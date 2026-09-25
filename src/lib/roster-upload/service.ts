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
import { monthStart, assertMonthNotLocked } from "@/lib/month-lock";
import { BadRequest, Conflict } from "@/lib/api/errors";
import { writeAuditTx } from "@/lib/audit";
import { parseRosterWorkbook, type ParseResult, type ParsedCellRow } from "./parse";
import { shiftTypeTimeSlot } from "./time-range";
import { AMBIGUOUS_SUBSITE_WARNING_PREFIX } from "./reconcile";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import {
  matchSite,
  matchBroker,
  matchShiftType,
  matchGuard,
  buildGuardMatchIndex,
  resolveRosterUploadSite,
  type SiteCandidate,
  type BrokerCandidate,
  type ShiftTypeCandidate,
  type RosterUploadSiteResolution,
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
  /** 補丁（§17.7 未修第一項）：靠 rank_raw 第三層收窄先至配到更別嘅格
   * 數（time_raw 收窄之後仲夾住多過一個候選，用 rank 先至剩返一個）。 */
  rankNarrowedCount: number;
  // WP-GUARD-FIX 第二輪（老闆 2026-09-25 更正根因）：B1-8「未寫子盤」
  // warning 原本對**冇子盤欄**嘅檔案格式（例如 HKU座頭 standard
  // layout）都會逐行出，令會計以為成份檔都要逐行覆核——而家淨係「真係
  // 有子盤欄（citybus，或者呢個上載本身 parse 到 sub_site_names）而且
  // 嗰行冇寫」先算，加返三層推斷（見 `matchRowsAndSummarize()` 大註解）：
  subSiteInferredFromFileCount: number; // 同檔其他行嘅子盤淨係一種，自動填
  subSiteInferredFromHistoryCount: number; // 最近 3 個月嗰個安員喺呢個盤嘅子盤出更紀錄淨係一個，自動填
  subSiteNeedsHumanCount: number; // 歷史候選多過一個，留 null 交人手（對數頁 unresolved）
  warnings: string[];
}

/** WP-GUARD-FIX 驗收（Opus 5.5）：reparse 前後對返「同一格」嘅 key——
 * 檔案 bytes 唔變，`parseRosterWorkbook()` 係決定性嘅，(row_index,
 * work_date, raw_code, staff_no_raw, name_raw) 足夠分辨同一格（加埋姓名／
 * 工號係防多 sheet 同 row_index 撞）。 */
