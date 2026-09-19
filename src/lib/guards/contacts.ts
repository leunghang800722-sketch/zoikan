// WP-MULTI（老闆 2026-09-19 拍板「全部資料都要保留，唔好揀一個」）：
// 電話／緊急聯絡人／地址三張新子表（`guard_phones`／
// `guard_emergency_contacts`／`guard_addresses`）嘅核心邏輯——同
// `src/lib/guards/staff-numbers.ts`（WP-STAFFNO）一樣嘅「獨立子表＋
// legacy 欄自動同步」pattern。
//
// 業務規則（老闆 2026-09-19 拍板）：
//   1. 電話：有幾多個記幾多個（多值），一個主要（primary）。
//   2. 緊急聯絡人：有幾多個記幾多個（多值）。冇「主要」概念——用
//      `sort_order` 排先後，`guards.emergency_contact_name`／`_tel`
//      呢兩個舊欄嘅同步值＝`sort_order` 最細嗰行。
//   3. 地址（規劃師延伸，同一原則）：可以多個，一個主要。
//   4. 離職嘅人所有資料完整保留——三張表 FK 一律 `ON DELETE RESTRICT`
//      （唔准刪 guard 過手清走），呢個檔案本身冇任何「因為離職／作廢
//      就清空」嘅邏輯；DELETE（`deleteGuardPhone()`／
//      `deleteGuardAddress()`／`deleteGuardEmergencyContact()`）純粹俾
//      用戶自己更正打錯用（同 route 層 audit_log 留底），唔會被任何
//      自動流程觸發。
//
// 同 WP-STAFFNO 一致嘅設計取捨：
//   - 冇「former／已取消」呢個狀態（同員工編號唔同）——呢三張表嘅行
//     「存在」就代表「呢筆資料仲有效」，DELETE 真係刪走一行（唔係
//     UPDATE status）。
//
// Opus 覆核（規劃師拍板，同 WP-STAFFNO「已取消 fallback 顯示歷史值」
// 一致精神）：**legacy 欄（`guards.tel／address／emergency_contact_*`）
// 有值而子表冇對應行時，任何路徑都唔准將 legacy 值寫成 null 或者令佢
// 消失；髒資料唔可以鎖死成張表嘅儲存。**
//   - `syncLegacyGuardContactColumns()` 改做逐組判斷：子表有行（主要
//     行／代表行）→ 寫返同步值；子表 0 行 → 完全唔掂嗰組 legacy 欄
//     （唔會寫 null）——即使係「刪走最後一個電話」呢類令子表變 0 行嘅
//     動作，legacy `tel` 都會停留喺舊值（同 WP-STAFFNO 已取消號 fallback
//     顯示歷史值一致取態），唔會反映做「而家一個電話都冇」。
//   - 每次 call 要傳 `groups` 參數，明確講呢次操作影響邊組（`"tel"`／
//     `"address"`／`"emergency"`），淨係重算嗰組——唔會因為改咗電話而
//     連帶重算（甚至冧走）冇改過嗰組地址／緊急聯絡人嘅 legacy 值。
//   - 「自癒」（`healLegacyContactBeforeWrite()`）：任何子資源
//     create（`createGuardPhone()`／`createGuardAddress()`／
//     `createGuardEmergencyContact()`）之前，如果嗰個 guard 嗰組 legacy
//     欄有值但子表仲係 0 行（例如呢個 guard 舊資料一直冇行過任何一張
//     新表、或者之前俾人刪晒），就先將個 legacy 值搬一行入去（電話／
//     地址設做 primary，`source="backfill:legacy-on-write"`，值照搬
//     唔驗格式——同 migration 一致嘅「髒值照搬」取態），先至再做用戶
//     嗰個真正操作。等「加第二個電話」呢類動作唔會因為子表本身係空
//     而將原本嗰個（淨係存喺 legacy 欄嗰個）電話丟晒。
//
//   呢個檔案冚唪唥函數要喺 `prisma.$transaction()` 入面 call——「降級
//   舊 primary」＋「起新 primary」／「刪 primary＋自動升級下一個」要
//   原子性咁一齊成功或者一齊失敗，落完數記得喺同一個 tx 入面 call
//   `syncLegacyGuardContactColumns()`。
import type { Prisma, GuardPhone, GuardEmergencyContact, GuardAddress } from "@prisma/client";
import { BadRequest } from "../api/errors";
import { writeAudit } from "../audit";

type Tx = Prisma.TransactionClient;

