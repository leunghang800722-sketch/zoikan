// audit_log middleware：邊個、幾時、邊張表邊一行、改前JSON、改後JSON、IP。
// 呢個表本身係 append-only（DB trigger 拒絕 UPDATE/DELETE/TRUNCATE，見
// prisma/migrations/20260911070700_audit_log_append_only、
// .../20260911100000_audit_log_no_truncate）——呢度淨係負責寫入。
import { prisma } from "./db";
import { Prisma } from "@prisma/client";
import { AUDIT_DTO_BY_TABLE, AUDIT_ROW_MAPPED_ACTIONS, AUDIT_META_PASSTHROUGH_KEYS } from "./api/audit-dto";

export type AuditAction =
  | "create"
  | "update"
  | "void"
  | "unvoid"
  | "login"
  | "login_failed"
  | "login_locked"
  | "logout"
  | "change_password"
  | "lock_month"
  | "unlock_month"
  | "permission_denied"
  // WP-AI1：AI 助手——每條問答一條（table_name="ai_chat"）；guard
  // 觸發（輸出過濾攔截咗一個似係改動指示/DML 嘅回覆）額外多一條。
  | "ai_chat"
  | "ai_guard_triggered";

export interface WriteAuditInput {
  actorUserId: string | null;
  tableName: string;
  rowId: string;
  action: AuditAction;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

// JSON-safe：Decimal/Date 呢類 Prisma 特殊型別直接塞入 Prisma.JsonValue 會
// 出錯，統一由呢個 helper 經 JSON.stringify→parse 一次過轉成純 JSON。
function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

// N1(a)：見 ./api/audit-dto.ts 頂註解——create/update/void/unvoid/
// lock_month/unlock_month 呢類「完整 row」action 自動經 table_name → DTO
// 對照表；其他 action 或者陣列（role_permissions 嘅安全手砌陣列）原樣
// 存；未登記嘅 table 只存 { id }。
function toAuditSafeValue(tableName: string, action: AuditAction, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (!AUDIT_ROW_MAPPED_ACTIONS.has(action)) return value;
  if (Array.isArray(value)) return value;
  if (typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const mapper = AUDIT_DTO_BY_TABLE[tableName];
  if (mapper) {
    const dto = mapper(row);
    const meta: Record<string, unknown> = {};
    for (const k of AUDIT_META_PASSTHROUGH_KEYS) {
      if (k in row) meta[k] = row[k];
    }
    return { ...dto, ...meta };
  }
  return "id" in row ? { id: row.id } : undefined;
}

export async function writeAudit(input: WriteAuditInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      tableName: input.tableName,
      rowId: input.rowId,
      action: input.action,
      before: toJson(toAuditSafeValue(input.tableName, input.action, input.before)) ?? Prisma.JsonNull,
      after: toJson(toAuditSafeValue(input.tableName, input.action, input.after)) ?? Prisma.JsonNull,
      ip: input.ip ?? null,
    },
  });
}
