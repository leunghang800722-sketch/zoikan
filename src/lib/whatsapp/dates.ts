// W1：日期最終解析（code 決定，唔信 LLM 嘅 iso_guess；計劃書 §5.2）。
// 一律香港時區，以訊息 ts 嘅香港日曆日為「今日」。純函數、零 DB。
//  - 相對詞：今日／聽日／後日／大後日／琴日…；星期 X／下星期 X；X 號；X/X；X 月 Y 日。
//  - 同一句相對＋絕對（「聽日 17 號」）→ 兩者要一致，否則 date_ambiguous（唔估）。
//  - range 展開（「17–19 號」「聽日至後日」），最多 14 日。
//  - 凌晨 00:00–05:00 發出、日期詞係今日／今晚／而家／今個更／聽日（冇絕對日期、冇星期）→ date_ambiguous，
//    候選：當日、前一日（「聽日」：聽日、當日）。
import { hkParts } from "@/lib/dates";

type DateKind = "relative" | "absolute" | "range";

export interface DateInput {
  raw: string | null | undefined;
  kind?: DateKind | null;
}

type DateFailReason = "date_missing" | "date_unparseable" | "date_ambiguous" | "date_inconsistent" | "range_too_long";

export type DateResult =
  | { ok: true; dates: string[]; notes: string[] }
  | { ok: false; reason: DateFailReason; detail: string; candidates: string[] };

const MAX_RANGE_DAYS = 14;
/** 凌晨降級窗口：訊息香港時間 < 05:00。 */
const DAWN_END_HOUR = 5;

