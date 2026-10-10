"use client";
// WP-ROSTER-UPLOAD Phase B-1（B1-3）：對數頁——summary 卡（各類數目）、
// 分類 tab、逐項行（日期／（子）盤／更種／更表嗰邊／系統嗰邊／動作）、
// 批量「全部以更表為準」（淨係 roster_only／settlement_diff）、套用掣
// （confirm dialog 列數目）。已鎖月份→唯讀＋提示（規則 8/10）。
//
// 型別（wire format，一律 snake_case，同 request/response body 一致——
// 見 docs/api.md「欄位命名」／src/lib/api/http.ts `ok()` 嘅
// `camelToSnakeDeep()`）。
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtDate } from "@/lib/ui/format";
import { loadGuardDirectory, useGuardDirectory, useNeedsBoss } from "@/components/reconcile/data";
import { classifyReason, hasPerson, personFromRow, personKey, telTail, type RawRosterRow } from "@/components/reconcile/derive";
import { SimilarGuards } from "@/components/reconcile/GuardHints";
import { ReasonLinks, ReasonText, WroteCell, reasonHasActions, type ActionCtx } from "./UnresolvedCells";

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
  // WP-GUARD-FIX 第二輪（老闆 2026-09-25 要求）：「子盤未定」批量掣——
  // `allSites` 全部盤（含 parent_site_id），`childSites` derive 出嚟淨係
  // 呢個上載母盤（data.upload.site_id）底下嘅子盤，俾「批量指定子盤」
  // 個下拉揀；`subSiteSelected` 記低用戶喺呢一輪剔選咗邊幾行（key 用
  // row id，同 unresolved item.key 嘅 "row:" 前綴對應）。
  const [allSites, setAllSites] = useState<Array<{ id: string; canonical_name: string; parent_site_id: string | null }>>([]);
  const [subSiteSelected, setSubSiteSelected] = useState<Set<string>>(new Set());
  const [subSiteTargetId, setSubSiteTargetId] = useState<string>("");
  const [subSiteBusy, setSubSiteBusy] = useState(false);

  // key -> 用戶喺呢一輪揀咗嘅動作（未套用之前純前端狀態）。
  const [decisions, setDecisions] = useState<Map<string, { action: PendingAction; reason: string }>>(new Map());

  async function load() {
    setLoading(true);
    setError(null);
    // 2026-09-26 修正：「全部」tab 之前砌出 `/reconcile&take=500`（冇 `?`），
    // 正式站直接 404、套用掣永遠 (0)。統一用 URLSearchParams 砌 query。
    const params = new URLSearchParams({ take: "500" });
    if (tab !== "all") params.set("category", tab);
    const res = await apiGet<ReconcileResponse>(`/api/roster-uploads/${uploadId}/reconcile?${params.toString()}`);
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
        loadGuardDirectory(),
        apiGet<ApiListResult<{ id: string; canonical_name: string; parent_site_id: string | null }>>("/api/sites?take=500"),
        apiGet<ApiListResult<{ id: string; code: string }>>("/api/shift-types?take=500"),
        apiGet<ApiListResult<{ id: string; code: string }>>("/api/brokers?take=500"),
      ]);
      if (guards) setGuardNames(new Map(guards.rows.map((g) => [g.id, g.name_zh])));
      if (sites.ok) {
        setSiteNames(new Map(sites.data.rows.map((s) => [s.id, s.canonical_name])));
        setAllSites(sites.data.rows);
      }
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

  const rows = useMemo(() => data?.items.rows ?? [], [data]);

  // ---- WP-RECONCILE-UI（§33）：未配對行嘅原始資料（只讀現有 rows API）、名冊、guard-fix needs_boss ----
  const month7 = data?.upload.month.slice(0, 7) ?? "";
  const dir = useGuardDirectory();
  const nbRes = useNeedsBoss(month7 || null, !!month7);
  const [rawRows, setRawRows] = useState<Map<string, RawRosterRow>>(new Map());
  const [rawLoading, setRawLoading] = useState(false);
  const rawTried = useRef<Set<string>>(new Set());
  const [reparsing, setReparsing] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [groupReason, setGroupReason] = useState<Record<string, string>>({});

  const unresolvedIds = useMemo(() => rows.filter((i) => i.category === "unresolved").map((i) => i.key.replace(/^row:/, "")), [rows]);
  useEffect(() => {
    const missing = unresolvedIds.filter((id) => !rawTried.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) rawTried.current.add(id);
    (async () => {
      setRawLoading(true);
      const need = new Set(missing);
      const found = new Map<string, RawRosterRow>();
      // 先攞 guard_match=unmatched（安員未配對），仲有冇攞到嘅（雞頭碼／更別／盤…）先逐頁掃全部行。
      const scan = async (guardMatch?: string) => {
        for (let skip = 0; found.size < need.size; skip += 500) {
          const params = new URLSearchParams({ take: "500", skip: String(skip) });
          if (guardMatch) params.set("guard_match", guardMatch);
          const res = await apiGet<{ rows: ApiListResult<RawRosterRow> }>(`/api/roster-uploads/${uploadId}?${params.toString()}`);
          if (!res.ok) return;
          for (const r of res.data.rows.rows) if (need.has(r.id)) found.set(r.id, r);
          if (res.data.rows.rows.length === 0 || skip + res.data.rows.rows.length >= res.data.rows.total) return;
        }
      };
      await scan("unmatched");
      if (found.size < need.size) await scan();
      setRawRows((prev) => {
        const next = new Map(prev);
        for (const [k, v] of found) next.set(k, v);
        return next;
      });
      setRawLoading(false);
    })();
  }, [unresolvedIds, uploadId]);

  async function doReparse() {
    setReparsing(true);
    const res = await apiPost(`/api/roster-uploads/${uploadId}/reparse`);
    setReparsing(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    rawTried.current = new Set();
    setRawRows(new Map());
    setNotice("已重新解析呢份上載，下面清單已重新載入");
    await load();
  }

  // 同一人（姓名＋工號）、同一原因，出現 3 行或以上 → 合併成一行摘要（可摺）。
  interface PersonGroup {
    id: string;
    items: ReconcileItemDto[];
    raw: RawRosterRow;
  }
  type Unit = { kind: "row"; item: ReconcileItemDto } | { kind: "group"; group: PersonGroup };
  const units: Unit[] = useMemo(() => {
    const buckets = new Map<string, ReconcileItemDto[]>();
    const keyOf = (it: ReconcileItemDto): string | null => {
      if (it.category !== "unresolved") return null;
      const raw = rawRows.get(it.key.replace(/^row:/, ""));
      if (!raw) return null;
      const p = personFromRow(raw);
      if (!hasPerson(p)) return null;
      return `${personKey(p)}#${it.unresolved_reason ?? ""}`;
    };
    for (const it of rows) {
      const k = keyOf(it);
      if (k) buckets.set(k, [...(buckets.get(k) ?? []), it]);
    }
    const out: Unit[] = [];
    const emitted = new Set<string>();
    for (const it of rows) {
      const k = keyOf(it);
      const members = k ? buckets.get(k)! : null;
      if (k && members && members.length >= 3) {
        if (emitted.has(k)) continue;
        emitted.add(k);
        out.push({ kind: "group", group: { id: k, items: members, raw: rawRows.get(members[0]!.key.replace(/^row:/, ""))! } });
      } else {
        out.push({ kind: "row", item: it });
      }
    }
    return out;
  }, [rows, rawRows]);


  const [bulkBusy, setBulkBusy] = useState(false);
  async function bulkApplyRosterForVisible() {
    // 批量「全部以更表為準」——只對 roster_only／settlement_diff（任務書
    // B1-3）。
    // 2026-09-26 驗收修正（Opus 5.5）：之前淨係掃已載入嘅 `rows`，但 GET
    // `take` 上限 500（「全部」tab 城巴車廠 546 行 → 尾嗰批永遠冇決定、
    // 上載轉唔到 confirmed）。而家逐個分類用 skip/take 分頁攞晒先標。
    // 喺「更表有・系統冇」／「結算單位唔同」tab 就淨係標嗰個分類；其他
    // tab（全部／未配對…）兩個分類都標。
    const cats: ReconcileCategory[] = tab === "roster_only" || tab === "settlement_diff" ? [tab] : ["roster_only", "settlement_diff"];
    setBulkBusy(true);
    const keys: string[] = [];
    for (const category of cats) {
      for (let skip = 0; ; skip += 500) {
        const params = new URLSearchParams({ category, take: "500", skip: String(skip) });
        const res = await apiGet<ReconcileResponse>(`/api/roster-uploads/${uploadId}/reconcile?${params.toString()}`);
        if (!res.ok) {
          setBulkBusy(false);
          setError(res.message);
          return;
        }
        for (const item of res.data.items.rows) {
          if (item.category === "roster_only" || item.category === "settlement_diff") keys.push(item.key);
        }
        if (res.data.items.rows.length === 0 || skip + res.data.items.rows.length >= res.data.items.total) break;
      }
    }
    setBulkBusy(false);
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const key of keys) next.set(key, { action: "apply_roster", reason: "" });
      return next;
    });
    setNotice(`已標記 ${keys.length} 項「以更表為準」（包括未顯示喺呢頁嘅項目），撳「套用決定」先會寫入`);
  }

  const pendingList = useMemo(() => [...decisions.entries()].map(([key, v]) => ({ key, ...v })), [decisions]);
  const countsByAction = useMemo(() => {
    const c = { apply_roster: 0, keep_system: 0, exception: 0 };
    for (const p of pendingList) c[p.action] += 1;
    return c;
  }, [pendingList]);

  // WP-GUARD-FIX 第二輪：呢個上載母盤底下嘅子盤（`批量指定子盤` 下拉）。
  const childSites = useMemo(() => {
    const parentSiteId = data?.upload.site_id;
    if (!parentSiteId) return [];
    return allSites.filter((s) => s.parent_site_id === parentSiteId);
  }, [allSites, data?.upload.site_id]);

  // WP-GUARD-FIX 第二輪：「子盤未定」——`build-guard-fix-plan` 第二輪
  // 三層推斷（同檔／歷史）都冧唔到，留 `resolved_site_id=null` 嗰批行，
  // 用 unresolved_reason 嘅 marker 分辨（同 reconcile.ts
  // `AMBIGUOUS_SUBSITE_WARNING_PREFIX` 一致字面，見 service.ts）。
  function isSubSiteAmbiguous(item: ReconcileItemDto): boolean {
    return item.category === "unresolved" && !!item.unresolved_reason?.includes("批量指定子盤");
  }
  function rowIdFromKey(key: string): string {
    return key.startsWith("row:") ? key.slice(4) : key;
  }
  function toggleSubSiteSelected(rowId: string) {
    setSubSiteSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }
  async function applySubSiteBulk(siteId: string | null) {
    if (subSiteSelected.size === 0) return;
    setSubSiteBusy(true);
    const res = await apiPost<{ updated: string[]; skipped: Array<{ row_id: string; reason: string }> }>(`/api/roster-uploads/${uploadId}/reconcile/resolve-subsite`, {
      row_ids: [...subSiteSelected],
      site_id: siteId,
    });
    setSubSiteBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setSubSiteSelected(new Set());
    setSubSiteTargetId("");
    if (res.data.skipped.length > 0) {
      setError(`${res.data.skipped.length} 行跳過（可能已經被人手指定過）：${res.data.skipped.map((s) => s.reason).join("；")}`);
    } else {
      setNotice(`已${siteId ? "批量指定子盤" : "批量確認歸母盤"} ${res.data.updated.length} 行`);
    }
    await load();
  }

  async function doApply() {
    if (pendingList.length === 0) return;
    // exception 一定要有 reason——前端一樣攔一次（後端都會驗）。
    const missingReason = pendingList.find((p) => p.action === "exception" && !p.reason.trim());
    if (missingReason) {
      setError(`有 ${pendingList.filter((p) => p.action === "exception" && !p.reason.trim()).length} 項例外決定未填原因（例如 ${fmtDate(missingReason.key.startsWith("row:") ? (rows.find((r) => r.key === missingReason.key)?.work_date ?? "") : missingReason.key.split("|")[0]!)}）`);
      setConfirmOpen(false);
      return;
    }
    setApplying(true);
    // 2026-09-26 驗收修正：apply schema `actions` 上限 2000——批量標記可以
    // 超過，分批送（每批各自一個 transaction；已套用嘅批次唔會因為後面
    // 批次失敗而回滾，失敗項會列出嚟、可以重新整理再套）。
    type ApplyRes = { results: { key: string; ok: boolean; error?: string }[]; upload_status: string; pending_count: number };
    const CHUNK = 2000;
    const allResults: ApplyRes["results"] = [];
    let last: ApplyRes | null = null;
    let apiError: string | null = null;
    for (let i = 0; i < pendingList.length; i += CHUNK) {
      const res = await apiPost<ApplyRes>(`/api/roster-uploads/${uploadId}/reconcile/apply`, {
        actions: pendingList.slice(i, i + CHUNK).map((p) => ({ key: p.key, action: p.action, reason: p.reason || undefined })),
      });
      if (!res.ok) {
        apiError = res.message;
        break;
      }
      last = res.data;
      allResults.push(...res.data.results);
    }
    setApplying(false);
    setConfirmOpen(false);
    if (apiError && !last) {
      setError(apiError);
      return;
    }
    const failed = allResults.filter((r) => !r.ok);
    setDecisions(new Map());
    if (apiError) {
      setError(`已套用 ${allResults.length} 項，之後一批失敗：${apiError}——請重新整理再套用餘下項目`);
    } else if (failed.length > 0) {
      setError(`${failed.length} 項套用失敗：${failed.map((f) => f.error).join("；")}`);
    } else if (last) {
      setNotice(`已套用 ${allResults.length} 項${last.upload_status === "confirmed" ? "——全部非一致項已有決定，上載已轉「已對數確認」" : `，仲有 ${last.pending_count} 項未處理`}`);
    }
    await load();
  }


  const actionCtx: ActionCtx = {
    uploadId,
    uploadSiteId: data?.upload.site_id ?? null,
    month: month7,
    needsBoss: nbRes && nbRes !== "denied" ? nbRes.items : null,
    canGuardFix: nbRes !== "denied",
    onReparse: () => void doReparse(),
    reparsing,
    siteNameOf: (id) => nameOrId(siteNames, id),
  };
  const showSides = tab !== "unresolved";
  const showWrote = tab === "unresolved" || tab === "all";
  const tableCols = 5 + (showSides ? 2 : 0) + (showWrote ? 1 : 0);

  function toggleGroup(id: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function markGroupException(g: PersonGroup) {
    const reason = (groupReason[g.id] ?? "").trim();
    if (!reason) return;
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const it of g.items) next.set(it.key, { action: "exception", reason });
      return next;
    });
  }
  function groupTitle(g: PersonGroup): string {
    const p = personFromRow(g.raw);
    return `同一人：${p.name || p.staffNo}${p.name && p.staffNo ? `（${p.staffNo}）` : ""}共 ${g.items.length} 更`;
  }
  function groupMeta(g: PersonGroup): string {
    const dates = g.items.map((i) => i.work_date).sort();
    const sites = [...new Set(g.items.map((i) => nameOrId(siteNames, i.site_id)))];
    return `${fmtDate(dates[0]!)}–${fmtDate(dates[dates.length - 1]!)}・${sites.slice(0, 2).join("、")}${sites.length > 2 ? "…" : ""}`;
  }
  function groupBody(g: PersonGroup) {
    const first = g.items[0]!;
    const p = personFromRow(g.raw);
    const expanded = expandedGroups.has(g.id);
    return (
      <div className="space-y-1.5" data-testid="reconcile-person-group" data-group-size={g.items.length}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-zk-text" data-testid="reconcile-group-title">
            {groupTitle(g)}
          </span>
          <span className="text-[11.5px] text-zk-muted">{groupMeta(g)}</span>
          <button type="button" onClick={() => toggleGroup(g.id)} className="text-[12px] text-zk-primary underline" data-testid="reconcile-group-toggle">
            {expanded ? "摺埋" : `展開 ${g.items.length} 條`}
          </button>
        </div>
        <div className="text-[11px] text-zk-muted">
          {[telTail(g.raw.tel_raw), g.raw.broker_code_raw?.trim() ? `雞頭碼 ${g.raw.broker_code_raw.trim()}` : null].filter(Boolean).join("・")}
        </div>
        <ReasonText item={first} raw={g.raw} />
        {classifyReason(first.unresolved_reason).some((x) => x.kind === "guard") && hasPerson(p) && <SimilarGuards person={p} dir={dir} />}
        <ReasonLinks item={first} raw={g.raw} ctx={actionCtx} />
        {!locked && (
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="text"
              placeholder="整組標例外嘅原因"
              value={groupReason[g.id] ?? ""}
              onChange={(e) => setGroupReason((prev) => ({ ...prev, [g.id]: e.target.value }))}
              className="rounded-[5px] border border-zk-border px-1.5 py-[3px] text-[11.5px]"
              data-testid="reconcile-group-reason"
            />
            <button
              type="button"
              disabled={!(groupReason[g.id] ?? "").trim()}
              onClick={() => markGroupException(g)}
              className="rounded-[5px] border border-zk-border px-2 py-[3px] text-[11.5px] text-[#334155] disabled:opacity-40"
              data-testid="reconcile-group-exception"
            >
              整組 {g.items.length} 條標例外
            </button>
          </div>
        )}
      </div>
    );
  }

  function exceptionButtons(item: ReconcileItemDto, decision: { action: PendingAction; reason: string } | undefined) {
    return (
      <>
        <div className="flex flex-wrap gap-1">
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
      </>
    );
  }

  function renderDesktopRow(item: ReconcileItemDto) {
    const decision = decisions.get(item.key);
    const raw = item.category === "unresolved" ? rawRows.get(rowIdFromKey(item.key)) : undefined;
    return (
      <tr key={item.key} data-testid="reconcile-item-row" data-reconcile-key={item.key} data-category={item.category} className={tableCls.rowHover}>
        <td className={tableCls.td}>{fmtDate(item.work_date)}</td>
        <td className={tableCls.td}>{nameOrId(siteNames, item.site_id)}</td>
        <td className={tableCls.td}>{item.shift_type_id ? nameOrId(shiftTypeCodes, item.shift_type_id) : "—"}</td>
        {showWrote && (
          <td className={tableCls.td}>
            {item.category === "unresolved" ? <WroteCell raw={raw} loading={rawLoading} item={item} dir={dir} /> : <span className="text-zk-faint">—</span>}
          </td>
        )}
        {showSides && (
          <>
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
                    {item.system.settlement_broker_id ? nameOrId(brokerCodes, item.system.settlement_broker_id) : "冇結算單位"} · {SOURCE_LABEL[item.system.source ?? ""] ?? "未標記"}
                  </div>
                </div>
              ) : (
                <span className="text-zk-faint">—</span>
              )}
            </td>
          </>
        )}
        <td className={tableCls.td}>
          <Pill variant={CATEGORY_TONE[item.category]}>{CATEGORY_LABEL[item.category]}</Pill>
          {item.category === "unresolved" ? <ReasonText item={item} raw={raw} /> : item.unresolved_reason && <div className="mt-1 text-[11px] text-red-600">{item.unresolved_reason}</div>}
        </td>
        <td className={tableCls.td}>
          {locked ? (
            <span className="text-zk-faint">已鎖定</span>
          ) : item.category === "match" ? (
            <span className="text-zk-faint">—</span>
          ) : item.category === "unresolved" ? (
            // 驗收修正（Opus 5.5）：unresolved 之前完全冇動作——但「非 match 項全部有決定」先會轉
            // confirmed，而月結鎖定要 confirmed，即係一格真係配唔到（例如外判／唔喺名冊嘅人）就永遠
            // 卡死。後端本身接受 exception，呢度開返。
            <div className="flex flex-col gap-1">
              {isSubSiteAmbiguous(item) && (
                <label className="flex items-center gap-1.5 text-[11.5px] text-orange-800">
                  <input type="checkbox" checked={subSiteSelected.has(rowIdFromKey(item.key))} onChange={() => toggleSubSiteSelected(rowIdFromKey(item.key))} />
                  子盤未定——剔選後用上面「批量指定子盤」／「全部歸母盤確認」
                </label>
              )}
              <ReasonLinks item={item} raw={raw} ctx={actionCtx} />
              {!isSubSiteAmbiguous(item) && !reasonHasActions(item) && <span className="text-[11px] text-zk-muted">先去上載列表頁指定盤／別名再重新解析；確認唔使寫入就標「例外」</span>}
              {exceptionButtons(item, decision)}
            </div>
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
  }

  function renderMobileCard(item: ReconcileItemDto) {
    const decision = decisions.get(item.key);
    const raw = item.category === "unresolved" ? rawRows.get(rowIdFromKey(item.key)) : undefined;
    return (
      <div key={item.key} className="rounded-lg border border-zk-border bg-white p-3" data-testid="reconcile-item-card">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-zk-text">
            {fmtDate(item.work_date)} · {nameOrId(siteNames, item.site_id)}
          </span>
          <Pill variant={CATEGORY_TONE[item.category]}>{CATEGORY_LABEL[item.category]}</Pill>
        </div>
        <div className="mt-1 text-[11.5px] text-zk-muted">更種：{item.shift_type_id ? nameOrId(shiftTypeCodes, item.shift_type_id) : "—"}</div>
        {item.category === "unresolved" ? (
          <div className="mt-1 rounded border border-zk-border-soft bg-zk-header px-2 py-1">
            <div className="text-[10.5px] text-zk-muted">更表寫咗</div>
            <WroteCell raw={raw} loading={rawLoading} item={item} dir={dir} />
          </div>
        ) : (
          <>
            <div className="mt-1 text-[12px] text-zk-text">
              更表：{item.roster ? `${nameOrId(guardNames, item.roster.guard_id)}（${item.roster.settlement_broker_id ? nameOrId(brokerCodes, item.roster.settlement_broker_id) : "冇雞頭碼"}${item.roster.settlement_inferred ? "・推算" : ""}）` : "—"}
            </div>
            <div className="mt-0.5 text-[12px] text-zk-text">
              系統：{item.system ? `${nameOrId(guardNames, item.system.guard_id)}（${item.system.settlement_broker_id ? nameOrId(brokerCodes, item.system.settlement_broker_id) : "冇結算單位"}・${SOURCE_LABEL[item.system.source ?? ""] ?? "未標記"}）` : "—"}
            </div>
          </>
        )}
        {item.category === "unresolved" ? <ReasonText item={item} raw={raw} /> : item.unresolved_reason && <div className="mt-1 text-[11px] text-red-600">{item.unresolved_reason}</div>}
        {!locked && item.category === "unresolved" && (
          <div className="mt-1.5">
            <ReasonLinks item={item} raw={raw} ctx={actionCtx} />
          </div>
        )}
        {!locked && isSubSiteAmbiguous(item) && (
          <label className="mt-1 flex items-center gap-1.5 text-[11.5px] text-orange-800">
            <input type="checkbox" checked={subSiteSelected.has(rowIdFromKey(item.key))} onChange={() => toggleSubSiteSelected(rowIdFromKey(item.key))} />
            子盤未定——剔選後用上面「批量指定子盤」／「全部歸母盤確認」
          </label>
        )}
        {!locked && item.category !== "match" && (
          <div className="mt-2 flex flex-col gap-1">
            <div className="flex flex-wrap gap-1">
              {((item.category === "unresolved" ? ["exception"] : ["apply_roster", "keep_system", "exception"]) as PendingAction[]).map((a) => (
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
            <Button variant="secondary" onClick={bulkApplyRosterForVisible} disabled={bulkBusy}>
              {bulkBusy ? "標記緊…" : "全部以更表為準（限「更表有・系統冇」／「結算單位唔同」，包括未顯示項目）"}
            </Button>
            <Button variant="primary" disabled={pendingList.length === 0} onClick={() => setConfirmOpen(true)}>
              套用決定（{pendingList.length}）
            </Button>
          </>
        )}
      </div>

      {/* WP-GUARD-FIX 第二輪（老闆 2026-09-25 要求）：「子盤未定」批量
          指定子盤／全部歸母盤確認——淨係喺揀咗至少一行先出嚟。 */}
      {!locked && subSiteSelected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-orange-300 bg-orange-50 px-3 py-2">
          <span className="text-[12.5px] text-orange-800">已揀 {subSiteSelected.size} 行「子盤未定」</span>
          <select
            value={subSiteTargetId}
            onChange={(e) => setSubSiteTargetId(e.target.value)}
            className="rounded-[5px] border border-zk-border px-1.5 py-[4px] text-[12.5px]"
          >
            <option value="">揀子盤…</option>
            {childSites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.canonical_name}
              </option>
            ))}
          </select>
          <Button variant="secondary" disabled={!subSiteTargetId || subSiteBusy} onClick={() => applySubSiteBulk(subSiteTargetId)}>
            批量指定子盤
          </Button>
          <Button variant="secondary" disabled={subSiteBusy} onClick={() => applySubSiteBulk(null)}>
            全部歸母盤確認
          </Button>
          <button type="button" className="text-[11px] text-zk-faint underline" onClick={() => setSubSiteSelected(new Set())}>
            清除選取
          </button>
        </div>
      )}

      <div className={`hidden md:block ${tableCls.wrap}`}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(tableCols) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>日期</th>
              <th className={tableCls.th}>（子）盤</th>
              <th className={tableCls.th}>更種</th>
              {showWrote && <th className={tableCls.th}>更表寫咗</th>}
              {showSides && <th className={tableCls.th}>更表嗰邊</th>}
              {showSides && <th className={tableCls.th}>系統嗰邊</th>}
              <th className={tableCls.th}>分類</th>
              <th className={tableCls.th}>動作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className={tableCls.tdMuted} colSpan={tableCols}>
                  {loading ? "載入緊…" : "冇符合條件嘅項目"}
                </td>
              </tr>
            )}
            {units.map((u) =>
              u.kind === "row" ? (
                renderDesktopRow(u.item)
              ) : (
                <Fragment key={`g:${u.group.id}`}>
                  <tr className="bg-zk-header" data-testid="reconcile-group-row">
                    <td className={tableCls.td} colSpan={tableCols}>
                      {groupBody(u.group)}
                    </td>
                  </tr>
                  {expandedGroups.has(u.group.id) && u.group.items.map((it) => renderDesktopRow(it))}
                </Fragment>
              ),
            )}
          </tbody>
        </table>
      </div>


      {data && data.items.total > rows.length && (
        <div className="text-[12px] text-orange-700">
          呢個分類有 {data.items.total} 項，而家只顯示頭 {rows.length} 項——套用完呢批再重新整理會見到其餘項目。
        </div>
      )}

      {/* 手機：卡列表（README 慣例——七欄表格喺窄屏幕唔用得）。 */}
      <div className="space-y-2 md:hidden">
        {rows.length === 0 && <EmptyState title={loading ? "載入緊…" : "冇符合條件嘅項目"} />}
        {units.map((u) =>
          u.kind === "row" ? (
            renderMobileCard(u.item)
          ) : (
            <Fragment key={`g:${u.group.id}`}>
              <div className="rounded-lg border border-zk-border bg-zk-header p-3">{groupBody(u.group)}</div>
              {expandedGroups.has(u.group.id) && u.group.items.map((it) => renderMobileCard(it))}
            </Fragment>
          ),
        )}
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
