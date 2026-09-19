// WP-STAFFNO（老闆 2026-09-19 拍板）：員工編號獨立表（方案 B）＋保安牌照
// 甲／乙類到期日分開存嘅共用邏輯。
//
// 業務規則（老闆 2026-09-19 拍板，四條）：
//   (1) 員工編號種類：U＝去 Wilson 盤做散工必須有；MP＝去第二間公司嘅
//       盤做散工用；MG＝轉咗長工（純內部出糧／行政用，唔係前線）；
//       MW＝公司寫字樓員工編號（office staff，唔係前線保安）。
//   (2) 更表／匯出一律顯示 U 號——`guards.staff_no`（現用 U）係更表編輯
//       器／匯出 Excel／報表淨一嘅工號來源，唔會顯示 `staff_no_mw`
//       （MG／MW），呢兩個純粹俾內部出糧／行政用。
//   (3) 轉長工後 U／MP 繼續有效——一個人可以同時有 U／MP／MG 三種現用
//       號，加 MG 唔會影響 U／MP 嘅 current 狀態（呢個檔案「一種
//       scheme 一個 current」嘅唯一性淨係限**同一個 scheme 入面**，跨
//       scheme 互不影響）。
//   (4) 離職後舊編號會「取消」，再入職攞全新編號，永遠唔復用舊號——
//       所以 `status=former` 嘅語義係「已取消／已停用」，唔係「舊但
//       仍然生效」。UI／API 訊息一律用「已取消」呢個講法（DB 值本身仍
//       然叫 `former`，唔改，改就要 migration，見 worktree 規則）。
//
// 員工編號並存唔取代：同一人可以同時有 U／MP／MG；同一種入面亦可能有
// 多個號（臨時號→正式號、離職再入職攞新號）——舊行存底但摺埋
// （status=former＝已取消，見上面 (4)）。`scheme` 刻意用 String（1-4 位
// 大寫英文字母，呢度 zod-style regex 管，唔用 Prisma enum），將來加新
// 種類唔使 migration。
//
// 呢個檔案兩組函數：
//   1. `upsertCurrentStaffNumber()`／`syncLegacyStaffNoColumns()`／
//      `applyLegacyStaffNoPatch()`——員工編號寫入嘅核心邏輯，俾
//      `POST /api/guards/:id/staff-numbers`、`PATCH /api/guards/:id`
//      （舊寫法）、seed script 共用。
//   2. `deriveSiaPermitExpiry()`——SIA 牌照甲／乙類到期日 →
//      衍生 `sia_permit_expiry`／`sia_permit_type`。
import type { Prisma, GuardStaffNumber } from "@prisma/client";
import { BadRequest, Conflict, Forbidden } from "../api/errors";
import { todayLocalStr } from "../ui/format";
import { writeAudit } from "../audit";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// 員工編號（guard_staff_numbers）
// ---------------------------------------------------------------------------

/** scheme 格式：1-4 位大寫英文字母。已知 U／MP／MG／MW（見上面業務規則
 * (1)），但呢度刻意唔用寫死 enum——將來加新種類（例如第三間公司又有新
 * 代號）淨係改 UI 下拉，唔使 migration。 */
export const STAFF_NUMBER_SCHEME_RE = /^[A-Z]{1,4}$/;

// S2（Opus 驗收）：`number` 正規化後嘅格式——scheme 前綴（1-4 位大寫英文
// 字母）+ 1-16 位大寫英文字母／數字／連字符（`-`），總長自然 ≤20（4+16）。
// 呢個 regex 係「正規化之後」先驗，唔理原文大小寫/空白（見
// `normalizeStaffNumber()`）。
export const STAFF_NUMBER_NUMBER_RE = /^[A-Z]{1,4}[0-9A-Z-]{1,16}$/;

// S2：正規化＝trim＋大寫＋移除所有空白（唔淨係頭尾——中間打錯多咗個
// space，例如 "U 1234"，都要當同 "U1234" 係同一個號，唔應該因為呢種
// 打字習慣差異漏撞號檢查）。
export function normalizeStaffNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/** 由工號本身推返個 scheme（前綴大寫英文字母）——「PATCH /api/guards/:id
 * 舊寫法」（body 帶 staff_no／staff_no_mw，冇明確畀 scheme）用嚟推斷。
 * 推唔到（冇字母前綴，或者前綴長過 4 位）就 return null，由 call site
 * 決定點處理（一律 400）。 */
export function schemeFromNumber(raw: string): string | null {
  const normalized = normalizeStaffNumber(raw);
  const match = normalized.match(/^[A-Z]+/);
  if (!match) return null;
  const scheme = match[0];
  return STAFF_NUMBER_SCHEME_RE.test(scheme) ? scheme : null;
}

