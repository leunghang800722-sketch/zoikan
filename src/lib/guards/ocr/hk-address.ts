// WP-OCR-2：香港地址正規化（純函數，browser／Node 共用，零 server 依賴）。
// 只做「可逆、可解釋」嘅處理：
//   canon     比對用（形近字歸一、全形半形、空白標點、單位詞歸一）——唔顯示俾人睇
//   display   保留原讀數（只做 NFKC＋空白折疊）
//   suggested 只喺「形近字歸一後命中屋邨／街道／地區表」而原文寫法唔同時，先喺原文改該段（其餘不動）；唔命中唔改
//   edits     逐項 { from, to, reason, index }（index＝喺 display 入面嘅字元位置）
//   parts     規則抽出嘅地址成分（floor／unit 供 ALS 外送前剔走；見 alsQueryFromParts）
import { BUILDING_SUFFIXES, ESTATE_SUFFIXES, STREET_SUFFIXES, EXTRA_ESTATES, HK_DISTRICTS, HK_ESTATES, HK_REGIONS, MAJOR_STREETS } from "./hk-address-data";

/**
 * 形近／同音／簡繁字映射（只限地址語境；一對一、等長，所以位置可對齊）。
 * variant → canonical（canonical 取屋邨／街道表慣用寫法）。canon=false 嘅只做「候選」（唔入 canon、唔自動歸一）。
 * 每條附註解（來源：香港地名慣用寫法／常見手寫誤讀，規劃者簡報整理；補充項標「補」）。
 */
interface FoldPair {
  variant: string;
  canonical: string;
  canon: boolean;
  note: string;
}
const FOLD_PAIRS: readonly FoldPair[] = [
  { variant: "村", canonical: "邨", canon: true, note: "屋邨名慣用邨，常被寫成村" },
  { variant: "步", canonical: "埗", canon: true, note: "深水埗" },
  { variant: "湧", canonical: "涌", canon: true, note: "東涌／葵涌／大涌／鰂魚涌" },
  { variant: "則", canonical: "鰂", canon: true, note: "鰂魚涌（則／鰂 形近）" },
  { variant: "浦", canonical: "埔", canon: true, note: "大埔（浦／埔 形近）" },
  { variant: "湾", canonical: "灣", canon: true, note: "簡體：灣仔／長沙灣" },
  { variant: "茘", canonical: "荔", canon: true, note: "荔枝角／荔景（異體）" },
  { variant: "癸", canonical: "葵", canon: true, note: "葵涌／葵芳（形近）" },
  { variant: "岭", canonical: "嶺", canon: true, note: "簡體：粉嶺／嶺南" },
  { variant: "砂", canonical: "沙", canon: true, note: "沙田／沙頭角（同音形近）" },
  { variant: "奧", canonical: "澳", canon: true, note: "將軍澳（形近）" },
  { variant: "边", canonical: "邊", canon: true, note: "簡體：水邊圍" },
  { variant: "园", canonical: "園", canon: true, note: "簡體：花園" },
  { variant: "楼", canonical: "樓", canon: true, note: "簡體：樓" },
  { variant: "厦", canonical: "廈", canon: true, note: "簡體：大廈" },
  { variant: "兴", canonical: "興", canon: true, note: "簡體：新興／長興" },
  { variant: "华", canonical: "華", canon: true, note: "簡體：華富／華廈" },
  { variant: "丰", canonical: "豐", canon: true, note: "簡體：豐盛／豐和" },
  { variant: "宝", canonical: "寶", canon: true, note: "簡體：寶琳／寶田" },
  { variant: "丽", canonical: "麗", canon: true, note: "簡體：麗瑤／美麗" },
  { variant: "荣", canonical: "榮", canon: true, note: "簡體：榮昌" },
  { variant: "龙", canonical: "龍", canon: true, note: "簡體：九龍" },
  { variant: "号", canonical: "號", canon: true, note: "簡體：號" },
  { variant: "栅", canonical: "柵", canon: true, note: "補：簡體（石栅？）" },
  { variant: "咀", canonical: "角", canon: false, note: "旺角／尖沙咀 易混——只做候選，唔自動改" },
  { variant: "角", canonical: "咀", canon: false, note: "尖沙咀／旺角 易混——只做候選，唔自動改" },
];

