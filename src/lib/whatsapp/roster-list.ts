// WA-9：文字名單偵測（純函數，零 LLM、零 DB）。
// 數碼港群 10 月起置頂規矩：有人打字接龍交齊返工保安員中文全名。真數據（WA-9 (7)）係「多日累積版」：
//   一行日期（可帶 WhatsApp 粗體星號 / 尾空格 / 全形斜線 / 數字 0 打成英文 O / 轉發前綴），下一行（或同一行）係當日全部人名，
//   由月初逐日疊落去，每位保安員報到就編輯／重發整條。亦支援舊單日格式（「1/10/2026 名 名 名」、相對日期詞）。
// 命中 → { kind:"roster_list", days:[{date, date_raw, names:[{raw, shift_hint}]}], header_lines, confidence }；唔命中 → null（照舊路徑）。
// 另有 detectRosterPlan：預定更表「日序名單」（`20 名 名 名`，日期只係日數）——唔係實際報到，唔建 shift。
// 清潔：尾句號、雙空格、1 字 token 接 1–3 字 token（姓同名分開）合併、簡繁正規化（比對用）、同日重複名去重；
// 5–8 字黏名 token 要有已知姓名集（knownNames）先敢拆（detect 唔依賴名集；resolve 階段用 GuardMatchIndex 名集再 refineNames）。
import { hkDateOf, resolveDates } from "./dates";
import { normNameVariant } from "@/lib/names/variants";

interface RosterName {
  raw: string;
  /** 該名自己帶嘅更碼提示（D／N／夜…），或整句更碼；冇＝null */
  shift_hint: string | null;
}
interface RosterDay {
  /** 日期 ISO（明確日期或可唯一解析嘅相對詞）；凌晨「今日」等降級＝null（由 resolveIntents 按 date_raw 處理） */
  date: string | null;
  /** 原日期 token（交 resolveIntents 做日期降級／窗口檢查） */
  date_raw: string;
  names: RosterName[];
}
export interface RosterList {
  kind: "roster_list";
  days: RosterDay[];
  /** 第一個日期行之前嘅標題行數（忽略，只作統計） */
  header_lines: number;
  confidence: "high" | "medium";
}
export interface RosterPlan {
  kind: "roster_plan";
  days: Array<{ date: string; names: string[] }>;
}
export interface DetectOpts {
  /** 已知姓名集（已 normNameVariant）；有就可以拆黏名／判斷 1 字 token 合併 */
  knownNames?: ReadonlySet<string>;
}

const TEXT_MAX_CHARS = 8000;
const MAX_DAYS = 31;
const ROSTER_MAX_NAMES = 40;

// 常見姓氏（單字＋複姓）。只用嚟**判斷係咪名單**（避免「開會 準時」之類普通詞被當名單）；名單一旦成立，所有姓名樣 token 都保留（冇偏門姓氏就被靜靜丟走）。
const SURNAMES_1 = "陳李張黃梁林劉王吳楊何郭羅周鄭馬蔡葉蘇許譚曾鍾徐趙孫朱胡潘余馮洪彭呂蕭容鄧姚方蔣溫戴杜傅沈袁范丁魏區簡曹謝邱莫柯阮尹韓田石岑古白賴湯駱倪麥魯梅任史嚴龍文盧程陸唐衛汪董甘毛紀巫辛韋賀岳薛邵歐管康常錢鄒凌游熊郝苗萬鄺雷季顧關章江龐金鄔練柳舒施雲祁洛蒙宋鮑甄利崔屈禤巢邢單狄滕鄢湛藍黎孔向谷尤戚寧俞翟翁童蒲安殷柏華卓左卜池官顏葛霍侯俊褚衞鞠奚欒喬盛夏於連藺步都耿滿弘匡國寇廣祿闕東殳沃曲符景詹束龔咸盧蘭祝曉";
const SURNAMES_2 = ["司徒", "歐陽", "夏侯", "上官", "諸葛", "皇甫", "司馬", "令狐", "慕容", "東方", "公孫", "長孫", "宇文", "呼延", "尉遲", "申屠", "太史", "端木", "南宮", "西門", "百里", "公冶"];
export const startsWithSurname = (nameIn: string): boolean => {
  const name = normNameVariant(nameIn); // 簡體姓（谢／陈／刘…）先轉繁體再判斷
  return SURNAMES_2.some((s) => name.startsWith(s)) || SURNAMES_1.includes(name[0] ?? "");
};

