// WP-GUARD-FIX（老闆 2026-09-25 要求，緊急，直接影響出糧）：apply-guard-
// fix-plan.ts——讀 `data/2026-09/guard-fix/plan.json`（build-guard-fix-
// plan.ts 生成），寫入 DB。預設 `--plan`（唔寫，淨係印 diff：新建/連結/
// 跳過數目，冇 PII）；`--apply` 先真係寫。一個 transaction，timeout 30
// 分鐘（同 opening P2028 教訓一致，老闆可能經 Zeabur 公開 port 對正式站
// 行）；冪等（工號／電話／別名已存在就 skip）。
//
// 建安員一定用同 opening 一樣嘅路徑（`scripts/opening/apply-aug-plan.ts`
// `ensureGuard()`）：`tx.guard.create` ＋ `upsertCurrentStaffNumber` ＋
// `syncLegacyStaffNoColumns` ＋ `createGuardPhone` ＋
// `syncLegacyGuardContactColumns`。
//
// 鐵則：audit 唔帶姓名／電話——同 `apply-aug-plan.ts ensureGuard()` 一致
// 做法（`after`/`before` 傳精簡 object，唔傳完整 row，DTO whitelist 淨係
// 揀返呢個精簡 object 有嘅 key）。
//
// `--apply` 完成之後自動對目標 DB 2026-08 全部 active 上載逐個
// `reparseRosterUpload()`（順序，唔並行——同一個 DB connection pool），
// 印每盤 reparse 前後 unmatched／ambiguous 數，最後總結。
import { PrismaClient, Prisma } from "@prisma/client";
import { readFileSync } from "fs";
import { writeAuditTx } from "@/lib/audit";
import { upsertCurrentStaffNumber, syncLegacyStaffNoColumns } from "@/lib/guards/staff-numbers";
import { createGuardPhone, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { reparseRosterUpload } from "@/lib/roster-upload/service";
import { canonicalHkid } from "./lib/sources";
import type { GuardFixPlan } from "./lib/types";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const PLAN_ONLY = !APPLY;
const PLAN_JSON_PATH = "data/2026-09/guard-fix/plan.json";
const AUG_MONTH = new Date("2026-08-01T00:00:00.000Z");
const SYSTEM_ACTOR = "system:guard-fix";

function describeDbTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "（DATABASE_URL 未設）";
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "（DATABASE_URL 解析唔到）";
  }
}

interface Diff {
  create: string[]; // seq
  skip: string[]; // seq（（原因））
}
function emptyDiff(): Diff {
  return { create: [], skip: [] };
}

