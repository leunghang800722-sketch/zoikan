"use client";
// WP-RECONCILE-UI（§33.3 A/B/C）：對數頁「未配對」行嘅「更表寫咗」欄、人話原因、按原因出嘅直達連結。
// 全部係顯示＋導航；唔寫入任何嘢。電話只顯示尾 4 位。
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { SimilarGuards } from "@/components/reconcile/GuardHints";
import {
  LINK,
  classifyReason,
  guardSearchTerm,
  hasPerson,
  humanizeReasonPart,
  personFromRow,
  personLabel,
  rankTimeText,
  telTail,
  matchNeedsBossByPerson,
  piiHidden,
  type GuardLite,
  type NeedsBossItem,
  type RawRosterRow,
  type ReasonKind,
} from "@/components/reconcile/derive";

export interface UnresolvedItemLite {
  key: string;
  work_date: string;
  site_id: string | null;
  unresolved_reason: string | null;
}

type Dir = { rows: GuardLite[]; total: number; loaded: boolean };

const linkCls = "inline-block rounded-[5px] border border-zk-primary px-2 py-[3px] text-[11.5px] font-medium text-zk-primary hover:bg-blue-50";

export function reasonKinds(item: UnresolvedItemLite): Set<ReasonKind> {
  return new Set(classifyReason(item.unresolved_reason).map((p) => p.kind));
}

/** 人話原因（每句一行）。 */
export function ReasonText({ item, raw }: { item: UnresolvedItemLite; raw: RawRosterRow | null | undefined }) {
  const parts = classifyReason(item.unresolved_reason);
  if (parts.length === 0) return null;
  const person = raw ? personFromRow(raw) : null;
  return (
    <div className="mt-1 space-y-0.5" data-testid="reconcile-reason" data-raw-reason={item.unresolved_reason ?? ""}>
      {parts.map((p, i) => (
        <div key={i} className="text-[11px] text-red-600" data-reason-kind={p.kind}>
          {humanizeReasonPart(p, person, piiHidden(raw))}
        </div>
      ))}
    </div>
  );
}

/** 「更表寫咗」欄：姓名、工號、電話尾 4、雞頭碼、職級／時段、原始第 N 行＋相似保安員。 */
export function WroteCell({ raw, loading, item, dir }: { raw: RawRosterRow | null | undefined; loading: boolean; item: UnresolvedItemLite; dir: Dir }) {
  if (!raw) return <span className="text-[11px] text-zk-faint">{loading ? "載入緊…" : "—"}</span>;
  const person = personFromRow(raw);
  const tel = telTail(raw.tel_raw);
  const rt = rankTimeText(raw);
  const hidden = piiHidden(raw);
  const showSimilar = reasonKinds(item).has("guard") && !hidden;
  return (
    <div className="space-y-0.5 text-[12px]" data-testid="reconcile-wrote" data-row-index={raw.row_index}>
      <div className="font-medium text-zk-text" data-testid="reconcile-wrote-name">
        {hidden ? <span className="text-zk-faint">冇權限睇姓名／工號</span> : hasPerson(person) ? personLabel(person) : <span className="text-zk-faint">（更表冇寫姓名／工號）</span>}
      </div>
      <div className="text-[11px] text-zk-muted">
        {[tel, raw.broker_code_raw?.trim() ? `雞頭碼 ${raw.broker_code_raw.trim()}` : null, rt || null, `原始第 ${raw.row_index} 行`].filter(Boolean).join("・")}
      </div>
      {showSimilar && hasPerson(person) && <SimilarGuards person={person} dir={dir} />}
    </div>
  );
}

/** 同一人多日嘅行合併摘要用：同一份 needs_boss 提示。 */
export function NeedsBossBox({ nb }: { nb: NeedsBossItem }) {
  return (
    <div className="rounded border border-orange-200 bg-orange-50 px-2 py-1 text-[11px] text-orange-800" data-testid="reconcile-needs-boss">
      <div>一鍵結算有待答題（{nb.seq}，{nb.total_cell_count} 格）：{nb.reason}</div>
      <Link href={LINK.triage} className="font-medium text-zk-primary underline">
        去答題 ›
      </Link>
    </div>
  );
}

