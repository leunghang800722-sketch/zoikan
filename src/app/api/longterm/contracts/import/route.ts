// WP-LTPAY Phase 2（§20.4 交付 3）：`POST /api/longterm/contracts/import`
// ——Maxwell 長工名單（xlsx）上載，建／更新 `guard_longterm_contracts`。
// module「長工糧」（同「保安員銀行資料」一致粒度——老闆／會計先有，主管／
// 雞頭／保安員硬性拒）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { BadRequest } from "@/lib/api/errors";
import { brandSafeResponse } from "@/lib/api/serialize";
import { importMaxwellContracts, importMaxwellContractsCsv } from "@/lib/longterm-payroll/import-service";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // Maxwell 名單正常幾十至幾百 KB
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "長工糧", "create");

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      throw BadRequest("要用 multipart/form-data 上載（file）");
    }
    // CSV 路徑（Opus 5.5 驗收加：正式站操作員淨係可以傳 CSV）——
    // `active_csv`＝「在職名單」分頁匯出、`left_csv`＝「離職名單」分頁匯出，
    // 至少一個；兩個都有先會處理離職。
    const activeCsv = formData.get("active_csv");
    const leftCsv = formData.get("left_csv");
    if (activeCsv instanceof File || leftCsv instanceof File) {
      const files: Array<{ status: "active" | "left"; text: string }> = [];
      for (const [status, entry] of [["active", activeCsv], ["left", leftCsv]] as const) {
        if (!(entry instanceof File)) continue;
        if (entry.size > MAX_UPLOAD_BYTES) throw BadRequest(`檔案太大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`);
        const buf = Buffer.from(await entry.arrayBuffer());
        if (buf.subarray(0, 4).equals(ZIP_MAGIC) || buf.subarray(0, 4).equals(OLE_MAGIC)) throw BadRequest(`${status === "active" ? "在職名單" : "離職名單"}：呢個係 Excel 檔唔係 CSV——請喺 Excel「另存新檔 → CSV UTF-8」`);
        files.push({ status, text: buf.toString("utf8") });
      }
      const summary = await importMaxwellContractsCsv(files, session.userId, getClientIp(req));
      return ok(brandSafeResponse({ summary }), 200);
    }

    const fileEntry = formData.get("file");
    if (!(fileEntry instanceof File)) throw BadRequest("要帶 file（Maxwell 名單 xlsx），或者 active_csv／left_csv（在職／離職名單 CSV）");
    if (fileEntry.size > MAX_UPLOAD_BYTES) throw BadRequest(`檔案太大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`);

    const buffer = Buffer.from(await fileEntry.arrayBuffer());
    if (!buffer.length) throw BadRequest("檔案係空嘅");
    if (buffer.subarray(0, 4).equals(OLE_MAGIC)) throw BadRequest("呢個係舊版 .xls 檔，請用 Excel 另存做 .xlsx 先上載");
    if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) throw BadRequest("唔係 xlsx 檔案");

    const summary = await importMaxwellContracts(buffer, session.userId, getClientIp(req));

    return ok(brandSafeResponse({ summary }), 200);
  });
}
