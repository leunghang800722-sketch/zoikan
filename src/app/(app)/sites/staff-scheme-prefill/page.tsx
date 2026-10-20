"use client";
// SITE-SCHEME-1：未設工號體系嘅盤——一頁清單，每行建議體系可改，「全部套用」一撳寫入並即刻補更次工號歸屬。
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { selectCls } from "@/components/ui/Field";
import { tableCls, tableMinWidth } from "@/components/ui/DataTable";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { kickerFor } from "@/lib/nav/schema";

interface Proposal {
  site_id: string;
  site_name: string;
  client_name: string;
  guards_paid_by_client: boolean;
  proposed_scheme: "U" | "MP";
  reason: string;
}
interface ApplyResult {
  applied: number;
  skipped_already_set: number;
  backfilled: number;
  by_scheme: Array<{ scheme: string; count: number }>;
}

export default function StaffSchemePrefillPage() {
  const [rows, setRows] = useState<Proposal[] | null>(null);
  const [choice, setChoice] = useState<Record<string, "U" | "MP">>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiGet<{ count: number; proposals: Proposal[] }>("/api/sites/staff-scheme-prefill");
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setRows(res.data.proposals);
    setChoice(Object.fromEntries(res.data.proposals.map((p) => [p.site_id, p.proposed_scheme])));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function applyAll() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    const overrides = rows.filter((p) => choice[p.site_id] !== p.proposed_scheme).map((p) => ({ site_id: p.site_id, scheme: choice[p.site_id]! }));
    const res = await apiPost<ApplyResult>("/api/sites/staff-scheme-prefill", { apply: true, ...(overrides.length ? { overrides } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const d = res.data;
    setNotice(`已設定 ${d.applied} 個盤（${d.by_scheme.map((b) => `${b.scheme} ${b.count}`).join("／")}），更次工號歸屬即刻補咗 ${d.backfilled} 更。`);
    await load();
  }

  return (
    <div className="flex flex-col gap-4" data-testid="staff-scheme-prefill-page">
      <PageHeader
        kicker={kickerFor("/sites/staff-scheme-prefill")}
        title="盤工號體系（預設建議）"
        subtitle="客戶／盤名／別名含 Wilson 或威信 → U，其餘 → MP（LINK 盤照客戶判）。逐行可改，撳「全部套用」一次過寫入未設定嘅盤，並即刻對佢哋嘅更次補推導工號歸屬（只填空位；已設定嘅盤唔會郁）。"
        actions={
          <Button variant="primary" disabled={busy || !rows || rows.length === 0} onClick={() => void applyAll()} data-testid="prefill-apply-all">
            {busy ? "套用緊…" : "全部套用"}
          </Button>
        }
      />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {rows === null ? (
        <div className="text-zk-base text-zk-muted">載入緊…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-zk-border bg-white px-4 py-6 text-zk-base text-zk-muted" data-testid="prefill-empty">
          所有盤都已設工號體系。 <Link href="/sites" className="text-zk-primary">返去盤 ›</Link>
        </div>
      ) : (
        <div className={tableCls.wrap}>
          <table className={tableCls.table} style={{ minWidth: tableMinWidth(4) }}>
            <thead>
              <tr>
                <th className={tableCls.th}>盤</th>
                <th className={tableCls.th}>客戶</th>
                <th className={tableCls.th}>建議體系</th>
                <th className={tableCls.th}>理由</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.site_id} className={tableCls.rowHover} data-testid={`prefill-row-${p.site_id}`}>
                  <td className={tableCls.td}>
                    {p.site_name}
                    {p.guards_paid_by_client && <Pill variant="neutral">LINK</Pill>}
                  </td>
                  <td className={tableCls.td}>{p.client_name}</td>
                  <td className={tableCls.td}>
                    <select className={selectCls} value={choice[p.site_id] ?? p.proposed_scheme} onChange={(e) => setChoice((c) => ({ ...c, [p.site_id]: e.target.value as "U" | "MP" }))} aria-label={`${p.site_name} 工號體系`}>
                      <option value="U">U（Wilson 盤）</option>
                      <option value="MP">MP（在勤盤）</option>
                    </select>
                  </td>
                  <td className={tableCls.td}>{p.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
