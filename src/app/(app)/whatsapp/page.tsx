"use client";
// W0：WhatsApp 報更——群組綁定、訊息清單、health（docs/plans/whatsapp-roster-plan.md §4／§9）。
// 本階段只「落庫」，未解析／未寫更。所有資料經 /api/whatsapp/*；訊息原文唔顯示。手機 375px 友善（卡片列表，無橫向捲動）。
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/DataTable";
import { inputCls, selectCls } from "@/components/ui/Field";
import { apiGet, apiPatch, apiPost } from "@/lib/ui/api-client";
import { fmtDateTime } from "@/lib/ui/format";
import { kickerFor } from "@/lib/nav/schema";

interface WordPair {
  word: string;
  code: string;
}
interface GroupRow {
  id: string;
  group_jid: string;
  label: string;
  kind: string;
  site_id: string | null;
  site_name: string | null;
  broker_id: string | null;
  broker_code: string | null;
  shift_word_map: WordPair[];
  auto_write: boolean;
  auto_confirm: boolean;
  active: boolean;
  last_message_at: string | null;
  unprocessed_count: number;
}
interface GroupsRes {
  rows: GroupRow[];
  can_update: boolean;
  site_options: { id: string; name: string }[];
  broker_options: { id: string; code: string }[];
}
interface MessageRow {
  id: string;
  ts: string;
  group_id: string | null;
  group_label: string;
  sender: string;
  status: string;
  ignore_reason: string | null;
  filter_score: number | null;
  revision: number;
  edited: boolean;
  revoked: boolean;
  redacted: boolean;
  media_type: string | null;
}
interface HealthRes {
  enabled: boolean;
  waha_configured: boolean;
  waha_ok: boolean;
  waha_status: string | null;
  waha_error: string | null;
  last_received_at: string | null;
  backlog: number;
  errors_24h: number;
  messages_24h: number;
}

const KIND_LABEL: Record<string, string> = { site: "單盤群", multi_site: "大群（多盤）", broker: "判頭群", office: "辦公室", ignored: "略過" };
const STATUS_LABEL: Record<string, string> = { received: "已收", filtered: "已過濾", parsed: "已解析", routed: "已分流", done: "完成", ignored: "略過", error: "錯誤", revoked: "已撤回" };
const IGNORE_LABEL: Record<string, string> = { not_group: "非群組", from_me: "本機發出", stale: "過期", no_timestamp: "冇時間", future_ts: "時間異常" };
const STATUS_FILTERS = ["", "received", "ignored", "error", "revoked"] as const;

function statusVariant(s: string): "success" | "neutral" | "warning" | "danger" {
  if (s === "error") return "danger";
  if (s === "ignored" || s === "revoked") return "neutral";
  if (s === "received") return "warning";
  return "success";
}