/** `syncLegacyGuardContactColumns()`／自癒邏輯用嘅組別——一次操作淨係
 * 影響一組，唔會連累第二組。 */
export type LegacyContactGroup = "tel" | "address" | "emergency";

// ---------------------------------------------------------------------------
// 併發控制——刪除／設主要（會改變「邊行係 primary」呢個不變式）之前，
// 用 `SELECT … FOR UPDATE` 鎖住呢個 guard 本身一行，逼同一個 guard 嘅
// 電話／地址寫入一定序列化（Postgres row lock，等第二個 transaction 要
// 等第一個 commit 先可以開始），唔會兩個 transaction 同時各自見到
// 「得返一行、仲係 primary」而一齊唔做「升級下一行」嗰步，最終冧到
// 一個 primary 都冇。Prisma 冇高階 API 表達 `FOR UPDATE`，用
// `$queryRaw`——`guards.id` 係 TEXT（唔係 Postgres uuid 型別），直接
// tagged-template 參數化，Prisma 自動處理 `$1` 綁定，冇 SQL injection
// 風險。
// ---------------------------------------------------------------------------
async function lockGuardRowForContactWrite(tx: Tx, guardId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM guards WHERE id = ${guardId} FOR UPDATE`;
}

/** 鎖咗之後嘅保險網：呢個 guard 電話有 ≥1 行就一定要有一個 primary——
 * 理論上唔應該行到呢度先執行（DB 有 partial unique index
 * `guard_phones_guard_id_primary_key` 擋多過一個 primary；`deleteGuard
 * Phone()`/`setPrimaryGuardPhone()` 本身邏輯亦已經保證少一個primary
 * 就自動升級），純粹 defense-in-depth——真係執行到就升最舊
 * （`createdAt` asc）嗰行做 primary。 */
async function reconcilePrimaryPhoneInvariant(tx: Tx, guardId: string): Promise<void> {
  const rows = await tx.guardPhone.findMany({ where: { guardId }, orderBy: { createdAt: "asc" } });
  if (rows.length === 0) return;
  if (rows.some((r) => r.isPrimary)) return;
  await tx.guardPhone.update({ where: { id: rows[0]!.id }, data: { isPrimary: true } });
}

async function reconcilePrimaryAddressInvariant(tx: Tx, guardId: string): Promise<void> {
  const rows = await tx.guardAddress.findMany({ where: { guardId }, orderBy: { createdAt: "asc" } });
  if (rows.length === 0) return;
  if (rows.some((r) => r.isPrimary)) return;
  await tx.guardAddress.update({ where: { id: rows[0]!.id }, data: { isPrimary: true } });
}

// ---------------------------------------------------------------------------
// 自癒——任何子資源 create 之前，如果呢個 guard 嗰組 legacy 欄有值但子
// 表 0 行，先將個 legacy 值搬一行入去（見檔案頂註解）。
// ---------------------------------------------------------------------------
async function healLegacyContactBeforeWrite(tx: Tx, guardId: string, group: LegacyContactGroup, createdBy: string | null): Promise<void> {
  const guard = await tx.guard.findUnique({
    where: { id: guardId },
    select: { tel: true, address: true, emergencyContactName: true, emergencyContactTel: true },
  });
  if (!guard) return;

  if (group === "tel") {
    if (!guard.tel || !guard.tel.trim()) return;
    const count = await tx.guardPhone.count({ where: { guardId } });
    if (count > 0) return;
    await tx.guardPhone.create({
      data: { guardId, tel: guard.tel.trim(), isPrimary: true, source: "backfill:legacy-on-write", createdBy },
    });
    return;
  }
  if (group === "address") {
    if (!guard.address || !guard.address.trim()) return;
    const count = await tx.guardAddress.count({ where: { guardId } });
    if (count > 0) return;
    await tx.guardAddress.create({
      data: { guardId, address: guard.address.trim(), isPrimary: true, source: "backfill:legacy-on-write", createdBy },
    });
    return;
  }
  // group === "emergency"
  const hasName = !!(guard.emergencyContactName && guard.emergencyContactName.trim());
  const hasTel = !!(guard.emergencyContactTel && guard.emergencyContactTel.trim());
  if (!hasName && !hasTel) return;
  const count = await tx.guardEmergencyContact.count({ where: { guardId } });
  if (count > 0) return;
  await tx.guardEmergencyContact.create({
    data: {
      guardId,
      name: hasName ? guard.emergencyContactName!.trim() : null,
      tel: hasTel ? guard.emergencyContactTel!.trim() : null,
      sortOrder: 0,
      source: "backfill:legacy-on-write",
      createdBy,
    },
  });
}

// ---------------------------------------------------------------------------
// 電話（guard_phones）
// ---------------------------------------------------------------------------

/** 正規化：去空白／連字符（`\s`／`-`），同 `staff-numbers.ts
 * normalizeStaffNumber()` 一致嘅簡單字符類 replace 手法。 */
export function normalizeTel(raw: string): string {
  return raw.replace(/[\s-]+/g, "");
}

// 8 位香港號（純數字）或者 `+` 開頭國際號——正規化之後統一用呢條 regex
// 驗證：`+` 選填，跟住 7-15 位數字（8 位香港號自然喺呢個範圍入面，唔使
// 分兩條 regex）。
export const TEL_RE = /^\+?[0-9]{7,15}$/;

export function isValidTel(tel: string): boolean {
  return TEL_RE.test(tel);
}

export interface CreateGuardPhoneInput {
  guardId: string;
  tel: string;
  label?: string | null;
  isPrimary?: boolean;
  note?: string | null;
  source?: string | null;
  createdBy?: string | null;
}

export interface CreateGuardPhoneResult {
  created: GuardPhone;
  demotedPrimary: { before: GuardPhone; after: GuardPhone } | null;
}

/** 新增一個電話。第一個電話（呢個 guard 而家一行都冇）**強制**變成
 * primary（唔理 `input.isPrimary` 傳咩）——保證「有電話就實有一個
 * primary」，`syncLegacyGuardContactColumns()` 先有嘢好同步落
 * `guards.tel`。第二個之後跟 `input.isPrimary`（default false）；如果
 * 要求 true，原本嗰行 primary 自動降級（同一 transaction，partial
 * unique index `guard_phones_guard_id_primary_key` 保證唔會兩行一齊
 * true）。`UNIQUE(guard_id, tel)`——呢個 constraint 本身只限「同一個
 * guard」（跨 guard 唔受限，兩個唔同人可以有相同電話，例如屋企共用一線）。
 *
 * M（實測揭發）：呢個 constraint 撞到嘅**唯一**情況就係「同一個 guard
 * 已經記錄咗呢個電話」——冇任何「跨 guard」撞號嘅可能（同
 * `upsertCurrentStaffNumber()` 個 number 全表 unique 唔同層次）。呢種
 * 情況唔應該當「衝突」（409）：`applyLegacyGuardContactPatch()`（legacy
 * PATCH /api/guards/:id 舊寫法）「值冇變就當冇改」個判斷只係比對緊
 * `before.tel`（現時 primary），但呢個 guard 可能重複記過一個而家已經
 * 唔係 primary 嘅舊電話（例如人手改返 `guards.tel` 之後、`guard_
 * phones` 冇跟住清——見 tests/e2e/pii.spec.ts (e) finally 用 raw
 * `prisma.guard.update()` 還原、唔清 `guard_phones` 呢類場景），或者
 * 用戶淨係想將一個已經記錄過嘅舊電話搵返做 primary。改做**冪等**：
 * 撞到自己已經有嘅同一個電話 → 當「呢個電話已經存在」，`wantPrimary`
 * 就直接設做 primary（同 `setPrimaryGuardPhone()` 一致邏輯），唔重新
 * INSERT，亦唔 throw；純粹「新增」語意先兜返嚟一個已存在嘅結果。 */
export async function createGuardPhone(tx: Tx, input: CreateGuardPhoneInput): Promise<CreateGuardPhoneResult> {
  const tel = normalizeTel(input.tel);
  if (!isValidTel(tel)) {
    throw BadRequest(`電話格式唔啱（正規化後要係 7-15 位數字，可以 + 開頭）：${tel}`);
  }
  await lockGuardRowForContactWrite(tx, input.guardId);
  // 自癒：加電話之前，如果呢個 guard 嘅 legacy `tel` 有值但 `guard_
  // phones` 仲係 0 行，先將個 legacy 值搬一行入去（設做 primary）——
  // 唔係就下面 `existingCount === 0` 會將「今次新加嗰個」錯誤咁當第一
  // 個電話變 primary，原本記喺 legacy 欄嗰個電話會冇晒行、彈唔返（見
  // 檔案頂註解）。
  await healLegacyContactBeforeWrite(tx, input.guardId, "tel", input.createdBy ?? null);
  const existingCount = await tx.guardPhone.count({ where: { guardId: input.guardId } });
  const wantPrimary = existingCount === 0 ? true : !!input.isPrimary;

  const dup = await tx.guardPhone.findUnique({ where: { guardId_tel: { guardId: input.guardId, tel } } });
  if (dup) {
    if (wantPrimary && !dup.isPrimary) {
      const promoted = await setPrimaryGuardPhone(tx, input.guardId, dup.id);
      return { created: promoted?.after ?? dup, demotedPrimary: promoted?.demoted ?? null };
    }
    return { created: dup, demotedPrimary: null };
  }

  let demotedPrimary: { before: GuardPhone; after: GuardPhone } | null = null;
  if (wantPrimary) {
    const existingPrimary = await tx.guardPhone.findFirst({ where: { guardId: input.guardId, isPrimary: true } });
    if (existingPrimary) {
      const after = await tx.guardPhone.update({ where: { id: existingPrimary.id }, data: { isPrimary: false } });
      demotedPrimary = { before: existingPrimary, after };
    }
  }

  const created = await tx.guardPhone.create({
    data: {
      guardId: input.guardId,
      tel,
      label: input.label ?? null,
      isPrimary: wantPrimary,
      note: input.note ?? null,
      source: input.source ?? "manual",
      createdBy: input.createdBy ?? null,
    },
  });
  return { created, demotedPrimary };
}

