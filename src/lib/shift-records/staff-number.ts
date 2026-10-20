// EMP-P1：更次工號歸屬推導——每一更用「人 N 張工號卡」入面邊一張。
//
// 次序（每條更次，先中先贏）：
//   1. payload 明確 `staff_number_id`（必須屬同一個 guard，否則 400）→ source=payload
//   2. 更表上載：`roster_upload_rows.staff_no_raw` 正規化後對中呢個 guard 嘅任何一張卡（含已取消）→ roster_file
//   3. 結算單位係 internal_longterm（B07）→ 該 guard 嘅 MG 卡：workDate 落喺「有日期」嘅卡期間內優先，否則 current → longterm
//   4. `sites.staff_scheme` → 該 guard 同 scheme 嘅卡：
//        - 有日期嘅卡入面 workDate 落喺期間內剛好一張 → 用佢（range）
//        - 冇任何一張落喺期間內，而該 scheme 淨係得一張卡、而且張卡完全冇日期（valid_from／valid_to 都 null）→ 用佢（sole）
//        - 其餘（多於一張冇法分／唯一一張有日期但唔包 workDate）→ 唔推（ambiguous／unresolved）
//   5. 都唔中 → null（唔擋儲存；response 帶 no_staff_number_count）
// 純歸屬資訊：呢個模組唔掂任何金額欄。批量 prefetch（參考 settlement-broker-fallback.ts）：一個 call 最多 4 條查詢。
import type { Prisma, PrismaClient } from "@prisma/client";
import { BadRequest } from "@/lib/api/errors";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";

type PrismaLike = PrismaClient | Prisma.TransactionClient;

type StaffNumberSource = "payload" | "roster_file" | "longterm" | "site_scheme" | "manual";

interface StaffCardLike {
  id: string;
  guardId: string;
  scheme: string;
  number: string;
  status: "current" | "former";
  validFrom: Date | null;
  validTo: Date | null;
}

/** 純函數推導結果：method 供回填腳本逐類計數（live 寫入時 range／sole 都記 site_scheme）。 */
type StaffResolveMethod = "payload" | "roster_file" | "longterm" | "range" | "sole" | "ambiguous" | "unresolved";
interface StaffResolveOutcome {
  card: StaffCardLike | null;
  method: StaffResolveMethod;
}

interface StaffResolveInput {
  workDate: Date;
  /** 更表上載行嘅原始工號（staff_no_raw）；冇＝null */
  rosterStaffNoRaw?: string | null;
  /** 呢更結算單位係咪 internal_longterm（B07） */
  isLongterm: boolean;
  /** sites.staff_scheme；null＝未設定 */
  siteScheme: string | null;
}

const dated = (c: StaffCardLike) => c.validFrom !== null || c.validTo !== null;
const inPeriod = (c: StaffCardLike, d: Date) => (c.validFrom === null || c.validFrom.getTime() <= d.getTime()) && (c.validTo === null || d.getTime() <= c.validTo.getTime());

/** 第 2–4 步（唔包第 1 步 payload）。`cards`＝同一個 guard 全部卡（含 former）。 */
export function resolveFromCards(cards: readonly StaffCardLike[], input: StaffResolveInput): StaffResolveOutcome {
  const raw = input.rosterStaffNoRaw ? normalizeStaffNumber(input.rosterStaffNoRaw) : "";
  if (raw) {
    const hit = cards.find((c) => c.number === raw);
    if (hit) return { card: hit, method: "roster_file" };
  }
  if (input.isLongterm) {
    const mg = cards.filter((c) => c.scheme === "MG");
    const range = mg.filter((c) => dated(c) && inPeriod(c, input.workDate));
    if (range.length === 1) return { card: range[0]!, method: "longterm" };
    if (range.length > 1) return { card: null, method: "ambiguous" };
    // EMP-P1.1：current 後備只限張卡冇日期，或者 workDate 落喺佢期間內——入職前嘅更次唔掛去之後先發嘅卡
    const current = mg.filter((c) => c.status === "current" && (!dated(c) || inPeriod(c, input.workDate)));
    if (current.length === 1) return { card: current[0]!, method: "longterm" };
    // 長工但冇 MG 卡 → 跌落第 4 步（盤 scheme）
  }
  if (input.siteScheme) {
    const same = cards.filter((c) => c.scheme === input.siteScheme);
    const range = same.filter((c) => dated(c) && inPeriod(c, input.workDate));
    if (range.length === 1) return { card: range[0]!, method: "range" };
    if (range.length > 1) return { card: null, method: "ambiguous" };
    if (same.length === 1 && !dated(same[0]!)) return { card: same[0]!, method: "sole" };
    if (same.length >= 2) return { card: null, method: "ambiguous" };
  }
  return { card: null, method: "unresolved" };
}

export interface ShiftStaffItem {
  /** caller 自己嘅 key（結果 Map 用） */
  key: string;
  guardId: string;
  siteId: string;
  workDate: Date;
  /** payload 明確指定嘅工號卡 id */
  explicitStaffNumberId?: string | null;
  /** 更表上載行 id（roster_upload_rows.id）——用嚟攞 staff_no_raw */
  rosterRowId?: string | null;
  /** 呢更結算單位（判斷係咪長工 B07） */
  settlementBrokerId?: string | null;
}

export interface ResolvedStaff {
  staffNumberId: string;
  scheme: string;
  source: StaffNumberSource;
}

