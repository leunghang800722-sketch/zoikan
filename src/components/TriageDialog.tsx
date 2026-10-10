"use client";
// WP-AI-OPS §28.4：導入後對話式分診 dialog。
// 一條一條問：證據卡 → 揀選項（系統列舉，唔收自由指令）→「預覽影響」→「確認寫入」；
// 可以「跳過，留返人手」或「遲啲先答」（關閉，之後喺「待答問題」續答）。
// 寫入全部由 server 經現有導入路徑做，呢度只負責問同顯示；回應 DTO 係 snake_case。
import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { apiGet, apiPost, apiRequest, type ApiListResult } from "@/lib/ui/api-client";
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
  options: Option[];
  evidence: {
    pii_visible: boolean;
    pii_update: boolean;
    guard_update: boolean;
    bank_view: boolean;
    bank_update: boolean;
    person: { hkid: Field; name_zh: Field; name_en: Field; date_of_birth: Field; phone: Field; address: Field; staff_numbers: string[]; ext: ExtView | null } | null;
    reasons: string[];
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
}
interface SessionRes {
  session: { id: string; status: string; counts: { open: number; answered: number; skipped: number; total: number } };
  questions: Question[];
}

const SUPP_KINDS = ["field_review", "ext_field_conflict", "ext_field_review"];
const isSupp = (k: string) => SUPP_KINDS.includes(k);

const REASON_LABEL: Record<string, string> = {
  name_not_confirmed: "姓名未能確認（身份證副本讀數唔一致或者未核對）",
  create_no_name: "導入包冇姓名",
  hkid_not_confirmed_no_other_key: "身份證號未確認，又冇工號／電話可以對上現有保安員",
  create_hkid_not_confirmed: "身份證號未確認",
  guard_has_other_hkid_unconfirmed: "同名現有保安員已有另一個身份證號，而導入包嘅身份證號未確認",
  extract_fail: "證件讀取失敗／冇可用嘅身份證號",
  tel_only_candidate: "淨係電話對到現有保安員，其他資料對唔上",
  name_only_candidate: "淨係姓名對到現有保安員，冇硬證據",
  name_multi_candidate: "有幾個同名嘅現有保安員",
  same_name_different_dob: "同名現有保安員，但出生日期唔同",
  staffno_shared_by_persons: "同一個工號出現喺導入包內多個人",
  dup_tel_across_persons: "同一個電話出現喺導入包內多個人",
  group_name_differs: "同一個身份證喺唔同檔案嘅姓名唔一致",
  duplicate_hkid_in_package: "導入包內有重複身份證",
  duplicate_key_in_package: "導入包內有重複記錄",
  hkid_multi_guard: "多個現有保安員用同一個身份證號",
  staffno_multi_guard: "工號對到多個現有保安員",
  hkid_vs_staffno_differ: "身份證同工號指向唔同嘅現有保安員",
  guard_hkid_differs: "現有保安員已有另一個身份證號",
  tel_belongs_to_other_guard: "電話屬於另一個現有保安員",
  tel_guard_has_other_hkid: "電話對到嘅現有保安員有另一個身份證號",
  tel_multi_guard: "電話對到多個現有保安員",
  name_differs_from_guard: "姓名同現有保安員紀錄唔同",
  same_name_different_hkid: "同名但現有保安員嘅身份證號唔同",
  forced_guard_missing: "揀咗嘅保安員已經唔存在",
  hkid_belongs_to_other_guard: "呢個身份證號已屬於另一個保安員",
  apply_failed: "套用失敗，請稍後再試",
  overwrite_forbidden: "要有保安員個人資料／保安員修改權限嘅同事處理",
  staffno_belongs_to_other: "有工號屬於另一個保安員",
  staffno_scheme_has_other_current: "有工號同現有工號類別重複",
  staffno_invalid: "有工號格式唔合法",
  bank_copy_disagrees: "銀行卡／存摺副本同 Payroll Editor 戶口唔一致",
  bank_copy_agrees: "銀行卡／存摺副本同 Payroll Editor 戶口一致",
  bank_copy_only: "淨係有銀行卡／存摺副本，Payroll Editor 冇呢個戶口",
  bank_identity_name_only: "戶口淨靠英文姓名對返呢個人",
  bank_identity_name_ambiguous: "戶口嘅英文姓名對到多個人",
  bank_identity_unknown: "Payroll Editor 戶口對唔到人",
  maxwell_acct_differs: "Maxwell 名單戶口同 Payroll Editor 唔同",
  maxwell_payee_differs: "Maxwell 名單收款人同 Payroll Editor 唔同",
  typed_list_only_person: "淨係喺打字名單出現",
  ext_identity_check: "工號／身份同另一位唔一致",
  longterm_hire_via_triage: "長工入職日期會影響長工糧計算，要喺分診題逐條確認，唔可以批量決定",
  bank_incomplete: "包內銀行資料四欄唔齊（編號／戶口／收款人／名稱），只可以跳過，唔准砌半套戶口",
  bank_acct_belongs_to_other: "呢個戶口已屬於另一位保安員",
  bank_acct_shared_by_persons: "同一個戶口出現喺導入包內多個人",
};