export interface SetPrimaryResult<T> {
  before: T;
  after: T;
  demoted: { before: T; after: T } | null;
}

/** 將一行電話設做 primary——原本嗰行 primary（如果有）自動降級。已經係
 * primary 就 no-op（`demoted=null`，`before===after`）。 */
export async function setPrimaryGuardPhone(tx: Tx, guardId: string, phoneId: string): Promise<SetPrimaryResult<GuardPhone> | null> {
  await lockGuardRowForContactWrite(tx, guardId);
  const row = await tx.guardPhone.findFirst({ where: { id: phoneId, guardId } });
  if (!row) return null;
  if (row.isPrimary) return { before: row, after: row, demoted: null };
  const existingPrimary = await tx.guardPhone.findFirst({ where: { guardId, isPrimary: true } });
  let demoted: { before: GuardPhone; after: GuardPhone } | null = null;
  if (existingPrimary) {
    const after = await tx.guardPhone.update({ where: { id: existingPrimary.id }, data: { isPrimary: false } });
    demoted = { before: existingPrimary, after };
  }
  const after = await tx.guardPhone.update({ where: { id: row.id }, data: { isPrimary: true } });
  await reconcilePrimaryPhoneInvariant(tx, guardId);
  return { before: row, after, demoted };
}

export interface DeleteResult<T> {
  deleted: T;
  promoted: { before: T; after: T } | null;
}

