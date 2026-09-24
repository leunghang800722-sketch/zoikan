"use client";
// WP-ROSTER-UPLOAD Phase B-1（B1-3）：對數頁——summary 卡（各類數目）、
// 分類 tab、逐項行（日期／（子）盤／更種／更表嗰邊／系統嗰邊／動作）、
// 批量「全部以更表為準」（淨係 roster_only／settlement_diff）、套用掣
// （confirm dialog 列數目）。已鎖月份→唯讀＋提示（規則 8/10）。
//
// 型別（wire format，一律 snake_case，同 request/response body 一致——
// 見 docs/api.md「欄位命名」／src/lib/api/http.ts `ok()` 嘅
// `camelToSnakeDeep()`）。
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtDate } from "@/lib/ui/format";

type ReconcileCategory = "match" | "roster_only" | "system_only" | "guard_diff" | "settlement_diff" | "shift_type_diff" | "unresolved";

const CATEGORY_ORDER: ReconcileCategory[] = ["unresolved", "guard_diff", "shift_type_diff", "settlement_diff", "roster_only", "system_only", "match"];
const CATEGORY_LABEL: Record<ReconcileCategory, string> = {
  match: "一致",
  roster_only: "更表有・系統冇",
  system_only: "系統有・更表冇",
  guard_diff: "人唔同",
  settlement_diff: "結算單位唔同",
  shift_type_diff: "更別唔同",
  unresolved: "未配對（唔可以寫入）",
};
const CATEGORY_TONE: Record<ReconcileCategory, "success" | "warning" | "danger" | "neutral"> = {
  match: "success",
  roster_only: "warning",
  system_only: "warning",
  guard_diff: "danger",
  settlement_diff: "warning",
  shift_type_diff: "danger",
  unresolved: "danger",
};

interface RosterSideDto {
  row_id: string;
  work_date: string;
  site_id: string;
  guard_id: string;
  shift_type_id: string;
  code_kind: "shift" | "ot" | "leave";
  raw_code: string;
  hours: number | null;
  leave_code: string | null;
  shift_type_inferred: boolean;
  settlement_broker_id: string | null;
  settlement_inferred: boolean;
}
interface SystemSideDto {
  id: string;
  work_date: string;
  site_id: string;
  guard_id: string;
  shift_type_id: string;
  settlement_broker_id: string | null;
  operational_broker_id: string | null;
  record_type: string;
  leave_code: string | null;
  status: string;
  source: string | null;
}
interface ReconcileItemDto {
  key: string;
  category: ReconcileCategory;
  work_date: string;
  site_id: string | null;
  guard_id: string | null;
  shift_type_id: string | null;
  roster: RosterSideDto | null;
  system: SystemSideDto | null;
  unresolved_reason: string | null;
}
interface ReconcileSummaryDto {
  total: number;
  by_category: Record<ReconcileCategory, number>;
  settlement_inferred_count: number;
}
interface ReconcileResponse {
  upload: { id: string; month: string; site_id: string | null; status: string; version: number };
  summary: ReconcileSummaryDto;
  items: ApiListResult<ReconcileItemDto>;
}

type PendingAction = "apply_roster" | "keep_system" | "exception";
const SOURCE_LABEL: Record<string, string> = { roster_upload: "更表上載", 雞頭報: "雞頭報", 人手: "人手", 複製上月: "複製上月" };

function nameOrId(map: Map<string, string>, id: string | null): string {
  if (!id) return "—";
  return map.get(id) ?? `（${id.slice(0, 8)}）`;
}

