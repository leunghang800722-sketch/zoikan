"use client";
// TE-1：分流題卡 inline 顯示原文件欄位裁圖（docs/plans/triage-evidence-crops-plan.md §2.3／§7）。
//  - 用普通 <img>（唔用 next/image，免得圖落磁碟快取，M9）；src 係需要 session cookie 嘅 no-store API。
//  - 優先來源（priority 1）先顯示；第二張摺埋「亦見入職表手寫」；點圖放大（overlay，Esc／點擊關閉）。
import { useEffect, useState } from "react";
import { apiPost } from "@/lib/ui/api-client";

export interface EvidenceImageDto {
  id: string;
  field: string;
  doc_kind: string;
  priority: number;
  width: number;
  height: number;
  /** TE-7：整頁原稿頁碼 */
  page_no?: number | null;
}

const EVIDENCE_DOC_LABEL: Record<string, string> = { id_card: "身份證副本", address_proof: "住址證明", onboarding_form: "入職表手寫", sia_permit: "牌照卡副本", printed: "牌照／證書印刷" };
/** TriageDialog review_fields 嘅 field 名 → 證據圖 field 名 */
export const REVIEW_TO_EVIDENCE_FIELD: Record<string, string> = { nameZh: "name_zh", nameEn: "name_en", dateOfBirth: "dob", phone: "phone", address: "address" };
const EVIDENCE_FIELD_LABEL: Record<string, string> = { hkid: "身份證號", name_zh: "中文姓名", name_en: "英文姓名", dob: "出生日期", phone: "電話", address: "地址", permit_no: "牌照號碼", hire_date: "入職日期" };

function WithdrawBtn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="mt-0.5 text-zk-xs text-zk-muted underline" onClick={onClick} data-testid="evidence-withdraw">
      呢張圖錯／唔相關
    </button>
  );
}

function Zoomable({ img, label, onOpen }: { img: EvidenceImageDto; label: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="block max-w-full cursor-zoom-in rounded border border-zk-border bg-white p-1" onClick={() => onOpen(img.id)} data-testid="evidence-img-btn" aria-label={`放大${label}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/triage/evidence-images/${img.id}`} alt={label} width={img.width} height={img.height} loading="lazy" decoding="async" className="h-auto max-h-40 w-auto max-w-full object-contain" data-testid="evidence-img" />
    </button>
  );
}

/** 一個欄位嘅證據圖（imgs 已經只含該欄）。冇圖 render null（唔阻答題）。 */
export function EvidenceImages({ imgs: allImgs, fieldLabel }: { imgs: readonly EvidenceImageDto[]; fieldLabel: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const imgs = allImgs.filter((i) => !gone.has(i.id));
  /** TE-8：呢張圖錯／唔相關——軟刪（要「導入分診:update」），成功後即時隱藏 */
  async function withdraw(id: string) {
    setErr(null);
    const r = await apiPost(`/api/triage/evidence-images/${id}/withdraw`, { reason: "wrong" });
    if (!r.ok) {
      setErr(r.message);
      return;
    }
    setGone((g) => new Set([...g, id]));
    setOpen(null);
  }
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
      <WithdrawBtn onClick={() => void withdraw(first.id)} />
      {rest.map((r) => (
        <details key={r.id} className="text-zk-xs" data-testid="evidence-more">
          <summary className="cursor-pointer text-zk-muted">亦見{EVIDENCE_DOC_LABEL[r.doc_kind] ?? "其他文件"}</summary>
          <div className="mt-1">
            <Zoomable img={r} label={`${fieldLabel}（${EVIDENCE_DOC_LABEL[r.doc_kind] ?? "文件"}）`} onOpen={setOpen} />
            <WithdrawBtn onClick={() => void withdraw(r.id)} />
          </div>
        </details>
      ))}
      {err && (
        <div className="text-zk-xs text-zk-danger-dark" data-testid="evidence-withdraw-error">
          {err}
        </div>
      )}
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
  const cropImages = images?.filter((i) => i.field !== "page"); // TE-7：整頁原稿喺 fallback 區另外摺埋顯示
  images = cropImages;
  if (!images || images.length === 0)
    return (
      <div className="text-zk-xs text-zk-faint" data-testid="evidence-empty">
        冇裁圖（文件讀唔到）
      </div>
    );
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

/**
 * TE-7：整頁原稿（抽取失敗人嘅例外；暫存加密、最高權限、答題即刪）。摺埋，撳開先載入圖（no-store）；
 * 冇權限（hidden>0 而 imgs 空）→「有 N 頁原稿，需最高權限查看」。
 */
export function OriginalPages({ imgs, hidden }: { imgs: readonly EvidenceImageDto[]; hidden: number }) {
  const [opened, setOpened] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);
  const pages = [...imgs].filter((i) => i.field === "page").sort((a, b) => (a.page_no ?? 0) - (b.page_no ?? 0));
  if (pages.length === 0) {
    return hidden > 0 ? (
      <div className="text-zk-xs text-zk-faint" data-testid="evidence-pages-hidden">
        有 {hidden} 頁原稿，需最高權限查看
      </div>
    ) : null;
  }
  const zoomed = pages.find((i) => i.id === open) ?? null;
  return (
    <details className="text-zk-sm" data-testid="evidence-pages" onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-zk-muted">原稿頁（{pages.length}）</summary>
      {opened && (
        <div className="mt-1 space-y-2">
          {pages.map((p, i) => (
            <div key={p.id} className="space-y-0.5">
              <div className="text-zk-xs text-zk-faint">第 {p.page_no ?? i + 1} 頁</div>
              <Zoomable img={p} label={`原稿第 ${p.page_no ?? i + 1} 頁`} onOpen={setOpen} />
            </div>
          ))}
        </div>
      )}
      {zoomed && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-3" role="dialog" aria-modal="true" aria-label="原稿頁放大" onClick={() => setOpen(null)} data-testid="evidence-overlay">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/triage/evidence-images/${zoomed.id}`} alt="原稿頁放大" className="max-h-full max-w-full rounded bg-white object-contain" data-testid="evidence-img-zoomed" />
          <button type="button" className="absolute right-3 top-3 rounded bg-white px-3 py-1.5 text-zk-base font-semibold" onClick={() => setOpen(null)} data-testid="evidence-close">
            關閉
          </button>
        </div>
      )}
    </details>
  );
}
