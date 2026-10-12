// P15.3：`GET /api/longterm/guard-search?q=`——新增合約表單揀保安員用（長工糧:view）。
// 只回 { guard_id, name, staff_no }（≤20），唔含證件／電話／銀行等敏感欄位。搜尋：姓名（中／英）、任何現有或舊工號。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "長工糧", "view");
    const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 60);
    if (q.length < 1) return ok(brandSafeResponse({ rows: [] }));
    const rows = await prisma.guard.findMany({
      where: {
        OR: [
          { nameZh: { contains: q, mode: "insensitive" } },
          { nameEn: { contains: q, mode: "insensitive" } },
          { staffNo: { contains: q, mode: "insensitive" } },
          { staffNoMw: { contains: q, mode: "insensitive" } },
          { staffNumbers: { some: { number: { contains: q, mode: "insensitive" } } } },
        ],
      },
      select: { id: true, nameZh: true, staffNo: true, staffNoMw: true },
      orderBy: [{ nameZh: "asc" }, { id: "asc" }],
      take: 20,
    });
    return ok(brandSafeResponse({ rows: rows.map((g) => ({ guard_id: g.id, name: g.nameZh, staff_no: g.staffNo ?? g.staffNoMw ?? null })) }));
  });
}