const EXCLUDE_RE = /(唔返|不返|返唔到|病假|請假|告假|事假|放假|休假|例假|公假|取消|唔去|替|頂更|頂替|換更|調更|\bSL\b|\bAL\b|\bNL\b|\bNPL\b|\bRD\b|\bSH\b)/i;
const STOP = new Set(["收到", "多謝", "唔該", "好的", "明白", "了解", "知道", "返工", "名單", "以上", "如下", "當值", "全部", "大家", "各位", "辛苦", "今日返工", "人員", "名單如下", "保安", "當更"]);
const SHIFT_TOKEN = /^(?:[A-Za-z]|[A-Za-z]更|[日夜早中晚]更?|通宵)$/;
const NAME_RE = /^[一-鿿]{2,4}$/;
const NAME_WITH_HINT_RE = /^([一-鿿]{2,4})[(（[【]\s*([^)）\]】]{1,4}?)\s*[)）\]】]$/;

interface DateHit {
  token: string;
  iso: string | null;
}

/** 搵日期 token（移除用）。回 { hit, rest }；冇＝null。 */
function findDate(text: string, ts: Date): { hit: DateHit; rest: string } | null {
  const today = hkDateOf(ts);
  const year = Number(today.slice(0, 4));
  const valid = (y: number, m: number, d: number): string | null => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 ? dt.toISOString().slice(0, 10) : null;
  };
  const tryRe = (re: RegExp, f: (m: RegExpExecArray) => string | null): { hit: DateHit; rest: string } | null => {
    const m = re.exec(text);
    if (!m) return null;
    return { hit: { token: m[0], iso: f(m) }, rest: text.replace(m[0], " ") };
  };
  // d/m/yyyy（香港習慣日/月/年；第一個 >12 一定係日，第二個 >12 就當月/日/年）
  const dmy = tryRe(/(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(20\d{2})(?!\d)/, (m) => {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    return b > 12 && a <= 12 ? valid(y, a, b) : valid(y, b, a);
  });
  if (dmy) return dmy;
  const iso = tryRe(/(?<!\d)(20\d{2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})(?!\d)/, (m) => valid(Number(m[1]), Number(m[2]), Number(m[3])));
  if (iso) return iso;
  const md = tryRe(/(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/, (m) => {
    const cands = [year - 1, year, year + 1].flatMap((y) => { const v = valid(y, Number(m[1]), Number(m[2])); return v ? [v] : []; });
    return cands.sort((a, b) => Math.abs(Date.parse(a) - Date.parse(today)) - Math.abs(Date.parse(b) - Date.parse(today)))[0] ?? null;
  });
  if (md) return md;
  const dm = tryRe(/(?<!\d)(\d{1,2})\s*[/.]\s*(\d{1,2})(?!\d)/, (m) => {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const opts = [valid(year, b, a), valid(year - 1, b, a), valid(year + 1, b, a)].filter((x): x is string => !!x); // 日/月
    return opts.sort((x, y) => Math.abs(Date.parse(x) - Date.parse(today)) - Math.abs(Date.parse(y) - Date.parse(today)))[0] ?? null;
  });
  if (dm) return dm;
  // 相對詞
  const rel = /(大後日|後日|聽日|明日|今日|今天|今晚|聽晚|琴日|尋日|昨日|昨天|前日)/.exec(text);
  if (rel) {
    const r = resolveDates({ raw: rel[0], kind: "relative" }, ts);
    return { hit: { token: rel[0], iso: r.ok && r.dates.length === 1 ? r.dates[0]! : null }, rest: text.replace(rel[0], " ") };
  }
  return null;
}

const CJK = "[一-鿿]";
const strip = (t: string): string => t.replace(/^[.。,，!！~～•·]+|[.。,，!！~～•·]+$/g, "");
const isCjkRun = (t: string, min: number, max: number): boolean => new RegExp(`^${CJK}{${min},${max}}$`).test(t);

interface Tokenized {
  names: Array<RosterName & { glued?: boolean }>;
  other: number;
  globalHint: string | null;
}

/** 名行 → 姓名 token（合併分開嘅姓／名、剝句號、更碼提示）。 */
function tokenizeNames(text: string, known?: ReadonlySet<string>): Tokenized {
  const toks = text.split(/[\s　、，,；;：:/|]+/).map(strip).filter(Boolean);
  let globalHint: string | null = null;
  const names: Tokenized["names"] = [];
  let other = 0;
  for (let i = 0; i < toks.length; i++) {
    let t = toks[i]!;
    if (STOP.has(t)) continue;
    const withHint = NAME_WITH_HINT_RE.exec(t);
    if (withHint && SHIFT_TOKEN.test(withHint[2]!.trim()) && !STOP.has(withHint[1]!)) {
      names.push({ raw: withHint[1]!, shift_hint: withHint[2]!.trim() });
      continue;
    }
    if (SHIFT_TOKEN.test(t)) {
      // 接喺名後＝該名更碼；喺第一個名之前＝整句更碼
      if (names.length > 0) names[names.length - 1]!.shift_hint ??= t;
      else globalHint = t;
      continue;
    }
    // 1 字 token（姓同名中間有空格）：接住下一個 1–3 字 token 合併；有名集而合併後唔係已知名、但下一個本身係已知名 → 1 字係雜質，丟
    if (isCjkRun(t, 1, 1) && i + 1 < toks.length && isCjkRun(toks[i + 1]!, 1, 3)) {
      const merged = t + toks[i + 1]!;
      if (known && !known.has(normNameVariant(merged)) && known.has(normNameVariant(toks[i + 1]!))) continue;
      t = merged;
      i += 1;
    }
    // 2–4 字＝姓名；5–8 字而且姓氏開頭＝黏埋嘅幾個名（或歐陽／司徒複姓長名）——保留，resolve 階段先拆
    if (NAME_RE.test(t)) {
      names.push({ raw: t, shift_hint: null });
      continue;
    }
    if (isCjkRun(t, 5, 8) && startsWithSurname(t)) {
      names.push({ raw: t, shift_hint: null, glued: true });
      continue;
    }
    other += 1;
  }
  return { names, other, globalHint };
}

/**
 * 用已知姓名集拆黏名（5–8 字）：能夠切成 2–4 字、而且每段都係已知名（簡繁正規化後）→ 拆開；
 * 拆唔到就原樣保留（交揀人題）。同日重複名（簡繁視為同一人）去重。
 */
export function refineNames(names: ReadonlyArray<RosterName>, known: ReadonlySet<string>): RosterName[] {
  const out: RosterName[] = [];
  const seen = new Set<string>();
  const push = (raw: string, hint: string | null): void => {
    const k = normNameVariant(raw);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ raw, shift_hint: hint });
  };
  const split = (t: string): string[] | null => {
    if (t.length < 4 || t.length > 12) return null;
    const best = (from: number): string[] | null => {
      if (from === t.length) return [];
      for (const len of [3, 2, 4]) {
        const seg = t.slice(from, from + len);
        if (seg.length !== len || !known.has(normNameVariant(seg))) continue;
        const rest = best(from + len);
        if (rest) return [seg, ...rest];
      }
      return null;
    };
    const r = best(0);
    return r && r.length >= 2 ? r : null;
  };
  for (const n of names) {
    if (n.raw.length >= 5 && !known.has(normNameVariant(n.raw))) {
      const parts = split(n.raw);
      if (parts) {
        for (const p of parts) push(p, n.shift_hint);
        continue;
      }
    }
    push(n.raw, n.shift_hint);
  }
  return out;
}

