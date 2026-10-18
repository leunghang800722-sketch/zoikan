// TE-1：`POST /api/triage/sessions/:id/evidence-images[?dry_run=1]`——上載覆核證據裁圖 zip（本機 20-triage-evidence.ts 出）。
// multipart 欄位 file＝zip（≤8 MB）。權限「導入分診:update」＋老闆／session 擁有人；淨係 guard_import session。
// 回應同 audit 只有計數（唔回顯 entry 名／manifest 內容）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { getSessionFor } from "@/lib/triage/session";
import { MAX_ZIP_BYTES, runEvidenceUpload } from "@/lib/triage/evidence-upload";
import { ApiError, BadRequest } from "@/lib/api/errors";
import { getClientIp, ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

const BODY_LIMIT = MAX_ZIP_BYTES + 64 * 1024; // multipart 框架開銷

/** 串流讀 body，累計 bytes 超過上限即刻中止（唔信 content-length；冇 header 都擋到）。 */
async function readBodyLimited(req: Request): Promise<Uint8Array> {
  const tooBig = () => new ApiError(413, "payload_too_large", "zip 檔案太大（上限 8 MB）");
  if (!req.body) throw BadRequest("請上載 zip 檔（欄位名 file）");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > BODY_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "update");
    const { id } = await params;
    const session = await getSessionFor(actor, id);
    if (session.sourceType !== "guard_import") throw BadRequest("淨係保安員證件資料導入嘅分診先可以上載覆核裁圖");
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > BODY_LIMIT) throw new ApiError(413, "payload_too_large", "zip 檔案太大（上限 8 MB）");
    const raw = await readBodyLimited(req);
    const ct = req.headers.get("content-type") ?? "";
    const f = (await new Response(raw as BodyInit, { headers: { "content-type": ct } }).formData().catch(() => null))?.get("file");
    if (!f || typeof f === "string") throw BadRequest("請上載 zip 檔（欄位名 file）");
    if (f.size > MAX_ZIP_BYTES) throw BadRequest("zip 檔案太大（上限 8 MB）");
    const bytes = new Uint8Array(await f.arrayBuffer());
    const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
    const out = await runEvidenceUpload(actor, session.id, bytes, { dryRun, ip: getClientIp(req) });
    return ok(brandSafeResponse({ ...out }));
  });
}
