"use client";
// P2-C：操作紀錄版面重新實作（README §18）——副題「只讀 — 寫入一律由各
// API 內部觸發。」；filters 資料表／操作人／日期；欄 時間(灰)／操作人
// (500)／資料表 pill 灰／動作 pill（lock 橙、create 綠、其他淺灰）／
// Row ID(`#94a3b8`)／「展開 before/after」掣（沿用現有 <details>，換皮）。
//
// 資料表／操作人兩個 filter 送去 GET /api/audit-log 現有嘅 table_name／
// actor_user_id 參數（API 不變）。「日期」呢個 filter README 話要有，
// 但 API 本身未有日期範圍參數，加呢個參數屬於改 API 語意，超出「只
// 換皮」範圍——改用客戶端喺已經攞落嚟嗰一頁（PAGE_SIZE 筆）再篩，
// 屬於已知偏差，詳見回報。
import { useEffect, useMemo, useState } from "react";
import { apiGet, type ApiListResult } from "@/lib/ui/api-client";
import { Notice } from "@/components/ui/Notice";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtDateTime } from "@/lib/ui/format";

interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  table_name: string;
  row_id: string;
  action: string;
  before: unknown;
  after: unknown;
  ip?: string | null;
  created_at: string;
}
interface UserRow {
  id: string;
  name: string;
}

const PAGE_SIZE = 50;

// 見過會寫入 audit_log 嘅 table_name（`src/lib/audit.ts` writeAudit()
// call site 逐個 grep 出嚟）——純粹俾 filter 揀，唔係白名單限制（API
// 本身冇限制傳咩 table_name）。
const TABLE_NAMES = [
  "ai_chat",
  "broker_site_assignments",
  "brokers",
  "daily_requirements",
  "guards",
  "month_closes",
  "quotas",
  "rate_cards",
  "referral_fee_rates",
  "role_permissions",
  "roles",
  "shift_records",
  "shift_types",
  "sites",
  "special_items",
  "users",
];

const DATE_PRESETS = [
  { value: "", label: "全部" },
  { value: "today", label: "今日" },
  { value: "7d", label: "最近 7 日" },
  { value: "30d", label: "最近 30 日" },
] as const;

function actionPill(action: string) {
  if (action === "lock_month" || action === "lock") return <Pill variant="warning">{action}</Pill>;
  if (action === "create") return <Pill variant="success">{action}</Pill>;
  return (
    <Pill variant="broker" color={{ bg: "#f8fafc", fg: "#64748b" }}>
      {action}
    </Pill>
  );
}