function manualSiteKey(r: { rowIndex: number; workDate: string | Date; rawCode: string; staffNoRaw: string | null; nameRaw: string | null }): string {
  const wd = typeof r.workDate === "string" ? r.workDate : r.workDate.toISOString().slice(0, 10);
  return [r.rowIndex, wd, r.rawCode, r.staffNoRaw ?? "", (r.nameRaw ?? "").trim()].join("|");
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
  // WP-UPLOAD-AUTOFIX 個案 1：`resolveRosterUploadSite()` 嘅結果——
  // `matchedViaFileKey`/`fileKeyMatchedKey` 用嚟逐行加「由檔名鍵對盤」
  // warning，`parentNoSubSiteWarning` 用嚟加返個頂層安全網警告（見
  // match.ts `resolveRosterUploadSite()` 註解）。冇傳＝行為同之前一樣
  // （`reparseRosterUpload()` 已經人手指定 site_id 嗰種情況唔使呢層）。
  siteMatch?: Pick<RosterUploadSiteResolution, "matchedViaFileKey" | "fileKeyMatchedKey" | "parentNoSubSiteWarning">,
  // WP-GUARD-FIX 驗收（Opus 5.5）：reparse 前對數頁人手指定過嘅子盤
  // （`resolved_site_manual=true`），key 見 `manualSiteKey()`——命中就用
  // 返人手決定，唔行三層推斷（唔俾 reparse 覆蓋人手決定）。
  manualSiteOverrides?: ReadonlyMap<string, string>,
): Promise<{ rows: Prisma.RosterUploadRowCreateManyInput[]; summary: RosterUploadParseSummary | null }> {
  if (!parseResult.ok) return { rows: [], summary: null };

  // Phase B-0 第 3 項：呢個上載掛嘅盤如果有子盤（`sites.parent_site_id`
  // 指返嚟），逐行用 `sub_site_name`（同 aliases）對返個子盤；更別配對
  // 要跟子盤嘅 shift_types 範圍，唔跟上載本身嘅 site_id。
  const childSitesRaw = resolvedSiteId ? await tx.site.findMany({ where: { parentSiteId: resolvedSiteId }, select: { id: true, canonicalName: true, aliases: true } }) : [];
  const childSites: SiteCandidate[] = childSitesRaw.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases }));

  const shiftTypeSiteIds = resolvedSiteId ? [resolvedSiteId, ...childSites.map((c) => c.id)] : [];
  const shiftTypesRaw = shiftTypeSiteIds.length
    ? await tx.shiftType.findMany({ where: { siteId: { in: shiftTypeSiteIds }, voidedAt: null }, select: { id: true, siteId: true, code: true, startTime: true, endTime: true, billingGroup: true } })
    : [];
  // Phase B-0 第 2 項：candidates 加埋 `timeSlot`（由 start_time/end_time
  // 算），`matchShiftType()` 多過一個候選嗰陣會用嚟同 `timeRaw` 收窄。
  // 補丁（§17.7 未修第一項）：加埋 `billingGroup`，時段收窄唔到（候選
  // 時段完全一樣，例如數碼港 CP5「D」）嗰陣俾 rank_raw 第三層收窄用。
  const shiftTypes: ShiftTypeCandidate[] = shiftTypesRaw.map((s) => ({ id: s.id, siteId: s.siteId, code: s.code, timeSlot: shiftTypeTimeSlot(s.startTime, s.endTime), billingGroup: s.billingGroup }));

  const [guardsRaw, staffNumbersRaw, phonesRaw] = await Promise.all([
    tx.guard.findMany({ select: { id: true, nameZh: true, tel: true, staffNo: true, staffNoMw: true, nameAliases: true } }),
    tx.guardStaffNumber.findMany({ select: { number: true, guardId: true, status: true } }),
    tx.guardPhone.findMany({ select: { guardId: true, tel: true } }),
  ]);
  const guardIndex = buildGuardMatchIndex({ guards: guardsRaw, staffNumbers: staffNumbersRaw, phones: phonesRaw });

  // ---------------------------------------------------------------------
  // WP-GUARD-FIX 第二輪（老闆 2026-09-25 更正根因）：對數頁大量「未寫子
  // 盤，歸母盤，人手覆核」——真正根因唔係 python/TS forward-fill 唔一致
  // （查證過，兩邊行為一致），係 B-0 §15.5 呢條 warning 對**檔案格式根本
  // 冇子盤欄**嘅母盤上載（例如 HKU座頭：standard layout，得一個子盤
  // 「HKU 醫學院」，醫學院自己有獨立更表檔，HKU座頭自己嗰份檔案本身
  // 冇 sub_site 欄可以寫）都逐行出，會計以為要逐條覆核。
  //
  // 修法分三層：
  //   1. warning 收窄——淨係「呢個上載嘅檔案格式真係有子盤欄（citybus
  //      layout，或者呢個上載本身 parse 到 subSiteNames 非空）」而且
  //      呢行冇寫，先算「漏寫」；冇子盤欄嘅檔案格式（好似 HKU座頭）淨
  //      係靜靜歸母盤，唔出 warning（回復 B-0 §15.5 原語意）。
  //   2. 歷史推斷（淨係喺 (1) 判斷「真係漏寫」嘅情況先做）：
  //      (a) 同一個上載、同一個安員嘅**其他（物理）行**（同一個人喺一
  //          個檔案入面可能出現喺唔止一個 Excel 行——例如唔同 block/
  //          唔同星期各自一行；一個物理行本身逐日展開嘅 `ParsedCellRow`
  //          全部共用同一個 `rowIndex`、亦即成粒 subSiteName 一定一致，
  //          所以「其他行」要用「身份」（staff_no_raw 正規化、冇就用
  //          name_raw）分組，唔可以用 `rowIndex`——同一 `rowIndex` 入面
  //          唔可能出現多過一種 subSiteName，用 `rowIndex` 分組會令呢
  //          層推斷變死code）——身份嘅其他物理行已經寫咗子盤，而且淨係
  //          一種 → 自動填（「同檔其他行推斷」）。
  //      (b) 同檔搵唔到就查嗰個安員最近 3 個月喺呢個母盤子盤嘅
  //          `shift_records`（`status != cancelled`）——淨係一個子盤
  //          出過更 → 自動填（「歷史推斷」）；零個 → 跌返 (1) 嘅「未寫
  //          子盤，歸母盤」warning；多過一個 → 留 `resolved_site_id=
  //          null`＋warning 列候選子盤名，交對數頁人手揀（見
  //          reconcile.ts 點分辨呢種 null 同「舊上載未 reparse」嘅 null）。
  //   3. 對數頁批量指定／歸母盤確認——見
  //      `src/lib/roster-upload/reconcile.ts`／`bulk-resolve-site.ts`。
  const hasSubSiteColumn = childSites.length > 0 && (parseResult.sheets.some((s) => s.layouts.includes("citybus")) || parseResult.subSiteNames.length > 0);

  // Pre-pass 1：逐格 guardResult 抽出嚟先計一次（主 loop 直接攞現成，
  // 歷史推斷都要用到 guardId，唔使計多次）。
  const guardResults = parseResult.rows.map((r) => matchGuard({ staffNoRaw: r.staffNoRaw, nameRaw: r.nameRaw, telRaw: r.telRaw }, guardIndex));

  // 「身份」key——staff_no_raw 正規化就用嚟分（同一個號一定係同一個
  // 人），冇就用 name_raw（trim）。同 scripts/guard-fix/build-guard-fix-
  // plan.ts 分組邏輯一致精神。
  const identityKeyOf = (r: ParsedCellRow): string => {
    const sn = r.staffNoRaw ? normalizeStaffNumber(r.staffNoRaw) : null;
    return sn ? `sn:${sn}` : `name:${(r.nameRaw ?? "").trim()}`;
  };

  // Pre-pass 2：同檔其他行推斷——逐個身份收集已寫嘅子盤名。
  const subSiteNamesByIdentity = new Map<string, Set<string>>();
  if (hasSubSiteColumn) {
    for (const r of parseResult.rows) {
      if (!r.subSiteName) continue;
      const key = identityKeyOf(r);
      if (!subSiteNamesByIdentity.has(key)) subSiteNamesByIdentity.set(key, new Set());
      subSiteNamesByIdentity.get(key)!.add(r.subSiteName);
    }
  }
  const sameFileInferredByIdentity = new Map<string, string>();
  for (const [key, names] of subSiteNamesByIdentity) {
    if (names.size === 1) sameFileInferredByIdentity.set(key, [...names][0]!);
  }

  // Pre-pass 3：歷史推斷——淨係「真係漏寫」（有子盤欄、呢行冇寫、同檔
  // 都冧唔到）而且呢行有配到 guard 先查，逐個身份淨係查一次。
  const historyGuardIdByIdentity = new Map<string, string>();
  if (hasSubSiteColumn) {
    for (let i = 0; i < parseResult.rows.length; i++) {
      const r = parseResult.rows[i]!;
      const key = identityKeyOf(r);
      if (r.subSiteName || sameFileInferredByIdentity.has(key) || historyGuardIdByIdentity.has(key)) continue;
      const guardId = guardResults[i]!.guardId;
      if (guardId) historyGuardIdByIdentity.set(key, guardId);
    }
  }
  const threeMonthsAgo = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 3, 1));
  const historyInferredByIdentity = new Map<string, string>(); // identityKey -> siteId
  const historyCandidateNamesByIdentity = new Map<string, string[]>(); // identityKey -> 候選子盤名（多過一個）
  if (historyGuardIdByIdentity.size > 0) {
    const uniqueGuardIds = [...new Set(historyGuardIdByIdentity.values())];
    const historyRows = await tx.shiftRecord.findMany({
      where: { guardId: { in: uniqueGuardIds }, siteId: { in: childSites.map((c) => c.id) }, workDate: { gte: threeMonthsAgo, lt: month }, status: { not: "cancelled" } },
      select: { guardId: true, siteId: true },
    });
    const siteIdsByGuard = new Map<string, Set<string>>();
    for (const hr of historyRows) {
      if (!siteIdsByGuard.has(hr.guardId)) siteIdsByGuard.set(hr.guardId, new Set());
      siteIdsByGuard.get(hr.guardId)!.add(hr.siteId);
    }
    const childNameById = new Map(childSites.map((c) => [c.id, c.canonicalName]));
    for (const [key, guardId] of historyGuardIdByIdentity) {
      const siteIds = [...(siteIdsByGuard.get(guardId) ?? [])];
      if (siteIds.length === 1) historyInferredByIdentity.set(key, siteIds[0]!);
      else if (siteIds.length > 1) historyCandidateNamesByIdentity.set(key, siteIds.map((id) => childNameById.get(id) ?? id));
    }
  }

  let unmatchedGuardCount = 0;
  let ambiguousGuardCount = 0;
  let unmatchedShiftTypeCount = 0;
  let ambiguousShiftTypeCount = 0;
  let unmatchedBrokerCount = 0;
  let outOfMonthCount = 0;
  let unmatchedSubSiteCount = 0;
  let staleStaffNoCount = 0;
  let staffNoMismatchCount = 0;
  let rankNarrowedCount = 0;
  let subSiteInferredFromFileCount = 0;
  let subSiteInferredFromHistoryCount = 0;
  let subSiteNeedsHumanCount = 0;
  // 驗收 2026-09-23：python 版（extract.py EXPECTED_YEAR_MONTH）會將「格仔
  // 日期唔係呢個月」逐格列入 unparsed 俾人覆核——移植漏咗。上載揀錯月份
  // （例如 8 月更表揀咗 9 月）或者更表夾住上／下月日子，都要明確警告。
  const monthPrefix = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-`;
  const rows: Prisma.RosterUploadRowCreateManyInput[] = [];

  for (let rowPos = 0; rowPos < parseResult.rows.length; rowPos++) {
    const r = parseResult.rows[rowPos]!;
    const brokerId = matchBroker(r.brokerCodeRaw, brokers);
    if (r.brokerCodeRaw && !brokerId) unmatchedBrokerCount += 1;

    // Phase B-0 第 3 項：先決定呢行「解析後實際盤」——冇子盤嘅上載（絕
    // 大多數）同上載本身嘅 site_id 一致；有子盤而且呢行有 sub_site_name
    // 就用嚟對返個子盤；有子盤但對唔到就 null（唔准估）。
    let effectiveSiteId = resolvedSiteId;
    let resolvedSiteManual = false;
    const warnings = [...r.warnings];
    // WP-UPLOAD-AUTOFIX 個案 1：呢個上載嘅盤係靠檔名鍵（`roster_file_
    // keys`）對到嘅——逐行留痕「由邊條鍵對盤」，等會計覆核（同「子盤對
    // 唔到」呢類 warning 一樣係逐行加，唔淨係頂層一句）。
    if (siteMatch?.matchedViaFileKey && siteMatch.fileKeyMatchedKey) {
      warnings.push(`由檔名鍵「${siteMatch.fileKeyMatchedKey}」對盤`);
    }
    if (resolvedSiteId && childSites.length > 0 && r.subSiteName) {
      const childId = matchSite(r.subSiteName, childSites);
      if (childId) {
        effectiveSiteId = childId;
      } else {
        effectiveSiteId = null;
        unmatchedSubSiteCount += 1;
        warnings.push(`子盤「${r.subSiteName}」對唔到呢個盤底下嘅子盤，更種配對留空，人手覆核`);
      }
    } else if (resolvedSiteId && childSites.length > 0 && !r.subSiteName) {
      // WP-GUARD-FIX 第二輪：三層推斷（見上面大註解）。
      const identityKey = identityKeyOf(r);
      const manualSiteId = manualSiteOverrides?.get(manualSiteKey(r));
      if (manualSiteId && (manualSiteId === resolvedSiteId || childSites.some((c) => c.id === manualSiteId))) {
        // WP-GUARD-FIX 驗收（Opus 5.5）：人手指定過——保留，唔再推斷。
        effectiveSiteId = manualSiteId;
        resolvedSiteManual = true;
        warnings.push("子盤人手指定（重新解析保留）");
      } else if (sameFileInferredByIdentity.has(identityKey)) {
        const inferredName = sameFileInferredByIdentity.get(identityKey)!;
        const childId = matchSite(inferredName, childSites);
        if (childId) {
          effectiveSiteId = childId;
          subSiteInferredFromFileCount += 1;
          warnings.push(`子盤由同檔其他行推斷：${inferredName}`);
        } else {
          // 驗收（Opus 5.5）：同檔其他行寫嘅子盤本身對唔到——唔可以靜靜
          // 歸母盤冇任何 warning。
          warnings.push("未寫子盤，歸母盤，人手覆核係咪漏寫子盤");
        }
      } else if (historyInferredByIdentity.has(identityKey)) {
        effectiveSiteId = historyInferredByIdentity.get(identityKey)!;
        subSiteInferredFromHistoryCount += 1;
        warnings.push("子盤由歷史推斷（最近 3 個月呢個安員喺呢個盤底下子盤有出更紀錄）");
      } else if (historyCandidateNamesByIdentity.has(identityKey)) {
        // 多過一個候選——留 null，唔准估，交對數頁人手揀（呢種 null 同
        // 「舊上載未 reparse」嘅 null 點分辨見 reconcile.ts）。
        effectiveSiteId = null;
        subSiteNeedsHumanCount += 1;
        warnings.push(`${AMBIGUOUS_SUBSITE_WARNING_PREFIX}多過一個（${historyCandidateNamesByIdentity.get(identityKey)!.join("、")}），人手覆核並指定子盤`);
      } else if (hasSubSiteColumn) {
        // 真係有子盤欄、呢行冇寫、同檔／歷史都冧唔到——先出「漏寫」
        // warning；effectiveSiteId 保持=母盤（唔擋寫入）。
        warnings.push("未寫子盤，歸母盤，人手覆核係咪漏寫子盤");
      }
      // hasSubSiteColumn=false（呢個盤嘅檔案格式根本冇子盤欄，例如
      // HKU座頭 standard layout）——靜靜歸母盤，唔出 warning（回復 B-0
      // §15.5 原語意）。
    }

    const shiftTypeMatch = matchShiftType(r.rawCode, r.codeKind, effectiveSiteId, r.timeRaw, shiftTypes, r.rankRaw);
    const guardResult = guardResults[rowPos]!;
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
    // B1-8 第 3 項（B-0 驗收留低）：檔案工號命中咗一個人、但呢行姓名同
    // 嗰個人唔夾——「唔准配」（match.ts 已經回 guardId=null、ambiguous），
    // 呢度淨係加 warning（同「工號唔一致」warning 一樣係工號原文，交俾
    // [id]/route.ts redactStaffNoWarnings() 一齊遮）。
    if (guardResult.staffNoBelongsToOther) {
      staffNoMismatchCount += 1;
      warnings.push(`檔案工號 ${r.staffNoRaw} 屬另一人（姓名對唔上），唔會自動配對，人手覆核`);
    }
    // WP-GUARD-FIX（老闆 2026-09-25 要求）：靠別名（`guards.name_aliases`）
    // 配到——留痕俾會計知呢個人個本名同更表寫嘅唔同，唔係純粹信賴巧合。
    if (guardResult.matchedViaAlias) {
      warnings.push("由別名配對（更表姓名同系統本名唔同，見安員資料「更表用名」）");
    }
    if (shiftTypeMatch.matchedViaRank) rankNarrowedCount += 1;
    if (shiftTypeMatch.ambiguous) {
      ambiguousShiftTypeCount += 1;
      const candidateList = shiftTypeMatch.candidateTimeSlots?.join("、") ?? "";
      // 補丁（§17.7 未修第一項）：rankAttempted=true 代表時段收窄唔夠、
      // 已經試過用 rank_raw 收窄但仲係唔夠（收窄完剩 0 個或者多過一
      // 個）——講明畀會計，唔係淨係睇咗時段就放棄。
      const rankNote = shiftTypeMatch.rankAttempted ? "，已用 rank 收窄但仍未夠" : "";
      warnings.push(`更別配對到多過一個候選（時段：${candidateList}${rankNote}），人手覆核`);
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
      resolvedSiteManual,
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
    rankNarrowedCount,
    subSiteInferredFromFileCount,
    subSiteInferredFromHistoryCount,
    subSiteNeedsHumanCount,
    warnings: [
      // WP-UPLOAD-AUTOFIX 個案 1：母盤安全網觸發——擺最前，會計最先睇到
      // 「呢個上載未配對盤，要人手指定」。
      ...(siteMatch?.parentNoSubSiteWarning ? [siteMatch.parentNoSubSiteWarning] : []),
      ...(outOfMonthCount ? [`有 ${outOfMonthCount} 格日期唔係上載月份（${monthPrefix.slice(0, 7)}）——檢查係咪揀錯月份`] : []),
      ...parseResult.warnings,
    ],
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
 * supersede／版本遞增邏輯用。WP-UPLOAD-VOID：`voided` 一樣要抽走——
 * 一個已作廢嘅版本唔算「active」，新上載唔應該將佢由 voided 變返
 * superseded（會抹走作廢記錄），version 遞增亦唔應該淨係睇 active
 * 嗰批（見 `monthGroupWhere()` 先算全部版本嘅 max version）。 */
function versionGroupWhere(siteId: string | null, siteNameRaw: string, month: Date) {
  return { ...monthGroupWhere(siteId, siteNameRaw, month), status: { notIn: ["superseded" as const, "voided" as const] } };
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
    prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true, parentSiteId: true, rosterFileKeys: true } }),
    prisma.broker.findMany({ select: { id: true, code: true, aliases: true } }),
  ]);
  const sites: SiteCandidate[] = sitesRaw.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases, parentSiteId: s.parentSiteId, rosterFileKeys: s.rosterFileKeys }));
  const brokers: BrokerCandidate[] = brokersRaw.map((b) => ({ id: b.id, code: b.code, aliases: b.aliases }));

  const siteNameRaw = (parseResult.ok ? parseResult.siteRaw : null) ?? input.fileName;
  // WP-UPLOAD-AUTOFIX 個案 1：配盤優先次序見 match.ts `resolveRosterUploadSite()`
  // 註解——siteIdHint（呢個 API 嘅人手指定）> 檔名鍵 > 檔內盤名（有安全網）。
  const siteMatch = resolveRosterUploadSite(input.fileName, input.siteIdHint, parseResult.ok ? parseResult.siteRaw : null, parseResult.ok ? parseResult.subSiteNames : [], sites);
  const resolvedSiteId = siteMatch.siteId;

  return prisma.$transaction(async (tx) => {
    await lockVersionGroup(tx, resolvedSiteId, siteNameRaw, month);

    // Phase B-0 第 5(b) 項（老闆 2026-09-23 追加答）：更新檔嘅檔名一定要
    // 同呢個盤同月「任何現有版本」（active 或 superseded）唔同——同名一
    // 律 400 拒絕，唔存底、唔開版本。喺 lock 入面做，避免兩個並發上載
    // 撞同一個檔名都各自過檢查。
    const allVersionsSameGroup = await tx.rosterUpload.findMany({ where: monthGroupWhere(resolvedSiteId, siteNameRaw, month), select: { fileName: true, fileSha256: true, version: true } });
    const newNameNorm = input.fileName.trim().toLowerCase();
    if (allVersionsSameGroup.some((u) => u.fileName.trim().toLowerCase() === newNameNorm)) {
      throw BadRequest("更新檔嘅檔名必須同舊版唔同，請改檔名再上載");
    }

    const groupWhere = versionGroupWhere(resolvedSiteId, siteNameRaw, month);
    const previous = await tx.rosterUpload.findMany({ where: groupWhere, select: { id: true, version: true, fileSha256: true } });
    // WP-UPLOAD-VOID：版本號要跟**全部**歷史（含 superseded／voided）先
    // 唔會撞號——例如作廢咗 v2、v1 由 superseded 回復做 active 之後再上
    // 載，`previous`（active-only）嘅 max 淨係 1，但 v2 個版本號已經俾
    // 個已作廢嘅 upload 佔用咗，下一版一定要係 v3 先唔會同 voided 嘅 v2 撞號。
    const nextVersion = allVersionsSameGroup.length ? Math.max(...allVersionsSameGroup.map((p) => p.version)) + 1 : 1;
    if (previous.length) {
      await tx.rosterUpload.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { status: "superseded" } });
    }

    // Phase B-0 第 5(a) 項：同一檔（同 SHA-256）重複上載——出提示，唔擋
    // （老闆 2026-09-23 答）。驗收 2026-09-23：比對範圍由「即將被取代嗰批
    // active」擴闊到呢個盤同月**全部**版本（含 superseded）——v1→v2→再上
    // 載返 v1 個檔（改咗名）之前唔會出提示。撞多個就報最新嗰個版本。
    const duplicateMatch =
      allVersionsSameGroup.filter((p) => p.fileSha256 === sha256).sort((a, b) => b.version - a.version)[0] ?? null;

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

    const { rows, summary } = await matchRowsAndSummarize(tx, upload.id, resolvedSiteId, parseResult, brokers, month, siteMatch);
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
export async function reparseRosterUpload(
  uploadId: string,
  // WP-GUARD-FIX 驗收（Opus 5.5）：`txTimeoutMs`——scripts 經 Zeabur 公開
  // port 對正式站 reparse 嗰陣，一個大上載（啟航1331 千幾格）喺預設 5 秒
  // interactive transaction timeout 入面好易 P2028；web route 唔傳，維持
  // 預設。
  opts: { autoResolveSite?: boolean; txTimeoutMs?: number } = {},
): Promise<ParseResult> {
  const autoResolveSite = opts.autoResolveSite ?? true;
  const existing = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: uploadId } });
  const buffer = Buffer.from(existing.fileBytes);
  const parseResult = await parseRosterWorkbook(buffer, existing.fileName);

  const [sitesRaw, brokersRaw] = await Promise.all([
    prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true, parentSiteId: true, rosterFileKeys: true } }),
    prisma.broker.findMany({ select: { id: true, code: true, aliases: true } }),
  ]);
  const sites: SiteCandidate[] = sitesRaw.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases, parentSiteId: s.parentSiteId, rosterFileKeys: s.rosterFileKeys }));
  const brokers: BrokerCandidate[] = brokersRaw.map((b) => ({ id: b.id, code: b.code, aliases: b.aliases }));
  // 驗收 2026-09-23：PATCH `{site_id:null}`（人手清返未指定）之後唔好即刻
  // 又用盤名自動配返，否則「清返」永遠清唔到。WP-UPLOAD-AUTOFIX 個案 1：
  // 自動配對（檔名鍵／檔內盤名＋安全網）一樣經 `resolveRosterUploadSite()`
  // （`siteIdHint` 傳 null——`existing.siteId` 已經喺呢個 `??` 之前處理咗
  // 「人手指定」呢個優先層）。
  const siteMatch = existing.siteId
    ? undefined
    : autoResolveSite && parseResult.ok
      ? resolveRosterUploadSite(existing.fileName, null, parseResult.siteRaw, parseResult.subSiteNames, sites)
      : undefined;
  const resolvedSiteId = existing.siteId ?? siteMatch?.siteId ?? null;
  // 驗收 2026-09-23：已被取代（superseded）／已確認（confirmed）嘅版本重新
  // 解析之後**唔准**變返 parsed——之前會令同盤同月出現兩個 active 版本。
  const keepStatus = existing.status === "superseded" || existing.status === "confirmed";

  await prisma.$transaction(async (tx) => {
    // WP-GUARD-FIX 驗收（Opus 5.5）：刪之前記低人手指定過嘅子盤（對數頁
    // 「批量指定子盤／全部歸母盤確認」），重建 rows 嗰陣用返——唔俾
    // reparse（三層推斷）覆蓋人手決定。上載個盤變咗（人手改 site_id）就
    // 唔保留（`matchRowsAndSummarize()` 會驗證 site 仍然係母盤／其子盤）。
    const manualRows = await tx.rosterUploadRow.findMany({
      where: { uploadId, resolvedSiteManual: true, resolvedSiteId: { not: null } },
      select: { rowIndex: true, workDate: true, rawCode: true, staffNoRaw: true, nameRaw: true, resolvedSiteId: true },
    });
    const manualSiteOverrides = new Map(manualRows.map((m) => [manualSiteKey(m), m.resolvedSiteId!]));
    await tx.rosterUploadRow.deleteMany({ where: { uploadId } });
    const { rows, summary } = await matchRowsAndSummarize(tx, uploadId, resolvedSiteId, parseResult, brokers, existing.month, siteMatch, manualSiteOverrides);
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
  }, opts.txTimeoutMs ? { timeout: opts.txTimeoutMs, maxWait: 30_000 } : undefined);

  return parseResult;
}

