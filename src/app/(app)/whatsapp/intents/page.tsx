"use client";
// W1：WhatsApp 解析 dry-run 對照頁——每條 intent 嘅解析結果、routed 判定、原因碼，對照「實際排更」。
// 只讀：唔寫更、唔開分流題。所有資料經 /api/whatsapp/{intents,stats,groups}；原話同姓名要「保安員」view 權。手機 375px 友善。
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/DataTable";
import { inputCls, selectCls } from "@/components/ui/Field";
import { apiGet } from "@/lib/ui/api-client";
import { fmtDateTime } from "@/lib/ui/format";
import { kickerFor } from "@/lib/nav/schema";

interface IntentRow {
  id: string;
  message_ts: string;
  group_id: string | null;
  group_label: string;
  sender: string;
  text: string | null;
  text_redacted: boolean;
  revision: number;
  kind: string;
  work_date: string | null;
  site_name: string | null;
  guard_name: string | null;
  has_guard: boolean;
  shift_code: string | null;
  leave_code: string | null;
  confidence: number | null;
  routed: string;
  reasons: string[];
  notes: string[];
  candidate_counts: Record<string, number>;
  group_auto_write: boolean;
  superseded: boolean;
  revoked: boolean;
  source_changed: boolean;
  compare: "match" | "mismatch" | "none" | null;
  actual: string[];
  /** W2：routed=triage 嘅 intent 對應嘅分診題 */
  triage_question_id: string | null;
  triage_session_id: string | null;
  triage_status: string | null;
  /** W3：routed=auto_write 嘅實際結果 */
  auto_result: "pending" | "approved" | "rejected" | "no_op" | "suggested" | null;
  auto_record_id: string | null;
}
interface IntentsRes {
  rows: IntentRow[];
  total: number;
  from: string;
  to: string;
  can_see_text: boolean;
}
interface StatsRes {
  from: string;
  to: string;
  received: number;
  filtered: number;
  parsed: number;
  auto_write: number;
  triage: number;
  ignored: number;
  compared: number;
  consistent: number;
  inconsistent: number;
  not_scheduled: number;
  consistency_rate: number | null;
  auto_write_compared: number;
  auto_write_consistent: number;
  auto_write_consistency_rate: number | null;
  errors: number;
  pending: number;
  auto_results: { written: number; pending: number; approved: number; rejected: number; no_op: number; suggested: number };
}
interface GroupOpt {
  id: string;
  label: string;
}

const KIND_LABEL: Record<string, string> = { shift: "報更", leave: "請假", cover: "替更", cancel: "取消", unclear: "唔清楚", question_only: "查詢" };
const ROUTED_LABEL: Record<string, string> = { auto_write: "建議自動寫入", triage: "需人手分流", ignored: "忽略", pending: "待處理" };
const REASON_LABEL: Record<string, string> = {
  person_ambiguous: "人名對到多個保安員",
  person_unknown: "搵唔到呢個人",
  site_ambiguous: "盤口唔肯定",
  date_ambiguous: "日期唔肯定",
  date_missing: "冇講日期",
  date_unparseable: "日期睇唔明",
  date_out_of_range: "日期超出範圍",
  shift_unmapped: "更別對唔到",
  shift_ambiguous: "更別唔肯定",
  leave_unmapped: "請假類別對唔到",
  leave_code_unclear: "放假類別唔清楚（年假／事假／例假？）",
  low_confidence: "AI 信心偏低",
  leave_ambiguous: "請假類別唔肯定",
  conflict_other_shift: "同日已有其他更",
  conflict_leave: "同日已有請假",
  conflict_shift_vs_leave: "同日已有更",
  already_exists: "已有相同記錄",
  month_locked: "該月已鎖定",
  slot_full: "該更已滿額",
  quota_full: "配額已滿",
  type_not_auto: "替更／取消（首階段人手）",
  question_only: "純查詢",
  unclear: "睇唔明",
  duplicate_in_message: "同一訊息重覆",
  daily_cap: "呢個群今日自動寫入已達上限",
  auto_disabled: "自動寫入總開關已關",
  duplicate_recent: "5 分鐘內重覆（去重）",
};
const NOTE_LABEL: Record<string, string> = {
  group_auto_write_off: "群組未開自動寫入",
  month_rolled: "日期推去下個月",
  llm_bad_output: "AI 輸出無效",
  llm_no_intent: "AI 冇抽到指令",
};
const AUTO_RESULT_LABEL: Record<string, { text: string; variant: "success" | "warning" | "danger" | "neutral" }> = {
  pending: { text: "已自動寫入・待批", variant: "warning" },
  approved: { text: "已自動寫入・已批", variant: "success" },
  rejected: { text: "已自動寫入・已拒／已取消", variant: "danger" },
  no_op: { text: "已有相同記錄（no-op）", variant: "neutral" },
  suggested: { text: "只係建議（群組未開自動寫入）", variant: "neutral" },
};
const COMPARE_LABEL: Record<string, { text: string; variant: "success" | "danger" | "neutral" }> = {
  match: { text: "✓ 一致", variant: "success" },
  mismatch: { text: "✗ 唔一致", variant: "danger" },
  none: { text: "— 未有排更", variant: "neutral" },
};

