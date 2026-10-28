// HIST-5：歷史導入「未入格」AI 推斷——共用型別＋姓名折返 helper（純函數，零 DB 依賴）。
// 規則表（rule／信心）見 docs/ops.md「HIST-5」。報告／audit／guard_match_overrides.reason 一律用呢啲型別。
// 鐵則：evidence／decision／subject 可以出姓名同工號（老闆 2026-10-20 PII 規則），**唔准出電話／身份證／銀行／住址／出生日期**。
import { normNameVariant } from "@/lib/names/variants";

/** 規則碼。R＝身份推斷（guard-fix 歷史分支）、S＝更種／代號／跨月推斷。 */
export type HistInferenceRule =
  | "R1" // 工號屬別人、姓名唯一 → link 姓名對到嗰位
  | "R2a" // 電話屬別人 A、姓名唯一對到另一位 B → link B（唔加電話）
  | "R2b" // 姓名 DB 冇／唯一變體（簡繁／後綴／相差一字）→ link 電話主人 A（或唯一變體）＋加別名
  | "R2c" // 姓名 DB 冇、亦唔係變體 → create_minimal 電話留空（疑共用電話）
  | "R3a" // 同名多候選全部係歷史導入 minimal guard → 合併
  | "R3b" // 一個本名完全相同＋其餘後綴變體 → 揀本名相同嗰個（變體如係 minimal 一併合併）
  | "R3c" // ≥2 個真實同名 guard → 用盤史揀
  | "R3d" // 候選＝一個真實 guard＋其餘全部係歷史 minimal → 併入真實嗰個
  | "R4" // 同一次未配對集合內同名（工號唔同／其一冇工號）→ 當同一人
  | "R6a" // U Team 名單同名多行但身份證一致（名單重複行）→ 用第一行（有身份證優先）create
  | "R6b" // U Team 名單同名多行，更表電話剛好等於其中一行 → 用嗰行 create
  | "R6c" // U Team 名單同名多行、分辨唔到（或選中行被拒）→ 唔用名單，按更表姓名建獨立保安員
  | "R5" // create_minimal 建人時電話撞 DB → 電話留空
  | "S1" // 單字母 unknown 代號按該行時段當出更
  | "S1n" // 單字母代號、時段解析唔到 → 冇開始時間更種（只計出勤）
  | "S2" // code 認到但該盤冇該 code＋時段嘅更種 → 自動建
  | "S3" // 跨盤代號（代號＝另一盤名／別名）
  | "S4"; // 跨月格直接寫入目標歷史月份

/** 每條規則嘅信心（docs/ops.md 同 UI 規則表共用）。 */
export const HIST_RULE_CONFIDENCE: Readonly<Record<HistInferenceRule, number>> = {
  R1: 0.9,
  R2a: 0.9,
  R2b: 0.85,
  R2c: 0.85,
  R3a: 0.9,
  R3b: 0.9,
  R3c: 0.8,
  R3d: 0.7,
  R4: 0.9,
  R6a: 0.85,
  R6b: 0.85,
  R6c: 0.7,
  R5: 0.85,
  S1: 0.85,
  S1n: 0.7,
  S2: 0.9,
  S3: 0.85,
  S4: 0.95,
};

/** 歷史模式 S1／S3 推斷喺 roster_upload_rows.warnings 留嘅記號（報告由呢啲字面反推，唔靠 run 內存）。 */
export const S1_ROW_WARNING = "單字母代號按該行時段當出更（AI 推斷）";
export const S1_NO_TIME_ROW_WARNING = "單字母代號，該行時段解析唔到，只計出勤（AI 推斷）";
export const S3_ROW_WARNING = "跨盤代號（AI 推斷）";

/** HIST-5 S4：reconcile unresolved reason 嘅記號字面（bucketUnresolvedReason 用嚟歸類 cross_month_duplicate／out_of_scope）。 */
export const CROSS_MONTH_DUPLICATE_MARK = "跨月重複";
export const OUT_OF_SCOPE_MARK = "範圍外";

/** guard_match_overrides.reason 前綴：歷史導入 AI 推斷覆寫（matchGuard 用嚟分辨舊「工號衝突保守預設」）。 */
export const HIST5_OVERRIDE_REASON_PREFIX = "HIST5";

