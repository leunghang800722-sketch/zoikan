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
import { normalizeTimeRange } from "./time-range";

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
  /** `shiftTypeTimeSlot(startTime,endTime)` 算出嚟嘅 "HHMM-HHMM"（冇齊
   * 開工／收工時間就 null）——Phase B-0：多過一個候選嗰陣用嚟同
   * `timeRaw` 正規化之後嘅值收窄。 */
  timeSlot: string | null;
}

export interface ShiftTypeMatchResult {
  id: string | null;
  ambiguous: boolean;
  /** ambiguous（或者候選 timeSlot 都冇一個啱）嗰陣，攞嚟砌 warning 俾
   * 會計睇到「候選有邊幾個」。淨係 matches.length>1 先會有值。 */
  candidateTimeSlots?: string[];
}

/** code→`shift_types`：按盤＋code 對照（時段呢個系統嘅 shift_types 一個
 * code 喺同一個盤入面可以對應幾個唔同 start_time 嘅行）。Phase A：搵到
 * 多過一個就當 ambiguous，唔亂估揀邊個。Phase B-0（老闆 8 月 748 格
 * ambiguous）：改為先試用 `timeRaw`（該行 Time 欄原文，經
 * `normalizeTimeRange()` 正規化做 "HHMM-HHMM"）同各候選嘅 `timeSlot`
 * 逐字比對收窄——一個命中就配、零個或者多過一個就保留 null＋
 * `candidateTimeSlots` 講明候選有邊幾個時段。淨係 shift／ot 兩種
 * code_kind 先做呢個對照——leave/marker/unknown 本身唔對應一個實際更別。 */
export function matchShiftType(
  rawCode: string,
  codeKind: CodeKind,
  siteId: string | null,
  timeRaw: string | null,
  candidates: readonly ShiftTypeCandidate[],
): ShiftTypeMatchResult {
  if (!siteId || (codeKind !== "shift" && codeKind !== "ot")) return { id: null, ambiguous: false };
  const norm = rawCode.trim().toUpperCase();
  const matches = candidates.filter((c) => c.siteId === siteId && c.code.trim().toUpperCase() === norm);
  if (matches.length === 0) return { id: null, ambiguous: false };
  if (matches.length === 1) return { id: matches[0]!.id, ambiguous: false };

  const normalizedTimeRaw = normalizeTimeRange(timeRaw);
  if (normalizedTimeRaw) {
    const narrowed = matches.filter((c) => c.timeSlot === normalizedTimeRaw);
    if (narrowed.length === 1) return { id: narrowed[0]!.id, ambiguous: false };
  }
  return { id: null, ambiguous: true, candidateTimeSlots: matches.map((c) => c.timeSlot ?? "（未設時段）") };
}

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
}

export interface GuardCandidate {
  id: string;
  nameZh: string;
}

/** `service.ts` 一次過查晒 DB 預先起好嘅對照索引——一個上載入面成千格
 * 記錄逐格 O(1) 查表，唔使逐行 await 查 DB。 */
export interface GuardMatchIndex {
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
  /** guardId → 現用（或者已取消 fallback）嘅 U 號顯示值（`guards.
   * staff_no`）——(a)「檔案工號 X 同系統工號 Y 唔一致」warning 用嚟攞
   * Y。 */
  staffNoByGuardId: ReadonlyMap<string, string | null>;
}

function nameTelKey(name: string, tel: string): string {
  return `${name}\u0000${tel}`;
}

export function buildGuardMatchIndex(rows: {
  guards: readonly (GuardCandidate & { tel: string | null; staffNo: string | null; staffNoMw: string | null })[];
  staffNumbers: readonly { number: string; guardId: string; status: string }[];
  phones: readonly { guardId: string; tel: string }[];
}): GuardMatchIndex {
  const byStaffNumber = new Map<string, { guardId: string; status: string }>();
  for (const sn of rows.staffNumbers) byStaffNumber.set(normalizeStaffNumber(sn.number), { guardId: sn.guardId, status: sn.status });

  const byLegacyStaffNo = new Map<string, string>();
  const staffNoByGuardId = new Map<string, string | null>();
  for (const g of rows.guards) {
    staffNoByGuardId.set(g.id, g.staffNo);
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

  return { byStaffNumber, byLegacyStaffNo, byName, byNameAndTel, staffNoByGuardId };
}

/** 安員配對：先 staff_no_raw（正規化，含已取消號——`byStaffNumber` 索引
 * 唔分 current/former，舊號都要搵到返個人），再 name＋tel，再淨靠
 * name（多於一個候選→ambiguous）。「唔准估」：淨係喺剩返一個候選先當
 * 啱，唔會揀「最似」嗰個。
 *
 * Phase B-0：加埋 (a)/(b) 兩個 flag（見 `GuardMatchResult` 註解）——
 * (b) staff_no 命中但嗰行 `status==='former'`；(a) 檔案帶咗 staff_no
 * 但完全搵唔到（current／former／legacy 三路都冇），退用姓名／電話先
 * 配到人。 */
export function matchGuard(
  params: { staffNoRaw: string | null; nameRaw: string | null; telRaw: string | null },
  index: GuardMatchIndex,
): GuardMatchResult {
  let staffNoProvidedButNotFound = false;
  if (params.staffNoRaw) {
    const normalized = normalizeStaffNumber(params.staffNoRaw);
    if (normalized) {
      const viaNumber = index.byStaffNumber.get(normalized);
      if (viaNumber) {
        return { guardId: viaNumber.guardId, guardMatch: "by_staff_no", matchedViaFormerStaffNo: viaNumber.status === "former", staffNoMismatch: false };
      }
      const viaLegacy = index.byLegacyStaffNo.get(normalized);
      if (viaLegacy) return { guardId: viaLegacy, guardMatch: "by_staff_no", matchedViaFormerStaffNo: false, staffNoMismatch: false };
      staffNoProvidedButNotFound = true;
    }
  }

  const name = params.nameRaw?.trim() || null;
  const tel = params.telRaw ? normalizeTel(params.telRaw) : null;

  if (name && tel) {
    const candidates = index.byNameAndTel.get(nameTelKey(name, tel)) ?? [];
    if (candidates.length === 1) {
      return { guardId: candidates[0]!, guardMatch: "by_name_tel", matchedViaFormerStaffNo: false, staffNoMismatch: staffNoProvidedButNotFound };
    }
    if (candidates.length > 1) return { guardId: null, guardMatch: "ambiguous", matchedViaFormerStaffNo: false, staffNoMismatch: false };
  }

  if (name) {
    const candidates = index.byName.get(name) ?? [];
    if (candidates.length === 1) {
      return { guardId: candidates[0]!, guardMatch: "by_name", matchedViaFormerStaffNo: false, staffNoMismatch: staffNoProvidedButNotFound };
    }
    if (candidates.length > 1) return { guardId: null, guardMatch: "ambiguous", matchedViaFormerStaffNo: false, staffNoMismatch: false };
  }

  return { guardId: null, guardMatch: "unmatched", matchedViaFormerStaffNo: false, staffNoMismatch: false };
}
