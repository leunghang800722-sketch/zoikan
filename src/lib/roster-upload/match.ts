// WP-ROSTER-UPLOAD Phase A（§15.3）：更表解析結果 → 現有主數據（盤／
// 更別／安員／雞頭）嘅對照。呢個檔案入面嘅函數全部**同步、純函數**——
// 對照用嘅候選名單（sites/brokers/shift_types/guards/guard_staff_
// numbers/guard_phones）由 `service.ts` 一次過查晒 DB 預先攞好先傳入
// 嚟，唔喺呢度逐行查 DB（一個上載可以有成千格記錄，逐行 await 查 DB
// 太慢，亦冇必要）。「對唔到→null＋warning，唔准估」——逐個對照函數
// 冧唔到就老實話 null，唔會揀個「睇落最似」嘅去湊。
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { normalizeTel } from "@/lib/guards/contacts";
import { normalizeTelHk } from "@/lib/guards/identity";
import type { CodeKind } from "./cell-codes";
import { normalizeTimeRange } from "./time-range";

export interface SiteCandidate {
  id: string;
  canonicalName: string;
  aliases: string[];
  /** WP-UPLOAD-AUTOFIX 個案 1：母盤安全網（`resolveRosterUploadSite()`）
   * 用嚟判斷「呢個盤係咪有子盤」——冇傳（例如 `matchRowsAndSummarize()`
   * 嘅 `childSites` 候選）就當冇呢個欄，唔影響原本嘅對照。 */
  parentSiteId?: string | null;
  /** WP-UPLOAD-AUTOFIX 個案 1：`sites.roster_file_keys`——更表檔名鍵，
   * 上載時檔名 stem 含任一鍵（NFKC、唔分大小寫、字詞邊界）就直接用呢個盤，優先過檔內
   * 盤名（`matchSiteByFileName()`／`resolveRosterUploadSite()`）。 */
  rosterFileKeys?: readonly string[];
}

/** WP-LTSHIFT §19（第二部分驗收）：盤名比對前嘅正規化——NFKC（全形/
 * 半形字元、組合字統一）、去頭尾空白、內部多個空白摺做一個、全形括號
 * （（）（））換做半形（()）。跟 `rosterFileNameStem()`（檔名鍵
 * 比對，同一份精神）一致做法——純粹擴闊「完全相等」嘅比對範圍（例如
 * Postorder 逐格「客戶名稱」有時空白／括號寫法同 `sites.canonical_
 * name`／`aliases` 唔完全一樣），唔改「對唔到就 null，唔准估」原則
 * （仍然要正規化之後完全相等先算撞中，唔係 substring／fuzzy）。 */
export function normalizeSiteLabel(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"))
    .trim()
    .replace(/\s+/g, " ");
}

/** 更表盤名→`sites`：canonical_name 完全相等（正規化後）優先，搵唔到
 * 再試 aliases（例如「怡安」→怡安168 呢類別名）。對唔到就 null——上載
 * 時盤名對唔到可以先存底，之後人手 PATCH 指定（`roster_uploads.
 * site_id` nullable 就係為咗呢個情況）。 */
export function matchSite(siteNameRaw: string | null, candidates: readonly SiteCandidate[]): string | null {
  if (!siteNameRaw) return null;
  const norm = normalizeSiteLabel(siteNameRaw);
  if (!norm) return null;
  const exact = candidates.find((s) => normalizeSiteLabel(s.canonicalName) === norm);
  if (exact) return exact.id;
  const byAlias = candidates.find((s) => s.aliases.some((a) => normalizeSiteLabel(a) === norm));
  return byAlias?.id ?? null;
}

// ---------------------------------------------------------------------------
// WP-UPLOAD-AUTOFIX 個案 1（P2-版面重設計計劃.md §17.11）：更表上載完全
// 自動、唔准要人手補救。「CTB 6907」檔案內盤名格寫「城巴車廠」（同城巴車
// 廠母盤主檔一樣），但實際係「創富廠IC」呢個獨立盤——檔內盤名對照
// （`matchSite()`）冚唔到呢種「盤名寫錯／寫咗個共用字眼」嘅情況，會同
// 「城巴車廠」主檔同盤同月撞版（互相 supersede）。老闆方案：逐盤設
// `roster_file_keys`（更表檔名入面嘅穩定識別字，例如「CTB 6907」），
// 上載時檔名優先於檔內盤名。
// ---------------------------------------------------------------------------

// 月份三字母縮寫（8 月試算檔名全部用呢種寫法：「Aug 2026」）。
const MONTH_ABBR = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
// 去尾嘅 " - <Mon> <YYYY>" 或者 " <Mon> <YYYY>"（有冇 dash 都要中，dash
// 前後可以有多過一個空白——喺呢個 regex 行之前已經 collapse 咗空白做一
// 格，所以呢度淨係要顧「有冇 dash」呢個變化）。
const MONTH_YEAR_SUFFIX_RE = new RegExp(`\\s*-?\\s*(${MONTH_ABBR})\\s+\\d{4}$`, "i");
const ROSTER_PREFIX_RE = /^Roster\s*-\s*/i;

/** 更表檔名 → 「stem」（用嚟同 `roster_file_keys` 比對）：先 NFKC（全形
 * 英數／全形空格 → 半形）、去 `Roster - ` 前綴、去 ` - Aug 2026`／
 * ` Aug 2026`／` - <Mon> <YYYY>` 月份尾、去副檔名、空格 collapse。純字串
 * 處理，唔理檔案實際內容。 */
export function rosterFileNameStem(fileName: string): string {
  let s = fileName.normalize("NFKC").replace(/\.xlsx?$/i, "");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(ROSTER_PREFIX_RE, "");
  s = s.replace(MONTH_YEAR_SUFFIX_RE, "");
  return s.replace(/\s+/g, " ").trim();
}

