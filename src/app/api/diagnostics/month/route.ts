// WP-MONTH-DIAG（老闆 2026-09-27 緊急）：`GET /api/diagnostics/month?month=
// YYYY-MM`——正式站「重新對數全月」8 月數字同 dev 端到端唔同（介紹費、
// 未定價、營業額都唔一致），老闆睇唔到正式站 DB，操作員得瀏覽器——呢個
// **唯讀**診斷 endpoint 俾操作員開個網址貼返數字（冇 PII）。
//
// 權限：淨係老闆——用「月結總表」view（同月結總表報表一致嘅權限
// module）＋顯式 `baseRole === "老闆"` check（「月結總表」view 對主管/
// 會計係「○」出廠關但老闆可以開，呢度加多一重硬性 baseRole 保證，唔
// 靠角色權限畫面嘅設定，同任務書「老闆 only」要求一致）。
import { z } from "zod";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { Forbidden, BadRequest } from "@/lib/api/errors";
import { parseMonthParam } from "@/lib/reports/money";
import { prisma } from "@/lib/db";
import { identityIndexStatus } from "@/lib/guards/identity-indexes";
import { assertNotHistoricalMonth } from "@/lib/month-close/historical";
import { buildMonthDiagnostics } from "@/lib/reports/month-diagnostics";

const monthParamSchema = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "月結總表", "view");
    if (session.baseRole !== "老闆") throw Forbidden("呢個診斷 endpoint 淨係老闆先可以用");

    const url = new URL(req.url);
    const parsedMonth = monthParamSchema.safeParse(url.searchParams.get("month"));
    if (!parsedMonth.success) throw BadRequest("month 要帶值（YYYY-MM）");
    const month = parseMonthParam(parsedMonth.data);
    if (!month) throw BadRequest("month 要帶值（YYYY-MM）");

    await assertNotHistoricalMonth(month, "月份診斷"); // HIST-1
    const diagnostics = await buildMonthDiagnostics(session, month);
    // WP-STAFF-IMPORT：身份證／電話唯一 index 狀態（淨係數字）。
    return ok(brandSafeResponse({ ...diagnostics, identity: await identityIndexStatus(prisma) }));
  });
}
