"use client";
import { apiGetAll, type ApiResult, type ApiListResult } from "./api-client";
import { cachedLookup } from "./lookup-cache";
import { ApiClientError } from "../api-client";


/** 逐頁拉齊全部行，並按 path 記憶 60 s；失敗回傳 ApiResult（唔記）。 */
export function cachedGetAll<T>(path: string): Promise<ApiResult<ApiListResult<T>>> {
  return cachedLookup(`all:${path}`, async () => {
    const res = await apiGetAll<T>(path);
    if (!res.ok) throw res;
    return res;
  }).catch((e: unknown) => {
    if (e && typeof e === "object" && "ok" in e) return e as ApiResult<ApiListResult<T>>;
    return { ok: false, status: 0, error: "error", message: e instanceof Error ? e.message : "讀取失敗" } as ApiResult<ApiListResult<T>>;
  });
}

/** 經共用 `cachedGetAll`（同 useLookups／各頁同一個 key＋同一個 ApiResult 形狀）攞全部行；失敗拋 ApiClientError。
 * 更表編輯器（用另一個會 throw 嘅 api-client）用呢個，唔好另開 key 形狀。 */
export async function cachedRows<T>(path: string): Promise<T[]> {
  const res = await cachedGetAll<T>(path);
  if (!res.ok) throw new ApiClientError(res.status, res.message, res.error);
  return res.data.rows;
}
