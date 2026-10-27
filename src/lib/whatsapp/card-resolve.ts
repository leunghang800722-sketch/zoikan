// WA-8 C：工卡相歸屬——人（工號→guard_staff_numbers；冇工號→姓名 strict）、日期（訊息 ts 香港日；凌晨降級沿用 resolveDates）、
// 盤（單盤群＝群盤；大群／判頭群：當日更表預排 → 近 60 日同盤 → 都冇就出題）、更（群「開工」口語對照 → 該盤同時段 ±2 小時）。
// 重用 resolveIntents（日期窗口／鎖月／撞更／額滿／quota 檢查照舊），每張卡一個 intent；自動寫入條件另見 autowrite.ts。
// 冇任何值用 caption 以外嘅文字推斷（呢度完全唔睇 caption）。
import { prisma } from "@/lib/db";
import { normZh } from "@/lib/guards/import/text";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import type { GuardMatchIndex } from "@/lib/roster-upload/match";
import { hkParts } from "@/lib/dates";
import type { PhotoCard, CardPhotoResult } from "./card-ocr";
import type { ParsedIntent } from "./parse";
import { addDays, hkDateOf, isoToDbDate } from "./dates";
import { resolveIntents, resolveShift, type IntentOverride, type IntentSrc, type ResolveContext, type ResolvedIntent, type ShiftTypeLite } from "./resolve";
import type { WaCardEvidence } from "./triage-types";

const RECENT_DAYS = 60;
const SHIFT_WINDOW_HOURS = 2;
const MAX_SITE_CANDIDATES = 8;

/** 工卡相來源嘅額外 DB 查詢（可注入，方便單元測試）。 */
export interface CardDeps {
  /** 該人該日已有嘅（未取消）shift 記錄：盤＋更別 */
  scheduled(guardId: string, dateIso: string): Promise<Array<{ siteId: string; shiftTypeId: string }>>;
  /** 該人 sinceIso（含）至 beforeIso（唔含）喺各盤嘅更數 */
  recentSites(guardId: string, sinceIso: string, beforeIso: string): Promise<Map<string, number>>;
}

function prismaCardDeps(): CardDeps {
  return {
    async scheduled(guardId, dateIso) {
      const rows = await prisma.shiftRecord.findMany({ where: { guardId, workDate: isoToDbDate(dateIso), recordType: "shift", status: { not: "cancelled" } }, select: { siteId: true, shiftTypeId: true }, orderBy: [{ id: "asc" }] });
      return rows;
    },
    async recentSites(guardId, sinceIso, beforeIso) {
      const rows = await prisma.shiftRecord.groupBy({ by: ["siteId"], where: { guardId, workDate: { gte: isoToDbDate(sinceIso), lt: isoToDbDate(beforeIso) }, recordType: "shift", status: { not: "cancelled" } }, _count: { _all: true } });
      return new Map(rows.map((r) => [r.siteId, r._count._all]));
    },
  };
}

export type CardInput =
  | { kind: "photo"; photo: CardPhotoResult }
  | { kind: "dead"; why: "expired" | "not_card" | "unreadable" };

export interface CardResolveArgs {
  ctx: ResolveContext;
  input: CardInput;
  /** whatsapp_media_evidence.id（有圖先有） */
  mediaId: string | null;
  deps?: CardDeps;
}

const DEAD_REASON = { expired: "card_media_expired", not_card: "card_not_card", unreadable: "card_unreadable" } as const;

/** ts 落喺各更開始前後 ±2 小時（24h 環形）→ 候選更別；唯一最近者先採用。 */
export function shiftBySlot(types: readonly ShiftTypeLite[], ts: Date, timeOn?: string | null): { shiftTypeId: string | null; reasons: string[]; candidates: string[]; basis: string } {
  const p = hkParts(ts);
  // WA-9：相入面讀到嘅打卡時間（HH:MM）優先於訊息送出時間
  const tm = timeOn ? /^(\d{2}):(\d{2})$/.exec(timeOn) : null;
  const h = tm ? Number(tm[1]) + Number(tm[2]) / 60 : p.hour + p.minute / 60;
  const near = types
    .filter((t) => t.startHour !== null)
    .map((t) => {
      const d = Math.abs(h - t.startHour!);
      return { t, d: Math.min(d, 24 - d) };
    })
    .filter((x) => x.d <= SHIFT_WINDOW_HOURS)
    .sort((a, b) => a.d - b.d || a.t.code.localeCompare(b.t.code));
  if (near.length === 1) return { shiftTypeId: near[0]!.t.id, reasons: [], candidates: [], basis: "time_slot" };
  if (near.length > 1 && near[1]!.d - near[0]!.d >= 0.5) return { shiftTypeId: near[0]!.t.id, reasons: [], candidates: [], basis: "time_slot_nearest" };
  if (near.length > 1) return { shiftTypeId: null, reasons: ["shift_ambiguous"], candidates: near.map((x) => x.t.id), basis: "time_slot_multi" };
  return { shiftTypeId: null, reasons: ["shift_unmapped"], candidates: [], basis: "time_slot_none" };
}

