// WA-9：文字名單偵測（純函數，零 LLM、零 DB）。
// 數碼港群 10 月起置頂規矩：每日有人打字接龍交齊當日全部返工保安員中文全名，例：「1/10/2026 孫富榮 陳文傑 許景竣 …」。
// 條件：(a) 有日期 token（d/m/yyyy、yyyy-mm-dd、d月d日、d/m，或今日／聽日等相對詞）；(b) 之後 ≥2 個 CJK 姓名 token（2–4 字；分隔：空格／全形空格／換行／、，；：/），
// 名後可帶更碼（「張三 D」「李四(夜)」「王五[N]」），名單前可有整句更碼（「夜更：…」）；(c) 冇請假／取消／替更字眼、冇問號。
// 命中 → { date, date_raw, names:[{raw, shift_hint}] }；唔命中 → null（照舊 LLM 路徑）。
import { hkDateOf, resolveDates } from "./dates";

interface RosterName {
  raw: string;
  /** 該名自己帶嘅更碼提示（D／N／夜…），或整句更碼；冇＝null */
  shift_hint: string | null;
}
export interface RosterList {
  /** 日期 ISO（明確日期或可唯一解析嘅相對詞）；凌晨「今日」等降級＝null（由 resolveIntents 按 date_raw 處理） */
  date: string | null;
  /** 原日期 token（交 resolveIntents 做日期降級／窗口檢查） */
  date_raw: string;
  names: RosterName[];
  confidence: "high" | "medium";
}

const ROSTER_MAX_NAMES = 40;

// 常見姓氏（單字＋複姓）。只用嚟**判斷係咪名單**（避免「開會 準時」之類普通詞被當名單）；名單一旦成立，所有姓名樣 token 都保留（冇偏門姓氏就被靜靜丟走）。
const SURNAMES_1 = "陳李張黃梁林劉王吳楊何郭羅周鄭馬蔡葉蘇許譚曾鍾徐趙孫朱胡潘余馮洪彭呂蕭容鄧姚方蔣溫戴杜傅沈袁范丁魏區簡曹謝邱莫柯阮尹韓田石岑古白賴湯駱倪麥魯梅任史嚴龍文盧程陸唐衛汪董甘毛紀巫辛韋賀岳薛邵歐管康常錢鄒凌游熊郝苗萬鄺雷季顧關章江龐金鄔練柳舒施雲祁洛蒙宋鮑甄利崔屈禤巢邢單狄滕鄢湛藍黎孔向谷尤戚寧俞翟翁童蒲安殷柏華卓左卜池官顏葛霍侯俊褚衞鞠奚欒喬盛夏於連藺步都耿滿弘匡國寇廣祿闕東殳沃曲符景詹束龔咸盧蘭祝曉";
const SURNAMES_2 = ["司徒", "歐陽", "夏侯", "上官", "諸葛", "皇甫", "司馬", "令狐", "慕容", "東方", "公孫", "長孫", "宇文", "呼延", "尉遲", "申屠", "太史", "端木", "南宮", "西門", "百里", "公冶"];
const startsWithSurname = (name: string): boolean => SURNAMES_2.some((s) => name.startsWith(s)) || SURNAMES_1.includes(name[0] ?? "");

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

/** 偵測文字名單；唔係名單＝null。 */
export function detectRosterList(textIn: string, ts: Date): RosterList | null {
  const text = (textIn ?? "").normalize("NFKC").trim();
  if (text.length < 8 || text.length > 1200) return null;
  if (EXCLUDE_RE.test(text) || /[?？]/.test(text)) return null;
  const d = findDate(text, ts);
  if (!d) return null;
  const toks = d.rest.split(/[\s　、，,；;：:\/／|]+/).map((t) => t.trim()).filter(Boolean);
  let globalHint: string | null = null;
  const names: RosterName[] = [];
  let other = 0;
  for (const t of toks) {
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
    // 2–4 字＝姓名；5–6 字而且姓氏開頭（歐陽／司徒複姓＋三字名、少數長名）都當姓名——唔好靜靜丟走
    if (NAME_RE.test(t) || (/^[一-鿿]{5,6}$/.test(t) && startsWithSurname(t))) {
      names.push({ raw: t, shift_hint: null });
      continue;
    }
    other += 1;
  }
  if (names.length < 2) return null;
  // 姓名樣 token 要夠多係常見姓氏開頭，否則係普通詞語（「開會 準時」）
  if (names.filter((n) => startsWithSurname(n.raw)).length < Math.max(2, Math.ceil(names.length * 0.7))) return null;
  // 非姓名雜質太多（句子、數字…）＝普通訊息，唔當名單
  if (other > Math.max(1, Math.floor(names.length * 0.3))) return null;
  const seen = new Set<string>();
  const uniq = names.filter((n) => (seen.has(n.raw) ? false : (seen.add(n.raw), true))).slice(0, ROSTER_MAX_NAMES);
  if (uniq.length < 2) return null;
  const startsWithDate = text.indexOf(d.hit.token) <= 2;
  return {
    date: d.hit.iso,
    date_raw: d.hit.token,
    names: uniq.map((n) => ({ raw: n.raw, shift_hint: n.shift_hint ?? globalHint })),
    confidence: startsWithDate && other === 0 ? "high" : "medium",
  };
}

