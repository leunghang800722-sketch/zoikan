// W2：WhatsApp 分診題嘅共用型別（evidence_json 形狀）＋純函數（原因碼 → kind 優先次序、選項、groupKey）。
// evidence 含原話＋人名候選（PII）——只存 DB，API 層按「保安員:view」遮罩（見 triage-answer.ts）。
// 冇電話全號：發訊人只記保安員 id＋電話尾 4 位。
import type { QuestionKind, QuestionOption } from "@/lib/triage/types";

export type WaKind = Extract<QuestionKind, "wa_person_ambiguous" | "wa_person_unknown" | "wa_site_ambiguous" | "wa_date_ambiguous" | "wa_shift_conflict" | "wa_unparsed" | "wa_cover" | "wa_cancel" | "wa_card_confirm" | "wa_roster_mismatch">;
export type WaIntentKind = "shift" | "leave" | "cover" | "cancel" | "unclear" | "question_only";

/** WA-8：工卡相辨識資料（DB 內；工號／姓名係 PII-ish → API 層按「保安員:view」遮罩）。 */
export interface WaCardEvidence {
  /** whatsapp_media_evidence.id（圖片 GET 用）；過期／冇圖＝null */
  media_id: string | null;
  staff_no_read: string | null;
  name_zh_read: string | null;
  name_en_read: string | null;
  /** 支持該工號嘅引擎票數 */
  votes: number;
  /** 一張相入面第幾張卡／共幾張 */
  index: number;
  total: number;
  /** 有用到仲裁 */
  arbiter: boolean;
  /** review 時畀人揀嘅候選工號 */
  candidates: string[];
  /** WA-9：相片文件類型／相入面讀到嘅打卡時間 */
  doc_type?: string | null;
  time_on?: string | null;
  time_off?: string | null;
  /** 已確認姓名卡以外嘅單票姓名讀數（畀審核人見；唔參與配對） */
  name_alt?: string[];
  /** 值勤表：工號欄原樣（Wilson 純數字／手寫 L13xxxx 等，唔係 U 格式）＋行號 */
  wilson_no?: string | null;
  row_no?: number | null;
  /** 同一張相嘅其他卡（疑似第二張卡題用） */
  others?: Array<{ staff_no: string | null; status: "confirmed" | "review" }>;
  /** 無圖原因：expired｜not_card｜unreadable */
  none?: "expired" | "not_card" | "unreadable";
}

/** 同一 intent 最多問兩輪；第三輪一律 wa_unparsed（只剩人手／忽略）。 */
const WA_MAX_ROUNDS = 2;
/** W4：替更／取消要先經盤口、日子等題再到最後確認題，容許多兩輪。 */
const WA_MAX_ROUNDS_COVER_CANCEL = 4;
export const maxRoundsOf = (kind: WaIntentKind): number => (kind === "cover" || kind === "cancel" ? WA_MAX_ROUNDS_COVER_CANCEL : WA_MAX_ROUNDS);

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
  /** W4：替更題人手揀咗嘅被替者 */
  replaced_guard_id?: string;
}

