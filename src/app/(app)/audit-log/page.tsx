"use client";
// P2-C：操作紀錄版面重新實作（README §18）——副題「只讀 — 寫入一律由各
// API 內部觸發。」；filters 資料表／操作人／日期；欄 時間(灰)／操作人
// (500)／資料表 pill 灰／動作 pill（lock 橙、create 綠、其他淺灰）／
// Row ID(`#94a3b8`)／「展開 before/after」掣（沿用現有 <details>，換皮）。
//
// M1（Opus 驗收修復）：「日期」filter 之前淨係喺前端對已攞到手嗰
// PAGE_SIZE 行假篩，UI 冇講呢個限制（撳「最近 30 日」睇落好似篩緊全部
// 紀錄，其實只係篩緊第一頁）——而家改做正路：send `from`／`to`（香港
// 曆日 "YYYY-MM-DD"）落 GET /api/audit-log，server 篩 created_at，分頁
// 總數自然跟返 filter。「今日／最近 7 日／最近 30 日」用
// `@/lib/ui/format.ts` 嘅 `todayLocalStr()`／`addDaysStr()`（香港時區）
// 計出 from/to；「自訂」俾用戶自己揀兩個日期。
//
// A3（Opus 驗收修復）：「資料表」filter 名單之前係前端硬編碼一個
// table_name 陣列，要人手同 writeAudit() call site keep in sync——改由
// 新增嘅 additive `GET /api/audit-log/tables`（distinct table_name，
// 同一權限、只讀）提供，冇資料就唔會出現。
import { useEffect, useMemo, useState } from "react";
import { apiGet, type ApiListResult, apiGetAll } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtDateTime, todayLocalStr, addDaysStr } from "@/lib/ui/format";
import { kickerFor } from "@/lib/nav/schema";

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

const DATE_PRESETS = [
  { value: "", label: "全部" },
  { value: "today", label: "今日" },
  { value: "7d", label: "最近 7 日" },
  { value: "30d", label: "最近 30 日" },
  { value: "custom", label: "自訂" },
] as const;
type DatePreset = (typeof DATE_PRESETS)[number]["value"];

/** 「今日／最近 7 日／最近 30 日」→ `{ from, to }`（香港曆日
 * "YYYY-MM-DD"，含首尾兩日）；「自訂」用返用戶自己揀嘅 `customFrom`／
 * `customTo`；「全部」冇界。 */
function presetToRange(preset: DatePreset, customFrom: string, customTo: string): { from: string; to: string } {
  const today = todayLocalStr();
  if (preset === "today") return { from: today, to: today };
  if (preset === "7d") return { from: addDaysStr(today, -6), to: today };
  if (preset === "30d") return { from: addDaysStr(today, -29), to: today };
  if (preset === "custom") return { from: customFrom, to: customTo };
  return { from: "", to: "" };
}

function actionPill(action: string) {
  if (action === "lock_month" || action === "lock") return <Pill variant="warning">{action}</Pill>;
  if (action === "create") return <Pill variant="success">{action}</Pill>;
  return (
    <Pill variant="broker" color={{ bg: "var(--zk-surface-2)", fg: "var(--zk-muted)" }}>
      {action}
    </Pill>
  );
}

export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [users, setUsers] = useState<Record<string, string>>({});
  const [userOptions, setUserOptions] = useState<UserRow[]>([]);
  const [tableOptions, setTableOptions] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [tableName, setTableName] = useState("");
  const [actorUserId, setActorUserId] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { from, to } = useMemo(() => presetToRange(datePreset, customFrom, customTo), [datePreset, customFrom, customTo]);

  async function load() {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({ take: String(PAGE_SIZE), skip: String(skip) });
    if (tableName) qs.set("table_name", tableName);
    if (actorUserId) qs.set("actor_user_id", actorUserId);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
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
  }, [skip, tableName, actorUserId, from, to]);

  useEffect(() => {
    // 用戶名對照——盡力而為，冇「用戶管理:view」就攞唔到，靜靜哋跌返用 id。
    apiGetAll<UserRow>("/api/users?include_inactive=1").then((res) => {
      if (res.ok) {
        setUsers(Object.fromEntries(res.data.rows.map((u) => [u.id, u.name])));
        setUserOptions(res.data.rows);
      }
    });
    // A3：「資料表」filter 名單由 API 提供（distinct table_name），唔再硬編碼。
    apiGet<{ tables: string[] }>("/api/audit-log/tables").then((res) => {
      if (res.ok) setTableOptions(res.data.tables);
    });
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker={kickerFor("/audit-log")}
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
                {tableOptions.map((t) => (
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
              <select
                data-testid="audit-log-date-filter"
                value={datePreset}
                onChange={(e) => {
                  setSkip(0);
                  setDatePreset(e.target.value as DatePreset);
                }}
              >
                {DATE_PRESETS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </FilterChip>
            {datePreset === "custom" && (
              <FilterChip label="由" showCaret={false}>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => {
                    setSkip(0);
                    setCustomFrom(e.target.value);
                  }}
                />
                <span className="mx-1 text-zk-faint">至</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => {
                    setSkip(0);
                    setCustomTo(e.target.value);
                  }}
                />
              </FilterChip>
            )}
          </>
        }
      />

      {error && <Banner compact kind="error">{error}</Banner>}

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
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <EmptyState title="暫時冇紀錄" description="呢頁只讀，寫入一律由各 API 內部觸發，調整篩選再試。" />
                </td>
              </tr>
            )}
            {rows.map((r) => (
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
                <td className={`${tableCls.td} whitespace-nowrap font-mono text-xs`} style={{ color: "var(--zk-faint)" }}>
                  {r.row_id.slice(0, 12)}
                </td>
                <td className={tableCls.tdNum}>
                  <details className="text-left">
                    <summary className="cursor-pointer text-xs text-zk-primary">展開 before/after</summary>
                    <div className="mt-1 space-y-1">
                      <pre className="max-w-md overflow-x-auto rounded bg-zk-header p-2 text-zk-xs">before: {JSON.stringify(r.before, null, 2)}</pre>
                      <pre className="max-w-md overflow-x-auto rounded bg-zk-header p-2 text-zk-xs">after: {JSON.stringify(r.after, null, 2)}</pre>
                    </div>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-zk-base text-zk-muted">
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
