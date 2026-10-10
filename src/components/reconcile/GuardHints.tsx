"use client";
// WP-RECONCILE-UI（§33.3 B）：相似保安員提示——純顯示＋連去 /guards?q=，唔配對、唔寫入。
import Link from "next/link";
import { LINK, SIMILAR_WHY_LABEL, guardStatusLabel, type Person } from "./derive";
import { useSimilarGuards } from "./data";
import type { GuardLite } from "./derive";

export function SimilarGuards({ person, dir }: { person: Person; dir: { rows: GuardLite[]; total: number; loaded: boolean } }) {
  const s = useSimilarGuards(person, dir);
  if (s.status === "loading") return <div className="text-zk-xs text-zk-faint" data-testid="similar-loading">查緊名冊…</div>;
  if (s.list.length === 0) return <div className="text-zk-xs text-zk-muted" data-testid="similar-none">名冊冇相似，可能係新人或離職員工</div>;
  return (
    <div className="space-y-0.5" data-testid="similar-guards">
      <div className="text-zk-xs font-semibold text-zk-muted">名冊有相似保安員（只係提示，唔會自動配對）</div>
      <ul className="space-y-0.5">
        {s.list.map(({ guard, why }) => {
          const no = guard.staff_no || guard.staff_numbers?.[0]?.number || "";
          return (
            <li key={guard.id} className="text-zk-xs" data-testid="similar-guard" data-guard-id={guard.id}>
              <Link href={LINK.guards(no || guard.name_zh)} className="text-zk-primary underline">
                {guard.name_zh}
                {no ? `（${no}）` : ""}
              </Link>
              <span className="ml-1 text-zk-muted">
                {guardStatusLabel(guard.status)}・{why.map((w) => SIMILAR_WHY_LABEL[w]).join("、")}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

