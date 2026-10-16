// W1：程式碼配對（唔靠 AI 認人／認日／認盤；計劃書 §5.3／§6.1）。
// 輸入：LLM 抽出嘅 intents（parse.ts）＋ 上下文；輸出：可寫入 whatsapp_intents 嘅解析結果＋ routed 判定。
// W1 只「判定」，唔執行寫入／唔開 Triage 題。resolution 只含原因碼、id 列表、basis 代碼——唔含訊息原文。
// 取捨（簡報未講清，採保守）：routed=auto_write 只睇 §6.1 第 1–6 項；第 7 項（群組 auto_write 開關）記入
// resolution.group_auto_write，供 W3 真正寫入時再把關（dry-run 期間試點群開關通常仍係關）。
import { classifySiteName, type SiteNameCandidate } from "@/lib/month-close/auto/site-match";
import type { GuardMatchIndex } from "@/lib/roster-upload/match";
import { normalizeTelHk } from "@/lib/guards/identity";
import type { ParsedIntent } from "./parse";
import { dateInWindow, resolveDates, addDays, hkDateOf } from "./dates";

type IntentKind = "shift" | "leave" | "cover" | "cancel" | "unclear" | "question_only";
type Routed = "auto_write" | "triage" | "ignored";

const MIN_AUTO_CONFIDENCE = 0.6;
const RECENT_DAYS = 60;

export interface ShiftTypeLite {
  id: string;
  siteId: string;
  code: string;
  label: string | null;
  /** 開工鐘數（0–23）；冇開工時間＝null */
  startHour: number | null;
}
export interface ExistingRecord {
  id: string;
  siteId: string;
  shiftTypeId: string;
  recordType: "shift" | "ot" | "leave";
  leaveCode: string | null;
  status: string;
}

/** DB 查詢抽象（job 用 Prisma 實作；單元測試用記憶體實作）。 */
export interface ResolveRepo {
  shiftTypes(siteId: string): Promise<ShiftTypeLite[]>;
  /** 近 N 日喺呢個盤有更嘅保安員 id。 */
  recentGuardIdsAtSite(siteId: string, sinceIso: string): Promise<Set<string>>;
  /** 近 N 日該判頭（結算判頭）名下有更嘅保安員 id。 */
  recentGuardIdsOfBroker(brokerId: string, sinceIso: string): Promise<Set<string>>;
  existing(guardId: string, dateIso: string): Promise<ExistingRecord[]>;
  headcount(siteId: string, shiftTypeId: string, dateIso: string): Promise<{ required: number | null; current: number }>;
  quota(guardId: string, siteId: string, shiftTypeId: string, dateIso: string): Promise<{ target: number; actual: number } | null>;
  monthLocked(dateIso: string): Promise<boolean>;
}

export interface ResolveContext {
  ts: Date;
  group: { id: string; kind: "site" | "multi_site" | "broker" | "office" | "ignored"; siteId: string | null; brokerId: string | null; shiftWordMap: Record<string, string>; autoWrite: boolean };
  senderGuardId: string | null;
  senderTelNorm: string | null;
  sites: readonly SiteNameCandidate[];
  index: GuardMatchIndex;
  repo: ResolveRepo;
}

interface Resolution {
  type: IntentKind;
  /** 阻擋自動寫入嘅原因碼 */
  reasons: string[];
  /** 資訊性備註碼（唔阻擋） */
  notes: string[];
  basis: { site?: string; person?: string; date?: string; shift?: string };
  candidates: { guard_ids?: string[]; site_ids?: string[]; dates?: string[]; shift_type_ids?: string[] };
  group_id: string;
  group_auto_write: boolean;
  replaced_guard_id?: string | null;
  replaced_candidate_ids?: string[];
  existing_record_ids?: string[];
  [k: string]: unknown;
}

export interface ResolvedIntent {
  kind: IntentKind;
  workDate: string | null;
  siteId: string | null;
  guardId: string | null;
  shiftTypeId: string | null;
  leaveCode: string | null;
  hours: number | null;
  confidence: number;
  resolution: Resolution;
  routed: Routed;
}

// ---------------------------------------------------------------- 盤口
interface SiteRes {
  siteId: string | null;
  reasons: string[];
  candidates: string[];
  basis: string;
}