/** 鍵／stem 比對前嘅正規化：NFKC＋細階＋空格 collapse。 */
function normalizeFileKeyText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const ASCII_ALNUM_RE = /[0-9a-z]/;

/** Opus 5.5 驗收（WP-UPLOAD-AUTOFIX）：鍵對 stem 要**字詞邊界**，唔係
 * 純 `includes`——否則鍵「615」會誤中「9615 數碼港」、「CTB 690」會誤中
 * 「CTB 6907」。規則：鍵頭／鍵尾如果係英數字，stem 喺嗰邊緊貼嘅字元就唔
 * 准係英數字（中文字冇字詞邊界，鍵頭尾係中文就唔加限制）。stem、key 都
 * 已經 `normalizeFileKeyText()`。 */
function stemContainsKeyAtBoundary(stem: string, key: string): boolean {
  if (!key) return false;
  const keyStartsAlnum = ASCII_ALNUM_RE.test(key[0]!);
  const keyEndsAlnum = ASCII_ALNUM_RE.test(key[key.length - 1]!);
  for (let i = stem.indexOf(key); i !== -1; i = stem.indexOf(key, i + 1)) {
    const before = i > 0 ? stem[i - 1]! : "";
    const after = stem[i + key.length] ?? "";
    if (keyStartsAlnum && before && ASCII_ALNUM_RE.test(before)) continue;
    if (keyEndsAlnum && after && ASCII_ALNUM_RE.test(after)) continue;
    return true;
  }
  return false;
}

interface FileKeyMatch {
  siteId: string;
  /** 撞中嘅嗰個 `roster_file_keys` 原文（未正規化）——俾 warning 用嚟講
   * 「由邊條鍵對盤」。 */
  key: string;
}

type FileKeyLookup = { kind: "hit"; match: FileKeyMatch } | { kind: "none" } | { kind: "conflict"; keys: string[] };

/** 逐個盤逐條鍵試（字詞邊界比對），**最長嘅鍵贏**（例如將來「9615 數碼港」
 * 同「9615 數碼港 CP5」各自係兩個盤嘅鍵，CP5 檔會配去較長嗰條）；最長
 * 嘅鍵有多過一個唔同盤撞中（設定打架）→ `conflict`，唔准估，交返畀檔內
 * 盤名對照＋頂層警告。 */
function findFileKeyMatch(stem: string, candidates: readonly SiteCandidate[]): FileKeyLookup {
  const normStem = normalizeFileKeyText(stem);
  if (!normStem) return { kind: "none" };
  const hits: { siteId: string; key: string; len: number }[] = [];
  for (const c of candidates) {
    for (const rawKey of c.rosterFileKeys ?? []) {
      const key = normalizeFileKeyText(rawKey);
      if (key && stemContainsKeyAtBoundary(normStem, key)) hits.push({ siteId: c.id, key: rawKey.trim(), len: key.length });
    }
  }
  if (!hits.length) return { kind: "none" };
  const maxLen = Math.max(...hits.map((h) => h.len));
  const top = hits.filter((h) => h.len === maxLen);
  const siteIds = new Set(top.map((h) => h.siteId));
  if (siteIds.size > 1) return { kind: "conflict", keys: [...new Set(top.map((h) => h.key))] };
  return { kind: "hit", match: { siteId: top[0]!.siteId, key: top[0]!.key } };
}

/** 檔名 stem 含某盤任一 `roster_file_keys`（NFKC、唔分大小寫、字詞邊界，
 * 最長鍵贏）→ 嗰個盤嘅 id；冇撞中或者設定打架就 null。淨係睇檔名，唔查
 * DB（candidates 由 caller 一次過查好傳入）。 */
export function matchSiteByFileName(fileName: string, candidates: readonly SiteCandidate[]): string | null {
  const r = findFileKeyMatch(rosterFileNameStem(fileName), candidates);
  return r.kind === "hit" ? r.match.siteId : null;
}

export interface RosterUploadSiteResolution {
  siteId: string | null;
  matchedViaFileKey: boolean;
  /** 淨係 `matchedViaFileKey=true` 先有值——撞中嗰條 `roster_file_keys`
   * 原文，俾 caller 砌 row warning「由檔名鍵『…』對盤」。 */
  fileKeyMatchedKey: string | null;
  /** 淨係「母盤安全網」觸發、或者檔名鍵設定打架先有值——加落
   * `parse_summary.warnings` 嘅頂層警告文字。 */
  parentNoSubSiteWarning: string | null;
}

/** WP-UPLOAD-AUTOFIX 個案 1：配盤優先次序（`service.ts` 用）——
 *   (0) `siteIdHint`（上載 API／人手 PATCH 指定）永遠最優先，呢個函數
 *       唔會覆蓋；
 *   (1) 檔名鍵（`matchSiteByFileName()`）；
 *   (2) 跌返檔內盤名（`matchSite()`）——但加安全網：冚中一個**多過一個
 *       子盤**嘅母盤、而呢次解析結果 `subSiteNames` 係空（冇子盤標題可
 *       以再細分）→ 唔自動掛母盤（`siteId:null`），因為冚錯母盤主檔會
 *       同真正嘅母盤更表同盤同月互相 supersede（CTB 6907 撞「城巴車廠」
 *       主檔就係呢種情況嘅示例，加咗 roster_file_keys 之後呢個檔案唔會
 *       再行到呢一步，但保留呢層防其他類似檔案）。
 *
 *       驗收（dev DB 實測）：**淨係「多過一個子盤」（>1）先觸發**，唔係
 *       「有子盤就觸發」——「HKU座頭」有一個子盤「HKU 醫學院」（純組織
 *       關係，兩個盤各自有獨立更表檔案，母盤自己嗰份檔案本身用 standard
 *       layout、冇 sub_site 欄，`subSiteNames` 本身就一定係空），如果淨
 *       係「有冇子盤」就觸發，會令「HKU座頭」呢個一路行得好好嘅盤突然
 *       上載唔到（`site_id=null`）。「城巴車廠」（9 個子盤）／「數碼港
 *       CP5」呢類先係真正「一檔多子盤」（`sub_site` 欄要分好幾個子盤）
 *       嘅結構，用「子盤數量 >1」呢個訊號分返呢兩種情況，同現有 DB 結構
 *       實測吻合。「有子盤但冇 sub_site_name」呢一行本身仲有另一層保護
 *       （`matchRowsAndSummarize()` 嘅「未寫子盤，歸母盤，人手覆核」
 *       warning），唔靠呢個安全網獨力頂晒。 */
