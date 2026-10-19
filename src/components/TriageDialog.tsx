"use client";
// WP-AI-OPS §28.4：導入後對話式分診 dialog。
// 一條一條問：證據卡 → 揀選項（系統列舉，唔收自由指令）→「預覽影響」→「確認寫入」；
// 可以「跳過，留返人手」或「遲啲先答」（關閉，之後喺「待答問題」續答）。
// 寫入全部由 server 經現有導入路徑做，呢度只負責問同顯示；回應 DTO 係 snake_case。
import { reasonLabel } from "@/lib/triage/reason-labels";
import { hanCount, hkidInputState } from "@/lib/guards/hkid-pure";
import { EvidenceImages, EvidenceSection, OriginalPages, REVIEW_TO_EVIDENCE_FIELD, type EvidenceImageDto } from "@/components/EvidenceImages";
import { useEffect, useMemo, useRef, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { apiPost, apiRequest, type ApiListResult } from "@/lib/ui/api-client";
import { useTriagePager } from "@/lib/ui/use-triage-pager";
import { useHistoryOverlay } from "@/lib/ui/use-history-overlay";
import { choiceBtn } from "@/components/ui/button-classes";

interface Field {
  value: string | null;
  status: string;
}
interface Option {
  id: string;
  label: string;
  hint?: string;
  input?: "text" | "hkid" | "guard_search";
  guard_id?: string;
}
interface ExtScalar {
  key: string;
  label: string;
  value: string;
  status: string;
}
interface ExtView {
  scalars: ExtScalar[];
  bank: { status: string; hidden?: boolean; code?: string | null; name?: string | null; account_masked?: string | null; account_full?: string | null; payee_name?: string | null } | null;
  emergency_contacts: { key: string; label: string; status: string; name: string | null; relationship: string | null; tel: string | null }[];
  staff_hires: ExtScalar[];
}
interface Candidate {
  guard_id: string;
  name_zh: string;
  name_en: string | null;
  hkid: string | null;
  date_of_birth: string | null;
  tels: string[];
  staff_numbers: string[];
  recent_sites: { name: string; last_date: string }[];
  name_hidden?: boolean;
  bank?: { has: boolean; tail4: string | null };
}
interface Question {
  id: string;
  kind: string;
  kind_label: string;
  status: string;
  title?: string;
  /** 銀行題而你冇「保安員銀行資料」修改權：內容收埋 */
  restricted?: boolean;
  /** 已答題嘅答案摘要；source=ocr_reread＝由「OCR 重讀建議」自動答 */
  answer?: { option: string; source?: "ocr_reread" } | null;
  options: Option[];
  /** TE-1：原文件欄位裁圖 meta（唔含 bytes；圖由 GET /api/triage/evidence-images/:id 攞） */
  evidence_images?: EvidenceImageDto[];
  /** TE-7：有整頁原稿但冇權限睇（頁數） */
  evidence_pages_hidden?: number;
  evidence: {
    pii_visible: boolean;
    pii_update: boolean;
    guard_update: boolean;
    bank_view: boolean;
    bank_update: boolean;
    person: { hkid: Field; name_zh: Field; name_en: Field; date_of_birth: Field; phone: Field; address: Field; staff_numbers: string[]; ext: ExtView | null; doc_info?: { page_count: number; pages_by_kind: Record<string, number>; file_ext: string[] } | null } | null;
    reasons: string[];
    doc_ref?: { file_name: string | null; page_count: number; pages_by_kind: Record<string, number> } | null;
    candidates: Candidate[];
    review_fields: { field: string; label: string; check: string }[];
    ext_review: { key: string; label: string; check: string; status: string; held?: "longterm_hire_date" | "identity" | "bank" }[];
    unassigned: { bank_code: string; bank_name: string | null; account_masked: string | null; account_full: string | null; payee_name: string | null; hidden?: boolean } | null;
  };
}
interface Impact {
  can_confirm: boolean;
  summary: string[];
  changes: { table: string; action: string; label: string; fields: { label: string; from: string | null; to: string }[] }[];
  field_outcomes: { field: string; label: string; outcome: string }[];
  notes: string[];
  /** TE-3：唔可以確認時嘅人話原因（server 逐個 reason code 轉出嚟） */
  reason_text?: string;
  /** TE-3：補咗呢啲欄就可以確認（例：冇姓名要補中文姓名） */
  needs_fields?: { field: "name_zh" | "name_en"; label: string; required: boolean }[];
  /** TE-5：同名現有保安員要人決定 */
  needs_decision?: { reason: string; candidates: DecisionCandidate[]; options: ("link" | "create_new" | "skip")[]; truncated?: boolean };
}
interface DecisionCandidate {
  guard_id: string;
  name_zh: string;
  name_en: string | null;
  has_hkid: boolean;
  has_dob: boolean;
  staff_numbers: string[];
  phone_masked: string | null;
  created_at: string;
  last_shift_month: string | null;
  active: boolean;
  same_hkid?: boolean;
}
/** TE-3：建人類題型——姓名圖只喺「要補姓名」嗰陣喺輸入框旁出現，題卡頂淨係身份證號圖 */
const NAME_ON_DEMAND_KINDS = new Set(["no_id_card", "hkid_not_confirmed", "ext_identity_check"]);
const NAME_FIELDS: { field: "name_zh" | "name_en"; label: string; required: boolean }[] = [
  { field: "name_zh", label: "中文姓名", required: true },
  { field: "name_en", label: "英文姓名", required: false },
];
const SUPP_KINDS = ["field_review", "ext_field_conflict", "ext_field_review"];
const isSupp = (k: string) => SUPP_KINDS.includes(k);

export { reasonLabel };

const KIND_PAGE_LABEL: Record<string, string> = { id_card: "身份證", application_form: "入職表", address_proof: "住址證明", sia_permit: "牌照", bank: "銀行", address_declaration: "地址聲明", other: "其他", blank: "空白" };

const STATUS_LABEL: Record<string, string> = { confirmed: "已確認", review: "待核對", missing: "冇資料" };
const CHECK_LABEL: Record<string, string> = { hidden: "你冇權限睇現有資料",  fill: "現有資料冇，會補", differs: "同現有資料唔同", invalid_date: "日期唔合法", new: "新", held: "待你決定", add: "會加多一位", same: "同現有資料一樣", not_stored: "系統未儲存" };

function FieldRow({ label, f }: { label: string; f: Field }) {
  // TE-7：missing 欄唔再隱藏，要見到有邊啲欄係缺
  if (f.status === "missing" && !f.value)
    return (
      <div className="flex flex-wrap items-center gap-x-2 text-zk-base text-zk-faint" data-testid="triage-field-missing">
        <span className="w-[72px] shrink-0">{label}</span>
        <span>—（未讀到）</span>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-zk-base">
      <span className="w-[72px] shrink-0 text-zk-faint">{label}</span>
      <span className="break-all">{f.value ?? "（冇權限睇／無）"}</span>
      <Pill variant={f.status === "confirmed" ? "success" : "warning"}>{STATUS_LABEL[f.status] ?? f.status}</Pill>
    </div>
  );
}

/** 銀行戶口：預設淨顯示尾 4 位；有「保安員銀行資料:view」先有「顯示全號」，撳先出（確認寫入前核對用）。 */
function BankLine({ b }: { b: NonNullable<ExtView["bank"]> }) {
  const [full, setFull] = useState(false);
  if (b.hidden) return <div className="text-zk-base text-zk-faint" data-testid="bank-hidden">銀行資料（你冇「保安員銀行資料」睇權，內容唔顯示）</div>;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-zk-base" data-testid="bank-line">
      <span className="w-[72px] shrink-0 text-zk-faint">銀行</span>
      <span className="break-all">
        {b.name ?? b.code ?? "—"}（{b.code ?? "—"}）· 戶口 {full && b.account_full ? b.account_full : (b.account_masked ?? "—")} · 收款人 {b.payee_name ?? "—"}
      </span>
      <Pill variant={b.status === "confirmed" ? "success" : "warning"}>{STATUS_LABEL[b.status] ?? b.status}</Pill>
      {b.account_full && (
        <Button variant="secondary" size="sm" type="button" onClick={() => setFull((v) => !v)} data-testid="bank-show-full">
          {full ? "隱藏全號" : "顯示全號"}
        </Button>
      )}
    </div>
  );
}

