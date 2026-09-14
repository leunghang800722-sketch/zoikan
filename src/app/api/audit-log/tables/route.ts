// GET /api/audit-log/tables（additive，只讀，同 GET /api/audit-log 一樣
// 要求「操作紀錄:view」）。
//
// A3（Opus 驗收）：操作紀錄頁「資料表」filter 之前係前端硬編碼一個
// table_name 陣列（見舊版 audit-log/page.tsx 頂註解），要人手同
// writeAudit() 逐個 call site keep in sync，容易漏（例如加咗新表寫
// audit 但冇補落 filter 名單）。呢個 endpoint 直接查 audit_log 實際出現
// 過嘅 distinct table_name，永遠準——冇資料就唔會出現喺揀選名單，唔使
// 白名單維護。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "操作紀錄", "view");
    const rows = await prisma.auditLog.findMany({
      distinct: ["tableName"],
      select: { tableName: true },
      orderBy: { tableName: "asc" },
    });
    const tables = rows.map((r) => r.tableName);
    return ok(brandSafeResponse({ tables }));
  });
}