// M1（Opus 驗收修復）：原本用 `hkDayStartUtc(todayLocalStr(now))`——
// `hkDayStartUtc()` 傳返「嗰個 HK 曆日 00:00 HKT」對應嘅 UTC instant
// （即 UTC 前一日 16:00），寫落 `@db.Date` 欄會俾 Postgres 攞返嗰個 UTC
// instant 嘅日曆日部分＝**前一日**（例如 HK 今日 2026-09-19，`hkDayStartUtc`
// 返 2026-09-18T16:00:00Z，存到 `guard_staff_numbers.valid_to` 就變咗
// 2026-09-18，早咗一日）。`hkDayStartUtc()`/`hkDayEndUtc()` 本身係啱
// 嘅——佢哋係俾「當範圍邊界同 `created_at`（timestamptz）比較」呢類場合
// 用（見 src/lib/ui/format.ts 頂註解），唔係俾「要寫入 `@db.Date` 嘅字面
// 日曆日」呢種場合用。`@db.Date` 呢類欄要嘅係同 zod `dateOnly`
// （`z.coerce.date()` 解 "YYYY-MM-DD"）一致嘅慣例：直接用「HK 今日」嗰個
// YYYY-MM-DD 字串起 `T00:00:00.000Z`（唔經 HKT 換算），等 Postgres 攞到
// 嘅日曆日就係 HK 今日本身，唔會早/遲一日。全檔（呢個 module）寫
// `@db.Date` 一律用呢個慣例，唔再用 `hkDayStartUtc()`。
export function hkToday(now: Date = new Date()): Date {
  const ymd = todayLocalStr(now);
  return new Date(`${ymd}T00:00:00.000Z`);
}

export interface UpsertStaffNumberInput {
  guardId: string;
  scheme: string;
  number: string;
  validFrom?: Date | null;
  note?: string | null;
  source?: string | null;
  createdBy?: string | null;
  now?: Date;
  // M2b（Opus 驗收）：409（撞號）response 帶 `guard_id` 呢個結構化 detail
  // 淨係俾內部角色（老闆／主管／會計）見到，雞頭（同其他角色）一律唔
  // 畀——call site 要明確傳 `true`（`src/lib/broker-isolation.ts
  // isInternalRole()`），default `false`（default-deny，就算漏傳都唔會
  // 洩漏）。
  revealConflictGuardId?: boolean;
}

export interface UpsertStaffNumberResult {
  created: GuardStaffNumber;
  /** 冇 → null；有 → 舊嗰行轉 former 前後嘅完整 row（俾 call site 一齊
   * 寫 audit_log，並且喺 response 講明「原本嘅 XX 號已取消」）。 */
  convertedFormer: { before: GuardStaffNumber; after: GuardStaffNumber } | null;
}

/** `POST /api/guards/:id/staff-numbers` 同「PATCH /api/guards/:id 舊
 * 寫法」共用嘅核心 upsert 邏輯——起一行新 current；如果同一個 guard 同
 * 一個 scheme 已經有 current，就將舊嗰行自動轉 `former`（`validTo`＝今日
 * HK）；`number` 已經被（任何，包括自己）guard 用緊就 409（唔回姓名，
 * `revealConflictGuardId=true`——即係內部角色——先回埋邊個 guard_id，
 * 見 `src/lib/api/errors.ts` `ApiError.details`／M2b）。
 *
 * 一定要喺 `prisma.$transaction()` 入面 call（`tx` 入面）——同一個 scheme
 * 「舊 current 轉 former」＋「起新 current」要原子性咁一齊成功或者一齊
 * 失敗，唔可以出現兩行 current 或者零行 current 嘅中間狀態。落完數要
 * 記得跟住喺同一個 tx 入面 call `syncLegacyStaffNoColumns()`。 */