// ---- 日曆工具（YYYY-MM-DD ↔ UTC 日序號）----
function toDayNum(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function fromDayNum(n: number): string {
  const dt = new Date(n * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
function dayNumOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return toDayNum(y!, m!, d!);
}
export function addDays(iso: string, n: number): string {
  return fromDayNum(dayNumOf(iso) + n);
}
function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}
/** 0＝星期日 … 6＝星期六 */
function dowOf(iso: string): number {
  return new Date(dayNumOf(iso) * 86400000).getUTCDay();
}
export function hkDateOf(ts: Date): string {
  const p = hkParts(ts);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

// ---- token 抽取 ----
interface RelTok {
  offset: number;
  /** 「同日類」：今日／今晚／而家／今個更；「聽日類」：聽日／聽晚 */
  cls: "same" | "next" | "other";
}
const REL_WORDS: Array<[string, RelTok]> = [
  ["大後日", { offset: 3, cls: "other" }],
  ["大後天", { offset: 3, cls: "other" }],
  ["大前日", { offset: -3, cls: "other" }],
  ["後日", { offset: 2, cls: "other" }],
  ["後天", { offset: 2, cls: "other" }],
  ["前日", { offset: -2, cls: "other" }],
  ["前天", { offset: -2, cls: "other" }],
  ["聽日", { offset: 1, cls: "next" }],
  ["聽晚", { offset: 1, cls: "next" }],
  ["聽朝", { offset: 1, cls: "next" }],
  ["明日", { offset: 1, cls: "next" }],
  ["明天", { offset: 1, cls: "next" }],
  ["明晚", { offset: 1, cls: "next" }],
  ["琴日", { offset: -1, cls: "other" }],
  ["尋日", { offset: -1, cls: "other" }],
  ["昨日", { offset: -1, cls: "other" }],
  ["昨天", { offset: -1, cls: "other" }],
  ["昨晚", { offset: -1, cls: "other" }],
  ["今個更", { offset: 0, cls: "same" }],
  ["今更", { offset: 0, cls: "same" }],
  ["今日", { offset: 0, cls: "same" }],
  ["今天", { offset: 0, cls: "same" }],
  ["今晚", { offset: 0, cls: "same" }],
  ["今朝", { offset: 0, cls: "same" }],
  ["今早", { offset: 0, cls: "same" }],
  ["今夜", { offset: 0, cls: "same" }],
  ["而家", { offset: 0, cls: "same" }],
];

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

function cleanRaw(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[–—~～]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

interface Extracted {
  rel: RelTok[];
  weekday: Array<{ dow: number; next: boolean }>;
  /** 絕對日期候選（每個 token 一組，組內多個解讀） */
  abs: Array<{ kind: "dm" | "md-explicit" | "day"; options: Array<{ m: number | null; d: number }> }>;
  rangeDays: { from: number; to: number } | null;
}

function extract(rawIn: string): Extracted {
  let s = cleanRaw(rawIn);
  const out: Extracted = { rel: [], weekday: [], abs: [], rangeDays: null };

  // 相對詞（長詞先，並從字串移除避免重覆命中）
  for (const [w, tok] of REL_WORDS) {
    while (s.includes(w)) {
      out.rel.push(tok);
      s = s.replace(w, " ");
    }
  }
  // 星期：下星期X／下個星期X／星期X／禮拜X／週X／周X
  const wk = /(下個?|下)?\s*(?:星期|禮拜|週|周)\s*([一二三四五六日天])/g;
  s = s.replace(wk, (_m, nx: string | undefined, d: string) => {
    out.weekday.push({ dow: CN_DIGIT[d]!, next: !!nx });
    return " ";
  });
  // range：17-19號 / 17至19號 / 17到19號（日數）
  const rg = /(\d{1,2})\s*(?:號|日)?\s*(?:-|至|到|to)\s*(\d{1,2})\s*(?:號|日)/;
  const rgm = rg.exec(s);
  if (rgm) {
    out.rangeDays = { from: Number(rgm[1]), to: Number(rgm[2]) };
    s = s.replace(rg, " ");
  }
  // X月Y日／號
  s = s.replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*[號日]?/g, (_m, mo: string, d: string) => {
    out.abs.push({ kind: "md-explicit", options: [{ m: Number(mo), d: Number(d) }] });
    return " ";
  });
  // X/Y（HK 習慣日/月；兩個解讀都合法就俾兩個）
  s = s.replace(/(\d{1,2})\s*[/.]\s*(\d{1,2})/g, (_m, a: string, b: string) => {
    const x = Number(a);
    const y = Number(b);
    const options: Array<{ m: number | null; d: number }> = [];
    if (y >= 1 && y <= 12 && x >= 1 && x <= 31) options.push({ m: y, d: x }); // 日/月
    if (x >= 1 && x <= 12 && y >= 1 && y <= 31 && !(x === y)) options.push({ m: x, d: y }); // 月/日
    if (options.length === 0) options.push({ m: y, d: x });
    out.abs.push({ kind: "dm", options });
    return " ";
  });
  // 單獨 X號／X日
  s = s.replace(/(\d{1,2})\s*[號日]/g, (_m, d: string) => {
    out.abs.push({ kind: "day", options: [{ m: null, d: Number(d) }] });
    return " ";
  });
  return out;
}

/** 「X 號」冇月份：用最近、合理（今日 −2 起）嘅一日；過咗今個月就當下個月。 */
function resolveDayOnly(d: number, today: string): { iso: string | null; rolled: boolean } {
  const [ty, tm] = today.split("-").map(Number) as [number, number];
  const cands: Array<{ iso: string; rolled: boolean }> = [];
  // 上月（今日喺月初，例如 2 號講「31 號」）
  const prev = tm === 1 ? [ty - 1, 12] : [ty, tm - 1];
  if (isValidYmd(prev[0]!, prev[1]!, d)) cands.push({ iso: `${prev[0]}-${String(prev[1]).padStart(2, "0")}-${String(d).padStart(2, "0")}`, rolled: false });
  if (isValidYmd(ty, tm, d)) cands.push({ iso: `${ty}-${String(tm).padStart(2, "0")}-${String(d).padStart(2, "0")}`, rolled: false });
  const next = tm === 12 ? [ty + 1, 1] : [ty, tm + 1];
  if (isValidYmd(next[0]!, next[1]!, d)) cands.push({ iso: `${next[0]}-${String(next[1]).padStart(2, "0")}-${String(d).padStart(2, "0")}`, rolled: true });
  const todayNum = dayNumOf(today);
  const ok = cands.filter((c) => dayNumOf(c.iso) >= todayNum - 2);
  const first = ok[0];
  if (!first) return { iso: null, rolled: false };
  return { iso: first.iso, rolled: first.rolled || dayNumOf(first.iso) - todayNum > 20 };
}

function resolveMonthDay(m: number, d: number, today: string): string | null {
  const [ty] = today.split("-").map(Number) as [number];
  const todayNum = dayNumOf(today);
  const cands = [ty - 1, ty, ty + 1].filter((y) => isValidYmd(y, m, d)).map((y) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  // 取最近（絕對距離最短）嘅一年
  cands.sort((a, b) => Math.abs(dayNumOf(a) - todayNum) - Math.abs(dayNumOf(b) - todayNum));
  return cands[0] ?? null;
}

function resolveWeekday(dow: number, next: boolean, today: string): string {
  const tDow = dowOf(today);
  if (next) {
    // 下星期X：下一個（星期一起計）星期入面嘅星期X
    const mondayOffset = (tDow + 6) % 7; // 今日距今個星期一
    const nextMonday = dayNumOf(today) - mondayOffset + 7;
    const idx = (dow + 6) % 7; // 星期一=0 … 星期日=6
    return fromDayNum(nextMonday + idx);
  }
  // 星期X：由今日起（含今日）最近一個
  const diff = (dow - tDow + 7) % 7;
  return addDays(today, diff);
}

/** 唯一入口：將 LLM 回嘅 date.raw 解析成具體日子（可能多日）。 */
export function resolveDates(input: DateInput, ts: Date): DateResult {
  const rawStr = (input.raw ?? "").trim();
  const today = hkDateOf(ts);
  if (!rawStr) return { ok: false, reason: "date_missing", detail: "no_date_text", candidates: [] };
  const ex = extract(rawStr);
  const hasAny = ex.rel.length > 0 || ex.weekday.length > 0 || ex.abs.length > 0 || ex.rangeDays !== null;
  if (!hasAny) return { ok: false, reason: "date_unparseable", detail: "no_known_token", candidates: [] };
  const notes: string[] = [];
  const hkHour = hkParts(ts).hour;
  const dawn = hkHour < DAWN_END_HOUR;

  // ---- range ----
  if (ex.rangeDays) {
    const { from, to } = ex.rangeDays;
    if (from < 1 || to < 1 || from > 31 || to > 31 || to < from) return { ok: false, reason: "date_unparseable", detail: "bad_range", candidates: [] };
    if (to - from + 1 > MAX_RANGE_DAYS) return { ok: false, reason: "range_too_long", detail: "range_over_14_days", candidates: [] };
    const first = resolveDayOnly(from, today);
    if (!first.iso) return { ok: false, reason: "date_unparseable", detail: "range_start_past", candidates: [] };
    const [fy, fm] = first.iso.split("-").map(Number) as [number, number];
    const dates: string[] = [];
    for (let d = from; d <= to; d++) {
      if (!isValidYmd(fy, fm, d)) return { ok: false, reason: "date_unparseable", detail: "range_invalid_day", candidates: [] };
      dates.push(`${fy}-${String(fm).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    notes.push("range");
    return { ok: true, dates, notes };
  }
  // 「聽日至後日」：兩個相對詞（連同 至／到／-）
  const rangeWord = /(至|到|-)/.test(cleanRaw(rawStr));
  if (rangeWord && ex.rel.length === 2 && ex.weekday.length === 0 && ex.abs.length === 0) {
    const [a, b] = [ex.rel[0]!.offset, ex.rel[1]!.offset].sort((x, y) => x - y) as [number, number];
    if (b - a + 1 > MAX_RANGE_DAYS) return { ok: false, reason: "range_too_long", detail: "range_over_14_days", candidates: [] };
    const dates: string[] = [];
    for (let i = a; i <= b; i++) dates.push(addDays(today, i));
    notes.push("range_relative");
    return { ok: true, dates, notes };
  }

  // ---- 單日：每個 token 各自出候選集，要求交集唯一 ----
  const sets: string[][] = [];
  let dawnClass: RelTok["cls"] | null = null;
  const hasAbsOrWeekday = ex.abs.length > 0 || ex.weekday.length > 0;
  for (const r of ex.rel) {
    sets.push([addDays(today, r.offset)]);
    if (!hasAbsOrWeekday && (r.cls === "same" || r.cls === "next")) dawnClass = dawnClass === "same" ? "same" : r.cls;
  }
  for (const w of ex.weekday) sets.push([resolveWeekday(w.dow, w.next, today)]);
  for (const a of ex.abs) {
    const iso: string[] = [];
    for (const o of a.options) {
      if (o.m === null) {
        const r = resolveDayOnly(o.d, today);
        if (r.iso) {
          iso.push(r.iso);
          if (r.rolled) notes.push("month_rolled");
        }
      } else {
        const r = resolveMonthDay(o.m, o.d, today);
        if (r) iso.push(r);
      }
    }
    if (iso.length === 0) return { ok: false, reason: "date_unparseable", detail: "absolute_invalid", candidates: [] };
    sets.push([...new Set(iso)]);
  }

  // 交集
  let inter = sets[0]!;
  for (const st of sets.slice(1)) inter = inter.filter((x) => st.includes(x));
  if (inter.length === 0) {
    return { ok: false, reason: "date_inconsistent", detail: "tokens_disagree", candidates: [...new Set(sets.flat())].sort() };
  }
  if (inter.length > 1) {
    return { ok: false, reason: "date_ambiguous", detail: "multiple_interpretations", candidates: inter.sort() };
  }

  // 凌晨降級（只對「冇絕對日期、冇星期」嘅今日／今晚／而家／今個更／聽日）
  if (dawn && dawnClass) {
    const cands = dawnClass === "same" ? [today, addDays(today, -1)] : [addDays(today, 1), today];
    return { ok: false, reason: "date_ambiguous", detail: "dawn_cross_day", candidates: cands };
  }
  if (sets.length > 1) notes.push("rel_abs_consistent");
  return { ok: true, dates: inter, notes };
}

/** 日子係咪喺 [今日 −2, 今日 +45] 範圍（以訊息 ts 嘅香港日為今日）。 */
export function dateInWindow(iso: string, ts: Date, minDays = -2, maxDays = 45): boolean {
  const diff = dayNumOf(iso) - dayNumOf(hkDateOf(ts));
  return diff >= minDays && diff <= maxDays;
}

/** YYYY-MM-DD → 月份第一日（UTC 0 時 Date，DB 月份欄口徑）。 */
export function monthStartOf(iso: string): Date {
  const [y, m] = iso.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1));
}

/** YYYY-MM-DD → DB `@db.Date` 用嘅 UTC 0 時 Date。 */
export function isoToDbDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}
