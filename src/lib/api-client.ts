// 共用 fetch helper——畫面 client component 用嚟打現成 API（P1-WP3 更表
// 編輯器率先用到，其他畫面有需要都可以共用）。Request/response body 一律
// snake_case（同 docs/api.md「欄位命名」一致），呢度唔做 camelCase 轉換，
// 淨係負責 fetch/分頁/錯誤形狀。相對路徑 fetch 喺瀏覽器會自動帶埋
// same-origin cookie，唔使加 credentials:"include"。
"use client";

export class ApiClientError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

// 2026-09-13 安全網：每個 request 45 秒逾時（唔准無限轉圈）；401 即刻跳返登入頁。
const REQUEST_TIMEOUT_MS = 45_000;
async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw new ApiClientError(0, `請求逾時（${REQUEST_TIMEOUT_MS / 1000} 秒）：${input.split("?")[0]}`, "timeout");
    throw new ApiClientError(0, `網絡錯誤：${input.split("?")[0]}`, "network");
  } finally {
    clearTimeout(timer);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401 && typeof window !== "undefined") {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/login?next=${next}`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 冇 body（例如 204）——留 null。
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    throw new ApiClientError(res.status, b.message ?? `HTTP ${res.status}`, b.error);
  }
  return body as T;
}

export type ListResponse<T> = { rows: T[]; total: number; skip: number; take: number };

export async function apiGet<T>(
  path: string,
  params?: Record<string, string | number | undefined | null>,
): Promise<T> {
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
  }
  const query = qs.toString();
  const res = await fetchWithTimeout(query ? `${path}?${query}` : path, { method: "GET" });
  return handle<T>(res);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handle<T>(res);
}

/**
 * 攞晒一個 list endpoint 嘅全部 rows，自動跟 `total`/`skip` 分頁攞到晒
 * （單次 request 上限 500，一個月一個盤可能多過 500 行）。
 */
export async function apiGetAll<T>(
  path: string,
  params: Record<string, string | number | undefined | null>,
  pageSize = 500,
): Promise<T[]> {
  const out: T[] = [];
  // skip 按頁（pageSize）前進，唔按已收 rows 數（server 可能喺分頁後剔行，見 ui/api-client.ts）。
  for (let skip = 0; ; skip += pageSize) {
    const page = await apiGet<ListResponse<T>>(path, { ...params, skip, take: pageSize });
    out.push(...page.rows);
    if (page.rows.length === 0 || skip + pageSize >= page.total) break;
  }
  return out;
}
