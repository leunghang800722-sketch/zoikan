"use client";
import { useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { tableCls, tableMinWidth, TableEmptyRow } from "@/components/ui/DataTable";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { fmtMoney } from "@/lib/ui/format";
import { addMonthsStr, currentMonthStr } from "@/lib/ui/format";

interface Sug {
  site_id: string;
  site_name: string;
  grade: string;
  status: "consistent" | "mixed" | "single_sample";
  suggested_amount: number | null;
  needs_choice: boolean;
  amounts: { amount: number; shifts: number; guard_count: number }[];
  total_shifts: number;
  guard_count: number;
  months: string[];
}
interface Result {
  months: string[];
  suggestions: Sug[];
  unresolved: {
    no_input: { site_id: string; site_name: string; grade: string; shifts: number; guard_count: number; months: string[] }[];
    no_shift: { reason: string; guard_id: string; month: string; amount: number }[];
    ambiguous: { guard_id: string; month: string; total_amount: number; keys: { site_name: string; grade: string; shifts: number }[] }[];
  };
  backtest: {
    rows: { month: string; guard_id: string; expected: number; actual: number; diff: number; unpriced_shifts: number; has_mixed_input: boolean }[];
    summary: { guard_months: number; matched: number; match_rate: number | null; diff_nonzero: number; max_abs_diff: number; unpriced_guard_months: number; by_month: { month: string; guard_months: number; matched: number; diff_nonzero: number; max_abs_diff: number }[] };
  };
  stats: { cover_shifts: number; tagged_inputs: number; untagged_other_allowance_guard_months: number };
}

const STATUS_LABEL = { consistent: "一致", mixed: "多個價（要揀）", single_sample: "只得 1 次" } as const;
const keyOf = (s: { site_id: string; grade: string }) => `${s.site_id}|${s.grade}`;

export function InferClient() {
  const cur = currentMonthStr();
  const [months, setMonths] = useState([addMonthsStr(cur, -3), addMonthsStr(cur, -2), addMonthsStr(cur, -1)].join(","));
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [effFrom, setEffFrom] = useState(`${cur}-01`);

  async function run() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await apiGet<Result>(`/api/longterm/cover-rates/infer?months=${encodeURIComponent(months)}`);
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setResult(res.data);
    const p: Record<string, boolean> = {};
    for (const s of res.data.suggestions) p[keyOf(s)] = s.status === "consistent";
    setPicked(p);
    setChosen({});
  }

  function amountFor(s: Sug): number | null {
    if (s.status === "mixed") return chosen[keyOf(s)] ? Number(chosen[keyOf(s)]) : null;
    return s.suggested_amount;
  }

  async function adopt() {
    if (!result) return;
    const items = result.suggestions
      .filter((s) => picked[keyOf(s)] && amountFor(s) !== null)
      .map((s) => ({ site_id: s.site_id, grade: s.grade, amount: amountFor(s)!, status: s.status }));
    if (items.length === 0) return setError("未剔選任何行（多個價嘅行要先揀金額）");
    setBusy(true);
    const res = await apiPost<{ created: number; skipped: unknown[] }>("/api/longterm/cover-rates/adopt", { months: result.months.join(","), effective_from: effFrom, items });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    setError(null);
    setNotice(`已採用 ${res.data.created} 行${res.data.skipped.length ? `，${res.data.skipped.length} 行已有價跳過` : ""}。去價目表檢查／微調。`);
  }

  const diffRows = result?.backtest.rows.filter((r) => r.diff !== 0 || r.unpriced_shifts > 0).slice(0, 100) ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="cover-infer-page">
      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-zk-border bg-white p-4">
        <Field label="月份（逗號分隔 YYYY-MM）">
          <input className={inputCls} value={months} onChange={(e) => setMonths(e.target.value)} data-testid="cover-infer-months" />
        </Field>
        <Button variant="primary" onClick={run} disabled={busy} data-testid="cover-infer-run">
          {busy ? "推斷中…" : "推斷（唯讀）"}
        </Button>
      </section>
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {result && (
        <>
          <Banner kind="warning" data-testid="cover-infer-warning">注意：頂位更＝長工幫雞頭頂散更，呢啲更喺長工糧已經由雞頭現金結算（唔當長工返工日）。再出頂位津貼會唔會雙重支付，要老闆決定；可以睇下面回測吻合率（會計過往有冇另外畀）再決定採用。</Banner>
          <Banner kind="info" data-testid="cover-infer-stats">
            頂位更 {result.stats.cover_shifts} 更；頂位津貼人手輸入 {result.stats.tagged_inputs} 條（備註含「頂位」先認得到）；有頂位更但只有未標「頂位」嘅其他津貼嘅人月 {result.stats.untagged_other_allowance_guard_months} 個（漏判風險，回測當 0）。
          </Banner>
          <section className="flex flex-col gap-2" data-testid="cover-infer-suggestions">
            <div className="text-sm font-semibold text-zk-text">建議價目表</div>
            <div className={tableCls.wrap}>
              <table className={tableCls.table} style={{ minWidth: tableMinWidth(7) }}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>採用</th>
                    <th className={tableCls.th}>盤</th>
                    <th className={tableCls.th}>職級</th>
                    <th className={tableCls.th}>建議每更</th>
                    <th className={tableCls.th}>狀態</th>
                    <th className={tableCls.th}>證據</th>
                    <th className={tableCls.th}>次數／人數</th>
                  </tr>
                </thead>
                <tbody>
                  {result.suggestions.length === 0 ? (
                    <TableEmptyRow colSpan={7}>推斷唔到任何價</TableEmptyRow>
                  ) : (
                    result.suggestions.map((s) => (
                      <tr key={keyOf(s)} className={tableCls.rowHover} data-testid="cover-infer-row" data-status={s.status}>
                        <td className={tableCls.td}>
                          <input type="checkbox" checked={!!picked[keyOf(s)]} onChange={(e) => setPicked({ ...picked, [keyOf(s)]: e.target.checked })} aria-label="採用" data-testid="cover-infer-pick" />
                        </td>
                        <td className={tableCls.td}>{s.site_name}</td>
                        <td className={tableCls.td}>{s.grade}</td>
                        <td className={tableCls.td}>
                          {s.status === "mixed" ? (
                            <select className={selectCls} value={chosen[keyOf(s)] ?? ""} onChange={(e) => setChosen({ ...chosen, [keyOf(s)]: e.target.value })} data-testid="cover-infer-choose">
                              <option value="">— 要老闆揀 —</option>
                              {s.amounts.map((a) => (
                                <option key={a.amount} value={a.amount}>
                                  {fmtMoney(a.amount)}（{a.shifts} 更）
                                </option>
                              ))}
                            </select>
                          ) : (
                            fmtMoney(s.suggested_amount)
                          )}
                        </td>
                        <td className={tableCls.td}>
                          <Pill variant={s.status === "consistent" ? "success" : "warning"}>{STATUS_LABEL[s.status]}</Pill>
                        </td>
                        <td className={tableCls.td}>{s.amounts.map((a) => `${fmtMoney(a.amount)}×${a.shifts}`).join("、")}（{s.months.join("、")}）</td>
                        <td className={tableCls.td}>
                          {s.total_shifts} 更／{s.guard_count} 人
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="價目表生效日（要係未鎖月份）">
                <input type="date" className={inputCls} value={effFrom} onChange={(e) => setEffFrom(e.target.value)} data-testid="cover-infer-eff" />
              </Field>
              <Button variant="primary" onClick={adopt} disabled={busy || result.suggestions.length === 0} data-testid="cover-infer-adopt">
                採用已剔選嘅行
              </Button>
            </div>
          </section>
          <section className="flex flex-col gap-2" data-testid="cover-infer-unresolved">
            <div className="text-sm font-semibold text-zk-text">推斷唔到（要老闆補）</div>
            <ul className="list-disc pl-5 text-zk-sm text-zk-text-secondary">
              <li data-testid="cover-infer-unresolved-noinput">
                有頂位更但冇對應人手輸入：{result.unresolved.no_input.length === 0 ? "無" : result.unresolved.no_input.map((u) => `${u.site_name} ${u.grade}（${u.shifts} 更／${u.guard_count} 人）`).join("；")}
              </li>
              <li data-testid="cover-infer-unresolved-noshift">
                有頂位輸入但配對唔到頂位更（或混咗賣假）：{result.unresolved.no_shift.length === 0 ? "無" : `${result.unresolved.no_shift.length} 項（${result.unresolved.no_shift.filter((n) => n.reason === "sell_leave_mixed").length} 項混賣假）`}
              </li>
              <li data-testid="cover-infer-unresolved-ambiguous">
                同月頂多個盤／職級但輸入得一個總數：{result.unresolved.ambiguous.length === 0 ? "無" : result.unresolved.ambiguous.map((a) => `${a.month} 總額 ${fmtMoney(a.total_amount)}（${a.keys.map((k) => `${k.site_name} ${k.grade}×${k.shifts}`).join("＋")}）`).join("；")}
              </li>
            </ul>
          </section>
          <section className="flex flex-col gap-2" data-testid="cover-infer-backtest">
            <div className="text-sm font-semibold text-zk-text">回測（用建議價重算每人每月頂位津貼 vs 實際人手輸入）</div>
            <div className="text-zk-sm text-zk-text-secondary" data-testid="cover-infer-backtest-summary">
              共 {result.backtest.summary.guard_months} 個人月；吻合 {result.backtest.summary.matched}（{result.backtest.summary.match_rate === null ? "—" : `${Math.round(result.backtest.summary.match_rate * 100)}%`}）；有差額 {result.backtest.summary.diff_nonzero} 個人月，最大差額 {fmtMoney(result.backtest.summary.max_abs_diff)}；有更未有價 {result.backtest.summary.unpriced_guard_months} 個人月。
            </div>
            <div className={tableCls.wrap}>
              <table className={tableCls.table} style={{ minWidth: tableMinWidth(5) }}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>月</th>
                    <th className={tableCls.th}>保安員 id</th>
                    <th className={tableCls.th}>應有</th>
                    <th className={tableCls.th}>實際</th>
                    <th className={tableCls.th}>差額</th>
                  </tr>
                </thead>
                <tbody>
                  {diffRows.length === 0 ? (
                    <TableEmptyRow colSpan={5}>冇差額</TableEmptyRow>
                  ) : (
                    diffRows.map((r) => (
                      <tr key={`${r.month}${r.guard_id}`} className={tableCls.rowHover}>
                        <td className={tableCls.td}>{r.month}</td>
                        <td className={tableCls.td}>{r.guard_id.slice(0, 8)}</td>
                        <td className={tableCls.td}>{fmtMoney(r.expected)}</td>
                        <td className={tableCls.td}>{fmtMoney(r.actual)}{r.has_mixed_input ? "（另有混賣假項）" : ""}</td>
                        <td className={tableCls.td}>{fmtMoney(r.diff)}{r.unpriced_shifts ? `（${r.unpriced_shifts} 更未有價）` : ""}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
