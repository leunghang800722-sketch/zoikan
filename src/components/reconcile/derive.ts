// WP-RECONCILE-UI（§33）：對數頁／月結分診共用嘅純函數——未配對原因分類＋人話、
// 相似保安員（純提示，唔配對唔寫入）、直達連結、needs_boss 對應。冇 React、冇 API 呼叫。

// ---------------------------------------------------------------------------
// 型別（wire format，snake_case，只取要用嘅欄）
// ---------------------------------------------------------------------------
export interface RawRosterRow {
  id: string;
  row_index: number;
  work_date?: string;
  name_raw: string | null;
  staff_no_raw: string | null;
  tel_raw: string | null;
  rank_raw: string | null;
  time_raw: string | null;
  broker_code_raw: string | null;
  raw_code?: string | null;
  sub_site_name?: string | null;
  warnings?: unknown;
  guard_match?: string | null;
}

export interface GuardLite {
  id: string;
  name_zh: string;
  staff_no?: string | null;
  staff_no_mw?: string | null;
  tel?: string | null;
  status?: string | null;
  staff_numbers?: Array<{ number: string; status?: string }> | null;
}

export interface NeedsBossItem {
  seq: string;
  cells: Array<{ site_label: string; cell_count: number }>;
  total_cell_count: number;
  reason: string;
  name_raw?: string | null;
  staff_no_raw?: string | null;
  tel_raw?: string | null;
  candidates?: Array<{ id: string; name_zh: string }>;
}

