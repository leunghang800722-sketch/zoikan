"use client";
// WP-AI-OPS §28.4：導入後對話式分診 dialog。
// 一條一條問：證據卡 → 揀選項（系統列舉，唔收自由指令）→「預覽影響」→「確認寫入」；
// 可以「跳過，留返人手」或「遲啲先答」（關閉，之後喺「待答問題」續答）。
// 寫入全部由 server 經現有導入路徑做，呢度只負責問同顯示；回應 DTO 係 snake_case。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { apiGet, apiPost } from "@/lib/ui/api-client";

interface Field {
  value: string | null;
  status: string;
}
interface Option {
  id: string;
  label: string;
  hint?: string;
  input?: "text" | "hkid";
  guard_id?: string;
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
}
interface Question {
  id: string;
  kind: string;
  kind_label: string;
  status: string;
  options: Option[];
  evidence: {
    pii_visible: boolean;
    pii_update: boolean;
    guard_update: boolean;
    person: { hkid: Field; name_zh: Field; name_en: Field; date_of_birth: Field; phone: Field; address: Field; staff_numbers: string[] };
    reasons: string[];
    candidates: Candidate[];
    review_fields: { field: string; label: string; check: string }[];
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

const SUPP_KIND = "field_review";

export const REASON_LABEL: Record<string, string> = {
  name_not_confirmed: "姓名未能確認（身份證副本讀數唔一致或者未核對）",
  create_no_name: "導入包冇姓名",
  hkid_not_confirmed_no_other_key: "身份證號未確認，又冇工號／電話可以對上現有安員",
  create_hkid_not_confirmed: "身份證號未確認",
  guard_has_other_hkid_unconfirmed: "同名現有安員已有另一個身份證號，而導入包嘅身份證號未確認",
  extract_fail: "證件讀取失敗／冇可用嘅身份證號",
  tel_only_candidate: "淨係電話對到現有安員，其他資料對唔上",
  name_only_candidate: "淨係姓名對到現有安員，冇硬證據",
  name_multi_candidate: "有幾個同名嘅現有安員",
  same_name_different_dob: "同名現有安員，但出生日期唔同",
  staffno_shared_by_persons: "同一個工號出現喺導入包內多個人",
  dup_tel_across_persons: "同一個電話出現喺導入包內多個人",
  group_name_differs: "同一個身份證喺唔同檔案嘅姓名唔一致",
  duplicate_hkid_in_package: "導入包內有重複身份證",
  duplicate_key_in_package: "導入包內有重複記錄",
  hkid_multi_guard: "多個現有安員用同一個身份證號",
  staffno_multi_guard: "工號對到多個現有安員",
  hkid_vs_staffno_differ: "身份證同工號指向唔同嘅現有安員",
  guard_hkid_differs: "現有安員已有另一個身份證號",
  tel_belongs_to_other_guard: "電話屬於另一個現有安員",
  tel_guard_has_other_hkid: "電話對到嘅現有安員有另一個身份證號",
  tel_multi_guard: "電話對到多個現有安員",
  name_differs_from_guard: "姓名同現有安員紀錄唔同",
  same_name_different_hkid: "同名但現有安員嘅身份證號唔同",
  forced_guard_missing: "揀咗嘅安員已經唔存在",
  hkid_belongs_to_other_guard: "呢個身份證號已屬於另一個安員",
  apply_failed: "套用失敗，請稍後再試",
  staffno_belongs_to_other: "有工號屬於另一個安員",
  staffno_scheme_has_other_current: "有工號同現有工號類別重複",
  staffno_invalid: "有工號格式唔合法",
};

/** reason code → 中文標籤；未知 code 一律顯示「其他原因」，唔露英文碼。 */
export function reasonLabel(code: string): string {
  return REASON_LABEL[code] ?? "其他原因";
}

const STATUS_LABEL: Record<string, string> = { confirmed: "已確認", review: "待核對", missing: "冇資料" };
const CHECK_LABEL: Record<string, string> = { hidden: "你冇權限睇現有資料",  fill: "現有資料冇，會補", differs: "同現有資料唔同", invalid_date: "日期唔合法", new: "新" };

function FieldRow({ label, f }: { label: string; f: Field }) {
  if (f.status === "missing" && !f.value) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
      <span className="w-[72px] shrink-0 text-zk-faint">{label}</span>
      <span className="break-all">{f.value ?? "（冇權限睇／無）"}</span>
      <Pill variant={f.status === "confirmed" ? "success" : "warning"}>{STATUS_LABEL[f.status] ?? f.status}</Pill>
    </div>
  );
}

function PersonCard({ q }: { q: Question }) {
  const p = q.evidence.person;
  return (
    <div className="space-y-1 rounded-lg border border-zk-border bg-zk-header/40 p-3" data-testid="triage-person">
      <div className="text-[12px] font-semibold text-zk-muted">導入包內嘅資料</div>
      <FieldRow label="中文姓名" f={p.name_zh} />
      <FieldRow label="英文姓名" f={p.name_en} />
      <FieldRow label="身份證" f={p.hkid} />
      <FieldRow label="出生日期" f={p.date_of_birth} />
      <FieldRow label="電話" f={p.phone} />
      <FieldRow label="地址" f={p.address} />
      {p.staff_numbers.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
          <span className="w-[72px] shrink-0 text-zk-faint">工號</span>
          <span>{p.staff_numbers.join("、")}</span>
        </div>
      )}
      {!q.evidence.pii_visible && <div className="text-[11.5px] text-zk-faint">你冇「安員個人資料」權限，身份證／電話／地址已遮罩，出生日期唔顯示。</div>}
    </div>
  );
}

