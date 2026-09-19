// WP-STAFFNO（老闆 2026-09-19 拍板）：員工編號獨立表（方案 B）＋保安牌照
// 甲／乙類到期日分開存嘅共用邏輯。
//
// 員工編號並存唔取代：U＝去 Wilson 盤做散工必須有；MP＝去第二間公司嘅
// 盤做散工用；MG＝轉咗長工；MW 意思未確認（老闆仲未答）。同一人可以
// 同時有 U／MP／MG；同一種入面亦可能有多個號（臨時號→正式號、離職再
// 入職攞新號）——舊號存底但摺埋（status=former）。仲未答：邊個盤顯示
// 邊種號、轉長工後 U／MP 係咪繼續有效、MW 係咩——`scheme` 刻意用
// String（1-4 位大寫英文字母，呢度 zod-style regex 管，唔用 Prisma
// enum），將來加新種類唔使 migration。
//
// 呢個檔案兩組函數：
//   1. `upsertCurrentStaffNumber()`／`syncLegacyStaffNoColumns()`／
//      `applyLegacyStaffNoPatch()`——員工編號寫入嘅核心邏輯，俾
//      `POST /api/guards/:id/staff-numbers`、`PATCH /api/guards/:id`
//      （舊寫法）、seed script 共用。
//   2. `deriveSiaPermitExpiry()`——SIA 牌照甲／乙類到期日 →
//      衍生 `sia_permit_expiry`／`sia_permit_type`。
import type { Prisma, GuardStaffNumber } from "@prisma/client";
import { BadRequest, Conflict } from "../api/errors";
import { todayLocalStr, hkDayStartUtc } from "../ui/format";
import { writeAudit } from "../audit";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// 員工編號（guard_staff_numbers）
// ---------------------------------------------------------------------------

/** scheme 格式：1-4 位大寫英文字母。已知 U／MP／MG／MW，但呢度刻意唔用
 * 寫死 enum——將來加新種類（例如老闆答咗 MW 係咩、或者第三間公司又有
 * 新代號）淨係改 UI 下拉，唔使 migration。 */
export const STAFF_NUMBER_SCHEME_RE = /^[A-Z]{1,4}$/;

export function normalizeStaffNumber(raw: string): string {
  return raw.trim().toUpperCase();
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

function hkToday(now: Date = new Date()): Date {
  return hkDayStartUtc(todayLocalStr(now));
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
}

export interface UpsertStaffNumberResult {
  created: GuardStaffNumber;
  /** 冇 → null；有 → 舊嗰行轉 former 前後嘅完整 row（俾 call site 一齊
   * 寫 audit_log，並且喺 response 講明「舊 XX 號已經轉咗做舊號」）。 */
  convertedFormer: { before: GuardStaffNumber; after: GuardStaffNumber } | null;
}

/** `POST /api/guards/:id/staff-numbers` 同「PATCH /api/guards/:id 舊
 * 寫法」共用嘅核心 upsert 邏輯——起一行新 current；如果同一個 guard 同
 * 一個 scheme 已經有 current，就將舊嗰行自動轉 `former`（`validTo`＝今日
 * HK）；`number` 已經被（任何，包括自己）guard 用緊就 409（唔回姓名，
 * 淨係回邊個 guard_id，見 `src/lib/api/errors.ts` `ApiError.details`）。
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
  if (!number.startsWith(scheme)) {
    throw BadRequest(`number 要以 scheme 開頭（${scheme}）：${number}`);
  }

  const conflictingRow = await tx.guardStaffNumber.findUnique({ where: { number } });
  if (conflictingRow) {
    throw Conflict("呢個工號已經有人用緊", { guard_id: conflictingRow.guardId });
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

/** `guards.staff_no`／`staff_no_mw`（舊欄，保留做同步顯示值）由呢個函數
 * 由新表現狀重算：`staff_no`＝現用 **U**（冇就 null）；`staff_no_mw`＝
 * 現用 **MG**（冇就 MW，再冇就 null）。任何員工編號增／改／轉舊號之後
 * 都要喺同一個 transaction 內尾 call 呢個函數，等兩邊唔會唔一致——更表
 * 編輯器／匯出 Excel／報表／`ai.guards` view／seed gate 全部繼續讀
 * 呢兩個舊欄，唔使改。 */
export async function syncLegacyStaffNoColumns(tx: Tx, guardId: string): Promise<void> {
  const currentRows = await tx.guardStaffNumber.findMany({ where: { guardId, status: "current" } });
  const uRow = currentRows.find((r) => r.scheme === "U");
  const mgRow = currentRows.find((r) => r.scheme === "MG");
  const mwRow = currentRows.find((r) => r.scheme === "MW");
  await tx.guard.update({
    where: { id: guardId },
    data: {
      staffNo: uRow?.number ?? null,
      staffNoMw: mgRow?.number ?? mwRow?.number ?? null,
    },
  });
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
  params: { guardId: string; staffNo?: string | null; staffNoMw?: string | null; createdBy?: string | null; now?: Date },
): Promise<ApplyLegacyStaffNoPatchResult> {
  const { guardId, staffNo, staffNoMw, createdBy, now } = params;
  const changes: UpsertStaffNumberResult[] = [];
  if (staffNo) {
    const scheme = schemeFromNumber(staffNo);
    if (!scheme) throw BadRequest(`staff_no 格式推唔到 scheme（要以 1-4 位大寫英文字母開頭）：${staffNo}`);
    changes.push(await upsertCurrentStaffNumber(tx, { guardId, scheme, number: staffNo, source: "manual:legacy-patch(staff_no)", createdBy, now }));
  }
  if (staffNoMw) {
    const scheme = schemeFromNumber(staffNoMw);
    if (!scheme) throw BadRequest(`staff_no_mw 格式推唔到 scheme（要以 1-4 位大寫英文字母開頭）：${staffNoMw}`);
    changes.push(await upsertCurrentStaffNumber(tx, { guardId, scheme, number: staffNoMw, source: "manual:legacy-patch(staff_no_mw)", createdBy, now }));
  }
  if (changes.length) {
    await syncLegacyStaffNoColumns(tx, guardId);
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