function resolveSite(siteRaw: string | null | undefined, ctx: ResolveContext): SiteRes {
  const groupSite = ctx.group.kind === "site" ? ctx.group.siteId : null;
  const raw = (siteRaw ?? "").trim();
  if (!raw) {
    if (groupSite) return { siteId: groupSite, reasons: [], candidates: [], basis: "group" };
    return { siteId: null, reasons: ["site_ambiguous"], candidates: [], basis: "none_in_multi_site" };
  }
  const c = classifySiteName(raw, ctx.sites);
  if ((c.level === "exact" || c.level === "auto") && c.siteId) {
    if (groupSite && c.siteId !== groupSite) {
      return { siteId: c.siteId, reasons: ["site_ambiguous"], candidates: [groupSite, c.siteId], basis: "other_site_than_group" };
    }
    return { siteId: c.siteId, reasons: [], candidates: [], basis: c.level === "exact" ? "text_exact" : "text_auto" };
  }
  if (c.level === "propose") {
    const ids = c.candidates.length ? c.candidates.map((x) => x.siteId) : c.siteId ? [c.siteId] : [];
    return { siteId: null, reasons: ["site_ambiguous"], candidates: ids, basis: "text_propose" };
  }
  return { siteId: null, reasons: ["site_ambiguous"], candidates: groupSite ? [groupSite] : [], basis: "text_unknown" };
}

// ---------------------------------------------------------------- 人
interface PersonRes {
  guardId: string | null;
  reasons: string[];
  candidates: string[];
  basis: string;
}

const SELF_WORDS = /^(我|本人|自己|小弟|小妹|in)$/i;

function normName(raw: string): string {
  return raw.normalize("NFKC").trim();
}

async function orderCandidates(ids: string[], ctx: ResolveContext, siteId: string | null): Promise<string[]> {
  const since = addDays(hkDateOf(ctx.ts), -RECENT_DAYS);
  let list = ids;
  if (ctx.group.kind === "broker" && ctx.group.brokerId) {
    const ofBroker = await ctx.repo.recentGuardIdsOfBroker(ctx.group.brokerId, since);
    const narrowed = list.filter((g) => ofBroker.has(g));
    if (narrowed.length > 0) list = narrowed; // 只影響候選範圍，唔影響「唯一」判定
  }
  if (siteId) {
    const recent = await ctx.repo.recentGuardIdsAtSite(siteId, since);
    list = [...list].sort((a, b) => Number(recent.has(b)) - Number(recent.has(a)));
  }
  return list;
}

function resolveSelf(ctx: ResolveContext): PersonRes {
  if (ctx.senderGuardId && ctx.index.nameByGuardId.has(ctx.senderGuardId)) {
    return { guardId: ctx.senderGuardId, reasons: [], candidates: [], basis: "sender_phone" };
  }
  if (ctx.senderTelNorm) {
    const key = normalizeTelHk(ctx.senderTelNorm) ?? ctx.senderTelNorm;
    const hits = ctx.index.byTel?.get(key) ?? [];
    if (hits.length === 1) return { guardId: hits[0]!, reasons: [], candidates: [], basis: "sender_phone" };
    if (hits.length > 1) return { guardId: null, reasons: ["person_ambiguous"], candidates: [...hits], basis: "sender_phone_multi" };
  }
  return { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "sender_unmatched" };
}

async function resolveNamed(raw: string, ctx: ResolveContext, siteId: string | null): Promise<PersonRes> {
  const name = normName(raw);
  if (!name) return { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "empty_name" };
  if (SELF_WORDS.test(name)) return resolveSelf(ctx);
  const viaName = ctx.index.byName.get(name) ?? [];
  const viaAlias = ctx.index.byAlias.get(name) ?? [];
  const cands = [...new Set([...viaName, ...viaAlias])];
  if (cands.length === 1) return { guardId: cands[0]!, reasons: [], candidates: [], basis: viaName.includes(cands[0]!) ? "name" : "alias" };
  if (cands.length > 1) return { guardId: null, reasons: ["person_ambiguous"], candidates: await orderCandidates(cands, ctx, siteId), basis: "name_multi" };
  return { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "name_unmatched" };
}

// ---------------------------------------------------------------- 更別
interface ShiftRes {
  shiftTypeId: string | null;
  reasons: string[];
  candidates: string[];
  basis: string;
}

