// WP-PII（老闆 2026-09-17 拍板）：「身份證顯示」規則——列表遮罩
// （`A123***(7)`），詳情／編輯有權先見全號。呢個同 field-group gate
// （src/lib/api/field-groups.ts 嘅 GUARD_PII_FIELDS，管「有冇權見到
// 呢粒欄」）係兩件唔同事：遮罩管嘅係「見到，但唔畀睇晒成個號碼」——
// 就算老闆/會計有「安員個人資料:view」，列表都照樣遮，淨係
// `GET /api/guards/[id]`（單項詳情，同 PATCH 之後嘅 response）先畀睇
// 全號。冇 `hkid` 呢個 key 嘅 row（例如主管/雞頭冇「安員個人資料:view」
// 已經被 field-group gate 剝走成粒欄）原樣跳過，唔會報錯。
//
// WP-PII（Opus 驗收應修 3）：fail-closed——之前「格式意外」一律回原值
// （即係話一個唔跟寬鬆 regex 嘅舊資料/髒資料會喺列表原封不動洩露成個
// 身份證號碼，同「列表一律遮罩」呢個規則直接矛盾）。而家改做：格式啱
// 先砌遮罩版本，格式唔啱一律回 `"***"`（唔畀睇到原值，寧枉勿縱）；
// null/undefined/空字串一律回 null（「冇資料」本身唔算敏感，唔使遮）。
const HKID_MASK_RE = /^([A-Za-z]{1,2})([0-9]{3})[0-9]{3}(\([0-9Aa]\))$/;

export function maskHkid(hkid: unknown): unknown {
  if (hkid === null || hkid === undefined) return null;
  if (typeof hkid !== "string") return "***"; // 唔係字串（型別意外）：fail-closed
  const trimmed = hkid.trim();
  if (trimmed === "") return null;
  const m = trimmed.match(HKID_MASK_RE);
  if (!m) return "***"; // 格式意外（例如舊資料唔跟寬鬆 regex）：fail-closed，唔畀睇到原值
  return `${m[1]}${m[2]}***${m[3]}`;
}

/** 列表（`GET /api/guards`）用：逐行將 `hkid`（如果呢粒欄有喺 row 度）
 * 換做遮罩版本。淨係換值，唔改 key 存在與否——field-group gate 已經
 * 決定咗邊行有冇 `hkid` 呢個 key。 */
export function maskHkidForList<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((r) => (Object.prototype.hasOwnProperty.call(r, "hkid") ? { ...r, hkid: maskHkid(r.hkid) } : r));
}
