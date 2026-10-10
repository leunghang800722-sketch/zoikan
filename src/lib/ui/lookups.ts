"use client";
// P3-2.4（P3 §3.1 P5）：共用參考資料 hook——sites／brokers／shift-types／輕量 guards。
// 同一分頁內 60 s 記憶（見 lookup-cache.ts），多頁、多個 component 同時要同一份只打一次 API。
import { useEffect, useState } from "react";
import { apiGetAll, type ApiResult, type ApiListResult } from "./api-client";
import { cachedLookup, invalidateLookups } from "./lookup-cache";
import { ApiClientError } from "../api-client";

export { invalidateLookups };

/** 輕量保安員（`GET /api/guards?fields=lite`）——唔帶電話／證件／銀行。 */
export interface GuardLite {
  id: string;
  staff_no?: string | null;
  name_zh: string;
  name_en?: string | null;
  status?: string | null;
  default_broker_id?: string | null;
  default_broker_code?: string | null;
  sia_permit_expiry?: string | null;
  staff_numbers?: Array<{ scheme?: string; number: string; status?: string }> | null;
}

export const LOOKUP_PATHS = {
  sites: "/api/sites",
  brokers: "/api/brokers",
  shiftTypes: "/api/shift-types",
  guardsLite: "/api/guards?fields=lite",
} as const;
export type LookupName = keyof typeof LOOKUP_PATHS;

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

type Want = Partial<Record<LookupName, boolean>>;
interface LookupState<S, B, T> {
  sites: S[];
  brokers: B[];
  shiftTypes: T[];
  guardsLite: GuardLite[];
  loading: boolean;
  error: string | null;
}

export function useLookups<S = { id: string; canonical_name: string }, B = { id: string; code: string; name?: string }, T = { id: string; site_id: string; code: string }>(want: Want): LookupState<S, B, T> {
  const [state, setState] = useState<LookupState<S, B, T>>({ sites: [], brokers: [], shiftTypes: [], guardsLite: [], loading: true, error: null });
  const wantKey = (Object.keys(want) as LookupName[]).filter((k) => want[k]).sort().join(",");
  useEffect(() => {
    let cancelled = false;
    const names = (wantKey ? wantKey.split(",") : []) as LookupName[];
    (async () => {
      const results = await Promise.all(names.map((n) => cachedGetAll<unknown>(LOOKUP_PATHS[n]).then((r) => [n, r] as const)));
      if (cancelled) return;
      const next: LookupState<S, B, T> = { sites: [], brokers: [], shiftTypes: [], guardsLite: [], loading: false, error: null };
      for (const [n, r] of results) {
        if (!r.ok) {
          next.error = r.message;
          continue;
        }
        (next as unknown as Record<string, unknown>)[n] = r.data.rows;
      }
      setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [wantKey]);
  return state;
}
