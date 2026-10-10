// 保安員名冊表（桌面表格＋手機卡）：分頁 render（P3-5.2：一次最多 render 100 行，「載入更多」）。
// P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變。
"use client";

import { useEffect, useState } from "react";
import { ConfirmVoidButton } from "@/components/ui/ConfirmVoidButton";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth, EmptyState, TableLoadingRow } from "@/components/ui/DataTable";
import { fmt, fmtDate, isExpired, isExpiringSoon } from "@/lib/ui/format";
import { brokerColor } from "@/lib/ui/broker-color";
import type { BrokerRow, GuardRow } from "./guards-types";
import { earlierExpiry } from "./guards-utils";

/** 一次最多 render 嘅行數（540 人一次 render 會有 ~19k DOM 節點）；搜尋／篩選照舊由 server 做，唔受影響。 */
export const GUARDS_PAGE_SIZE = 100;
// S2：加返「聘用形式」欄——8 欄變 9 欄。
const colCount = 9;

export function GuardsTable({
  rows: visibleRows,
  loading,
  search,
  resetKey,
  brokers,
  onEdit: openEdit,
  onVoid,
  onUnvoid,
}: {
  rows: GuardRow[];
  loading: boolean;
  search: string;
  /** 搜尋／篩選改變就由頭開始 render（唔跟 reload 重置，儲存後唔會跳返頂）。 */
  resetKey: string;
  brokers: BrokerRow[];
  onEdit: (row: GuardRow) => void;
  onVoid: (id: string, reason: string) => void | Promise<void>;
  onUnvoid: (id: string) => void | Promise<void>;
}) {
  const [shown, setShown] = useState(GUARDS_PAGE_SIZE);
  useEffect(() => {
    setShown(GUARDS_PAGE_SIZE);
  }, [resetKey]);
  const shownRows = visibleRows.slice(0, shown);
  const remaining = visibleRows.length - shownRows.length;

  function broker(id?: string | null): BrokerRow | undefined {
    if (!id) return undefined;
    return brokers.find((x) => x.id === id);
  }

  function statusPill(g: GuardRow) {
    // Opus 覆核 S2：`staff_no` 舊欄而家會 fallback 顯示已取消嘅 U 號（保歷史
    // 更表／匯出），唔可以再用佢判斷「有冇工號」——睇現用 U 號（U 號係
    // 去 Wilson 盤開工嘅硬性要求）；冇 `staff_numbers`（舊 response）先退返舊欄。
    const hasCurrentU = g.staff_numbers ? g.staff_numbers.some((n) => n.scheme === "U" && n.status === "current") : !!g.staff_no;
    if (!hasCurrentU) return <Pill variant="warning">未有現用 U 號</Pill>;
    if (g.status === "active") return <Pill variant="success">在職</Pill>;
    return <Pill variant="neutral">{g.status}</Pill>;
  }

  // WP-STAFFNO：列表「工號」欄——由舊嘅單一 `staff_no` 文字改做逐個
  // scheme 一個 chip（`U…`／`MP…`／`MG…`，淨係 current，additive
  // `staff_numbers`，見 src/app/api/guards/route.ts）；冇任何現用號就
  // 「—」。
  function staffNumberChips(g: GuardRow) {
    const numbers = g.staff_numbers ?? [];
    return (
      <div className="flex flex-wrap items-center gap-1">
        {numbers.length === 0 ? <span className="text-zk-muted">—</span> : null}
        {numbers.map((n) => (
          <Pill key={`${n.scheme}:${n.number}`} variant="neutral">
            {n.number}
          </Pill>
        ))}
        {/* S7：靠一個已取消（former）號搵到嘅結果——標俾用戶知呢個人喺
            搜尋緊嗰個號其實已經取消（列表 chips 本身淨係顯示 current）。 */}
        {g.former_number_hit ? <Pill variant="warning">已取消號命中</Pill> : null}
      </div>
    );
  }

  // WP-PII：牌照/平安卡到期三態 pill——過期紅、90 日內橙、冇填灰「未填」
  // （`isExpiringSoon()` 帶 90 日門檻，見 src/lib/ui/format.ts；已過期
  // 嘅 diffDays 係負數，一樣會 `<=90`，但呢度優先判 `isExpired` 出紅）。
  // Fable5.1（4 個細修 1）：原本必修 4 個做法係將「乙類已失效」塞喺
  // `!expiry` 分支入面——但 `expiry` 呢度傳嘅係 `earlierExpiry(牌照,
  // 平安卡)`，保安員平安卡（safety_card_expiry）仲有效嗰陣 `expiry` 就唔
  // 會係 falsy，成粒 pill 會跌落「有效」綠色分支，完全冚蓋咗「乙類已
  // 失效」呢個警示，用戶睇唔出。改法：`licenceExpiryPill()` 淨係反映
  // `expiry`（最近到期日）本身，「乙類已失效」拆做獨立
  // `siaPermitBLapsedPill()`，兩粒 pill 喺 call site 並排 render（桌面
  // 表格／手機卡都要），互不影響。
  function licenceExpiryPill(expiry?: string | null) {
    if (!expiry) return <Pill variant="neutral">未填</Pill>;
    if (isExpired(expiry)) return <Pill variant="danger">已過期</Pill>;
    if (isExpiringSoon(expiry, 90)) return <Pill variant="warning">90 日內</Pill>;
    return <Pill variant="success">有效</Pill>;
  }

  // Fable5.1：獨立嘅「乙類已失效（滿70歲）」警示 pill——同
  // `licenceExpiryPill()` 並排顯示，唔會被「有效」冚蓋（見上面註解）。
  function siaPermitBLapsedPill(bLapsedByAge?: boolean) {
    if (!bLapsedByAge) return null;
    return <Pill variant="warning">乙類已失效（滿70歲）</Pill>;
  }

  return (
    <>
      {!loading && visibleRows.length === 0 ? (
        <div className={tableCls.wrap}>
          <EmptyState
            title={search ? "搵唔到符合嘅保安員" : "暫時冇保安員"}
            description={search ? "試下改搜尋字眼（姓名／工號／電話）。" : "撳右上「新增」開始建立名冊。"}
          />
        </div>
      ) : (
        <>
          <div className={`hidden sm:block ${tableCls.wrap}`}>
            <table className={tableCls.table} style={{ minWidth: tableMinWidth(colCount) }}>
              <thead>
                <tr>
                  <th className={tableCls.th}>姓名</th>
                  <th className={tableCls.th}>工號</th>
                  <th className={tableCls.th}>雞頭</th>
                  <th className={tableCls.th}>電話</th>
                  <th className={tableCls.th}>聘用形式</th>
                  <th className={tableCls.thNum}>本月更數</th>
                  <th className={tableCls.th}>狀態</th>
                  <th className={tableCls.th}>牌照到期</th>
                  <th className={tableCls.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <TableLoadingRow colSpan={colCount} />
                )}
                {shownRows.map((r) => {
                  // WP-PII（可接受但順手）：牌照／平安卡兩個到期日取較早
                  // 嗰個嚟判斷高亮/顯示，見 earlierExpiry() 頂註解。
                  const nearestExpiry = earlierExpiry(r.sia_permit_expiry, r.safety_card_expiry, r.qas_expiry_date);
                  const expired = isExpired(nearestExpiry);
                  const b = broker(r.default_broker_id);
                  return (
                    <tr key={r.id} className={`${tableCls.rowHover} ${expired ? tableCls.warnRow : ""}`}>
                      <td className={`${tableCls.td} font-medium`}>{r.name_zh}</td>
                      <td className={tableCls.td}>{staffNumberChips(r)}</td>
                      <td className={tableCls.td}>
                        {b ? (
                          <Pill variant="broker" color={brokerColor(b.code)}>
                            {b.name}
                          </Pill>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className={tableCls.td}>{fmt(r.tel)}</td>
                      <td className={tableCls.tdMuted}>{fmt(r.employment_type)}</td>
                      <td className={tableCls.tdNum}>{r.month_shift_count ?? "—"}</td>
                      <td className={tableCls.td}>{statusPill(r)}</td>
                      <td className={tableCls.td}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {licenceExpiryPill(nearestExpiry)}
                          {siaPermitBLapsedPill(r.sia_permit_b_lapsed_by_age)}
                          <span className="text-zk-xs text-zk-muted">{fmtDate(nearestExpiry)}</span>
                        </div>
                      </td>
                      <td className={tableCls.td}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button variant="secondary" size="sm" type="button" onClick={() => openEdit(r)}>
                            編輯
                          </Button>
                          {r.status === "inactive" ? (
                            <Button variant="secondary" size="sm"
                              type="button"
                              onClick={() => onUnvoid(r.id)}

                            >
                              恢復
                            </Button>
                          ) : (
                            <ConfirmVoidButton confirmLabel="確認停用" onConfirm={(reason) => onVoid(r.id, reason)} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="space-y-2 sm:hidden">
            {shownRows.map((r) => {
              const nearestExpiry = earlierExpiry(r.sia_permit_expiry, r.safety_card_expiry, r.qas_expiry_date);
              const expired = isExpired(nearestExpiry);
              const b = broker(r.default_broker_id);
              return (
                <div key={r.id} className={`rounded-lg border border-zk-border bg-white p-3 ${expired ? "bg-zk-danger-bg" : ""}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-zk-base font-medium text-zk-text">{r.name_zh}</span>
                    <span className="text-zk-base tabular-nums text-zk-text">{r.month_shift_count ?? "—"} 更</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-zk-xs text-zk-muted">
                    {staffNumberChips(r)}
                    <span>{fmt(r.tel)}</span>
                    <span>{fmt(r.employment_type)}</span>
                    {b && (
                      <Pill variant="broker" color={brokerColor(b.code)}>
                        {b.name}
                      </Pill>
                    )}
                    {statusPill(r)}
                    {licenceExpiryPill(nearestExpiry)}
                    {siaPermitBLapsedPill(r.sia_permit_b_lapsed_by_age)}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button variant="secondary" size="sm" type="button" onClick={() => openEdit(r)}>
                      編輯
                    </Button>
                    {r.status === "inactive" ? (
                      <Button variant="secondary" size="sm" type="button" onClick={() => onUnvoid(r.id)}>
                        恢復
                      </Button>
                    ) : (
                      <ConfirmVoidButton confirmLabel="確認停用" onConfirm={(reason) => onVoid(r.id, reason)} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {remaining > 0 && (
        <div className="flex items-center justify-center gap-3 text-zk-sm text-zk-muted">
          <span data-testid="guards-shown-count">
            顯示 {shownRows.length} / {visibleRows.length} 位
          </span>
          <Button variant="secondary" size="sm" type="button" data-testid="guards-load-more" onClick={() => setShown((n) => n + GUARDS_PAGE_SIZE)}>
            載入更多（還有 {remaining} 位）
          </Button>
        </div>
      )}
    </>
  );
}
