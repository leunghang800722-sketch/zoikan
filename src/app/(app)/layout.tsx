import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getNavLinks, getViewGrants } from "@/lib/rbac/nav";
import { uiLabel } from "@/lib/ui/format";
import { LogoutButton } from "@/components/LogoutButton";
import { MustChangePwdGate } from "@/components/MustChangePwdGate";
import { AiAssistantSidebar } from "@/components/ai/AiAssistantSidebar";
import { isAiConfigured } from "@/lib/ai/config";

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
  // WP-AI3：邊個 provider 配置好（DeepSeek／Anthropic／測試用 fake）
  // 判斷邏輯抽咗喺 `@/lib/ai/config.ts`，同 `getLlmClient()`
  // （`src/lib/ai/llm.ts`）共用同一套，唔會走飛——未配置好任何 provider
  // 就唔顯示 tab，免得用戶見到一個「暫時未連接」嘅助手。
  const aiConfigured = isAiConfigured();
  const showAiAssistant = grants["助手"] && aiConfigured;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col gap-4 border-r border-gray-200 bg-gray-50 p-4">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-gray-400">在勤</div>
          <div className="mt-1 text-sm font-medium text-gray-900">{session.name}</div>
          <div className="text-xs text-gray-500">{uiLabel(session.roleName)}</div>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 text-sm">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="rounded px-2 py-1.5 text-gray-700 hover:bg-gray-200">
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex flex-col gap-2 border-t border-gray-200 pt-3 text-sm">
          <Link href="/change-password" className="rounded px-2 py-1.5 text-blue-700 hover:bg-gray-200">
            改密碼
          </Link>
          <LogoutButton />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-x-auto p-6">
        <MustChangePwdGate mustChange={session.mustChangePwd} />
        {children}
      </main>
      {showAiAssistant && <AiAssistantSidebar userName={session.name} />}
    </div>
  );
}
