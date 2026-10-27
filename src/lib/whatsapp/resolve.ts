// W1：程式碼配對（唔靠 AI 認人／認日／認盤；計劃書 §5.3／§6.1）。
// 輸入：LLM 抽出嘅 intents（parse.ts）＋ 上下文；輸出：可寫入 whatsapp_intents 嘅解析結果＋ routed 判定。
// W1 只「判定」，唔執行寫入／唔開 Triage 題。resolution 只含原因碼、id 列表、basis 代碼——唔含訊息原文。
// 取捨（簡報未講清，採保守）：routed=auto_write 只睇 §6.1 第 1–6 項；第 7 項（群組 auto_write 開關）記入
// resolution.group_auto_write，供 W3 真正寫入時再把關（dry-run 期間試點群開關通常仍係關）。
import { foldVariants } from "@/lib/names/variants";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { rosterNameKey } from "./name-key";
import { guardsByName } from "./name-index";
import { classifySiteName, type SiteNameCandidate } from "@/lib/month-close/auto/site-match";
import type { GuardMatchIndex } from "@/lib/roster-upload/match";
import { normalizeTelHk } from "@/lib/guards/identity";
import type { ParsedIntent } from "./parse";
import type { WaCardEvidence } from "./triage-types";
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
  /** 開工分鐘（0–59）；冇提供（undefined／null）＝只對鐘數 */
  startMinute?: number | null;
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

/** 盤名候選＋所屬客戶（client_group 優先，冇就 client_name；用嚟判斷兄弟盤）。 */
export type WaSite = SiteNameCandidate & { client?: string | null };

export interface ResolveContext {
  ts: Date;
  group: { id: string; kind: "site" | "multi_site" | "broker" | "office" | "ignored"; siteId: string | null; brokerId: string | null; shiftWordMap: Record<string, string>; /** W5：群組請假詞覆寫（優先於內建）；冇就用內建 */ leaveWordMap?: Record<string, string>; autoWrite: boolean };
  senderGuardId: string | null;
  senderTelNorm: string | null;
  /** WA-8：intents[idx] 嘅覆寫（冇＝照舊） */
  overrides?: ReadonlyMap<number, IntentOverride>;
  sites: readonly WaSite[];
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
  /** W4：替更題——被替者當日（同盤同更別）嘅現有更記錄 */
  replaced_record_ids?: string[];
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
  /** WA-9 (7)：呢行對應輸入 intents 嘅 index（一個 intent 可展開多行；roster/caption 對返來源用，唔落 DB） */
  intentIdx?: number;
  /** W2：LLM 抽出嘅原始片段（記憶體限定，唔落 whatsapp_intents；Triage 題 evidence 用，含人名＝PII，只存 DB）。 */
  src?: IntentSrc;
}

/** WA-8：工卡相——每張卡由 card-resolve.ts 預先算好人／盤／更，覆寫 resolveIntents 對應步驟（其餘日期、衝突、額滿、鎖月等檢查照舊）。 */
export interface IntentOverride {
  person?: { guardId: string | null; reasons: string[]; candidates: string[]; basis: string };
  site?: { siteId: string | null; reasons: string[]; candidates: string[]; basis: string };
  shift?: { shiftTypeId: string | null; reasons: string[]; candidates: string[]; basis: string };
  /** 額外阻擋自動寫入嘅原因碼（例：card_confirm） */
  extraReasons?: string[];
  extraNotes?: string[];
}

export interface IntentSrc {
  /** WA-8：工卡相辨識資料（evidence 用，DB 內） */
  card?: WaCardEvidence;
  /** WA-9：名單／相片差異（一日一條合併題） */
  mismatch?: { day: string; roster_only: string[]; photo_only: string[] };
  /** WA-9 (7)：名單配唔到嘅名——(群,日,名) 固定 groupKey（重發唔再開題） */
  dedupe_key?: string;
  /** WA-9 (8)：短訊路徑揀人題嘅 (群,日,名) 固定 key（同名單路徑 rosterNameKey 一樣） */
  name_key?: string;
  person_raw: string | null;
  site_raw: string | null;
  date_raw: string | null;
  shift_raw: string | null;
  leave_raw: string | null;
  replaced_raw: string | null;
}

// ---------------------------------------------------------------- 盤口
interface SiteRes {
  siteId: string | null;
  reasons: string[];
  candidates: string[];
  basis: string;
}

