// WP-MC-UI：月結頁嘅純推導函數（五步狀態列、③ 每步人話總結、自動處理摘要分類、
// 要你睇分組、⑤ 鎖定前置、體檢人話化）。全部由現有 API 回傳嘅數字砌出，
// 唔寫死示意數據；冇資料就回空／null，由 UI 顯示空狀態。冇 PII：淨係盤名、
// 雞頭代號、更種代號、數目。
import type { AutoReportDTO, ReportDTO, RunDTO, StepDTO } from "./types";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const fmtN = (n: number) => n.toLocaleString("zh-HK", { maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// 要你睇：按題型分組
// ---------------------------------------------------------------------------
export const REVIEW_GROUP_DEFS = [
  { key: "pricing", name: "定價", kinds: ["month_close_pricing"] },
  { key: "guard", name: "安員配對", kinds: ["month_close_guard_match"] },
  { key: "settlement", name: "結算雞頭", kinds: ["month_close_settlement"] },
  { key: "variance", name: "更數差異", kinds: ["month_close_shift_variance"] },
  { key: "site", name: "盤名／新盤", kinds: ["month_close_site_alias", "month_close_site_new"] },
  { key: "other", name: "其他", kinds: [] },
] as const;
export type ReviewGroupKey = (typeof REVIEW_GROUP_DEFS)[number]["key"];

export interface ReviewGroup {
  key: ReviewGroupKey;
  name: string;
  count: number;
  propose: number;
  unknown: number;
  preview: Array<{ text: string; confidence: "propose" | "unknown" }>;
  more: number;
}

/** 4 欄（定價／安員配對／結算雞頭／更數差異）固定出；「盤名／新盤」有題先出。0 題嘅欄照出（顯示 0）。 */
export function groupReview(review: AutoReportDTO["review"] | undefined | null): ReviewGroup[] {
  const list = review ?? [];
  const out: ReviewGroup[] = [];
  for (const def of REVIEW_GROUP_DEFS) {
    const known = REVIEW_GROUP_DEFS.flatMap((d) => d.kinds as readonly string[]);
    // 未知 kind 唔准靜靜丟：歸入「其他」，顯示原文。
    const items = def.key === "other" ? list.filter((r) => !known.includes(r.kind)) : list.filter((r) => (def.kinds as readonly string[]).includes(r.kind));
    if ((def.key === "site" || def.key === "other") && items.length === 0) continue;
    out.push({
      key: def.key,
      name: def.name,
      count: items.length,
      propose: items.filter((r) => r.confidence === "propose").length,
      unknown: items.filter((r) => r.confidence !== "propose").length,
      preview: items.slice(0, 2).map((r) => ({ text: r.text, confidence: r.confidence })),
      more: Math.max(0, items.length - 2),
    });
  }
  return out;
}

export function reviewTotals(review: AutoReportDTO["review"] | undefined | null) {
  const list = review ?? [];
  const propose = list.filter((r) => r.confidence === "propose").length;
  return { total: list.length, propose, unknown: list.length - propose };
}

// ---------------------------------------------------------------------------
// 五步狀態列
// ---------------------------------------------------------------------------
export type StageState = "ok" | "warn" | "todo";
export interface Stage {
  key: "upload" | "run" | "progress" | "report" | "lock";
  name: string;
  state: StageState;
  sub: string;
}

export function fmtMdHm(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function stepByKey(run: RunDTO | null, key: string): StepDTO | null {
  return run?.steps.find((s) => s.key === key) ?? null;
}

export interface UploadFacts {
  /** 今次 session 內成功上載更表嘅檔數。 */
  sessionRoster: number;
  sessionStaffList: boolean;
  sessionPostorder: boolean;
}

export interface UploadRow {
  key: "roster" | "staff_list" | "postorder";
  name: string;
  hint: string;
  have: boolean;
  status: string;
}

/** 三種上載嘅狀態：今次 session 上載 + 最新 run 步驟數字（API 冇獨立「上載紀錄」查詢，唔加）。 */
export function deriveUploads(run: RunDTO | null, facts: UploadFacts, report: ReportDTO | null): UploadRow[] {
  const parse = stepByKey(run, "parse_health");
  const pre = stepByKey(run, "precheck");
  const po = stepByKey(run, "postorder_compare");
  const runRoster = num(parse?.numbers.uploadCount) ?? num(stepByKey(run, "reconcile_apply")?.numbers.uploadCount);
  const missing = report?.lock_precondition.missing_upload_sites.length ?? 0;

  const rosterBits: string[] = [];
  if (runRoster !== null && runRoster > 0) rosterBits.push(`${runRoster} 份已上載`);
  else if (facts.sessionRoster > 0) rosterBits.push(`今次已上載 ${facts.sessionRoster} 份`);
  if (report && report.lock_precondition.unconfirmed_upload_sites.length > 0) rosterBits.push(`${report.lock_precondition.unconfirmed_upload_sites.length} 個盤未對數確認`);
  if (missing > 0) rosterBits.push(`${missing} 個盤未上載`);
  const haveRoster = (runRoster ?? 0) > 0 || facts.sessionRoster > 0;

  const ageDays = num(pre?.numbers.staffListAgeDays);
  const haveList = ageDays !== null || facts.sessionStaffList;
  const listStatus = facts.sessionStaffList ? "今次已上載" : ageDays !== null ? (ageDays <= 0 ? "已上載 · 今日" : `已上載 · ${ageDays} 日前`) : "未有紀錄";

  const poUploaded = po?.numbers.uploaded === true;
  const poFile = str(po?.numbers.fileName);
  const poRows = num(po?.numbers.referralRowCount);
  const havePo = poUploaded || facts.sessionPostorder;
  const poStatus = facts.sessionPostorder && !poUploaded ? "今次已上載" : poUploaded ? `已上載${poFile ? ` · ${poFile}` : ""}${poRows !== null ? ` · 介紹費 ${poRows} 行` : ""}` : "未上載（可選）";

  return [
    { key: "roster", name: "更表 xlsx", hint: "逐盤一檔，可以一次揀多個", have: haveRoster, status: rosterBits.length ? rosterBits.join(" · ") : "未有紀錄" },
    { key: "staff_list", name: "U Team 名單", hint: "新散工建檔用", have: haveList, status: listStatus },
    { key: "postorder", name: "Postorder 總表", hint: "可選 · 過渡對照", have: havePo, status: poStatus },
  ];
}

export function runSeconds(run: RunDTO | null): number | null {
  if (!run?.finished_at) return null;
  const s = (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000;
  return Number.isFinite(s) && s >= 0 ? Math.round(s) : null;
}

export function deriveStages(args: { run: RunDTO | null; report: ReportDTO | null; uploads: UploadRow[]; locked: boolean }): Stage[] {
  const { run, report, uploads, locked } = args;
  const rosterRow = uploads.find((u) => u.key === "roster")!;
  const haveAny = uploads.some((u) => u.have);
  const upBits: string[] = [];
  if (rosterRow.have) upBits.push("更表");
  if (uploads.find((u) => u.key === "staff_list")?.have) upBits.push("名單");
  if (uploads.find((u) => u.key === "postorder")?.have) upBits.push("總表");
  const upload: Stage = { key: "upload", name: "上載", state: haveAny ? "ok" : "todo", sub: haveAny ? upBits.join(" · ") : "未上載" };

  let runStage: Stage;
  if (!run) runStage = { key: "run", name: "一鍵結算", state: "todo", sub: "未跑" };
  else if (run.status === "running" && !run.stalled) runStage = { key: "run", name: "一鍵結算", state: "warn", sub: "執行緊" };
  else if (run.stalled || run.status === "failed") runStage = { key: "run", name: "一鍵結算", state: "warn", sub: run.stalled ? "卡住咗" : "失敗" };
  else runStage = { key: "run", name: "一鍵結算", state: "ok", sub: `${fmtMdHm(run.finished_at ?? run.started_at)} 跑完` };

  let progress: Stage;
  if (!run) progress = { key: "progress", name: "進度", state: "todo", sub: "未開始" };
  else {
    const doneN = run.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    const failed = run.steps.some((s) => s.status === "failed") || run.status === "failed" || run.stalled;
    progress = { key: "progress", name: "進度", state: failed ? "warn" : doneN === run.steps.length && run.steps.length > 0 ? "ok" : run.status === "running" ? "warn" : "todo", sub: `${doneN} / ${run.steps.length} 步` };
  }

  let rep: Stage;
  if (!report) rep = { key: "report", name: "報告", state: "todo", sub: "未出" };
  else {
    const q = report.auto?.review.length ?? 0;
    rep = q > 0 ? { key: "report", name: "報告", state: "warn", sub: `${q} 題要你睇` } : { key: "report", name: "報告", state: "ok", sub: "已出" };
  }

  let lock: Stage;
  if (locked) lock = { key: "lock", name: "鎖定", state: "ok", sub: "已鎖定" };
  else if (!report) lock = { key: "lock", name: "鎖定", state: "todo", sub: "未到" };
  else {
    const reqs = lockRequirements(report, 0);
    lock = reqs.length === 0 && report.lock_precondition.ready_to_lock ? { key: "lock", name: "鎖定", state: "warn", sub: "可以鎖" } : { key: "lock", name: "鎖定", state: "todo", sub: reqs.length > 0 ? `仲差 ${reqs.length} 樣` : "未可以鎖" };
  }
  return [upload, runStage, progress, rep, lock];
}

// ---------------------------------------------------------------------------
// ③ 進度：每步一句人話 + chip
// ---------------------------------------------------------------------------
export function stepSummary(step: StepDTO): string {
  const n = step.numbers;
  if (step.status === "pending") return "等緊";
  if (step.status === "running") return "執行緊……";
  if (step.status === "skipped") return "略過";
  if (step.status === "failed") return step.warnings[0] ?? "呢步出錯，睇技術明細";
  switch (step.key) {
    case "precheck": {
      if (n.currentMonthLocked === true) return "本月已鎖定，一鍵結算已停低";
      if (n.prevMonthHasData === true && n.prevMonthLocked === false) return "上月未鎖，已停低——請先鎖定上月";
      const parts: string[] = [];
      if (n.prevMonthHasData === true && n.prevMonthLocked === true) parts.push("上月已鎖、有數");
      else if (n.prevMonthHasData === false) parts.push("上月冇數據");
      const miss = num(n.siteMissingShiftTypeCount);
      if (miss) parts.push(`${miss} 個盤未設更種`);
      const noCard = num(n.cardsMissingNoCarryover);
      if (noCard) parts.push(`${noCard} 個盤冇生效價卡`);
      return parts.length ? parts.join("；") : "前置條件齊";
    }
    case "parse_health": {
      const up = num(n.uploadCount);
      const shifts = num(n.totalShiftCount);
      let s = up !== null && shifts !== null ? `${up} 份更表、共讀到 ${fmtN(shifts)} 更` : "更表已解析";
      const flagged = num(n.varianceFlagged);
      if (flagged) s += `；${flagged} 個盤更數同上月差好遠，${num(n.varianceExplained) ?? 0} 個已搵到原因`;
      return s;
    }
    case "guard_fix": {
      const remaining = num(n.remainingNeedsBoss) ?? 0;
      const linkedCells = num(n.autoLinkedCells) ?? 0;
      const parts: string[] = [];
      if (linkedCells > 0) parts.push(`自動配咗 ${fmtN(linkedCells)} 格安員`);
      parts.push(remaining > 0 ? `${remaining} 組對唔到安員，系統唔敢自己決定` : "冇對唔到安員嘅格");
      return parts.join("；");
    }
    case "longterm_settlement": {
      const scanned = num(n.longtermRowsScanned);
      const changed = num(n.longtermRowsChanged);
      return scanned !== null ? `掃咗 ${fmtN(scanned)} 行長工資料，更新咗 ${fmtN(changed ?? 0)} 行` : "長工資料已處理";
    }
    case "reconcile_apply": {
      const up = num(n.uploadCount);
      const errs = num(n.uploadsWithErrors) ?? 0;
      return `${up ?? 0} 個盤以更表為準套用，${errs > 0 ? `${errs} 個出錯` : "冇出錯"}`;
    }
    case "auto_pricing": {
      if (n.skipped === true) return "2026-08 之前嘅月份唔做自動歸屬／定價";
      const parts: string[] = [];
      const cards = num(n.cardsCreated);
      const priced = num(n.recordsPriced);
      const assigned = num(n.settlementAssigned);
      if (cards) parts.push(`建咗 ${cards} 張價卡`);
      if (priced) parts.push(`定價 ${fmtN(priced)} 更`);
      if (assigned) parts.push(`${fmtN(assigned)} 更歸屬雞頭`);
      return parts.length ? parts.join("、") : "冇需要自動處理";
    }
    case "pricing_check": {
      const count = num(n.count) ?? 0;
      if (count === 0) return "全部更都有價";
      const parts: string[] = [];
      const payout = num(n.payoutCount) ?? 0;
      const client = num(n.clientCount) ?? 0;
      const noSet = num(n.noSettlementCount) ?? 0;
      if (payout) parts.push(`${fmtN(payout)} 更未有出街價`);
      if (client) parts.push(`${fmtN(client)} 更未有客價`);
      if (noSet) parts.push(`${fmtN(noSet)} 更冇結算雞頭`);
      return `仲有 ${parts.length ? parts.join("、") : `${fmtN(count)} 更未定價`}`;
    }
    case "compute": {
      const sites = num(n.siteCount);
      const rev = num(n.totalRevenue);
      const cost = num(n.totalCost);
      const bits: string[] = [];
      if (sites !== null) bits.push(`${sites} 個盤`);
      bits.push(`收入 ${rev !== null ? fmtN(rev) : "—"}`);
      bits.push(`成本 ${cost !== null ? fmtN(cost) : "—"}`);
      return bits.join(" · ");
    }
    case "postorder_compare": {
      if (n.uploaded !== true) return "冇上載 Postorder，略過對照";
      const diff = num(n.referralDiff);
      if (diff === null) return "總表冇提供介紹費金額，唔比較";
      return diff === 0 ? "介紹費同 Postorder 總表一致" : `介紹費同 Postorder 總表差 ${fmtN(Math.abs(diff))} 元`;
    }
    case "report":
      return "月結報告已出";
    default:
      return "完成";
  }
}

/** 每步 chip：自動 N（系統自己做咗）／N 題（要你睇）。由 report.auto 數字砌，冇 report 就無 chip。 */
export function stepChips(key: string, auto: AutoReportDTO | undefined | null): { auto: number; q: number } {
  if (!auto) return { auto: 0, q: 0 };
  const s = auto.summary;
  const qOf = (...kinds: string[]) => auto.review.filter((r) => kinds.includes(r.kind)).length;
  switch (key) {
    case "precheck":
      return { auto: s.shift_types_created, q: 0 };
    case "parse_health":
      return { auto: s.sites_aliased + s.sites_created + s.variances_explained, q: qOf("month_close_site_alias", "month_close_site_new", "month_close_shift_variance") };
    case "guard_fix":
      return { auto: s.guard_matches_auto, q: qOf("month_close_guard_match") };
    case "auto_pricing":
      return { auto: s.cards_created + s.records_priced + s.records_settled, q: qOf("month_close_settlement") };
    case "pricing_check":
      return { auto: 0, q: qOf("month_close_pricing") };
    default:
      return { auto: 0, q: 0 };
  }
}

export function stepSeconds(step: StepDTO): string {
  if (!step.started_at || !step.finished_at) return "";
  const s = (new Date(step.finished_at).getTime() - new Date(step.started_at).getTime()) / 1000;
  if (!Number.isFinite(s) || s < 0) return "";
  return `${s < 10 ? s.toFixed(1) : Math.round(s)} 秒`;
}

/** 技術明細：只出原始 key=value（俾 IT 對數）。 */
export function stepKv(step: StepDTO): string[] {
  return Object.entries(step.numbers)
    .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    .map(([k, v]) => `${k}=${String(v)}`);
}

// ---------------------------------------------------------------------------
// ④ 自動處理摘要：分類 + 明細行
// ---------------------------------------------------------------------------
export type AutoCatKey = "other" | "shift_types" | "cards" | "priced" | "settled" | "variance" | "sites_aliased" | "sites_created" | "guard_auto";

export interface AutoRow {
  site: string;
  shiftType: string;
  broker: string;
  n: number | null;
  price: string;
  basis: string;
}
export interface AutoCategory {
  key: AutoCatKey;
  name: string;
  n: number;
  unit: string;
  sub: string;
  rows: AutoRow[];
}

const PRICING_RE = /^盤「(.*?)」更種「(.*?)」(?:雞頭 (\S+) )?(\d+) 更自動定價（([\s\S]*)）$/;
const SETTLE_RE = /^(\d+) 更冇結算雞頭，自動歸 (\S+?)（([\s\S]*)）$/;
const SHIFT_TYPE_RE = /「(.+?)」自動建 (\d+) 個更種/;
const VARIANCE_RE = /^更數差異已解釋：「(.+?)」([\s\S]*)$/;
const SITE_NEW_RE = /^新盤「(.+?)」([\s\S]*)$/;
const SITE_ALIAS_RE = /^更表盤名「(.+?)」自動對上盤「(.+?)」([\s\S]*)$/;
const GUARD_RE = /^安員配對 [^（]*（([\s\S]*?)，(\d+) 格）自動配對：([\s\S]*)$/;

const blankRow = (): AutoRow => ({ site: "", shiftType: "", broker: "", n: null, price: "", basis: "" });

export function parsePricingLine(text: string): AutoRow | null {
  const m = PRICING_RE.exec(text);
  if (!m) return null;
  const inner = m[5] ?? "";
  const cut = inner.indexOf("；");
  return { site: m[1]!, shiftType: m[2]!, broker: m[3] ?? "", n: Number(m[4]), price: cut >= 0 ? inner.slice(0, cut) : inner, basis: cut >= 0 ? inner.slice(cut + 1) : "" };
}

export function deriveAutoCategories(auto: AutoReportDTO): { cats: AutoCategory[]; zero: string[]; total: number } {
  const s = auto.summary;
  const lines = auto.auto_lines;
  const rowsShiftTypes: AutoRow[] = [];
  const rowsPricing: AutoRow[] = [];
  const rowsSettled: AutoRow[] = [];
  const rowsVariance: AutoRow[] = [];
  const rowsAlias: AutoRow[] = [];
  const rowsNew: AutoRow[] = [];
  const rowsGuard: AutoRow[] = [];
  const rowsOther: AutoRow[] = [];
  for (const l of lines) {
    const t = l.text;
    if (l.kind === "shift_type_created") {
      const m = SHIFT_TYPE_RE.exec(t);
      rowsShiftTypes.push(m ? { ...blankRow(), site: m[1]!, n: Number(m[2]), basis: "由更表代號＋時段推出" } : { ...blankRow(), site: t });
    } else if (l.kind === "pricing") {
      const p = parsePricingLine(t);
      const st = SETTLE_RE.exec(t);
      if (p) rowsPricing.push(p);
      else if (st) rowsSettled.push({ ...blankRow(), broker: st[2]!, n: Number(st[1]), basis: st[3]! });
      else rowsPricing.push({ ...blankRow(), basis: t });
    } else if (l.kind === "variance") {
      const m = VARIANCE_RE.exec(t);
      rowsVariance.push(m ? { ...blankRow(), site: m[1]!, basis: m[2]!.replace(/^[，：\s]+/, "") } : { ...blankRow(), basis: t });
    } else if (l.kind === "site_created") {
      const m = SITE_NEW_RE.exec(t);
      rowsNew.push(m ? { ...blankRow(), site: m[1]!, basis: m[2]! } : { ...blankRow(), basis: t });
    } else if (l.kind === "site_alias") {
      const m = SITE_ALIAS_RE.exec(t);
      rowsAlias.push(m ? { ...blankRow(), site: m[2]!, basis: `更表寫「${m[1]!}」${m[3]!}` } : { ...blankRow(), basis: t });
    } else if (l.kind === "guard_match") {
      const m = GUARD_RE.exec(t);
      rowsGuard.push(m ? { ...blankRow(), site: m[1]!, n: Number(m[2]), basis: m[3]! } : { ...blankRow(), basis: t });
    } else {
      rowsOther.push({ ...blankRow(), basis: t });
    }
  }
  const all: AutoCategory[] = [
    { key: "shift_types", name: "新盤更種", n: s.shift_types_created, unit: "個", sub: "跟更表代號＋時段推出嚟", rows: rowsShiftTypes },
    { key: "cards", name: "自動建價卡", n: s.cards_created, unit: "張", sub: "新價卡全部標咗來源", rows: rowsPricing.filter((r) => r.site) },
    { key: "priced", name: "自動定價", n: s.records_priced, unit: "更", sub: "跟價卡／Postorder 定價", rows: rowsPricing },
    { key: "settled", name: "歸屬結算雞頭", n: s.records_settled, unit: "更", sub: "跟 Postorder／長工／預設雞頭", rows: rowsSettled },
    { key: "variance", name: "解釋更數差異", n: s.variances_explained, unit: "個盤", sub: "更數同上月差好遠，但搵到原因", rows: rowsVariance },
    { key: "sites_aliased", name: "自動對盤", n: s.sites_aliased, unit: "個", sub: "更表盤名對上現有盤", rows: rowsAlias },
    { key: "sites_created", name: "自動建新盤", n: s.sites_created, unit: "個", sub: "更表有、系統未有嘅盤", rows: rowsNew },
    { key: "guard_auto", name: "自動安員配對", n: s.guard_matches_auto, unit: "組", sub: "有建議先自動配", rows: rowsGuard },
    { key: "other", name: "其他", n: rowsOther.length, unit: "項", sub: "未分類，睇原文", rows: rowsOther },
  ];
  return { cats: all.filter((c) => c.n > 0), zero: all.filter((c) => c.n === 0 && c.key !== "other").map((c) => `${c.name} 0`), total: all.reduce((a, c) => a + c.n, 0) };
}

// ---------------------------------------------------------------------------
// ⑤ 鎖定前置
// ---------------------------------------------------------------------------
export interface LockReq {
  key: "missing_upload" | "unconfirmed" | "unpriced";
  title: string;
  detail: string;
  action: "roster-uploads" | "triage";
  actionLabel: string;
}

function nameList(names: string[], max = 5): string {
  return names.length <= max ? names.join("、") : `${names.slice(0, max).join("、")} … 再多 ${names.length - max} 個`;
}

/** 「一定要做好先可以鎖」：由 report.lock_precondition 推。pricingQuestions＝要你睇入面定價題數（只用嚟寫「＝ 要你睇 N 題」）。 */
export function lockRequirements(report: ReportDTO, pricingQuestions: number): LockReq[] {
  const lp = report.lock_precondition;
  const out: LockReq[] = [];
  if (lp.missing_upload_sites.length > 0) out.push({ key: "missing_upload", title: `${lp.missing_upload_sites.length} 個盤未上載更表`, detail: humanize(nameList(lp.missing_upload_sites)), action: "roster-uploads", actionLabel: "去更表上載 ›" });
  if (lp.unconfirmed_upload_sites.length > 0) out.push({ key: "unconfirmed", title: `${lp.unconfirmed_upload_sites.length} 個盤嘅更表未對數確認`, detail: humanize(nameList(lp.unconfirmed_upload_sites)), action: "roster-uploads", actionLabel: "去更表上載 ›" });
  const unpriced = lp.unpriced_count ?? 0;
  if (unpriced > 0) {
    out.push({
      key: "unpriced",
      title: `${fmtN(unpriced)} 更未定價`,
      detail: pricingQuestions > 0 ? `即係「要你睇」入面嘅 ${pricingQuestions} 題定價題` : "未有對應嘅「要你睇」題，要去價目設定或重新一鍵結算",
      action: "triage",
      actionLabel: pricingQuestions > 0 ? `去答 ${pricingQuestions} 題 ›` : "",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 體檢：人話化 + 同「要你睇」重複標記
// ---------------------------------------------------------------------------
export function humanizeHealth(message: string): string {
  return message
    .replace(/（ambiguous）/g, "")
    .replace(/（unmatched）/g, "")
    .replace(/（name_only）/g, "")
    .replace(/安員配對有多個候選/g, "安員有多個可能")
    .replace(/安員配對唔到/g, "對唔到安員")
    .replace(/\bambiguous\b/g, "有多個可能")
    .replace(/\bunmatched\b/g, "對唔到安員")
    .replace(/\bname_only\b/g, "淨靠姓名配對")
    .replace(/\s+/g, " ")
    .trim();
}

export function humanizeHealthCell(v: string): string {
  if (v === "shift") return "更";
  if (v === "leave") return "假";
  if (v === "ot") return "OT";
  if (v === "unmatched") return "對唔到安員";
  if (v === "ambiguous") return "有多個可能";
  if (v === "name_only") return "淨靠姓名配對";
  return v;
}

const HEALTH_DUP_GROUP: Record<string, ReviewGroupKey> = {
  unpriced_payout: "pricing",
  unpriced_client: "pricing",
  ot_unpriced: "pricing",
  no_settlement: "settlement",
  ambiguous_cells: "guard",
  unmatched_cells: "guard",
};

/** 體檢 finding 同「要你睇」重複嘅，回要你睇題數（>0 先標「＝ 要你睇 N 題」）。 */
export function healthDupReviewCount(code: string, groups: ReviewGroup[]): number {
  const g = HEALTH_DUP_GROUP[code];
  if (!g) return 0;
  return groups.find((x) => x.key === g)?.count ?? 0;
}

// ---------------------------------------------------------------------------
// ④ KPI
// ---------------------------------------------------------------------------
export interface CostStack {
  parts: Array<{ key: "shift" | "referral" | "autopay"; label: string; value: number; pct: number }>;
  total: number;
}

export function deriveCostStack(c: ReportDTO["combined_cost_summary"]): CostStack | null {
  if (!c) return null;
  const vals = [c.per_shift_cost_total, c.referral_fee_total, c.longterm_autopay_total];
  if (vals.some((v) => typeof v !== "number")) return null; // 金額按角色隱藏
  const total = vals.reduce((a, b) => a + b, 0);
  const mk = (key: "shift" | "referral" | "autopay", label: string, value: number) => ({ key, label, value, pct: total > 0 ? (Math.max(0, value) / total) * 100 : 0 });
  return { total, parts: [mk("shift", "更次", vals[0]!), mk("referral", "介紹費", vals[1]!), mk("autopay", "長工 Autopay", vals[2]!)] };
}

export function marginPct(t: ReportDTO["totals"]): number | null {
  const base = typeof t.margin_revenue === "number" ? t.margin_revenue : t.revenue;
  if (typeof base !== "number" || typeof t.gross_margin !== "number" || base <= 0) return null;
  return Math.round((t.gross_margin / base) * 1000) / 10;
}

export function splitSiteRevenue(rows: ReportDTO["site_revenue"]): { shown: ReportDTO["site_revenue"]; rest: ReportDTO["site_revenue"]; zeroCount: number; max: number } {
  const active = rows.filter((r) => r.shifts > 0 || r.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  const zeroCount = rows.length - active.length;
  return { shown: active.slice(0, 10), rest: active.slice(10), zeroCount, max: active[0]?.revenue ?? 0 };
}

/** 「還原所有自動改動」說明（老闆 2026-10-09 指定；桌面右欄／摘要頭／確認對話框／手機完成頁共用）。 */
export const UNDO_NOTE = "只還原系統自動做嘅改動（自動建嘅更種、價卡、補價、歸屬、別名；安員自動登記嘅別名／工號都會還原）。自動建嘅盤唔會刪。你喺「要你睇」一撳確認咗嘅答案唔會還原；仲未答嘅題會作廢，下次重跑會重新出。已經人手改過價嘅更唔會郁。";
export const UNDO_NOTE_SHORT = "只還原系統自動做嘅改動；你一撳確認咗嘅答案唔會還原，未答嘅題會作廢，人手改過價嘅更唔會郁。";

/** 顯示 API 文字前嘅禁用詞替換（集中處理；API 文字唔改）。 */
export function humanize(text: string): string {
  return text
    .replace(/（parsed）/g, "（已解析，未對數）")
    .replace(/冇依據/g, "要你揀")
    .replace(/有依據/g, "有建議")
    .replace(/(?<![A-Za-z_])unmatched(?![A-Za-z_])/gi, "對唔到安員")
    .replace(/(?<![A-Za-z_])ambiguous(?![A-Za-z_])/gi, "有多個可能")
    .replace(/(?<![A-Za-z_])name_only(?![A-Za-z_])/gi, "淨靠姓名配對")
    .replace(/(?<![A-Za-z_])shift(?![A-Za-z_])/gi, "更")
    .replace(/(?<![A-Za-z_])leave(?![A-Za-z_])/gi, "假")
    .replace(/(?<![A-Za-z_])external(?![A-Za-z_])/gi, "客戶自己人")
    .replace(/(?<![A-Za-z_])parsed(?![A-Za-z_])/gi, "已解析");
}

/** 題型 chip：UI 自己按 kind 對應（唔直接顯示 API kind_label，佢會出「冇依據」等禁用詞）。 */
export function kindChip(kind: string, fallbackLabel: string): string {
  switch (kind) {
    case "month_close_pricing":
      return "定價";
    case "month_close_guard_match":
      return "安員配對";
    case "month_close_settlement":
      return "結算雞頭";
    case "month_close_shift_variance":
      return "更數差異";
    case "month_close_site_alias":
    case "month_close_site_new":
      return "盤名";
    default:
      return humanize(fallbackLabel);
  }
}

/** 全部步驟 needs_human 項數（③ 逐行直接顯示；規則：needs_human 行全部顯示，唔同「要你睇」去重——簡單規則）。 */
export function needsHumanCount(run: RunDTO | null): number {
  return run ? run.steps.reduce((a, s) => a + s.needs_human.length, 0) : 0;
}