const CANON_FOLD = new Map(FOLD_PAIRS.filter((p) => p.canon).map((p) => [p.variant, p.canonical]));
// 候選版：canon 歸一再加單向 咀→角（旺角／尖沙咀 易混，名稱同原文兩邊都歸一先比對）
const CAND_FOLD = new Map<string, string>([...CANON_FOLD, ["咀", "角"]]);
/** 單位詞用字嘅簡繁歸一（parts 抽取用；唔動地名） */
const UNIT_CHAR_FOLD = new Map([["楼", "樓"], ["号", "號"], ["层", "層"], ["铺", "鋪"], ["厦", "廈"]]);

const mapChars = (s: string, m: ReadonlyMap<string, string>): string => {
  let o = "";
  for (const ch of s) o += m.get(ch) ?? ch;
  return o;
};
/** 形近字歸一（等長 1:1）。 */
const foldVariants = (s: string): string => mapChars(s, CANON_FOLD);

export interface AddressEdit {
  from: string;
  to: string;
  /** variant_char＝形近字歸一後命中表；candidate_only＝易混字（旺角／尖沙咀）候選 */
  reason: "variant_char" | "candidate_only";
  /** 喺 display 嘅字元位置 */
  index: number;
}

export interface HkAddressParts {
  district?: string;
  street?: string;
  number?: string;
  estate?: string;
  block?: string;
  floor?: string;
  unit?: string;
  building?: string;
  phase?: string;
}

export interface HkAddressResult {
  display: string;
  canon: string;
  /** 同 canon 一樣但唔做形近字歸一（候選去重用：邨／村 係兩個候選） */
  strict: string;
  suggested: string;
  edits: AddressEdit[];
  parts: HkAddressParts;
}

/** 基本清理：NFKC（全形→半形）、控制字元、破折號、空白折疊。 */
function cleanAddr(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[‐‑‒–—―－﹣]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- 數字（〇零一二…／壹貳叁…）----------
const DIGIT_ZH: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 壹: 1, 貳: 2, 叁: 3, 參: 3, 肆: 4, 伍: 5, 陸: 6, 柒: 7, 捌: 8, 玖: 9 };
const NUM_RUN = "[〇零一二兩三四五六七八九十百壹貳叁參肆伍陸柒捌玖拾佰廿卅]+";

/** 中文數字串 → 阿拉伯數字（≤999）；唔識 → null。 */
export function zhNumeralToInt(input: string): number | null {
  if (!input) return null;
  const s = input.replace(/廿/g, "二十").replace(/卅/g, "三十"); // 廿＝二十、卅＝三十（廿三樓＝23樓）
  if (!/[十拾百佰]/.test(s)) {
    let o = "";
    for (const ch of s) {
      if (!(ch in DIGIT_ZH)) return null;
      o += DIGIT_ZH[ch];
    }
    return Number(o);
  }
  let n = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in DIGIT_ZH) cur = DIGIT_ZH[ch]!;
    else if (ch === "十" || ch === "拾") {
      n += (cur || 1) * 10;
      cur = 0;
    } else if (ch === "百" || ch === "佰") {
      n += (cur || 1) * 100;
      cur = 0;
    } else return null;
  }
  return n + cur;
}

const numRunRe = new RegExp(`${NUM_RUN}(?=[號樓層室座期舖鋪])`, "g");

/**
 * 單位詞歸一（中文形式）：數字＋號／樓／室／座／期 前嘅中文數字→阿拉伯；15/F、15F→15樓；Flat／Rm／Room／Unit X→X室；
 * Block／Blk／Tower X→X座；Phase X→X期；G/F→地下。輸入已大寫。
 */
