"use client";
// WP-GUARD-OCR §29：用證件新增保安員。
//   ① 上載身份證（必須）／住址證明／入職表（圖片或 PDF，瀏覽器轉圖縮細）→ ② 辨識（每份兩次獨立讀）
//   → ③ 並排核對（圖＋表單，逐欄 已確認／要核對／讀唔到）→ ④ 預覽（新建定連去現有保安員、會寫邊啲欄）→ ⑤ 確認套用。
// 圖片只留喺瀏覽器記憶體；儲存／離開頁面即 revoke。寫入全部行現有 /api/guards/import/preview → apply（source=single_ocr）。
import { BackLink } from "@/components/ui/BackLink";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { apiPost } from "@/lib/ui/api-client";
import { TriageDialog, reasonLabel } from "@/components/TriageDialog";
import { canvasFromImageFile, cropFieldsFromCanvas, isPdfFile, openPdf, prepareFromCanvas, type PdfHandle, type PreparedImage } from "@/lib/guards/ocr/browser-images";
import { hasCropFields } from "@/lib/guards/ocr/field-crops";
import { readTwoStage } from "@/lib/guards/ocr/two-stage";
import { normalizeField } from "@/lib/guards/ocr/normalize";
import { CRITICAL_MSG, CROSS_MSG, FIELD_LABEL, candidateChips, REQUIRED_FIELDS, ackAfterEdit, criticalPending, fieldError as fieldErrorOf, groupHkid, applySummaryText, initialAck, isCritical, reviewProblems } from "@/lib/guards/ocr/review-state";
import type { CrossResult, FieldStatus } from "@/lib/guards/ocr/normalize";
import { OCR_DOC_FIELDS, type OcrDocType, type OcrFieldKey } from "@/lib/guards/ocr/config";
import { kickerFor } from "@/lib/nav/schema";
import { tableCls } from "@/components/ui/DataTable";

const DOC_LABEL: Record<OcrDocType, string> = { id_card: "身份證（必須）", address_proof: "住址證明（可選）", onboarding_form: "入職表（可選）" };
const DOC_SHORT: Record<OcrDocType, string> = { id_card: "身份證", address_proof: "住址證明", onboarding_form: "入職表" };
const FIELD_ORDER: OcrFieldKey[] = ["name_zh", "name_en", "hkid", "dob", "sex", "phone", "address"];
const REQUIRED = REQUIRED_FIELDS;
const REASON_MSG: Record<string, string> = {
  hkid_format: "身份證號格式唔啱",
  hkid_check_digit: "身份證號檢查碼唔啱，請對住圖核對",
  dob_calendar: "出生日期唔係合法日期（例如 DD-MM-YYYY）",
  dob_year_implausible: "出生年份唔合理，請核對",
  sex_format: "性別請填 M 或 F",
  phone_format: "電話格式唔啱",
  phone_not_hk: "唔係香港 8 位電話",
  phone_gridline_suspect: "電話多咗一兩位，可能將印刷分格線睇成數字 1，請對住圖核對",
  name_zh_format: "中文姓名請只填中文字",
  name_en_format: "英文姓名格式唔啱",
  address_format: "地址太短",
  reads_differ: "兩次辨識結果唔一樣，請對住圖揀一個或者自己改",
  one_read_unclear: "其中一次辨識睇唔清，請對住圖核對",
  both_unclear_alternatives: "兩次都睇唔清，只有候選字，請對住圖核對",
  unclear: "睇唔清，請自己輸入",
  simplified_chars: "疑似簡體字，請對住證件核對原字",
};

