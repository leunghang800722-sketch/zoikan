// 保安員 Drawer「電話／地址／緊急聯絡人」子資源（P3-5.2：由 GuardsClient.tsx
// 原樣搬出，行為零改變）。
"use client";

import { useState } from "react";
import { apiGet, apiPatch, apiPost, apiDelete, apiPut } from "@/lib/ui/api-client";
import type { ConfirmOptions } from "@/components/ui/ConfirmDialog";
import {
  emptyAddressForm,
  emptyContactForm,
  emptyPhoneForm,
  type AddressRow,
  type ContactRow,
  type PhoneRow,
} from "./guards-types";

export function useGuardContacts({
  editingId,
  askConfirm,
  setNotice,
  reloadList,
  refreshMainFormAfterContactChange,
}: {
  editingId: string | null;
  askConfirm: (opts: ConfirmOptions) => Promise<boolean>;
  setNotice: (v: string | null) => void;
  reloadList: () => Promise<void>;
  refreshMainFormAfterContactChange: () => Promise<void>;
}) {
  // WP-MULTI（老闆 2026-09-19 拍板）：電話——「主要電話照舊喺頂」＝上面
  // `form.tel`（舊寫法，經 PATCH /api/guards/:id 走 legacy path，見
  // src/lib/guards/contacts.ts applyLegacyGuardContactPatch()），呢度
  // 加多一個分區列晒所有電話（`GET .../phones`，主要 pill／label／設為
  // 主要／編輯／刪除／新增）。雞頭（isBroker）淨係讀（冇新增/編輯/刪除
  // 掣，同員工編號分區一致 UX）。
  const [phones, setPhones] = useState<PhoneRow[]>([]);
  const [phoneForm, setPhoneForm] = useState(emptyPhoneForm);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneActionBusy, setPhoneActionBusy] = useState(false);
  const [phoneActionError, setPhoneActionError] = useState<string | null>(null);
  const [phoneEditingId, setPhoneEditingId] = useState<string | null>(null);
  const [phoneEditForm, setPhoneEditForm] = useState({ tel: "", label: "", note: "" });
  // WP-MULTI：地址——同電話一致嘅分區手法（primary pill）。
  const [addresses, setAddresses] = useState<AddressRow[]>([]);
  const [addressForm, setAddressForm] = useState(emptyAddressForm);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [addressSaving, setAddressSaving] = useState(false);
  const [addressActionBusy, setAddressActionBusy] = useState(false);
  const [addressActionError, setAddressActionError] = useState<string | null>(null);
  const [addressEditingId, setAddressEditingId] = useState<string | null>(null);
  const [addressEditForm, setAddressEditForm] = useState({ address: "", note: "" });
  // WP-MULTI：緊急聯絡人——冇「主要」概念，用 sort_order 排先後（列表
  // 已經跟 `GET .../emergency-contacts` 排好序，唔使前端再排一次）。
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [contactForm, setContactForm] = useState(emptyContactForm);
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactActionBusy, setContactActionBusy] = useState(false);
  const [contactActionError, setContactActionError] = useState<string | null>(null);
  const [contactEditingId, setContactEditingId] = useState<string | null>(null);
  const [contactEditForm, setContactEditForm] = useState({ name: "", tel: "", relationship: "", note: "" });

  // WP-MULTI：抽屜開緊嗰個人嘅電話／地址／緊急聯絡人——冇權（403，例如
  // 雞頭睇地址／緊急聯絡人）就保持空陣列，對應分區靠 `hasPiiField`／
  // `isBroker` 唔顯示，唔靠呢度嘅 fetch 結果判斷顯唔顯示。
  async function loadPhones(guardId: string) {
    const res = await apiGet<PhoneRow[]>(`/api/guards/${guardId}/phones`);
    setPhones(res.ok ? res.data : []);
  }

  async function loadAddresses(guardId: string) {
    const res = await apiGet<AddressRow[]>(`/api/guards/${guardId}/addresses`);
    setAddresses(res.ok ? res.data : []);
  }

  async function loadContacts(guardId: string) {
    const res = await apiGet<ContactRow[]>(`/api/guards/${guardId}/emergency-contacts`);
    setContacts(res.ok ? res.data : []);
  }

  // -------------------------------------------------------------------
  // 電話
  // -------------------------------------------------------------------
  async function onAddPhone() {
    if (!editingId) return;
    setPhoneSaving(true);
    setPhoneError(null);
    const res = await apiPost<PhoneRow>(`/api/guards/${editingId}/phones`, {
      tel: phoneForm.tel,
      label: phoneForm.label || undefined,
      note: phoneForm.note || undefined,
    });
    setPhoneSaving(false);
    if (!res.ok) {
      setPhoneError(res.message);
      return;
    }
    setPhoneForm(emptyPhoneForm);
    setNotice("已新增電話");
    await loadPhones(editingId);
    await reloadList();
    await refreshMainFormAfterContactChange();
  }

  async function onSetPhonePrimary(row: PhoneRow) {
    if (!editingId || row.is_primary) return;
    setPhoneActionBusy(true);
    setPhoneActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/phones/${row.id}`, { is_primary: true });
    setPhoneActionBusy(false);
    if (!res.ok) {
      setPhoneActionError(res.message);
      return;
    }
    setNotice(`已將 ${row.tel} 設做主要電話`);
    await loadPhones(editingId);
    await reloadList();
    await refreshMainFormAfterContactChange();
  }

  function onOpenPhoneEdit(row: PhoneRow) {
    setPhoneEditingId(row.id);
    setPhoneActionError(null);
    setPhoneEditForm({ tel: row.tel, label: row.label ?? "", note: row.note ?? "" });
  }

  function onCancelPhoneEdit() {
    setPhoneEditingId(null);
    setPhoneActionError(null);
  }

  async function onSavePhoneEdit() {
    if (!editingId || !phoneEditingId) return;
    setPhoneActionBusy(true);
    setPhoneActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/phones/${phoneEditingId}`, {
      tel: phoneEditForm.tel,
      label: phoneEditForm.label || null,
      note: phoneEditForm.note || null,
    });
    setPhoneActionBusy(false);
    if (!res.ok) {
      setPhoneActionError(res.message);
      return;
    }
    setPhoneEditingId(null);
    setNotice("已更新電話");
    await loadPhones(editingId);
    await reloadList();
    await refreshMainFormAfterContactChange();
  }

  async function onDeletePhone(row: PhoneRow) {
    if (!editingId) return;
    const confirmed = await askConfirm({ message: `確定要刪走電話 ${row.tel}？（更正打錯用，audit_log 留底）`, confirmLabel: "刪走", tone: "danger" });
    if (!confirmed) return;
    setPhoneActionBusy(true);
    setPhoneActionError(null);
    const res = await apiDelete(`/api/guards/${editingId}/phones/${row.id}`);
    setPhoneActionBusy(false);
    if (!res.ok) {
      setPhoneActionError(res.message);
      return;
    }
    setNotice(`已刪走電話 ${row.tel}`);
    await loadPhones(editingId);
    await reloadList();
    await refreshMainFormAfterContactChange();
  }

  // -------------------------------------------------------------------
  // 地址
  // -------------------------------------------------------------------
  async function onAddAddress() {
    if (!editingId) return;
    setAddressSaving(true);
    setAddressError(null);
    const res = await apiPost<AddressRow>(`/api/guards/${editingId}/addresses`, { address: addressForm.address, note: addressForm.note || undefined });
    setAddressSaving(false);
    if (!res.ok) {
      setAddressError(res.message);
      return;
    }
    setAddressForm(emptyAddressForm);
    setNotice("已新增地址");
    await loadAddresses(editingId);
    await refreshMainFormAfterContactChange();
  }

  async function onSetAddressPrimary(row: AddressRow) {
    if (!editingId || row.is_primary) return;
    setAddressActionBusy(true);
    setAddressActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/addresses/${row.id}`, { is_primary: true });
    setAddressActionBusy(false);
    if (!res.ok) {
      setAddressActionError(res.message);
      return;
    }
    setNotice("已設做主要地址");
    await loadAddresses(editingId);
    await refreshMainFormAfterContactChange();
  }

  function onOpenAddressEdit(row: AddressRow) {
    setAddressEditingId(row.id);
    setAddressActionError(null);
    setAddressEditForm({ address: row.address, note: row.note ?? "" });
  }

  function onCancelAddressEdit() {
    setAddressEditingId(null);
    setAddressActionError(null);
  }

  async function onSaveAddressEdit() {
    if (!editingId || !addressEditingId) return;
    setAddressActionBusy(true);
    setAddressActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/addresses/${addressEditingId}`, { address: addressEditForm.address, note: addressEditForm.note || null });
    setAddressActionBusy(false);
    if (!res.ok) {
      setAddressActionError(res.message);
      return;
    }
    setAddressEditingId(null);
    setNotice("已更新地址");
    await loadAddresses(editingId);
    await refreshMainFormAfterContactChange();
  }

  async function onDeleteAddress(row: AddressRow) {
    if (!editingId) return;
    const confirmed = await askConfirm({ message: "確定要刪走呢個地址？（更正打錯用，audit_log 留底）", confirmLabel: "刪走", tone: "danger" });
    if (!confirmed) return;
    setAddressActionBusy(true);
    setAddressActionError(null);
    const res = await apiDelete(`/api/guards/${editingId}/addresses/${row.id}`);
    setAddressActionBusy(false);
    if (!res.ok) {
      setAddressActionError(res.message);
      return;
    }
    setNotice("已刪走地址");
    await loadAddresses(editingId);
    await refreshMainFormAfterContactChange();
  }

  // -------------------------------------------------------------------
  // 緊急聯絡人
  // -------------------------------------------------------------------
  async function onAddContact() {
    if (!editingId) return;
    setContactSaving(true);
    setContactError(null);
    const res = await apiPost<ContactRow>(`/api/guards/${editingId}/emergency-contacts`, {
      name: contactForm.name || undefined,
      tel: contactForm.tel || undefined,
      relationship: contactForm.relationship || undefined,
      note: contactForm.note || undefined,
    });
    setContactSaving(false);
    if (!res.ok) {
      setContactError(res.message);
      return;
    }
    setContactForm(emptyContactForm);
    setNotice("已新增緊急聯絡人");
    await loadContacts(editingId);
    await refreshMainFormAfterContactChange();
  }

  function onOpenContactEdit(row: ContactRow) {
    setContactEditingId(row.id);
    setContactActionError(null);
    setContactEditForm({ name: row.name ?? "", tel: row.tel ?? "", relationship: row.relationship ?? "", note: row.note ?? "" });
  }

  function onCancelContactEdit() {
    setContactEditingId(null);
    setContactActionError(null);
  }

  async function onSaveContactEdit() {
    if (!editingId || !contactEditingId) return;
    setContactActionBusy(true);
    setContactActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/emergency-contacts/${contactEditingId}`, {
      name: contactEditForm.name || null,
      tel: contactEditForm.tel || null,
      relationship: contactEditForm.relationship || null,
      note: contactEditForm.note || null,
    });
    setContactActionBusy(false);
    if (!res.ok) {
      setContactActionError(res.message);
      return;
    }
    setContactEditingId(null);
    setNotice("已更新緊急聯絡人");
    await loadContacts(editingId);
    await refreshMainFormAfterContactChange();
  }

  async function onDeleteContact(row: ContactRow) {
    if (!editingId) return;
    const confirmed = await askConfirm({ message: `確定要刪走呢個緊急聯絡人${row.name ? `（${row.name}）` : ""}？（更正打錯用，audit_log 留底）`, confirmLabel: "刪走", tone: "danger" });
    if (!confirmed) return;
    setContactActionBusy(true);
    setContactActionError(null);
    const res = await apiDelete(`/api/guards/${editingId}/emergency-contacts/${row.id}`);
    setContactActionBusy(false);
    if (!res.ok) {
      setContactActionError(res.message);
      return;
    }
    setNotice("已刪走緊急聯絡人");
    await loadContacts(editingId);
    await refreshMainFormAfterContactChange();
  }

  // 排序——撳「較先」/「較後」同鄰居換位，一齊送落新嘅
  // `PUT .../emergency-contacts/order` 端點（一個 transaction 重寫成個
  // guard 全部行嘅 `sort_order`，原子性；之前分兩次 PATCH 互換有短暫
  // 窗口冇原子性，Opus 覆核必修 6 改用呢個）。
  async function onMoveContact(index: number, direction: -1 | 1) {
    if (!editingId) return;
    const neighbourIndex = index + direction;
    const target = contacts[index];
    const neighbour = contacts[neighbourIndex];
    if (!target || !neighbour) return;
    const ids = contacts.map((c) => c.id);
    const tmp = ids[index]!;
    ids[index] = ids[neighbourIndex]!;
    ids[neighbourIndex] = tmp;
    setContactActionBusy(true);
    setContactActionError(null);
    const res = await apiPut(`/api/guards/${editingId}/emergency-contacts/order`, { ids });
    setContactActionBusy(false);
    if (!res.ok) {
      setContactActionError(res.message);
      return;
    }
    await loadContacts(editingId);
    await refreshMainFormAfterContactChange();
  }

  // openCreate()／openEdit() 重置（搬自原本兩個函數）。
  function resetForCreate() {
    setPhones([]);
    setAddresses([]);
    setContacts([]);
    resetForEdit();
  }
  function resetForEdit() {
    setPhoneForm(emptyPhoneForm);
    setPhoneError(null);
    setPhoneEditingId(null);
    setPhoneActionError(null);
    setAddressForm(emptyAddressForm);
    setAddressError(null);
    setAddressEditingId(null);
    setAddressActionError(null);
    setContactForm(emptyContactForm);
    setContactError(null);
    setContactEditingId(null);
    setContactActionError(null);
  }

  return {
    phones,
    phoneForm,
    phoneError,
    phoneSaving,
    phoneActionBusy,
    phoneActionError,
    phoneEditingId,
    phoneEditForm,
    addresses,
    addressForm,
    addressError,
    addressSaving,
    addressActionBusy,
    addressActionError,
    addressEditingId,
    addressEditForm,
    contacts,
    contactForm,
    contactError,
    contactSaving,
    contactActionBusy,
    contactActionError,
    contactEditingId,
    contactEditForm,
    setPhoneForm,
    setPhoneEditForm,
    setAddressForm,
    setAddressEditForm,
    setContactForm,
    setContactEditForm,
    loadPhones,
    loadAddresses,
    loadContacts,
    onAddPhone,
    onSetPhonePrimary,
    onOpenPhoneEdit,
    onCancelPhoneEdit,
    onSavePhoneEdit,
    onDeletePhone,
    onAddAddress,
    onSetAddressPrimary,
    onOpenAddressEdit,
    onCancelAddressEdit,
    onSaveAddressEdit,
    onDeleteAddress,
    onAddContact,
    onOpenContactEdit,
    onCancelContactEdit,
    onSaveContactEdit,
    onDeleteContact,
    onMoveContact,
    resetForCreate,
    resetForEdit,
  };
}