function convertUnitWords(input: string, foldChars = true): string {
  let t = foldChars ? mapChars(input, UNIT_CHAR_FOLD) : input;
  t = t.replace(/([0-9A-Z])\s+(?=[號樓層室座期舖鋪])/g, "$1"); // 「5 舖」「100 號」「3 室」
  t = t.replace(new RegExp(`(${NUM_RUN})\\s+(?=[號樓層室座期舖鋪])`, "g"), "$1"); // 「一 樓」
  t = t.replace(numRunRe, (m) => {
    const n = zhNumeralToInt(m);
    return n === null ? m : String(n);
  });
  // 英文單位詞（前置詞→後置中文單位）
  t = t.replace(/\bG\s*\/\s*F\b/g, "地下");
  t = t.replace(/\b(\d+[A-Z]?)\s*(?:\/\s*F|F)(?![A-Z])/g, "$1樓");
  t = t.replace(/\b(?:FLOOR|FL)\.?\s*(\d+)\b/g, "$1樓");
  t = t.replace(/\b(\d+)\s*(?:ST|ND|RD|TH)?\s*(?:FLOOR|FL)\b/g, "$1樓");
  t = t.replace(/\b(?:FLAT|FLT|RM|ROOM|UNIT)[.\-:]?\s*([A-Z0-9]+(?:-[A-Z0-9]+)?)/g, "$1室");
  t = t.replace(/\bSHOP\.?\s*([A-Z0-9]+(?:-[A-Z0-9]+)?)/g, "$1舖");
  t = t.replace(/\b(?:BLOCK|BLK|TOWER)\.?\s*([A-Z0-9]+)/g, "$1座");
  t = t.replace(/\bPHASE\s*([0-9]+|[IVX]+)/g, "$1期");
  // 樓層後面冇單位詞嘅單位：「12樓A」→12樓A室；「12/F 1203」→12樓1203室（後面緊接 號／樓／室／座／期 就唔係）
  t = t.replace(/(\d+[A-Z]?樓)[\s,，、]*([A-Z]\d{0,2})(?![A-Z0-9號樓層室座期舖鋪])/g, "$1$2室");
  t = t.replace(/(\d+[A-Z]?樓)[\s,，、]*(\d{2,4}[A-Z]?)(?![A-Z0-9號樓層室座期舖鋪])(?!\s*[A-Z' ]{0,30}\b(?:ROAD|STREET|LANE|AVENUE|PATH|DRIVE|SQUARE|TERRACE|RD|ST)\b)/g, "$1$2室");
  return t;
}

/** 比對用 canonical：形近字歸一＋大寫＋單位詞歸一＋標點／空白（中文字旁邊嘅空白刪走，其餘折疊成單一空格）。 */
function canonOf(clean: string, fold = true): string {
  let t = convertUnitWords((fold ? foldVariants(clean) : clean).toUpperCase(), fold);
  t = t.replace(/[\s,，、;；.．。·]+/g, " ");
  t = t.replace(/\s+(?=\p{Script=Han})|(?<=\p{Script=Han})\s+/gu, "");
  return t.trim();
}

// ---------- 表命中（形近字糾錯）----------
interface KnownName {
  name: string;
  folded: string;
  kind: "estate" | "street" | "district" | "region";
}
const KNOWN: readonly KnownName[] = (() => {
  const l: KnownName[] = [];
  const add = (names: readonly string[], kind: KnownName["kind"]) => {
    for (const name of names) if ([...name].length >= 2) l.push({ name, folded: foldVariants(name), kind });
  };
  add(HK_ESTATES, "estate");
  add(EXTRA_ESTATES, "estate");
  add(MAJOR_STREETS, "street");
  add(HK_REGIONS, "region");
  for (const d of HK_DISTRICTS) {
    add([d.zh, d.zh.replace(/區$/, ""), ...d.areas], "district");
  }
  // 長名先（同位置取最長）
  return l.sort((a, b) => [...b.name].length - [...a.name].length);
})();

const CAND_KNOWN = (() => {
  // 候選版（含易混字 角↔咀）：只喺 canon 版冇命中時用
  return KNOWN.map((k) => ({ ...k, cfolded: mapChars(k.name, CAND_FOLD) }));
})();

/** 喺 clean 入面搵形近字寫法嘅已知名稱；回傳 edits（按 index 升序、冇重疊）。 */
function findEdits(clean: string): AddressEdit[] {
  const foldedText = foldVariants(clean);
  const candText = mapChars(clean, CAND_FOLD);
  const taken: boolean[] = new Array<boolean>(clean.length).fill(false);
  const edits: AddressEdit[] = [];
  const claim = (i: number, n: number) => {
    for (let k = i; k < i + n; k++) taken[k] = true;
  };
  const free = (i: number, n: number) => {
    for (let k = i; k < i + n; k++) if (taken[k]) return false;
    return true;
  };
  // 字元長度（BMP 地址字 1 code unit；補充平面字罕見，直接按 code unit 比對）
  for (const k of KNOWN) {
    let from = 0;
    for (;;) {
      const i = foldedText.indexOf(k.folded, from);
      if (i < 0) break;
      from = i + 1;
      const n = k.folded.length;
      if (!free(i, n)) continue;
      const seg = clean.slice(i, i + n);
      if (seg === k.name) {
        claim(i, n); // 寫法已啱，佔位避免短名重複命中
        continue;
      }
      claim(i, n);
      edits.push({ from: seg, to: k.name, reason: "variant_char", index: i });
    }
  }
  // 易混字候選（旺角／尖沙咀）：只對仍未被佔用、而且原文唔等於表內寫法嘅位置
  for (const k of CAND_KNOWN) {
    if (!/[咀角]/.test(k.name)) continue; // 冇易混字，canon 版已處理
    let from = 0;
    for (;;) {
      const i = candText.indexOf(k.cfolded, from);
      if (i < 0) break;
      from = i + 1;
      const n = k.cfolded.length;
      if (!free(i, n)) continue;
      const seg = clean.slice(i, i + n);
      if (seg === k.name) {
        claim(i, n);
        continue;
      }
      claim(i, n);
      edits.push({ from: seg, to: k.name, reason: "candidate_only", index: i });
    }
  }
  return edits.sort((a, b) => a.index - b.index);
}

function applyEdits(clean: string, edits: readonly AddressEdit[]): string {
  let out = "";
  let pos = 0;
  for (const e of edits) {
    out += clean.slice(pos, e.index) + e.to;
    pos = e.index + e.from.length;
  }
  return out + clean.slice(pos);
}

// ---------- parts 抽取 ----------
const ZH = "\\p{Script=Han}";

/** 喺 text 入面按 re 取第一個匹配，回傳 [匹配, 剔走後嘅文字]；冇＝[null, text]。 */
function takeFirst(text: string, re: RegExp): [RegExpExecArray | null, string] {
  const m = re.exec(text);
  if (!m) return [null, text];
  return [m, `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`];
}
/** 取走全部匹配，回傳 [匹配陣列, 剔走後嘅文字]。 */
function takeAll(text: string, re: RegExp): [string[], string] {
  const got: string[] = [];
  const out = text.replace(re, (m) => {
    got.push(m);
    return " ";
  });
  return [got, out];
}

const FLOOR_RES: RegExp[] = [
  /(?:[A-Z]{0,2}\d+(?:-\d+)?[A-Z]?)(?:字)?樓/g, // 15樓、5-8樓、12字樓、1A樓（字尾 樓 ＝ 已由 convertUnitWords 由 F 轉成）
  /[一二三四五六七八九十]+(?:字)?樓/g,
  /[A-Z]樓/g,
  /(?:地下|閣樓|天台|平台|[高中低頂]層|\d+層)/g,
];
const UNIT_RES: RegExp[] = [
  /(?:[A-Z]?\d+[A-Z]?|[A-Z]|[甲乙丙丁戊己庚辛])(?:-[A-Z0-9]+)?室/g, // 1203室、A室、5B室、1-3室
  /\d+[A-Z]?(?:號)?[舖鋪]/g, // 5舖、10號舖
  /(?:[A-Z]?\d+[A-Z]?|[A-Z])單位/g,
  /單位\s*[A-Z0-9]+/g,
  // 單獨 12A 呢類（數字＋字母、冇任何單位詞）：寧願當單位剔走；後面跟英文街名（12A Nathan Road）就係門牌，唔剔
  /(?<![0-9A-Z-])\d{1,3}[A-Z](?![0-9A-Z號樓層室座期舖鋪])(?!\s*[A-Z' ]{0,30}\b(?:ROAD|STREET|LANE|AVENUE|PATH|DRIVE|SQUARE|TERRACE|RD|ST)\b)/g,
];

const ESTATE_GENERIC = new RegExp(`${ZH}{1,6}?(?:${ESTATE_SUFFIXES.join("|")})`, "u");
const STREET_GENERIC = new RegExp(`${ZH}{1,6}?(?:${STREET_SUFFIXES.map((x) => (x === "圍" ? "圍(?![道街路里徑巷])" : x)).join("|")})(?:[東南西北中](?:段)?)?`, "u");
const BUILDING_GENERIC = new RegExp(`${ZH}{1,8}?(?:${BUILDING_SUFFIXES.join("|")})`, "u");

/** 抽成分。src＝已套用 edits 嘅文字（保留大小寫唔重要，內部轉大寫）。 */
function extractParts(srcRaw: string): HkAddressParts {
  const parts: HkAddressParts = {};
  let text = convertUnitWords(srcRaw.toUpperCase()).replace(/[,，、;；]+/g, " ");

  // 1) unit（先於 floor：5B室 之類）
  const units: string[] = [];
  for (const re of UNIT_RES) {
    const [got, rest] = takeAll(text, re);
    units.push(...got);
    text = rest;
  }
  if (units.length) parts.unit = units.join(" ");
  // 2) floor
  const floors: string[] = [];
  for (const re of FLOOR_RES) {
    const [got, rest] = takeAll(text, re);
    floors.push(...got);
    text = rest;
  }
  if (floors.length) parts.floor = floors.join(" ");
  // 3) block（第X座／X座）
  {
    const [m, rest] = takeFirst(text, /第?([A-Z0-9甲乙丙丁]+)座/);
    if (m) {
      parts.block = `${m[1]}座`;
      text = rest;
    }
  }
  // 4) phase
  {
    const [m, rest] = takeFirst(text, /第?([0-9]+|[IVX]+)期/);
    if (m) {
      parts.phase = `${m[1]}期`;
      text = rest;
    }
  }
  // 5) number（x號／No. x；範圍 15-17號）
  {
    const [m, rest] = takeFirst(text, /(?:NO\.?\s*)?(\d+[A-Z]?(?:\s*-\s*\d+[A-Z]?)?)\s*號/);
    if (m) {
      parts.number = `${m[1]!.replace(/\s+/g, "")}號`;
      text = rest;
    }
  }
  // 6) 已知屋邨（精確）
  for (const name of [...HK_ESTATES, ...EXTRA_ESTATES].sort((a, b) => b.length - a.length)) {
    const i = text.indexOf(name);
    if (i >= 0) {
      parts.estate = name;
      text = `${text.slice(0, i)} ${text.slice(i + name.length)}`;
      break;
    }
  }
  text = text.trim();
  // 7) 地區（開頭，可連續：九龍 深水埗 …）
  {
    const names = KNOWN.filter((k) => k.kind === "district" || k.kind === "region").map((k) => k.name);
    const got: string[] = [];
    let rest = text.replace(/^\s+/, "");
    for (let guard = 0; guard < 4; guard++) {
      // 地名後面緊接街道／屋邨後綴字＝其實係街名／屋邨名嘅一部分（例如「青山道」），唔當地區
      const hit = names.find((n) => rest.startsWith(n) && !/^[道街路里徑巷坊圍橋邨苑]/.test(rest.slice(n.length)) && !MAJOR_STREETS.some((st) => rest.startsWith(st)));
      if (!hit) break;
      got.push(hit);
      rest = rest.slice(hit.length).replace(/^\s+/, "");
    }
    if (got.length) {
      parts.district = got.join("");
      text = rest;
    }
  }
  // 英文地區（任何位置）
  if (!parts.district) {
    for (const d of HK_DISTRICTS) {
      const en = d.en.toUpperCase();
      if (new RegExp(`\\b${en.replace(/ /g, "\\s+")}\\b`).test(text)) {
        parts.district = d.zh;
        break;
      }
    }
  }
  // 8) 屋邨（未知名稱：xx邨／苑…）
  if (!parts.estate) {
    const [m, rest] = takeFirst(text, ESTATE_GENERIC);
    if (m) {
      parts.estate = m[0];
      text = rest;
    } else {
      const [e, rest2] = takeFirst(text, /([A-Z][A-Z' ]*?\s(?:ESTATE|COURT|GARDENS?|VILLAS?|MANSIONS?))\b/);
      if (e) {
        parts.estate = e[1]!.trim();
        text = rest2;
      }
    }
  }
  // 9) 街道（已知表優先，再 regex；英文 No. x Xxx Road）
  {
    const known = MAJOR_STREETS.slice().sort((a, b) => b.length - a.length).find((s) => text.includes(s));
    if (known) {
      parts.street = known;
      const i = text.indexOf(known);
      text = `${text.slice(0, i)} ${text.slice(i + known.length)}`;
    } else {
      const [m, rest] = takeFirst(text, STREET_GENERIC);
      if (m) {
        parts.street = m[0];
        text = rest;
      } else {
        const [e, rest2] = takeFirst(text, /(?:(\d+[A-Z]?(?:-\d+[A-Z]?)?)\s+)?([A-Z][A-Z' ]*?\s(?:ROAD|STREET|LANE|AVENUE|PATH|DRIVE|SQUARE|TERRACE|ROW|BRIDGE|RD|ST))\b/);
        if (e) {
          parts.street = e[2]!.trim();
          if (e[1] && !parts.number) parts.number = e[1];
          text = rest2;
        }
      }
    }
  }
  // 10) 大廈／建築物
  {
    const [m, rest] = takeFirst(text, BUILDING_GENERIC);
    if (m) {
      parts.building = m[0];
      text = rest;
    } else {
      const [e] = takeFirst(text, /([A-Z][A-Z' ]*?\s(?:BUILDING|CENTRE|CENTER|TOWER|PLAZA|HOUSE|MANSION))\b/);
      if (e) parts.building = e[1]!.trim();
    }
  }
  return parts;
}

/** 正規化香港地址。純函數。 */
export function normalizeHkAddress(raw: string): HkAddressResult {
  const display = cleanAddr(raw);
  const edits = findEdits(display);
  const suggested = applyEdits(display, edits);
  return { display, canon: canonOf(display), strict: canonOf(display, false), suggested, edits, parts: extractParts(suggested) };
}

// ---------- ALS 外送：只准地區／街道／門牌／屋邨／座／大廈，樓層室號絕不外送 ----------
/** 樓層／室號 pattern（assert 用）：中文 樓／層／室／舖／單位／字樓、英文 Flat／Room／Rm／Unit／Shop／Floor、15/F、15F、G/F。 */
const FLOOR_UNIT_PATTERN = /樓|层|層|室|舖|鋪|單位|单位|[\s\d](?:\/\s*)?F(?![A-Za-z])|\/F|\bFLAT\b|\bFLT\b|\bROOMS?\b|\bRM\b|\bUNIT\b|\bSHOP\b|\bFLOORS?\b|\bFL\b|\bG\/F\b|地下|閣樓|天台/i;

/** 部件有冇含樓層／室號字眼（含 building 名「xx樓」）。 */
export const hasFloorUnitText = (s: string): boolean => FLOOR_UNIT_PATTERN.test(s) || /^\d+F$/i.test(s.trim());

/**
 * 由 parts 砌 ALS 查詢字串：district＋street＋number＋estate＋block＋building。
 * 老闆鐵則：永遠唔含 floor／unit；任何部件如果仲含樓層／室號字眼（例如大廈名「xx樓」）就整個部件唔送。
 * 太少資訊（冇 street／estate／building）→ null（唔查詢）。最終字串再 assert 一次，唔過 → null。
 */
export function alsQueryFromParts(p: HkAddressParts): string | null {
  const safe = (s: string | undefined): string => (s && !hasFloorUnitText(s) ? s : "");
  if (!safe(p.street) && !safe(p.estate) && !safe(p.building)) return null;
  // 中文：街名＋「999號」；英文：「999 TEST ROAD」（門牌喺街名前）
  const num = safe(p.street) ? safe(p.number) : "";
  const enNum = !!num && !/號/.test(num);
  const q = [safe(p.district), ...(enNum ? [num, safe(p.street)] : [safe(p.street), num]), safe(p.estate), safe(p.block), safe(p.building)].filter(Boolean).join(" ").trim();
  if (!q || q.length > 200 || hasFloorUnitText(q)) return null;
  return q;
}

/** 形近／簡繁變體字個數（只計 canon 歸一表入面嘅變體字）：越少越似標準寫法（候選排序用）。 */
export function variantCharCount(s: string): number {
  let n = 0;
  for (const ch of s) if (CANON_FOLD.has(ch)) n += 1;
  return n;
}

/** 本地拼返標準地址：<district?><street><number><estate><block><building><floor><unit>（中文慣例；floor／unit 係本地保留嘅，唔經 ALS）。 */
export function composeAddressZh(c: { district?: string; street?: string; number?: string; estate?: string; block?: string; building?: string }, local: Pick<HkAddressParts, "floor" | "unit">): string {
  return [c.district, c.street, c.number, c.estate, c.block, c.building, local.floor, local.unit].filter((x): x is string => !!x).map((x) => x.replace(/\s+/g, "")).join("");
}