export default function WhatsappPage() {
  const [groups, setGroups] = useState<GroupsRes | null>(null);
  const [messages, setMessages] = useState<MessageRow[] | null>(null);
  const [health, setHealth] = useState<HealthRes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [groupFilter, setGroupFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [editing, setEditing] = useState<GroupRow | null>(null);

  const loadGroups = useCallback(async () => {
    const r = await apiGet<GroupsRes>("/api/whatsapp/groups");
    if (r.ok) setGroups(r.data);
    else setError(r.message);
  }, []);
  const loadMessages = useCallback(async () => {
    const q = new URLSearchParams({ take: "200" });
    if (groupFilter) q.set("group", groupFilter);
    if (statusFilter) q.set("status", statusFilter);
    const r = await apiGet<{ rows: MessageRow[] }>(`/api/whatsapp/messages?${q.toString()}`);
    if (r.ok) setMessages(r.data.rows);
    else setError(r.message);
  }, [groupFilter, statusFilter]);
  const loadHealth = useCallback(async () => {
    const r = await apiGet<HealthRes>("/api/whatsapp/health");
    if (r.ok) setHealth(r.data);
  }, []);

  useEffect(() => {
    void loadGroups();
    void loadHealth();
  }, [loadGroups, loadHealth]);
  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  async function sync() {
    setSyncing(true);
    setError(null);
    setNotice(null);
    const r = await apiPost<{ total: number; created: number; relabelled: number }>("/api/whatsapp/groups/sync");
    setSyncing(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setNotice(`已同步：WAHA 共 ${r.data.total} 個群，新增 ${r.data.created} 個（預設「略過」），更新群名 ${r.data.relabelled} 個。`);
    await loadGroups();
  }

  const canUpdate = groups?.can_update === true;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker={kickerFor("/whatsapp")}
        title="WhatsApp 報更"
        subtitle="被動收聽公司專用號碼所在群組嘅訊息（只聽唔講）。本階段只落庫，未解析、未寫入更表。"
        actions={
          <>
            <Button onClick={() => { void loadGroups(); void loadMessages(); void loadHealth(); }}>重新整理</Button>
            {canUpdate && (
              <Button variant="primary" disabled={syncing} onClick={() => void sync()}>
                {syncing ? "同步緊…" : "同步群組"}
              </Button>
            )}
          </>
        }
      />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <section aria-label="系統狀態" className="rounded-lg border border-zk-border bg-white p-3.5" data-testid="wa-health">
        <div className="mb-2 text-zk-sm font-semibold text-zk-text">系統狀態</div>
        {!health ? (
          <div className="text-zk-sm text-zk-faint">載入緊…</div>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-zk-sm sm:grid-cols-3">
            <div>
              <div className="text-zk-xs text-zk-muted">總開關</div>
              <Pill variant={health.enabled ? "success" : "neutral"}>{health.enabled ? "已開" : "已關"}</Pill>
            </div>
            <div>
              <div className="text-zk-xs text-zk-muted">WAHA session</div>
              <Pill variant={health.waha_ok && health.waha_status === "WORKING" ? "success" : "warning"}>
                {!health.waha_configured ? "未設定" : health.waha_ok ? (health.waha_status ?? "未知") : "連唔到"}
              </Pill>
            </div>
            <div>
              <div className="text-zk-xs text-zk-muted">最後收到訊息</div>
              <div className="text-zk-text">{fmtDateTime(health.last_received_at)}</div>
            </div>
            <div>
              <div className="text-zk-xs text-zk-muted">積壓（待處理）</div>
              <div className="text-zk-text">{health.backlog}</div>
            </div>
            <div>
              <div className="text-zk-xs text-zk-muted">24 小時錯誤</div>
              <div className={health.errors_24h > 0 ? "font-semibold text-zk-danger" : "text-zk-text"}>{health.errors_24h}</div>
            </div>
            <div>
              <div className="text-zk-xs text-zk-muted">24 小時收到</div>
              <div className="text-zk-text">{health.messages_24h}</div>
            </div>
          </div>
        )}
      </section>

      <section aria-label="群組" className="space-y-2">
        <div className="text-zk-sm font-semibold text-zk-text">群組{groups ? `（${groups.rows.length}）` : ""}</div>
        {!groups ? (
          <div className="text-zk-sm text-zk-faint">載入緊…</div>
        ) : groups.rows.length === 0 ? (
          <div className="rounded-lg border border-zk-border bg-white">
            <EmptyState title="未有群組" description={canUpdate ? "撳「同步群組」由 WAHA 攞群組列表；新群預設「略過」，綁定後先會處理。" : "未有群組。請老闆同步群組。"} />
          </div>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="wa-group-list">
            {groups.rows.map((g) => (
              <li key={g.id} className="rounded-lg border border-zk-border bg-white p-3" data-testid="wa-group-card">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-zk-base font-semibold text-zk-text">{g.label || "（未命名群組）"}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Pill variant={g.kind === "ignored" ? "neutral" : "shift"}>{KIND_LABEL[g.kind] ?? g.kind}</Pill>
                      {g.site_name && <Pill variant="neutral">盤：{g.site_name}</Pill>}
                      {g.broker_code && <Pill variant="neutral">判頭：{g.broker_code}</Pill>}
                      {!g.active && <Pill variant="warning">已停用</Pill>}
                      {g.auto_write && <Pill variant="success">自動寫入</Pill>}
                      {g.auto_confirm && <Pill variant="success">自動確認</Pill>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-zk-xs text-zk-muted">
                    <div>未處理 <span className="font-semibold text-zk-text">{g.unprocessed_count}</span></div>
                    <div>{fmtDateTime(g.last_message_at)}</div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setGroupFilter(groupFilter === g.id ? "" : g.id)}>{groupFilter === g.id ? "取消篩選訊息" : "睇訊息"}</Button>
                  {canUpdate && <Button size="sm" variant="primary" onClick={() => setEditing(g)}>綁定設定</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="訊息" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-zk-sm font-semibold text-zk-text">最近訊息（最多 200 條）{groupFilter && groups ? ` · ${groups.rows.find((g) => g.id === groupFilter)?.label ?? ""}` : ""}</div>
          <select aria-label="狀態篩選" className={`${selectCls} !w-auto`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>{s ? STATUS_LABEL[s] : "全部狀態"}</option>
            ))}
          </select>
        </div>
        {!messages ? (
          <div className="text-zk-sm text-zk-faint">載入緊…</div>
        ) : messages.length === 0 ? (
          <div className="rounded-lg border border-zk-border bg-white">
            <EmptyState title="未有訊息" description="WAHA 收到群組訊息後會喺呢度顯示（唔顯示原文）。" />
          </div>
        ) : (
          <ul className="divide-y divide-zk-border-soft rounded-lg border border-zk-border bg-white" data-testid="wa-message-list">
            {messages.map((m) => (
              <li key={m.id} className="px-3 py-2 text-zk-sm" data-testid="wa-message-row">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="min-w-0 truncate font-medium text-zk-text">{m.group_label}</span>
                  <span className="text-zk-xs text-zk-muted">{fmtDateTime(m.ts)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="text-zk-text-secondary">{m.sender}</span>
                  <Pill variant={statusVariant(m.status)}>{STATUS_LABEL[m.status] ?? m.status}</Pill>
                  {m.ignore_reason && <Pill variant="neutral">{IGNORE_LABEL[m.ignore_reason] ?? m.ignore_reason}</Pill>}
                  {m.filter_score !== null && <span className="text-zk-xs text-zk-muted">分數 {m.filter_score}</span>}
                  {m.edited && <Pill variant="warning">已編輯 r{m.revision}</Pill>}
                  {m.revoked && m.status !== "revoked" && <Pill variant="danger">已撤回</Pill>}
                  {m.media_type && <Pill variant="neutral">媒體：{m.media_type}</Pill>}
                  {m.redacted && <Pill variant="neutral">原文已清除</Pill>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing && groups && (
        <GroupEditor
          key={editing.id}
          group={editing}
          sites={groups.site_options}
          brokers={groups.broker_options}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setNotice("已儲存群組綁定。");
            await loadGroups();
          }}
        />
      )}
    </div>
  );
}

function GroupEditor({ group, sites, brokers, onClose, onSaved }: {
  group: GroupRow;
  sites: { id: string; name: string }[];
  brokers: { id: string; code: string }[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [kind, setKind] = useState(group.kind);
  const [siteId, setSiteId] = useState(group.site_id ?? "");
  const [brokerId, setBrokerId] = useState(group.broker_id ?? "");
  const [pairs, setPairs] = useState<WordPair[]>(group.shift_word_map);
  const [autoWrite, setAutoWrite] = useState(group.auto_write);
  const [autoConfirm, setAutoConfirm] = useState(group.auto_confirm);
  const [active, setActive] = useState(group.active);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const noAuto = kind === "ignored" || kind === "office";

  async function save() {
    setSaving(true);
    setErr(null);
    const cleaned = pairs.map((p) => ({ word: p.word.trim(), code: p.code.trim() })).filter((p) => p.word && p.code);
    const r = await apiPatch(`/api/whatsapp/groups`, {
      id: group.id,
      kind,
      site_id: kind === "site" ? siteId || null : null,
      broker_id: kind === "broker" ? brokerId || null : null,
      shift_word_map: cleaned,
      auto_write: noAuto ? false : autoWrite,
      auto_confirm: noAuto || !autoWrite ? false : autoConfirm,
      active,
    });
    setSaving(false);
    if (!r.ok) {
      setErr(r.message);
      return;
    }
    await onSaved();
  }

  return (
    <Drawer open title={`綁定設定：${group.label || "（未命名群組）"}`} onClose={onClose} widthClassName="w-full max-w-[420px]">
      <div className="space-y-3" data-testid="wa-group-editor">
        <Banner kind="error" message={err} />
        <label className="block space-y-1">
          <span className="block text-sm text-zk-text-secondary">群組類型</span>
          <select className={selectCls} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="群組類型">
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        {kind === "site" && (
          <label className="block space-y-1">
            <span className="block text-sm text-zk-text-secondary">綁定盤口</span>
            <select className={selectCls} value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="綁定盤口">
              <option value="">（未揀）</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
        )}
        {kind === "broker" && (
          <label className="block space-y-1">
            <span className="block text-sm text-zk-text-secondary">綁定判頭</span>
            <select className={selectCls} value={brokerId} onChange={(e) => setBrokerId(e.target.value)} aria-label="綁定判頭">
              <option value="">（未揀）</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>{b.code}</option>
              ))}
            </select>
          </label>
        )}
        <div className="space-y-1.5">
          <div className="text-sm text-zk-text-secondary">口語 → 更碼對照</div>
          {pairs.length === 0 && <div className="text-zk-xs text-zk-faint">冇對照時，之後會用該盤更別時段推斷。</div>}
          {pairs.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={inputCls} aria-label={`口語 ${i + 1}`} placeholder="口語（例：夜）" maxLength={20} value={p.word} onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, word: e.target.value } : x)))} />
              <input className={`${inputCls} !w-24`} aria-label={`更碼 ${i + 1}`} placeholder="更碼" maxLength={12} value={p.code} onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} />
              <Button size="sm" variant="ghost" aria-label={`刪除對照 ${i + 1}`} onClick={() => setPairs(pairs.filter((_, j) => j !== i))}>刪</Button>
            </div>
          ))}
          {pairs.length < 30 && <Button size="sm" onClick={() => setPairs([...pairs, { word: "", code: "" }])}>加一行對照</Button>}
        </div>
        <label className={`flex items-center gap-2 text-sm ${noAuto ? "opacity-50" : ""}`}>
          <input type="checkbox" checked={!noAuto && autoWrite} disabled={noAuto} onChange={(e) => { setAutoWrite(e.target.checked); if (!e.target.checked) setAutoConfirm(false); }} />
          自動寫入（之後階段先生效）
        </label>
        <label className={`flex items-center gap-2 text-sm ${noAuto || !autoWrite ? "opacity-50" : ""}`}>
          <input type="checkbox" checked={!noAuto && autoWrite && autoConfirm} disabled={noAuto || !autoWrite} onChange={(e) => setAutoConfirm(e.target.checked)} />
          自動確認（唔經主管批核）
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          啟用
        </label>
        <div className="flex gap-2 pt-1">
          <Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? "儲存緊…" : "儲存"}</Button>
          <Button onClick={onClose}>取消</Button>
        </div>
      </div>
    </Drawer>
  );
}
