"use client";
// 1a ⑤ 鎖定本月：「一定要做好先可以鎖」＋鎖月前體檢。P3-3.4（老闆 3A）：鎖定掣只留右欄 RightRail；已鎖定時呢度有解鎖（原因必填，API 不變）。
import { useState } from "react";
import Link from "next/link";
import { inputCls } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import type { ReportDTO } from "@/components/month-close/types";
import { lockRequirements, type ReviewGroup } from "@/components/month-close/derive";
import { MonthHealthCard } from "./MonthHealthCard";

import { Button } from "@/components/ui/Button";
export function LockSection({ report, lockedAt, month, busy, locked, groups, onUnlock, canUnlock, needDiffReason, diffReason, onDiffReason, isBoss, onForceLock, onSlUnpaidLock, onOpenTriage, onHealth }: { report: ReportDTO | null; lockedAt?: string | null; month: string; busy: boolean; locked: boolean; groups: ReviewGroup[]; onUnlock: (reason: string) => void; canUnlock: boolean; needDiffReason: boolean; diffReason: string; onDiffReason: (v: string) => void; isBoss: boolean; onForceLock: (reason: string) => void; onSlUnpaidLock: (reason: string) => void; onOpenTriage: () => void; onHealth: (s: { critical: number; warn: number; info: number }) => void }) {
  const [unlockReason, setUnlockReason] = useState("");
  const [forceOn, setForceOn] = useState(false);
  const [forceReason, setForceReason] = useState("");
  const [slOn, setSlOn] = useState(false);
  const [slReason, setSlReason] = useState("");
  const pricingQ = groups.find((g) => g.key === "pricing")?.count ?? 0;
  // P3-4.0：鎖定狀態由 month_closes 記錄決定；舊流程鎖咗、冇一鍵結算 run 嘅月份 report 係 null（只出鎖定狀態＋解鎖）。
  const reqs = report ? lockRequirements(report, pricingQ) : [];
  const lp = report?.lock_precondition ?? { ready_to_lock: false, missing_upload_sites: [], unconfirmed_upload_sites: [], sl_drafts_pending: 0 };
  const ready = lp.ready_to_lock && !locked;
  const canTriage = !!report?.auto?.triage_session_id && pricingQ > 0 && !locked;
  return (
    <section className="overflow-hidden rounded-[10px] border border-zk-border bg-white" data-testid="lock-section">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-zk-border-soft px-4 py-3">
        <h2 className="text-zk-md font-semibold text-zk-text">⑤ 鎖定本月</h2>
        {locked ? <Pill variant="warning">已鎖定</Pill> : <span className={`text-zk-sm ${ready ? "text-zk-success" : "text-zk-danger-dark"}`}>{ready ? "條件齊，可以鎖" : reqs.length > 0 ? `仲有 ${reqs.length} 樣未做好，未可以鎖` : "未可以鎖"}</span>}
      </div>
      {!locked && reqs.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-zk-border-soft px-4 py-3.5">
          <div className="text-zk-xs font-semibold text-zk-muted">一定要做好先可以鎖</div>
          {reqs.map((r) => (
            <div key={r.key} className="flex items-center gap-3 rounded-lg border border-zk-danger-border bg-zk-danger-bg px-3 py-2.5" data-lock-req={r.key}>
              <span className="h-[18px] w-[18px] flex-none rounded-full border-[1.5px] border-zk-danger" />
              <div className="min-w-0 flex-1">
                <div className="text-zk-base font-medium text-zk-text">{r.title}</div>
                <div className="text-zk-xs text-zk-muted">{r.detail}</div>
              </div>
              {r.action === "longterm-sl" ? (
                <Link href={`/reports/longterm-payroll?month=${month}&focus=sl-drafts`} className="whitespace-nowrap text-zk-sm text-zk-primary hover:underline" data-testid="lock-req-sl-link">
                  {r.actionLabel}
                </Link>
              ) : r.action === "roster-uploads" ? (
                <Link href={`/roster-uploads?month=${month}`} className="whitespace-nowrap text-zk-sm text-zk-primary hover:underline">
                  {r.actionLabel}
                </Link>
              ) : (
                canTriage && (
                  <Button variant="link" size="sm" className="whitespace-nowrap" type="button" onClick={onOpenTriage}>
                    {r.actionLabel}
                  </Button>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {locked && (
        <div className="border-b border-zk-border-soft px-4 py-3 text-zk-sm text-zk-text" data-testid="locked-info">
          已鎖定{lockedAt ? ` · 鎖定時間 ${new Date(lockedAt).toLocaleString("zh-HK", { hour12: false })}` : ""} · 鎖定人見操作紀錄
        </div>
      )}
      {/* WP-AI-OPS §28.3：鎖月前體檢（只提示，唔擋鎖月）。 */}
      {report && (
        <div className="px-4 py-3.5">
          <MonthHealthCard month={report.month} groups={groups} onLoaded={onHealth} onOpenTriage={canTriage ? onOpenTriage : undefined} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-zk-border-soft bg-zk-header px-4 py-3">
        <span className="min-w-0 flex-1 text-zk-sm text-zk-muted">
          鎖咗之後成個月只讀；要改要搵有「月結鎖定解鎖」權限嘅同事。{!locked && " 鎖定掣喺右欄（唯一鎖月入口）。"}
        </span>
        {locked && <Pill variant="warning">已鎖定</Pill>}
      </div>
      {!locked && needDiffReason && (
        <div id="diff-reason-box" className="flex flex-col gap-1.5 border-t border-zk-border-soft px-4 py-3" data-testid="diff-reason-box">
          <label className="text-zk-sm font-medium text-zk-text">§6.3 對數有紅色差異——override 原因（必填）</label>
          <input className={inputCls} placeholder="override 原因（必填）" value={diffReason} onChange={(e) => onDiffReason(e.target.value)} data-testid="diff-reason" />
        </div>
      )}
      {/* 強制鎖定：淨係老闆、鎖月條件（更表上載／對數）未齊先出；call 同一個 lock API（body { force: true, override_reason }），原因必填。 */}
      {!locked && isBoss && (lp.missing_upload_sites.length > 0 || lp.unconfirmed_upload_sites.length > 0) && (
        <div className="flex flex-col gap-2 border-t border-zk-border-soft px-4 py-3" data-testid="force-lock-box">
          <label className="flex items-center gap-1.5 text-zk-sm text-zk-text">
            <input type="checkbox" checked={forceOn} onChange={(e) => setForceOn(e.target.checked)} data-testid="force-lock-check" />
            強制鎖定（淨係老闆做得到，會記落操作紀錄）
          </label>
          {forceOn && (
            <div className="flex flex-wrap items-center gap-2">
              <input className={inputCls} placeholder="override 原因（必填）" value={forceReason} onChange={(e) => setForceReason(e.target.value)} data-testid="force-lock-reason" />
              <Button variant="danger" size="md" className="whitespace-nowrap disabled:cursor-not-allowed"
                type="button"
                data-testid="force-lock-month"
                onClick={() => onForceLock(forceReason.trim())}
                disabled={busy || !forceReason.trim()}

              >
                強制鎖定 {month}
              </Button>
            </div>
          )}
        </div>
      )}
      {/* P17：未確認病假草稿擋鎖月；淨係老闆可以「全部當無薪」覆蓋（草稿保持未確認＝唔出津貼；原因必填，寫操作紀錄）。 */}
      {!locked && isBoss && (lp.sl_drafts_pending ?? 0) > 0 && (
        <div className="flex flex-col gap-2 border-t border-zk-border-soft px-4 py-3" data-testid="sl-unpaid-box">
          <label className="flex items-center gap-1.5 text-zk-sm text-zk-text">
            <input type="checkbox" checked={slOn} onChange={(e) => setSlOn(e.target.checked)} data-testid="sl-unpaid-check" />
            全部未確認病假當無薪，照鎖（淨係老闆做得到，會記落操作紀錄）
          </label>
          {slOn && (
            <div className="flex flex-wrap items-center gap-2">
              <input className={inputCls} placeholder="覆蓋原因（必填）" value={slReason} onChange={(e) => setSlReason(e.target.value)} data-testid="sl-unpaid-reason" />
              <Button variant="danger" size="md" className="whitespace-nowrap disabled:cursor-not-allowed" type="button" data-testid="sl-unpaid-lock-month" onClick={() => onSlUnpaidLock(slReason.trim())} disabled={busy || !slReason.trim()}>
                全部當無薪並鎖定 {month}
              </Button>
            </div>
          )}
        </div>
      )}
      {locked && canUnlock && (
        <div className="flex flex-wrap items-center gap-2 border-t border-zk-border-soft px-4 py-3" data-testid="unlock-box">
          <span className="text-zk-sm text-zk-muted">解鎖原因（必填，會寫入操作紀錄）</span>
          <input className={inputCls} placeholder="解鎖原因" value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} data-testid="unlock-reason" />
          <Button variant="danger" size="md" className="whitespace-nowrap disabled:cursor-not-allowed"
            type="button"
            data-testid="unlock-month"
            onClick={() => onUnlock(unlockReason.trim())}
            disabled={busy || !unlockReason.trim()}

          >
            解鎖 {month}
          </Button>
        </div>
      )}
    </section>
  );
}