async function personFor(card: PhotoCard, ctx: ResolveContext, scope: ReadonlySet<string> | null): Promise<{ person: NonNullable<IntentOverride["person"]>; extra: string[] }> {
  const idx: GuardMatchIndex = ctx.index;
  const extra: string[] = [];
  if (card.staff_no && card.status === "confirmed") {
    const hit = idx.byStaffNumber.get(normalizeStaffNumber(card.staff_no)) ?? null;
    if (!hit) {
      // 系統冇呢個工號——唔用姓名「補救」（工號係主，姓名只輔助）
      return { person: { guardId: null, reasons: ["person_unknown", "card_staff_no_unknown"], candidates: [], basis: "card_staff_no_unmatched" }, extra };
    }
    if (hit.status !== "current") extra.push("card_former_number");
    const sysName = idx.nameByGuardId.get(hit.guardId) ?? null;
    if (card.name_zh && sysName && normZh(card.name_zh) !== normZh(sysName)) extra.push("card_name_mismatch");
    return { person: { guardId: hit.guardId, reasons: [], candidates: [], basis: "card_staff_no" }, extra };
  }
  const cands = [...new Set([...(card.staff_no ? [card.staff_no] : []), ...card.candidates])];
  if (cands.length > 0) {
    // 疑似第二張卡（只一個引擎讀到，而同一張相已有確認嘅卡）：人配到就一撳確認；系統冇呢個工號 → person_unknown
    if (card.reasons.includes("card_suspect_second") && card.staff_no) {
      const hit = idx.byStaffNumber.get(normalizeStaffNumber(card.staff_no)) ?? null;
      // candidates＝同相所有候選工號對應嘅 guard（「加多一位」揀人用，唔影響 kind 判定）
      const allIds = [...new Set(cands.flatMap((n) => { const h = idx.byStaffNumber.get(normalizeStaffNumber(n)); return h ? [h.guardId] : []; }))];
      if (hit) return { person: { guardId: hit.guardId, reasons: [], candidates: allIds.slice(0, MAX_SITE_CANDIDATES), basis: "card_suspect_second" }, extra: ["card_suspect_second", ...(hit.status !== "current" ? ["card_former_number"] : [])] };
      return { person: { guardId: null, reasons: ["person_unknown", "card_staff_no_unknown"], candidates: [], basis: "card_suspect_second_unmatched" }, extra: ["card_suspect_second"] };
    }
    // review：候選工號 → guard 候選（畀人揀；三個讀數都唔同＝一條題列晒全部候選）
    const ids = [...new Set(cands.flatMap((n) => { const h = idx.byStaffNumber.get(normalizeStaffNumber(n)); return h ? [h.guardId] : []; }))];
    const code = card.reasons[0] ?? "card_disputed";
    // 值勤表逐行：候選只有一位 → 人配到，淨係要一撳確認（低信心／分歧行）
    if (card.doc_type === "attendance_sheet" && ids.length === 1) return { person: { guardId: ids[0]!, reasons: [], candidates: [], basis: "card_row_candidate" }, extra: ["card_confirm", ...card.reasons.filter((r) => r === "row_low_confidence")] };
    if (ids.length > 0) return { person: { guardId: null, reasons: ["person_ambiguous"], candidates: ids.slice(0, MAX_SITE_CANDIDATES), basis: "card_candidates" }, extra: [code] };
    return { person: { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "card_candidates_unmatched" }, extra: [code] };
  }
  // WA-9：冇工號 → 姓名身份（打卡紙手寫／簽到表印刷／app「歡迎，X！」）。盤口群＝該盤近 60 日有更嘅 guard、判頭群＝該判頭旗下 guard 範圍內 strict 同名；
  // 範圍內唯一（而且兩個引擎讀到同一姓名）＝配到人；範圍內多個／冇 → 揀人題（候選：同名者＋同範圍 guard 按字形接近排序）。
  const norm = (n: string): string => n.normalize("NFKC").replace(/\s+/g, "");
  const names = (card.name_candidates?.length ? card.name_candidates : card.name_zh ? [card.name_zh] : []).map(norm).filter(Boolean);
  const global = [...new Set(names.flatMap((n) => [...(idx.byName.get(n) ?? []), ...(idx.byAlias.get(n) ?? [])]))];
  const inScope = scope ? global.filter((g) => scope.has(g)) : global;
  const strong = card.status === "confirmed" && names.length === 1; // 兩個引擎讀到同一姓名
  if (inScope.length === 1) return { person: { guardId: inScope[0]!, reasons: [], candidates: [], basis: scope ? "card_name_in_scope" : "card_name" }, extra: [...(strong && scope ? [] : ["card_name_only"]), ...card.reasons.filter((r) => r === "row_low_confidence")] };
  const pool = new Set<string>(global);
  if (scope && names.length > 0) {
    const chars = new Set([...names.join("")]);
    const overlap = (g: string): number => [...(idx.nameByGuardId.get(g) ?? "")].filter((c) => chars.has(c)).length;
    for (const g of [...scope].sort((a, b) => overlap(b) - overlap(a) || a.localeCompare(b))) {
      if (pool.size >= MAX_SITE_CANDIDATES) break;
      if (overlap(g) > 0) pool.add(g);
    }
  }
  const ids = [...pool].slice(0, MAX_SITE_CANDIDATES);
  if (ids.length > 0) return { person: { guardId: null, reasons: ["person_ambiguous"], candidates: ids, basis: inScope.length > 1 ? "card_name_multi" : "card_name_out_of_scope" }, extra: ["card_name_only"] };
  return { person: { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "card_name_unmatched" }, extra: ["card_name_only"] };
}

