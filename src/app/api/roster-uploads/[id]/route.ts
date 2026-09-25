// WP-ROSTER-UPLOAD Phase A（§15.3）：`GET /api/roster-uploads/:id`（rows
// 分頁＋summary，`?guard_match=unmatched` 篩未配對）、`PATCH
// /api/roster-uploads/:id`（人手指定 site_id——上載時盤名對唔到，之後
// 由會計/主管/老闆補；指定咗之後即刻重新對照一次，等更別/安員配對用返
// 啱嘅盤範圍）。
import { prisma } from "@/lib/db";
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { toRosterUploadDTO, toRosterUploadRowDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGateToList, applyFieldGroupGate } from "@/lib/api/field-groups";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams } from "@/lib/api/query";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { RosterUploadPatchSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound, BadRequest, Conflict } from "@/lib/api/errors";
import { assignRosterUploadSite, reparseRosterUpload } from "@/lib/roster-upload/service";
import type { Prisma } from "@prisma/client";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "view");
    const { id } = await params;
    const upload = await prisma.rosterUpload.findUnique({ where: { id } });
    if (!upload) throw NotFound();

    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const guardMatchParam = url.searchParams.get("guard_match"); // ?guard_match=unmatched 篩未配對（UI 用）
    const ALLOWED_GUARD_MATCH = ["by_staff_no", "by_name_tel", "by_name", "unmatched", "ambiguous"] as const;
    type GuardMatchValue = (typeof ALLOWED_GUARD_MATCH)[number];
    if (guardMatchParam && !(ALLOWED_GUARD_MATCH as readonly string[]).includes(guardMatchParam)) {
      throw BadRequest(`guard_match 要係其中一個：${ALLOWED_GUARD_MATCH.join("/")}`);
    }
    // Phase B-0 第 4 項：呢兩類細分（工號唔一致／用已取消舊號配對）淨係
    // 加咗 warnings 文字，冇改 `guard_match` enum（見 match.ts
    // GuardMatchResult 註解），所以要用 `warnings::text ILIKE` 篩，
    // Prisma 嘅 Json filter 冇「子字串 contains」呢種表達力。
    const warningFlagParam = url.searchParams.get("warning_flag");
    const WARNING_FLAG_PATTERNS: Record<string, string> = {
      staff_no_mismatch: "%同系統工號%唔一致%",
      stale_staff_no: "%用已取消舊號配對%",
      // B1-8 第 3 項：工號命中另一個人（姓名對唔上，唔准配）。
      staff_no_belongs_to_other: "%屬另一人（姓名對唔上）%",
    };
    if (warningFlagParam && !(warningFlagParam in WARNING_FLAG_PATTERNS)) {
      throw BadRequest(`warning_flag 要係其中一個：${Object.keys(WARNING_FLAG_PATTERNS).join("/")}`);
    }
    let warningFilterIds: string[] | null = null;
    if (warningFlagParam) {
      const pattern = WARNING_FLAG_PATTERNS[warningFlagParam]!;
      const matched = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM roster_upload_rows WHERE upload_id = ${id} AND warnings::text ILIKE ${pattern}`;
      warningFilterIds = matched.map((r) => r.id);
    }
    const where: Prisma.RosterUploadRowWhereInput = {
      uploadId: id,
      ...(guardMatchParam ? { guardMatch: guardMatchParam as GuardMatchValue } : {}),
      ...(warningFilterIds ? { id: { in: warningFilterIds } } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.rosterUploadRow.findMany({ where, skip, take, orderBy: [{ workDate: "asc" }, { rowIndex: "asc" }] }),
      prisma.rosterUploadRow.count({ where }),
    ]);

    const uploadDto = await applyFieldGroupGate(session, "roster_uploads", toRosterUploadDTO(upload));
    const rowsListDto = mapListDTO({ rows, total, skip, take }, toRosterUploadRowDTO);
    const gatedRowsDto = await applyFieldGroupGateToList(session, "roster_upload_rows", rowsListDto);
    // 驗收 2026-09-23：Phase B-0「檔案工號 X 同系統工號 Y 唔一致」warning
    // 將工號原文寫咗入 `warnings`——`staff_no_raw` 本身屬「安員個人資料」
    // field gate（主管出廠係 O＝預設冇），唔遮嘅話冇權限嘅角色經 warnings
    // 一樣睇到工號。冇 view 權限就將兩個號碼換做「（已隱藏）」，保留其餘
    // 文字（`?warning_flag=` 篩選同 UI 顯示照用）。
    const canSeeGuardPii = await hasPermission(session, "安員個人資料", "view");
    const rowsDto = canSeeGuardPii
      ? gatedRowsDto
      : brandSafeResponse({ ...gatedRowsDto, rows: gatedRowsDto.rows.map((r) => ({ ...r, warnings: redactStaffNoWarnings(r.warnings) })) });

    return ok(brandSafeResponse({ upload: uploadDto, rows: rowsDto }));
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表上載", "update");
    const { id } = await params;
    const before = await prisma.rosterUpload.findUnique({ where: { id } });
    if (!before) throw NotFound();
    // WP-UPLOAD-VOID：已作廢嘅上載係歷史記錄，唔准再人手指定盤——要
    // 「改盤」即係當呢個上載未作廢過（老闆要求上載唔准人手補救嘅精神
    // 一致：作廢咗就係終態，要更正就重新上載）。
    if (before.status === "voided") throw Conflict("呢個上載已經作廢，唔可以再指定盤");

    const body = await readJson(req);
    const parsed = parseBody(RosterUploadPatchSchema, body);

    if (parsed.site_id) {
      const site = await prisma.site.findUnique({ where: { id: parsed.site_id }, select: { id: true } });
      if (!site) throw BadRequest("site_id 唔存在");
    }

    // 驗收 2026-09-23：改盤要同時處理版本序列（目標盤呢個月已經有 active
    // 上載嘅話，唔可以變兩個 active v1）——見 assignRosterUploadSite()。
    const { supersededIds } = await assignRosterUploadSite(id, parsed.site_id);
    // 重新對照一次（更別配對要跟返新盤嘅 shift_types 範圍）——`reparseRosterUpload`
    // 用返原檔 bytes，唔使用戶重新上載。壞檔（parse_failed）冇 rows 可以重配，
    // 但 site_id 本身已經update咗，`reparseRosterUpload` 一樣會行（照樣搵唔到 Date 表頭）。
    // autoResolveSite=false：人手清返 null 就係 null，唔好又用盤名自動配返。
    await reparseRosterUpload(id, { autoResolveSite: false });

    const after = await prisma.rosterUpload.findUniqueOrThrow({ where: { id } });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "roster_uploads",
      rowId: id,
      action: "update",
      before,
      after: { ...after, superseded_upload_ids: supersededIds },
      ip: getClientIp(req),
    });

    return ok(toRosterUploadDTO(after));
  });
}

const STAFF_NO_MISMATCH_RE = /檔案工號 .*? 同系統工號 .*? 唔一致/g;
// B1-8 第 3 項：「工號屬另一人」warning 同上面一樣帶工號原文，一齊遮。
const STAFF_NO_BELONGS_TO_OTHER_RE = /檔案工號 .*? 屬另一人（姓名對唔上），唔會自動配對，人手覆核/g;

function redactStaffNoWarnings(warnings: unknown): unknown {
  if (!Array.isArray(warnings)) return warnings;
  return warnings.map((w) =>
    typeof w === "string"
      ? w
          .replace(STAFF_NO_MISMATCH_RE, "檔案工號（已隱藏）同系統工號（已隱藏）唔一致")
          .replace(STAFF_NO_BELONGS_TO_OTHER_RE, "檔案工號（已隱藏）屬另一人（姓名對唔上），唔會自動配對，人手覆核")
      : w,
  );
}
