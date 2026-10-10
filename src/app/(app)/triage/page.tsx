"use client";
// WP-AI-OPS §28.4：待答問題——列出導入分診 session（老闆見全部＋可轉交；其他人見自己上載嗰批），可繼續答。
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/DataTable";
import { TriageDialog } from "@/components/TriageDialog";
import { MonthCloseTriageDialog } from "@/components/MonthCloseTriageDialog";
import { apiGet, apiPost } from "@/lib/ui/api-client";

interface SessionRow {
  id: string;
  source_type: string;
  owner_user_id: string;
  owner_name: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
  counts: { open: number; answered: number; skipped: number; superseded?: number; total: number; important_open: number; supplementary_open: number };
  superseded_all?: boolean;
}
interface ListRes {
  sessions: SessionRow[];
  open_total: number;
  eligible_owners: { id: string; name: string; role_name: string }[];
}

const SOURCE_LABEL: Record<string, string> = { guard_import: "保安員證件資料導入", roster_upload: "更表上載", month_close: "一鍵結算（要你睇）", postorder_backfill: "補齊價目卡（Postorder／自動卡）" };
// month_close 同 postorder_backfill 都係 month_close_* 題型，用同一個對話框。
const isMcSource = (t: string | undefined): boolean => t === "month_close" || t === "postorder_backfill";

export default function TriagePage() {
  const router = useRouter();
  const [data, setData] = useState<ListRes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [owner, setOwner] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await apiGet<ListRes>(`/api/triage/sessions${mineOnly ? "?mine=1" : ""}`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setData(res.data);
  }, [mineOnly]);
  useEffect(() => {
    void load();
  }, [load]);

  async function reassign(sessionId: string) {
    const to = owner[sessionId];
    if (!to) return;
    setError(null);
    const res = await apiPost(`/api/triage/sessions/${sessionId}/reassign`, { owner_user_id: to });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已轉交");
    router.refresh();
    await load();
  }

  const isBossView = (data?.eligible_owners.length ?? 0) > 0;

  return (
    <div className="space-y-4">
      <PageHeader kicker="主檔" title="待答問題" subtitle="保安員證件資料導入／一鍵結算後，系統唔肯自動決定嘅項目——逐條答，答完先寫入（一鍵結算嘅題預填建議答案，一撳確認）。" />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {isBossView && (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          只睇我自己上載嘅
        </label>
      )}
      {data && data.sessions.length === 0 && <EmptyState title="冇待答問題" />}
      <div className="space-y-3">
        {(data?.sessions ?? []).map((s) => (
          <div key={s.id} className="space-y-2 rounded-lg border border-zk-border p-3 text-[13px]" data-testid="triage-session-card">
            <div className="flex flex-wrap items-center gap-2">
              <b>{SOURCE_LABEL[s.source_type] ?? s.source_type}</b>
              <Pill variant={s.status === "done" ? "success" : "warning"}>{s.superseded_all ? "已被較新嘅導入取代" : s.counts.open === 0 ? "已處理晒" : `重要 ${s.counts.important_open}`}</Pill>
              {s.counts.supplementary_open > 0 && <Pill variant="neutral">補充資料 {s.counts.supplementary_open}</Pill>}
              <span className="text-zk-faint">
                共 {s.counts.total} 條 · 已答 {s.counts.answered} · 跳過 {s.counts.skipped}{(s.counts.superseded ?? 0) > 0 ? ` · ${s.counts.superseded} 條已被較新嘅導入取代` : ""}
              </span>
              <span className="text-zk-faint">{new Date(s.created_at).toLocaleString("zh-HK")}</span>
              {isBossView && <span className="text-zk-muted">上載者／擁有人：{s.owner_name ?? "—"}</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={s.counts.open === 0} onClick={() => setOpenId(s.id)}>
                {s.counts.open > 0 ? "繼續答" : "冇未答"}
              </Button>
              {isBossView && (
                <>
                  <select
                    className="rounded-[5px] border border-zk-border px-2 py-1.5"
                    aria-label="轉交對象"
                    value={owner[s.id] ?? ""}
                    onChange={(e) => setOwner((o) => ({ ...o, [s.id]: e.target.value }))}
                  >
                    <option value="">轉交俾…</option>
                    {data!.eligible_owners
                      .filter((u) => u.id !== s.owner_user_id)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}（{u.role_name}）
                        </option>
                      ))}
                  </select>
                  <Button disabled={!owner[s.id]} onClick={() => reassign(s.id)}>
                    轉交
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {openId && isMcSource(data?.sessions.find((s) => s.id === openId)?.source_type) && (
        <MonthCloseTriageDialog
          sessionId={openId}
          onClose={() => {
            setOpenId(null);
            router.refresh();
            void load();
          }}
          onChanged={() => void load()}
        />
      )}
      {openId && !isMcSource(data?.sessions.find((s) => s.id === openId)?.source_type) && (
        <TriageDialog
          sessionId={openId}
          onClose={() => {
            setOpenId(null);
            router.refresh();
            void load();
          }}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
}
