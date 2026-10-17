"use client";
// W2：WhatsApp 報更分診 dialog（sourceType="whatsapp"）。一次一題：原話＋群名＋時間＋發訊人 → 候選一鍵揀 → 預覽影響 → 確認寫入（待批核）。
// 手機（375px）全寬 bottom sheet，內容 break-words，唔橫向捲動。API 同其他分診一致：
//   GET /api/triage/sessions/:id、POST /api/triage/questions/:id/preview|answer。
import { useEffect, useMemo, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { choiceBtn } from "@/components/ui/button-classes";
import { apiPost, apiRequest, type ApiListResult } from "@/lib/ui/api-client";
import { useTriagePager } from "@/lib/ui/use-triage-pager";
import { useHistoryOverlay } from "@/lib/ui/use-history-overlay";

interface WaOption {
  id: string;
  label: string;
  hint?: string;
  input?: "text" | "hkid" | "guard_search" | "date";
  guard_id?: string;
  site_id?: string;
  date?: string;
}
interface WaQuestion {
  id: string;
  kind: string;
  kind_label: string;
  title: string;
  status: string;
  options: WaOption[];
  restricted: boolean;
  wa: {
    round: number;
    text: string | null;
    text_redacted: boolean;
    group_label: string;
    sent_at: string;
    sender: string;
    source_changed: boolean;
    source_revoked: boolean;
    reasons: string[];
    notes: string[];
    intent: { kind: string; work_date: string | null; site_name: string | null; guard_name: string | null; shift_code: string | null; leave_code: string | null; confidence: number | null };
    raw: { person: string | null; site: string | null; date: string | null; shift: string | null; leave: string | null } | null;
    guard_candidates: Array<{ guard_id: string; name_zh: string; name_en: string | null; staff_numbers: string[]; recent_sites: Array<{ name: string; last_date: string }>; recent_here: boolean }>;
    site_options: Array<{ id: string; name: string }>;
    date_candidates: string[];
    existing: Array<{ id: string; site_name: string; shift_code: string; record_type: string; leave_code: string | null; status: string }>;
    can_remember_alias: boolean;
    manual_href: string | null;
  };
}
interface Impact {
  can_confirm: boolean;
  summary: string[];
  changes: Array<{ label: string; fields: Array<{ label: string; from: string | null; to: string }> }>;
  notes: string[];
}

const REASON_LABEL: Record<string, string> = {
  site_ambiguous: "盤口唔肯定",
  person_ambiguous: "人名對到多位保安員",
  person_unknown: "搵唔到呢位保安員",
  date_missing: "冇講日子",
  date_unparseable: "睇唔明日子",
  date_ambiguous: "日子有幾個可能",
  date_out_of_range: "日子太遠／太舊",
  conflict_leave: "當日已經有請假",
  conflict_other_shift: "當日已經有另一更",
  conflict_shift_vs_leave: "當日已經有排更",
  slot_full: "該更人手已滿",
  quota_full: "超過配額",
  month_locked: "月份已鎖定",
  low_confidence: "AI 信心偏低",
  daily_cap: "呢個群今日自動寫入已達上限",
  auto_disabled: "自動寫入總開關已關",
  duplicate_recent: "5 分鐘內重覆",
  type_not_auto: "替更／取消，首階段要人手",
  unclear: "未能理解",
  shift_unmapped: "唔知係邊一更",
  shift_ambiguous: "更種有幾個可能",
  leave_code_unclear: "請假類別唔清",
  leave_ambiguous: "請假類別唔清",
  leave_unmapped: "請假類別唔清",
};
const INTENT_LABEL: Record<string, string> = { shift: "報更", leave: "請假", cover: "替更", cancel: "取消", unclear: "未明", question_only: "查詢" };
const NO_WRITE = new Set(["wa_ignore", "wa_keep_old", "wa_manual"]);

function GuardSearch({ onPick }: { onPick: (g: { id: string; name: string } | null) => void }) {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<{ id: string; name_zh: string; name_en: string | null; staff_numbers?: { number: string }[]; status?: string }[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const t = term.trim();
    if (t.length < 2) {
      setRows([]);
      return;
    }
    const h = setTimeout(() => {
      void apiRequest<ApiListResult<{ id: string; name_zh: string; name_en: string | null; staff_numbers?: { number: string }[]; status?: string }>>("/api/guards?take=10&include_inactive=1", { headers: { "x-guard-search": encodeURIComponent(t) } }).then((r) => setRows(r.ok ? r.data.rows : []));
    }, 250);
    return () => clearTimeout(h);
  }, [term]);
  return (
    <span className="mt-1.5 block space-y-1" data-testid="wa-guard-search">
      <input className="w-full rounded-[5px] border border-zk-border px-2 py-1.5" placeholder="輸入姓名／工號／電話搜尋" value={term} aria-label="搜尋保安員" onChange={(e) => { setTerm(e.target.value); setPicked(null); onPick(null); }} />
      {rows.map((r) => (
        <button key={r.id} type="button" className={choiceBtn(picked === r.id, "block w-full text-left break-words")} onClick={() => { setPicked(r.id); onPick({ id: r.id, name: r.name_zh }); }}>
          {r.name_zh}
          {r.name_en ? <span className="ml-1 text-zk-faint">{r.name_en}</span> : null}
          {r.staff_numbers?.length ? <span className="ml-1 text-zk-faint">{r.staff_numbers.map((n) => n.number).join("、")}</span> : null}
          {r.status && r.status !== "active" ? <span className="ml-1 text-zk-warning">（非在職）</span> : null}
        </button>
      ))}
    </span>
  );
}

function hkTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
}

export function WhatsappTriageDialog({ sessionId, onClose, onChanged, focusQuestionId = null }: { sessionId: string; onClose: () => void; onChanged?: () => void; focusQuestionId?: string | null }) {
  const pager = useTriagePager<WaQuestion>(sessionId, { status: "open" });
  const { reload } = pager;
  const { close } = useHistoryOverlay(true, onClose, `wa-triage-${sessionId}`);
  const [handled, setHandled] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pickedGuard, setPickedGuard] = useState<{ id: string; name: string } | null>(null);
  const [dateText, setDateText] = useState("");
  const [remember, setRemember] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void reload();
  }, [reload]);

  const items = useMemo(() => {
    const list = (pager.items ?? []).filter((x) => !handled.includes(x.id));
    if (!focusQuestionId) return list;
    return [...list].sort((a, b) => Number(b.id === focusQuestionId) - Number(a.id === focusQuestionId));
  }, [pager.items, handled, focusQuestionId]);
  const q = items[0] ?? null;
  const loading = pager.items === null;

  // 換題時重置作答狀態
  useEffect(() => {
    setSelected(null);
    setPickedGuard(null);
    setDateText(q?.wa.date_candidates[0] ?? "");
    setRemember(false);
    setImpact(null);
    setHash(null);
    setError(null);
  }, [q?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const opts = q ? q.options.filter((o) => o.id !== "skip") : [];
  const opt = selected !== null ? opts[selected] : null;

  function buildAnswer(): Record<string, unknown> | null {
    if (!opt) return null;
    if (opt.id === "wa_pick_guard") {
      const gid = opt.guard_id ?? pickedGuard?.id;
      if (!gid) return null;
      return { option: opt.id, guard_id: gid, ...(remember ? { remember_alias: true } : {}) };
    }
    if (opt.id === "wa_pick_site") return opt.site_id ? { option: opt.id, site_id: opt.site_id } : null;
    if (opt.id === "wa_set_date") {
      const v = opt.date ?? dateText.trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { option: opt.id, value: v } : null;
    }
    return { option: opt.id };
  }
  const answer = buildAnswer();
  const noWrite = !!opt && NO_WRITE.has(opt.id);

  async function onPreview() {
    if (!q || !answer) return;
    setBusy(true);
    setError(null);
    const r = await apiPost<{ preview_hash: string; writes: boolean; impact: Impact }>(`/api/triage/questions/${q.id}/preview`, { answer });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      setImpact(null);
      setHash(null);
      return;
    }
    setImpact(r.data.impact);
    setHash(r.data.preview_hash);
  }

  async function submit(body: Record<string, unknown>, manualHref: string | null) {
    if (!q) return;
    setBusy(true);
    setError(null);
    const r = await apiPost<{ status: string; impact: Impact | null; result: Record<string, unknown>; note: string | null }>(`/api/triage/questions/${q.id}/answer`, body);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      if (r.status === 409) {
        setImpact(null);
        setHash(null);
      }
      return;
    }
    const nextQ = typeof r.data.result?.next_question_id === "string";
    setNotice(r.data.status === "skipped" ? "已跳過，留返人手" : `${r.data.impact?.summary[0] ?? "已處理"}${r.data.note ? `——${r.data.note}` : ""}${nextQ ? "（下一條題已開）" : ""}`);
    setHandled((h) => [...h, q.id]);
    onChanged?.();
    if (r.data.result?.manual && manualHref) window.open(manualHref, "_blank", "noopener");
    void reload();
  }

  const onConfirm = () => {
    if (!answer || !q) return;
    void submit(noWrite ? { answer } : { answer, preview_hash: hash }, q.wa.manual_href);
  };
  const onSkip = () => {
    if (!q) return;
    void submit({ answer: { option: "skip" } }, null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="WhatsApp 報更待答問題" data-testid="wa-triage-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:max-w-xl sm:rounded-xl">
        <div className="flex items-start gap-2 border-b border-zk-border px-3 py-3">
          <Button variant="secondary" size="sm" type="button" onClick={close} data-testid="wa-triage-back" aria-label="返回列表">
            ‹ 返回列表
          </Button>
          <div className="min-w-0 flex-1">
            <div className="text-zk-md font-semibold">WhatsApp 報更，有幾條要你揀</div>
            {pager.counts && <div className="text-zk-sm text-zk-muted" data-testid="wa-triage-progress">仲有 {Math.max(0, pager.counts.open - handled.length)} 題未答</div>}
          </div>
        </div>

        <div className="min-w-0 space-y-3 overflow-y-auto break-words px-4 py-3">
          {(error ?? pager.error) && <Banner kind="error">{error ?? pager.error}</Banner>}
          {notice && <Banner kind="success" data-testid="wa-triage-notice">{notice}</Banner>}
          {loading && <div className="text-zk-base text-zk-muted">載入緊…</div>}
          {!loading && !q && (
            <div className="space-y-2 py-6 text-center" data-testid="wa-triage-empty">
              <div className="text-zk-md font-semibold">冇未答嘅 WhatsApp 題</div>
              <Button variant="primary" onClick={close}>返回列表</Button>
            </div>
          )}
          {q && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Pill variant="warning">{q.kind_label}</Pill>
                {q.wa.round > 1 && <span className="text-zk-xs text-zk-faint">第 {Math.min(q.wa.round, 3)} 輪確認</span>}
              </div>
              {q.restricted ? (
                <Banner kind="warning" data-testid="wa-triage-restricted">要有「保安員」查看同「更表」新增權限嘅同事（老闆／主管）先睇到內容同作答。</Banner>
              ) : (
                <>
                  <div className="rounded-lg border border-zk-border bg-zk-surface p-3" data-testid="wa-original">
                    <div className="text-zk-xs text-zk-faint">
                      WhatsApp 原話 · {q.wa.group_label} · {hkTime(q.wa.sent_at)} · {q.wa.sender}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-zk-base" data-testid="wa-original-text">{q.wa.text_redacted ? "（原文已超過保留期，已清除）" : (q.wa.text ?? "")}</div>
                  </div>
                  {(q.wa.source_changed || q.wa.source_revoked) && (
                    <Banner kind="warning" data-testid="wa-source-changed">⚠ 原訊息已被發訊人{q.wa.source_revoked ? "撤回" : "修改"}，呢題可能已經唔適用。</Banner>
                  )}
                  <div className="text-zk-sm text-zk-muted" data-testid="wa-parsed">
                    系統解析：{INTENT_LABEL[q.wa.intent.kind] ?? q.wa.intent.kind}
                    {q.wa.intent.work_date ? ` · ${q.wa.intent.work_date}` : ""}
                    {q.wa.intent.site_name ? ` · ${q.wa.intent.site_name}` : ""}
                    {q.wa.intent.guard_name ? ` · ${q.wa.intent.guard_name}` : ""}
                    {q.wa.intent.shift_code ? ` · ${q.wa.intent.shift_code}更` : ""}
                    {q.wa.intent.leave_code ? ` · ${q.wa.intent.leave_code}` : ""}
                  </div>
                  <div className="text-zk-sm text-zk-warning" data-testid="wa-reasons">卡住原因：{q.wa.reasons.map((r) => REASON_LABEL[r] ?? r).join("、") || "—"}</div>
                  {q.wa.existing.length > 0 && (
                    <div className="space-y-1 rounded border border-zk-border p-2 text-zk-sm" data-testid="wa-existing">
                      <div className="font-semibold">現有記錄</div>
                      {q.wa.existing.map((e) => (
                        <div key={e.id}>{e.site_name} · {e.record_type === "leave" ? `請假 ${e.leave_code ?? ""}` : `${e.shift_code} 更`} · {e.status === "pending_approval" ? "待批核" : e.status === "confirmed" ? "已確認" : e.status}</div>
                      ))}
                    </div>
                  )}

                  <fieldset className="space-y-2" disabled={busy}>
                    <legend className="text-zk-sm font-semibold text-zk-muted">你想點處理？</legend>
                    {opts.map((o, i) => {
                      const cand = o.guard_id ? q.wa.guard_candidates.find((c) => c.guard_id === o.guard_id) : null;
                      const siteName = o.site_id ? q.wa.site_options.find((s) => s.id === o.site_id)?.name : null;
                      const isSel = selected === i;
                      return (
                        <div key={`${o.id}-${i}`} className={`rounded-lg border p-2 ${isSel ? "border-zk-primary bg-zk-primary-tint-soft" : "border-zk-border"}`}>
                          <button
                            type="button"
                            className="block w-full text-left"
                            data-testid={cand ? `wa-opt-guard-${cand.guard_id}` : `wa-opt-${o.id}${o.site_id ? `-${o.site_id}` : ""}${o.date ? `-${o.date}` : ""}`}
                            aria-pressed={isSel}
                            onClick={() => { setSelected(i); setImpact(null); setHash(null); }}
                          >
                            {cand ? (
                              <span className="block">
                                <span className="font-semibold">{cand.name_zh}</span>
                                {cand.name_en ? <span className="ml-1 text-zk-faint">{cand.name_en}</span> : null}
                                {cand.recent_here ? <span className="ml-2 rounded bg-zk-success-bg px-1.5 text-zk-xs text-zk-success-dark">近 60 日同盤</span> : null}
                                <span className="block text-zk-sm text-zk-muted">
                                  {cand.staff_numbers.length ? `工號 ${cand.staff_numbers.join("、")} · ` : ""}
                                  最近返更盤：{cand.recent_sites.length ? cand.recent_sites.map((s) => `${s.name}（${s.last_date}）`).join("、") : "未有紀錄"}
                                </span>
                              </span>
                            ) : siteName ? (
                              <span className="font-semibold">{siteName}</span>
                            ) : (
                              <span>{o.label}</span>
                            )}
                          </button>
                          {isSel && o.input === "guard_search" && <GuardSearch onPick={(g) => { setPickedGuard(g); setImpact(null); setHash(null); }} />}
                          {isSel && o.input === "date" && (
                            <input type="date" className="mt-1.5 w-full rounded-[5px] border border-zk-border px-2 py-1.5" aria-label="日期" data-testid="wa-date-input" value={dateText} onChange={(e) => { setDateText(e.target.value); setImpact(null); setHash(null); }} />
                          )}
                          {isSel && o.id === "wa_manual" && q.wa.manual_href && <div className="mt-1 text-zk-sm text-zk-muted">確認後會喺新分頁開排更頁。</div>}
                        </div>
                      );
                    })}
                    {(q.kind === "wa_person_unknown" || q.kind === "wa_person_ambiguous") && (
                      <div className="text-zk-sm text-zk-muted">
                        新保安員？請到 <a className="underline" href="/guards/new-from-docs" target="_blank" rel="noreferrer">入職流程</a> 建立，再返嚟揀。
                      </div>
                    )}
                    {opt?.id === "wa_pick_guard" && q.wa.can_remember_alias && q.wa.raw?.person && (
                      <label className="flex items-start gap-2 text-zk-sm" data-testid="wa-remember-alias">
                        <input type="checkbox" className="mt-0.5" checked={remember} onChange={(e) => { setRemember(e.target.checked); setImpact(null); setHash(null); }} />
                        <span>記住呢個花名：之後「{q.wa.raw.person}」直接對到呢位保安員</span>
                      </label>
                    )}
                  </fieldset>
                  {impact && (
                    <div className="space-y-2 rounded-lg border border-zk-primary/30 bg-zk-primary-tint-soft p-3 text-zk-base" data-testid="wa-impact">
                      <div className="font-semibold text-zk-primary-deep">影響預覽（未寫入）</div>
                      <ul className="list-disc pl-5">
                        {impact.summary.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                      {impact.notes.map((n) => (
                        <div key={n} className="text-zk-sm text-zk-warning">{n}</div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {q && !q.restricted && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zk-border px-4 py-3">
            <Button disabled={busy} onClick={onSkip} data-testid="wa-skip">跳過，留返人手</Button>
            <div className="flex items-center gap-2">
              {!noWrite && (
                <Button disabled={busy || !answer} onClick={onPreview} data-testid="wa-preview">預覽影響</Button>
              )}
              <Button variant="primary" disabled={busy || !answer || (!noWrite && (!hash || !impact?.can_confirm))} onClick={onConfirm} data-testid="wa-confirm">
                {busy ? "處理緊…" : noWrite ? "確認" : "確認寫入"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
