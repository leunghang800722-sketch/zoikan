"use client";
// P3-4.2：「N 更未定價／N 格冇結算單位」共用提示（取代 gross-margin／月結總表／糧明細／本月應收／更表編輯器 5 份複製）。
// variant="compact"（報表頁）：一行＋「去處理 ›」；variant="full"（更表編輯器）：完整逐組清單＋重新計價掣。
// 只改顯示：數字、分組全部由呼叫方傳入，唔改任何計算。
import Link from "next/link";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";

export type UnpricedNoticeGroup = {
  site_id: string;
  site_name: string;
  shift_type_code: string;
  broker_code: string | null;
  broker_display: string;
  category?: "payout_unpriced" | "client_unpriced" | "no_settlement" | "ot_unpriced";
  count: number;
};

export interface UnpricedNoticeProps {
  variant: "compact" | "full";
  month: string;
  unpricedCount: number;
  noSettlementCount: number;
  groups: UnpricedNoticeGroup[];
  /** 句尾講邊份報表唔計（例如「毛利表」）。 */
  scope?: string;
  /** full：出街價／收客價拆數。 */
  payoutCount?: number;
  clientCount?: number;
  /** full：重新計價掣。 */
  canReprice?: boolean;
  repricing?: boolean;
  onReprice?: () => void;
}

function groupKey(g: UnpricedNoticeGroup) {
  return `${g.category ?? "payout_unpriced"}|${g.site_id}|${g.shift_type_code}|${g.broker_code ?? "none"}`;
}

export function UnpricedNotice(p: UnpricedNoticeProps) {
  const { variant, month, unpricedCount, noSettlementCount, groups } = p;
  if (unpricedCount <= 0 && noSettlementCount <= 0) return null;
  const fixHref = `/rate-cards?month=${month}`;

  if (variant === "compact") {
    return (
      <Banner
        compact
        kind={noSettlementCount > 0 ? "error" : "warning"}
        data-testid="unpriced-notice"
        action={
          <Link href={fixHref} className="font-semibold underline" style={{ color: "inherit" }}>
            去處理 ›
          </Link>
        }
      >
        {unpricedCount > 0 && <>呢個月有 {unpricedCount} 更未定價（冇對應價目卡），金額未計入{p.scope ?? "報表"}</>}
        {unpricedCount > 0 && noSettlementCount > 0 && "；"}
        {noSettlementCount > 0 && <>{noSettlementCount} 格冇結算單位（唔會計入任何雞頭／長工／公司兵嘅糧單，只會出現喺「未歸屬結算單位」行）</>}
      </Banner>
    );
  }

  return (
    <>
      {unpricedCount > 0 && (
        <Banner
          compact
          kind="warning"
          data-testid="unpriced-notice"
          action={
            p.canReprice && p.onReprice ? (
              <Button variant="secondary" size="sm" onClick={p.onReprice} disabled={p.repricing}>
                {p.repricing ? "計價緊…" : `重新計價（${month}）`}
              </Button>
            ) : undefined
          }
        >
          <p className="font-medium">呢個月有 {unpricedCount} 更未定價（冇對應價目卡），金額未計入報表：</p>
          {/* S3：分開講「出街價未定」／「收客價未定」（後者淨係逐更盤先算，月費／admin_fee／special 盤 client_rate=null 屬正常）。 */}
          <p className="text-zk-sm opacity-80">
            出街價未定 {p.payoutCount ?? unpricedCount} 更；收客價未定（逐更盤）{p.clientCount ?? 0} 更
          </p>
          <ul className="mt-1 list-disc pl-5">
            {/* no_settlement 分類唔喺呢個清單顯示（有自己獨立、更搶眼嘅提示）——留喺度會令人以為補張卡就得。 */}
            {groups
              .filter((g) => g.category !== "no_settlement")
              .map((g) => (
                <li key={groupKey(g)}>
                  {g.category === "client_unpriced" ? "收客價未定 · " : "出街價未定 · "}
                  {g.site_name} · 更別 {g.shift_type_code} · 雞頭 {g.broker_display} · {g.count} 更
                </li>
              ))}
          </ul>
          <p className="mt-1">
            去<Link href="/rate-cards" className="underline" style={{ color: "inherit" }}>價目頁</Link>補卡後
            {p.canReprice ? "，撳右邊「重新計價」。" : "，請有「出街價:update」權限嘅同事撳「重新計價」。"}
          </p>
        </Banner>
      )}
      {noSettlementCount > 0 && (
        <Banner compact kind="error" data-testid="no-settlement-notice">
          <p className="font-medium">
            呢個月有 {noSettlementCount} 更冇結算單位（settlement_broker_id 未定）——
            <strong>呢批更唔會出現喺任何雞頭嘅糧明細</strong>，請盡快幫呢啲格指定雞頭再儲存。
          </p>
          <ul className="mt-1 list-disc pl-5">
            {groups
              .filter((g) => g.category === "no_settlement")
              .map((g) => (
                <li key={`no_settlement|${g.site_id}|${g.shift_type_code}`}>
                  {g.site_name} · 更別 {g.shift_type_code} · {g.count} 更
                </li>
              ))}
          </ul>
        </Banner>
      )}
    </>
  );
}
