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
  outOfMonthCount: number;
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
  month: Date,
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
  let outOfMonthCount = 0;
  // 驗收 2026-09-23：python 版（extract.py EXPECTED_YEAR_MONTH）會將「格仔
  // 日期唔係呢個月」逐格列入 unparsed 俾人覆核——移植漏咗。上載揀錯月份
  // （例如 8 月更表揀咗 9 月）或者更表夾住上／下月日子，都要明確警告。
  const monthPrefix = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-`;
  const rows: Prisma.RosterUploadRowCreateManyInput[] = [];

  for (const r of parseResult.rows) {
    const brokerId = matchBroker(r.brokerCodeRaw, brokers);
    if (r.brokerCodeRaw && !brokerId) unmatchedBrokerCount += 1;
    const shiftTypeMatch = matchShiftType(r.rawCode, r.codeKind, resolvedSiteId, shiftTypes);
    const guardResult = matchGuard({ staffNoRaw: r.staffNoRaw, nameRaw: r.nameRaw, telRaw: r.telRaw }, guardIndex);
    if (guardResult.guardMatch === "unmatched") unmatchedGuardCount += 1;
    if (guardResult.guardMatch === "ambiguous") ambiguousGuardCount += 1;

    const warnings = [...r.warnings];
    if (!r.workDate.startsWith(monthPrefix)) {
      outOfMonthCount += 1;
      warnings.push(`格仔日期 ${r.workDate} 唔係上載月份（${monthPrefix.slice(0, 7)}），人手覆核`);
    }
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
    outOfMonthCount,
    warnings: outOfMonthCount
      ? [`有 ${outOfMonthCount} 格日期唔係上載月份（${monthPrefix.slice(0, 7)}）——檢查係咪揀錯月份`, ...parseResult.warnings]
      : parseResult.warnings,
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

/** 驗收 2026-09-23：同盤同月版本序列嘅 transaction 級 advisory lock——
 * 冇呢個，兩個同時上載（例如撳兩下）喺 READ COMMITTED 下面會各自睇唔到
 * 對方，兩個都變 v(N+1) 而且都係 active。 */
async function lockVersionGroup(tx: Prisma.TransactionClient, siteId: string | null, siteNameRaw: string, month: Date): Promise<void> {
  const key = `roster_upload:${month.toISOString().slice(0, 7)}:${siteId ?? `raw:${siteNameRaw.trim()}`}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
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
    await lockVersionGroup(tx, resolvedSiteId, siteNameRaw, month);
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

    const { rows, summary } = await matchRowsAndSummarize(tx, upload.id, resolvedSiteId, parseResult, brokers, month);
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
export async function reparseRosterUpload(uploadId: string, opts: { autoResolveSite?: boolean } = {}): Promise<ParseResult> {
  const autoResolveSite = opts.autoResolveSite ?? true;
  const existing = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: uploadId } });
  const buffer = Buffer.from(existing.fileBytes);
  const parseResult = await parseRosterWorkbook(buffer, existing.fileName);

  const [sitesRaw, brokersRaw] = await Promise.all([
    prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true } }),
    prisma.broker.findMany({ select: { id: true, code: true, aliases: true } }),
  ]);
  const sites: SiteCandidate[] = sitesRaw.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases }));
  const brokers: BrokerCandidate[] = brokersRaw.map((b) => ({ id: b.id, code: b.code, aliases: b.aliases }));
  // 驗收 2026-09-23：PATCH `{site_id:null}`（人手清返未指定）之後唔好即刻
  // 又用盤名自動配返，否則「清返」永遠清唔到。
  const resolvedSiteId = existing.siteId ?? (autoResolveSite && parseResult.ok ? matchSite(parseResult.siteRaw, sites) : null);
  // 驗收 2026-09-23：已被取代（superseded）／已確認（confirmed）嘅版本重新
  // 解析之後**唔准**變返 parsed——之前會令同盤同月出現兩個 active 版本。
  const keepStatus = existing.status === "superseded" || existing.status === "confirmed";

  await prisma.$transaction(async (tx) => {
    await tx.rosterUploadRow.deleteMany({ where: { uploadId } });
    const { rows, summary } = await matchRowsAndSummarize(tx, uploadId, resolvedSiteId, parseResult, brokers, existing.month);
    if (rows.length) await tx.rosterUploadRow.createMany({ data: rows });

    await tx.rosterUpload.update({
      where: { id: uploadId },
      data: {
        siteId: resolvedSiteId,
        status: keepStatus ? existing.status : parseResult.ok ? "parsed" : "parse_failed",
        parseSummary: summary ? (summary as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        parseError: parseResult.ok ? null : parseResult.error,
        layoutKey: parseResult.ok ? parseResult.layoutKey : null,
      },
    });
  });

  return parseResult;
}


/** 驗收 2026-09-23：PATCH `site_id`（人手指定盤）——之前淨係 update
 * siteId，如果目標盤呢個月已經有 active 上載，就會出現兩個 active v1。
 * 而家喺 advisory lock 入面：呢個上載攞目標組別 max(version)+1；目標組別
 * 入面「上載時間最新」嗰個保持 active，其餘轉 superseded（唔會因為人手
 * 指定一個舊檔而蓋咗較新嘅上載）。返回被轉 superseded 嘅 id。 */
export async function assignRosterUploadSite(uploadId: string, siteId: string | null): Promise<{ supersededIds: string[] }> {
  return prisma.$transaction(async (tx) => {
    const upload = await tx.rosterUpload.findUniqueOrThrow({ where: { id: uploadId } });
    await lockVersionGroup(tx, siteId, upload.siteNameRaw, upload.month);
    if (upload.siteId === siteId) return { supersededIds: [] };
    const others = await tx.rosterUpload.findMany({
      where: { ...versionGroupWhere(siteId, upload.siteNameRaw, upload.month), id: { not: uploadId } },
      select: { id: true, uploadedAt: true },
    });
    const allVersions = await tx.rosterUpload.findMany({
      where: siteId ? { siteId, month: upload.month } : { siteId: null, siteNameRaw: upload.siteNameRaw.trim(), month: upload.month },
      select: { version: true },
    });
    const nextVersion = allVersions.length ? Math.max(...allVersions.map((v) => v.version)) + 1 : 1;
    const isActive = upload.status !== "superseded" && upload.status !== "confirmed";
    const thisIsNewest = others.every((o) => o.uploadedAt <= upload.uploadedAt);
    const supersededIds = isActive && thisIsNewest ? others.map((o) => o.id) : [];
    if (supersededIds.length) {
      await tx.rosterUpload.updateMany({ where: { id: { in: supersededIds } }, data: { status: "superseded" } });
    }
    await tx.rosterUpload.update({
      where: { id: uploadId },
      data: {
        siteId,
        version: nextVersion,
        ...(isActive && !thisIsNewest ? { status: "superseded" as const } : {}),
      },
    });
    return { supersededIds };
  });
}
