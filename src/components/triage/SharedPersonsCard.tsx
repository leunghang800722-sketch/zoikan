// TE-13：staffno_shared_by_persons／dup_tel_across_persons 題卡——列出共用者；同埋「導入包淨係得工號」嘅空人後備。
import type { ReactNode } from "react";
import { hkidStatusLabel, sharedHeadline, type SharedKind } from "@/lib/triage/shared-card";

export interface SharedWithView {
  person_key: string;
  name_zh: string | null;
  name_en: string | null;
  name_hidden?: boolean;
  hkid_status: string;
  has_docs: boolean;
  doc_count: number;
  staff_numbers: string[];
  tel_status: string;
  question_id: string | null;
}
export interface SelfView {
  name_zh: string | null;
  name_en: string | null;
  hkid_status: string;
  doc_count: number;
  staff_numbers: string[];
}

const nameOf = (n: { name_zh: string | null; name_en: string | null; name_hidden?: boolean }): string => (n.name_hidden ? "（你冇權限睇姓名）" : n.name_zh || n.name_en || "（姓名未讀到）");
const docText = (n: number): string => (n > 0 ? `文件 ${n} 頁` : "冇文件");

export function SharedPersonsCard({ kind, sharedStaffNumbers, self, others, canGoto, onGoto }: { kind: SharedKind; sharedStaffNumbers: readonly string[]; self: SelfView; others: readonly SharedWithView[]; canGoto?: (questionId: string) => boolean; onGoto?: (questionId: string) => void }) {
  return (
    <div className="space-y-2 rounded-lg border border-zk-warning-border bg-zk-warning-bg p-3" data-testid="triage-shared-card">
      <div className="text-zk-base font-semibold" data-testid="triage-shared-headline">
        {sharedHeadline(kind, sharedStaffNumbers, others.length)}
      </div>
      <ul className="space-y-1.5 text-zk-sm" data-testid="triage-shared-list">
        <li className="rounded border border-zk-border bg-white px-2 py-1.5" data-testid="triage-shared-self">
          <span className="font-semibold">{nameOf(self)}</span>
          <span className="ml-1 text-zk-muted">（呢條題嘅人）</span>
          <div className="text-zk-muted">身份證：{hkidStatusLabel(self.hkid_status)}・{docText(self.doc_count)}・包內工號：{self.staff_numbers.join("、") || "—"}</div>
        </li>
        {others.map((o) => (
          <li key={o.person_key} className="rounded border border-zk-border bg-white px-2 py-1.5" data-testid="triage-shared-other">
            <span className="font-semibold">{nameOf(o)}</span>
            <div className="text-zk-muted">
              身份證：{hkidStatusLabel(o.hkid_status)}・{docText(o.doc_count)}・包內工號：{o.staff_numbers.join("、") || "—"}
              {o.question_id && canGoto?.(o.question_id) && onGoto ? (
                <button type="button" className="ml-2 text-zk-primary underline" onClick={() => onGoto(o.question_id!)} data-testid="triage-shared-goto">
                  去嗰條題
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 空人後備：所有個人欄 missing（即使有工號／ext）——導入包只讀到工號，冇任何文件內容。 */
export function StaffNoOnlyPerson({ staffNumbers, reasons, children }: { staffNumbers: readonly string[]; reasons: readonly string[]; children?: ReactNode }) {
  return (
    <div className="space-y-1 rounded-lg border border-zk-border bg-zk-header/40 p-3" data-testid="triage-person-empty">
      <div className="text-zk-sm font-semibold text-zk-muted">導入包內嘅資料</div>
      <div className="text-zk-base font-semibold text-zk-warning" data-testid="triage-person-empty-title">
        {staffNumbers.length > 0 ? "導入包只讀到呢位嘅工號（嚟自打字名單／更表），冇任何文件" : "導入包冇讀到呢位嘅任何資料"}
      </div>
      {staffNumbers.length > 0 && <div className="text-zk-sm text-zk-muted">工號：{staffNumbers.join("、")}</div>}
      {reasons.length > 0 && <div className="text-zk-sm text-zk-muted">原因：{reasons.join("、")}</div>}
      {children}
    </div>
  );
}
