// WA-9：文字名單 → 逐名 shift intent（純 code，零 LLM）。WA-9 (7)：多日累積名單 + 幂等（重發 6–9 次唔重複建）。
// 每個名：strict（NFKC 去空白）姓名配對，範圍＝該盤近 60 日有更／判頭旗下／該群曾配對過嘅 guard；範圍內唯一 → 配到；
// 範圍內冇而全體唯一 → 配到（擴到全部）；同名多人／配唔到 → 揀人題（候選：同名者＋同範圍字形接近者）。**只有呢啲名先出題。**
// 日期＝名單日期（明確日期用絕對 token；凌晨「今日」等沿用 resolveIntents 日期降級）；盤＝群盤（盤口群）或該人預排／近 60 日；
// 更＝名單內該名更碼 → 群「開工」對照 → 該盤只有一個更別 → 否則 shift_unmapped（出題）。日期窗口／鎖月／撞更／同日同人同更去重全部沿用 resolveIntents。
import { prisma } from "@/lib/db";
import { addDays, dateInWindow, hkDateOf, isoToDbDate } from "./dates";
import type { ParsedIntent } from "./parse";
import { prismaCardDeps, siteAndShiftFor, type CardDeps } from "./card-resolve";
import { rosterNameKey } from "./name-key";
import { normNameNear } from "@/lib/names/variants";
import { guardsByName, nameViewOf, nearGuardsGlobal } from "./name-index";
import { refineNames, type RosterList } from "./roster-list";
import { resolveIntents, resolveShift, type IntentOverride, type ResolveContext, type ResolvedIntent } from "./resolve";

const RECENT_DAYS = 60;
const MAX_CANDIDATES = 8;

export interface RosterDeps extends CardDeps {
  /** 呢個群近 N 日已配對到嘅 guard（whatsapp_intents.guard_id 非空） */
  groupMatchedGuards(chatJid: string, sinceIso: string): Promise<Set<string>>;
  /** 幂等批量查詢（一次過，唔逐名 round-trip）：已有（未取消、非 OT）記錄嘅 `${guardId}|${date}` 同 `${guardId}|${date}|${shiftTypeId}`；excludeIds＝編輯後被取代嘅舊 pending 記錄 */
  existingKeys(guardIds: string[], dates: string[], excludeIds: ReadonlySet<string>): Promise<Set<string>>;
  /** 其他訊息（同群、未撤回、未被取代）已對過呢個人呢日嘅 intent：`${guardId}|${date}`（＋`|${shiftTypeId}`） */
  priorIntentKeys(chatJid: string, guardIds: string[], dates: string[], exceptMessageId: string): Promise<Set<string>>;
  /** 已存在嘅 dedupe 題 groupKey（只計 open／answered／skipped；撤回後 superseded 嘅唔計，重發可再開） */
  questionKeys(keys: string[]): Promise<Set<string>>;
  /** WA-9 (8)：上面嗰啲 key 之中，題係短訊（LLM）路徑開嘅（evidence 冇 dedupe_key）——名單要留一個指向佢嘅 intent，原訊息撤回／編輯時題先可以改歸屬而唔會冇咗 */
  llmOriginKeys?(keys: string[]): Promise<Set<string>>;
}

