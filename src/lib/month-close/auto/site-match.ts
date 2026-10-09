// WP-ONE-CLICK-AUTO（§31.3 A）：盤名比對——純函數，零 DB 依賴。
//
// 信心分級（照 §31.3 A）：
//   exact   正規化（NFKC、去空白／標點／括號、全半形、常見後綴）之後同現有
//           canonical／alias 完全相同（只有一個盤）→ 直接對上，加 alias。
//   auto    相似度（Jaro-Winkler）≥ AUTO_MIN，而且「分辨字」（數字／英文字母／
//           中文數字／方位字）完全相同，而且編輯距離 ≤ 1（長名 ≤ 2），而且
//           第二候選低 ≥ MARGIN → 自動加 alias。
//   propose 有候選但唔夠硬（相似度 PROPOSE_MIN～AUTO_MIN、編輯距離過大、
//           第二候選太近、exact 撞兩個盤）→ 分診題預填建議答案。
//   new     其餘（包括分辨字唔同——CP1-4 vs CP5、厚A vs 厚B、Weave OL vs
//           Weave Robinson——永遠唔自動合併，亦唔當 propose）→ 新盤。
//
// 「城巴各車廠」呢類冇數字／字母、只靠地名分辨嘅盤：編輯距離 ≤ 1 嘅硬閘令
// 「柴灣城巴車廠」「上環城巴車廠」呢類差兩個字嘅唔會被自動合併。
export const SITE_AUTO_MIN = 0.9;
export const SITE_PROPOSE_MIN = 0.75;
export const SITE_MARGIN = 0.08;
export const SITE_PROPOSE_MAX_EDIT_RATIO = 0.34;

const SUFFIXES = ["有限公司", "物業服務", "物業管理", "管理處", "公司", "管理", "物業"];
const CJK_NUMERALS = "〇零一二三四五六七八九十百";
const DIRECTION_CHARS = "東西南北上下中前後內外";

/** 異體／繁簡對照（細表，自己維護）：左邊嘅字當右邊（正體常用字）。淨係呢啲字先可以當「相同」；
 * 其餘中文字唔同一律唔准 auto（東涌／東區、景湖居／樂湖居、領峯／領都 都係真係唔同嘅盤）。 */
const VARIANT_PAIRS: Array<[string, string]> = [
  ["臺", "台"], ["裏", "裡"], ["峯", "峰"], ["邨", "村"], ["廠", "厰"], ["樓", "楼"], ["灣", "湾"], ["區", "区"], ["龍", "龙"],
  ["園", "园"], ["國", "国"], ["廈", "厦"], ["門", "门"], ["東", "东"], ["馬", "马"], ["場", "场"], ["務", "务"], ["業", "业"],
  ["學", "学"], ["醫", "医"], ["體", "体"], ["與", "与"], ["會", "会"], ["華", "华"], ["興", "兴"], ["順", "顺"], ["環", "环"],
];
const VARIANT_MAP = new Map<string, string>(VARIANT_PAIRS.flatMap(([a, b]) => [[b, a], [a, a]] as Array<[string, string]>));
export function canonVariants(s: string): string {
  return [...s].map((c) => VARIANT_MAP.get(c) ?? c).join("");
}
/** 淨剩中文字（變體歸一之後）——兩個盤名中文字序列唔同就唔准 auto。 */
export function cjkSequence(s: string): string {
  return canonVariants(s.normalize("NFKC")).replace(/[^\p{Script=Han}]+/gu, "");
}

/** NFKC、細楷、去晒非字母數字（空白／標點／括號符號）、異體字歸一。括號入面嘅內容保留。 */
export function normalizeSiteKey(raw: string): string {
  return canonVariants(
    raw
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ""),
  );
}

