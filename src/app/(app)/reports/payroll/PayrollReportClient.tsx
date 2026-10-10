"use client";
// P2-B：糧明細（按雞頭）（README §14）——逐結算單位（雞頭）本月更數／
// 工資／雞頭費／金額；foot 合計。Generate／匯出 API 唔變。
//
// WP-PRICE（老闆 2026-09-16 拍板）：呢度由原本嘅 page.tsx 搬出嚟做
// client component——`canReprice`（「出街價:update」）要喺 server
// component 查一次先傳落嚟（同 src/app/(app)/rate-cards/page.tsx 一樣
// 嘅 pattern），「重新計價」掣先可以做到「有權先顯示」。
import { useEffect, useState, useCallback } from "react";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/Pill";
import { EmptyMonthNotice } from "@/components/ui/EmptyMonthNotice";
import { tableCls, tableMinWidth, EmptyState, TableLoadingRow } from "@/components/ui/DataTable";
import { fmtMoney } from "@/lib/ui/format";
import { BROKER_KIND_LABEL, brokerKindPillTone } from "@/lib/ui/broker-kind";
import { kickerFor } from "@/lib/nav/schema";
import { MonthPicker, useMonthState } from "@/components/ui/MonthPicker";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { UnpricedNotice } from "@/components/UnpricedNotice";

// API response 一律 snake_case（見 src/lib/api/http.ts）。
// P0（Opus 驗收重現）：`broker_id` 可以係 `null`——代表「未歸屬結算
// 單位」（settlement_broker_id IS NULL 嘅記錄，見 src/lib/reports/
// payroll.ts buildPayrollTotals()），呢種行唔可以再靜靜消失。
interface Total {
  broker_id: string | null;
  broker_name: string;
  broker_code: string;
  broker_kind?: string;
  shifts: number;
  wage: number;
  fee: number;
  amount: number;
}

interface UnpricedGroup {
  site_id: string;
  site_name: string;
  shift_type_code: string;
  broker_code: string | null;
  broker_display: string;
  // 應修 1：同 RosterEditor.tsx 一致——`no_settlement`（冇結算單位）唔係
  // 「未定價」，唔可以喺同一個清單重複顯示，要獨立 filter 出嚟。
  category?: "payout_unpriced" | "client_unpriced" | "no_settlement";
  count: number;
}

const COLS = 7; // 結算單位/代號/種類/更數/工資/雞頭費/金額

// P2-B 應修⑤（README §14「種類 pill」）：公司兵／公司長工 藍，外判（同
// 其餘 kind）灰——用現成 `BROKER_KIND_LABEL`（搬咗去
// `src/lib/ui/broker-kind.ts`，`src/lib/ai/tools/common.ts` re-export，
// 兩邊共用同一份業務用語）。
function kindLabel(kind?: string): string {
  return BROKER_KIND_LABEL[kind as keyof typeof BROKER_KIND_LABEL] ?? "外判";
}
function KindPill({ kind }: { kind?: string }) {
  return <Pill variant={brokerKindPillTone(kind) === "blue" ? "shift" : "neutral"}>{kindLabel(kind)}</Pill>;
}