export function prismaRosterDeps(): RosterDeps {
  return {
    ...prismaCardDeps(),
    async groupMatchedGuards(chatJid, sinceIso) {
      const rows = await prisma.whatsappIntent.findMany({ where: { guardId: { not: null }, message: { chatJid, ts: { gte: new Date(`${sinceIso}T00:00:00+08:00`) } } }, select: { guardId: true }, distinct: ["guardId"], take: 500 });
      return new Set(rows.flatMap((r) => (r.guardId ? [r.guardId] : [])));
    },
    async existingKeys(guardIds, dates, excludeIds) {
      if (guardIds.length === 0 || dates.length === 0) return new Set();
      const rows = await prisma.shiftRecord.findMany({ where: { guardId: { in: guardIds }, workDate: { in: dates.map(isoToDbDate) }, status: { not: "cancelled" }, recordType: { not: "ot" } }, select: { id: true, guardId: true, workDate: true, shiftTypeId: true } });
      return new Set(rows.filter((r) => !excludeIds.has(r.id)).flatMap((r) => { const k = `${r.guardId}|${r.workDate.toISOString().slice(0, 10)}`; return [k, `${k}|${r.shiftTypeId}`]; }));
    },
    async priorIntentKeys(chatJid, guardIds, dates, exceptMessageId) {
      if (guardIds.length === 0 || dates.length === 0) return new Set();
      const rows = await prisma.whatsappIntent.findMany({
        where: { guardId: { in: guardIds }, workDate: { in: dates.map(isoToDbDate) }, kind: "shift", revokedAt: null, supersededByRevision: null, message: { chatJid, revokedAt: null, messageId: { not: exceptMessageId } } },
        select: { guardId: true, workDate: true, shiftTypeId: true },
      });
      return new Set(rows.flatMap((r) => { if (!r.guardId || !r.workDate) return []; const k = `${r.guardId}|${r.workDate.toISOString().slice(0, 10)}`; return [k, ...(r.shiftTypeId ? [`${k}|${r.shiftTypeId}`] : [])]; }));
    },
    async questionKeys(keys) {
      if (keys.length === 0) return new Set();
      const rows = await prisma.triageQuestion.findMany({ where: { groupKey: { in: keys }, status: { in: ["open", "answered", "skipped"] }, session: { sourceType: "whatsapp" } }, select: { groupKey: true } });
      return new Set(rows.map((r) => r.groupKey));
    },
    async llmOriginKeys(keys) {
      if (keys.length === 0) return new Set();
      const rows = await prisma.$queryRaw<{ group_key: string }[]>`
        SELECT DISTINCT q.group_key FROM triage_questions q JOIN triage_sessions s ON s.id = q.session_id
        WHERE s.source_type = 'whatsapp' AND q.status IN ('open','answered','skipped') AND q.group_key = ANY(${keys}) AND q.evidence_json->>'dedupe_key' IS NULL`;
      return new Set(rows.map((r) => r.group_key));
    },
  };
}



/** 範圍：盤口群→該盤近 60 日有更；判頭群→該判頭旗下；加上呢個群曾配對過嘅 guard */
export async function rosterScope(ctx: ResolveContext, chatJid: string, deps: Pick<RosterDeps, "groupMatchedGuards">, sinceIso: string): Promise<Set<string>> {
  const scope = new Set<string>(await deps.groupMatchedGuards(chatJid, sinceIso));
  if (ctx.group.kind === "site" && ctx.group.siteId) for (const g of await ctx.repo.recentGuardIdsAtSite(ctx.group.siteId, sinceIso)) scope.add(g);
  else if (ctx.group.kind === "broker" && ctx.group.brokerId) for (const g of await ctx.repo.recentGuardIdsOfBroker(ctx.group.brokerId, sinceIso)) scope.add(g);
  return scope;
}

/** 一個姓名 → 範圍內唯一＝配到；範圍內冇而全體唯一＝配到；同名多人／配唔到＝揀人題候選。簡繁容錯。 */
export function personForName(idx: ResolveContext["index"], name: string, scope: ReadonlySet<string>): NonNullable<IntentOverride["person"]> {
  const global = guardsByName(idx, name);
  const inScope = global.filter((g) => scope.has(g));
  if (inScope.length === 1) return { guardId: inScope[0]!, reasons: [], candidates: [], basis: "roster_name_in_scope" };
  // 範圍外嘅唯一同名（近 60 日冇喺該群／盤出現）：唔自動寫（同卡相 card_name_only 口徑一致）→ 揀人題，單一候選畀人一撳確認
  if (inScope.length === 0 && global.length === 1) return { guardId: null, reasons: ["person_ambiguous"], candidates: [global[0]!], basis: "roster_name_out_of_scope" };
  if (global.length > 0) return { guardId: null, reasons: ["person_ambiguous"], candidates: (inScope.length > 1 ? inScope : global).slice(0, MAX_CANDIDATES), basis: "roster_name_multi" };
  // 配唔到：候選＝同範圍、字形接近（共用字）嘅 guard
  const chars = new Set([...normNameNear(name)]);
  const overlap = (g: string): number => [...normNameNear(idx.nameByGuardId.get(g) ?? "")].filter((c) => chars.has(c)).length;
  const near = [...scope].filter((g) => overlap(g) > 0).sort((a, b) => overlap(b) - overlap(a) || a.localeCompare(b)).slice(0, MAX_CANDIDATES);
  if (near.length > 0) return { guardId: null, reasons: ["person_ambiguous"], candidates: near, basis: "roster_name_unmatched" };
  // WA-9 (9)：範圍內冇近似 → 全庫同姓＋至少 1 個相同字（含壁／璧等混淆字）；只出揀人題，唔自動配
  const wide = nearGuardsGlobal(idx, name, MAX_CANDIDATES);
  return wide.length > 0 ? { guardId: null, reasons: ["person_ambiguous"], candidates: wide, basis: "roster_name_near_global" } : { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "roster_name_unmatched" };
}

