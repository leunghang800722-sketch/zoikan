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
  // P2-C §16：用戶管理「重設密碼」——之前呢個 module 淨係有 create/
  // update/void/unvoid，冇對稱嘅「幫用戶開返新密碼」action，見
  // src/app/api/users/[id]/reset-password/route.ts。
  | "reset_password"
  // WP-AI1：AI 助手——每條問答一條（table_name="ai_chat"）；guard
  // 觸發（輸出過濾攔截咗一個似係改動指示/DML 嘅回覆）額外多一條。
  | "ai_chat"
  | "ai_guard_triggered"
  // WP-AI3：表達方式 guard（`src/lib/ai/output-style.ts`）觸發——回覆
  // 出現咗 snake_case 識別符/工具名/內部雞頭代號，改寫或者剝走咗。
  | "ai_style_rewrite"
  // P2.5「現場反映」開會模式——訪談每輪一條（table_name="ai_feedback_chat"）；
  // 可行性 guard（`src/lib/ai/feasibility-guard.ts`）觸發（訪談員答咗
  // 可行性判斷）額外多一條；撳「確認送出」寫 feedback_reports 一條
  // （table_name="feedback_reports"）；老闆改狀態用返現有 "update"
  // action（同其他 resource PATCH 一致）。
  | "ai_feedback_chat"
  | "ai_feasibility_guard_triggered"
  | "feedback_submit"
  // WP-PRICE（老闆 2026-09-16 拍板）：`POST /api/shift-records/reprice`
  // 一個月/一個盤重新計价，一次過覆蓋整段範圍嘅 snapshot（價目卡改咗
  // 要生效）——一行 audit（table_name="shift_records"，row_id=
  // "reprice:<month>[:<site_id>]"），after 存 counts（唔存逐條 before/
  // after，成千上萬條會令 audit_log 爆），詳情見
  // src/app/api/shift-records/reprice/route.ts。
  | "reprice_month"
  // P2.5 Opus 驗收應修④：`session/summarize` 每次成功整理（叫咗一次
  // LLM）都寫一條（table_name="ai_feedback_chat"，同 `ai_feedback_chat`
  // 呢個 action 分開，等 audit_log 可以分辨「訪談對話」定「整理」，同
  // 埋計入 `src/lib/ai-rate-limit.ts` 嗰個同主助手共用嘅每日額度）。
  | "ai_feedback_summarize"
  // WP-STAFFNO 必修 1(b)(c)（Opus 驗收第二輪）：`scripts/db/recompute-
  // permit-derived.ts` 背景校正 job——之前呢個 script 靜默寫入、唔留底，
  // 而家改做「任何更新都寫一條」（table_name="guards"，before/after 淨係
  // `{sia_permit_expiry, sia_permit_type}` 呢兩粒衍生值，唔係完整 row，
  // 避免 PII 經呢條 action 漏出去）。
  | "recompute_permit_derived";

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
