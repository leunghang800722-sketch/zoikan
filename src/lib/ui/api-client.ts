// 前端 client component 共用嘅 fetch helper——統一處理 snake_case JSON、
// {error,message} 錯誤形狀、網絡例外。所有寫入一律用相對路徑（瀏覽器自動帶
// cookie），唔使手動處理 session。
export interface ApiListResult<T> {
  rows: T[];
  total: number;
  skip: number;
  take: number;
}

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; message: string };

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