export function resolveRosterUploadSite(
  fileName: string,
  siteIdHint: string | null | undefined,
  siteRaw: string | null,
  subSiteNames: readonly string[],
  candidates: readonly SiteCandidate[],
): RosterUploadSiteResolution {
  if (siteIdHint) return { siteId: siteIdHint, matchedViaFileKey: false, fileKeyMatchedKey: null, parentNoSubSiteWarning: null };

  const fileKey = findFileKeyMatch(rosterFileNameStem(fileName), candidates);
  if (fileKey.kind === "hit") {
    return { siteId: fileKey.match.siteId, matchedViaFileKey: true, fileKeyMatchedKey: fileKey.match.key, parentNoSubSiteWarning: null };
  }
  if (fileKey.kind === "conflict") {
    // 設定打架（同一個檔名撞中兩個唔同盤、長度一樣嘅鍵）：唔准估，唔自動
    // 掛任何盤，要人手指定＋修正盤管理頁嘅鍵。
    return {
      siteId: null,
      matchedViaFileKey: false,
      fileKeyMatchedKey: null,
      parentNoSubSiteWarning: `檔名同時撞中幾個盤嘅更表檔名鍵（${fileKey.keys.map((k) => `「${k}」`).join("、")}），請指定盤並修正盤管理頁嘅鍵`,
    };
  }

  const contentMatch = matchSite(siteRaw, candidates);
  if (contentMatch) {
    const childCount = candidates.filter((c) => c.parentSiteId === contentMatch).length;
    if (childCount > 1 && subSiteNames.length === 0) {
      const parentName = candidates.find((c) => c.id === contentMatch)?.canonicalName ?? siteRaw ?? "（未知）";
      return {
        siteId: null,
        matchedViaFileKey: false,
        fileKeyMatchedKey: null,
        parentNoSubSiteWarning: `檔內盤名係母盤「${parentName}」但冇子盤資料，請指定盤`,
      };
    }
  }
  return { siteId: contentMatch, matchedViaFileKey: false, fileKeyMatchedKey: null, parentNoSubSiteWarning: null };
}

export interface BrokerCandidate {
  id: string;
  code: string;
  aliases: string[];
}

/** 雞頭碼（A 欄）→`brokers.code`。冇雞頭碼欄嘅盤（patch 6）呢度收到
 * `null` 一樣返 `null`，Phase B 先由系統設定補（§15.2 老闆答 (1)）。 */
export function matchBroker(brokerCodeRaw: string | null, candidates: readonly BrokerCandidate[]): string | null {
  if (!brokerCodeRaw) return null;
  const norm = brokerCodeRaw.trim().toUpperCase();
  if (!norm) return null;
  const exact = candidates.find((b) => b.code.toUpperCase() === norm);
  if (exact) return exact.id;
  const byAlias = candidates.find((b) => b.aliases.some((a) => a.toUpperCase() === norm));
  return byAlias?.id ?? null;
}

export interface ShiftTypeCandidate {
  id: string;
  siteId: string;
  code: string;
  /** `shiftTypeTimeSlot(startTime,endTime)` 算出嚟嘅 "HHMM-HHMM"（冇齊
   * 開工／收工時間就 null）——Phase B-0：多過一個候選嗰陣用嚟同
   * `timeRaw` 正規化之後嘅值收窄。 */
  timeSlot: string | null;
  /** `shift_types.billing_group`（`per_shift`／`monthly_ic`）——補丁
   * （§17.7 未修第一項）：時段收窄之後仲夾住多過一個候選（例如數碼港
   * CP5「D」代號同時段 0750-1950 有 `monthly_ic` 同 `per_shift` 兩個
   * 候選），用嚟同 rank_raw 第三層收窄配對。 */
  billingGroup: "per_shift" | "monthly_ic";
}

export interface ShiftTypeMatchResult {
  id: string | null;
  ambiguous: boolean;
  /** ambiguous（或者候選 timeSlot 都冇一個啱）嗰陣，攞嚟砌 warning 俾
   * 會計睇到「候選有邊幾個」。淨係 matches.length>1 先會有值。 */
  candidateTimeSlots?: string[];
  /** 呢格最終配對係咪靠 rank_raw 第三層收窄先至得出（時段收窄之後仲夾住
   * 多過一個候選，用 rank 先至剩返一個）——`service.ts` 用嚟計
   * `parse_summary.rank_narrowed_count`。 */
  matchedViaRank?: boolean;
  /** 淨係 ambiguous=true 嗰陣先有意義：呢格有冇試過用 rank_raw 收窄（即
   * rank_raw 正規化之後有值、確實試過篩一次候選）——唔理收窄完成唔成
   * 功都會係 true，`service.ts` 用嚟喺 warning 度加多句「已經試過用
   * rank 收窄」，等會計知呢格唔係淨係睇時段就放棄。 */
  rankAttempted?: boolean;
}

/** rank_raw 正規化之後分類：「IC」類（含 IC／SIC，例如「早更IC」）定
 * 「保安員」類（含「保安員」／「Guard」，或者其他唔含 IC 嘅寫法——當
 * 冇特別寫明就當普通保安員，符合現實：更表 Rank 欄冇「IC」字樣嘅寫法
 * 五花八門，唔可能逐個列晒，跟「唔係 IC 就係普通兵」呢個業務事實）。
 * rank_raw 冇值／NFKC＋壓空白之後係空字串 → null（冇資訊可以收窄，同
 * 冇試過一樣，唔算 rankAttempted）。 */
