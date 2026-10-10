"use client";
// WP-ONE-CLICK-AUTO §31.3 E＋WP-MC-UI 1a：「系統自動幫你做咗 N 項」——5 格 tab（新盤更種／自動建價卡／
// 自動定價／歸屬結算雞頭／解釋更數差異；其他類有數先出）＋明細表（頭 6 行＋睇晒）；0 類併一行灰字。
// 降級（§32.1）：逐類／逐行撤銷無 API；「還原所有自動改動」掣只留右欄 RightRail（P3-3.4 唯一 CTA 區，testid undo-auto-rail）。冇 PII：盤名、雞頭代號、更種代號、數目。
import { useState, type ReactNode } from "react";
import { Pill } from "@/components/ui/Pill";
import type { AutoReportDTO } from "@/components/month-close/types";
import { UNDO_NOTE, humanize, deriveAutoCategories, type AutoCatKey } from "@/components/month-close/derive";

export type { AutoReportDTO };
const HEAD_ROWS = 6;

export function AutoSummaryCard({ auto, extraFooter }: { auto: AutoReportDTO; extraFooter?: ReactNode }) {
  const s = auto.summary;
  const { cats, zero, total } = deriveAutoCategories(auto);
  const [sel, setSel] = useState<AutoCatKey | null>(null);
  const [all, setAll] = useState(false);
  const active = cats.find((c) => c.key === sel) ?? cats[0] ?? null;
  const rows = active?.rows ?? [];
  const shown = all ? rows : rows.slice(0, HEAD_ROWS);
  const showPrice = active?.key === "cards" || active?.key === "priced";
  const showBroker = showPrice || active?.key === "settled";
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
      <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
        <div className="flex flex-wrap items-center gap-3 border-b border-zk-border-soft px-4 py-3.5">
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg bg-[#ccfbf1] text-[13px] font-bold text-[#0f766e]">✓</span>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-zk-text">
              系統自動幫你做咗 {total} 項 {auto.undone && <Pill variant="warning">已還原</Pill>}
            </div>
            <div className="text-[12px] text-zk-muted">{UNDO_NOTE}</div>
          </div>
        </div>

        {cats.length > 0 ? (
          <>
            <div className="grid grid-cols-2 border-b border-zk-border-soft sm:grid-cols-3 lg:grid-cols-5" role="tablist">
              {cats.map((c) => {
                const on = c.key === active?.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => {
                      setSel(c.key);
                      setAll(false);
                    }}
                    className="border-r border-zk-border-soft px-3.5 py-3 text-left"
                    style={{ background: on ? "#f0f7ff" : "#fff", boxShadow: on ? "inset 0 -2px 0 #2563eb" : "none" }}
                  >
                    <div className="text-[11.5px] text-zk-muted">{c.name}</div>
                    <div className="mt-0.5 flex items-baseline gap-1">
                      <span className="text-xl font-bold text-zk-text">{c.n}</span>
                      <span className="text-[11.5px] text-zk-muted">{c.unit}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] leading-snug text-zk-faint">{c.sub}</div>
                  </button>
                );
              })}
            </div>
            {active && (
              <div className="px-4 pb-3 pt-2.5">
                <div className="mb-2 flex items-center gap-2.5">
                  <span className="text-[13px] font-semibold text-zk-text">{active.name}</span>
                  <span className="text-[12px] text-zk-muted">{active.n} {active.unit}</span>
                </div>
                {rows.length === 0 ? (
                  <div className="rounded-lg border border-zk-border px-3 py-2.5 text-[12px] text-zk-muted">呢類冇逐項紀錄（逐項最多記 80 項）。</div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-zk-border">
                    <table className="w-full min-w-[560px] text-[12.5px]" data-testid="auto-rows">
                      <thead>
                        <tr className="bg-zk-header text-left text-[11px] font-semibold text-zk-muted">
                          <th className="px-3 py-1.5">盤</th>
                          {showPrice && <th className="px-2 py-1.5">更種</th>}
                          {showBroker && <th className="px-2 py-1.5">雞頭</th>}
                          <th className="px-2 py-1.5 text-right">更數</th>
                          {showPrice && <th className="px-2 py-1.5">定咗嘅價</th>}
                          <th className="px-2 py-1.5">依據</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((r, i) => (
                          <tr key={i} className="border-t border-zk-border-soft align-top">
                            <td className="px-3 py-2 font-medium">{r.site || "—"}</td>
                            {showPrice && <td className="px-2 py-2">{r.shiftType ? <span className="rounded bg-zk-primary-tint px-1.5 py-px text-[11px] font-semibold text-zk-primary-deep">{r.shiftType}</span> : "—"}</td>}
                            {showBroker && <td className="px-2 py-2">{r.broker || "—"}</td>}
                            <td className="px-2 py-2 text-right">{r.n ?? "—"}</td>
                            {showPrice && <td className="px-2 py-2">{humanize(r.price) || "—"}</td>}
                            <td className="px-2 py-2">{r.basis ? <span className="inline-block rounded-[10px] bg-zk-surface px-2 py-0.5 text-[11px] text-[#475569]">{humanize(r.basis)}</span> : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > HEAD_ROWS && (
                      <button type="button" className="w-full border-t border-zk-border-soft bg-white px-3 py-1.5 text-left text-[12px] text-zk-primary" onClick={() => setAll((v) => !v)}>
                        {all ? "收埋 ›" : `睇晒其餘 ${rows.length - HEAD_ROWS} 組 ›`}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="px-4 py-3 text-[12.5px] text-zk-muted">呢次一鍵結算冇需要自動處理嘅項目。</div>
        )}

        {extraFooter}
        <div className="border-t border-zk-border-soft bg-zk-header px-4 py-2.5 text-[11.5px] text-zk-faint" data-testid="auto-counts">
          {zero.length > 0 && <>冇需要處理：{zero.join(" · ")}　·　</>}
          本月更次記錄：計數更次 {s.counts.countable}（其中公司兵 {s.counts.internal_cash}）；客戶自己人{s.counts.external} 更另計，唔入收入／成本。
          {s.variances_unexplained > 0 ? ` 仲有 ${s.variances_unexplained} 個更數差異解釋唔到。` : ""}
        </div>
      </div>
    </div>
  );
}
