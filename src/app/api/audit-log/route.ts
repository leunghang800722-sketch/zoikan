// GET /api/audit-log（只讀——audit_log 本身係 append-only，冇 POST/PATCH/
// DELETE endpoint，亦冇必要有：寫入一律由 writeAudit() 喺其他 route 內部
// 觸發，唔開一個公開嘅「新增 audit_log」endpoint）。
//
// N1（Opus 對抗式驗收第三輪）：呢個 route 之前直接 `ok({ rows, ... })`
// 將成個 Prisma AuditLog row（連 before/after 兩個 JSON blob）塞出街，
// 冇 DTO 冇 field-group gate——即使 writeAudit() 寫入嗰陣（見
// src/lib/api/audit-dto.ts）已經淨係存緊「完整資源 DTO」（唔係原始
// Prisma row），before/after 入面仍然可能有 client_rate/monthly_fee/
// revenue 呢類淨係「收客價:view」/「出街價:view」先應該見到嘅價錢欄
// ——寫入嗰陣存嘅係*完整*審計記錄，讀出嗰陣先按*讀者*（唔係當初改嗰個
// 人）嘅權限再 gate 一次，先至係正確嘅存取控制模型（審計軌跡本身要
// 完整，但邊個睇得到邊部分先受讀者權限限制）。雞頭本身喺 matrix.ts
// 「操作紀錄」係 uniformRow(D)——硬性 deny，requirePermission() 已經
// 喺呢個 route 最頭拒咗，唔會行到落嚟。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { paginationParams } from "@/lib/api/query";
import { toAuditLogDTO, mapListDTO, AUDIT_FIELD_GROUP_RESOURCE_BY_TABLE } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { BadRequest } from "@/lib/api/errors";
import { isValidHkDateStr, hkDayStartUtc, hkDayEndUtc } from "@/lib/ui/format";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Prisma } from "@prisma/client";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 必修（本輪 vitest 全跑發現）：`applyFieldGroupGate()` 淨係識做**頂層**
// key（見 src/lib/api/field-groups.ts `omit()`）——WP-PRICE `reprice_month`
// action 嘅 `after.changed_records`（src/app/api/shift-records/reprice/
// route.ts）係一個 nested array，每項自己帶一個完整嘅 `before`/`after`
// snapshot（`client_rate_snapshot`／`guard_wage_snapshot`／
// `broker_fee_snapshot`），淨係靠頂層 gate 完全唔會拆到呢層，令冇「收客
// 價:view」／「出街價:view」嘅讀者一樣經 GET /api/audit-log 見到呢啲數
// （wp2-n1-audit-log-gate.test.ts 全 suite 一齊跑先會發現，因為 audit_log
// 係 append-only、跨 test file 唔清）。呢度額外遞歸落 `changed_records[]`
// 逐項對 `before`/`after` 用返同一個 `applyFieldGroupGate(shift_records)`
// gate 一次。
async function gateChangedRecords(session: AuthedSession, blob: Record<string, unknown>): Promise<Record<string, unknown>> {
  const changedRecords = blob.changed_records;
  if (!Array.isArray(changedRecords)) return blob;
  const gated = await Promise.all(
    changedRecords.map(async (entry) => {
      if (!isPlainObject(entry)) return entry;
      const out: Record<string, unknown> = { ...entry };
      if (isPlainObject(out.before)) out.before = await applyFieldGroupGate(session, "shift_records", out.before as Record<string, unknown>);
      if (isPlainObject(out.after)) out.after = await applyFieldGroupGate(session, "shift_records", out.after as Record<string, unknown>);
      return out;
    }),
  );
  return { ...blob, changed_records: gated };
}

async function gateAuditBlob(session: AuthedSession, tableName: string, blob: unknown): Promise<unknown> {
  const resource = AUDIT_FIELD_GROUP_RESOURCE_BY_TABLE[tableName];
  if (!resource || !isPlainObject(blob)) return blob;
  const gatedTop = await applyFieldGroupGate(session, resource, blob);
  if (resource !== "shift_records") return gatedTop;
  return gateChangedRecords(session, gatedTop);
}

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "操作紀錄", "view");
    const url = new URL(req.url);
    if (url.searchParams.get("export") === "1") {
      await requirePermission(req, "操作紀錄", "export");
    }
    const { skip, take } = paginationParams(url);
    const tableName = url.searchParams.get("table_name");
    const rowId = url.searchParams.get("row_id");
    const actorUserId = url.searchParams.get("actor_user_id");

    // M1（Opus 驗收）：「日期」filter 之前淨係喺前端對已載入嗰 50 行假
    // 篩、UI 冇講呢個限制——而家喺呢度做正路 server-side 篩，`from`/`to`
    // 一律 "YYYY-MM-DD"，當香港曆日解讀（`from` 00:00 HKT 至 `to`
    // 23:59:59 HKT），分頁總數（下面 count）自然跟返呢個 filter。兩個
    // 參數獨立生效，冇傳就唔加嗰一邊嘅界。
    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");
    if (fromRaw !== null && !isValidHkDateStr(fromRaw)) throw BadRequest("from 格式錯誤，要 YYYY-MM-DD");
    if (toRaw !== null && !isValidHkDateStr(toRaw)) throw BadRequest("to 格式錯誤，要 YYYY-MM-DD");
    const createdAtFilter: Prisma.DateTimeFilter = {
      ...(fromRaw ? { gte: hkDayStartUtc(fromRaw) } : {}),
      ...(toRaw ? { lte: hkDayEndUtc(toRaw) } : {}),
    };
    const hasCreatedAtFilter = fromRaw !== null || toRaw !== null;

    const where: Prisma.AuditLogWhereInput = {
      ...(tableName ? { tableName } : {}),
      ...(rowId ? { rowId } : {}),
      ...(actorUserId ? { actorUserId } : {}),
      ...(hasCreatedAtFilter ? { createdAt: createdAtFilter } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.auditLog.count({ where }),
    ]);

    const gatedRows = await Promise.all(
      rows.map(async (row) => ({
        ...row,
        before: await gateAuditBlob(session, row.tableName, row.before),
        after: await gateAuditBlob(session, row.tableName, row.after),
      })),
    );

    return ok(mapListDTO({ rows: gatedRows, total, skip, take }, toAuditLogDTO));
  });
}
