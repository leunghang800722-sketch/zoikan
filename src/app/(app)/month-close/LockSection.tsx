"use client";
// 1a ⑤ 鎖定本月：「一定要做好先可以鎖」＋鎖月前體檢。P3-3.4（老闆 3A）：鎖定掣只留右欄 RightRail；已鎖定時呢度有解鎖（原因必填，API 不變）。
import { useState } from "react";
import Link from "next/link";
import { inputCls } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import type { ReportDTO } from "@/components/month-close/types";
import { lockRequirements, type ReviewGroup } from "@/components/month-close/derive";
import { MonthHealthCard } from "./MonthHealthCard";

export function LockSection({ report, month, busy, locked, groups, onUnlock, canUnlock, needDiffReason, diffReason, onDiffReason, isBoss, onForceLock, onOpenTriage, onHealth }: { report: ReportDTO; month: string; busy: boolean; locked: boolean; groups: ReviewGroup[]; onUnlock: (reason: string) => void; canUnlock: boolean; needDiffReason: boolean; diffReason: string; onDiffReason: (v: string) => void; isBoss: boolean; onForceLock: (reason: string) => void; onOpenTriage: () => void; onHealth: (s: { critical: number; warn: number; info: number }) => void }) {
  const [unlockReason, setUnlockReason] = useState("");
  const [forceOn, setForceOn] = useState(false);
  const [forceReason, setForceReason] = useState("");
  const pricingQ = groups.find((g) => g.key === "pricing")?.count ?? 0;
  const reqs = lockRequirements(report, pricingQ);
  const lp = report.lock_precondition;
  const ready = lp.ready_to_lock && !locked;
  const canTriage = !!report.auto?.triage_session_id && pricingQ > 0 && !locked;
  return (
    <section className="overflow-hidden rounded-[10px] border border-zk-border bg-white" data-testid="lock-section">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-zk-border-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold text-zk-text">⑤ 鎖定本月</h2>
        {locked ? <Pill variant="warning">已鎖定</Pill> : <span className={`text-[12px] ${ready ? "text-zk-success" : "text-zk-danger-dark"}`}>{ready ? "條件齊，可以鎖" : reqs.length > 0 ? `仲有 ${reqs.length} 樣未做好，未可以鎖` : "未可以鎖"}</span>}
      </div>
      {!locked && reqs.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-zk-border-soft px-4 py-3.5">
          <div className="text-[11.5px] font-semibold text-zk-muted">一定要做好先可以鎖</div>
          {reqs.map((r) => (
            <div key={r.key} className="flex items-center gap-3 rounded-lg border border-[#fecaca] bg-[#fffafa] px-3 py-2.5" data-lock-req={r.key}>
              <span className="h-[18px] w-[18px] flex-none rounded-full border-[1.5px] border-[#dc2626]" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-zk-text">{r.title}</div>
                <div className="text-[11.5px] text-zk-muted">{r.detail}</div>
              </div>
              {r.action === "roster-uploads" ? (
                <Link href={`/roster-uploads?month=${month}`} className="whitespace-nowrap text-[12.5px] text-zk-primary hover:underline">
                  {r.actionLabel}
                </Link>
              ) : (
                canTriage && (
                  <button type="button" onClick={onOpenTriage} className="whitespace-nowrap text-[12.5px] text-zk-primary hover:underline">
                    {r.actionLabel}
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {/* WP-AI-OPS §28.3：鎖月前體檢（只提示，唔擋鎖月）。 */}
      <div className="px-4 py-3.5">
        <MonthHealthCard month={report.month} groups={groups} onLoaded={onHealth} onOpenTriage={canTriage ? onOpenTriage : undefined} />
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-zk-border-soft bg-zk-header px-4 py-3">
        <span className="min-w-0 flex-1 text-[12px] text-zk-muted">
          鎖咗之後成個月只讀；要改要搵有「月結鎖定解鎖」權限嘅同事。{!locked && " 鎖定掣喺右欄（唯一鎖月入口）。"}
        </span>
        {locked && <Pill variant="warning">已鎖定</Pill>}
      </div>
      {!locked && needDiffReason && (
        <div className="flex flex-col gap-1.5 border-t border-zk-border-soft px-4 py-3" data-testid="diff-reason-box">
          <label className="text-[12.5px] font-medium text-zk-text">§6.3 對數有紅色差異——override 原因（必填）</label>
          <input className={inputCls} placeholder="override 原因（必填）" value={diffReason} onChange={(e) => onDiffReason(e.target.value)} data-testid="diff-reason" />
        </div>
      )}
      {/* 強制鎖定：淨係老闆、鎖月條件（更表上載／對數）未齊先出；call 同一個 lock API（body { force: true, override_reason }），原因必填。 */}
      {!locked && isBoss && (lp.missing_upload_sites.length > 0 || lp.unconfirmed_upload_sites.length > 0) && (
        <div className="flex flex-col gap-2 border-t border-zk-border-soft px-4 py-3" data-testid="force-lock-box">
          <label className="flex items-center gap-1.5 text-[12.5px] text-zk-text">
            <input type="checkbox" checked={forceOn} onChange={(e) => setForceOn(e.target.checked)} data-testid="force-lock-check" />
            強制鎖定（淨係老闆做得到，會記落操作紀錄）
          </label>
          {forceOn && (
            <div className="flex flex-wrap items-center gap-2">
              <input className={inputCls} placeholder="override 原因（必填）" value={forceReason} onChange={(e) => setForceReason(e.target.value)} data-testid="force-lock-reason" />
              <button
                type="button"
                data-testid="force-lock-month"
                onClick={() => onForceLock(forceReason.trim())}
                disabled={busy || !forceReason.trim()}
                className="whitespace-nowrap rounded-md border border-[#fecaca] bg-white px-4 py-2 text-[13px] font-semibold text-[#b91c1c] hover:bg-[#fef2f2] disabled:cursor-not-allowed disabled:opacity-[.45]"
              >
                強制鎖定 {month}
              </button>
            </div>
          )}
        </div>
      )}
      {locked && canUnlock && (
        <div className="flex flex-wrap items-center gap-2 border-t border-zk-border-soft px-4 py-3" data-testid="unlock-box">
          <span className="text-[12px] text-zk-muted">解鎖原因（必填，會寫入操作紀錄）</span>
          <input className={inputCls} placeholder="解鎖原因" value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} data-testid="unlock-reason" />
          <button
            type="button"
            data-testid="unlock-month"
            onClick={() => onUnlock(unlockReason.trim())}
            disabled={busy || !unlockReason.trim()}
            className="whitespace-nowrap rounded-md border border-[#fecaca] bg-white px-4 py-2 text-[13px] font-semibold text-[#b91c1c] hover:bg-[#fef2f2] disabled:cursor-not-allowed disabled:opacity-[.45]"
          >
            解鎖 {month}
          </button>
        </div>
      )}
    </section>
  );
}
