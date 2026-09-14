// P2.5「現場反映」開會模式——意見詳情頁（server component 攞 session，
// 同 `[id]` 一致做法交俾 client component 打 API）。淨係老闆先睇得到
// （同 `/feedback` 一樣 403 畫面）；API 層 `GET /api/feedback/reports/
// [id]` 本身都準作者本人睇自己嗰份，但呢一頁（清單背後嗰個詳情頁）
// 刻意都淨係老闆入得嚟——作者自己想睇返送出咗嘅內容，暫時冇獨立畫面
// （API 已經開放咗俾佢哋，日後要加「我送出嘅意見」畫面可以直接用）。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { PageHeader } from "@/components/ui/PageHeader";
import { FeedbackDetailClient } from "./FeedbackDetailClient";

export default async function FeedbackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const { id } = await params;

  if (session.baseRole !== "老闆") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader kicker="系統" title="現場意見" />
        <div className="flex flex-col items-center gap-2 rounded-lg border border-zk-border bg-white px-6 py-16 text-center" data-testid="feedback-forbidden">
          <div className="text-sm font-semibold text-zk-text">你冇權睇呢一頁</div>
          <div className="max-w-[380px] text-[12.5px] leading-relaxed text-zk-muted">「現場意見」清單淨係老闆先睇得到。</div>
        </div>
      </div>
    );
  }

  return <FeedbackDetailClient id={id} />;
}
