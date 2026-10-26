// W0：WhatsApp 群組列表／綁定。GET＝view（老闆／會計／主管）；PATCH＝update（淨係老闆）。
// 雞頭／保安員角色硬性拒（matrix.ts）。群組綁定改動寫 audit（whatsapp_groups，before／after 白名單 DTO）。
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { prisma } from "@/lib/db";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { BadRequest, NotFound } from "@/lib/api/errors";
import { brandSafeResponse } from "@/lib/api/serialize";
import { writeAuditTx } from "@/lib/audit";
import { assertGroupConsistent, GroupPatchSchema, LEAVE_OVERRIDE_CODES, pairsToWordMap } from "@/lib/whatsapp/groups";
import { toWaGroupDTO } from "@/lib/whatsapp/dto";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "WhatsApp 報更", "view");
    const canUpdate = await hasPermission(actor, "WhatsApp 報更", "update");
    const [groups, unproc] = await Promise.all([
      prisma.whatsappGroup.findMany({ orderBy: [{ active: "desc" }, { label: "asc" }, { id: "asc" }], include: { site: { select: { canonicalName: true } }, broker: { select: { code: true } } } }),
      prisma.whatsappMessage.groupBy({ by: ["chatJid"], where: { status: "received" }, _count: { _all: true } }),
    ]);
    const unprocByJid = new Map(unproc.map((u) => [u.chatJid, u._count._all]));
    const rows = groups.map((g) =>
      brandSafeResponse({
        ...toWaGroupDTO(g as unknown as Record<string, unknown>),
        site_name: g.site?.canonicalName ?? null,
        broker_code: g.broker?.code ?? null,
        unprocessed_count: unprocByJid.get(g.groupJid) ?? 0,
      }),
    );
    // 綁定表單選項：淨係有 update 權先出（盤名＋判頭代號，唔含收客價／真名）
    const [siteOptions, brokerOptions, shiftTypes] = canUpdate
      ? await Promise.all([
          prisma.site.findMany({ where: { status: { in: ["active", "paused"] } }, select: { id: true, canonicalName: true }, orderBy: { canonicalName: "asc" } }),
          prisma.broker.findMany({ select: { id: true, code: true }, orderBy: { code: "asc" } }),
          // W5：口語對照下拉用——每盤有效更別（只有更碼＋標籤，無價）
          prisma.shiftType.findMany({ where: { voidedAt: null }, select: { siteId: true, code: true, label: true }, orderBy: [{ code: "asc" }] }),
        ])
      : [[], [], []];
    const codesBySite = new Map<string, { code: string; label: string | null }[]>();
    for (const t of shiftTypes) codesBySite.set(t.siteId, [...(codesBySite.get(t.siteId) ?? []), { code: t.code, label: t.label }]);
    return ok(
      brandSafeResponse({
        rows,
        total: rows.length,
        can_update: canUpdate,
        site_options: siteOptions.map((s) => ({ id: s.id, name: s.canonicalName })),
        broker_options: brokerOptions.map((b) => ({ id: b.id, code: b.code })),
        shift_code_options: [...codesBySite.entries()].map(([site_id, codes]) => ({ site_id, codes })),
        leave_code_options: [...LEAVE_OVERRIDE_CODES],
      }),
    );
  });
}

export async function PATCH(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "WhatsApp 報更", "update");
    const body = parseBody(GroupPatchSchema, await readJson(req));
    const cur = await prisma.whatsappGroup.findUnique({ where: { id: body.id } });
    if (!cur) throw NotFound("搵唔到呢個群組");
    const kind = body.kind ?? cur.kind;
    // 轉去 ignored／office／multi_site 時，除非明確傳 site_id／broker_id，否則清走舊綁定（避免殘留）。
    let siteId = body.site_id !== undefined ? body.site_id : cur.siteId;
    let brokerId = body.broker_id !== undefined ? body.broker_id : cur.brokerId;
    if (body.kind !== undefined && body.kind !== cur.kind) {
      if (body.site_id === undefined && kind !== "site") siteId = null;
      if (body.broker_id === undefined && kind !== "broker") brokerId = null;
    }
    if (siteId && !(await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } }))) throw BadRequest("搵唔到呢個盤口");
    if (brokerId && !(await prisma.broker.findUnique({ where: { id: brokerId }, select: { id: true } }))) throw BadRequest("搵唔到呢個判頭");
    const autoWrite = body.auto_write ?? cur.autoWrite;
    const autoConfirm = body.auto_confirm ?? cur.autoConfirm;
    assertGroupConsistent({ kind, siteId, brokerId, autoWrite, autoConfirm });
    const data: Prisma.WhatsappGroupUncheckedUpdateInput = { kind, siteId, brokerId, autoWrite, autoConfirm };
    if (body.label !== undefined && body.label !== cur.label) {
      data.label = body.label;
      data.labelLocked = true; // 用戶手動改群名：之後 WAHA 同步唔再覆蓋
    }
    if (body.active !== undefined) data.active = body.active;
    if (body.card_photo_mode !== undefined) {
      if (body.card_photo_mode && (kind === "ignored" || kind === "office")) throw BadRequest("「略過」或「辦公室」群唔可以開工卡相模式");
      data.cardPhotoMode = body.card_photo_mode;
    }
    if (body.auto_write_daily_cap !== undefined) data.autoWriteDailyCap = body.auto_write_daily_cap;
    if (body.filter_threshold !== undefined) data.filterThreshold = body.filter_threshold;
    if (body.shift_word_map !== undefined) data.shiftWordMap = pairsToWordMap(body.shift_word_map);
    if (body.leave_word_map !== undefined) data.leaveWordMap = pairsToWordMap(body.leave_word_map, 2);
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.whatsappGroup.update({ where: { id: cur.id }, data });
      await writeAuditTx(tx, { actorUserId: actor.userId, tableName: "whatsapp_groups", rowId: cur.id, action: "update", before: cur, after: u, ip: getClientIp(req) });
      return u;
    });
    return ok(toWaGroupDTO(updated as unknown as Record<string, unknown>));
  });
}
