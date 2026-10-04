"use client";
// WP-STAFF-IMPORT B3：安員證件資料批量導入（老闆／會計／主管；WP-AI-OPS §28.4 開放）。
//   ① 揀本機產生嘅導入包（import-package.json，淨文字）→ ② 預覽統計（逐欄 confirmed／review／missing
//   ＋逐人 link／create／conflict／needs_review）→ ③「套用自動項」（淨寫 confirmed 欄）→ ④ 覆核清單：
//   review 欄逐欄「確認／改正後確認／略過」。
// 導入包只留喺瀏覽器記憶體，每次請求重新帶上去；伺服器唔存檔。回應內 hkid／電話／地址已遮罩，
// 要核對嘅抽取值（姓名／地址）來自你自己揀嗰個本機檔。
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/DataTable";
import { apiPost } from "@/lib/ui/api-client";
import { TriageDialog } from "@/components/TriageDialog";

type Status = "confirmed" | "review" | "missing";
interface PkgField {
  value: string | null;
  status: Status;
}
interface PkgPerson {
  key: string;
  hkid: PkgField;
  nameZh: PkgField;
  nameEn: PkgField;
  dateOfBirth: PkgField;
  sex: PkgField;
  phone: PkgField;
  address: PkgField & { source?: string };
  [k: string]: unknown;
}
interface Pkg {
  version: number;
  generatedAt: string;
  persons: PkgPerson[];
}

const FIELD_LABEL: Record<string, string> = {
  hkid: "身份證",
  name_zh: "中文姓名",
  name_en: "英文姓名",
  date_of_birth: "出生日期",
  sex: "性別",
  phone: "電話",
  address: "地址",
};
const PKG_KEY: Record<string, keyof PkgPerson> = { name_zh: "nameZh", name_en: "nameEn", date_of_birth: "dateOfBirth", phone: "phone", address: "address" };
const REVIEWABLE = ["name_zh", "name_en", "date_of_birth", "phone", "address"] as const;
const ACTION_LABEL: Record<string, string> = { link: "對上現有安員", create: "新增安員", conflict: "衝突", needs_review: "要人手" };
const CHECK_LABEL: Record<string, string> = { new: "新", fill: "補空欄", same: "同現值一樣", differs: "同現值唔同", conflict: "衝突", missing: "冇", not_stored: "唔儲存", invalid_date: "日期唔合法" };

interface Row {
  key: string;
  action: string;
  reasons: string[];
  rating: string;
  auto_apply: boolean;
  hkid_masked: string | null;
  name_zh: string | null;
  name_en: string | null;
  phone_masked: string | null;
  address_masked: string | null;
  address_source?: string;
  basis?: string[];
  current_name_zh: string | null;
  current_name_en: string | null;
  name_review_pending: boolean;
  fields: Record<string, { status: string; check: string }>;
}
interface Preview {
  package_hash: string;
  package: { version: number; generated_at: string; persons: number };
  person_stats: Record<string, number>;
  field_stats: Record<string, { confirmed: number; review: number; missing: number }>;
  auto_apply: Record<string, number>;
  review: { persons: number; fields: Record<string, number> };
  reason_counts: Record<string, number>;
  rows: Row[];
}
interface ApplyRes {
  persons_total: number;
  outcomes: Record<string, number>;
  guards_created: number;
  guards_updated: number;
  phones_added: number;
  addresses_added: number;
  staff_numbers_added: number;
  field_conflicts: number;
  fields_written: Record<string, number>;
  /** WP-AI-OPS §28.4：自動項完成後剩低要人手嘅問題（上載者自己嗰批） */
  triage?: { session_id: string; open_questions: number; new_questions: number; total_questions: number } | null;
}

