// WP-GUARD-FIX-UI：套用 `GuardFixPlan` 落 DB——純邏輯模組，
// 舊 `scripts/guard-fix/apply-guard-fix-plan.ts`（2026-09-28 已刪）同 `POST /api/guard-fix/
// runs/:id/apply` 共用，唔准複製貼上一份新邏輯（WP-GUARD-FIX-UI 鐵則）。
//
// 建保安員一定用同 opening 一樣路徑：`tx.guard.create` ＋
// `upsertCurrentStaffNumber` ＋ `syncLegacyStaffNoColumns` ＋
// `createGuardPhone` ＋ `syncLegacyGuardContactColumns`。audit 精簡
// `after`（唔帶姓名／電話——同 `apply-aug-plan.ts ensureGuard()` 一致
// 手法）。冪等：工號／同名同電話已存在就 skip。
import type { PrismaClient, Prisma } from "@prisma/client";
import { writeAuditTx } from "@/lib/audit";
import { upsertCurrentStaffNumber, syncLegacyStaffNoColumns } from "@/lib/guards/staff-numbers";
import { telLookupVariants } from "@/lib/guards/identity";
import { createGuardPhone, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { reparseRosterUpload } from "@/lib/roster-upload/service";
import { canonicalHkid } from "@/lib/guard-fix/sources";
import type { GuardFixPlan } from "@/lib/guard-fix/types";

const SYSTEM_ACTOR = "system:guard-fix";

/** Opus 5.5 驗收：`pg_advisory_xact_lock` key——script 同 `POST /api/
 * guard-fix/runs/:id/apply` 共用，兩個 apply（兩個 run、或者 script＋頁
 * 面）同時行會排隊，唔會兩邊都見到「U 號／同名同電話未存在」而重複建人
 * （create_minimal 冇 unique constraint 兜底）。 */
export const GUARD_FIX_ADVISORY_LOCK_KEY = 7_710_250_925;

interface Diff {
  create: string[]; // seq
  skip: string[]; // seq（（原因））
  /** WP-STAFF-IMPORT B-fix M1：電話撞咗現有 guard_phones（全表唯一）→ 跳過唔寫，記 `seq:tel_skipped_duplicate`。有先出現。 */
  telSkipped?: string[];
}
function emptyDiff(): Diff {
  return { create: [], skip: [] };
}

export interface ApplyGuardFixPlanDiffs {
  link: Diff;
  create: Diff;
  createMinimal: Diff;
  setLongterm: Diff;
  setLongtermPost: Diff;
  setReferral: Diff;
  setReferralInferred: Diff;
  setVisa: Diff;
}

export interface ApplyGuardFixPlanOptions {
  prisma: PrismaClient;
  plan: GuardFixPlan;
  /** true＝淨係計 diff（新建/連結/跳過數目），唔寫入——同 script `--plan`
   * 一致。 */
  planOnly: boolean;
  /** transaction timeout（ms）——老闆可能經 Zeabur 公開 port 對正式站
   * 行，見 P2028 教訓。預設 30 分鐘（同 script 一致）。 */
  txTimeoutMs?: number;
  /** WP-LTSHIFT §19：`set_longterm_post` 新建崗位記錄嘅 `effective_from`
   * ——冇傳就跌返用 `plan.generatedAt` 嗰個月首日（保底；正式 call site
   * 應該傳 `guard_fix_runs.month`）。 */
  month?: Date;
}

/** 一個 transaction，冪等。回傳逐類 diff（create=呢次處理咗幾多、
 * skip=跳過幾多＋原因）。 */
export async function applyGuardFixPlan(opts: ApplyGuardFixPlanOptions): Promise<ApplyGuardFixPlanDiffs> {
  const { prisma, plan, planOnly } = opts;
  const diffs: ApplyGuardFixPlanDiffs = {
    link: emptyDiff(),
    create: emptyDiff(),
    createMinimal: emptyDiff(),
    setLongterm: emptyDiff(),
    setLongtermPost: emptyDiff(),
    setReferral: emptyDiff(),
    setReferralInferred: emptyDiff(),
    setVisa: emptyDiff(),
  };
  const effectiveFrom = opts.month ?? new Date(`${plan.generatedAt.slice(0, 7)}-01T00:00:00.000Z`);

  const run = async (tx: Prisma.TransactionClient) => {
    // 排隊：同一時間淨係一個 apply transaction（見 GUARD_FIX_ADVISORY_LOCK_KEY）。
    // 攞到 lock 之後先讀 DB 現狀，前一個 apply 已 commit 嘅新人／工號睇得到。
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${GUARD_FIX_ADVISORY_LOCK_KEY})`);
    const existingHkids = new Set(
      (await tx.guard.findMany({ where: { hkid: { not: null } }, select: { hkid: true } })).map((g) => canonicalHkid(g.hkid)).filter((x): x is string => !!x),
    );

    // -----------------------------------------------------------------
    // 1. link——登記工號／加別名到現有保安員。
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
        if (existing && existing.guardId !== la.guardId) {
          diffs.link.skip.push(`${la.seq}（工號已經屬另一位保安員，成項唔做，交老闆睇）`);
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
      if (planOnly) continue;

      if (needsStaffNo && la.addStaffNumber) {
        const staffResult = await upsertCurrentStaffNumber(tx, {
          guardId: la.guardId,
          scheme: la.addStaffNumber.scheme,
          number: la.addStaffNumber.number,
          source: "system:guard-fix",
          createdBy: SYSTEM_ACTOR,
        });
        await syncLegacyStaffNoColumns(tx, la.guardId);
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_staff_numbers", rowId: staffResult.created.id, action: "create", after: staffResult.created, ip: null });
      }
      if (needsAlias && la.addAlias) {
        const before = await tx.guard.findUniqueOrThrow({ where: { id: la.guardId }, select: { nameAliases: true } });
        const nextAliases = [...new Set([...before.nameAliases, la.addAlias])];
        await tx.guard.update({ where: { id: la.guardId }, data: { nameAliases: nextAliases } });
        await writeAuditTx(tx, { actorUserId: null, tableName: "guards", rowId: la.guardId, action: "update", after: { id: la.guardId }, ip: null });
      }
    }

    // -----------------------------------------------------------------
    // 2. create／create_minimal——起新保安員，路徑同 opening ensureGuard()。
    // -----------------------------------------------------------------
    async function ensureNewGuard(input: {
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
    }): Promise<string | null> {
      const hkidCanon = canonicalHkid(input.hkid);
      if (hkidCanon && existingHkids.has(hkidCanon)) {
        input.diff.skip.push(`${input.seq}（同身份證已有保安員，唔再起，交老闆睇）`);
        return null;
      }
      if (input.uNumber) {
        const existingSn = await tx.guardStaffNumber.findUnique({ where: { number: input.uNumber } });
        if (existingSn) {
          input.diff.skip.push(`${input.seq}（U 號已存在，冪等跳過）`);
          return null;
        }
      } else {
        const dup = await tx.guard.findFirst({ where: { nameZh: input.nameZh, tel: input.primaryTel ?? undefined }, select: { id: true } });
        if (dup) {
          input.diff.skip.push(`${input.seq}（同名同電話已存在，冪等跳過）`);
          return null;
        }
      }
      input.diff.create.push(input.seq);
      if (hkidCanon) existingHkids.add(hkidCanon);
      if (planOnly) return null;

      const broker = await tx.broker.findUnique({ where: { code: input.defaultBrokerCode }, select: { id: true } });
      const created = await tx.guard.create({
        data: {
          nameZh: input.nameZh,
          nameAliases: input.alias ? [input.alias] : [],
          hkid: input.hkid,
          hireDate: input.hireDate ? new Date(`${input.hireDate}T00:00:00.000Z`) : null,
          defaultBrokerId: broker?.id ?? null,
          employmentType: "cash_casual",
          status: "active",
          createdBy: SYSTEM_ACTOR,
        },
      });
      await writeAuditTx(tx, {
        actorUserId: null,
        tableName: "guards",
        rowId: created.id,
        action: "create",
        after: { id: created.id, defaultBrokerId: created.defaultBrokerId, employmentType: created.employmentType, status: created.status },
        ip: null,
      });

      if (input.uNumber) {
        const staffResult = await upsertCurrentStaffNumber(tx, { guardId: created.id, scheme: "U", number: input.uNumber, source: "system:guard-fix", createdBy: SYSTEM_ACTOR });
        await syncLegacyStaffNoColumns(tx, created.id);
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_staff_numbers", rowId: staffResult.created.id, action: "create", after: staffResult.created, ip: null });
      }
      // 電話全表唯一：撞咗現有電話（或者本次 apply 較早建嘅人）→ 跳過唔寫，guard 照建，唔 rollback。
      const addTel = async (rawTel: string, isPrimary: boolean) => {
        const variants = telLookupVariants(rawTel);
        const clash = variants.length ? await tx.guardPhone.findFirst({ where: { tel: { in: variants } }, select: { id: true } }) : null;
        if (clash) {
          (input.diff.telSkipped ??= []).push(`${input.seq}:tel_skipped_duplicate`);
          return;
        }
        const pr = await createGuardPhone(tx, { guardId: created.id, tel: rawTel, isPrimary, source: "system:guard-fix", createdBy: SYSTEM_ACTOR });
        await syncLegacyGuardContactColumns(tx, created.id, ["tel"]);
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_phones", rowId: pr.created.id, action: "create", after: { id: pr.created.id, guardId: pr.created.guardId, isPrimary: pr.created.isPrimary, source: pr.created.source }, ip: null });
      };
      if (input.primaryTel) await addTel(input.primaryTel, true);
      if (input.secondaryTel) await addTel(input.secondaryTel, false);
      return created.id;
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
      // 驗收（Opus 5.5）：工號衝突保守預設——同一個「工號＋更表姓名」已經
      // 有 override 就冪等跳過（唔再起多個人）。
      if (cm.matchOverrideStaffNo) {
        const existingOverride = await tx.guardMatchOverride.findUnique({ where: { staffNo_nameRaw: { staffNo: cm.matchOverrideStaffNo, nameRaw: cm.nameZh.trim() } } });
        if (existingOverride && existingOverride.voidedAt === null) {
          diffs.createMinimal.skip.push(`${cm.seq}（工號衝突保守預設已套用過，冪等跳過）`);
          continue;
        }
      }
      const newGuardId = await ensureNewGuard({
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
      if (newGuardId && cm.conservative) {
        // audit 留低「保守預設、待核」原因（guards 表冇 note 欄）。
        await writeAuditTx(tx, {
          actorUserId: null,
          tableName: "guards",
          rowId: newGuardId,
          action: "guard_fix_conservative_default",
          after: { id: newGuardId, conservative: cm.conservative, note: cm.conservative === "staff_no_conflict" ? "工號衝突待核" : "淨係姓名對到名單、未能核實，待核" },
          ip: null,
        });
      }
      if (newGuardId && cm.matchOverrideStaffNo) {
        const override = await tx.guardMatchOverride.upsert({
          where: { staffNo_nameRaw: { staffNo: cm.matchOverrideStaffNo, nameRaw: cm.nameZh.trim() } },
          create: { staffNo: cm.matchOverrideStaffNo, nameRaw: cm.nameZh.trim(), guardId: newGuardId, reason: "工號衝突待核（guard-fix 保守預設：按更表姓名建獨立保安員）", createdBy: SYSTEM_ACTOR },
          update: { guardId: newGuardId, voidedAt: null, voidedBy: null },
        });
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_match_overrides", rowId: override.id, action: "create", after: { id: override.id, guardId: newGuardId, reason: override.reason }, ip: null });
      }
    }

    // -----------------------------------------------------------------
    // 3. set_longterm——`employment_type` 改做 longterm_autopay（同一個
    //    guardId 淨係喺套用嗰一刻先再查一次現況，避免同一個 run 入面
    //    兩個 action 撞、或者呢個保安員套用之間俾人手改咗）。
    // -----------------------------------------------------------------
    for (const sa of plan.actions.setLongterm) {
      const guard = await tx.guard.findUnique({ where: { id: sa.guardId }, select: { id: true, employmentType: true } });
      if (!guard) {
        diffs.setLongterm.skip.push(`${sa.seq}（guard_id 搵唔到，可能已刪）`);
        continue;
      }
      if (guard.employmentType.startsWith("longterm_")) {
        diffs.setLongterm.skip.push(`${sa.seq}（已經係長工，冪等跳過）`);
        continue;
      }
      diffs.setLongterm.create.push(sa.seq);
      if (planOnly) continue;
      await tx.guard.update({ where: { id: sa.guardId }, data: { employmentType: "longterm_autopay" } });
      await writeAuditTx(tx, {
        actorUserId: null,
        tableName: "guards",
        rowId: sa.guardId,
        action: "update",
        after: { id: sa.guardId, employmentType: "longterm_autopay" },
        ip: null,
      });
    }

    // -----------------------------------------------------------------
    // 4. set_longterm_post——新建生效中崗位記錄（`source=manual`，見
    //    prisma/schema.prisma GuardLongtermPost 大註解：guard-fix
    //    set_longterm_post 計劃套用同老闆手動加同一種來源）。
    // -----------------------------------------------------------------
    for (const sp of plan.actions.setLongtermPost) {
      const existing = await tx.guardLongtermPost.findFirst({ where: { guardId: sp.guardId, siteId: sp.siteId, voidedAt: null, source: "manual" }, select: { id: true } });
      if (existing) {
        diffs.setLongtermPost.skip.push(`${sp.seq}（已經有生效崗位記錄，冪等跳過）`);
        continue;
      }
      diffs.setLongtermPost.create.push(sp.seq);
      if (planOnly) continue;
      // 驗收（Opus 5.5）：同組合之前由占比推算建咗 inferred 崗位——總表已經
      // 確認，作廢推算嗰條（留歷史），下面建 manual。
      const inferredSame = await tx.guardLongtermPost.findMany({ where: { guardId: sp.guardId, siteId: sp.siteId, voidedAt: null, source: "inferred" } });
      for (const inf of inferredSame) {
        const voided = await tx.guardLongtermPost.update({ where: { id: inf.id }, data: { voidedAt: new Date(), voidedBy: SYSTEM_ACTOR } });
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_longterm_posts", rowId: inf.id, action: "void", before: inf, after: voided, ip: null });
      }
      const created = await tx.guardLongtermPost.create({
        data: {
          guardId: sp.guardId,
          siteId: sp.siteId,
          effectiveFrom,
          effectiveTo: null,
          source: "manual",
          note: `guard-fix set_longterm_post（Postorder 上載，${sp.cellCount} 格）`,
          createdBy: SYSTEM_ACTOR,
        },
      });
      await writeAuditTx(tx, { actorUserId: null, tableName: "guard_longterm_posts", rowId: created.id, action: "create", after: created, ip: null });
    }

    // -----------------------------------------------------------------
    // 5. set_referral——`guards.referral_broker_id`。
    // -----------------------------------------------------------------
    for (const sr of plan.actions.setReferral) {
      const guard = await tx.guard.findUnique({ where: { id: sr.guardId }, select: { id: true, referralBrokerId: true } });
      if (!guard) {
        diffs.setReferral.skip.push(`${sr.seq}（guard_id 搵唔到，可能已刪）`);
        continue;
      }
      if (guard.referralBrokerId === sr.brokerId) {
        diffs.setReferral.skip.push(`${sr.seq}（已經係呢個雞頭，冪等跳過）`);
        continue;
      }
      diffs.setReferral.create.push(sr.seq);
      if (planOnly) continue;
      await tx.guard.update({ where: { id: sr.guardId }, data: { referralBrokerId: sr.brokerId } });
      await writeAuditTx(tx, { actorUserId: null, tableName: "guards", rowId: sr.guardId, action: "update", after: { id: sr.guardId, referralBrokerId: sr.brokerId }, ip: null });
    }

    // -----------------------------------------------------------------
    // 5b. set_referral_inferred（WP-REFERRAL-FALLBACK）——`guards.
    //     referral_broker_id`，同 set_referral 一樣欄位，淨係嚟源唔同
    //     （唔靠 Postorder，睇更表雞頭碼推算）。冪等：套用前再查一次現況，
    //     已經有值（呢個 run 嘅 set_referral、或者人手／舊 run 設過）就
    //     skip，唔會覆蓋。
    // -----------------------------------------------------------------
    for (const sri of plan.actions.setReferralInferred) {
      const guard = await tx.guard.findUnique({ where: { id: sri.guardId }, select: { id: true, referralBrokerId: true } });
      if (!guard) {
        diffs.setReferralInferred.skip.push(`${sri.seq}（guard_id 搵唔到，可能已刪）`);
        continue;
      }
      if (guard.referralBrokerId !== null) {
        diffs.setReferralInferred.skip.push(`${sri.seq}（已經有介紹雞頭，冪等跳過）`);
        continue;
      }
      diffs.setReferralInferred.create.push(sri.seq);
      if (planOnly) continue;
      await tx.guard.update({ where: { id: sri.guardId }, data: { referralBrokerId: sri.brokerId } });
      await writeAuditTx(tx, { actorUserId: null, tableName: "guards", rowId: sri.guardId, action: "update", after: { id: sri.guardId, referralBrokerId: sri.brokerId, source: "guard_fix_referral_inferred" }, ip: null });
    }

    // -----------------------------------------------------------------
    // 6. set_visa——`guards.visa_sponsored_by_broker_id`（Postorder 暫時
    //    冇顯式標記，`plan.actions.setVisa` 一律空 array，呢段留低等
    //    parser 之後補實作）。
    // -----------------------------------------------------------------
    for (const sv of plan.actions.setVisa) {
      const guard = await tx.guard.findUnique({ where: { id: sv.guardId }, select: { id: true, visaSponsoredByBrokerId: true } });
      if (!guard) {
        diffs.setVisa.skip.push(`${sv.seq}（guard_id 搵唔到，可能已刪）`);
        continue;
      }
      if (guard.visaSponsoredByBrokerId === sv.brokerId) {
        diffs.setVisa.skip.push(`${sv.seq}（已經係呢個贊助雞頭，冪等跳過）`);
        continue;
      }
      diffs.setVisa.create.push(sv.seq);
      if (planOnly) continue;
      await tx.guard.update({ where: { id: sv.guardId }, data: { visaSponsoredByBrokerId: sv.brokerId } });
      await writeAuditTx(tx, { actorUserId: null, tableName: "guards", rowId: sv.guardId, action: "update", after: { id: sv.guardId, visaSponsoredByBrokerId: sv.brokerId }, ip: null });
    }
  };

  await prisma.$transaction(async (tx) => run(tx), { timeout: opts.txTimeoutMs ?? 1_800_000, maxWait: 30_000 });
  return diffs;
}

