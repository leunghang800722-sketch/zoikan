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
//     UPDATE status）。所以 legacy 欄同步冇「former fallback 顯示歷史
//     值」呢個概念：primary 冧咗（例如刪走最後一個電話）就直接同步做
//     `null`，反映「而家一個電話都冇記錄」嘅真實狀態。
//   - 呢個檔案冚唪唥函數要喺 `prisma.$transaction()` 入面 call——「降級
//     舊 primary」＋「起新 primary」／「刪 primary＋自動升級下一個」
//     要原子性咁一齊成功或者一齊失敗，落完數記得喺同一個 tx 入面 call
//     `syncLegacyGuardContactColumns()`。
import type { Prisma, GuardPhone, GuardEmergencyContact, GuardAddress } from "@prisma/client";
import { BadRequest } from "../api/errors";
import { writeAudit } from "../audit";

type Tx = Prisma.TransactionClient;

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
  return { before: row, after, demoted };
}

export async function deleteGuardAddress(tx: Tx, guardId: string, addressId: string): Promise<DeleteResult<GuardAddress> | null> {
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

// ---------------------------------------------------------------------------
// legacy 欄同步——`guards.tel`／`address`／`emergency_contact_name`／
// `emergency_contact_tel` 呢四個舊欄而家係由三張新表現狀重算嘅**同步顯示
// 值**：`tel`＝primary phone（冇 phone 就 null）；`address`＝primary
// address（冇就 null）；`emergency_contact_name`／`_tel`＝`sort_order`
// 最細嗰個緊急聯絡人（冇就兩個都 null）。任何一張表增／改／刪之後都要
// 喺同一個 transaction 內尾 call 呢個函數，等 legacy 欄唔會唔一致——更表
// 編輯器／雞頭 DTO／搜尋／匯出／報表全部繼續讀呢四個舊欄，唔使改。
// ---------------------------------------------------------------------------
export async function syncLegacyGuardContactColumns(tx: Tx, guardId: string): Promise<void> {
  const [primaryPhone, primaryAddress, contacts] = await Promise.all([
    tx.guardPhone.findFirst({ where: { guardId, isPrimary: true } }),
    tx.guardAddress.findFirst({ where: { guardId, isPrimary: true } }),
    tx.guardEmergencyContact.findMany({ where: { guardId }, orderBy: { sortOrder: "asc" }, take: 1 }),
  ]);
  const representative = contacts[0] ?? null;
  await tx.guard.update({
    where: { id: guardId },
    data: {
      tel: primaryPhone?.tel ?? null,
      address: primaryAddress?.address ?? null,
      emergencyContactName: representative?.name ?? null,
      emergencyContactTel: representative?.tel ?? null,
    },
  });
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

  if (phone || addressResult || contact) {
    await syncLegacyGuardContactColumns(tx, guardId);
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