export default function GuardImportPage() {
  const [pkg, setPkg] = useState<Pkg | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applyRes, setApplyRes] = useState<ApplyRes | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [shown, setShown] = useState(30);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, string>>({});
  const [triageSession, setTriageSession] = useState<string | null>(null);
  const [triageOpen, setTriageOpen] = useState(0);

  const personByKey = useMemo(() => new Map((pkg?.persons ?? []).map((p) => [p.key, p])), [pkg]);

  async function onFile(file: File | undefined) {
    setError(null);
    setNotice(null);
    setPreview(null);
    setApplyRes(null);
    setDone({});
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Pkg;
      if (!parsed || !Array.isArray(parsed.persons)) throw new Error("bad");
      setPkg(parsed);
      setFileName(file.name);
      await runPreview(parsed);
    } catch {
      setPkg(null);
      setError("讀唔到導入包（要係 06-build-package 產生嘅 JSON）");
    }
  }

  async function runPreview(p: Pkg) {
    setBusy(true);
    const res = await apiPost<Preview>("/api/guards/import/preview", { package: p });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setPreview(res.data);
  }

  async function onApplyAuto() {
    if (!pkg) return;
    setBusy(true);
    setError(null);
    const res = await apiPost<ApplyRes>("/api/guards/import/apply", { package: pkg, package_hash: preview?.package_hash });
    setBusy(false);
    setConfirming(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setApplyRes(res.data);
    // 有問題就自動彈出對話式分診（可以「遲啲先答」，之後喺「待答問題」續答）
    setTriageOpen(res.data.triage?.open_questions ?? 0);
    if (res.data.triage && res.data.triage.open_questions > 0) setTriageSession(res.data.triage.session_id);
    setNotice(`已套用：新增 ${res.data.guards_created}、更新 ${res.data.guards_updated}、電話 ${res.data.phones_added}、地址 ${res.data.addresses_added}、工號 ${res.data.staff_numbers_added}`);
    await runPreview(pkg);
  }

  async function onDecide(key: string, field: (typeof REVIEWABLE)[number], action: "confirm" | "replace" | "skip" | "keep_pending") {
    if (!pkg) return;
    const edit = edits[`${key}:${field}`];
    setBusy(true);
    setError(null);
    const res = await apiPost<ApplyRes>("/api/guards/import/apply", {
      package: pkg,
      package_hash: preview?.package_hash,
      decisions: { [key]: { [field]: { action, ...(action !== "skip" && edit ? { value: edit } : {}) } } },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const conflict = res.data.field_conflicts > 0;
    setDone((d) => ({ ...d, [`${key}:${field}`]: action === "skip" ? "已略過" : conflict ? "同現值唔同（未覆蓋；用「改正後確認」可覆蓋）" : "已確認" }));
    await runPreview(pkg);
  }

  const reviewRows = (preview?.rows ?? []).filter((r) => (r.auto_apply || r.reasons.includes("name_not_confirmed")) && REVIEWABLE.some((f) => r.fields[f]?.status === "review" || (f === "name_zh" && r.name_review_pending)));

  return (
    <div className="space-y-4">
      <PageHeader kicker="主檔" title="安員證件資料導入" subtitle="上載本機產生嘅導入包 → 預覽 → 套用自動項 → 覆核待確認欄。導入包唔會存入系統。" />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <div className="rounded-lg border border-zk-border p-3">
        <label className="flex flex-wrap items-center gap-2 text-[13px]">
          導入包（JSON）
          <input type="file" accept="application/json,.json" onChange={(e) => onFile(e.target.files?.[0])} data-testid="import-file" />
          {fileName && <span className="text-zk-faint">{fileName}</span>}
        </label>
      </div>

      {triageSession && (
        <TriageDialog
          sessionId={triageSession}
          onClose={() => setTriageSession(null)}
          onChanged={() => setTriageOpen((n) => Math.max(0, n - 1))}
        />
      )}

      {preview && (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="import-person-stats">
            {(["link", "create", "conflict", "needs_review"] as const).map((a) => (
              <div key={a} className="rounded-lg border border-zk-border p-3">
                <div className="text-[12px] text-zk-faint">{ACTION_LABEL[a]}</div>
                <div className="text-xl font-semibold">{preview.person_stats[a] ?? 0}</div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border border-zk-border">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-left text-zk-faint">
                  <th className="p-2">欄位</th>
                  <th className="p-2">已確認</th>
                  <th className="p-2">待覆核</th>
                  <th className="p-2">冇資料</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(preview.field_stats).map(([f, s]) => (
                  <tr key={f} className="border-t border-zk-border">
                    <td className="p-2">{FIELD_LABEL[f] ?? f}</td>
                    <td className="p-2">{s.confirmed}</td>
                    <td className="p-2">{s.review}</td>
                    <td className="p-2">{s.missing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-zk-border p-3 text-[13px]" data-testid="import-auto-summary">
            自動套用（淨寫已確認欄）：{preview.auto_apply.persons} 人 · 新增安員 {preview.auto_apply.guards_to_create} · 補欄 {preview.auto_apply.guard_fields_to_fill} ·
            電話 {preview.auto_apply.phones_to_add} · 地址 {preview.auto_apply.addresses_to_add} · 工號 {preview.auto_apply.staff_numbers_to_add} · 現值唔同（唔覆蓋）{preview.auto_apply.field_conflicts}
            <div className="mt-2 flex items-center gap-2">
              {!confirming ? (
                <Button variant="primary" disabled={busy || preview.auto_apply.persons === 0} onClick={() => setConfirming(true)}>
                  套用自動項
                </Button>
              ) : (
                <>
                  <span className="text-orange-700">確認套用 {preview.auto_apply.persons} 人？會寫入並留 audit。</span>
                  <Button variant="danger" disabled={busy} onClick={onApplyAuto}>
                    {busy ? "套用緊…" : "確認套用"}
                  </Button>
                  <Button onClick={() => setConfirming(false)}>取消</Button>
                </>
              )}
            </div>
          </div>
          {applyRes && <div className="text-[12.5px] text-zk-muted">結果：{JSON.stringify(applyRes.outcomes)}</div>}
          {applyRes?.triage && triageOpen > 0 && !triageSession && (
            <div className="flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 p-3 text-[13px]" data-testid="triage-reopen">
              <span>有 {triageOpen} 條待答問題</span>
              <Button variant="primary" onClick={() => setTriageSession(applyRes.triage!.session_id)}>
                繼續答
              </Button>
            </div>
          )}

          <h2 className="text-sm font-semibold">覆核清單（{reviewRows.length} 人）</h2>
          {reviewRows.length === 0 && <EmptyState title="冇待覆核嘅欄" />}
          {reviewRows.slice(0, shown).map((r) => {
            const person = personByKey.get(r.key);
            return (
              <div key={r.key} className="space-y-2 rounded-lg border border-zk-border p-3 text-[13px]" data-testid="import-review-card">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill variant="neutral">{ACTION_LABEL[r.action]}</Pill>
                  <span className="text-zk-faint">身份證 {r.hkid_masked ?? "—"} · 電話 {r.phone_masked ?? "—"}</span>
                  {r.name_review_pending && <Pill variant="warning">姓名待核對</Pill>}
                  {r.address_source === "application_form" && r.fields.address?.status === "review" && <Pill variant="warning">地址來自申請表</Pill>}
                  {r.action === "link" && r.basis?.some((b) => b.startsWith("name_")) && <Pill variant="warning">對齊依據：{r.basis.join("＋")}</Pill>}
                  {r.reasons.slice(0, 3).map((x) => (
                    <Pill key={x} variant="neutral">
                      {x}
                    </Pill>
                  ))}
                </div>
                {REVIEWABLE.filter((f) => r.fields[f]?.status === "review" || (f === "name_zh" && r.name_review_pending)).map((f) => {
                  const k = `${r.key}:${f}`;
                  const extracted = (person?.[PKG_KEY[f]!] as PkgField | undefined)?.value ?? "";
                  const current = f === "name_zh" ? r.current_name_zh : f === "name_en" ? r.current_name_en : null;
                  return (
                    <div key={f} className="grid grid-cols-1 items-center gap-2 md:grid-cols-[90px_1fr_auto]">
                      <div className="text-zk-faint">
                        {FIELD_LABEL[f]} <span className="text-[11px]">（{CHECK_LABEL[r.fields[f]?.check ?? ""] ?? ""}）</span>
                      </div>
                      <div>
                        <input
                          className="w-full rounded-[5px] border border-zk-border px-2 py-1"
                          defaultValue={extracted}
                          onChange={(e) => setEdits((s) => ({ ...s, [k]: e.target.value }))}
                          aria-label={`${FIELD_LABEL[f]}抽取值`}
                        />
                        {current ? <div className="mt-0.5 text-[11.5px] text-zk-faint">現值：{current}</div> : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {done[k] ? (
                          <span className="text-[12px] text-zk-muted">{done[k]}</span>
                        ) : (
                          <>
                            <Button variant="primary" disabled={busy} onClick={() => onDecide(r.key, f, "confirm")}>
                              確認
                            </Button>
                            <Button disabled={busy} onClick={() => onDecide(r.key, f, "replace")}>
                              改正後確認
                            </Button>
                            {f === "name_zh" && r.reasons.includes("name_not_confirmed") && (
                              <Button disabled={busy} onClick={() => onDecide(r.key, f, "keep_pending")}>
                                照建但標待核對
                              </Button>
                            )}
                            <Button disabled={busy} onClick={() => onDecide(r.key, f, "skip")}>
                              略過
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {reviewRows.length > shown && (
            <Button onClick={() => setShown((n) => n + 30)}>載入更多（尚餘 {reviewRows.length - shown}）</Button>
          )}
        </>
      )}
    </div>
  );
}
