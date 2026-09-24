// WP-ROSTER-UPLOAD Phase B-1（§14.1 WP-ATTRIB／§15.3 分期）：對數引擎——
// 更表上載（`roster_upload_rows`，只計 `code_kind in (shift, ot, leave)`，
// `marker`/`unknown` 唔參與對數）vs 系統內已報更（`shift_records`，
// `status != cancelled`）。規則 11（§14）：更表檔案係糧單權威來源，對數
// 只係兩方比較——更表 vs 系統，對唔上嘅通知**會計**（唔係雞頭，雞頭連
// 呢個對數頁都見唔到，見 rbac/matrix.ts「更表上載」module）。
//
// 呢個檔案分兩層（同 `pricing/resolve-rate.ts` 嘅「fetch cards / resolve
// from cards」分層手法一致）：
//   1. `loadReconcileInput()`：**一個 DB loader**——攞晒呢個上載嘅 rows、
//      呢個（子）盤呢個月嘅 shift_records、結算單位 fallback 需要嘅
//      guard/broker 資料，喺呢一層做埋（B1-4）leave 行嘅 shift_type_id
//      推斷、（規則 8）結算單位 fallback 決定。
//   2. `reconcileRosterUpload()`：純函數——對住已經攞好嘅資料逐更配對＋
//      分類，冇任何 DB 依賴，單元測試主力測呢個。
//
// 逐更配對鍵＝(work_date, resolved_site_id ?? upload.site_id, guard_id,
// shift_type_id)（B1-8 第 5 項，B-0 §15.5 同一語意：對數用嘅盤同寫入
// shift_records.site_id 都係呢個「解析後實際盤」，唔係上載本身掛嘅
// site_id）。
import { prisma } from "@/lib/db";
import { monthStart as toMonthStart } from "@/lib/month-lock";
import { normalizeTimeRange, shiftTypeTimeSlot } from "./time-range";
import { createSettlementBrokerFallbackResolver } from "@/lib/pricing/settlement-broker-fallback";
import type { RosterUpload, RosterUploadRow, ShiftRecord } from "@prisma/client";

export type ReconcileCategory = "match" | "roster_only" | "system_only" | "guard_diff" | "settlement_diff" | "shift_type_diff" | "unresolved";

export const RECONCILE_CATEGORIES: readonly ReconcileCategory[] = [
  "match",
  "roster_only",
  "system_only",
  "guard_diff",
  "settlement_diff",
  "shift_type_diff",
  "unresolved",
] as const;

/** 逐更配對鍵——四個組件用 "|" 連埋（各組件本身係 uuid／YYYY-MM-DD，
 * 唔會撞 "|"）。`unresolved` 冇齊呢四個組件，唔用呢個 key（見
 * `buildUnresolvedKey()`）。 */
export function buildReconcileKey(parts: { workDate: string; siteId: string; guardId: string; shiftTypeId: string }): string {
  return `${parts.workDate}|${parts.siteId}|${parts.guardId}|${parts.shiftTypeId}`;
}

/** unresolved 行冇齊配對鍵四要素，用 `roster_upload_row.id` 做穩定 key
 * （前綴 `row:` 避免同上面嘅逐更 key 撞——上面嗰種一定含兩個 "|"，呢種
 * 唔含）。 */
export function buildUnresolvedKey(rowId: string): string {
  return `row:${rowId}`;
}

