// EMP-P2：`PATCH /api/admin/staff-schemes/:code`——改 label／payer／pay_method（唔可以加減 code，亦唔改 is_frontline／is_longterm／sort）。老闆專用，寫 audit。
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { brandSafeResponse } from "@/lib/api/serialize";
import { NotFound } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import { assertBossOnly } from "@/lib/jobs/admin";
import { STAFF_SCHEME_CODES, loadStaffSchemes } from "@/lib/guards/staff-schemes";

const StaffSchemeUpdateSchema = z
  .object({
    label_zh: z.string().trim().min(1).max(40).optional(),
    payer_code: z.string().trim().max(30).nullable().optional(),
    payer_label_zh: z.string().trim().max(40).nullable().optional(),
    pay_method: z.enum(["cash", "autopay", "salary"]).nullable().optional(),
  })
  .strict();

export async function PATCH(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return withApiError(async () => {
    const session = await requireSession(req);
    assertBossOnly(session);
    const { code } = await params;
    if (!STAFF_SCHEME_CODES.includes(code)) throw NotFound("搵唔到呢個工號體系（code 固定，唔可以加減）");
    const input = parseBody(StaffSchemeUpdateSchema, await readJson(req));
    const cur = (await loadStaffSchemes()).get(code)!;
    const data = {
      labelZh: input.label_zh ?? cur.labelZh,
      payerCode: input.payer_code === undefined ? cur.payerCode : input.payer_code || null,
      payerLabelZh: input.payer_label_zh === undefined ? cur.payerLabelZh : input.payer_label_zh || null,
      payMethod: input.pay_method === undefined ? cur.payMethod : input.pay_method,
    };
    // upsert：設定表缺行（被清）時用出廠預設補返
    const after = await prisma.staffScheme.upsert({
      where: { code },
      update: data,
      create: { code, isFrontline: cur.isFrontline, isLongterm: cur.isLongterm, sort: cur.sort, ...data },
    });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "staff_schemes",
      rowId: code,
      action: "update",
      before: cur,
      after,
      ip: getClientIp(req),
    });
    return ok(brandSafeResponse({ code, label_zh: after.labelZh, payer_code: after.payerCode, payer_label_zh: after.payerLabelZh, pay_method: after.payMethod }));
  });
}