async function siteAndShiftFor(guardId: string | null, ctx: ResolveContext, deps: CardDeps, timeOn: string | null = null): Promise<{ site: NonNullable<IntentOverride["site"]>; shift?: NonNullable<IntentOverride["shift"]>; extra: string[] }> {
  const g = ctx.group;
  const day = hkDateOf(ctx.ts);
  const types = async (siteId: string) => ctx.repo.shiftTypes(siteId);
  const pickShift = async (siteId: string, scheduledShiftId: string | null) => {
    if (scheduledShiftId) return { shiftTypeId: scheduledShiftId, reasons: [], candidates: [], basis: "scheduled" };
    const ts = await types(siteId);
    // 群組「開工」口語對照（日更群→D、夜更群→N）優先
    if (Object.prototype.hasOwnProperty.call(g.shiftWordMap, "開工")) return resolveShift("開工", null, ts, g.shiftWordMap);
    return shiftBySlot(ts, ctx.ts, timeOn);
  };
  if (g.kind === "site" && g.siteId) {
    return { site: { siteId: g.siteId, reasons: [], candidates: [], basis: "group" }, shift: await pickShift(g.siteId, null), extra: [] };
  }
  // 大群／判頭群：要先識人，再推盤
  if (!guardId) return { site: { siteId: null, reasons: ["site_ambiguous"], candidates: [], basis: "no_person" }, extra: [] };
  const sched = await deps.scheduled(guardId, day);
  const schedSites = [...new Set(sched.map((s) => s.siteId))];
  if (schedSites.length === 1) {
    const sid = schedSites[0]!;
    const sameSite = sched.filter((s) => s.siteId === sid);
    return { site: { siteId: sid, reasons: [], candidates: [], basis: "scheduled" }, shift: await pickShift(sid, sameSite.length === 1 ? sameSite[0]!.shiftTypeId : null), extra: [] };
  }
  if (schedSites.length > 1) return { site: { siteId: null, reasons: ["site_ambiguous"], candidates: schedSites.slice(0, MAX_SITE_CANDIDATES), basis: "scheduled_multi" }, extra: [] };
  const recent = await deps.recentSites(guardId, addDays(day, -RECENT_DAYS), day);
  const ranked = [...recent.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
  if (ranked.length === 1) {
    // 近 60 日歷史推斷唔算「明確」→ 要人一撳確認
    return { site: { siteId: ranked[0]!, reasons: [], candidates: [], basis: "recent_60d" }, shift: await pickShift(ranked[0]!, null), extra: ["card_confirm"] };
  }
  return { site: { siteId: null, reasons: ["site_ambiguous"], candidates: ranked.slice(0, MAX_SITE_CANDIDATES), basis: ranked.length ? "recent_60d_multi" : "no_history" }, extra: [] };
}

function cardEvidence(card: PhotoCard | null, i: number, n: number, mediaId: string | null, arbiter: boolean, none?: WaCardEvidence["none"], all?: readonly PhotoCard[]): WaCardEvidence {
  return {
    media_id: mediaId,
    staff_no_read: card?.staff_no ?? null,
    name_zh_read: card?.name_zh ?? null,
    name_en_read: card?.name_en ?? null,
    votes: card?.votes ?? 0,
    index: i + 1,
    total: n,
    arbiter,
    candidates: card?.candidates ?? [],
    ...(card?.doc_type ? { doc_type: card.doc_type } : {}),
    ...(card?.time_on ? { time_on: card.time_on } : {}),
    ...(card?.wilson_staff_no_raw ? { wilson_no: card.wilson_staff_no_raw } : {}),
    ...(card?.row_no ? { row_no: card.row_no } : {}),
    // 同一張相嘅其他卡（題卡列明「已確認 U01095＋疑似第二張 U01096」）
    ...(all && all.length > 1 ? { others: all.filter((_, k) => k !== i).map((c) => ({ staff_no: c.staff_no, status: c.status })) } : {}),
    ...(none ? { none } : {}),
  };
}

/** 工卡相 → 已配對 intents（一張卡一個；冇可用資料＝一個 unclear 題）。 */
export async function resolveCardPhoto(a: CardResolveArgs): Promise<ResolvedIntent[]> {
  const { ctx } = a;
  const deps = a.deps ?? prismaCardDeps();
  const dead = (why: "expired" | "not_card" | "unreadable", arbiter = false): ResolvedIntent[] => [
    {
      kind: "unclear",
      workDate: null,
      siteId: null,
      guardId: null,
      shiftTypeId: null,
      leaveCode: null,
      hours: null,
      confidence: 0,
      resolution: { type: "unclear", reasons: [DEAD_REASON[why]], notes: [], basis: {}, candidates: {}, group_id: ctx.group.id, group_auto_write: ctx.group.autoWrite },
      routed: "triage",
      src: { person_raw: null, site_raw: null, date_raw: null, shift_raw: null, leave_raw: null, replaced_raw: null, card: cardEvidence(null, 0, 1, a.mediaId, arbiter, why) },
    },
  ];
  if (a.input.kind === "dead") return dead(a.input.why);
  const photo = a.input.photo;
  if (photo.kind === "not_card") return dead("not_card");
  if (photo.kind === "unreadable" || photo.cards.length === 0) return dead("unreadable", photo.arbiter_used);

  const intents: ParsedIntent[] = [];
  const overrides = new Map<number, IntentOverride>();
  const cards = photo.cards;
  // 姓名身份嘅範圍：盤口群＝該盤近 60 日有更嘅 guard；判頭群＝該判頭旗下近 60 日有更嘅 guard；大群＝冇範圍
  let scope: ReadonlySet<string> | null = null;
  if (cards.some((c) => !c.staff_no)) {
    const since = addDays(hkDateOf(ctx.ts), -RECENT_DAYS);
    if (ctx.group.kind === "site" && ctx.group.siteId) scope = await ctx.repo.recentGuardIdsAtSite(ctx.group.siteId, since);
    else if (ctx.group.kind === "broker" && ctx.group.brokerId) scope = await ctx.repo.recentGuardIdsOfBroker(ctx.group.brokerId, since);
  }
  for (const [i, card] of cards.entries()) {
    const { person, extra: pExtra } = await personFor(card, ctx, scope);
    const { site, shift, extra: sExtra } = await siteAndShiftFor(person.guardId, ctx, deps, card.time_on ?? null);
    const extraReasons = [...pExtra, ...sExtra];
    // 辨識全齊、人配到，但群組冇開自動寫入 → 一撳確認（開咗自動寫入先走 pending_approval 自動流程）
    if (card.status === "confirmed" && person.guardId && !ctx.group.autoWrite && !extraReasons.includes("card_confirm")) extraReasons.push("card_confirm");
    intents.push({
      type: "shift",
      date: card.row_date ? { raw: `${Number(card.row_date.slice(5, 7))}月${Number(card.row_date.slice(8, 10))}日`, kind: "absolute" } : { raw: "今日", kind: "relative" },
      site_raw: null,
      persons: [],
      self_reference: false,
      shift_raw: null,
      shift_code_guess: null,
      hours: null,
      leave_raw: null,
      leave_code_guess: null,
      confidence: card.status === "confirmed" ? 0.95 : 0.5,
      evidence: null,
    } as ParsedIntent);
    overrides.set(i, { person, site, ...(shift ? { shift } : {}), extraReasons, extraNotes: ["card_photo"] });
  }
  const resolved = await resolveIntents(intents, { ...ctx, overrides });
  // resolveIntents 一個 intent 可能展開多行（日期 range）；工卡相只會一日，逐行對返 card 證據
  return resolved.map((r, k) => {
    const ci = Math.min(k, cards.length - 1);
    const src: IntentSrc = { ...(r.src ?? { person_raw: null, site_raw: null, date_raw: null, shift_raw: null, leave_raw: null, replaced_raw: null }), person_raw: null, card: cardEvidence(cards[ci]!, ci, cards.length, a.mediaId, photo.arbiter_used, undefined, cards) };
    return { ...r, src };
  });
}
