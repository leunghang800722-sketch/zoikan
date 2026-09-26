"use client";
// P2-B：月結工作台（README §13）——兩欄 grid：左上「五條自動對數規則」
// 卡＋左下「月結總表」；右邊 sticky「狀態卡」（鎖定／解鎖）。Generate／
// 鎖定／解鎖 API 流程唔變（同 P1 一樣）。
//
// 保持向下相容（tests/e2e/wp4.spec.ts (b) 呢個舊 e2e 唔喺呢次 P2-B 範圍
// 內，但一齊跑喺 `npx playwright test tests/e2e/`，唔可以整壞）：
//  - `input[type="month"]` 照喺（FilterChip 包住）。
//  - 撳掣文字用 substring match（Playwright getByRole name 預設 substring）
//    ——「重新 Generate」仲係揾到 name:"Generate"；「鎖定 2026-10」揾到
//    name:"鎖定"；「解鎖 2026-10」揾到 name:"解鎖"。
//  - 「§6.3 五條自動對數規則」呢串文字原封不動保留（唔改做純 README
//    「五條自動對數規則」，怕另一個 test 用 exact text 揾——保守做法係
//    兩個字串都出現：卡標題用 README 版，副標維持 §6.3 呢個 anchor）。
//  - 解鎖 input 嘅 `placeholder` 屬性一定要係「解鎖原因」呢隻字面值
//    （舊 test 用 `input[placeholder="解鎖原因"]` CSS attribute selector，
//    唔係 substring）——README 想要「解鎖原因（必填）」呢個顯示，改用
//    上面獨立一行 label 顯示「（必填）」，`placeholder` 屬性維持原字面值。
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Pill } from "@/components/ui/Pill";
import { Notice } from "@/components/ui/Notice";
import { EmptyMonthNotice } from "@/components/ui/EmptyMonthNotice";
import { inputCls } from "@/components/ui/Field";
import { tableCls, tableMinWidth, EmptyState } from "@/components/ui/DataTable";
import { fmtMoney, fmtDateTime, currentMonthStr } from "@/lib/ui/format";
import type { ApiListResult } from "@/lib/ui/api-client";

// API response 一律 snake_case（見 src/lib/api/http.ts）。
interface MonthCloseDto {
  id: string;
  month: string;
  locked_at: string | null;
}
interface SiteRow {
  site_id: string;
  canonical_name: string;
  shifts: number;
  revenue?: number;
  cost: number;
  profit?: number;
  margin_pct?: number | null;
  note: string | null;
}
interface ReconciliationRule {
  rule: number;
  rule_no: number;
  key: string;
  label: string;
  title: string;
  status: "pass" | "diff" | "not_enabled";
  diff_count: number;
  details: Array<Record<string, unknown>>;
  note: string | null;
}
interface GenerateResult {
  month_close: MonthCloseDto;
  // 應修①：`last_generated_at`——`month_closes` 冇 `generated_at` 欄，由
  // audit_log 查返（見 src/app/api/month-closes/[id]/generate/route.ts）；
  // 而家成個 code base 冇任何 route 會寫呢種 audit action，所以呢個欄
  // 現況一律 null，UI 顯示「—」。
  last_generated_at: string | null;
  monthly_close: { main_rows: SiteRow[]; outside_rows: SiteRow[] };
  reconciliation: { month: string; rules: ReconciliationRule[]; has_diff: boolean };
}
// 毛利即時表 totals（README §13 狀態卡「毛利」要同毛利即時表口徑一致，
// 唔可以自己用月結總表 main_rows 加返出嚟——兩份報表 scope 唔同，見
// src/lib/reports/gross-margin.ts 檔頭註解）。
interface UnpricedGroup {
  site_id: string;
  site_name: string;
  shift_type_code: string;
  broker_code: string | null;
  broker_display: string;
  // 應修 1：同 RosterEditor.tsx 一致——`no_settlement`（冇結算單位）唔係
  // 「未定价」，唔可以喺同一個清單重複顯示，要獨立 filter 出嚟。
  category?: "payout_unpriced" | "client_unpriced" | "no_settlement";
  count: number;
}
interface GrossMarginTotalsResult {
  totals: { revenue?: number; profit?: number; margin_pct?: number | null };
  // WP-PRICE §3：呢個 route 已經 additive 加咗呢兩個欄（見
  // src/app/api/reports/gross-margin/route.ts）——月結工作台借嚟顯示
  // 「N 更未定价」Notice，唔使另外打 API。
  unpriced_count?: number;
  unpriced_groups?: UnpricedGroup[];
  // 應修 1：獨立於「未定价」——settlement_broker_id IS NULL 嘅格。
  no_settlement_count?: number;
}

