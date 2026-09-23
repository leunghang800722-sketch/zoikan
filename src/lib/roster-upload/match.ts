// WP-ROSTER-UPLOAD Phase A（§15.3）：更表解析結果 → 現有主數據（盤／
// 更別／安員／雞頭）嘅對照。呢個檔案入面嘅函數全部**同步、純函數**——
// 對照用嘅候選名單（sites/brokers/shift_types/guards/guard_staff_
// numbers/guard_phones）由 `service.ts` 一次過查晒 DB 預先攞好先傳入
// 嚟，唔喺呢度逐行查 DB（一個上載可以有成千格記錄，逐行 await 查 DB
// 太慢，亦冇必要）。「對唔到→null＋warning，唔准估」——逐個對照函數
// 冧唔到就老實話 null，唔會揀個「睇落最似」嘅去湊。
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { normalizeTel } from "@/lib/guards/contacts";
import type { CodeKind } from "./cell-codes";

export interface SiteCandidate {
  id: string;
  canonicalName: string;
  aliases: string[];
}

/** 更表盤名→`sites`：canonical_name 完全相等（trim）優先，搵唔到再試
 * aliases（例如「怡安」→怡安168 呢類別名）。對唔到就 null——上載時盤名
 * 對唔到可以先存底，之後人手 PATCH 指定（`roster_uploads.site_id`
 * nullable 就係為咗呢個情況）。 */
export function matchSite(siteNameRaw: string | null, candidates: readonly SiteCandidate[]): string | null {
  if (!siteNameRaw) return null;
  const norm = siteNameRaw.trim();
  if (!norm) return null;
  const exact = candidates.find((s) => s.canonicalName.trim() === norm);
  if (exact) return exact.id;
  const byAlias = candidates.find((s) => s.aliases.some((a) => a.trim() === norm));
  return byAlias?.id ?? null;
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
}

/** code→`shift_types`：按盤＋code 對照（時段呢個系統嘅 shift_types 一個
 * code 喺同一個盤入面可以對應幾個唔同 start_time 嘅行——Phase A 冇原檔
 * 時段解析出嚟嘅絕對時間可以再收窄，搵到多過一個就當 ambiguous 處理，
 * 唔亂估揀邊個）。淨係 shift／ot 兩種 code_kind 先做呢個對照——leave/
 * marker/unknown 本身唔對應一個實際更別。 */
export function matchShiftType(rawCode: string, codeKind: CodeKind, siteId: string | null, candidates: readonly ShiftTypeCandidate[]): { id: string | null; ambiguous: boolean } {
  if (!siteId || (codeKind !== "shift" && codeKind !== "ot")) return { id: null, ambiguous: false };
  const norm = rawCode.trim().toUpperCase();
  const matches = candidates.filter((c) => c.siteId === siteId && c.code.trim().toUpperCase() === norm);
  if (matches.length === 1) return { id: matches[0]!.id, ambiguous: false };
  if (matches.length > 1) return { id: null, ambiguous: true };
  return { id: null, ambiguous: false };
}

export type GuardMatchKind = "by_staff_no" | "by_name_tel" | "by_name" | "unmatched" | "ambiguous";

export interface GuardMatchResult {
  guardId: string | null;
  guardMatch: GuardMatchKind;
}

export interface GuardCandidate {
  id: string;
  nameZh: string;
}

/** `service.ts` 一次過查晒 DB 預先起好嘅對照索引——一個上載入面成千格
 * 記錄逐格 O(1) 查表，唔使逐行 await 查 DB。 */
export interface GuardMatchIndex {
  /** 正規化工號（含 current／former，`guard_staff_numbers.number`）→ guardId。 */
  byStaffNumber: ReadonlyMap<string, string>;
  /** 正規化舊 staff_no／staff_no_mw（`guards` 表同步顯示值）→ guardId。 */
  byLegacyStaffNo: ReadonlyMap<string, string>;
  /** 姓名（`name_zh`）→ 呢個名嘅全部 guardId（同名可以多過一個，交俾
   * caller 判斷 ambiguous）。 */
  byName: ReadonlyMap<string, readonly string[]>;
  /** 姓名+正規化電話 → 呢個組合嘅全部 guardId（同時比對 `guards.tel`
   * 同 `guard_phones`——任何一個電話啱都算）。 */
  byNameAndTel: ReadonlyMap<string, readonly string[]>;
}

function nameTelKey(name: string, tel: string): string {
  return `${name}\u0000${tel}`;
}

export function buildGuardMatchIndex(rows: {
  guards: readonly (GuardCandidate & { tel: string | null; staffNo: string | null; staffNoMw: string | null })[];
  staffNumbers: readonly { number: string; guardId: string }[];
  phones: readonly { guardId: string; tel: string }[];
}): GuardMatchIndex {
  const byStaffNumber = new Map<string, string>();
  for (const sn of rows.staffNumbers) byStaffNumber.set(normalizeStaffNumber(sn.number), sn.guardId);

  const byLegacyStaffNo = new Map<string, string>();
  for (const g of rows.guards) {
    if (g.staffNo) byLegacyStaffNo.set(normalizeStaffNumber(g.staffNo), g.id);
    if (g.staffNoMw) byLegacyStaffNo.set(normalizeStaffNumber(g.staffNoMw), g.id);
  }

  const byName = new Map<string, string[]>();
  const byNameAndTel = new Map<string, string[]>();
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
  }

  return { byStaffNumber, byLegacyStaffNo, byName, byNameAndTel };
}

/** 安員配對：先 staff_no_raw（正規化，含已取消號——`byStaffNumber` 索引
 * 唔分 current/former，舊號都要搵到返個人），再 name＋tel，再淨靠
 * name（多於一個候選→ambiguous）。「唔准估」：淨係喺剩返一個候選先當
 * 啱，唔會揀「最似」嗰個。 */
export function matchGuard(
  params: { staffNoRaw: string | null; nameRaw: string | null; telRaw: string | null },
  index: GuardMatchIndex,
): GuardMatchResult {
  if (params.staffNoRaw) {
    const normalized = normalizeStaffNumber(params.staffNoRaw);
    if (normalized) {
      const viaNumber = index.byStaffNumber.get(normalized);
      if (viaNumber) return { guardId: viaNumber, guardMatch: "by_staff_no" };
      const viaLegacy = index.byLegacyStaffNo.get(normalized);
      if (viaLegacy) return { guardId: viaLegacy, guardMatch: "by_staff_no" };
    }
  }

  const name = params.nameRaw?.trim() || null;
  const tel = params.telRaw ? normalizeTel(params.telRaw) : null;

  if (name && tel) {
    const candidates = index.byNameAndTel.get(nameTelKey(name, tel)) ?? [];
    if (candidates.length === 1) return { guardId: candidates[0]!, guardMatch: "by_name_tel" };
    if (candidates.length > 1) return { guardId: null, guardMatch: "ambiguous" };
  }

  if (name) {
    const candidates = index.byName.get(name) ?? [];
    if (candidates.length === 1) return { guardId: candidates[0]!, guardMatch: "by_name" };
    if (candidates.length > 1) return { guardId: null, guardMatch: "ambiguous" };
  }

  return { guardId: null, guardMatch: "unmatched" };
}