// 盤名／別名先做字形折疊（簡繁、異體字：「厚徳」＝「厚德」）再配對；ids 不變
const foldedSites = new WeakMap<ResolveContext["sites"], ResolveContext["sites"]>();
function foldSites(sites: ResolveContext["sites"]): ResolveContext["sites"] {
  let f = foldedSites.get(sites);
  if (!f) {
    f = sites.map((s) => ({ ...s, canonicalName: foldVariants(s.canonicalName), aliases: s.aliases.map((a) => foldVariants(a)) }));
    foldedSites.set(sites, f);
  }
  return f;
}

/** 文字（已折疊）命中邊啲盤：盤名／別名（≥2 字）等於文字，或文字包含該名。owners＝掛住同一個名嘅盤數（1＝獨有，≥2＝多盤共用）。 */
function siteTextHits(rawF: string, sites: ResolveContext["sites"]): Array<{ siteId: string; name: string; owners: number }> {
  const ownersOf = new Map<string, Set<string>>();
  for (const s of sites) for (const n of [s.canonicalName, ...s.aliases]) if (n && n.length >= 2) ownersOf.set(n, new Set([...(ownersOf.get(n) ?? []), s.id]));
  const out: Array<{ siteId: string; name: string; owners: number }> = [];
  for (const [name, ids] of ownersOf) if (rawF === name || rawF.includes(name)) for (const id of ids) out.push({ siteId: id, name, owners: ids.size });
  return out;
}

/**
 * 文字（已折疊）係咪群盤名嘅「明顯部分」：去空白＋小寫後長度 ≥2（純 ASCII 要 ≥3，避免「CP」之類），
 * 而且係群盤名（去空白）嘅前綴，或者等於群盤名按空格分開嘅其中一個 token。
 */
export function isGroupNamePrefix(rawF: string, names: readonly string[]): boolean {
  const t = rawF.replace(/\s+/g, "").toLowerCase();
  if (t.length < 2) return false;
  if (/^[\x00-\x7f]+$/.test(t) && t.length < 3) return false;
  for (const n of names) {
    if (!n) continue;
    const flat = n.replace(/\s+/g, "").toLowerCase();
    if (flat.startsWith(t)) return true;
    if (n.toLowerCase().split(/\s+/).some((tok) => tok === t)) return true;
  }
  return false;
}

