"use client";
// WP-ROSTER-UPLOAD Phase A（§15.3）：更表上載頁（排更區）——老闆／主管／
// 會計每月逐盤上載更表檔案（xlsx），即時解析＋對照（盤／更別／安員／
// 雞頭），**唔寫入 shift_records**（對數＋寫入係 Phase B）。雞頭／安員
// 呢個 module 硬性 deny，連呢頁都入唔到（API 一律 403，見 matrix.ts）。
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiGet, apiUpload, apiPatch, apiPost, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Field, selectCls } from "@/components/ui/Field";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtDate, fmtDateTime, currentMonthStr } from "@/lib/ui/format";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";

interface SiteOption {
  id: string;
  canonical_name: string;
}

interface RosterUploadDTO {
  id: string;
  month: string;
  site_id: string | null;
  site_name_raw: string;
  uploader_user_id: string;
  uploaded_at: string;
  file_name: string;
  file_sha256: string;
  file_size: number;
  version: number;
  status: "uploaded" | "parsed" | "parse_failed" | "superseded" | "confirmed";
  parse_summary: {
    total_cell_count: number;
    shift_count: number;
    unmatched_guard_count: number;
    ambiguous_guard_count: number;
    unmatched_shift_type_count: number;
    ambiguous_shift_type_count: number;
    unmatched_broker_count: number;
    out_of_month_count: number;
    // Phase B-0：合併格展開格數／子盤對唔到格數／舊工號兩類格數。
    merged_expanded_count: number;
    unmatched_sub_site_count: number;
    stale_staff_no_count: number;
    staff_no_mismatch_count: number;
    // 補丁（§17.7 未修第一項）：更別配對用 rank_raw 第三層收窄配到嘅格數。
    rank_narrowed_count: number;
    date_range: { min: string; max: string } | null;
    warnings: string[];
  } | null;
  parse_error: string | null;
  layout_key: string | null;
}

interface SiteStatusEntry {
  site_id: string | null;
  site_name: string;
  upload_status: string;
  upload: RosterUploadDTO | null;
}
interface ListResponse {
  month: string;
  sites: SiteStatusEntry[];
  unresolved_uploads: SiteStatusEntry[];
}

interface RosterUploadRowDTO {
  id: string;
  upload_id: string;
  row_index: number;
  sub_site_name: string | null;
  work_date: string;
  raw_code: string;
  code_kind: "shift" | "leave" | "ot" | "marker" | "unknown";
  shift_type_id: string | null;
  // Phase B-0 第 3 項：一檔多子盤（城巴車廠／CP5）解析後嘅實際盤——冇
  // 子盤嘅上載一律等於呢個上載自己嘅 site_id。
  resolved_site_id: string | null;
  staff_no_raw?: string;
  name_raw?: string;
  tel_raw?: string;
  rank_raw: string | null;
  time_raw: string | null;
  broker_code_raw: string | null;
  guard_id: string | null;
  guard_match: "by_staff_no" | "by_name_tel" | "by_name" | "unmatched" | "ambiguous";
  settlement_broker_id: string | null;
  hours: number | null;
  warnings: string[] | null;
}
interface DetailResponse {
  upload: RosterUploadDTO;
  rows: ApiListResult<RosterUploadRowDTO>;
}

const STATUS_LABEL: Record<string, string> = {
  not_uploaded: "未上載",
  uploaded: "已上載",
  parsed: "已上載",
  parse_failed: "解析失敗",
  superseded: "已被取代",
  confirmed: "已對數確認",
};
function statusPillVariant(status: string): "neutral" | "success" | "danger" | "warning" {
  if (status === "not_uploaded") return "neutral";
  if (status === "parse_failed") return "danger";
  if (status === "parsed" || status === "confirmed") return "success";
  return "warning";
}

const GUARD_MATCH_LABEL: Record<string, string> = {
  by_staff_no: "工號配對",
  by_name_tel: "姓名+電話配對",
  by_name: "姓名配對",
  unmatched: "未配對",
  ambiguous: "多個候選",
};

// Phase B-0 第 4 項：呢兩類淨係 warnings 文字（唔改 guard_match enum），
// 對應 API `?warning_flag=`（唔係 `?guard_match=`）。
const WARNING_FLAG_VALUES = new Set(["staff_no_mismatch", "stale_staff_no"]);