function ExtLines({ ext }: { ext: ExtView | null }) {
  if (!ext) return null;
  return (
    <>
      {ext.scalars.map((s) => (
        <div key={s.key} className="flex flex-wrap items-center gap-x-2 text-zk-base">
          <span className="w-[72px] shrink-0 text-zk-faint">{s.label.replace(/（系統未儲存）/, "")}</span>
          <span className="break-all">{s.value}</span>
          <Pill variant={s.status === "confirmed" ? "success" : "warning"}>{STATUS_LABEL[s.status] ?? s.status}</Pill>
        </div>
      ))}
      {ext.staff_hires.map((s) => (
        <div key={s.key} className="flex flex-wrap items-center gap-x-2 text-zk-base">
          <span className="shrink-0 text-zk-faint">{s.label}</span>
          <span>{s.value}</span>
          <Pill variant={s.status === "confirmed" ? "success" : "warning"}>{STATUS_LABEL[s.status] ?? s.status}</Pill>
        </div>
      ))}
      {ext.emergency_contacts.map((c) => (
        <div key={c.key} className="flex flex-wrap items-center gap-x-2 text-zk-base">
          <span className="shrink-0 text-zk-faint">{c.label}</span>
          <span className="break-all">
            {c.name ?? "—"}
            {c.relationship ? `（${c.relationship}）` : ""} · {c.tel ?? "—"}
          </span>
          <Pill variant={c.status === "confirmed" ? "success" : "warning"}>{STATUS_LABEL[c.status] ?? c.status}</Pill>
        </div>
      ))}
      {ext.bank && <BankLine b={ext.bank} />}
    </>
  );
}

