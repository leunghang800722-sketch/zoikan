"use client";
// WP-POSTORDER-FREE（§34 C）：④ 自動處理摘要下面一行「價錢：N／M 更唔靠 Postorder 都計到（X%）；雞頭歸屬：N／M（Y%）」
// ＋「補齊價目卡 ›」（該月有補齊 session 仍有未答題先出，連去待答問題頁）。純展示；數字全部由 report.auto.summary.postorder_dependency 來。
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/ui/api-client";
import type { AutoReportDTO } from "@/components/month-close/types";
import { dependencyLine } from "@/components/month-close/derive";

interface BackfillStatus {
  session_id: string | null;
  open: number;
}

export function PostorderDependencyLine({ auto, month }: { auto: AutoReportDTO; month: string }) {
  const line = dependencyLine(auto.summary.postorder_dependency);
  const [st, setSt] = useState<BackfillStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await apiGet<BackfillStatus>(`/api/rate-cards/backfill-from-postorder?month=${month}`);
      if (alive && res.ok) setSt(res.data);
    })();
    return () => {
      alive = false;
    };
  }, [month]);
  if (!line) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zk-border-soft px-4 py-2.5 text-[12.5px] text-[#334155]" data-testid="auto-dependency">
      <span data-testid="auto-dependency-price">{line.price}</span>
      <span className="text-zk-faint">；</span>
      <span data-testid="auto-dependency-settle">{line.settle}</span>
      {st && st.open > 0 && (
        <Link href="/triage" className="ml-auto whitespace-nowrap text-zk-primary hover:underline" data-testid="auto-dependency-backfill">
          補齊價目卡 ›（{st.open} 題待答）
        </Link>
      )}
    </div>
  );
}
