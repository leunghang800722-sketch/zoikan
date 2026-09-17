import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, scrubForBrokerSession, isBrokerRole } from "@/lib/broker-isolation";
import { toBrokerGuardDTO } from "@/lib/broker-dto";
import { toGuardFullDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, assertFieldGroupWritable, dropUnchangedFieldGroupValues } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { GuardUpdateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound } from "@/lib/api/errors";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";
import type { Prisma } from "@prisma/client";

function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const row = await prisma.guard.findFirst({ where });
    if (!row) throw NotFound();
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(row)));
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(row)));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "update");
    const { id } = await params;
    const where = scopeGuardWhere(session, { id });
    const before = await prisma.guard.findFirst({ where });
    if (!before) throw NotFound();
    const body = await readJson(req);
    const parsed = parseBody(GuardUpdateSchema, body);
    // WP-PII（Opus 驗收必修 2a）：前端編輯抽屜起草成個 form，撳「儲存」
    // 成個 form 一齊送——冇改嘅 field-group 受控欄（例如長工冇改月薪，
    // 但主管淨係改咗電話）唔算「想寫」，先由 body 度刪走，先至再
    // assertFieldGroupWritable()（唔係就會被冇改嘅欄嗰個 field-group
    // 誤 403，見 src/lib/api/field-groups.ts dropUnchangedFieldGroupValues()
    // 大註解）。
    const effectiveBody = dropUnchangedFieldGroupValues("guards", parsed, before as unknown as Record<string, unknown>);
    // WP-PII：body 帶「收客價/出街價/安員個人資料/安員銀行資料」任何一組
    // 欄位，冇對應 module 嘅 update 權限一律 403（唔准靜靜忽略）——同
    // rate-cards/sites 等 route 一致做法（見 src/lib/api/field-groups.ts）。
    await assertFieldGroupWritable(session, "guards", effectiveBody);
    const data = snakeToCamelShallow(effectiveBody) as Prisma.GuardUncheckedUpdateInput;
    const after = await prisma.guard.update({ where: { id }, data });
    await writeAudit({ actorUserId: session.userId, tableName: "guards", rowId: id, action: "update", before, after, ip: getClientIp(req) });
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(after)));
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(after)));
  });
}