function PersonCard({ q }: { q: Question }) {
  const p = q.evidence.person;
  const u = q.evidence.unassigned;
  if (u) {
    return (
      <div className="space-y-1 rounded-lg border border-zk-border bg-zk-header/40 p-3" data-testid="triage-unassigned">
        <div className="text-zk-sm font-semibold text-zk-muted">Payroll Editor 嘅戶口（對唔到人）</div>
        {u.hidden ? (
          <div className="text-zk-base text-zk-faint">你冇「保安員銀行資料」睇權，內容唔顯示。</div>
        ) : (
          <BankLine b={{ status: "review", code: u.bank_code, name: u.bank_name, account_masked: u.account_masked, account_full: u.account_full, payee_name: u.payee_name }} />
        )}
      </div>
    );
  }
  if (!p) return null;
  const empty = [p.name_zh, p.name_en, p.hkid, p.date_of_birth, p.phone, p.address].every((f) => f.status === "missing" && !f.value) && p.staff_numbers.length === 0 && !p.ext;
  if (empty) {
    const di = p.doc_info;
    return (
      <div className="space-y-1 rounded-lg border border-zk-border bg-zk-header/40 p-3" data-testid="triage-person-empty">
        <div className="text-zk-sm font-semibold text-zk-muted">導入包內嘅資料</div>
        <div className="text-zk-base font-semibold text-zk-warning">導入包冇讀到呢位嘅任何資料</div>
        {q.evidence.reasons.length > 0 && <div className="text-zk-sm text-zk-muted">原因：{[...new Set(q.evidence.reasons.map(reasonLabel))].join("、")}</div>}
        {di && (
          <div className="text-zk-sm text-zk-muted" data-testid="triage-doc-info">
            來源文件：共 {di.page_count} 頁
            {Object.keys(di.pages_by_kind).length > 0 ? `（${Object.entries(di.pages_by_kind).map(([k, n]) => `${k} ${n}`).join("、")}）` : ""}
            {di.file_ext.length > 0 ? `・類型 ${di.file_ext.join("、")}` : ""}
          </div>
        )}
        {q.evidence.doc_ref && (
          <div className="text-zk-sm text-zk-muted" data-testid="triage-doc-ref">
            檔案：{q.evidence.doc_ref.file_name ?? "（你冇權限睇檔名）"}（{q.evidence.doc_ref.page_count} 頁
            {Object.keys(q.evidence.doc_ref.pages_by_kind).length > 0 ? `：${Object.entries(q.evidence.doc_ref.pages_by_kind).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${KIND_PAGE_LABEL[k] ?? k} ${n}`).join("、")}` : ""}）
          </div>
        )}
        <div className="text-zk-sm text-zk-muted">下一步：請補交身份證副本／入職表再導入，或者人手輸入。</div>
        <OriginalPages imgs={q.evidence_images ?? []} hidden={q.evidence_pages_hidden ?? 0} />
      </div>
    );
  }
  return (
    <div className="space-y-1 rounded-lg border border-zk-border bg-zk-header/40 p-3" data-testid="triage-person">
      <div className="text-zk-sm font-semibold text-zk-muted">導入包內嘅資料</div>
      <FieldRow label="中文姓名" f={p.name_zh} />
      <FieldRow label="英文姓名" f={p.name_en} />
      <FieldRow label="身份證" f={p.hkid} />
      <FieldRow label="出生日期" f={p.date_of_birth} />
      <FieldRow label="電話" f={p.phone} />
      <FieldRow label="地址" f={p.address} />
      {p.staff_numbers.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 text-zk-base">
          <span className="w-[72px] shrink-0 text-zk-faint">工號</span>
          <span>{p.staff_numbers.join("、")}</span>
        </div>
      )}
      <ExtLines ext={p.ext} />
      {!q.evidence.pii_visible && <div className="text-zk-xs text-zk-faint">你冇「保安員個人資料」權限，身份證／電話／地址已遮罩，出生日期唔顯示。</div>}
    </div>
  );
}

function CandidateCard({ c, idx }: { c: Candidate; idx: number }) {
  return (
    <div className="space-y-0.5 rounded-lg border border-zk-border p-3 text-zk-base" data-testid="triage-candidate">
      <div className="text-zk-sm font-semibold text-zk-muted">現有保安員（候選 {idx + 1}）</div>
      <div>
        {c.name_hidden ? <span className="text-zk-faint">姓名同導入包唔同（要有保安員個人資料權限先睇到）</span> : c.name_zh}
        {c.name_en ? <span className="ml-1 text-zk-faint">{c.name_en}</span> : null}
      </div>
      <div className="text-zk-muted">
        身份證 {c.hkid ?? "未有"} · 出生日期 {c.date_of_birth ?? "—"}
      </div>
      {c.tels.length > 0 && <div className="text-zk-muted">電話 {c.tels.join("、")}</div>}
      {c.staff_numbers.length > 0 && <div className="text-zk-muted">工號 {c.staff_numbers.join("、")}</div>}
      {c.bank?.has && <div className="text-zk-muted" data-testid="candidate-has-bank">已有銀行戶口{c.bank.tail4 ? `（尾 4 位 ${c.bank.tail4}）` : ""}</div>}
      <div className="text-zk-muted">最近返更盤：{c.recent_sites.length ? c.recent_sites.map((s) => `${s.name}（${s.last_date}）`).join("、") : "未有紀錄"}</div>
    </div>
  );
}

/** TE-6：身份證號即時提示（灰＝格式未齊；紅＝check digit 唔啱；綠＝合法） */
function HkidHint({ raw }: { raw: string }) {
  const { state } = hkidInputState(raw);
  if (state === "empty") return <span className="mt-1 block text-zk-xs text-zk-faint" data-testid="triage-hkid-hint" data-state="empty">格式：A123456(3)</span>;
  if (state === "partial") return <span className="mt-1 block text-zk-xs text-zk-faint" data-testid="triage-hkid-hint" data-state="partial">格式：A123456(3)（未齊）</span>;
  if (state === "bad_format") return <span className="mt-1 block text-zk-xs text-zk-danger-dark" data-testid="triage-hkid-hint" data-state="bad_format">格式唔啱：要 1–2 個英文字母＋6 位數字＋檢查碼，例 A123456(3)</span>;
  if (state === "bad_check") return <span className="mt-1 block text-zk-xs text-zk-danger" data-testid="triage-hkid-hint" data-state="bad_check">檢查碼唔啱，請對住裁圖再睇（括號內係檢查碼）</span>;
  return <span className="mt-1 block text-zk-xs text-zk-success" data-testid="triage-hkid-hint" data-state="valid">✓ 身份證號合法</span>;
}

function ImpactCard({ impact }: { impact: Impact }) {
  return (
    <div className="space-y-2 rounded-lg border border-zk-primary/30 bg-zk-primary-tint-soft p-3 text-zk-base" data-testid="triage-impact">
      <div className="font-semibold text-zk-primary-deep">影響預覽（未寫入）</div>
      <ul className="list-disc pl-5">
        {impact.summary.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      {impact.changes.map((c, i) => (
        <div key={i} className="rounded border border-zk-primary-tint bg-white p-2">
          <div className="text-zk-sm font-semibold">{c.label}</div>
          {c.fields.map((f) => (
            <div key={f.label} className="text-zk-sm">
              {f.label}：{f.from !== null ? `${f.from} → ` : ""}
              <b>{f.to}</b>
            </div>
          ))}
        </div>
      ))}
      {impact.field_outcomes.length > 0 && (
        <div className="text-zk-sm text-zk-muted">{impact.field_outcomes.map((o) => `${o.label}：${o.outcome}`).join(" · ")}</div>
      )}
      {impact.notes.map((n) => (
        <div key={n} className="text-zk-sm text-zk-warning">
          {n}
        </div>
      ))}
      {!impact.can_confirm && impact.reason_text && (
        <div className="text-zk-sm font-semibold text-zk-danger" data-testid="triage-reason-text">
          唔可以寫入：{impact.reason_text}
        </div>
      )}
    </div>
  );
}

type FieldAns = { action: "confirm" | "replace" | "skip"; value?: string };
type ExtChoice = "use_import" | "keep_current" | "skip";
const EXT_CHOICE_LABEL: Record<ExtChoice, string> = { use_import: "用導入值", keep_current: "保留現值", skip: "跳過" };

/** 「搜尋其他保安員」：用現有 GET /api/guards（搜尋字經 header，唔入 URL）。 */
function GuardSearch({ onPick }: { onPick: (g: { id: string; name: string } | null) => void }) {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<{ id: string; name_zh: string; name_en: string | null; staff_numbers?: { number: string }[]; status?: string }[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    const t = term.trim();
    if (t.length < 2) {
      setRows([]);
      return;
    }
    const h = setTimeout(() => {
      void apiRequest<ApiListResult<{ id: string; name_zh: string; name_en: string | null; staff_numbers?: { number: string }[]; status?: string }>>("/api/guards?take=10&include_inactive=1", { headers: { "x-guard-search": encodeURIComponent(t) } }).then((r) => setRows(r.ok ? r.data.rows : []));
    }, 250);
    return () => clearTimeout(h);
  }, [term]);
  return (
    <span className="mt-1.5 block space-y-1" data-testid="guard-search">
      <input className="w-full rounded-[5px] border border-zk-border px-2 py-1.5" placeholder="輸入姓名／工號／電話搜尋" value={term} aria-label="搜尋保安員" onChange={(e) => { setTerm(e.target.value); setPicked(null); onPick(null); }} />
      {rows.map((r) => (
        <button key={r.id} type="button" className={choiceBtn(picked === r.id, "block w-full text-left")} onClick={() => { setPicked(r.id); onPick({ id: r.id, name: r.name_zh }); }}>
          {r.name_zh}
          {r.name_en ? <span className="ml-1 text-zk-faint">{r.name_en}</span> : null}
          {r.staff_numbers?.length ? <span className="ml-1 text-zk-faint">{r.staff_numbers.map((n) => n.number).join("、")}</span> : null}
          {r.status && r.status !== "active" ? <span className="ml-1 text-zk-warning">（非在職）</span> : null}
        </button>
      ))}
    </span>
  );
}

export function TriageDialog({ sessionId, onClose, onChanged }: { sessionId: string; onClose: () => void; onChanged?: () => void }) {
  // P13.1：分頁載入——頭 5 題即刻顯示，快到尾背景 prefetch；counts 係整個 session 嘅數
  // P13.3「由頭開始」：status 轉 open,skipped＝連之前跳過咗嘅一齊攞（可重新答）
  const [status, setStatus] = useState("open");
  const impP = useTriagePager<Question>(sessionId, { tier: "important", status });
  const supP = useTriagePager<Question>(sessionId, { tier: "supplementary", status });
  const { close } = useHistoryOverlay(true, onClose, `triage-${sessionId}`); // P13.5：返回＝關對話框，唔離開頁面
  // P13.2：本次對話框內答過／跳過嘅題（上一題回看用）；view＝正在回看第幾個（null＝最新未答）
  const [trail, setTrail] = useState<{ q: Question; kind: "answered" | "skipped"; label: string }[]>([]);
  const [view, setView] = useState<number | null>(null);
  const [resume, setResume] = useState<{ n: number } | null>(null); // P13.3
  const baseOffset = useRef<number | null>(null);
  const lastKind = useRef<"answered" | "skipped">("answered");
  const lastLabel = useRef("");
  const [since, setSince] = useState({ imp: 0, sup: 0 }); // 自上次攞 counts 之後答咗／跳過幾多
  const [done, setDone] = useState({ imp: 0, sup: 0 });
  const [suppStarted, setSuppStarted] = useState(false);
  const [choice, setChoice] = useState<string>("");
  const [text, setText] = useState("");
  const [fields, setFields] = useState<Record<string, FieldAns>>({});
  const [extChoices, setExtChoices] = useState<Record<string, ExtChoice>>({});
  const [pickedGuard, setPickedGuard] = useState<{ id: string; name: string } | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [confirmIdentity, setConfirmIdentity] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [extraNames, setExtraNames] = useState<{ name_zh: string; name_en: string }>({ name_zh: "", name_en: "" });
  const [decision, setDecision] = useState<{ kind: "link"; guardId: string } | { kind: "create_new" } | null>(null); // TE-5
  const [extraShown, setExtraShown] = useState(false); // 曾經要補姓名：之後預覽可確認（needs_fields 消失）都要繼續帶 extra
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { reload: reloadImp, loadMore: loadMoreImp } = impP;
  const { reload: reloadSup, loadMore: loadMoreSup } = supP;
  useEffect(() => {
    void reloadImp();
  }, [reloadImp]);

  // 重要（要人手／衝突）先問，補充資料（field_review）後問；答完重要嗰批先問要唔要繼續
  const imp = useMemo(() => impP.items ?? [], [impP.items]);
  const sup = useMemo(() => (suppStarted ? (supP.items ?? []) : []), [supP.items, suppStarted]);
  const cnt = impP.counts;
  const restarted = status !== "open";
  const impRemaining = cnt ? Math.max(0, cnt.important_open + cnt.restricted_open + (restarted ? cnt.skipped : 0) - since.imp) : 0;
  const supRemaining = cnt ? Math.max(0, cnt.supplementary_open - since.sup) : 0;
  const liveQ = imp[0] ?? (suppStarted ? (sup[0] ?? null) : null);
  // P13.2 回看：已答（只讀，改答案留下一輪）／跳過（可以重新答）
  const viewing = view !== null ? (trail[view] ?? null) : null;
  const readOnly = !!viewing && viewing.kind === "answered";
  const q = viewing ? (readOnly ? null : viewing.q) : liveQ;
  const shownQ = viewing ? viewing.q : liveQ;
  // 第一頁未到，或者空咗但仲有下一頁（prefetch 未到）＝仍然載入緊
  const loading = impP.items === null || (!imp[0] && (impP.hasMore || impP.loadingMore)) || (suppStarted && !imp[0] && (supP.items === null || (!supP.items[0] && (supP.hasMore || supP.loadingMore))));
  const queueReady = !loading;
  const gate = queueReady && !liveQ && !viewing && supRemaining > 0 && !suppStarted;
  // prefetch：剩返 ≤3 題（即係去到每頁第 3 題）就背景攞下一頁
  useEffect(() => {
    if (impP.hasMore && !impP.loadingMore && imp.length <= 3) void loadMoreImp();
  }, [impP.hasMore, impP.loadingMore, imp.length, loadMoreImp]);
  useEffect(() => {
    if (suppStarted && supP.hasMore && !supP.loadingMore && sup.length <= 3) void loadMoreSup();
  }, [suppStarted, supP.hasMore, supP.loadingMore, sup.length, loadMoreSup]);
  // 補充資料第一頁：重要題剩尾幾題（或者撳「繼續做補充資料」）就預先攞，gate 撳落去即刻有題
  // P13.3 記住位置：每個 session 嘅當前題 id＋第 N 題存 sessionStorage；重開由上次位置繼續
  const posKey = `zk-triage-pos-${sessionId}`;
  useEffect(() => {
    if (!cnt || baseOffset.current !== null) return;
    baseOffset.current = restarted ? 0 : cnt.answered + cnt.skipped;
  }, [cnt, restarted]);
  const liveId = liveQ?.id ?? null;
  const [resumeChecked, setResumeChecked] = useState(false);
  useEffect(() => {
    if (!liveId || baseOffset.current === null) return;
    const n = baseOffset.current + done.imp + done.sup + 1;
    if (!resumeChecked) {
      setResumeChecked(true);
      try {
        const raw = window.sessionStorage.getItem(posKey);
        const st = raw ? (JSON.parse(raw) as { id?: string; n?: number }) : null;
        if (st && st.id === liveId && typeof st.n === "number" && st.n > 1) setResume({ n: st.n });
      } catch {
        /* sessionStorage 唔可用就算 */
      }
      return;
    }
    try {
      window.sessionStorage.setItem(posKey, JSON.stringify({ id: liveId, n }));
    } catch {
      /* ignore */
    }
  }, [liveId, done.imp, done.sup, posKey, resumeChecked, cnt]);
  function restartFromBeginning() {
    try {
      window.sessionStorage.removeItem(posKey);
    } catch {
      /* ignore */
    }
    baseOffset.current = 0;
    setResume(null);
    setTrail([]);
    setView(null);
    setDone({ imp: 0, sup: 0 });
    setSince({ imp: 0, sup: 0 });
    setSuppStarted(false);
    setStatus("open,skipped");
  }
  // status 轉咗（由頭開始）→ 兩層都重載
  useEffect(() => {
    if (status !== "open" && supP.items !== null) void reloadSup();
  }, [status, reloadSup]); // eslint-disable-line react-hooks/exhaustive-deps

  const supNeeded = supRemaining > 0 && supP.items === null && (suppStarted || (!impP.hasMore && imp.length <= 2 && impP.items !== null));
  useEffect(() => {
    if (supNeeded) void reloadSup();
  }, [supNeeded, reloadSup]);
  const reset = () => {
    setChoice("");
    setText("");
    setFields({});
    setExtChoices({});
    setPickedGuard(null);
    setReplaceExisting(false);
    setConfirmIdentity(false);
    setImpact(null);
    setHash(null);
    setExtraNames({ name_zh: "", name_en: "" });
    setExtraShown(false);
    setDecision(null);
    setError(null);
  };
  useEffect(() => {
    reset();
  }, [q?.id]);
  useEffect(() => {
    setExtraShown(false);
    setDecision(null);
  }, [choice]);
  // TE-5：揀咗連結／建新人 → 自動重新預覽（之後一撳「確認寫入」）
  const lastDecision = useRef<string>("");
  useEffect(() => {
    const k = decision ? (decision.kind === "link" ? `l:${decision.guardId}` : "c") : "";
    if (!k || lastDecision.current === k) {
      if (!k) lastDecision.current = "";
      return;
    }
    lastDecision.current = k;
    void runPreview();
  }, [decision]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(() => (q ? q.options.find((o, i) => `${o.id}:${o.guard_id ?? ""}:${i}` === choice) ?? null : null), [q, choice]);

  function buildAnswer(): Record<string, unknown> | null {
    if (!selected) return null;
    if (selected.id === "apply_fields") return { option: "apply_fields", fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { action: v.action, ...(v.action !== "skip" && v.value ? { value: v.value } : {}) }])) };
    if (selected.id === "apply_ext_fields") return { option: "apply_ext_fields", ext_fields: extChoices, ...(replaceExisting ? { replace_existing: true } : {}) };
    if (selected.id === "assign_bank") {
      const gid = selected.guard_id ?? pickedGuard?.id;
      if (!gid) return null;
      return { option: "assign_bank", guard_id: gid, ...(replaceExisting ? { replace_existing: true } : {}), ...(confirmIdentity ? { confirm_identity: true } : {}) };
    }
    const nz = extraNames.name_zh.trim();
    const ne = extraNames.name_en.trim();
    const nameExtra = extraShown ? { ...(nz ? { name_zh: nz } : {}), ...(ne ? { name_en: ne } : {}) } : {};
    const decisionExtra = decision ? (decision.kind === "link" ? { link_guard_id: decision.guardId } : { create_new: true }) : {};
    const extraObj = { ...nameExtra, ...decisionExtra };
    const extra = Object.keys(extraObj).length > 0 ? { extra: extraObj } : {};
    const sendValue = selected.input === "hkid" ? (hkidInputState(text).canon ?? text) : text; // 全形括號／空格／小寫 → canonical 後送出
    return { option: selected.id, ...(selected.guard_id ? { guard_id: selected.guard_id } : {}), ...(selected.input && selected.input !== "guard_search" ? { value: sendValue } : {}), ...extra };
  }

  async function runPreview(): Promise<{ hash: string; impact: Impact } | null> {
    const answer = buildAnswer();
    if (!q || !answer) return null;
    setBusy(true);
    setError(null);
    const res = await apiPost<{ preview_hash: string; writes: boolean; impact: Impact }>(`/api/triage/questions/${q.id}/preview`, { answer });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      setImpact(null);
      setHash(null);
      return null;
    }
    if (res.data.impact.needs_fields) setExtraShown(true);
    setImpact(res.data.impact);
    setHash(res.data.preview_hash);
    return { hash: res.data.preview_hash, impact: res.data.impact };
  }
  const onPreview = async () => {
    await runPreview();
  };

  // TE-3：補咗中文姓名之後自動重新預覽（debounce），唔使再撳「預覽影響」
  const needsFieldsOpen = extraShown;
  const namesKey = `${extraNames.name_zh.trim()}|${extraNames.name_en.trim()}`;
  const lastAuto = useRef("");
  useEffect(() => {
    if (!needsFieldsOpen) {
      lastAuto.current = "";
      return;
    }
    if (hanCount(extraNames.name_zh) < 2 || lastAuto.current === namesKey) return;
    const t = setTimeout(() => {
      lastAuto.current = namesKey;
      void runPreview();
    }, 600);
    return () => clearTimeout(t);
  }, [namesKey, needsFieldsOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  async function next() {
    if (!q) return;
    const tier = isSupp(q.kind) ? "sup" : "imp";
    onChanged?.();
    // 左欄 badge 由 page 嘅 onChanged（debounce）負責
    setResume(null);
    if (viewing) {
      // 重新答咗一條之前跳過嘅題：只更新回看紀錄，唔影響計數
      const idx = view as number;
      setTrail((t) => t.map((x, i) => (i === idx ? { ...x, kind: lastKind.current, label: lastLabel.current } : x)));
      setView(idx + 1 < trail.length ? idx + 1 : null);
      return;
    }
    setTrail((t) => [...t, { q, kind: lastKind.current, label: lastLabel.current }]);
    (tier === "sup" ? supP : impP).drop(q.id);
    setDone((d) => ({ ...d, [tier]: d[tier] + 1 }));
    setSince((d) => ({ ...d, [tier]: d[tier] + 1 }));
    // 身份確認之後可能即時補開跟進題（長工入職日期／銀行／衝突）：重新載入題目清單，同一個對話框即時見到
    if (q.kind === "ext_identity_check") {
      await reloadImp();
      if (supP.items !== null) await reloadSup();
      setSince({ imp: 0, sup: 0 });
    }
  }

  async function onConfirm() {
    // TE-3：一鍵確認——未預覽就先自動預覽；可以確認即寫入，否則留低原因／要補嘅欄
    let useHash = hash;
    let useImpact = impact;
    if (!useHash || !useImpact) {
      const r = await runPreview();
      if (!r) return;
      useHash = r.hash;
      useImpact = r.impact;
    }
    const answer = buildAnswer();
    if (!q || !answer || !useHash) return;
    if (!useImpact?.can_confirm) {
      setError(useImpact?.reason_text || "呢個答案暫時唔可以寫入");
      return;
    }
    setBusy(true);
    const res = await apiPost(`/api/triage/questions/${q.id}/answer`, { answer, preview_hash: useHash });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 409 ? `${res.message}（請再撳「預覽影響」）` : res.message);
      if (res.status === 409) {
        setImpact(null);
        setHash(null);
      }
      return;
    }
    lastKind.current = "answered";
    lastLabel.current = `${selected?.label ?? ""}${selected?.guard_id ? `（${q.evidence.candidates.find((c) => c.guard_id === selected.guard_id)?.name_zh ?? ""}）` : ""}`;
    await next();
  }

  async function onSkip() {
    if (!q) return;
    setBusy(true);
    const res = await apiPost(`/api/triage/questions/${q.id}/answer`, { answer: { option: "skip" } });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    lastKind.current = "skipped";
    lastLabel.current = "跳過，留返人手";
    await next();
  }

  const needsText = !!selected?.input && selected.input !== "guard_search";
  // TE-6：即時驗證——身份證號 check digit、補姓名（中文 ≥2 個中文字）、其他文字輸入唔可空白
  const hkidSt = selected?.input === "hkid" ? hkidInputState(text) : null;
  const textOk = !needsText || (selected?.input === "hkid" ? hkidSt?.state === "valid" : text.trim().length > 0);
  const nameZhOk = !extraShown || hanCount(extraNames.name_zh) >= 2;
  const fieldsReady =
    (selected?.id !== "apply_fields" || Object.keys(fields).length > 0) &&
    (selected?.id !== "apply_ext_fields" || Object.keys(extChoices).length > 0) &&
    (selected?.id !== "assign_bank" || !!selected.guard_id || !!pickedGuard);
  // 冇修改權限：「改正後確認」選項本身停用（server 一樣會 403）。出生日期／地址要「保安員個人資料」修改權；姓名要「保安員」修改權
  // 只有覆蓋現有非空值先要權限：欄位現有係空（check=fill）或者新建（new）屬補空欄，得
  const replaceDenied = (f: string, check: string): boolean => {
    if (!q || check === "fill" || check === "new") return false;
    return f === "dateOfBirth" || f === "address" ? !q.evidence.pii_update : f === "nameZh" || f === "nameEn" ? !q.evidence.guard_update : false;
  };
  const canPreview = !!selected && selected.id !== "skip" && textOk && nameZhOk && fieldsReady && !busy;
  const suppNow = !!q && isSupp(q.kind);
  // 總數＝已答＋仍然未答（身份題答完補開跟進題後都計到）
  const liveTotals = !queueReady || !cnt ? null : { imp: done.imp + impRemaining, sup: done.sup + supRemaining };
  const progressTotal = liveTotals ? (suppNow ? liveTotals.sup : liveTotals.imp) : 0;
  const progressDone = suppNow ? done.sup : done.imp;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="導入後待答問題" data-testid="triage-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      <div className="relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:max-w-xl sm:rounded-xl">
        <div className="flex items-start gap-2 border-b border-zk-border px-3 py-3">
          <Button variant="secondary" size="sm" type="button" onClick={close} data-testid="triage-later" aria-label="返回列表">
            ‹ 返回列表
          </Button>
          <div className="min-w-0 flex-1">
            <div className="text-zk-md font-semibold">導入完成，有幾條要你決定</div>
            {viewing && (
              <div className="text-zk-sm text-zk-muted" data-testid="triage-progress">
                回看第 {(view ?? 0) + 1} 題{readOnly ? "（已送出，唔可以改）" : "（之前跳過，可以重新答）"}
              </div>
            )}
            {!viewing && q && (
              <div className="text-zk-sm text-zk-muted" data-testid="triage-progress">
                {suppNow ? "補充資料 " : ""}第 {Math.min(progressDone + 1, progressTotal)} 題／共{restarted ? "約" : " "}{progressTotal} 題
                {!suppNow && liveTotals && liveTotals.sup > 0 ? `（另有 ${liveTotals.sup} 題補充資料可以遲啲先做）` : ""}
              </div>
            )}
            {!viewing && !q && liveTotals && liveTotals.imp + liveTotals.sup > 0 && <div className="text-zk-sm text-zk-muted">重要 {liveTotals.imp} 題，補充資料 {liveTotals.sup} 題</div>}
            {resume && !viewing && q && (
              <div className="text-zk-xs text-zk-faint" data-testid="triage-resume">
                由第 {resume.n} 題繼續 ·{" "}
                <button type="button" className="underline" onClick={restartFromBeginning} data-testid="triage-restart">
                  由頭開始
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3 overflow-y-auto px-4 py-3">
          {(error ?? impP.error ?? supP.error) && <Banner kind="error">{error ?? impP.error ?? supP.error}</Banner>}
          {loading && <div className="text-zk-base text-zk-muted" data-testid="triage-loading">載入緊…</div>}
          {gate && (
            <div className="space-y-2 py-6 text-center" data-testid="triage-gate">
              <div className="text-zk-md font-semibold">{liveTotals && liveTotals.imp > 0 ? "重要嘅問題答完喇" : "冇重要嘅問題"}</div>
              <div className="text-zk-base text-zk-muted">仲有 {supRemaining} 題補充資料（逐欄核對英文名、出生日期、電話、地址），唔急，可以遲啲先做。</div>
              <div className="flex justify-center gap-2">
                <Button variant="primary" onClick={() => setSuppStarted(true)} data-testid="triage-continue-supp">
                  繼續做補充資料
                </Button>
                <Button onClick={close}>遲啲先做</Button>
              </div>
            </div>
          )}
          {queueReady && !q && !gate && !viewing && (
            <div className="space-y-2 py-6 text-center">
              <div className="text-zk-md font-semibold">全部處理完</div>
              <div className="text-zk-base text-zk-muted">本批共答咗 {done.imp + done.sup} 條。跳過嘅會留喺「待答問題」，隨時可以再答。</div>
              <Button variant="primary" onClick={close}>
                完成
              </Button>
            </div>
          )}
          {shownQ && (
            <>
              {readOnly && viewing && (
                <div className="rounded-lg border border-zk-success/30 bg-zk-success-bg p-3 text-zk-base" data-testid="triage-readonly">
                  你答咗：<b>{viewing.label}</b> <Pill variant="success">已送出</Pill>
                  {viewing.q.answer?.source === "ocr_reread" && <Pill variant="neutral" data-testid="triage-ocr-reread-badge">OCR 重讀自動答</Pill>}
                  <div className="text-zk-xs text-zk-muted">已經寫入，唔可以喺度改；想改答案留待下一輪導入分診。</div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Pill variant="neutral">{shownQ.kind_label}</Pill>
                {shownQ.answer?.source === "ocr_reread" && <Pill variant="neutral">OCR 重讀自動答</Pill>}
                {shownQ.evidence.reasons.slice(0, 3).map((r) => (
                  <span key={r} className="text-zk-sm text-zk-muted">
                    {reasonLabel(r)}
                  </span>
                ))}
              </div>
              {shownQ.restricted && !readOnly && (
                <div className="rounded-lg border border-zk-warning-border bg-zk-warning-bg p-3 text-zk-base" data-testid="triage-restricted">
                  要有保安員銀行資料權限嘅同事處理。你可以按「返回列表」，由老闆或有權限嘅同事跟進。
                </div>
              )}
              <PersonCard q={shownQ} />
              {(shownQ.kind !== "field_review" || !choice) && <EvidenceSection images={NAME_ON_DEMAND_KINDS.has(shownQ.kind) ? shownQ.evidence_images?.filter((im) => im.field !== "name_zh" && im.field !== "name_en") : shownQ.evidence_images} />}
              {shownQ.evidence.candidates.map((c, i) => (
                <CandidateCard key={c.guard_id} c={c} idx={i} />
              ))}

              {q && (<>
              <fieldset className="space-y-2" disabled={busy}>
                <legend className="mb-1 text-zk-base font-semibold">你點睇？</legend>
                {q.options
                  .filter((o) => o.id !== "skip")
                  .map((o, i) => {
                    const val = `${o.id}:${o.guard_id ?? ""}:${i}`;
                    const cand = o.guard_id ? q.evidence.candidates.find((c) => c.guard_id === o.guard_id) : null;
                    return (
                      <label key={val} className="flex cursor-pointer items-start gap-2 rounded-md border border-zk-border p-2.5 text-zk-base has-[:checked]:border-zk-primary has-[:checked]:bg-zk-primary-tint-soft">
                        <input
                          type="radio"
                          name="triage-option"
                          className="mt-0.5"
                          checked={choice === val}
                          onChange={() => {
                            setChoice(val);
                            setImpact(null);
                            setHash(null);
                          }}
                        />
                        <span className="flex-1">
                          {o.label}
                          {cand ? <b className="ml-1">（{cand.name_zh}）</b> : null}
                          {o.hint ? <span className="block text-zk-xs text-zk-faint">{o.hint}</span> : null}
                          {choice === val && o.input && o.input !== "guard_search" && (
                            <input
                              className="mt-1.5 w-full rounded-[5px] border border-zk-border px-2 py-1.5"
                              placeholder={o.input === "hkid" ? "例：A123456(3)" : "輸入中文姓名"}
                              value={text}
                              aria-label={o.label}
                              onChange={(e) => {
                                setText(e.target.value);
                                setImpact(null);
                                setHash(null);
                              }}
                            />
                          )}
                          {choice === val && o.input === "hkid" && <HkidHint raw={text} />}
                          {choice === val && o.input && o.input !== "guard_search" && o.input !== "hkid" && !text.trim() && (
                            <span className="mt-1 block text-zk-xs text-zk-faint" data-testid="triage-text-hint">
                              請輸入內容
                            </span>
                          )}
                          {choice === val && o.input === "guard_search" && <GuardSearch onPick={(g) => { setPickedGuard(g); setImpact(null); setHash(null); }} />}
                          {choice === val && o.id === "assign_bank" && (
                            <span className="mt-2 block rounded border border-zk-border p-2" data-testid="replace-existing">
                              <label className="flex items-start gap-2 text-zk-sm">
                                <input type="checkbox" className="mt-0.5" checked={replaceExisting} onChange={(e) => { setReplaceExisting(e.target.checked); setImpact(null); setHash(null); }} />
                                <span>如果佢已經有唔同戶口：取代現有戶口{pickedGuard ? `（${pickedGuard.name}）` : ""}（預設唔覆蓋{!q.evidence.bank_view ? "；你冇銀行資料睇權，睇唔到現有戶口，要剔先可以寫" : ""}）</span>
                              </label>
                              {impact?.notes.some((n) => n.startsWith("警告")) && (
                                <label className="mt-1 flex items-start gap-2 text-zk-sm text-zk-warning-dark" data-testid="confirm-identity">
                                  <input type="checkbox" className="mt-0.5" checked={confirmIdentity} onChange={(e) => { setConfirmIdentity(e.target.checked); setImpact(null); setHash(null); }} />
                                  <span>我確認呢個戶口屬於呢位保安員</span>
                                </label>
                              )}
                            </span>
                          )}
                          {choice === val && o.id === "apply_ext_fields" && (
                            <span className="mt-2 block space-y-2">
                              {q.evidence.ext_review.map((rf) => (
                                <span key={rf.key} className="block rounded border border-zk-border p-2" data-testid="ext-review-row">
                                  <span className="block text-zk-sm text-zk-faint">
                                    {rf.label}（{CHECK_LABEL[rf.check] ?? rf.check}
                                    {rf.status === "review" ? "、導入值待核對" : ""}
                                    {rf.held === "identity" ? "、身份未夠證據，所以唔自動寫" : rf.held === "bank" ? "、銀行資料要人確認先寫" : ""}）
                                  </span>
                                  {rf.held === "longterm_hire_date" && (
                                    <span className="mt-1 block rounded border border-zk-warning-border bg-zk-warning-bg px-2 py-1 text-zk-sm text-zk-warning-dark" data-testid="longterm-hire-warning">
                                      呢位係長工，入職日期會影響長工糧（強積金／假期）計算，請核實先確認
                                    </span>
                                  )}
                                  {rf.key === "bank" && (
                                    <label className="mt-1 flex items-start gap-2 text-zk-sm" data-testid="bank-replace-existing">
                                      <input type="checkbox" className="mt-0.5" checked={replaceExisting} onChange={(e) => { setReplaceExisting(e.target.checked); setImpact(null); setHash(null); }} />
                                      <span>如果現有戶口唔同：取代現有戶口（要剔先會覆蓋{!q.evidence.bank_view ? "；你冇銀行資料睇權，一定要剔" : ""}）</span>
                                    </label>
                                  )}
                                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                                    {(["use_import", "keep_current", "skip"] as const).map((c) => (
                                      <button
                                        key={c}
                                        type="button"
                                        className={choiceBtn(extChoices[rf.key] === c)}
                                        onClick={() => { setExtChoices((m) => ({ ...m, [rf.key]: c })); setImpact(null); setHash(null); }}
                                      >
                                        {EXT_CHOICE_LABEL[c]}
                                      </button>
                                    ))}
                                  </span>
                                </span>
                              ))}
                            </span>
                          )}
                          {choice === val && o.id === "apply_fields" && (
                            <span className="mt-2 block space-y-2">
                              {q.evidence.review_fields.map((rf) => {
                                const cur = fields[rf.field];
                                const pp = q.evidence.person!;
                                const extracted =
                                  rf.field === "nameZh" ? pp.name_zh.value : rf.field === "nameEn" ? pp.name_en.value : rf.field === "dateOfBirth" ? pp.date_of_birth.value : rf.field === "phone" ? pp.phone.value : pp.address.value;
                                return (
                                  <span key={rf.field} className="block rounded border border-zk-border p-2">
                                    <span className="block text-zk-sm text-zk-faint">
                                      {rf.label}（{CHECK_LABEL[rf.check] ?? rf.check}）
                                    </span>
                                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                                      {(["confirm", "replace", "skip"] as const).map((a) => (
                                        <button
                                          key={a}
                                          type="button"
                                          disabled={a === "replace" && replaceDenied(rf.field, rf.check)}
                                          className={choiceBtn(cur?.action === a, "disabled:cursor-not-allowed disabled:opacity-40")}
                                          onClick={() => {
                                            setFields((f) => ({ ...f, [rf.field]: { action: a, value: f[rf.field]?.value ?? undefined } }));
                                            setImpact(null);
                                            setHash(null);
                                          }}
                                        >
                                          {a === "confirm" ? "確認" : a === "replace" ? "改正後確認" : "略過"}
                                        </button>
                                      ))}
                                    </span>
                                    <span className="mt-1 block">
                                      <EvidenceImages imgs={(q.evidence_images ?? []).filter((im) => im.field === REVIEW_TO_EVIDENCE_FIELD[rf.field])} fieldLabel={rf.label} />
                                    </span>
                                    {replaceDenied(rf.field, rf.check) && <span className="mt-1 block text-zk-xs text-zk-warning">「改正後確認」要有修改權限嘅同事（例如老闆）先可以做。</span>}
                                    {cur && cur.action !== "skip" && (
                                      <input
                                        className="mt-1.5 w-full rounded-[5px] border border-zk-border px-2 py-1.5"
                                        defaultValue={q.evidence.pii_visible || rf.field === "nameZh" || rf.field === "nameEn" ? (extracted ?? "") : ""}
                                        placeholder={rf.field === "dateOfBirth" ? "YYYY-MM-DD（留空＝用導入包嘅值）" : "改正值（留空＝用導入包嘅值）"}
                                        aria-label={`${rf.label}值`}
                                        onChange={(e) => {
                                          const v = e.target.value;
                                          setFields((f) => ({ ...f, [rf.field]: { action: f[rf.field]!.action, value: v || undefined } }));
                                          setImpact(null);
                                          setHash(null);
                                        }}
                                      />
                                    )}
                                  </span>
                                );
                              })}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                {q.options.filter((o) => o.id !== "skip").length === 0 && <div className="text-zk-sm text-zk-muted">呢條同現有資料矛盾，系統唔會自動處理——可以跳過留返人手。</div>}
              </fieldset>

              {(impact?.needs_fields || extraShown) && (
                <div className="space-y-2 rounded-lg border border-zk-warning/50 bg-zk-header/40 p-3" data-testid="triage-needs-fields">
                  <div className="text-zk-sm font-semibold text-zk-warning">要補返以下資料先寫得入（對住原文件裁圖打）</div>
                  {(impact?.needs_fields ?? NAME_FIELDS).map((nf) => (
                    <div key={nf.field} className="space-y-1">
                      <EvidenceImages imgs={(q.evidence_images ?? []).filter((im) => im.field === nf.field)} fieldLabel={nf.label} />
                      <label className="block text-zk-sm">
                        {nf.label}
                        {nf.required ? "（必填）" : "（選填）"}
                        <input
                          className="mt-1 w-full rounded-[5px] border border-zk-border px-2 py-1.5"
                          value={extraNames[nf.field]}
                          maxLength={100}
                          aria-label={nf.label}
                          data-testid={`triage-extra-${nf.field}`}
                          onChange={(e) => {
                            setExtraNames((m) => ({ ...m, [nf.field]: e.target.value }));
                            setHash(null); // TE-3 S2：答案變咗，舊 hash 作廢；確認前會自動重新預覽
                          }}
                        />
                        {nf.field === "name_zh" && hanCount(extraNames.name_zh) < 2 && (
                          <span className="mt-0.5 block text-zk-xs text-zk-danger-dark" data-testid="triage-extra-name_zh-hint">
                            中文姓名要最少 2 個中文字
                          </span>
                        )}
                      </label>
                    </div>
                  ))}
                </div>
              )}
              {impact?.needs_decision && (
                <div className="space-y-2 rounded-lg border border-zk-warning/50 bg-zk-header/40 p-3" data-testid="triage-needs-decision">
                  <div className="text-zk-sm font-semibold text-zk-warning">系統已有同名保安員，請確認係咪同一人</div>
                  {impact.needs_decision.candidates.map((c) => (
                    <div key={c.guard_id} className="space-y-1 rounded border border-zk-border bg-white p-2 text-zk-sm" data-testid="triage-decision-candidate">
                      <div className="font-semibold">
                        {c.name_zh}
                        {c.name_en ? `（${c.name_en}）` : ""}
                        {!c.active && <span className="ml-1 text-zk-xs text-zk-muted">（非在職）</span>}
                        {c.same_hkid && (
                          <span className="ml-1 rounded bg-zk-warning-tint px-1.5 py-px text-zk-xs font-semibold text-zk-warning" data-testid="triage-decision-same-hkid">
                            身份證號相同
                          </span>
                        )}
                      </div>
                      <div className="text-zk-muted">
                        {c.has_hkid ? "已有身份證號" : "冇身份證號"}・{c.has_dob ? "已有出生日期" : "冇出生日期"}・工號：{c.staff_numbers.length ? c.staff_numbers.join("、") : "冇"}
                        {c.phone_masked ? `・電話 ${c.phone_masked}` : ""}・建立 {c.created_at}・最近出更：{c.last_shift_month ?? "冇出過更"}
                      </div>
                      {impact.needs_decision!.options.includes("link") && (
                        <Button size="sm" type="button" disabled={busy} onClick={() => setDecision({ kind: "link", guardId: c.guard_id })} data-testid="triage-decision-link">
                          係同一人，連結並補資料
                        </Button>
                      )}
                    </div>
                  ))}
                  {impact.needs_decision.truncated && <div className="text-zk-xs text-zk-warning" data-testid="triage-decision-truncated">仲有同名者，請用搜尋確認</div>}
                  {!impact.needs_decision.options.includes("link") && <div className="text-zk-xs text-zk-muted">你冇權限連結現有保安員，只可以{impact.needs_decision.options.includes("create_new") ? "建新人或者" : ""}跳過。</div>}
                  {impact.needs_decision.options.includes("create_new") ? (
                    <Button size="sm" type="button" disabled={busy} onClick={() => setDecision({ kind: "create_new" })} data-testid="triage-decision-create">
                      唔係，建新人
                    </Button>
                  ) : (
                    <div className="text-zk-xs text-zk-muted" data-testid="triage-decision-no-create">同一個身份證號唔可以建兩個人：確認係同一人就連結；唔係就核對身份證號，或者跳過留返人手。</div>
                  )}
                </div>
              )}
              {decision && !impact?.needs_decision && (
                <div className="text-zk-sm text-zk-muted" data-testid="triage-decision-chosen">
                  已揀：{decision.kind === "link" ? "係同一人，連結並補資料" : "唔係，建新人"}（再撳「確認寫入」；想改可以重新揀答案）
                </div>
              )}
              {impact && <ImpactCard impact={impact} />}
              </>)}
            </>
          )}
          {(trail.length > 0 || viewing) && (
            <div className="flex items-center justify-between gap-2 border-t border-zk-border-soft pt-2" data-testid="triage-nav">
              <Button variant="secondary" size="sm" type="button" disabled={view === 0 || trail.length === 0 || busy} onClick={() => setView((v) => (v === null ? trail.length - 1 : Math.max(0, v - 1)))} data-testid="triage-prev">
                ‹ 上一題
              </Button>
              {viewing && (
                <Button variant="secondary" size="sm" type="button" disabled={busy} onClick={() => setView((v) => (v !== null && v + 1 < trail.length ? v + 1 : null))} data-testid="triage-next">
                  下一題 ›
                </Button>
              )}
            </div>
          )}
        </div>

        {q && !q.restricted && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zk-border px-4 py-3">
            <Button disabled={busy} onClick={onSkip} data-testid="triage-skip">
              跳過，留返人手
            </Button>
            <div className="flex items-center gap-2">
              <Button disabled={!canPreview} onClick={onPreview} data-testid="triage-preview">
                預覽影響
              </Button>
              <Button variant="primary" disabled={!canPreview || (!!impact && !impact.can_confirm && !impact.needs_fields && !impact.needs_decision)} onClick={onConfirm} data-testid="triage-confirm">
                {busy ? "處理緊…" : "確認寫入"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
