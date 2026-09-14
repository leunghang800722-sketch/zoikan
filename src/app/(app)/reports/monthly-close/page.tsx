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
import { useState } from "react";
import { apiPost } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { FilterChip } from "@/components/ui/FilterChip";
import { Pill } from "@/components/ui/Pill";
import { tableCls, tableMinWidth } from "@/components/ui/DataTable";
import { fmtMoney, fmtDateTime, currentMonthStr } from "@/lib/ui/format";

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
  monthly_close: { main_rows: SiteRow[]; outside_rows: SiteRow[] };
  reconciliation: { month: string; rules: ReconciliationRule[]; has_diff: boolean };
}

const CLOSE_COLS = 6; // 工作地點/更數/營業額/成本/盈利/%

const fieldCls = "w-full rounded-lg border border-[#d1d5db] bg-white px-3 py-2 text-[13px] text-zk-text focus:border-zk-primary focus:outline-none";

function statusDot(status: ReconciliationRule["status"]): string {
  if (status === "pass") return "#0f766e";
  if (status === "diff") return "#dc2626";
  return "#cbd5e1";
}

function ruleDetailLine(d: Record<string, unknown>): { kind: string; rest: string } {
  const { kind, ...others } = d;
  const rest = Object.entries(others)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" · ");
  return { kind: kind ? String(kind) : "—", rest };
}

function RuleCard({ rule }: { rule: ReconciliationRule }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rule.details : rule.details.slice(0, 5);
  const cardBg = rule.status === "diff" ? "#fef2f2" : rule.status === "not_enabled" ? "#f8fafc" : "#f0fdf9";
  const cardBorder = rule.status === "diff" ? "#fecaca" : "#e5e7eb";

  return (
    <div data-rule-key={rule.key} data-rule-status={rule.status} className="rounded-lg border p-3" style={{ background: cardBg, borderColor: cardBorder }}>
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
            const { kind, rest } = ruleDetailLine(d);
            return (
              <div key={i} className="flex gap-2 border-b bg-white px-2.5 py-1.5 text-[11.5px] last:border-b-0" style={{ borderColor: "#fef2f2" }}>
                <span className="w-[110px] shrink-0 font-semibold text-[#b91c1c]">{kind}</span>
                <span className="min-w-0 truncate text-zk-muted">{rest}</span>
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

  async function generate() {
    setLoading(true);
    setError(null);
    // month 段接受 "YYYY-MM"——見 src/lib/month-lock.ts resolveMonthCloseIdOrMonth()
    const res = await apiPost<GenerateResult>(`/api/month-closes/${month}/generate`);
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setResult(res.data);
  }

  async function lock() {
    if (!result) return;
    setError(null);
    const res = await apiPost(`/api/month-closes/${result.month_close.id}/lock`, result.reconciliation.has_diff ? { override_reason: overrideReason } : {});
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setNotice("已鎖定");
    setOverrideReason("");
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
            <Button variant="dark" onClick={generate} disabled={loading}>
              {loading ? "生成緊…" : "重新 Generate"}
            </Button>
          </>
        }
      />

      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />

      {!result && <div className="text-sm text-zk-faint">撳「重新 Generate」開始。</div>}

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
                </table>
              </div>
            </div>
          </div>

          {/* 右邊 sticky 狀態卡。 */}
          <div className="flex h-fit flex-col gap-3 rounded-[10px] border border-zk-border bg-white p-4 lg:sticky lg:top-6">
            <div className="flex items-center justify-between">
              <div className="text-[13.5px] font-semibold text-zk-text">{month} 狀態</div>
              <Pill variant={locked ? "warning" : "success"}>{locked ? "已鎖定" : "未鎖定"}</Pill>
            </div>
            <dl className="flex flex-col gap-1.5 text-[12.5px] text-zk-text">
              <div className="flex justify-between gap-2">
                <dt className="text-zk-muted">月份</dt>
                <dd>{result.month_close.month.slice(0, 7)}</dd>
              </div>
              {locked && (
                <div className="flex justify-between gap-2">
                  <dt className="text-zk-muted">鎖定時間</dt>
                  <dd>{fmtDateTime(result.month_close.locked_at)}</dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-zk-muted">總更數</dt>
                <dd>{result.monthly_close.main_rows.reduce((a, r) => a + r.shifts, 0)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zk-muted">營業額</dt>
                <dd>{fmtMoney(result.monthly_close.main_rows.reduce((a, r) => a + (r.revenue ?? 0), 0))}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-zk-muted">毛利</dt>
                <dd>{fmtMoney(result.monthly_close.main_rows.reduce((a, r) => a + (r.profit ?? 0), 0))}</dd>
              </div>
            </dl>

            <hr className="border-zk-border" />

            {!locked ? (
              <div className="flex flex-col gap-2">
                {result.reconciliation.has_diff && (
                  <>
                    <span className="text-xs text-zk-muted">有紅色差異，鎖定要填 override 原因（必填）</span>
                    <input
                      className={fieldCls}
                      placeholder="有紅色差異，鎖定要填 override 原因"
                      value={overrideReason}
                      onChange={(e) => setOverrideReason(e.target.value)}
                    />
                  </>
                )}
                <Button variant="dark" onClick={lock} disabled={result.reconciliation.has_diff && !overrideReason.trim()}>
                  鎖定 {month}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-xs text-zk-muted">解鎖原因（必填）</span>
                <input className={fieldCls} placeholder="解鎖原因" value={unlockReason} onChange={(e) => setUnlockReason(e.target.value)} />
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
