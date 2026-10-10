// WP-AI-DIAG（§37.3）：助手 `recent_app_errors` 嘅唯讀 reader——讀 `app_error_log`（已遮罩，冇 body／header／IP／stack）。
// 寫入同遮罩留喺 `src/lib/app-error-log.ts`；呢度放 `src/lib/reports/`（結構守門 allowlist 本來就涵蓋「純讀 report builder」，唔使另開放行）。
import { prisma } from "@/lib/db";

export interface AppErrorRow {
  id: string;
  at: string;
  method: string | null;
  route: string;
  status: number;
  error_code: string | null;
  error_name: string | null;
  message: string;
}

/** 助手 `recent_app_errors` 用：最近 N 條（上限 50），只有已遮罩欄位。 */
export async function listRecentAppErrors(limit: number): Promise<AppErrorRow[]> {
  const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const rows = await prisma.appErrorLog.findMany({
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, createdAt: true, method: true, route: true, status: true, errorCode: true, errorName: true, messageMasked: true },
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt.toISOString(),
    method: r.method,
    route: r.route,
    status: r.status,
    error_code: r.errorCode,
    error_name: r.errorName,
    message: r.messageMasked,
  }));
}
