"use client";
// WP-RECONCILE-UI（§33）：全部只讀現有 endpoint——/api/guards（?take=500 同 ?q=）、
// /api/guard-fix/runs(+/:id)。短 TTL 記憶體快取，同一頁／同一個分診 dialog 多條題唔會重複打。
import { useEffect, useRef, useState } from "react";
import { apiGet, apiGetAll, type ApiListResult } from "@/lib/ui/api-client";
import { findSimilar, hasPerson, personKey, type GuardLite, type NeedsBossItem, type Person, type SimilarGuard } from "./derive";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; p: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p as Promise<T | null>;
  const p = load().then((v) => {
    if (v === null) cache.delete(key); // 失敗唔記
    return v;
  });
  cache.set(key, { at: Date.now(), p });
  return p;
}

export function loadGuardDirectory(): Promise<{ rows: GuardLite[]; total: number } | null> {
  return cached("guards:all", async () => {
    // P3-2.x（階段 1 驗收員補充）：`take=500` 會喺在職保安員 >500 時靜靜截斷——逐頁拉齊。
    // AI-PII-2.3：名冊包括離職（inactive）保安員——「相似保安員」提示可以認到離職者（UI 標「已離職」）
    const res = await apiGetAll<GuardLite>("/api/guards?include_inactive=1");
    return res.ok ? { rows: res.data.rows, total: res.data.total } : null;
  });
}

function loadGuardSearch(q: string): Promise<GuardLite[] | null> {
  return cached(`guards:q:${q}`, async () => {
    const res = await apiGet<ApiListResult<GuardLite>>(`/api/guards?q=${encodeURIComponent(q)}&take=20&include_inactive=1`);
    return res.ok ? res.data.rows : null;
  });
}

/** 名冊（全部在職）。 */
export function useGuardDirectory(enabled = true): { rows: GuardLite[]; total: number; loaded: boolean } {
  const [dir, setDir] = useState<{ rows: GuardLite[]; total: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadGuardDirectory().then((d) => {
      if (!alive) return;
      setDir(d);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return { rows: dir?.rows ?? [], total: dir?.total ?? 0, loaded };
}

export interface SimilarState {
  status: "idle" | "loading" | "done";
  list: SimilarGuard[];
}

/**
 * 相似保安員：先用已載入名冊算；冇結果先按需 `?q=<名>`、`?q=<工號>`（去抖 400ms，每個人最多兩次，
 * 結果有快取）。包括離職員工（include_inactive=1）。純提示：唔配對、唔寫入。
 */
export function useSimilarGuards(person: Person | null, dir: { rows: GuardLite[]; total: number; loaded: boolean }): SimilarState {
  const key = person ? personKey(person) : "";
  const local = person && dir.loaded ? findSimilar(person, dir.rows) : [];
  const [remote, setRemote] = useState<{ key: string; list: SimilarGuard[] } | null>(null);
  const personRef = useRef(person);
  personRef.current = person;
  const needRemote = !!person && hasPerson(person) && dir.loaded && local.length === 0;
  useEffect(() => {
    const p = personRef.current;
    if (!needRemote || !p) return;
    let alive = true;
    const t = setTimeout(async () => {
      const terms = [...new Set([p.name.trim(), p.staffNo.trim()].filter(Boolean))].slice(0, 2);
      const pool = new Map<string, GuardLite>();
      for (const term of terms) {
        const rows = await loadGuardSearch(term);
        for (const g of rows ?? []) pool.set(g.id, g);
      }
      if (alive) setRemote({ key, list: findSimilar(p, [...pool.values()]) });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [needRemote, key]);
  if (!person || !hasPerson(person)) return { status: "done", list: [] };
  if (!dir.loaded) return { status: "loading", list: [] };
  if (local.length > 0) return { status: "done", list: local };
  if (remote && remote.key === key) return { status: "done", list: remote.list };
  return { status: "loading", list: [] };
}


// ---------------------------------------------------------------------------
// guard-fix 最新 run 嘅 needs_boss
// ---------------------------------------------------------------------------
interface RunListItem {
  id: string;
  month: string;
  status: string;
  created_at: string;
}
interface RunDetail {
  id: string;
  month: string;
  needs_boss?: NeedsBossItem[];
}

export interface NeedsBossResult {
  runId: string | null;
  month: string | null;
  items: NeedsBossItem[];
}

/** 該月（YYYY-MM，唔傳就全部 run 最新一個）最新 guard-fix run 嘅 needs_boss；冇權限／冇 run → null／空。 */
function loadNeedsBoss(month: string | null): Promise<NeedsBossResult | null> {
  return cached(`needsboss:${month ?? "*"}`, async () => {
    const list = await apiGet<{ runs: RunListItem[] }>(`/api/guard-fix/runs${month ? `?month=${encodeURIComponent(month.slice(0, 7))}` : ""}`);
    if (!list.ok) return null;
    // API 冇按月篩選，自己按 month 篩；列表已按 created_at desc。
    const runs = list.data.runs.filter((r) => !month || r.month.startsWith(month.slice(0, 7)));
    const latest = runs[0];
    if (!latest) return { runId: null, month, items: [] };
    const detail = await apiGet<RunDetail>(`/api/guard-fix/runs/${latest.id}`);
    if (!detail.ok) return null;
    return { runId: latest.id, month: latest.month, items: detail.data.needs_boss ?? [] };
  });
}

/** null＝載入中；"denied"＝冇權限（guard-fix 403）或者失敗；否則結果。 */
export function useNeedsBoss(month: string | null, enabled = true): NeedsBossResult | "denied" | null {
  const [res, setRes] = useState<NeedsBossResult | "denied" | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadNeedsBoss(month).then((r) => {
      if (alive) setRes(r ?? "denied");
    });
    return () => {
      alive = false;
    };
  }, [month, enabled]);
  return res;
}