export interface ReconcileRosterEntry {
  rowId: string;
  workDate: string; // YYYY-MM-DD
  siteId: string;
  guardId: string;
  shiftTypeId: string;
  codeKind: "shift" | "ot" | "leave";
  rawCode: string;
  hours: number | null; // OT 小時
  /** codeKind=leave 先有值——原檔字面（RD/OFF/AL/SL/NL/NPL/SH），直接係
   * `LeaveCode` enum 嘅合法值（唔做 OFF→RD／NPL→NL 呢類歸一，見
   * `resolveLeaveInfo()` 頂註解解釋點解）。 */
  leaveCode: string | null;
  /** codeKind=leave 先可能有值——B1-4：呢行推斷出嚟嘅 shift_type_id 係
   * 靠「該行 Time 對到嘅更種」定「同一行其他日子」推斷出嚟（`true`），
   * 定係本身檔案就有配對到（`false`，理論上唔會發生，leave 行解析階段
   * 唔配 shift_type，見 match.ts `matchShiftType()`）。 */
  shiftTypeInferred: boolean;
  /** 規則 8：呢行嘅結算單位——雞頭碼有就 `brokers.code`（`inferred:
   * false`），冇雞頭碼欄嘅盤用 `resolveSettlementBrokerFallback()`
   * 補（`inferred:true`，要標「推算」俾會計覆核）。 */
  settlementBrokerId: string | null;
  settlementInferred: boolean;
}

export interface ReconcileUnresolvedEntry {
  rowId: string;
  workDate: string;
  siteId: string | null;
  guardId: string | null;
  shiftTypeId: string | null;
  codeKind: "shift" | "ot" | "leave";
  rawCode: string;
  reason: string;
}

export interface ReconcileSystemEntry {
  id: string;
  workDate: string;
  siteId: string;
  guardId: string;
  shiftTypeId: string;
  settlementBrokerId: string | null;
  operationalBrokerId: string | null;
  recordType: string;
  leaveCode: string | null;
  status: string;
  /** 糧明細來源標記（B1-7）——`shift_records.source`，宜家絕大部份現存
   * 記錄呢欄係 null（`batch/route.ts`／單筆 POST 之前冇寫過，見
   * B1-7 大註解），對數頁淨係原樣顯示、null 顯示做「未標記」，唔喺呢度
   * 估返一個值。 */
  source: string | null;
}

export interface ReconcileItem {
  key: string;
  category: ReconcileCategory;
  workDate: string;
  siteId: string | null;
  guardId: string | null;
  shiftTypeId: string | null;
  roster: ReconcileRosterEntry | null;
  system: ReconcileSystemEntry | null;
  unresolvedReason: string | null;
}

export interface ReconcileInput {
  upload: { id: string; siteId: string | null; month: Date };
  rosterEntries: ReconcileRosterEntry[];
  unresolvedEntries: ReconcileUnresolvedEntry[];
  systemEntries: ReconcileSystemEntry[];
}

/** 幫一組 id 揀「出現次數最多」嗰個（tie 揀先出現嗰個，`Map` 保留插入
 * 次序）——純粹輔助函數，唔係「估」，係喺已知嘅具體訊號（同一行、或者
 * 同一個安員喺呢張上載入面其他日子）入面揀最常見嗰個。 */
