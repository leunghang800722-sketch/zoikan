"use client";
// P2-WP-R3：老闆／主管／會計首頁「今日尚欠」（README §02／§15；手機 §21）。
// P3-3.3：尚欠總覽頁 `/reports/shortfall` 已併入首頁（redirect `/`），`variant="overview"` 分支刪走；
// 待審批／更表對數待處理兩張卡搬去 `HomeInbox`（待辦收件箱）。日期切換 chip 撳 ‹ › 前後一日、重新 fetch `?date=`，並用
// `history.replaceState` 同步落 URL（唔用 `useSearchParams()`，跟
// RosterEditor.tsx 同一個理由：避免呢個 client component 被迫加
// Suspense boundary）。
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { KpiCard } from "@/components/ui/KpiCard";
import { tableCls, EmptyState } from "@/components/ui/DataTable";
import { fmtMoney, fmtDateWeekday, fmtMonthDayWeekday, addDaysStr, todayLocalStr, greetingWord } from "@/lib/ui/format";

// API response 一律 snake_case（見 src/lib/api/http.ts）。
interface SiteRow {
  site_id: string;
  site_name: string;
  required: number;
  confirmed: number;
  shortfall: number;
}
interface Result {
  date: string;
  today: SiteRow[];
  pending_approval_count: number;
  // P2 整合驗收應修③：全部未審批數（唔篩月份）——同側欄 badge／
  // `/approvals` 頁口徑一致，KPI 大數改用呢個（`pending_approval_count`
  // 淨係用嚟喺兩者唔同時加多一行 note，見底下 `PendingApprovalNote`）。
  pending_approval_total: number;
}
// P3-2.2：月級毛利進度改由 `GET /api/reports/margin-progress?month=` 提供（同日級並行載入、
// 唔互相等；每次開／換月即時重計，冇 cache）。
interface MarginProgress {
  month: string;
  revenue?: number;
  cost?: number;
  profit?: number;
  margin_pct: number | null;
  threshold_pct: number;
  below_threshold_site_count: number;
}

const MARGIN_SCALE_MAX = 20; // README：進度條 0%–20% 刻度

// 用 shortfall（=required-confirmed）判斷紅／綠，唔淨係比較 required/
// confirmed——先夾得埋「required=0 但有額外出勤」呢種盤（冇正式所需人手
// 但有人出勤，shortfall=負數，唔算尚欠，應該着綠，唔係因為 required=0
// 就當「未達標」變紅）。
function confirmedBarColor(s: SiteRow): string {
  return s.shortfall > 0 ? "#dc2626" : "#0f766e";
}
function confirmedBarPct(s: SiteRow): number {
  if (s.required <= 0) return s.confirmed > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, (s.confirmed / s.required) * 100));
}

/** URL query `?date=` 讀（一次性，載入時）／寫（撳 chip 即刻 replaceState，
 * 唔加 history stack）——同 RosterEditor.tsx 嘅 `?broker=` 同步手法一致。 */
function readDateFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("date");
}
function writeDateToUrl(date: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("date", date);
  window.history.replaceState(null, "", url.toString());
}