export default function RosterUploadsPage() {
  const [month, setMonth] = useState(currentMonthStr());
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [uploadSiteId, setUploadSiteId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedUploadId, setSelectedUploadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // 驗收 2026-09-23：原本淨係得「只顯示未配對」checkbox——「多個候選」（同名
  // 多人）同「淨係姓名配對」一樣要人手覆核，改做下拉。Phase B-0 第 4 項：
  // 加多兩類（工號唔一致／已取消舊號配對）——呢兩類唔係 `guard_match`
  // enum 值，係喺 warnings 文字入面（見 match.ts GuardMatchResult 註解），
  // 對應 API 嘅 `?warning_flag=` 參數（`loadDetail()` 自己分流）。
  const [matchFilter, setMatchFilter] = useState<"" | "unmatched" | "ambiguous" | "by_name" | "staff_no_mismatch" | "stale_staff_no">("");
  const [patchingSiteFor, setPatchingSiteFor] = useState<string | null>(null);

  async function loadList() {
    setLoading(true);
    setError(null);
    const res = await apiGet<ListResponse>(`/api/roster-uploads?month=${month}`);
    if (!res.ok) {
      setError(res.message);
      setLoading(false);
      return;
    }
    setList(res.data);
    setLoading(false);
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  useEffect(() => {
    apiGet<ApiListResult<SiteOption>>("/api/sites?take=500").then((res) => {
      if (res.ok) setSites(res.data.rows);
    });
  }, []);

  // 驗收 2026-09-23：API 每頁上限 500 格，大盤（例如城巴車廠）一個月過千格——
  // 之前淨係攞第一頁，後面嘅格靜靜睇唔到。而家顯示「已載入 N／共 T」＋「載入更多」。
  async function loadDetail(uploadId: string, filter?: string, append = false) {
    setDetailLoading(true);
    const skip = append && detail ? detail.rows.rows.length : 0;
    const qs = new URLSearchParams({ take: "500", skip: String(skip) });
    if (filter) {
      if (WARNING_FLAG_VALUES.has(filter)) qs.set("warning_flag", filter);
      else qs.set("guard_match", filter);
    }
    const res = await apiGet<DetailResponse>(`/api/roster-uploads/${uploadId}?${qs.toString()}`);
    setDetailLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (append && detail) {
      setDetail({ ...res.data, rows: { ...res.data.rows, rows: [...detail.rows.rows, ...res.data.rows.rows] } });
    } else {
      setDetail(res.data);
    }
  }

  function openDetail(uploadId: string) {
    setSelectedUploadId(uploadId);
    setDetail(null);
    setMatchFilter("");
    loadDetail(uploadId);
  }

  useEffect(() => {
    if (selectedUploadId) loadDetail(selectedUploadId, matchFilter || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchFilter]);

  async function doUpload(file: File) {
    if (uploading) return; // 驗收 2026-09-23：上載緊時再拖放／再撳唔好重複送
    setUploading(true);
    setNotice(null);
    setError(null);
    const form = new FormData();
    form.set("file", file);
    form.set("month", month);
    if (uploadSiteId) form.set("site_id", uploadSiteId);
    const res = await apiUpload<{ upload: RosterUploadDTO; superseded_count: number; parse_ok: boolean; parse_error: string | null; duplicate_of_version: number | null }>(
      "/api/roster-uploads",
      form,
    );
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!res.ok) {
      // Phase B-0 第 5(b) 項：檔名同該盤同月現有版本撞名——後端 400，
      // 訊息「更新檔嘅檔名必須同舊版唔同，請改檔名再上載」直接喺呢度顯示。
      setError(res.message);
      return;
    }
    if (res.data.parse_ok) {
      // Phase B-0 第 5(a) 項：同一檔（同 SHA-256）重複上載——出提示，唔擋。
      const dupNote = res.data.duplicate_of_version ? `；同第 ${res.data.duplicate_of_version} 版一模一樣（SHA-256 相同），已開新版本` : "";
      setNotice(`已上載並解析：${file.name}（版本 ${res.data.upload.version}${res.data.superseded_count ? `，取代咗 ${res.data.superseded_count} 個舊版` : ""}${dupNote}）`);
    } else {
      setError(`已存底但解析失敗：${res.data.parse_error ?? "未知原因"}`);
    }
    await loadList();
    openDetail(res.data.upload.id);
  }

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) doUpload(file);
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) doUpload(file);
  }

  async function patchSiteId(uploadId: string, siteId: string) {
    setPatchingSiteFor(uploadId);
    const res = await apiPatch(`/api/roster-uploads/${uploadId}`, { site_id: siteId || null });
    setPatchingSiteFor(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice(siteId ? "已指定盤，重新配對完成" : "已清返盤");
    await loadList();
    if (selectedUploadId === uploadId) loadDetail(uploadId, matchFilter || undefined);
  }

  async function doReparse(uploadId: string) {
    const res = await apiPost(`/api/roster-uploads/${uploadId}/reparse`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已重新解析");
    await loadList();
    if (selectedUploadId === uploadId) loadDetail(uploadId, matchFilter || undefined);
  }

  const allEntries = list ? [...list.sites, ...list.unresolved_uploads] : [];
  const colCount = 6;

  return (
    <div className="space-y-4">
      <PageHeader
        kicker="排更"
        title="更表上載"
        subtitle="會計／主管／老闆每月逐盤上載更表檔案（xlsx）——呢個係計糧嘅唯一依據，系統自己報更淨係參考／輔助。"
        actions={
          <FilterChip label="月份" showCaret={false}>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </FilterChip>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {/* 上載區：拖放或選檔 */}
      <div className="rounded-lg border border-zk-border bg-white p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="盤（可選——盤名對唔到可以先唔揀，之後人手指定）">
            <select className={selectCls} value={uploadSiteId} onChange={(e) => setUploadSiteId(e.target.value)}>
              <option value="">（由檔案盤名自動配對）</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.canonical_name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div
          data-testid="roster-upload-dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
            dragOver ? "border-[#2563eb] bg-blue-50" : "border-zk-border bg-zk-surface"
          }`}
        >
          <div className="text-[13.5px] font-medium text-zk-text">{uploading ? "上載緊…" : "拖放更表 xlsx 到呢度，或者撳呢度揀檔"}</div>
          <div className="text-[12px] text-zk-muted">單一 xlsx 檔案，最大 20MB</div>
          <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={onFileChosen} disabled={uploading} data-testid="roster-upload-file-input" />
        </div>
      </div>

      {/* 逐盤狀態表 */}
      {!loading && allEntries.length === 0 ? (
        <div className={tableCls.wrap}>
          <EmptyState title={`${month} 未有任何盤`} description="先去「盤」頁加盤。" />
        </div>
      ) : (
        <>
          <div className={`hidden sm:block ${tableCls.wrap}`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>盤</th>
                  <th className={tableCls.th}>狀態</th>
                  <th className={tableCls.thNum}>版本</th>
                  <th className={tableCls.thNum}>更數</th>
                  <th className={tableCls.thNum}>未配對</th>
                  <th className={tableCls.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td className={tableCls.tdMuted} colSpan={colCount}>
                      載入緊…
                    </td>
                  </tr>
                )}
                {allEntries.map((entry) => {
                  const u = entry.upload;
                  const summary = u?.parse_summary;
                  return (
                    <tr key={entry.site_id ?? `unresolved:${u?.id}`} className={tableCls.rowHover}>
                      <td className={`${tableCls.td} font-medium`}>
                        {entry.site_name}
                        {!entry.site_id && <span className="ml-1.5 text-[11px] text-orange-600">（盤名未配對）</span>}
                      </td>
                      <td className={tableCls.td}>
                        <Pill variant={statusPillVariant(entry.upload_status)}>{STATUS_LABEL[entry.upload_status] ?? entry.upload_status}</Pill>
                        {u?.status === "parse_failed" && u.parse_error && <div className="mt-1 text-[11px] text-red-600">{u.parse_error}</div>}
                      </td>
                      <td className={tableCls.tdNum}>{u ? `v${u.version}` : "—"}</td>
                      <td className={tableCls.tdNum}>{summary ? summary.shift_count : "—"}</td>
                      <td className={tableCls.tdNum}>
                        {summary && summary.unmatched_guard_count > 0 ? (
                          <span className="font-semibold text-orange-600">{summary.unmatched_guard_count}</span>
                        ) : summary ? (
                          "0"
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={tableCls.td}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {u && (
                            <button type="button" onClick={() => openDetail(u.id)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155] hover:bg-zk-header">
                              睇詳情
                            </button>
                          )}
                          {/* B1-3：對數頁入口——冇解到盤（entry.site_id 未定）就冧唔到
                              盤，先要 PATCH 指定盤先可以對數。 */}
                          {u && entry.site_id && (u.status === "parsed" || u.status === "confirmed") && (
                            <Link
                              href={`/roster-uploads/${u.id}/reconcile`}
                              className="rounded-[5px] border border-zk-primary px-2.5 py-[3px] text-xs font-medium text-zk-primary hover:bg-blue-50"
                            >
                              對數
                            </Link>
                          )}
                          {u && !entry.site_id && (
                            <select
                              className="rounded-[5px] border border-zk-border px-1.5 py-[3px] text-xs"
                              value=""
                              disabled={patchingSiteFor === u.id}
                              onChange={(e) => e.target.value && patchSiteId(u.id, e.target.value)}
                            >
                              <option value="">指定盤…</option>
                              {sites.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.canonical_name}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 手機（&lt;640）：卡列表 */}
          <div className="space-y-2 sm:hidden">
            {loading && <div className="rounded-lg border border-zk-border bg-white p-3 text-center text-[13px] text-zk-muted">載入緊…</div>}
            {allEntries.map((entry) => {
              const u = entry.upload;
              const summary = u?.parse_summary;
              return (
                <div key={entry.site_id ?? `unresolved:${u?.id}`} className="rounded-lg border border-zk-border bg-white p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13.5px] font-medium text-zk-text">{entry.site_name}</span>
                    <Pill variant={statusPillVariant(entry.upload_status)}>{STATUS_LABEL[entry.upload_status] ?? entry.upload_status}</Pill>
                  </div>
                  <div className="mt-1 text-[11.5px] text-zk-muted">
                    {u ? `v${u.version} · ${summary ? `${summary.shift_count} 更 · 未配對 ${summary.unmatched_guard_count}` : ""}` : "未上載"}
                    {!entry.site_id && <span className="ml-1.5 text-orange-600">（盤名未配對）</span>}
                  </div>
                  {u?.status === "parse_failed" && u.parse_error && <div className="mt-1 text-[11px] text-red-600">{u.parse_error}</div>}
                  {u && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button type="button" onClick={() => openDetail(u.id)} className="rounded-[5px] border border-zk-border px-2.5 py-[3px] text-xs text-[#334155]">
                        睇詳情
                      </button>
                      {entry.site_id && (u.status === "parsed" || u.status === "confirmed") && (
                        <Link href={`/roster-uploads/${u.id}/reconcile`} className="rounded-[5px] border border-zk-primary px-2.5 py-[3px] text-xs font-medium text-zk-primary">
                          對數
                        </Link>
                      )}
                      {/* 驗收 2026-09-23：手機之前冇「指定盤」，盤名對唔到嘅上載喺手機處理唔到 */}
                      {!entry.site_id && (
                        <select
                          className="rounded-[5px] border border-zk-border px-1.5 py-[3px] text-xs"
                          value=""
                          disabled={patchingSiteFor === u.id}
                          onChange={(e) => e.target.value && patchSiteId(u.id, e.target.value)}
                          aria-label="指定盤"
                        >
                          <option value="">指定盤…</option>
                          {sites.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.canonical_name}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* 逐上載詳情 */}
      {selectedUploadId && (
        <div className="rounded-lg border border-zk-border bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[14px] font-semibold text-zk-text">
                {detail?.upload.file_name ?? "詳情"}
                {detail && <span className="ml-2 text-[12px] text-zk-muted">v{detail.upload.version} · 上載於 {fmtDateTime(detail.upload.uploaded_at)}</span>}
              </div>
              {detail?.upload.layout_key && <div className="text-[11.5px] text-zk-faint">layout: {detail.upload.layout_key}</div>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12.5px] text-zk-muted">
                篩選
                <select
                  className="rounded-[5px] border border-zk-border px-1.5 py-[3px] text-xs"
                  value={matchFilter}
                  onChange={(e) => setMatchFilter(e.target.value as typeof matchFilter)}
                  data-testid="roster-upload-match-filter"
                >
                  <option value="">全部</option>
                  <option value="unmatched">只顯示未配對</option>
                  <option value="ambiguous">只顯示多個候選</option>
                  <option value="by_name">只顯示淨係姓名配對</option>
                  <option value="staff_no_mismatch">只顯示工號不一致</option>
                  <option value="stale_staff_no">只顯示用已取消舊號配對</option>
                </select>
              </label>
              <Button variant="secondary" onClick={() => selectedUploadId && doReparse(selectedUploadId)}>
                重新解析
              </Button>
              <Button variant="secondary" onClick={() => setSelectedUploadId(null)}>
                收起
              </Button>
            </div>
          </div>

          {detail?.upload.parse_summary && detail.upload.parse_summary.warnings.length > 0 && (
            <ul className="mb-3 list-disc space-y-0.5 rounded-md border border-orange-200 bg-orange-50 py-2 pl-6 pr-3 text-[12px] text-orange-800" data-testid="roster-upload-summary-warnings">
              {detail.upload.parse_summary.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {detailLoading && !detail && <div className="py-6 text-center text-[13px] text-zk-muted">載入緊…</div>}

          {detail && (
            <>
            <div className="mb-1.5 text-[12px] text-zk-muted" data-testid="roster-upload-rows-count">
              已載入 {detail.rows.rows.length}／共 {detail.rows.total} 格
            </div>
            <div className={`overflow-x-auto rounded-md border border-zk-border`}>
              <table className={tableCls.table} style={{ minWidth: tableMinWidth(7) }}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>日期</th>
                    <th className={tableCls.th}>代號</th>
                    <th className={tableCls.th}>更種</th>
                    <th className={tableCls.th}>安員配對</th>
                    <th className={tableCls.th}>雞頭碼</th>
                    <th className={tableCls.th}>子盤</th>
                    <th className={tableCls.th}>警告</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.rows.rows.length === 0 && (
                    <tr>
                      <td className={tableCls.tdMuted} colSpan={7}>
                        冇符合條件嘅記錄
                      </td>
                    </tr>
                  )}
                  {detail.rows.rows.map((r) => {
                    const style = shiftCodeStyle(r.raw_code, { isLeave: r.code_kind === "leave" });
                    return (
                      <tr key={r.id} className={tableCls.rowHover}>
                        <td className={tableCls.td}>{fmtDate(r.work_date)}</td>
                        <td className={tableCls.td}>
                          <span
                            className="inline-flex items-center rounded-[10px] px-2 py-0.5 text-[11px] font-semibold"
                            style={{ background: style.bg, color: style.fg, border: style.border }}
                          >
                            {r.raw_code}
                          </span>
                        </td>
                        <td className={tableCls.td}>{r.code_kind}</td>
                        <td className={tableCls.td}>
                          <Pill variant={r.guard_match === "unmatched" || r.guard_match === "ambiguous" ? "warning" : "success"}>{GUARD_MATCH_LABEL[r.guard_match]}</Pill>
                          {r.name_raw && <span className="ml-1.5 text-[11.5px] text-zk-muted">{r.name_raw}</span>}
                        </td>
                        <td className={tableCls.td}>{r.broker_code_raw ?? "—"}</td>
                        <td className={tableCls.td}>
                          {r.sub_site_name ?? "—"}
                          {r.sub_site_name && !r.resolved_site_id && <span className="ml-1 text-[11px] text-orange-600">（子盤未配對）</span>}
                        </td>
                        <td className={`${tableCls.td} text-[11.5px] text-orange-700`}>{r.warnings && r.warnings.length ? r.warnings.join("；") : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {detail.rows.rows.length < detail.rows.total && (
              <div className="mt-2 text-center">
                <Button variant="secondary" disabled={detailLoading} onClick={() => selectedUploadId && loadDetail(selectedUploadId, matchFilter || undefined, true)}>
                  {detailLoading ? "載入緊…" : "載入更多"}
                </Button>
              </div>
            )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
