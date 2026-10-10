// P1-WP3：更表 Excel 匯出——`更表匯出` module（src/lib/rbac/matrix.ts
// 已有：老闆/主管/會計出廠 grant；雞頭出廠 off（連 更表匯出:view 都
// 硬性 deny——雞頭預設完全見唔到匯出呢個功能，除非老闆開咗
// 更表匯出:export）。
//
// Binary response 例外——唔行 ok()/Dto brand 嗰套 JSON 慣例（見
// src/lib/api/http.ts 頂註解：`ok()` 嘅型別淨係接受 `Dto`，呢個 route
// 直接出 xlsx binary，唔使勉強塞入嗰個系統）。
//
// 雞頭權限：就算老闆開咗佢 更表匯出:export，都要做返 broker isolation
// 三重防線（src/lib/broker-isolation.ts 檔案頂註解）——
//   (a) assertSiteAssignedToBroker：呢個盤呢個月自己有份先准匯出
//   (b) 匯出內容淨係包自己保安員嗰幾行——buildRosterWorkbookForSite()
//       嘅 opts.brokerId 喺 query 層做呢個 scope（同
//       scopeShiftRecordWhere 一致嘅 OR 條件）
//   (c) 呢個 export 本身冇金錢欄（純代號/日期），唔使煩 field-group gate
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole, requireOwnBrokerId, assertSiteAssignedToBroker } from "@/lib/broker-isolation";
import { buildRosterWorkbookForSite, safeFileName } from "@/lib/roster-export";
import { withApiError } from "@/lib/api/http";
import { BadRequest, NotFound, NoRosterLayout } from "@/lib/api/errors";
import { monthStart } from "@/lib/month-lock";
import { NextResponse } from "next/server";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表匯出", "export");
    const { id } = await params;

    const site = await prisma.site.findUnique({ where: { id } });
    if (!site) throw NotFound();
    // Opus 對抗式驗收第二輪 R3：冇 roster_layout 模板一律 409——雞頭同
    // 內部角色一致（呢個唔係權限問題）。冇呢個 check 之前會靜靜哋跌落
    // `buildGenericRosterWorkbook()`，出一份用戶完全唔知係「冧牌」
    // 版本嘅殘缺/空檔。
    if (!site.rosterLayout) throw NoRosterLayout();

    const url = new URL(req.url);
    const monthParam = url.searchParams.get("month");
    if (!monthParam) throw BadRequest("要帶 ?month=YYYY-MM");
    const parsedMonth = new Date(monthParam);
    if (Number.isNaN(parsedMonth.getTime())) throw BadRequest("month 格式唔啱（要 YYYY-MM）");
    const month = monthStart(parsedMonth);

    let brokerId: string | undefined;
    if (isBrokerRole(session)) {
      brokerId = requireOwnBrokerId(session);
      // (a) 呢個盤呢個月自己有份先准匯出——唔可以靠「已經有更」反推可見性。
      await assertSiteAssignedToBroker(id, brokerId, month);
    }

    // (b) 雞頭：opts.brokerId 令匯出內容淨係包自己保安員嗰幾行。
    const { workbook, siteName } = await buildRosterWorkbookForSite(id, month, { brokerId });

    const buffer = await workbook.xlsx.writeBuffer();
    const monthLabel = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
    const filename = `${safeFileName(`更表 - ${siteName} - ${monthLabel}`)}.xlsx`;

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
      },
    });
  });
}
