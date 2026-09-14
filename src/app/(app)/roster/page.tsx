"use client";
// P2-B：更表索引（README §03）——兩欄 grid：左卡「開啟更表」（盤／月份
// select＋開啟 primary）；右邊「最近開過」＝呢個月最近有更表改動嘅盤
// （最多 8 個，Opus 驗收 M3；唯讀 `GET /api/roster/overview?month=`，見
// src/lib/reports/roster-overview.ts 註解：用 shift_records 代替真正嘅
// 瀏覽歷史，唔加新表）。撳一項＝去 `/roster/<site>/<month>`；列表下面
// 「全部盤用左邊選單開」提示用左卡開其他盤。
//
// 「已鎖定」pill：`month_closes` 係月級（一個月一行，唔分盤）——呢個
// pill 顯示嘅係「呢個盤所屬嗰個月」有冇鎖定，唔係呢個盤自己有冇獨立嘅
// 鎖定狀態（見 src/lib/reports/roster-overview.ts 嘅 `locked` 計法）。
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiGet, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/DataTable";
import { currentMonthStr } from "@/lib/ui/format";

// README「表單控件」：padding 9–10px 12px、1px solid #d1d5db、圓角
// 7–8px、13.5–14px——冇共用 ui component 出呢個 class（Field.tsx 係 P1
// 前舊樣式，唔屬於呢次規格），逐頁自己攞呢串（同 RosterEditor.tsx 現有
// 工具列 input 同一套色）。
const fieldCls = "w-full rounded-lg border border-[#d1d5db] bg-white px-3 py-2 text-[13.5px] text-zk-text focus:border-zk-primary focus:outline-none";

interface SiteRow {
  id: string;
  canonical_name: string;
  client_name?: string;
  status: string;
}

interface OverviewRow {
  site_id: string;
  site_name: string;
  guard_count: number;
  shift_count: number;
  locked: boolean;
  // Opus 驗收 M1：null＝雞頭 session（API 結構性唔傳呢個盤級口徑俾雞頭，
  // 見 src/lib/reports/roster-overview.ts 檔頭註解）——雞頭 pill 淨係出
  // 「已鎖定」／「排更中」，唔顯示「欠 N 更」（避免反推盤總所需人手）。
  shortfall: number | null;
}

function StatusPill({ row }: { row: OverviewRow }) {
  if (row.locked) return <Pill variant="warning">已鎖定</Pill>;
  // Pill 冇「危險/紅」variant（README 呢個 pill 用嘅紅色同 Pill 現有
  // variant 唔同色階，唔改現有 ui/Pill.tsx，呢度用同一個組件外形手砌）。
  if (row.shortfall !== null && row.shortfall > 0) {
    return (
      <span className="inline-flex items-center rounded-[10px] px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap" style={{ background: "#fef2f2", color: "#dc2626" }}>
        欠 {row.shortfall} 更
      </span>
    );
  }
  return <Pill variant="success">排更中</Pill>;
}

export default function RosterEntryPage() {
  const router = useRouter();
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [siteId, setSiteId] = useState("");
  const [month, setMonth] = useState(() => currentMonthStr());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [overview, setOverview] = useState<OverviewRow[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await apiGet<ApiListResult<SiteRow>>("/api/sites?take=500");
      if (!res.ok) {
        setError(res.message);
      } else {
        setSites(res.data.rows);
        if (res.data.rows.length > 0) setSiteId(res.data.rows[0].id);
      }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setOverviewLoading(true);
      const res = await apiGet<{ month: string; sites: OverviewRow[] }>(`/api/roster/overview?month=${month}`);
      if (cancelled) return;
      if (!res.ok) {
        setOverviewError(res.message);
        setOverviewLoading(false);
        return;
      }
      setOverview(res.data.sites);
      setOverviewError(null);
      setOverviewLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [month]);

  function onOpen(e: React.FormEvent) {
    e.preventDefault();
    if (!siteId || !month) return;
    router.push(`/roster/${siteId}/${month}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader kicker="排更" title="更表" subtitle="揀盤揀月，開啟嗰個月嘅更表編輯器。" />

      <Banner kind="error" message={error} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(280px,380px)_1fr]">
        {/* 左卡：開啟更表。 */}
        <form onSubmit={onOpen} className="flex h-fit flex-col gap-3 rounded-[10px] border border-zk-border bg-white p-4">
          <div className="text-[13.5px] font-semibold text-zk-text">開啟更表</div>
          <label className="block space-y-1.5">
            <span className="block text-xs text-zk-muted">盤</span>
            <select className={fieldCls} value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={loading} required>
              {sites.length === 0 && <option value="">（冇盤）</option>}
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.canonical_name}
                  {s.client_name ? `（${s.client_name}）` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="block text-xs text-zk-muted">月份</span>
            <input type="month" className={fieldCls} value={month} onChange={(e) => setMonth(e.target.value)} required />
          </label>
          <Button type="submit" variant="primary" disabled={loading || !siteId} className="w-full">
            開啟
          </Button>
        </form>

        {/* 右邊：最近開過。 */}
        <div className="flex flex-col gap-2">
          <div className="text-[13.5px] font-semibold text-zk-text">最近開過</div>
          <Banner kind="error" message={overviewError} />
          {overviewLoading ? (
            <div className="text-sm text-zk-faint">載入緊…</div>
          ) : overview.length === 0 ? (
            <div className="rounded-[10px] border border-zk-border bg-white">
              <EmptyState title={`${month} 未有任何盤嘅更表記錄`} description="呢個月未有任何盤排過更或者雞頭指派，開啟一個盤嘅更表開始排更。" />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {overview.map((row) => (
                <Link
                  key={row.site_id}
                  href={`/roster/${row.site_id}/${month}`}
                  data-testid="roster-overview-row"
                  className="flex items-center justify-between gap-3 rounded-lg border border-zk-border bg-white px-4 py-3 transition-colors hover:bg-zk-header focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-zk-primary"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium text-zk-text">{row.site_name}</div>
                    <div className="mt-0.5 text-[11.5px] text-zk-muted">
                      {month} · {row.guard_count} 人 · {row.shift_count} 更
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusPill row={row} />
                    <span className="text-zk-faint">›</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
          {!overviewLoading && overview.length > 0 && <div className="text-[11.5px] text-zk-faint">全部盤用左邊選單開。</div>}
        </div>
      </div>
    </div>
  );
}
