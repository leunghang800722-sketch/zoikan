// 保安員 Drawer「長工」tab（轉長工／介紹雞頭／崗位盤）。
// P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變。
"use client";

import Link from "next/link";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { todayLocalStr } from "@/lib/ui/format";
import { isInternalBrokerKind, type BrokerRow, type SiteRow } from "../guards-types";
import type { GuardForm } from "../useGuardForm";

export function LongtermTab({
  g,
  tabCls,
  isBroker,
  brokers,
  sites,
}: {
  g: GuardForm;
  tabCls: (t: string) => string;
  isBroker: boolean;
  brokers: BrokerRow[];
  sites: SiteRow[];
}) {
  const { editingId, form, setForm, referralBrokerMigrationCleared, longterm } = g;
  const {
    longtermPosts,
    longtermPostForm,
    longtermPostError,
    longtermPostSaving,
    longtermPostActionBusy,
    convertOpen,
    convertForm,
    convertError,
    convertSaving,
    setLongtermPostForm,
    setConvertOpen,
    setConvertForm,
    onAddLongtermPost,
    onTerminateLongtermPost,
    onSubmitConvert,
  } = longterm;
  return (
    <>
          {/* WP-PHASE3（§20.4 Phase 3 item 1）：保安員抽屜「長工」區——老闆／
              主管；雞頭（`isBroker`）結構性唔見（呢個 component 雞頭
              session 根本唔會行到呢個分支，`!isBroker` 淨係防禦性）。
              淨係編輯先顯示（同員工編號／電話等子資源一致——新增保安員
              嗰陣個 guard 仲未存在）。 */}
          {editingId && !isBroker && (
            <div className={tabCls("longterm")} data-testid="guard-tab-panel-longterm">
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">長工</h3>
              {form.employment_type !== "longterm_autopay" && (
                <div className="rounded-[7px] border border-dashed border-zk-border p-2.5">
                  {!convertOpen ? (
                    <Button variant="secondary" size="sm" type="button" onClick={() => setConvertOpen(true)}>
                      轉長工（一步：設聘用形式＋崗位盤＋介紹雞頭＋起始月薪）
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <Banner kind="error" message={convertError} />
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="崗位盤">
                          <select className={selectCls} value={convertForm.site_id} onChange={(e) => setConvertForm((f) => ({ ...f, site_id: e.target.value }))}>
                            <option value="">（揀盤）</option>
                            {sites.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.canonical_name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="生效日">
                          <input type="date" className={inputCls} value={convertForm.effective_from} onChange={(e) => setConvertForm((f) => ({ ...f, effective_from: e.target.value }))} />
                        </Field>
                        <Field label="介紹雞頭（選填）" hint="Y／內部長工結算單位唔可以做介紹雞頭，下拉已剔走">
                          <select className={selectCls} value={convertForm.referral_broker_id} onChange={(e) => setConvertForm((f) => ({ ...f, referral_broker_id: e.target.value }))}>
                            <option value="">（無）</option>
                            {brokers
                              .filter((b) => !isInternalBrokerKind(b.kind))
                              .map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.name}（{b.code}）
                                </option>
                              ))}
                          </select>
                        </Field>
                        <Field label="起始月薪（選填）" hint="要「長工糧」權限先建到合約，冇權會警告但唔會擋轉長工">
                          <input type="number" step="0.01" className={inputCls} value={convertForm.monthly_salary} onChange={(e) => setConvertForm((f) => ({ ...f, monthly_salary: e.target.value }))} />
                        </Field>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="primary" size="sm" type="button" disabled={convertSaving || !convertForm.site_id} onClick={onSubmitConvert}>
                          {convertSaving ? "處理緊…" : "確認轉長工"}
                        </Button>
                        <Button variant="secondary" size="sm" type="button" onClick={() => setConvertOpen(false)}>
                          取消
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="介紹雞頭"
                  hint={
                    referralBrokerMigrationCleared
                      ? "已清：原設定係內部現金結算單位（Y），老闆 2026-09-28 決定 Y 唔可以做介紹雞頭，系統已自動清空，請人手覆核係咪要改揀其他雞頭"
                      : "呢個長工由邊個雞頭供應（計介紹費用）——Y／內部長工結算單位唔可以做介紹雞頭，下拉已剔走"
                  }
                >
                  <select className={selectCls} value={form.referral_broker_id} onChange={(e) => setForm((f) => ({ ...f, referral_broker_id: e.target.value }))}>
                    <option value="">（無）</option>
                    {brokers
                      .filter((b) => !isInternalBrokerKind(b.kind))
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}（{b.code}）
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="簽證形式贊助雞頭" hint="有值＝永遠跟呢個雞頭散更結算，唔理崗位盤">
                  <select
                    className={selectCls}
                    value={form.visa_sponsored_by_broker_id}
                    onChange={(e) => setForm((f) => ({ ...f, visa_sponsored_by_broker_id: e.target.value }))}
                  >
                    <option value="">（無）</option>
                    {brokers.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}（{b.code}）
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div>
                <div className="mb-1 text-zk-sm text-zk-muted">長工崗位盤</div>
                <Banner kind="error" message={longtermPostError} />
                {longtermPosts.length === 0 ? (
                  <div className="text-zk-sm text-zk-faint">未設崗位盤</div>
                ) : (
                  <ul className="space-y-1">
                    {longtermPosts.map((p) => {
                      const active = !p.voided_at && (!p.effective_to || p.effective_to >= todayLocalStr());
                      return (
                        <li key={p.id} className="flex items-center justify-between gap-2 rounded border border-zk-border px-2 py-1 text-zk-sm">
                          <span className="min-w-0 break-words">
                            {sites.find((s) => s.id === p.site_id)?.canonical_name ?? p.site_id.slice(0, 8)}
                            <span className="ml-1 text-zk-faint">
                              （{p.effective_from.slice(0, 10)}～{p.effective_to ? p.effective_to.slice(0, 10) : "現在"}，{p.source === "manual" ? "人手" : p.source}）
                            </span>
                          </span>
                          {active && !p.voided_at && (
                            <Button variant="linkDanger" size="sm" className="shrink-0" type="button" disabled={longtermPostActionBusy} onClick={() => onTerminateLongtermPost(p.id)}>
                              終止
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {/* e2e：`aria-label` 俾 tests/e2e/phase3.spec.ts 用
                      `getByLabel()` 精準揀（呢兩個控件冇用 <Field> 包
                      住，唔靠隱式 label association）。 */}
                  <select
                    aria-label="長工崗位盤：揀盤"
                    className={selectCls}
                    value={longtermPostForm.site_id}
                    onChange={(e) => setLongtermPostForm((f) => ({ ...f, site_id: e.target.value }))}
                  >
                    <option value="">（揀盤）</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.canonical_name}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="長工崗位盤：生效日"
                    type="date"
                    className={inputCls}
                    value={longtermPostForm.effective_from}
                    onChange={(e) => setLongtermPostForm((f) => ({ ...f, effective_from: e.target.value }))}
                  />
                </div>
                <Button variant="secondary" size="sm" type="button" disabled={longtermPostSaving || !longtermPostForm.site_id} onClick={onAddLongtermPost} className="mt-2">
                  {longtermPostSaving ? "新增緊…" : "加崗位盤"}
                </Button>
              </div>

              <div className="text-zk-sm text-zk-muted">
                合約（月薪／假期結餘）去{" "}
                <Link href="/reports/longterm-payroll" className="text-zk-primary underline">
                  長工糧頁
                </Link>{" "}
                管理。
              </div>
            </div>
          )}
    </>
  );
}
