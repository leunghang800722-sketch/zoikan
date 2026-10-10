// 更表編輯器提示橫幅（鎖定／圖例／未定價／警示／錯誤）同本月配額列。
// P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變。
"use client";

import Link from "next/link";
import { Banner } from "@/components/ui/Banner";
import { UnpricedNotice } from "@/components/UnpricedNotice";
import { shiftCodeStyle } from "@/lib/ui/shift-code-color";
import type { BrokerDto, QuotaDto, ShiftTypeDto, UnpricedSummary } from "./roster-types";

export function RosterNotices({
  monthLocked,
  month,
  compact,
  siteShiftCodes,
  guardsPaidByClient,
  unpricedSummary,
  canReprice,
  repricing,
  handleReprice,
  warnings,
  errorBanner,
  infoBanner,
}: {
  monthLocked: boolean;
  month: string;
  compact: boolean;
  siteShiftCodes: string[];
  guardsPaidByClient: boolean;
  unpricedSummary: UnpricedSummary | null;
  canReprice: boolean;
  repricing: boolean;
  handleReprice: () => void | Promise<void>;
  warnings: string[];
  errorBanner: string | null;
  infoBanner: string | null;
}) {
  return (
    <>
      {/* ================= 鎖定／提示橫幅 ================= */}
      {monthLocked ? (
        <Banner compact
          kind="warning"
          action={
            <Link href={`/month-close?month=${month}`} className="text-zk-sm underline" style={{ color: "inherit" }}>
              去一鍵結算
            </Link>
          }
        >
          {month} 已鎖定 — 更表只讀。如需修改，請聯絡有「月結鎖定解鎖」權限嘅同事。
        </Banner>
      ) : (
        !compact && (
          <div className="flex items-center gap-3.5 rounded-md border border-zk-border bg-white px-3 py-2 text-xs text-zk-muted">
            <span>撳格打字（D / N / SH / RD / AL）· 拖選多格一齊填 · 右鍵：清除／整行填／整行清</span>
            <span className="ml-auto inline-flex flex-wrap gap-2.5">
              {siteShiftCodes.map((code) => {
                const s = shiftCodeStyle(code);
                return (
                  <span key={code} className="inline-flex items-center gap-1">
                    <span className="h-3 w-3 rounded-[3px]" style={{ background: s.bg === "transparent" ? "var(--zk-surface)" : s.bg, border: s.border }} />
                    {code}
                  </span>
                );
              })}
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded-[3px]" style={{ border: "1px dashed var(--zk-amber)" }} />
                假
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded-[3px]" style={{ border: "1px dashed var(--zk-primary)" }} />
                待批
              </span>
              {/* P2 整合驗收應修①：加返「未儲存」圖例——同格仔嘅 dirty inset
                  ring 同一個顏色（琥珀色），等用戶睇圖例就知呢個顏色代表
                  「未儲存」，唔使靠估。 */}
              <span className="inline-flex items-center gap-1">
                <span className="h-3 w-3 rounded-[3px]" style={{ boxShadow: "inset 0 0 0 2px var(--zk-amber)" }} />
                未儲存
              </span>
            </span>
          </div>
        )
      )}
      {/* WP-MISC（老闆 2026-09-20 拍板，LINK：TKO Gateway 厚A/B/C）：呢類
          「客戶直接出糧」嘅盤——頁頂提示，同鎖定狀態獨立（鎖定與否都要
          畀用戶知呢個盤嘅更唔計工資／客價）。 */}
      {guardsPaidByClient && (
        <Banner compact kind="info">
          {/* WP-MISC Opus 應修（P0 同一輪覆核）：舊文字講「亦唔會出現喺
              糧單」會令人以為呢個盤嘅更表記錄喺糧單完全睇唔到——實情係
              糧單入面呢個盤照計更數，淨係金額為 0（`buildPayrollTotals()`
              對 LINK 盤唔寫 snapshot，但記錄仍然掛住雞頭/內部結算單位，
              照樣出現喺對應 broker 明細）。唔准改報表本身，淨係改呢句
              文字令講法準確。 */}
          呢個盤嘅保安員由客戶直接出糧，我哋只收每月服務費——呢度嘅更唔計工資／客價（糧單入面更數照計、金額為 0）。
        </Banner>
      )}
      {/* WP-PRICE §3：呢個盤呢個月未定價格持續提示（唔止儲存嗰下先出——
          載入頁面已經攞緊，等用戶就算冇改動都睇到舊有缺價格）。 */}
      {/* WP-PRICE §3：呢個盤呢個月未定價／冇結算單位持續提示（載入頁面已經攞緊，就算冇改動都睇到）。P3-4.2：共用 <UnpricedNotice variant="full">。 */}
      {unpricedSummary && (
        <UnpricedNotice
          variant="full"
          month={month}
          unpricedCount={unpricedSummary.count}
          noSettlementCount={unpricedSummary.noSettlementCount ?? 0}
          groups={unpricedSummary.groups}
          payoutCount={unpricedSummary.payoutCount}
          clientCount={unpricedSummary.clientCount}
          canReprice={canReprice}
          repricing={repricing}
          onReprice={handleReprice}
        />
      )}
      {warnings.length > 0 && (
        <div className="rounded border border-zk-warning-border bg-zk-warning-bg text-zk-warning-dark text-sm px-3 py-2 space-y-1">
          <p className="font-medium">儲存成功，但有以下軟性警示（唔擋寫入，建議留意）：</p>
          <ul className="list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {errorBanner && (
        <Banner kind="error" className="whitespace-pre-wrap">{errorBanner}</Banner>
      )}
      <Banner kind="info" message={infoBanner} data-testid="roster-info-banner" />
    </>
  );
}

export function QuotaStrip({
  quotas,
  shiftTypesById,
  brokersById,
}: {
  quotas: QuotaDto[];
  shiftTypesById: Map<string, ShiftTypeDto>;
  brokersById: Map<string, BrokerDto>;
}) {
  return (
    <>
      {quotas.length > 0 && (
        <div className="text-xs text-zk-muted border border-zk-border rounded p-2">
          <p className="font-medium text-zk-text-secondary mb-1">本月配額（純顯示，超配額警示會喺儲存後嘅黃色提示出現）：</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {quotas.map((q) => (
              <li key={q.id}>
                {shiftTypesById.get(q.shift_type_id)?.code ?? q.shift_type_id} · {brokersById.get(q.broker_id)?.name ?? q.broker_id}：{q.target_shifts} 更
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
