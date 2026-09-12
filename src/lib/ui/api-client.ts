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