type RankKind = "ic" | "guard" | null;
/** 「IC」／「SIC」要係獨立字元組，前後唔可以黐住拉丁字母——驗收
 * 2026-09-24：原版 `/(IC|SIC)/i` 喺去晒空格嘅字串度 test，英文 rank
 * 例如「Security Officer」（off**ic**er）、「Traffic …」會誤判做 IC
 * 類。而家喺「保留空格」（NFKC＋空白壓做一格）嘅字串度用字邊界比對：
 * 「早更IC」「夜Zone SIC」「Zone IC」「保安員(IC)」「ＩＣ」（全形）都係
 * IC 類；「Security Officer」「Guard」係保安員類。 */
// 第二條：黐住前面細楷字母嘅大楷「IC／SIC」（例如冇空格嘅「ZoneSIC」）
// 都當 IC；「officer」（細楷）、「PUBLIC」（前面係大楷）唔中。
const IC_TOKEN_RE = /(?<![A-Za-z])S?IC(?![A-Za-z])/i;
const IC_CAMEL_RE = /(?<=[a-z])S?IC(?![A-Za-z])/;
const IC_TOKEN = { test: (s: string): boolean => IC_TOKEN_RE.test(s) || IC_CAMEL_RE.test(s) };
export function classifyRank(rankRaw: string | null | undefined): RankKind {
  if (!rankRaw) return null;
  const norm = rankRaw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!norm) return null;
  if (IC_TOKEN.test(norm)) return "ic";
  return "guard";
}

/** 用 rank 分類喺 `candidates` 入面篩：IC 類淨係留 `billing_group=
 * monthly_ic` 或者 code 本身含「IC」（例如啟航1331「SIC」）嘅候選；保
 * 安員類淨係留 `per_shift` 嘅候選。冧唔到就可能剩返 0 個或者仲係多過一
 * 個——call site 照舊當 ambiguous，唔會亂揀。 */
function narrowByRank(candidates: readonly ShiftTypeCandidate[], rankKind: RankKind): readonly ShiftTypeCandidate[] {
  if (rankKind === "ic") return candidates.filter((c) => c.billingGroup === "monthly_ic" || IC_TOKEN.test(c.code));
  if (rankKind === "guard") return candidates.filter((c) => c.billingGroup === "per_shift");
  return candidates;
}

/** 「同一個代號」嘅代號家族——呢個系統有個現成慣例（build-aug-plan.ts
 * `ensureShiftType()` 附近註解）：DB `@@unique([siteId, code,
 * startTime])` 淨係睇 code+start_time，兩個概念上「其實係同一個代
 * 號」但要分開存嘅更種，會用「-2」「-3」呢類數字後綴分開嚟避免撞
 * unique（例：數碼港 CP5 嘅 `D`／`D-2`、國泰城嘅 `MR-…`／`-2`/`-3`/
 * `-4`）。更表格仔嘅 rawCode 通常淨係寫嗰個冇後綴嘅（例如「D」）——
 * 「同代號」要用呢個家族嚟湊齊全部候選（D、D-2、D-3…），CP5「D」呢個
 * rawCode 先至會喺 `matches` 度見到 `D-2`（billing_group=per_shift）
 * 呢個候選，先有得用 rank_raw 第三層收窄分返普通兵／IC。冇後綴嘅代號
 * family(x)===x，唔會影響冇呢個慣例嘅盤（dev DB 實測：全個系統淨係
 * 數碼港 CP5「D」有真實檔案會撞到呢種情況；其餘「-2/-3/-4」都係
 * `MR-` placeholder 合成 code，冇真實檔案會寫呢啲 code 做 rawCode，
 * 唔會被呢個 family widening 意外撞中）。 */
function codeFamily(code: string): string {
  return code.replace(/-\d+$/, "");
}

/** code→`shift_types`：按盤＋code 對照（時段呢個系統嘅 shift_types 一個
 * code 喺同一個盤入面可以對應幾個唔同 start_time 嘅行）。Phase A：搵到
 * 多過一個就當 ambiguous，唔亂估揀邊個。Phase B-0（老闆 8 月 748 格
 * ambiguous）：改為先試用 `timeRaw`（該行 Time 欄原文，經
 * `normalizeTimeRange()` 正規化做 "HHMM-HHMM"）同各候選嘅 `timeSlot`
 * 逐字比對收窄——一個命中就配、零個或者多過一個就保留 null＋
 * `candidateTimeSlots` 講明候選有邊幾個時段。補丁（§17.7 未修第一項，
 * 數碼港 CP5「D」同時段有 monthly_ic／per_shift 兩個候選——時段完全一
 * 樣，time_raw 收窄唔到）：「同代號」而家用 `codeFamily()`（見上面）
 * 湊埋同一個代號家族（D／D-2 呢類「-N」後綴慣例）嘅全部候選，唔淨係
 * 逐字相等——先至會喺 matches 度見齊呢兩個候選。搵到候選之後：時段收
 * 窄之後（或者 time_raw 解唔到／冇候選時段夾中，直接用原本嘅候選）仍
 * 然多過一個，用 `rankRaw`（該行 Rank 欄原文）做第三層收窄——一個命
 * 中就配，唔夠就照舊 null＋ambiguous。淨係 shift／ot 兩種 code_kind
 * 先做呢個對照——leave/marker/unknown 本身唔對應一個實際更別。 */
