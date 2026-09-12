import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { getNavLinks } from "@/lib/rbac/nav";
import { LogoutButton } from "@/components/LogoutButton";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect("/login");

  const links = await getNavLinks(session);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col gap-4 border-r border-gray-200 bg-gray-50 p-4">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-gray-400">在勤</div>
          <div className="mt-1 text-sm font-medium text-gray-900">{session.name}</div>
          <div className="text-xs text-gray-500">{session.roleName}</div>
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
      <main className="min-w-0 flex-1 overflow-x-auto p-6">{children}</main>
    </div>
  );
}
