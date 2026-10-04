"use client";
// WP-AI-OPS §28.2：每月修正摘要——月份揀選、同上月對比、類別表、重複提示、基線。
// 唔含任何人名／工號／hkid／電話。「AI 摘要」掣淨係 AI 已設定先顯示。
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChip";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth } from "@/components/ui/DataTable";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { currentMonthStr, addMonthsStr } from "@/lib/ui/format";

interface CategoryDTO {
  key: string;
  group: string;
  label: string;
  count: number;
  prev_count: number;
  streak: number;
}
interface BaselineDTO {
  one_click: { runs: number; done_runs: number; failed_runs: number; avg_duration_sec: number | null; max_duration_sec: number | null; needs_human_per_run: number[] };
  name_only_cells: number;
  unmatched_cells: number;
  ambiguous_cells: number;
  unpriced_records: number;
  uploads: { files: number; reuploads: number; voided: number; superseded: number };
  days_month_end_to_lock: number | null;
}
interface DigestDTO {
  month: string;
  prev_month: string;
  window: { from: string; to: string; basis: string };
  categories: CategoryDTO[];
  group_totals: Array<{ group: string; label: string; count: number; prev_count: number }>;
  baseline: BaselineDTO;
  prev_baseline: BaselineDTO;
  repeats: Array<{ key: string; label: string; streak: number }>;
  top_sites: Array<{ site_name: string; count: number }>;
  top_brokers: Array<{ broker_code: string; count: number }>;
  correction_total: number;
  ai_available: boolean;
}

function delta(cur: number, prev: number) {
  const d = cur - prev;
  if (d === 0) return <span className="text-zk-faint">±0</span>;
  return <span className={d > 0 ? "text-red-600" : "text-green-700"}>{d > 0 ? `+${d}` : d}</span>;
}

function fmtNum(v: number | null) {
  return v === null ? "—" : String(v);
}

