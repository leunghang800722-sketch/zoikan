// 保安員名冊頁頂欄（搜尋／月份／篩選／新增）。
// P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變。
"use client";

import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChip";
import { MenuButton } from "@/components/ui/MenuButton";
import { MonthPicker } from "@/components/ui/MonthPicker";
import { PageHeader } from "@/components/ui/PageHeader";
import { kickerFor } from "@/lib/nav/schema";

export type IdentityFilter = "" | "missing_hkid" | "missing_tel" | "missing_any";

export function GuardsFilters({
  isBroker,
  canOcr,
  search,
  setSearch,
  searchHasHkid,
  month,
  setMonth,
  expiringDays,
  setExpiringDays,
  identityFilter,
  setIdentityFilter,
  openCreate,
}: {
  isBroker: boolean;
  canOcr: boolean;
  search: string;
  setSearch: (v: string) => void;
  searchHasHkid: boolean;
  month: string;
  setMonth: (v: string) => void;
  expiringDays: 0 | 30 | 90;
  setExpiringDays: (v: 0 | 30 | 90) => void;
  identityFilter: IdentityFilter;
  setIdentityFilter: (v: IdentityFilter) => void;
  openCreate: () => void;
}) {
  return (
      <PageHeader
        kicker={kickerFor("/guards", isBroker)}
        title="保安員"
        subtitle="牌照／平安卡／QAS 90 日內到期或已過期嘅列會高亮。"
        actions={
          <>
            <FilterChip label="搜尋" showCaret={false}>
              <input type="text" placeholder={searchHasHkid ? "姓名 / 工號 / 電話 / 身份證" : "姓名 / 工號 / 電話"} value={search} onChange={(e) => setSearch(e.target.value)} className="w-36" />
            </FilterChip>
            <MonthPicker label="本月更數月份" value={month} onChange={setMonth} />
            {/* WP-PII：老闆決定「雞頭視角完全唔變」——呢個新 FilterChip
                淨係內部角色顯示，雞頭個 toolbar 保持原樣。 */}
            {/* P8.4：同一個 chip——平時係「90 日內到期」（舊行為不變）；經證件到期週報連結 /guards?expiring=30 入嚟就顯示「30 日內到期」（已剔）。唔加第二個 chip，免得工具列多一行令「新增 ▾」選單跌去側欄底。 */}
            {!isBroker && (
              <FilterChip label={`牌照／平安卡／QAS ${expiringDays === 30 ? 30 : 90} 日內到期`} showCaret={false}>
                <input type="checkbox" checked={expiringDays !== 0} onChange={(e) => setExpiringDays(e.target.checked ? 90 : 0)} data-testid="guards-expiring-toggle" />
              </FilterChip>
            )}
            {!isBroker && (
              <FilterChip label="識別狀態">
                <select value={identityFilter} onChange={(e) => setIdentityFilter(e.target.value as typeof identityFilter)}>
                  <option value="">全部</option>
                  <option value="missing_any">缺身份證或電話</option>
                  <option value="missing_hkid">缺身份證</option>
                  <option value="missing_tel">缺電話</option>
                </select>
              </FilterChip>
            )}
            {/* P3-3.6：三個新增入口收成一個「新增 ▾」（手動／用證件／批量導入）；雞頭只有手動新增。 */}
            {isBroker ? (
              <Button variant="primary" onClick={openCreate}>
                新增保安員
              </Button>
            ) : (
              <MenuButton
                label="新增"
                variant="primary"
                testId="guards-add-menu"
                items={[
                  { label: "手動新增", onSelect: openCreate, testId: "guards-add-manual" },
                  ...(canOcr ? [{ label: "用證件新增", href: "/guards/new-from-docs", testId: "guards-new-from-docs" }] : []),
                  { label: "批量導入", href: "/guards/import", testId: "guards-add-import" },
                ]}
              />
            )}
          </>
        }
      />
  );
}
