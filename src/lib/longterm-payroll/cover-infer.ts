// P10.2：由歷史（頂位更＋人手輸入）反推頂位價目表＋回測。**純唯讀，唔寫任何嘢。**
// 輸出唔含姓名／工號：只有盤（id＋盤名）／職級／金額／次數／人數／guard_id。
//
// 「頂位人手輸入」判斷規則（寫明漏判風險）：kind=other_allowance、已確認、未作廢，且 note 含「頂位」二字。
//   - note 同時含「賣假」→ 當混入項（金額混咗賣假），唔參與配對，列入「推斷唔到 (b)」。
//   - 冇「頂位」字樣嘅 other_allowance（例如只寫「津貼」）**認唔到**：有頂位更嘅人月若存在此類輸入，計入
//     `untagged_other_allowance_guard_months`（漏判風險）；回測當實際＝0。
// 配對：同一長工同一月，頂位輸入總額 ÷ 該月頂位更數＝每更金額；note 寫明盤名／「N更」就優先用（盤名只認該長工該月頂過嘅盤）。
import { round2 } from "@/lib/reports/money";
import type { CoverShift } from "./cover-shifts";

export interface TaggedInput {
  id: string;
  guardId: string;
  month: string; // YYYY-MM
  amount: number;
  note: string | null;
}

type InferStatus = "consistent" | "mixed" | "single_sample";

interface SuggestionAmount {
  amount: number;
  shifts: number;
  guard_count: number;
}
interface Suggestion {
  site_id: string;
  site_name: string;
  grade: string;
  status: InferStatus;
  suggested_amount: number | null;
  needs_choice: boolean;
  amounts: SuggestionAmount[];
  total_shifts: number;
  guard_count: number;
  months: string[];
}
interface UnresolvedNoInput {
  site_id: string;
  site_name: string;
  grade: string;
  shifts: number;
  guard_count: number;
  months: string[];
}
interface UnresolvedNoShift {
  reason: "no_cover_shift" | "sell_leave_mixed";
  guard_id: string;
  month: string;
  amount: number;
}
interface UnresolvedAmbiguous {
  guard_id: string;
  month: string;
  total_amount: number;
  keys: { site_id: string; site_name: string; grade: string; shifts: number }[];
}
interface BacktestRow {
  month: string;
  guard_id: string;
  expected: number;
  actual: number;
  diff: number;
  unpriced_shifts: number;
  has_mixed_input: boolean;
}
export interface InferResult {
  months: string[];
  suggestions: Suggestion[];
  unresolved: { no_input: UnresolvedNoInput[]; no_shift: UnresolvedNoShift[]; ambiguous: UnresolvedAmbiguous[] };
  backtest: {
    rows: BacktestRow[];
    summary: { guard_months: number; matched: number; match_rate: number | null; diff_nonzero: number; max_abs_diff: number; unpriced_guard_months: number; by_month: { month: string; guard_months: number; matched: number; diff_nonzero: number; max_abs_diff: number }[] };
  };
  stats: { cover_shifts: number; tagged_inputs: number; untagged_other_allowance_guard_months: number };
}

export function isCoverNote(note: string | null | undefined): boolean {
  return !!note && note.includes("頂位");
}
function isSellLeaveMixed(note: string | null | undefined): boolean {
  return !!note && note.includes("賣假");
}

interface Obs {
  amount: number;
  shifts: number;
  guardId: string;
  month: string;
}

const keyOf = (siteId: string, grade: string) => `${siteId}|${grade}`;

function noteCount(note: string | null): number | null {
  if (!note) return null;
  const m = /(\d+)\s*(?:更|次)/.exec(note);
  if (!m) return null;
  const v = Number(m[1]);
  return v > 0 ? v : null;
}

export interface InferInput {
  months: string[];
  shifts: CoverShift[];
  inputs: TaggedInput[];
  siteNames: Map<string, string>;
  untaggedOtherAllowanceGuardMonths?: number;
}

