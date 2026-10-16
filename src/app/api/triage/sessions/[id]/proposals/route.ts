// TR-1：`POST /api/triage/sessions/:id/proposals[?dry_run=1]`——導入「OCR 重讀建議答案」（本機 19-triage-reread.ts 出嘅 proposals.json）。
// body：JSON `{version:1, proposals:[…]}`（≤2,000 條）或 multipart（欄位 file＝JSON 檔）。權限同答題一樣（導入分診:update＋老闆／session 擁有人）；
// 只處理 guard_import session 嘅 open 題（field_review／name_not_confirmed／hkid_not_confirmed）。回應淨係計數。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { getSessionFor } from "@/lib/triage/session";
import { proposalsBodySchema, runProposals } from "@/lib/triage/proposals";
import { BadRequest } from "@/lib/api/errors";
import { getClientIp, ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

const MAX_BODY_BYTES = 2_000_000;

async function readBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? "";
  let text: string;
  if (ct.includes("multipart/form-data")) {
    const f = (await req.formData().catch(() => null))?.get("file");
    if (!f || typeof f === "string") throw BadRequest("請上載 proposals.json（欄位名 file）");
    if (f.size > MAX_BODY_BYTES) throw BadRequest("檔案太大");
    text = await f.text();
  } else {
    text = await req.text();
    if (text.length > MAX_BODY_BYTES) throw BadRequest("內容太大");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw BadRequest("唔係有效嘅 JSON");
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "update");
    const { id } = await params;
    const session = await getSessionFor(actor, id);
    if (session.sourceType !== "guard_import") throw BadRequest("淨係保安員證件資料導入嘅分診先可以導入 OCR 重讀建議");
    const parsed = proposalsBodySchema.safeParse(await readBody(req));
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw BadRequest(`建議檔格式唔啱（${i ? i.path.join(".") : "unknown"}）`);
    }
    const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
    const out = await runProposals(actor, session.id, parsed.data.proposals, { dryRun, ip: getClientIp(req) });
    return ok(brandSafeResponse({ ...out }));
  });
}