export function matchShiftType(
  rawCode: string,
  codeKind: CodeKind,
  siteId: string | null,
  timeRaw: string | null,
  candidates: readonly ShiftTypeCandidate[],
  rankRaw?: string | null,
): ShiftTypeMatchResult {
  if (!siteId || (codeKind !== "shift" && codeKind !== "ot")) return { id: null, ambiguous: false };
  const norm = rawCode.trim().toUpperCase();
  // 驗收 2026-09-24：淨係 rawCode 本身冇「-N」後綴（例如「D」）先湊成
  // 個家族；更表明確寫咗「D-2」就淨係逐字配 `D-2`，唔好反過嚟撈埋
  // `D`，再俾 rank 收窄揀咗去另一個。
  const normFamily = codeFamily(norm);
  const matches =
    normFamily === norm
      ? candidates.filter((c) => c.siteId === siteId && codeFamily(c.code.trim().toUpperCase()) === normFamily)
      : candidates.filter((c) => c.siteId === siteId && c.code.trim().toUpperCase() === norm);
  if (matches.length === 0) return { id: null, ambiguous: false };
  if (matches.length === 1) return { id: matches[0]!.id, ambiguous: false };

  const normalizedTimeRaw = normalizeTimeRange(timeRaw);
  let afterTime = matches;
  if (normalizedTimeRaw) {
    const timeNarrowed = matches.filter((c) => c.timeSlot === normalizedTimeRaw);
    if (timeNarrowed.length === 1) return { id: timeNarrowed[0]!.id, ambiguous: false };
    // 時段有收窄到但仲夾住多過一個（例如數碼港 CP5 兩個候選時段完全一
    // 樣）→ 喺呢個較窄嘅範圍再用 rank 篩；時段完全冧唔到任何候選（0
    // 個）→ 维持用返未收窄嘅 `matches`，交俾 rank 篩。
    if (timeNarrowed.length > 1) afterTime = timeNarrowed;
  }

  const rankKind = classifyRank(rankRaw);
  const rankAttempted = rankKind !== null;
  if (rankAttempted) {
    const rankNarrowed = narrowByRank(afterTime, rankKind);
    if (rankNarrowed.length === 1) return { id: rankNarrowed[0]!.id, ambiguous: false, matchedViaRank: true };
  }

  return { id: null, ambiguous: true, candidateTimeSlots: matches.map((c) => c.timeSlot ?? "（未設時段）"), rankAttempted };
}

/** WP-STAFF-IMPORT B2：逐格配對依據（寫入 `roster_upload_rows.match_basis`）。
 * `name_only`＝淨靠姓名配到（無工號／電話佐證），上載頁／待處理摘要出警告。 */
export type GuardMatchBasis = "staff_no" | "tel" | "name_tel" | "name_only" | "alias" | "override";

export type GuardMatchKind = "by_staff_no" | "by_name_tel" | "by_name" | "unmatched" | "ambiguous";

// Phase B-0（§15.3 第 4 項）：「二揀一」——`guard_match` enum 本身唔加值
// （唔使 migration，跟分支鐵則「唔改 schema 就最好」），細分結果全部用
// `warnings` 文字表達，由 `service.ts` 砌落 `ParsedCellRow`/row 嘅
// warnings。呢個檔案淨係喺 `GuardMatchResult` 加兩個 boolean flag，俾
// call site（`service.ts`）決定要唔要加對應嘅 warning 句。
export interface GuardMatchResult {
  guardId: string | null;
  guardMatch: GuardMatchKind;
  /** (b) 靠一個已取消（`status='former'`）嘅工號配到——`guard_match`
   * 仍然係 `by_staff_no`（真係憑工號搵到呢個人），淨係加呢個 flag 令
   * call site 可以加多句「用已取消舊號配對」warning。 */
  matchedViaFormerStaffNo: boolean;
  /** (a) 檔案有帶工號但系統完全搵唔到（current／former 都冇），退咗用
   * 姓名／電話先配到人——call site 用嚟砌「檔案工號 X 同系統工號 Y 唔
   * 一致」個 warning（呢個 flag 淨係喺 `guardId!==null` 嗰陣先有意
   * 義）。 */
  staffNoMismatch: boolean;
  /** B1-8 第 3 項（B-0 驗收留低）：檔案工號本身命中咗系統入面一個真實
   * 存在嘅安員，但呢行嘅姓名同嗰個安員唔夾（例如打錯工號撞正另一個人
   * 個號、或者工號俾第二個人）——「唔准配」，`guardId` 留 `null`、
   * `guardMatch` 落 `ambiguous`（唔可以直接當呢個號一定係嗰個人）；呢
   * 個 flag 令 call site 加「工號屬另一人」warning。 */
  staffNoBelongsToOther: boolean;
  /** WP-GUARD-FIX（老闆 2026-09-25 要求）：呢格淨係靠「別名＋電話」或者
   * 「別名唯一」（`guards.name_aliases`）先配到——`service.ts` 用嚟加
   * 「由別名配對」warning，等會計知呢個人個本名同更表寫嘅唔同。 */
  matchedViaAlias: boolean;
  /** 驗收（Opus 5.5，2026-09-26）：靠 `guard_match_overrides`（工號衝突
   * 保守預設）配到——更表工號屬另一人、guard-fix 按更表姓名建咗獨立安員
   * 並記低「呢個工號＋呢個姓名 → 嗰個安員」。`service.ts` 加「工號衝突
   * 待核」warning。optional：舊 call site／測試唔使改。 */
  matchedViaStaffNoConflictOverride?: boolean;
  /** WP-STAFF-IMPORT B2：配對依據；配唔到＝null。optional：舊 call site／測試唔使改。 */
  matchBasis?: GuardMatchBasis | null;
  /** WP-STAFF-IMPORT B2：靠電話（全表唯一）配到，但更表姓名同系統本名／別名唔同。 */
  telMatchNameDiffers?: boolean;
}

export interface GuardCandidate {
  id: string;
  nameZh: string;
}

/** `service.ts` 一次過查晒 DB 預先起好嘅對照索引——一個上載入面成千格
 * 記錄逐格 O(1) 查表，唔使逐行 await 查 DB。 */
