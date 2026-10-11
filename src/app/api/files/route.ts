// P8.3：`GET /api/files?month=YYYY-MM`——鎖月後自動生成嘅檔案清單（唔含 content）。
// 權限按 kind 對應原匯出 route 嘅 module 嘅 `export`（糧明細／月結總表／長工糧）：只列有權嘅 kind；一個都冇權 → 403（雞頭）。
import { prisma } from "@/lib/db";
import { requireSession, hasPermission } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest, Forbidden } from "@/lib/api/errors";
import { parseMonthParam, monthLabel } from "@/lib/reports/money";
import { FILE_KINDS, FILE_KIND_META, type FileKind } from "@/lib/files/generated";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requireSession(req);
    const allowed: FileKind[] = [];
    for (const k of FILE_KINDS) if (await hasPermission(session, FILE_KIND_META[k].module, "export")) allowed.push(k);
    if (allowed.length === 0) throw Forbidden("冇權下載已生成檔案");
    const monthParam = new URL(req.url).searchParams.get("month");
    const month = monthParam ? parseMonthParam(monthParam) : null;
    if (monthParam && !month) throw BadRequest("month 要 YYYY-MM");
    const rows = await prisma.generatedFile.findMany({
      where: { kind: { in: allowed }, ...(month ? { month } : {}) },
      orderBy: [{ month: "desc" }, { kind: "asc" }, { generatedAt: "desc" }],
      select: { id: true, month: true, kind: true, filename: true, size: true, sha256: true, generatedAt: true, generatedBy: true, sourceLockedAt: true, current: true },
      take: 200,
    });
    return ok(
      brandSafeResponse({
        files: rows.map((r) => ({
          id: r.id,
          month: monthLabel(r.month),
          kind: r.kind,
          kind_label: FILE_KIND_META[r.kind as FileKind]?.label ?? r.kind,
          filename: r.filename,
          size: r.size,
          sha256: r.sha256,
          generated_at: r.generatedAt.toISOString(),
          generated_by: r.generatedBy,
          source_locked_at: r.sourceLockedAt?.toISOString() ?? null,
          current: r.current,
          needs_confirm: r.kind === "longterm_autopay",
        })),
      }),
    );
  });
}
