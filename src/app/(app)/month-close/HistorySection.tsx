"use client";
// 1a 歷史：一行「今個月一鍵結算跑咗 N 次 … 睇歷史 ›」，展開現有 runs 表。
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth } from "@/components/ui/DataTable";
import { fmtDateTime } from "@/lib/ui/format";
import type { RunDTO } from "@/components/month-close/types";
import { fmtMdHm } from "@/components/month-close/derive";

export function HistorySection({ runs, busy, open, onToggle, onRerun }: { runs: RunDTO[]; busy: boolean; open: boolean; onToggle: () => void; onRerun: (id: string) => void }) {
  return (
    <section data-testid="history-section">
      <div className="px-0.5 text-[12.5px] text-zk-muted">
        {runs.length === 0 ? "呢個月未跑過一鍵結算" : `今個月一鍵結算跑咗 ${runs.length} 次，最近一次 ${fmtMdHm(runs[0]!.started_at)}`}
        {runs.length > 0 && (
          <>
            {" · "}
            <button type="button" className="text-zk-primary hover:underline" onClick={onToggle} aria-expanded={open}>
              {open ? "收埋歷史 ›" : "睇歷史 ›"}
            </button>
          </>
        )}
      </div>
      {open && runs.length > 0 && (
        <div className="mt-2 rounded-[10px] border border-zk-border bg-white p-4">
          <div className="mb-2 text-sm font-semibold text-zk-text">歷史 runs</div>
          <div className={tableCls.wrap}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(4) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>開始時間</th>
                  <th className={tableCls.th}>狀態</th>
                  <th className={tableCls.th}>而家步驟</th>
                  <th className={tableCls.th}></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={tableCls.rowHover}>
                    <td className={tableCls.td}>{fmtDateTime(r.started_at)}</td>
                    <td className={tableCls.td}>{r.stalled ? <Pill variant="danger">卡住</Pill> : r.status === "done" ? <Pill variant="success">完成</Pill> : r.status === "failed" ? <Pill variant="danger">失敗</Pill> : <Pill variant="shift">執行緊</Pill>}</td>
                    <td className={tableCls.td}>{r.current_step ?? "-"}</td>
                    <td className={tableCls.td}>
                      {(r.stalled || r.status === "failed") && (
                        <Button onClick={() => onRerun(r.id)} disabled={busy}>
                          重新執行
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