export async function upsertCurrentStaffNumber(tx: Tx, input: UpsertStaffNumberInput): Promise<UpsertStaffNumberResult> {
  const scheme = input.scheme.trim().toUpperCase();
  if (!STAFF_NUMBER_SCHEME_RE.test(scheme)) {
    throw BadRequest(`scheme 格式唔啱（要 1-4 位大寫英文字母）：${input.scheme}`);
  }
  const number = normalizeStaffNumber(input.number);
  // 必修 5（Opus 驗收第三輪）：原本淨係 `number.startsWith(scheme)`——
  // "ABCDE123".startsWith("ABCD") 都係 true，但 "ABCDE123" 開頭嘅**連續**
  // 大寫字母其實係 "ABCDE"（5 位），同 `scheme="ABCD"` 唔一致，`startsWith()`
  // 呢種寫法漏咗檢查「scheme 之後即刻跟住嘅唔可以再係字母」，同
  // migration.sql「(3) 資料搬遷」`schemeFromNumber()` 對齊嘅計法（攞成串
  // 連續開頭字母先驗證長度）唔一致，會走漏 `{scheme:"ABCD",
  // number:"ABCDE123"}` 呢類本應 400 嘅輸入。改做：攞 `number` 開頭連續
  // 大寫字母（可能多過 4 位），要求逐字等於 `scheme`。
  const numberLeadingLetters = number.match(/^[A-Z]+/)?.[0] ?? "";
  if (numberLeadingLetters !== scheme) {
    throw BadRequest(
      `number 開頭連續字母要同 scheme 逐字相等（scheme=${scheme}，number 讀到嘅開頭係「${numberLeadingLetters || "（冇字母前綴）"}」）：${number}`,
    );
  }
  // S2（Opus 驗收）：正規化之後仲要符合 `STAFF_NUMBER_NUMBER_RE`
  // （scheme 前綴 1-4 位大寫英文字母 + 1-16 位英文數字／連字符，總長
  // ≤20）——冇呢層會漏收例如夾埋標點/emoji/超長字串嘅工號。
  if (!STAFF_NUMBER_NUMBER_RE.test(number)) {
    throw BadRequest(`number 格式唔啱（正規化後要係 ${scheme}+1-16 位大寫英文字母／數字／連字符，總長 ≤20）：${number}`);
  }

  const conflictingRow = await tx.guardStaffNumber.findUnique({ where: { number } });
  if (conflictingRow) {
    // M2b：淨係內部角色（`revealConflictGuardId=true`）先攞到 guard_id，
    // 雞頭一律得返個 generic 訊息，冇任何結構化 detail。
    throw Conflict("呢個工號已經有人用緊", input.revealConflictGuardId ? { guard_id: conflictingRow.guardId } : undefined);
  }

  const existingCurrent = await tx.guardStaffNumber.findFirst({
    where: { guardId: input.guardId, scheme, status: "current" },
  });
  let convertedFormer: { before: GuardStaffNumber; after: GuardStaffNumber } | null = null;
  if (existingCurrent) {
    const after = await tx.guardStaffNumber.update({
      where: { id: existingCurrent.id },
      data: { status: "former", validTo: hkToday(input.now) },
    });
    convertedFormer = { before: existingCurrent, after };
  }

  const created = await tx.guardStaffNumber.create({
    data: {
      guardId: input.guardId,
      scheme,
      number,
      status: "current",
      validFrom: input.validFrom ?? null,
      note: input.note ?? null,
      source: input.source ?? "manual",
      createdBy: input.createdBy ?? null,
    },
  });

  return { created, convertedFormer };
}

/** 揀一個 scheme 嘅「代表行」：current 優先；冇 current 就揀**最近取消**
 * 嗰一行（`validTo` desc nulls last → `updatedAt` desc）。俾
 * `syncLegacyStaffNoColumns()` 用（B，見下面大註解）——`rows` 要傳呢個
 * guard **全部**行（唔限 status），呢度自己揀返啱個 scheme。 */
function pickRepresentativeStaffNumberRow(rows: GuardStaffNumber[], scheme: string): GuardStaffNumber | undefined {
  const schemeRows = rows.filter((r) => r.scheme === scheme);
  const current = schemeRows.find((r) => r.status === "current");
  if (current) return current;
  const cancelled = schemeRows.filter((r) => r.status === "former");
  if (cancelled.length === 0) return undefined;
  return [...cancelled].sort((a, b) => {
    // validTo desc nulls last：null 當 -Infinity，descending 排序自然排
    // 到最後。
    // Opus 覆核 M1：手動取消嘅行舊資料可能冇 validTo（null）——唔可以當
    // 「最舊」排最後，否則「被新號取代嘅舊號」會贏咗「最後真正用緊、啱啱
    // 先取消嗰個」。冇 validTo 就用 updatedAt 頂上；同分再比 updatedAt。
    const av = (a.validTo ?? a.updatedAt).getTime();
    const bv = (b.validTo ?? b.updatedAt).getTime();
    if (av !== bv) return bv - av;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  })[0];
}