export interface ActionCtx {
  uploadId: string;
  uploadSiteId: string | null;
  month: string; // YYYY-MM
  needsBoss: NeedsBossItem[] | null;
  /** false＝冇權限用保安員配對修復（guard-fix 403）——唔出相關連結。 */
  canGuardFix: boolean;
  onReparse: () => void;
  reparsing: boolean;
  siteNameOf: (id: string | null) => string;
}

/** 動作欄：按原因出直達連結（同一行可以多個）。 */
export function ReasonLinks({ item, raw, ctx }: { item: UnresolvedItemLite; raw: RawRosterRow | null | undefined; ctx: ActionCtx }): ReactNode {
  const parts = classifyReason(item.unresolved_reason);
  const person = personFromRow(raw ?? null);
  const links: ReactNode[] = [];
  const notes: ReactNode[] = [];
  const seen = new Set<ReasonKind>();
  for (const p of parts) {
    if (seen.has(p.kind) && p.kind !== "broker_code") continue;
    seen.add(p.kind);
    if (p.kind === "guard") {
      if (ctx.canGuardFix) {
        links.push(
          <Link key="gf" href={LINK.guardFix(ctx.month)} className={linkCls} data-testid="link-guard-fix">
            去保安員配對修復 ›
          </Link>,
        );
      }
      if (hasPerson(person)) {
        links.push(
          <Link key="gs" href={LINK.guards(guardSearchTerm(person))} className={linkCls} data-testid="link-find-guard">
            搵保安員 ›
          </Link>,
        );
      }
      links.push(
        <Link key="nd" href={LINK.newFromDocs(person.name, person.staffNo)} className={linkCls} data-testid="link-new-from-docs">
          用證件新增 ›
        </Link>,
      );
      const nb = matchNeedsBossByPerson(person, ctx.needsBoss);
      if (nb) notes.push(<NeedsBossBox key="nb" nb={nb} />);
    } else if (p.kind === "no_site") {
      links.push(
        <Link key="ns" href={LINK.uploadFocus(ctx.month, ctx.uploadId)} className={linkCls} data-testid="link-assign-site">
          去指定盤 ›
        </Link>,
      );
    } else if (p.kind === "subsite_unmatched") {
      links.push(
        <Link key="su" href={LINK.sites(ctx.uploadSiteId)} className={linkCls} data-testid="link-sites-subsite">
          去盤管理掛子盤 ›
        </Link>,
      );
    } else if (p.kind === "shift_type" || p.kind === "leave_shift") {
      const code = raw?.raw_code?.trim();
      const time = raw?.time_raw?.trim();
      notes.push(
        <div key="st" className="text-[11px] text-zk-muted" data-testid="reconcile-shift-raw">
          更表寫嘅更種碼：{code ? `「${code}」` : "—"}
          {time ? `・時段 ${time}` : ""}
        </div>,
      );
      links.push(
        <Link key="stl" href={LINK.sites(item.site_id ?? ctx.uploadSiteId)} className={linkCls} data-testid="link-sites-shift-type">
          去盤管理加更種 ›
        </Link>,
      );
    } else if (p.kind === "broker_code") {
      notes.push(
        <div key={`bc-${p.value}`} className="text-[11px] text-zk-muted" data-testid="reconcile-broker-raw">
          更表寫嘅雞頭碼：「{p.value}」
        </div>,
      );
      links.push(
        <Link key={`bl-${p.value}`} href={LINK.brokers(p.value)} className={linkCls} data-testid="link-brokers">
          去雞頭管理加別名 ›
        </Link>,
      );
    } else if (p.kind === "voided_shift_type") {
      links.push(
        <Button key="rp" variant="secondary" onClick={ctx.onReparse} disabled={ctx.reparsing} data-testid="reconcile-reparse">
          {ctx.reparsing ? "重新解析緊…" : "重新解析呢份上載"}
        </Button>,
      );
    }
  }
  if (links.length === 0 && notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="reconcile-links">
      {notes}
      <div className="flex flex-wrap gap-1">{links}</div>
    </div>
  );
}

const ACTIONABLE: ReasonKind[] = ["guard", "no_site", "subsite_unmatched", "shift_type", "leave_shift", "broker_code", "voided_shift_type"];
/** 呢行有冇直達連結／掣（冇就顯示舊嘅通用提示）。 */
export function reasonHasActions(item: UnresolvedItemLite): boolean {
  const k = reasonKinds(item);
  return ACTIONABLE.some((x) => k.has(x));
}
