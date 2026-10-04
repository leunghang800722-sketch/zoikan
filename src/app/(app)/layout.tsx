import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getNavLinks, getViewGrants, groupNavLinks } from "@/lib/rbac/nav";
import { uiLabel } from "@/lib/ui/format";
import { MustChangePwdGate } from "@/components/MustChangePwdGate";
import { SessionRefresh } from "@/components/SessionRefresh";
import { ChunkErrorReload } from "@/components/ChunkErrorReload";
import { AiAssistantSidebar } from "@/components/ai/AiAssistantSidebar";
import { MobileNav } from "@/components/MobileNav";
import { DesktopNav } from "@/components/DesktopNav";
import { isAiConfigured } from "@/lib/ai/config";
import { prisma } from "@/lib/db";
import { countOpenFor } from "@/lib/triage/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  // WP-AI2：「助手」module 嘅 view 權（老闆/主管/會計✓，雞頭/安員硬性
  // 禁止，見 `src/lib/rbac/matrix.ts`）同左欄導航一齊用同一次
  // `getViewGrants()` fetch 判斷，唔使幫側欄 AI 助手 tab 多打一次
  // `/api/roles/:id/permissions`。冇 `助手:view` 就連 `<AiAssistantSidebar>`
  // 呢個 component 都唔會 render——DOM 零元素，唔係淨係 CSS 隱藏。
  const grants = await getViewGrants(session);
  const links = await getNavLinks(session, grants);
  // WP-R1：導航分組純粹顯示層（見 `groupNavLinks()` 註解）——邊條連結
  // 顯示唔顯示仍然由 `getNavLinks()` 嗰套權限邏輯決定，呢度淨係決定
  // 擺去邊組。
  const groups = groupNavLinks(session.baseRole, links);

  // WP-R1：「審批隊列」右側紅 badge＝待審批更次總數（README「桌面外殼 ·
  // 左欄」）。淨係有「審批:view」權限先查（0 就唔顯示，交由
  // DesktopNav/MobileNav 自己判斷 `!!badge`）。
  //
  // R1 驗收修正：口徑要同 `/approvals` 頁本身一致——嗰頁列晒全部
  // `pending_approval` 嘅更次，冇按本月篩（見
  // `src/app/(app)/approvals/page.tsx`），之前呢度加咗 `workDate` 本月
  // 篩選，會令 badge 數字細過 `/approvals` 頁實際筆數，令人以為「仲有
  // 未算入 badge 嘅待批」。改成同頁面一樣唔篩月份。
  const approvalsPending = grants["審批"] ? await prisma.shiftRecord.count({ where: { status: "pending_approval" } }) : 0;
  // P2.5「現場反映」開會模式——「現場意見」badge＝status=new 嘅報告數
  // （同審批 badge 一樣做法：server count，淨係老闆先查，見
  // `src/lib/rbac/nav.ts` 嘅「現場意見」連結一樣用「助手」module＋
  // baseRole==="老闆" 雙重判斷）。
  const unreadFeedback = grants["助手"] && session.baseRole === "老闆" ? await prisma.feedbackReport.count({ where: { status: "new" } }) : 0;
  // WP-AI-OPS §28.4：「待答問題」badge＝自己上載嗰批未答數（老闆＝全部）。
  const triageOpen = grants["導入分診"] ? await countOpenFor(session) : 0;
  const badges: Record<string, number> = {
    ...(triageOpen > 0 ? { "/triage": triageOpen } : {}),
    ...(approvalsPending > 0 ? { "/approvals": approvalsPending } : {}),
    ...(unreadFeedback > 0 ? { "/feedback": unreadFeedback } : {}),
  };

  // WP-AI3：邊個 provider 配置好（DeepSeek／Anthropic／測試用 fake）
  // 判斷邏輯抽咗喺 `@/lib/ai/config.ts`，同 `getLlmClient()`
  // （`src/lib/ai/llm.ts`）共用同一套，唔會走飛——未配置好任何 provider
  // 就唔顯示 tab，免得用戶見到一個「暫時未連接」嘅助手。
  const aiConfigured = isAiConfigured();
  const showAiAssistant = grants["助手"] && aiConfigured;

  const roleLabel = uiLabel(session.roleName);

  return (
    <div className="flex min-h-screen flex-col bg-zk-bg lg:flex-row">
      {/* 手機版（< lg，README「<1024 建議左欄收起變抽屜」）：漢堡抽屜，
          見 MobileNav 內部註解。桌面版（lg 以上）呢個 component render
          一個 `lg:hidden` 空殼，唔影響下面固定 `<aside>`。 */}
      <MobileNav groups={groups} userName={session.name} roleLabel={roleLabel} badges={badges} />

      <DesktopNav groups={groups} userName={session.name} roleLabel={roleLabel} badges={badges} />

      <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-x-auto px-4 pt-3.5 pb-[90px] lg:px-7 lg:pt-6 lg:pb-6">
        <ChunkErrorReload />
        <SessionRefresh />
        <MustChangePwdGate mustChange={session.mustChangePwd} />
        {children}
      </main>
      {showAiAssistant && <AiAssistantSidebar userName={session.name} />}
    </div>
  );
}
