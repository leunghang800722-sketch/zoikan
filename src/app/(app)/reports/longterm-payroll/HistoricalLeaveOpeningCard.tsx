"use client";
// HIST-2：「歷史假期結餘回填」導航卡——由 2026-07 前月份更表（已落更嘅 SL／AL）計長工病假／年假結餘 opening。
// 流程：先 dry-run 列差異（唔寫入）→ 睇完再一撳套用（POST /api/leave-balances/opening-from-rosters）。
// API 只回 guard_id＋數字，人名經現有保安員 lookup（/api/guards?fields=lite）顯示。權限「糧務:create」（老闆／會計），冇權限會見到 403 訊息。
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { apiPost } from "@/lib/ui/api-client";
import { cachedGetAll } from "@/lib/ui/lookups";

const AS_OF_OPTIONS = ["2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01"] as const;

interface RowDTO {
  guard_id: string;
  action: string;
  flags: string[];
  diffs: Record<string, [number | string | null, number | string | null]>;
}
interface ResultDTO {
  as_of: string;
  apply: boolean;
  counts: Record<string, number>;
  rows: RowDTO[];
}
interface GuardLite {
  id: string;
  name_zh: string;
}

const ACTION_LABEL: Record<string, string> = {
  create: "新增結餘行",
  update: "更新結餘行",
  merge: "合併落現有結餘行",
  already_merged: "已合併過",
  skip_existing_newer_or_equal: "現有結餘較新，唔郁",
  nothing_to_write: "冇嘢寫",
  unchanged: "冇變",
};
const FIELD_LABEL: Record<string, string> = { al_taken: "年假已用", sl_taken: "病假已用", sl_accrued: "病假累積", al_taken_opening: "年假期初", sl_taken_opening: "病假期初", as_of_month: "截至月份" };
const WRITE_ACTIONS = new Set(["create", "update", "merge"]);

export function HistoricalLeaveOpeningCard() {
  const [open, setOpen] = useState(false);
  const [asOf, setAsOf] = useState<string>("2026-06");
  const [merge, setMerge] = useState(true);
  const [busy, setBusy] = useState<"dry" | "apply" | null>(null);
  const [result, setResult] = useState<ResultDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const unmounted = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  async function loadNames() {
    const res = await cachedGetAll<GuardLite>("/api/guards?fields=lite&include_inactive=1");
    if (res.ok && !unmounted.current) setNames(new Map(res.data.rows.map((g) => [g.id, g.name_zh])));
  }

  async function run(apply: boolean) {
    setBusy(apply ? "apply" : "dry");
    setError(null);
    const res = await apiPost<ResultDTO>("/api/leave-balances/opening-from-rosters", { as_of: asOf, apply, merge_into_existing: merge });
    if (unmounted.current) return;
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setResult(res.data);
    if (!apply) await loadNames();
  }

  const writable = result ? result.rows.filter((r) => WRITE_ACTIONS.has(r.action)) : [];
  const shown = result ? result.rows.filter((r) => r.action !== "nothing_to_write" && r.action !== "unchanged") : [];

  return (
    <section className="rounded-lg border border-zk-border bg-white p-3 sm:p-4" data-testid="hist-leave-opening-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-zk-text">歷史假期結餘回填（1–6 月更表）</div>
          <p className="text-zk-sm text-zk-muted">由 2026-07 前月份更表入面嘅病假／年假，計長工嘅假期結餘期初值。先睇差異，確認啱先套用。</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} data-testid="hist-leave-opening-toggle">
          {open ? "收埋" : "展開"}
        </Button>
      </div>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-zk-sm text-zk-text">
              計到
              <select className="rounded border border-zk-border px-2 py-1" value={asOf} onChange={(e) => { setAsOf(e.target.value); setResult(null); }} data-testid="hist-leave-opening-asof">
                {AS_OF_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} 月底
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-zk-sm text-zk-text">
              <input type="checkbox" checked={merge} onChange={(e) => { setMerge(e.target.checked); setResult(null); }} />
              已有 7 月起結餘行就加落去（合併）
            </label>
            <Button variant="primary" size="sm" onClick={() => void run(false)} disabled={busy !== null} data-testid="hist-leave-opening-dry">
              {busy === "dry" ? "計緊…" : "先睇差異（唔寫入）"}
            </Button>
          </div>
          {error && <div className="rounded border border-zk-danger-border bg-zk-danger-bg px-3 py-2 text-zk-sm text-zk-danger-dark" data-testid="hist-leave-opening-error">{error}</div>}
          {result && (
            <div className="flex flex-col gap-2" data-testid="hist-leave-opening-result">
              <div className="text-zk-sm text-zk-text" data-testid="hist-leave-opening-counts">
                {result.apply ? "已套用：" : "預覽（未寫入）："}長工 {result.counts.guards ?? 0} 人｜新增 {result.counts.create ?? 0}｜更新 {result.counts.update ?? 0}｜合併 {result.counts.merge ?? 0}｜冇變／冇嘢寫 {(result.counts.unchanged ?? 0) + (result.counts.nothing_to_write ?? 0)}｜唔郁 {result.counts.skip_existing_newer_or_equal ?? 0}｜缺入職日 {result.counts.no_hire_date ?? 0}
              </div>
              {shown.length > 0 && (
                <ul className="max-h-72 divide-y divide-zk-border overflow-y-auto rounded border border-zk-border text-zk-sm">
                  {shown.slice(0, 200).map((r) => (
                    <li key={r.guard_id} className="px-2.5 py-1.5" data-testid="hist-leave-opening-row">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-zk-text">{names.get(r.guard_id) ?? r.guard_id.slice(0, 8)}</span>
                        <span className="text-zk-muted">{ACTION_LABEL[r.action] ?? r.action}</span>
                      </div>
                      <div className="text-zk-muted tabular-nums">
                        {Object.entries(r.diffs)
                          .map(([k, [from, to]]) => `${FIELD_LABEL[k] ?? k} ${from ?? "—"} → ${to ?? "—"}`)
                          .join("；")}
                        {r.flags.length > 0 ? `　（${r.flags.join("、")}）` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {shown.length > 200 && <div className="text-zk-xs text-zk-faint">只列頭 200 人，全部差異套用時一併處理。</div>}
              {!result.apply && (
                <div>
                  <Button variant="primary" size="sm" onClick={() => void run(true)} disabled={busy !== null || writable.length === 0} data-testid="hist-leave-opening-apply">
                    {busy === "apply" ? "套用緊…" : `確認套用（寫入 ${writable.length} 人）`}
                  </Button>
                  {writable.length === 0 && <span className="ml-2 text-zk-xs text-zk-faint">冇需要寫入嘅人。</span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