export function PayrollReportClient({ canReprice }: { canReprice: boolean }) {
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm();
  const [month, setMonth, monthReady] = useMonthState(undefined, { persistDefault: true });
  const [totals, setTotals] = useState<Total[]>([]);
  const [unpricedCount, setUnpricedCount] = useState(0);
  const [unpricedGroups, setUnpricedGroups] = useState<UnpricedGroup[]>([]);
  // 應修 1：獨立於「未定價」——settlement_broker_id IS NULL 嘅格喺任何
  // 雞頭／長工／公司兵嘅糧單都唔會出現，只會出現喺「未歸屬結算單位」
  // 行，要有自己嘅警告，就算未定價 count＝0 都要顯示。
  const [noSettlementCount, setNoSettlementCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [repricing, setRepricing] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!monthReady) return; // 月份仲未由 URL／sessionStorage 解出（hydration 後），等咗先 fetch（只 fetch 一次）
    (async () => {
      setLoading(true);
      setError(null);
      const res = await apiGet<{ month: string; totals: Total[]; unpriced_count?: number; unpriced_groups?: UnpricedGroup[]; no_settlement_count?: number }>(
        `/api/reports/payroll?month=${month}`,
      );
      if (!res.ok) {
        setError(res.message);
        setLoading(false);
        return;
      }
      setTotals(res.data.totals);
      setUnpricedCount(res.data.unpriced_count ?? 0);
      setUnpricedGroups(res.data.unpriced_groups ?? []);
      setNoSettlementCount(res.data.no_settlement_count ?? 0);
      setLoading(false);
    })();
  }, [month, reloadTick, monthReady]);

  // WP-PRICE §M3：「重新計價」——見 src/app/(app)/roster/[site]/[month]/
  // RosterEditor.tsx 同一段設計註解——dry-run 預覽（diff 摘要）→ confirm
  // →先至真係 dry_run:false 寫入（唔再係單一 confirm 就直接覆蓋）。
  const handleReprice = useCallback(async () => {
    if (repricing) return;
    setRepricing(true);
    setNotice(null);
    try {
      const preview = await apiPost<{ changed: number; unchanged: number; kept_unresolved: number; unpriced: number; groups: UnpricedGroup[] }>(
        "/api/shift-records/reprice",
        { month, dry_run: true },
      );
      if (!preview.ok) {
        setError(preview.message);
        return;
      }
      if (preview.data.changed === 0) {
        setNotice(`重新計價預覽：呢個月全公司冇任何更次嘅 snapshot 會變，${preview.data.unpriced} 更仍然未定價。冇嘢寫入。`);
        return;
      }
      const keptNote = preview.data.kept_unresolved > 0 ? `（其中 ${preview.data.kept_unresolved} 更搵唔到對應卡，保留原有 snapshot）` : "";
      if (
        !(await askConfirm({
          message: `重新計價預覽 ${month}（全公司）：${preview.data.changed} 更會改變，${preview.data.unchanged} 更不變${keptNote}，仲有 ${preview.data.unpriced} 更未定價。確定要寫入？`,
          confirmLabel: "寫入",
        }))
      ) {
        return;
      }
      const res = await apiPost<{ repriced: number; unpriced: number; groups: UnpricedGroup[] }>("/api/shift-records/reprice", { month, dry_run: false });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setNotice(`重新計價完成：${res.data.repriced} 更已改寫，仲有 ${res.data.unpriced} 更未定價。`);
      setReloadTick((t) => t + 1);
    } finally {
      setRepricing(false);
    }
  }, [repricing, month, askConfirm]);

  const grand = totals.reduce((a, t) => ({ shifts: a.shifts + t.shifts, wage: a.wage + t.wage, fee: a.fee + t.fee, amount: a.amount + t.amount }), { shifts: 0, wage: 0, fee: 0, amount: 0 });

  return (
    <div className="flex flex-col gap-4">
      {confirmDialog}
      <PageHeader
        kicker={kickerFor("/reports/payroll")}
        title="糧明細（按雞頭）"
        subtitle="逐結算單位（雞頭）本月更數／工資／雞頭費／金額。"
        actions={
          <>
            <MonthPicker label="月份" value={month} onChange={setMonth} />
            {canReprice && (
              <Button variant="secondary" onClick={handleReprice} disabled={repricing}>
                {repricing ? "計價緊…" : `重新計價（${month}）`}
              </Button>
            )}
            <a href={`/api/reports/payroll?month=${month}&export=1`}>
              <Button variant="secondary">匯出 Excel</Button>
            </a>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="info" message={notice} data-testid="payroll-notice" />
      {/* WP-PRICE §3：頁頂「N 更未定價」——P3-4.2 共用 <UnpricedNotice>（報表頁一行＋「去處理 ›」）。 */}
      <UnpricedNotice variant="compact" month={month} unpricedCount={unpricedCount} noSettlementCount={noSettlementCount} groups={unpricedGroups} scope="糧明細" />
      <EmptyMonthNotice month={month} isEmpty={!loading && totals.length === 0} onJump={setMonth} />

      {/* 桌面表。 */}
      <div className={`hidden lg:block ${tableCls.wrap}`}>
        <table className={tableCls.table} style={{ minWidth: tableMinWidth(COLS) }}>
          <thead>
            <tr>
              <th className={tableCls.th}>結算單位</th>
              <th className={tableCls.th}>代號</th>
              <th className={tableCls.th}>種類</th>
              <th className={tableCls.thNum}>更數</th>
              <th className={tableCls.thNum}>工資</th>
              <th className={tableCls.thNum}>雞頭費</th>
              <th className={tableCls.thNum}>金額</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <TableLoadingRow colSpan={7} />
            )}
            {!loading && totals.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState title="呢個月暫時冇資料" />
                </td>
              </tr>
            )}
            {!loading &&
              totals.map((t) => (
                <tr key={t.broker_id ?? "unattributed"} className={tableCls.rowHover} style={t.broker_id === null ? { background: "var(--zk-danger-bg)" } : undefined}>
                  <td className={`${tableCls.td} font-medium`}>{t.broker_name}</td>
                  <td className={tableCls.td}>{t.broker_code}</td>
                  <td className={tableCls.td}>
                    {/* P0：未歸屬結算單位嗰行冇一個真正嘅 broker.kind
                        （sentinel，唔係真 broker）——唔可以借 KindPill
                        嘅 fallback 顯示做「外判」（誤導）。 */}
                    {t.broker_id === null ? <Pill variant="neutral">未歸屬</Pill> : <KindPill kind={t.broker_kind} />}
                  </td>
                  <td className={tableCls.tdNum}>{t.shifts}</td>
                  <td className={tableCls.tdNum}>{fmtMoney(t.wage)}</td>
                  <td className={tableCls.tdNum}>{fmtMoney(t.fee)}</td>
                  <td className={`${tableCls.tdNum} font-semibold`}>{fmtMoney(t.amount)}</td>
                </tr>
              ))}
          </tbody>
          <tfoot>
            <tr>
              <td className={`${tableCls.td} ${tableCls.foot}`} colSpan={3}>
                Total
              </td>
              <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{grand.shifts}</td>
              <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(grand.wage)}</td>
              <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(grand.fee)}</td>
              <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(grand.amount)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* 手機：每行變卡。 */}
      <div className="flex flex-col gap-2 lg:hidden">
        {loading ? (
          <div className="text-sm text-zk-faint">載入緊…</div>
        ) : totals.length === 0 ? (
          <div className="rounded-[10px] border border-zk-border bg-white">
            <EmptyState title="呢個月暫時冇資料" />
          </div>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-zk-border bg-white">
            {totals.map((t) => (
              <div
                key={t.broker_id ?? "unattributed"}
                className="flex items-center justify-between gap-2.5 border-b border-zk-border-soft px-3.5 py-2.5 last:border-b-0"
                style={t.broker_id === null ? { background: "var(--zk-danger-bg)" } : undefined}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-zk-base font-medium text-zk-text">{t.broker_name}</span>
                    <Pill variant="neutral">{t.broker_code}</Pill>
                  </div>
                  <div className="mt-0.5 text-zk-xs text-zk-muted">
                    {t.broker_id === null ? "未歸屬" : kindLabel(t.broker_kind)} · {t.shifts} 更
                  </div>
                </div>
                <div className="shrink-0 text-zk-base font-semibold text-zk-text">{fmtMoney(t.amount)}</div>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-zk-border bg-zk-header px-3.5 py-2.5 text-zk-base font-bold text-zk-text">
              <span>Total {grand.shifts} 更</span>
              <span>{fmtMoney(grand.amount)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
