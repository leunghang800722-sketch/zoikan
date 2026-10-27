// WA-9：文字名單 → 逐名 shift intent（純 code，零 LLM）。
// 每個名：strict（NFKC 去空白）姓名配對，範圍＝該盤近 60 日有更／判頭旗下／該群曾配對過嘅 guard；範圍內唯一 → 配到；
// 範圍內冇而全體唯一 → 配到（擴到全部）；同名多人／配唔到 → 揀人題（候選：同名者＋同範圍字形接近者）。**只有呢啲名先出題。**
// 日期＝名單日期（明確日期用絕對 token；凌晨「今日」等沿用 resolveIntents 日期降級）；盤＝群盤（盤口群）或該人預排／近 60 日；
// 更＝名單內該名更碼 → 群「開工」對照 → 該盤只有一個更別 → 否則 shift_unmapped（出題）。日期窗口／鎖月／撞更／同日同人同更去重全部沿用 resolveIntents。
import { prisma } from "@/lib/db";
import { addDays, hkDateOf } from "./dates";
import type { ParsedIntent } from "./parse";
import { prismaCardDeps, siteAndShiftFor, type CardDeps } from "./card-resolve";
import type { RosterList } from "./roster-list";
import { resolveIntents, resolveShift, type IntentOverride, type ResolveContext, type ResolvedIntent } from "./resolve";

const RECENT_DAYS = 60;
const MAX_CANDIDATES = 8;

export interface RosterDeps extends CardDeps {
  /** 呢個群近 N 日已配對到嘅 guard（whatsapp_intents.guard_id 非空） */
  groupMatchedGuards(chatJid: string, sinceIso: string): Promise<Set<string>>;
}

export function prismaRosterDeps(): RosterDeps {
  return {
    ...prismaCardDeps(),
    async groupMatchedGuards(chatJid, sinceIso) {
      const rows = await prisma.whatsappIntent.findMany({ where: { guardId: { not: null }, message: { chatJid, ts: { gte: new Date(`${sinceIso}T00:00:00+08:00`) } } }, select: { guardId: true }, distinct: ["guardId"], take: 500 });
      return new Set(rows.flatMap((r) => (r.guardId ? [r.guardId] : [])));
    },
  };
}

const norm = (s: string): string => s.normalize("NFKC").replace(/\s+/g, "");

export async function resolveRosterList(args: { ctx: ResolveContext; list: RosterList; chatJid: string; deps?: RosterDeps }): Promise<ResolvedIntent[]> {
  const { ctx, list } = args;
  const deps = args.deps ?? prismaRosterDeps();
  const idx = ctx.index;
  const day = hkDateOf(ctx.ts);
  const since = addDays(day, -RECENT_DAYS);
  // 範圍：盤口群→該盤近 60 日有更；判頭群→該判頭旗下；加上呢個群曾配對過嘅 guard
  const scope = new Set<string>(await deps.groupMatchedGuards(args.chatJid, since));
  if (ctx.group.kind === "site" && ctx.group.siteId) for (const g of await ctx.repo.recentGuardIdsAtSite(ctx.group.siteId, since)) scope.add(g);
  else if (ctx.group.kind === "broker" && ctx.group.brokerId) for (const g of await ctx.repo.recentGuardIdsOfBroker(ctx.group.brokerId, since)) scope.add(g);

  const dateRaw = list.date ? `${Number(list.date.slice(5, 7))}月${Number(list.date.slice(8, 10))}日` : list.date_raw;
  const intents: ParsedIntent[] = [];
  const overrides = new Map<number, IntentOverride>();
  const nameOf: string[] = [];
  for (const [i, n] of list.names.entries()) {
    const nm = norm(n.raw);
    const global = [...new Set([...(idx.byName.get(nm) ?? []), ...(idx.byAlias.get(nm) ?? [])])];
    const inScope = global.filter((g) => scope.has(g));
    let person: NonNullable<IntentOverride["person"]>;
    if (inScope.length === 1) person = { guardId: inScope[0]!, reasons: [], candidates: [], basis: "roster_name_in_scope" };
    else if (inScope.length === 0 && global.length === 1) person = { guardId: global[0]!, reasons: [], candidates: [], basis: "roster_name" };
    else if (global.length > 0) person = { guardId: null, reasons: ["person_ambiguous"], candidates: (inScope.length > 1 ? inScope : global).slice(0, MAX_CANDIDATES), basis: "roster_name_multi" };
    else {
      // 配唔到：候選＝同範圍、字形接近（共用字）嘅 guard
      const chars = new Set([...nm]);
      const overlap = (g: string): number => [...(idx.nameByGuardId.get(g) ?? "")].filter((c) => chars.has(c)).length;
      const near = [...scope].filter((g) => overlap(g) > 0).sort((a, b) => overlap(b) - overlap(a) || a.localeCompare(b)).slice(0, MAX_CANDIDATES);
      person = near.length > 0 ? { guardId: null, reasons: ["person_ambiguous"], candidates: near, basis: "roster_name_unmatched" } : { guardId: null, reasons: ["person_unknown"], candidates: [], basis: "roster_name_unmatched" };
    }
    const sf = await siteAndShiftFor(person.guardId, ctx, deps);
    // 更：名單提示 → 群「開工」對照 → 該盤單一更別；預排嘅更別（scheduled）照用
    let shift: NonNullable<IntentOverride["shift"]> | undefined = sf.shift?.basis === "scheduled" ? sf.shift : undefined;
    if (!shift && sf.site.siteId) {
      const types = await ctx.repo.shiftTypes(sf.site.siteId);
      if (n.shift_hint) shift = resolveShift(n.shift_hint, null, types, ctx.group.shiftWordMap);
      else if (Object.prototype.hasOwnProperty.call(ctx.group.shiftWordMap, "開工")) shift = resolveShift("開工", null, types, ctx.group.shiftWordMap);
      else if (types.length === 1) shift = { shiftTypeId: types[0]!.id, reasons: [], candidates: [], basis: "single_shift_type" };
      else shift = { shiftTypeId: null, reasons: ["shift_unmapped"], candidates: [], basis: "roster_no_shift_hint" };
    }
    intents.push({
      type: "shift",
      date: { raw: dateRaw, kind: list.date ? "absolute" : "relative" },
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
    overrides.set(i, { person, site: sf.site, ...(shift ? { shift } : {}), extraReasons: sf.extra, extraNotes: ["roster_list"] });
    nameOf.push(n.raw);
  }
  const resolved = await resolveIntents(intents, { ...ctx, overrides });
  // resolveIntents 一個 intent 對一行（單日）；逐行對返姓名做 src.person_raw（題卡顯示／「記住花名」用）
  return resolved.map((r, k) => ({ ...r, src: { ...(r.src ?? { person_raw: null, site_raw: null, date_raw: null, shift_raw: null, leave_raw: null, replaced_raw: null }), person_raw: nameOf[Math.min(k, nameOf.length - 1)] ?? null } }));
}