function routedVariant(r: string): "success" | "warning" | "neutral" {
  return r === "auto_write" ? "success" : r === "triage" ? "warning" : "neutral";
}
function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 1000) / 10}%`;
}

export default function WhatsappIntentsPage() {
  const [groups, setGroups] = useState<GroupOpt[]>([]);
  const [data, setData] = useState<IntentsRes | null>(null);
  const [stats, setStats] = useState<StatsRes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [routed, setRouted] = useState("");

  const seq = useRef(0); // 篩選連續改動時，只採用最新一次請求嘅結果（避免舊回應覆蓋新篩選）
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const q = new URLSearchParams();
    if (group) q.set("group", group);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const sq = new URLSearchParams(q);
    if (routed) q.set("routed", routed);
    const [a, b] = await Promise.all([apiGet<IntentsRes>(`/api/whatsapp/intents?${q.toString()}`), apiGet<StatsRes>(`/api/whatsapp/stats?${sq.toString()}`)]);
    if (mine !== seq.current) return;
    if (a.ok) setData(a.data);
    else setError(a.message);
    if (b.ok) setStats(b.data);
    else if (a.ok) setError(b.message);
  }, [group, from, to, routed]);

  useEffect(() => {
    void (async () => {
      const r = await apiGet<{ rows: Array<{ id: string; label: string }> }>("/api/whatsapp/groups");
      if (r.ok) setGroups(r.data.rows.map((g) => ({ id: g.id, label: g.label || "（未命名群組）" })));
    })();
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <PageHeader
        kicker={kickerFor("/whatsapp/intents")}
        title="WhatsApp 解析對照（dry-run）"
        subtitle="每條訊息嘅解析結果同「實際排更」對一對。群組未開自動寫入＝只係建議；已開嘅，自動寫入結果（待批／已批／已拒）都會喺度顯示。"
        actions={
          <>
            <Link href="/whatsapp" className="rounded-md border border-zk-input-border bg-white px-3.5 py-[7px] text-zk-base text-zk-text-secondary transition-colors hover:bg-zk-header">群組同訊息</Link>
            <Button onClick={() => void load()}>重新整理</Button>
          </>
        }
      />
      <Banner kind="error" message={error} />

      <section aria-label="統計" className="rounded-lg border border-zk-border bg-white p-3.5" data-testid="wa-intent-stats">
        <div className="mb-2 text-zk-sm font-semibold text-zk-text">統計{stats ? `（${stats.from} 至 ${stats.to}）` : ""}</div>
        {!stats ? (
          <div className="text-zk-sm text-zk-faint">載入緊…</div>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-zk-sm sm:grid-cols-4">
            {(
              [
                ["received", "收", stats.received],
                ["filtered", "過濾", stats.filtered],
                ["parsed", "解析", stats.parsed],
                ["auto_write", "建議自動", stats.auto_write],
                ["triage", "分流", stats.triage],
                ["ignored", "忽略", stats.ignored],
              ] as const
            ).map(([k, label, v]) => (
              <div key={k} data-testid={`wa-stat-${k}`}>
                <div className="text-zk-xs text-zk-muted">{label}</div>
                <div className="text-zk-lg font-semibold text-zk-text">{v}</div>
              </div>
            ))}
            <div data-testid="wa-stat-auto-results" className="col-span-2 sm:col-span-4">
              <div className="text-zk-xs text-zk-muted">自動寫入結果</div>
              <div className="text-zk-sm text-zk-text">
                已寫 {stats.auto_results.written}（待批 {stats.auto_results.pending}、已批 {stats.auto_results.approved}、已拒 {stats.auto_results.rejected}）· no-op {stats.auto_results.no_op} · 只係建議 {stats.auto_results.suggested}
              </div>
            </div>
            <div data-testid="wa-stat-consistency">
              <div className="text-zk-xs text-zk-muted">對照一致率</div>
              <div className="text-zk-lg font-semibold text-zk-text">{pct(stats.consistency_rate)}</div>
              <div className="text-zk-xs text-zk-muted">{stats.consistent}／{stats.compared}（未排 {stats.not_scheduled}）</div>
            </div>
            <div data-testid="wa-stat-auto-consistency">
              <div className="text-zk-xs text-zk-muted">建議自動 · 一致率</div>
              <div className="text-zk-lg font-semibold text-zk-text">{pct(stats.auto_write_consistency_rate)}</div>
              <div className="text-zk-xs text-zk-muted">{stats.auto_write_consistent}／{stats.auto_write_compared}</div>
            </div>
          </div>
        )}
      </section>

      <section aria-label="篩選" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
        <label className="col-span-2 block space-y-1 sm:col-span-1">
          <span className="block text-zk-xs text-zk-muted">群組</span>
          <select aria-label="群組" className={`${selectCls} sm:!w-auto`} value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">全部群組</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-zk-xs text-zk-muted">由</span>
          <input type="date" aria-label="由" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="block text-zk-xs text-zk-muted">至</span>
          <input type="date" aria-label="至" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="col-span-2 block space-y-1 sm:col-span-1">
          <span className="block text-zk-xs text-zk-muted">判定</span>
          <select aria-label="判定" className={`${selectCls} sm:!w-auto`} value={routed} onChange={(e) => setRouted(e.target.value)}>
            <option value="">全部判定</option>
            {(["auto_write", "triage", "ignored"] as const).map((r) => (
              <option key={r} value={r}>{ROUTED_LABEL[r]}</option>
            ))}
          </select>
        </label>
      </section>

      <section aria-label="解析結果" className="space-y-2">
        <div className="text-zk-sm font-semibold text-zk-text">解析結果{data ? `（${data.total}）` : ""}</div>
        {!data ? (
          <div className="text-zk-sm text-zk-faint">載入緊…</div>
        ) : data.rows.length === 0 ? (
          <div className="rounded-lg border border-zk-border bg-white">
            <EmptyState title="未有解析結果" description="總開關（WA_ENABLED）開咗、群組已綁定，新訊息經 AI 解析後會喺度出現。" />
          </div>
        ) : (
          <ul className="space-y-2" data-testid="wa-intent-list">
            {data.rows.map((r) => (
              <li key={r.id} className={`rounded-lg border border-zk-border bg-white p-3 text-zk-sm ${r.superseded || r.revoked ? "opacity-60" : ""}`} data-testid="wa-intent-row">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="min-w-0 truncate font-medium text-zk-text">{r.group_label}</span>
                  <span className="text-zk-xs text-zk-muted">{fmtDateTime(r.message_ts)}</span>
                </div>
                <div className="mt-0.5 text-zk-xs text-zk-muted">發訊人：{r.sender}</div>
                {data.can_see_text && (
                  <blockquote className="mt-1.5 break-words rounded border-l-2 border-zk-border bg-zk-bg px-2 py-1 text-zk-text-secondary" data-testid="wa-intent-text">
                    {r.text_redacted ? "（原文已按保留期清除）" : (r.text ?? "")}
                  </blockquote>
                )}
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                  <div>
                    <dt className="text-zk-xs text-zk-muted">類別</dt>
                    <dd>{KIND_LABEL[r.kind] ?? r.kind}</dd>
                  </div>
                  <div>
                    <dt className="text-zk-xs text-zk-muted">日期</dt>
                    <dd>{r.work_date ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-zk-xs text-zk-muted">盤口</dt>
                    <dd className="break-words">{r.site_name ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-zk-xs text-zk-muted">保安員</dt>
                    <dd className="break-words">{r.guard_name ?? (r.has_guard ? "（已配對）" : "—")}</dd>
                  </div>
                  <div>
                    <dt className="text-zk-xs text-zk-muted">更別／請假</dt>
                    <dd>{r.shift_code ?? r.leave_code ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-zk-xs text-zk-muted">信心</dt>
                    <dd>{r.confidence === null ? "—" : r.confidence.toFixed(2)}</dd>
                  </div>
                </dl>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Pill variant={routedVariant(r.routed)}>{ROUTED_LABEL[r.routed] ?? r.routed}</Pill>
                  {r.compare ? (
                    <span data-testid="wa-intent-compare"><Pill variant={COMPARE_LABEL[r.compare]!.variant}>{COMPARE_LABEL[r.compare]!.text}</Pill></span>
                  ) : (
                    <span data-testid="wa-intent-compare"><Pill variant="neutral">對照：不適用</Pill></span>
                  )}
                  {r.actual.length > 0 && <span className="text-zk-xs text-zk-muted">實際：{r.actual.join("、")}</span>}
                  {r.routed === "triage" && r.triage_question_id && r.triage_session_id && (
                    <Link href={`/triage?open=${r.triage_session_id}&focus=${r.triage_question_id}`} className="text-zk-xs text-zk-primary underline" data-testid="wa-intent-triage-link">
                      {r.triage_status === "open" ? "去答分診題 ›" : r.triage_status === "answered" ? "已答 ›" : "睇分診題 ›"}
                    </Link>
                  )}
                  {r.auto_result && (
                    <span data-testid="wa-intent-auto-result" data-result={r.auto_result}><Pill variant={AUTO_RESULT_LABEL[r.auto_result]!.variant}>{AUTO_RESULT_LABEL[r.auto_result]!.text}</Pill></span>
                  )}
                  {r.superseded && <Pill variant="warning">已被編輯後版本取代</Pill>}
                  {r.revoked && <Pill variant="danger">原訊息已撤回</Pill>}
                  {r.source_changed && !r.superseded && !r.revoked && <Pill variant="warning">原訊息已修改</Pill>}
                </div>
                {(r.reasons.length > 0 || r.notes.length > 0) && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="wa-intent-reasons">
                    {r.reasons.map((c) => (
                      <Pill key={c} variant="neutral">{REASON_LABEL[c] ?? c}</Pill>
                    ))}
                    {r.notes.map((c) => (
                      <span key={c} className="text-zk-xs text-zk-faint">{NOTE_LABEL[c] ?? c}</span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
