// 保安員 Drawer「聯絡」tab 區塊（所有電話／地址列表／緊急聯絡人列表）。
// P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變。
"use client";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field, inputCls } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import type { AddressRow, ContactRow, PhoneRow } from "../guards-types";
import type { GuardForm } from "../useGuardForm";

export function PhonesSection({ g, tabCls, isBroker }: { g: GuardForm; tabCls: (t: string) => string; isBroker: boolean }) {
  const { editingId, contactsH } = g;
  const {
    phones,
    phoneForm,
    phoneError,
    phoneSaving,
    phoneActionBusy,
    phoneActionError,
    phoneEditingId,
    phoneEditForm,
    setPhoneForm,
    setPhoneEditForm,
    onAddPhone,
    onSetPhonePrimary,
    onOpenPhoneEdit,
    onCancelPhoneEdit,
    onSavePhoneEdit,
    onDeletePhone,
  } = contactsH;

  // WP-MULTI：電話分區每行——主要 pill／label／（!isBroker 先有）「設為
  // 主要」／「編輯」／「刪除」，call PATCH/DELETE .../phones/:phoneId。
  function renderPhoneRow(p: PhoneRow) {
    const isEditing = phoneEditingId === p.id;
    return (
      <div key={p.id} className="rounded-[7px] border border-zk-border px-2.5 py-1.5 text-zk-base">
        <div className="flex flex-wrap items-center gap-2">
          <span className={p.is_primary ? "font-medium text-zk-text" : undefined}>{p.tel}</span>
          {p.is_primary ? <Pill variant="success">主要</Pill> : null}
          {p.label && <Pill variant="neutral">{p.label}</Pill>}
          {!isBroker && (
            <div className="ml-auto flex gap-1.5">
              {!p.is_primary && (
                <Button variant="link" size="sm" type="button" disabled={phoneActionBusy} onClick={() => onSetPhonePrimary(p)}>
                  設為主要
                </Button>
              )}
              <Button variant="link" size="sm" type="button" onClick={() => (isEditing ? onCancelPhoneEdit() : onOpenPhoneEdit(p))}>
                {isEditing ? "取消編輯" : "編輯"}
              </Button>
              <Button variant="linkDanger" size="sm" type="button" disabled={phoneActionBusy} onClick={() => onDeletePhone(p)}>
                刪除
              </Button>
            </div>
          )}
        </div>
        {isEditing && (
          <div className="mt-2 space-y-2 border-t border-zk-border pt-2">
            <Banner kind="error" message={phoneActionError} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="號碼">
                <input className={inputCls} value={phoneEditForm.tel} onChange={(e) => setPhoneEditForm((f) => ({ ...f, tel: e.target.value }))} />
              </Field>
              <Field label="標籤（選填）" hint="例：本人／屋企／WhatsApp">
                <input className={inputCls} value={phoneEditForm.label} onChange={(e) => setPhoneEditForm((f) => ({ ...f, label: e.target.value }))} />
              </Field>
            </div>
            <Field label="備註（選填）">
              <input className={inputCls} value={phoneEditForm.note} onChange={(e) => setPhoneEditForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" type="button" disabled={phoneActionBusy} onClick={onSavePhoneEdit}>
                {phoneActionBusy ? "儲存緊…" : "儲存"}
              </Button>
              <Button variant="secondary" size="sm" type="button" onClick={onCancelPhoneEdit}>
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
          {/* WP-MULTI（老闆 2026-09-19 拍板「全部資料都要保留，唔好揀
              一個」）：主要電話照舊喺頂（above），呢度加多一個分區列晒
              所有電話（有幾多個記幾多個）。新增保安員嗰陣（!editingId）
              個 guard 仲未存在，同員工編號分區一致淨係編輯先顯示。 */}
          {editingId && (
            <div className={tabCls("contact")} data-testid="guard-tab-panel-contact">
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">所有電話</h3>
              {phones.length === 0 ? (
                <div className="text-sm text-zk-muted">未有記錄電話</div>
              ) : (
                <div className="space-y-1.5">{phones.map(renderPhoneRow)}</div>
              )}
              {!isBroker && (
                <div className="rounded-[7px] border border-dashed border-zk-border p-2.5">
                  <Banner kind="error" message={phoneError} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="新增電話號碼">
                      <input className={inputCls} value={phoneForm.tel} onChange={(e) => setPhoneForm((f) => ({ ...f, tel: e.target.value }))} placeholder="例：61234567" />
                    </Field>
                    <Field label="標籤（選填）" hint="例：本人／屋企／WhatsApp">
                      <input className={inputCls} value={phoneForm.label} onChange={(e) => setPhoneForm((f) => ({ ...f, label: e.target.value }))} />
                    </Field>
                  </div>
                  <Button variant="secondary" size="sm" type="button" disabled={phoneSaving || !phoneForm.tel} onClick={onAddPhone} className="mt-2">
                    {phoneSaving ? "新增緊…" : "新增電話"}
                  </Button>
                </div>
              )}
            </div>
          )}
    </>
  );
}

export function AddressContactSection({ g, tabCls, isBroker }: { g: GuardForm; tabCls: (t: string) => string; isBroker: boolean }) {
  const { contactsH } = g;
  const {
    addresses,
    addressForm,
    addressError,
    addressSaving,
    addressActionBusy,
    addressActionError,
    addressEditingId,
    addressEditForm,
    setAddressForm,
    setAddressEditForm,
    onAddAddress,
    onSetAddressPrimary,
    onOpenAddressEdit,
    onCancelAddressEdit,
    onSaveAddressEdit,
    onDeleteAddress,
    contacts,
    contactForm,
    contactError,
    contactSaving,
    contactActionBusy,
    contactActionError,
    contactEditingId,
    contactEditForm,
    setContactForm,
    setContactEditForm,
    onAddContact,
    onOpenContactEdit,
    onCancelContactEdit,
    onSaveContactEdit,
    onDeleteContact,
    onMoveContact,
  } = contactsH;

  // WP-MULTI：地址分區每行——同電話一致嘅 primary pill 手法。
  function renderAddressRow(a: AddressRow) {
    const isEditing = addressEditingId === a.id;
    return (
      <div key={a.id} className="rounded-[7px] border border-zk-border px-2.5 py-1.5 text-zk-base">
        <div className="flex flex-wrap items-center gap-2">
          <span className={a.is_primary ? "font-medium text-zk-text" : undefined}>{a.address}</span>
          {a.is_primary ? <Pill variant="success">主要</Pill> : null}
          {!isBroker && (
            <div className="ml-auto flex gap-1.5">
              {!a.is_primary && (
                <Button variant="link" size="sm" type="button" disabled={addressActionBusy} onClick={() => onSetAddressPrimary(a)}>
                  設為主要
                </Button>
              )}
              <Button variant="link" size="sm" type="button" onClick={() => (isEditing ? onCancelAddressEdit() : onOpenAddressEdit(a))}>
                {isEditing ? "取消編輯" : "編輯"}
              </Button>
              <Button variant="linkDanger" size="sm" type="button" disabled={addressActionBusy} onClick={() => onDeleteAddress(a)}>
                刪除
              </Button>
            </div>
          )}
        </div>
        {isEditing && (
          <div className="mt-2 space-y-2 border-t border-zk-border pt-2">
            <Banner kind="error" message={addressActionError} />
            <Field label="地址">
              <input className={inputCls} value={addressEditForm.address} onChange={(e) => setAddressEditForm((f) => ({ ...f, address: e.target.value }))} />
            </Field>
            <Field label="備註（選填）">
              <input className={inputCls} value={addressEditForm.note} onChange={(e) => setAddressEditForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" type="button" disabled={addressActionBusy} onClick={onSaveAddressEdit}>
                {addressActionBusy ? "儲存緊…" : "儲存"}
              </Button>
              <Button variant="secondary" size="sm" type="button" onClick={onCancelAddressEdit}>
                取消
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // WP-MULTI：緊急聯絡人分區每行——冇「主要」，用「較先」/「較後」兩粒
  // 箭嘴掣同鄰居互換 sort_order（`index` 係喺 `contacts`（已經跟
  // sort_order 排好序）入面嘅位置）。
  function renderContactRow(c: ContactRow, index: number) {
    const isEditing = contactEditingId === c.id;
    return (
      <div key={c.id} className="rounded-[7px] border border-zk-border px-2.5 py-1.5 text-zk-base">
        <div className="flex flex-wrap items-center gap-2">
          {index === 0 && <Pill variant="success">代表（同步落舊欄）</Pill>}
          <span className="font-medium text-zk-text">{c.name || "（未填姓名）"}</span>
          {c.tel && <span className="text-zk-muted">{c.tel}</span>}
          {c.relationship && <Pill variant="neutral">{c.relationship}</Pill>}
          {!isBroker && (
            <div className="ml-auto flex gap-1.5">
              <Button variant="link" size="sm" type="button" disabled={contactActionBusy || index === 0} onClick={() => onMoveContact(index, -1)}>
                較先
              </Button>
              <Button variant="link" size="sm"
                type="button"
                disabled={contactActionBusy || index === contacts.length - 1}
                onClick={() => onMoveContact(index, 1)}

              >
                較後
              </Button>
              <Button variant="link" size="sm" type="button" onClick={() => (isEditing ? onCancelContactEdit() : onOpenContactEdit(c))}>
                {isEditing ? "取消編輯" : "編輯"}
              </Button>
              <Button variant="linkDanger" size="sm" type="button" disabled={contactActionBusy} onClick={() => onDeleteContact(c)}>
                刪除
              </Button>
            </div>
          )}
        </div>
        {isEditing && (
          <div className="mt-2 space-y-2 border-t border-zk-border pt-2">
            <Banner kind="error" message={contactActionError} />
            <div className="grid grid-cols-2 gap-2">
              <Field label="姓名">
                <input className={inputCls} value={contactEditForm.name} onChange={(e) => setContactEditForm((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="電話">
                <input className={inputCls} value={contactEditForm.tel} onChange={(e) => setContactEditForm((f) => ({ ...f, tel: e.target.value }))} />
              </Field>
            </div>
            <Field label="關係（選填）" hint="例：配偶／父母／子女">
              <input className={inputCls} value={contactEditForm.relationship} onChange={(e) => setContactEditForm((f) => ({ ...f, relationship: e.target.value }))} />
            </Field>
            <Field label="備註（選填）">
              <input className={inputCls} value={contactEditForm.note} onChange={(e) => setContactEditForm((f) => ({ ...f, note: e.target.value }))} />
            </Field>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" type="button" disabled={contactActionBusy} onClick={onSaveContactEdit}>
                {contactActionBusy ? "儲存緊…" : "儲存"}
              </Button>
              <Button variant="secondary" size="sm" type="button" onClick={onCancelContactEdit}>
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
            <div className={tabCls("contact")} data-testid="guard-tab-panel-contact-addr">
              {/* WP-MULTI（老闆 2026-09-19 拍板，規劃師延伸同一原則）：
                  上面「地址」單一 input 照舊（快速改主要地址，經 PATCH
                  舊寫法），呢度加地址列表（可以多個，一個主要）。 */}
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">地址列表</h3>
              {addresses.length === 0 ? (
                <div className="text-sm text-zk-muted">未有記錄地址</div>
              ) : (
                <div className="space-y-1.5">{addresses.map(renderAddressRow)}</div>
              )}
              {!isBroker && (
                <div className="rounded-[7px] border border-dashed border-zk-border p-2.5">
                  <Banner kind="error" message={addressError} />
                  <Field label="新增地址">
                    <input className={inputCls} value={addressForm.address} onChange={(e) => setAddressForm((f) => ({ ...f, address: e.target.value }))} />
                  </Field>
                  <Button variant="secondary" size="sm" type="button" disabled={addressSaving || !addressForm.address} onClick={onAddAddress} className="mt-2">
                    {addressSaving ? "新增緊…" : "新增地址"}
                  </Button>
                </div>
              )}

              {/* 上面「緊急聯絡人姓名／電話」兩個 input 照舊（快速改代表
                  行，經 PATCH 舊寫法），呢度加緊急聯絡人列表（可以多個，
                  可加／改／刪／排序）。 */}
              <h3 className="border-t border-zk-border pt-3 text-xs font-semibold text-zk-faint">緊急聯絡人列表</h3>
              <p className="text-xs text-zk-muted">排先個位（「代表」）會同步落上面嘅「緊急聯絡人姓名／電話」。</p>
              {contacts.length === 0 ? (
                <div className="text-sm text-zk-muted">未有記錄緊急聯絡人</div>
              ) : (
                <div className="space-y-1.5">{contacts.map((c, i) => renderContactRow(c, i))}</div>
              )}
              {!isBroker && (
                <div className="rounded-[7px] border border-dashed border-zk-border p-2.5">
                  <Banner kind="error" message={contactError} />
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="姓名（新增聯絡人）">
                      <input className={inputCls} value={contactForm.name} onChange={(e) => setContactForm((f) => ({ ...f, name: e.target.value }))} />
                    </Field>
                    <Field label="電話（新增聯絡人）">
                      <input className={inputCls} value={contactForm.tel} onChange={(e) => setContactForm((f) => ({ ...f, tel: e.target.value }))} />
                    </Field>
                  </div>
                  <Field label="關係（選填）" hint="例：配偶／父母／子女">
                    <input className={inputCls} value={contactForm.relationship} onChange={(e) => setContactForm((f) => ({ ...f, relationship: e.target.value }))} />
                  </Field>
                  <Button variant="secondary" size="sm"
                    type="button"
                    disabled={contactSaving || (!contactForm.name && !contactForm.tel)}
                    onClick={onAddContact} className="mt-2">
                    {contactSaving ? "新增緊…" : "新增緊急聯絡人"}
                  </Button>
                </div>
              )}

            </div>
    </>
  );
}
