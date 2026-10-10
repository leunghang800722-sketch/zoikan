"use client";
// WP-STAFF-IMPORT B3：保安員證件資料批量導入（老闆／會計／主管；WP-AI-OPS §28.4 開放）。
//   ① 揀本機產生嘅導入包（import-package.json，淨文字）→ ② 預覽統計（逐欄 confirmed／review／missing
//   ＋逐人 link／create／conflict／needs_review）→ ③「套用自動項」（淨寫 confirmed 欄）→ ④ 覆核清單：
//   review 欄逐欄「確認／改正後確認／略過」。
// 導入包只留喺瀏覽器記憶體，每次請求重新帶上去；伺服器唔存檔。回應內 hkid／電話／地址已遮罩，
// 要核對嘅抽取值（姓名／地址）來自你自己揀嗰個本機檔。
import { useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { EmptyState, tableCls } from "@/components/ui/DataTable";
import { apiPost } from "@/lib/ui/api-client";
import { TriageDialog, reasonLabel } from "@/components/TriageDialog";
import { kickerFor } from "@/lib/nav/schema";
import Link from "next/link";

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
  unassignedBankAccounts?: { key: string; bankCode: string; accountNo: string; payeeName: string }[];
}

// WP-STAFF-FIELDS：v3 新欄標籤（動態 key 一律以陣列 [{key,…}] 傳，因為 response 會將物件 key 轉 snake_case）
const EXT_LABEL: Record<string, string> = {
  "siaPermit.no": "許可證號碼",
  "siaPermit.aExpiry": "許可證甲類屆滿日",
  "siaPermit.bExpiry": "許可證乙類屆滿日",
  "siaPermit.cExpiry": "許可證丙類屆滿日（未儲存）",
  "siaPermit.dExpiry": "許可證丁類屆滿日（未儲存）",
  "safetyCard.no": "平安咭號碼",
  "safetyCard.expiry": "平安咭屆滿日",
  "qas.issueDate": "QAS 簽發日",
  "qas.expiryDate": "QAS 屆滿日",
  hireDate: "入職日期",
  bank: "銀行資料",
  "emergency.1": "緊急聯絡人 1",
  "emergency.2": "緊急聯絡人 2",
  "emergency.3": "緊急聯絡人 3",
  "emergency.4": "緊急聯絡人 4",
  staffHire: "工號入職日期",
};
const maskAcct = (v: string) => (v.length <= 4 ? "****" : `${"*".repeat(Math.min(v.length - 4, 12))}${v.slice(-4)}`);

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
const ACTION_LABEL: Record<string, string> = { link: "對上現有保安員", create: "新增保安員", conflict: "衝突", needs_review: "要人手" };
const CHECK_LABEL: Record<string, string> = { new: "新", fill: "補空欄", same: "同現值一樣", differs: "同現值唔同", conflict: "衝突", missing: "冇", not_stored: "唔儲存", invalid_date: "日期唔合法" };

