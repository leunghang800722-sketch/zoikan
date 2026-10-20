"use client";
// EMP-P2：工號體系設定（老闆專用）——U／MP／MG／MW 嘅顯示名、出糧方、出糧方式。code 固定，唔可以加減。
// U＝Wilson 盤（登記工號），出糧全部係在勤（老闆 2026-10-20 更正）：U／MP／MW 行＝在勤出糧、MG 行＝在勤長工糧（逐人糧單／報表按呢度分組標示）；
// 錢點到人手睇逐人糧單「出糧途徑」欄（經雞頭／在勤直接／未歸屬）。
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { apiGet, apiPatch } from "@/lib/ui/api-client";
import { kickerFor } from "@/lib/nav/schema";

interface SchemeRow {
  code: string;
  label_zh: string;
  payer_code: string | null;
  payer_label_zh: string | null;
  pay_method: string | null;
  is_frontline: boolean;
  is_longterm: boolean;
}
type Draft = { label_zh: string; payer_code: string; payer_label_zh: string; pay_method: string };

export default function StaffSchemesPage() {
  const [rows, setRows] = useState<SchemeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const load = useCallback(async () => {
    const res = await apiGet<{ schemes: SchemeRow[] }>("/api/admin/staff-schemes");
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setRows(res.data.schemes);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const draftOf = (r: SchemeRow): Draft => drafts[r.code] ?? { label_zh: r.label_zh, payer_code: r.payer_code ?? "", payer_label_zh: r.payer_label_zh ?? "", pay_method: r.pay_method ?? "" };
  const patch = (r: SchemeRow, d: Partial<Draft>) => setDrafts((all) => ({ ...all, [r.code]: { ...draftOf(r), ...d } }));

  async function save(r: SchemeRow) {
    const d = draftOf(r);
    setBusy(r.code);
    const res = await apiPatch(`/api/admin/staff-schemes/${r.code}`, { label_zh: d.label_zh, payer_code: d.payer_code || null, payer_label_zh: d.payer_label_zh || null, pay_method: d.pay_method || null });
    setBusy(null);
    if (!res.ok) setError(res.message);
    else {
      setNotice(`${r.code}：已儲存。`);
      setDrafts((all) => {
        const { [r.code]: _omit, ...rest } = all;
        void _omit;
        return rest;
      });
      await load();
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="staff-schemes-page">
      <PageHeader kicker={kickerFor("/settings/staff-schemes")} title="工號體系" subtitle="U／MP／MG／MW 邊個出糧、點出糧。代號固定，只可以改顯示名、出糧方同出糧方式（空白＝跟雞頭）。注意：改動會即時反映喺所有月份嘅逐人糧單（只係顯示，唔影響金額）。" />
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      {rows === null ? (
        <div className="text-zk-base text-zk-muted">載入緊…</div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((r) => {
            const d = draftOf(r);
            const dirty = !!drafts[r.code];
            return (
              <section key={r.code} data-testid={`scheme-${r.code}`} className="rounded-[10px] border border-zk-border bg-white px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-zk-md font-semibold text-zk-text">{r.code}</h2>
                  <Pill variant="neutral">{r.is_longterm ? "長工" : r.is_frontline ? "前線" : "非前線"}</Pill>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-zk-sm md:grid-cols-4">
                  <label className="flex flex-col gap-1">
                    顯示名
                    <input className="rounded-md border border-zk-border px-2 py-1" value={d.label_zh} onChange={(e) => patch(r, { label_zh: e.target.value })} data-testid={`scheme-${r.code}-label`} />
                  </label>
                  <label className="flex flex-col gap-1">
                    出糧方代號
                    <input className="rounded-md border border-zk-border px-2 py-1" value={d.payer_code} onChange={(e) => patch(r, { payer_code: e.target.value })} data-testid={`scheme-${r.code}-payer`} />
                  </label>
                  <label className="flex flex-col gap-1">
                    出糧方顯示名
                    <input className="rounded-md border border-zk-border px-2 py-1" value={d.payer_label_zh} onChange={(e) => patch(r, { payer_label_zh: e.target.value })} data-testid={`scheme-${r.code}-payer-label`} />
                  </label>
                  <label className="flex flex-col gap-1">
                    出糧方式
                    <select className="rounded-md border border-zk-border px-2 py-1" value={d.pay_method} onChange={(e) => patch(r, { pay_method: e.target.value })} data-testid={`scheme-${r.code}-method`}>
                      <option value="">跟雞頭</option>
                      <option value="cash">現金</option>
                      <option value="autopay">Autopay</option>
                      <option value="salary">月薪</option>
                    </select>
                  </label>
                </div>
                {dirty && (
                  <div className="mt-2">
                    <Button size="sm" variant="primary" disabled={busy === r.code} onClick={() => save(r)} data-testid={`scheme-${r.code}-save`}>
                      {busy === r.code ? "儲存緊…" : "儲存"}
                    </Button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