/** `guards.staff_no`／`staff_no_mw`（舊欄，保留做同步顯示值）由呢個函數
 * 由新表現狀重算：`staff_no`＝現用 **U**（冇就用**最近取消**嗰個 U）；
 * `staff_no_mw`＝現用 **MG**（冇就現用 **MW**；兩個都冇 current 就用
 * MG／MW 入面**最近取消**嗰個，MG 優先）。任何員工編號增／改／取消之後
 * 都要喺同一個 transaction 內尾 call 呢個函數，等兩邊唔會唔一致——更表
 * 編輯器／匯出 Excel／報表／`ai.guards` view／seed gate 全部繼續讀
 * 呢兩個舊欄，唔使改。
 *
 * B（老闆 2026-09-19 拍板業務規則 (4)：離職後編號取消，永遠唔復用）：
 * 原本「冇 current 就寫 null」嘅做法，喺安員離職（U 號轉 former／已取消）
 * 之後就會將 `guards.staff_no` 抹走——但呢個安員舊月份嘅更表／匯出／
 * `gate:export` 對數仍然要顯示返嗰個（已取消嘅）U 號先做到「歷史文件
 * 完整」（業務規則 (2)：更表／匯出一律顯示 U 號；一個已離職安員嘅舊
 * 更表當然仲係要顯示佢嗰陣用緊嘅 U 號，唔可以因為而家取消咗就變空白）。
 * 改做：冇 current 就 fallback 用「最近取消」嗰一行（`pickRepresentativeStaffNumberRow()`），
 * 淨係完全冇任何行（連 former 都冇）先真係 null。 */
