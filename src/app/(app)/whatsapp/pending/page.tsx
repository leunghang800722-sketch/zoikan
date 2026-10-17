"use client";
// W3：WhatsApp 待批清單——來源 WhatsApp、仍待批核嘅排更記錄（時間、群、發訊人、盤、日期、更／請假、原話、⚠ 標示）。
// 一鍵批核多條＝逐條 call 現有 /api/shift-records/[id]/approve（權限、鎖月、補計價照舊）；退回＝現有 /reject（要原因）。
// 「全選」唔包含 ⚠（原訊息已被修改／撤回）嘅記錄，要逐條自己剔。原話／姓名要「保安員」view 權。手機 375px 友善。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/DataTable";
import { inputCls, selectCls } from "@/components/ui/Field";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { fmtDateTime } from "@/lib/ui/format";
import { kickerFor } from "@/lib/nav/schema";

interface PendingRow {
  id: string;
  created_at: string;
  message_ts: string | null;
  group_label: string | null;
  sender: string;
  site_name: string;
  work_date: string;
  record_type: string;
  code: string;
  guard_name: string | null;
  text: string | null;
  text_redacted: boolean;
  source_changed: boolean;
  revoked: boolean;
}
interface PendingRes {
  rows: PendingRow[];
  total: number;
  can_see_text: boolean;
  can_approve: boolean;
}