interface OcrField {
  status: FieldStatus;
  value: string;
  candidates: string[];
  /** WP-OCR-4（additive）：按格式驗證排序嘅候選；舊 server 冇 */
  candidates_ranked?: { value: string; sources: string[]; score: number; reason: string; als_score?: number }[];
  reason?: string;
  /** WP-OCR-1（additive）：同另一份文件嘅交叉核對；舊 server 冇 */
  cross?: { against: string; result: CrossResult };
}
interface OcrDocResult {
  type: OcrDocType;
  fields: Partial<Record<OcrFieldKey, OcrField>>;
  /** WP-OCR-3（additive）：讀 B 用咗欄位級裁圖定後備 2×2 格 */
  images_b_kind?: "tiles" | "field_crops";
}
interface OcrResponse {
  model: string;
  ms: number;
  usage: { prompt_tokens: number; completion_tokens: number; calls: number };
  documents: OcrDocResult[];
}
interface Slot {
  file: File | null;
  pdf: PdfHandle | null;
  page: number;
  prepared: PreparedImage | null;
  busy: boolean;
  error: string | null;
}
interface FormField {
  value: string;
  ocrStatus: FieldStatus;
  ocrValue: string;
  candidates: string[];
  /** WP-OCR-2：來自 ALS（政府地址庫）嘅候選值（chip 加細字標示）；冇＝undefined */
  alsValue?: string;
  reason?: string;
  /** 用戶已確認／改正／標明冇資料 */
  ack: boolean;
  /** 值同 OCR 預填值唔同（用戶改過） */
  edited: boolean;
  from?: OcrDocType;
  /** WP-OCR-1：同入職表手寫值嘅交叉核對（身份證關鍵欄）；入職表手寫值只作唯讀顯示，唔覆蓋身份證值 */
  cross?: CrossResult;
  formValue?: string;
}
type FormState = Record<OcrFieldKey, FormField>;

const emptySlot = (): Slot => ({ file: null, pdf: null, page: 1, prepared: null, busy: false, error: null });
const blankField = (): FormField => ({ value: "", ocrStatus: "missing", ocrValue: "", candidates: [], ack: false, edited: false });
// 更表寫咗嘅姓名預填：當作用戶自己輸入（edited），仍要逐欄核對確認先可以繼續。
const prefilledNameField = (name: string): FormField => ({ ...blankField(), value: name, edited: true, ack: ackAfterEdit("name_zh", "missing", name) });
const blankForm = (): FormState => Object.fromEntries(FIELD_ORDER.map((f) => [f, blankField()])) as FormState;

interface Row {
  key: string;
  action: "link" | "create" | "conflict" | "needs_review";
  reasons: string[];
  basis?: string[];
  hkid_masked: string | null;
  phone_masked: string | null;
  fields: Record<string, { status: string; check: string }>;
  current_name_zh: string | null;
}
interface PreviewRes {
  package_hash: string;
  rows: Row[];
  counts_hidden?: boolean;
}
interface ApplyRes {
  outcomes: Record<string, number>;
  guards_created: number;
  guards_updated: number;
  phones_added: number;
  addresses_added: number;
  staff_numbers_added: number;
  fields_written: Record<string, number>;
  results?: { key: string; reasons: string[] }[];
  counts_hidden?: boolean;
  triage?: { session_id?: string; open_questions?: number; owned_by_other?: boolean } | null;
}

const ACTION_TEXT: Record<string, string> = {
  create: "會新增一位保安員",
  link: "已有呢位保安員，只會補空欄（唔會覆蓋現有資料）",
  conflict: "同現有資料有衝突，唔會自動寫入（可以交俾待答問題處理）",
  needs_review: "未能自動處理，唔會寫入（可以交俾待答問題處理）",
};
const CHECK_TEXT: Record<string, string> = { new: "會寫入", fill: "現有冇，會補", same: "現有一樣，唔使寫", differs: "現有唔同，唔會覆蓋", conflict: "現有唔同，唔會覆蓋", missing: "冇填", not_stored: "系統唔儲存", invalid_date: "日期唔合法", hidden: "（冇權限睇比較）" };

function statusPill(f: FormField) {
  if (f.ocrStatus === "confirmed") return <Pill variant="success">已確認</Pill>;
  if (f.ocrStatus === "review") return <Pill variant="warning">要核對</Pill>;
  return <Pill variant="neutral">讀唔到</Pill>;
}

const fieldError = (k: OcrFieldKey, v: string) => fieldErrorOf(k, v, REASON_MSG);