type Bucket = "morning" | "mid" | "night";
function bucketOf(word: string): Bucket | null {
  const w = word.replace(/[更班\s]/g, "");
  if (w === "早" || w === "朝") return "morning";
  if (w === "中" || w === "午") return "mid";
  if (w === "夜" || w === "通宵" || w === "晚") return "night";
  return null;
}
function hourBucket(h: number): Bucket {
  if (h >= 6 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "mid";
  return "night";
}

function pickByCode(types: ShiftTypeLite[], code: string): ShiftTypeLite[] {
  const c = code.trim().toLowerCase();
  return types.filter((t) => t.code.trim().toLowerCase() === c);
}

function resolveShift(shiftRaw: string | null | undefined, codeGuess: string | null | undefined, types: ShiftTypeLite[], wordMap: Record<string, string>): ShiftRes {
  const raw = (shiftRaw ?? "").normalize("NFKC").trim();
  if (!raw) return { shiftTypeId: null, reasons: ["shift_unmapped"], candidates: [], basis: "no_shift_word" };
  if (types.length === 0) return { shiftTypeId: null, reasons: ["shift_unmapped"], candidates: [], basis: "site_has_no_shift_types" };
  const stripped = raw.replace(/[更班\s]/g, "");
  const finish = (m: ShiftTypeLite[], basis: string): ShiftRes | null => {
    if (m.length === 1) return { shiftTypeId: m[0]!.id, reasons: [], candidates: [], basis };
    if (m.length > 1) return { shiftTypeId: null, reasons: ["shift_ambiguous"], candidates: m.map((x) => x.id), basis };
    return null;
  };
  // 1) 群組口語對照
  for (const k of [raw, stripped]) {
    if (k && Object.prototype.hasOwnProperty.call(wordMap, k)) {
      const r = finish(pickByCode(types, wordMap[k]!), "word_map");
      return r ?? { shiftTypeId: null, reasons: ["shift_unmapped"], candidates: [], basis: "map_code_not_at_site" };
    }
  }
  // 2) 直接更碼（N／N更／a更…）
  const direct = finish(pickByCode(types, stripped), "code");
  if (direct) return direct;
  // 3) 時段
  const b = bucketOf(raw);
  if (b) {
    const m = types.filter((t) => t.startHour !== null && hourBucket(t.startHour) === b);
    const r = finish(m, "time_slot");
    if (r) return r;
  }
  // 4) LLM 猜嘅更碼只可以做候選（唔自動採用）
  const g = (codeGuess ?? "").trim();
  if (g) {
    const m = pickByCode(types, g);
    if (m.length > 0) return { shiftTypeId: null, reasons: ["shift_ambiguous"], candidates: m.map((x) => x.id), basis: "llm_guess_only" };
  }
  return { shiftTypeId: null, reasons: ["shift_unmapped"], candidates: [], basis: "no_match" };
}

const LEAVE_TABLE: Array<{ code: string; re: RegExp }> = [
  { code: "SL", re: /病假|病|\bSL\b|sick/i },
  { code: "AL", re: /年假|\bAL\b|annual/i },
  { code: "NL", re: /事假|無薪|\bNL\b|\bNPL\b/i },
  { code: "RD", re: /例假|\bRD\b|\bOFF\b/i },
  { code: "SH", re: /公假|公眾假期|法定假|\bSH\b/i },
];
// 「放假／休息／休假」可以係年假、事假、例假——唔自動對 RD，留 leave_code 空＋leave_code_unclear（只有明確「例假／RD」先 RD）
const UNCLEAR_LEAVE_RE = /放假|休息|休假/;
export function mapLeaveCode(raw: string | null | undefined): { code: string | null; ambiguous: boolean; unclear?: boolean } {
  const t = (raw ?? "").normalize("NFKC").trim();
  if (!t) return { code: null, ambiguous: false };
  const hits = LEAVE_TABLE.filter((x) => x.re.test(t)).map((x) => x.code);
  if (hits.length === 1) return { code: hits[0]!, ambiguous: false };
  if (hits.length === 0 && UNCLEAR_LEAVE_RE.test(t)) return { code: null, ambiguous: false, unclear: true };
  return { code: null, ambiguous: hits.length > 1 };
}

function normLeave(code: string | null): string | null {
  if (code === "OFF") return "RD";
  if (code === "NPL") return "NL";
  return code;
}

// ---------------------------------------------------------------- 主流程
const AUTO_TYPES = new Set<IntentKind>(["shift", "leave"]);

function baseResolution(type: IntentKind, ctx: ResolveContext): Resolution {
  return { type, reasons: [], notes: [], basis: {}, candidates: {}, group_id: ctx.group.id, group_auto_write: ctx.group.autoWrite };
}

function pushUnique(arr: string[], ...v: string[]): void {
  for (const x of v) if (!arr.includes(x)) arr.push(x);
}

function unresolvedRow(kind: IntentKind, conf: number, res: Resolution, routed: Routed, extra?: Partial<ResolvedIntent>): ResolvedIntent {
  return { kind, workDate: null, siteId: null, guardId: null, shiftTypeId: null, leaveCode: null, hours: null, confidence: conf, resolution: res, routed, ...extra };
}

export async function resolveIntents(intents: readonly ParsedIntent[], ctx: ResolveContext): Promise<ResolvedIntent[]> {
  const out: ResolvedIntent[] = [];
  const seen = new Set<string>();
  const typeCache = new Map<string, ShiftTypeLite[]>();
  const typesOf = async (siteId: string) => {
    let t = typeCache.get(siteId);
    if (!t) {
      t = await ctx.repo.shiftTypes(siteId);
      typeCache.set(siteId, t);
    }
    return t;
  };

  for (const it of intents) {
    const kind = it.type as IntentKind;
    const conf = it.confidence;

    if (kind === "question_only") {
      const res = baseResolution(kind, ctx);
      pushUnique(res.reasons, "question_only");
      out.push(unresolvedRow(kind, conf, res, "ignored"));
      continue;
    }
    if (kind === "unclear") {
      const res = baseResolution(kind, ctx);
      pushUnique(res.reasons, "unclear");
      out.push(unresolvedRow(kind, conf, res, "triage"));
      continue;
    }

    // ---- 共用：盤口、日期、人
    const site = resolveSite(it.site_raw, ctx);
    const dateRes = resolveDates({ raw: it.date?.raw ?? null, kind: it.date?.kind ?? null }, ctx.ts);

    const workers: Array<{ raw: string | null; self: boolean }> = it.persons.filter((p) => p.role === "worker").map((p) => ({ raw: p.raw, self: SELF_WORDS.test(normName(p.raw)) }));
    if (it.self_reference && !workers.some((w) => w.self)) workers.unshift({ raw: null, self: true });
    const replaced = it.persons.filter((p) => p.role === "replaced");

    // 被替人（資訊）
    let replacedGuardId: string | null | undefined;
    let replacedCands: string[] | undefined;
    if (replaced.length > 0) {
      const r = await resolveNamed(replaced[0]!.raw, ctx, site.siteId);
      replacedGuardId = r.guardId;
      if (!r.guardId && r.candidates.length) replacedCands = r.candidates;
    }

    // 更別／請假碼（盤口定咗先解）
    let shift: ShiftRes | null = null;
    let leaveCode: string | null = null;
    const baseReasons: string[] = [];
    if (kind === "shift" || kind === "cover") {
      if (site.siteId) shift = resolveShift(it.shift_raw, it.shift_code_guess, await typesOf(site.siteId), ctx.group.shiftWordMap);
    } else if (kind === "leave") {
      const lv = mapLeaveCode(it.leave_raw);
      if (lv.code) leaveCode = lv.code;
      else baseReasons.push(lv.unclear ? "leave_code_unclear" : lv.ambiguous ? "leave_ambiguous" : "leave_unmapped");
    }

    const dates: Array<string | null> = dateRes.ok ? dateRes.dates : [null];
    const workerList = workers.length > 0 ? workers : [{ raw: null as string | null, self: false }];

    for (const w of workerList) {
      let person: PersonRes;
      if (w.self) person = resolveSelf(ctx);
      else if (w.raw === null) person = { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "no_person" };
      else person = await resolveNamed(w.raw, ctx, site.siteId);

      for (const d of dates) {
        const res = baseResolution(kind, ctx);
        res.basis = { site: site.basis, person: person.basis };
        if (shift) res.basis.shift = shift.basis;
        pushUnique(res.reasons, ...site.reasons, ...person.reasons, ...baseReasons);
        if (shift) pushUnique(res.reasons, ...shift.reasons);
        if (site.candidates.length) res.candidates.site_ids = site.candidates;
        if (person.candidates.length) res.candidates.guard_ids = person.candidates;
        if (shift && shift.candidates.length) res.candidates.shift_type_ids = shift.candidates;
        if (replacedGuardId !== undefined) res.replaced_guard_id = replacedGuardId;
        if (replacedCands) res.replaced_candidate_ids = replacedCands;
        if (dateRes.ok) {
          res.basis.date = dateRes.notes.join(",") || "single";
          if (dateRes.notes.includes("month_rolled")) pushUnique(res.notes, "month_rolled");
        } else {
          pushUnique(res.reasons, dateRes.reason === "date_missing" || dateRes.reason === "date_unparseable" ? dateRes.reason : "date_ambiguous");
          res.basis.date = dateRes.detail;
          if (dateRes.candidates.length) res.candidates.dates = dateRes.candidates;
        }
        if (!ctx.group.autoWrite) pushUnique(res.notes, "group_auto_write_off");

        const row: ResolvedIntent = {
          kind,
          workDate: d,
          siteId: site.siteId,
          guardId: person.guardId,
          shiftTypeId: shift?.shiftTypeId ?? null,
          leaveCode,
          hours: it.hours ?? null,
          confidence: conf,
          resolution: res,
          routed: "triage",
        };

        if (!AUTO_TYPES.has(kind)) {
          pushUnique(res.reasons, "type_not_auto"); // cover／cancel 首階段一律 Triage
          out.push(row);
          continue;
        }

        // ---- 日期窗口、鎖月
        if (d) {
          if (!dateInWindow(d, ctx.ts)) pushUnique(res.reasons, "date_out_of_range");
          else if (await ctx.repo.monthLocked(d)) pushUnique(res.reasons, "month_locked");
        }

        // ---- 衝突（要人、日子、（更別或請假碼）齊先查）
        const ready = row.guardId && d && ((kind === "shift" && row.shiftTypeId && row.siteId) || (kind === "leave" && row.leaveCode));
        if (ready) {
          const key = `${kind}|${row.guardId}|${d}|${kind === "shift" ? row.shiftTypeId : normLeave(row.leaveCode)}`;
          if (seen.has(key)) {
            res.reasons = ["duplicate_in_message"];
            row.routed = "ignored";
            out.push(row);
            continue;
          }
          seen.add(key);
          const ex = (await ctx.repo.existing(row.guardId!, d)).filter((r) => r.status !== "cancelled");
          const real = ex.filter((r) => r.recordType !== "ot");
          if (kind === "shift") {
            const same = real.filter((r) => r.recordType === "shift" && r.shiftTypeId === row.shiftTypeId);
            if (same.length > 0) {
              res.existing_record_ids = same.map((r) => r.id);
              res.reasons = ["already_exists"]; // no-op：同更已存在
              row.routed = "ignored";
              out.push(row);
              continue;
            }
            if (real.some((r) => r.recordType === "leave")) {
              pushUnique(res.reasons, "conflict_leave");
              res.existing_record_ids = real.map((r) => r.id);
            } else if (real.length > 0) {
              pushUnique(res.reasons, "conflict_other_shift");
              res.existing_record_ids = real.map((r) => r.id);
            }
            if (!res.reasons.includes("month_locked") && !res.reasons.includes("date_out_of_range") && real.length === 0) {
              const hc = await ctx.repo.headcount(row.siteId!, row.shiftTypeId!, d);
              if (hc.required !== null && hc.current >= hc.required) pushUnique(res.reasons, "slot_full");
              const q = await ctx.repo.quota(row.guardId!, row.siteId!, row.shiftTypeId!, d);
              if (q && q.actual >= q.target) pushUnique(res.reasons, "quota_full");
            }
          } else {
            const lv = normLeave(row.leaveCode);
            const sameLeave = real.filter((r) => r.recordType === "leave" && normLeave(r.leaveCode) === lv);
            if (sameLeave.length > 0) {
              res.existing_record_ids = sameLeave.map((r) => r.id);
              res.reasons = ["already_exists"];
              row.routed = "ignored";
              out.push(row);
              continue;
            }
            if (real.some((r) => r.recordType === "leave")) {
              pushUnique(res.reasons, "conflict_leave");
              res.existing_record_ids = real.map((r) => r.id);
            } else if (real.length > 0) {
              pushUnique(res.reasons, "conflict_shift_vs_leave");
              res.existing_record_ids = real.map((r) => r.id);
            }
          }
        }

        if (conf < MIN_AUTO_CONFIDENCE) pushUnique(res.reasons, "low_confidence"); // LLM 信心過低唔自動
        row.routed = res.reasons.length === 0 ? "auto_write" : "triage";
        out.push(row);
      }
    }
  }
  return out;
}
