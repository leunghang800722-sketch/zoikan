// WP-ROSTER-UPLOAD Phase A（§15.3）：上載處理服務層——存 bytes＋sha256、
// 解析、對照、寫 `roster_uploads`／`roster_upload_rows`、同盤同月舊版
// supersede。**唔寫入 `shift_records`**（Phase A 範圍明文排除，對數＋
// 寫入係 Phase B）。
import crypto from "node:crypto";
import { Prisma, type RosterUpload, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { monthStart } from "@/lib/month-lock";
import { parseRosterWorkbook, type ParseResult } from "./parse";
import { matchSite, matchBroker, matchShiftType, matchGuard, buildGuardMatchIndex, type SiteCandidate, type BrokerCandidate } from "./match";

type Tx = PrismaClient | Prisma.TransactionClient;

export interface ProcessRosterUploadInput {
  fileBuffer: Buffer;
  fileName: string;
  month: Date; // 月入面任何一日都得，會 normalize 做月初
  siteIdHint?: string | null; // 上載時老闆/主管/會計可以直接揀盤
  uploaderUserId: string;
}

export interface ProcessRosterUploadResult {
  upload: RosterUpload;
  supersededIds: string[];
  parseResult: ParseResult;
}

export interface RosterUploadParseSummary {
  ok: boolean;
  totalCellCount: number;
  shiftCount: number;
  codeBreakdown: Record<string, number>;
  codeKindBreakdown: Record<string, number>;
  dateRange: { min: string; max: string } | null;
  subSiteNames: string[];
  unmatchedGuardCount: number;
  ambiguousGuardCount: number;
  unmatchedShiftTypeCount: number;
  unmatchedBrokerCount: number;
  warnings: string[];
}

/** 逐格對照（雞頭碼→broker、code→shift_type、姓名/電話/工號→guard）＋
 * 砌返 roster_upload_rows 嘅 create 輸入＋parse_summary。純粹讀 DB（傳
 * 入嘅 tx），唔寫入——寫入由 caller（`processRosterUpload`／
 * `reparseRosterUpload`）用同一個 transaction 做。 */
async function matchRowsAndSummarize(
  tx: Tx,
  uploadId: string,
  resolvedSiteId: string | null,
  parseResult: ParseResult,
  brokers: readonly BrokerCandidate[],
): Promise<{ rows: Prisma.RosterUploadRowCreateManyInput[]; summary: RosterUploadParseSummary | null }> {
  if (!parseResult.ok) return { rows: [], summary: null };

  const shiftTypes = resolvedSiteId
    ? await tx.shiftType.findMany({ where: { siteId: resolvedSiteId, voidedAt: null }, select: { id: true, siteId: true, code: true } })
    : [];
  const [guardsRaw, staffNumbersRaw, phonesRaw] = await Promise.all([
    tx.guard.findMany({ select: { id: true, nameZh: true, tel: true, staffNo: true, staffNoMw: true } }),
    tx.guardStaffNumber.findMany({ select: { number: true, guardId: true } }),
    tx.guardPhone.findMany({ select: { guardId: true, tel: true } }),
  ]);
  const guardIndex = buildGuardMatchIndex({ guards: guardsRaw, staffNumbers: staffNumbersRaw, phones: phonesRaw });

  let unmatchedGuardCount = 0;
  let ambiguousGuardCount = 0;
  let unmatchedShiftTypeCount = 0;
  let unmatchedBrokerCount = 0;
  const rows: Prisma.RosterUploadRowCreateManyInput[] = [];

  for (const r of parseResult.rows) {
    const brokerId = matchBroker(r.brokerCodeRaw, brokers);
    if (r.brokerCodeRaw && !brokerId) unmatchedBrokerCount += 1;
    const shiftTypeMatch = matchShiftType(r.rawCode, r.codeKind, resolvedSiteId, shiftTypes);
    const guardResult = matchGuard({ staffNoRaw: r.staffNoRaw, nameRaw: r.nameRaw, telRaw: r.telRaw }, guardIndex);
    if (guardResult.guardMatch === "unmatched") unmatchedGuardCount += 1;
    if (guardResult.guardMatch === "ambiguous") ambiguousGuardCount += 1;

    const warnings = [...r.warnings];
    if (guardResult.guardMatch === "unmatched") warnings.push("安員配對唔到（staff_no/姓名/電話都對唔上現有安員名冊）");
    if (guardResult.guardMatch === "ambiguous") warnings.push("安員配對到多過一個候選，人手覆核");
    if (shiftTypeMatch.ambiguous) {
      warnings.push("更別配對到多過一個候選，人手覆核");
    } else if ((r.codeKind === "shift" || r.codeKind === "ot") && !shiftTypeMatch.id) {
      unmatchedShiftTypeCount += 1;
      warnings.push(`更別「${r.rawCode}」對唔到 shift_types，人手覆核`);
    }

    rows.push({
      uploadId,
      rowIndex: r.rowIndex,
      subSiteName: r.subSiteName,
      workDate: new Date(`${r.workDate}T00:00:00.000Z`),
      rawCode: r.rawCode,
      codeKind: r.codeKind,
      shiftTypeId: shiftTypeMatch.id,
      staffNoRaw: r.staffNoRaw,
      nameRaw: r.nameRaw,
      telRaw: r.telRaw,
      rankRaw: r.rankRaw,
      timeRaw: r.timeRaw,
      brokerCodeRaw: r.brokerCodeRaw,
      guardId: guardResult.guardId,
      guardMatch: guardResult.guardMatch,
      settlementBrokerId: brokerId,
      hours: r.hours,
      warnings: warnings.length ? (warnings as Prisma.InputJsonValue) : Prisma.JsonNull,
    });
  }

  const summary: RosterUploadParseSummary = {
    ok: true,
    totalCellCount: parseResult.totalCellCount,
    shiftCount: parseResult.shiftCount,
    codeBreakdown: parseResult.codeBreakdown,
    codeKindBreakdown: parseResult.codeKindBreakdown,
    dateRange: parseResult.dateRange,
    subSiteNames: parseResult.subSiteNames,
    unmatchedGuardCount,
    ambiguousGuardCount,
    unmatchedShiftTypeCount,
    unmatchedBrokerCount,
    warnings: parseResult.warnings,
  };
  return { rows, summary };
}

/** 同盤同月分組嘅 key——site_id 已解到就用 site_id，未解到就用
 * site_name_raw（trim）暫代，等人手 PATCH 指定咗 site_id 之後嘅下一次
 * 上載先歸到啱嘅版本序列。 */
function versionGroupWhere(siteId: string | null, siteNameRaw: string, month: Date) {
  return siteId
    ? { siteId, month, status: { not: "superseded" as const } }
    : { siteId: null, siteNameRaw: siteNameRaw.trim(), month, status: { not: "superseded" as const } };
}

export async function processRosterUpload(input: ProcessRosterUploadInput): Promise<ProcessRosterUploadResult> {
  const month = monthStart(input.month);
  const sha256 = crypto.createHash("sha256").update(input.fileBuffer).digest("hex");
  const parseResult = await parseRosterWorkbook(input.fileBuffer, input.fileName);

  const [sitesRaw, brokersRaw] = await Promise.all([
    prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true } }),
    prisma.broker.findMany({ select: { id: true, code: true, aliases: true } }),
  ]);
  const sites: SiteCandidate[] = sitesRaw.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases }));
  const brokers: BrokerCandidate[] = brokersRaw.map((b) => ({ id: b.id, code: b.code, aliases: b.aliases }));

  const siteNameRaw = (parseResult.ok ? parseResult.siteRaw : null) ?? input.fileName;
  const resolvedSiteId = input.siteIdHint ?? (parseResult.ok ? matchSite(parseResult.siteRaw, sites) : null);

  return prisma.$transaction(async (tx) => {
    const groupWhere = versionGroupWhere(resolvedSiteId, siteNameRaw, month);
    const previous = await tx.rosterUpload.findMany({ where: groupWhere, select: { id: true, version: true } });
    const nextVersion = previous.length ? Math.max(...previous.map((p) => p.version)) + 1 : 1;
    if (previous.length) {
      await tx.rosterUpload.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { status: "superseded" } });
    }

    const upload = await tx.rosterUpload.create({
      data: {
        month,
        siteId: resolvedSiteId,
        siteNameRaw,
        uploaderUserId: input.uploaderUserId,
        fileName: input.fileName,
        fileSha256: sha256,
        fileBytes: new Uint8Array(input.fileBuffer),
        fileSize: input.fileBuffer.length,
        version: nextVersion,
        status: parseResult.ok ? "parsed" : "parse_failed",
        parseError: parseResult.ok ? null : parseResult.error,
        layoutKey: parseResult.ok ? parseResult.layoutKey : null,
        createdBy: input.uploaderUserId,
      },
    });

    const { rows, summary } = await matchRowsAndSummarize(tx, upload.id, resolvedSiteId, parseResult, brokers);
    if (rows.length) await tx.rosterUploadRow.createMany({ data: rows });
    const finalUpload = summary
      ? await tx.rosterUpload.update({ where: { id: upload.id }, data: { parseSummary: summary as unknown as Prisma.InputJsonValue } })
      : upload;

    return { upload: finalUpload, supersededIds: previous.map((p) => p.id), parseResult };
  });
}