function resolveSite(siteRaw: string | null | undefined, ctx: ResolveContext): SiteRes {
  const groupSite = ctx.group.kind === "site" ? ctx.group.siteId : null;
  const raw = (siteRaw ?? "").trim();
  if (!raw) {
    if (groupSite) return { siteId: groupSite, reasons: [], candidates: [], basis: "group" };
    return { siteId: null, reasons: ["site_ambiguous"], candidates: [], basis: "none_in_multi_site" };
  }
  const rawF = foldVariants(raw);
  if (groupSite) {
    // 盤口群（群組已綁定盤）分層（兄弟盤調人係常態，唔可以一刀切）：
    //  0. 文字命中群盤自己 → 群盤。
    //  1. 命中**同客戶兄弟盤獨有**嘅名／別名（只掛喺一個盤）→ 出 site_ambiguous 題（候選＝群盤＋該盤；預設群盤，唔自動寫）。
    //  2. 只命中**多盤共用**嘅區域名／客戶名（別名掛喺 ≥2 個盤，例：「數碼港」）→ 群盤，唔出題（basis group_over_alias）。
    //  3. 命中**唔同客戶**嘅盤獨有嘅名 → 群盤，但要確認（site_ambiguous，唔自動寫）。
    //  4. 完全唔識／模糊 → 照舊（落到下面 classifySiteName）。
    //  0b. 文字係群盤名（或其別名）嘅前綴／空格分隔嘅 token（例：群盤「數碼港 CP5」，文字「數碼港」）→ 都係群盤（basis group_name_prefix）。
    const folded = foldSites(ctx.sites);
    const hits = siteTextHits(rawF, folded);
    if (hits.length > 0) {
      if (hits.some((h) => h.siteId === groupSite)) return { siteId: groupSite, reasons: [], candidates: [], basis: "text_exact" };
    }
    const gs = folded.find((x) => x.id === groupSite);
    if (gs && isGroupNamePrefix(rawF, [gs.canonicalName, ...gs.aliases])) return { siteId: groupSite, reasons: [], candidates: [], basis: "group_name_prefix" };
    if (hits.length > 0) {
      const unique = hits.filter((h) => h.owners === 1);
      if (unique.length === 0) {
        // 多盤共用嘅名只限掛住嘅盤**全部同一客戶**先當區域名（群盤唔出題）；橫跨唔同客戶（或客戶未知）→ 出題，候選＝群盤＋該些盤
        const clientOf = (id: string): string | null => ctx.sites.find((x) => x.id === id)?.client ?? null;
        const shared = [...new Set(hits.map((h) => h.siteId))];
        const clients = new Set(shared.map(clientOf));
        if (clients.size > 1 || clients.has(null)) return { siteId: groupSite, reasons: ["site_ambiguous"], candidates: [groupSite, ...shared], basis: "shared_name_cross_client" };
        return { siteId: groupSite, reasons: [], candidates: [], basis: "group_over_alias" };
      }
      const groupClient = ctx.sites.find((x) => x.id === groupSite)?.client ?? null;
      const sibling = unique.filter((h) => groupClient !== null && (ctx.sites.find((x) => x.id === h.siteId)?.client ?? null) === groupClient);
      if (sibling.length > 0) return { siteId: groupSite, reasons: ["site_ambiguous"], candidates: [groupSite, ...new Set(sibling.map((h) => h.siteId))], basis: "sibling_site_text" };
      return { siteId: groupSite, reasons: ["site_ambiguous"], candidates: [groupSite, ...new Set(unique.map((h) => h.siteId))], basis: "other_client_site" };
    }
  }
  const c = classifySiteName(rawF, foldSites(ctx.sites));
  if ((c.level === "exact" || c.level === "auto") && c.siteId) {
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

// LLM 有時將工號同人名黐埋（例「U9O369梁某」，原文字母 O 被轉成 0／反之）：開頭或結尾剝走 U／MP／MG／MW＋3–6 位（O 當 0）工號 token。
const STAFF_TOKEN_RE = /^(?:(U|MP|MG|MW)\s*([0-9Oo]{3,6}))(?![0-9A-Za-z])|(?<![0-9A-Za-z])(U|MP|MG|MW)\s*([0-9Oo]{3,6})$/i;
export function stripStaffToken(name: string): { number: string; rest: string } | null {
  const t = name.normalize("NFKC").trim();
  const m = STAFF_TOKEN_RE.exec(t);
  if (!m) return null;
  const prefix = m[1] ?? m[3]!;
  const digits = m[2] ?? m[4]!;
  if ((digits.match(/[0-9]/g) ?? []).length < 2) return null; // 全部係 O 之類唔當工號
  const rest = (m[1] ? t.slice(m[0].length) : t.slice(0, m.index)).replace(/[\s,，、:：()（）\-]+/g, " ").trim();
  return { number: normalizeStaffNumber(prefix + digits.replace(/[Oo]/g, "0")), rest };
}

async function resolveNamed(raw: string, ctx: ResolveContext, siteId: string | null): Promise<PersonRes> {
  const name = normName(raw);
  if (!name) return { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "empty_name" };
  if (SELF_WORDS.test(name)) return resolveSelf(ctx);
  const stripped = stripStaffToken(name);
  if (stripped) {
    const nameCands = stripped.rest ? nameCandidates(stripped.rest, ctx) : [];
    const hit = ctx.index.byStaffNumber.get(stripped.number)?.guardId ?? ctx.index.byLegacyStaffNo.get(stripped.number);
    if (hit) {
      // 工號指甲、名指乙（名有配到人而唔包含工號嗰位）→ 揀人題，兩邊都列
      if (nameCands.length > 0 && !nameCands.includes(hit)) return { guardId: null, reasons: ["person_ambiguous"], candidates: await orderCandidates([hit, ...nameCands], ctx, siteId), basis: "staff_number_name_mismatch" };
      return { guardId: hit, reasons: [], candidates: [], basis: "staff_number" };
    }
    // 工號查唔到 → 用剝走工號後嘅淨名照舊配
    if (!stripped.rest) return { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "staff_number_unmatched" };
    return namedByName(stripped.rest, ctx, siteId);
  }
  return namedByName(name, ctx, siteId);
}

/** 人名（已 NFKC）→ 候選 guard（byName／byAlias 精確；剝工號後嘅淨名再試簡繁容錯）。 */
function nameCandidates(name: string, ctx: ResolveContext): string[] {
  const viaName = ctx.index.byName.get(name) ?? [];
  const viaAlias = ctx.index.byAlias.get(name) ?? [];
  const c = [...new Set([...viaName, ...viaAlias])];
  return c.length > 0 ? c : guardsByName(ctx.index, name);
}

async function namedByName(name: string, ctx: ResolveContext, siteId: string | null): Promise<PersonRes> {
  const viaName = ctx.index.byName.get(name) ?? [];
  const viaAlias = ctx.index.byAlias.get(name) ?? [];
  const cands = [...new Set([...viaName, ...viaAlias])];
  if (cands.length === 1) return { guardId: cands[0]!, reasons: [], candidates: [], basis: viaName.includes(cands[0]!) ? "name" : "alias" };
  if (cands.length > 1) return { guardId: null, reasons: ["person_ambiguous"], candidates: await orderCandidates(cands, ctx, siteId), basis: "name_multi" };
  return { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "name_unmatched" };
}

// ---------------------------------------------------------------- 更別
export interface ShiftRes {
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

/** 時間段文字 → 開始時間：「0700-1900」「0700一1900」「2200－0615」「07:00-19:00」；「一」只喺前後都係 3–4 位數字（或 HH:MM）時先當分隔。 */
export function parseTimeRangeStart(raw: string): { hour: number; minute: number } | null {
  const t = raw.normalize("NFKC");
  const ok = (h: number, m: number): boolean => h >= 0 && h <= 24 && m >= 0 && m <= 59;
  const c = /(?<![0-9:])(\d{1,2}):(\d{2})\s*(?:[-–—~至到一])\s*(\d{1,2}):(\d{2})(?![0-9:])/.exec(t);
  if (c && ok(Number(c[1]), Number(c[2])) && ok(Number(c[3]), Number(c[4])) && Number(c[1]) < 24) return { hour: Number(c[1]), minute: Number(c[2]) };
  const d = /(?<![0-9])(\d{3,4})\s*(?:[-–—~至到一])\s*(\d{3,4})(?![0-9])/.exec(t);
  if (d) {
    const sp = (x: string): [number, number] => [Number(x.slice(0, -2)), Number(x.slice(-2))];
    const [h1, m1] = sp(d[1]!);
    const [h2, m2] = sp(d[2]!);
    if (h1 < 24 && ok(h1, m1) && ok(h2, m2)) return { hour: h1, minute: m1 };
  }
  return null;
}

function pickByCode(types: ShiftTypeLite[], code: string): ShiftTypeLite[] {
  const c = code.trim().toLowerCase();
  return types.filter((t) => t.code.trim().toLowerCase() === c);
}

export function resolveShift(shiftRaw: string | null | undefined, codeGuess: string | null | undefined, types: ShiftTypeLite[], wordMap: Record<string, string>): ShiftRes {
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
  // 2b) 時間段（判頭群常見「0700一1900」「2200-0615」）：取開始時間，對盤嘅更別開工時間
  const tr = parseTimeRangeStart(raw);
  if (tr) {
    const exact = types.filter((t) => t.startHour === tr.hour && (typeof t.startMinute === "number" ? t.startMinute === tr.minute : true));
    const r = finish(exact, "time_range_start");
    if (r) return r;
    const byBucket = finish(types.filter((t) => t.startHour !== null && hourBucket(t.startHour) === hourBucket(tr.hour)), "time_range_bucket");
    if (byBucket) return byBucket;
    return { shiftTypeId: null, reasons: ["shift_unmapped"], candidates: [], basis: "time_range_unmapped" };
  }
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
export function mapLeaveCode(raw: string | null | undefined, overrides?: Record<string, string>): { code: string | null; ambiguous: boolean; unclear?: boolean } {
  const t = (raw ?? "").normalize("NFKC").trim();
  if (!t) return { code: null, ambiguous: false };
  // W5：群組覆寫優先——全字相同先，其次包含（最長詞優先）；詞已 NFKC 正規化
  if (overrides) {
    const keys = Object.keys(overrides).filter((k) => k);
    if (Object.prototype.hasOwnProperty.call(overrides, t)) return { code: overrides[t]!, ambiguous: false };
    const hit = keys.filter((k) => t.includes(k)).sort((a, b) => b.length - a.length)[0];
    if (hit) return { code: overrides[hit]!, ambiguous: false };
  }
  const hits = LEAVE_TABLE.filter((x) => x.re.test(t)).map((x) => x.code);
  if (hits.length === 1) return { code: hits[0]!, ambiguous: false };
  if (hits.length === 0 && UNCLEAR_LEAVE_RE.test(t)) return { code: null, ambiguous: false, unclear: true };
  return { code: null, ambiguous: hits.length > 1 };
}

export function normLeave(code: string | null): string | null {
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

/** WA-9 (8)：短訊（LLM）路徑嘅 shift 揀人題帶同名單路徑一樣嘅 (群,日,名) key，兩邊互相去重。冇日期／冇名／工卡覆寫就唔帶。 */
function nameKeyOf(kind: IntentKind, ov: IntentOverride | undefined, raw: string | null, date: string | null, reasons: readonly string[], groupId: string): { name_key: string } | null {
  if (kind !== "shift" || ov?.person || !raw || !date) return null;
  if (!reasons.includes("person_ambiguous") && !reasons.includes("person_unknown")) return null;
  return { name_key: rosterNameKey(groupId, date, raw) };
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

  const starts: number[] = [];
  for (const [intentIdx, it] of intents.entries()) {
    starts.push(out.length);
    const ov = ctx.overrides?.get(intentIdx);
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
    const site = ov?.site ?? resolveSite(it.site_raw, ctx);
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
      if (ov?.shift) shift = { ...ov.shift };
      else if (site.siteId) shift = resolveShift(it.shift_raw, it.shift_code_guess, await typesOf(site.siteId), ctx.group.shiftWordMap);
    } else if (kind === "leave") {
      const lv = mapLeaveCode(it.leave_raw, ctx.group.leaveWordMap);
      if (lv.code) leaveCode = lv.code;
      else baseReasons.push(lv.unclear ? "leave_code_unclear" : lv.ambiguous ? "leave_ambiguous" : "leave_unmapped");
    }

    const dates: Array<string | null> = dateRes.ok ? dateRes.dates : [null];
    const workerList = workers.length > 0 ? workers : [{ raw: null as string | null, self: false }];

    for (const w of workerList) {
      let person: PersonRes;
      if (ov?.person) person = ov.person;
      else if (w.self) person = resolveSelf(ctx);
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
        if (ov?.extraNotes) pushUnique(res.notes, ...ov.extraNotes);

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
          src: { person_raw: w.raw, ...(nameKeyOf(kind, ov, w.raw, d, res.reasons, ctx.group.id) ?? {}), site_raw: it.site_raw ?? null, date_raw: it.date?.raw ?? null, shift_raw: it.shift_raw ?? null, leave_raw: it.leave_raw ?? null, replaced_raw: replaced[0]?.raw ?? null },
        };

        if (!AUTO_TYPES.has(kind)) {
          // W4：cover／cancel 首階段一律 Triage（wa_cover／wa_cancel 題）；呢度只做診斷（唔再用 type_not_auto 擋）
          pushUnique(res.notes, kind === "cover" ? "cover_triage" : "cancel_triage");
          if (kind === "cancel") res.reasons = res.reasons.filter((r) => r !== "site_ambiguous"); // 取消唔需要盤口
          if (d) {
            if (!dateInWindow(d, ctx.ts)) pushUnique(res.reasons, "date_out_of_range");
            else if (await ctx.repo.monthLocked(d)) pushUnique(res.reasons, "month_locked");
          }
          if (kind === "cover") {
            if (replacedGuardId === undefined) pushUnique(res.notes, "replaced_missing");
            if (d && !res.reasons.includes("month_locked")) {
              if (row.guardId) {
                const real = (await ctx.repo.existing(row.guardId, d)).filter((r) => r.status !== "cancelled" && r.recordType !== "ot");
                const clash = real.filter((r) => !(r.recordType === "shift" && r.shiftTypeId === row.shiftTypeId));
                if (real.length > clash.length) pushUnique(res.notes, "worker_already_has_shift");
                if (clash.length > 0) {
                  pushUnique(res.reasons, clash.some((r) => r.recordType === "leave") ? "conflict_leave" : "conflict_other_shift");
                  res.existing_record_ids = clash.map((r) => r.id);
                }
              }
              if (replacedGuardId) {
                const rrec = (await ctx.repo.existing(replacedGuardId, d)).filter((r) => r.status !== "cancelled" && r.recordType === "shift");
                const mine = rrec.filter((r) => (!row.siteId || r.siteId === row.siteId) && (!row.shiftTypeId || r.shiftTypeId === row.shiftTypeId));
                res.replaced_record_ids = mine.map((r) => r.id);
                if (mine.length === 0) pushUnique(res.notes, "replaced_no_shift");
              }
            }
          } else if (row.guardId && d && !res.reasons.includes("month_locked")) {
            const real = (await ctx.repo.existing(row.guardId, d)).filter((r) => r.status !== "cancelled" && r.recordType !== "ot" && (!row.siteId || r.siteId === row.siteId));
            res.existing_record_ids = real.map((r) => r.id);
            if (real.length === 0) pushUnique(res.reasons, "no_cancel_target");
          }
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
        if (ov?.extraReasons) pushUnique(res.reasons, ...ov.extraReasons);
        row.routed = res.reasons.length === 0 ? "auto_write" : "triage";
        out.push(row);
      }
    }
  }
  starts.push(out.length);
  for (let k = 0; k < intents.length; k++) for (let j = starts[k]!; j < starts[k + 1]!; j++) out[j]!.intentIdx = k;
  return out;
}