export interface GuardMatchIndex {
  /** 驗收（Opus 5.5）：`${正規化工號}\u0000${更表姓名}` → guardId（工號衝突保守預設；optional，舊測試自己砌 index 唔使改）。 */
  staffNoConflictOverrides?: ReadonlyMap<string, string>;
  /** 正規化工號（含 current／former，`guard_staff_numbers.number`）→
   * {guardId, status}——status 俾 (b) 判斷係咪靠已取消號配到。 */
  byStaffNumber: ReadonlyMap<string, { guardId: string; status: string }>;
  /** 正規化舊 staff_no／staff_no_mw（`guards` 表同步顯示值）→ guardId。
   * 呢條 fallback 路唔帶 status 資訊（`guards` 表舊欄本身唔記
   * current/former），唔會觸發 (b) 嘅「已取消」warning。 */
  byLegacyStaffNo: ReadonlyMap<string, string>;
  /** 姓名（`name_zh`）→ 呢個名嘅全部 guardId（同名可以多過一個，交俾
   * caller 判斷 ambiguous）。 */
  byName: ReadonlyMap<string, readonly string[]>;
  /** 姓名+正規化電話 → 呢個組合嘅全部 guardId（同時比對 `guards.tel`
   * 同 `guard_phones`——任何一個電話啱都算）。 */
  byNameAndTel: ReadonlyMap<string, readonly string[]>;
  /** WP-GUARD-FIX：別名（`guards.name_aliases`，每個 guard 可以有幾個）
   * → 呢個別名嘅全部 guardId（同名／同別名可以撞多過一個，交俾 caller
   * 判斷 ambiguous）。 */
  byAlias: ReadonlyMap<string, readonly string[]>;
  /** WP-GUARD-FIX：別名+正規化電話 → 呢個組合嘅全部 guardId（同
   * `byNameAndTel` 一致做法，電話比對埋 `guards.tel`／`guard_phones`）。 */
  byAliasAndTel: ReadonlyMap<string, readonly string[]>;
  /** guardId → 現用（或者已取消 fallback）嘅 U 號顯示值（`guards.
   * staff_no`）——(a)「檔案工號 X 同系統工號 Y 唔一致」warning 用嚟攞
   * Y。 */
  staffNoByGuardId: ReadonlyMap<string, string | null>;
  /** guardId → `name_zh`（trim）——B1-8 第 3 項：staff_no 命中之後要同
   * 呢行嘅 `name_raw` 對一對，唔夾就「唔准配」。 */
  nameByGuardId: ReadonlyMap<string, string>;
  /** WP-GUARD-FIX（實測揭發）：guardId → `name_aliases`——B1-8 第 3 項嘅
   * 「唔夾」比對唔可以淨係睇 `nameByGuardId`（本名）：一個安員嘅工號
   * 喺呢行入面可能係啱嘅，但更表寫嘅係佢個別名（唔係本名），淨係比
   * 本名會誤判「工號屬另一人」。加呢個 map 之後，`matchGuard()` 嘅
   * B1-8 比對會本名／別名都試，有一個啱就唔算「唔夾」。 */
  aliasesByGuardId: ReadonlyMap<string, readonly string[]>;
  /** WP-STAFF-IMPORT B2：正規化電話（`guards.tel`＋`guard_phones`）→ guardId 全部。電話全表唯一，
   * 所以通常只有一個；多於一個（歷史重複）就唔當鍵用。optional：舊測試自己砌 index 唔使改。 */
  byTel?: ReadonlyMap<string, readonly string[]>;
}

function telKey(raw: string): string {
  return normalizeTelHk(raw) ?? normalizeTel(raw);
}

function nameTelKey(name: string, tel: string): string {
  return `${name}\u0000${tel}`;
}

export function buildGuardMatchIndex(rows: {
  // WP-GUARD-FIX：`nameAliases` 做 optional——舊 call site（例如
  // scripts/opening/build-aug-plan.ts，7 月開賬未有呢個欄嘅概念）唔傳都
  // 得，當冇別名（`[]`），唔影響原有工號／姓名／電話配對行為。
  guards: readonly (GuardCandidate & { tel: string | null; staffNo: string | null; staffNoMw: string | null; nameAliases?: readonly string[] })[];
  staffNumbers: readonly { number: string; guardId: string; status: string }[];
  phones: readonly { guardId: string; tel: string }[];
  /** 驗收（Opus 5.5）：`guard_match_overrides`（未作廢）——工號衝突保守預設。 */
  matchOverrides?: readonly { staffNo: string; nameRaw: string; guardId: string }[];
}): GuardMatchIndex {
  const byStaffNumber = new Map<string, { guardId: string; status: string }>();
  for (const sn of rows.staffNumbers) byStaffNumber.set(normalizeStaffNumber(sn.number), { guardId: sn.guardId, status: sn.status });

  const byLegacyStaffNo = new Map<string, string>();
  const staffNoByGuardId = new Map<string, string | null>();
  const nameByGuardId = new Map<string, string>();
  const aliasesByGuardId = new Map<string, readonly string[]>();
  for (const g of rows.guards) {
    staffNoByGuardId.set(g.id, g.staffNo);
    nameByGuardId.set(g.id, g.nameZh.trim());
    aliasesByGuardId.set(g.id, g.nameAliases ?? []);
    if (g.staffNo) byLegacyStaffNo.set(normalizeStaffNumber(g.staffNo), g.id);
    if (g.staffNoMw) byLegacyStaffNo.set(normalizeStaffNumber(g.staffNoMw), g.id);
  }

  const byName = new Map<string, string[]>();
  const byNameAndTel = new Map<string, string[]>();
  const byAlias = new Map<string, string[]>();
  const byAliasAndTel = new Map<string, string[]>();
  const telsByGuard = new Map<string, Set<string>>();
  for (const p of rows.phones) {
    if (!telsByGuard.has(p.guardId)) telsByGuard.set(p.guardId, new Set());
    telsByGuard.get(p.guardId)!.add(normalizeTel(p.tel));
  }
  for (const g of rows.guards) {
    const name = g.nameZh.trim();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(g.id);

    const tels = new Set(telsByGuard.get(g.id) ?? []);
    if (g.tel) tels.add(normalizeTel(g.tel));
    for (const tel of tels) {
      const key = nameTelKey(name, tel);
      if (!byNameAndTel.has(key)) byNameAndTel.set(key, []);
      byNameAndTel.get(key)!.push(g.id);
    }

    // WP-GUARD-FIX：逐個別名一樣起 byAlias／byAliasAndTel——去空白、去
    // 重複（`nameAliasesSchema`，src/lib/api/schemas.ts，寫入嗰陣已經做
    // 咗，呢度 `.trim()` 純粹防禦性，唔信賴上游一定乾淨）。
    for (const rawAlias of g.nameAliases ?? []) {
      const alias = rawAlias.trim();
      if (!alias) continue;
      if (!byAlias.has(alias)) byAlias.set(alias, []);
      byAlias.get(alias)!.push(g.id);
      for (const tel of tels) {
        const key = nameTelKey(alias, tel);
        if (!byAliasAndTel.has(key)) byAliasAndTel.set(key, []);
        byAliasAndTel.get(key)!.push(g.id);
      }
    }
  }

  const byTelSets = new Map<string, Set<string>>();
  const addTel = (raw: string, guardId: string) => {
    const k = telKey(raw);
    if (!k) return;
    if (!byTelSets.has(k)) byTelSets.set(k, new Set());
    byTelSets.get(k)!.add(guardId);
  };
  for (const p of rows.phones) addTel(p.tel, p.guardId);
  for (const g of rows.guards) if (g.tel) addTel(g.tel, g.id);
  const byTel = new Map<string, string[]>([...byTelSets].map(([k, v]) => [k, [...v]]));

  const staffNoConflictOverrides = new Map<string, string>();
  for (const o of rows.matchOverrides ?? []) staffNoConflictOverrides.set(overrideKey(normalizeStaffNumber(o.staffNo), o.nameRaw.trim()), o.guardId);

  return { byStaffNumber, byLegacyStaffNo, byName, byNameAndTel, byAlias, byAliasAndTel, staffNoByGuardId, nameByGuardId, aliasesByGuardId, staffNoConflictOverrides, byTel };
}