/** 重新解析一個已存在嘅上載（檔案 bytes 唔變）——刪返舊 rows 再插新，
 * upload 本身嘅 status/parse_summary/layout_key 同步更新。已經人手
 * PATCH 指定咗嘅 site_id 保留，唔會俾解析結果覆蓋。 */
export async function reparseRosterUpload(uploadId: string): Promise<ParseResult> {
  const existing = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: uploadId } });
  const buffer = Buffer.from(existing.fileBytes);
  const parseResult = await parseRosterWorkbook(buffer, existing.fileName);

  const [sitesRaw, brokersRaw] = await Promise.all([
    prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true } }),
    prisma.broker.findMany({ select: { id: true, code: true, aliases: true } }),
  ]);
  const sites: SiteCandidate[] = sitesRaw.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases }));
  const brokers: BrokerCandidate[] = brokersRaw.map((b) => ({ id: b.id, code: b.code, aliases: b.aliases }));
  const resolvedSiteId = existing.siteId ?? (parseResult.ok ? matchSite(parseResult.siteRaw, sites) : null);

  await prisma.$transaction(async (tx) => {
    await tx.rosterUploadRow.deleteMany({ where: { uploadId } });
    const { rows, summary } = await matchRowsAndSummarize(tx, uploadId, resolvedSiteId, parseResult, brokers);
    if (rows.length) await tx.rosterUploadRow.createMany({ data: rows });

    await tx.rosterUpload.update({
      where: { id: uploadId },
      data: {
        siteId: resolvedSiteId,
        status: parseResult.ok ? "parsed" : "parse_failed",
        parseSummary: summary ? (summary as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        parseError: parseResult.ok ? null : parseResult.error,
        layoutKey: parseResult.ok ? parseResult.layoutKey : null,
      },
    });
  });

  return parseResult;
}
