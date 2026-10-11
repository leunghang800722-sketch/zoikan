// audit_log middleware：邊個、幾時、邊張表邊一行、改前JSON、改後JSON、IP。
// 呢個表本身係 append-only（DB trigger 拒絕 UPDATE/DELETE/TRUNCATE，見
// prisma/migrations/20260911070700_audit_log_append_only、
// .../20260911100000_audit_log_no_truncate）——呢度淨係負責寫入。
import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { currentAuditJob, currentAuditJobActor } from "./audit-job-context";
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
  // 驗收（Opus 5.5，2026-09-26）：guard-fix 保守預設（工號衝突／淨係
  // 姓名對到名單）建嘅獨立保安員——guards 表冇 note 欄，喺度留「待核」原因
  // （after 淨係 {id, conservative, note}，冇 PII）。
  | "guard_fix_conservative_default"
  // WP-PRICE（老闆 2026-09-16 拍板）：`POST /api/shift-records/reprice`
  // 一個月/一個盤重新計價，一次過覆蓋整段範圍嘅 snapshot（價目卡改咗
  // 要生效）——一行 audit（table_name="shift_records"，row_id=
  // "reprice:<month>[:<site_id>]"），after 存 counts（唔存逐條 before/
  // after，成千上萬條會令 audit_log 爆），詳情見
  // src/app/api/shift-records/reprice/route.ts。
  | "reprice_month"
  // WP-PHASE3（§20.4 Phase 3 item 3）：`POST /api/rate-cards/copy-last-
  // month`——批量「複製上月卡到本月」一行摘要 audit（table_name=
  // "rate_cards"，row_id="copy_last_month"，after 存 counts＋建咗嘅
  // rate_cards id 陣列），逐張新卡自己仲有一條獨立 "create" audit（同
  // reprice_month 一致「摘要一條 + 逐項各自一條」寫法）。
  | "copy_last_month"
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
  | "recompute_permit_derived"
  // WP-MULTI（老闆 2026-09-19 拍板）：guard_phones／
  // guard_emergency_contacts／guard_addresses 呢三張新表冇「former／已
  // 取消」呢個狀態（唔似 guard_staff_numbers），DELETE 係真刪一行（俾
  // 用戶自己更正打錯用）——用獨立嘅 "delete" action（`before`＝刪之前
  // 嘅完整 DTO，`after`＝null），同 "void"（軟刪，資源仲存在）分開，
  // audit_log 睇落一眼就分辨得到「呢行真係冇咗」定「淨係停用」。
  | "delete"
  // WP-LTPAY §21 任務 5c：BOCHK autopay 檔下載——含銀行戶口／收款人名
  // 呢類最嚴 PII，任務書明文要求「audit 記下載」。`after` 淨係安全計數
  // （行數／缺銀行資料人數/preview flag，冇逐人資料），唔經
  // `AUDIT_ROW_MAPPED_ACTIONS` DTO mapping（本身已經係 route 自己手砌
  // 嘅安全 payload，同 `ai_chat`/`feedback_submit` 一致 passthrough）。
  | "export_download"
  // 已鎖月份 autopay 下載未確認被擋（月份＋原因，冇戶口）
  | "export_download_blocked"
  // WP-STAFF-IMPORT B3：證件資料批量導入——summary audit（淨係計數，冇逐人資料）。
  | "guard_import_apply"
  // WP-AI-OPS：導入 preview（計非老闆每日次數用；after 淨係人數／計數／package_hash，冇 PII）
  | "guard_import_preview"
  // WP-GUARD-OCR §29：證件辨識讀取——after 淨係文件類型、欄位狀態計數、模型、tokens、耗時（冇圖、冇任何欄位值）。
  | "guard_ocr_read"
  // 配額預留行（限額只數呢種行；after 只有 kind＋request_id，冇 PII）
  | "guard_quota_reserve"
  // WP-AI-OPS §28.4：導入後對話式分診——開 session／作答（含跳過）／老闆轉交。after 淨係 id＋類別＋計數（冇姓名／身份證等 PII）。
  | "triage_session_create"
  | "triage_answer"
  | "triage_reassign"
  // P7.1：老闆手動立即跑排程 job（after 淨係 run id＋狀態）；用戶改通知電郵（after 淨係 { changed: true }，唔存電郵）。
  | "job_run_now"
  | "notify_email_update";

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
  // P8.1／驗收 M1：未登記 DTO 嘅表只保留最窄白名單 key（非 PII 標記）
  if (!("id" in row)) return undefined;
  const meta: Record<string, unknown> = {};
  for (const k of UNMAPPED_META_KEYS) {
    if (k in row) meta[k] = row[k];
  }
  return { id: row.id, ...meta };
}

