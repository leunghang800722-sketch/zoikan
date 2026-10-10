// 前端 client component 共用嘅 fetch helper——統一處理 snake_case JSON、
// {error,message} 錯誤形狀、網絡例外。所有寫入一律用相對路徑（瀏覽器自動帶
// cookie），唔使手動處理 session。
import { invalidateLookups, isLookupWritePath } from "./lookup-cache";

export interface ApiListResult<T> {
  rows: T[];
  total: number;
  skip: number;
  take: number;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; message: string };

/** 讀 response body（JSON，讀唔到就當 null）並轉做統一 `ApiResult`；非 2xx 帶 server 嘅 error／message。 */
async function readResult<T>(res: Response): Promise<ApiResult<T>> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const b = (body ?? {}) as Partial<{ error: string; message: string }>;
    return { ok: false, status: res.status, error: b.error ?? "error", message: b.message ?? `請求失敗（HTTP ${res.status}）` };
  }
  return { ok: true, status: res.status, data: body as T };
}

export async function apiRequest<T = unknown>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    return { ok: false, status: 0, error: "network_error", message: "網絡錯誤，請檢查連線後重試" };
  }

  const result = await readResult<T>(res);
  // P3-2.4：寫入參考資料相關資源成功 → 前端參考資料 cache 作廢（見 lookup-cache.ts）。
  if (result.ok && init?.method && init.method !== "GET" && isLookupWritePath(path)) invalidateLookups();
  return result;
}

/**
 * P3-1.9（B-5）：攞某個 list API 嘅**全部**行——逐頁（每頁 `pageSize`，server 上限 500）拉，
 * 直至拉齊 `total`，避免 `?take=500` 超過 500 行時靜靜截斷。`path` 可以已帶 query（例如
 * `/api/brokers?include_inactive=1`），唔好自己加 `take`／`skip`。回傳形狀同單頁 `ApiListResult`
 * 一致（`rows` 係全部、`total` 係 server 回報總數），所以 call site 淨係將 `apiGet(...?take=500)` 換成
 * `apiGetAll(path)`。任何一頁失敗即回傳該錯誤。
 */
export async function apiGetAll<T>(path: string, pageSize = 500): Promise<ApiResult<ApiListResult<T>>> {
  const sep = path.includes("?") ? "&" : "?";
  const rows: T[] = [];
  let total = 0;
  // skip 按「頁」前進（唔係按已收 rows 數）：有啲 list（例如雞頭 session 嘅 DTO 轉換）可能喺分頁之後
  // 再剔走個別行，用 rows.length 做 skip 會重複／錯位拉到後面嘅行。
  for (let skip = 0; ; skip += pageSize) {
    const res = await apiRequest<ApiListResult<T>>(`${path}${sep}skip=${skip}&take=${pageSize}`);
    if (!res.ok) return res;
    rows.push(...res.data.rows);
    total = res.data.total;
    if (res.data.rows.length === 0 || skip + pageSize >= total) break;
  }
  return { ok: true, status: 200, data: { rows, total, skip: 0, take: rows.length } };
}

export function apiGet<T = unknown>(path: string): Promise<ApiResult<T>> {
  return apiRequest<T>(path);
}

export function apiPost<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  return apiRequest<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

export function apiPatch<T = unknown>(path: string, body: unknown): Promise<ApiResult<T>> {
  return apiRequest<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}

// WP-MULTI（老闆 2026-09-19 拍板）：電話／緊急聯絡人／地址三張新子表嘅
// DELETE（更正打錯用）——之前冇任何資源需要真 DELETE（其他資源一律
// void/unvoid 軟刪），呢個先加呢個 helper。
export function apiDelete<T = unknown>(path: string): Promise<ApiResult<T>> {
  return apiRequest<T>(path, { method: "DELETE" });
}

// WP-MULTI（Opus 覆核必修 6）：緊急聯絡人排序端點（`PUT .../emergency-
// contacts/order`）用——第一個需要 PUT 嘅資源。
export function apiPut<T = unknown>(path: string, body: unknown): Promise<ApiResult<T>> {
  return apiRequest<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

// WP-ROSTER-UPLOAD Phase A：multipart/form-data 上載（帶檔案）——唔可以
// 用 `apiRequest()`，佢會強制 `Content-Type: application/json`（FormData
// 要瀏覽器自己加 boundary，手動設 JSON content-type 會令 body 解析唔到）。
export async function apiUpload<T = unknown>(path: string, formData: FormData): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", body: formData });
  } catch {
    return { ok: false, status: 0, error: "network_error", message: "網絡錯誤，請檢查連線後重試" };
  }
  return readResult<T>(res);
}
