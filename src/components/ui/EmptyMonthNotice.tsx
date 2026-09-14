"use client";
// A5（Opus 整合驗收）：報表／列表頁預設顯示「當月」，但當月啱啱冇資料
// 嗰陣，畫面單淨顯示空狀態，用戶未必知道係咪成個系統冇資料，定係淨係
// 呢個月冇。加呢個 Notice——淨係喺「而家睇緊嘅月份＝今個月」而且「呢個
// 月零資料」先觸發，查 GET /api/months/latest-with-data（唯讀，見嗰個
// route 註解）攞「最近有資料嘅月份」，一撳即刻跳去嗰個月（`onJump` 通常
// 就係 caller 嘅 `setMonth`）。
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/ui/api-client";
import { Notice } from "@/components/ui/Notice";
import { currentMonthStr } from "@/lib/ui/format";

interface LatestMonthResult {
  latest_month: string | null;
}

export function EmptyMonthNotice({ month, isEmpty, onJump }: { month: string; isEmpty: boolean; onJump: (month: string) => void }) {
  const isCurrentMonth = month === currentMonthStr();
  const shouldCheck = isCurrentMonth && isEmpty;
  const [latestMonth, setLatestMonth] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!shouldCheck) {
      setChecked(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await apiGet<LatestMonthResult>("/api/months/latest-with-data");
      if (cancelled) return;
      setLatestMonth(res.ok ? res.data.latest_month : null);
      setChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldCheck]);

  if (!shouldCheck || !checked || !latestMonth || latestMonth === month) return null;

  return (
    <Notice
      variant="info"
      action={
        <button type="button" data-testid="empty-month-jump" onClick={() => onJump(latestMonth)} className="font-semibold text-[#1e40af] underline">
          去 {latestMonth}
        </button>
      }
    >
      {month} 未有資料 · 最近有資料嘅月份係 {latestMonth}
    </Notice>
  );
}