/** DELETE 係俾更正打錯用——刪走一行電話；如果刪嘅係 primary，自動升返
 * 最舊（`createdAt` asc）嗰行做新 primary（保證剩返嘅電話一定有一個
 * primary）。冇剩返任何電話就自然冇 primary，
 * `syncLegacyGuardContactColumns()` 會將 `guards.tel` 同步做 `null`
 * （反映「呢個人而家一個電話都冇記錄」嘅真實狀態——呢張表冇「已取消」
 * 呢個狀態，刪咗就係冇咗，冇歷史好 fallback，同 WP-STAFFNO 員工編號嘅
 * 「已取消號 fallback 顯示歷史值」唔同，見呢個檔案頂註解）。 */
export async function deleteGuardPhone(tx: Tx, guardId: string, phoneId: string): Promise<DeleteResult<GuardPhone> | null> {
  await lockGuardRowForContactWrite(tx, guardId);
  const row = await tx.guardPhone.findFirst({ where: { id: phoneId, guardId } });
  if (!row) return null;
  await tx.guardPhone.delete({ where: { id: row.id } });
  let promoted: { before: GuardPhone; after: GuardPhone } | null = null;
  if (row.isPrimary) {
    const next = await tx.guardPhone.findFirst({ where: { guardId }, orderBy: { createdAt: "asc" } });
    if (next) {
      const after = await tx.guardPhone.update({ where: { id: next.id }, data: { isPrimary: true } });
      promoted = { before: next, after };
    }
  }
  await reconcilePrimaryPhoneInvariant(tx, guardId);
  return { deleted: row, promoted };
}