// S3/S4（Opus 驗收修復）：原本版本淨係睇 current 行——一個 guard 喺新表
// 完全冇任何 U 行（例如佢個 legacy `staff_no` 格式怪，搬遷 migration
// 跳咗冇起新表行，見 migration.sql），叫呢個函數都會將 `staffNo` 寫做
// null，靜靜哋抹走一個「新表冇對應」但本身有效嘅 legacy 值。而家改做：
// 淨係當呢個 guard 喺新表**有過**（`current` 或 `former`，唔限
// `current`）呢個 scheme 嘅行，先同步嗰個舊欄；完全冇任何行（包括
// former）就當「呢個 scheme 唔歸新表管」，保留 `guards` 表原有值唔郁。
//
// 應修 1（Opus 驗收第二輪）：`guards.staff_no`（`@unique`）呢個寫入可能
// 撞另一個 guard——典型成因係 migration「(3) 資料搬遷」跳咗嘅
// `migration_skipped_duplicate` 案例：輸咗嗰個 guard 嘅**原始**（未正規
// 化）legacy 欄值原封不動留喺自己嗰行（migration 刻意唔郁 guards 表本身，
// 見 migration.sql），如果嗰個原始值本身已經係正規化形式（同贏咗嗰個
// guard 而家喺新表嘅現用號啱啱好撞正），呢度就會撞號。原本冇攔截，直上
// route 變 500；而家轉做 409，並且指出「呢個號碼仲留喺另一個安員嘅舊工
// 號欄（資料遷移時跳過咗）」，`guard_id` 淨係內部角色
// （`revealConflictGuardId=true`）先見到，同 M2b
// （`upsertCurrentStaffNumber()`）一致口徑。
//
// 做法：寫之前**主動查一次**有冇第二個 guard 已經用緊呢個值（`tx.guard.
// findFirst()`）——唔淨係靠 catch P2002 先發現，因為 P2002 一撞，Postgres
// 個 transaction 即刻進入 aborted 狀態（"current transaction is aborted,
// commands ignored until end of transaction block"），呢下再想用返
// **同一個** `tx` 查邊個 guard 攞緊（想攞佢個 id 做 409 detail）會直接
// 再拋多個錯，查唔到。主動查冇呢個問題（transaction 仲正常），可以攞到
// `guard_id`。`catch` 嗰段留低做 defense-in-depth（極罕見 race：主動查
// 完、真正 UPDATE 之前，第二個 transaction 啱啱好寫咗同一個值）——呢種
// 情況都要轉做 409（唔可以 500），但呢一刻 tx 已經 aborted，唔再嘗試攞
// `guard_id`（寧願訊息少啲都好過再拋一個關於「transaction aborted」嘅
// 唔相關 500）。呢個函數本身冇開自己個 transaction（call site 已經喺
// `tx` 入面），拋錯會令外層 `prisma.$transaction()` 自然 rollback，唔使
// 呢度額外處理。
export async function syncLegacyStaffNoColumns(tx: Tx, guardId: string, opts?: { revealConflictGuardId?: boolean }): Promise<void> {
  const allRows = await tx.guardStaffNumber.findMany({ where: { guardId } });
  const hasUHistory = allRows.some((r) => r.scheme === "U");
  const hasMgOrMwHistory = allRows.some((r) => r.scheme === "MG" || r.scheme === "MW");
  // B：`staff_no`／`staff_no_mw` 各自嘅代表值——current 優先，冇 current
  // 就用最近取消嗰行（見上面 `pickRepresentativeStaffNumberRow()` 同呢個
  // 函數大註解）。`staff_no_mw` 嘅 MG／MW 各自揀代表行之後，先用「MG 優先
  // 其次 MW」揀邊個做最終值。
  const uRepresentative = pickRepresentativeStaffNumberRow(allRows, "U");
  const mgRepresentative = pickRepresentativeStaffNumberRow(allRows, "MG");
  const mwRepresentative = pickRepresentativeStaffNumberRow(allRows, "MW");

  const data: Prisma.GuardUpdateInput = {};
  if (hasUHistory) data.staffNo = uRepresentative?.number ?? null;
  if (hasMgOrMwHistory) {
    // 現用嘅一定贏已取消嘅：現用 MG → 現用 MW → 最近取消 MG → 最近取消 MW。
    const reps = [mgRepresentative, mwRepresentative].filter((r): r is GuardStaffNumber => !!r);
    data.staffNoMw = (reps.find((r) => r.status === "current") ?? reps[0])?.number ?? null;
  }
  if (Object.keys(data).length === 0) return;

  // 必修 5（Opus 驗收第三輪）：補一句點處理——單講「請先處理嗰邊」冇講
  // 清楚實際要點做，用戶（老闆/主管）未必知道「處理」係指去邊度做乜。
  const conflictHint = "，請去嗰位安員嘅「員工編號」區加返正確號碼，舊工號欄就會更新";
  const conflictMessage = (value: string) => `呢個號碼（${value}）仲留喺另一個安員嘅舊工號欄（資料遷移時跳過咗），請先處理嗰邊${conflictHint}`;
  // Opus 覆核 S1：如果要寫入嘅只係「已取消號」嘅歷史顯示值（fallback），
  // 撞到另一個安員嘅舊工號欄就唔好阻住個操作（否則呢類人永遠取消唔到個
  // 號）——跳過呢欄、保留原值就算；真現用號撞先至 409。
  if (typeof data.staffNo === "string" && uRepresentative?.status === "former") {
    const holder = await tx.guard.findFirst({ where: { staffNo: data.staffNo, NOT: { id: guardId } }, select: { id: true } });
    if (holder) delete data.staffNo;
  }
  if (typeof data.staffNoMw === "string" && ![mgRepresentative, mwRepresentative].some((r) => r?.status === "current")) {
    const holder = await tx.guard.findFirst({ where: { staffNoMw: data.staffNoMw, NOT: { id: guardId } }, select: { id: true } });
    if (holder) delete data.staffNoMw;
  }
  if (Object.keys(data).length === 0) return;
  if (typeof data.staffNo === "string") {
    const holder = await tx.guard.findFirst({ where: { staffNo: data.staffNo, NOT: { id: guardId } }, select: { id: true } });
    if (holder) throw Conflict(conflictMessage(data.staffNo), opts?.revealConflictGuardId ? { guard_id: holder.id } : undefined);
  }
  // `staff_no_mw` 而家冇 DB unique constraint（見 prisma/schema.prisma），
  // 理論上唔會撞——但一致對待（防禦性；日後如果加返 constraint 都唔使
  // 改呢度）。
  if (typeof data.staffNoMw === "string") {
    const holder = await tx.guard.findFirst({ where: { staffNoMw: data.staffNoMw, NOT: { id: guardId } }, select: { id: true } });
    if (holder) throw Conflict(conflictMessage(data.staffNoMw), opts?.revealConflictGuardId ? { guard_id: holder.id } : undefined);
  }

  try {
    await tx.guard.update({ where: { id: guardId }, data });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      throw Conflict(`呢個號碼仲留喺另一個安員嘅舊工號欄（資料遷移時跳過咗），請先處理嗰邊${conflictHint}`);
    }
    throw err;
  }
}

export interface ApplyLegacyStaffNoPatchResult {
  /** 逐個成功處理咗嘅欄位（`staff_no`／`staff_no_mw`）一個 entry，俾
   * call site 用 `writeStaffNumberAudits()` 寫 audit_log。 */
  changes: UpsertStaffNumberResult[];
}

/** `PATCH /api/guards/:id` 舊寫法（body 帶 `staff_no`／`staff_no_mw`，
 * 舊前端／舊 API 用法）——轉做對新表嘅 upsert，再 sync 返舊欄，令兩邊
 * 一致。淨係值為 truthy（非空字串）先處理——`undefined` 一律當「冇提
 * 供」，`""`／`null` 同 `GuardUpdateSchema` 其他 optional 欄一致口徑，
 * 唔支援用呢條舊路刪走工號（要刪／轉舊用返專門嘅
 * `PATCH /api/guards/:id/staff-numbers/:numberId`）。 */
