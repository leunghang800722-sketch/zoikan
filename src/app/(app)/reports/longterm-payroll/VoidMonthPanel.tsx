"use client";
// P15：「作廢本月計算」（老闆）。撳開先 GET 唯讀前置檢查：之前月份已計（有／冇）、回滾方式（快照／精確重建／近似重建）；
// 近似重建要額外剔一個確認先可以作廢；原因必填。
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { apiGet, apiPost } from "@/lib/ui/api-client";

interface Preview {
  has_run: boolean;
  earlier_valid_runs: string[];
  later_blockers: string[];
  rollback_method: "none" | "snapshot" | "exact_rebuild" | "approx_rebuild";
  needs_confirm_approx: boolean;
  affected_guards: number;
}
const METHOD_LABEL: Record<Preview["rollback_method"], string> = { none: "冇結餘需要回滾", snapshot: "快照（精確還原）", exact_rebuild: "精確重建", approx_rebuild: "近似重建（冇快照，P15 前計過）" };

export function VoidMonthPanel({ month, onDone, onError, onNotice }: { month: string; onDone: () => void; onError: (m: string) => void; onNotice: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pv, setPv] = useState<Preview | null>(null);
  const [reason, setReason] = useState("");
  const [approx, setApprox] = useState(false);
  const [busy, setBusy] = useState(false);

  async function openPanel() {
    setOpen(true);
    setPv(null);
    setReason("");
    setApprox(false);
    const r = await apiGet<Preview>(`/api/longterm/payroll/${month}/void`);
    if (r.ok) setPv(r.data);
    else onError(r.message);
  }

  async function submit() {
    setBusy(true);
    const res = await apiPost<{ voided_runs: number; balances_restored: number; legacy_rebuilt: number; kept_manual_rows: number; avg_wages_cleared: number }>(`/api/longterm/payroll/${month}/void`, { reason: reason.trim(), ...(approx ? { confirm_approx: true } : {}) });
    setBusy(false);
    if (!res.ok) return onError(res.message);
    onNotice(`已作廢 ${month} 長工糧計算（回滾假期結餘 ${res.data.balances_restored} 人${res.data.legacy_rebuilt ? `，其中 ${res.data.legacy_rebuilt} 人係舊資料重建，請覆核` : ""}${res.data.kept_manual_rows ? `，${res.data.kept_manual_rows} 行有人手結餘資料已保留` : ""}，清走自動計平均工資 ${res.data.avg_wages_cleared} 行）`);
    setOpen(false);
    onDone();
  }

  if (!open) {
    return (
      <Button variant="danger" size="sm" onClick={openPanel}>
        作廢本月計算（老闆）
      </Button>
    );
  }
  const blocked = !!pv && pv.later_blockers.length > 0;
  const canSubmit = !!pv && !blocked && pv.has_run && reason.trim().length > 0 && (!pv.needs_confirm_approx || approx) && !busy;
  return (
    <div className="flex w-full flex-col gap-2 text-zk-sm" data-testid="ltpay-void-panel">
      {!pv ? (
        <div className="text-zk-muted">檢查緊…</div>
      ) : (
        <>
          <div data-testid="ltpay-void-earlier">之前月份已計：{pv.earlier_valid_runs.length ? `有（${pv.earlier_valid_runs.join("、")}）` : "冇"}</div>
          <div data-testid="ltpay-void-method">
            回滾方式：{METHOD_LABEL[pv.rollback_method]}（影響 {pv.affected_guards} 人）
          </div>
          {blocked && <div className="text-zk-danger">{pv.later_blockers.join("、")} 仲有效，要先作廢嗰個月（只准由最近一個月倒序作廢）</div>}
          {pv.needs_confirm_approx && (
            <label className="flex items-center gap-1 text-zk-danger">
              <input type="checkbox" checked={approx} onChange={(e) => setApprox(e.target.checked)} data-testid="ltpay-void-approx" />
              我明白呢次係近似重建，作廢後會抽查 AL／SL 已放日數
            </label>
          )}
          <div className="flex items-center gap-1">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="填原因先可以確認" className="w-56 rounded border border-zk-input-border px-2 py-1 text-xs" />
            <Button variant="dangerSolid" size="sm" disabled={!canSubmit} onClick={submit}>
              {busy ? "處理中…" : "確認作廢"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              取消
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
