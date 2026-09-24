// WP-AUG-OPENING：apply-aug-plan.ts
// 讀 data/2026-09/aug-opening/plan.json（build-aug-plan.ts 生成），寫入
// DB。預設 `--plan`（唔寫，淨係印 diff：新建/修改/跳過 數目＋清單，冇
// PII）；`--apply` 先真係寫。冪等：natural key 已存在就跳過，唔覆蓋。
// 全部一個 transaction；寫 audit_log（actor=null 代表 system，跟
// src/lib/audit.ts 嘅 writeAudit()）。
//
// DATABASE_URL：用 process.env.DATABASE_URL（.env 已經有 dev DB 嘅值；
// 老闆對正式站行嘅時候喺 Terminal 用 `DATABASE_URL='<正式站>' npx tsx
// scripts/opening/apply-aug-plan.ts --apply` 覆蓋）。
import { PrismaClient, Prisma } from "@prisma/client";
import { readFileSync } from "fs";
import path from "path";
import { writeAudit } from "@/lib/audit";
import type { AugPlan, NewSitePlan, NewShiftTypePlan, NewRateCardPlan, NewGuardPlan } from "./lib/types";
import { upsertCurrentStaffNumber, syncLegacyStaffNoColumns } from "@/lib/guards/staff-numbers";

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

async function main() {
  const planPath = path.resolve(process.cwd(), "data/2026-09/aug-opening/plan.json");
  const plan: AugPlan = JSON.parse(readFileSync(planPath, "utf8"));

  console.log(`[apply-aug-plan] 模式：${APPLY ? "--apply（真係寫）" : "--plan（淨係印 diff，唔寫）"}`);
  console.log(`[apply-aug-plan] plan.json 生成於 ${plan.generatedAt}`);

  const diffs = {
    sitesCreate: emptyDiff(),
    sitesAlias: emptyDiff(),
    sitesClientGroup: emptyDiff(),
    sitesParent: emptyDiff(),
    shiftTypes: emptyDiff(),
    rateCards: emptyDiff(),
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
      await writeAudit({ actorUserId: null, tableName: "sites", rowId: created.id, action: "create", after: created, ip: null });
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
      await writeAudit({ actorUserId: null, tableName: "sites", rowId: site.id, action: "update", before: { aliases: site.aliases }, after: { aliases: updated.aliases }, ip: null });
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
      await writeAudit({ actorUserId: null, tableName: "sites", rowId: site.id, action: "update", before: { clientGroup: site.clientGroup }, after: { clientGroup: updated.clientGroup }, ip: null });
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
      await writeAudit({ actorUserId: null, tableName: "sites", rowId: site.id, action: "update", before: { parentSiteId: site.parentSiteId }, after: { parentSiteId: updated.parentSiteId }, ip: null });
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
      await writeAudit({ actorUserId: null, tableName: "shift_types", rowId: created.id, action: "create", after: created, ip: null });
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
        if (!shiftTypeId && !PLAN_ONLY) {
          diffs.rateCards.skip.push(`${key}（shift_type 未起到）`);
          return;
        }
      }
      const brokerId = cp.brokerCode ? (brokerIdByCode.get(cp.brokerCode) ?? null) : null;
      if (cp.brokerCode && !brokerId) {
        diffs.rateCards.skip.push(`雞頭代號 ${cp.brokerCode} 搵唔到（${cp.siteCanonicalName}）`);
        return;
      }
      const guardId = cp.guardStaffNo ? (guardIdByStaffNo.get(cp.guardStaffNo) ?? null) : null;
      if (cp.guardStaffNo && !guardId) {
        diffs.rateCards.skip.push(`U 號 ${cp.guardStaffNo} 搵唔到安員（${cp.siteCanonicalName}）`);
        return;
      }
      const effectiveFrom = dateOnly(cp.effectiveFrom);
      const label = `${cp.siteCanonicalName}|${cp.shiftType ? `${cp.shiftType.code}@${cp.shiftType.startTime}` : "flat"}|${cp.brokerCode ?? "-"}|${cp.guardStaffNo ?? "-"}|${cp.effectiveFrom}`;

      // 依賴嘅盤／更種喺呢次 --plan 入面都係「仲未真係建」（sentinel）——
      // 冇真實 id 可以查 natural key，樂觀當「會建」，唔查 DB（呢個情況淨係
      // 喺 apply 之前嘅第一次 --plan 先會出現；apply 完之後再 --plan，
      // 呢兩個 id 就會係真實 DB id，落面先真係查）。
      if (isPlanned(siteId) || (shiftTypeId && isPlanned(shiftTypeId))) {
        diffs.rateCards.create.push(label);
        return;
      }

      const existing = await tx.rateCard.findFirst({
        where: { siteId, shiftTypeId, brokerId, guardId, effectiveFrom, voidedAt: null },
      });
      if (existing) {
        diffs.rateCards.skip.push(label);
        return;
      }
      diffs.rateCards.create.push(label);
      if (PLAN_ONLY) return;
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
          source: cp.source,
          evidence: "",
          confidence: "high",
          status: "solved",
          note: cp.note,
          createdBy: "system:aug-opening",
        },
      });
      await writeAudit({ actorUserId: null, tableName: "rate_cards", rowId: created.id, action: "create", after: created, ip: null });
    }
    for (const cp of plan.rateCards.create) await ensureRateCard(cp);

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
      const created = await tx.guard.create({
        data: {
          nameZh: gp.nameZh,
          tel: gp.tel,
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
      guardIdByStaffNo.set(gp.staffNo, created.id);
      await writeAudit({ actorUserId: null, tableName: "guards", rowId: created.id, action: "create", after: { staffNo: gp.staffNo }, ip: null });
      await writeAudit({ actorUserId: null, tableName: "guard_staff_numbers", rowId: staffResult.created.id, action: "create", after: { staffNo: gp.staffNo }, ip: null });
    }
    for (const gp of plan.guards.create) await ensureGuard(gp);
  };

  if (PLAN_ONLY) {
    await prisma.$transaction(async (tx) => run(tx), { timeout: 120_000 });
  } else {
    await prisma.$transaction(async (tx) => run(tx), { timeout: 120_000 });
  }

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
  console.log(`\n=== 散工 === 新建 ${diffs.guards.create.length}／跳過 ${diffs.guards.skip.length}`);

  console.log(`\n[apply-aug-plan] ${APPLY ? "已經寫入 DB（同一個 transaction）。" : "淨係印咗 diff，冇寫入（要真係寫用 --apply）。"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
