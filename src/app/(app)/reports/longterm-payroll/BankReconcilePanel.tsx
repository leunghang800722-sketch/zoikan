"use client";
// P14.3：「銀行對數」tab——上載 BOCHK Payroll Editor（xls／xlsx，要解密版）→ 逐人同系統 autopay 對數 → 差異標原因。
// 姓名／工號照長工糧頁（module gate）；bank_only 行只有行號同金額；匯出 CSV 唔含銀行名／戶口。
import { Fragment, useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { inputCls, selectCls } from "@/components/ui/Field";
import { tableCls, tableMinWidth, TableEmptyRow } from "@/components/ui/DataTable";
import { apiGet, apiPatch, apiUpload } from "@/lib/ui/api-client";
import { fmtMoney } from "@/lib/ui/format";
import { REASON_CODES, REASON_LABEL } from "@/lib/longterm-payroll/reconcile-reasons";

interface Components {
  work_days: number;
  days_in_month: number;
  net_basic: number | null;
  ot_hours: number | null;
  ot_amount: number | null;
  rest_day_payment: number | null;
  npsh: number | null;
  npl_days: number | null;
  npsl_days: number | null;
  deduction: number | null;
  special_allowance: number | null;
  other_allowance: number | null;
  al_payment: number | null;
  sl45_amount: number | null;
  gross: number | null;
  mpf_ee: number | null;
  mpf_er: number | null;
  autopay: number | null;
  notes: string[];
}
interface Row {
  id: string;
  bank_row_no: number;
  guard_id: string | null;
  guard_name: string | null;
  guard_staff_no: string | null;
  bank_amount: number | null;
  system_autopay: number | null;
  diff: number | null;
  match_by: string;
  status: "equal" | "diff" | "bank_only" | "system_only";
  reason_code: string | null;
  reason_note: string | null;
  components: Components | null;
}
interface Summary {
  bank_rows: number;
  system_lines: number;
  matched: number;
  equal: number;
  diff: { total: number; le1: number; le100: number; gt100: number };
  bank_only: number;
  system_only: number;
  bad_amount_rows: number;
  ambiguous_name?: number;
  system_zero_skipped: number;
  totals: { bank: number; system: number; matched_bank: number; matched_system: number };
  unresolved: number;
}
interface Result {
  month: string;
  reconciliation: { id: string; file_name: string; uploaded_at: string; stale: boolean } | null;
  summary: Summary | null;
  rows: Row[];
}
const STATUS_LABEL: Record<Row["status"], string> = { equal: "吻合", diff: "有差額", bank_only: "只喺銀行", system_only: "只喺系統" };
const MATCH_LABEL: Record<string, string> = { remark: "備考號", account: "戶口", name_en: "英文名", none: "—" };
const COMP_LABEL: Array<[keyof Components, string]> = [
  ["net_basic", "Net Basic"],
  ["ot_amount", "OT"],
  ["rest_day_payment", "賣假"],
  ["npsh", "NPSH"],
  ["deduction", "NPL／扣款"],
  ["special_allowance", "津貼"],
  ["other_allowance", "其他津貼"],
  ["al_payment", "年假"],
  ["sl45_amount", "4/5 病假"],
  ["gross", "Gross"],
  ["mpf_ee", "MPF EE"],
  ["autopay", "Autopay"],
];

export function BankReconcilePanel({ month, hasRun, active, onError, onNotice }: { month: string; hasRun: boolean; active: boolean; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [data, setData] = useState<Result | null>(null);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await apiGet<Result>(`/api/longterm/payroll/${month}/reconcile`);
    if (r.ok) setData(r.data);
    else onError(r.message);
  }, [month, onError]);

  useEffect(() => {
    if (active) void load(); // tab 隱藏時唔 GET
  }, [load, active]);

  async function onFile(f: File | null) {
    if (!f) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("file", f);
    const res = await apiUpload<{ summary: Summary }>(`/api/longterm/payroll/${month}/reconcile`, fd);
    setBusy(false);
    if (!res.ok) return onError(res.message);
    onNotice(`對數完成：吻合 ${res.data.summary.equal}、有差額 ${res.data.summary.diff.total}、只喺銀行 ${res.data.summary.bank_only}、只喺系統 ${res.data.summary.system_only}`);
    await load();
  }

  async function setReason(row: Row, code: string, note: string | null) {
    const res = await apiPatch<{ unresolved: number }>(`/api/longterm/reconcile-rows/${row.id}`, { reason_code: code || null, reason_note: note });
    if (!res.ok) return onError(res.message);
    await load();
  }

  const s = data?.summary;
  const rows = (data?.rows ?? []).filter((r) => !onlyDiff || r.status !== "equal");

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zk-border bg-white p-4" data-testid="ltpay-recon-panel">
      <div className="text-sm font-semibold text-zk-text">銀行 Payroll Editor 對數（{month}）</div>
      <p className="text-zk-sm text-zk-muted">
        上載銀行 BOCHK Payroll Editor 檔（.xls／.xlsx）。檔案如果有密碼，請先用 Excel 另存冇密碼版本。系統會逐人（備考號 LT{month.replace("-", "")}-工號 → 戶口 → 英文名）同「本月糧」嘅 Autopay 對數，容差 ±0.01。銀行姓名只記雜湊，唔存原文。
      </p>
      {!hasRun && <Banner kind="info" message="呢個月未計過長工糧，請先「重算本月」再對數" />}
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".xls,.xlsx" disabled={busy || !hasRun} onChange={(e) => { void onFile(e.target.files?.[0] ?? null); e.target.value = ""; }} data-testid="ltpay-recon-file" aria-label="銀行 Payroll Editor 檔案" />
        {data?.reconciliation && (
          <a href={`/api/longterm/payroll/${month}/reconcile?format=csv`} data-testid="ltpay-recon-csv">
            <Button variant="secondary" size="sm">匯出差異 CSV</Button>
          </a>
        )}
      </div>
      {data?.reconciliation?.stale && <Banner kind="warning" message="上次對數之後本月糧已重算過，結果可能過時——請重新上載銀行檔" />}
      {s && (
        <div className="flex flex-col gap-2" data-testid="ltpay-recon-summary">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Card label="銀行行數／系統人數" value={`${s.bank_rows}／${s.system_lines}`} />
            <Card label="吻合" value={String(s.equal)} />
            <Card label="有差額（≤1／≤100／>100）" value={`${s.diff.total}（${s.diff.le1}／${s.diff.le100}／${s.diff.gt100}）`} />
            <Card label="只喺銀行／只喺系統" value={`${s.bank_only}／${s.system_only}`} />
            <Card label="銀行總額" value={fmtMoney(s.totals.bank)} />
            <Card label="系統總額" value={fmtMoney(s.totals.system)} />
            <Card label="配到嘅兩邊差" value={fmtMoney(Math.round((s.totals.matched_bank - s.totals.matched_system) * 100) / 100)} />
            <Card label="未解釋" value={String(s.unresolved)} tone={s.unresolved > 0 ? "danger" : "ok"} />
          </div>
          <div className="text-zk-sm text-zk-muted">
            檔案：{data?.reconciliation?.file_name}
            {s.bad_amount_rows > 0 ? `；${s.bad_amount_rows} 行金額無法解析（已列入只喺銀行）` : ""}
            {(s.ambiguous_name ?? 0) > 0 ? `；${s.ambiguous_name} 行同名多人／多行，無法自動配對（需人手核）` : ""}
            {s.system_zero_skipped > 0 ? `；${s.system_zero_skipped} 人系統 Autopay 為 0 而銀行冇出，唔當差異` : ""}
          </div>
        </div>
      )}
      {data?.reconciliation && (
        <label className="flex items-center gap-2 text-zk-sm">
          <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} data-testid="ltpay-recon-only-diff" />
          只睇差異
        </label>
      )}
      {data?.reconciliation && (
        <div className={tableCls.wrap}>
          <table className={tableCls.table} style={{ minWidth: tableMinWidth(8) }}>
            <thead>
              <tr>
                <th className={tableCls.th}>工號</th>
                <th className={tableCls.th}>姓名</th>
                <th className={tableCls.thNum}>系統 Autopay</th>
                <th className={tableCls.thNum}>銀行</th>
                <th className={tableCls.thNum}>差額</th>
                <th className={tableCls.th}>配對</th>
                <th className={tableCls.th}>狀態</th>
                <th className={tableCls.th}>原因</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <TableEmptyRow colSpan={8}>{onlyDiff ? "冇差異" : "冇資料"}</TableEmptyRow>
              ) : (
                rows.map((r) => (
                  <Fragment key={r.id}>
                    <tr className={tableCls.rowHover} data-testid="ltpay-recon-row">
                      <td className={tableCls.td}>{r.guard_staff_no ?? (r.bank_row_no ? `銀行第 ${r.bank_row_no} 行` : "—")}</td>
                      <td className={tableCls.td}>
                        {r.guard_name ?? "—"}
                        {r.components && (
                          <Button variant="link" size="sm" onClick={() => setExpanded(expanded === r.id ? null : r.id)} data-testid="ltpay-recon-expand">
                            {expanded === r.id ? "收埋" : "組成"}
                          </Button>
                        )}
                      </td>
                      <td className={tableCls.tdNum}>{r.system_autopay === null ? "—" : fmtMoney(r.system_autopay)}</td>
                      <td className={tableCls.tdNum}>{r.bank_amount === null ? "—" : fmtMoney(r.bank_amount)}</td>
                      <td className={tableCls.tdNum}>{r.diff === null ? "—" : fmtMoney(r.diff)}</td>
                      <td className={tableCls.td}>{MATCH_LABEL[r.match_by] ?? r.match_by}</td>
                      <td className={tableCls.td}>
                        <Pill variant={r.status === "equal" ? "success" : "neutral"}>{STATUS_LABEL[r.status]}</Pill>
                      </td>
                      <td className={tableCls.td}>
                        {r.status === "equal" ? (
                          "—"
                        ) : (
                          <span className="flex flex-wrap items-center gap-1">
                            <select className={selectCls} value={r.reason_code ?? ""} onChange={(e) => void setReason(r, e.target.value, r.reason_note)} aria-label="差異原因" data-testid="ltpay-recon-reason">
                              <option value="">未解釋</option>
                              {REASON_CODES.map((c) => (
                                <option key={c} value={c}>
                                  {REASON_LABEL[c]}
                                </option>
                              ))}
                            </select>
                            <input className={inputCls} defaultValue={r.reason_note ?? ""} placeholder="備注" aria-label="原因備注" onBlur={(e) => { if (e.target.value !== (r.reason_note ?? "")) void setReason(r, r.reason_code ?? "", e.target.value); }} />
                          </span>
                        )}
                      </td>
                    </tr>
                    {expanded === r.id && r.components && (
                      <tr data-testid="ltpay-recon-components">
                        <td className={tableCls.td} colSpan={8}>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-zk-sm">
                            <span>返工 {r.components.work_days}／{r.components.days_in_month} 日</span>
                            <span>OT {r.components.ot_hours ?? 0} 小時</span>
                            {COMP_LABEL.map(([k, label]) => (
                              <span key={k}>
                                {label} {fmtMoney(r.components![k] as number | null)}
                              </span>
                            ))}
                          </div>
                          {r.components.notes.length > 0 && <div className="mt-1 text-zk-sm text-zk-muted">{r.components.notes.join("；")}</div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: "ok" | "danger" }) {
  return (
    <div className="rounded border border-zk-border-soft p-2">
      <div className="text-zk-xs text-zk-muted">{label}</div>
      <div className={`text-sm font-semibold ${tone === "danger" ? "text-zk-danger" : "text-zk-text"}`}>{value}</div>
    </div>
  );
}
