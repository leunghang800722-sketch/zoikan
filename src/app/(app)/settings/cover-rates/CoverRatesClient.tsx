"use client";
import { useCallback, useEffect, useState } from "react";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { Field, inputCls, selectCls } from "@/components/ui/Field";
import { tableCls, tableMinWidth, TableEmptyRow } from "@/components/ui/DataTable";
import { apiGet, apiGetAll, apiPost, apiPatch } from "@/lib/ui/api-client";
import { fmtMoney, fmtDate } from "@/lib/ui/format";

interface RateRow {
  id: string;
  site_id: string;
  site_name: string;
  grade: string;
  amount: number | string;
  effective_from: string;
  effective_to: string | null;
  source: string;
  voided_at: string | null;
}
interface SiteRow {
  id: string;
  canonical_name: string;
}

export function CoverRatesClient({ isBoss }: { isBoss: boolean }) {
  const [rows, setRows] = useState<RateRow[] | null>(null);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [showVoided, setShowVoided] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [siteId, setSiteId] = useState("");
  const [grade, setGrade] = useState("兵");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");

  const load = useCallback(async () => {
    const res = await apiGet<{ rows: RateRow[] }>(`/api/longterm/cover-rates${showVoided ? "?include_voided=1" : ""}`);
    if (res.ok) setRows(res.data.rows);
    else setError(res.message);
  }, [showVoided]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!isBoss) return;
    void apiGetAll<SiteRow>("/api/sites").then((r) => {
      if (r.ok) setSites(r.data.rows);
    });
  }, [isBoss]);

  async function add() {
    setError(null);
    setNotice(null);
    if (!siteId || !from || !(Number(amount) > 0)) return setError("要揀盤、填生效日同大過 0 嘅金額");
    const res = await apiPost("/api/longterm/cover-rates", { site_id: siteId, grade, amount: Number(amount), effective_from: from });
    if (!res.ok) return setError(res.message);
    setNotice("已新增");
    setAmount("");
    void load();
  }
  async function saveEdit(id: string) {
    const res = await apiPatch(`/api/longterm/cover-rates/${id}`, { amount: Number(editAmount) });
    if (!res.ok) return setError(res.message);
    setEditId(null);
    void load();
  }
  async function voidRow(id: string) {
    const res = await apiPatch(`/api/longterm/cover-rates/${id}`, { void: true });
    if (!res.ok) return setError(res.message);
    void load();
  }

  return (
    <div className="flex flex-col gap-4" data-testid="cover-rates-page">
      <Banner kind="info">改價請「新增」一行新生效日（舊價保留）。生效區間覆蓋已鎖月份嘅價唔可以改額或作廢。{isBoss ? "" : "你淨係可以睇，改價淨係老闆。"}</Banner>
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {isBoss && (
        <section className="flex flex-wrap items-end gap-3 rounded-lg border border-zk-border bg-white p-4" data-testid="cover-rates-add">
          <Field label="盤">
            <select className={selectCls} value={siteId} onChange={(e) => setSiteId(e.target.value)} data-testid="cover-rates-site">
              <option value="">— 揀盤 —</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.canonical_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="職級">
            <select className={selectCls} value={grade} onChange={(e) => setGrade(e.target.value)} data-testid="cover-rates-grade">
              <option value="兵">兵</option>
              <option value="IC">IC</option>
            </select>
          </Field>
          <Field label="每更金額">
            <input type="number" min="0" step="0.01" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="cover-rates-amount" />
          </Field>
          <Field label="生效日">
            <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} data-testid="cover-rates-from" />
          </Field>
          <Button variant="primary" onClick={add} data-testid="cover-rates-submit">
            新增
          </Button>
        </section>
      )}
      <label className="flex items-center gap-2 text-zk-sm">
        <input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} />
        顯示已作廢
      </label>
      <div className={tableCls.wrap}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(6) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>盤</th>
              <th className={tableCls.th}>職級</th>
              <th className={tableCls.th}>每更金額</th>
              <th className={tableCls.th}>生效日</th>
              <th className={tableCls.th}>來源</th>
              <th className={tableCls.th}></th>
            </tr>
          </thead>
          <tbody>
            {!rows || rows.length === 0 ? (
              <TableEmptyRow colSpan={6}>{rows ? "未有頂位價——去「由歷史反推」或者手動新增" : "載入緊…"}</TableEmptyRow>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className={tableCls.rowHover} data-testid="cover-rate-row">
                  <td className={tableCls.td}>{r.site_name}</td>
                  <td className={tableCls.td}>{r.grade}</td>
                  <td className={tableCls.td}>
                    {editId === r.id ? <input type="number" className={inputCls} value={editAmount} onChange={(e) => setEditAmount(e.target.value)} aria-label="新金額" data-testid="cover-rate-edit-amount" /> : fmtMoney(r.amount)}
                  </td>
                  <td className={tableCls.td}>
                    {fmtDate(r.effective_from)}
                    {r.effective_to ? `–${fmtDate(r.effective_to)}` : "起"}
                  </td>
                  <td className={tableCls.td}>
                    <Pill variant={r.source === "inferred" ? "shift" : "neutral"}>{r.source === "inferred" ? "歷史反推" : "人手"}</Pill>
                    {r.voided_at ? <Pill variant="danger">已作廢</Pill> : null}
                  </td>
                  <td className={tableCls.td}>
                    {isBoss && !r.voided_at && (
                      <span className="flex flex-wrap items-center gap-2">
                        {editId === r.id ? (
                          <>
                            <Button variant="primary" size="sm" onClick={() => saveEdit(r.id)} data-testid="cover-rate-save">
                              儲存
                            </Button>
                            <Button variant="link" size="sm" onClick={() => setEditId(null)}>
                              取消
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="link"
                              size="sm"
                              onClick={() => {
                                setEditId(r.id);
                                setEditAmount(String(r.amount));
                              }}
                              data-testid="cover-rate-edit"
                            >
                              改額
                            </Button>
                            <Button variant="linkDanger" size="sm" onClick={() => voidRow(r.id)} data-testid="cover-rate-void">
                              作廢
                            </Button>
                          </>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
