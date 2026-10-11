// P7.1：`GET/PATCH /api/users/:id/notify`——通知電郵＋每類通知 email 開關。
// 本人改自己；老闆改所有人。電郵屬聯絡資料：唔入 ai schema／AI 工具輸出，audit 只記「已改」（唔存電郵值）。
import { prisma } from "@/lib/db";
import { requireSession, type AuthedSession } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { NotifySettingsSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { Forbidden, NotFound, BadRequest } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { NOTIFY_KIND_SET } from "@/lib/notify/kinds";
import type { Prisma } from "@prisma/client";

function assertSelfOrBoss(session: AuthedSession, id: string): void {
  if (session.userId !== id && session.baseRole !== "老闆") throw Forbidden("淨係本人或老闆先可以睇／改通知電郵");
}

function dto(u: { notifyEmail: string | null; notifyPrefs: unknown }) {
  return { notify_email: u.notifyEmail, notify_prefs: (u.notifyPrefs ?? {}) as Record<string, boolean> };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requireSession(req);
    const { id } = await params;
    assertSelfOrBoss(session, id);
    const u = await prisma.user.findUnique({ where: { id }, select: { notifyEmail: true, notifyPrefs: true } });
    if (!u) throw NotFound();
    return ok(brandSafeResponse({ ...dto(u) }));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requireSession(req);
    const { id } = await params;
    assertSelfOrBoss(session, id);
    const input = parseBody(NotifySettingsSchema, await readJson(req));
    const before = await prisma.user.findUnique({ where: { id }, select: { notifyEmail: true, notifyPrefs: true } });
    if (!before) throw NotFound();
    const data: Prisma.UserUpdateInput = {};
    if (input.notify_email !== undefined) data.notifyEmail = input.notify_email === null || input.notify_email === "" ? null : input.notify_email.toLowerCase();
    if (input.notify_prefs !== undefined) {
      for (const k of Object.keys(input.notify_prefs)) if (!NOTIFY_KIND_SET.has(k)) throw BadRequest(`未知通知類別：${k}`);
      data.notifyPrefs = { ...((before.notifyPrefs ?? {}) as Record<string, boolean>), ...input.notify_prefs };
    }
    const after = await prisma.user.update({ where: { id }, data, select: { notifyEmail: true, notifyPrefs: true } });
    await writeAudit({ actorUserId: session.userId, tableName: "users", rowId: id, action: "notify_email_update", after: { changed: true, email_set: !!after.notifyEmail }, ip: getClientIp(req) });
    return ok(brandSafeResponse({ ...dto(after) }));
  });
}
