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

    return ok(
      brandSafeResponse({
        month_close: await applyFieldGroupGate(session, "month_closes", toMonthCloseDTO(monthClose)),
        monthly_close: { main_rows: scrubRows(mainRows), outside_rows: scrubRows(outsideRows) },
        reconciliation,
      }),
    );
  });
}