export interface Person {
  name: string;
  staffNo: string;
  tel: string;
}

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------
export const normName = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, "").toUpperCase();
export const normStaffNo = (s: string | null | undefined): string => (s ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();

/** 電話尾 4 位（淨係數字，少過 4 位當冇）。 */
export function tel4(s: string | null | undefined): string | null {
  const d = (s ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}

export function personFromRow(r: Pick<RawRosterRow, "name_raw" | "staff_no_raw" | "tel_raw"> | null | undefined): Person {
  return { name: (r?.name_raw ?? "").trim(), staffNo: (r?.staff_no_raw ?? "").trim(), tel: (r?.tel_raw ?? "").trim() };
}

export function personKey(p: Person): string {
  return `${normName(p.name)}|${normStaffNo(p.staffNo)}`;
}

/** 冇「保安員個人資料」權限：rows API 會成個欄位剷走（唔係 null）。 */
export const piiHidden = (r: object | null | undefined): boolean => !!r && !Object.prototype.hasOwnProperty.call(r, "name_raw") && !Object.prototype.hasOwnProperty.call(r, "staff_no_raw");

export const hasPerson = (p: Person): boolean => !!(normName(p.name) || normStaffNo(p.staffNo));

/** 顯示用：「測試甲／U90001」；冇工號就淨係姓名。 */
export function personLabel(p: Person): string {
  const n = p.name.trim();
  const s = p.staffNo.trim();
  if (n && s) return `${n}／${s}`;
  return n || s || "（更表冇寫姓名／工號）";
}

// ---------------------------------------------------------------------------
// 相似保安員（純提示）
// ---------------------------------------------------------------------------
export type SimilarWhy = "staff_no" | "name" | "tel4" | "surname_char";
export const SIMILAR_WHY_LABEL: Record<SimilarWhy, string> = {
  staff_no: "工號相同",
  name: "同名",
  tel4: "電話尾 4 位相同",
  surname_char: "同姓＋一字相同",
};
const WHY_SCORE: Record<SimilarWhy, number> = { staff_no: 100, name: 80, tel4: 60, surname_char: 40 };
const CJK_ONLY = /^[㐀-鿿]+$/;

function guardStaffNos(g: GuardLite): string[] {
  const out = [g.staff_no, g.staff_no_mw, ...(g.staff_numbers ?? []).map((x) => x.number)];
  return out.map((x) => normStaffNo(x)).filter(Boolean);
}

export function surnameCharMatch(a: string, b: string): boolean {
  const x = normName(a);
  const y = normName(b);
  if (x.length < 2 || y.length < 2 || x === y) return false;
  if (!CJK_ONLY.test(x) || !CJK_ONLY.test(y)) return false;
  if (x[0] !== y[0]) return false;
  const rest = new Set([...y.slice(1)]);
  return [...x.slice(1)].some((c) => rest.has(c));
}

export interface SimilarGuard {
  guard: GuardLite;
  why: SimilarWhy[];
  score: number;
}

/** 四種規則：同名／同工號／同姓＋一字相同／電話尾 4 位相同；最多 `max` 個（預設 3）。 */
export function findSimilar(p: Person, guards: GuardLite[], max = 3): SimilarGuard[] {
  const n = normName(p.name);
  const s = normStaffNo(p.staffNo);
  const t = tel4(p.tel);
  const out: SimilarGuard[] = [];
  for (const g of guards) {
    const why: SimilarWhy[] = [];
    if (s && guardStaffNos(g).includes(s)) why.push("staff_no");
    if (n && normName(g.name_zh) === n) why.push("name");
    if (t && tel4(g.tel) === t) why.push("tel4");
    if (n && !why.includes("name") && surnameCharMatch(p.name, g.name_zh)) why.push("surname_char");
    if (why.length === 0) continue;
    out.push({ guard: g, why, score: Math.max(...why.map((w) => WHY_SCORE[w])) + why.length });
  }
  out.sort((a, b) => b.score - a.score || a.guard.name_zh.localeCompare(b.guard.name_zh));
  return out.slice(0, max);
}

export const guardStatusLabel = (s: string | null | undefined): string => (s === "active" ? "在職" : s ? "非在職" : "狀態未知");

// ---------------------------------------------------------------------------
// 未配對原因分類＋人話
// ---------------------------------------------------------------------------
export type ReasonKind =
  | "guard"
  | "no_site"
  | "subsite_ambiguous"
  | "subsite_unmatched"
  | "broker_code"
  | "shift_type"
  | "leave_shift"
  | "voided_shift_type"
  | "out_of_month"
  | "duplicate"
  | "other";

export interface ReasonPart {
  kind: ReasonKind;
  /** 原文（後端句子，一律用嚟分類）。 */
  raw: string;
  /** broker_code：對唔到嘅雞頭碼；subsite_unmatched：子盤名。 */
  value?: string;
}

/** 後端 `unresolved_reason` 係用「；」接埋嘅多句（見 reconcile.ts）。 */
export function classifyReason(reason: string | null | undefined): ReasonPart[] {
  if (!reason) return [];
  return reason
    .split("；")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((raw): ReasonPart => {
      if (raw.includes("批量指定子盤")) return { kind: "subsite_ambiguous", raw };
      const sub = raw.match(/^子盤「(.*?)」對唔到/);
      if (sub) return { kind: "subsite_unmatched", raw, value: sub[1] };
      if (raw.includes("上載未指定盤")) return { kind: "no_site", raw };
      const bc = raw.match(/雞頭碼「(.*?)」對唔到/);
      if (bc) return { kind: "broker_code", raw, value: bc[1] };
      if (/^保?保安員未配對/.test(raw)) return { kind: "guard", raw };
      if (raw.includes("請假格推斷唔到")) return { kind: "leave_shift", raw };
      if (raw.startsWith("更別未配對")) return { kind: "shift_type", raw };
      if (raw.includes("更種已作廢")) return { kind: "voided_shift_type", raw };
      if (raw.startsWith("格仔日期")) return { kind: "out_of_month", raw };
      if (raw.includes("重複行")) return { kind: "duplicate", raw };
      return { kind: "other", raw };
    });
}

/** 人話：保安員未配對講明更表寫咗啲乜；其餘跟後端原句（本身已經係廣東話）。 */
export function humanizeReasonPart(part: ReasonPart, person: Person | null, piiHidden = false): string {
  if (part.kind === "guard") {
    if (piiHidden) return "更表有一個保安員名冊搵唔到（冇權限睇姓名／工號）";
    if (person && hasPerson(person)) return `更表寫「${personLabel(person)}」，名冊搵唔到`;
    return "更表呢行冇寫姓名／工號，名冊搵唔到";
  }
  if (part.kind === "no_site") return "呢份上載未指定盤，要先去更表上載列表頁指定盤";
  if (part.kind === "voided_shift_type") return "對到嘅更種已經作廢，要重新解析呢份上載";
  return part.raw;
}

/** 「更表寫咗」欄用：職級／時段 一句。 */
export function rankTimeText(r: Pick<RawRosterRow, "rank_raw" | "time_raw">): string {
  return [r.rank_raw?.trim(), r.time_raw?.trim()].filter(Boolean).join("・");
}

export function telTail(s: string | null | undefined): string | null {
  const t = tel4(s);
  return t ? `電話 ****${t}` : null;
}

// ---------------------------------------------------------------------------
// 直達連結（全部係純導航；deep link 參數只做預填／高亮）
// ---------------------------------------------------------------------------
const enc = encodeURIComponent;
export const LINK = {
  guardFix: (month: string) => `/guard-fix?month=${enc(month.slice(0, 7))}`,
  guards: (q: string) => `/guards?q=${enc(q)}`,
  newFromDocs: (name: string, staffNo: string) => {
    const p = new URLSearchParams();
    if (name.trim()) p.set("name", name.trim());
    if (staffNo.trim()) p.set("staff_no", staffNo.trim());
    const s = p.toString();
    return `/guards/new-from-docs${s ? `?${s}` : ""}`;
  },
  uploadFocus: (month: string, uploadId: string) => `/roster-uploads?month=${enc(month.slice(0, 7))}&focus=${enc(uploadId)}`,
  sites: (siteId: string | null | undefined) => (siteId ? `/sites?focus=${enc(siteId)}` : "/sites"),
  brokers: (code: string | null | undefined) => (code && code.trim() ? `/brokers?focus=${enc(code.trim())}` : "/brokers"),
  triage: "/triage",
} as const;

/** 搵保安員搜尋字：工號優先（唯一），冇就姓名。 */
export const guardSearchTerm = (p: Person): string => p.staffNo.trim() || p.name.trim();

// ---------------------------------------------------------------------------
// needs_boss 對應
// ---------------------------------------------------------------------------
export function matchNeedsBossByPerson(p: Person, items: NeedsBossItem[] | null | undefined): NeedsBossItem | null {
  if (!items || !hasPerson(p)) return null;
  const n = normName(p.name);
  const s = normStaffNo(p.staffNo);
  return items.find((x) => normName(x.name_raw) === n && normStaffNo(x.staff_no_raw) === s) ?? null;
}

/** 月結分診題 → needs_boss：先按 seq（題目文字有「(I001)」），再按姓名，再按盤名＋格數。 */
export function matchNeedsBossForQuestion(q: { title: string; summary: string; identity_label: string | null }, items: NeedsBossItem[] | null | undefined): NeedsBossItem | null {
  if (!items || items.length === 0) return null;
  const seqM = `${q.title} ${q.summary}`.match(/[（(]\s*(I\d{2,5})\s*[)）]/);
  if (seqM) {
    const bySeq = items.find((x) => x.seq === seqM[1]);
    if (bySeq) return bySeq;
  }
  // 題目標題：「保安員配對要核實（盤甲、盤乙，12 格）」
  const t = q.title.match(/（(.*)[，,]\s*(\d+)\s*格）/);
  const siteLabels = t ? t[1]!.split("、").map((x) => x.trim()).filter(Boolean) : [];
  const cellCount = t ? Number(t[2]) : null;
  const bySites = (x: NeedsBossItem) => cellCount !== null && x.total_cell_count === cellCount && siteLabels.length > 0 && siteLabels.every((l) => x.cells.some((c) => c.site_label === l));
  const nameN = normName(q.identity_label);
  if (nameN) {
    const byName = items.filter((x) => normName(x.name_raw) === nameN);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) return byName.find(bySites) ?? byName[0]!;
  }
  const bySite = items.filter(bySites);
  return bySite.length === 1 ? bySite[0]! : null;
}