/** W4：替更題額外證據（被替者配對結果＋被替者當日該更記錄）。 */
interface WaCoverEvidence {
  replaced_guard_id: string | null;
  replaced_candidate_ids: string[];
  replaced_record_ids: string[];
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
  /** W4：只喺 intent.kind=cover 有 */
  cover?: WaCoverEvidence;
  /** WA-8：只喺工卡相來源有 */
  card?: WaCardEvidence;
  /** WA-9：名單／相片差異（一日一條合併題；姓名只存 DB，API 層按「保安員:view」遮罩） */
  mismatch?: { day: string; roster_only: string[]; photo_only: string[] };
  /** WA-9 (7)：固定 groupKey 嘅題（名單配唔到嘅名）；round 1 先用 */
  dedupe_key?: string;
  /** WA-9 (8)：短訊（LLM）路徑嘅揀人題亦帶同一把 (群,日,名) key（`rn:`）→ 同名單路徑互相去重；唔影響 supersede（撤回／編輯照舊作廢） */
  name_key?: string;
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
const UNPARSED_REASONS = new Set(["unclear", "type_not_auto", "shift_unmapped", "shift_ambiguous", "leave_code_unclear", "leave_ambiguous", "leave_unmapped", "llm_bad_output", "question_only", "no_cancel_target"]);
const SITE_REASONS = new Set(["site_ambiguous"]);
const PERSON_REASONS = new Set(["person_ambiguous", "person_unknown"]);
const DATE_REASONS = new Set(["date_missing", "date_unparseable", "date_ambiguous", "date_out_of_range"]);
const CONFLICT_REASONS = new Set(["conflict_leave", "conflict_other_shift", "conflict_shift_vs_leave", "slot_full", "quota_full", "month_locked"]);

/** W3：只係安全閥／低信心擋住（解析本身完整）→ 「照解析結果入更」。 */
const SOFT_REASONS = new Set(["low_confidence", "daily_cap", "auto_disabled"]);
/** WA-8：工卡相冇資料可用（過期／唔係工卡／讀唔到）→ 只可人手／忽略。 */
const CARD_DEAD_REASONS = new Set(["card_media_expired", "card_not_card", "card_unreadable"]);
/** WA-8：辨識／歸屬都有結果，但要人一撳確認嘅提示碼。 */
const CARD_CONFIRM_REASONS = new Set(["card_confirm", "card_name_mismatch", "card_former_number", "card_name_only", "card_suspect_second", "row_low_confidence", "row_misread_suspect"]);

/**
 * 優先次序：unparsed > site > person > date > conflict（低信心單獨出現 → unparsed＋「照解析入更」）。
 * W4：替更 → unparsed > site > date > 鎖月 > wa_cover（人／撞更喺 wa_cover 題內處理）；
 *     取消 → unparsed > person > date > 鎖月 > wa_cancel（唔需要盤口）。
 */
export function pickWaKind(reasons: readonly string[], intentKind?: WaIntentKind): WaKind {
  const has = (set: Set<string>) => reasons.some((r) => set.has(r));
  // WA-8：工卡相——冇可用資料，或者辨識全齊淨係等人一撳確認 → wa_card_confirm
  if (reasons.includes("roster_mismatch")) return "wa_roster_mismatch";
  if (has(CARD_DEAD_REASONS)) return "wa_card_confirm";
  if (has(CARD_CONFIRM_REASONS) && reasons.every((r) => SOFT_REASONS.has(r) || CARD_CONFIRM_REASONS.has(r))) return "wa_card_confirm";
  if (has(UNPARSED_REASONS)) return "wa_unparsed";
  if (intentKind === "cover" || intentKind === "cancel") {
    if (intentKind === "cover" && has(SITE_REASONS)) return "wa_site_ambiguous";
    if (intentKind === "cancel" && has(PERSON_REASONS)) return reasons.includes("person_ambiguous") ? "wa_person_ambiguous" : "wa_person_unknown";
    if (has(DATE_REASONS)) return "wa_date_ambiguous";
    if (reasons.includes("month_locked")) return "wa_shift_conflict";
    return intentKind === "cover" ? "wa_cover" : "wa_cancel";
  }
  if (has(SITE_REASONS)) return "wa_site_ambiguous";
  if (has(PERSON_REASONS)) return reasons.includes("person_ambiguous") ? "wa_person_ambiguous" : "wa_person_unknown";
  if (has(DATE_REASONS)) return "wa_date_ambiguous";
  if (has(CONFLICT_REASONS)) return "wa_shift_conflict";
  return "wa_unparsed"; // low_confidence 或其他未列明
}

/** WA-9：名單／相片差異題＝一個群一日一條（唔按訊息） */
export const rosterMismatchKey = (groupId: string, day: string): string => `rm:${groupId}:${day}`;
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
    case "wa_cover": {
      const conflict = ev.reasons.some((r) => r === "conflict_leave" || r === "conflict_other_shift");
      return [
        ...(conflict
          ? [{ id: "wa_use_whatsapp", label: "以 WhatsApp 為準（取消替更者同日原有記錄，連被替者該更一併改）" } as QuestionOption]
          : [{ id: "wa_cover_confirm", label: "確認替更（被替者該更取消，替更者入更）" } as QuestionOption, { id: "wa_cover_add_only", label: "只加替更者（唔改被替者）" } as QuestionOption]),
        { id: "wa_manual", label: "人手處理（去排更頁）" },
        SKIP,
      ];
    }
    case "wa_cancel":
      return [
        { id: "wa_cancel_apply", label: "取消該更／請假" },
        { id: "wa_cancel_to_leave", label: "改為請假（揀碼）", input: "leave_code" },
        { id: "wa_manual", label: "人手處理（去排更頁）" },
        SKIP,
      ];
    case "wa_roster_mismatch":
      return [{ id: "wa_manual", label: "去排更頁核對（名單／相片有差異）" }, { id: "wa_ignore", label: "已核對，冇問題" }, SKIP];
    case "wa_card_confirm": {
      if (ev.reasons.some((r) => CARD_DEAD_REASONS.has(r))) return [{ id: "wa_manual", label: "人手入更（去排更頁）" }, { id: "wa_ignore", label: "忽略（唔入更）" }, SKIP];
      return [{ id: "wa_accept", label: "確認入更（待批核）" }, { id: "wa_manual", label: "人手入更（去排更頁）" }, { id: "wa_ignore", label: "忽略（唔入更）" }, SKIP];
    }
    case "wa_unparsed": {
      const i = ev.intent;
      const complete = (i.kind === "shift" || i.kind === "leave") && ev.reasons.length > 0 && ev.reasons.every((r) => SOFT_REASONS.has(r));
      return [...(complete ? [{ id: "wa_accept", label: "照解析結果入更（待批核）" } as QuestionOption] : []), { id: "wa_manual", label: "人手入更（去排更頁）" }, { id: "wa_ignore", label: "忽略（唔入更）" }, SKIP];
    }
  }
}