function DateChip({ date, onChange }: { date: string; onChange: (next: string) => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-zk-border bg-white px-2.5 py-[5px] text-[13px] text-[#334155]">
      <button
        type="button"
        aria-label="前一日"
        data-testid="shortfall-date-prev"
        onClick={() => onChange(addDaysStr(date, -1))}
        className="px-0.5 text-zk-faint hover:text-zk-text"
      >
        ‹
      </button>
      <span data-testid="shortfall-date-label">{fmtDateWeekday(date)}</span>
      <button
        type="button"
        aria-label="後一日"
        data-testid="shortfall-date-next"
        onClick={() => onChange(addDaysStr(date, 1))}
        className="px-0.5 text-zk-faint hover:text-zk-text"
      >
        ›
      </button>
    </div>
  );
}

function MarginProgressCard({ monthProgress, href }: { monthProgress: MarginProgress; href?: string }) {
  const pct = monthProgress.margin_pct == null ? 0 : Math.min(100, Math.max(0, (monthProgress.margin_pct / MARGIN_SCALE_MAX) * 100));
  const thresholdLeft = Math.min(100, Math.max(0, (monthProgress.threshold_pct / MARGIN_SCALE_MAX) * 100));
  const cls = "flex flex-col rounded-[10px] border border-zk-border bg-white px-3.5 py-3 md:px-[18px] md:py-4 col-span-2";

  const inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-zk-muted">本月毛利進度（{monthProgress.month}）</div>
        {monthProgress.below_threshold_site_count > 0 && (
          <div className="shrink-0 text-[11.5px] font-semibold text-[#dc2626]">
            {monthProgress.below_threshold_site_count} 個盤毛利率低於 {monthProgress.threshold_pct}%
          </div>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2.5">
        <span data-testid="margin-pct-value" className="text-[28px] leading-[1.1] font-bold text-zk-text md:text-[30px]">
          {monthProgress.margin_pct == null ? "—" : `${monthProgress.margin_pct}%`}
        </span>
        {monthProgress.revenue !== undefined && (
          <span className="text-xs text-zk-muted">
            毛利 {fmtMoney(monthProgress.profit)} / 營業額 {fmtMoney(monthProgress.revenue)}
          </span>
        )}
      </div>
      <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-zk-surface">
        <div className="absolute inset-y-0 left-0 bg-zk-primary" style={{ width: `${pct}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-[#dc2626]" style={{ left: `${thresholdLeft}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-zk-faint">
        <span>0%</span>
        <span className="text-[#dc2626]">{monthProgress.threshold_pct}% 警戒線</span>
        <span>{MARGIN_SCALE_MAX}%</span>
      </div>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={`${cls} cursor-pointer transition-colors hover:bg-zk-header`}>
        {inner}
      </Link>
    );
  }
  return <div className={cls}>{inner}</div>;
}

function MarginSlot({ progress, error }: { progress: MarginProgress | null; error: string | null }) {
  if (progress) return <MarginProgressCard monthProgress={progress} href="/reports/gross-margin" />;
  return (
    <div data-testid="margin-progress-loading" className="col-span-2 flex flex-col rounded-[10px] border border-zk-border bg-white px-3.5 py-3 text-xs text-zk-muted md:px-[18px] md:py-4">
      {error ? `本月毛利進度載入失敗：${error}` : "本月毛利進度計算中…"}
    </div>
  );
}

export interface ShortfallDashboardProps {
  userName: string;
  roleLabel: string;
  // P3-0.4：按權限隱藏卡（預設顯示，保持舊 caller 行為）。
  showMargin?: boolean;
}

export default function ShortfallDashboard({ userName, roleLabel, showMargin = true }: ShortfallDashboardProps) {
  // SSR／首次 client render 一律用 `todayLocalStr()`（避免 hydration
  // mismatch——`window` 喺 SSR 冇得攞，見 `readDateFromUrl()`）；URL 已有
  // `?date=` 就喺下面呢個 effect 入面先切換，同 RosterEditor.tsx 嘅
  // `?broker=` 同步手法一致。
  const [date, setDate] = useState<string>(() => todayLocalStr());
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marginProgress, setMarginProgress] = useState<MarginProgress | null>(null);
  const [marginError, setMarginError] = useState<string | null>(null);
  const marginMonth = date.slice(0, 7);

  useEffect(() => {
    const fromUrl = readDateFromUrl();
    if (fromUrl && fromUrl !== date) {
      setDate(fromUrl); // 觸發呢個 effect 用正確日期重新行一次，落面就唔使 fetch
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      const res = await apiGet<Result>(`/api/reports/shortfall?date=${date}&include_margin=0`);
      if (cancelled) return;
      if (!res.ok) {
        setError(res.message);
        setLoading(false);
        return;
      }
      setData(res.data);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [date]);

  // 月級毛利進度：只喺月份變先重拉（撳 ‹ › 喺同一個月內換日唔重拉）。
  useEffect(() => {
    if (!showMargin) return;
    let cancelled = false;
    setMarginProgress(null);
    setMarginError(null);
    (async () => {
      const res = await apiGet<MarginProgress>(`/api/reports/margin-progress?month=${marginMonth}`);
      if (cancelled) return;
      if (res.ok) setMarginProgress(res.data);
      else setMarginError(res.message);
    })();
    return () => {
      cancelled = true;
    };
  }, [marginMonth, showMargin]);

  function changeDate(next: string) {
    setDate(next);
    writeDateToUrl(next);
  }

  if (error) return <Banner kind="error" message={error} />;

  const shortfallSites = data?.today.filter((s) => s.shortfall > 0) ?? [];
  const totalShort = shortfallSites.reduce((a, s) => a + s.shortfall, 0);
  const kicker = `${roleLabel} · 今日尚欠情況一覽`;
  const title = `歡迎返嚟，${userName}`;
  // B3 驗收修正：手機版原本冇任何可見 <h1>（桌面 <h1> 由 PageHeader
  // 出，但成個 PageHeader 包喺 `hidden md:block` 度，手機淨係得一個
  // `<div>` 重複文字，等於手機頁面完全冇 heading）。改做「同一個 h1、
  // 兩邊都係 heading」：淨係一個 <h1> 元素，入面兩個 <span> 用
  // `hidden`/`md:hidden` responsive class 互相排斥，唔再用兩個獨立
  // block 各自 hidden 嗰種寫法。
  const mobileHeading = `${greetingWord()}，${userName}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 md:flex-row md:flex-wrap md:items-end md:justify-between md:gap-4">
        <div>
          <div className="text-xs text-zk-muted md:text-[12.5px]">
            <span className="md:hidden">{`${fmtMonthDayWeekday(date)} · ${roleLabel}`}</span>
            <span className="hidden md:inline">{kicker}</span>
          </div>
          <h1 className="mt-0.5 text-[20px] font-bold text-zk-text md:text-[22px] md:tracking-[-0.01em]">
            <span className="md:hidden">{mobileHeading}</span>
            <span className="hidden md:inline">{title}</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {/* 手機：問候語頁首唔使日期 chip（README §21 冇畫呢個掣）。 */}
          <div className="hidden md:block">
            <DateChip date={date} onChange={changeDate} />
          </div>
        </div>
      </div>

      {loading && !data ? (
        <div className="text-sm text-zk-faint">載入緊…</div>
      ) : data ? (
        <>
          {/* 桌面 KPI grid：README `repeat(auto-fit,minmax(240px,1fr))` gap 12px。 */}
          <div className="hidden grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3 md:grid">
            <KpiCard
              label="今日尚欠盤數"
              value={<span data-testid="shortfall-count-value">{shortfallSites.length}</span>}
              tone={shortfallSites.length > 0 ? "danger" : "default"}
              note={shortfallSites.length > 0 ? `共欠 ${totalShort} 更` : "今日各盤人手足夠"}
            >
              {shortfallSites.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {shortfallSites.slice(0, 6).map((s) => (
                    <span key={s.site_id} className="rounded-[10px] bg-[#fef2f2] px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-[#b91c1c]">
                      {s.site_name} 欠 {s.shortfall}
                    </span>
                  ))}
                </div>
              )}
            </KpiCard>
            {showMargin && <MarginSlot progress={marginProgress} error={marginError} />}
          </div>

          {/* 手機 KPI 2×2（尚欠／待審批；毛利跨 2 欄）。 */}
          <div className="grid grid-cols-2 gap-2.5 md:hidden">
            <KpiCard
              label="今日尚欠盤數"
              value={<span data-testid="shortfall-count-value">{shortfallSites.length}</span>}
              tone={shortfallSites.length > 0 ? "danger" : "default"}
              note={shortfallSites.length > 0 ? `共欠 ${totalShort} 更` : "人手足夠"}
            />
            {showMargin && <MarginSlot progress={marginProgress} error={marginError} />}
          </div>

          {/* 桌面表格。 */}
          <div className="hidden flex-col gap-2 md:flex">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-zk-text">今日各盤出勤 vs 所需</h2>
              <span className="text-xs text-zk-muted">尚欠嘅盤排最前 · 撳行＝去更表</span>
            </div>
            <div className={tableCls.wrap}>
              <table className={tableCls.table}>
                <thead>
                  <tr>
                    <th className={tableCls.th}>盤</th>
                    <th className={tableCls.thNum}>所需</th>
                    <th className={tableCls.thNum}>已確認</th>
                    <th className={tableCls.thNum}>尚欠</th>
                  </tr>
                </thead>
                <tbody>
                  {data.today.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <EmptyState title="今日暫時冇排更資料" description="未有任何盤設定今日所需人手或者出勤記錄。" />
                      </td>
                    </tr>
                  )}
                  {data.today.map((s) => (
                    <tr
                      key={s.site_id}
                      data-testid="shortfall-row"
                      // B1 驗收修正：成行撳得原本靠 `<tr onClick>`——冇
                      // 鍵盤焦點、Tab 唔到，亦冇 focus-visible 樣式。改
                      // 用「行內覆蓋真 <a>」呢個標準無障礙 pattern：
                      // `relative` 落喺 <tr>，第一個 <td> 入面嘅
                      // `next/link` 用 `absolute inset-0`（相對嗰個
                      // positioned 嘅 <tr> 伸展去成行闊／高），視覺上
                      // 「成行都撳得」，同時本身係一個真 <a>，可以
                      // Tab 到、有 focus-visible outline。
                      className={`relative ${tableCls.rowHover} ${s.shortfall > 0 ? tableCls.warnRow : ""}`}
                    >
                      <td className={`${tableCls.td} font-medium`}>
                        <Link
                          href={`/roster/${s.site_id}/${date.slice(0, 7)}`}
                          className="absolute inset-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zk-primary"
                          aria-label={`開啟 ${s.site_name} 更表`}
                        />
                        <span aria-hidden="true">{s.site_name}</span>
                      </td>
                      <td className={tableCls.tdNum}>{s.required}</td>
                      <td className={tableCls.tdNum}>
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-[5px] w-20 overflow-hidden rounded-full bg-zk-surface">
                            <div className="h-full" style={{ width: `${confirmedBarPct(s)}%`, background: confirmedBarColor(s) }} />
                          </div>
                          <span>{s.confirmed}</span>
                        </div>
                      </td>
                      <td className={s.shortfall > 0 ? "border-b border-[#f1f5f9] px-3.5 py-2.5 text-right font-bold text-[#dc2626]" : `${tableCls.tdMuted} text-right`}>
                        {s.shortfall > 0 ? s.shortfall : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 手機：「今日出勤 vs 所需」列表卡（README §21）。 */}
          <div className="flex flex-col gap-2 md:hidden">
            <div className="flex items-baseline justify-between">
              <div className="text-[13.5px] font-semibold text-zk-text">今日出勤 vs 所需</div>
            </div>
            <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
              {data.today.length === 0 ? (
                <EmptyState title="今日暫時冇排更資料" />
              ) : (
                data.today.map((s) => (
                  // B2 驗收修正：同 B1 一致——「撳列表卡」改用真
                  // `next/link`（唔再係 `<div onClick>`），可以 Tab
                  // 到、有 focus-visible 樣式。
                  <Link
                    key={s.site_id}
                    href={`/roster/${s.site_id}/${date.slice(0, 7)}`}
                    data-testid="shortfall-row-mobile"
                    className="flex items-center gap-2.5 border-b border-[#f1f5f9] px-3.5 py-2.5 last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zk-primary"
                  >
                    <div className="min-w-0 flex-1 truncate text-[13px] text-zk-text">{s.site_name}</div>
                    <div className="h-[5px] w-20 shrink-0 overflow-hidden rounded-full bg-zk-surface">
                      <div className="h-full" style={{ width: `${confirmedBarPct(s)}%`, background: confirmedBarColor(s) }} />
                    </div>
                    <div className="w-12 shrink-0 text-right text-xs text-zk-text-secondary">
                      {s.confirmed}
                      <span className="text-zk-faint">/{s.required}</span>
                    </div>
                    <div className={`w-6 shrink-0 text-right text-[12.5px] font-bold ${s.shortfall > 0 ? "text-[#dc2626]" : "text-zk-faintest"}`}>
                      {s.shortfall > 0 ? s.shortfall : "—"}
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
