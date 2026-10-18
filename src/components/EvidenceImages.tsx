"use client";
// TE-1：分流題卡 inline 顯示原文件欄位裁圖（docs/plans/triage-evidence-crops-plan.md §2.3／§7）。
//  - 用普通 <img>（唔用 next/image，免得圖落磁碟快取，M9）；src 係需要 session cookie 嘅 no-store API。
//  - 優先來源（priority 1）先顯示；第二張摺埋「亦見入職表手寫」；點圖放大（overlay，Esc／點擊關閉）。
import { useEffect, useState } from "react";

export interface EvidenceImageDto {
  id: string;
  field: string;
  doc_kind: string;
  priority: number;
  width: number;
  height: number;
}

const EVIDENCE_DOC_LABEL: Record<string, string> = { id_card: "身份證副本", address_proof: "住址證明", onboarding_form: "入職表手寫", sia_permit: "牌照卡副本" };
/** TriageDialog review_fields 嘅 field 名 → 證據圖 field 名 */
export const REVIEW_TO_EVIDENCE_FIELD: Record<string, string> = { nameZh: "name_zh", nameEn: "name_en", dateOfBirth: "dob", phone: "phone", address: "address" };
const EVIDENCE_FIELD_LABEL: Record<string, string> = { hkid: "身份證號", name_zh: "中文姓名", name_en: "英文姓名", dob: "出生日期", phone: "電話", address: "地址", permit_no: "牌照號碼" };

function Zoomable({ img, label, onOpen }: { img: EvidenceImageDto; label: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="block max-w-full cursor-zoom-in rounded border border-zk-border bg-white p-1" onClick={() => onOpen(img.id)} data-testid="evidence-img-btn" aria-label={`放大${label}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/triage/evidence-images/${img.id}`} alt={label} width={img.width} height={img.height} loading="lazy" decoding="async" className="h-auto max-h-40 w-auto max-w-full object-contain" data-testid="evidence-img" />
    </button>
  );
}

/** 一個欄位嘅證據圖（imgs 已經只含該欄）。冇圖 render null（唔阻答題）。 */
export function EvidenceImages({ imgs, fieldLabel }: { imgs: readonly EvidenceImageDto[]; fieldLabel: string }) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);
  if (imgs.length === 0) return null;
  const sorted = [...imgs].sort((a, b) => a.priority - b.priority);
  const first = sorted[0]!;
  const rest = sorted.slice(1);
  const zoomed = sorted.find((i) => i.id === open) ?? null;
  return (
    <div className="space-y-1" data-testid="evidence-block" data-field={first.field}>
      <div className="text-zk-xs text-zk-faint">
        {fieldLabel}原文件裁圖 · <span data-testid="evidence-source">{EVIDENCE_DOC_LABEL[first.doc_kind] ?? "文件"}</span>
      </div>
      <Zoomable img={first} label={`${fieldLabel}（${EVIDENCE_DOC_LABEL[first.doc_kind] ?? "文件"}）`} onOpen={setOpen} />
      {rest.map((r) => (
        <details key={r.id} className="text-zk-xs" data-testid="evidence-more">
          <summary className="cursor-pointer text-zk-muted">亦見{EVIDENCE_DOC_LABEL[r.doc_kind] ?? "其他文件"}</summary>
          <div className="mt-1">
            <Zoomable img={r} label={`${fieldLabel}（${EVIDENCE_DOC_LABEL[r.doc_kind] ?? "文件"}）`} onOpen={setOpen} />
          </div>
        </details>
      ))}
      {zoomed && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-3" role="dialog" aria-modal="true" aria-label={`${fieldLabel}原文件裁圖放大`} onClick={() => setOpen(null)} data-testid="evidence-overlay">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/triage/evidence-images/${zoomed.id}`} alt={`${fieldLabel}放大`} className="max-h-full max-w-full rounded bg-white object-contain" data-testid="evidence-img-zoomed" />
          <button type="button" className="absolute right-3 top-3 rounded bg-white px-3 py-1.5 text-zk-base font-semibold" onClick={() => setOpen(null)} data-testid="evidence-close">
            關閉
          </button>
        </div>
      )}
    </div>
  );
}

/** 按欄分組顯示（非 field_review 題用）。 */
export function EvidenceSection({ images }: { images: readonly EvidenceImageDto[] | undefined }) {
  if (!images || images.length === 0) return null;
  const fields = [...new Set(images.map((i) => i.field))];
  return (
    <div className="space-y-2 rounded-lg border border-zk-border bg-zk-header/40 p-3" data-testid="evidence-section">
      <div className="text-zk-sm font-semibold text-zk-muted">原文件欄位裁圖（對住打返正確資料）</div>
      {fields.map((f) => (
        <EvidenceImages key={f} imgs={images.filter((i) => i.field === f)} fieldLabel={EVIDENCE_FIELD_LABEL[f] ?? f} />
      ))}
    </div>
  );
}
