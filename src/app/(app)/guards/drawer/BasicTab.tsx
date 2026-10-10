// 保安員 Drawer「基本」tab 區塊（基本資料／預設雞頭等／個人資料）。
// P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變。
"use client";

import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { EMPLOYMENT_TYPES, type BrokerRow } from "../guards-types";
import type { GuardForm } from "../useGuardForm";

export function BasicMain({ g, tabCls }: { g: GuardForm; tabCls: (t: string) => string }) {
  const { form, setForm } = g;
  return (
    <>
          <div className={tabCls("basic")} data-testid="guard-tab-panel-basic">
          <div className="grid grid-cols-2 gap-2">
            {/* S1（Opus 驗收）：呢兩個係快速路（同步落 guards.staff_no／
                staff_no_mw），淨係收固定種類——U／MG／MW 以外嘅種類（例如
                MP）要落面「員工編號」分區新增，唔係就 API 會 400。 */}
            {/* hint 文字刻意唔用「員工編號」呢個字眼（雖然指緊嗰個分區）——
                Playwright e2e（tests/e2e/staffno.spec.ts fieldControl()）
                淨係靠 `label` 嘅 `hasText` 子字串 + `.first()` 揾返落面
                「員工編號」分區入面真正嘅「編號」input，`hint` 文字入面
                字面出現「編號」呢兩個字會令佢誤中呢個較前面嘅 label，撳
                「新增編號」個掣（`!staffNumberForm.number` 都仲係空）保持
                disabled，成個 POST 都唔會發出——見 fieldControl() 註解。 */}
            <Field label="工號" hint="更表／匯出顯示嘅 U 號；只收 U 開頭。如果現用 U 號已取消，呢度會顯示最近取消嗰個（歷史更表用）——現用狀態以下面獨立分區為準">
              <input className={inputCls} value={form.staff_no} onChange={(e) => setForm((f) => ({ ...f, staff_no: e.target.value }))} />
            </Field>
            <Field label="長工／寫字樓工號（MG／MW）" hint="只作內部出糧／行政用；只收 MG／MW 開頭。現用狀態以下面獨立分區為準">
              <input className={inputCls} value={form.staff_no_mw} onChange={(e) => setForm((f) => ({ ...f, staff_no_mw: e.target.value }))} />
            </Field>
          </div>
          <Field label="姓名（中文）">
            <input className={inputCls} value={form.name_zh} onChange={(e) => setForm((f) => ({ ...f, name_zh: e.target.value }))} required />
          </Field>
          <Field label="姓名（英文）">
            <input className={inputCls} value={form.name_en} onChange={(e) => setForm((f) => ({ ...f, name_en: e.target.value }))} />
          </Field>
          <Field label="電話">
            <input className={inputCls} value={form.tel} onChange={(e) => setForm((f) => ({ ...f, tel: e.target.value }))} />
          </Field>
          </div>
    </>
  );
}

export function BasicMisc({ g, tabCls, brokers, hasMoneyField }: { g: GuardForm; tabCls: (t: string) => string, brokers: BrokerRow[]; hasMoneyField: boolean }) {
  const { editingId, form, setForm } = g;
  return (
    <>
          <div className={tabCls("basic")} data-testid="guard-tab-panel-basic-misc">
          <Field label="預設雞頭" hint={editingId ? "建立之後唔可以喺呢頁改，要用用戶/雞頭管理" : undefined}>
            <select
              className={selectCls}
              value={form.default_broker_id}
              onChange={(e) => setForm((f) => ({ ...f, default_broker_id: e.target.value }))}
              disabled={!!editingId}
            >
              <option value="">（無）</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}（{b.code}）
                </option>
              ))}
            </select>
          </Field>
          <Field label="聘用形式（employment_type）">
            <select
              className={selectCls}
              value={form.employment_type}
              onChange={(e) => setForm((f) => ({ ...f, employment_type: e.target.value }))}
            >
              {EMPLOYMENT_TYPES.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          {hasMoneyField ? (
            <Field label="月薪（monthly_salary）">
              <input
                type="number"
                step="0.01"
                className={inputCls}
                value={form.monthly_salary}
                onChange={(e) => setForm((f) => ({ ...f, monthly_salary: e.target.value }))}
              />
            </Field>
          ) : (
            <Field label="月薪（monthly_salary）">
              <div className="text-sm text-zk-faint">—（冇「出街價」權限）</div>
            </Field>
          )}
          <Field label="Polo 尺碼">
            <input className={inputCls} value={form.polo_size} onChange={(e) => setForm((f) => ({ ...f, polo_size: e.target.value }))} />
          </Field>
          </div>
    </>
  );
}

export function PiiSection({ g, tabCls }: { g: GuardForm; tabCls: (t: string) => string }) {
  const { form, setForm, allowInvalidHkid, setAllowInvalidHkid } = g;
  return (
    <>
            <div className={tabCls("basic")} data-testid="guard-tab-panel-basic-pii">
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">個人資料</h3>
              <Field label="身份證號碼" hint="格式例：A123456(3)；系統會驗 check digit，同另一位保安員重複會擋">
                <input className={inputCls} value={form.hkid} onChange={(e) => setForm((f) => ({ ...f, hkid: e.target.value }))} />
              </Field>
              <label className="flex items-center gap-2 text-xs text-zk-faint">
                <input type="checkbox" checked={allowInvalidHkid} onChange={(e) => setAllowInvalidHkid(e.target.checked)} />
                護照／特殊證件號（唔驗 check digit）
              </label>
              <Field label="出生日期">
                <input type="date" className={inputCls} value={form.date_of_birth} onChange={(e) => setForm((f) => ({ ...f, date_of_birth: e.target.value }))} />
              </Field>
              <Field label="地址">
                <input className={inputCls} value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="緊急聯絡人姓名">
                  <input
                    className={inputCls}
                    value={form.emergency_contact_name}
                    onChange={(e) => setForm((f) => ({ ...f, emergency_contact_name: e.target.value }))}
                  />
                </Field>
                <Field label="緊急聯絡人電話" hint="可以 + 開頭，7-15 位數字">
                  <input
                    className={inputCls}
                    value={form.emergency_contact_tel}
                    onChange={(e) => setForm((f) => ({ ...f, emergency_contact_tel: e.target.value }))}
                  />
                </Field>
              </div>
              {/* WP-GUARD-FIX（老闆 2026-09-25 要求）：更表姓名格寫法可能
                  同系統本名唔同（花名／簡寫／曾用名）——呢個欄俾更表上載
                  配對用，hint 刻意唔提「編號」（同員工編號分工唔同）。 */}
              <Field label="更表用名（別名）" hint="逗號分隔，例如：阿明, 小明——更表寫嘅唔同姓名寫法，幫手配對更表上載">
                <input
                  className={inputCls}
                  value={form.name_aliases}
                  onChange={(e) => setForm((f) => ({ ...f, name_aliases: e.target.value }))}
                />
              </Field>

            </div>
    </>
  );
}
