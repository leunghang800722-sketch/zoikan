// W2：WhatsApp 分診題嘅共用型別（evidence_json 形狀）＋純函數（原因碼 → kind 優先次序、選項、groupKey）。
// evidence 含原話＋人名候選（PII）——只存 DB，API 層按「保安員:view」遮罩（見 triage-answer.ts）。
// 冇電話全號：發訊人只記保安員 id＋電話尾 4 位。
import type { QuestionKind, QuestionOption } from "@/lib/triage/types";

export type WaKind = Extract<QuestionKind, "wa_person_ambiguous" | "wa_person_unknown" | "wa_site_ambiguous" | "wa_date_ambiguous" | "wa_shift_conflict" | "wa_unparsed">;
export type WaIntentKind = "shift" | "leave" | "cover" | "cancel" | "unclear" | "question_only";

/** 同一 intent 最多問兩輪；第三輪一律 wa_unparsed（只剩人手／忽略）。 */
export const WA_MAX_ROUNDS = 2;

interface WaSrc {
  person_raw: string | null;
  site_raw: string | null;
  date_raw: string | null;
  shift_raw: string | null;
  leave_raw: string | null;
  replaced_raw: string | null;
}

/** 人手逐輪答咗嘅嘢（疊加喺 intent 解析結果上面）。 */
export interface WaHuman {
  guard_id?: string;
  site_id?: string;
  work_date?: string;
  /** 人手揀咗仍然入更（額滿／超配額）／照解析入更 */
  force?: boolean;
}

export interface WaEvidence {
  v: 1;
  wa: true;
  round: number;
  message: { message_id: string; revision: number; idx: number; intent_id: string };
  group: { id: string; label: string; kind: string };
  sent_at: string;
  sender: { guard_id: string | null; tel_tail4: string | null };
  /** 原話（DB 內；redacted 之後置 null） */
  text: string | null;
  intent: {
    kind: WaIntentKind;
    work_date: string | null;
    site_id: string | null;
    guard_id: string | null;
    shift_type_id: string | null;
    leave_code: string | null;
    confidence: number | null;
  };
  src: WaSrc;
  /** 阻擋自動寫入嘅原因碼（W1 resolve） */
  reasons: string[];
  notes: string[];
  candidates: { guard_ids: string[]; site_ids: string[]; dates: string[]; shift_type_ids: string[]; existing_record_ids: string[] };
  human: WaHuman;
  /** 工作月（YYYY-MM-01）；鎖月檢查／session 月份用。未知日期就用訊息月。 */
  month: string;
}

export interface WaQuestionDraft {
  kind: WaKind;
  groupKey: string;
  sort: number;
  title: string;
  evidence: WaEvidence;
  options: QuestionOption[];
}

// ---------------------------------------------------------------- 原因碼分類
const UNPARSED_REASONS = new Set(["unclear", "type_not_auto", "shift_unmapped", "shift_ambiguous", "leave_code_unclear", "leave_ambiguous", "leave_unmapped", "llm_bad_output", "question_only"]);
const SITE_REASONS = new Set(["site_ambiguous"]);
const PERSON_REASONS = new Set(["person_ambiguous", "person_unknown"]);
const DATE_REASONS = new Set(["date_missing", "date_unparseable", "date_ambiguous", "date_out_of_range"]);
const CONFLICT_REASONS = new Set(["conflict_leave", "conflict_other_shift", "conflict_shift_vs_leave", "slot_full", "quota_full", "month_locked"]);

/** 優先次序：unparsed > site > person > date > conflict（低信心單獨出現 → unparsed＋「照解析入更」）。 */
export function pickWaKind(reasons: readonly string[]): WaKind {
  const has = (set: Set<string>) => reasons.some((r) => set.has(r));
  if (has(UNPARSED_REASONS)) return "wa_unparsed";
  if (has(SITE_REASONS)) return "wa_site_ambiguous";
  if (has(PERSON_REASONS)) return reasons.includes("person_ambiguous") ? "wa_person_ambiguous" : "wa_person_unknown";
  if (has(DATE_REASONS)) return "wa_date_ambiguous";
  if (has(CONFLICT_REASONS)) return "wa_shift_conflict";
  return "wa_unparsed"; // low_confidence 或其他未列明
}

export const groupKeyOf = (messageId: string, revision: number, idx: number, round: number): string => `${messageId}:${revision}:${idx}${round > 1 ? `:r${round}` : ""}`;

/** 用 UTC 分鐘數做排序（舊訊息先），喺 int32 範圍內。 */
export const sortOfTs = (ts: Date): number => Math.floor(ts.getTime() / 60000);

const SKIP: QuestionOption = { id: "skip", label: "跳過，留返人手" };

/** 按 kind＋證據砌選項（候選 guard 最多 8 個）。 */
export function optionsForWa(kind: WaKind, ev: Pick<WaEvidence, "candidates" | "reasons" | "intent" | "human">): QuestionOption[] {
  switch (kind) {
    case "wa_person_ambiguous":
      return [
        ...ev.candidates.guard_ids.slice(0, 8).map((g): QuestionOption => ({ id: "wa_pick_guard", label: "揀呢位", guard_id: g })),
        { id: "wa_pick_guard", label: "搜尋其他保安員", input: "guard_search" },
        SKIP,
      ];
    case "wa_person_unknown":
      return [{ id: "wa_pick_guard", label: "搜尋並揀保安員", input: "guard_search" }, { id: "wa_ignore", label: "忽略（唔入更）" }, SKIP];
    case "wa_site_ambiguous":
      return [...ev.candidates.site_ids.slice(0, 8).map((s): QuestionOption => ({ id: "wa_pick_site", label: "揀呢個盤", site_id: s })), SKIP];
    case "wa_date_ambiguous":
      return [
        ...ev.candidates.dates.slice(0, 6).map((d): QuestionOption => ({ id: "wa_set_date", label: `用 ${d}`, date: d })),
        { id: "wa_set_date", label: "輸入日期（YYYY-MM-DD）", input: "date" },
        SKIP,
      ];
    case "wa_shift_conflict": {
      if (ev.reasons.includes("month_locked")) return [{ id: "wa_manual", label: "人手處理（鎖月中，去排更頁睇）" }, SKIP];
      const hard = ev.reasons.some((r) => r === "conflict_leave" || r === "conflict_other_shift" || r === "conflict_shift_vs_leave");
      if (hard) return [{ id: "wa_use_whatsapp", label: "以 WhatsApp 為準（取消舊記錄）" }, { id: "wa_keep_old", label: "保留舊記錄（唔入更）" }, { id: "wa_manual", label: "人手改（去排更頁）" }, SKIP];
      return [{ id: "wa_force_write", label: "仍然入更（待批核）" }, { id: "wa_keep_old", label: "唔入更（保留現狀）" }, { id: "wa_manual", label: "人手改（去排更頁）" }, SKIP];
    }
    case "wa_unparsed": {
      const i = ev.intent;
      const complete = (i.kind === "shift" || i.kind === "leave") && ev.reasons.length > 0 && ev.reasons.every((r) => r === "low_confidence");
      return [...(complete ? [{ id: "wa_accept", label: "照解析結果入更（待批核）" } as QuestionOption] : []), { id: "wa_manual", label: "人手入更（去排更頁）" }, { id: "wa_ignore", label: "忽略（唔入更）" }, SKIP];
    }
  }
}
