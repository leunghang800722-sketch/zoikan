// HIST-2：歷史月份「更表 vs Postorder（Roster 分頁）逐盤格數」比對——純函數，零 DB 依賴。
// 本機消化報告 script（scripts/report/hist-roster-digest.ts）同歷史一鍵導入報告共用同一套配盤邏輯（rowsForSite）。
// 鐵則：輸出只有盤名／物業短代號＋數字，唔帶任何人名（Postorder「客戶名稱」尾段可能係人名，只用嚟配盤）。
import { rowsForSite, type PostorderRosterRow } from "./auto/postorder-evidence";
import { normalizeSiteKey } from "./auto/site-match";

export interface RosterSiteCells {
  /** 報告顯示用盤名。 */
  label: string;
  /** 用嚟配 Postorder 崗位行嘅名（canonical＋aliases＋更表盤名）。 */
  names: string[];
  /** 更表 shift＋ot 格數（請假格 Postorder 冇「有人當值」意思，唔計）。 */
  cells: number;
}

export interface SiteCompareRow {
  label: string;
  rosterCells: number;
  /** null＝Postorder 對唔到呢個盤。 */
  postorderCells: number | null;
  postorderRows: number;
  diff: number | null;
  /** 只喺 `loose: true`（本機消化報告）出現：嚴格配唔到，改用「物業短代號／客戶名頭包含喺盤名」約略配對，要人手核。 */
  loose?: boolean;
}

export interface PostorderRosterCompare {
  perSite: SiteCompareRow[];
  /** Postorder 有人當值但冇任何更表盤對到嘅崗位（按物業短代號匯總，唔含客戶名稱）。 */
  unmatchedPostorder: Array<{ property: string; cells: number }>;
  totals: { rosterCells: number; postorderCells: number; matchedSites: number; unmatchedSites: number; sitesWithDiff: number };
}

export function compareRosterVsPostorder(sites: readonly RosterSiteCells[], postorderRows: readonly PostorderRosterRow[], opts: { loose?: boolean } = {}): PostorderRosterCompare {
  const used = new Set<number>();
  const perSite: SiteCompareRow[] = [];
  // loose 第二輪：嚴格配唔到嘅盤，按盤名由短到長，逐個認領「物業短代號／客戶名頭（≥2 字）包含喺盤名」而且未被認領嘅崗位行。
  const loosePicks = new Map<number, PostorderRosterRow[]>();
  if (opts.loose) {
    const strictUsed = new Set<number>();
    const unmatchedIdx: number[] = [];
    sites.forEach((s, i) => {
      const rows = rowsForSite(postorderRows, s.names);
      if (rows.length === 0) unmatchedIdx.push(i);
      for (const r of rows) strictUsed.add(r.rowIndex);
    });
    const claimed = new Set<number>(strictUsed);
    const keyOf = (i: number) => sites[i]!.names.map((n) => normalizeSiteKey(n)).filter(Boolean);
    for (const i of [...unmatchedIdx].sort((a, b) => keyOf(a).join("").length - keyOf(b).join("").length)) {
      const keys = keyOf(i);
      const picks = postorderRows.filter((r) => {
        if (claimed.has(r.rowIndex)) return false;
        const cands = [r.propertyShort, r.labelHead].map((x) => (x ? normalizeSiteKey(x) : "")).filter((x) => x.length >= 2);
        return cands.some((c) => keys.some((k) => k.includes(c)));
      });
      for (const r of picks) claimed.add(r.rowIndex);
      if (picks.length) loosePicks.set(i, picks);
    }
  }
  let rosterTotal = 0;
  let postorderTotal = 0;
  let matchedSites = 0;
  let sitesWithDiff = 0;
  for (const [idx, s] of sites.entries()) {
    const strict = rowsForSite(postorderRows, s.names);
    const rows = strict.length > 0 ? strict : (loosePicks.get(idx) ?? []);
    const isLoose = strict.length === 0 && rows.length > 0;
    rosterTotal += s.cells;
    if (rows.length === 0) {
      perSite.push({ label: s.label, rosterCells: s.cells, postorderCells: null, postorderRows: 0, diff: null });
      continue;
    }
    matchedSites++;
    for (const r of rows) used.add(r.rowIndex);
    const po = rows.reduce((a, r) => a + r.cells, 0);
    postorderTotal += po;
    const diff = s.cells - po;
    if (diff !== 0) sitesWithDiff++;
    perSite.push({ label: s.label, rosterCells: s.cells, postorderCells: po, postorderRows: rows.length, diff, ...(isLoose ? { loose: true } : {}) });
  }
  const unmatched = new Map<string, number>();
  for (const r of postorderRows) {
    if (used.has(r.rowIndex) || r.cells === 0) continue;
    const key = r.propertyShort ?? "（無物業名稱）";
    unmatched.set(key, (unmatched.get(key) ?? 0) + r.cells);
  }
  return {
    perSite,
    unmatchedPostorder: [...unmatched.entries()].map(([property, cells]) => ({ property, cells })).sort((a, b) => b.cells - a.cells),
    totals: { rosterCells: rosterTotal, postorderCells: postorderTotal, matchedSites, unmatchedSites: sites.length - matchedSites, sitesWithDiff },
  };
}

/** 對數引擎 unresolved 原因（reconcile.ts 組嘅中文句，以「；」連接）歸類——報告只出類別＋格數。一格可有多個原因，所以類別格數加起嚟可以大過 unresolved 格數。 */
export const UNRESOLVED_BUCKETS = {
  guard_unmatched: "保安員未配對",
  shift_type_unmatched: "更別／更種未配對或已作廢",
  date_outside_month: "格仔日期唔係上載月份",
  site_unresolved: "盤／子盤未定",
  broker_code_unmatched: "雞頭碼對唔到",
  leave_shift_type_unknown: "請假格推斷唔到更別",
  other: "其他",
} as const;
export type UnresolvedBucket = keyof typeof UNRESOLVED_BUCKETS;

export function bucketUnresolvedReason(reason: string): UnresolvedBucket[] {
  const out = new Set<UnresolvedBucket>();
  for (const part of reason.split("；")) {
    if (!part.trim()) continue;
    if (part.includes("保安員未配對")) out.add("guard_unmatched");
    else if (part.includes("更別未配對") || part.includes("更種已作廢")) out.add("shift_type_unmatched");
    else if (part.includes("唔係上載月份")) out.add("date_outside_month");
    else if (part.includes("子盤") || part.includes("未指定盤")) out.add("site_unresolved");
    else if (part.includes("雞頭碼")) out.add("broker_code_unmatched");
    else if (part.includes("請假格推斷")) out.add("leave_shift_type_unknown");
    else out.add("other");
  }
  if (out.size === 0) out.add("other");
  return [...out];
}