function CandidateCard({ c, idx }: { c: Candidate; idx: number }) {
  return (
    <div className="space-y-0.5 rounded-lg border border-zk-border p-3 text-[13px]" data-testid="triage-candidate">
      <div className="text-[12px] font-semibold text-zk-muted">現有安員（候選 {idx + 1}）</div>
      <div>
        {c.name_hidden ? <span className="text-zk-faint">姓名同導入包唔同（要有安員個人資料權限先睇到）</span> : c.name_zh}
        {c.name_en ? <span className="ml-1 text-zk-faint">{c.name_en}</span> : null}
      </div>
      <div className="text-zk-muted">
        身份證 {c.hkid ?? "未有"} · 出生日期 {c.date_of_birth ?? "—"}
      </div>
      {c.tels.length > 0 && <div className="text-zk-muted">電話 {c.tels.join("、")}</div>}
      {c.staff_numbers.length > 0 && <div className="text-zk-muted">工號 {c.staff_numbers.join("、")}</div>}
      <div className="text-zk-muted">最近返更盤：{c.recent_sites.length ? c.recent_sites.map((s) => `${s.name}（${s.last_date}）`).join("、") : "未有紀錄"}</div>
    </div>
  );
}

function ImpactCard({ impact }: { impact: Impact }) {
  return (
    <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-[13px]" data-testid="triage-impact">
      <div className="font-semibold text-blue-900">影響預覽（未寫入）</div>
      <ul className="list-disc pl-5">
        {impact.summary.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      {impact.changes.map((c, i) => (
        <div key={i} className="rounded border border-blue-100 bg-white p-2">
          <div className="text-[12px] font-semibold">{c.label}</div>
          {c.fields.map((f) => (
            <div key={f.label} className="text-[12.5px]">
              {f.label}：{f.from !== null ? `${f.from} → ` : ""}
              <b>{f.to}</b>
            </div>
          ))}
        </div>
      ))}
      {impact.field_outcomes.length > 0 && (
        <div className="text-[12px] text-zk-muted">{impact.field_outcomes.map((o) => `${o.label}：${o.outcome}`).join(" · ")}</div>
      )}
      {impact.notes.map((n) => (
        <div key={n} className="text-[12px] text-orange-700">
          {n}
        </div>
      ))}
    </div>
  );
}

type FieldAns = { action: "confirm" | "replace" | "skip"; value?: string };

export function TriageDialog({ sessionId, onClose, onChanged }: { sessionId: string; onClose: () => void; onChanged?: () => void }) {
  const [queue, setQueue] = useState<Question[] | null>(null);
  const router = useRouter();
  const [totals, setTotals] = useState<{ imp: number; sup: number } | null>(null);
  const [done, setDone] = useState({ imp: 0, sup: 0 });
  const [suppStarted, setSuppStarted] = useState(false);
  const [choice, setChoice] = useState<string>("");
  const [text, setText] = useState("");
  const [fields, setFields] = useState<Record<string, FieldAns>>({});
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
    setTotals((t) => t ?? { imp: res.data.questions.filter((x) => x.kind !== SUPP_KIND).length, sup: res.data.questions.filter((x) => x.kind === SUPP_KIND).length });
  }, [sessionId]);
  useEffect(() => {
    void load();
  }, [load]);

  // 重要（要人手／衝突）先問，補充資料（field_review）後問；答完重要嗰批先問要唔要繼續
  const imp = useMemo(() => (queue ?? []).filter((x) => x.kind !== SUPP_KIND), [queue]);
  const sup = useMemo(() => (queue ?? []).filter((x) => x.kind === SUPP_KIND), [queue]);
  const q = imp[0] ?? (suppStarted ? (sup[0] ?? null) : null);
  const gate = queue !== null && !q && sup.length > 0 && !suppStarted;
  const reset = () => {
    setChoice("");
    setText("");
    setFields({});
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
    return { option: selected.id, ...(selected.guard_id ? { guard_id: selected.guard_id } : {}), ...(selected.input ? { value: text } : {}) };
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
    const tier = q.kind === SUPP_KIND ? "sup" : "imp";
    onChanged?.();
    router.refresh(); // 左欄 badge 即時更新
    setQueue((cur) => (cur ? cur.filter((x) => x.id !== q.id) : cur));
    setDone((d) => ({ ...d, [tier]: d[tier] + 1 }));
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

  const needsText = !!selected?.input;
  const fieldsReady = selected?.id !== "apply_fields" || Object.keys(fields).length > 0;
  // 冇修改權限：「改正後確認」選項本身停用（server 一樣會 403）。出生日期／地址要「安員個人資料」修改權；姓名要「安員」修改權
  // 只有覆蓋現有非空值先要權限：欄位現有係空（check=fill）或者新建（new）屬補空欄，得
  const replaceDenied = (f: string, check: string): boolean => {
    if (!q || check === "fill" || check === "new") return false;
    return f === "dateOfBirth" || f === "address" ? !q.evidence.pii_update : f === "nameZh" || f === "nameEn" ? !q.evidence.guard_update : false;
  };
  const canPreview = !!selected && selected.id !== "skip" && (!needsText || text.trim().length > 0) && fieldsReady && !busy;
  const isSupp = q?.kind === SUPP_KIND;
  const progressTotal = totals ? (isSupp ? totals.sup : totals.imp) : 0;
  const progressDone = isSupp ? done.sup : done.imp;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="導入後待答問題" data-testid="triage-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:max-w-xl sm:rounded-xl">
        <div className="flex items-center justify-between gap-2 border-b border-zk-border px-4 py-3">
          <div>
            <div className="text-[15px] font-semibold">導入完成，有幾條要你決定</div>
            {q && (
              <div className="text-[12px] text-zk-muted" data-testid="triage-progress">
                {isSupp ? "補充資料 " : ""}第 {Math.min(progressDone + 1, progressTotal)} 題／共 {progressTotal} 題
                {!isSupp && totals && totals.sup > 0 ? `（另有 ${totals.sup} 題補充資料可以遲啲先做）` : ""}
              </div>
            )}
            {!q && totals && totals.imp + totals.sup > 0 && <div className="text-[12px] text-zk-muted">重要 {totals.imp} 題，補充資料 {totals.sup} 題</div>}
          </div>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-[13px] text-zk-muted hover:bg-zk-header" data-testid="triage-later">
            遲啲先答
          </button>
        </div>

        <div className="space-y-3 overflow-y-auto px-4 py-3">
          {error && <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
          {queue === null && <div className="text-[13px] text-zk-muted">載入緊…</div>}
          {gate && (
            <div className="space-y-2 py-6 text-center" data-testid="triage-gate">
              <div className="text-[15px] font-semibold">{totals && totals.imp > 0 ? "重要嘅問題答完喇" : "冇重要嘅問題"}</div>
              <div className="text-[13px] text-zk-muted">仲有 {sup.length} 題補充資料（逐欄核對英文名、出生日期、電話、地址），唔急，可以遲啲先做。</div>
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
              <div className="text-[15px] font-semibold">全部處理完</div>
              <div className="text-[13px] text-zk-muted">本批共答咗 {done.imp + done.sup} 條。跳過嘅會留喺「待答問題」，隨時可以再答。</div>
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
                  <span key={r} className="text-[12px] text-zk-muted">
                    {reasonLabel(r)}
                  </span>
                ))}
              </div>
              <PersonCard q={q} />
              {q.evidence.candidates.map((c, i) => (
                <CandidateCard key={c.guard_id} c={c} idx={i} />
              ))}

              <fieldset className="space-y-2" disabled={busy}>
                <legend className="mb-1 text-[13px] font-semibold">你點睇？</legend>
                {q.options
                  .filter((o) => o.id !== "skip")
                  .map((o, i) => {
                    const val = `${o.id}:${o.guard_id ?? ""}:${i}`;
                    const cand = o.guard_id ? q.evidence.candidates.find((c) => c.guard_id === o.guard_id) : null;
                    return (
                      <label key={val} className="flex cursor-pointer items-start gap-2 rounded-md border border-zk-border p-2.5 text-[13px] has-[:checked]:border-zk-primary has-[:checked]:bg-blue-50">
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
                          {o.hint ? <span className="block text-[11.5px] text-zk-faint">{o.hint}</span> : null}
                          {choice === val && o.input && (
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
                          {choice === val && o.id === "apply_fields" && (
                            <span className="mt-2 block space-y-2">
                              {q.evidence.review_fields.map((rf) => {
                                const cur = fields[rf.field];
                                const extracted =
                                  rf.field === "nameZh" ? q.evidence.person.name_zh.value : rf.field === "nameEn" ? q.evidence.person.name_en.value : rf.field === "dateOfBirth" ? q.evidence.person.date_of_birth.value : rf.field === "phone" ? q.evidence.person.phone.value : q.evidence.person.address.value;
                                return (
                                  <span key={rf.field} className="block rounded border border-zk-border p-2">
                                    <span className="block text-[12px] text-zk-faint">
                                      {rf.label}（{CHECK_LABEL[rf.check] ?? rf.check}）
                                    </span>
                                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                                      {(["confirm", "replace", "skip"] as const).map((a) => (
                                        <button
                                          key={a}
                                          type="button"
                                          disabled={a === "replace" && replaceDenied(rf.field, rf.check)}
                                          className={`rounded border px-2 py-1 text-[12px] ${cur?.action === a ? "border-zk-primary bg-blue-100 font-semibold" : "border-zk-border"} disabled:cursor-not-allowed disabled:opacity-40`}
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
                                    {replaceDenied(rf.field, rf.check) && <span className="mt-1 block text-[11.5px] text-orange-700">「改正後確認」要有修改權限嘅同事（例如老闆）先可以做。</span>}
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
                {q.options.filter((o) => o.id !== "skip").length === 0 && <div className="text-[12.5px] text-zk-muted">呢條同現有資料矛盾，系統唔會自動處理——可以跳過留返人手。</div>}
              </fieldset>

              {impact && <ImpactCard impact={impact} />}
            </>
          )}
        </div>

        {q && (
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