function withJobMarkerSafe(input: WriteAuditInput): unknown {
  // by_job 喺 DTO mapping 之後先加（mapper 會剝走未知 key；by_job 係白名單 meta）
  const safe = toAuditSafeValue(input.tableName, input.action, input.after);
  return withJobMarker(safe);
}

const UNMAPPED_META_KEYS = ["by_job", "auto_source", "batch_id"] as const;

/** 排程 job 執行期間（withAuditJob）：after 一律帶 by_job（after 係物件就合併，冇／非物件就當 { by_job }）。 */
function withJobMarker(after: unknown): unknown {
  const job = currentAuditJob();
  if (!job) return after;
  if (after === undefined || after === null) return { by_job: job };
  if (Array.isArray(after) || typeof after !== "object") return after;
  return { ...(after as Record<string, unknown>), by_job: job };
}

function toAuditCreateData(input: WriteAuditInput): Prisma.AuditLogUncheckedCreateInput {
  return {
    actorUserId: input.actorUserId ?? currentAuditJobActor() ?? null,
    tableName: input.tableName,
    rowId: input.rowId,
    action: input.action,
    before: toJson(toAuditSafeValue(input.tableName, input.action, input.before)) ?? Prisma.JsonNull,
    after: toJson(withJobMarkerSafe(input)) ?? Prisma.JsonNull,
    ip: input.ip ?? null,
  };
}

export async function writeAudit(input: WriteAuditInput): Promise<void> {
  await prisma.auditLog.create({ data: toAuditCreateData(input) });
}

/** WP-AUG-OPENING 驗收（Opus 5.5）：同 `writeAudit()` 一樣嘅 DTO 白名單，
 * 但寫喺呼叫者嘅 transaction 入面——`writeAudit()` 用全域 `prisma`（另一條
 * connection），喺 `$transaction()` 入面用嘅話，業務資料 rollback 咗
 * audit_log 都照樣留低（audit_log append-only，刪唔返），會出現指住唔存在
 * row 嘅孤兒 audit。批量 script（例如 scripts/opening/apply-aug-plan.ts）
 * 要「成批一齊成功或者一齊冇」就用呢個。 */
export async function writeAuditTx(tx: Prisma.TransactionClient, input: WriteAuditInput): Promise<void> {
  await tx.auditLog.create({ data: toAuditCreateData(input) });
}

/** P3-5.5：同批 audit 嘅 id——最前 8 hex 位係批內序號（升序），其餘隨機（跨批唔撞）。
 * 同批共用同一個 `createdAt`，列表按 `createdAt desc, id asc` 排，所以 id 升序＝plan 次序（唔需要 migration 加 seq 欄）。 */
export function orderedAuditIds(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = randomBytes(10).toString("hex"); // 20 hex
    const idx = i.toString(16).padStart(8, "0");
    out.push(`${idx}-${r.slice(0, 4)}-4${r.slice(4, 7)}-8${r.slice(7, 10)}-${r.slice(10, 20)}${r.slice(0, 2)}`);
  }
  return out;
}

/** P3-2.5：批量寫 audit——一條 `createMany`，同一批共用同一個 `createdAt`（DB `now()`；唔偽造未來時間，
 * 2,000 格都唔會寫到幾秒後）。同批內次序：id 按插入順序升序（`orderedAuditIds()`），audit-log 列表
 * 嘅 `createdAt desc, id asc` 因此保持 plan 次序。內容經同一個 `toAuditCreateData()`，同 `writeAudit()`
 * 逐條寫入完全一樣。傳 `tx` 就寫喺呼叫者嘅 transaction。 */
export async function writeAuditMany(inputs: WriteAuditInput[], client: Pick<Prisma.TransactionClient, "auditLog"> = prisma): Promise<void> {
  if (inputs.length === 0) return;
  const ids = orderedAuditIds(inputs.length);
  await client.auditLog.createMany({ data: inputs.map((input, i) => ({ ...toAuditCreateData(input), id: ids[i] })) });
}
