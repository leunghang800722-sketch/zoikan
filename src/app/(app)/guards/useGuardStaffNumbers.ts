// 保安員 Drawer「員工編號」子資源（P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變）。
"use client";

import { useState } from "react";
import { apiGet, apiPatch, apiPost } from "@/lib/ui/api-client";
import type { ConfirmOptions } from "@/components/ui/ConfirmDialog";
import { emptyStaffNumberForm, type GuardRow, type StaffNumberRow } from "./guards-types";

export function useGuardStaffNumbers({
  editingId,
  askConfirm,
  setNotice,
  reloadList,
  fillFormFromRow,
}: {
  editingId: string | null;
  askConfirm: (opts: ConfirmOptions) => Promise<boolean>;
  setNotice: (v: string | null) => void;
  reloadList: () => Promise<void>;
  fillFormFromRow: (row: GuardRow) => void;
}) {
  // WP-STAFFNO：員工編號獨立表——編輯抽屜開嗰陣先另外 GET
  // `/api/guards/:id/staff-numbers`（current+former），唔喺主列表/詳情
  // 攞（列表淨係 additive 嘅 current chips）。雞頭（`isBroker`）淨係讀
  // （冇「新增編號」表單，見下面 render）。
  const [staffNumbers, setStaffNumbers] = useState<StaffNumberRow[]>([]);
  const [staffNumberForm, setStaffNumberForm] = useState(emptyStaffNumberForm);
  const [staffNumberError, setStaffNumberError] = useState<string | null>(null);
  const [staffNumberSaving, setStaffNumberSaving] = useState(false);
  // 已取消（former）號預設摺埋——「顯示已取消嘅號 N 個」撳咗先展開。
  const [showFormerStaffNumbers, setShowFormerStaffNumbers] = useState(false);
  // S7：每行員工編號「取消呢個號」／「改返現用」／「編輯（號碼／生效期／
  // 備註）」——`numberEditingId` 有值就顯示緊嗰行嘅 inline 編輯表單。
  const [numberActionBusy, setNumberActionBusy] = useState(false);
  const [numberActionError, setNumberActionError] = useState<string | null>(null);
  const [numberEditingId, setNumberEditingId] = useState<string | null>(null);
  const [numberEditForm, setNumberEditForm] = useState({ number: "", valid_from: "", valid_to: "", note: "", end_reason: "" });
  // EMP-P1：結束一張卡（→已取消）必須填離職／停用日＋原因
  const [numberEndingId, setNumberEndingId] = useState<string | null>(null);
  const [numberEndForm, setNumberEndForm] = useState({ valid_to: "", end_reason: "resigned" });

  // WP-STAFFNO：抽屜開緊嗰個人嘅員工編號（current+former），俾「員工
  // 編號」分區用。
  async function loadStaffNumbers(guardId: string) {
    const res = await apiGet<StaffNumberRow[]>(`/api/guards/${guardId}/staff-numbers`);
    if (res.ok) setStaffNumbers(res.data);
  }

  // WP-STAFFNO：抽屜「員工編號」分區嘅「新增」——POST
  // `/api/guards/:id/staff-numbers`。淨係編輯（`editingId` 有值）先用得
  // 到（新增保安員嗰陣個 guard 仲未存在）；掛喺一個獨立 `type="button"`
  // 撳掣（唔係 nested `<form>` submit——HTML 唔准 form 入面再有 form，
  // 呢個分區本身喺編輯保安員嗰個大 `<form onSubmit={onSubmit}>` 入面）。
  async function onAddStaffNumber() {
    if (!editingId) return;
    setStaffNumberSaving(true);
    setStaffNumberError(null);
    const scheme = staffNumberForm.scheme === "其他" ? staffNumberForm.schemeOther.trim().toUpperCase() : staffNumberForm.scheme;
    const hist = staffNumberForm.historical;
    const res = await apiPost<{ converted_former?: { number: string } | null }>(`/api/guards/${editingId}/staff-numbers`, {
      scheme,
      number: staffNumberForm.number,
      valid_from: staffNumberForm.valid_from || undefined,
      note: staffNumberForm.note || undefined,
      // EMP-P1：補歷史卡＝status former＋離職日＋原因；換號＝replaces_current
      ...(hist ? { status: "former", valid_to: staffNumberForm.valid_to || undefined, end_reason: staffNumberForm.end_reason } : {}),
      ...(!hist && staffNumberForm.replaces_current ? { replaces_current: true } : {}),
    });
    setStaffNumberSaving(false);
    if (!res.ok) {
      setStaffNumberError(res.message);
      return;
    }
    setStaffNumberForm({ ...emptyStaffNumberForm, scheme: staffNumberForm.scheme });
    setNotice(
      res.data.converted_former
        ? `已新增 ${scheme} 號，原本嘅 ${res.data.converted_former.number} 已標示為被取代（換號）`
        : hist
          ? `已補 ${scheme} 歷史號`
          : `已新增 ${scheme} 號`,
    );
    await loadStaffNumbers(editingId);
    await reloadList(); // 令列表 chips 即時反映新現用號
    // 主表單頂部嘅「工號」／「工號（MW）」（舊欄，PATCH 支援舊寫法）
    // 唔可以留低啱先起草嗰陣嘅舊值——如果新增咗 U／MG／MW 號，`guards.
    // staff_no`／`staff_no_mw` 已經由後台 `syncLegacyStaffNoColumns()`
    // 同步咗，主表單再唔重新 GET 就會停留喺舊值；到時撳「儲存」個 form
    // 會帶住呢個舊值一齊送，`PATCH /api/guards/:id` 會以為「想將個號改返
    // 舊嗰個」，同呢個 guard 自己頭先轉咗做 former 嗰行撞號（409）。
    const detailRes = await apiGet<GuardRow>(`/api/guards/${editingId}`);
    if (detailRes.ok) fillFormFromRow(detailRes.data);
  }

  // S7（Opus 驗收）：員工編號逐行「取消呢個號」／「改返現用」——一click
  // 切換 status（`current`↔`former`），call PATCH .../staff-numbers/:id。
  // 業務規則 (4)（老闆 2026-09-19 拍板）：離職後舊編號會取消，再入職攞
  // 全新編號，永遠唔復用舊號——所以「改返現用」（former→current）係
  // 反常操作，正常流程唔應該再用返一個已取消嘅號，加一個 `confirm()`
  // 防手震／防誤觸，撳之前一定要用戶明確確認先送 PATCH。
  async function onToggleStaffNumberStatus(row: StaffNumberRow) {
    if (!editingId) return;
    const nextStatus: "current" | "former" = row.status === "current" ? "former" : "current";
    if (nextStatus === "former") {
      // EMP-P1：結束一張卡要填離職／停用日＋原因——開 inline 表單，確認後先送 PATCH
      setNumberEndingId(row.id);
      setNumberEndForm({ valid_to: new Date().toISOString().slice(0, 10), end_reason: "resigned" });
      setNumberActionError(null);
      return;
    }
    if (nextStatus === "current") {
      const confirmed = await askConfirm({
        message: `已取消嘅編號正常唔會再用（再入職會攞新號）。確定要將 ${row.number} 改返現用？（只應該用嚟更正撳錯）`,
      });
      if (!confirmed) return;
    }
    setNumberActionBusy(true);
    setNumberActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/staff-numbers/${row.id}`, { status: nextStatus });
    setNumberActionBusy(false);
    if (!res.ok) {
      setNumberActionError(res.message);
      return;
    }
    setNotice(`已將 ${row.number} 改返現用`);
    await loadStaffNumbers(editingId);
    await reloadList();
    // 同 onAddStaffNumber() 一致理由——staff_no／staff_no_mw 可能經
    // syncLegacyStaffNoColumns() 同步咗，主表單要重新 GET 先唔會帶住
    // 舊值撳「儲存」撞號。
    const detailRes = await apiGet<GuardRow>(`/api/guards/${editingId}`);
    if (detailRes.ok) fillFormFromRow(detailRes.data);
  }

  async function onConfirmEndStaffNumber() {
    if (!editingId || !numberEndingId) return;
    if (!numberEndForm.valid_to) {
      setNumberActionError("要填離職／停用日");
      return;
    }
    setNumberActionBusy(true);
    setNumberActionError(null);
    const res = await apiPatch(`/api/guards/${editingId}/staff-numbers/${numberEndingId}`, { status: "former", valid_to: numberEndForm.valid_to, end_reason: numberEndForm.end_reason });
    setNumberActionBusy(false);
    if (!res.ok) {
      setNumberActionError(res.message);
      return;
    }
    setNumberEndingId(null);
    setNotice("已結束呢張工號卡");
    await loadStaffNumbers(editingId);
    await reloadList();
    const detailRes = await apiGet<GuardRow>(`/api/guards/${editingId}`);
    if (detailRes.ok) fillFormFromRow(detailRes.data);
  }

  // S7：「編輯」撳落去開 inline 表單（號碼／生效日期／備註），「編輯」
  // 撳多次都得——`openNumberEdit()` 淨係重設個 form 做嗰行現有值。
  function onOpenNumberEdit(row: StaffNumberRow) {
    setNumberEditingId(row.id);
    setNumberActionError(null);
    setNumberEditForm({
      number: row.number,
      valid_from: row.valid_from ? row.valid_from.slice(0, 10) : "",
      valid_to: row.valid_to ? row.valid_to.slice(0, 10) : "",
      note: row.note ?? "",
      end_reason: row.end_reason ?? "",
    });
  }

  function onCancelNumberEdit() {
    setNumberEditingId(null);
    setNumberActionError(null);
  }

  async function onSaveNumberEdit() {
    if (!editingId || !numberEditingId) return;
    setNumberActionBusy(true);
    setNumberActionError(null);
    // 應修 2（Opus 驗收第二輪）：`note`／`valid_from`／`valid_to` 而家
    // 一律送（`|| null`），唔再「空就唔送」——`GuardStaffNumberUpdateSchema`
    // 已經改用 nullable schema，用戶打空咗想清返呢三個欄要真係清得走。
    const res = await apiPatch(`/api/guards/${editingId}/staff-numbers/${numberEditingId}`, {
      number: numberEditForm.number,
      valid_from: numberEditForm.valid_from || null,
      valid_to: numberEditForm.valid_to || null,
      ...(numberEditForm.end_reason ? { end_reason: numberEditForm.end_reason } : {}),
      note: numberEditForm.note || null,
    });
    setNumberActionBusy(false);
    if (!res.ok) {
      setNumberActionError(res.message);
      return;
    }
    setNumberEditingId(null);
    setNotice("已更新員工編號");
    await loadStaffNumbers(editingId);
    await reloadList();
    const detailRes = await apiGet<GuardRow>(`/api/guards/${editingId}`);
    if (detailRes.ok) fillFormFromRow(detailRes.data);
  }

  // openCreate()／openEdit() 重置（搬自原本兩個函數）。
  function resetForCreate() {
    setStaffNumbers([]);
    resetForEdit();
  }
  function resetForEdit() {
    setStaffNumberForm(emptyStaffNumberForm);
    setStaffNumberError(null);
    setShowFormerStaffNumbers(false);
    setNumberEditingId(null);
    setNumberEndingId(null);
    setNumberActionError(null);
  }

  return {
    staffNumbers,
    staffNumberForm,
    staffNumberError,
    staffNumberSaving,
    showFormerStaffNumbers,
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
    setShowFormerStaffNumbers,
    setNumberEditForm,
    loadStaffNumbers,
    onAddStaffNumber,
    onToggleStaffNumberStatus,
    onOpenNumberEdit,
    onCancelNumberEdit,
    onSaveNumberEdit,
    resetForCreate,
    resetForEdit,
  };
}