// ---------------------------------------------------------------------------
// 地址（guard_addresses）——同電話一致嘅 primary 手法，冇格式驗證（地址
// 自由文字，冧格式），淨係唔准空白。
// ---------------------------------------------------------------------------

export interface CreateGuardAddressInput {
  guardId: string;
  address: string;
  isPrimary?: boolean;
  note?: string | null;
  source?: string | null;
  createdBy?: string | null;
}

export interface CreateGuardAddressResult {
  created: GuardAddress;
  demotedPrimary: { before: GuardAddress; after: GuardAddress } | null;
}

export async function createGuardAddress(tx: Tx, input: CreateGuardAddressInput): Promise<CreateGuardAddressResult> {
  const address = input.address.trim();
  if (!address) throw BadRequest("地址唔可以係空白");
  await lockGuardRowForContactWrite(tx, input.guardId);
  // 自癒——同 createGuardPhone() 一致理由。
  await healLegacyContactBeforeWrite(tx, input.guardId, "address", input.createdBy ?? null);
  const existingCount = await tx.guardAddress.count({ where: { guardId: input.guardId } });
  const wantPrimary = existingCount === 0 ? true : !!input.isPrimary;

  let demotedPrimary: { before: GuardAddress; after: GuardAddress } | null = null;
  if (wantPrimary) {
    const existingPrimary = await tx.guardAddress.findFirst({ where: { guardId: input.guardId, isPrimary: true } });
    if (existingPrimary) {
      const after = await tx.guardAddress.update({ where: { id: existingPrimary.id }, data: { isPrimary: false } });
      demotedPrimary = { before: existingPrimary, after };
    }
  }

  const created = await tx.guardAddress.create({
    data: {
      guardId: input.guardId,
      address,
      isPrimary: wantPrimary,
      note: input.note ?? null,
      source: input.source ?? "manual",
      createdBy: input.createdBy ?? null,
    },
  });
  return { created, demotedPrimary };
}

export async function setPrimaryGuardAddress(tx: Tx, guardId: string, addressId: string): Promise<SetPrimaryResult<GuardAddress> | null> {
  await lockGuardRowForContactWrite(tx, guardId);
  const row = await tx.guardAddress.findFirst({ where: { id: addressId, guardId } });
  if (!row) return null;
  if (row.isPrimary) return { before: row, after: row, demoted: null };
  const existingPrimary = await tx.guardAddress.findFirst({ where: { guardId, isPrimary: true } });
  let demoted: { before: GuardAddress; after: GuardAddress } | null = null;
  if (existingPrimary) {
    const after = await tx.guardAddress.update({ where: { id: existingPrimary.id }, data: { isPrimary: false } });
    demoted = { before: existingPrimary, after };
  }
  const after = await tx.guardAddress.update({ where: { id: row.id }, data: { isPrimary: true } });
  await reconcilePrimaryAddressInvariant(tx, guardId);
  return { before: row, after, demoted };
}

export async function deleteGuardAddress(tx: Tx, guardId: string, addressId: string): Promise<DeleteResult<GuardAddress> | null> {
  await lockGuardRowForContactWrite(tx, guardId);
  const row = await tx.guardAddress.findFirst({ where: { id: addressId, guardId } });
  if (!row) return null;
  await tx.guardAddress.delete({ where: { id: row.id } });
  let promoted: { before: GuardAddress; after: GuardAddress } | null = null;
  if (row.isPrimary) {
    const next = await tx.guardAddress.findFirst({ where: { guardId }, orderBy: { createdAt: "asc" } });
    if (next) {
      const after = await tx.guardAddress.update({ where: { id: next.id }, data: { isPrimary: true } });
      promoted = { before: next, after };
    }
  }
  await reconcilePrimaryAddressInvariant(tx, guardId);
  return { deleted: row, promoted };
}

// ---------------------------------------------------------------------------
// 緊急聯絡人（guard_emergency_contacts）——冇「主要」概念，用
// `sort_order` 排先後（細嗰個排先）；`name`／`tel` 唔可以同時空（同 DB
// CHECK constraint 一致，呢度應用層先驗一次，錯誤訊息清楚啲，唔使等
// Postgres 拋 constraint violation）。
// ---------------------------------------------------------------------------

export interface CreateGuardEmergencyContactInput {
  guardId: string;
  name?: string | null;
  tel?: string | null;
  relationship?: string | null;
  sortOrder?: number;
  note?: string | null;
  source?: string | null;
  createdBy?: string | null;
}