/**
 * 批量推導（帶完整 method，回填腳本逐類計數用）。`explicitStaffNumberId` 唔屬同一個 guard → 400。
 * method=payload 只喺有明確指定時出現；其餘同 resolveFromCards 一致。
 */
export async function resolveShiftStaffOutcomes(client: PrismaLike, items: readonly ShiftStaffItem[], expectedMissing?: Set<string>): Promise<Map<string, StaffResolveOutcome>> {
  const out = new Map<string, StaffResolveOutcome>();
  if (items.length === 0) return out;
  const guardIds = [...new Set(items.map((i) => i.guardId))];
  const siteIds = [...new Set(items.map((i) => i.siteId))];
  const brokerIds = [...new Set(items.map((i) => i.settlementBrokerId).filter((v): v is string => !!v))];
  const rowIds = [...new Set(items.map((i) => i.rosterRowId).filter((v): v is string => !!v))];
  const [cardRows, sites, brokers, rows] = await Promise.all([
    client.guardStaffNumber.findMany({ where: { guardId: { in: guardIds } }, select: { id: true, guardId: true, scheme: true, number: true, status: true, validFrom: true, validTo: true } }),
    client.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, staffScheme: true } }),
    brokerIds.length ? client.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, kind: true } }) : Promise.resolve([]),
    rowIds.length ? client.rosterUploadRow.findMany({ where: { id: { in: rowIds } }, select: { id: true, staffNoRaw: true } }) : Promise.resolve([]),
  ]);
  const cardsByGuard = new Map<string, StaffCardLike[]>();
  const cardById = new Map<string, StaffCardLike>();
  for (const c of cardRows) {
    cardsByGuard.set(c.guardId, [...(cardsByGuard.get(c.guardId) ?? []), c]);
    cardById.set(c.id, c);
  }
  const schemeBySite = new Map(sites.map((s) => [s.id, s.staffScheme]));
  const longtermBroker = new Set(brokers.filter((b) => b.kind === "internal_longterm").map((b) => b.id));
  const rawByRow = new Map(rows.map((r) => [r.id, r.staffNoRaw]));

  // 明確指定嘅卡可能屬別個 guard（要 400），所以逐個核對（唔受 guardIds prefetch 限制）
  const explicitIds = [...new Set(items.map((i) => i.explicitStaffNumberId).filter((v): v is string => !!v))];
  const missing = explicitIds.filter((id) => !cardById.has(id));
  if (missing.length) {
    const extra = await client.guardStaffNumber.findMany({ where: { id: { in: missing } }, select: { id: true, guardId: true, scheme: true, number: true, status: true, validFrom: true, validTo: true } });
    for (const c of extra) cardById.set(c.id, c);
  }

  for (const it of items) {
    if (it.explicitStaffNumberId) {
      const c = cardById.get(it.explicitStaffNumberId);
      if (!c || c.guardId !== it.guardId) throw BadRequest("staff_number_id 唔屬於呢個保安員，或者唔存在");
      out.set(it.key, { card: c, method: "payload" });
      continue;
    }
    const isLongterm = !!it.settlementBrokerId && longtermBroker.has(it.settlementBrokerId);
    const siteScheme = schemeBySite.get(it.siteId) ?? null;
    const outcome = resolveFromCards(cardsByGuard.get(it.guardId) ?? [], { workDate: it.workDate, rosterStaffNoRaw: it.rosterRowId ? (rawByRow.get(it.rosterRowId) ?? null) : null, isLongterm, siteScheme });
    out.set(it.key, outcome);
    // EMP-P1.1 降噪：只有「盤已設 staff_scheme 或 B07 長工」而推唔到，先算應該有但冇（盤未設 scheme 嘅格唔計）
    if (!outcome.card && (isLongterm || siteScheme)) expectedMissing?.add(it.key);
  }
  return out;
}

/** 批量推導（寫入點用）：唔中 → Map 值 null。range／sole 都記 site_scheme。 */
export async function resolveShiftStaffNumbers(client: PrismaLike, items: readonly ShiftStaffItem[], expectedMissing?: Set<string>): Promise<Map<string, ResolvedStaff | null>> {
  const outcomes = await resolveShiftStaffOutcomes(client, items, expectedMissing);
  const out = new Map<string, ResolvedStaff | null>();
  for (const [key, o] of outcomes) {
    out.set(
      key,
      o.card ? { staffNumberId: o.card.id, scheme: o.card.scheme, source: o.method === "payload" ? "payload" : o.method === "roster_file" ? "roster_file" : o.method === "longterm" ? "longterm" : "site_scheme" } : null,
    );
  }
  return out;
}

/** 寫入 shift_records 嘅三個歸屬欄（null＝唔郁）。 */
export function staffNumberData(r: ResolvedStaff | null | undefined): { staffNumberId: string; staffScheme: string; staffNumberSource: string } | Record<string, never> {
  return r ? { staffNumberId: r.staffNumberId, staffScheme: r.scheme, staffNumberSource: r.source } : {};
}

/**
 * 更新現存記錄時要唔要覆寫歸屬：冇舊值就寫；有舊值只係新推導源自 payload／roster_file（人手／檔案證據）先覆寫，
 * 唔會用 site_scheme／longterm 嘅推算蓋走已有歸屬；同一張卡就唔使寫。
 */
export function shouldWriteStaffNumber(existing: { staffNumberId: string | null }, next: ResolvedStaff | null | undefined): next is ResolvedStaff {
  if (!next) return false;
  if (existing.staffNumberId === next.staffNumberId) return false;
  if (!existing.staffNumberId) return true;
  return next.source === "payload" || next.source === "roster_file";
}
