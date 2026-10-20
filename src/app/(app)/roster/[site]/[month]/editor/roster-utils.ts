// 更表編輯器純函數 helper（P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變）。
import type { StaffCardDto,
  BrokerDto,
  CellState,
  GuardDto,
  QuotaDto,
  RowMeta,
  ShiftRecordDto,
  ShiftTypeDto,
} from "./roster-types";

// 純函數 helper（日期計算全部用 UTC，避免時區令「幾號」跳日）。

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function parseMonthStr(month: string): { year: number; monthNum: number } {
  const [y, m] = month.split("-").map(Number);
  return { year: y, monthNum: m };
}

export function daysInMonth(year: number, monthNum: number): number {
  return new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
}

export function dayOfMonthFromIso(iso: string): number {
  return new Date(iso).getUTCDate();
}

export function prevMonthStr(month: string): string {
  const { year, monthNum } = parseMonthStr(month);
  const pm = monthNum === 1 ? 12 : monthNum - 1;
  const py = monthNum === 1 ? year - 1 : year;
  return `${py}-${pad2(pm)}`;
}

// WP-R2：月份 chip「‹ › 」撳＝跳去上／下月（README §04）。
export function nextMonthStr(month: string): string {
  const { year, monthNum } = parseMonthStr(month);
  const nm = monthNum === 12 ? 1 : monthNum + 1;
  const ny = monthNum === 12 ? year + 1 : year;
  return `${ny}-${pad2(nm)}`;
}

// WP-R2：今日（香港時間）高亮用——同 src/lib/ai/system-prompt.ts
// `hongKongToday()` 一樣做法（伺服器/瀏覽器一律用 Asia/Hong_Kong，唔靠
// 本機時區）。淨係喺 `loading` 完咗先會 render 到用得着呢個值嘅格仔表，
// 所以唔會有 SSR/CSR 唔同日先後 render 撞第日嘅 hydration mismatch 風險。
export function hongKongTodayYMD(): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

export type DayMeta = {
  weekday: string;
  isWeekend: boolean;
  isToday: boolean;
  headerBg: string;
  weekdayColor: string;
  dayColor: string;
  /** 資料格底色（今日／週末），`undefined` = 平日（透明，跟返行 hover 底）。 */
  colBg?: string;
};

export function dayMeta(y: number, m: number, day: number, today: { y: number; m: number; d: number } | null): DayMeta {
  const wd = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  const isWeekend = wd === 0 || wd === 6;
  const isToday = !!today && today.y === y && today.m === m && today.d === day;
  return {
    weekday: WEEKDAY_LABELS[wd],
    isWeekend,
    isToday,
    headerBg: isToday ? "var(--zk-primary-tint)" : isWeekend ? "var(--zk-surface)" : "var(--zk-header)",
    weekdayColor: isToday ? "var(--zk-primary)" : "var(--zk-faint)",
    dayColor: isToday ? "var(--zk-primary-dark)" : isWeekend ? "var(--zk-muted)" : "var(--zk-text)",
    colBg: isToday ? "var(--zk-primary-tint-soft)" : isWeekend ? "var(--zk-surface-2)" : undefined,
  };
}

// WP-R2：底部合計行「已排」數配色（README §04：≥所需 綠；<所需 但
// ≥所需×0.55 中性；否則紅；冇所需設定＝中性）。
export function coverageColor(count: number, required: number): string {
  if (!required || required <= 0) return "var(--zk-text-secondary)";
  if (count >= required) return "var(--zk-success)";
  if (count >= required * 0.55) return "var(--zk-text-secondary)";
  return "var(--zk-danger)";
}

export function workDateStr(year: number, monthNum: number, day: number): string {
  return `${year}-${pad2(monthNum)}-${pad2(day)}`;
}

export function cellKeyOf(rowKey: string, day: number): string {
  return `${rowKey}#${day}`;
}

export function normalizeCode(text: string | null | undefined): string | null {
  if (text == null) return null;
  const t = text.trim().toUpperCase();
  return t === "" ? null : t;
}