/** reason code → 中文標籤；未知 code 一律顯示「其他原因」，唔露英文碼。 */
export function reasonLabel(code: string): string {
  return REASON_LABEL[code] ?? "其他原因";
}

const STATUS_LABEL: Record<string, string> = { confirmed: "已確認", review: "待核對", missing: "冇資料" };
const CHECK_LABEL: Record<string, string> = { hidden: "你冇權限睇現有資料",  fill: "現有資料冇，會補", differs: "同現有資料唔同", invalid_date: "日期唔合法", new: "新", held: "待你決定", add: "會加多一位", same: "同現有資料一樣", not_stored: "系統未儲存" };

function FieldRow({ label, f }: { label: string; f: Field }) {
  if (f.status === "missing" && !f.value) return null;
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
  const [queue, setQueue] = useState<Question[] | null>(null);
  const router = useRouter();
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiGet<SessionRes>(`/api/triage/sessions/${sessionId}?status=open`);
    if (!res.ok) {
      setError(res.message);
      setQueue([]);
      return;
    }
    setQueue(res.data.questions);
  }, [sessionId]);
  useEffect(() => {
    void load();
  }, [load]);

  // 重要（要人手／衝突）先問，補充資料（field_review）後問；答完重要嗰批先問要唔要繼續
  const imp = useMemo(() => (queue ?? []).filter((x) => !isSupp(x.kind)), [queue]);
  const sup = useMemo(() => (queue ?? []).filter((x) => isSupp(x.kind)), [queue]);
  const q = imp[0] ?? (suppStarted ? (sup[0] ?? null) : null);
  const gate = queue !== null && !q && sup.length > 0 && !suppStarted;
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
    setError(null);
  };
  useEffect(() => {
    reset();
  }, [q?.id]);

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
    return { option: selected.id, ...(selected.guard_id ? { guard_id: selected.guard_id } : {}), ...(selected.input && selected.input !== "guard_search" ? { value: text } : {}) };
  }

  async function onPreview() {
    const answer = buildAnswer();
    if (!q || !answer) return;
    setBusy(true);
    setError(null);
    const res = await apiPost<{ preview_hash: string; writes: boolean; impact: Impact }>(`/api/triage/questions/${q.id}/preview`, { answer });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      setImpact(null);
      setHash(null);
      return;
    }
    setImpact(res.data.impact);
    setHash(res.data.preview_hash);
  }

  async function next() {
    if (!q) return;
    const tier = isSupp(q.kind) ? "sup" : "imp";
    onChanged?.();
    router.refresh(); // 左欄 badge 即時更新
    setQueue((cur) => (cur ? cur.filter((x) => x.id !== q.id) : cur));
    setDone((d) => ({ ...d, [tier]: d[tier] + 1 }));
    // 身份確認之後可能即時補開跟進題（長工入職日期／銀行／衝突）：重新載入題目清單，同一個對話框即時見到
    if (q.kind === "ext_identity_check") await load();
  }

  async function onConfirm() {
    const answer = buildAnswer();
    if (!q || !answer || !hash) return;
    setBusy(true);
    const res = await apiPost(`/api/triage/questions/${q.id}/answer`, { answer, preview_hash: hash });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 409 ? `${res.message}（請再撳「預覽影響」）` : res.message);
      if (res.status === 409) {
        setImpact(null);
        setHash(null);
      }
      return;
    }
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
    await next();
  }

  const needsText = !!selected?.input && selected.input !== "guard_search";
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
  const canPreview = !!selected && selected.id !== "skip" && (!needsText || text.trim().length > 0) && fieldsReady && !busy;
  const suppNow = !!q && isSupp(q.kind);
  // 總數＝已答＋仍然未答（身份題答完補開跟進題後都計到）
  const liveTotals = queue === null ? null : { imp: done.imp + imp.length, sup: done.sup + sup.length };
  const progressTotal = liveTotals ? (suppNow ? liveTotals.sup : liveTotals.imp) : 0;
  const progressDone = suppNow ? done.sup : done.imp;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="導入後待答問題" data-testid="triage-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:max-w-xl sm:rounded-xl">
        <div className="flex items-center justify-between gap-2 border-b border-zk-border px-4 py-3">
          <div>
            <div className="text-zk-md font-semibold">導入完成，有幾條要你決定</div>
            {q && (
              <div className="text-zk-sm text-zk-muted" data-testid="triage-progress">
                {suppNow ? "補充資料 " : ""}第 {Math.min(progressDone + 1, progressTotal)} 題／共 {progressTotal} 題
                {!suppNow && liveTotals && liveTotals.sup > 0 ? `（另有 ${liveTotals.sup} 題補充資料可以遲啲先做）` : ""}
              </div>
            )}
            {!q && liveTotals && liveTotals.imp + liveTotals.sup > 0 && <div className="text-zk-sm text-zk-muted">重要 {liveTotals.imp} 題，補充資料 {liveTotals.sup} 題</div>}
          </div>
          <Button variant="ghost" size="sm" type="button" onClick={onClose} data-testid="triage-later">
            遲啲先答
          </Button>
        </div>

        <div className="space-y-3 overflow-y-auto px-4 py-3">
          {error && <Banner kind="error">{error}</Banner>}
          {queue === null && <div className="text-zk-base text-zk-muted">載入緊…</div>}
          {gate && (
            <div className="space-y-2 py-6 text-center" data-testid="triage-gate">
              <div className="text-zk-md font-semibold">{liveTotals && liveTotals.imp > 0 ? "重要嘅問題答完喇" : "冇重要嘅問題"}</div>
              <div className="text-zk-base text-zk-muted">仲有 {sup.length} 題補充資料（逐欄核對英文名、出生日期、電話、地址），唔急，可以遲啲先做。</div>
              <div className="flex justify-center gap-2">
                <Button variant="primary" onClick={() => setSuppStarted(true)} data-testid="triage-continue-supp">
                  繼續做補充資料
                </Button>
                <Button onClick={onClose}>遲啲先做</Button>
              </div>
            </div>
          )}
          {queue !== null && !q && !gate && (
            <div className="space-y-2 py-6 text-center">
              <div className="text-zk-md font-semibold">全部處理完</div>
              <div className="text-zk-base text-zk-muted">本批共答咗 {done.imp + done.sup} 條。跳過嘅會留喺「待答問題」，隨時可以再答。</div>
              <Button variant="primary" onClick={onClose}>
                完成
              </Button>
            </div>
          )}
          {q && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Pill variant="neutral">{q.kind_label}</Pill>
                {q.evidence.reasons.slice(0, 3).map((r) => (
                  <span key={r} className="text-zk-sm text-zk-muted">
                    {reasonLabel(r)}
                  </span>
                ))}
              </div>
              {q.restricted && (
                <div className="rounded-lg border border-zk-warning-border bg-zk-warning-bg p-3 text-zk-base" data-testid="triage-restricted">
                  要有保安員銀行資料權限嘅同事處理。你可以按「遲啲先答」，由老闆或有權限嘅同事跟進。
                </div>
              )}
              <PersonCard q={q} />
              {q.evidence.candidates.map((c, i) => (
                <CandidateCard key={c.guard_id} c={c} idx={i} />
              ))}

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

              {impact && <ImpactCard impact={impact} />}
            </>
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
              <Button variant="primary" disabled={busy || !hash || !impact?.can_confirm} onClick={onConfirm} data-testid="triage-confirm">
                {busy ? "處理緊…" : "確認寫入"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
