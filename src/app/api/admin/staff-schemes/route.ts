// EMP-P2：`GET /api/admin/staff-schemes`——工號體系設定（U／MP／MG／MW）。老闆專用（同 /api/admin/jobs 一致）。
import { requireSession } from "@/lib/rbac/requirePermission";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { assertBossOnly } from "@/lib/jobs/admin";
import { loadStaffSchemes } from "@/lib/guards/staff-schemes";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requireSession(req);
    assertBossOnly(session);
    const schemes = [...(await loadStaffSchemes()).values()].sort((a, b) => a.sort - b.sort);
    return ok(
      brandSafeResponse({
        schemes: schemes.map((s) => ({ code: s.code, label_zh: s.labelZh, payer_code: s.payerCode, payer_label_zh: s.payerLabelZh, pay_method: s.payMethod, is_frontline: s.isFrontline, is_longterm: s.isLongterm, sort: s.sort })),
      }),
    );
  });
}
