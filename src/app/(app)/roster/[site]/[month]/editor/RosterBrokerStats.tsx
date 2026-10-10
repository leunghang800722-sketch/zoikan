// 更表編輯器雞頭統計卡（桌面）／chips（手機）。
// P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變。
"use client";

import { Button } from "@/components/ui/Button";
import { brokerColor } from "@/lib/ui/broker-color";
import type { BrokerStat } from "./roster-utils";

export function RosterBrokerStats({
  brokerStats,
  compact,
  isBrokerSession,
  selectedBrokerCode,
  setSelectedBrokerCode,
}: {
  brokerStats: BrokerStat[];
  compact: boolean;
  isBrokerSession: boolean;
  selectedBrokerCode: string | null;
  setSelectedBrokerCode: (code: string | null) => void;
}) {
  return (
    <>
      {/* ================= 雞頭統計卡（桌面，README §04） ================= */}
      {brokerStats.length > 0 && !compact && (
        <div className="flex flex-col gap-2" data-testid="broker-stats-bar">
          <div
            className="grid gap-2.5"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}
            data-testid="broker-stats-table"
          >
            {brokerStats.map((b) => {
              const scheduled = b.confirmed + b.pending;
              const isSelected = selectedBrokerCode === b.code;
              const bc = brokerColor(b.code);
              const pct = b.quotaTarget > 0 ? Math.min(100, Math.round((scheduled / b.quotaTarget) * 100)) : 100;
              return (
                <div
                  key={b.brokerId}
                  data-testid="broker-stats-row"
                  data-broker-code={b.code}
                  className={`flex flex-col gap-1.5 rounded-lg border bg-white px-3.5 py-2.5 ${isBrokerSession ? "" : "cursor-pointer hover:bg-zk-header"}`}
                  style={{ borderColor: isSelected ? bc.dot : "var(--zk-border)" }}
                  onClick={isBrokerSession ? undefined : () => setSelectedBrokerCode(isSelected ? null : b.code)}
                >
                  <div className="flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-zk-sm font-semibold text-zk-text">
                      <span className="h-2 w-2 rounded-sm" style={{ background: bc.dot }} />
                      {b.code}
                      {b.name ? `（${b.name}）` : ""}
                    </span>
                    <span className="text-zk-xs text-zk-muted">{b.headcount} 人</span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-zk-lg font-bold text-zk-text">{b.confirmed}</span>
                    <span className="text-zk-xs text-zk-muted">
                      已確認 · 待審批{" "}
                      <span style={{ color: b.pending > 0 ? "var(--zk-warning-darker)" : "var(--zk-muted)", fontWeight: b.pending > 0 ? 600 : 400 }}>{b.pending}</span>
                    </span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-zk-surface">
                    <div className="h-full" style={{ width: `${pct}%`, background: bc.dot }} />
                  </div>
                  <div className="text-zk-xs text-zk-faint">
                    {b.quotaTarget > 0 ? `配額 ${b.quotaTarget} · 已排 ${scheduled}` : "未設配額（軟性限制）"}
                  </div>
                </div>
              );
            })}
          </div>
          {!isBrokerSession && (
            <div className="flex items-center gap-2">
              {/* 舊雞頭篩選下拉：卡本身已經可以撳篩選，呢個下拉保留做
                  輔助／後備（testid 要留喺 DOM），視覺上隱藏。 */}
              <label htmlFor="broker-filter-select" className="sr-only">
                雞頭篩選
              </label>
              <select
                id="broker-filter-select"
                data-testid="broker-filter-select"
                className="sr-only"
                value={selectedBrokerCode ?? ""}
                onChange={(e) => setSelectedBrokerCode(e.target.value || null)}
              >
                <option value="">全部</option>
                {brokerStats.map((b) => (
                  <option key={b.brokerId} value={b.code}>
                    {b.code}
                    {b.name ? `（${b.name}）` : ""}
                  </option>
                ))}
              </select>
              {selectedBrokerCode && (
                <Button variant="link" size="sm" type="button" data-testid="broker-filter-clear" onClick={() => setSelectedBrokerCode(null)}>
                  清除篩選
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ================= 雞頭 chips（手機，README §23） ================= */}
      {brokerStats.length > 0 && compact && (
        <div className="flex flex-col gap-1.5" data-testid="broker-stats-bar">
          <div className="nosb flex gap-1.5 overflow-x-auto" data-testid="broker-stats-table">
            {brokerStats.map((b) => {
              const isSelected = selectedBrokerCode === b.code;
              const bc = brokerColor(b.code);
              return (
                <button
                  key={b.brokerId}
                  type="button"
                  data-testid="broker-stats-row"
                  data-broker-code={b.code}
                  disabled={isBrokerSession}
                  className="flex shrink-0 items-center gap-1 rounded-[14px] border px-2 py-1 text-zk-xs text-zk-text-secondary"
                  style={{ borderColor: isSelected ? bc.dot : "var(--zk-border)" }}
                  onClick={() => setSelectedBrokerCode(isSelected ? null : b.code)}
                >
                  <span className="h-[7px] w-[7px] rounded-sm" style={{ background: bc.dot }} />
                  {b.code}
                  {b.name ? `（${b.name}）` : ""} <b>{b.confirmed}</b>
                </button>
              );
            })}
          </div>
          {!isBrokerSession && (
            <div className="flex items-center gap-2">
              <select
                id="broker-filter-select"
                data-testid="broker-filter-select"
                className="sr-only"
                value={selectedBrokerCode ?? ""}
                onChange={(e) => setSelectedBrokerCode(e.target.value || null)}
                aria-hidden
              >
                <option value="">全部</option>
                {brokerStats.map((b) => (
                  <option key={b.brokerId} value={b.code}>
                    {b.code}
                  </option>
                ))}
              </select>
              {selectedBrokerCode && (
                <Button variant="link" size="sm" type="button" data-testid="broker-filter-clear" onClick={() => setSelectedBrokerCode(null)}>
                  清除篩選
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
