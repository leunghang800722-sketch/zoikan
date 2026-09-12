// P1-WP3：更表編輯器「批量儲存」——同一 site × month 內多格一次寫入
// （設計文件§4.1/§4.2、P1-執行計劃.md §4 WP3）。逐格同樣過閘，任何一格
// 驗證失敗（403/400）令**成批 rollback**（唔會部分寫入）：做法係先逐格
// validate 晒（唔掂 DB 寫入），一有錯即刻 throw（乜都未寫），驗證全過
// 先開一個 `prisma.$transaction()` 逐格寫入（DB 層面嘅 unique 衝突都會
// 令成個 transaction rollback，回 409）。
//
// 每格代表一個「行」（guard_id + shift_type_id，即更別／時段）× 一日
// （work_date）：
//   code = null/""  → 清格。已存在嘅記錄先有嘢做——status=cancelled
//                      （硬性規則「只有作廢冇刪除」，唔做真刪除）。
//                      雞頭淨係可以清自己**未 confirm**（draft/
//                      pending_approval）嘅格；已經 confirmed 嘅要主管
//                      用 /api/shift-records/:id/void（附原因）。
//   code = 更別本身代號（cell.shift_type_id 嗰個 shift_type.code）
//                    → record_type=shift（出勤）。
//   code = LeaveCode（AL/NL/RD/SL/SH）→ record_type=leave。
//   其他 code            → 400（同呢行嘅更別／請假代號都對唔上）。
//
// 已存在記錄嘅狀態轉移（設計文件§4.2「雞頭改自己已confirmed嘅更→重入
// 審批」）：
//   - 雞頭改自己 status=confirmed 嘅格 → 新狀態一律 pending_approval
//     （唔理 brokers.requires_approval，改咗就要再批）。
//   - 雞頭改自己 status=draft/pending_approval 嘅格 → 維持
//     pending_approval/draft 邏輯：新建時用 requires_approval 決定，
//     修改未批嘅內容唔使再轉一次（本身都仲未批）。
//   - 內部角色（老闆/主管，有「更表:update」）直接改，status 一律
//     confirmed，唔使入審批隊列（設計文件§4.2「主管或有權者直接改」）。
import { prisma } from "@/lib/db";
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import {
  isBrokerRole,
  requireOwnBrokerId,
  assertGuardOwnedByBroker,
  assertSiteAssignedToBroker,
} from "@/lib/broker-isolation";
import { assertMonthNotLocked, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { ShiftRecordBatchSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Forbidden, Conflict } from "@/lib/api/errors";
import { LeaveCode, type Prisma, type ShiftRecordStatus } from "@prisma/client";

const LEAVE_CODES = new Set<string>(Object.values(LeaveCode));

type Cell = {
  guard_id: string;
  shift_type_id: string;
  work_date: Date;
  code?: string | null;
  settlement_broker_id?: string;
  operational_broker_id?: string;
};

type PlannedOp =
  | { kind: "noop"; cell: Cell }
  | { kind: "clear"; cell: Cell; existingId: string }
  | {
      kind: "upsert";
      cell: Cell;
      existingId: string | null;
      recordType: "shift" | "leave";
      leaveCode: string | null;
      settlementBrokerId: string | null;
      operationalBrokerId: string | null;
      status: ShiftRecordStatus;
    };

export async function POST(req: Request) {
  return withApiError(async () => {
    // baseline 進閘：更表:create（雞頭出廠 grant——「雞頭配額內填人」；
    // 內部角色逐格再視乎新建/修改/清格細分要求 create/update/void）。
    const session = await requirePermission(req, "更表", "create");
    const rawBody = await readJson(req);
    const parsed = parseBody(ShiftRecordBatchSchema, rawBody);

    const monthParsed = new Date(parsed.month.length <= 7 ? `${parsed.month}-01` : parsed.month);
    if (Number.isNaN(monthParsed.getTime())) throw BadRequest("month 格式唔啱（YYYY-MM）");
    const month = monthStart(monthParsed);
    const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));

    const broker = isBrokerRole(session) ? requireOwnBrokerId(session) : null;
    if (broker) {
      await assertSiteAssignedToBroker(parsed.site_id, broker, month);
    }

    await assertMonthNotLocked({ workDate: month, actorUserId: session.userId, tableName: "shift_records", rowId: "batch", ip: getClientIp(req) });

    // ---- 逐格 validate（未寫入任何嘢）----------------------------------
    const cells = parsed.cells as Cell[];
    for (const c of cells) {
      if (c.work_date < month || c.work_date > monthEnd) {
        throw BadRequest(`work_date ${c.work_date.toISOString().slice(0, 10)} 唔屬於 ${parsed.month}`);
      }
    }

    const shiftTypeIds = [...new Set(cells.map((c) => c.shift_type_id))];
    const shiftTypes = await prisma.shiftType.findMany({ where: { id: { in: shiftTypeIds } } });
    const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s]));
    for (const stId of shiftTypeIds) {
      const st = shiftTypeById.get(stId);
      if (!st) throw BadRequest(`shift_type_id ${stId} 唔存在`);
      if (st.siteId !== parsed.site_id) throw BadRequest(`shift_type_id ${stId} 唔屬於呢個 site_id`);
    }

    const guardIds = [...new Set(cells.map((c) => c.guard_id))];
    const guards = await prisma.guard.findMany({ where: { id: { in: guardIds } } });
    const guardById = new Map(guards.map((g) => [g.id, g]));
    for (const gId of guardIds) {
      if (!guardById.get(gId)) throw BadRequest(`guard_id ${gId} 唔存在`);
    }
    if (broker) {
      for (const gId of guardIds) {
        await assertGuardOwnedByBroker(gId, broker); // C1：guard 嫁接防線
      }
    }

    const canVoid = await hasPermission(session, "更表", "void");
    const canUpdate = await hasPermission(session, "更表", "update");

    const existing = await prisma.shiftRecord.findMany({
      where: {
        siteId: parsed.site_id,
        workDate: { gte: month, lte: monthEnd },
        guardId: { in: guardIds },
        shiftTypeId: { in: shiftTypeIds },
      },
    });
    const existingByKey = new Map(existing.map((r) => [`${r.guardId}|${r.workDate.toISOString().slice(0, 10)}|${r.shiftTypeId}`, r]));

    let requiresApprovalForNewBroker: boolean | null = null;
    if (broker) {
      const brokerRow = await prisma.broker.findUniqueOrThrow({ where: { id: broker }, select: { requiresApproval: true } });
      requiresApprovalForNewBroker = brokerRow.requiresApproval;
    }

    const plans: PlannedOp[] = [];
    for (const c of cells) {
      const st = shiftTypeById.get(c.shift_type_id)!;
      const key = `${c.guard_id}|${c.work_date.toISOString().slice(0, 10)}|${c.shift_type_id}`;
      const record = existingByKey.get(key) ?? null;
      const code = c.code && c.code.trim() !== "" ? c.code.trim() : null;

      if (code === null) {
        if (!record) {
          plans.push({ kind: "noop", cell: c });
          continue;
        }
        if (broker) {
          if (record.status === "confirmed" || record.status === "completed") {
            throw Forbidden(`已確認嘅更次（${key}）唔可以自己清格，請聯絡主管作廢`);
          }
          if (record.settlementBrokerId !== broker && record.operationalBrokerId !== broker) {
            throw Forbidden(`呢格（${key}）唔屬於你`);
          }
          plans.push({ kind: "clear", cell: c, existingId: record.id });
          continue;
        }
        if (!canVoid) throw Forbidden("冇「更表:void」權限，唔可以清格");
        plans.push({ kind: "clear", cell: c, existingId: record.id });
        continue;
      }

      const isLeave = LEAVE_CODES.has(code);
      const isOwnShiftCode = code === st.code;
      if (!isLeave && !isOwnShiftCode) {
        throw BadRequest(`code "${code}"（${key}）同呢行嘅更別代號「${st.code}」／請假代號都對唔上`);
      }

      let settlementBrokerId: string | null;
      let operationalBrokerId: string | null;
      let status: ShiftRecordStatus;

      if (broker) {
        settlementBrokerId = broker;
        operationalBrokerId = broker;
        if (record && (record.status === "confirmed" || record.status === "completed")) {
          status = "pending_approval"; // §4.2：雞頭改自己已confirmed嘅更→重入審批
        } else if (record) {
          status = record.status; // 未批嘅內容自己再改，狀態不變
        } else {
          status = requiresApprovalForNewBroker ? "pending_approval" : "confirmed";
        }
      } else {
        if (record && !canUpdate) throw Forbidden("冇「更表:update」權限，唔可以改呢格");
        if (!record && !(await hasPermission(session, "更表", "create"))) throw Forbidden("冇「更表:create」權限");
        settlementBrokerId = c.settlement_broker_id ?? record?.settlementBrokerId ?? guardById.get(c.guard_id)!.defaultBrokerId ?? null;
        operationalBrokerId = c.operational_broker_id ?? record?.operationalBrokerId ?? guardById.get(c.guard_id)!.defaultBrokerId ?? null;
        status = "confirmed"; // 主管/有權者直接改，唔使入審批隊列
      }

      plans.push({
        kind: "upsert",
        cell: c,
        existingId: record?.id ?? null,
        recordType: isLeave ? "leave" : "shift",
        leaveCode: isLeave ? code : null,
        settlementBrokerId,
        operationalBrokerId,
        status,
      });
    }

    // ---- 全部 validate 過關，先開 transaction 寫入 --------------------
    // 重要：`writeAudit()` 用嘅係外層 `prisma`（唔係 `tx`）嚟寫
    // audit_log——喺 `$transaction` callback 入面直接 call 佢嘅話，audit
    // 記錄會即刻獨立 commit，同呢個 transaction 本身唔同步：如果 transaction
    // 之後先撞 P2002 rollback，之前幾格已經寫低嘅 audit_log 會變成「孤兒」
    // （指住一條已經俾 rollback 走嘅記錄）。所以呢度**淨係喺 transaction
    // 入面收集 audit 素材，transaction 成功 commit 之後先真係逐條
    // writeAudit()**，保證 audit_log 同實際落咗 DB 嘅嘢一致。
    const ip = getClientIp(req);
    const results: { key: string; id: string; action: string }[] = [];
    type PendingAudit = { rowId: string; action: "create" | "update" | "void"; before?: unknown; after: unknown };
    const pendingAudits: PendingAudit[] = [];
    try {
      await prisma.$transaction(async (tx) => {
        for (const plan of plans) {
          const key = `${plan.cell.guard_id}|${plan.cell.work_date.toISOString().slice(0, 10)}|${plan.cell.shift_type_id}`;
          if (plan.kind === "noop") continue;
          if (plan.kind === "clear") {
            const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: plan.existingId } });
            const after = await tx.shiftRecord.update({ where: { id: plan.existingId }, data: { status: "cancelled" } });
            pendingAudits.push({ rowId: plan.existingId, action: "void", before, after: { ...after, void_reason: "batch:clear_cell" } });
            results.push({ key, id: plan.existingId, action: "cleared" });
            continue;
          }
          // upsert
          if (plan.existingId) {
            const before = await tx.shiftRecord.findUniqueOrThrow({ where: { id: plan.existingId } });
            const after = await tx.shiftRecord.update({
              where: { id: plan.existingId },
              data: {
                recordType: plan.recordType,
                leaveCode: plan.leaveCode as never,
                settlementBrokerId: plan.settlementBrokerId,
                operationalBrokerId: plan.operationalBrokerId,
                status: plan.status,
              },
            });
            pendingAudits.push({ rowId: plan.existingId, action: "update", before, after });
            results.push({ key, id: plan.existingId, action: "updated" });
          } else {
            const data: Prisma.ShiftRecordUncheckedCreateInput = {
              workDate: plan.cell.work_date,
              siteId: parsed.site_id,
              shiftTypeId: plan.cell.shift_type_id,
              guardId: plan.cell.guard_id,
              settlementBrokerId: plan.settlementBrokerId,
              operationalBrokerId: plan.operationalBrokerId,
              recordType: plan.recordType,
              leaveCode: plan.leaveCode as never,
              status: plan.status,
              createdBy: session.userId,
            };
            const created = await tx.shiftRecord.create({ data });
            pendingAudits.push({ rowId: created.id, action: "create", after: created });
            results.push({ key, id: created.id, action: "created" });
          }
        }
      });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
        throw Conflict("批量寫入撞到唯一約束（同一安員、同一日、同一更別已經有記錄）——成批已 rollback");
      }
      throw err;
    }

    // transaction 已經成功 commit——而家先逐條真係寫 audit_log。
    for (const a of pendingAudits) {
      await writeAudit({ actorUserId: session.userId, tableName: "shift_records", rowId: a.rowId, action: a.action, before: a.before, after: a.after, ip });
    }

    const warnings = await computeWarnings(guardIds, parsed.site_id, month, monthEnd, broker);

    return ok(brandSafeResponse({ results, warnings }), 200);
  });
}