export async function applyLegacyStaffNoPatch(
  tx: Tx,
  params: {
    guardId: string;
    staffNo?: string | null;
    staffNoMw?: string | null;
    createdBy?: string | null;
    now?: Date;
    // M2b：見 UpsertStaffNumberInput.revealConflictGuardId——呢個 legacy
    // patch 一樣可能撞號 409，一致對待。
    revealConflictGuardId?: boolean;
  },
): Promise<ApplyLegacyStaffNoPatchResult> {
  const { guardId, staffNo, staffNoMw, createdBy, now, revealConflictGuardId } = params;
  const changes: UpsertStaffNumberResult[] = [];
  if (staffNo) {
    const scheme = schemeFromNumber(staffNo);
    if (!scheme) throw BadRequest(`staff_no 格式推唔到 scheme（要以 1-4 位大寫英文字母開頭）：${staffNo}`);
    // S1（Opus 驗收）：`staff_no`（舊欄）呢條快速路淨係收 U 開頭——其他
    // 種類（MP／MG／MW／將來新種類）要用「員工編號」區（`POST/PATCH
    // .../staff-numbers*`，唔限 scheme）新增／管理，唔准借呢條 legacy
    // 路後門入。
    if (scheme !== "U") {
      throw BadRequest(`staff_no 只收 U 開頭嘅工號；「${scheme}」呢類請用「員工編號」區新增／管理：${staffNo}`);
    }
    changes.push(
      await upsertCurrentStaffNumber(tx, { guardId, scheme, number: staffNo, source: "manual:legacy-patch(staff_no)", createdBy, now, revealConflictGuardId }),
    );
  }
  if (staffNoMw) {
    const scheme = schemeFromNumber(staffNoMw);
    if (!scheme) throw BadRequest(`staff_no_mw 格式推唔到 scheme（要以 1-4 位大寫英文字母開頭）：${staffNoMw}`);
    // S1：`staff_no_mw`（舊欄）淨係收 MG／MW——同上，其他種類請用
    // 「員工編號」區。
    if (scheme !== "MG" && scheme !== "MW") {
      throw BadRequest(`staff_no_mw 只收 MG／MW 開頭嘅工號；「${scheme}」呢類請用「員工編號」區新增／管理：${staffNoMw}`);
    }
    changes.push(
      await upsertCurrentStaffNumber(tx, { guardId, scheme, number: staffNoMw, source: "manual:legacy-patch(staff_no_mw)", createdBy, now, revealConflictGuardId }),
    );
  }
  if (changes.length) {
    await syncLegacyStaffNoColumns(tx, guardId, { revealConflictGuardId });
  }
  return { changes };
}

/** POST staff-numbers／PATCH guards 舊寫法共用嘅 audit_log 寫法——逐個
 * `UpsertStaffNumberResult` 寫一條 create（新 current 行），如果有自動
 * 轉 former 就多寫一條 update（同 `writeAudit()` 一致，`table_name`＝
 * "guard_staff_numbers" 會自動經 `AUDIT_DTO_BY_TABLE` 嘅
 * `toGuardStaffNumberDTO` 白名單）。 */
export async function writeStaffNumberAudits(
  actorUserId: string | null,
  changes: UpsertStaffNumberResult[],
  ip: string | null,
): Promise<void> {
  for (const change of changes) {
    await writeAudit({ actorUserId, tableName: "guard_staff_numbers", rowId: change.created.id, action: "create", after: change.created, ip });
    if (change.convertedFormer) {
      await writeAudit({
        actorUserId,
        tableName: "guard_staff_numbers",
        rowId: change.convertedFormer.after.id,
        action: "update",
        before: change.convertedFormer.before,
        after: change.convertedFormer.after,
        ip,
      });
    }
  }
}

/** WP-STAFFNO：`sia_permit_type`／`sia_permit_expiry` 而家係由甲／乙類
 * 到期日算出嚟嘅衍生值——API（POST／PATCH /api/guards*）唔再接受直接
 * 寫，帶咗就 400 並提示用 `sia_permit_a_expiry`／`sia_permit_b_expiry`
 * （好過淨係靠 zod `.strict()` 嘅「未知欄位」generic 錯誤——嗰兩個 key
 * 已經唔喺 schema 度，`.strict()` 本身都會 400，呢個函數淨係俾更清楚
 * 嘅訊息，要喺 `parseBody()` 之前 call）。 */