const CLOSE_COLS = 6; // 工作地點/更數/營業額/成本/盈利/%

function statusDot(status: ReconciliationRule["status"]): string {
  if (status === "pass") return "#0f766e";
  if (status === "diff") return "#dc2626";
  return "#cbd5e1";
}

// §13：差異小表三欄（kind 紅 600 110px／who 500／detail 灰）——用業務
// 字眼，唔出 DB 欄名（`ruleDetailLine()` 之前直接 `k=v` dump 返 raw 物件
// 欄名，違反規格；而家逐條規則識別自己嘅 details 形狀，砌返中文業務句）。
function fmtAmt(v: unknown): string {
  return fmtMoney(typeof v === "number" ? v : Number(v ?? 0));
}
function ruleDetailRow(ruleKey: string, d: Record<string, unknown>): { kind: string; who: string; detail: string } {
  if (ruleKey === "revenue_per_site") {
    return {
      kind: "營業額差異",
      who: String(d.site_name ?? "—"),
      detail: `確認狀態 ${fmtAmt(d.confirmed_only_revenue)} · 全部狀態 ${fmtAmt(d.all_status_revenue)} · 差 ${fmtAmt(d.diff)}`,
    };
  }
  if (ruleKey === "payroll_per_broker") {
    return {
      kind: "糧明細差異",
      who: String(d.broker_code ?? "—"),
      detail: `確認狀態 ${fmtAmt(d.confirmed_only_amount)} · 糧明細總額 ${fmtAmt(d.payroll_amount)} · 差 ${fmtAmt(d.diff)}`,
    };
  }
  if (ruleKey === "three_table_shifts") {
    return {
      kind: "更數唔對",
      who: String(d.site_name ?? "—"),
      detail: `更表 ${d.roster_shifts_with_adjustments ?? 0} 更 · 月結 ${d.monthly_close_shifts ?? 0} 更 · 糧明細 ${d.payroll_shift_and_ot_records ?? 0} 更`,
    };
  }
  // yellow_warnings（規則 5）：details 本身已經有業務用語嘅 `kind`。
  const detailParts: string[] = [];
  if (d.work_date) detailParts.push(`出更日 ${d.work_date}`);
  if (d.shift_count) detailParts.push(`${d.shift_count} 更`);
  if (d.permit_expiry) detailParts.push(`許可證到期 ${d.permit_expiry}`);
  return { kind: String(d.kind ?? "—"), who: String(d.guard_ref ?? "—"), detail: detailParts.join(" · ") };
}

