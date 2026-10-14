"use client";
// P18.2：「出勤修正」tab——① 同日多來源衝突日（顯示各來源代號、系統而家採用邊個、對糧嘅影響）；② 全部更歸雞頭嘅長工（可「歸公司兵」）。
// 寫入一律經 POST /api/shift-records/batch（人手紀錄 source="manual"，來源優先次序會蓋過舊紀錄；原紀錄唔作廢，batch 寫 audit）。
// 做完要「重算本月」先反映；已鎖月份唯讀。姓名只喺本頁顯示，通知唔含。
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { selectCls } from "@/components/ui/Field";
import { tableCls, tableMinWidth, TableEmptyRow } from "@/components/ui/DataTable";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { fmtDate } from "@/lib/ui/format";
import type { AttendanceIssues, AttendanceConflictRow, MisattributedGuardRow, AttendanceEffect } from "@/lib/longterm-payroll/attendance-issues";

const EFFECT_VARIANT: Record<AttendanceEffect, "success" | "warning" | "neutral" | "shift"> = { work: "success", paid: "shift", unpaid: "warning", rest: "neutral" };
// 「設為代號…」可揀嘅合法代號（返工＝目標紀錄所屬更別代號）。
const SET_CODES: Array<{ value: string; label: string }> = [
  { value: "SL", label: "SL 病假" },
  { value: "NPL", label: "NPL 無薪假" },
  { value: "NL", label: "NL 無薪假" },
  { value: "RD", label: "RD 例假" },
  { value: "OFF", label: "OFF 例假" },
  { value: "SH", label: "SH 法定假" },
  { value: "AL", label: "AL 年假" },
];

