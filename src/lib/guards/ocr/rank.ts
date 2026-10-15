// WP-OCR-4：候選排序（路徑 A reconcile 同路徑 B resolveField 共用）。純函數。
// 分數＝格式驗證基礎分（0–100）＋多讀一致加權＋仲裁加權；相同分數時 confidence high 優先，再按輸入次序（讀 A 優先）。
import { normalizeField, type Normalized } from "./normalize";
import type { OcrFieldKey } from "./config";
import type { ReadConfidence } from "./field-read";

/** 候選池上限 */
const MAX_CANDIDATES = 4;
/** 每多一個獨立讀數同意加幾多分 */
const AGREE_BONUS = 5;
/** 仲裁讀數入池嘅加權 */
const ARBITER_BONUS = 3;

export interface RankInput {
  value: string;
  /** 來源標籤：a／b／arbiter（主讀數）；後綴 `_alt`＝該讀數嘅 alternatives、`_grid`＝電話分格線剔走 1 嘅推算候選（confidence 都當最低） */
  source: string;
  confidence?: ReadConfidence;
}
export interface RankedCandidate {
  value: string;
  sources: string[];
  score: number;
  /** 格式驗證結果：valid｜invalid 原因碼（唔含值） */
  reason: string;
}

const CONF_RANK: Record<ReadConfidence, number> = { high: 3, medium: 2, low: 1 };
/** 冇寫 confidence（舊格式）當 medium；alternatives 永遠最低 */
const confRank = (i: RankInput): number => (/_(alt|grid)$/.test(i.source) ? 0 : i.confidence ? CONF_RANK[i.confidence] : 2);

const BASE_BY_REASON: Record<string, number> = {
  hkid_check_digit: 40,
  hkid_format: 5,
  dob_year_implausible: 40,
  dob_calendar: 5,
  phone_not_hk: 30,
  phone_gridline_suspect: 20,
  phone_format: 5,
  simplified_chars: 60,
  name_zh_format: 5,
  name_en_format: 5,
  sex_format: 0,
  address_format: 10,
};

/** 單一候選嘅格式驗證基礎分：valid＝100（地址另按長度／中文字／門牌標記分層）；invalid 按原因碼。 */
function validityScore(key: OcrFieldKey, n: Normalized): number {
  if (!n.valid) return BASE_BY_REASON[n.reason ?? ""] ?? 10;
  if (key !== "address") return 100;
  return 70 + (/\p{Script=Han}/u.test(n.canon) ? 10 : 0) + (/[0-9]/.test(n.canon) && /[樓室座號鋪舖層]|\/F|FLAT|ROOM|RM |BLOCK/.test(n.canon) ? 10 : 0);
}

const readOf = (source: string) => source.replace(/_(alt|grid)$/, "");

/** 通用排序核心：按 canon 合併同值、算分、排序、截 4。scoreOf 回 { canon, display, base, reason }。 */
export function rankPool(inputs: readonly RankInput[], scoreOf: (value: string) => { canon: string; display: string; base: number; reason: string }): RankedCandidate[] {
  const groups = new Map<string, { display: string; base: number; reason: string; inputs: RankInput[]; first: number }>();
  inputs.forEach((inp, idx) => {
    const s = scoreOf(inp.value);
    if (!s.canon) return;
    const g = groups.get(s.canon);
    if (g) g.inputs.push(inp);
    else groups.set(s.canon, { display: s.display, base: s.base, reason: s.reason, inputs: [inp], first: idx });
  });
  const rows = [...groups.values()].map((g) => {
    const reads = new Set(g.inputs.map((i) => readOf(i.source)));
    const score = g.base + AGREE_BONUS * (reads.size - 1) + (reads.has("arbiter") ? ARBITER_BONUS : 0);
    return { g, score, conf: Math.max(...g.inputs.map(confRank)) };
  });
  rows.sort((x, y) => y.score - x.score || y.conf - x.conf || x.g.first - y.g.first);
  return rows.slice(0, MAX_CANDIDATES).map(({ g, score }) => ({ value: g.display, sources: [...new Set(g.inputs.map((i) => i.source))], score, reason: g.reason }));
}

/** 路徑 A：按欄位格式驗證（HKID check digit、電話、日期曆法＋年齡、地址長度／中文字…）排序。 */
export function rankFieldCandidates(key: OcrFieldKey, inputs: readonly RankInput[], now: Date = new Date()): RankedCandidate[] {
  return rankPool(inputs, (value) => {
    const n = normalizeField(key, value, now);
    return { canon: n.canon, display: n.display, base: validityScore(key, n), reason: n.valid ? "valid" : (n.reason ?? "invalid_format") };
  });
}