function assertNameOrTel(name: string | null | undefined, tel: string | null | undefined): void {
  const hasName = !!(name && name.trim());
  const hasTel = !!(tel && tel.trim());
  if (!hasName && !hasTel) throw BadRequest("姓名／電話唔可以同時空白（至少填一樣）");
}

/** 新增一個緊急聯絡人——冇傳 `sort_order` 就自動排喺尾（呢個 guard 現有
 * 最大 `sort_order` + 1，冇任何行就 0）。 */
export async function createGuardEmergencyContact(tx: Tx, input: CreateGuardEmergencyContactInput): Promise<GuardEmergencyContact> {
  const name = input.name?.trim() || null;
  const tel = input.tel?.trim() || null;
  assertNameOrTel(name, tel);
  // 自癒——同 createGuardPhone() 一致理由：加緊急聯絡人之前，如果
  // legacy `emergency_contact_name`／`_tel` 有值但子表仲係 0 行，先將
  // 個 legacy 值搬做代表行（`sort_order=0`），等佢唔會因為子表原本係
  // 空而冧走。
  await healLegacyContactBeforeWrite(tx, input.guardId, "emergency", input.createdBy ?? null);
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const maxRow = await tx.guardEmergencyContact.findFirst({ where: { guardId: input.guardId }, orderBy: { sortOrder: "desc" } });
    sortOrder = maxRow ? maxRow.sortOrder + 1 : 0;
  }
  return tx.guardEmergencyContact.create({
    data: {
      guardId: input.guardId,
      name,
      tel,
      relationship: input.relationship ?? null,
      sortOrder,
      note: input.note ?? null,
      source: input.source ?? "manual",
      createdBy: input.createdBy ?? null,
    },
  });
}

export interface UpdateGuardEmergencyContactInput {
  name?: string | null;
  tel?: string | null;
  relationship?: string | null;
  sortOrder?: number;
  note?: string | null;
}

export async function updateGuardEmergencyContact(
  tx: Tx,
  guardId: string,
  contactId: string,
  input: UpdateGuardEmergencyContactInput,
): Promise<{ before: GuardEmergencyContact; after: GuardEmergencyContact } | null> {
  const row = await tx.guardEmergencyContact.findFirst({ where: { id: contactId, guardId } });
  if (!row) return null;
  const nextName = input.name !== undefined ? input.name?.trim() || null : row.name;
  const nextTel = input.tel !== undefined ? input.tel?.trim() || null : row.tel;
  assertNameOrTel(nextName, nextTel);
  const data: Prisma.GuardEmergencyContactUpdateInput = {};
  if (input.name !== undefined) data.name = nextName;
  if (input.tel !== undefined) data.tel = nextTel;
  if (input.relationship !== undefined) data.relationship = input.relationship;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.note !== undefined) data.note = input.note;
  if (Object.keys(data).length === 0) return { before: row, after: row };
  const after = await tx.guardEmergencyContact.update({ where: { id: row.id }, data });
  return { before: row, after };
}

export async function deleteGuardEmergencyContact(tx: Tx, guardId: string, contactId: string): Promise<GuardEmergencyContact | null> {
  const row = await tx.guardEmergencyContact.findFirst({ where: { id: contactId, guardId } });
  if (!row) return null;
  await tx.guardEmergencyContact.delete({ where: { id: row.id } });
  return row;
}

/** 加單一端點 `PUT /api/guards/:id/emergency-contacts/order`
 * 用——一個 transaction 重寫成個 guard 全部緊急聯絡人嘅 `sort_order`
 * （0-based，跟 `orderedIds` 陣列順序）。`orderedIds` 一定要啱啱好等於
 * 呢個 guard 現有全部行（唔准漏、唔准多、唔准夾雜其他 guard 嘅 id）
 * ——唔係嘅話 400，避免手快打錯令某一行走失咗個 sort_order 對應。 */
export async function reorderGuardEmergencyContacts(tx: Tx, guardId: string, orderedIds: string[]): Promise<GuardEmergencyContact[]> {
  const rows = await tx.guardEmergencyContact.findMany({ where: { guardId } });
  const rowIds = new Set(rows.map((r) => r.id));
  const uniqueOrderedIds = new Set(orderedIds);
  if (orderedIds.length !== rows.length || uniqueOrderedIds.size !== orderedIds.length || orderedIds.some((id) => !rowIds.has(id))) {
    throw BadRequest("id 陣列要啱啱好包含呢個保安員全部緊急聯絡人（唔可以多、少、重複或者帶第啲人嘅 id）");
  }
  const updated: GuardEmergencyContact[] = [];
  for (let i = 0; i < orderedIds.length; i++) {
    updated.push(await tx.guardEmergencyContact.update({ where: { id: orderedIds[i]! }, data: { sortOrder: i } }));
  }
  return updated.sort((a, b) => a.sortOrder - b.sortOrder);
}

