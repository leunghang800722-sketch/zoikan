// W0：WAHA（WhatsApp HTTP API）client——server-only，**純唯讀被動**：
//   GET {WAHA_BASE_URL}/api/sessions/{session}   → session 狀態
//   GET {WAHA_BASE_URL}/api/{session}/groups     → 群組列表（只取 id＋名，唔取成員）
// 絕對冇任何發送類 API（鐵律；tests/whatsapp-no-send-api.test.ts 掃描本目錄禁用字串）。
// header X-Api-Key；timeout 5s；失敗一律回結構化錯誤（唔 throw、唔洩漏 key／response body）。
import { wahaApiKey, wahaBaseUrl, wahaSession } from "./config";

const TIMEOUT_MS = 5000;

export type WahaResult<T> = { ok: true; data: T } | { ok: false; error: "not_configured" | "unreachable" | "timeout" | "http_error" | "bad_response"; status?: number };

async function wahaGet(path: string, fetchImpl: typeof fetch): Promise<WahaResult<unknown>> {
  const base = wahaBaseUrl();
  if (!base) return { ok: false, error: "not_configured" };
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = wahaApiKey();
  if (key) headers["X-Api-Key"] = key;
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" };
  }
  if (!res.ok) return { ok: false, error: "http_error", status: res.status };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, error: "bad_response" };
  }
}

export interface WahaSessionStatus {
  session: string;
  /** WORKING｜STARTING｜SCAN_QR_CODE｜STOPPED｜FAILED｜…（照 WAHA 原樣，唔識就 UNKNOWN）。 */
  status: string;
}

export async function getSessionStatus(fetchImpl: typeof fetch = fetch): Promise<WahaResult<WahaSessionStatus>> {
  const session = wahaSession();
  const r = await wahaGet(`/api/sessions/${encodeURIComponent(session)}`, fetchImpl);
  if (!r.ok) return r;
  const st = (r.data as { status?: unknown } | null)?.status;
  return { ok: true, data: { session, status: typeof st === "string" && st ? st : "UNKNOWN" } };
}

export interface WahaGroup {
  jid: string;
  name: string;
}

function jidOf(id: unknown): string | null {
  if (typeof id === "string") return id;
  if (id && typeof id === "object") {
    const s = (id as { _serialized?: unknown })._serialized;
    if (typeof s === "string") return s;
  }
  return null;
}

/** 假設回傳係陣列（亦容忍 { groups: [] }）；每項 id 可係字串或 {_serialized}；名取 name／subject。 */
export function parseGroups(data: unknown): WahaGroup[] {
  const arr = Array.isArray(data) ? data : Array.isArray((data as { groups?: unknown } | null)?.groups) ? ((data as { groups: unknown[] }).groups) : null;
  if (!arr) return [];
  const out: WahaGroup[] = [];
  const seen = new Set<string>();
  for (const g of arr) {
    if (!g || typeof g !== "object") continue;
    const rec = g as Record<string, unknown>;
    const jid = jidOf(rec.id);
    if (!jid || !jid.endsWith("@g.us") || seen.has(jid)) continue;
    seen.add(jid);
    const nm = typeof rec.name === "string" ? rec.name : typeof rec.subject === "string" ? rec.subject : "";
    out.push({ jid, name: nm.slice(0, 200) });
  }
  return out;
}

export async function listGroups(fetchImpl: typeof fetch = fetch): Promise<WahaResult<WahaGroup[]>> {
  const r = await wahaGet(`/api/${encodeURIComponent(wahaSession())}/groups`, fetchImpl);
  if (!r.ok) return r;
  if (!Array.isArray(r.data) && !Array.isArray((r.data as { groups?: unknown } | null)?.groups)) return { ok: false, error: "bad_response" };
  return { ok: true, data: parseGroups(r.data) };
}