export default function OpsDigestPage() {
  const [month, setMonth] = useState(() => addMonthsStr(currentMonthStr(), -1));
  const [digest, setDigest] = useState<DigestDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDigest(null);
    setAiText(null);
    setError(null);
    apiGet<DigestDTO>(`/api/reports/ops-digest?month=${month}`).then((res) => {
      if (cancelled) return;
      if (res.ok) setDigest(res.data);
      else setError(res.message);
    });
    return () => {
      cancelled = true;
    };
  }, [month]);

  async function askAi() {
    setAiBusy(true);
    setError(null);
    const res = await apiPost<{ text: string }>(`/api/reports/ops-digest/ai-summary`, { month });
    setAiBusy(false);
    if (res.ok) setAiText(res.data.text);
    else setError(res.message);
  }

  const b = digest?.baseline;
  const p = digest?.prev_baseline;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        kicker="財務"
        title="每月修正摘要"
        subtitle="呢個月結算要修正咗乜、同上月比、邊啲問題重複出現——只有類別同數字，冇人名。"
        actions={
          <FilterChip label="月份">
            <input type="month" data-testid="ops-digest-month" value={month} onChange={(e) => setMonth(e.target.value)} className="bg-transparent text-sm" />
          </FilterChip>
        }
      />
      <Banner kind="error" message={error} />

      {!digest && !error && <div className="text-sm text-zk-muted">載入緊……</div>}

      {digest && b && p && (
        <>
          <section className="rounded-lg border border-zk-border bg-white p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold text-zk-text">
                {digest.month} 修正總覽（對比 {digest.prev_month}）
              </div>
              {digest.ai_available && (
                <Button variant="secondary" onClick={askAi} disabled={aiBusy} data-testid="ops-digest-ai-button">
                  {aiBusy ? "AI 整理緊……" : "AI 摘要"}
                </Button>
              )}
            </div>
            <div className="text-[11.5px] text-zk-faint">時間類統計視窗：{digest.window.from.slice(0, 10)} 至 {digest.window.to.slice(0, 10)}（首份更表上載起計到鎖月／而家，最長 60 日）。更次修正按出更日期、特殊項按月份、對數決定按上載月份。</div>
            {aiText && (
              <div className="mt-3 rounded border border-blue-200 bg-blue-50 p-3 text-[13px] leading-relaxed text-zk-text" data-testid="ops-digest-ai-text">
                <div className="mb-1 text-[11.5px] text-zk-muted">AI 摘要（只根據上面嘅數字；請以表內數字為準）</div>
                {aiText}
              </div>
            )}
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {digest.group_totals.map((g) => (
                <div key={g.group} className="rounded border border-zk-border p-3">
                  <div className="text-[11.5px] text-zk-muted">{g.label}</div>
                  <div className="text-lg font-bold">{g.count}</div>
                  <div className="text-[11px] text-zk-muted">上月 {g.prev_count}　{delta(g.count, g.prev_count)}</div>
                </div>
              ))}
            </div>
          </section>

          {digest.repeats.length > 0 && (
            <section className="rounded-lg border border-orange-200 bg-orange-50 p-4" data-testid="ops-digest-repeats">
              <div className="text-sm font-semibold text-orange-800">連續出現嘅問題（值得從源頭改善）</div>
              <ul className="mt-1 list-disc pl-5 text-[12.5px] text-orange-800">
                {digest.repeats.map((r) => (
                  <li key={r.key}>
                    {r.label}：連續 {r.streak} 個月都有
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-lg border border-zk-border bg-white p-4">
            <div className="mb-2 text-sm font-semibold text-zk-text">類別明細</div>
            <div className={tableCls.wrap}>
              <table className={tableCls.table} style={{ minWidth: tableMinWidth(4) }}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>類別</th>
                    <th className={tableCls.th}>分組</th>
                    <th className={tableCls.thNum}>本月</th>
                    <th className={tableCls.thNum}>上月</th>
                    <th className={tableCls.thNum}>連續月數</th>
                  </tr>
                </thead>
                <tbody>
                  {digest.categories
                    .filter((c) => c.count > 0 || c.prev_count > 0)
                    .map((c) => (
                      <tr key={c.key} className={tableCls.rowHover}>
                        <td className={tableCls.td}>{c.label}</td>
                        <td className={tableCls.td}>{digest.group_totals.find((g) => g.group === c.group)?.label ?? c.group}</td>
                        <td className={tableCls.tdNum}>{c.count}</td>
                        <td className={tableCls.tdNum}>{c.prev_count}</td>
                        <td className={tableCls.tdNum}>{c.streak >= 2 ? <Pill variant="warning">{c.streak}</Pill> : c.streak || "—"}</td>
                      </tr>
                    ))}
                  {digest.categories.every((c) => c.count === 0 && c.prev_count === 0) && (
                    <tr>
                      <td className={tableCls.td} colSpan={5}>
                        呢兩個月冇任何修正記錄。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-zk-border bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-zk-text">修正量 Top {digest.top_sites.length || 5} 盤（共 {digest.correction_total} 項更次修正）</div>
              <ol className="list-decimal pl-5 text-[13px]">
                {digest.top_sites.map((s) => (
                  <li key={s.site_name}>
                    {s.site_name}：{s.count}
                  </li>
                ))}
              </ol>
              {digest.top_sites.length === 0 && <div className="text-[12.5px] text-zk-muted">冇</div>}
              <div className="mb-1 mt-3 text-sm font-semibold text-zk-text">Top 雞頭代號</div>
              <ol className="list-decimal pl-5 text-[13px]">
                {digest.top_brokers.map((s) => (
                  <li key={s.broker_code}>
                    {s.broker_code}：{s.count}
                  </li>
                ))}
              </ol>
              {digest.top_brokers.length === 0 && <div className="text-[12.5px] text-zk-muted">冇</div>}
            </div>

            <div className="rounded-lg border border-zk-border bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-zk-text">基線指標</div>
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-zk-muted">
                    <th className="py-1 font-medium">指標</th>
                    <th className="py-1 text-right font-medium">本月</th>
                    <th className="py-1 text-right font-medium">上月</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["一鍵結算次數", b.one_click.runs, p.one_click.runs],
                    ["一鍵結算平均耗時（秒）", b.one_click.avg_duration_sec, p.one_click.avg_duration_sec],
                    ["最近一次 needs_human 數", b.one_click.needs_human_per_run.at(-1) ?? null, p.one_click.needs_human_per_run.at(-1) ?? null],
                    ["name_only 格數", b.name_only_cells, p.name_only_cells],
                    ["unmatched 格數", b.unmatched_cells, p.unmatched_cells],
                    ["ambiguous 格數", b.ambiguous_cells, p.ambiguous_cells],
                    ["未定價記錄", b.unpriced_records, p.unpriced_records],
                    ["上載檔數", b.uploads.files, p.uploads.files],
                    ["重傳（version>1）", b.uploads.reuploads, p.uploads.reuploads],
                    ["作廢上載", b.uploads.voided, p.uploads.voided],
                    ["下月 1 號到鎖月日數", b.days_month_end_to_lock, p.days_month_end_to_lock],
                  ].map(([label, cur, prev]) => (
                    <tr key={String(label)} className="border-t border-zk-border">
                      <td className="py-1">{label}</td>
                      <td className="py-1 text-right">{fmtNum(cur as number | null)}</td>
                      <td className="py-1 text-right">{fmtNum(prev as number | null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
