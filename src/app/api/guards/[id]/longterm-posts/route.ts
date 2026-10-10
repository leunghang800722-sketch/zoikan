// WP-PHASE3（§20.4 Phase 3 item 1）：保安員抽屜「長工」區——長工崗位盤
// CRUD。跟 `src/app/api/guards/[id]/staff-numbers/route.ts` 一致嘅
// module selector（內部角色「保安員」，雞頭「自己保安員」）；雞頭 session 讀
// 寫一律硬性 403（Opus 5.5 驗收：原本雞頭讀得到自己保安員嘅崗位盤，同
// 「長工」區雞頭結構性見唔到嘅設計唔一致），唔靠矩陣 cell。
//
// GET：列出呢個保安員全部崗位盤（未作廢＋已作廢都列，前端自己分現行/
// 歷史）。POST：新增一條生效崗位記錄（`source=manual`）——唔同盤冇硬性
// 「同一時間只可以有一個生效崗位」檢查（同 guard-fix `set_longterm_post`
// 一致，長工短期可能同時掛兩個盤嘅記錄，由人手判斷）；**同一個盤**生效
// 期重疊就 409（Opus 5.5 驗收，見 src/lib/guards/longterm-posts.ts）。
import { guardModule, assertScopedGuard } from "@/lib/api/route-modules";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole } from "@/lib/broker-isolation";
import { toGuardLongtermPostDTO } from "@/lib/api/dto";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardLongtermPostCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound, Forbidden } from "@/lib/api/errors";
import { assertLongtermPostPeriodOk } from "@/lib/guards/longterm-posts";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    // WP-PHASE3 Opus 5.5 驗收：「長工」區雞頭結構性見唔到——連讀都硬性
    // 拒（原本雞頭讀得到自己保安員嘅崗位盤記錄，同「長工」區唔俾雞頭睇
    // 嘅設計唔一致；雞頭前端本身冇 call 呢個 endpoint）。
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以睇長工崗位盤");
    const { id } = await params;
    await assertScopedGuard(session, id);
    const rows = await prisma.guardLongtermPost.findMany({
      where: { guardId: id },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    });
    return ok(rows.map(toGuardLongtermPostDTO));
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    // WP-PHASE3：同 staff-numbers／phones 一致——雞頭 session 淨係讀，
    // 唔可以寫（唔靠「自己保安員:update」出廠 off 個 cell，見 module 選擇
    // 大註解）。
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以新增長工崗位盤");
    const { id } = await params;
    const guard = await prisma.guard.findUnique({ where: { id }, select: { id: true } });
    if (!guard) throw NotFound();
    const body = await readJson(req);
    const parsed = parseBody(GuardLongtermPostCreateSchema, body);
    const siteRow = await prisma.site.findUnique({ where: { id: parsed.site_id }, select: { id: true } });
    if (!siteRow) throw NotFound("搵唔到呢個盤");
    // WP-PHASE3 Opus 5.5 驗收：同一盤生效期重疊擋（409）＋終止日唔可以早過生效日（400）。
    await assertLongtermPostPeriodOk({ guardId: id, siteId: parsed.site_id, effectiveFrom: parsed.effective_from, effectiveTo: parsed.effective_to ?? null });
    const created = await prisma.guardLongtermPost.create({
      data: {
        guardId: id,
        siteId: parsed.site_id,
        effectiveFrom: parsed.effective_from,
        effectiveTo: parsed.effective_to ?? null,
        source: "manual",
        note: parsed.note ?? null,
        createdBy: session.userId,
      },
    });
    await writeAudit({ actorUserId: session.userId, tableName: "guard_longterm_posts", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(toGuardLongtermPostDTO(created), 201);
  });
}