async function main() {
  console.log(`[apply-guard-fix-plan] 目標 DB：${describeDbTarget()}${APPLY ? "" : "（--plan，唔會寫入）"}`);
  const plan = JSON.parse(readFileSync(PLAN_JSON_PATH, "utf8")) as GuardFixPlan;
  console.log(`[apply-guard-fix-plan] plan 產生於 ${plan.generatedAt}，資料嚟源 ${plan.sourceMode}`);
  // 驗收（Opus 5.5）：plan 係對住另一個 DB build 嘅（例如 dev build 完
  // 忘記重新 build 就對正式站 apply）→ 停。
  if (plan.dbTarget !== describeDbTarget()) {
    throw new Error(`plan.json 係對住 ${plan.dbTarget} build 嘅，而家目標係 ${describeDbTarget()}——停，請對住目標 DB 重新 build。`);
  }
  console.log(`[apply-guard-fix-plan] link=${plan.actions.link.length} create=${plan.actions.create.length} create_minimal=${plan.actions.createMinimal.length} needs_boss=${plan.actions.needsBoss.length}`);

  const diffs = { link: emptyDiff(), create: emptyDiff(), createMinimal: emptyDiff() };

  const run = async (tx: Prisma.TransactionClient) => {
    // 驗收（Opus 5.5）：防重複建人——apply 嗰刻 DB 已有嘅身份證（canonical）。
    const existingHkids = new Set((await tx.guard.findMany({ where: { hkid: { not: null } }, select: { hkid: true } })).map((g) => canonicalHkid(g.hkid)).filter((x): x is string => !!x));
    // -----------------------------------------------------------------
    // 1. link——登記工號／加別名到現有安員。
    // -----------------------------------------------------------------
    for (const la of plan.actions.link) {
      const guard = await tx.guard.findUnique({ where: { id: la.guardId }, select: { id: true, nameAliases: true } });
      if (!guard) {
        diffs.link.skip.push(`${la.seq}（guard_id 搵唔到，可能已刪）`);
        continue;
      }
      let needsStaffNo = false;
      if (la.addStaffNumber) {
        const existing = await tx.guardStaffNumber.findUnique({ where: { number: la.addStaffNumber.number } });
        // 驗收（Opus 5.5）：build 之後呢個號已經俾第二個人登記咗——成個
        // link 唔做（連別名都唔加），唔係淨係靜靜跳過個號。
        if (existing && existing.guardId !== la.guardId) {
          diffs.link.skip.push(`${la.seq}（工號已經屬另一位安員，成項唔做，交老闆睇）`);
          continue;
        }
        needsStaffNo = !existing;
      }
      const needsAlias = !!la.addAlias && !guard.nameAliases.includes(la.addAlias);
      if (!needsStaffNo && !needsAlias) {
        diffs.link.skip.push(`${la.seq}（已經登記晒，冪等跳過）`);
        continue;
      }
      diffs.link.create.push(la.seq);
      if (PLAN_ONLY) continue;

      if (needsStaffNo && la.addStaffNumber) {
        const staffResult = await upsertCurrentStaffNumber(tx, {
          guardId: la.guardId,
          scheme: la.addStaffNumber.scheme,
          number: la.addStaffNumber.number,
          source: "system:guard-fix",
          createdBy: SYSTEM_ACTOR,
        });
        await syncLegacyStaffNoColumns(tx, la.guardId);
        // guard_staff_numbers 一直都經完整 DTO 存 audit（工號本身唔係
        // 「姓名／電話」，跟 apply-aug-plan.ts 一致做法）。
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_staff_numbers", rowId: staffResult.created.id, action: "create", after: staffResult.created, ip: null });
      }
      if (needsAlias && la.addAlias) {
        const before = await tx.guard.findUniqueOrThrow({ where: { id: la.guardId }, select: { nameAliases: true } });
        const nextAliases = [...new Set([...before.nameAliases, la.addAlias])];
        await tx.guard.update({ where: { id: la.guardId }, data: { nameAliases: nextAliases } });
        // 鐵則：audit 唔帶姓名/電話——「guards」action="update" 一律經
        // `toGuardFullDTO()` 白名單，傳精簡 object 令佢淨係揀返 `id`
        // （同 ensureGuard() 一致手法，見檔案頂註解）。
        await writeAuditTx(tx, { actorUserId: null, tableName: "guards", rowId: la.guardId, action: "update", after: { id: la.guardId }, ip: null });
      }
    }

    // -----------------------------------------------------------------
    // 2. create／create_minimal——起新安員，路徑同 opening ensureGuard()。
    // -----------------------------------------------------------------
    async function ensureNewGuard(opts: {
      seq: string;
      nameZh: string;
      alias: string | null;
      primaryTel: string | null;
      secondaryTel: string | null;
      hkid: string | null;
      hireDate: string | null;
      uNumber: string | null;
      defaultBrokerCode: string;
      diff: Diff;
    }) {
      // 冪等 natural key：有 U 號用 U 號（同 opening 一致，工號係最穩嘅
      // natural key）；冇 U 號（create_minimal）冧唔到穩定 natural key，
      // 淨係查一次同名+同電話嘅 guard 存唔存在（防止 --plan→--apply 之間
      // 又跑多次 build 產生重複身份）。
      const hkidCanon = canonicalHkid(opts.hkid);
      if (hkidCanon && existingHkids.has(hkidCanon)) {
        opts.diff.skip.push(`${opts.seq}（同身份證已有安員，唔再起，交老闆睇）`);
        return;
      }
      if (opts.uNumber) {
        const existingSn = await tx.guardStaffNumber.findUnique({ where: { number: opts.uNumber } });
        if (existingSn) {
          opts.diff.skip.push(`${opts.seq}（U 號已存在，冪等跳過）`);
          return;
        }
      } else {
        const dup = await tx.guard.findFirst({ where: { nameZh: opts.nameZh, tel: opts.primaryTel ?? undefined }, select: { id: true } });
        if (dup) {
          opts.diff.skip.push(`${opts.seq}（同名同電話已存在，冪等跳過）`);
          return;
        }
      }
      opts.diff.create.push(opts.seq);
      if (hkidCanon) existingHkids.add(hkidCanon); // 同一個 plan 入面兩項同身份證都要擋
      if (PLAN_ONLY) return;

      const broker = await tx.broker.findUnique({ where: { code: opts.defaultBrokerCode }, select: { id: true } });
      const created = await tx.guard.create({
        data: {
          nameZh: opts.nameZh,
          nameAliases: opts.alias ? [opts.alias] : [],
          hkid: opts.hkid,
          hireDate: opts.hireDate ? new Date(`${opts.hireDate}T00:00:00.000Z`) : null,
          defaultBrokerId: broker?.id ?? null,
          employmentType: "cash_casual",
          status: "active",
          createdBy: SYSTEM_ACTOR,
        },
      });
      // 鐵則：audit 唔帶姓名/電話——精簡 `after`（同 ensureGuard() 一致），
      // 淨係記錄結構性資料（U 號、雞頭碼、有冇 hkid/alias，唔存值本身）。
      await writeAuditTx(tx, {
        actorUserId: null,
        tableName: "guards",
        rowId: created.id,
        action: "create",
        after: { id: created.id, defaultBrokerId: created.defaultBrokerId, employmentType: created.employmentType, status: created.status },
        ip: null,
      });

      if (opts.uNumber) {
        const staffResult = await upsertCurrentStaffNumber(tx, {
          guardId: created.id,
          scheme: "U",
          number: opts.uNumber,
          source: "system:guard-fix",
          createdBy: SYSTEM_ACTOR,
        });
        await syncLegacyStaffNoColumns(tx, created.id);
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_staff_numbers", rowId: staffResult.created.id, action: "create", after: staffResult.created, ip: null });
      }

      if (opts.primaryTel) {
        const phoneResult = await createGuardPhone(tx, { guardId: created.id, tel: opts.primaryTel, isPrimary: true, source: "system:guard-fix", createdBy: SYSTEM_ACTOR });
        await syncLegacyGuardContactColumns(tx, created.id, ["tel"]);
        // guard_phones 精簡 audit（唔存電話本身），同 ensureGuard() 一致。
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_phones", rowId: phoneResult.created.id, action: "create", after: { id: phoneResult.created.id, guardId: phoneResult.created.guardId, isPrimary: phoneResult.created.isPrimary, source: phoneResult.created.source }, ip: null });
      }
      if (opts.secondaryTel) {
        const phoneResult2 = await createGuardPhone(tx, { guardId: created.id, tel: opts.secondaryTel, isPrimary: false, source: "system:guard-fix", createdBy: SYSTEM_ACTOR });
        await syncLegacyGuardContactColumns(tx, created.id, ["tel"]);
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_phones", rowId: phoneResult2.created.id, action: "create", after: { id: phoneResult2.created.id, guardId: phoneResult2.created.guardId, isPrimary: phoneResult2.created.isPrimary, source: phoneResult2.created.source }, ip: null });
      }
    }

    for (const ca of plan.actions.create) {
      await ensureNewGuard({
        seq: ca.seq,
        nameZh: ca.nameZh,
        alias: ca.alias,
        primaryTel: ca.primaryTel,
        secondaryTel: ca.secondaryTel,
        hkid: ca.hkid,
        hireDate: ca.hireDate,
        uNumber: ca.uNumber,
        defaultBrokerCode: ca.defaultBrokerCode,
        diff: diffs.create,
      });
    }
    for (const cm of plan.actions.createMinimal) {
      await ensureNewGuard({
        seq: cm.seq,
        nameZh: cm.nameZh,
        alias: null,
        primaryTel: cm.tel,
        secondaryTel: null,
        hkid: null,
        hireDate: null,
        uNumber: null,
        defaultBrokerCode: cm.defaultBrokerCode,
        diff: diffs.createMinimal,
      });
    }
  };

  // timeout 30 分鐘、maxWait 30 秒——同 apply-aug-plan.ts P2028 教訓一致
  // （老闆可能經 Zeabur 公開 port 對正式站行，每次來回可能幾百毫秒）。
  await prisma.$transaction(async (tx) => run(tx), { timeout: 1_800_000, maxWait: 30_000 });

  console.log(`\n=== link（登記工號／加別名）=== 處理 ${diffs.link.create.length}／跳過 ${diffs.link.skip.length}`);
  for (const s of diffs.link.skip) console.log(`  ! ${s}`);
  console.log(`=== create（新散工，U Team 名單有）=== 新建 ${diffs.create.create.length}／跳過 ${diffs.create.skip.length}`);
  for (const s of diffs.create.skip) console.log(`  ! ${s}`);
  console.log(`=== create_minimal（needs_hr）=== 新建 ${diffs.createMinimal.create.length}／跳過 ${diffs.createMinimal.skip.length}`);
  for (const s of diffs.createMinimal.skip) console.log(`  ! ${s}`);
  console.log(`\n[apply-guard-fix-plan] ${APPLY ? "已經寫入 DB（同一個 transaction）。" : "淨係印咗 diff，冇寫入（要真係寫用 --apply）。"}`);

  if (!APPLY) return;

  // -----------------------------------------------------------------
  // 3. --apply 完成之後：對目標 DB 2026-08 全部 active 上載逐個
  //    reparseRosterUpload()（順序，唔並行）。
  // -----------------------------------------------------------------
  // 驗收（Opus 5.5）：`confirmed`（對數已經寫入 shift_records）嘅上載唔
  // reparse——reparse 會刪晒 rows 再重建（新 row id），對數頁「保留系統／
  // 例外」決定係用 `row:<id>` 做 key 嘅會對唔返；已寫入嘅更亦唔會因為
  // reparse 而改。淨係列出嚟俾人知。
  const confirmedUploads = await prisma.rosterUpload.findMany({ where: { month: AUG_MONTH, status: "confirmed" }, select: { id: true, siteId: true, siteNameRaw: true } });
  const uploads = await prisma.rosterUpload.findMany({
    where: { month: AUG_MONTH, status: { notIn: ["superseded", "voided", "confirmed"] } },
    select: { id: true, siteId: true, siteNameRaw: true },
  });
  if (confirmedUploads.length) {
    console.log(`\n[apply-guard-fix-plan] ! ${confirmedUploads.length} 個 2026-08 上載已經對數確認（confirmed），唔 reparse（已寫入 shift_records 嘅唔郁）。`);
  }
  if (uploads.length === 0) {
    console.log("\n[apply-guard-fix-plan] 目標 DB 冇 2026-08 active 上載，跳過 reparse（dev 環境未上載更表嗰陣正常）。");
    return;
  }
  const siteRows = await prisma.site.findMany({ select: { id: true, canonicalName: true } });
  const siteNameById = new Map(siteRows.map((s) => [s.id, s.canonicalName]));

  async function countUnmatchedAmbiguous(uploadId: string): Promise<{ unmatched: number; ambiguous: number }> {
    const [unmatched, ambiguous] = await Promise.all([
      prisma.rosterUploadRow.count({ where: { uploadId, guardMatch: "unmatched" } }),
      prisma.rosterUploadRow.count({ where: { uploadId, guardMatch: "ambiguous" } }),
    ]);
    return { unmatched, ambiguous };
  }

  console.log(`\n=== reparse 2026-08 全部 active 上載（${uploads.length} 個）===`);
  let totalBefore = 0;
  let totalAfter = 0;
  for (const u of uploads) {
    const label = (u.siteId && siteNameById.get(u.siteId)) || u.siteNameRaw || "（盤名未定）";
    const before = await countUnmatchedAmbiguous(u.id);
    // 驗收（Opus 5.5）：經公開 port 行，大上載喺預設 5 秒 transaction
    // timeout 會 P2028——俾 10 分鐘。
    await reparseRosterUpload(u.id, { txTimeoutMs: 600_000 });
    const after = await countUnmatchedAmbiguous(u.id);
    totalBefore += before.unmatched + before.ambiguous;
    totalAfter += after.unmatched + after.ambiguous;
    console.log(`  ${label}：unmatched ${before.unmatched}→${after.unmatched}，ambiguous ${before.ambiguous}→${after.ambiguous}`);
  }
  console.log(`\n[apply-guard-fix-plan] 總結：修復前 ${totalBefore} 格未配對 → 修復後 ${totalAfter} 格未配對`);

  if (totalAfter > 0) {
    const remaining = await prisma.rosterUploadRow.findMany({
      where: { uploadId: { in: uploads.map((u) => u.id) }, guardMatch: { in: ["unmatched", "ambiguous"] } },
      select: { uploadId: true, guardMatch: true },
    });
    const bySite = new Map<string, { unmatched: number; ambiguous: number }>();
    for (const r of remaining) {
      const u = uploads.find((x) => x.id === r.uploadId)!;
      const label = (u.siteId && siteNameById.get(u.siteId)) || u.siteNameRaw || "（盤名未定）";
      if (!bySite.has(label)) bySite.set(label, { unmatched: 0, ambiguous: 0 });
      const entry = bySite.get(label)!;
      if (r.guardMatch === "unmatched") entry.unmatched += 1;
      else entry.ambiguous += 1;
    }
    console.log("剩低（盤＋格數＋原因，需要 needs_hr／needs_boss 覆核，唔印名）：");
    for (const [label, n] of bySite) {
      console.log(`  - ${label}：unmatched ${n.unmatched} 格／ambiguous ${n.ambiguous} 格`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