// ---------------------------------------------------------------------------
// legacy 欄同步——`guards.tel`／`address`／`emergency_contact_name`／
// `emergency_contact_tel` 呢四個舊欄而家係由三張新表現狀重算嘅**同步顯示
// 值**：`tel`＝primary phone；`address`＝primary address；
// `emergency_contact_name`／`_tel`＝`sort_order` 最細嗰個緊急聯絡人。
//
// Opus 覆核：逐組判斷——`groups` 話呢次操作改咗邊組，淨係重算嗰組（冇
// 講嘅組唔會被連累重算）；每組入面，子表有行就寫返同步值，**子表 0
// 行就完全唔掂嗰組 legacy 欄**（唔寫 null）——保證「呢個 guard 一直都
// 有電話」呢類舊資料唔會因為子表一時 0 行（例如刪咗最後一行、或者呢
// 個 guard 仲未行過自癒）就俾人睇到個電話「唔見咗」。 */
export async function syncLegacyGuardContactColumns(tx: Tx, guardId: string, groups: readonly LegacyContactGroup[]): Promise<void> {
  const data: Prisma.GuardUpdateInput = {};

  if (groups.includes("tel")) {
    const primaryPhone = await tx.guardPhone.findFirst({ where: { guardId, isPrimary: true } });
    if (primaryPhone) data.tel = primaryPhone.tel;
    // 冇 primary（包括 0 行）——唔寫，保留 DB 原值。
  }
  if (groups.includes("address")) {
    const primaryAddress = await tx.guardAddress.findFirst({ where: { guardId, isPrimary: true } });
    if (primaryAddress) data.address = primaryAddress.address;
  }
  if (groups.includes("emergency")) {
    const contacts = await tx.guardEmergencyContact.findMany({ where: { guardId }, orderBy: { sortOrder: "asc" }, take: 1 });
    const representative = contacts[0] ?? null;
    if (representative) {
      data.emergencyContactName = representative.name;
      data.emergencyContactTel = representative.tel;
    }
  }

  if (Object.keys(data).length > 0) {
    await tx.guard.update({ where: { id: guardId }, data });
  }
}

// ---------------------------------------------------------------------------
// `PATCH /api/guards/:id` 舊寫法（body 帶 `tel`／`address`／
// `emergency_contact_name`／`emergency_contact_tel`）——轉做對新表嘅
// 「加一行並設為主要，原本嗰個保留做非主要」（電話／地址），或者「加一
// 個新嘅緊急聯絡人（`sort_order` 排最先，變成新嘅代表行）」（緊急聯絡
// 人，冇「主要」概念但效果一致：舊值唔會被覆蓋／消失，永遠可以喺分區
// 見返）。送空字串／`null`＝**唔刪任何行**（no-op，唔會觸發呢個函數任何
// 動作）——「想刪」要用專門嘅 DELETE 端點。
// ---------------------------------------------------------------------------

export interface ApplyLegacyContactPatchResult {
  phone: CreateGuardPhoneResult | null;
  address: CreateGuardAddressResult | null;
  contact: GuardEmergencyContact | null;
}

