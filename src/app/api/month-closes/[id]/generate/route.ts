// P1-執行計劃.md §4 WP4 item 3：`POST /api/month-closes/:month/generate`
// ——由 DB 重新生成呢個月嘅月結總表＋五條自動對數規則（§6.3），俾月結
// 工作台顯示。`:month` 呢段同 lock/unlock 共用 Next.js 嘅 `[id]` 動態
// segment（技術限制：同一路徑深度嘅 sibling 資料夾唔准用唔同 dynamic
// segment 名）——`resolveMonthCloseIdOrMonth()` 令佢可以接受
// "2026-07"／"2026-07-01" 或者真正嘅 month_closes.id（uuid）。
//
// 鎖定前必須 generate 一次：[id]/lock/route.ts 鎖定嗰陣會**自己**重新
// 計一次 buildReconciliation()（唔靠呢個 route 有冇被叫過嚟做前置狀態
// ——避免「叫完 generate 之後、鎖定之前又偷偷改咗數」呢類 race，見
// lock/route.ts 註解），所以呢個 route 純粹係俾 UI 預覽用。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { resolveMonthCloseIdOrMonth } from "@/lib/month-lock";
import { toMonthCloseDTO } from "@/lib/api/dto";
import { applyFieldGroupGate } from "@/lib/api/field-groups";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { buildMonthlyClose } from "@/lib/reports/monthly-close";
import { buildReconciliation } from "@/lib/reports/reconciliation";
import { hasPermission } from "@/lib/rbac/requirePermission";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結總表", "view");
    const { id } = await params;
    const monthClose = await resolveMonthCloseIdOrMonth(id, session.userId);

    const [{ mainRows, outsideRows }, reconciliation] = await Promise.all([buildMonthlyClose(monthClose.month), buildReconciliation(monthClose.month)]);

    // 主表/月結以外嘅營業額屬「收客價」性質——冇「收客價:view」就剝走
    // revenue/profit/marginPct（field-level gate 中央機制，M1/M3 一致做法）。
    const canViewClientRate = await hasPermission(session, "收客價", "view");
    const scrubRows = (rows: typeof mainRows) =>
      rows.map((r) => (canViewClientRate ? r : { ...r, revenue: undefined, profit: undefined, marginPct: undefined, fullProfit: undefined, fullMarginPct: undefined }));

    // 應修①（Opus 驗收）：月結工作台狀態卡想顯示「最後 Generate」時間——
    // `month_closes` 本身冇 `generated_at` 呢個欄（Generate 純粹係 UI
    // 預覽，唔寫任何一行），只讀查 audit_log 有冇任何 table_name=
    // month_closes、row_id=呢個 month_close、action 含「generate」嘅記錄，
    // 攞最近一條嘅時間。**已知現況**：而家成個 code base 冇任何 route 會
    // 寫呢種 audit action（lock/unlock 先會寫 audit，見 [id]/lock、
    // [id]/unlock），所以呢個查詢而家實際上一定搵唔到、`last_generated_at`
        // 一律 null——UI 顯示「—」（規格容許嘅 fallback，唔係 bug）。故意唔喺
    // 呢個 route 加一個新嘅 audit 寫入（呢次修復範圍係「API 只
    // additive/唯讀」，加寫入係另一個決定，留返俾規劃 session）。
    const lastGenerateAudit = await prisma.auditLog.findFirst({
      where: { tableName: "month_closes", rowId: monthClose.id, action: { contains: "generate" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    return ok(
      brandSafeResponse({
        month_close: await applyFieldGroupGate(session, "month_closes", toMonthCloseDTO(monthClose)),
        last_generated_at: lastGenerateAudit?.createdAt ?? null,
        monthly_close: { main_rows: scrubRows(mainRows), outside_rows: scrubRows(outsideRows) },
        reconciliation,
      }),
    );
  });
}