interface ReparseSiteResult {
  siteLabel: string;
  uploadId: string;
  before: { unmatched: number; ambiguous: number };
  after: { unmatched: number; ambiguous: number };
}

export interface ReparseAllResult {
  confirmedSkippedCount: number;
  perUpload: ReparseSiteResult[];
  totalBefore: number;
  totalAfter: number;
}

/** apply 完成之後對呢個月全部 active（非 confirmed）上載順序
 * `reparseRosterUpload()`——`confirmed`（已寫入 shift_records）唔
 * reparse（reparse 換晒 row id，對數決定 `row:<id>` 對唔返）。順序而
 * 唔並行，同一個 DB connection pool。 */
export async function reparseAllActiveUploads(prisma: PrismaClient, month: Date, opts: { txTimeoutMs?: number } = {}): Promise<ReparseAllResult> {
  const confirmedUploads = await prisma.rosterUpload.findMany({ where: { month, status: "confirmed" }, select: { id: true } });
  const uploads = await prisma.rosterUpload.findMany({
    where: { month, status: { notIn: ["superseded", "voided", "confirmed"] } },
    select: { id: true, siteId: true, siteNameRaw: true },
  });
  const siteRows = await prisma.site.findMany({ select: { id: true, canonicalName: true } });
  const siteNameById = new Map(siteRows.map((s) => [s.id, s.canonicalName]));

  async function countUnmatchedAmbiguous(uploadId: string): Promise<{ unmatched: number; ambiguous: number }> {
    const [unmatched, ambiguous] = await Promise.all([
      prisma.rosterUploadRow.count({ where: { uploadId, guardMatch: "unmatched" } }),
      prisma.rosterUploadRow.count({ where: { uploadId, guardMatch: "ambiguous" } }),
    ]);
    return { unmatched, ambiguous };
  }

  const perUpload: ReparseSiteResult[] = [];
  let totalBefore = 0;
  let totalAfter = 0;
  for (const u of uploads) {
    const label = (u.siteId && siteNameById.get(u.siteId)) || u.siteNameRaw || "（盤名未定）";
    const before = await countUnmatchedAmbiguous(u.id);
    await reparseRosterUpload(u.id, { txTimeoutMs: opts.txTimeoutMs ?? 600_000 });
    const after = await countUnmatchedAmbiguous(u.id);
    totalBefore += before.unmatched + before.ambiguous;
    totalAfter += after.unmatched + after.ambiguous;
    perUpload.push({ siteLabel: label, uploadId: u.id, before, after });
  }
  return { confirmedSkippedCount: confirmedUploads.length, perUpload, totalBefore, totalAfter };
}