// 應修（README §13）：規則列表改白底單行——狀態圓點＋「N. 標題」
// 500/13px＋公式說明 11.5px 灰＋右側狀態 pill；只有差異規則先展開紅邊
// 小表（唔再成張卡染色）。
function RuleCard({ rule }: { rule: ReconciliationRule }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rule.details : rule.details.slice(0, 5);

  return (
    <div data-rule-key={rule.key} data-rule-status={rule.status} className="rounded-lg border border-zk-border bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-[10px] w-[10px] shrink-0 rounded-full" style={{ background: statusDot(rule.status) }} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-zk-text">
              {rule.rule}. {rule.label}
            </div>
            <div className="truncate text-[11.5px] text-zk-muted">{rule.title}</div>
          </div>
        </div>
        <div className="shrink-0">
          {rule.status === "pass" && <Pill variant="success">通過</Pill>}
          {rule.status === "not_enabled" && <Pill variant="neutral">未啟用</Pill>}
          {rule.status === "diff" && (
            <span className="inline-flex items-center rounded-[10px] px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap" style={{ background: "#fee2e2", color: "#b91c1c" }}>
              {rule.diff_count} 項差異
            </span>
          )}
        </div>
      </div>
      {rule.note && <div className="mt-1 pl-5 text-[11.5px] text-zk-muted">{rule.note}</div>}
      {rule.status === "diff" && rule.details.length > 0 && (
        <div className="mt-2 overflow-hidden rounded-md border" style={{ borderColor: "#fecaca" }}>
          {shown.map((d, i) => {
            const { kind, who, detail } = ruleDetailRow(rule.key, d);
            return (
              <div key={i} className="flex gap-2 border-b bg-white px-2.5 py-1.5 text-[11.5px] last:border-b-0" style={{ borderColor: "#fef2f2" }}>
                <span className="w-[110px] shrink-0 font-semibold text-[#b91c1c]">{kind}</span>
                <span className="w-[100px] shrink-0 font-medium text-zk-text">{who}</span>
                <span className="min-w-0 truncate text-zk-muted">{detail}</span>
              </div>
            );
          })}
          {rule.details.length > 5 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="w-full bg-white px-2.5 py-1.5 text-left text-[11.5px] text-zk-primary hover:bg-zk-header">
              {showAll ? "收埋 ‹" : `睇全部 ${rule.details.length} 項 ›`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function MonthlyCloseWorkbenchPage() {
  const [month, setMonth] = useState(() => currentMonthStr());
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [unlockReason, setUnlockReason] = useState("");
  const [showOutside, setShowOutside] = useState(false);
  // 應修①：狀態卡「毛利」要同毛利即時表口徑一致（唔係月結總表 main_rows
  // 加返出嚟嗰個數——兩份報表 scope 唔同，見 gross-margin.ts 檔頭註解），
  // 呢度另外攞 `/api/reports/gross-margin?month=` 嘅 totals。
  const [marginTotals, setMarginTotals] = useState<GrossMarginTotalsResult["totals"] | null>(null);
  // WP-PRICE §3：頁頂「N 更未定价，金額未計入」——同 marginTotals 一齊由
  // gross-margin API 攞（additive 欄，唔使多打一次 API）。
  const [unpricedCount, setUnpricedCount] = useState(0);
  const [unpricedGroups, setUnpricedGroups] = useState<UnpricedGroup[]>([]);
  // 應修 1：獨立於「未定价」——settlement_broker_id IS NULL 嘅格，就算
  // 未定价 count＝0 都要顯示。
  const [noSettlementCount, setNoSettlementCount] = useState(0);
  // B1-6（規則 10，§14）：月結鎖定前檢查——邊啲盤呢個月有出更但未上載
  // 更表／未對數完成，鎖定會 400。呢度入頁／Generate 就查一次，等用戶
  // 撳「鎖定」之前已經見到清單（唔使撞 400 先知）。
  const [rosterCoverage, setRosterCoverage] = useState<{
    missing_upload_sites: { site_id: string; site_name: string }[];
    unconfirmed_upload_sites: { site_id: string; site_name: string; status: string }[];
  } | null>(null);
  const [forceOverride, setForceOverride] = useState(false);
  // A1（Opus 整合驗收）：入頁／切月份時，先查呢個月有冇 month_closes 行
  // （`GET /api/month-closes?month=`）——已經有就自動行一次 Generate（見
  // src/app/api/month-closes/[id]/generate/route.ts 檔頭註解：
  // `resolveMonthCloseIdOrMonth()` 對已存在嘅行係 no-op upsert，安全），
  // 用戶入頁即刻見到規則卡／總表／狀態卡，唔使自己撳「Generate」；冇行
  // 就顯示空狀態＋掣，唔自動幫用戶建新行（建行係「Generate」呢個動作
  // 本身嘅副作用，唔應該淨係「打開個頁」就觸發）。
  const [checkingExisting, setCheckingExisting] = useState(true);

  async function generate() {
    setLoading(true);
    setError(null);
    // month 段接受 "YYYY-MM"——見 src/lib/month-lock.ts resolveMonthCloseIdOrMonth()
    const [res, marginRes, coverageRes] = await Promise.all([
      apiPost<GenerateResult>(`/api/month-closes/${month}/generate`),
      apiGet<GrossMarginTotalsResult>(`/api/reports/gross-margin?month=${month}`),
      apiGet<{ missing_upload_sites: { site_id: string; site_name: string }[]; unconfirmed_upload_sites: { site_id: string; site_name: string; status: string }[] }>(
        `/api/month-closes/roster-coverage?month=${month}`,
      ),
    ]);
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setResult(res.data);
    setMarginTotals(marginRes.ok ? marginRes.data.totals : null);
    setUnpricedCount(marginRes.ok ? (marginRes.data.unpriced_count ?? 0) : 0);
    setUnpricedGroups(marginRes.ok ? (marginRes.data.unpriced_groups ?? []) : []);
    setNoSettlementCount(marginRes.ok ? (marginRes.data.no_settlement_count ?? 0) : 0);
    setRosterCoverage(coverageRes.ok ? coverageRes.data : null);
  }

  // WP-LTSHIFT §19 交付 D：月結頁「重算介紹費」——呼叫已有嘅
  // `POST /api/reports/referral-fee/recompute`（後端 WP-LTSHIFT 第一部分
  // 已完成，呢度淨係加前端掣）。7 月會俾 400（已人手入，鐵則唔可以自動
  // 覆蓋），顯示錯誤訊息就得。
  const [referralFeeResult, setReferralFeeResult] = useState<{
    total_amount: number;
    totals_by_broker_code: Record<string, number>;
    created_count: number;
    voided_count: number;
    exempt_shift_count: number;
    warnings: Array<{ guardId: string; brokerId: string; siteId: string; shifts: number; reason: string }>;
    /** 驗收修正：Postorder 費率同步結果（舊 API 冇呢欄）。 */
    rate_sync?: { upserted: number; skipped: string[] };
  } | null>(null);
  const [recomputingReferralFee, setRecomputingReferralFee] = useState(false);

  async function recomputeReferralFee() {
    setRecomputingReferralFee(true);
    setError(null);
    setReferralFeeResult(null);
    const res = await apiPost<{
      total_amount: number;
      totals_by_broker_code: Record<string, number>;
      created_count: number;
      voided_count: number;
      exempt_shift_count: number;
      warnings: Array<{ guardId: string; brokerId: string; siteId: string; shifts: number; reason: string }>;
      rate_sync?: { upserted: number; skipped: string[] };
    }>("/api/reports/referral-fee/recompute", { month });
    setRecomputingReferralFee(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setReferralFeeResult(res.data);
    setNotice(`介紹費已重算：合共 $${res.data.total_amount}（新建 ${res.data.created_count}、作廢 ${res.data.voided_count}）`);
    await generate(); // 月結總表／毛利即時表要反映新嘅 special_items
  }

  async function lock() {
    if (!result) return;
    setError(null);
    const body: Record<string, unknown> = {};
    if (result.reconciliation.has_diff) body.override_reason = overrideReason;
    if (forceOverride) body.force = true;
    const res = await apiPost(`/api/month-closes/${result.month_close.id}/lock`, body);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已鎖定");
    setOverrideReason("");
    setForceOverride(false);
    await generate();
  }

  async function unlock() {
    if (!result) return;
    setError(null);
    const res = await apiPost(`/api/month-closes/${result.month_close.id}/unlock`, { reason: unlockReason });
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已解鎖");
    setUnlockReason("");
    await generate();
  }

  // A1：入頁／切月份查呢個月有冇 month_closes 行，有就自動 Generate。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setCheckingExisting(true);
      setResult(null);
      setMarginTotals(null);
      const res = await apiGet<ApiListResult<MonthCloseDto>>(`/api/month-closes?month=${month}`);
      if (cancelled) return;
      const exists = res.ok && res.data.rows.length > 0;
      setCheckingExisting(false);
      if (exists) await generate();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const locked = !!result?.month_close.locked_at;
  const rules = result?.reconciliation.rules ?? [];
  const passCount = rules.filter((r) => r.status === "pass").length;
  const notEnabledCount = rules.filter((r) => r.status === "not_enabled").length;
  const diffCount = rules.filter((r) => r.status === "diff").length;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker="財務"
        title="月結工作台"
        subtitle="生成月結總表＋五條自動對數規則；鎖定前必須先 Generate 一次。"
        actions={
          <>
            <FilterChip label="月份">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </FilterChip>
            <a href={`/api/reports/monthly-close?month=${month}&export=1`}>
              <Button variant="secondary">匯出 Excel</Button>
            </a>
            <Button variant="secondary" onClick={recomputeReferralFee} disabled={recomputingReferralFee}>
              {recomputingReferralFee ? "重算緊…" : "重算介紹費"}
            </Button>
            <Button variant="dark" onClick={generate} disabled={loading}>
              {loading ? "生成緊…" : "重新 Generate"}
            </Button>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {referralFeeResult && (
        <div className="rounded-lg border border-zk-border bg-white p-3 text-[12.5px]" data-testid="referral-fee-result">
          <div className="mb-1 font-medium text-zk-text">介紹費重算結果（{month}）——合共 {fmtMoney(referralFeeResult.total_amount)}</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-zk-muted">
            {Object.entries(referralFeeResult.totals_by_broker_code).map(([code, amount]) => (
              <span key={code}>
                {code}：{fmtMoney(amount)}
              </span>
            ))}
            {Object.keys(referralFeeResult.totals_by_broker_code).length === 0 && <span>（冇任何長工設咗介紹雞頭，或者冇 B07 更）</span>}
          </div>
          {referralFeeResult.rate_sync && (
            <div className="mt-1 text-zk-muted" data-testid="referral-rate-sync">
              Postorder 費率同步：寫入 {referralFeeResult.rate_sync.upserted} 組
              {referralFeeResult.rate_sync.skipped.length > 0 ? (
                <span className="text-amber-700">、跳過 {referralFeeResult.rate_sync.skipped.length} 行（對唔到雞頭／盤或者費率打架）</span>
              ) : (
                "、冇跳過"
              )}
            </div>
          )}
          {referralFeeResult.exempt_shift_count > 0 && <div className="mt-1 text-zk-muted">卓弘客戶盤豁免咗 {referralFeeResult.exempt_shift_count} 格。</div>}
          {referralFeeResult.warnings.length > 0 && (
            <div className="mt-1 text-amber-700">{referralFeeResult.warnings.length} 個 (長工,盤) 組合冇設費率，未計入（見 audit / referral_fee_rates）。</div>
          )}
        </div>
      )}
      {/* WP-PRICE §3：頁頂「N 更未定价，金額未計入」——逐組列表。 */}
      {unpricedCount > 0 && (
        <Notice variant="warning">
          <p className="font-medium">呢個月有 {unpricedCount} 更未定价（冇對應價目卡），金額未計入月結總表：</p>
          <ul className="list-disc pl-5 mt-1">
            {/* 應修 1：no_settlement 分類唔喺呢個清單顯示（有自己獨立、更
                搶眼嘅 Notice，見下面）。 */}
            {unpricedGroups
              .filter((g) => g.category !== "no_settlement")
              .map((g) => (
                <li key={`${g.category ?? "payout_unpriced"}|${g.site_id}|${g.shift_type_code}|${g.broker_code ?? "none"}`}>
                  {g.site_name} · 更別 {g.shift_type_code} · 雞頭 {g.broker_display} · {g.count} 更
                </li>
              ))}
          </ul>
        </Notice>
      )}
      {/* 應修 1：冇結算單位（settlement_broker_id NULL）嘅格——呢批更
          唔會計入任何雞頭／長工／公司兵嘅糧單，只會出現喺「未歸屬結算
          單位」行。就算未定价 count＝0 都要顯示。 */}
      {noSettlementCount > 0 && (
        <Notice variant="error">
          <p className="font-medium">
            呢個月有 {noSettlementCount} 格冇結算單位（唔會計入任何雞頭／長工／公司兵嘅糧單，只會出現喺「未歸屬結算單位」行）：
          </p>
          <ul className="list-disc pl-5 mt-1">
            {unpricedGroups
              .filter((g) => g.category === "no_settlement")
              .map((g) => (
                <li key={`no_settlement|${g.site_id}|${g.shift_type_code}`}>
                  {g.site_name} · 更別 {g.shift_type_code} · {g.count} 更
                </li>
              ))}
          </ul>
        </Notice>
      )}
      <EmptyMonthNotice month={month} isEmpty={!checkingExisting && !result} onJump={setMonth} />

      {checkingExisting && !result && <div className="text-sm text-zk-faint">載入緊…</div>}

      {!checkingExisting && !result && (
        <div className="rounded-[10px] border border-zk-border bg-white">
          <EmptyState
            title={`${month} 未有月結記錄`}
            description="呢個月未 Generate 過——撳「Generate」建立月結總表＋五條自動對數規則。"
            cta={
              <Button variant="dark" onClick={generate} disabled={loading}>
                {loading ? "生成緊…" : "Generate"}
              </Button>
            }
          />
        </div>
      )}

      {result && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
          {/* 左欄。 */}
          <div className="flex min-w-0 flex-col gap-4">
            <div className="rounded-[10px] border border-zk-border bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* 保留「§6.3 五條自動對數規則」呢個完整字面值（單一元素、
                    唔拆開）——tests/e2e/wp4.spec.ts (b) 用
                    `page.getByText("§6.3 五條自動對數規則")` 揾呢一句，
                    拆成兩個 element 會令個 substring 唔連續，揾唔到。 */}
                <div className="text-[13.5px] font-semibold text-zk-text">§6.3 五條自動對數規則</div>
                <div className="text-xs text-zk-muted">
                  {passCount} 通過 · {notEnabledCount} 未啟用
                  {diffCount > 0 && (
                    <>
                      {" "}
                      · <span className="font-semibold text-[#dc2626]">{diffCount} 有差異</span>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {rules.map((r) => (
                  <RuleCard key={r.rule_no} rule={r} />
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h2 className="text-[13.5px] font-semibold text-zk-text">月結總表</h2>
              <div className={tableCls.wrap}>
                <table className={tableCls.table} style={{ minWidth: tableMinWidth(CLOSE_COLS) }}>
                  <thead>
                    <tr>
                      <th className={tableCls.th}>工作地點</th>
                      <th className={tableCls.thNum}>更數</th>
                      <th className={tableCls.thNum}>營業額</th>
                      <th className={tableCls.thNum}>成本</th>
                      <th className={tableCls.thNum}>盈利</th>
                      <th className={tableCls.thNum}>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.monthly_close.main_rows.map((r) => (
                      <tr key={r.site_id} className={`${tableCls.rowHover} ${r.margin_pct != null && r.margin_pct < 8 ? tableCls.warnRow : ""}`}>
                        <td className={`${tableCls.td} font-medium`}>{r.canonical_name}</td>
                        <td className={tableCls.tdNum}>{r.shifts}</td>
                        <td className={tableCls.tdNum}>{fmtMoney(r.revenue)}</td>
                        <td className={tableCls.tdNum}>{fmtMoney(r.cost)}</td>
                        <td className={tableCls.tdNum}>{fmtMoney(r.profit)}</td>
                        <td className={r.margin_pct != null && r.margin_pct < 8 ? "border-b border-[#f1f5f9] px-3.5 py-2.5 text-right font-bold text-[#dc2626]" : tableCls.tdNum}>
                          {r.margin_pct == null ? "n/a" : `${r.margin_pct}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {/* 應修②：foot 合計。 */}
                  <tfoot>
                    <tr>
                      <td className={`${tableCls.td} ${tableCls.foot}`}>合計</td>
                      <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{result.monthly_close.main_rows.reduce((a, r) => a + r.shifts, 0)}</td>
                      <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(result.monthly_close.main_rows.reduce((a, r) => a + (r.revenue ?? 0), 0))}</td>
                      <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(result.monthly_close.main_rows.reduce((a, r) => a + r.cost, 0))}</td>
                      <td className={`${tableCls.tdNum} ${tableCls.foot}`}>{fmtMoney(result.monthly_close.main_rows.reduce((a, r) => a + (r.profit ?? 0), 0))}</td>
                      <td className={`${tableCls.tdNum} ${tableCls.foot}`}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* 應修②：額外盤（outside_rows）摺埋顯示，唔入月結對數。 */}
              {result.monthly_close.outside_rows.length > 0 && (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setShowOutside((v) => !v)}
                    className="w-fit text-left text-[12.5px] text-zk-primary hover:underline"
                  >
                    {showOutside ? "收埋 ‹" : `額外盤 ${result.monthly_close.outside_rows.length} 個（唔入月結對數）›`}
                  </button>
                  {showOutside && (
                    <div className={tableCls.wrap}>
                      <table className={tableCls.table} style={{ minWidth: tableMinWidth(CLOSE_COLS) }}>
                        <thead>
                          <tr>
                            <th className={tableCls.th}>工作地點</th>
                            <th className={tableCls.thNum}>更數</th>
                            <th className={tableCls.thNum}>營業額</th>
                            <th className={tableCls.thNum}>成本</th>
                            <th className={tableCls.thNum}>盈利</th>
                            <th className={tableCls.thNum}>%</th>
                          </tr>
                        </thead>
                        <tbody>
                          {result.monthly_close.outside_rows.map((r) => (
                            <tr key={r.site_id} className={tableCls.rowHover}>
                              <td className={`${tableCls.td} font-medium`}>{r.canonical_name}</td>
                              <td className={tableCls.tdNum}>{r.shifts}</td>
                              <td className={tableCls.tdNum}>{fmtMoney(r.revenue)}</td>
                              <td className={tableCls.tdNum}>{fmtMoney(r.cost)}</td>
                              <td className={tableCls.tdNum}>{fmtMoney(r.profit)}</td>
                              <td className={tableCls.tdNum}>{r.margin_pct == null ? "n/a" : `${r.margin_pct}%`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 右邊 sticky 狀態卡。 */}
          <div className="flex h-fit flex-col gap-3 rounded-[10px] border border-zk-border bg-white p-4 lg:sticky lg:top-6">
            <div className="flex items-center justify-between">
              <div className="text-[13.5px] font-semibold text-zk-text">{month} 狀態</div>
              <Pill variant={locked ? "warning" : "success"}>{locked ? "已鎖定" : "未鎖定"}</Pill>
            </div>
            <dl className="flex flex-col gap-1.5 text-[12.5px] text-zk-text">
              {/* 應修①：刪重覆「月份」row（頁首 FilterChip 已經顯示緊）；
                  「最後 Generate」——month_closes 冇 generated_at 欄，由
                  audit_log 查返（見 generate route 註解），而家現況一律
                  「—」（冇任何 route 寫呢種 audit action）。 */}
              <div className="flex justify-between gap-2">
                <dt className="text-zk-muted">最後 Generate</dt>
                <dd>{result.last_generated_at ? fmtDateTime(result.last_generated_at) : "—"}</dd>
              </div>
              {locked && (
                <div className="flex justify-between gap-2">
                  <dt className="text-zk-muted">鎖定時間</dt>
                  <dd>{fmtDateTime(result.month_close.locked_at)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-zk-muted">總更數（月結總表）</dt>
                <dd>{result.monthly_close.main_rows.reduce((a, r) => a + r.shifts, 0)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zk-muted">營業額（月結總表）</dt>
                <dd>{fmtMoney(result.monthly_close.main_rows.reduce((a, r) => a + (r.revenue ?? 0), 0))}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zk-muted">毛利（毛利即時表口徑）</dt>
                <dd>
                  {marginTotals ? (
                    <>
                      {fmtMoney(marginTotals.profit)} · {marginTotals.margin_pct == null ? "—" : `${marginTotals.margin_pct}%`}
                    </>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
            </dl>

            <hr className="border-zk-border" />

            {!locked ? (
              <div className="flex flex-col gap-2">
                {/* B1-6（規則 10，§14）：未上載／未對數完成嘅盤清單——撳
                    「鎖定」之前已經見到，唔使撞 400 先知。 */}
                {rosterCoverage && (rosterCoverage.missing_upload_sites.length > 0 || rosterCoverage.unconfirmed_upload_sites.length > 0) && (
                  <div className="rounded-md border border-orange-200 bg-orange-50 p-2.5 text-[12px] text-orange-800" data-testid="roster-coverage-issues">
                    <div className="font-medium">更表上載/對數未齊，會擋鎖定：</div>
                    {rosterCoverage.missing_upload_sites.length > 0 && (
                      <div className="mt-1">未上載：{rosterCoverage.missing_upload_sites.map((s) => s.site_name).join("、")}</div>
                    )}
                    {rosterCoverage.unconfirmed_upload_sites.length > 0 && (
                      <div className="mt-1">未對數完成：{rosterCoverage.unconfirmed_upload_sites.map((s) => `${s.site_name}（${s.status}）`).join("、")}</div>
                    )}
                    <label className="mt-2 flex items-center gap-1.5">
                      <input type="checkbox" checked={forceOverride} onChange={(e) => setForceOverride(e.target.checked)} />
                      強制鎖定（淨係老闆做得到，會記落操作紀錄）
                    </label>
                  </div>
                )}
                {result.reconciliation.has_diff && (
                  <>
                    <span className="text-xs text-zk-muted">有紅色差異，鎖定要填 override 原因（必填）</span>
                    <input
                      className={inputCls}
                      placeholder="有紅色差異，鎖定要填 override 原因"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                    />
                  </>
                )}
                <Button
                  variant="dark"
                  onClick={lock}
                  disabled={
                    (result.reconciliation.has_diff && !overrideReason.trim()) ||
                    (!!rosterCoverage && (rosterCoverage.missing_upload_sites.length > 0 || rosterCoverage.unconfirmed_upload_sites.length > 0) && !forceOverride)
                  }
                >
                  鎖定 {month}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-[11px] leading-relaxed text-zk-faint">
                  解鎖會令更表重新可改；需要「月結鎖定解鎖」權限 · 原因會寫入操作紀錄。
                </span>
                <span className="text-xs text-zk-muted">解鎖原因（必填）</span>
                <input className={inputCls} placeholder="解鎖原因" value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} />
                <Button variant="danger" onClick={unlock} disabled={!unlockReason.trim()}>
                  解鎖 {month}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
