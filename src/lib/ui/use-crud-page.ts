"use client";
// P3-4.2：主檔 CRUD 頁共用 hook（brokers／sites／quotas／users）——抽出 rows／loading／error／notice／drawer／editingId／form／saving
// 同「儲存」「作廢類單一動作」兩個流程。只係 state＋流程樣板，唔碰任何 API 路徑／body。
import { useCallback, useState } from "react";
import type { ApiResult } from "@/lib/ui/api-client";

export function useCrudPage<Row, Form>(emptyForm: Form) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** 開新增 drawer（`initial` 預設＝emptyForm）。 */
  const openCreate = useCallback(
    (initial?: Form) => {
      setEditingId(null);
      setForm(initial ?? emptyForm);
      setFormError(null);
      setDrawerOpen(true);
    },
    [emptyForm],
  );

  /** 開編輯 drawer。 */
  const openEdit = useCallback((id: string, f: Form) => {
    setEditingId(id);
    setForm(f);
    setFormError(null);
    setDrawerOpen(true);
  }, []);

  /**
   * 儲存流程：saving→執行→失敗出 formError／成功收 drawer＋notice＋reload。
   * `run` 回傳 API 結果（已按新增／編輯揀好路徑）。
   */
  const saveForm = useCallback(
    async (run: () => Promise<ApiResult<unknown>>, reload: () => Promise<void> | void, notices: { created: string; updated: string } = { created: "已新增", updated: "已更新" }) => {
      setSaving(true);
      setFormError(null);
      const res = await run();
      setSaving(false);
      if (!res.ok) {
        setFormError(res.message);
        return false;
      }
      setDrawerOpen(false);
      setNotice(editingId ? notices.updated : notices.created);
      await reload();
      return true;
    },
    [editingId],
  );

  /** 列表上單一動作（作廢／解除作廢／停用／恢復）：失敗出 error，成功出 notice＋reload。 */
  const runAction = useCallback(async (run: () => Promise<ApiResult<unknown>>, successNotice: string, reload: () => Promise<void> | void) => {
    setError(null);
    const res = await run();
    if (!res.ok) {
      setError(res.message);
      return false;
    }
    setNotice(successNotice);
    await reload();
    return true;
  }, []);

  return {
    rows, setRows, loading, setLoading, error, setError, notice, setNotice,
    drawerOpen, setDrawerOpen, editingId, setEditingId, form, setForm, formError, setFormError, saving, setSaving,
    openCreate, openEdit, saveForm, runAction,
  };
}
