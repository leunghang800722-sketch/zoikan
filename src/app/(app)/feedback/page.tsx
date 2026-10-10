// P2.5「現場反映」開會模式——「現場意見」清單頁，淨係老闆先用得到
// （`session.baseRole !== "老闆"` 就顯示 403，同 `src/lib/feedback/
// guard.ts` 嘅 `assertBoss()` 呼應——API 層一樣硬性擋，呢度純粹係俾
// UI 一個清楚嘅畫面，唔係淨係得個 API 403）。同 `users/page.tsx` 一樣
// 做法：server component 攞 session，冇 session 就 redirect 去 /login。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";

import { FeedbackPageClient } from "./FeedbackPageClient";
import { FeedbackForbidden } from "./FeedbackForbidden";

export default async function FeedbackPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  if (session.baseRole !== "老闆") return <FeedbackForbidden />;

  return <FeedbackPageClient />;
}