export default function WhatsappPendingPage() {
  const [data, setData] = useState<PendingRes | null>(null);
  const [groups, setGroups] = useState<Array<{ id: string; label: string }>>([]);
  const [group, setGroup] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const q = new URLSearchParams();
    if (group) q.set("group", group);
    const r = await apiGet<PendingRes>(`/api/whatsapp/pending?${q.toString()}`);
    if (mine !== seq.current) return;
    if (r.ok) {
      setData(r.data);
      setPicked((p) => new Set([...p].filter((id) => r.data.rows.some((x) => x.id === id))));
    } else setError(r.message);
  }, [group]);

  useEffect(() => {
    void (async () => {
      const r = await apiGet<{ rows: Array<{ id: string; label: string }> }>("/api/whatsapp/groups");
      if (r.ok) setGroups(r.data.rows.map((g) => ({ id: g.id, label: g.label || "（未命名群組）" })));
    })();
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const safeIds = useMemo(() => (data ? data.rows.filter((r) => !r.source_changed).map((r) => r.id) : []), [data]);
  const allSafePicked = safeIds.length > 0 && safeIds.every((id) => picked.has(id));

  function toggle(id: string) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function approveSelected() {
    const ids = [...picked];
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let okN = 0;
    const fails: string[] = [];
    for (const id of ids) {
      const r = await apiPost(`/api/shift-records/${id}/approve`);
      if (r.ok) okN++;
      else fails.push(r.message);
    }
    setBusy(false);
    setNotice(`已批核 ${okN} 條${fails.length ? `，${fails.length} 條失敗` : ""}`);
    if (fails.length) setError(`有 ${fails.length} 條批核失敗：${[...new Set(fails)].slice(0, 2).join("；")}`);
    setPicked(new Set());
    await load();
  }

  async function rejectOne(id: string) {
    const text = reason.trim();
    if (!text) {
      setError("退回要寫原因");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await apiPost(`/api/shift-records/${id}/reject`, { reason: text });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setRejectId(null);
    setReason("");
    setNotice("已退回 1 條");
    await load();
  }

  return (
    <div className="space-y-4">
      <PageHeader
        kicker={kickerFor("/whatsapp/pending")}
        title="WhatsApp 待批"
        subtitle="由 WhatsApp 報更自動寫入、等主管批核嘅更／請假。批核後先正式計入更表。"
        actions={
          <>
            <Link href="/whatsapp" className="rounded-md border border-zk-input-border bg-white px-3.5 py-[7px] text-zk-base text-zk-text-secondary transition-colors hover:bg-zk-header">群組同訊息</Link>
            <Button onClick={() => void load()}>重新整理</Button>
          </>
        }
      />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <section aria-label="篩選" className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-end">
        <label className="block space-y-1">
          <span className="block text-zk-xs text-zk-muted">群組</span>
          <select aria-label="群組" className={`${selectCls} sm:!w-auto`} value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="">全部群組</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
        </label>
        {data?.can_approve && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-zk-sm">
              <input
                type="checkbox"
                aria-label="全選（唔包含有 ⚠ 嘅）"
                checked={allSafePicked}
                disabled={safeIds.length === 0}
                onChange={(e) => setPicked(e.target.checked ? new Set([...picked, ...safeIds]) : new Set([...picked].filter((id) => !safeIds.includes(id))))}
              />
              全選（唔包含 ⚠）
            </label>
            <Button variant="primary" disabled={busy || picked.size === 0} onClick={() => void approveSelected()} data-testid="wa-pending-approve">
              {busy ? "處理緊…" : `批核已選（${picked.size}）`}
            </Button>
          </div>
        )}
      </section>

      <section aria-label="待批清單" className="space-y-2">
        <div className="text-zk-sm font-semibold text-zk-text">待批記錄{data ? `（${data.total}）` : ""}</div>
        {!data ? (
          <div className="text-zk-sm text-zk-faint">載入緊…</div>
        ) : data.rows.length === 0 ? (
          <div className="rounded-lg border border-zk-border bg-white">
            <EmptyState title="冇待批嘅 WhatsApp 記錄" description="開咗「自動寫入」嘅群組有新報更，經解析後會喺度出現。" />
          </div>
        ) : (
          <ul className="space-y-2" data-testid="wa-pending-list">
            {data.rows.map((r) => (
              <li key={r.id} className="rounded-lg border border-zk-border bg-white p-3 text-zk-sm" data-testid="wa-pending-row">
                <div className="flex items-start gap-2">
                  {data.can_approve && <input type="checkbox" className="mt-1" aria-label={`揀 ${r.work_date} ${r.code}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="min-w-0 truncate font-medium text-zk-text">{r.group_label ?? "（原訊息已不在）"}</span>
                      <span className="text-zk-xs text-zk-muted">{fmtDateTime(r.message_ts ?? r.created_at)}</span>
                    </div>
                    <div className="mt-0.5 text-zk-xs text-zk-muted">發訊人：{r.sender}</div>
                    {data.can_see_text && (
                      <blockquote className="mt-1.5 break-words rounded border-l-2 border-zk-border bg-zk-bg px-2 py-1 text-zk-text-secondary" data-testid="wa-pending-text">
                        {r.text_redacted ? "（原文已按保留期清除）" : (r.text ?? "")}
                      </blockquote>
                    )}
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <div>
                        <dt className="text-zk-xs text-zk-muted">盤口</dt>
                        <dd className="break-words">{r.site_name}</dd>
                      </div>
                      <div>
                        <dt className="text-zk-xs text-zk-muted">日期</dt>
                        <dd>{r.work_date}</dd>
                      </div>
                      <div>
                        <dt className="text-zk-xs text-zk-muted">{r.record_type === "leave" ? "請假" : "更別"}</dt>
                        <dd>{r.code}</dd>
                      </div>
                      <div>
                        <dt className="text-zk-xs text-zk-muted">保安員</dt>
                        <dd className="break-words">{r.guard_name ?? "（已配對）"}</dd>
                      </div>
                    </dl>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Pill variant="neutral">{r.record_type === "leave" ? "請假" : "更"}</Pill>
                      {r.source_changed && <span data-testid="wa-pending-warn"><Pill variant="warning">{r.revoked ? "⚠ 原訊息已被發訊人撤回" : "⚠ 原訊息已被發訊人修改"}</Pill></span>}
                      {data.can_approve && rejectId !== r.id && (
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRejectId(r.id); setReason(""); }}>退回</Button>
                      )}
                    </div>
                    {rejectId === r.id && (
                      <div className="mt-2 space-y-1.5">
                        <input className={inputCls} aria-label="退回原因" placeholder="退回原因（必填）" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
                        <div className="flex gap-2">
                          <Button size="sm" variant="primary" disabled={busy} onClick={() => void rejectOne(r.id)}>確認退回</Button>
                          <Button size="sm" onClick={() => setRejectId(null)}>取消</Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
