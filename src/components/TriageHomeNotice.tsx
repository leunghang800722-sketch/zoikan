// WP-AI-OPS §28.4：首頁「待答問題（N）」入口（server component；老闆見全部，其他人見自己上載嗰批）。
import Link from "next/link";
import { Notice } from "@/components/ui/Notice";
import { getViewGrants } from "@/lib/rbac/nav";
import { countOpenFor } from "@/lib/triage/session";
import type { CurrentSession } from "@/lib/auth/current-session";

export async function TriageHomeNotice({ session }: { session: CurrentSession }) {
  const grants = await getViewGrants(session);
  if (!grants["導入分診"]) return null;
  const n = await countOpenFor(session);
  if (n === 0) return null;
  return (
    <Notice variant="warning" action={<Link href="/triage" className="font-semibold underline">去答</Link>}>
      待答問題（{n}）——保安員導入或者一鍵結算後有項目要人手決定
    </Notice>
  );
}