export function AttendanceFixPanel({
  month,
  active,
  locked,
  recomputing,
  onRecompute,
  onError,
  onNotice,
}: {
  month: string; // YYYY-MM
  active: boolean;
  locked: boolean;
  recomputing: boolean;
  onRecompute: () => void;
  onError: (m: string) => void;
  onNotice: (m: string | null) => void;
}) {
  const [data, setData] = useState<AttendanceIssues | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [needRecompute, setNeedRecompute] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await apiGet<AttendanceIssues>(`/api/longterm/attendance-issues?month=${month}-01`);
    if (res.ok) setData(res.data);
    else onError(res.message);
    setLoading(false);
  }, [month, onError]);

  useEffect(() => {
    setNeedRecompute(false);
    if (active) void load();
  }, [active, load]);

  async function write(key: string, siteId: string, cells: Array<Record<string, string>>, okMsg: string) {
    setBusy(key);
    const res = await apiPost(`/api/shift-records/batch`, { site_id: siteId, month, cells });
    if (res.ok) {
      onNotice(okMsg);
      setNeedRecompute(true);
      await load();
    } else onError(res.message);
    setBusy(null);
  }

  function setCode(row: AttendanceConflictRow, code: string) {
    return write(
      `${row.guard_id}|${row.date}`,
      row.target.site_id,
      [{ guard_id: row.guard_id, shift_type_id: row.target.shift_type_id, work_date: row.date, code }],
      `已寫入 ${row.date} 人手紀錄（代號 ${code}）——要「重算本月」先反映`,
    );
  }

  async function toCompany(g: MisattributedGuardRow) {
    if (!data?.internal_longterm_broker_id) return onError("揾唔到公司兵（B07）結算單位");
    const b07 = data.internal_longterm_broker_id;
    setBusy(`co|${g.guard_id}`);
    const bySite = new Map<string, MisattributedGuardRow["cells"]>();
    for (const c of g.cells) bySite.set(c.site_id, [...(bySite.get(c.site_id) ?? []), c]);
    for (const [siteId, cells] of bySite) {
      const res = await apiPost(`/api/shift-records/batch`, {
        site_id: siteId,
        month,
        cells: cells.map((c) => ({ guard_id: g.guard_id, shift_type_id: c.shift_type_id, work_date: c.date, code: c.shift_type_code, settlement_broker_id: b07 })),
      });
      if (!res.ok) {
        onError(res.message);
        setBusy(null);
        await load();
        return;
      }
    }
    onNotice(`已將 ${g.cells.length} 更歸公司兵——要「重算本月」先反映`);
    setNeedRecompute(true);
    await load();
    setBusy(null);
  }

  const ro = locked || data?.locked;
  return (
    <div className="flex flex-col gap-4" data-testid="attfix-panel">
      <div className="text-zk-sm text-zk-muted">
        同一人同一日有多個來源（人手 &gt; roster_upload &gt; master_roster &gt; payroll_only）嘅更表紀錄時，系統只採用最高來源。喺度可揀採用邊個代號（寫一條人手紀錄，原紀錄唔作廢）。
        {ro ? "（本月已鎖定，唯讀）" : ""}
      </div>
      {needRecompute && (
        <div className="flex items-center gap-3 rounded-lg border border-zk-border bg-white p-3 text-zk-sm" data-testid="attfix-recompute-hint">
          <span>要重算本月先反映</span>
          <Button variant="primary" onClick={onRecompute} disabled={recomputing || !!ro} data-testid="attfix-recompute">
            {recomputing ? "重算緊…" : "重算本月"}
          </Button>
        </div>
      )}
      {loading && <div className="text-sm text-zk-muted">載入緊…</div>}

      <section className="flex flex-col gap-2">
        <h3 className="text-zk-base font-semibold">同日多來源衝突（{data?.conflicts.length ?? 0}）</h3>
        <div className={tableCls.wrap}>
          <table className={tableCls.table} style={{ minWidth: tableMinWidth(6) }} data-testid="attfix-conflicts">
            <thead>
              <tr>
                <th className={tableCls.th}>保安員</th>
                <th className={tableCls.th}>日期</th>
                <th className={tableCls.th}>各來源代號</th>
                <th className={tableCls.th}>系統而家採用</th>
                <th className={tableCls.th}>對糧影響</th>
                <th className={tableCls.th}>動作</th>
              </tr>
            </thead>
            <tbody>
              {!data || data.conflicts.length === 0 ? (
                <TableEmptyRow colSpan={6}>{loading ? "載入緊…" : "呢個月冇同日多來源衝突"}</TableEmptyRow>
              ) : (
                data.conflicts.map((r) => {
                  const k = `${r.guard_id}|${r.date}`;
                  return (
                    <tr key={k} className={tableCls.rowHover} data-testid="attfix-conflict-row">
                      <td className={tableCls.td}>
                        {r.guard_name}
                        {r.guard_staff_no ? <span className="ml-1 text-zk-xs text-zk-muted">{r.guard_staff_no}</span> : null}
                      </td>
                      <td className={tableCls.td}>{fmtDate(r.date)}</td>
                      <td className={tableCls.td}>{r.entries.map((e) => `${e.source}：${e.code}`).join(" ／ ")}</td>
                      <td className={tableCls.td}>
                        來源 {r.adopted_source}：{r.adopted_code}
                      </td>
                      <td className={tableCls.td}>
                        <Pill variant={EFFECT_VARIANT[r.effect]}>{r.effect_label}</Pill>
                      </td>
                      <td className={tableCls.td}>
                        <div className="flex flex-wrap items-center gap-2">
                          {r.options
                            .filter((o) => o.code !== r.adopted_code)
                            .map((o) => (
                              <Button key={o.code} variant="secondary" disabled={!!ro || busy === k} onClick={() => setCode(r, o.batch_code)} data-testid={`attfix-adopt-${o.code}`}>
                                採用：代號 {o.code}
                              </Button>
                            ))}
                          <select
                            className={selectCls}
                            defaultValue=""
                            disabled={!!ro || busy === k}
                            aria-label="設為代號"
                            data-testid="attfix-set-select"
                            onChange={(e) => {
                              const v = e.target.value;
                              e.target.value = "";
                              if (v) void setCode(r, v === "__work__" ? r.target.shift_type_code : v);
                            }}
                          >
                            <option value="">設為代號…</option>
                            <option value="__work__">返工（{r.target.shift_type_code}）</option>
                            {SET_CODES.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-zk-base font-semibold">全部更歸雞頭嘅長工（{data?.misattributed.length ?? 0}）</h3>
        <div className="text-zk-xs text-zk-muted">呢啲長工本月所有正更嘅結算單位都唔係公司兵（B07），系統當全部係頂位更：返工日 0、假期唔計。如果佢哋其實係公司兵，撳「歸公司兵」。</div>
        <div className={tableCls.wrap}>
          <table className={tableCls.table} style={{ minWidth: tableMinWidth(4) }} data-testid="attfix-misattributed">
            <thead>
              <tr>
                <th className={tableCls.th}>保安員</th>
                <th className={tableCls.thNum}>正更日數</th>
                <th className={tableCls.th}>現時結算單位</th>
                <th className={tableCls.th}>動作</th>
              </tr>
            </thead>
            <tbody>
              {!data || data.misattributed.length === 0 ? (
                <TableEmptyRow colSpan={4}>{loading ? "載入緊…" : "冇"}</TableEmptyRow>
              ) : (
                data.misattributed.map((g) => (
                  <tr key={g.guard_id} className={tableCls.rowHover} data-testid="attfix-mis-row">
                    <td className={tableCls.td}>
                      {g.guard_name}
                      {g.guard_staff_no ? <span className="ml-1 text-zk-xs text-zk-muted">{g.guard_staff_no}</span> : null}
                    </td>
                    <td className={tableCls.tdNum}>{g.shift_days}</td>
                    <td className={tableCls.td}>{g.settlement_broker_codes.join("、")}</td>
                    <td className={tableCls.td}>
                      <Button variant="secondary" disabled={!!ro || busy === `co|${g.guard_id}`} onClick={() => toCompany(g)} data-testid="attfix-to-company">
                        歸公司兵
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