export function cellsEqual(a: CellState | undefined, b: CellState | undefined): boolean {
  return (a?.code ?? null) === (b?.code ?? null);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** EMP-P1：盤 staff_scheme 下面各 guard 嘅工號卡（scheme 未設定／U＝空，照舊顯示 guards.staff_no）。 */
export type StaffDisplayCtx = { scheme: string | null; cardsByGuard: Map<string, StaffCardDto[]> };

/** 該 guard 喺呢個盤顯示嘅工號卡：記錄指明嘅卡優先，否則現用卡，否則最後一張已取消卡。 */
function pickStaffCard(cards: StaffCardDto[], preferredId?: string | null): StaffCardDto | null {
  if (preferredId) {
    const hit = cards.find((c) => c.id === preferredId);
    if (hit) return hit;
  }
  return cards.find((c) => c.status === "current") ?? [...cards].reverse().find((c) => c.status === "former") ?? null;
}

export function buildRowsAndCells(
  records: ShiftRecordDto[],
  shiftTypesById: Map<string, ShiftTypeDto>,
  guardsById: Map<string, GuardDto>,
  staff?: StaffDisplayCtx,
): { rows: RowMeta[]; cells: Map<string, CellState> } {
  const rowsMap = new Map<string, RowMeta>();
  const cellsMap = new Map<string, CellState>();

  for (const r of records) {
    const day = dayOfMonthFromIso(r.work_date);
    const rowKey = `${r.shift_type_id}|${r.guard_id}`;
    const st = shiftTypesById.get(r.shift_type_id);
    const code = r.record_type === "shift" || r.record_type === "ot" ? (st?.code ?? "?") : (r.leave_code ?? "?");
    cellsMap.set(cellKeyOf(rowKey, day), { code, id: r.id, status: r.status, recordType: r.record_type, source: r.source ?? null });

    if (!rowsMap.has(rowKey)) {
      const guard = guardsById.get(r.guard_id);
      // EMP-P1：盤有設定 scheme（非 U）→ 顯示該 scheme 嘅卡號（唔會借 U 號充數）；否則照舊 guards.staff_no
      const schemeCards = staff && staff.scheme && staff.scheme !== "U" ? (staff.cardsByGuard.get(r.guard_id) ?? []) : null;
      const chosen = schemeCards ? pickStaffCard(schemeCards, r.staff_number_id) : null;
      rowsMap.set(rowKey, {
        key: rowKey,
        shiftTypeId: r.shift_type_id,
        guardId: r.guard_id,
        shiftTypeCode: st?.code ?? "?",
        guardName: guard?.name_zh ?? "",
        staffNo: schemeCards ? (chosen?.number ?? "") : (guard?.staff_no ?? ""),
        ...(schemeCards && schemeCards.length > 1 ? { staffCards: schemeCards, staffCardId: chosen?.id ?? null } : {}),
        tel: "", // P3-2.4：輕量 guards 唔帶電話；RowMeta.tel 本來就唔顯示
        brokerId: r.settlement_broker_id ?? guard?.default_broker_id ?? null,
      });
    }
  }

  const rows = [...rowsMap.values()].sort(
    (a, b) => a.shiftTypeCode.localeCompare(b.shiftTypeCode) || a.guardName.localeCompare(b.guardName),
  );
  return { rows, cells: cellsMap };
}

export function isEffectiveShiftCell(row: RowMeta, day: number, cells: Map<string, CellState>, baseline: Map<string, CellState>): boolean {
  const key = cellKeyOf(row.key, day);
  const c = cells.get(key);
  if (!c || !c.code || c.code !== row.shiftTypeCode) return false;
  const dirty = !cellsEqual(baseline.get(key), c);
  // 本地新填／改嘅格，batch API 一律寫 record_type=shift（清格/正更代號
  // 先會送出去，見 batch route 頂註解）；未改過嘅格跟返 baseline 本身嘅
  // record_type（可能係 shift 或 ot——ot 唔計落 Total，同
  // scripts/report/roster.ts 口徑一致）。
  const effectiveType = dirty ? "shift" : c.recordType;
  return effectiveType === "shift";
}

// 左邊固定欄寬度（px，WP-R2 按 README §04/§23 重新分配）——用嚟計 sticky
// 欄嘅 left offset。
// 桌面（≥1024，非 compact）：更別 44 + 姓名/工號（彈性）+ 雞頭 70 = 300 總闊。
export const DESK_COL_SHIFT_TYPE = 44;
export const DESK_COL_BROKER = 70;
export const DESK_FIXED_TOTAL = 300;
export const DESK_COL_DAY = 34;
// 手機（compact，<640）：單一「姓名」固定欄 118px（連工號／雞頭代號都收
// 埋落姓名格下行，冇獨立更別／工號／雞頭欄——跟 README §23 手機原型
// 1:1，見 P2-版面重設計計劃.md §2「手機更別鍵盤」判斷附近段落）。
export const MOBILE_COL_NAME = 118;
export const MOBILE_COL_DAY = 44;
// 2026-09-12 老闆 feedback：更表唔顯示保安員電話（聯絡資料只喺保安員名冊，按 保安員:view 權限）；Excel 匯出照原檔格式保留，`RowMeta.tel` 仍然保留但呢頁唔顯示。

// WP-R2 第 9 項：手機底部更別鍵盤實際高度（約），等表格捲動區留返
// padding-bottom，撳近底部嘅格先唔會俾鍵盤遮住。
export const MOBILE_KEYPAD_HEIGHT = 143;

  // ---- 雞頭人數／更數統計條（老闆 feedback 2026-09-12）------------------
  // 用原始 `records`（未經 rows/cells 聚合）逐更計數，先分得到
  // confirmed／pending 兩個桶。歸屬雞頭嘅口徑同 buildRowsAndCells()一致：
  // settlement_broker_id 冇填就跟 guard.default_broker_id；仲係冇（例如
  // 舊更表冇填雞頭欄）嘅記錄唔計入任何雞頭列（同 §「Y=公司兵」呢類淨係
  // 憑糧明細先反推得到嘅安排一致，呢度冇資料源可以反推，唔會亂估）。
  // 內部角色見晒全部雞頭；雞頭 session 本身 API 已經淨係傳返自己嗰啲
  // records（scopeShiftRecordWhere），呢度自然淨係計到自己一行，唔使
  // 額外分支處理。
export type BrokerStat = {
  brokerId: string;
  code: string;
  name: string;
  headcount: number;
  confirmed: number;
  pending: number;
  quotaTarget: number;
};
export function computeBrokerStats(
  records: ShiftRecordDto[],
  guardsById: Map<string, GuardDto>,
  brokersById: Map<string, BrokerDto>,
  quotas: QuotaDto[],
): BrokerStat[] {
  const byBroker = new Map<string, { guards: Set<string>; confirmed: number; pending: number }>();
  for (const rec of records) {
    const brokerId = rec.settlement_broker_id ?? guardsById.get(rec.guard_id)?.default_broker_id ?? null;
    if (!brokerId) continue;
    let bucket = byBroker.get(brokerId);
    if (!bucket) {
      bucket = { guards: new Set(), confirmed: 0, pending: 0 };
      byBroker.set(brokerId, bucket);
    }
    bucket.guards.add(rec.guard_id);
    if (rec.status === "confirmed" || rec.status === "completed") bucket.confirmed++;
    else if (rec.status === "pending_approval" || rec.status === "draft") bucket.pending++;
  }
  const quotaTotalsByBroker = new Map<string, number>();
  for (const q of quotas) {
    quotaTotalsByBroker.set(q.broker_id, (quotaTotalsByBroker.get(q.broker_id) ?? 0) + q.target_shifts);
  }
  const stats: BrokerStat[] = [];
  for (const [brokerId, bucket] of byBroker) {
    const broker = brokersById.get(brokerId);
    stats.push({
      brokerId,
      code: broker?.code ?? brokerId,
      name: broker?.name ?? "",
      headcount: bucket.guards.size,
      confirmed: bucket.confirmed,
      pending: bucket.pending,
      quotaTarget: quotaTotalsByBroker.get(brokerId) ?? 0,
    });
  }
  return stats.sort((a, b) => a.code.localeCompare(b.code));
}