export function NewFromDocsClient() {
  const [slots, setSlots] = useState<Record<OcrDocType, Slot>>({ id_card: emptySlot(), address_proof: emptySlot(), onboarding_form: emptySlot() });
  const [step, setStep] = useState<"upload" | "review" | "preview" | "done">("upload");
  const [form, setForm] = useState<FormState>(blankForm());
  const [addrFrom, setAddrFrom] = useState<OcrDocType | null>(null);
  const [viewDoc, setViewDoc] = useState<OcrDocType>("id_card");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ocrInfo, setOcrInfo] = useState<string | null>(null);
  const [formBKind, setFormBKind] = useState<"tiles" | "field_crops" | null>(null);
  const [preview, setPreview] = useState<PreviewRes | null>(null);
  const [pkgState, setPkgState] = useState<{ pkg: unknown; decisions: Record<string, unknown> } | null>(null);
  const [applyRes, setApplyRes] = useState<ApplyRes | null>(null);
  const [triageSession, setTriageSession] = useState<string | null>(null);
  // WP-RECONCILE-UI（§33.3 D）：deep link `?name=&staff_no=`——只預填「全部自己輸入」／辨識讀唔到嘅中文姓名，
  // 並顯示更表寫咗嘅工號作參考；唔觸發辨識，仍要上載證件、逐欄核對先寫入。
  const [prefill, setPrefill] = useState<{ name: string; staffNo: string }>({ name: "", staffNo: "" });
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    setPrefill({ name: (sp.get("name") ?? "").trim().slice(0, 40), staffNo: (sp.get("staff_no") ?? "").trim().slice(0, 40) });
  }, []);
  const urlsRef = useRef<string[]>([]);
  const pdfsRef = useRef<PdfHandle[]>([]);

  // 離開頁面／卸載即 revoke 所有圖片 object URL，並關閉 PDF
  const cleanup = useCallback(() => {
    for (const u of urlsRef.current) URL.revokeObjectURL(u);
    urlsRef.current = [];
    for (const p of pdfsRef.current) void Promise.resolve(p.destroy()).catch(() => undefined);
    pdfsRef.current = [];
  }, []);
  useEffect(() => cleanup, [cleanup]);

  async function loadPage(type: OcrDocType, file: File, pdf: PdfHandle | null, page: number) {
    setSlots((s) => ({ ...s, [type]: { ...s[type], file, pdf, page, busy: true, error: null } }));
    try {
      const canvas = pdf ? await pdf.render(page) : await canvasFromImageFile(file);
      const prepared = await prepareFromCanvas(canvas, hasCropFields(type));
      urlsRef.current.push(prepared.previewUrl);
      setSlots((s) => {
        const old = s[type].prepared?.previewUrl;
        if (old) {
          URL.revokeObjectURL(old);
          urlsRef.current = urlsRef.current.filter((u) => u !== old);
        }
        return { ...s, [type]: { ...s[type], file, pdf, page, prepared, busy: false, error: null } };
      });
    } catch {
      setSlots((s) => ({ ...s, [type]: { ...s[type], busy: false, error: "讀唔到呢個檔案（請用清晰嘅圖片或者 PDF）" } }));
    }
  }

  async function onPick(type: OcrDocType, file: File | undefined) {
    if (!file) return;
    let pdf: PdfHandle | null = null;
    if (isPdfFile(file)) {
      try {
        pdf = await openPdf(file);
        pdfsRef.current.push(pdf);
      } catch {
        setSlots((s) => ({ ...s, [type]: { ...emptySlot(), error: "PDF 打唔開" } }));
        return;
      }
    }
    await loadPage(type, file, pdf, 1);
  }

  function removeSlot(type: OcrDocType) {
    const old = slots[type].prepared?.previewUrl;
    if (old) URL.revokeObjectURL(old);
    setSlots((s) => ({ ...s, [type]: emptySlot() }));
  }

  async function onRead() {
    const docs = (Object.keys(slots) as OcrDocType[]).filter((t) => slots[t].prepared);
    if (!slots.id_card.prepared) return;
    setBusy(true);
    setError(null);
    // WP-OCR-3：先試兩段式（stage a 定位欄位 → 本機欄位級裁圖 → stage b）；任何一步失敗就退回舊單次流程，用戶無感。
    const two = await readTwoStage<OcrResponse>(
      docs.map((t) => ({ type: t, full: slots[t].prepared!.full, tiles: slots[t].prepared!.tiles, sourceW: slots[t].prepared!.source?.width ?? 0, sourceH: slots[t].prepared!.source?.height ?? 0 })),
      {
        post: async <T,>(body: unknown) => {
          const r = await apiPost<T>("/api/guards/ocr/read", body);
          return r.ok ? { ok: true as const, data: r.data } : { ok: false as const, status: r.status, message: r.message };
        },
        crop: (doc, plan) => cropFieldsFromCanvas(slots[doc.type].prepared!.source!, plan.crops),
      },
    );
    // 429／503（provider 繁忙、用唔到、配額）：唔退回舊流程，直接顯示錯誤
    if (!two.ok && two.fatal) {
      setBusy(false);
      setError(two.fatal.status === 503 ? `${two.fatal.message}（可以撳「全部自己輸入」繼續）` : two.fatal.message);
      return;
    }
    const res = two.ok ? ({ ok: true, status: 200, data: two.data } as const) : await apiPost<OcrResponse>("/api/guards/ocr/read", { documents: docs.map((t) => ({ type: t, full: slots[t].prepared!.full, tiles: slots[t].prepared!.tiles })) });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 503 ? `${res.message}（可以撳「全部自己輸入」繼續）` : res.message);
      return;
    }
    const byType = new Map(res.data.documents.map((d) => [d.type, d]));
    const next = blankForm();
    const put = (k: OcrFieldKey, d: OcrDocResult | undefined) => {
      const r = d?.fields[k];
      if (!r) return false;
      next[k] = { value: r.value, ocrStatus: r.status, ocrValue: r.value, candidates: r.candidates_ranked?.length ? r.candidates_ranked.map((c) => c.value) : r.candidates, ...(r.candidates_ranked?.find((c) => c.sources.includes("als")) ? { alsValue: r.candidates_ranked.find((c) => c.sources.includes("als"))!.value } : {}), reason: r.reason, ack: initialAck(k, r.status), edited: false, from: d!.type, ...(r.cross && d!.type === "id_card" ? { cross: r.cross.result } : {}) };
      return true;
    };
    for (const k of OCR_DOC_FIELDS.id_card) put(k, byType.get("id_card"));
    put("phone", byType.get("onboarding_form"));
    // WP-OCR-1：入職表手寫姓名／身份證號／出生日期只作唯讀顯示（交叉核對），唔覆蓋身份證值；讀到先顯示
    for (const k of ["name_zh", "hkid", "dob"] as const) {
      const hv = byType.get("onboarding_form")?.fields[k];
      if (hv && hv.status !== "missing" && hv.value.trim() && next[k].cross !== undefined) next[k] = { ...next[k], formValue: hv.value };
    }
    // 地址：住址證明優先；冇上載或者讀唔到先用入職表
    const proof = byType.get("address_proof")?.fields.address;
    const formAddr = byType.get("onboarding_form")?.fields.address;
    if (proof && (proof.status !== "missing" || !formAddr || formAddr.status === "missing")) {
      put("address", byType.get("address_proof"));
      setAddrFrom("address_proof");
    } else if (formAddr) {
      put("address", byType.get("onboarding_form"));
      setAddrFrom("onboarding_form");
    }
    if (prefill.name && !next.name_zh.value.trim()) next.name_zh = prefilledNameField(prefill.name);
    setForm(next);
    setFormBKind(res.data.documents.find((d) => d.type === "onboarding_form")?.images_b_kind ?? null);
    const u = res.data.usage;
    setOcrInfo(`辨識完成（${Math.round(res.data.ms / 100) / 10} 秒，${u.calls} 次讀取）`);
    setViewDoc("id_card");
    setStep("review");
  }

  function manualAll() {
    const f = blankForm();
    if (prefill.name) f.name_zh = prefilledNameField(prefill.name);
    setForm(f);
    setAddrFrom("address_proof");
    setOcrInfo(null);
    setFormBKind(null);
    setStep("review");
  }

  function setField(k: OcrFieldKey, v: string) {
    setForm((s) => {
      const f = s[k];
      return { ...s, [k]: { ...f, value: v, edited: v !== f.ocrValue, ack: ackAfterEdit(k, f.ocrStatus, v, f.cross) } };
    });
  }
  const ackField = (k: OcrFieldKey, empty = false) => setForm((s) => ({ ...s, [k]: { ...s[k], ack: true, ...(empty ? { value: "", edited: s[k].ocrValue !== "" } : {}) } }));

  const problems = reviewProblems(form, REASON_MSG);
  const critPending = criticalPending(form);
  const [zoom, setZoom] = useState(false);

  function buildPackage() {
    const decisions: Record<string, Record<string, { action: "confirm"; value: string }>> = {};
    const key = crypto.randomUUID();
    const mk = (k: OcrFieldKey, decisionKey?: string) => {
      const f = form[k];
      const raw = f.value.trim();
      if (!raw) return { value: null, status: "missing" as const };
      const n = normalizeField(k, raw);
      const value = n.display;
      // OCR 兩讀一致而且用戶冇改 → confirmed；用戶確認／改正嘅欄 → review＋decisions(confirm)
      if (f.ocrStatus === "confirmed" && !f.edited) return { value, status: "confirmed" as const };
      if (decisionKey) {
        decisions[key] = { ...(decisions[key] ?? {}), [decisionKey]: { action: "confirm", value } };
        return { value, status: "review" as const };
      }
      return { value, status: "confirmed" as const }; // hkid／sex：用戶已對住圖核對、格式驗證通過
    };
    const addr = mk("address", "address");
    const pkg = {
      version: 2 as const,
      generatedAt: new Date().toISOString(),
      source: "single_ocr" as const,
      persons: [
        {
          key,
          hkid: mk("hkid"),
          nameZh: mk("name_zh", "name_zh"),
          nameEn: mk("name_en", "name_en"),
          dateOfBirth: mk("dob", "date_of_birth"),
          sex: mk("sex"),
          phone: mk("phone", "phone"),
          address: { ...addr, source: addrFrom === "onboarding_form" ? ("application_form" as const) : ("address_proof" as const) },
          staffNumbers: [],
          rating: "review" as const,
          reasons: [] as string[],
        },
      ],
    };
    return { pkg, decisions };
  }

  async function onPreview() {
    setBusy(true);
    setError(null);
    const built = buildPackage();
    const hasDec = Object.keys(built.decisions).length > 0;
    const res = await apiPost<PreviewRes>("/api/guards/import/preview", { package: built.pkg, ...(hasDec ? { decisions: built.decisions } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setPkgState({ pkg: built.pkg, decisions: built.decisions });
    setPreview(res.data);
    setStep("preview");
  }

  async function onApply() {
    if (!pkgState || !preview) return;
    setBusy(true);
    setError(null);
    const hasDec = Object.keys(pkgState.decisions).length > 0;
    const res = await apiPost<ApplyRes>("/api/guards/import/apply", { package: pkgState.pkg, package_hash: preview.package_hash, ...(hasDec ? { decisions: pkgState.decisions } : {}) });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setApplyRes(res.data);
    // 儲存即棄圖：revoke 全部 object URL
    cleanup();
    setSlots({ id_card: emptySlot(), address_proof: emptySlot(), onboarding_form: emptySlot() });
    const t = res.data.triage;
    if (t && !t.owned_by_other && (t.open_questions ?? 0) > 0 && t.session_id) setTriageSession(t.session_id);
    setNotice(applySummaryText(res.data));
    setStep("done");
  }

  function startOver() {
    cleanup();
    setSlots({ id_card: emptySlot(), address_proof: emptySlot(), onboarding_form: emptySlot() });
    setForm(blankForm());
    setPreview(null);
    setPkgState(null);
    setApplyRes(null);
    setTriageSession(null);
    setNotice(null);
    setError(null);
    setOcrInfo(null);
    setStep("upload");
  }

  const row = preview?.rows[0];
  const uploaded = (Object.keys(slots) as OcrDocType[]).filter((t) => slots[t].prepared);

  return (
    <div className="space-y-4">
      <BackLink href="/guards" data-testid="back-to-guards" className="block w-fit text-zk-base text-zk-primary hover:underline">
        ‹ 返回保安員
      </BackLink>
      <PageHeader kicker={kickerFor("/guards/new-from-docs")} title="用證件新增保安員" subtitle="上載證件，由 AI 辨識自動填表；逐欄核對後先會寫入。" />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {triageSession && <TriageDialog sessionId={triageSession} onClose={() => setTriageSession(null)} />}

      {step === "upload" && (
        <div className="space-y-4" data-testid="ocr-step-upload">
          {(prefill.name || prefill.staffNo) && (
            <div className="rounded-lg border border-zk-primary/30 bg-zk-primary-tint-soft p-3 text-zk-base text-zk-primary-deep" data-testid="ocr-prefill-hint">
              由更表對數帶過嚟：更表寫「{prefill.name || "—"}／{prefill.staffNo || "—"}」。呢兩項只作參考／預填，仍要上載證件（或「全部自己輸入」）逐欄核對先會寫入。
            </div>
          )}
          <div className="rounded-lg border border-zk-warning-border bg-zk-warning-bg p-3 text-zk-base text-zk-warning-dark" data-testid="ocr-privacy-notice">
            圖片會傳送去 Claude（Anthropic，美國伺服器）同 DeepSeek（內地伺服器）做辨識，兩邊讀到一致先會預填；本系統唔會儲存圖片。圖片只留喺你部機嘅瀏覽器記憶體，儲存或者離開頁面就會清走。
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            {(Object.keys(DOC_LABEL) as OcrDocType[]).map((t) => {
              const s = slots[t];
              return (
                <div key={t} className="space-y-2 rounded-lg border border-zk-border p-3" data-testid={`ocr-slot-${t}`}>
                  <div className="text-zk-base font-semibold">{DOC_LABEL[t]}</div>
                  <input type="file" accept="image/*,application/pdf" data-testid={`ocr-file-${t}`} className="w-full text-zk-base" onChange={(e) => void onPick(t, e.target.files?.[0])} />
                  {s.busy && <div className="text-zk-sm text-zk-muted">處理緊圖片…</div>}
                  {s.error && <div className="text-zk-sm text-zk-danger">{s.error}</div>}
                  {s.pdf && s.pdf.pages > 1 && (
                    <div className="flex items-center gap-2 text-zk-sm">
                      <Button disabled={s.page <= 1 || s.busy} onClick={() => void loadPage(t, s.file!, s.pdf, s.page - 1)}>上一頁</Button>
                      <span>
                        第 {s.page} / {s.pdf.pages} 頁
                      </span>
                      <Button disabled={s.page >= s.pdf.pages || s.busy} onClick={() => void loadPage(t, s.file!, s.pdf, s.page + 1)}>下一頁</Button>
                    </div>
                  )}
                  {s.prepared && (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.prepared.previewUrl} alt={`${DOC_SHORT[t]}預覽`} className="max-h-48 w-full rounded border border-zk-border object-contain" />
                      <Button onClick={() => removeSlot(t)}>移除</Button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={busy || !slots.id_card.prepared} onClick={() => void onRead()} data-testid="ocr-read">
              {busy ? "辨識緊…（約 10–30 秒）" : "開始辨識"}
            </Button>
            <Button disabled={busy} onClick={manualAll} data-testid="ocr-manual">
              全部自己輸入
            </Button>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="space-y-3" data-testid="ocr-step-review" data-sticky-page>
          {ocrInfo && <div className="text-zk-sm text-zk-muted">{ocrInfo}。請對住圖逐欄核對：「要核對」同「讀唔到」嘅欄要你確認或者改正先可以繼續。</div>}
          {ocrInfo && formBKind && (
            <div className="text-zk-sm text-zk-muted" data-testid="ocr-b-kind" data-kind={formBKind}>
              放大圖：{formBKind === "field_crops" ? "欄位級" : "後備格"}
            </div>
          )}
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            {/* 證件圖：手機 375 闊 sticky 細圖（撳一下放大），桌面 sticky 大圖——對欄值唔使捲上捲落 */}
            <div className="sticky top-0 z-20 space-y-2 bg-zk-bg pb-2 lg:top-2 lg:w-1/2 lg:self-start" data-testid="ocr-image-pane">
              {uploaded.length > 0 ? (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {uploaded.map((t) => (
                      <Button key={t} variant={viewDoc === t ? "primary" : "secondary"} onClick={() => setViewDoc(t)}>
                        {DOC_SHORT[t]}
                      </Button>
                    ))}
                  </div>
                  {slots[viewDoc].prepared && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={slots[viewDoc].prepared!.previewUrl}
                      alt={`${DOC_SHORT[viewDoc]}原圖`}
                      onClick={() => setZoom((z) => !z)}
                      title="撳一下放大／縮細"
                      className={`w-full cursor-zoom-in rounded border border-zk-border object-contain ${zoom ? "max-h-[75vh]" : "max-h-32"} lg:max-h-[80vh]`}
                      data-testid="ocr-review-image"
                    />
                  )}
                </>
              ) : (
                <div className="rounded-lg border border-zk-border p-3 text-zk-base text-zk-muted">全部自己輸入模式：冇上載圖片，請直接填寫。</div>
              )}
            </div>
            <div className="space-y-3 lg:w-1/2">
              {critPending && ocrInfo && (
                <div className="rounded-lg border border-zk-warning-border bg-zk-warning-bg p-2.5 text-zk-base font-semibold text-zk-warning-dark" data-testid="ocr-critical-notice">
                  {CRITICAL_MSG}
                </div>
              )}
              {[...FIELD_ORDER].sort((a, b) => Number(isCritical(b)) - Number(isCritical(a))).map((k) => {
                const f = form[k];
                const err = fieldError(k, f.value);
                const needAck = !f.ack;
                const crit = isCritical(k);
                const reasonMsg = f.reason && f.ocrStatus !== "confirmed" ? REASON_MSG[f.reason] : null;
                return (
                  <div key={k} className={`space-y-1 rounded-lg border p-2.5 ${crit ? "border-2 border-zk-primary/30" : "border-zk-border"}`} data-testid={`ocr-field-${k}`} data-status={f.ocrStatus} data-ack={f.ack ? "1" : "0"}>
                    <div className="flex flex-wrap items-center gap-2 text-zk-base">
                      <span className="font-semibold">
                        {FIELD_LABEL[k]}
                        {REQUIRED.includes(k) ? " *" : ""}
                      </span>
                      {statusPill(f)}
                      {f.edited && <Pill variant="shift">已改</Pill>}
                      {crit && f.ack && f.value.trim() && <Pill variant="success">已對過證件</Pill>}
                      {k === "address" && addrFrom === "onboarding_form" && f.value && <Pill variant="neutral">來自入職表</Pill>}
                    </div>
                    {crit && f.value.trim() && (
                      <div className={`break-all rounded bg-zk-header px-2 py-1.5 text-zk-2xl font-bold leading-tight tracking-wide ${k === "hkid" ? "font-mono" : ""}`} data-testid={`ocr-big-${k}`}>
                        {k === "hkid" ? groupHkid(f.value) : f.value}
                      </div>
                    )}
                    {k === "sex" ? (
                      <select className="w-full rounded-[5px] border border-zk-border px-2 py-1.5 text-zk-md" value={f.value} onChange={(e) => setField(k, e.target.value)} aria-label={FIELD_LABEL[k]}>
                        <option value="">（未填）</option>
                        <option value="M">男 M</option>
                        <option value="F">女 F</option>
                      </select>
                    ) : (
                      <input
                        className="w-full rounded-[5px] border border-zk-border px-2 py-1.5 text-zk-md"
                        value={f.value}
                        onChange={(e) => setField(k, e.target.value)}
                        aria-label={FIELD_LABEL[k]}
                        inputMode={k === "phone" ? "tel" : undefined}
                      />
                    )}
                    {f.candidates.length > 1 && (
                      <div className="flex flex-wrap items-center gap-1.5 text-zk-sm" data-testid={`ocr-chips-${k}`}>
                        <span className="text-zk-faint">候選（撳一下套用）：</span>
                        {candidateChips(k, f.candidates).map((c, i) => (
                          <Button
                            variant={c.value === f.value ? "primary" : "secondary"}
                            size="sm"
                            key={c.value}
                            type="button"
                            className="max-w-full whitespace-normal break-all text-left"
                            aria-pressed={c.value === f.value}
                            data-testid={`ocr-chip-${k}-${i}`}
                            onClick={() => setField(k, c.value)}
                          >
                            {c.segs ? c.segs.map((sg, n) => (sg.diff ? <mark key={n} className="rounded-sm bg-zk-warning-bg px-px font-bold text-zk-danger-dark" data-diff="1">{sg.ch}</mark> : <span key={n}>{sg.ch}</span>)) : c.value}
                            {f.alsValue === c.value && <span className="ml-1 text-[10px] font-normal text-zk-faint" data-testid={`ocr-chip-als-${k}`}>政府地址庫</span>}
                          </Button>
                        ))}
                      </div>
                    )}
                    {f.cross && (
                      <div
                        className={`break-words text-zk-sm ${f.cross === "differs" ? "font-semibold text-zk-danger" : f.cross === "match" ? "text-zk-success" : "text-zk-muted"}`}
                        data-testid={`ocr-cross-${k}`}
                        data-result={f.cross}
                      >
                        {f.formValue && <span data-testid={`ocr-form-value-${k}`}>入職表手寫（唯讀）：{f.formValue}　</span>}
                        {CROSS_MSG[f.cross]}
                      </div>
                    )}
                    {reasonMsg && <div className="text-zk-sm text-zk-warning">{reasonMsg}</div>}
                    {err && <div className="text-zk-sm text-zk-danger">{err}</div>}
                    {needAck && (
                      <div className="flex flex-wrap items-center gap-2">
                        {f.value.trim() ? (
                          <Button variant="primary" disabled={!!err} onClick={() => ackField(k)} data-testid={`ocr-ack-${k}`}>
                            {crit ? (f.cross === "differs" ? "對過證件，以證件為準" : "對過證件，啱") : "對住圖確認"}
                          </Button>
                        ) : !REQUIRED.includes(k) ? (
                          <Button onClick={() => ackField(k, true)}>呢項冇資料／略過</Button>
                        ) : (
                          <span className="text-zk-sm text-zk-muted">請自己輸入</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {problems.length > 0 && <div className="text-zk-sm text-zk-warning" data-testid="ocr-problems">{critPending && ocrInfo ? `${CRITICAL_MSG}。` : ""}仲有 {problems.length} 項要處理：{problems.slice(0, 4).join("、")}{problems.length > 4 ? "…" : ""}</div>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={startOver}>重新開始</Button>
            <Button variant="primary" disabled={busy || problems.length > 0} onClick={() => void onPreview()} data-testid="ocr-to-preview">
              {busy ? "預覽緊…" : "下一步：預覽"}
            </Button>
          </div>
        </div>
      )}

      {step === "preview" && row && (
        <div className="space-y-3" data-testid="ocr-step-preview">
          <div className="rounded-lg border border-zk-border p-3 text-zk-md">
            <div className="font-semibold" data-testid="ocr-preview-action">{ACTION_TEXT[row.action]}</div>
            <div className="mt-1 text-zk-sm text-zk-muted">
              身份證 {row.hkid_masked ?? "—"} · 電話 {row.phone_masked ?? "—"}
              {row.current_name_zh ? ` · 現有紀錄：${row.current_name_zh}` : ""}
            </div>
            {row.reasons.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {row.reasons.map((r) => (
                  <Pill key={r} variant="warning">
                    {reasonLabel(r)}
                  </Pill>
                ))}
              </div>
            )}
          </div>
          <div className="overflow-x-auto rounded-lg border border-zk-border">
            <table className={tableCls.table}>
              <tbody>
                {FIELD_ORDER.filter((k) => k !== "sex").map((k) => {
                  // 回應經 camelToSnake：欄位 key 係 name_zh／name_en／date_of_birth…
                  const c = row.fields[k === "dob" ? "date_of_birth" : k];
                  return (
                    <tr key={k}>
                      <td className={tableCls.td}>{FIELD_LABEL[k]}</td>
                      <td className={tableCls.td}>{k === "phone" && c?.check === "differs" ? "現有有其他電話，會加入呢個號碼（冇「保安員個人資料」權限只補空）" : (CHECK_TEXT[c?.check ?? "missing"] ?? "（未能比較）")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setStep("review")}>返去修改</Button>
            <Button variant="danger" disabled={busy} onClick={() => void onApply()} data-testid="ocr-apply">
              {busy ? "套用緊…" : row.action === "create" ? "確認新增" : row.action === "link" ? "確認補充資料" : "確認（交俾待答問題處理）"}
            </Button>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="space-y-3" data-testid="ocr-step-done">
          {applyRes && (
            <div className="rounded-lg border border-zk-border p-3 text-zk-base">
              新增 {applyRes.guards_created} · 更新 {applyRes.guards_updated} · 電話 {applyRes.phones_added} · 地址 {applyRes.addresses_added}
              {applyRes.results?.[0]?.reasons.length ? <div className="mt-1 text-zk-warning">{applyRes.results[0].reasons.map(reasonLabel).join("、")}</div> : null}
              {applyRes.triage?.owned_by_other ? <div className="mt-1">呢位已有同事跟進中。</div> : null}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={startOver}>再新增一位</Button>
            <a href="/guards" className="inline-flex items-center rounded-md border border-zk-border px-3 py-1.5 text-sm hover:bg-zk-hover">返去保安員</a>
          </div>
        </div>
      )}
    </div>
  );
}