/** 去常見後綴（重複，淨係剩 ≥2 個字先剝）。 */
export function stripSiteSuffix(key: string): string {
  let cur = key;
  for (let guard = 0; guard < 4; guard++) {
    let changed = false;
    for (const suf of SUFFIXES) {
      if (cur.endsWith(suf) && cur.length - suf.length >= 2) {
        cur = cur.slice(0, cur.length - suf.length);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return cur;
}

/** 分辨字：英文字母連續段、數字連續段、中文數字、方位字——兩個盤名呢啲唔同，
 * 就一定唔係同一個盤（CP1-4／CP5、厚A／厚B、OL／Robinson、第一期／第二期、東／西）。 */
export function distinguishingTokens(raw: string): string[] {
  const s = canonVariants(raw.normalize("NFKC").toLowerCase());
  const out: string[] = [];
  for (const m of s.matchAll(/[a-z]+|\d+/g)) out.push(m[0]);
  for (const ch of s) {
    if (CJK_NUMERALS.includes(ch) || DIRECTION_CHARS.includes(ch)) out.push(ch);
  }
  return out.sort();
}

export function sameTokens(a: string, b: string): boolean {
  const ta = distinguishingTokens(a);
  const tb = distinguishingTokens(b);
  return ta.length === tb.length && ta.every((t, i) => t === tb[i]);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const A = [...a];
  const B = [...b];
  if (A.length === 0) return B.length;
  if (B.length === 0) return A.length;
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (A[i - 1] === B[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[B.length]!;
}

export function jaroWinkler(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  if (A.length === 0 && B.length === 0) return 1;
  if (A.length === 0 || B.length === 0) return 0;
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(A.length, B.length) / 2) - 1);
  const aMatched = new Array<boolean>(A.length).fill(false);
  const bMatched = new Array<boolean>(B.length).fill(false);
  let matches = 0;
  for (let i = 0; i < A.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(B.length - 1, i + range);
    for (let j = lo; j <= hi; j++) {
      if (!bMatched[j] && A[i] === B[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < A.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (A[i] !== B[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / A.length + m / B.length + (m - t / 2) / m) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, A.length, B.length); i++) {
    if (A[i] === B[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export interface SiteNameCandidate {
  id: string;
  canonicalName: string;
  aliases: string[];
}

export type SiteMatchLevel = "exact" | "auto" | "propose" | "new";

export interface SiteMatchResult {
  level: SiteMatchLevel;
  /** exact／auto：對上嗰個盤；propose：最佳候選（預填建議）；new：null。 */
  siteId: string | null;
  score: number;
  second: number;
  reason: string;
  /** propose 用：最多 3 個候選（高→低）。 */
  candidates: Array<{ siteId: string; score: number }>;
  /** new 但係有相似盤名（分辨字唔同）——報告講一句「似 X 但數字／字母唔同，當新盤」。 */
  lookalikeSiteIds: string[];
}

interface Scored {
  siteId: string;
  score: number;
  exact: boolean;
  tokensEqual: boolean;
  cjkEqual: boolean;
  edit: number;
  keyLen: number;
}

function scoreAgainst(rawKey: string, rawStripped: string, rawName: string, site: SiteNameCandidate): Scored {
  let best: Scored = { siteId: site.id, score: 0, exact: false, tokensEqual: false, cjkEqual: false, edit: 99, keyLen: rawKey.length };
  for (const name of [site.canonicalName, ...site.aliases]) {
    const k = normalizeSiteKey(name);
    if (!k) continue;
    const ks = stripSiteSuffix(k);
    const exact = k === rawKey || ks === rawStripped || k === rawStripped || ks === rawKey;
    const score = exact ? 1 : jaroWinkler(rawKey, k);
    const tokensEqual = sameTokens(rawName, name);
    const cjkEqual = cjkSequence(rawName) === cjkSequence(name);
    const edit = levenshtein(rawKey, k);
    const better = (exact && !best.exact) || (exact === best.exact && score > best.score);
    if (better) best = { siteId: site.id, score, exact, tokensEqual, cjkEqual, edit, keyLen: Math.max(rawKey.length, k.length) };
  }
  return best;
}

export function classifySiteName(rawName: string, sites: readonly SiteNameCandidate[]): SiteMatchResult {
  const key = normalizeSiteKey(rawName);
  const none: SiteMatchResult = { level: "new", siteId: null, score: 0, second: 0, reason: "冇相似盤名", candidates: [], lookalikeSiteIds: [] };
  if (!key) return none;
  const stripped = stripSiteSuffix(key);
  const scored = sites.map((s) => scoreAgainst(key, stripped, rawName, s)).sort((a, b) => b.score - a.score);

  const exacts = scored.filter((s) => s.exact);
  if (exacts.length === 1) return { level: "exact", siteId: exacts[0]!.siteId, score: 1, second: scored.find((s) => s.siteId !== exacts[0]!.siteId)?.score ?? 0, reason: "正規化後同現有盤名／別名完全相同", candidates: [], lookalikeSiteIds: [] };
  if (exacts.length > 1) {
    return { level: "propose", siteId: exacts[0]!.siteId, score: 1, second: 1, reason: "正規化後同多個現有盤名／別名相同，唔肯定係邊個", candidates: exacts.slice(0, 3).map((s) => ({ siteId: s.siteId, score: s.score })), lookalikeSiteIds: [] };
  }

  const best = scored[0];
  if (!best || best.score < SITE_PROPOSE_MIN) return none;
  const second = scored[1]?.score ?? 0;

  // 分辨字唔同（數字／字母／中文數字／方位）——永遠唔自動合併，亦唔當 propose。
  const sameTok = scored.filter((s) => s.score >= SITE_PROPOSE_MIN && s.tokensEqual);
  // 最相似嘅盤分辨字唔同，而且分辨字一致嘅候選明顯低過佢（≥ MARGIN）→ 最似嗰個其實係「另一個盤」，
  // 唔好退而求其次 propose 一個低分候選，當新盤。
  if (!best.tokensEqual) {
    const alt = sameTok[0];
    if (!alt || best.score - alt.score >= SITE_MARGIN) {
      return { ...none, score: best.score, second, reason: "相似但數字／字母唔同，當新盤", lookalikeSiteIds: scored.filter((s) => s.score >= SITE_PROPOSE_MIN).slice(0, 3).map((s) => s.siteId) };
    }
  }
  const top = sameTok[0] ?? best;
  const topSecond = sameTok[1]?.score ?? Math.max(0, ...scored.filter((s) => s.siteId !== top.siteId).map((s) => s.score));
  const maxEdit = top.keyLen >= 12 ? 2 : 1;
  if (top.score >= SITE_AUTO_MIN && top.cjkEqual && top.edit <= maxEdit && top.score - topSecond >= SITE_MARGIN) {
    return { level: "auto", siteId: top.siteId, score: top.score, second: topSecond, reason: `相似度 ${top.score.toFixed(2)}、數字／字母一致、只差 ${top.edit} 個字`, candidates: [], lookalikeSiteIds: [] };
  }
  // propose 都要「差得唔多」：編輯距離唔可以超過名長約三分一（短名同共用前後綴嘅無關盤名，例如「測試海景新」vs「測試娉廷新」，唔建議）。
  const cands = sameTok.filter((s) => s.edit / Math.max(1, s.keyLen) <= SITE_PROPOSE_MAX_EDIT_RATIO).slice(0, 3).map((s) => ({ siteId: s.siteId, score: s.score }));
  if (cands.length === 0) return none;
  const proposeTop = sameTok.find((s) => s.siteId === cands[0]!.siteId) ?? top;
  return {
    level: "propose",
    siteId: proposeTop.siteId,
    score: proposeTop.score,
    second: topSecond,
    reason: top.score >= SITE_AUTO_MIN ? (top.cjkEqual ? "相似度夠高但差異字數多／第二候選太近，唔夠硬" : "中文字有分別（唔係異體字），唔自動合併") : `相似度 ${top.score.toFixed(2)}（0.75–0.90）`,
    candidates: cands,
    lookalikeSiteIds: [],
  };
}
