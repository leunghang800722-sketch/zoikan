"use client";
// P9.1：長工糧「人手輸入」tab 頂部兩個面板——① 草稿列表（更表 SL 自動生成，未確認唔計糧；逐條確認／改咗再確認／刪除；
// 「全部確認」5 秒撤銷）；② 勤工獎合資格清單（只列名，唔填金額）。姓名只喺本頁顯示，通知唔含。
import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { UndoBar } from "@/components/ui/UndoBar";
import { inputCls } from "@/components/ui/Field";
import { tableCls, tableMinWidth, TableEmptyRow } from "@/components/ui/DataTable";
import { DEFERRED_UNDO_MS } from "@/components/month-close/deferred";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/ui/api-client";
import { fmtDate } from "@/lib/ui/format";

export interface DraftInputDTO {
  id: string;
  guard_name: string;
  guard_staff_no: string | null;
  kind: string;
  amount?: number | null;
  date_from: string | null;
  date_to: string | null;
  doctor_note_verified: boolean | null;
  note: string | null;
  draft_source: string | null;
  draft_evidence: { dates?: string[]; edited?: boolean; shifts?: number } | null;
}

const CHUNK = 50;
const SOURCE_LABEL: Record<string, string> = { "roster_leave:SL": "更表 SL", "cover:rates": "頂位價目表" };
const isCover = (d: DraftInputDTO): boolean => d.draft_source === "cover:rates";