function overrideKey(staffNoNorm: string, name: string): string {
  return `${staffNoNorm}\u0000${name}`;
}

/** WP-STAFF-IMPORT B2 配對次序：工號 → 電話（byTel，全表唯一，對到一個先用）→ 姓名＋電話 →
 * 淨姓名 → 花名（別名）；每格回 `matchBasis`。以下係 WP-GUARD-FIX 原有說明：
 *
 * 安員配對次序（WP-GUARD-FIX 老闆 2026-09-25 要求擴充）：
 *   (1) staff_no_raw（正規化，含已取消號——`byStaffNumber` 索引唔分
 *       current/former，舊號都要搵到返個人）；
 *   (2) 姓名／別名＋電話（`guards.name_aliases`——更表寫嘅可能係花名／
 *       曾用名；驗收 Opus 5.5：本名同別名候選合埋計）；
 *   (3) 姓名／別名唯一（合埋多於一個候選→ambiguous）。
 * 「唔准估」：每一步淨係喺剩返一個候選先當啱，唔會揀「最似」嗰個。
 *
 * Phase B-0：加埋 (a)/(b) 兩個 flag（見 `GuardMatchResult` 註解）——
 * (b) staff_no 命中但嗰行 `status==='former'`；(a) 檔案帶咗 staff_no
 * 但完全搵唔到（current／former／legacy 三路都冇），退用姓名／電話先
 * 配到人。WP-GUARD-FIX：加埋 `matchedViaAlias` flag——(2b)/(3b) 呢兩步
 * 配到就係 true，`guard_match` 本身唔加新值（跟返「二揀一」慣例），
 * `service.ts` 用嚟加「由別名配對」warning。 */
/** B1-8 第 3 項嘅「呢行姓名同工號嗰個人夾唔夾」比對——WP-GUARD-FIX 實測
 * 揭發：淨係比本名（`nameByGuardId`）唔夠，一個安員嘅工號登記啱，但更
 * 表寫嘅係佢個別名（`name_aliases`）——例如 `link` 個案：呢個人本身喺
 * DB 已經有正確嘅 U 號＋別名，但更表呢一行嘅 `name_raw` 用緊個別名，
 * 冇呢層會誤判「工號屬另一人」（`staffNoBelongsToOther`），令一個本身
 * 已經配對好嘅人重新跌返做 ambiguous。本名／別名有一個啱就當夾。 */
type NameMatchKind = "name" | "alias" | "none";
function rowNameMatchesGuard(rowName: string, guardId: string, index: GuardMatchIndex): NameMatchKind {
  const systemName = index.nameByGuardId.get(guardId);
  if (systemName && rowName === systemName) return "name";
  const aliases = index.aliasesByGuardId.get(guardId) ?? [];
  return aliases.includes(rowName) ? "alias" : "none";
}

