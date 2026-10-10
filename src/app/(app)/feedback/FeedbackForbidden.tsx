// P3-5.3：「現場意見」淨係老闆睇得到——清單頁同詳情頁共用嘅無權限畫面。
import { PageHeader } from "@/components/ui/PageHeader";
import { kickerFor } from "@/lib/nav/schema";

export function FeedbackForbidden() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader kicker={kickerFor("/feedback")} title="現場意見" />
      <div className="flex flex-col items-center gap-2 rounded-lg border border-zk-border bg-white px-6 py-16 text-center" data-testid="feedback-forbidden">
        <div className="text-sm font-semibold text-zk-text">你冇權睇呢一頁</div>
        <div className="max-w-[380px] text-zk-sm leading-relaxed text-zk-muted">「現場意見」清單淨係老闆先睇得到。</div>
      </div>
    </div>
  );
}
