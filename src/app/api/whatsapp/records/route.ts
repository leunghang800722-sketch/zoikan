// W3：GET /api/whatsapp/records?site=&month=YYYY-MM——該盤該月來源 WhatsApp 嘅排更記錄對應原訊息資訊
// （排更頁格仔 tooltip 用：「來自 WhatsApp｜群｜時間｜原話」＋「⚠ 原訊息已被發訊人修改／撤回」）。
// 權限：「WhatsApp 報更」view；原話／姓名要「保安員」view（冇就只回標示，text＝null）。
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { prisma } from "@/lib/db";
import { ok, withApiError } from "@/lib/api/http";
import { BadRequest } from "@/lib/api/errors";
import { brandSafeResponse } from "@/lib/api/serialize";
import { waRecordInfos } from "@/lib/whatsapp/records";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "WhatsApp 報更", "view");
    const url = new URL(req.url);
    const site = url.searchParams.get("site") ?? "";
    const month = url.searchParams.get("month") ?? "";
    if (!site) throw BadRequest("要帶 site");
    if (!MONTH.test(month)) throw BadRequest("month 要 YYYY-MM");
    const [y, m] = month.split("-").map(Number) as [number, number];
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 0));
    const canSee = await hasPermission(actor, "安員", "view");
    const recs = await prisma.shiftRecord.findMany({
      where: { source: "whatsapp", siteId: site, status: { not: "cancelled" }, workDate: { gte: start, lte: end } },
      select: { id: true, provenance: true },
      take: 2000,
    });
    const infos = await waRecordInfos(recs, canSee);
    return ok(brandSafeResponse({ rows: [...infos.values()], can_see_text: canSee }));
  });
}
