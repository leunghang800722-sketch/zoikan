// 保安員 Drawer「銀行」tab。
// P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變。
"use client";

import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { HKICL_BANK_OPTIONS } from "@/lib/longterm-payroll/hkicl-bank-codes";
import type { GuardForm } from "../useGuardForm";

export function BankTab({ g, tabCls, hasBankField }: { g: GuardForm; tabCls: (t: string) => string, hasBankField: boolean }) {
  const { editingId, form, setForm } = g;
  return (
    <>
          {editingId && hasBankField && (
            <div className={tabCls("bank")} data-testid="guard-tab-panel-bank">
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">銀行</h3>
              <Field label="銀行">
                <input className={inputCls} value={form.bank_name} onChange={(e) => setForm((f) => ({ ...f, bank_name: e.target.value }))} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="戶口號碼">
                  <input className={inputCls} value={form.bank_account_no} onChange={(e) => setForm((f) => ({ ...f, bank_account_no: e.target.value }))} />
                </Field>
                <Field label="收款人名">
                  <input className={inputCls} value={form.bank_payee_name} onChange={(e) => setForm((f) => ({ ...f, bank_payee_name: e.target.value }))} />
                </Field>
              </div>
              {/* WP-BOSS5 §25.4（老闆 2026-09-28 決定 6）：BOCHK Payroll
                  Editor 要 3 位 HKICL 銀行編號——淨係提供「建議下拉」，
                  唔會憑上面「銀行」自由文字自動填；揀咗先寫入呢個輸入
                  格，會計都可以人手改／直接打冇喺建議清單嘅 3 位碼。 */}
              <div className="grid grid-cols-2 gap-2">
                <Field label="銀行編號（HKICL，3 位）" hint="BOCHK Payroll Editor 用；建議下拉揀咗先入呢格，唔會自動填">
                  <input
                    className={inputCls}
                    value={form.bank_code}
                    maxLength={3}
                    placeholder="例：004"
                    onChange={(e) => setForm((f) => ({ ...f, bank_code: e.target.value.replace(/[^0-9]/g, "").slice(0, 3) }))}
                  />
                </Field>
                <Field label="建議（常見銀行）">
                  <select
                    className={selectCls}
                    value=""
                    onChange={(e) => {
                      if (e.target.value) setForm((f) => ({ ...f, bank_code: e.target.value }));
                    }}
                  >
                    <option value="">（揀常見銀行帶入編號）</option>
                    {HKICL_BANK_OPTIONS.map((b) => (
                      <option key={b.code} value={b.code}>
                        {b.nameZhShort}（{b.code}）
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </div>
          )}
    </>
  );
}
