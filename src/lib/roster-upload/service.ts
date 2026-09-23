// WP-ROSTER-UPLOAD Phase A（§15.3）：上載處理服務層——存 bytes＋sha256、
// 解析、對照、寫 `roster_uploads`／`roster_upload_rows`、同盤同月舊版
// supersede。**唔寫入 `shift_records`**（Phase A 範圍明文排除，對數＋
// 寫入係 Phase B）。
//
// Phase B-0（§15.3）喺呢個檔案加咗四樣嘢：
//   1. 合併儲存格展開（parse.ts 做，呢度冇改）。
//   2. 更別配對用 `time_raw` 收窄——`matchShiftType()` 簽名加咗
//      `timeRaw` 同 candidates 加咗 `timeSlot`（見 match.ts）。
//   3. 一檔多子盤（城巴車廠／CP5）——`matchRowsAndSummarize()` 加咗
//      「攞呢個上載盤嘅子盤名單、逐行用 sub_site_name 對子盤」呢層，
//      算出嚟嘅「解析後實際盤」寫落新欄 `resolved_site_id`，更別配對
//      跟呢個欄嘅盤範圍（唔跟上載本身嘅 site_id）。
//   4. 工號唔一致／已取消舊號——`match.ts` `matchGuard()` 加咗兩個
//      flag，呢度轉做 warnings 文字（「二揀一」揀咗唔改 `guard_match`
//      enum，理由見 match.ts `GuardMatchResult` 註解）。
//   5. 同檔重複上載——(a) 同 SHA-256 唔擋，response 帶
//      `duplicateOfVersion` 俾前端出提示；(b) 老闆 2026-09-23 追加答：
//      更新檔嘅檔名一定要同該盤同月任何現有版本（active 或
//      superseded）唔同，同名一律 400、唔存底、唔開版本。
import crypto from "node:crypto";
import { Prisma, type RosterUpload, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { monthStart } from "@/lib/month-lock";
import { BadRequest } from "@/lib/api/errors";
import { parseRosterWorkbook, type ParseResult } from "./parse";
import { shiftTypeTimeSlot } from "./time-range";
import {
  matchSite,
  matchBroker,
  matchShiftType,
  matchGuard,
  buildGuardMatchIndex,
  type SiteCandidate,
  type BrokerCandidate,
  type ShiftTypeCandidate,
} from "./match";

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
  /** Phase B-0 第 5(a) 項：呢次上載嘅 SHA-256 同（即將被取代嗰個）舊版
   * 完全一樣就係嗰個舊版嘅 `version`，唔一樣就 null。唔擋上載，淨係俾
   * 前端出提示。 */
  duplicateOfVersion: number | null;
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
  ambiguousShiftTypeCount: number;
  unmatchedBrokerCount: number;
  outOfMonthCount: number;
  /** Phase B-0 第 1 項：由橫向合併格展開出嚟嘅格數總和。 */
  mergedExpandedCount: number;
  /** Phase B-0 第 3 項：有子盤嘅上載入面，sub_site_name 對唔到任何一個
   * 子盤嘅格數。 */
  unmatchedSubSiteCount: number;
  /** Phase B-0 第 4(b) 項：靠已取消（former）舊工號配對到嘅格數。 */
  staleStaffNoCount: number;
  /** Phase B-0 第 4(a) 項：檔案工號同系統工號唔一致（退用姓名/電話配
   * 到）嘅格數。 */
  staffNoMismatchCount: number;
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

  // Phase B-0 第 3 項：呢個上載掛嘅盤如果有子盤（`sites.parent_site_id`
  // 指返嚟），逐行用 `sub_site_name`（同 aliases）對返個子盤；更別配對
  // 要跟子盤嘅 shift_types 範圍，唔跟上載本身嘅 site_id。
  const childSitesRaw = resolvedSiteId ? await tx.site.findMany({ where: { parentSiteId: resolvedSiteId }, select: { id: true, canonicalName: true, aliases: true } }) : [];
  const childSites: SiteCandidate[] = childSitesRaw.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases }));

  const shiftTypeSiteIds = resolvedSiteId ? [resolvedSiteId, ...childSites.map((c) => c.id)] : [];
  const shiftTypesRaw = shiftTypeSiteIds.length
    ? await tx.shiftType.findMany({ where: { siteId: { in: shiftTypeSiteIds }, voidedAt: null }, select: { id: true, siteId: true, code: true, startTime: true, endTime: true } })
    : [];
  // Phase B-0 第 2 項：candidates 加埋 `timeSlot`（由 start_time/end_time
  // 算），`matchShiftType()` 多過一個候選嗰陣會用嚟同 `timeRaw` 收窄。
  const shiftTypes: ShiftTypeCandidate[] = shiftTypesRaw.map((s) => ({ id: s.id, siteId: s.siteId, code: s.code, timeSlot: shiftTypeTimeSlot(s.startTime, s.endTime) }));

  const [guardsRaw, staffNumbersRaw, phonesRaw] = await Promise.all([
    tx.guard.findMany({ select: { id: true, nameZh: true, tel: true, staffNo: true, staffNoMw: true } }),
    tx.guardStaffNumber.findMany({ select: { number: true, guardId: true, status: true } }),
    tx.guardPhone.findMany({ select: { guardId: true, tel: true } }),
  ]);
  const guardIndex = buildGuardMatchIndex({ guards: guardsRaw, staffNumbers: staffNumbersRaw, phones: phonesRaw });

  let unmatchedGuardCount = 0;
  let ambiguousGuardCount = 0;
  let unmatchedShiftTypeCount = 0;
  let ambiguousShiftTypeCount = 0;
  let unmatchedBrokerCount = 0;
  let outOfMonthCount = 0;
  let unmatchedSubSiteCount = 0;
  let staleStaffNoCount = 0;
  let staffNoMismatchCount = 0;
  // 驗收 2026-09-23：python 版（extract.py EXPECTED_YEAR_MONTH）會將「格仔
  // 日期唔係呢個月」逐格列入 unparsed 俾人覆核——移植漏咗。上載揀錯月份
  // （例如 8 月更表揀咗 9 月）或者更表夾住上／下月日子，都要明確警告。
  const monthPrefix = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-`;
  const rows: Prisma.RosterUploadRowCreateManyInput[] = [];

  for (const r of parseResult.rows) {
    const brokerId = matchBroker(r.brokerCodeRaw, brokers);
    if (r.brokerCodeRaw && !brokerId) unmatchedBrokerCount += 1;

    // Phase B-0 第 3 項：先決定呢行「解析後實際盤」——冇子盤嘅上載（絕
    // 大多數）同上載本身嘅 site_id 一致；有子盤而且呢行有 sub_site_name
    // 就用嚟對返個子盤；有子盤但對唔到就 null（唔准估）。
    let effectiveSiteId = resolvedSiteId;
    const warnings = [...r.warnings];
    if (resolvedSiteId && childSites.length > 0 && r.subSiteName) {
      const childId = matchSite(r.subSiteName, childSites);
      if (childId) {
        effectiveSiteId = childId;
      } else {
        effectiveSiteId = null;
        unmatchedSubSiteCount += 1;
        warnings.push(`子盤「${r.subSiteName}」對唔到呢個盤底下嘅子盤，更種配對留空，人手覆核`);
      }
    }

    const shiftTypeMatch = matchShiftType(r.rawCode, r.codeKind, effectiveSiteId, r.timeRaw, shiftTypes);
    const guardResult = matchGuard({ staffNoRaw: r.staffNoRaw, nameRaw: r.nameRaw, telRaw: r.telRaw }, guardIndex);
    if (guardResult.guardMatch === "unmatched") unmatchedGuardCount += 1;
    if (guardResult.guardMatch === "ambiguous") ambiguousGuardCount += 1;

    if (!r.workDate.startsWith(monthPrefix)) {
      outOfMonthCount += 1;
      warnings.push(`格仔日期 ${r.workDate} 唔係上載月份（${monthPrefix.slice(0, 7)}），人手覆核`);
    }
    if (guardResult.guardMatch === "unmatched") warnings.push("安員配對唔到（staff_no/姓名/電話都對唔上現有安員名冊）");
    if (guardResult.guardMatch === "ambiguous") warnings.push("安員配對到多過一個候選，人手覆核");
    // Phase B-0 第 4 項：(a)(b) 兩類細分警告——「二揀一」揀咗淨係加
    // warnings 唔改 `guard_match` enum（見 match.ts GuardMatchResult 頂
    // 註解解釋點解）。兩個 flag 唔互斥都可以同時出現（例如檔案工號完全
    // 對唔到、靠姓名配到，同時嗰個人自己另一個 scheme 有已取消號—— 但
    // matchedViaFormerStaffNo 淨係喺「真係靠 staff_no 命中」先會 true，
    // 同 staffNoMismatch 邏輯上互斥，唔會同一行一齊出現）。
    if (guardResult.matchedViaFormerStaffNo) {
      staleStaffNoCount += 1;
      warnings.push("用已取消舊號配對");
    }
    if (guardResult.staffNoMismatch && guardResult.guardId) {
      staffNoMismatchCount += 1;
      const systemStaffNo = guardIndex.staffNoByGuardId.get(guardResult.guardId) ?? "（未有工號）";
      warnings.push(`檔案工號 ${r.staffNoRaw} 同系統工號 ${systemStaffNo} 唔一致`);
    }
    if (shiftTypeMatch.ambiguous) {
      ambiguousShiftTypeCount += 1;
      const candidateList = shiftTypeMatch.candidateTimeSlots?.join("、") ?? "";
      warnings.push(`更別配對到多過一個候選（時段：${candidateList}），人手覆核`);
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
      resolvedSiteId: effectiveSiteId,
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
    ambiguousShiftTypeCount,
    unmatchedBrokerCount,
    outOfMonthCount,
    mergedExpandedCount: parseResult.mergedExpandedCount,
    unmatchedSubSiteCount,
    staleStaffNoCount,
    staffNoMismatchCount,
    warnings: outOfMonthCount
      ? [`有 ${outOfMonthCount} 格日期唔係上載月份（${monthPrefix.slice(0, 7)}）——檢查係咪揀錯月份`, ...parseResult.warnings]
      : parseResult.warnings,
  };
  return { rows, summary };
}

/** 同盤同月「呢個月份分組」（active＋superseded 全部）嘅 where——site_id
 * 已解到就用 site_id，未解到就用 site_name_raw（trim）暫代。Phase B-0
 * 第 5(b) 項嘅檔名撞名檢查要睇**全部**版本（唔限 active），所以由
 * `versionGroupWhere()` 抽走 `status` 條件做返呢個共用底。 */
function monthGroupWhere(siteId: string | null, siteNameRaw: string, month: Date) {
  return siteId ? { siteId, month } : { siteId: null, siteNameRaw: siteNameRaw.trim(), month };
}

/** 同盤同月「版本序列」（淨係 active，唔包 superseded）嘅 where——俾
 * supersede／版本遞增邏輯用。 */
function versionGroupWhere(siteId: string | null, siteNameRaw: string, month: Date) {
  return { ...monthGroupWhere(siteId, siteNameRaw, month), status: { not: "superseded" as const } };
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

    // Phase B-0 第 5(b) 項（老闆 2026-09-23 追加答）：更新檔嘅檔名一定要
    // 同呢個盤同月「任何現有版本」（active 或 superseded）唔同——同名一
    // 律 400 拒絕，唔存底、唔開版本。喺 lock 入面做，避免兩個並發上載
    // 撞同一個檔名都各自過檢查。
    const allVersionsSameGroup = await tx.rosterUpload.findMany({ where: monthGroupWhere(resolvedSiteId, siteNameRaw, month), select: { fileName: true } });
    const newNameNorm = input.fileName.trim().toLowerCase();
    if (allVersionsSameGroup.some((u) => u.fileName.trim().toLowerCase() === newNameNorm)) {
      throw BadRequest("更新檔嘅檔名必須同舊版唔同，請改檔名再上載");
    }

    const groupWhere = versionGroupWhere(resolvedSiteId, siteNameRaw, month);
    const previous = await tx.rosterUpload.findMany({ where: groupWhere, select: { id: true, version: true, fileSha256: true } });
    const nextVersion = previous.length ? Math.max(...previous.map((p) => p.version)) + 1 : 1;
    if (previous.length) {
      await tx.rosterUpload.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { status: "superseded" } });
    }

    // Phase B-0 第 5(a) 項：同一檔（同 SHA-256）重複上載——出提示，唔擋
    // （老闆 2026-09-23 答）。比對即將被取代嗰批（`previous`，通常最多
    // 一個 active）。
    const duplicateMatch = previous.find((p) => p.fileSha256 === sha256) ?? null;

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

    return { upload: finalUpload, supersededIds: previous.map((p) => p.id), parseResult, duplicateOfVersion: duplicateMatch?.version ?? null };
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
      where: monthGroupWhere(siteId, upload.siteNameRaw, upload.month),
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