export interface BulkResolveSubSiteResult {
  updated: string[]; // rowId
  skipped: Array<{ rowId: string; reason: string }>;
}

/** WP-GUARD-FIX 第二輪（老闆 2026-09-25 要求）：對數頁批量指定子盤／
 * 全部歸母盤確認——淨係俾「三層推斷都冧唔到、留 `resolved_site_id=
 * null`」嗰批行用（`AMBIGUOUS_SUBSITE_WARNING_PREFIX` 呢個 marker，見
 * reconcile.ts）；`siteId=null` 代表「全部歸母盤確認」（用上載本身嘅
 * `site_id`），`siteId` 有值就要係呢個上載母盤嘅子盤。逐行重新
 * `matchShiftType()`（唔係成個 `reparseRosterUpload()`——淨係改咗嘅行
 * 唔應該連累其他行嘅配對結果重新計一次，亦唔會抹走呢個人手決定）。
 *
 * WP-GUARD-FIX 驗收（Opus 5.5）：人手決定寫 `resolved_site_manual=true`，
 * `reparseRosterUpload()` 重建 rows 嗰陣用 `manualSiteKey()` 對返同一格
 * 保留（之前冇呢個欄，一 reparse 人手決定就冇咗）。新上載版本（新檔案）
 * 唔會繼承——嗰個係另一份更表，要重新判斷。 */
