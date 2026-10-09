"use client";
// WP-ONE-CLICK-AUTO §31.3 E：報告嘅「自動處理摘要」＋「要你睇」＋撤銷掣。
// 冇 PII：淨係盤名、雞頭代號、更種代號、數目。
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";

export interface AutoReportDTO {
  summary: {
    sites_aliased: number;
    sites_created: number;
    shift_types_created: number;
    aliases_from_postorder: number;
    cards_created: number;
    records_priced: number;
    records_settled: number;
    guard_matches_auto: number;
    variances_explained: number;
    variances_unexplained: number;
    unpriced_records: number;
    counts: { countable: number; external: number; internal_cash: number };
  };
  auto_lines: Array<{ kind: string; text: string }>;
  review: Array<{ kind: string; text: string; confidence: "propose" | "unknown"; question_id: string | null }>;
  triage_session_id: string | null;
  undone: boolean;
  undone_at: string | null;
  voided_card_price_check?: { count: number; record_ids: string[] };
}

const KIND_LABEL: Record<string, string> = {
  month_close_site_alias: "盤名",
  month_close_site_new: "新盤",
  month_close_pricing: "定價",
  month_close_settlement: "結算雞頭",
  month_close_guard_match: "安員配對",
  month_close_shift_variance: "更數差異",
};

export function AutoSummaryCard({ auto, busy, onUndo, onOpenTriage }: { auto: AutoReportDTO; busy: boolean; onUndo: () => void; onOpenTriage: () => void }) {
  const s = auto.summary;
  const items: Array<[string, number]> = [
    ["自動對盤", s.sites_aliased],
    ["自動建新盤", s.sites_created],
    ["新盤更種", s.shift_types_created],
    ["自動建價卡", s.cards_created],
    ["自動定價（更）", s.records_priced],
    ["自動歸屬結算雞頭（更）", s.records_settled],
    ["自動安員配對", s.guard_matches_auto],
    ["解釋咗嘅更數異常", s.variances_explained],
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="auto-summary">
      {auto.undone && (
        <div className="rounded border border-orange-300 bg-orange-50 px-3 py-2 text-[12.5px] text-orange-900" data-testid="auto-undone-banner">
          已撤銷：呢次一鍵結算嘅自動改動（價卡、別名、結算雞頭、自動配對）已經還原{auto.undone_at ? `（${new Date(auto.undone_at).toLocaleString("zh-HK")}）` : ""}；下面數字係還原前嘅摘要。想重做請再撳「一鍵結算」。
        </div>
      )}
      {auto.undone && (auto.voided_card_price_check?.count ?? 0) > 0 && (
        <div className="rounded border border-orange-300 bg-orange-50 px-3 py-2 text-[12.5px] text-orange-900" data-testid="auto-voided-price-warning">
          {auto.voided_card_price_check!.count} 更價錢同已作廢卡相同但冇自動定價紀錄，可能係人手輸入，請檢查（更 id：{auto.voided_card_price_check!.record_ids.slice(0, 10).map((x) => x.slice(0, 8)).join("、")}{auto.voided_card_price_check!.record_ids.length > 10 ? "…" : ""}）
        </div>
      )}
      <div className="rounded border border-zk-border p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] font-medium text-zk-text">
            自動處理摘要 {auto.undone && <Pill variant="warning">已還原</Pill>}
          </div>
          <Button variant="secondary" onClick={onUndo} disabled={busy || auto.undone} data-testid="undo-auto">
            還原所有自動改動
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {items.map(([label, n]) => (
            <div key={label} className="rounded border border-zk-border px-2.5 py-2">
              <div className="text-[11px] text-zk-muted">{label}</div>
              <div className="text-base font-bold">{n}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[11.5px] text-zk-muted" data-testid="auto-counts">
          本月更數（shift 記錄）：計數更次 {s.counts.countable}（其中公司兵 {s.counts.internal_cash}）；客戶自己人（external）{s.counts.external} 更另計，唔入收入／成本。
          {s.variances_unexplained > 0 ? ` 仲有 ${s.variances_unexplained} 個更數差異解釋唔到。` : ""}
        </div>
        {auto.auto_lines.length > 0 && (
          <details className="mt-2 text-[12px]">
            <summary className="cursor-pointer text-zk-muted">逐項睇（{auto.auto_lines.length}）</summary>
            <ul className="mt-1 list-disc pl-4 text-zk-muted">
              {auto.auto_lines.map((l, i) => (
                <li key={i}>{l.text}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="rounded border border-orange-200 bg-orange-50 p-3" data-testid="auto-review">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] font-medium text-orange-900">要你睇（{auto.review.length}）</div>
          <div className="flex items-center gap-2">
            {auto.triage_session_id && auto.review.length > 0 && (
              <Button variant="primary" onClick={onOpenTriage} disabled={busy} data-testid="open-triage">
                逐條一撳確認
              </Button>
            )}
            <Link href="/triage" className="text-[12px] text-orange-900 underline">
              去分診頁
            </Link>
          </div>
        </div>
        {auto.review.length === 0 ? (
          <div className="text-[12.5px] text-orange-900">冇要你睇嘅項目——系統全部有依據、已自動處理。</div>
        ) : (
          <ul className="list-disc space-y-0.5 pl-4 text-[12.5px] text-orange-900">
            {auto.review.map((r, i) => (
              <li key={i}>
                <Pill variant="neutral">{KIND_LABEL[r.kind] ?? r.kind}</Pill> {r.confidence === "propose" ? "（有建議）" : "（冇依據）"} {r.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
