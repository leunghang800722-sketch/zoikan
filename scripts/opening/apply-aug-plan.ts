// WP-AUG-OPENING：apply-aug-plan.ts
// 讀 data/2026-09/aug-opening/plan.json（build-aug-plan.ts 生成），寫入
// DB。預設 `--plan`（唔寫，淨係印 diff：新建/修改/跳過 數目＋清單，冇
// PII）；`--apply` 先真係寫。冪等：natural key 已存在就跳過，唔覆蓋。
// 全部一個 transaction；寫 audit_log（actor=null 代表 system）——用
// src/lib/audit.ts 嘅 writeAuditTx()，audit 同業務資料喺同一個 transaction，
// 中途失敗 rollback 唔會留低指住唔存在 row 嘅孤兒 audit（Opus 5.5 驗收：
// 原本 writeAudit() 行另一條 connection，實測失敗一次留低 46 行孤兒 audit，
// audit_log append-only 刪唔返）。
//
// DATABASE_URL：用 process.env.DATABASE_URL（.env 已經有 dev DB 嘅值；
// 老闆對正式站行嘅時候喺 Terminal 用 `DATABASE_URL='<正式站>' npx tsx
// scripts/opening/apply-aug-plan.ts --apply` 覆蓋）。
import { PrismaClient, Prisma } from "@prisma/client";
import { readFileSync } from "fs";
import path from "path";
import { writeAuditTx } from "@/lib/audit";
import type { AugPlan, NewSitePlan, NewShiftTypePlan, NewRateCardPlan, NewGuardPlan, RateCardCloseJulyPlan } from "./lib/types";
import { upsertCurrentStaffNumber, syncLegacyStaffNoColumns } from "@/lib/guards/staff-numbers";
import { createGuardPhone, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";

const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");
const PLAN_ONLY = !APPLY; // 預設 --plan

interface Diff {
  create: string[];
  skip: string[];
  update: string[];
}
function emptyDiff(): Diff {
  return { create: [], skip: [], update: [] };
}

function timeOnly(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
}
function dateOnly(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

// --plan 模式：第一次跑（apply 之前）嘅時候，plan 入面互相依賴嘅嘢
// （例如某張卡掛住嘅盤／更種都仲未存在）冇真實 DB id 可以查。用呢個
// sentinel 前綴標記「呢個 id 係假設 plan 會建到」，落 natural-key 查詢
// 之前，如果任何一個 id 係 sentinel 就跳過 DB 查詢，直接當「會建」
// （樂觀）；如果全部都係真實 id（例如 apply 完之後再跑 --plan 驗冪等），
// 先真係查 DB 做冪等 check。
const PLANNED = "__planned__:";
function isPlanned(id: string | null): boolean {
  return id !== null && id.startsWith(PLANNED);
}

/** 印目標 DB（host:port/db），唔印帳號密碼——老闆對正式站行之前睇清楚指住邊度。 */
function describeDbTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "（DATABASE_URL 未設）";
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "（DATABASE_URL 格式解析唔到）";
  }
}