// ---- 日期行
const FWD_PREFIX = /^\[\d{1,2}\/\d{1,2} \d{1,2}:\d{2}\] [^:]{1,40}: ?/;
const cleanLine = (l: string): string => l.replace(FWD_PREFIX, "").replace(/\*/g, "").replace(/[ \t　]+/g, " ").trim();
const fixO = (s: string): string => s.replace(/[Oo]/g, "0");

function validIso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt.toISOString().slice(0, 10) : null;
}
const nearest = (opts: string[], today: string): string | null => opts.sort((a, b) => Math.abs(Date.parse(a) - Date.parse(today)) - Math.abs(Date.parse(b) - Date.parse(today)))[0] ?? null;

/** 行首日期（d/m/yyyy、d/m、yyyy-mm-dd、d月d日；數字上下文 O→0）。回 { iso, token, rest }。 */
function leadingDate(line: string, ts: Date): { iso: string | null; token: string; rest: string } | null {
  const today = hkDateOf(ts);
  const year = Number(today.slice(0, 4));
  let m = /^([\dOo]{1,2})\s*\/\s*([\dOo]{1,2})(?:\s*\/\s*([\dOo]{4}))?(?![\dOo\/])/.exec(line);
  if (m && /\d/.test(m[1]!) && /\d/.test(m[2]!)) {
    const a = Number(fixO(m[1]!));
    const b = Number(fixO(m[2]!));
    let iso: string | null;
    if (m[3]) {
      const y = Number(fixO(m[3]));
      iso = b > 12 && a <= 12 ? validIso(y, a, b) : validIso(y, b, a);
    } else {
      iso = nearest([validIso(year, b, a), validIso(year - 1, b, a), validIso(year + 1, b, a)].filter((x): x is string => !!x), today);
    }
    return { iso, token: m[0], rest: line.slice(m[0].length).trim() };
  }
  m = /^(20\d{2})\s*-\s*(\d{1,2})\s*-\s*(\d{1,2})(?!\d)/.exec(line);
  if (m) return { iso: validIso(Number(m[1]), Number(m[2]), Number(m[3])), token: m[0], rest: line.slice(m[0].length).trim() };
  m = /^(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/.exec(line);
  if (m) {
    const iso = nearest([year - 1, year, year + 1].flatMap((y) => { const v = validIso(y, Number(m![1]), Number(m![2])); return v ? [v] : []; }), today);
    return { iso, token: m[0], rest: line.slice(m[0].length).trim() };
  }
  return null;
}

function detectMultiLine(text: string, ts: Date, known?: ReadonlySet<string>): RosterList | null {
  const lines = text.split(/\r?\n/).map(cleanLine);
  const days = new Map<string, { iso: string | null; token: string; lines: string[] }>();
  let cur: { iso: string | null; token: string; lines: string[] } | null = null;
  let header = 0;
  for (const l of lines) {
    if (!l) continue;
    const d = leadingDate(l, ts);
    if (d) {
      cur = { iso: d.iso, token: d.token, lines: d.rest ? [d.rest] : [] };
      const key = d.iso ?? d.token;
      days.delete(key); // 同一日期出現多次（轉發兩段拼埋）→ 以後者為準
      days.set(key, cur);
    } else if (cur) cur.lines.push(l);
    else header += 1;
  }
  if (days.size === 0 || days.size > MAX_DAYS) return null;
  const outDays: RosterDay[] = [];
  let totalNames = 0;
  let surnameOk = 0;
  let other = 0;
  for (const d of days.values()) {
    const body = d.lines.join(" ");
    if (!body || EXCLUDE_RE.test(body) || /[?？]/.test(body)) continue; // 請假／替更／問句行：該日唔當名單
    const tk = tokenizeNames(body, known);
    other += tk.other;
    const names = (known ? refineNames(tk.names, known) : dedupe(tk.names)).slice(0, ROSTER_MAX_NAMES);
    if (names.length === 0) continue;
    totalNames += names.length;
    surnameOk += names.filter((n) => startsWithSurname(n.raw)).length;
    outDays.push({ date: d.iso, date_raw: d.token, names: names.map((n) => ({ raw: n.raw, shift_hint: n.shift_hint ?? tk.globalHint })) });
  }
  if (outDays.length === 0 || totalNames < 2) return null;
  if (surnameOk < Math.max(2, Math.ceil(totalNames * 0.7))) return null;
  if (other > Math.max(1, Math.floor(totalNames * 0.3))) return null;
  return { kind: "roster_list", days: outDays, header_lines: header, confidence: other === 0 ? "high" : "medium" };
}

function dedupe<T extends { raw: string }>(names: T[]): T[] {
  const seen = new Set<string>();
  return names.filter((n) => { const k = normNameVariant(n.raw); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

/** 舊單行格式（相對日期詞「今日／聽日」、日期唔喺行首）。 */
function detectInline(text: string, ts: Date, known?: ReadonlySet<string>): RosterList | null {
  if (text.length < 8 || text.length > 1200) return null;
  if (EXCLUDE_RE.test(text) || /[?？]/.test(text)) return null;
  const d = findDate(text, ts);
  if (!d) return null;
  const tk = tokenizeNames(d.rest, known);
  if (tk.names.length < 2) return null;
  if (tk.names.filter((n) => startsWithSurname(n.raw)).length < Math.max(2, Math.ceil(tk.names.length * 0.7))) return null;
  if (tk.other > Math.max(1, Math.floor(tk.names.length * 0.3))) return null;
  const names = (known ? refineNames(tk.names, known) : dedupe(tk.names)).slice(0, ROSTER_MAX_NAMES);
  if (names.length < 2) return null;
  return {
    kind: "roster_list",
    days: [{ date: d.hit.iso, date_raw: d.hit.token, names: names.map((n) => ({ raw: n.raw, shift_hint: n.shift_hint ?? tk.globalHint })) }],
    header_lines: 0,
    confidence: text.indexOf(d.hit.token) <= 2 && tk.other === 0 ? "high" : "medium",
  };
}

/** 偵測文字名單（單日／多日累積）；唔係名單＝null。 */
export function detectRosterList(textIn: string, ts: Date, opts: DetectOpts = {}): RosterList | null {
  const text = (textIn ?? "").normalize("NFKC").trim();
  if (text.length < 8 || text.length > TEXT_MAX_CHARS) return null;
  return detectMultiLine(text, ts, opts.knownNames) ?? detectInline(text, ts, opts.knownNames);
}

/** 預定更表「日序名單」：每行 `<日> 名 名 名`（日期只係日數，≥2 名；多段用空行或換行分隔）。唔係＝null。 */
export function detectRosterPlan(textIn: string, ts: Date, opts: DetectOpts = {}): RosterPlan | null {
  const text = (textIn ?? "").normalize("NFKC").trim();
  if (text.length < 6 || text.length > TEXT_MAX_CHARS) return null;
  if (EXCLUDE_RE.test(text) || /[?？]/.test(text) || /\d\s*[/月-]\s*\d/.test(text)) return null;
  const today = hkDateOf(ts);
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  const days: RosterPlan["days"] = [];
  let totalNames = 0;
  let surnameOk = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = cleanLine(raw);
    if (!l) continue;
    const m = /^(\d{1,2})\s+(.+)$/.exec(l);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 31) return null; // 有非日序行＝唔係純預定更表
    const day = Number(m[1]);
    const tk = tokenizeNames(m[2]!, opts.knownNames);
    const names = opts.knownNames ? refineNames(tk.names, opts.knownNames) : dedupe(tk.names);
    if (names.length < 2 || tk.other > 1) return null;
    // 日 ≥ 今日日數 → 本月，否則下月（唔會超過本月＋1）
    const [y, mo] = day >= td ? [ty, tm] : tm === 12 ? [ty + 1, 1] : [ty, tm + 1];
    const iso = validIso(y, mo, day);
    if (!iso) continue;
    totalNames += names.length;
    surnameOk += names.filter((n) => startsWithSurname(n.raw)).length;
    days.push({ date: iso, names: names.map((n) => n.raw) });
  }
  if (days.length === 0 || surnameOk < Math.max(2, Math.ceil(totalNames * 0.7))) return null;
  return { kind: "roster_plan", days };
}