function majorityOf(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

interface LeaveShiftTypeCandidate {
  id: string;
  siteId: string;
  timeSlot: string | null;
}

/** B1-4：leave 行（`code_kind=leave`）解析階段（`match.ts
 * matchShiftType()`）唔會配 `shift_type_id`（leave 冇「更別代號」呢個
 * 概念），但 `shift_records` 一定要有 `shift_type_id`（unique key 嘅
 * 一部分）。呢個純函數負責幫每一行 leave 推斷返應該寫入邊個
 * shift_type_id，兩層訊號（唔估，兩層都搵唔到就 unresolved）：
 *   1.「該行 Time 對到嘅更種」——呢行本身 `time_raw` 正規化之後同呢個
 *      （子）盤某個 shift_type 嘅 `timeSlot` 啱好夾中一個（唔止一個就
 *      唔用，避免估錯）。
 *   2.「同一行（rowIndex）其他日子」——更表入面「一行」＝一個安員一個
 *      更別嘅一整行日子（`row_index` 相同），leave 格同正更格通常同一
 *      physical row，用嗰行入面其他 `shift`/`ot` 格配到嘅 shift_type_id
 *      多數票。
 * 任務書寫「該盤預設」——現有 schema／設定完全冇「呢個盤預設更別」呢個
 * 概念（冇欄位、冇 config），呢個 loader 唔會無中生有加一個（避免
 * 「自己假設」），淨係用上面兩層有具體訊號支持嘅推斷；兩層都推斷唔到
 * 就留返 unresolved，等人手覆核（回報會講呢個落差）。 */
export function resolveLeaveShiftTypeIds(
  rows: readonly { id: string; rowIndex: number; codeKind: string; shiftTypeId: string | null; timeRaw: string | null; effectiveSiteId: string | null }[],
  shiftTypeCandidates: readonly LeaveShiftTypeCandidate[],
): Map<string, { shiftTypeId: string | null; inferred: boolean }> {
  const byRowIndex = new Map<number, string[]>();
  for (const r of rows) {
    if ((r.codeKind === "shift" || r.codeKind === "ot") && r.shiftTypeId) {
      const list = byRowIndex.get(r.rowIndex) ?? [];
      list.push(r.shiftTypeId);
      byRowIndex.set(r.rowIndex, list);
    }
  }

  const result = new Map<string, { shiftTypeId: string | null; inferred: boolean }>();
  for (const r of rows) {
    if (r.codeKind !== "leave") continue;
    if (r.shiftTypeId) {
      result.set(r.id, { shiftTypeId: r.shiftTypeId, inferred: false });
      continue;
    }
    // 訊號 1：呢行 Time 啱好夾中呢個（子）盤淨一個 shift_type。
    const normTime = normalizeTimeRange(r.timeRaw);
    if (normTime && r.effectiveSiteId) {
      const timeMatches = shiftTypeCandidates.filter((c) => c.siteId === r.effectiveSiteId && c.timeSlot === normTime);
      if (timeMatches.length === 1) {
        result.set(r.id, { shiftTypeId: timeMatches[0]!.id, inferred: true });
        continue;
      }
    }
    // 訊號 2：同一行（rowIndex）其他日子嘅正更/OT 格多數票。
    const rowMajority = majorityOf(byRowIndex.get(r.rowIndex) ?? []);
    if (rowMajority) {
      result.set(r.id, { shiftTypeId: rowMajority, inferred: true });
      continue;
    }
    result.set(r.id, { shiftTypeId: null, inferred: false });
  }
  return result;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 一個 DB loader：攞晒呢個上載對數要用嘅全部資料，交俾
 * `reconcileRosterUpload()`（純函數）分類。 */
export async function loadReconcileInput(uploadId: string): Promise<ReconcileInput> {
  const upload = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: uploadId } });
  const rows = await prisma.rosterUploadRow.findMany({
    where: { uploadId, codeKind: { in: ["shift", "ot", "leave"] } },
  });

  // B1-8 第 5 項：對數用嘅盤＝resolved_site_id ?? upload.site_id。
  const rowsWithEffectiveSite = rows.map((r) => ({ ...r, effectiveSiteId: r.resolvedSiteId ?? upload.siteId }));

  const effectiveSiteIds = [...new Set(rowsWithEffectiveSite.map((r) => r.effectiveSiteId).filter((v): v is string => v !== null))];
  const shiftTypesRaw = effectiveSiteIds.length
    ? await prisma.shiftType.findMany({ where: { siteId: { in: effectiveSiteIds }, voidedAt: null }, select: { id: true, siteId: true, startTime: true, endTime: true } })
    : [];
  const shiftTypeCandidates: LeaveShiftTypeCandidate[] = shiftTypesRaw.map((s) => ({ id: s.id, siteId: s.siteId, timeSlot: shiftTypeTimeSlot(s.startTime, s.endTime) }));

  const leaveShiftTypeByRowId = resolveLeaveShiftTypeIds(rowsWithEffectiveSite, shiftTypeCandidates);

  // 規則 8：冇雞頭碼欄嘅行（settlementBrokerId null）用
  // `resolveSettlementBrokerFallback()` 補，標 settlement_inferred。跟
  // batch/route.ts 一致，memoize（同一 guard+site 喺呢張上載入面出現
  //好多次，唔逐行都打 DB）。
  const guardIds = [...new Set(rowsWithEffectiveSite.map((r) => r.guardId).filter((v): v is string => v !== null))];
  const guards = guardIds.length ? await prisma.guard.findMany({ where: { id: { in: guardIds } }, select: { id: true, employmentType: true, defaultBrokerId: true } }) : [];
  const guardById = new Map(guards.map((g) => [g.id, g]));
  const resolveFallback = createSettlementBrokerFallbackResolver(prisma);

  const rosterEntries: ReconcileRosterEntry[] = [];
  const unresolvedEntries: ReconcileUnresolvedEntry[] = [];

  for (const r of rowsWithEffectiveSite) {
    const workDate = toDateStr(r.workDate);
    const reasons: string[] = [];
    if (!r.effectiveSiteId) reasons.push("上載未指定盤（site_id 未定），請先喺更表上載列表頁指定盤");
    if (!r.guardId) reasons.push("安員未配對");

    let shiftTypeId: string | null = r.shiftTypeId;
    let shiftTypeInferred = false;
    if (r.codeKind === "leave") {
      const inferred = leaveShiftTypeByRowId.get(r.id) ?? { shiftTypeId: null, inferred: false };
      shiftTypeId = inferred.shiftTypeId;
      shiftTypeInferred = inferred.inferred;
      if (!shiftTypeId) reasons.push("請假格推斷唔到屬邊個更別（Time 欄同同一行都冇夠訊號），人手覆核");
    } else if (!shiftTypeId) {
      reasons.push("更別未配對");
    }

    if (reasons.length > 0 || !r.guardId || !r.effectiveSiteId || !shiftTypeId) {
      unresolvedEntries.push({
        rowId: r.id,
        workDate,
        siteId: r.effectiveSiteId,
        guardId: r.guardId,
        shiftTypeId,
        codeKind: r.codeKind as "shift" | "ot" | "leave",
        rawCode: r.rawCode,
        reason: reasons.join("；") || "未配對",
      });
      continue;
    }

    let settlementBrokerId = r.settlementBrokerId;
    let settlementInferred = false;
    if (!settlementBrokerId) {
      const guard = guardById.get(r.guardId);
      settlementBrokerId = await resolveFallback({
        guardId: r.guardId,
        siteId: r.effectiveSiteId,
        employmentType: guard?.employmentType ?? "cash_casual",
        defaultBrokerId: guard?.defaultBrokerId ?? null,
      });
      settlementInferred = true;
    }

    rosterEntries.push({
      rowId: r.id,
      workDate,
      siteId: r.effectiveSiteId,
      guardId: r.guardId,
      shiftTypeId,
      codeKind: r.codeKind as "shift" | "ot" | "leave",
      rawCode: r.rawCode,
      hours: r.hours !== null ? Number(r.hours.toString()) : null,
      // B1-4：保留原檔字面（RD/OFF/AL/SL/NL/NPL/SH），唔歸一——見呢個
      // model 頂嘅大註解（同 prisma/schema.prisma LeaveCode enum 嘅
      // 既有設計精神一致：seed 有原檔字面就用原檔字面）。
      leaveCode: r.codeKind === "leave" ? r.rawCode.trim().toUpperCase() : null,
      shiftTypeInferred,
      settlementBrokerId: settlementBrokerId ?? null,
      settlementInferred,
    });
  }

  const monthStartDate = toMonthStart(upload.month);
  const monthEnd = new Date(Date.UTC(monthStartDate.getUTCFullYear(), monthStartDate.getUTCMonth() + 1, 0));
  const systemRecordsRaw: ShiftRecord[] = effectiveSiteIds.length
    ? await prisma.shiftRecord.findMany({
        where: { siteId: { in: effectiveSiteIds }, workDate: { gte: monthStartDate, lte: monthEnd }, status: { not: "cancelled" } },
      })
    : [];
  const systemEntries: ReconcileSystemEntry[] = systemRecordsRaw.map((s) => ({
    id: s.id,
    workDate: toDateStr(s.workDate),
    siteId: s.siteId,
    guardId: s.guardId,
    shiftTypeId: s.shiftTypeId,
    settlementBrokerId: s.settlementBrokerId,
    operationalBrokerId: s.operationalBrokerId,
    recordType: s.recordType,
    leaveCode: s.leaveCode,
    status: s.status,
    source: s.source,
  }));

  return { upload: { id: upload.id, siteId: upload.siteId, month: upload.month }, rosterEntries, unresolvedEntries, systemEntries };
}

