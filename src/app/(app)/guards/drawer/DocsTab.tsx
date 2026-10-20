// 保安員 Drawer「證件」tab 區塊（牌照與證件／員工編號／Blacklist）。
// P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變。
"use client";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { fmtDate } from "@/lib/ui/format";
import { BLACKLIST_LABEL, BLACKLIST_RESULTS, END_REASON_LABEL, KNOWN_STAFF_NUMBER_SCHEMES, type StaffNumberRow } from "../guards-types";
import { isAge70OrOlder } from "../guards-utils";
import type { GuardForm } from "../useGuardForm";

export function LicenceSection({ g, tabCls, hasLicenceExtraField }: { g: GuardForm; tabCls: (t: string) => string, hasLicenceExtraField: boolean }) {
  const { editingId, form, setForm, derivedSiaPermitType, legacyPermitInfo } = g;
  return (
    <>
          {/* WP-PII：新欄一律 PATCH-only（見上面 onSubmit()）——新增
              保安員嗰陣（`!editingId`）唔顯示呢幾個分區，建好之後先用
              「編輯」補（避免顯示一啲 POST 唔接受嘅 input，撳「儲存」
              先發現 400）。冇對應 view 權限嘅分區直接唔顯示（唔係顯示
              「—」，跟老闆決定原文）。 */}
          {editingId && hasLicenceExtraField && (
            <div className={tabCls("docs")} data-testid="guard-tab-panel-docs">
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">牌照與證件</h3>
              <div className="grid grid-cols-2 gap-2">
                <Field label="牌照號碼">
                  <input className={inputCls} value={form.sia_permit_no} onChange={(e) => setForm((f) => ({ ...f, sia_permit_no: e.target.value }))} />
                </Field>
                {/* WP-STAFFNO：牌照類別而家係衍生顯示值（由甲／乙類到期日
                    計，見 src/lib/guards/staff-numbers.ts
                    deriveSiaPermitExpiry()）——唔再係可以自己揀嘅
                    select，改甲／乙到期日、儲存之後重新 GET 先會見到
                    新值。 */}
                <Field label="牌照類別（自動計）">
                  <div className={`${inputCls} flex items-center bg-zk-header text-zk-muted`}>{derivedSiaPermitType ?? "—"}</div>
                </Field>
              </div>
              {/* 必修 3（Opus 驗收第三輪）：a／b 都未填但仲存住舊
                  `sia_permit_expiry`／`sia_permit_type` 嘅 guard——顯示
                  一行唯讀提示，等用戶知呢個人其實有舊牌照資料，淨係未
                  搬去新嘅甲／乙到期日兩欄；填咗任何一個之後（撳「儲存」
                  重新 GET）呢行就會自動消失，改用新計法。 */}
              {legacyPermitInfo && (
                <div className="rounded-[7px] border border-zk-warning-border bg-zk-warning-bg px-2.5 py-1.5 text-zk-base text-zk-warning-dark">
                  舊記錄：類別 {legacyPermitInfo.type ?? "—"}、到期 {legacyPermitInfo.expiry ?? "—"}
                  （填咗甲／乙類到期日之後會改用新計法）
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Field label="甲類到期">
                  <input
                    type="date"
                    className={inputCls}
                    value={form.sia_permit_a_expiry}
                    onChange={(e) => setForm((f) => ({ ...f, sia_permit_a_expiry: e.target.value }))}
                  />
                </Field>
                <Field
                  label="乙類到期"
                  hint={isAge70OrOlder(form.date_of_birth) ? "已滿 70 歲，乙類失效" : undefined}
                >
                  <input
                    type="date"
                    className={inputCls}
                    value={form.sia_permit_b_expiry}
                    onChange={(e) => setForm((f) => ({ ...f, sia_permit_b_expiry: e.target.value }))}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="平安卡號碼">
                  <input className={inputCls} value={form.safety_card_no} onChange={(e) => setForm((f) => ({ ...f, safety_card_no: e.target.value }))} />
                </Field>
                <Field label="平安卡到期日">
                  <input
                    type="date"
                    className={inputCls}
                    value={form.safety_card_expiry}
                    onChange={(e) => setForm((f) => ({ ...f, safety_card_expiry: e.target.value }))}
                  />
                </Field>
              </div>
              {/* WP-MISC（老闆 2026-09-20 拍板）：QAS（基本保安訓練證書）
                  ——來源檔個欄過去日子＝完成、未來日子＝到期，混雜咗，
                  分開兩欄先唔會入錯。 */}
              <div className="grid grid-cols-2 gap-2">
                <Field label="QAS 完成日期">
                  <input
                    type="date"
                    className={inputCls}
                    value={form.qas_issue_date}
                    onChange={(e) => setForm((f) => ({ ...f, qas_issue_date: e.target.value }))}
                  />
                </Field>
                <Field label="QAS 到期日（如有）">
                  <input
                    type="date"
                    className={inputCls}
                    value={form.qas_expiry_date}
                    onChange={(e) => setForm((f) => ({ ...f, qas_expiry_date: e.target.value }))}
                  />
                </Field>
              </div>
              {/* WP-MULTI：呢兩個係「保安員層面」（整體）嘅入職／離職日期——
                  跟下面「員工編號」分區每個號自己嘅入職／離職日期（見
                  renderStaffNumberRow）唔同層級，加 hint 講明分別。 */}
              <div className="grid grid-cols-2 gap-2">
                {/* Fable5.1：hint 刻意避免出現「編號」兩字——Playwright
                    e2e `fieldControl(page,"編號")`（tests/e2e/staffno.
                    spec.ts）用 `hasText` 揀返個「編號」input，佢會撞中
                    呢兩個欄嘅 hint 文字（連同呢個 label 底下嘅成段文字
                    一齊比對），令佢揀錯去呢度（type="date"）唔係下面
                    工號分區果個真正嘅「編號」文字 input。 */}
                <Field label="入職日期" hint="呢個係保安員整體嘅入職日期；每個工號仲有自己獨立嘅入職日期，見下面「員工工號」分區">
                  <input type="date" className={inputCls} value={form.hire_date} onChange={(e) => setForm((f) => ({ ...f, hire_date: e.target.value }))} />
                </Field>
                <Field label="離職日期" hint="呢個係保安員整體嘅離職日期；每個工號仲有自己獨立嘅離職／取消日期">
                  <input type="date" className={inputCls} value={form.leave_date} onChange={(e) => setForm((f) => ({ ...f, leave_date: e.target.value }))} />
                </Field>
              </div>
            </div>
          )}
    </>
  );
}

export function StaffNumbersSection({ g, tabCls, isBroker }: { g: GuardForm; tabCls: (t: string) => string, isBroker: boolean }) {
  const { staffNos } = g;
  const { editingId } = g;
  const {
    staffNumbers,
    staffNumberForm,
    staffNumberError,
    staffNumberSaving,
    showFormerStaffNumbers,
    setShowFormerStaffNumbers,
    numberActionBusy,
    numberActionError,
    numberEditingId,
    numberEditForm,
    numberEndingId,
    numberEndForm,
    setNumberEndForm,
    setNumberEndingId,
    onConfirmEndStaffNumber,
    setStaffNumberForm,
    setNumberEditForm,
    onAddStaffNumber,
    onToggleStaffNumberStatus,
    onOpenNumberEdit,
    onCancelNumberEdit,
    onSaveNumberEdit,
  } = staffNos;

  // S7：員工編號分區每行——顯示＋（!isBroker 先有）「取消呢個號」／
  // 「改返現用」／「編輯（號碼／生效期／備註）」，call PATCH
  // .../staff-numbers/:numberId。
  function renderStaffNumberRow(n: StaffNumberRow) {
    const isCurrent = n.status === "current";
    const isEditing = numberEditingId === n.id;
    return (
      <div
        key={n.id}
        className={`rounded-[7px] border px-2.5 py-1.5 text-zk-base ${isCurrent ? "border-zk-border" : "border-zk-border bg-zk-header text-zk-muted"}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Pill variant="neutral">{n.scheme}</Pill>
          <span className={isCurrent ? "font-medium text-zk-text" : undefined}>{n.number}</span>
          <Pill variant={isCurrent ? "success" : "neutral"}>{isCurrent ? "現用" : "已取消"}</Pill>
          {/* WP-MULTI（老闆 2026-09-19 拍板業務規則 (4)）：每個編號有自己
              嘅入職／離職日期——標籤改用呢個講法，唔再淨係講「生效」/
              「取消」，等用戶睇得明「呢個係呢個號嘅入職/離職日期，唔係
              呢個人整體嘅」。 */}
          {isCurrent && n.valid_from && <span className="text-xs text-zk-muted">入職（呢個號）：{fmtDate(n.valid_from)}</span>}
          {!isCurrent && n.valid_to && <span className="text-xs">離職／停用：{fmtDate(n.valid_to)}</span>}
          {!isCurrent && n.end_reason && <span className="text-xs">原因：{END_REASON_LABEL[n.end_reason] ?? n.end_reason}</span>}
          {n.predecessor_id && <span className="text-xs text-zk-muted">接替：{staffNumbers.find((x) => x.id === n.predecessor_id)?.number ?? "（舊號）"}</span>}
          {n.note && <span className="text-xs text-zk-muted">備註：{n.note}</span>}
          {!isBroker && (
            <div className="ml-auto flex gap-1.5">
              <Button variant="link" size="sm"
                type="button"
                disabled={numberActionBusy}
                onClick={() => onToggleStaffNumberStatus(n)}

              >
                {isCurrent ? "取消呢個號" : "改返現用"}
              </Button>
              <Button variant="link" size="sm"
                type="button"
                onClick={() => (isEditing ? onCancelNumberEdit() : onOpenNumberEdit(n))}

              >
                {isEditing ? "取消編輯" : "編輯"}
              </Button>
            </div>
          )}
        </div>
        {numberEndingId === n.id && (
          <div className="mt-2 space-y-2 border-t border-zk-border pt-2" data-testid="staff-number-end-form">
            <Banner kind="error" message={numberActionError} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="離職／停用日（必填）">
                <input type="date" className={inputCls} value={numberEndForm.valid_to} onChange={(e) => setNumberEndForm((f) => ({ ...f, valid_to: e.target.value }))} />
              </Field>
              <Field label="原因（必填）">
                <select className={selectCls} value={numberEndForm.end_reason} onChange={(e) => setNumberEndForm((f) => ({ ...f, end_reason: e.target.value }))}>
                  <option value="resigned">離職</option>
                  <option value="cancelled">作廢／取消</option>
                </select>
              </Field>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" type="button" disabled={numberActionBusy} onClick={onConfirmEndStaffNumber}>
                {numberActionBusy ? "處理中…" : "確認結束"}
              </Button>
              <Button variant="secondary" size="sm" type="button" onClick={() => setNumberEndingId(null)}>
                取消
              </Button>
            </div>
          </div>
        )}
        {isEditing && (
          <div className="mt-2 space-y-2 border-t border-zk-border pt-2">
            <Banner kind="error" message={numberActionError} />
            <Field label="號碼">
              <input className={inputCls} value={numberEditForm.number} onChange={(e) => setNumberEditForm((f) => ({ ...f, number: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              {/* WP-MULTI：`valid_from` 標籤改「入職日期（呢個號）」——
                  一個工號一行＝一組入職／離職日期，同「保安員整體」嘅
                  入職／離職日期（下面「牌照與證件」分區嗰兩個）分開。 */}
              <Field label="入職日期（呢個號）">
                <input
                  type="date"
                  className={inputCls}
                  value={numberEditForm.valid_from}
                  onChange={(e) => setNumberEditForm((f) => ({ ...f, valid_from: e.target.value }))}
                />
              </Field>
              {/* 應修 2（Opus 驗收第二輪）：取消自動填嘅 valid_to 之前
                  淨係顯示（renderStaffNumberRow 嗰行「離職／取消：」），
                  冇得喺呢個編輯表單度改／清——而家補返個 input，打空咗撳
                  「儲存」會送 null 清走（見 onSaveNumberEdit()）。 */}
              <Field label="離職／取消日期">
                <input
                  type="date"
                  className={inputCls}
                  value={numberEditForm.valid_to}
                  onChange={(e) => setNumberEditForm((f) => ({ ...f, valid_to: e.target.value }))}
                />
              </Field>
            </div>
            {!isCurrent && (
              <Field label="結束原因">
                <select className={selectCls} value={numberEditForm.end_reason} onChange={(e) => setNumberEditForm((f) => ({ ...f, end_reason: e.target.value }))}>
                  <option value="">（未填）</option>
                  <option value="resigned">離職</option>
                  <option value="replaced">換號（被新號取代）</option>
                  <option value="cancelled">作廢／取消</option>
                </select>
              </Field>
            )}
            <Field label="備註">
              <input className={inputCls} value={numberEditForm.note} onChange={(e) => setNumberEditForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" type="button" disabled={numberActionBusy} onClick={onSaveNumberEdit}>
                {numberActionBusy ? "儲存緊…" : "儲存"}
              </Button>
              <Button variant="secondary" size="sm" type="button" onClick={onCancelNumberEdit}>
                取消
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
          {/* WP-STAFFNO：員工編號獨立表——新增保安員嗰陣（`!editingId`）
              個 guard 仲未存在，`POST .../staff-numbers` 用唔到，同牌照/
              PII/銀行分區一致做法，淨係編輯先顯示。雞頭（`isBroker`）
              可以見到（`GET .../staff-numbers` 跟「自己保安員:view」，出廠
              有），但冇「新增編號」表單——「雞頭視角：chips 只讀，冇新增
              掣」（老闆決定原文）。 */}
          {editingId && (
            <div className={tabCls("docs")} data-testid="guard-tab-panel-docs">
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">員工編號</h3>
              {/* C（老闆 2026-09-19 拍板四條業務規則）：分區標題下加一句提示，
                  等用戶（尤其主管／會計）睇得明「邊個號用嚟做乜」，同「取消
                  咗嘅編號唔會復用」呢個關鍵行為。 */}
              <p className="text-xs text-zk-muted">
                更表／匯出一律顯示 U 號；MG 只作內部出糧／行政用；離職後編號取消，再入職會攞新編號。每個編號有自己嘅入職／離職日期。
              </p>
              {staffNumbers.filter((n) => n.status === "current").length === 0 ? (
                <div className="text-sm text-zk-muted">未有現用編號</div>
              ) : (
                <div className="space-y-1.5">{staffNumbers.filter((n) => n.status === "current").map(renderStaffNumberRow)}</div>
              )}

              {staffNumbers.filter((n) => n.status === "former").length > 0 && (
                <div>
                  <Button variant="link" size="sm"
                    type="button"
                    onClick={() => setShowFormerStaffNumbers((v) => !v)}

                  >
                    {showFormerStaffNumbers ? "隱藏已取消嘅號" : `顯示已取消嘅號 ${staffNumbers.filter((n) => n.status === "former").length} 個`}
                  </Button>
                  {showFormerStaffNumbers && (
                    <div className="mt-1.5 space-y-1.5">{staffNumbers.filter((n) => n.status === "former").map(renderStaffNumberRow)}</div>
                  )}
                </div>
              )}

              {!isBroker && (
                <div className="rounded-[7px] border border-dashed border-zk-border p-2.5">
                  <Banner kind="error" message={staffNumberError} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="種類（scheme）">
                      <select
                        className={selectCls}
                        value={staffNumberForm.scheme}
                        onChange={(e) => setStaffNumberForm((f) => ({ ...f, scheme: e.target.value }))}
                      >
                        {KNOWN_STAFF_NUMBER_SCHEMES.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                        <option value="其他">其他（自填）</option>
                      </select>
                    </Field>
                    {staffNumberForm.scheme === "其他" ? (
                      <Field label="自填 scheme">
                        <input
                          className={inputCls}
                          value={staffNumberForm.schemeOther}
                          onChange={(e) => setStaffNumberForm((f) => ({ ...f, schemeOther: e.target.value }))}
                          placeholder="1-4 位英文字母"
                        />
                      </Field>
                    ) : (
                      <Field label="編號">
                        <input
                          className={inputCls}
                          value={staffNumberForm.number}
                          onChange={(e) => setStaffNumberForm((f) => ({ ...f, number: e.target.value }))}
                          placeholder={`例：${staffNumberForm.scheme}00123`}
                        />
                      </Field>
                    )}
                  </div>
                  {staffNumberForm.scheme === "其他" && (
                    <div className="mt-2">
                      <Field label="編號">
                        <input
                          className={inputCls}
                          value={staffNumberForm.number}
                          onChange={(e) => setStaffNumberForm((f) => ({ ...f, number: e.target.value }))}
                        />
                      </Field>
                    </div>
                  )}
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {/* WP-MULTI：新增表單「生效日期」改「入職日期（呢個
                        號）」——同 renderStaffNumberRow／編輯表單一致講
                        法（見上面兩處同一段理由）。 */}
                    <Field label="入職日期（呢個號）（選填）">
                      <input
                        type="date"
                        className={inputCls}
                        value={staffNumberForm.valid_from}
                        onChange={(e) => setStaffNumberForm((f) => ({ ...f, valid_from: e.target.value }))}
                      />
                    </Field>
                    <Field label="備註（選填）">
                      <input className={inputCls} value={staffNumberForm.note} onChange={(e) => setStaffNumberForm((f) => ({ ...f, note: e.target.value }))} />
                    </Field>
                  </div>
                  {/* EMP-P1：同 scheme 已有現用卡 → 要揀「換號」（舊卡標示被取代）；重新入職要先喺舊卡填離職日＋原因結束舊卡。補歷史卡＝已離職／停用嘅舊號。 */}
                  <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-zk-muted">
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={staffNumberForm.replaces_current} disabled={staffNumberForm.historical} onChange={(e) => setStaffNumberForm((f) => ({ ...f, replaces_current: e.target.checked }))} />
                      換號（取代現用嘅同類編號，同一段聘用）
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="checkbox" checked={staffNumberForm.historical} onChange={(e) => setStaffNumberForm((f) => ({ ...f, historical: e.target.checked, replaces_current: false }))} />
                      補歷史卡（已離職／停用）
                    </label>
                  </div>
                  {staffNumberForm.historical && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Field label="離職／停用日（必填）">
                        <input type="date" className={inputCls} value={staffNumberForm.valid_to} onChange={(e) => setStaffNumberForm((f) => ({ ...f, valid_to: e.target.value }))} />
                      </Field>
                      <Field label="原因（必填）">
                        <select className={selectCls} value={staffNumberForm.end_reason} onChange={(e) => setStaffNumberForm((f) => ({ ...f, end_reason: e.target.value }))}>
                          <option value="resigned">離職</option>
                          <option value="replaced">換號（被新號取代）</option>
                          <option value="cancelled">作廢／取消</option>
                        </select>
                      </Field>
                    </div>
                  )}
                  <Button variant="secondary" size="sm"
                    type="button"
                    disabled={staffNumberSaving || !staffNumberForm.number}
                    onClick={onAddStaffNumber} className="mt-2">
                    {staffNumberSaving ? "新增緊…" : "新增編號"}
                  </Button>
                </div>
              )}
            </div>
          )}
    </>
  );
}

export function BlacklistSection({ g, tabCls }: { g: GuardForm; tabCls: (t: string) => string }) {
  const { form, setForm } = g;
  return (
    <>
            <div className={tabCls("docs")} data-testid="guard-tab-panel-docs-bl">
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">Blacklist</h3>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Check 結果">
                  <select
                    className={selectCls}
                    value={form.blacklist_check_result}
                    onChange={(e) => setForm((f) => ({ ...f, blacklist_check_result: e.target.value }))}
                  >
                    <option value="">（未填）</option>
                    {BLACKLIST_RESULTS.map((v) => (
                      <option key={v} value={v}>
                        {BLACKLIST_LABEL[v]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Check 日期">
                  <input
                    type="date"
                    className={inputCls}
                    value={form.blacklist_check_date}
                    onChange={(e) => setForm((f) => ({ ...f, blacklist_check_date: e.target.value }))}
                  />
                </Field>
              </div>
            </div>
    </>
  );
}
