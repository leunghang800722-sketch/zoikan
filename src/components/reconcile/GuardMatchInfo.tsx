"use client";
// WP-RECONCILE-UI（§33.3 E）：月結分診「安員配對」題下面嘅更表資料——姓名／工號／格數／reason
// （由 guard-fix 最新 run 嘅 needs_boss 對）＋相似安員提示＋連結。純顯示，唔配對、唔寫入。
import Link from "next/link";
import { LINK, guardSearchTerm, hasPerson, matchNeedsBossForQuestion, personLabel, telTail, type Person } from "./derive";
import { useGuardDirectory, useNeedsBoss } from "./data";
import { SimilarGuards } from "./GuardHints";

const linkCls = "inline-block rounded-[5px] border border-zk-primary px-2 py-[3px] text-[11.5px] font-medium text-zk-primary hover:bg-blue-50";

export function GuardMatchInfo({ question, month, compact = false }: { question: { title: string; mc: { summary: string; identity_label: string | null; action_type: string } }; month: string | null; compact?: boolean }) {
  const isGuard = question.mc.action_type === "guard_match";
  const nbRes = useNeedsBoss(month, isGuard);
  const dir = useGuardDirectory(isGuard);
  if (!isGuard) return null;
  const nb = matchNeedsBossForQuestion({ title: question.title, summary: question.mc.summary, identity_label: question.mc.identity_label }, nbRes && nbRes !== "denied" ? nbRes.items : null);
  const person: Person | null = nb ? { name: nb.name_raw ?? "", staffNo: nb.staff_no_raw ?? "", tel: nb.tel_raw ?? "" } : question.mc.identity_label ? { name: question.mc.identity_label, staffNo: "", tel: "" } : null;
  const canGuardFix = nbRes !== "denied";
  const mon = (nb && nbRes && nbRes !== "denied" && nbRes.month ? nbRes.month : month) ?? "";
  return (
    <div className={`space-y-1.5 rounded-lg border border-zk-border bg-zk-header ${compact ? "px-3 py-2.5" : "px-2.5 py-2"}`} data-testid="mc-guard-info">
      <div className="text-[11.5px] font-semibold text-zk-muted">更表寫咗</div>
      {nb ? (
        <div className="space-y-0.5 text-[12.5px]">
          <div className="font-medium text-zk-text" data-testid="mc-guard-name">
            {person && hasPerson(person) ? personLabel(person) : "（冇權限睇姓名／工號）"}
            <span className="ml-1.5 text-[11px] font-normal text-zk-faint">{nb.seq}</span>
          </div>
          <div className="text-[11.5px] text-zk-muted" data-testid="mc-guard-cells">
            {[telTail(nb.tel_raw), `共 ${nb.total_cell_count} 格`, nb.cells.map((c) => `${c.site_label} ${c.cell_count} 格`).join("、")].filter(Boolean).join("・")}
          </div>
          <div className="text-[11.5px] text-red-600" data-testid="mc-guard-reason">
            {nb.reason}
          </div>
        </div>
      ) : person && hasPerson(person) ? (
        <div className="text-[12.5px] font-medium text-zk-text" data-testid="mc-guard-name">
          {personLabel(person)}
        </div>
      ) : (
        <div className="text-[11.5px] text-zk-faint">冇權限睇姓名／工號，或者搵唔到對應嘅安員配對修復資料。</div>
      )}
      {person && hasPerson(person) && <SimilarGuards person={person} dir={dir} />}
      <div className="flex flex-wrap gap-1">
        {mon && canGuardFix && (
          <Link href={LINK.guardFix(mon)} className={linkCls} data-testid="mc-link-guard-fix">
            去安員配對修復 ›
          </Link>
        )}
        {person && hasPerson(person) && (
          <Link href={LINK.guards(guardSearchTerm(person))} className={linkCls} data-testid="mc-link-find-guard">
            搵安員 ›
          </Link>
        )}
        {person && hasPerson(person) && (
          <Link href={LINK.newFromDocs(person.name, person.staffNo)} className={linkCls} data-testid="mc-link-new-from-docs">
            用證件新增 ›
          </Link>
        )}
      </div>
    </div>
  );
}
