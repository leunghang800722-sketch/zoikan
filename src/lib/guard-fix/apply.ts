// WP-GUARD-FIX-UI：套用 `GuardFixPlan` 落 DB——純邏輯模組，
// `scripts/guard-fix/apply-guard-fix-plan.ts` 同 `POST /api/guard-fix/
// runs/:id/apply` 共用，唔准複製貼上一份新邏輯（WP-GUARD-FIX-UI 鐵則）。
//
// 建安員一定用同 opening 一樣路徑：`tx.guard.create` ＋
// `upsertCurrentStaffNumber` ＋ `syncLegacyStaffNoColumns` ＋
// `createGuardPhone` ＋ `syncLegacyGuardContactColumns`。audit 精簡
// `after`（唔帶姓名／電話——同 `apply-aug-plan.ts ensureGuard()` 一致
// 手法）。冪等：工號／同名同電話已存在就 skip。
import type { PrismaClient, Prisma } from "@prisma/client";
import { writeAuditTx } from "@/lib/audit";
import { upsertCurrentStaffNumber, syncLegacyStaffNoColumns } from "@/lib/guards/staff-numbers";
import { createGuardPhone, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { reparseRosterUpload } from "@/lib/roster-upload/service";
import { canonicalHkid } from "@/lib/guard-fix/sources";
import type { GuardFixPlan } from "@/lib/guard-fix/types";

const SYSTEM_ACTOR = "system:guard-fix";

export interface Diff {
  create: string[]; // seq
  skip: string[]; // seq（（原因））
}
function emptyDiff(): Diff {
  return { create: [], skip: [] };
}

export interface ApplyGuardFixPlanDiffs {
  link: Diff;
  create: Diff;
  createMinimal: Diff;
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
}

/** 一個 transaction，冪等。回傳逐類 diff（create=呢次處理咗幾多、
 * skip=跳過幾多＋原因）。 */
export async function applyGuardFixPlan(opts: ApplyGuardFixPlanOptions): Promise<ApplyGuardFixPlanDiffs> {
  const { prisma, plan, planOnly } = opts;
  const diffs: ApplyGuardFixPlanDiffs = { link: emptyDiff(), create: emptyDiff(), createMinimal: emptyDiff() };

  const run = async (tx: Prisma.TransactionClient) => {
    const existingHkids = new Set(
      (await tx.guard.findMany({ where: { hkid: { not: null } }, select: { hkid: true } })).map((g) => canonicalHkid(g.hkid)).filter((x): x is string => !!x),
    );

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
    // 2. create／create_minimal——起新安員，路徑同 opening ensureGuard()。
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
    }) {
      const hkidCanon = canonicalHkid(input.hkid);
      if (hkidCanon && existingHkids.has(hkidCanon)) {
        input.diff.skip.push(`${input.seq}（同身份證已有安員，唔再起，交老闆睇）`);
        return;
      }
      if (input.uNumber) {
        const existingSn = await tx.guardStaffNumber.findUnique({ where: { number: input.uNumber } });
        if (existingSn) {
          input.diff.skip.push(`${input.seq}（U 號已存在，冪等跳過）`);
          return;
        }
      } else {
        const dup = await tx.guard.findFirst({ where: { nameZh: input.nameZh, tel: input.primaryTel ?? undefined }, select: { id: true } });
        if (dup) {
          input.diff.skip.push(`${input.seq}（同名同電話已存在，冪等跳過）`);
          return;
        }
      }
      input.diff.create.push(input.seq);
      if (hkidCanon) existingHkids.add(hkidCanon);
      if (planOnly) return;

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
      if (input.primaryTel) {
        const phoneResult = await createGuardPhone(tx, { guardId: created.id, tel: input.primaryTel, isPrimary: true, source: "system:guard-fix", createdBy: SYSTEM_ACTOR });
        await syncLegacyGuardContactColumns(tx, created.id, ["tel"]);
        await writeAuditTx(tx, { actorUserId: null, tableName: "guard_phones", rowId: phoneResult.created.id, action: "create", after: { id: phoneResult.created.id, guardId: phoneResult.created.guardId, isPrimary: phoneResult.created.isPrimary, source: phoneResult.created.source }, ip: null });
      }
      if (input.secondaryTel) {
        const phoneResult2 = await createGuardPhone(tx, { guardId: created.id, tel: input.secondaryTel, isPrimary: false, source: "system:guard-fix", createdBy: SYSTEM_ACTOR });
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

  await prisma.$transaction(async (tx) => run(tx), { timeout: opts.txTimeoutMs ?? 1_800_000, maxWait: 30_000 });
  return diffs;
}

export interface ReparseSiteResult {
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