export function DraftInputsPanel({ drafts, locked, onChanged, onError }: { drafts: DraftInputDTO[]; locked: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [doctor, setDoctor] = useState(false);
  const [amt, setAmt] = useState("");
  const [deadline, setDeadline] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string[]>([]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function confirmOne(id: string) {
    const res = await apiPatch(`/api/longterm/inputs/${id}`, { status: "confirmed" });
    if (res.ok) onChanged();
    else onError(res.message);
  }
  async function editAndConfirm(id: string) {
    const d = drafts.find((x) => x.id === id);
    const body = d && isCover(d) ? { amount: Number(amt), status: "confirmed" } : { date_from: from || null, date_to: to || null, doctor_note_verified: doctor, status: "confirmed" };
    if (d && isCover(d) && !(Number(amt) > 0)) return onError("金額要大過 0");
    const res = await apiPatch(`/api/longterm/inputs/${id}`, body);
    if (res.ok) {
      setEditingId(null);
      onChanged();
    } else onError(res.message);
  }
  async function remove(id: string) {
    const res = await apiDelete(`/api/longterm/inputs/${id}`);
    if (res.ok) onChanged();
    else onError((res as { message: string }).message);
  }

  const send = useCallback(async () => {
    timer.current = null;
    setDeadline(null);
    setSending(true);
    let confirmed = 0;
    let skipped = 0;
    for (let i = 0; i < pending.current.length; i += CHUNK) {
      const res = await apiPost<{ counts: { confirmed: number; skipped: number } }>("/api/longterm/inputs/confirm-batch", { ids: pending.current.slice(i, i + CHUNK) });
      if (!res.ok) {
        onError(res.message);
        break;
      }
      confirmed += res.data.counts.confirmed;
      skipped += res.data.counts.skipped;
    }
    setSending(false);
    setSummary(`已確認 ${confirmed} 條${skipped ? `、跳過 ${skipped} 條` : ""}`);
    onChanged();
  }, [onChanged, onError]);

  const confirmAll = () => {
    pending.current = drafts.map((d) => d.id);
    if (pending.current.length === 0) return;
    setSummary(null);
    setDeadline(Date.now() + DEFERRED_UNDO_MS);
    timer.current = setTimeout(() => void send(), DEFERRED_UNDO_MS);
  };
  const undo = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setDeadline(null);
  };

  if (drafts.length === 0 && !summary) return null;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-zk-border bg-white p-4" data-testid="ltpay-drafts">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-zk-text">草稿（{drafts.length}）</div>
        <Pill variant="warning">草稿未確認唔計糧</Pill>
        {!locked && drafts.length > 0 && deadline === null && !sending && (
          <Button variant="primary" size="sm" className="ml-auto" onClick={confirmAll} data-testid="ltpay-drafts-confirm-all">
            全部確認（{drafts.length}）
          </Button>
        )}
      </div>
      <Banner kind="info">呢啲係由更表自動生成嘅草稿：頂位津貼按「設定 › 頂位價目表」逐更價計出金額。確認後先計入長工糧，確認前對 Gross 完全冇影響。</Banner>
      {deadline !== null && <UndoBar message={`即將確認 ${pending.current.length} 條草稿`} deadline={deadline} onUndo={undo} testId="ltpay-drafts-undo-bar" />}
      {sending && <div className="text-zk-sm text-zk-muted">批量確認中…</div>}
      {summary && (
        <div className="text-zk-sm font-semibold text-zk-text" data-testid="ltpay-drafts-summary">
          {summary}
        </div>
      )}
      <div className={tableCls.wrap}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(5) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>保安員</th>
              <th className={tableCls.th}>來源</th>
              <th className={tableCls.th}>日期段</th>
              <th className={tableCls.th}>醫生紙</th>
              <th className={tableCls.th}></th>
            </tr>
          </thead>
          <tbody>
            {drafts.length === 0 ? (
              <TableEmptyRow colSpan={5}>冇草稿</TableEmptyRow>
            ) : (
              drafts.map((d) => (
                <tr key={d.id} className={tableCls.rowHover} data-testid="ltpay-draft-row">
                  <td className={tableCls.td}>
                    {d.guard_name}
                    {d.guard_staff_no ? `（${d.guard_staff_no}）` : ""}
                  </td>
                  <td className={tableCls.td}>
                    <Pill variant="warning">草稿</Pill> {SOURCE_LABEL[d.draft_source ?? ""] ?? d.draft_source ?? "—"}
                    {d.draft_evidence?.edited ? "（已改）" : ""}
                  </td>
                  <td className={tableCls.td}>
                    {isCover(d) ? (
                      editingId === d.id ? (
                        <input type="number" min="0" step="0.01" className={inputCls} value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="頂位津貼金額" data-testid="ltpay-draft-amount-input" />
                      ) : (
                        <span data-testid="ltpay-draft-cover-amount">頂位津貼 ${d.amount ?? 0}（{d.draft_evidence?.shifts ?? 0} 更）</span>
                      )
                    ) : editingId === d.id ? (
                      <span className="flex flex-wrap items-center gap-1">
                        <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="開始日" />
                        <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} aria-label="結束日" />
                      </span>
                    ) : d.date_from ? (
                      `${fmtDate(d.date_from)}${d.date_to && d.date_to !== d.date_from ? `–${fmtDate(d.date_to)}` : ""}`
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={tableCls.td}>
                    {isCover(d) ? (
                      "—"
                    ) : editingId === d.id ? (
                      <label className="flex items-center gap-1 text-zk-sm">
                        <input type="checkbox" checked={doctor} onChange={(e) => setDoctor(e.target.checked)} />
                        已核實
                      </label>
                    ) : d.doctor_note_verified ? (
                      "已核實"
                    ) : (
                      "未核"
                    )}
                  </td>
                  <td className={tableCls.td}>
                    {!locked && (
                      <span className="flex flex-wrap items-center gap-2">
                        {editingId === d.id ? (
                          <>
                            <Button variant="primary" size="sm" onClick={() => editAndConfirm(d.id)} data-testid="ltpay-draft-save-confirm">
                              儲存並確認
                            </Button>
                            <Button variant="link" size="sm" onClick={() => setEditingId(null)}>
                              取消
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button variant="primary" size="sm" onClick={() => confirmOne(d.id)} data-testid="ltpay-draft-confirm">
                              確認
                            </Button>
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => {
                                setEditingId(d.id);
                                setFrom(d.date_from ?? "");
                                setTo(d.date_to ?? "");
                                setDoctor(!!d.doctor_note_verified);
                                setAmt(String(d.amount ?? ""));
                              }}
                              data-testid="ltpay-draft-edit"
                            >
                              改咗再確認
                            </Button>
                            <Button variant="linkDanger" size="sm" onClick={() => remove(d.id)} data-testid="ltpay-draft-delete">
                              刪除
                            </Button>
                          </>
                        )}
                      </span>
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

interface EligibleRow {
  guard_id: string;
  guard_name: string;
  guard_staff_no: string | null;
  already_filled: boolean;
}

export function BonusEligiblePanel({ month, refreshKey }: { month: string; refreshKey: number }) {
  const [rows, setRows] = useState<EligibleRow[] | null>(null);
  useEffect(() => {
    let alive = true;
    void apiGet<{ eligible: EligibleRow[] }>(`/api/longterm/attendance-bonus-eligible?month=${month}-01`).then((r) => {
      if (alive) setRows(r.ok ? r.data.eligible : null);
    });
    return () => {
      alive = false;
    };
  }, [month, refreshKey]);
  if (!rows) return null;
  const open = rows.filter((r) => !r.already_filled);
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-zk-border bg-white p-4" data-testid="ltpay-bonus-eligible">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-zk-text">勤工獎合資格清單（{rows.length} 人，未填 {open.length} 人）</div>
        <Pill variant="neutral">只列名，唔填金額</Pill>
      </div>
      <p className="text-zk-sm text-zk-muted">規則：該月更表冇 SL、NL／NPL。系統冇遲到紀錄，遲到要會計自己核對。中途入職／離職未排除，請自行判斷。金額請用下面「新增」揀「津貼」人手填。</p>
      {rows.length === 0 ? (
        <div className="text-zk-sm text-zk-muted">呢個月冇合資格人選</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {rows.map((r) => (
            <span key={r.guard_id} className="rounded-full border border-zk-border-soft px-2.5 py-0.5 text-zk-sm" data-testid="ltpay-bonus-chip">
              {r.guard_name}
              {r.guard_staff_no ? `（${r.guard_staff_no}）` : ""}
              {r.already_filled ? " ✓已填" : ""}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export interface SlPendingSegmentDTO {
  id: string;
  guard_name: string;
  guard_staff_no: string | null;
  date_from: string;
  date_to: string;
  roster_days: number;
  span_days: number;
  meets_consecutive: boolean;
  balance: number;
  within_balance: boolean;
  expected_amount: number | null;
  expected_note: string;
}

/** P17（老闆 2026-10-14）：病假「更表有 SL 就一定要人手確認醫生紙先出 4/5 津貼」。逐段決定，唔提供「全部確認」。 */
export function SlConfirmPanel({ month, locked, refreshKey, focus, onChanged, onError, onNotice }: { month: string; locked: boolean; refreshKey: number; focus: boolean; onChanged: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [segments, setSegments] = useState<SlPendingSegmentDTO[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unpaidId, setUnpaidId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const ref = useRef<HTMLElement | null>(null);
  const scrolled = useRef(false);

  const load = useCallback(async () => {
    const r = await apiGet<{ segments: SlPendingSegmentDTO[] }>(`/api/longterm/inputs/sl-pending?month=${month}`);
    setSegments(r.ok ? r.data.segments : null);
  }, [month]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    if (focus && segments && segments.length > 0 && !scrolled.current) {
      scrolled.current = true;
      ref.current?.scrollIntoView({ block: "start" });
    }
  }, [focus, segments]);

  async function decide(id: string, decision: "confirm" | "unpaid") {
    setBusyId(id);
    const res = await apiPost(`/api/longterm/inputs/${id}/sl-decision`, decision === "unpaid" ? { decision, reason: reason.trim() || undefined } : { decision });
    setBusyId(null);
    if (!res.ok) return onError(res.message);
    setUnpaidId(null);
    setReason("");
    onNotice(decision === "confirm" ? "已確認醫生紙——撳「重算本月」睇 4/5 津貼金額" : "已記低「冇醫生紙，當無薪」——撳「重算本月」睇扣款");
    await load();
    onChanged();
  }

  if (!segments || segments.length === 0) return null;
  return (
    <section ref={ref} id="sl-drafts" className={`flex flex-col gap-3 rounded-lg border bg-white p-4 ${focus ? "border-zk-danger" : "border-zk-border"}`} data-testid="ltpay-sl-panel">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-semibold text-zk-text">病假要你確認醫生紙（{segments.length} 段）</div>
        <Pill variant="warning">未確認唔出津貼，一律當無薪</Pill>
      </div>
      <Banner kind="info">更表有 SL 嘅日子，要你逐段確認有冇香港註冊醫生病假紙先會出 4/5 津貼；系統唔會自動幫你決定。已確認嘅段，連續未夠 4 日都照出（公司做法），但仍受病假結餘限制。</Banner>
      <div className={tableCls.wrap}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(5) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>保安員</th>
              <th className={tableCls.th}>日期段</th>
              <th className={tableCls.th}>連續／結餘</th>
              <th className={tableCls.th}>確認後預計津貼</th>
              <th className={tableCls.th}></th>
            </tr>
          </thead>
          <tbody>
            {segments.map((d) => (
              <tr key={d.id} className={tableCls.rowHover} data-testid="ltpay-sl-row">
                <td className={tableCls.td}>
                  {d.guard_name}
                  {d.guard_staff_no ? `（${d.guard_staff_no}）` : ""}
                </td>
                <td className={tableCls.td}>
                  {fmtDate(d.date_from)}
                  {d.date_to !== d.date_from ? `–${fmtDate(d.date_to)}` : ""}（SL {d.roster_days} 日）
                </td>
                <td className={tableCls.td}>
                  <span data-testid="ltpay-sl-span">連續 {d.span_days} 日</span>{" "}
                  {d.meets_consecutive ? <Pill variant="neutral">夠 4 日</Pill> : <Pill variant="warning">未夠 4 日（公司做法照出）</Pill>}
                  <div className="text-zk-xs text-zk-muted">結餘 {d.balance} 日{d.within_balance ? "" : "（唔夠）"}</div>
                </td>
                <td className={tableCls.td}>
                  <span data-testid="ltpay-sl-expected">{d.expected_amount == null ? "—" : `$${d.expected_amount.toFixed(2)}`}</span>
                  <div className="text-zk-xs text-zk-muted">{d.expected_note}</div>
                </td>
                <td className={tableCls.td}>
                  {!locked &&
                    (unpaidId === d.id ? (
                      <span className="flex flex-wrap items-center gap-2">
                        <input className={inputCls} placeholder="原因（可留空＝冇醫生紙）" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="當無薪原因" data-testid="ltpay-sl-unpaid-reason" />
                        <Button variant="linkDanger" size="sm" disabled={busyId === d.id} onClick={() => decide(d.id, "unpaid")} data-testid="ltpay-sl-unpaid-go">
                          確定當無薪
                        </Button>
                        <Button variant="link" size="sm" onClick={() => setUnpaidId(null)}>
                          取消
                        </Button>
                      </span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-2">
                        <Button variant="primary" size="sm" disabled={busyId === d.id} onClick={() => decide(d.id, "confirm")} data-testid="ltpay-sl-confirm">
                          有醫生紙，確認
                        </Button>
                        <Button
                          variant="linkDanger"
                          size="sm"
                          disabled={busyId === d.id}
                          onClick={() => {
                            setUnpaidId(d.id);
                            setReason("");
                          }}
                          data-testid="ltpay-sl-unpaid"
                        >
                          冇醫生紙，當無薪
                        </Button>
                      </span>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
