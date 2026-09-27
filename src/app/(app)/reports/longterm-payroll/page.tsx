"use client";
// WP-LTPAY §21 任務 5b（老闆 2026-09-26「長工月薪糧」）：`/reports/
// longterm-payroll`——財務區（老闆／會計，module「長工糧」，同「安員
// 銀行資料」一致粒度，主管/雞頭/安員硬性 403，nav.ts 已經唔顯示連結俾
// 佢哋）。① 月份選擇＋「重算本月」；② 逐人結算表（可展開逐項來源、
// 同上月比較）；③ 人手輸入區（津貼/扣款/病假段/年假段/離職結算 CRUD，
// 月鎖後唯讀）；④ 合約管理（列表/編輯/Maxwell 導入）；⑤ 平均工資／
// 假期餘額（逐人顯示、可人手改）；⑥ BOCHK autopay 檔下載。手機 375px
// 用得；hint 唔寫「編號」（跟鐵則）。
import { Fragment, useEffect, useState, useCallback } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { EmptyState, tableCls, tableMinWidth } from "@/components/ui/DataTable";
import { apiGet, apiPost, apiPatch, apiDelete, apiUpload } from "@/lib/ui/api-client";
import { fmtMoney, fmtDate, currentMonthStr, addMonthsStr } from "@/lib/ui/format";

// ---------------------------------------------------------------------------
// 型別（snake_case，同 API response 一致）
// ---------------------------------------------------------------------------
interface LineDTO {
  id: string;
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  days_in_month: number;
  work_days: number;
  net_basic: number;
  ot_hours: number;
  ot_amount: number;
  npsh: number;
  npl_days: number;
  npsl_days: number;
  deduction: number;
  special_allowance: number;
  other_allowance: number;
  al_payment: number;
  sl45_amount: number;
  gross: number;
  mpf_ee: number;
  mpf_er: number;
  autopay: number;
  notes_json: string[];
  prev_gross: number | null;
  prev_autopay: number | null;
  gross_delta: number | null;
  autopay_delta: number | null;
}

interface PayrollMonthDTO {
  month: string;
  locked: boolean;
  run: { id: string; status: string; created_at: string } | null;
  lines: LineDTO[];
  totals: { gross_total?: number; autopay_total?: number; mpf_ee_total?: number; mpf_er_total?: number; guard_count?: number } | null;
  prev_month: string | null;
}

interface InputDTO {
  id: string;
  month: string;
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  kind: string;
  amount: number | null;
  date_from: string | null;
  date_to: string | null;
  doctor_note_verified: boolean | null;
  note: string | null;
  voided_at: string | null;
}

interface ContractDTO {
  id: string;
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  effective_from: string;
  effective_to: string | null;
  monthly_salary: number;
  pay_basis: string;
  daily_rate: number | null;
  rest_day_paid: boolean;
  probation_months: number | null;
  annual_leave_days: number;
  statutory_holiday_paid_from: string;
  mpf_exempt_reason: string;
  source: string;
  note: string | null;
  voided_at: string | null;
}

interface AvgWageDTO {
  id: string;
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  month: string;
  avg_daily_wage: number;
  source: string;
}

interface LeaveBalanceDTO {
  id: string;
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  year: number;
  al_entitled: number;
  al_taken: number;
  al_carry: number;
  sl_accrued: number;
  sl_taken: number;
}

const INPUT_KIND_LABEL: Record<string, string> = {
  special_allowance: "津貼（勤工獎）",
  other_allowance: "其他津貼／賣假／頂位",
  uniform: "制服",
  deduction: "扣款",
  leave: "病假段（4/5 判定，要填開始／結束日）",
  contract_change: "轉約備註",
  leaver_settlement: "離職結算 override",
};

