// 保安員 Drawer「長工」子資源（崗位盤／轉長工）（P3-5.2：由 GuardsClient.tsx
// 原樣搬出，行為零改變）。
"use client";

import { useState } from "react";
import { apiGet, apiPatch, apiPost } from "@/lib/ui/api-client";
import { todayLocalStr } from "@/lib/ui/format";
import { emptyConvertForm, emptyLongtermPostForm, type LongtermPostRow } from "./guards-types";

export function useGuardLongterm({
  editingId,
  setNotice,
  reloadList,
  reopenEditing,
}: {
  editingId: string | null;
  setNotice: (v: string | null) => void;
  reloadList: () => Promise<void>;
  /** 轉長工成功之後重新打開（重新 GET）而家編輯緊嗰個保安員。 */
  reopenEditing: () => Promise<void>;
}) {
  const [longtermPosts, setLongtermPosts] = useState<LongtermPostRow[]>([]);
  const [longtermPostForm, setLongtermPostForm] = useState(emptyLongtermPostForm);
  const [longtermPostError, setLongtermPostError] = useState<string | null>(null);
  const [longtermPostSaving, setLongtermPostSaving] = useState(false);
  const [longtermPostActionBusy, setLongtermPostActionBusy] = useState(false);
  // WP-PHASE3（item 2）：「轉長工」一步動作——獨立細 modal，唔佔主 form。
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertForm, setConvertForm] = useState(emptyConvertForm);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [convertSaving, setConvertSaving] = useState(false);

  // WP-PHASE3（item 1）：抽屜開緊嗰個人嘅長工崗位盤——冇權（403，雞頭
  // 唔會行呢條 code path，但保守都係「冇權就得返空陣列」一致做法）就
  // 保持空。
  async function loadLongtermPosts(guardId: string) {
    const res = await apiGet<LongtermPostRow[]>(`/api/guards/${guardId}/longterm-posts`);
    setLongtermPosts(res.ok ? res.data : []);
  }

  // WP-PHASE3（item 1）：抽屜「長工」區——「加崗位盤」（POST /api/guards/
  // :id/longterm-posts）。同 onAddStaffNumber() 一致 pattern：獨立
  // `type="button"`，唔喺主 form submit 事件入面。
  async function onAddLongtermPost() {
    if (!editingId || !longtermPostForm.site_id) return;
    setLongtermPostSaving(true);
    setLongtermPostError(null);
    const res = await apiPost(`/api/guards/${editingId}/longterm-posts`, {
      site_id: longtermPostForm.site_id,
      effective_from: longtermPostForm.effective_from || todayLocalStr(),
      note: longtermPostForm.note || undefined,
    });
    setLongtermPostSaving(false);
    if (!res.ok) {
      setLongtermPostError(res.message);
      return;
    }
    setLongtermPostForm(emptyLongtermPostForm);
    await loadLongtermPosts(editingId);
    setNotice("已加長工崗位盤");
  }

  // 「終止」＝PATCH effective_to=今日（冇硬刪，同 staff_numbers／
  // rate_cards 一致精神）。
  async function onTerminateLongtermPost(postId: string) {
    if (!editingId) return;
    setLongtermPostActionBusy(true);
    setLongtermPostError(null);
    const res = await apiPatch(`/api/guards/${editingId}/longterm-posts/${postId}`, { effective_to: todayLocalStr() });
    setLongtermPostActionBusy(false);
    if (!res.ok) {
      setLongtermPostError(res.message);
      return;
    }
    await loadLongtermPosts(editingId);
    setNotice("已終止呢個崗位盤");
  }

  // WP-PHASE3（item 2）：「轉長工」一步動作——POST /api/guards/:id/
  // convert-to-longterm。撳掣先開 mini modal（`convertOpen`），揀盤／
  // 生效日／介紹雞頭／起始月薪一齊送，成功之後 `load()`＋`openEdit()`
  // 重新攞返最新 employment_type／崗位盤／合約狀態。
  async function onSubmitConvert() {
    if (!editingId || !convertForm.site_id) return;
    setConvertSaving(true);
    setConvertError(null);
    const body: Record<string, unknown> = {
      site_id: convertForm.site_id,
      effective_from: convertForm.effective_from || todayLocalStr(),
      referral_broker_id: convertForm.referral_broker_id || undefined,
    };
    if (convertForm.monthly_salary !== "") body.monthly_salary = Number(convertForm.monthly_salary);
    const res = await apiPost<{ warning: string | null }>(`/api/guards/${editingId}/convert-to-longterm`, body);
    setConvertSaving(false);
    if (!res.ok) {
      setConvertError(res.message);
      return;
    }
    setConvertOpen(false);
    setConvertForm(emptyConvertForm);
    setNotice(res.data.warning ? `已轉長工——${res.data.warning}` : "已轉長工");
    await reopenEditing();
    await reloadList();
  }

  // openCreate()／openEdit() 重置（搬自原本兩個函數）。
  function resetForCreate() {
    setLongtermPosts([]);
    resetForEdit();
  }
  function resetForEdit() {
    setLongtermPostForm(emptyLongtermPostForm);
    setLongtermPostError(null);
    setConvertOpen(false);
    setConvertForm(emptyConvertForm);
    setConvertError(null);
  }

  return {
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
    loadLongtermPosts,
    onAddLongtermPost,
    onTerminateLongtermPost,
    onSubmitConvert,
    resetForCreate,
    resetForEdit,
  };
}