export interface RosterStats {
  days: number;
  names: number;
  /** 新建（matched → intent / 配唔到 → 新題） */
  new: number;
  /** 已有記錄／已處理過嘅 intent → 唔再建 */
  already: number;
  unmatched_new: number;
  unmatched_dup: number;
  skipped_old: number;
  skipped_future: number;
  skipped_locked: number;
}
const emptyRosterStats = (): RosterStats => ({ days: 0, names: 0, new: 0, already: 0, unmatched_new: 0, unmatched_dup: 0, skipped_old: 0, skipped_future: 0, skipped_locked: 0 });

// 配唔到／同名多人嘅名，同一 (群, 日, 名) 只開一張題：groupKey 固定（rosterNameKey，短訊路徑共用），之後重發唔再開。

export async function resolveRosterList(args: { ctx: ResolveContext; list: RosterList; chatJid: string; messageId?: string; staleIds?: ReadonlySet<string>; deps?: RosterDeps }): Promise<{ resolved: ResolvedIntent[]; stats: RosterStats }> {
  const { ctx, list } = args;
  const deps = args.deps ?? prismaRosterDeps();
  const idx = ctx.index;
  const view = nameViewOf(idx);
  const today = hkDateOf(ctx.ts);
  const since = addDays(today, -RECENT_DAYS);
  const stats = emptyRosterStats();
  const scope = await rosterScope(ctx, args.chatJid, deps, since);

  // ---- 1. 揀要處理嘅日子：日期 ≤ 今日、喺日期窗口（今日 −2 內）、唔屬鎖月；日期 null（相對詞降級）照舊交 resolveIntents
  const lockedMonth = new Map<string, boolean>();
  type Item = { date: string | null; dateRaw: string; name: string; hint: string | null; person: NonNullable<IntentOverride["person"]>; key: string | null; wantShift: string | null };
  // 盤口群：預先揀定每個名要報嘅更別（名單更碼 → 群「開工」對照 → 單一更別），去重時（人，日，更別）一齊睇；同人同日 D＋N 唔會當同一條
  const siteTypes = ctx.group.kind === "site" && ctx.group.siteId ? await ctx.repo.shiftTypes(ctx.group.siteId) : [];
  const wantShiftOf = (hint: string | null): string | null => {
    if (siteTypes.length === 0) return null;
    const r = hint ? resolveShift(hint, null, siteTypes, ctx.group.shiftWordMap) : Object.prototype.hasOwnProperty.call(ctx.group.shiftWordMap, "開工") ? resolveShift("開工", null, siteTypes, ctx.group.shiftWordMap) : siteTypes.length === 1 ? { shiftTypeId: siteTypes[0]!.id } : null;
    return r?.shiftTypeId ?? null;
  };
  const items: Item[] = [];
  for (const day of list.days) {
    if (day.date) {
      if (day.date > today) { stats.skipped_future += 1; continue; }
      if (!dateInWindow(day.date, ctx.ts)) { stats.skipped_old += 1; continue; }
      const mk = day.date.slice(0, 7);
      if (!lockedMonth.has(mk)) lockedMonth.set(mk, await ctx.repo.monthLocked(day.date));
      if (lockedMonth.get(mk)) { stats.skipped_locked += 1; continue; }
    }
    stats.days += 1;
    const dateRaw = day.date ? `${Number(day.date.slice(5, 7))}月${Number(day.date.slice(8, 10))}日` : day.date_raw;
    for (const n of refineNames(day.names, view.known)) {
      stats.names += 1;
      const person = personForName(idx, n.raw, scope);
      items.push({ date: day.date, dateRaw, name: n.raw, hint: n.shift_hint, person, key: person.guardId ? null : day.date ? rosterNameKey(ctx.group.id, day.date, n.raw) : null, wantShift: wantShiftOf(n.shift_hint) });
    }
  }

  // ---- 2. 幂等：批量查已有記錄／已處理 intent／已存在題
  const dated = items.filter((i) => i.date);
  const guardIds = [...new Set(dated.flatMap((i) => (i.person.guardId ? [i.person.guardId] : [])))];
  const dates = [...new Set(dated.map((i) => i.date!))];
  const wantKeys = items.flatMap((i) => (i.key ? [i.key] : []));
  const [have, prior, qkeys] = await Promise.all([
    deps.existingKeys(guardIds, dates, args.staleIds ?? new Set()),
    deps.priorIntentKeys(args.chatJid, guardIds, dates, args.messageId ?? ""),
    deps.questionKeys(wantKeys),
  ]);
  const llmKeys = deps.llmOriginKeys && qkeys.size > 0 ? await deps.llmOriginKeys([...qkeys]) : new Set<string>();
  const survivors: Item[] = [];
  const seenKey = new Set<string>();
  for (const it of items) {
    if (it.date && it.person.guardId) {
      const k = `${it.person.guardId}|${it.date}${it.wantShift ? `|${it.wantShift}` : ""}`;
      if (have.has(k) || prior.has(k) || seenKey.has(k)) { stats.already += 1; continue; }
      seenKey.add(k);
      stats.new += 1;
    } else if (it.key) {
      if (qkeys.has(it.key) || seenKey.has(it.key)) {
        stats.unmatched_dup += 1;
        // 題係短訊路徑開嘅：留一行 intent 指向佢（insertWaQuestions 會併入既有題，唔另開）
        if (qkeys.has(it.key) && !seenKey.has(it.key) && llmKeys.has(it.key)) { seenKey.add(it.key); survivors.push(it); }
        continue;
      }
      seenKey.add(it.key);
      stats.unmatched_new += 1;
      stats.new += 1;
    } else stats.new += 1;
    survivors.push(it);
  }
  if (survivors.length === 0) return { resolved: [], stats };

  // ---- 3. 只對新增嘅項目砌 intent（盤／更查詢先付成本）
  const intents: ParsedIntent[] = [];
  const overrides = new Map<number, IntentOverride>();
  for (const [i, it] of survivors.entries()) {
    const sf = await siteAndShiftFor(it.person.guardId, ctx, deps);
    // 更：名單提示 → 群「開工」對照 → 該盤單一更別；預排嘅更別（scheduled）照用
    let shift: NonNullable<IntentOverride["shift"]> | undefined = sf.shift?.basis === "scheduled" ? sf.shift : undefined;
    if (!shift && sf.site.siteId) {
      const types = await ctx.repo.shiftTypes(sf.site.siteId);
      if (it.hint) shift = resolveShift(it.hint, null, types, ctx.group.shiftWordMap);
      else if (Object.prototype.hasOwnProperty.call(ctx.group.shiftWordMap, "開工")) shift = resolveShift("開工", null, types, ctx.group.shiftWordMap);
      else if (types.length === 1) shift = { shiftTypeId: types[0]!.id, reasons: [], candidates: [], basis: "single_shift_type" };
      else shift = { shiftTypeId: null, reasons: ["shift_unmapped"], candidates: [], basis: "roster_no_shift_hint" };
    }
    intents.push({
      type: "shift",
      date: { raw: it.dateRaw, kind: it.date ? "absolute" : "relative" },
      site_raw: null,
      persons: [],
      self_reference: false,
      shift_raw: null,
      shift_code_guess: null,
      hours: null,
      leave_raw: null,
      leave_code_guess: null,
      confidence: 0.95,
      evidence: null,
    } as ParsedIntent);
    overrides.set(i, { person: it.person, site: sf.site, ...(shift ? { shift } : {}), extraReasons: sf.extra, extraNotes: ["roster_list"] });
  }
  const resolved = await resolveIntents(intents, { ...ctx, overrides });
  // resolveIntents 一個 intent 對一行（單日）；逐行對返姓名做 src.person_raw（題卡顯示／「記住花名」用）＋ dedupe_key
  return {
    resolved: resolved.map((r, k) => {
      const it = r.intentIdx !== undefined ? survivors[r.intentIdx] : survivors[Math.min(k, survivors.length - 1)];
      const base = r.src ?? { person_raw: null, site_raw: null, date_raw: null, shift_raw: null, leave_raw: null, replaced_raw: null };
      return { ...r, src: { ...base, person_raw: it?.name ?? null, ...(it?.key ? { dedupe_key: it.key } : {}) } };
    }),
    stats,
  };
}