const LEGACY_SIA_PERMIT_KEYS = ["sia_permit_type", "sia_permit_expiry"] as const;
export function assertNoLegacySiaPermitWrite(body: unknown): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const hit = LEGACY_SIA_PERMIT_KEYS.find((k) => k in (body as Record<string, unknown>));
  if (hit) {
    throw BadRequest(`「${hit}」而家係衍生值（由甲／乙類到期日計出嚟），唔可以直接寫——請改用 sia_permit_a_expiry／sia_permit_b_expiry`);
  }
}

// M2a（Opus 驗收修復）：雞頭經 `POST /api/guards`／`PATCH /api/guards/:id`
// 帶 `staff_no`／`staff_no_mw`（舊寫法，會觸發 `applyLegacyStaffNoPatch()`
// 起／改新表行）一律 403——同兩條新 `.../staff-numbers*` route 一樣**硬性
// 擋**，唔靠矩陣「自己安員:update」出廠 off 個 cell（老闆理論上可以開
// 呢個 cell 俾雞頭改自己安員嘅普通欄，開咗唔應該連帶解鎖雞頭寫工號——
// 「雞頭唔可以寫工號」係呢個資源絕對規則，唔係可開關嘅權限）。要喺
// `parseBody()` 之前用 raw body 檢查（key 存在就算，唔理值係咪 truthy/
// 空字串——同 `assertNoLegacySiaPermitWrite()` 一致做法）。
const LEGACY_STAFF_NO_KEYS = ["staff_no", "staff_no_mw"] as const;
export function assertBrokerNoLegacyStaffNoWrite(isBroker: boolean, body: unknown): void {
  if (!isBroker) return;
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const hit = LEGACY_STAFF_NO_KEYS.find((k) => k in (body as Record<string, unknown>));
  if (hit) {
    throw Forbidden(`雞頭唔可以帶「${hit}」——工號要用「員工編號」區管理，呢兩個 API 快速路淨係俾內部角色用`);
  }
}

export interface StaffNumberChip {
  scheme: string;
  number: string;
  status: string;
}

/** `GET /api/guards`（列表）／`GET`、`PATCH /api/guards/:id`（詳情）
 * 共用——merge 落 response 嘅 additive `staffNumbers` 欄，淨係 current
 * （chips 用；former 要睇全部要用 `GET /api/guards/:id/staff-numbers`）。
 * 純資料轉換，唔碰 DB（call site 自己查完先傳個 rows 落嚟）。 */
export function toStaffNumberChips(rows: Array<Pick<GuardStaffNumber, "scheme" | "number" | "status">>): StaffNumberChip[] {
  return rows.map((r) => ({ scheme: r.scheme, number: r.number, status: r.status }));
}

// ---------------------------------------------------------------------------
// SIA 牌照甲／乙類到期日 → 衍生 sia_permit_expiry／sia_permit_type
// ---------------------------------------------------------------------------

export interface DeriveSiaPermitInput {
  siaPermitAExpiry?: Date | null;
  siaPermitBExpiry?: Date | null;
  dateOfBirth?: Date | null;
}
export interface DerivedSiaPermit {
  siaPermitExpiry: Date | null;
  siaPermitType: string | null;
}

/** 以 HK 曆日計算「而家」相對 `dateOfBirth` 嘅歲數（考慮緊月/日，唔係
 * 淨係減年份）——`@db.Date` 存嘅係 UTC 午夜，`toISOString().slice(0,10)`
 * 直接攞返曆日字串，唔使再理時區換算。 */