export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [userOptions, setUserOptions] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [tableName, setTableName] = useState("");
  const [actorUserId, setActorUserId] = useState("");
  const [datePreset, setDatePreset] = useState<(typeof DATE_PRESETS)[number]["value"]>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ take: String(PAGE_SIZE), skip: String(skip) });
    if (tableName) qs.set("table_name", tableName);
    if (actorUserId) qs.set("actor_user_id", actorUserId);
    const res = await apiGet<ApiListResult<AuditLogRow>>(`/api/audit-log?${qs.toString()}`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setRows(res.data.rows);
    setTotal(res.data.total);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, tableName, actorUserId]);

  useEffect(() => {
    // 用戶名對照——盡力而為，冇「用戶管理:view」就攞唔到，靜靜哋跌返用 id。
    apiGet<ApiListResult<UserRow>>("/api/users?take=500&include_inactive=1").then((res) => {
      if (res.ok) {
        setUsers(Object.fromEntries(res.data.rows.map((u) => [u.id, u.name])));
        setUserOptions(res.data.rows);
      }
    });
  }, []);

  // 「日期」——API 冇日期範圍參數（見頂註解），喺已經攞到手嘅呢一頁再篩。
  const visibleRows = useMemo(() => {
    if (!datePreset) return rows;
    const now = Date.now();
    const cutoffMs = datePreset === "today" ? 24 * 3600_000 : datePreset === "7d" ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000;
    return rows.filter((r) => now - new Date(r.created_at).getTime() <= cutoffMs);
  }, [rows, datePreset]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker="系統"
        title="操作紀錄"
        subtitle="只讀 — 寫入一律由各 API 內部觸發。"
        actions={
          <>
            <FilterChip label="資料表">
              <select
                value={tableName}
                onChange={(e) => {
                  setSkip(0);
                  setTableName(e.target.value);
                }}
              >
                <option value="">全部</option>
                {TABLE_NAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </FilterChip>
            <FilterChip label="操作人">
              <select
                value={actorUserId}
                onChange={(e) => {
                  setSkip(0);
                  setActorUserId(e.target.value);
                }}
              >
                <option value="">全部</option>
                {userOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </FilterChip>
            <FilterChip label="日期">
              <select value={datePreset} onChange={(e) => setDatePreset(e.target.value as (typeof DATE_PRESETS)[number]["value"])}>
                {DATE_PRESETS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </FilterChip>
          </>
        }
      />

      {error && <Notice variant="error">{error}</Notice>}

      <div className={tableCls.wrap}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(6) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>時間</th>
              <th className={tableCls.th}>操作人</th>
              <th className={tableCls.th}>資料表</th>
              <th className={tableCls.th}>動作</th>
              <th className={tableCls.th}>Row ID</th>
              <th className={tableCls.thNum}>內容</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td className="px-3.5 py-4 text-zk-faint" colSpan={6}>
                  載入緊…
                </td>
              </tr>
            )}
            {!loading && visibleRows.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState title="暫時冇紀錄" description="呢頁只讀，寫入一律由各 API 內部觸發，調整篩選再試。" />
                </td>
              </tr>
            )}
            {visibleRows.map((r) => (
              <tr key={r.id} data-testid="audit-log-row" className={`${tableCls.rowHover} align-top`}>
                <td className={`${tableCls.td} text-zk-muted whitespace-nowrap`}>{fmtDateTime(r.created_at)}</td>
                <td className={`${tableCls.td} font-medium whitespace-nowrap`}>
                  {r.actor_user_id ? (users[r.actor_user_id] ?? r.actor_user_id.slice(0, 8)) : "—"}
                </td>
                <td className={`${tableCls.td} whitespace-nowrap`}>
                  <Pill variant="neutral">{r.table_name}</Pill>
                </td>
                <td className={`${tableCls.td} whitespace-nowrap`} data-testid="audit-log-action-pill">
                  {actionPill(r.action)}
                </td>
                <td className={`${tableCls.td} whitespace-nowrap font-mono text-xs`} style={{ color: "#94a3b8" }}>
                  {r.row_id.slice(0, 12)}
                </td>
                <td className={tableCls.tdNum}>
                  <details className="text-left">
                    <summary className="cursor-pointer text-xs text-zk-primary">展開 before/after</summary>
                    <div className="mt-1 space-y-1">
                      <pre className="max-w-md overflow-x-auto rounded bg-zk-header p-2 text-[11px]">before: {JSON.stringify(r.before, null, 2)}</pre>
                      <pre className="max-w-md overflow-x-auto rounded bg-zk-header p-2 text-[11px]">after: {JSON.stringify(r.after, null, 2)}</pre>
                    </div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-[13px] text-zk-muted">
        <span>
          共 {total} 條，第 {Math.floor(skip / PAGE_SIZE) + 1} 頁
        </span>
        <div className="flex gap-2">
          <Button disabled={skip === 0} onClick={() => setSkip((s) => Math.max(0, s - PAGE_SIZE))}>
            上一頁
          </Button>
          <Button disabled={skip + PAGE_SIZE >= total} onClick={() => setSkip((s) => s + PAGE_SIZE)}>
            下一頁
          </Button>
        </div>
      </div>
    </div>
  );
}
