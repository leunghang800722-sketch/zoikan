// WP-OCR-2：香港政府 ALS（Address Lookup Service，https://www.als.gov.hk）客戶端（server-only）。
// 規格：GET /lookup?q=<percent-encoded>&n=3；Accept: application/json；Accept-Language: zh-Hant；
//   唔傳 3d／floor／unit 參數；狀態碼 400／406／413／429／500。見 ALS data dictionary。
//
// 老闆鐵則：送出去嘅 q 只可以有 地區／街道／門牌／屋邨／座／大廈，樓層、室號絕不外送（alsQueryFromParts 剔走＋assert）；
//   永遠唔送姓名、電話或其他欄位。查詢字串唔寫 log／audit／DB／error message（失敗一律靜靜略過，只計 als_failed）。
// 每份文件最多 1 次查詢；timeout 3 秒；`GUARD_OCR_ALS=0` 完全唔呼叫。
import { OCR_ALS_MIN_SCORE, OCR_ALS_TIMEOUT_MS } from "./config";
import { alsQueryFromParts, composeAddressZh, hasFloorUnitText, normalizeHkAddress, type HkAddressParts } from "./hk-address";

const ALS_URL = "https://www.als.gov.hk/lookup";

/** ALS 回傳嘅單條建議（只取中文結構化成分＋Score）。 */
export interface AlsHit {
  score: number;
  district?: string;
  street?: string;
  number?: string;
  estate?: string;
  block?: string;
  building?: string;
}
/** 查詢函數（可注入 fake）：q 係已剔走樓層室號嘅字串；失敗拋任何錯。 */
export type AlsLookup = (q: string) => Promise<AlsHit[]>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** 解析 ALS JSON（寬鬆、防禦）：SuggestedAddress[] → AlsHit[]。 */
export function parseAlsResponse(json: unknown): AlsHit[] {
  const root = rec(json);
  const lookup = rec(root?.AddressLookupResult) ?? root;
  const raw = lookup?.SuggestedAddress;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: AlsHit[] = [];
  for (const it of list) {
    const e = rec(it);
    const chi = rec(rec(rec(e?.Address)?.PremisesAddress)?.ChiPremisesAddress);
    if (!chi) continue;
    const scoreRaw = rec(e?.ValidationInformation)?.Score;
    const score = typeof scoreRaw === "number" ? scoreRaw : typeof scoreRaw === "string" ? Number(scoreRaw) : NaN;
    if (!Number.isFinite(score)) continue;
    const street = rec(chi.ChiStreet);
    const from = str(street?.BuildingNoFrom);
    const to = str(street?.BuildingNoTo);
    const block = rec(chi.ChiBlock);
    const desc = str(block?.BlockDescriptor);
    const no = str(block?.BlockNo);
    out.push({
      score,
      ...(str(rec(chi.ChiDistrict)?.DcDistrict) ? { district: str(rec(chi.ChiDistrict)?.DcDistrict)! } : {}),
      ...(str(street?.StreetName) ? { street: str(street?.StreetName)! } : {}),
      ...(from ? { number: `${from}${to && to !== from ? `-${to}` : ""}號` } : {}),
      ...(str(rec(chi.ChiEstate)?.EstateName) ? { estate: str(rec(chi.ChiEstate)?.EstateName)! } : {}),
      ...(no || desc ? { block: desc === "座" || desc === "閣" || desc === "樓" ? `${no ?? ""}${desc}` : `${desc ?? ""}${no ?? ""}` } : {}),
      ...(str(chi.BuildingName) ? { building: str(chi.BuildingName)! } : {}),
    });
  }
  return out;
}

/** 真 ALS 查詢（Node 原生 fetch）。非 200／逾時／網絡錯誤一律拋（caller 靜靜略過）；錯誤唔帶 q。 */
export const fetchAls: AlsLookup = async (q) => {
  if (hasFloorUnitText(q)) throw new Error("als_q_has_floor_unit"); // 最後防線（正常唔會去到呢度）
  const res = await fetch(`${ALS_URL}?q=${encodeURIComponent(q)}&n=3`, {
    method: "GET",
    headers: { Accept: "application/json", "Accept-Language": "zh-Hant" },
    signal: AbortSignal.timeout(OCR_ALS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`als_status_${res.status}`);
  return parseAlsResponse(await res.json());
};

// 測試注入點（vitest／eval --dry 用 fake；真環境冇 override 就用 fetchAls）
let alsOverride: AlsLookup | undefined;
export function setAlsOverride(fn: AlsLookup | undefined): void {
  alsOverride = fn;
}
export function getAlsOverride(): AlsLookup | undefined {
  return alsOverride;
}

export type AlsOutcome =
  | { status: "candidate"; value: string; score: number }
  | { status: "none" } // 冇 query（資訊太少）／冇結果／Score 太低
  | { status: "failed" };

/**
 * 由一個讀到嘅地址（原讀數）查 ALS：剔走 floor／unit → 查詢 → 取最高分（≥ 60）→ 本地拼返 floor／unit 作標準地址候選。
 * 永遠唔拋錯；唔 log 任何查詢內容。
 */
export async function lookupAlsCandidate(addressText: string, lookup: AlsLookup): Promise<AlsOutcome & { called: boolean }> {
  const parts: HkAddressParts = normalizeHkAddress(addressText).parts;
  const q = alsQueryFromParts(parts);
  if (!q || hasFloorUnitText(q)) return { status: "none", called: false };
  try {
    // 注入嘅 lookup 都要受 3 秒上限（真 fetch 自帶 AbortSignal；fake 靠呢度）
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hits = await Promise.race([lookup(q), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("als_timeout")), OCR_ALS_TIMEOUT_MS); })]).finally(() => clearTimeout(timer));
    const best = hits.filter((h) => h.score >= OCR_ALS_MIN_SCORE).sort((a, b) => b.score - a.score)[0];
    if (!best) return { status: "none", called: true };
    const value = composeAddressZh(best, { floor: parts.floor, unit: parts.unit });
    if (!value) return { status: "none", called: true };
    return { status: "candidate", value, score: best.score, called: true };
  } catch {
    return { status: "failed", called: true };
  }
}