export default function ReconcileClient({ uploadId }: { uploadId: string }) {
  const [data, setData] = useState<ReconcileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<ReconcileCategory | "all">("unresolved");
  const [locked, setLocked] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [guardNames, setGuardNames] = useState<Map<string, string>>(new Map());
  const [siteNames, setSiteNames] = useState<Map<string, string>>(new Map());
  const [shiftTypeCodes, setShiftTypeCodes] = useState<Map<string, string>>(new Map());
  const [brokerCodes, setBrokerCodes] = useState<Map<string, string>>(new Map());

  // key -> 用戶喺呢一輪揀咗嘅動作（未套用之前純前端狀態）。
  const [decisions, setDecisions] = useState<Map<string, { action: PendingAction; reason: string }>>(new Map());

  async function load() {
    setLoading(true);
    setError(null);
    const qs = tab === "all" ? "" : `?category=${tab}`;
    const res = await apiGet<ReconcileResponse>(`/api/roster-uploads/${uploadId}/reconcile${qs}&take=500`.replace("?&", "?"));
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setData(res.data);
    if (res.data.upload.month) {
      const mc = await apiGet<ApiListResult<{ month: string; locked_at: string | null }>>(`/api/month-closes?month=${res.data.upload.month.slice(0, 7)}`);
      if (mc.ok) setLocked(mc.data.rows.some((r) => !!r.locked_at));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadId, tab]);

  useEffect(() => {
    (async () => {
      const [guards, sites, shiftTypes, brokers] = await Promise.all([
        apiGet<ApiListResult<{ id: string; name_zh: string }>>("/api/guards?take=500"),
        apiGet<ApiListResult<{ id: string; canonical_name: string }>>("/api/sites?take=500"),
        apiGet<ApiListResult<{ id: string; code: string }>>("/api/shift-types?take=500"),
        apiGet<ApiListResult<{ id: string; code: string }>>("/api/brokers?take=500"),
      ]);
      if (guards.ok) setGuardNames(new Map(guards.data.rows.map((g) => [g.id, g.name_zh])));
      if (sites.ok) setSiteNames(new Map(sites.data.rows.map((s) => [s.id, s.canonical_name])));
      if (shiftTypes.ok) setShiftTypeCodes(new Map(shiftTypes.data.rows.map((s) => [s.id, s.code])));
      if (brokers.ok) setBrokerCodes(new Map(brokers.data.rows.map((b) => [b.id, b.code])));
    })();
  }, []);

  function setDecision(key: string, action: PendingAction, reason = "") {
    setDecisions((prev) => {
      const next = new Map(prev);
      next.set(key, { action, reason });
      return next;
    });
  }
  function clearDecision(key: string) {
    setDecisions((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  const rows = data?.items.rows ?? [];

  function bulkApplyRosterForVisible() {
    // 批量「全部以更表為準」——只對 roster_only／settlement_diff（任務書
    // B1-3）。
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const item of rows) {
        if (item.category === "roster_only" || item.category === "settlement_diff") {
          next.set(item.key, { action: "apply_roster", reason: "" });
        }
      }
      return next;
    });
  }

  const pendingList = useMemo(() => [...decisions.entries()].map(([key, v]) => ({ key, ...v })), [decisions]);
  const countsByAction = useMemo(() => {
    const c = { apply_roster: 0, keep_system: 0, exception: 0 };
    for (const p of pendingList) c[p.action] += 1;
    return c;
  }, [pendingList]);

  async function doApply() {
    if (pendingList.length === 0) return;
    // exception 一定要有 reason——前端一樣攔一次（後端都會驗）。
    const missingReason = pendingList.find((p) => p.action === "exception" && !p.reason.trim());
    if (missingReason) {
      setError(`「${missingReason.key}」呢項例外決定未填原因`);
      setConfirmOpen(false);
      return;
    }
    setApplying(true);
    const res = await apiPost<{ results: { key: string; ok: boolean; error?: string }[]; upload_status: string; pending_count: number }>(
      `/api/roster-uploads/${uploadId}/reconcile/apply`,
      { actions: pendingList.map((p) => ({ key: p.key, action: p.action, reason: p.reason || undefined })) },
    );
    setApplying(false);
    setConfirmOpen(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const failed = res.data.results.filter((r) => !r.ok);
    setDecisions(new Map());
    if (failed.length > 0) {
      setError(`${failed.length} 項套用失敗：${failed.map((f) => f.error).join("；")}`);
    } else {
      setNotice(`已套用 ${res.data.results.length} 項${res.data.upload_status === "confirmed" ? "——全部非一致項已有決定，上載已轉「已對數確認」" : `，仲有 ${res.data.pending_count} 項未處理`}`);
    }
    await load();
  }

  if (loading && !data) return <div className="p-6 text-center text-[13px] text-zk-muted">載入緊…</div>;

  const summary = data?.summary;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="排更"
        title="更表對數"
        subtitle="更表 vs 系統內已報更——以更表為準／保留系統／例外，決定套用後直接寫入 shift_records。"
        actions={
          <Link href="/roster-uploads" className="text-[13px] text-zk-primary">
            ‹ 返回更表上載
          </Link>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {locked && <Banner kind="info" message={`${data?.upload.month.slice(0, 7)} 已鎖定——呢頁唯讀，唔可以套用決定。`} />}

      {summary && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-7">
          {CATEGORY_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`reconcile-tab-${c}`}
              onClick={() => setTab(c)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${tab === c ? "border-zk-primary bg-blue-50" : "border-zk-border bg-white hover:bg-zk-header"}`}
            >
              <div className="text-[11px] text-zk-muted">{CATEGORY_LABEL[c]}</div>
              <div className="text-[18px] font-bold text-zk-text">{summary.by_category[c] ?? 0}</div>
            </button>
          ))}
        </div>
      )}
      {summary && summary.settlement_inferred_count > 0 && (
        <div className="text-[12px] text-orange-700">當中 {summary.settlement_inferred_count} 項結算單位係「推算」出嚟（見下面橙色「推算」標記），建議覆核。</div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setTab("all")} className={`text-[12.5px] ${tab === "all" ? "font-semibold text-zk-primary" : "text-zk-muted"}`}>
          全部
        </button>
        {!locked && (
          <>
            <Button variant="secondary" onClick={bulkApplyRosterForVisible}>
              呢頁全部以更表為準（限「更表有・系統冇」／「結算單位唔同」）
            </Button>
            <Button variant="primary" disabled={pendingList.length === 0} onClick={() => setConfirmOpen(true)}>
              套用決定（{pendingList.length}）
            </Button>
          </>
        )}
      </div>

      <div className={`hidden md:block ${tableCls.wrap}`}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(8) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>日期</th>
              <th className={tableCls.th}>（子）盤</th>
              <th className={tableCls.th}>更種</th>
              <th className={tableCls.th}>更表嗰邊</th>
              <th className={tableCls.th}>系統嗰邊</th>
              <th className={tableCls.th}>分類</th>
              <th className={tableCls.th}>動作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className={tableCls.tdMuted} colSpan={7}>
                  {loading ? "載入緊…" : "冇符合條件嘅項目"}
                </td>
              </tr>
            )}
            {rows.map((item) => {
              const decision = decisions.get(item.key);
              return (
                <tr key={item.key} data-testid="reconcile-item-row" data-reconcile-key={item.key} data-category={item.category} className={tableCls.rowHover}>
                  <td className={tableCls.td}>{fmtDate(item.work_date)}</td>
                  <td className={tableCls.td}>{nameOrId(siteNames, item.site_id)}</td>
                  <td className={tableCls.td}>{item.shift_type_id ? nameOrId(shiftTypeCodes, item.shift_type_id) : "—"}</td>
                  <td className={tableCls.td}>
                    {item.roster ? (
                      <div>
                        <div>{nameOrId(guardNames, item.roster.guard_id)}</div>
                        <div className="text-[11px] text-zk-muted">
                          {item.roster.settlement_broker_id ? nameOrId(brokerCodes, item.roster.settlement_broker_id) : "冇雞頭碼"}
                          {item.roster.settlement_inferred && <span className="ml-1 rounded bg-orange-100 px-1 text-orange-700">推算</span>}
                        </div>
                      </div>
                    ) : (
                      <span className="text-zk-faint">—</span>
                    )}
                  </td>
                  <td className={tableCls.td}>
                    {item.system ? (
                      <div>
                        <div>{nameOrId(guardNames, item.system.guard_id)}</div>
                        <div className="text-[11px] text-zk-muted">
                          {item.system.settlement_broker_id ? nameOrId(brokerCodes, item.system.settlement_broker_id) : "冇結算單位"} ·{" "}
                          {SOURCE_LABEL[item.system.source ?? ""] ?? "未標記"}
                        </div>
                      </div>
                    ) : (
                      <span className="text-zk-faint">—</span>
                    )}
                  </td>
                  <td className={tableCls.td}>
                    <Pill variant={CATEGORY_TONE[item.category]}>{CATEGORY_LABEL[item.category]}</Pill>
                    {item.unresolved_reason && <div className="mt-1 text-[11px] text-red-600">{item.unresolved_reason}</div>}
                  </td>
                  <td className={tableCls.td}>
                    {locked ? (
                      <span className="text-zk-faint">已鎖定</span>
                    ) : item.category === "match" ? (
                      <span className="text-zk-faint">—</span>
                    ) : item.category === "unresolved" ? (
                      <span className="text-[11px] text-zk-muted">先去上載列表頁指定盤／別名</span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            onClick={() => setDecision(item.key, "apply_roster")}
                            className={`rounded-[5px] border px-2 py-[3px] text-[11.5px] ${decision?.action === "apply_roster" ? "border-zk-primary bg-blue-50 font-semibold text-zk-primary" : "border-zk-border text-[#334155]"}`}
                          >
                            以更表為準
                          </button>
                          <button
                            type="button"
                            onClick={() => setDecision(item.key, "keep_system")}
                            className={`rounded-[5px] border px-2 py-[3px] text-[11.5px] ${decision?.action === "keep_system" ? "border-zk-primary bg-blue-50 font-semibold text-zk-primary" : "border-zk-border text-[#334155]"}`}
                          >
                            保留系統
                          </button>
                          <button
                            type="button"
                            onClick={() => setDecision(item.key, "exception", decision?.reason ?? "")}
                            className={`rounded-[5px] border px-2 py-[3px] text-[11.5px] ${decision?.action === "exception" ? "border-zk-primary bg-blue-50 font-semibold text-zk-primary" : "border-zk-border text-[#334155]"}`}
                          >
                            例外
                          </button>
                          {decision && (
                            <button type="button" onClick={() => clearDecision(item.key)} className="text-[11px] text-zk-faint underline">
                              清除
                            </button>
                          )}
                        </div>
                        {decision?.action === "exception" && (
                          <input
                            type="text"
                            placeholder="必填原因"
                            value={decision.reason}
                            onChange={(e) => setDecision(item.key, "exception", e.target.value)}
                            className="rounded-[5px] border border-zk-border px-1.5 py-[3px] text-[11.5px]"
                          />
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 手機：卡列表（README 慣例——七欄表格喺窄屏幕唔用得）。 */}
      <div className="space-y-2 md:hidden">
        {rows.length === 0 && <EmptyState title={loading ? "載入緊…" : "冇符合條件嘅項目"} />}
        {rows.map((item) => {
          const decision = decisions.get(item.key);
          return (
            <div key={item.key} className="rounded-lg border border-zk-border bg-white p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-zk-text">
                  {fmtDate(item.work_date)} · {nameOrId(siteNames, item.site_id)}
                </span>
                <Pill variant={CATEGORY_TONE[item.category]}>{CATEGORY_LABEL[item.category]}</Pill>
              </div>
              <div className="mt-1 text-[11.5px] text-zk-muted">更種：{item.shift_type_id ? nameOrId(shiftTypeCodes, item.shift_type_id) : "—"}</div>
              <div className="mt-1 text-[12px] text-zk-text">
                更表：{item.roster ? `${nameOrId(guardNames, item.roster.guard_id)}（${item.roster.settlement_broker_id ? nameOrId(brokerCodes, item.roster.settlement_broker_id) : "冇雞頭碼"}${item.roster.settlement_inferred ? "・推算" : ""}）` : "—"}
              </div>
              <div className="mt-0.5 text-[12px] text-zk-text">
                系統：{item.system ? `${nameOrId(guardNames, item.system.guard_id)}（${item.system.settlement_broker_id ? nameOrId(brokerCodes, item.system.settlement_broker_id) : "冇結算單位"}・${SOURCE_LABEL[item.system.source ?? ""] ?? "未標記"}）` : "—"}
              </div>
              {item.unresolved_reason && <div className="mt-1 text-[11px] text-red-600">{item.unresolved_reason}</div>}
              {!locked && item.category !== "match" && item.category !== "unresolved" && (
                <div className="mt-2 flex flex-col gap-1">
                  <div className="flex flex-wrap gap-1">
                    {(["apply_roster", "keep_system", "exception"] as PendingAction[]).map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => setDecision(item.key, a, decision?.reason ?? "")}
                        className={`rounded-[5px] border px-2 py-[4px] text-[11.5px] ${decision?.action === a ? "border-zk-primary bg-blue-50 font-semibold text-zk-primary" : "border-zk-border text-[#334155]"}`}
                      >
                        {a === "apply_roster" ? "以更表為準" : a === "keep_system" ? "保留系統" : "例外"}
                      </button>
                    ))}
                  </div>
                  {decision?.action === "exception" && (
                    <input
                      type="text"
                      placeholder="必填原因"
                      value={decision.reason}
                      onChange={(e) => setDecision(item.key, "exception", e.target.value)}
                      className="rounded-[5px] border border-zk-border px-1.5 py-[4px] text-[12px]"
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-lg">
            <div className="text-[14px] font-semibold text-zk-text">確認套用 {pendingList.length} 項決定？</div>
            <ul className="mt-2 space-y-0.5 text-[12.5px] text-zk-muted">
              <li>以更表為準：{countsByAction.apply_roster} 項（寫入 shift_records）</li>
              <li>保留系統：{countsByAction.keep_system} 項（唔改資料，留痕）</li>
              <li>例外：{countsByAction.exception} 項（唔改資料，留痕＋原因）</li>
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmOpen(false)} disabled={applying}>
                取消
              </Button>
              <Button variant="primary" onClick={doApply} disabled={applying}>
                {applying ? "套用緊…" : "確認套用"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