/** 純函數：逐更配對＋分類（見檔案頂註解嘅七類）。冇任何 DB 依賴，單元
 * 測試主力測呢個。 */
export function reconcileRosterUpload(input: Pick<ReconcileInput, "rosterEntries" | "unresolvedEntries" | "systemEntries">): ReconcileItem[] {
  const rosterByKey = new Map<string, ReconcileRosterEntry>();
  for (const r of input.rosterEntries) rosterByKey.set(buildReconcileKey(r), r);
  const systemByKey = new Map<string, ReconcileSystemEntry>();
  for (const s of input.systemEntries) systemByKey.set(buildReconcileKey(s), s);

  const consumedRosterKeys = new Set<string>();
  const consumedSystemKeys = new Set<string>();
  const items: ReconcileItem[] = [];

  // ---- 第一輪：完整四要素夾中（match／settlement_diff）--------------
  for (const [key, roster] of rosterByKey) {
    const system = systemByKey.get(key);
    if (!system) continue;
    consumedRosterKeys.add(key);
    consumedSystemKeys.add(key);
    const settlementSame = (roster.settlementBrokerId ?? null) === (system.settlementBrokerId ?? null);
    items.push({
      key,
      category: settlementSame ? "match" : "settlement_diff",
      workDate: roster.workDate,
      siteId: roster.siteId,
      guardId: roster.guardId,
      shiftTypeId: roster.shiftTypeId,
      roster,
      system,
      unresolvedReason: null,
    });
  }

  const remainingRoster = [...rosterByKey.entries()].filter(([k]) => !consumedRosterKeys.has(k));
  const remainingSystem = [...systemByKey.entries()].filter(([k]) => !consumedSystemKeys.has(k));

  // ---- 第二輪：guard_diff——同日同更種同盤，人唔同 -------------------
  // 分組鍵唔含 guard_id；一組入面淨係得一個 roster 剩低、一個 system
  // 剩低（人唔同）先配對——多過一個候選就太含糊，唔估，留返 roster_only
  // /system_only 分開列。
  function groupBy<T>(list: [string, T][], keyer: (v: T) => string): Map<string, [string, T][]> {
    const m = new Map<string, [string, T][]>();
    for (const [k, v] of list) {
      const gk = keyer(v);
      const arr = m.get(gk) ?? [];
      arr.push([k, v]);
      m.set(gk, arr);
    }
    return m;
  }

  const rosterByDateSiteShiftType = groupBy(remainingRoster, (r) => `${r.workDate}|${r.siteId}|${r.shiftTypeId}`);
  const systemByDateSiteShiftType = groupBy(remainingSystem, (s) => `${s.workDate}|${s.siteId}|${s.shiftTypeId}`);
  for (const [groupKey, rosterGroup] of rosterByDateSiteShiftType) {
    const systemGroup = systemByDateSiteShiftType.get(groupKey);
    if (!systemGroup || systemGroup.length !== 1 || rosterGroup.length !== 1) continue;
    const [rKey, roster] = rosterGroup[0]!;
    const [sKey, system] = systemGroup[0]!;
    if (roster.guardId === system.guardId) continue; // 唔應該發生（第一輪應該已經夾中），保險跳過
    if (consumedRosterKeys.has(rKey) || consumedSystemKeys.has(sKey)) continue;
    consumedRosterKeys.add(rKey);
    consumedSystemKeys.add(sKey);
    items.push({
      key: rKey,
      category: "guard_diff",
      workDate: roster.workDate,
      siteId: roster.siteId,
      guardId: roster.guardId,
      shiftTypeId: roster.shiftTypeId,
      roster,
      system,
      unresolvedReason: null,
    });
  }

  // ---- 第三輪：shift_type_diff——同人同日同盤，更種/時段唔同 ---------
  const remainingRoster2 = remainingRoster.filter(([k]) => !consumedRosterKeys.has(k));
  const remainingSystem2 = remainingSystem.filter(([k]) => !consumedSystemKeys.has(k));
  const rosterByDateSiteGuard = groupBy(remainingRoster2, (r) => `${r.workDate}|${r.siteId}|${r.guardId}`);
  const systemByDateSiteGuard = groupBy(remainingSystem2, (s) => `${s.workDate}|${s.siteId}|${s.guardId}`);
  for (const [groupKey, rosterGroup] of rosterByDateSiteGuard) {
    const systemGroup = systemByDateSiteGuard.get(groupKey);
    if (!systemGroup || systemGroup.length !== 1 || rosterGroup.length !== 1) continue;
    const [rKey, roster] = rosterGroup[0]!;
    const [sKey, system] = systemGroup[0]!;
    if (roster.shiftTypeId === system.shiftTypeId) continue;
    if (consumedRosterKeys.has(rKey) || consumedSystemKeys.has(sKey)) continue;
    consumedRosterKeys.add(rKey);
    consumedSystemKeys.add(sKey);
    items.push({
      key: rKey,
      category: "shift_type_diff",
      workDate: roster.workDate,
      siteId: roster.siteId,
      guardId: roster.guardId,
      shiftTypeId: roster.shiftTypeId,
      roster,
      system,
      unresolvedReason: null,
    });
  }

  // ---- roster_only／system_only：剩低嘅 -------------------------------
  for (const [key, roster] of rosterByKey) {
    if (consumedRosterKeys.has(key)) continue;
    items.push({ key, category: "roster_only", workDate: roster.workDate, siteId: roster.siteId, guardId: roster.guardId, shiftTypeId: roster.shiftTypeId, roster, system: null, unresolvedReason: null });
  }
  for (const [key, system] of systemByKey) {
    if (consumedSystemKeys.has(key)) continue;
    items.push({ key, category: "system_only", workDate: system.workDate, siteId: system.siteId, guardId: system.guardId, shiftTypeId: system.shiftTypeId, roster: null, system, unresolvedReason: null });
  }

  // ---- unresolved -----------------------------------------------------
  for (const u of input.unresolvedEntries) {
    items.push({
      key: buildUnresolvedKey(u.rowId),
      category: "unresolved",
      workDate: u.workDate,
      siteId: u.siteId,
      guardId: u.guardId,
      shiftTypeId: u.shiftTypeId,
      roster: null,
      system: null,
      unresolvedReason: u.reason,
    });
  }

  items.sort((a, b) => (a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : a.key.localeCompare(b.key)));
  return items;
}

export interface ReconcileSummary {
  total: number;
  byCategory: Record<ReconcileCategory, number>;
  settlementInferredCount: number;
}

export function summarizeReconcile(items: readonly ReconcileItem[]): ReconcileSummary {
  const byCategory = Object.fromEntries(RECONCILE_CATEGORIES.map((c) => [c, 0])) as Record<ReconcileCategory, number>;
  let settlementInferredCount = 0;
  for (const item of items) {
    byCategory[item.category] += 1;
    if (item.roster?.settlementInferred) settlementInferredCount += 1;
  }
  return { total: items.length, byCategory, settlementInferredCount };
}

/** 對數引擎入口——loader＋純函數合埋一齊用（API route 用呢個）。 */
export async function reconcileUpload(uploadId: string): Promise<{ items: ReconcileItem[]; summary: ReconcileSummary; upload: RosterUpload }> {
  const input = await loadReconcileInput(uploadId);
  const upload = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: uploadId } });
  const items = reconcileRosterUpload(input);
  const summary = summarizeReconcile(items);
  return { items, summary, upload };
}

// 型別重新導出（route.ts／UI 用）。
export type { RosterUpload, RosterUploadRow };
