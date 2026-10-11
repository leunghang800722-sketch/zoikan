// P8.2：`POST /api/triage/questions/batch-accept`——{ question_ids }（≤50）→ 逐題「預覽 → 確認」接受系統建議答案。
// 權限同單題 answer 一樣（導入分診:update ＋ 一鍵結算:create ＋ 只可答自己嗰批，老闆全部）；已鎖月份 403。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { batchAcceptBodySchema, runBatchAccept } from "@/lib/triage/batch-accept";
import { getClientIp, ok, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest } from "@/lib/api/errors";

export async function POST(req: Request) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "update");
    const parsed = batchAcceptBodySchema.safeParse(await readJson(req));
    if (!parsed.success) throw BadRequest("question_ids 要係 1–50 條題目 id");
    const out = await runBatchAccept(actor, parsed.data.question_ids, getClientIp(req));
    return ok(brandSafeResponse({ ...out }));
  });
}