// M（同 WP-STAFFNO `applyLegacyStaffNoPatch()`/guards/[id]/route.ts 一致
// 理由）：call site（`PATCH /api/guards/:id`）撳「儲存」個 form 通常會
// 帶埋「未改」嘅 `tel`（GuardsClient.tsx `body.tel` 一律送，唔止改咗
// 先送）——如果呢度唔識「呢個值同而家記緊嘅 primary 一樣」，每次儲存
// （包括淨係改姓名呢類完全唔關電話事嘅編輯）都會嘗試起一行新
// `guard_phones`，撞正 `UNIQUE(guard_id, tel)` 變 409。所以 call site
// （route 層）要用 `before` 比對，值冇變就傳 `undefined`（見
// src/app/api/guards/[id]/route.ts），呢個函數收到嘅一律當「真係想
// 改」。
export async function applyLegacyGuardContactPatch(
  tx: Tx,
  params: {
    guardId: string;
    tel?: string | null;
    address?: string | null;
    emergencyContactName?: string | null;
    emergencyContactTel?: string | null;
    createdBy?: string | null;
  },
): Promise<ApplyLegacyContactPatchResult> {
  const { guardId, tel, address, emergencyContactName, emergencyContactTel, createdBy } = params;
  let phone: CreateGuardPhoneResult | null = null;
  let addressResult: CreateGuardAddressResult | null = null;
  let contact: GuardEmergencyContact | null = null;

  // 空字串／null／undefined 一律當「冇提供」，no-op（唔刪任何行）——
  // 淨係非空字串先觸發「加一行並設為主要」。
  if (tel && tel.trim()) {
    phone = await createGuardPhone(tx, { guardId, tel, isPrimary: true, source: "manual:legacy-patch(tel)", createdBy });
  }
  if (address && address.trim()) {
    addressResult = await createGuardAddress(tx, { guardId, address, isPrimary: true, source: "manual:legacy-patch(address)", createdBy });
  }
  if ((emergencyContactName && emergencyContactName.trim()) || (emergencyContactTel && emergencyContactTel.trim())) {
    // 自癒要喺呢度（call `createGuardEmergencyContact()` 之前）先做，
    // 唔可以淨係靠 `createGuardEmergencyContact()` 入面嗰次——落面
    // `minRow` 要睇「自癒完成之後」嘅狀態先計得啱「細過現有全部行」嘅
    // `sortOrder`；如果自癒喺 `createGuardEmergencyContact()` 入面先
    // 觸發，呢度 `minRow` 會用返自癒之前（0 行）嗰個狀態計出
    // `sortOrder=0`，同自癒剛巧起低嗰行（都係 `sortOrder=0`）撞成同一個
    // 值，代表行變咗睇唔準邊個先（DB 冇規定 tie 點排）。
    await healLegacyContactBeforeWrite(tx, guardId, "emergency", createdBy ?? null);
    // 「加一個新嘅緊急聯絡人，變成新嘅代表行」——`sort_order` 要細過現有
    // 全部行先會贏（`syncLegacyGuardContactColumns()` 揀 `sort_order` 最
    // 細嗰個），用「現有最細 - 1」（冇任何行就 0）。
    const minRow = await tx.guardEmergencyContact.findFirst({ where: { guardId }, orderBy: { sortOrder: "asc" } });
    const sortOrder = minRow ? minRow.sortOrder - 1 : 0;
    contact = await createGuardEmergencyContact(tx, {
      guardId,
      name: emergencyContactName,
      tel: emergencyContactTel,
      sortOrder,
      source: "manual:legacy-patch(emergency_contact)",
      createdBy,
    });
  }

  const groups: LegacyContactGroup[] = [];
  if (phone) groups.push("tel");
  if (addressResult) groups.push("address");
  if (contact) groups.push("emergency");
  if (groups.length > 0) {
    await syncLegacyGuardContactColumns(tx, guardId, groups);
  }
  return { phone, address: addressResult, contact };
}

/** `applyLegacyGuardContactPatch()` 之後寫 audit_log——同
 * `writeStaffNumberAudits()`（staff-numbers.ts）一致做法。 */
export async function writeLegacyContactAudits(
  actorUserId: string | null,
  result: ApplyLegacyContactPatchResult,
  ip: string | null,
): Promise<void> {
  if (result.phone) {
    await writeAudit({ actorUserId, tableName: "guard_phones", rowId: result.phone.created.id, action: "create", after: result.phone.created, ip });
    if (result.phone.demotedPrimary) {
      await writeAudit({
        actorUserId,
        tableName: "guard_phones",
        rowId: result.phone.demotedPrimary.after.id,
        action: "update",
        before: result.phone.demotedPrimary.before,
        after: result.phone.demotedPrimary.after,
        ip,
      });
    }
  }
  if (result.address) {
    await writeAudit({ actorUserId, tableName: "guard_addresses", rowId: result.address.created.id, action: "create", after: result.address.created, ip });
    if (result.address.demotedPrimary) {
      await writeAudit({
        actorUserId,
        tableName: "guard_addresses",
        rowId: result.address.demotedPrimary.after.id,
        action: "update",
        before: result.address.demotedPrimary.before,
        after: result.address.demotedPrimary.after,
        ip,
      });
    }
  }
  if (result.contact) {
    await writeAudit({ actorUserId, tableName: "guard_emergency_contacts", rowId: result.contact.id, action: "create", after: result.contact, ip });
  }
}