// Opus 對抗式驗收「警示 UUID」：`computeWarnings()` 回應之前直接內嵌
// `guardId`／`shiftTypeId`／`brokerId` 呢類內部 UUID 落警示文字——對
// 雞頭（甚至內部角色）嚟講都冇意義，仲會意外印出其他人／盤嘅內部 id。
// 而家逐個 resolve 做代號／姓名／更別代號。`ownBrokerId`（雞頭角色先有
// 值）令超配額警示淨係講自己嘅配額，唔會見到其他雞頭嘅配額狀態。
async function computeWarnings(
  guardIds: string[],
  siteId: string,
  month: Date,
  monthEnd: Date,
  ownBrokerId: string | null,
): Promise<string[]> {
  const warnings: string[] = [];

  const guards = await prisma.guard.findMany({ where: { id: { in: guardIds } }, select: { id: true, nameZh: true, siaPermitExpiry: true } });
  const guardName = (id: string): string => guards.find((g) => g.id === id)?.nameZh ?? id.slice(0, 8);

  // 軟警示：單月 >26 更（record_type=shift，唔計 cancelled）
  const monthlyCounts = await prisma.shiftRecord.groupBy({
    by: ["guardId"],
    where: { guardId: { in: guardIds }, recordType: "shift", status: { not: "cancelled" }, workDate: { gte: month, lte: monthEnd } },
    _count: { _all: true },
  });
  for (const row of monthlyCounts) {
    if (row._count._all > 26) warnings.push(`安員 ${guardName(row.guardId)} 本月已排 ${row._count._all} 更（>26）`);
  }

  // 軟警示：同人同日多更（跨盤/跨更別都計，record_type=shift）
  const dayRows = await prisma.shiftRecord.findMany({
    where: { guardId: { in: guardIds }, recordType: "shift", status: { not: "cancelled" }, workDate: { gte: month, lte: monthEnd } },
    select: { guardId: true, workDate: true },
  });
  const perDay = new Map<string, number>();
  for (const r of dayRows) {
    const k = `${r.guardId}|${r.workDate.toISOString().slice(0, 10)}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  for (const [k, n] of perDay) {
    if (n > 1) {
      const [guardId, day] = k.split("|");
      warnings.push(`安員 ${guardName(guardId!)} ${day} 有 ${n} 條正更記錄（同人同日多更）`);
    }
  }

  // 軟警示：證件過期
  for (const g of guards) {
    if (g.siaPermitExpiry && g.siaPermitExpiry < monthEnd) {
      warnings.push(`安員 ${g.nameZh} 嘅許可證於 ${g.siaPermitExpiry.toISOString().slice(0, 10)} 到期`);
    }
  }

  // 軟警示：超配額（quotas.target_shifts vs 實際 shift 更數，per site×shiftType×broker）
  // 雞頭角色（`ownBrokerId` 有值）只計自己嘅配額——唔會見到其他雞頭
  // 呢個盤呢個月嘅配額狀態（同 `配額` module「雞頭 GET 只見自己」嘅
  // 隔離原則一致）。
  const quotas = await prisma.quota.findMany({
    where: { siteId, month, voidedAt: null, ...(ownBrokerId ? { brokerId: ownBrokerId } : {}) },
  });
  if (quotas.length > 0) {
    const [site, shiftTypes, brokers] = await Promise.all([
      prisma.site.findUnique({ where: { id: siteId }, select: { canonicalName: true } }),
      prisma.shiftType.findMany({ where: { id: { in: quotas.map((q) => q.shiftTypeId) } }, select: { id: true, code: true } }),
      prisma.broker.findMany({ where: { id: { in: quotas.map((q) => q.brokerId) } }, select: { id: true, code: true } }),
    ]);
    const siteName = site?.canonicalName ?? siteId.slice(0, 8);
    const shiftTypeCode = (id: string) => shiftTypes.find((s) => s.id === id)?.code ?? id.slice(0, 8);
    const brokerCode = (id: string) => brokers.find((b) => b.id === id)?.code ?? id.slice(0, 8);
    for (const q of quotas) {
      const actual = await prisma.shiftRecord.count({
        where: {
          siteId,
          shiftTypeId: q.shiftTypeId,
          settlementBrokerId: q.brokerId,
          recordType: "shift",
          status: { not: "cancelled" },
          workDate: { gte: month, lte: monthEnd },
        },
      });
      if (actual > q.targetShifts) {
        warnings.push(`盤 ${siteName} 更別 ${shiftTypeCode(q.shiftTypeId)} 雞頭 ${brokerCode(q.brokerId)} 超配額：已排 ${actual} / 配額 ${q.targetShifts}`);
      }
    }
  }

  return warnings;
}