async function main() {
  const planPath = path.resolve(process.cwd(), "data/2026-09/aug-opening/plan.json");
  const plan: AugPlan = JSON.parse(readFileSync(planPath, "utf8"));

  console.log(`[apply-aug-plan] 模式：${APPLY ? "--apply（真係寫）" : "--plan（淨係印 diff，唔寫）"}`);
  console.log(`[apply-aug-plan] 目標 DB：${describeDbTarget()}（冇設 DATABASE_URL 就用 .env 嘅本機 dev DB）`);
  console.log(`[apply-aug-plan] plan.json 生成於 ${plan.generatedAt}`);

  const diffs = {
    sitesCreate: emptyDiff(),
    sitesAlias: emptyDiff(),
    sitesClientGroup: emptyDiff(),
    sitesParent: emptyDiff(),
    shiftTypes: emptyDiff(),
    rateCards: emptyDiff(),
    // WP-MIXED-BILLING：7 月卡加 effective_to（老闆 2026-09-24 批准嘅唯一
    // 7 月卡改動）——用 `.update`（唔係 `.create`），skip 入 `.skip`。
    rateCardsCloseJuly: emptyDiff(),
    // 驗收（Opus 5.5）：同 natural key 現有卡 client_rate=null、plan 有值 → 補。
    rateCardsFillClient: emptyDiff(),
    guards: emptyDiff(),
  };

  const run = async (tx: Prisma.TransactionClient) => {
    // -----------------------------------------------------------------
    // 1. 盤：新建（分兩輪——先起晒冇 parent 嘅，再補 parent，avoid FK 序）
    // -----------------------------------------------------------------
    const siteIdByName = new Map<string, string>();
    for (const s of await tx.site.findMany({ select: { id: true, canonicalName: true } })) {
      siteIdByName.set(s.canonicalName, s.id);
    }

    async function ensureSite(sp: NewSitePlan) {
      const existingId = siteIdByName.get(sp.canonicalName);
      if (existingId) {
        diffs.sitesCreate.skip.push(sp.canonicalName);
        return existingId;
      }
      diffs.sitesCreate.create.push(sp.canonicalName);
      if (PLAN_ONLY) {
        const sentinel = `${PLANNED}${sp.canonicalName}`;
        siteIdByName.set(sp.canonicalName, sentinel);
        return sentinel;
      }
      // parentCanonicalName（例：「城巴-海洋公園車廠」跟「城巴車廠」）要喺
      // 呢度攞返個母盤 id——`plan.sites.create` 已經保證冇 parent 嘅先起
      // （見上面 for 迴圈分兩輪嘅次序），所以母盤呢一刻應該已經有真實 id。
      let parentSiteId: string | null = null;
      if (sp.parentCanonicalName) {
        parentSiteId = siteIdByName.get(sp.parentCanonicalName) ?? (await tx.site.findUnique({ where: { canonicalName: sp.parentCanonicalName } }))?.id ?? null;
        if (!parentSiteId) {
          console.warn(`[apply-aug-plan] WARN：「${sp.canonicalName}」嘅母盤「${sp.parentCanonicalName}」搵唔到，起呢個盤時 parent_site_id 留空。`);
        }
      }
      const created = await tx.site.create({
        data: {
          canonicalName: sp.canonicalName,
          clientName: sp.clientName,
          clientGroup: sp.clientGroup,
          aliases: sp.aliases,
          billingModel: sp.billingModel,
          monthlyFee: sp.monthlyFee,
          monthlyPosts: sp.monthlyPosts,
          guardsPaidByClient: sp.guardsPaidByClient,
          parentSiteId,
          createdBy: "system:aug-opening",
        },
      });
      siteIdByName.set(sp.canonicalName, created.id);
      await writeAuditTx(tx, { actorUserId: null, tableName: "sites", rowId: created.id, action: "create", after: created, ip: null });
      return created.id;
    }

    // 先起冇 parent 嘅（母盤要行先），再起有 parent 嘅
    for (const sp of plan.sites.create.filter((s) => !s.parentCanonicalName)) await ensureSite(sp);
    for (const sp of plan.sites.create.filter((s) => s.parentCanonicalName)) await ensureSite(sp);

    // -----------------------------------------------------------------
    // 1b. Aliases
    // -----------------------------------------------------------------
    for (const u of plan.sites.updateAliases) {
      const site = await tx.site.findUnique({ where: { canonicalName: u.canonicalName } });
      if (!site) {
        diffs.sitesAlias.skip.push(`${u.canonicalName}（盤唔存在）`);
        continue;
      }
      const toAdd = u.addAliases.filter((a) => !site.aliases.includes(a));
      if (toAdd.length === 0) {
        diffs.sitesAlias.skip.push(`${u.canonicalName}（alias 已存在）`);
        continue;
      }
      diffs.sitesAlias.update.push(`${u.canonicalName} +${toAdd.join(",")}`);
      if (PLAN_ONLY) continue;
      const newAliases = [...site.aliases, ...toAdd];
      const updated = await tx.site.update({ where: { id: site.id }, data: { aliases: newAliases } });
      await writeAuditTx(tx, { actorUserId: null, tableName: "sites", rowId: site.id, action: "update", before: { aliases: site.aliases }, after: { aliases: updated.aliases }, ip: null });
    }

    // -----------------------------------------------------------------
    // 1c. client_group
    // -----------------------------------------------------------------
    for (const u of plan.sites.updateClientGroup) {
      const site = await tx.site.findUnique({ where: { canonicalName: u.canonicalName } });
      if (!site) {
        diffs.sitesClientGroup.skip.push(`${u.canonicalName}（盤唔存在）`);
        continue;
      }
      if (site.clientGroup === u.clientGroup) {
        diffs.sitesClientGroup.skip.push(`${u.canonicalName}（已經係 ${u.clientGroup}）`);
        continue;
      }
      diffs.sitesClientGroup.update.push(`${u.canonicalName}→${u.clientGroup}`);
      if (PLAN_ONLY) continue;
      const updated = await tx.site.update({ where: { id: site.id }, data: { clientGroup: u.clientGroup } });
      await writeAuditTx(tx, { actorUserId: null, tableName: "sites", rowId: site.id, action: "update", before: { clientGroup: site.clientGroup }, after: { clientGroup: updated.clientGroup }, ip: null });
    }

    // -----------------------------------------------------------------
    // 1d. parent_site_id
    // -----------------------------------------------------------------
    for (const u of plan.sites.setParent) {
      const site = await tx.site.findUnique({ where: { canonicalName: u.canonicalName } });
      const parentId = siteIdByName.get(u.parentCanonicalName) ?? (await tx.site.findUnique({ where: { canonicalName: u.parentCanonicalName } }))?.id;
      if (!site || !parentId) {
        diffs.sitesParent.skip.push(`${u.canonicalName}（盤或母盤唔存在）`);
        continue;
      }
      if (site.parentSiteId === parentId) {
        diffs.sitesParent.skip.push(`${u.canonicalName}（parent 已經係 ${u.parentCanonicalName}）`);
        continue;
      }
      diffs.sitesParent.update.push(`${u.canonicalName}→${u.parentCanonicalName}`);
      if (PLAN_ONLY) continue;
      const updated = await tx.site.update({ where: { id: site.id }, data: { parentSiteId: parentId } });
      await writeAuditTx(tx, { actorUserId: null, tableName: "sites", rowId: site.id, action: "update", before: { parentSiteId: site.parentSiteId }, after: { parentSiteId: updated.parentSiteId }, ip: null });
    }

    // -----------------------------------------------------------------
    // 2. ShiftType
    // -----------------------------------------------------------------
    const shiftTypeIdByKey = new Map<string, string>(); // canonicalName|code|start|end -> id
    for (const st of await tx.shiftType.findMany({ where: { voidedAt: null }, select: { id: true, siteId: true, code: true, startTime: true, endTime: true, site: { select: { canonicalName: true } } } })) {
      const start = st.startTime ? `${String(st.startTime.getUTCHours()).padStart(2, "0")}:${String(st.startTime.getUTCMinutes()).padStart(2, "0")}` : "?";
      const end = st.endTime ? `${String(st.endTime.getUTCHours()).padStart(2, "0")}:${String(st.endTime.getUTCMinutes()).padStart(2, "0")}` : "?";
      shiftTypeIdByKey.set(`${st.site.canonicalName}|${st.code}|${start}|${end}`, st.id);
    }

    async function ensureShiftType(sp: NewShiftTypePlan): Promise<string | null> {
      const key = `${sp.siteCanonicalName}|${sp.code}|${sp.startTime}|${sp.endTime}`;
      const existing = shiftTypeIdByKey.get(key);
      if (existing) {
        diffs.shiftTypes.skip.push(key);
        return existing;
      }
      diffs.shiftTypes.create.push(key);
      if (PLAN_ONLY) {
        const sentinel = `${PLANNED}${key}`;
        shiftTypeIdByKey.set(key, sentinel);
        return sentinel;
      }
      const siteId = siteIdByName.get(sp.siteCanonicalName) ?? (await tx.site.findUnique({ where: { canonicalName: sp.siteCanonicalName } }))?.id;
      if (!siteId) {
        console.warn(`[apply-aug-plan] WARN：ShiftType ${key} 嘅盤「${sp.siteCanonicalName}」搵唔到，skip。`);
        return null;
      }
      const created = await tx.shiftType.create({
        data: {
          siteId,
          code: sp.code,
          startTime: timeOnly(sp.startTime),
          endTime: timeOnly(sp.endTime),
          billingGroup: sp.billingGroup,
          createdBy: "system:aug-opening",
        },
      });
      shiftTypeIdByKey.set(key, created.id);
      await writeAuditTx(tx, { actorUserId: null, tableName: "shift_types", rowId: created.id, action: "create", after: created, ip: null });
      return created.id;
    }
    for (const sp of plan.shiftTypes.create) await ensureShiftType(sp);

    // -----------------------------------------------------------------
    // 3. RateCard（natural key：site + shift_type + broker + guard + effective_from）
    // -----------------------------------------------------------------
    const brokerIdByCode = new Map<string, string>();
    for (const b of await tx.broker.findMany({ select: { id: true, code: true } })) brokerIdByCode.set(b.code, b.id);
    const guardIdByStaffNo = new Map<string, string>();
    for (const sn of await tx.guardStaffNumber.findMany({ select: { number: true, guardId: true } })) guardIdByStaffNo.set(sn.number, sn.guardId);
    // 2026-09-25 修正（老闆對正式站經公開 port 行 --apply 時 P2028
    // transaction timeout）：原本逐張卡 `findFirst` 查 natural key，112 張
    // 卡＝112 次來回，加埋 create／audit 每張 3 次來回，公開 port 延遲下
    // 120 秒唔夠。改為一次過預載所有未作廢卡嘅 natural key 落 Map，逐張
    // 卡淨係喺記憶體查；新建嗰陣同步加入 Map（同一次 run 內冪等）。
    const rateCardKey = (c: { siteId: string; shiftTypeId: string | null; brokerId: string | null; guardId: string | null; effectiveFrom: Date }) =>
      `${c.siteId}|${c.shiftTypeId ?? ""}|${c.brokerId ?? ""}|${c.guardId ?? ""}|${c.effectiveFrom.toISOString().slice(0, 10)}`;
    const existingRateCardKeys = new Set<string>();
    // 驗收（Opus 5.5）：同一 natural key 已有卡嗰陣要知佢 client_rate 係咪 null
    // （見下面「補收客價」）。
    const existingRateCardByKey = new Map<string, { id: string; clientRate: unknown }>();
    for (const c of await tx.rateCard.findMany({ where: { voidedAt: null }, select: { id: true, siteId: true, shiftTypeId: true, brokerId: true, guardId: true, effectiveFrom: true, clientRate: true } })) {
      existingRateCardKeys.add(rateCardKey(c));
      existingRateCardByKey.set(rateCardKey(c), { id: c.id, clientRate: c.clientRate });
    }

    async function ensureRateCard(cp: NewRateCardPlan) {
      const siteId = siteIdByName.get(cp.siteCanonicalName) ?? (await tx.site.findUnique({ where: { canonicalName: cp.siteCanonicalName } }))?.id ?? null;
      if (!siteId) {
        diffs.rateCards.skip.push(`${cp.siteCanonicalName}（盤搵唔到）`);
        return;
      }
      let shiftTypeId: string | null = null;
      if (cp.shiftType) {
        const key = `${cp.siteCanonicalName}|${cp.shiftType.code}|${cp.shiftType.startTime}|${cp.shiftType.endTime}`;
        shiftTypeId = shiftTypeIdByKey.get(key) ?? null;
        // --plan 都要 skip：否則 shiftTypeId=null 落面個 natural-key 查詢會
        // 誤撞同盤嘅 site 級 flat 卡（shift_type_id=null）報「跳過」。
        if (!shiftTypeId) {
          diffs.rateCards.skip.push(`${key}（shift_type 未起到）`);
          return;
        }
      }
      const brokerId = cp.brokerCode ? (brokerIdByCode.get(cp.brokerCode) ?? null) : null;
      if (cp.brokerCode && !brokerId) {
        diffs.rateCards.skip.push(`雞頭代號 ${cp.brokerCode} 搵唔到（${cp.siteCanonicalName}）`);
        return;
      }
      let guardId = cp.guardStaffNo ? (guardIdByStaffNo.get(cp.guardStaffNo) ?? null) : null;
      if (cp.guardStaffNo && !guardId) {
        diffs.rateCards.skip.push(`U 號 ${cp.guardStaffNo} 搵唔到安員（${cp.siteCanonicalName}）`);
        return;
      }
      // Opus 5.5 驗收（WP-UPLOAD-AUTOFIX 個案 2）：冇 U 號、build 用姓名＋
      // 電話／姓名後備對到嘅安員，plan 直接記 guardId——喺同一個 DB 核實
      // 仲存在先用（唔存在＝build 同 apply 唔係同一個 DB，skip 唔估）。
      if (!cp.guardStaffNo && cp.guardId) {
        const g = await tx.guard.findUnique({ where: { id: cp.guardId }, select: { id: true } });
        if (!g) {
          diffs.rateCards.skip.push(`安員（${cp.guardMatchMethod ?? "guardId"}）喺呢個 DB 搵唔到——build 同 apply 要用同一個 DB，重新 build（${cp.siteCanonicalName}）`);
          return;
        }
        guardId = g.id;
      }
      const effectiveFrom = dateOnly(cp.effectiveFrom);
      const guardLabel = cp.guardStaffNo ?? (cp.guardId ? `安員(${cp.guardMatchMethod ?? "guardId"})` : "-");
      const label = `${cp.siteCanonicalName}|${cp.shiftType ? `${cp.shiftType.code}@${cp.shiftType.startTime}` : "flat"}|${cp.brokerCode ?? "-"}|${guardLabel}|${cp.effectiveFrom}`;

      // 依賴嘅盤／更種喺呢次 --plan 入面都係「仲未真係建」（sentinel）——
      // 冇真實 id 可以查 natural key，樂觀當「會建」，唔查 DB（呢個情況淨係
      // 喺 apply 之前嘅第一次 --plan 先會出現；apply 完之後再 --plan，
      // 呢兩個 id 就會係真實 DB id，落面先真係查）。
      if (isPlanned(siteId) || (shiftTypeId && isPlanned(shiftTypeId))) {
        diffs.rateCards.create.push(label);
        return;
      }

      const natKey = rateCardKey({ siteId, shiftTypeId, brokerId, guardId, effectiveFrom });
      if (existingRateCardKeys.has(natKey)) {
        // 驗收（Opus 5.5，2026-09-26）：正式站舊版開盤已經起咗同一張卡、但當時
        // 「flat 收入盤唔起逐更收客」規則 strip 咗 client_rate（例：淺水灣道11號
        // 蔚峰園，WP-LTSHIFT §7 先剔走）——natural key 唔含 client_rate，之前
        // 會當「已存在」skip，令 8 月逐更收客卡永遠起唔到、7 月 flat 卡亦因為
        // 搵唔到替代卡而唔加到期（dev 模擬「舊版先開盤、後部署」實測）。
        // 淨係**補 null**（現有卡 client_rate 係 null、plan 有值），唔覆蓋已有值。
        const existingCard = existingRateCardByKey.get(natKey);
        if (existingCard && existingCard.clientRate === null && cp.clientRate !== null) {
          diffs.rateCardsFillClient.update.push(`${label}（現有卡冇收客價，補 ${cp.clientRate}）`);
          if (PLAN_ONLY) return;
          const before = await tx.rateCard.findUniqueOrThrow({ where: { id: existingCard.id } });
          const updated = await tx.rateCard.update({ where: { id: existingCard.id }, data: { clientRate: cp.clientRate, note: [before.note, "[驗收 Opus 5.5] 補收客價（舊版開盤 strip 咗）"].filter(Boolean).join("\n") } });
          existingCard.clientRate = updated.clientRate;
          await writeAuditTx(tx, { actorUserId: null, tableName: "rate_cards", rowId: updated.id, action: "update", before: { clientRate: null }, after: { clientRate: updated.clientRate }, ip: null });
          return;
        }
        diffs.rateCards.skip.push(label);
        return;
      }
      diffs.rateCards.create.push(label);
      if (PLAN_ONLY) return;
      existingRateCardKeys.add(natKey);
      const created = await tx.rateCard.create({
        data: {
          siteId,
          shiftTypeId,
          brokerId,
          guardId,
          clientRate: cp.clientRate,
          guardWage: cp.guardWage,
          brokerFee: cp.brokerFee,
          billingModel: cp.billingModel,
          effectiveFrom,
          // WP-MIXED-BILLING：數碼港 CP5 IC 8 月 flat 卡（18,580.65）要加
          // effective_to=2026-08-31（老闆 2026-09-24 答）；其餘新卡照舊
          // 無限期（undefined/null → DB null）。
          effectiveTo: cp.effectiveTo ? dateOnly(cp.effectiveTo) : null,
          source: cp.source,
          evidence: "",
          confidence: "high",
          status: "solved",
          note: cp.note,
          createdBy: "system:aug-opening",
        },
      });
      await writeAuditTx(tx, { actorUserId: null, tableName: "rate_cards", rowId: created.id, action: "create", after: created, ip: null });
    }
    for (const cp of plan.rateCards.create) await ensureRateCard(cp);

    // -----------------------------------------------------------------
    // 3b. WP-MIXED-BILLING：7 月卡加 effective_to（老闆 2026-09-24 批准
    //     嘅唯一 7 月卡改動——「8 月無就加」）。**淨係 DB 層面已經真係有
    //     對應嘅 8 月替代卡先套用**（唔淨係信 plan.json 生成時嘅 in-memory
    //     判斷——呢個時間點上面 3. 嘅 rate_cards create 已經行晒，可以真
    //     係查 DB），搵唔到就 skip（維持 7 月卡原封不動），唔會靜靜哋幫
    //     7 月卡加期限但冇嘢頂上。
    // -----------------------------------------------------------------
    async function findShiftTypeId(canonicalSiteName: string, code: string | null, startTime?: string): Promise<string | null | undefined> {
      // undefined = 呢個盤／更種搵唔到；null = site 級 flat（唔使 shift_type_id）
      if (code === null) return null;
      const siteId = siteIdByName.get(canonicalSiteName) ?? (await tx.site.findUnique({ where: { canonicalName: canonicalSiteName } }))?.id;
      if (!siteId) return undefined;
      // 同一個盤可以有兩個同 code 唔同時段嘅更種（例：啟航1331「D」有
      // 07:30-19:30 同 10:00-19:00）——`findFirst` 冇 `ORDER BY` 唔保證揀
      // 中邊個，一定要傳 `startTime` 先精確（唔傳就要求淨係得一個呢個
      // code 嘅更種，搵到多過一個就當搵唔到，寧願 skip 都唔可以撞錯）。
      if (startTime) {
        const st = await tx.shiftType.findFirst({ where: { siteId, code, startTime: timeOnly(startTime), voidedAt: null } });
        return st ? st.id : undefined;
      }
      const candidates = await tx.shiftType.findMany({ where: { siteId, code, voidedAt: null } });
      if (candidates.length !== 1) return undefined;
      return candidates[0].id;
    }

    async function ensureCloseJulyCard(cj: RateCardCloseJulyPlan) {
      const label = `${cj.siteCanonicalName}|${cj.shiftTypeCode ?? "flat"}|${cj.clientRate}→effective_to=${cj.setEffectiveTo}`;
      const siteId = siteIdByName.get(cj.siteCanonicalName) ?? (await tx.site.findUnique({ where: { canonicalName: cj.siteCanonicalName } }))?.id;
      if (!siteId) {
        diffs.rateCardsCloseJuly.skip.push(`${label}（盤搵唔到）`);
        return;
      }
      // (a) DB 層面核實 8 月替代卡真係存在（effective_from>=2026-08-01，
      //     金額夾）。
      const req = cj.requireAugReplacementCard;
      const reqShiftTypeId = await findShiftTypeId(req.siteCanonicalName, req.shiftTypeCode, req.shiftTypeStartTime);
      let replacementFound = false;
      if (reqShiftTypeId !== undefined) {
        const reqSiteId = siteIdByName.get(req.siteCanonicalName) ?? (await tx.site.findUnique({ where: { canonicalName: req.siteCanonicalName } }))?.id;
        if (reqSiteId) {
          const candidates = await tx.rateCard.findMany({
            where: { siteId: reqSiteId, shiftTypeId: reqShiftTypeId, billingModel: req.billingModel, effectiveFrom: { gte: new Date(Date.UTC(2026, 7, 1)) }, voidedAt: null },
          });
          replacementFound = candidates.some((c) => c.clientRate !== null && Math.abs(Number(c.clientRate) - req.clientRate) < 0.01);
        }
      }
      if (!replacementFound && PLAN_ONLY) {
        // Opus 5.5 驗收：第一次 --plan（apply 之前）8 月替代卡仲未寫入 DB——
        // 如果 plan 本身會起呢張替代卡，--plan 顯示「apply 時會改（到時再
        // 核實 DB）」，唔好顯示 skip 嚇親人；--apply 照舊一定要 DB 真係有先改。
        const plannedReplacement = plan.rateCards.create.some(
          (c) =>
            c.siteCanonicalName === req.siteCanonicalName &&
            c.billingModel === req.billingModel &&
            (req.shiftTypeCode === null ? c.shiftType === null : c.shiftType?.code === req.shiftTypeCode && (!req.shiftTypeStartTime || c.shiftType.startTime === req.shiftTypeStartTime)) &&
            c.clientRate !== null &&
            Math.abs(c.clientRate - req.clientRate) < 0.01,
        );
        if (plannedReplacement) {
          diffs.rateCardsCloseJuly.update.push(`${label}（plan 會起 8 月替代卡；--apply 時再喺 DB 核實先改）`);
          return;
        }
      }
      if (!replacementFound) {
        diffs.rateCardsCloseJuly.skip.push(`${label}（8 月替代卡未搵到，skip，維持 7 月卡原封不動）`);
        return;
      }
      // (b) 搵返嗰張現有（開放式，effective_to=null）7 月卡，金額要夾中
      //     先改（唔係就唔知搵錯咗邊張，保守 skip）。
      const shiftTypeId = await findShiftTypeId(cj.siteCanonicalName, cj.shiftTypeCode, cj.shiftTypeStartTime);
      if (shiftTypeId === undefined) {
        diffs.rateCardsCloseJuly.skip.push(`${label}（原 7 月更種搵唔到）`);
        return;
      }
      const existing = await tx.rateCard.findFirst({ where: { siteId, shiftTypeId, billingModel: cj.billingModel, effectiveTo: null, voidedAt: null } });
      if (!existing || existing.clientRate === null || Math.abs(Number(existing.clientRate) - cj.clientRate) >= 0.01) {
        // 冪等：可能上次 --apply 已經改過（effective_to 唔再係 null）——
        // 搵返嗰張已經改咗嘅卡，確認金額同目標日子一致就當「已經套用
        // 過」，skip（唔係失敗）。
        const alreadyClosed = await tx.rateCard.findFirst({ where: { siteId, shiftTypeId, billingModel: cj.billingModel, effectiveTo: dateOnly(cj.setEffectiveTo), voidedAt: null } });
        if (alreadyClosed && alreadyClosed.clientRate !== null && Math.abs(Number(alreadyClosed.clientRate) - cj.clientRate) < 0.01) {
          diffs.rateCardsCloseJuly.skip.push(`${label}（已經套用過，冪等 skip）`);
        } else {
          diffs.rateCardsCloseJuly.skip.push(`${label}（原 7 月卡搵唔到或者金額唔夾）`);
        }
        return;
      }
      diffs.rateCardsCloseJuly.update.push(label);
      if (PLAN_ONLY) return;
      const updated = await tx.rateCard.update({
        where: { id: existing.id },
        data: { effectiveTo: dateOnly(cj.setEffectiveTo), note: [existing.note, `[WP-MIXED-BILLING ${cj.reason}] ${cj.note}`].filter(Boolean).join("\n") },
      });
      await writeAuditTx(tx, {
        actorUserId: null,
        tableName: "rate_cards",
        rowId: existing.id,
        action: "update",
        before: { effectiveTo: existing.effectiveTo },
        // Opus 5.5 驗收：audit DTO 白名單會剝走唔認識嘅 key（之前嘅 `reason`
        // 冇寫入 audit_log）——用 AUDIT_META_PASSTHROUGH_KEYS 認可嘅
        // `override_reason` 記低「老闆 2026-09-24 批」同 8 月替代卡。
        after: {
          effectiveTo: updated.effectiveTo,
          override_reason: `${cj.reason}（WP-MIXED-BILLING 7 月卡加 effective_to；8 月替代卡：${req.siteCanonicalName}|${req.shiftTypeCode ?? "flat"}|${req.clientRate}）`,
        },
        ip: null,
      });
    }
    for (const cj of plan.rateCards.closeJuly) await ensureCloseJulyCard(cj);

    // -----------------------------------------------------------------
    // 4. Guards（4 位 U 號新散工）
    // -----------------------------------------------------------------
    async function ensureGuard(gp: NewGuardPlan) {
      const existingId = guardIdByStaffNo.get(gp.staffNo);
      if (existingId) {
        diffs.guards.skip.push(gp.staffNo);
        return;
      }
      diffs.guards.create.push(gp.staffNo);
      if (PLAN_ONLY) return;
      const brokerId = brokerIdByCode.get(gp.defaultBrokerCode) ?? null;
      // WP-MULTI：電話一定要經 createGuardPhone() 起一行 primary（再 sync
      // 返 legacy `guards.tel`），唔可以直接寫 `guards.tel`——同
      // POST /api/guards 一致（Opus 5.5 驗收：原本直寫 tel，guard_phones 0 行）。
      const created = await tx.guard.create({
        data: {
          nameZh: gp.nameZh,
          defaultBrokerId: brokerId,
          employmentType: "cash_casual",
          status: "active",
          createdBy: "system:aug-opening",
        },
      });
      const scheme = gp.staffNo.match(/^[A-Z]+/)?.[0] ?? "U";
      const staffResult = await upsertCurrentStaffNumber(tx, {
        guardId: created.id,
        scheme,
        number: gp.staffNo,
        source: "system:aug-opening",
        createdBy: "system:aug-opening",
      });
      await syncLegacyStaffNoColumns(tx, created.id);
      const phoneResult = gp.tel && gp.tel.trim() ? await createGuardPhone(tx, { guardId: created.id, tel: gp.tel, isPrimary: true, source: "system:aug-opening", createdBy: "system:aug-opening" }) : null;
      if (phoneResult) await syncLegacyGuardContactColumns(tx, created.id, ["tel"]);
      guardIdByStaffNo.set(gp.staffNo, created.id);
      // audit：guards 淨係記 staff_no（唔放姓名）；guard_staff_numbers 經
      // audit-dto 白名單；guard_phones 淨係記 id／guard_id／is_primary／source
      // （唔放電話號碼本身——批量 script 寫嘅 audit 盡量唔帶 PII）。
      await writeAuditTx(tx, { actorUserId: null, tableName: "guards", rowId: created.id, action: "create", after: { staffNo: gp.staffNo }, ip: null });
      await writeAuditTx(tx, { actorUserId: null, tableName: "guard_staff_numbers", rowId: staffResult.created.id, action: "create", after: staffResult.created, ip: null });
      if (phoneResult) await writeAuditTx(tx, { actorUserId: null, tableName: "guard_phones", rowId: phoneResult.created.id, action: "create", after: { id: phoneResult.created.id, guardId: phoneResult.created.guardId, isPrimary: phoneResult.created.isPrimary, source: phoneResult.created.source }, ip: null });
    }
    for (const gp of plan.guards.create) await ensureGuard(gp);
  };

  // --plan 都行 transaction（淨係讀），同 --apply 用同一條 code path。
  // timeout 30 分鐘、maxWait 30 秒：老闆經 Zeabur 公開 port 對正式站行，
  // 每次來回可能幾百毫秒；2026-09-25 實測 120 秒唔夠（P2028）。
  await prisma.$transaction(async (tx) => run(tx), { timeout: 1_800_000, maxWait: 30_000 });

  // -----------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------
  console.log(`\n=== 盤（新建）=== 新建 ${diffs.sitesCreate.create.length}／跳過 ${diffs.sitesCreate.skip.length}`);
  for (const s of diffs.sitesCreate.create) console.log(`  + ${s}`);
  console.log(`=== 盤（alias）=== 改 ${diffs.sitesAlias.update.length}／跳過 ${diffs.sitesAlias.skip.length}`);
  for (const s of diffs.sitesAlias.update) console.log(`  ~ ${s}`);
  console.log(`=== 盤（client_group）=== 改 ${diffs.sitesClientGroup.update.length}／跳過 ${diffs.sitesClientGroup.skip.length}`);
  for (const s of diffs.sitesClientGroup.update) console.log(`  ~ ${s}`);
  console.log(`=== 盤（parent）=== 改 ${diffs.sitesParent.update.length}／跳過 ${diffs.sitesParent.skip.length}`);
  for (const s of diffs.sitesParent.update) console.log(`  ~ ${s}`);
  console.log(`\n=== 更種 === 新建 ${diffs.shiftTypes.create.length}／跳過 ${diffs.shiftTypes.skip.length}`);
  console.log(`\n=== 價目卡 === 新建 ${diffs.rateCards.create.length}／跳過 ${diffs.rateCards.skip.length}`);
  // Opus 5.5 驗收：「已存在」以外嘅跳過（盤／更種／雞頭／U 號搵唔到）要印出嚟，唔可以靜靜哋少起卡。
  for (const s of diffs.rateCards.skip.filter((x) => x.includes("（") || x.includes("搵唔到"))) console.log(`  ! skip：${s}`);
  console.log(`=== 價目卡（補收客價，現有卡 client_rate 空）=== 改 ${diffs.rateCardsFillClient.update.length}`);
  for (const s of diffs.rateCardsFillClient.update) console.log(`  ~ ${s}`);
  console.log(`=== 價目卡（7 月卡加 effective_to，老闆 2026-09-24 批）=== 改 ${diffs.rateCardsCloseJuly.update.length}／跳過 ${diffs.rateCardsCloseJuly.skip.length}`);
  for (const s of diffs.rateCardsCloseJuly.update) console.log(`  ~ ${s}`);
  for (const s of diffs.rateCardsCloseJuly.skip) console.log(`  ! skip：${s}`);
  console.log(`\n=== 散工 === 新建 ${diffs.guards.create.length}／跳過 ${diffs.guards.skip.length}`);

  console.log(`\n[apply-aug-plan] ${APPLY ? "已經寫入 DB（同一個 transaction）。" : "淨係印咗 diff，冇寫入（要真係寫用 --apply）。"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