export default function LongtermPayrollPage() {
  const [month, setMonth] = useState(() => addMonthsStr(currentMonthStr(), -1));
  const [payroll, setPayroll] = useState<PayrollMonthDTO | null>(null);
  const [inputs, setInputs] = useState<InputDTO[]>([]);
  const [contracts, setContracts] = useState<ContractDTO[]>([]);
  const [avgWages, setAvgWages] = useState<AvgWageDTO[]>([]);
  const [leaveBalances, setLeaveBalances] = useState<LeaveBalanceDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedGuard, setExpandedGuard] = useState<string | null>(null);
  const [autopayPreview, setAutopayPreview] = useState<{ row_count: number; missing_bank_info: string[] } | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    const [pr, ir, cr, ar, lr] = await Promise.all([
      apiGet<PayrollMonthDTO>(`/api/longterm/payroll/${m}`),
      apiGet<{ rows: InputDTO[] }>(`/api/longterm/inputs?month=${m}-01`),
      apiGet<{ rows: ContractDTO[] }>(`/api/longterm/contracts`),
      apiGet<{ rows: AvgWageDTO[] }>(`/api/longterm/avg-wages?month=${m}-01`),
      apiGet<{ rows: LeaveBalanceDTO[] }>(`/api/longterm/leave-balances?year=${m.slice(0, 4)}`),
    ]);
    if (pr.ok) setPayroll(pr.data);
    else setError(pr.message);
    if (ir.ok) setInputs(ir.data.rows);
    if (cr.ok) setContracts(cr.data.rows);
    if (ar.ok) setAvgWages(ar.data.rows);
    if (lr.ok) setLeaveBalances(lr.data.rows);
    setAutopayPreview(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load(month);
  }, [month, load]);

  async function recompute() {
    setRecomputing(true);
    setError(null);
    setNotice(null);
    const res = await apiPost<{ run_id: string; totals: PayrollMonthDTO["totals"]; warnings: string[] }>(`/api/longterm/payroll/${month}/recompute`);
    if (res.ok) {
      setNotice(`重算完成——${res.data.totals?.guard_count ?? 0} 人${res.data.warnings.length ? `（${res.data.warnings.length} 項警告，見逐人備註）` : ""}`);
      await load(month);
    } else {
      setError(res.message);
    }
    setRecomputing(false);
  }

  async function loadAutopayPreview() {
    const res = await apiGet<{ row_count: number; missing_bank_info: string[] }>(`/api/longterm/payroll/${month}/autopay?preview=1`);
    if (res.ok) setAutopayPreview(res.data);
    else setError(res.message);
  }

  const totals = payroll?.totals;
  const guardOptions = [...new Map(contracts.map((c) => [c.guard_id, c])).values()];

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        kicker="財務"
        title="長工糧"
        subtitle="長工月薪糧——合約管理、逐月計糧、人手輸入、平均工資／假期餘額、BOCHK autopay 檔"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" onClick={() => setMonth(addMonthsStr(month, -1))}>
              ← 上月
            </Button>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={`${inputCls} w-[150px]`} />
            <Button variant="secondary" onClick={() => setMonth(addMonthsStr(month, 1))}>
              下月 →
            </Button>
            <Button variant="primary" onClick={recompute} disabled={recomputing || payroll?.locked}>
              {recomputing ? "重算緊…" : "重算本月"}
            </Button>
          </div>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {payroll?.locked && <Banner kind="info" message={`${month} 已鎖定——人手輸入／合約編輯唯讀，重算掣已停用`} />}

      {loading && <div className="text-sm text-zk-muted">載入緊…</div>}

      {/* ① 總額卡 */}
      {totals && (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-lg border border-zk-border bg-white p-3">
            <div className="text-[11.5px] text-zk-muted">人數</div>
            <div className="text-lg font-bold">{totals.guard_count ?? 0}</div>
          </div>
          <div className="rounded-lg border border-zk-border bg-white p-3">
            <div className="text-[11.5px] text-zk-muted">Gross 合計</div>
            <div className="text-lg font-bold">{fmtMoney(totals.gross_total)}</div>
          </div>
          <div className="rounded-lg border border-zk-border bg-white p-3">
            <div className="text-[11.5px] text-zk-muted">Autopay 合計</div>
            <div className="text-lg font-bold">{fmtMoney(totals.autopay_total)}</div>
          </div>
          <div className="rounded-lg border border-zk-border bg-white p-3">
            <div className="text-[11.5px] text-zk-muted">MPF 僱員</div>
            <div className="text-lg font-bold">{fmtMoney(totals.mpf_ee_total)}</div>
          </div>
          <div className="rounded-lg border border-zk-border bg-white p-3">
            <div className="text-[11.5px] text-zk-muted">MPF 僱主</div>
            <div className="text-lg font-bold">{fmtMoney(totals.mpf_er_total)}</div>
          </div>
        </section>
      )}
      {!payroll?.run && !loading && (
        <EmptyState title={`${month} 未計過長工糧`} description="撳右上角「重算本月」開始計算——會由更表／人手輸入項／合約自動砌出逐人結算行。" />
      )}

      {/* ② 逐人結算表 */}
      {payroll && payroll.lines.length > 0 && (
        <section className="flex flex-col gap-2">
          <div className="text-sm font-semibold text-zk-text">逐人結算（{payroll.lines.length} 人）</div>
          <div className={tableCls.wrap}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(11) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>安員</th>
                  <th className={tableCls.thNum}>返工日</th>
                  <th className={tableCls.thNum}>OT 時數</th>
                  <th className={tableCls.thNum}>Net Basic</th>
                  <th className={tableCls.thNum}>年假薪</th>
                  <th className={tableCls.thNum}>4/5 病假</th>
                  <th className={tableCls.thNum}>Gross</th>
                  <th className={tableCls.thNum}>MPF EE／ER</th>
                  <th className={tableCls.thNum}>Autopay</th>
                  <th className={tableCls.thNum}>同上月比較</th>
                  <th className={tableCls.th}></th>
                </tr>
              </thead>
              <tbody>
                {payroll.lines.map((l) => (
                  <Fragment key={l.id}>
                    <tr className={tableCls.rowHover}>
                      <td className={tableCls.td}>
                        {l.guard_name}
                        {l.guard_staff_no && <span className="ml-1 text-zk-faint">（{l.guard_staff_no}）</span>}
                      </td>
                      <td className={tableCls.tdNum}>{l.work_days}／{l.days_in_month}</td>
                      <td className={tableCls.tdNum}>{l.ot_hours}</td>
                      <td className={tableCls.tdNum}>{fmtMoney(l.net_basic)}</td>
                      <td className={tableCls.tdNum}>{fmtMoney(l.al_payment)}</td>
                      <td className={tableCls.tdNum}>{fmtMoney(l.sl45_amount)}</td>
                      <td className={tableCls.tdNum}>{fmtMoney(l.gross)}</td>
                      <td className={tableCls.tdNum}>
                        {fmtMoney(l.mpf_ee)} / {fmtMoney(l.mpf_er)}
                      </td>
                      <td className={tableCls.tdNum}>{fmtMoney(l.autopay)}</td>
                      <td className={tableCls.tdNum}>
                        {l.autopay_delta === null ? (
                          <span className="text-zk-faint">（冇上月）</span>
                        ) : (
                          <span className={l.autopay_delta === 0 ? "text-zk-faint" : l.autopay_delta > 0 ? "text-emerald-700" : "text-red-600"}>
                            {l.autopay_delta > 0 ? "+" : ""}
                            {fmtMoney(l.autopay_delta)}
                          </span>
                        )}
                      </td>
                      <td className={tableCls.td}>
                        <button className="text-[12px] text-zk-primary underline" onClick={() => setExpandedGuard(expandedGuard === l.id ? null : l.id)}>
                          {expandedGuard === l.id ? "收起" : "逐項來源"}
                        </button>
                      </td>
                    </tr>
                    {expandedGuard === l.id && (
                      <tr>
                        <td colSpan={11} className="border-b border-[#f1f5f9] bg-zk-header px-3.5 py-2.5">
                          <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-zk-text">
                            {l.notes_json.map((note, i) => (
                              <li key={i}>{note}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ③ 人手輸入區 */}
      <InputsSection month={month} inputs={inputs} guardOptions={guardOptions} locked={!!payroll?.locked} onChanged={() => load(month)} onError={setError} />

      {/* ④ 合約管理 */}
      <ContractsSection contracts={contracts} onChanged={() => load(month)} onError={setError} onNotice={setNotice} />

      {/* ⑤ 平均工資／假期餘額 */}
      <AvgWageLeaveBalanceSection month={month} guardOptions={guardOptions} locked={!!payroll?.locked} avgWages={avgWages} leaveBalances={leaveBalances} onChanged={() => load(month)} onError={setError} />

      {/* ⑥ BOCHK autopay 檔 */}
      <section className="flex flex-col gap-2 rounded-lg border border-zk-border bg-white p-4">
        <div className="text-sm font-semibold text-zk-text">BOCHK autopay 檔</div>
        <div className="text-[12px] text-zk-faint">
          格式待銀行核實——公司提供嘅 2026-07 樣本係密碼保護嘅舊版 .xls，未能核實 BOCHK Payroll Editor 實際要求嘅欄位次序。呢度出嘅係
          CSV fallback（bank_code, account_no, payee_name, amount, reference），bank_code 用安員登記嘅銀行名稱頂住。
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={loadAutopayPreview} disabled={!payroll?.run}>
            預覽
          </Button>
          {/* 同頁下載（唔開新 tab）——Content-Disposition: attachment 已經令
              瀏覽器當檔案下載處理，唔會離開現時頁面。 */}
          <a href={`/api/longterm/payroll/${month}/autopay`}>
            <Button variant="primary" disabled={!payroll?.run}>
              下載 CSV
            </Button>
          </a>
        </div>
        {autopayPreview && (
          <div className="text-[12.5px] text-zk-text">
            會有 {autopayPreview.row_count} 行。
            {autopayPreview.missing_bank_info.length > 0 && (
              <span className="text-red-600"> 缺銀行資料，唔會出現喺檔案：{autopayPreview.missing_bank_info.join("、")}</span>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ③ 人手輸入區
// ---------------------------------------------------------------------------
function InputsSection({
  month,
  inputs,
  guardOptions,
  locked,
  onChanged,
  onError,
}: {
  month: string;
  inputs: InputDTO[];
  guardOptions: { guard_id: string; guard_name: string; guard_staff_no: string | null }[];
  locked: boolean;
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [guardId, setGuardId] = useState("");
  const [kind, setKind] = useState("special_allowance");
  const [amount, setAmount] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [doctorNote, setDoctorNote] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!guardId) return onError("要揀安員");
    setSaving(true);
    const res = await apiPost(`/api/longterm/inputs`, {
      month: `${month}-01`,
      guard_id: guardId,
      kind,
      amount: amount ? Number(amount) : undefined,
      date_from: dateFrom || null,
      date_to: dateTo || null,
      doctor_note_verified: kind === "leave" ? doctorNote : undefined,
      note: note || undefined,
    });
    setSaving(false);
    if (res.ok) {
      setAmount("");
      setDateFrom("");
      setDateTo("");
      setNote("");
      onChanged();
    } else {
      onError(res.message);
    }
  }

  async function voidInput(id: string) {
    const res = await apiDelete(`/api/longterm/inputs/${id}`);
    if (res.ok) onChanged();
    else onError((res as { message: string }).message);
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zk-border bg-white p-4">
      <div className="text-sm font-semibold text-zk-text">人手輸入項</div>
      {!locked && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <Field label="安員">
            <select className={selectCls} value={guardId} onChange={(e) => setGuardId(e.target.value)}>
              <option value="">請揀</option>
              {guardOptions.map((g) => (
                <option key={g.guard_id} value={g.guard_id}>
                  {g.guard_name}
                  {g.guard_staff_no ? `（${g.guard_staff_no}）` : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="種類">
            <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(INPUT_KIND_LABEL).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="金額">
            <input className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="正數＝加，deduction 自動當扣" />
          </Field>
          <Field label="開始日（病假段／離職日先要）">
            <input type="date" className={inputCls} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </Field>
          <Field label="結束日">
            <input type="date" className={inputCls} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </Field>
          <Field label="備註">
            <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {kind === "leave" && (
            <label className="col-span-2 flex items-center gap-2 text-[13px] text-zk-text">
              <input type="checkbox" checked={doctorNote} onChange={(e) => setDoctorNote(e.target.checked)} />
              有香港註冊醫生病假紙（已核實）
            </label>
          )}
          <div className="col-span-2 flex items-end">
            <Button variant="primary" onClick={submit} disabled={saving}>
              新增
            </Button>
          </div>
        </div>
      )}
      <div className={tableCls.wrap}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(7) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>安員</th>
              <th className={tableCls.th}>種類</th>
              <th className={tableCls.thNum}>金額</th>
              <th className={tableCls.th}>日期段</th>
              <th className={tableCls.th}>備註</th>
              <th className={tableCls.th}>狀態</th>
              <th className={tableCls.th}></th>
            </tr>
          </thead>
          <tbody>
            {inputs.length === 0 ? (
              <tr>
                <td colSpan={7} className={tableCls.tdMuted}>
                  呢個月未有人手輸入項
                </td>
              </tr>
            ) : (
              inputs.map((i) => (
                <tr key={i.id} className={tableCls.rowHover}>
                  <td className={tableCls.td}>
                    {i.guard_name}
                    {i.guard_staff_no ? `（${i.guard_staff_no}）` : ""}
                  </td>
                  <td className={tableCls.td}>{INPUT_KIND_LABEL[i.kind] ?? i.kind}</td>
                  <td className={tableCls.tdNum}>{i.amount !== null ? fmtMoney(i.amount) : "—"}</td>
                  <td className={tableCls.td}>{i.date_from ? `${fmtDate(i.date_from)}${i.date_to ? `–${fmtDate(i.date_to)}` : ""}` : "—"}</td>
                  <td className={tableCls.td}>{i.note ?? "—"}</td>
                  <td className={tableCls.td}>{i.voided_at ? <Pill variant="neutral">已作廢</Pill> : <Pill variant="success">生效</Pill>}</td>
                  <td className={tableCls.td}>
                    {!i.voided_at && !locked && (
                      <button className="text-[12px] text-red-600 underline" onClick={() => voidInput(i.id)}>
                        作廢
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ④ 合約管理
// ---------------------------------------------------------------------------
function ContractsSection({
  contracts,
  onChanged,
  onError,
  onNotice,
}: {
  contracts: ContractDTO[];
  onChanged: () => void;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState<ContractDTO | null>(null);
  const [editSalary, setEditSalary] = useState("");
  const [editEffectiveTo, setEditEffectiveTo] = useState("");
  const [uploading, setUploading] = useState(false);

  const visible = showHistory ? contracts : contracts.filter((c) => !c.voided_at && (!c.effective_to || c.effective_to >= new Date().toISOString().slice(0, 10)));

  function startEdit(c: ContractDTO) {
    setEditing(c);
    setEditSalary(String(c.monthly_salary));
    setEditEffectiveTo(c.effective_to ?? "");
  }

  async function saveEdit() {
    if (!editing) return;
    const res = await apiPatch(`/api/longterm/contracts/${editing.id}`, {
      monthly_salary: Number(editSalary),
      effective_to: editEffectiveTo || null,
    });
    if (res.ok) {
      setEditing(null);
      onChanged();
    } else {
      onError((res as { message: string }).message);
    }
  }

  async function voidContract(id: string) {
    const res = await apiPatch(`/api/longterm/contracts/${id}`, { voided: true });
    if (res.ok) onChanged();
    else onError((res as { message: string }).message);
  }

  // Opus 5.5 驗收：response 經 camelToSnakeDeep()，key 係 snake_case（原本
  // 讀 camelCase，通知會顯示「undefined 行」）。
  async function uploadMaxwell(fd: FormData) {
    setUploading(true);
    const res = await apiUpload<{
      summary: { total_rows: number; contracts_created: number; contracts_updated: number; unmatched: unknown[]; skipped_manual_contract: unknown[]; warnings: string[] };
    }>("/api/longterm/contracts/import", fd);
    setUploading(false);
    if (res.ok) {
      const sm = res.data.summary;
      onNotice(
        `Maxwell 導入完成：${sm.total_rows} 行，建 ${sm.contracts_created}／更新 ${sm.contracts_updated}` +
          `${sm.unmatched.length ? `，${sm.unmatched.length} 行對唔到安員（要人手配對）` : ""}` +
          `${sm.skipped_manual_contract.length ? `，${sm.skipped_manual_contract.length} 人已有人手合約冇覆蓋` : ""}` +
          `${sm.warnings.length ? `。注意：${sm.warnings.join("；")}` : ""}`,
      );
      onChanged();
    } else {
      onError(res.message);
    }
  }
  const [activeCsv, setActiveCsv] = useState<File | null>(null);
  const [leftCsv, setLeftCsv] = useState<File | null>(null);
  function uploadMaxwellCsv() {
    if (!activeCsv && !leftCsv) return onError("揀至少一個 CSV（在職名單／離職名單）");
    const fd = new FormData();
    if (activeCsv) fd.append("active_csv", activeCsv);
    if (leftCsv) fd.append("left_csv", leftCsv);
    void uploadMaxwell(fd).then(() => {
      setActiveCsv(null);
      setLeftCsv(null);
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zk-border bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold text-zk-text">合約管理</div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-[12.5px] text-zk-muted">
            <input type="checkbox" checked={showHistory} onChange={(e) => setShowHistory(e.target.checked)} />
            顯示歷史／已作廢
          </label>
          <label className="cursor-pointer">
            <span className="rounded-md border border-[#d1d5db] bg-white px-3.5 py-[7px] text-[13px] text-[#334155] hover:bg-zk-header">
              {uploading ? "上載緊…" : "Maxwell 導入（xlsx）"}
            </span>
            <input
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  const fd = new FormData();
                  fd.append("file", f);
                  void uploadMaxwell(fd);
                }
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2 rounded border border-dashed border-zk-border p-2 text-[12.5px] text-zk-muted">
        <div className="w-full">Maxwell 導入（CSV）：喺 Excel 分別打開「在職名單」同「離職名單」分頁，「另存新檔 → CSV UTF-8」，兩個檔一齊上載。</div>
        <label className="flex flex-col gap-1">
          在職名單 CSV
          <input type="file" accept=".csv,text/csv" data-testid="maxwell-active-csv" onChange={(e) => setActiveCsv(e.target.files?.[0] ?? null)} />
        </label>
        <label className="flex flex-col gap-1">
          離職名單 CSV
          <input type="file" accept=".csv,text/csv" data-testid="maxwell-left-csv" onChange={(e) => setLeftCsv(e.target.files?.[0] ?? null)} />
        </label>
        <Button variant="secondary" onClick={uploadMaxwellCsv} disabled={uploading || (!activeCsv && !leftCsv)}>
          {uploading ? "上載緊…" : "導入 CSV"}
        </Button>
      </div>
      <div className={tableCls.wrap}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(8) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>安員</th>
              <th className={tableCls.th}>生效區間</th>
              <th className={tableCls.thNum}>月薪</th>
              <th className={tableCls.th}>計薪基礎</th>
              <th className={tableCls.th}>年假日</th>
              <th className={tableCls.th}>來源</th>
              <th className={tableCls.th}>狀態</th>
              <th className={tableCls.th}></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={8} className={tableCls.tdMuted}>
                  未有合約——用「Maxwell 導入」或者呼叫 POST /api/longterm/contracts 新增
                </td>
              </tr>
            ) : (
              visible.map((c) => (
                <tr key={c.id} className={tableCls.rowHover}>
                  <td className={tableCls.td}>
                    {c.guard_name}
                    {c.guard_staff_no ? `（${c.guard_staff_no}）` : ""}
                  </td>
                  <td className={tableCls.td}>
                    {fmtDate(c.effective_from)} → {c.effective_to ? fmtDate(c.effective_to) : "現在"}
                  </td>
                  <td className={tableCls.tdNum}>{c.pay_basis === "daily" ? `${fmtMoney(c.daily_rate)}／更` : fmtMoney(c.monthly_salary)}</td>
                  <td className={tableCls.td}>{c.pay_basis === "daily" ? "日薪制" : "月薪制"}</td>
                  <td className={tableCls.tdNum}>{c.annual_leave_days}</td>
                  <td className={tableCls.td}>{c.source === "maxwell_import" ? "Maxwell" : "人手"}</td>
                  <td className={tableCls.td}>{c.voided_at ? <Pill variant="neutral">已作廢</Pill> : <Pill variant="success">生效</Pill>}</td>
                  <td className={tableCls.td}>
                    {!c.voided_at && (
                      <div className="flex gap-2">
                        <button className="text-[12px] text-zk-primary underline" onClick={() => startEdit(c)}>
                          編輯
                        </button>
                        <button className="text-[12px] text-red-600 underline" onClick={() => voidContract(c.id)}>
                          作廢
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <div className="flex flex-wrap items-end gap-3 rounded border border-zk-border bg-zk-header p-3">
          <div className="text-[13px] font-medium">
            編輯：{editing.guard_name}
            {editing.guard_staff_no ? `（${editing.guard_staff_no}）` : ""}
          </div>
          <Field label="月薪">
            <input className={inputCls} value={editSalary} onChange={(e) => setEditSalary(e.target.value)} />
          </Field>
          <Field label="終止日（留空＝仲生效）">
            <input type="date" className={inputCls} value={editEffectiveTo} onChange={(e) => setEditEffectiveTo(e.target.value)} />
          </Field>
          <Button variant="primary" onClick={saveEdit}>
            儲存
          </Button>
          <Button variant="secondary" onClick={() => setEditing(null)}>
            取消
          </Button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ⑤ 平均工資／假期餘額
// ---------------------------------------------------------------------------
function AvgWageLeaveBalanceSection({
  month,
  guardOptions,
  locked,
  avgWages,
  leaveBalances,
  onChanged,
  onError,
}: {
  month: string;
  guardOptions: Array<{ guard_id: string; guard_name: string; guard_staff_no: string | null }>;
  locked: boolean;
  avgWages: AvgWageDTO[];
  leaveBalances: LeaveBalanceDTO[];
  onChanged: () => void;
  onError: (m: string) => void;
}) {
  const [editingBalance, setEditingBalance] = useState<LeaveBalanceDTO | null>(null);
  // Opus 5.5 驗收：平均工資原本淨係有 API 冇輸入位——正式站 8 月 3 位離職者
  // 補年假／病假 4/5 要用 7 月計糧表「平均工資」，冇位入就會 fallback 日薪。
  const [awGuardId, setAwGuardId] = useState("");
  const [awValue, setAwValue] = useState("");
  const [awSource, setAwSource] = useState("");
  async function saveAvgWage() {
    if (!awGuardId || !awValue) return onError("要揀安員同填平均日薪");
    const res = await apiPost(`/api/longterm/avg-wages`, { guard_id: awGuardId, month: `${month}-01`, avg_daily_wage: Number(awValue), source: awSource || "人手輸入（計糧表平均工資）" });
    if (res.ok) {
      setAwValue("");
      setAwSource("");
      onChanged();
    } else onError((res as { message: string }).message);
  }
  const [alTaken, setAlTaken] = useState("");
  const [slTaken, setSlTaken] = useState("");
  const [slAccrued, setSlAccrued] = useState("");

  function startEdit(b: LeaveBalanceDTO) {
    setEditingBalance(b);
    setAlTaken(String(b.al_taken));
    setSlTaken(String(b.sl_taken));
    setSlAccrued(String(b.sl_accrued));
  }

  async function saveBalance() {
    if (!editingBalance) return;
    const res = await apiPatch(`/api/longterm/leave-balances/${editingBalance.id}`, {
      al_taken: Number(alTaken),
      sl_taken: Number(slTaken),
      sl_accrued: Number(slAccrued),
    });
    if (res.ok) {
      setEditingBalance(null);
      onChanged();
    } else {
      onError((res as { message: string }).message);
    }
  }

  return (
    <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-2 rounded-lg border border-zk-border bg-white p-4">
        <div className="text-sm font-semibold text-zk-text">平均工資（呢個月）</div>
        <div className="text-[11.5px] text-zk-faint">SL 4/5／AL 離職結算派彩優先讀呢張表，冇記錄先 fallback 日薪；同一人同月再入會覆蓋</div>
        {!locked && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Field label="安員">
              <select className={selectCls} value={awGuardId} onChange={(e) => setAwGuardId(e.target.value)}>
                <option value="">請揀</option>
                {guardOptions.map((g) => (
                  <option key={g.guard_id} value={g.guard_id}>
                    {g.guard_name}
                    {g.guard_staff_no ? `（${g.guard_staff_no}）` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="平均日薪">
              <input className={inputCls} inputMode="decimal" value={awValue} onChange={(e) => setAwValue(e.target.value)} />
            </Field>
            <Field label="來源">
              <input className={inputCls} value={awSource} onChange={(e) => setAwSource(e.target.value)} placeholder="例：7 月計糧表平均工資" />
            </Field>
            <div className="flex items-end">
              <Button variant="primary" onClick={saveAvgWage}>
                儲存
              </Button>
            </div>
          </div>
        )}
        <div className={tableCls.wrap}>
          <table className={tableCls.table} style={{ minWidth: tableMinWidth(3) }}>
            <thead>
              <tr>
                <th className={tableCls.th}>安員</th>
                <th className={tableCls.thNum}>平均日薪</th>
                <th className={tableCls.th}>來源</th>
              </tr>
            </thead>
            <tbody>
              {avgWages.length === 0 ? (
                <tr>
                  <td colSpan={3} className={tableCls.tdMuted}>
                    冇記錄——fallback 用日薪
                  </td>
                </tr>
              ) : (
                avgWages.map((w) => (
                  <tr key={w.id} className={tableCls.rowHover}>
                    <td className={tableCls.td}>
                      {w.guard_name}
                      {w.guard_staff_no ? `（${w.guard_staff_no}）` : ""}
                    </td>
                    <td className={tableCls.tdNum}>{fmtMoney(w.avg_daily_wage)}</td>
                    <td className={tableCls.td}>{w.source}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-zk-border bg-white p-4">
        <div className="text-sm font-semibold text-zk-text">假期餘額（今年）</div>
        <div className={tableCls.wrap}>
          <table className={tableCls.table} style={{ minWidth: tableMinWidth(5) }}>
            <thead>
              <tr>
                <th className={tableCls.th}>安員</th>
                <th className={tableCls.thNum}>AL 已放（累積）</th>
                <th className={tableCls.thNum}>SL 已放 4/5（累積）</th>
                <th className={tableCls.thNum}>SL 結餘</th>
                <th className={tableCls.th}></th>
              </tr>
            </thead>
            <tbody>
              {leaveBalances.length === 0 ? (
                <tr>
                  <td colSpan={5} className={tableCls.tdMuted}>
                    冇記錄——重算本月後自動寫回
                  </td>
                </tr>
              ) : (
                leaveBalances.map((b) => (
                  <tr key={b.id} className={tableCls.rowHover}>
                    <td className={tableCls.td}>
                      {b.guard_name}
                      {b.guard_staff_no ? `（${b.guard_staff_no}）` : ""}
                    </td>
                    <td className={tableCls.tdNum}>{b.al_taken}</td>
                    <td className={tableCls.tdNum}>{b.sl_taken}</td>
                    <td className={tableCls.tdNum}>{b.sl_accrued}</td>
                    <td className={tableCls.td}>
                      <button className="text-[12px] text-zk-primary underline" onClick={() => startEdit(b)}>
                        人手覆核
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {editingBalance && (
          <div className="flex flex-wrap items-end gap-3 rounded border border-zk-border bg-zk-header p-3">
            <div className="text-[13px] font-medium">
              {editingBalance.guard_name}
              {editingBalance.guard_staff_no ? `（${editingBalance.guard_staff_no}）` : ""}
            </div>
            <div className="w-full text-[11.5px] text-zk-muted">改「已放」＝設定開波數（計到下次重算嗰個月之前，唔包嗰個月），儲存後撳「重算本月」先生效。</div>
            <Field label="AL 已放（開波）">
              <input className={inputCls} value={alTaken} onChange={(e) => setAlTaken(e.target.value)} />
            </Field>
            <Field label="SL 已放 4/5（開波）">
              <input className={inputCls} value={slTaken} onChange={(e) => setSlTaken(e.target.value)} />
            </Field>
            <Field label="SL 結餘">
              <input className={inputCls} value={slAccrued} onChange={(e) => setSlAccrued(e.target.value)} />
            </Field>
            <Button variant="primary" onClick={saveBalance}>
              儲存
            </Button>
            <Button variant="secondary" onClick={() => setEditingBalance(null)}>
              取消
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
