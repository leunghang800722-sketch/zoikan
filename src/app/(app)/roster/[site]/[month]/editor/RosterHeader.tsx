// 更表編輯器頁首（桌面／手機）。
// P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變。
"use client";

import { useEffect, useState } from "react";
import { GuardedLink } from "@/components/ui/GuardedLink";
import { Button } from "@/components/ui/Button";
import { iconBtn, menuItemBtn } from "@/components/ui/button-classes";
import { nextMonthStr, prevMonthStr } from "./roster-utils";

export function RosterHeader({
  compact,
  siteName,
  siteId,
  month,
  year,
  monthNum,
  days,
  siteShiftCodes,
  dirtyCount,
  monthLocked,
  saving,
  hasRosterLayout,
  goMonth,
  setShowAddGuard,
  handleCopyPrevMonth,
  handleRevert,
  handleSave,
}: {
  compact: boolean;
  siteName: string;
  siteId: string;
  month: string;
  year: number;
  monthNum: number;
  days: number;
  siteShiftCodes: string[];
  dirtyCount: number;
  monthLocked: boolean;
  saving: boolean;
  hasRosterLayout: boolean | undefined;
  goMonth: (targetMonth: string) => void;
  setShowAddGuard: (v: boolean) => void;
  handleCopyPrevMonth: () => void | Promise<void>;
  handleRevert: () => void;
  handleSave: () => void | Promise<void>;
}) {
  // WP-R2 第 5 項：手機頁首「⋯」更多選單（README §23 冇畫，但四個動作
  // 「加保安員／複製上月／匯出 Excel／還原」手機唔可以消失）。
  const [showMobileMore, setShowMobileMore] = useState(false);
  // WP-R2 第 5 項：手機「⋯」更多選單——Escape／點選單以外嘅地方收埋。
  useEffect(() => {
    if (!showMobileMore) return;
    const onDocMouseDown = () => setShowMobileMore(false);
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMobileMore(false);
    };
    window.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onDocKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onDocKeyDown);
    };
  }, [showMobileMore]);

  return (
    <>
      {/* ================= 桌面頁首（README §04） ================= */}
      {!compact && (
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <GuardedLink href="/roster" className="flex items-center gap-1.5 text-xs text-zk-muted hover:text-zk-text">
              更表 <span className="text-zk-faintest">/</span> {siteName || "…"}
            </GuardedLink>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-3">
              <h1 className="text-zk-xl font-bold tracking-[-0.01em] text-zk-text">{siteName || "更表編輯器"}</h1>
              <div className="flex items-center gap-1.5 rounded-md border border-zk-border bg-white px-2.5 py-[3px] text-zk-base text-zk-text-secondary">
                <button type="button" className={iconBtn} onClick={() => goMonth(prevMonthStr(month))} aria-label="上一月">
                  ‹
                </button>
                {year} 年 {monthNum} 月
                <button type="button" className={iconBtn} onClick={() => goMonth(nextMonthStr(month))} aria-label="下一月">
                  ›
                </button>
              </div>
              <span className="text-xs text-zk-muted">
                {days} 日{siteShiftCodes.length > 0 ? ` · 更別 ${siteShiftCodes.join("／")}` : ""}
                {dirtyCount > 0 ? ` · ${dirtyCount} 格未儲存` : ""}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="md" className="disabled:cursor-not-allowed"
              type="button"
              disabled={monthLocked}

              onClick={() => setShowAddGuard(true)}
            >
              加保安員
            </Button>
            <Button variant="secondary" size="md" className="disabled:cursor-not-allowed"
              type="button"
              disabled={monthLocked}

              onClick={handleCopyPrevMonth}
            >
              複製上月（{prevMonthStr(month)}）
            </Button>
            {hasRosterLayout === false ? (
              <span
                data-testid="roster-export-unavailable"
                title="呢個盤未有更表版面模板，唔可以匯出"
                className="cursor-not-allowed rounded-md border border-zk-border px-3.5 py-[7px] text-zk-base text-zk-faintest"
              >
                未有更表模板，唔可以匯出
              </span>
            ) : (
              <a
                data-testid="roster-export-link"
                href={`/api/sites/${siteId}/roster-export?month=${month}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-md border border-zk-input-border bg-white px-3.5 py-[7px] text-zk-base text-zk-text-secondary hover:bg-zk-header"
              >
                匯出 Excel
              </a>
            )}
            <span className="mx-1 h-[22px] w-px bg-zk-border" />
            <Button variant="secondary" size="md" className="disabled:cursor-not-allowed"
              type="button"
              disabled={dirtyCount === 0}

              style={{ color: "var(--zk-faint)" }}
              onClick={handleRevert}
            >
              還原
            </Button>
            <Button variant="primary" size="md" className="disabled:cursor-not-allowed"
              type="button"
              disabled={monthLocked || saving || dirtyCount === 0}

              style={{ opacity: monthLocked ? 0.45 : saving || dirtyCount === 0 ? 0.6 : 1 }}
              onClick={handleSave}
            >
              {saving ? "儲存緊……" : "儲存"}
            </Button>
          </div>
        </div>
      )}

      {/* ================= 手機頁首（README §23） =================
          注意：R1 嘅全域手機頂欄（漢堡＋「在勤」＋頭像，`MobileNav.tsx`）
          呢頁都會照樣顯示喺上面——原型 `mShowBar` 喺 roster 頁會收埋個
          全域頂欄，但 `MobileNav.tsx` 屬於 R1 外殼檔案，WP-R2 任務明確
          唔准改，所以呢個更表專屬頂欄改為疊喺全域頂欄下面（唔係取代
          佢），見完成回報「偏差」一節。 */}
      {compact && (
        <div data-testid="roster-mobile-header" className="-mx-4 -mt-3.5 flex items-center justify-between gap-3 border-b border-zk-border bg-white px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <GuardedLink href="/roster" aria-label="返回更表索引" className="text-xl text-zk-text">
              ‹
            </GuardedLink>
            <div className="min-w-0">
              <div className="truncate text-zk-lg font-bold text-zk-text">{siteName || "更表編輯器"}</div>
              <div className="text-zk-xs text-zk-muted">
                {year} 年 {monthNum} 月 · {monthLocked ? "已鎖定" : "排更中"}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* WP-R2 第 5 項：加保安員／複製上月／匯出 Excel／還原——手機
                頁首冇位擺齊，收埋做「⋯」選單，沿用桌面同一啲 handler。 */}
            <div className="relative">
              <button
                type="button"
                data-testid="roster-mobile-more"
                aria-label="更多操作"
                aria-haspopup="menu"
                aria-expanded={showMobileMore}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-zk-input-border text-zk-md leading-none text-zk-text-secondary"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setShowMobileMore((v) => !v)}
              >
                ⋯
              </button>
              {showMobileMore && (
                <div
                  data-testid="roster-mobile-more-menu"
                  className="absolute right-0 top-9 z-40 w-48 rounded-md border border-zk-border bg-white py-1 text-zk-base text-zk-text"
                  style={{ boxShadow: "0 6px 20px rgba(15,23,42,.15)" }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    disabled={monthLocked}
                    className={menuItemBtn}
                    onClick={() => {
                      setShowMobileMore(false);
                      setShowAddGuard(true);
                    }}
                  >
                    加保安員
                  </button>
                  <button
                    type="button"
                    disabled={monthLocked}
                    className={menuItemBtn}
                    onClick={() => {
                      setShowMobileMore(false);
                      handleCopyPrevMonth();
                    }}
                  >
                    複製上月（{prevMonthStr(month)}）
                  </button>
                  {hasRosterLayout === false ? (
                    <span
                      data-testid="roster-export-unavailable"
                      title="呢個盤未有更表版面模板，唔可以匯出"
                      className="block px-3 py-1.5 text-left text-zk-faintest"
                    >
                      未有更表模板，唔可以匯出
                    </span>
                  ) : (
                    <a
                      data-testid="roster-export-link"
                      href={`/api/sites/${siteId}/roster-export?month=${month}`}
                      target="_blank"
                      rel="noreferrer"
                      className="block px-3 py-1.5 hover:bg-zk-header"
                      onClick={() => setShowMobileMore(false)}
                    >
                      匯出 Excel
                    </a>
                  )}
                  <button
                    type="button"
                    disabled={dirtyCount === 0}
                    className={menuItemBtn}
                    onClick={() => {
                      setShowMobileMore(false);
                      handleRevert();
                    }}
                  >
                    還原{dirtyCount > 0 ? `（${dirtyCount} 格未儲存）` : ""}
                  </button>
                </div>
              )}
            </div>
            <Button variant="primary" size="sm" className="disabled:cursor-not-allowed"
              type="button"
              disabled={monthLocked || saving || dirtyCount === 0}

              style={{ opacity: monthLocked ? 0.45 : saving || dirtyCount === 0 ? 0.6 : 1 }}
              onClick={handleSave}
            >
              {saving ? "儲存緊…" : "儲存"}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