interface HistSubject {
  name?: string;
  staffNo?: string;
  site?: string;
  code?: string;
  timeSlot?: string;
}

export interface HistInference {
  rule: HistInferenceRule;
  confidence: number;
  subject: HistSubject;
  decision: string;
  evidence: string[];
  cells: number;
}

export interface HistRemainingCandidate {
  guardId: string;
  name: string;
  staffNumbers: string[];
  status: string;
  /** 候選喺同一盤（含子盤）±3 個月內有幾多條 shift_records（唔計 cancelled）。 */
  sameSiteHistoryCells: number;
}

export interface HistRemaining {
  subject: HistSubject;
  reasonCode: string;
  cells: number;
  candidates: HistRemainingCandidate[];
  recommended: { action: "link" | "create" | "none"; guardId?: string; name?: string; confidence: number; why: string };
}

/** 抽查提示（唔算待答）。 */
export interface HistReviewHint {
  rule: HistInferenceRule;
  subject: HistSubject;
  hint: string;
  evidence: string[];
  cells: number;
}

/** 去尾部 1–4 字括號後綴（「X (上)」「X(摩)」「X（夜）」）。 */
function stripNameSuffix(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .normalize("NFKC")
    .replace(/\s*\([^()]{1,4}\)\s*$/, "")
    .trim();
}

/** 比對用姓名鍵：NFKC＋去後綴＋去空白標點＋簡→繁。 */
export function foldName(s: string | null | undefined): string {
  return normNameVariant(stripNameSuffix(s));
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = [...a];
  const lb = [...b];
  if (Math.abs(la.length - lb.length) > 1) return false;
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  if (la.length === lb.length) return la.slice(i + 1).join("") === lb.slice(i + 1).join("");
  const [longer, shorter] = la.length > lb.length ? [la, lb] : [lb, la];
  return longer.slice(i + 1).join("") === shorter.slice(i).join("");
}

/** 3 字名「姓相同＋其餘兩字入面一字相同、另一字唔同」（形近／同音字筆誤；HIST-5.1）。fa／fb 已折返。 */
function isThreeCharSurnameVariant(fa: string, fb: string): boolean {
  const a = [...fa];
  const b = [...fb];
  if (a.length !== 3 || b.length !== 3 || a[0] !== b[0]) return false;
  return (a[1] === b[1]) !== (a[2] === b[2]);
}

/** 嚴格變體：折返後相同，或者（≥4 字）相差 ≤1 字。3 字名相差一字唔包（見 isLooseNameVariant）。 */
export function isStrictNameVariant(a: string | null | undefined, b: string | null | undefined): boolean {
  const fa = foldName(a);
  const fb = foldName(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  return [...fa].length >= 4 && [...fb].length >= 4 && editDistanceAtMostOne(fa, fb);
}

/** 寬鬆變體（HIST-5.1）：嚴格唔中，但係 3 字名「姓相同＋名其中一字相同＋另一字唔同」。用呢個中嗰陣信心降 0.05。 */
export function isLooseNameVariant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (isStrictNameVariant(a, b)) return false;
  const fa = foldName(a);
  const fb = foldName(b);
  return !!fa && !!fb && isThreeCharSurnameVariant(fa, fb);
}

/** 兩個姓名係咪「同一個名嘅變體」：折返後相同，或者 ≥4 字相差 ≤1 字，或者 3 字名姓同＋名差一字（HIST-5.1）。 */
export function isNameVariant(a: string | null | undefined, b: string | null | undefined): boolean {
  return isStrictNameVariant(a, b) || isLooseNameVariant(a, b);
}

/** 抽出 7 位以上連續數字（電話／身份證類）打 [num]——evidence／reason 最後一道防線。 */
export function maskLongDigits(s: string): string {
  return s.replace(/\d{7,}/g, "[num]");
}

/** 連續月份：months（任意次序、重複）內，包含 target 嘅最長連續月份數。 */
export function longestConsecutiveRunContaining(months: readonly Date[], target: Date): number {
  const idx = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  const set = new Set(months.map(idx));
  const t = idx(target);
  if (!set.has(t)) return 0;
  let lo = t;
  while (set.has(lo - 1)) lo--;
  let hi = t;
  while (set.has(hi + 1)) hi++;
  return hi - lo + 1;
}