interface Row {
  /** 回應唔再帶包內 key（可能衍生自身份證）：index＝喺上載包 persons 嘅位置，ref＝伺服器 HMAC key */
  index: number;
  ref: string;
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
  ext?: { key: string; status: string; check: string }[];
  bank_masked?: { present: true; code?: string | null; name?: string | null; account_masked?: string | null } | null;
  current_name_zh: string | null;
  current_name_en: string | null;
  current_name_hidden?: boolean;
  name_review_pending: boolean;
  fields: Record<string, { status: string; check: string }>;
}
interface Preview {
  package_hash: string;
  package: { version: number; generated_at: string; persons: number; unassigned_bank_accounts?: number };
  person_stats: Record<string, number>;
  field_stats: Record<string, { confirmed: number; review: number; missing: number }>;
  auto_apply: Record<string, number>;
  review: { persons: number; fields: Record<string, number> };
  reason_counts: Record<string, number>;
  rows: Row[];
  counts_hidden?: boolean;
  viewer?: { pii_update: boolean; guard_update: boolean; bank_view?: boolean; pii_view?: boolean };
  ext_stats?: { fields: { key: string; confirmed: number; review: number }[]; to_write: { key: string; count: number }[]; conflicts: number };
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
  counts_hidden?: boolean;
  overwrite_blocked?: number;
  results?: { index: number; ref: string; reasons: string[] }[];
  fields_written: Record<string, number>;
  /** WP-AI-OPS §28.4：自動項完成後剩低要人手嘅問題（上載者自己嗰批） */
  triage?: { session_id?: string; open_questions?: number; new_questions: number; total_questions?: number; important_open?: number; supplementary_open?: number; owned_by_other?: boolean } | null;
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
  const [showFull, setShowFull] = useState<Record<string, boolean>>({});

  
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
    const t = res.data.triage;
    setTriageOpen(t?.owned_by_other ? 0 : (t?.open_questions ?? 0));
    if (t && !t.owned_by_other && (t.open_questions ?? 0) > 0 && t.session_id) setTriageSession(t.session_id);
    setNotice(`已套用：新增 ${res.data.guards_created}、更新 ${res.data.guards_updated}、電話 ${res.data.phones_added}、地址 ${res.data.addresses_added}、工號 ${res.data.staff_numbers_added}`);
    await runPreview(pkg);
  }

  async function onDecide(index: number, field: (typeof REVIEWABLE)[number], action: "confirm" | "replace" | "skip" | "keep_pending") {
    if (!pkg) return;
    const edit = edits[`${index}:${field}`];
    setBusy(true);
    setError(null);
    const res = await apiPost<ApplyRes>("/api/guards/import/apply", {
      package: pkg,
      package_hash: preview?.package_hash,
      decisions: { [`@${index}`]: { [field]: { action, ...(action !== "skip" && edit ? { value: edit } : {}) } } },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    if (res.data.results?.some((x) => x.reasons.includes("overwrite_forbidden"))) {
      const lt = res.data.results.some((x) => x.reasons.includes("longterm_hire_via_triage"));
      setDone((d) => ({ ...d, [`${index}:${field}`]: lt ? "未處理：長工入職日期會影響長工糧計算，要喺分診題逐條確認" : "未處理：要有保安員個人資料／保安員修改權限嘅同事處理" }));
      return;
    }
    const conflict = !res.data.counts_hidden && res.data.field_conflicts > 0;
    setDone((d) => ({ ...d, [`${index}:${field}`]: action === "skip" ? "已略過" : conflict ? "同現值唔同（未覆蓋；用「改正後確認」可覆蓋）" : res.data.counts_hidden ? "已提交（結果要有保安員個人資料權限先睇到）" : "已確認" }));
    // 唔再每次決定後重新 preview：preview 對非老闆有每日次數上限，而且 done 已記低結果
  }

  // 冇修改權限：replace 類選項預先停用（server 一樣會 403）。出生日期／地址要「保安員個人資料」修改權；姓名要「保安員」修改權
  // 只有覆蓋現有非空值先要權限：現有係空（fill）或者新建（new）屬補空欄，得
  const replaceDenied = (f: string, check: string): boolean => {
    if (check === "fill" || check === "new") return false;
    return f === "date_of_birth" || f === "address" ? preview?.viewer?.pii_update === false : f === "name_zh" || f === "name_en" ? preview?.viewer?.guard_update === false : false;
  };

  const reviewRows = (preview?.rows ?? []).filter((r) => (r.auto_apply || r.reasons.includes("name_not_confirmed")) && REVIEWABLE.some((f) => r.fields[f]?.status === "review" || (f === "name_zh" && r.name_review_pending)));

  return (
    <div className="space-y-4">
      <Link href="/guards" data-testid="back-to-guards" className="block w-fit text-zk-base text-zk-primary hover:underline">
        ‹ 返回保安員
      </Link>
      <PageHeader kicker={kickerFor("/guards/import")} title="保安員證件資料導入" subtitle="上載本機產生嘅導入包 → 預覽 → 套用自動項 → 覆核待確認欄。導入包唔會存入系統。" />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      <div className="rounded-lg border border-zk-border p-3">
        <label className="flex flex-wrap items-center gap-2 text-zk-base">
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
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="import-person-stats">
            {(["link", "create", "conflict", "needs_review"] as const).map((a) => (
              <div key={a} className="rounded-lg border border-zk-border p-3">
                <div className="text-zk-sm text-zk-faint">{ACTION_LABEL[a]}</div>
                <div className="text-xl font-semibold">{preview.person_stats[a] ?? 0}</div>
              </div>
            ))}
          </div>

          <div className="overflow-x-auto rounded-lg border border-zk-border">
            <table className={tableCls.table}>
              <thead>
                <tr className="text-left text-zk-faint">
                  <th className={tableCls.th}>欄位</th>
                  <th className={tableCls.th}>已確認</th>
                  <th className={tableCls.th}>待覆核</th>
                  <th className={tableCls.th}>冇資料</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(preview.field_stats).map(([f, s]) => (
                  <tr key={f}>
                    <td className={tableCls.td}>{FIELD_LABEL[f] ?? f}</td>
                    <td className={tableCls.td}>{s.confirmed}</td>
                    <td className={tableCls.td}>{s.review}</td>
                    <td className={tableCls.td}>{s.missing}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(preview.ext_stats || (preview.package.unassigned_bank_accounts ?? 0) > 0) && (
            <div className="space-y-2 rounded-lg border border-zk-border p-3 text-zk-base" data-testid="import-ext-summary">
              <div className="font-semibold">新增欄位（牌照／平安咭／QAS／入職日期／銀行／緊急聯絡人）</div>
              {preview.ext_stats && (
                <div className="overflow-x-auto">
                  <table className={tableCls.table}>
                    <thead>
                      <tr className="text-left text-zk-faint">
                        <th className={tableCls.th}>欄位</th>
                        <th className={tableCls.th}>已確認</th>
                        <th className={tableCls.th}>待覆核</th>
                        <th className={tableCls.th}>自動會寫</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.ext_stats.fields.map((f) => (
                        <tr key={f.key}>
                          <td className={tableCls.td}>{EXT_LABEL[f.key] ?? "其他資料"}</td>
                          <td className={tableCls.td}>{f.confirmed}</td>
                          <td className={tableCls.td}>{f.review}</td>
                          <td className={tableCls.td}>{preview.ext_stats!.to_write.find((w) => w.key === f.key)?.count ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-1 text-zk-sm text-zk-muted">只補空欄；{preview.counts_hidden || preview.viewer?.bank_view === false ? "" : `現值唔同（唔覆蓋、會出分診題）：${preview.ext_stats.conflicts}；`}待覆核同現值唔同嘅會出分診題。</div>
                </div>
              )}
              {(preview.package.unassigned_bank_accounts ?? 0) > 0 && (
                <div className="text-zk-warning" data-testid="import-unassigned-bank">有 {preview.package.unassigned_bank_accounts} 個 Payroll Editor 戶口對唔到人，套用後會喺待答問題逐個問你歸邊個。</div>
              )}
              {preview.rows.filter((r) => r.bank_masked).length > 0 && (
                <div className="space-y-1" data-testid="import-bank-rows">
                  <div className="text-zk-sm font-semibold text-zk-muted">銀行戶口（預設遮罩）</div>
                  {preview.rows.filter((r) => r.bank_masked).slice(0, shown).map((r) => {
                    const full = preview.viewer?.bank_view ? (pkg?.persons[r.index]?.bank as { accountNo?: { value: string | null } } | undefined)?.accountNo?.value : null;
                    return (
                      <div key={r.index} className="flex flex-wrap items-center gap-x-2 text-zk-sm">
                        <span className="text-zk-faint">{r.hkid_masked ?? "—"}</span>
                        {r.bank_masked && "account_masked" in r.bank_masked ? (
                          <span className="break-all">{r.bank_masked.name ?? r.bank_masked.code ?? "—"} · 戶口 {showFull[r.index] && full ? full : (r.bank_masked.account_masked ?? "—")}</span>
                        ) : (
                          <span className="text-zk-faint">有銀行資料（你冇「保安員銀行資料」睇權，唔顯示）</span>
                        )}
                        {full && (
                          <Button variant="secondary" size="sm" type="button" onClick={() => setShowFull((m) => ({ ...m, [r.index]: !m[r.index] }))}>
                            {showFull[r.index] ? "隱藏全號" : "顯示全號"}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  {pkg?.unassignedBankAccounts && preview.viewer?.bank_view && (
                    <div className="text-zk-sm text-zk-muted">對唔到人嘅戶口（尾 4 位）：{pkg.unassignedBankAccounts.map((u) => maskAcct(u.accountNo)).join("、")}</div>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="rounded-lg border border-zk-border p-3 text-zk-base" data-testid="import-auto-summary">
            自動套用（淨寫已確認欄）：{preview.auto_apply.persons} 人 · 新增保安員 {preview.auto_apply.guards_to_create} · 補欄 {preview.auto_apply.guard_fields_to_fill} ·
            電話 {preview.auto_apply.phones_to_add} · 地址 {preview.auto_apply.addresses_to_add} · 工號 {preview.auto_apply.staff_numbers_to_add} {preview.counts_hidden ? "" : `· 現值唔同（唔覆蓋）${preview.auto_apply.field_conflicts}`}
            <div className="mt-2 flex items-center gap-2">
              {!confirming ? (
                <Button variant="primary" disabled={busy || preview.auto_apply.persons === 0} onClick={() => setConfirming(true)}>
                  套用自動項
                </Button>
              ) : (
                <>
                  <span className="text-zk-warning">確認套用 {preview.auto_apply.persons} 人？會寫入並留 audit。</span>
                  <Button variant="danger" disabled={busy} onClick={onApplyAuto}>
                    {busy ? "套用緊…" : "確認套用"}
                  </Button>
                  <Button onClick={() => setConfirming(false)}>取消</Button>
                </>
              )}
            </div>
          </div>
          {applyRes && <div className="text-zk-sm text-zk-muted">結果：{JSON.stringify(applyRes.outcomes)}</div>}
          {applyRes?.triage?.owned_by_other && (
            <div className="rounded-lg border border-zk-primary/30 bg-zk-primary-tint-soft p-3 text-zk-base" data-testid="triage-owned-by-other">
              呢個檔案之前已經有同事上載過，問題會由佢（或者老闆）跟進。
            </div>
          )}
          {applyRes?.triage && !applyRes.triage.owned_by_other && triageOpen > 0 && !triageSession && (
            <div className="flex items-center gap-2 rounded-lg border border-zk-warning-border bg-zk-warning-bg p-3 text-zk-base" data-testid="triage-reopen">
              <span>有 {triageOpen} 條待答問題</span>
              <Button variant="primary" onClick={() => setTriageSession(applyRes.triage!.session_id ?? null)}>
                繼續答
              </Button>
            </div>
          )}

          <h2 className="text-sm font-semibold">覆核清單（{reviewRows.length} 人）</h2>
          {reviewRows.length === 0 && <EmptyState title="冇待覆核嘅欄" />}
          {reviewRows.slice(0, shown).map((r) => {
            const person = pkg?.persons[r.index];
            return (
              <div key={r.index} className="space-y-2 rounded-lg border border-zk-border p-3 text-zk-base" data-testid="import-review-card">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill variant="neutral">{ACTION_LABEL[r.action]}</Pill>
                  <span className="text-zk-faint">身份證 {r.hkid_masked ?? "—"} · 電話 {r.phone_masked ?? "—"}</span>
                  {r.name_review_pending && <Pill variant="warning">姓名待核對</Pill>}
                  {r.address_source === "application_form" && r.fields.address?.status === "review" && <Pill variant="warning">地址來自申請表</Pill>}
                  {r.action === "link" && r.basis?.some((b) => b.startsWith("name_")) && <Pill variant="warning">對齊依據：{r.basis.join("＋")}</Pill>}
                  {r.reasons.slice(0, 3).map((x) => (
                    <Pill key={x} variant="neutral">
                      {reasonLabel(x)}
                    </Pill>
                  ))}
                </div>
                {REVIEWABLE.filter((f) => r.fields[f]?.status === "review" || (f === "name_zh" && r.name_review_pending)).map((f) => {
                  const k = `${r.index}:${f}`;
                  const extracted = (person?.[PKG_KEY[f]!] as PkgField | undefined)?.value ?? "";
                  const current = f === "name_zh" ? r.current_name_zh : f === "name_en" ? r.current_name_en : null;
                  return (
                    <div key={f} className="grid grid-cols-1 items-center gap-2 lg:grid-cols-[90px_1fr_auto]">
                      <div className="text-zk-faint">
                        {FIELD_LABEL[f]} <span className="text-zk-xs">（{CHECK_LABEL[r.fields[f]?.check ?? ""] ?? ""}）</span>
                      </div>
                      <div>
                        <input
                          className="w-full rounded-[5px] border border-zk-border px-2 py-1"
                          defaultValue={extracted}
                          onChange={(e) => setEdits((s) => ({ ...s, [k]: e.target.value }))}
                          aria-label={`${FIELD_LABEL[f]}抽取值`}
                        />
                        {current ? <div className="mt-0.5 text-zk-xs text-zk-faint">現值：{current}</div> : null}
                        {!current && r.current_name_hidden && (f === "name_zh" || f === "name_en") ? <div className="mt-0.5 text-zk-xs text-zk-faint">姓名同現有保安員紀錄唔同（要有保安員個人資料權限先睇到）</div> : null}
                        {replaceDenied(f, r.fields[f]?.check ?? "") ? <div className="mt-0.5 text-zk-xs text-zk-warning">呢條要有保安員個人資料修改權限嘅同事（例如老闆）答</div> : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {done[k] ? (
                          <span className="text-zk-sm text-zk-muted">{done[k]}</span>
                        ) : (
                          <>
                            <Button variant="primary" disabled={busy} onClick={() => onDecide(r.index, f, "confirm")}>
                              確認
                            </Button>
                            <Button disabled={busy || replaceDenied(f, r.fields[f]?.check ?? "")} onClick={() => onDecide(r.index, f, "replace")}>
                              改正後確認
                            </Button>
                            {f === "name_zh" && r.reasons.includes("name_not_confirmed") && (
                              <Button disabled={busy} onClick={() => onDecide(r.index, f, "keep_pending")}>
                                照建但標待核對
                              </Button>
                            )}
                            <Button disabled={busy} onClick={() => onDecide(r.index, f, "skip")}>
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