export async function bulkResolveAmbiguousSubSite(params: {
  uploadId: string;
  rowIds: string[];
  siteId: string | null;
  actorUserId: string | null;
  ip: string | null;
}): Promise<BulkResolveSubSiteResult> {
  const upload = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: params.uploadId } });
  if (!upload.siteId) throw BadRequest("呢個上載未指定盤，請先指定盤先可以批量指定子盤");
  // WP-GUARD-FIX 驗收（Opus 5.5）：同 `applyReconcileDecisions()` 一致——
  // 淨係 parsed／confirmed 先可以改；鎖咗嘅月份一律拒（寫 permission_denied
  // audit）。之前漏咗鎖月檢查，已鎖月份仲改得到 roster_upload_rows。
  if (upload.status !== "parsed" && upload.status !== "confirmed") {
    throw BadRequest(`呢個上載狀態係「${upload.status}」，唔可以批量指定子盤（要 parsed 或 confirmed）`);
  }
  await assertMonthNotLocked({ workDate: upload.month, actorUserId: params.actorUserId, tableName: "roster_uploads", rowId: params.uploadId, ip: params.ip });
  const childSites = await prisma.site.findMany({ where: { parentSiteId: upload.siteId }, select: { id: true, canonicalName: true } });
  const targetSiteId = params.siteId ?? upload.siteId; // null＝全部歸母盤確認
  if (params.siteId && !childSites.some((c) => c.id === params.siteId)) {
    throw BadRequest("指定嘅盤唔係呢個上載母盤底下嘅子盤");
  }
  const targetShiftTypesRaw = await prisma.shiftType.findMany({ where: { siteId: targetSiteId, voidedAt: null }, select: { id: true, siteId: true, code: true, startTime: true, endTime: true, billingGroup: true } });
  const targetShiftTypes: ShiftTypeCandidate[] = targetShiftTypesRaw.map((s) => ({ id: s.id, siteId: s.siteId, code: s.code, timeSlot: shiftTypeTimeSlot(s.startTime, s.endTime), billingGroup: s.billingGroup }));

  const rows = await prisma.rosterUploadRow.findMany({ where: { id: { in: params.rowIds }, uploadId: params.uploadId } });
  const foundIds = new Set(rows.map((r) => r.id));
  const result: BulkResolveSubSiteResult = { updated: [], skipped: [] };
  for (const rowId of params.rowIds) {
    if (!foundIds.has(rowId)) result.skipped.push({ rowId, reason: "呢個上載搵唔到呢行" });
  }
  // 淨係俾「三層推斷都冧唔到、留咗 null」嗰批行用——防止用戶亂改其他
  // 已經配到盤嘅行（呢個掣淨係喺對數頁「子盤未定」呢一類行出現，呢度
  // 係結構性再驗證一次，唔淨係信賴前端冧咗邊行）。
  const eligible = rows.filter((r) => {
    const warningsArr = Array.isArray(r.warnings) ? (r.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [];
    const ok = !r.resolvedSiteId && !r.subSiteName && warningsArr.some((w) => w.startsWith(AMBIGUOUS_SUBSITE_WARNING_PREFIX));
    if (!ok) result.skipped.push({ rowId: r.id, reason: "呢行唔係「子盤未定」狀態，唔可以用呢個批量掣" });
    return ok;
  });
  if (eligible.length === 0) return result;

  await prisma.$transaction(async (tx) => {
    for (const row of eligible) {
      const shiftTypeMatch = matchShiftType(row.rawCode, row.codeKind, targetSiteId, row.timeRaw, targetShiftTypes, row.rankRaw);
      const existingWarnings = Array.isArray(row.warnings) ? (row.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [];
      const noteText = params.siteId ? `人手批量指定子盤：${childSites.find((c) => c.id === params.siteId)?.canonicalName ?? params.siteId}` : "人手批量確認歸母盤";
      const after = await tx.rosterUploadRow.update({
        where: { id: row.id },
        data: { resolvedSiteId: targetSiteId, resolvedSiteManual: true, shiftTypeId: shiftTypeMatch.id, warnings: [...existingWarnings, noteText] as Prisma.InputJsonValue },
      });
      await writeAuditTx(tx, { actorUserId: params.actorUserId, tableName: "roster_upload_rows", rowId: row.id, action: "update", before: row, after, ip: params.ip });
      result.updated.push(row.id);
    }
  });
  return result;
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

    // B1-8 第 1 項（B-0 驗收留低）：呢個上載轉咗去嘅目標（盤,月）組別如
    // 果已經有一個同名檔（active 或 superseded），同 POST（processRosterUpload）
    // 一致 400 拒絕——唔可以人手指定盤之後撞名。
    const targetGroupFiles = await tx.rosterUpload.findMany({
      where: { ...monthGroupWhere(siteId, upload.siteNameRaw, upload.month), id: { not: uploadId } },
      select: { fileName: true },
    });
    const newNameNorm = upload.fileName.trim().toLowerCase();
    if (targetGroupFiles.some((u) => u.fileName.trim().toLowerCase() === newNameNorm)) {
      throw BadRequest("呢個盤呢個月已經有同名檔案，請改檔名再上載，或者直接指定去嗰個現有上載");
    }

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

export interface VoidRosterUploadResult {
  upload: RosterUpload; // 作廢之後嘅完整 row（audit after 用）
  /** 作廢緊嗰個係 active 版本、而且同盤同月有較舊嘅 superseded 版本 →
   * 嗰個版本回復做 active，呢度係佢嘅 id／version（冇就 null）。 */
  revivedUploadId: string | null;
  revivedVersion: number | null;
}

/** WP-UPLOAD-VOID（老闆 2026-09-25 要求：正式站揀錯月份上載咗 8 月更
 * 表，UI 冇任何刪除／撤銷）：人手作廢一個上載記錄——唔 hard delete
 * （file_bytes／rows／reconcile_decisions 全部留底），淨係轉
 * `status='voided'`＋記低邊個/幾時/原因。
 *
 * 規則（見 route.ts 呼叫呢個之前做嘅 pre-check）：
 *   - `confirmed`（已對數確認寫入 shift_records）唔可以喺呢度作廢——
 *     會計要先去對數頁處理（apply_roster/keep_system/exception 逐項
 *     決定，唔可以一鍵作廢整個上載搞掂）。
 *   - 已經 `voided` 嘅唔可以再作廢一次。
 *   - `uploaded`／`parsed`／`parse_failed`／`superseded` 四種狀態都可以
 *     作廢（`superseded` 都得——等會計可以清走一啲舊歷史版本，同「唔
 *     hard delete」唔矛盾，淨係加個作廢標記）。
 *
 * 回復邏輯：淨係當「作廢緊嗰個上載本身仲係呢個（盤,月）版本序列嘅
 * active 版本」（即係話佢嘅 status 唔係 `superseded`）先會觸發——揾返
 * 同盤同月**最新**嗰個 `superseded` 版本，令佢重新成為 active。回復做
 * 咩狀態：如果嗰個版本本身有 `roster_upload_rows`（曾經解析成功）就
 * `parsed`；冇 rows 但 `parse_error` 有值（曾經解析失敗）就 `parse_
 * failed`；兩樣都冇（理論上唔會發生）保守當 `parsed`。呢個判斷用返
 * 已經存底嘅資料（rows 存唔存在、parse_error 存唔存在），冇加新欄——
 * `status` 呢個欄本身一路俾 supersede/void 蓋咗，冧唔返「俾取代之前
 * 嗰刻嘅真實狀態」，用 rows/parse_error 做返最貼近事實嘅判斷。
 *
 * 版本號**唔會**因為作廢/回復而重新編號——`processRosterUpload()` 嘅
 * `nextVersion` 計算已經改咗用全部歷史（含 voided）嘅 max，唔會撞號
 * （見嗰個函數嘅註解）。 */
export async function voidRosterUpload(params: { uploadId: string; reason: string; actorUserId: string; ip: string | null }): Promise<VoidRosterUploadResult> {
  // 同 reconcile-apply.ts `applyReconcileDecisions()` 一致嘅做法：狀態／
  // 鎖月檢查喺 transaction 之前做（`assertMonthNotLocked()` 自己用全域
  // `prisma` 寫 permission_denied audit，唔可以攞住 transaction 個
  // connection 一齊做）；transaction 入面攞 advisory lock 之後再撈多次
  // 最新狀態覆核一次（防止檢查完至開 transaction 呢段空隙撞另一個並發
  // 請求，例如兩個人同時作廢同一個上載）。
  const before = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: params.uploadId } });
  if (before.status === "confirmed") throw Conflict("呢個上載已經對數確認，要先去對數頁處理（keep_system/exception/apply_roster），先可以作廢");
  if (before.status === "voided") throw Conflict("呢個上載已經作廢");
  await assertMonthNotLocked({ workDate: before.month, actorUserId: params.actorUserId, tableName: "roster_uploads", rowId: params.uploadId, ip: params.ip });

  return prisma.$transaction(async (tx) => {
    await lockVersionGroup(tx, before.siteId, before.siteNameRaw, before.month);
    const current = await tx.rosterUpload.findUniqueOrThrow({ where: { id: params.uploadId } });
    if (current.status === "confirmed") throw Conflict("呢個上載已經對數確認，要先去對數頁處理（keep_system/exception/apply_roster），先可以作廢");
    if (current.status === "voided") throw Conflict("呢個上載已經作廢");

    const wasActive = current.status !== "superseded";

    const after = await tx.rosterUpload.update({
      where: { id: params.uploadId },
      data: { status: "voided", voidedAt: new Date(), voidedBy: params.actorUserId, voidReason: params.reason },
    });

    let revivedUploadId: string | null = null;
    let revivedVersion: number | null = null;
    if (wasActive) {
      const candidates = await tx.rosterUpload.findMany({
        where: { ...monthGroupWhere(before.siteId, before.siteNameRaw, before.month), status: "superseded" },
        orderBy: { version: "desc" },
        take: 1,
      });
      const revive = candidates[0];
      if (revive) {
        const rowCount = await tx.rosterUploadRow.count({ where: { uploadId: revive.id } });
        const revivedStatus: RosterUpload["status"] = rowCount > 0 ? "parsed" : revive.parseError ? "parse_failed" : "parsed";
        await tx.rosterUpload.update({ where: { id: revive.id }, data: { status: revivedStatus } });
        revivedUploadId = revive.id;
        revivedVersion = revive.version;
      }
    }

    await writeAuditTx(tx, {
      actorUserId: params.actorUserId,
      tableName: "roster_uploads",
      rowId: params.uploadId,
      action: "void",
      before: current,
      after: { ...after, void_reason: params.reason, revived_upload_id: revivedUploadId, revived_version: revivedVersion },
      ip: params.ip,
    });

    return { upload: after, revivedUploadId, revivedVersion };
  });
}