export function inferCoverRates(inp: InferInput): InferResult {
  const siteName = (id: string) => inp.siteNames.get(id) ?? id;
  const gmKey = (g: string, m: string) => `${g}|${m}`;
  const shiftsByGm = new Map<string, CoverShift[]>();
  for (const s of inp.shifts) {
    const k = gmKey(s.guardId, s.month);
    shiftsByGm.set(k, [...(shiftsByGm.get(k) ?? []), s]);
  }
  const inputsByGm = new Map<string, TaggedInput[]>();
  for (const i of inp.inputs) {
    const k = gmKey(i.guardId, i.month);
    inputsByGm.set(k, [...(inputsByGm.get(k) ?? []), i]);
  }

  const obs = new Map<string, Obs[]>();
  const addObs = (siteId: string, grade: string, o: Obs) => obs.set(keyOf(siteId, grade), [...(obs.get(keyOf(siteId, grade)) ?? []), o]);
  const noInput = new Map<string, { shifts: number; guards: Set<string>; months: Set<string> }>();
  const noShift: UnresolvedNoShift[] = [];
  const ambiguous: UnresolvedAmbiguous[] = [];

  const allKeys = new Set([...shiftsByGm.keys(), ...inputsByGm.keys()]);
  for (const gm of [...allKeys].sort()) {
    const [guardId, month] = gm.split("|") as [string, string];
    const shifts = shiftsByGm.get(gm) ?? [];
    const allInputs = inputsByGm.get(gm) ?? [];
    const inputs = allInputs.filter((i) => !isSellLeaveMixed(i.note));
    for (const i of allInputs) if (isSellLeaveMixed(i.note)) noShift.push({ reason: "sell_leave_mixed", guard_id: guardId, month, amount: i.amount });

    const counts = new Map<string, { siteId: string; grade: string; n: number }>();
    for (const s of shifts) {
      const k = keyOf(s.siteId, s.grade);
      const c = counts.get(k) ?? { siteId: s.siteId, grade: s.grade, n: 0 };
      c.n++;
      counts.set(k, c);
    }
    if (inputs.length === 0) {
      for (const c of counts.values()) {
        const e = noInput.get(keyOf(c.siteId, c.grade)) ?? { shifts: 0, guards: new Set<string>(), months: new Set<string>() };
        e.shifts += c.n;
        e.guards.add(guardId);
        e.months.add(month);
        noInput.set(keyOf(c.siteId, c.grade), e);
      }
      continue;
    }
    if (counts.size === 0) {
      for (const i of inputs) noShift.push({ reason: "no_cover_shift", guard_id: guardId, month, amount: i.amount });
      continue;
    }

    // (1) note 寫明盤名嘅輸入先配
    const remainingInputs: TaggedInput[] = [];
    for (const i of inputs) {
      const hit = [...new Set([...counts.values()].map((c) => c.siteId))].filter((sid) => !!i.note && i.note.includes(siteName(sid)));
      if (hit.length === 1) {
        const atSite = [...counts.values()].filter((c) => c.siteId === hit[0]);
        if (atSite.length === 1) {
          const c = atSite[0]!;
          const nc = noteCount(i.note);
          if (nc !== null && nc !== c.n) {
            // note 寫嘅更數同實際頂位更數唔一致：唔照用，列入分唔到
            ambiguous.push({ guard_id: guardId, month, total_amount: round2(i.amount), keys: [{ site_id: c.siteId, site_name: siteName(c.siteId), grade: c.grade, shifts: c.n }] });
            counts.delete(keyOf(c.siteId, c.grade));
            continue;
          }
          const nn = c.n;
          addObs(c.siteId, c.grade, { amount: round2(i.amount / nn), shifts: nn, guardId, month });
          counts.delete(keyOf(c.siteId, c.grade));
          continue;
        }
      }
      remainingInputs.push(i);
    }
    // (2) 餘下輸入對餘下更
    if (remainingInputs.length === 0) {
      for (const c of counts.values()) {
        const e = noInput.get(keyOf(c.siteId, c.grade)) ?? { shifts: 0, guards: new Set<string>(), months: new Set<string>() };
        e.shifts += c.n;
        e.guards.add(guardId);
        e.months.add(month);
        noInput.set(keyOf(c.siteId, c.grade), e);
      }
      continue;
    }
    const total = round2(remainingInputs.reduce((a, b) => a + b.amount, 0));
    if (counts.size === 0) {
      for (const i of remainingInputs) noShift.push({ reason: "no_cover_shift", guard_id: guardId, month, amount: i.amount });
    } else if (counts.size === 1) {
      const c = [...counts.values()][0]!;
      addObs(c.siteId, c.grade, { amount: round2(total / c.n), shifts: c.n, guardId, month });
    } else {
      ambiguous.push({ guard_id: guardId, month, total_amount: total, keys: [...counts.values()].map((c) => ({ site_id: c.siteId, site_name: siteName(c.siteId), grade: c.grade, shifts: c.n })) });
    }
  }

  const suggestions: Suggestion[] = [];
  for (const [k, list] of obs) {
    const [siteId, grade] = k.split("|") as [string, string];
    const byAmt = new Map<number, { shifts: number; guards: Set<string> }>();
    const guards = new Set<string>();
    const months = new Set<string>();
    let totalShifts = 0;
    for (const o of list) {
      const e = byAmt.get(o.amount) ?? { shifts: 0, guards: new Set<string>() };
      e.shifts += o.shifts;
      e.guards.add(o.guardId);
      byAmt.set(o.amount, e);
      guards.add(o.guardId);
      months.add(o.month);
      totalShifts += o.shifts;
    }
    const amounts = [...byAmt.entries()].map(([amount, e]) => ({ amount, shifts: e.shifts, guard_count: e.guards.size })).sort((a, b) => b.shifts - a.shifts || a.amount - b.amount);
    const status: InferStatus = totalShifts === 1 ? "single_sample" : amounts.length === 1 ? "consistent" : "mixed";
    const tie = amounts.length > 1 && amounts[0]!.shifts === amounts[1]!.shifts;
    suggestions.push({
      site_id: siteId,
      site_name: siteName(siteId),
      grade,
      status,
      suggested_amount: status === "mixed" && tie ? null : amounts[0]!.amount,
      needs_choice: status === "mixed",
      amounts,
      total_shifts: totalShifts,
      guard_count: guards.size,
      months: [...months].sort(),
    });
  }
  suggestions.sort((a, b) => a.site_name.localeCompare(b.site_name, "zh-Hant") || a.grade.localeCompare(b.grade));

  // 回測
  const price = new Map<string, number>();
  for (const s of suggestions) if (s.suggested_amount !== null) price.set(keyOf(s.site_id, s.grade), s.suggested_amount);
  const rows: BacktestRow[] = [];
  for (const gm of [...allKeys].sort()) {
    const [guardId, month] = gm.split("|") as [string, string];
    const shifts = shiftsByGm.get(gm) ?? [];
    const all = inputsByGm.get(gm) ?? [];
    let expected = 0;
    let unpriced = 0;
    for (const s of shifts) {
      const p = price.get(keyOf(s.siteId, s.grade));
      if (p === undefined) unpriced++;
      else expected += p;
    }
    const actual = round2(all.filter((i) => !isSellLeaveMixed(i.note)).reduce((a, b) => a + b.amount, 0));
    expected = round2(expected);
    rows.push({ month, guard_id: guardId, expected, actual, diff: round2(actual - expected), unpriced_shifts: unpriced, has_mixed_input: all.some((i) => isSellLeaveMixed(i.note)) });
  }
  const isMatch = (r: BacktestRow) => r.diff === 0 && r.unpriced_shifts === 0;
  const byMonth = inp.months.map((m) => {
    const rs = rows.filter((r) => r.month === m);
    return { month: m, guard_months: rs.length, matched: rs.filter(isMatch).length, diff_nonzero: rs.filter((r) => r.diff !== 0).length, max_abs_diff: rs.reduce((a, r) => Math.max(a, Math.abs(r.diff)), 0) };
  });
  const matched = rows.filter(isMatch).length;
  return {
    months: inp.months,
    suggestions,
    unresolved: {
      no_input: [...noInput.entries()].map(([k, e]) => {
        const [siteId, grade] = k.split("|") as [string, string];
        return { site_id: siteId, site_name: siteName(siteId), grade, shifts: e.shifts, guard_count: e.guards.size, months: [...e.months].sort() };
      }),
      no_shift: noShift,
      ambiguous,
    },
    backtest: {
      rows,
      summary: {
        guard_months: rows.length,
        matched,
        match_rate: rows.length ? round2((matched / rows.length) * 100) / 100 : null,
        diff_nonzero: rows.filter((r) => r.diff !== 0).length,
        max_abs_diff: rows.reduce((a, r) => Math.max(a, Math.abs(r.diff)), 0),
        unpriced_guard_months: rows.filter((r) => r.unpriced_shifts > 0).length,
        by_month: byMonth,
      },
    },
    stats: { cover_shifts: inp.shifts.length, tagged_inputs: inp.inputs.length, untagged_other_allowance_guard_months: inp.untaggedOtherAllowanceGuardMonths ?? 0 },
  };
}
