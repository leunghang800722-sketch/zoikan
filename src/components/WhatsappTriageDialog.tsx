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
  input?: "text" | "hkid" | "guard_search" | "date" | "leave_code";
  guard_id?: string;
  site_id?: string;
  date?: string;
}
interface WaCand {
  guard_id: string;
  name_zh: string;
  name_en: string | null;
  staff_numbers: string[];
  recent_sites: Array<{ name: string; last_date: string }>;
  recent_here: boolean;
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
    existing: Array<{ id: string; site_name: string; shift_code: string; record_type: string; leave_code: string | null; status: string; work_date: string }>;
    cover: {
      worker: { guard_id: string | null; name: string | null };
      replaced: { guard_id: string | null; name: string | null };
      replaced_candidates: WaCand[];
      replaced_records: Array<{ id: string; site_name: string; shift_code: string; work_date: string; status: string }>;
    } | null;
    cancel_preview: string[];
    card?: { media_url: string | null; staff_no: string | null; name_zh: string | null; name_en: string | null; votes: number; index: number; total: number; arbiter: boolean; candidates: string[]; others?: Array<{ staff_no: string | null; status: "confirmed" | "review" }>; multi_hint?: boolean; doc_type?: string | null; time_on?: string | null; none: "expired" | "not_card" | "unreadable" | null } | null;
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

const DOC_TYPE_LABEL: Record<string, string> = { work_card: "工卡相", punch_card: "打卡紙", signin_sheet: "簽到表", attendance_sheet: "值勤／出勤記錄表", app_screenshot: "考勤 app 截圖", other: "其他相片" };
const CARD_NONE_TEXT: Record<string, string> = { expired: "相片已過期（系統冇收到圖），請叫對方再 send 一次", not_card: "相入面睇落唔係工卡（例如打卡機螢幕、自拍）", unreadable: "相太暗／太糊／反光，工號讀唔到" };
const REASON_LABEL: Record<string, string> = {
  card_media_expired: "相片已過期",
  card_not_card: "相入面唔係工卡",
  card_unreadable: "工卡讀唔到",
  card_confirm: "工卡相要你確認",
  card_suspect_second: "疑似同一張相仲有第二張工卡（只一個引擎讀到）",
  card_disputed: "工號讀數唔一致",
  card_arbiter_unavailable: "工號讀數唔一致（仲裁用唔到）",
  card_name_only: "淨係讀到姓名",
  card_name_mismatch: "卡上姓名同系統唔夾",
  card_former_number: "工號係已取消嘅舊號",
  card_staff_no_unknown: "系統冇呢個工號",
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
  source_edited_failed: "原訊息已修改，自動處理失敗（舊記錄仍待批）",
  daily_cap: "呢個群今日自動寫入已達上限",
  auto_disabled: "自動寫入總開關已關",
  duplicate_recent: "5 分鐘內重覆",
  type_not_auto: "替更／取消，首階段要人手",
  no_cancel_target: "搵唔到可以取消嘅更／請假",
  unclear: "未能理解",
  shift_unmapped: "唔知係邊一更",
  shift_ambiguous: "更種有幾個可能",
  leave_code_unclear: "請假類別唔清",
  leave_ambiguous: "請假類別唔清",
  leave_unmapped: "請假類別唔清",
};
const INTENT_LABEL: Record<string, string> = { shift: "報更", leave: "請假", cover: "替更", cancel: "取消", unclear: "未明", question_only: "查詢" };
const NO_WRITE = new Set(["wa_ignore", "wa_keep_old", "wa_manual"]);
const COVER_OPTS = new Set(["wa_cover_confirm", "wa_cover_add_only", "wa_use_whatsapp"]);
const LEAVE_CODES = ["AL", "SL", "NL", "RD", "SH"];

/** W4：替更題人選（候選一鍵揀；冇候選就搜尋）。 */
function PersonPicker({ title, testid, picked, cands, onPick }: { title: string; testid: string; picked: string | null; cands: WaCand[]; onPick: (id: string | null) => void }) {
  return (
    <div className="space-y-1" data-testid={testid}>
      <div className="text-zk-sm font-semibold">{title}</div>
      {cands.map((c) => (
        <button key={c.guard_id} type="button" data-testid={`${testid}-${c.guard_id}`} aria-pressed={picked === c.guard_id} className={choiceBtn(picked === c.guard_id, "block w-full text-left break-words")} onClick={() => onPick(c.guard_id)}>
          <span className="font-semibold">{c.name_zh}</span>
          {c.name_en ? <span className="ml-1 text-zk-faint">{c.name_en}</span> : null}
          {c.recent_here ? <span className="ml-2 rounded bg-zk-success-bg px-1.5 text-zk-xs text-zk-success-dark">近 60 日同盤</span> : null}
          <span className="block text-zk-sm text-zk-muted">
            {c.staff_numbers.length ? `工號 ${c.staff_numbers.join("、")} · ` : ""}最近返更盤：{c.recent_sites.length ? c.recent_sites.map((x) => `${x.name}（${x.last_date}）`).join("、") : "未有紀錄"}
          </span>
        </button>
      ))}
      {cands.length === 0 && <GuardSearch onPick={(g) => onPick(g ? g.id : null)} />}
    </div>
  );
}

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
  const [alsoGuard, setAlsoGuard] = useState(""); // WA-8.2：同一相仲有另一位
  const [coverWorker, setCoverWorker] = useState<string | null>(null);
  const [coverReplaced, setCoverReplaced] = useState<string | null>(null);
  const [leaveCode, setLeaveCode] = useState("AL");
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
    setAlsoGuard("");
    setCoverWorker(null);
    setCoverReplaced(null);
    setLeaveCode("AL");
    setImpact(null);
    setHash(null);
    setError(null);
  }, [q?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const opts = q ? q.options.filter((o) => o.id !== "skip") : [];
  const opt = selected !== null ? opts[selected] : null;

  function buildAnswer(): Record<string, unknown> | null {
    if (!opt) return null;
    const also = alsoGuard && q?.wa.card?.multi_hint && (opt.id === "wa_pick_guard" || opt.id === "wa_accept" || opt.id === "wa_force_write") ? { also_guard_id: alsoGuard } : {};
    if (opt.id === "wa_pick_guard") {
      const gid = opt.guard_id ?? pickedGuard?.id;
      if (!gid) return null;
      if (also.also_guard_id === gid) return null;
      return { option: opt.id, guard_id: gid, ...(remember ? { remember_alias: true } : {}), ...also };
    }
    if (opt.id === "wa_accept" || opt.id === "wa_force_write") return { option: opt.id, ...also };
    if (opt.id === "wa_pick_site") return opt.site_id ? { option: opt.id, site_id: opt.site_id } : null;
    if (opt.id === "wa_set_date") {
      const v = opt.date ?? dateText.trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { option: opt.id, value: v } : null;
    }
    if (q?.kind === "wa_cover" && COVER_OPTS.has(opt.id)) {
      const c = q.wa.cover;
      const needWorker = !c?.worker.guard_id;
      const needReplaced = opt.id !== "wa_cover_add_only" && !c?.replaced.guard_id;
      if ((needWorker && !coverWorker) || (needReplaced && !coverReplaced)) return null;
      return { option: opt.id, ...(needWorker && coverWorker ? { guard_id: coverWorker } : {}), ...(needReplaced && coverReplaced ? { replaced_guard_id: coverReplaced } : {}) };
    }
    if (opt.id === "wa_cancel_to_leave") return { option: opt.id, value: leaveCode };
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
                  {q.wa.card && (
                    <div className="rounded-lg border border-zk-border bg-zk-surface p-3 space-y-2" data-testid="wa-card">
                      <div className="text-zk-xs text-zk-faint">{q.wa.card.doc_type ? (DOC_TYPE_LABEL[q.wa.card.doc_type] ?? "相片") : "工卡相"}{q.wa.card.total > 1 ? `（第 ${q.wa.card.index}／${q.wa.card.total} 張）` : ""}{q.wa.card.time_on ? ` · 相上時間 ${q.wa.card.time_on}` : ""}</div>
                      {q.wa.card.media_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={q.wa.card.media_url} alt="工卡相" className="max-h-72 w-auto max-w-full rounded border border-zk-border bg-white object-contain" data-testid="wa-card-image" />
                      )}
                      {q.wa.card.none ? (
                        <div className="text-zk-sm text-zk-warning" data-testid="wa-card-none">{CARD_NONE_TEXT[q.wa.card.none]}</div>
                      ) : (
                        <div className="text-zk-sm" data-testid="wa-card-read">
                          讀到：工號 {q.wa.card.staff_no ?? "（讀唔到）"}
                          {q.wa.card.name_zh ? ` · ${q.wa.card.name_zh}` : ""}
                          {q.wa.card.name_en ? ` · ${q.wa.card.name_en}` : ""}
                          <span className="ml-1 text-zk-faint">（{q.wa.card.votes} 票{q.wa.card.arbiter ? "，已用仲裁" : ""}）</span>
                          {q.wa.card.candidates.length > 1 && <div className="text-zk-muted">其他可能：{q.wa.card.candidates.join("、")}</div>}
                          {q.wa.card.multi_hint && (
                            <div className="mt-1 rounded border border-zk-warning-border bg-zk-warning-bg p-2" data-testid="wa-card-multi-hint">
                              <div className="text-zk-warning">相入面可能有多過一張工卡：如果係兩個人，請分別確認。</div>
                              {(() => {
                                const others = q.wa.guard_candidates.filter((c) => c.name_zh !== q.wa.intent.guard_name);
                                return others.length > 0 ? (
                                  <label className="mt-1 flex flex-wrap items-center gap-2">
                                    <span>加多一位（同一相另開確認題）：</span>
                                    <select className="rounded border border-zk-border px-1 py-0.5" value={alsoGuard} onChange={(e) => { setAlsoGuard(e.target.value); setImpact(null); setHash(null); }} aria-label="加多一位" data-testid="wa-card-add-another">
                                      <option value="">（唔加）</option>
                                      {others.map((c) => (
                                        <option key={c.guard_id} value={c.guard_id}>{c.name_zh}{c.staff_numbers.length ? `（${c.staff_numbers.join("、")}）` : ""}</option>
                                      ))}
                                    </select>
                                  </label>
                                ) : null;
                              })()}
                            </div>
                          )}
                          {(q.wa.card.others?.length ?? 0) > 0 && (
                            <div className="text-zk-muted" data-testid="wa-card-others">
                              同一張相仲有：{q.wa.card.others!.map((o) => `${o.staff_no ?? "（讀唔到工號）"}（${o.status === "confirmed" ? "已確認" : "只一個引擎讀到"}）`).join("、")}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
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
                        <div key={e.id}>{e.work_date.slice(5, 7)}/{e.work_date.slice(8, 10)} · {e.site_name} · {e.record_type === "leave" ? `請假 ${e.leave_code ?? ""}` : `${e.shift_code} 更`} · {e.status === "pending_approval" ? "待批核" : e.status === "confirmed" ? "已確認" : e.status}</div>
                      ))}
                    </div>
                  )}

                  {q.wa.cancel_preview.length > 0 && (
                    <div className="rounded border border-zk-warning/40 bg-zk-warning-bg p-2 text-zk-sm font-semibold text-zk-warning" data-testid="wa-cancel-preview">
                      {q.wa.cancel_preview.map((l) => (
                        <div key={l}>{l}</div>
                      ))}
                    </div>
                  )}
                  {q.kind === "wa_cover" && q.wa.cover && (
                    <div className="space-y-3 rounded-lg border border-zk-border p-2" data-testid="wa-cover-panel">
                      {q.wa.cover.worker.guard_id ? (
                        <div className="text-zk-sm" data-testid="wa-cover-worker-fixed">替更者：<span className="font-semibold">{q.wa.cover.worker.name ?? "（已配對）"}</span></div>
                      ) : (
                        <PersonPicker title="邊個替更（替更者）？" testid="wa-cover-worker" picked={coverWorker} cands={q.wa.guard_candidates} onPick={(id) => { setCoverWorker(id); setImpact(null); setHash(null); }} />
                      )}
                      {q.wa.cover.replaced.guard_id ? (
                        <div className="text-zk-sm" data-testid="wa-cover-replaced-fixed">
                          被替者：<span className="font-semibold">{q.wa.cover.replaced.name ?? "（已配對）"}</span>
                          {q.wa.cover.replaced_records.length === 0 && <span className="ml-1 text-zk-warning">（當日冇呢一更，只會加替更者）</span>}
                        </div>
                      ) : (
                        <PersonPicker title="替邊個（被替者）？" testid="wa-cover-replaced" picked={coverReplaced} cands={q.wa.cover.replaced_candidates} onPick={(id) => { setCoverReplaced(id); setImpact(null); setHash(null); }} />
                      )}
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
                          {isSel && o.input === "leave_code" && (
                            <select className="mt-1.5 w-full rounded-[5px] border border-zk-border px-2 py-1.5" aria-label="請假碼" data-testid="wa-leave-code" value={leaveCode} onChange={(e) => { setLeaveCode(e.target.value); setImpact(null); setHash(null); }}>
                              {LEAVE_CODES.map((c) => (
                                <option key={c} value={c}>{c}</option>
                              ))}
                            </select>
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