export function matchGuard(
  params: { staffNoRaw: string | null; nameRaw: string | null; telRaw: string | null },
  index: GuardMatchIndex,
): GuardMatchResult {
  return matchGuardInner(params, index);
}
function matchGuardInner(
  params: { staffNoRaw: string | null; nameRaw: string | null; telRaw: string | null },
  index: GuardMatchIndex,
): GuardMatchResult {
  let staffNoProvidedButNotFound = false;
  const rowName = params.nameRaw?.trim() || null;
  if (params.staffNoRaw) {
    const normalized = normalizeStaffNumber(params.staffNoRaw);
    if (normalized) {
      // 驗收（Opus 5.5）：工號衝突保守預設——完全相同嘅「工號＋更表姓名」
      // 組合先會命中（見 GuardMatchOverride 註解）。
      const overrideGuardId = rowName ? index.staffNoConflictOverrides?.get(overrideKey(normalized, rowName)) : undefined;
      if (overrideGuardId) {
        return {
          guardId: overrideGuardId,
          guardMatch: "by_name",
          matchedViaFormerStaffNo: false,
          staffNoMismatch: false,
          staffNoBelongsToOther: false,
          matchedViaAlias: false,
          matchedViaStaffNoConflictOverride: true,
          matchBasis: "override",
        };
      }
      const viaNumber = index.byStaffNumber.get(normalized);
      if (viaNumber) {
        // B1-8 第 3 項：staff_no 命中真實存在嘅安員，但呢行姓名同嗰個
        // 人唔夾（本名／別名都唔夾，見 `rowNameMatchesGuard()`）——
        // 「唔准配」，退返 ambiguous，唔會靜靜當呢個號一定係嗰個人
        // （`rowName` 冇值就冇得比對，維持舊行為信 staff_no）。
        const nameMatchKind = rowName ? rowNameMatchesGuard(rowName, viaNumber.guardId, index) : "name";
        if (rowName && nameMatchKind === "none") {
          return { guardId: null, guardMatch: "ambiguous", matchedViaFormerStaffNo: false, staffNoMismatch: false, staffNoBelongsToOther: true, matchedViaAlias: false };
        }
        return {
          guardId: viaNumber.guardId,
          guardMatch: "by_staff_no",
          matchedViaFormerStaffNo: viaNumber.status === "former",
          staffNoMismatch: false,
          staffNoBelongsToOther: false,
          matchedViaAlias: nameMatchKind === "alias",
          matchBasis: "staff_no",
        };
      }
      const viaLegacy = index.byLegacyStaffNo.get(normalized);
      if (viaLegacy) {
        const nameMatchKind = rowName ? rowNameMatchesGuard(rowName, viaLegacy, index) : "name";
        if (rowName && nameMatchKind === "none") {
          return { guardId: null, guardMatch: "ambiguous", matchedViaFormerStaffNo: false, staffNoMismatch: false, staffNoBelongsToOther: true, matchedViaAlias: false };
        }
        return { guardId: viaLegacy, guardMatch: "by_staff_no", matchedViaFormerStaffNo: false, staffNoMismatch: false, staffNoBelongsToOther: false, matchedViaAlias: nameMatchKind === "alias", matchBasis: "staff_no" };
      }
      staffNoProvidedButNotFound = true;
    }
  }

  const name = rowName;
  const tel = params.telRaw ? normalizeTel(params.telRaw) : null;

  // WP-STAFF-IMPORT B2：電話層（全表唯一）——工號之後、姓名＋電話之前。電話只對到一個
  // guard 先用；對到多個（歷史重複）就跳過，交返下面姓名＋電話處理。
  if (tel) {
    const viaTel = index.byTel?.get(telKey(params.telRaw!)) ?? [];
    if (viaTel.length === 1) {
      const gid = viaTel[0]!;
      const nameKind = name ? rowNameMatchesGuard(name, gid, index) : "name";
      return {
        guardId: gid,
        guardMatch: "by_name_tel",
        matchedViaFormerStaffNo: false,
        staffNoMismatch: staffNoProvidedButNotFound,
        staffNoBelongsToOther: false,
        matchedViaAlias: nameKind === "alias",
        matchBasis: nameKind === "none" ? "tel" : nameKind === "alias" ? "alias" : "name_tel",
        telMatchNameDiffers: nameKind === "none",
      };
    }
  }

  // WP-GUARD-FIX 驗收（Opus 5.5）：(2)/(2b) 同 (3)/(3b) 改做「本名∪別名」
  // 一齊計候選——之前本名步驟先行、命中一個就即刻返回，如果 A 嘅別名
  // 啱啱等於 B 嘅本名（例如兩個同名人，其中一個用別名登記），更表寫呢
  // 個名嘅行會靜靜配咗俾 B，完全唔理 A；而家兩邊合埋多過一個人就
  // ambiguous（唔准估）。淨係靠別名命中先標 `matchedViaAlias`。
  if (name && tel) {
    const key = nameTelKey(name, tel);
    const viaName = index.byNameAndTel.get(key) ?? [];
    const viaAlias = index.byAliasAndTel.get(key) ?? [];
    const candidates = [...new Set([...viaName, ...viaAlias])];
    if (candidates.length === 1) {
      return { guardId: candidates[0]!, guardMatch: "by_name_tel", matchedViaFormerStaffNo: false, staffNoMismatch: staffNoProvidedButNotFound, staffNoBelongsToOther: false, matchedViaAlias: !viaName.includes(candidates[0]!), matchBasis: viaName.includes(candidates[0]!) ? "name_tel" : "alias" };
    }
    if (candidates.length > 1) return { guardId: null, guardMatch: "ambiguous", matchedViaFormerStaffNo: false, staffNoMismatch: false, staffNoBelongsToOther: false, matchedViaAlias: false };
  }

  if (name) {
    const viaName = index.byName.get(name) ?? [];
    const viaAlias = index.byAlias.get(name) ?? [];
    const candidates = [...new Set([...viaName, ...viaAlias])];
    if (candidates.length === 1) {
      return { guardId: candidates[0]!, guardMatch: "by_name", matchedViaFormerStaffNo: false, staffNoMismatch: staffNoProvidedButNotFound, staffNoBelongsToOther: false, matchedViaAlias: !viaName.includes(candidates[0]!), matchBasis: viaName.includes(candidates[0]!) ? "name_only" : "alias" };
    }
    if (candidates.length > 1) return { guardId: null, guardMatch: "ambiguous", matchedViaFormerStaffNo: false, staffNoMismatch: false, staffNoBelongsToOther: false, matchedViaAlias: false };
  }

  return { guardId: null, guardMatch: "unmatched", matchedViaFormerStaffNo: false, staffNoMismatch: false, staffNoBelongsToOther: false, matchedViaAlias: false, matchBasis: null };
}
