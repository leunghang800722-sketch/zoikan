// P2.5「現場反映」開會模式——意見詳情頁（server component 攞 session，
// 同 `[id]` 一致做法交俾 client component 打 API）。淨係老闆先睇得到
// （同 `/feedback` 一樣 403 畫面）；API 層 `GET /api/feedback/reports/
// [id]` 本身都準作者本人睇自己嗰份，但呢一頁（清單背後嗰個詳情頁）
// 刻意都淨係老闆入得嚟——作者自己想睇返送出咗嘅內容，暫時冇獨立畫面
// （API 已經開放咗俾佢哋，日後要加「我送出嘅意見」畫面可以直接用）。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";

import { FeedbackDetailClient } from "./FeedbackDetailClient";
import { FeedbackForbidden } from "../FeedbackForbidden";

export default async function FeedbackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const { id } = await params;

  if (session.baseRole !== "老闆") return <FeedbackForbidden />;

  return <FeedbackDetailClient id={id} />;
}