function ageAsOfHk(dateOfBirth: Date, now: Date): number {
  const todayStr = todayLocalStr(now);
  const dobStr = dateOfBirth.toISOString().slice(0, 10);
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const [by, bm, bd] = dobStr.split("-").map(Number);
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

/** 甲／乙類到期日 → 衍生 `sia_permit_expiry`（兩個入面「仍然有效（冇
 * 因為滿 70 歲而失效）而最早到期」嗰個）／`sia_permit_type`
 * （A／B／A+B，冇任何一個就 null）。
 *
 * 乙類：如果有出生日期，而且以 `now`（預設而家）計已經滿 70 歲，就當
 * 完全冇呢張牌——唔計入 type，都唔計入 expiry（法定失效，同「日期到期」
 * 唔同層次，唔理 `siaPermitBExpiry` 本身填嘅日期係幾時）。冇出生日期
 * 就冇辦法判斷，乙類正常計（唔會因為「唔知」就當失效）。
 *
 * 呢度刻意**唔**因為到期日已過（純日期意義上嘅「過期」）就剔走個
 * candidate——已過期都仲係「呢個人有嗰張牌」，過期警示係另一層（列表
 * pill／`expiring_within_days` 篩選，睇返回嚟嗰個 `siaPermitExpiry` 本
 * 身有幾接近/已經過咗）。 */
export function deriveSiaPermitExpiry(input: DeriveSiaPermitInput, now: Date = new Date()): DerivedSiaPermit {
  const bVoidByAge = input.dateOfBirth != null && ageAsOfHk(input.dateOfBirth, now) >= 70;
  const effectiveB = bVoidByAge ? null : (input.siaPermitBExpiry ?? null);
  const a = input.siaPermitAExpiry ?? null;
  const hasA = a != null;
  const hasB = effectiveB != null;

  let siaPermitType: string | null = null;
  if (hasA && hasB) siaPermitType = "A+B";
  else if (hasA) siaPermitType = "A";
  else if (hasB) siaPermitType = "B";

  let siaPermitExpiry: Date | null = null;
  if (hasA && hasB) siaPermitExpiry = a!.getTime() <= effectiveB!.getTime() ? a! : effectiveB!;
  else if (hasA) siaPermitExpiry = a;
  else if (hasB) siaPermitExpiry = effectiveB;

  return { siaPermitExpiry, siaPermitType };
}

// 必修 1（Opus 驗收第三輪）：讀取層（`withDerivedGuard()`／`withDerived()`，
// 見 src/app/api/guards/[id]/route.ts、src/app/api/guards/route.ts）、
// `scripts/db/recompute-permit-derived.ts`、寫入層（`PATCH`／`POST
// /api/guards*`）三處都要判斷「呢一刻可唔可以用
// `deriveSiaPermitExpiry()` 嘅結果覆蓋 DB／response 現有嘅
// `sia_permit_expiry`／`sia_permit_type`」——抽做呢一個共用函數，三處 call
// 同一份邏輯，避免各自抄一次、漏咗一層（第二輪驗收讀取層／script 已經
// 加咗安全閥，但 PATCH 寫入層完全冇——見
// src/app/api/guards/[id]/route.ts PATCH「WP-STAFFNO：body 改咗甲／乙
// 到期日或者出生日期」嗰段，原本 `DERIVED_INPUT_KEYS.some()` 一撞中就
// 無條件寫，冇檢查merge 之後係咪 a／b 兩個都 null）。
//
// 規則：a／b 兩個都 null（冇任何一個有值）嘅時候，`deriveSiaPermitExpiry()`
// 一定計出 {null,null}——呢個結果冇資訊性，唔可以攞嚟覆蓋舊值（可能係
// migration backfill 唔到、或者人手都未補嘅舊資料，見
// prisma/migrations/20260919064514_wp_staffno/migration.sql「(1)」大
// 註解），一律 return false（call site 要保留現值，唔寫／唔覆蓋）。
// 例外：`hadValueBefore=true`——即係呢個「兩個都 null」嘅狀態本身係
// 啱啱由「a 或 b 原本有值」轉變過嚟（用戶今次 PATCH 明確將原本有值嘅
// a／b 清空），呢種情況先 return true（等 call site 用 null 覆蓋，反映
// 用戶明確嘅清空操作）。淨係寫入層先會傳 `hadValueBefore`——讀取層／
// script 冇「之前」呢個概念（冧睇緊嗰一刻嘅 row 本身），一律用 default
// `false`，同現有行為一致。
export function canOverrideDerivedSiaPermit(input: {
  siaPermitAExpiry: Date | null;
  siaPermitBExpiry: Date | null;
  hadValueBefore?: boolean;
}): boolean {
  if (input.siaPermitAExpiry != null || input.siaPermitBExpiry != null) return true;
  return input.hadValueBefore === true;
}

// 必修 4（Opus 驗收第三輪）：乙類牌照因為滿 70 歲法定失效——
// `deriveSiaPermitExpiry()` 呢種情況會令 `siaPermitType`／
// `siaPermitExpiry` 都變 null，同「完全冇填任何牌照」喺 response 層面
// 睇落一模一樣，列表 pill／抽屜就會誤顯示做「未填」（用戶會以為淨係未
// 補資料，睇唔出其實係「呢張證已經因為年齡冇得再用」）。呢個 helper
// 淨係判斷「乙類本身呢一刻係咪因為年齡失效」，俾 route 層加落 response
// 做一個獨立、結構安全（唔係 PII）嘅 flag（`sia_permit_b_lapsed_by_age`），
// UI 靠呢個 flag 分開顯示。唔理有冇甲類（甲類獨立計，唔受呢個 flag
// 影響——就算甲類仲有效，乙類本身一樣可以已經失效）。
export function isSiaPermitBLapsedByAge(input: DeriveSiaPermitInput, now: Date = new Date()): boolean {
  if (input.siaPermitBExpiry == null || input.dateOfBirth == null) return false;
  return ageAsOfHk(input.dateOfBirth, now) >= 70;
}
