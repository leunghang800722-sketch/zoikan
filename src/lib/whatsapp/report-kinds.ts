// WA-9 (7)：純 code 文字分類（零 LLM、零 DB）——真數據入面 LLM 路徑接唔到或唔應該接嘅幾類短訊：
//   name_caption   「孫測壹報開工」「陳測貳收工」（相嘅 caption；身份＝中文姓名）
//   substitution   「A代B」（只認兩個姓名樣 token 夾一個「代／替／頂」）
//   leave_notice   「X11月份假期3,12,18,26」（月份＋日列表）
//   attendance_summary 「X10月份返<盤>考勤紀錄，休息6日：2，11，…」（只記錄，唔核對）
//   plain_question 「請問今早X有無返」（零 intent、零題卡）
// 另提供 fixOcrDigits（工號／日期 token 內數字 0 打成英文 O）、normalizeReportText（時間範圍連字號統一）。
import { startsWithSurname } from "./roster-list";

export type TextKind =
  | { kind: "name_caption"; name: string; action: "checkin" | "checkout" }
  | { kind: "substitution"; worker: string; replaced: string }
  | { kind: "leave_notice"; name: string; month: number; days: number[] }
  | { kind: "attendance_summary"; name: string; month: number; rest_days: number[]; claimed: number | null }
  | { kind: "plain_question" };

const NAME = "[一-鿿]{2,4}";
const stripNoise = (t: string): string => t.normalize("NFKC").replace(/[\p{Extended_Pictographic}‍️]+/gu, "").replace(/[\s　]+/g, " ").trim();
const okName = (n: string): boolean => startsWithSurname(n);

function daysOf(list: string): number[] {
  return [...new Set((list.match(/\d{1,2}/g) ?? []).map(Number).filter((d) => d >= 1 && d <= 31))].sort((a, b) => a - b);
}

export function classifyText(textIn: string): TextKind | null {
  const t = stripNoise(textIn ?? "");
  if (t.length < 4 || t.length > 120) return null;
  let m = new RegExp(`^(${NAME}?)報?(開工|返工|上班)$`).exec(t);
  if (m && okName(m[1]!)) return { kind: "name_caption", name: m[1]!, action: "checkin" };
  m = new RegExp(`^(${NAME}?)報?(收工|下班)$`).exec(t);
  if (m && okName(m[1]!)) return { kind: "name_caption", name: m[1]!, action: "checkout" };
  m = new RegExp(`^(${NAME})[代替頂](${NAME})$`).exec(t);
  if (m && okName(m[1]!) && okName(m[2]!)) return { kind: "substitution", worker: m[1]!, replaced: m[2]! };
  m = new RegExp(`^(${NAME})(\\d{1,2})月份?(?:假期|休息|放假|請假|休假|例假)[:：]?\\s*([\\d,，、\\s/]+)$`).exec(t);
  if (m && okName(m[1]!) && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const days = daysOf(m[3]!);
    if (days.length > 0) return { kind: "leave_notice", name: m[1]!, month: Number(m[2]), days };
  }
  m = new RegExp(`^(${NAME})(\\d{1,2})月份?(?:返.{1,12}?)?考勤(?:紀錄|記錄)?[，,]?\\s*休息\\s*(\\d+)\\s*日[:：]\\s*([\\d,，、\\s]+)$`).exec(t);
  if (m && okName(m[1]!) && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { kind: "attendance_summary", name: m[1]!, month: Number(m[2]), rest_days: daysOf(m[4]!), claimed: Number(m[3]) };
  if (/^(?:請問|問下|想問|請教)/.test(t) || /有(?:無|冇)返/.test(t)) return { kind: "plain_question" };
  return null;
}

/** 工號 token（U／MP／MG／MW＋4–6 位數字，容許 O/o 代 0）同日期 token（d/m(/yyyy) 容許 O/o）內嘅英文 O → 0。只改 token，唔改全文。 */
export function fixOcrDigits(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9])([Uu]|[Mm][PpGgWw])([0-9Oo]{4,6})(?![A-Za-z0-9])/g, (all, a: string, b: string) => (/\d/.test(b) ? a + b.replace(/[Oo]/g, "0") : all))
    .replace(/(?<![A-Za-z0-9])([0-9Oo]{1,2})\/([0-9Oo]{1,2})(?:\/([0-9Oo]{4}))?(?![A-Za-z0-9])/g, (all, d: string, mth: string, y?: string) => (/\d/.test(d) && /\d/.test(mth) ? `${d.replace(/[Oo]/g, "0")}/${mth.replace(/[Oo]/g, "0")}${y ? "/" + y.replace(/[Oo]/g, "0") : ""}` : all));
}

/** 時間範圍：`0700一1900`、`2200—0615`、`0700至1900` → `0700-1900`（4 位時間夾一個連字號類符號）。 */
function normalizeTimeRanges(text: string): string {
  return text.replace(/(?<!\d)(\d{4}|\d{1,2}:\d{2})\s*[一—–~～至到\-－]\s*(\d{4}|\d{1,2}:\d{2})(?!\d)/g, "$1-$2");
}

export const normalizeReportText = (text: string): string => normalizeTimeRanges(fixOcrDigits(text));

export const TIME_RANGE_RE = /(?<!\d)(?:[01]\d|2[0-3])[0-5]\d\s*[-一—–~～至到]\s*(?:[01]\d|2[0-3])[0-5]\d(?!\d)/;
/** 員工編號樣 token（U90222／MP9234…，容許 O 代 0）。 */
export const STAFF_TOKEN_RE = /(?<![A-Za-z0-9])(?:U|MP|MG|MW)[0-9Oo]{4,6}(?![A-Za-z0-9])/;
