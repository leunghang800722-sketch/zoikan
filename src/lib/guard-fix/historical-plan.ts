// HIST-5 A：歷史導入「未入格」身份推斷（guard-fix plan 歷史分支，取代 needs_boss）。
// 只喺 `buildGuardFixPlan({ historical: true })` 用；正式月份行為不變（呢個模組唔會被 call）。
// 規則表見 `src/lib/month-close/hist-inference.ts` 同 docs/ops.md「HIST-5」。
// 鐵則：evidence／decision 可以出姓名同工號，**唔准出電話／身份證／銀行／住址／出生日期**。
import type { PrismaClient } from "@prisma/client";
import { normalizeStaffNumber, STAFF_NUMBER_NUMBER_RE } from "@/lib/guards/staff-numbers";
import { HISTORICAL_ROSTER_SOURCE } from "@/lib/guard-fix/apply";
import { normalizeTel } from "@/lib/guards/contacts";
import { isMergedAwayGuard } from "@/lib/roster-upload/match";
import { uNumberKey, type UTeamRow } from "@/lib/guard-fix/sources";
import type { CreateMinimalAction, LinkAction, MergeGuardsAction } from "@/lib/guard-fix/types";
import {
  HIST_RULE_CONFIDENCE,
  foldName,
  isNameVariant,
  isStrictNameVariant,
  longestConsecutiveRunContaining,
  type HistInference,
  type HistInferenceRule,
  type HistRemaining,
  type HistRemainingCandidate,
  type HistReviewHint,
} from "@/lib/month-close/hist-inference";

export interface HistGuardRow {
  id: string;
  nameZh: string;
  nameAliases: string[];
  status: string;
  createdAt: Date;
  createdBy: string | null;
  tel: string | null;
  mergedFrom: string[];
}
export interface HistStaffNumberRow {
  number: string;
  guardId: string;
  status: string;
  scheme: string;
}

export interface HistPlanContext {
  prisma: PrismaClient;
  month: Date;
  guards: Map<string, HistGuardRow>;
  /** foldName(本名／別名) → guardId（已排除被合併走嘅 guard；任何 status）。 */
  foldIndex: Map<string, Set<string>>;
  staffNoOwner: Map<string, string>;
  staffNumbersByGuard: Map<string, HistStaffNumberRow[]>;
  guardIdsWithPhone: Set<string>;
  /** siteId → 同一個「家族」（同一母盤＋全部子盤）嘅 siteId。 */
  siteFamily: Map<string, Set<string>>;
  /** 已存在（未作廢）嘅 override key：`${staffNo}\u0000${nameRaw}`。 */
  activeOverrideKeys: Set<string>;
}

export interface HistIdentityInput {
  seq: string;
  nameRaw: string;
  staffNoRaw: string | null;
  totalCellCount: number;
  siteLabels: string[];
  siteIds: string[];
  /** 該身份喺更表用過嘅工號原文（查「連續月份」用）。 */
  staffNoRawVariants: string[];
}

export type HistDecision =
  | { kind: "link"; link: Omit<LinkAction, "seq">; hints: Array<Omit<HistReviewHint, "cells">> }
  | { kind: "create_minimal"; create: Omit<CreateMinimalAction, "seq" | "defaultBrokerCode">; hints?: Array<Omit<HistReviewHint, "cells">> }
  | { kind: "merge"; merge: Omit<MergeGuardsAction, "seq">; hints?: Array<Omit<HistReviewHint, "cells">> }
  | { kind: "remaining"; remaining: HistRemaining }
  | { kind: "fallthrough" };

export const overrideKeyOf = (staffNoNorm: string, name: string): string => `${staffNoNorm}\u0000${name}`;

export function buildHistPlanContext(params: {
  prisma: PrismaClient;
  month: Date;
  guardsRaw: HistGuardRow[];
  staffNumbersRaw: HistStaffNumberRow[];
  phonesRaw: Array<{ guardId: string }>;
  siteRows: Array<{ id: string; parentSiteId: string | null }>;
  activeOverrides: Array<{ staffNo: string; nameRaw: string }>;
  staffNoOwner: Map<string, string>;
}): HistPlanContext {
  const guards = new Map<string, HistGuardRow>();
  const foldIndex = new Map<string, Set<string>>();
  for (const g of params.guardsRaw) {
    if (isMergedAwayGuard(g)) continue;
    guards.set(g.id, g);
    for (const n of [g.nameZh, ...g.nameAliases]) {
      const k = foldName(n);
      if (!k) continue;
      if (!foldIndex.has(k)) foldIndex.set(k, new Set());
      foldIndex.get(k)!.add(g.id);
    }
  }
  const staffNumbersByGuard = new Map<string, HistStaffNumberRow[]>();
  for (const sn of params.staffNumbersRaw) {
    if (!staffNumbersByGuard.has(sn.guardId)) staffNumbersByGuard.set(sn.guardId, []);
    staffNumbersByGuard.get(sn.guardId)!.push(sn);
  }
  const rootOf = new Map(params.siteRows.map((s) => [s.id, s.parentSiteId ?? s.id]));
  const byRoot = new Map<string, Set<string>>();
  for (const s of params.siteRows) {
    const root = rootOf.get(s.id)!;
    if (!byRoot.has(root)) byRoot.set(root, new Set());
    byRoot.get(root)!.add(s.id);
  }
  const siteFamily = new Map<string, Set<string>>();
  for (const s of params.siteRows) siteFamily.set(s.id, byRoot.get(rootOf.get(s.id)!)!);
  return {
    prisma: params.prisma,
    month: params.month,
    guards,
    foldIndex,
    staffNoOwner: params.staffNoOwner,
    staffNumbersByGuard,
    guardIdsWithPhone: new Set(params.phonesRaw.map((p) => p.guardId)),
    siteFamily,
    activeOverrideKeys: new Set(params.activeOverrides.map((o) => overrideKeyOf(o.staffNo ? normalizeStaffNumber(o.staffNo) : "", o.nameRaw.trim()))),
  };
}

function currentNumbers(ctx: HistPlanContext, guardId: string): string[] {
  return (ctx.staffNumbersByGuard.get(guardId) ?? []).filter((n) => n.status === "current").map((n) => n.number);
}
function numbersText(ctx: HistPlanContext, guardId: string): string {
  const nums = currentNumbers(ctx, guardId);
  return nums.length ? `現有工號 ${nums.join("、")}` : "冇工號";
}
function guardName(ctx: HistPlanContext, guardId: string): string {
  return ctx.guards.get(guardId)?.nameZh ?? "（已刪）";
}
function foldCandidates(ctx: HistPlanContext, name: string): string[] {
  return [...(ctx.foldIndex.get(foldName(name)) ?? [])].sort();
}
/** 歷史導入自己建嘅 minimal guard：created_by 以 :historical_roster 結尾、冇工號、冇電話。 */
function isHistoricalMinimalGuard(ctx: HistPlanContext, g: HistGuardRow): boolean {
  return (g.createdBy ?? "").endsWith(`:${HISTORICAL_ROSTER_SOURCE}`) && (ctx.staffNumbersByGuard.get(g.id) ?? []).length === 0 && !g.tel && !ctx.guardIdsWithPhone.has(g.id);
}

function inferenceOf(rule: HistInferenceRule, identity: HistIdentityInput, decision: string, evidence: string[]): HistInference {
  return {
    rule,
    confidence: HIST_RULE_CONFIDENCE[rule],
    subject: { name: identity.nameRaw, ...(identity.staffNoRaw ? { staffNo: normalizeStaffNumber(identity.staffNoRaw) } : {}), ...(identity.siteLabels.length ? { site: identity.siteLabels.join("、") } : {}) },
    decision,
    evidence,
    cells: identity.totalCellCount,
  };
}

/** 加工號落目標 guard 嘅條件（同 guard-fix link 一致）：工號冇人用、目標同 scheme 冇另一張現用卡。 */
function staffNumberAddition(ctx: HistPlanContext, identity: HistIdentityInput, guardId: string): { scheme: string; number: string } | null {
  if (!identity.staffNoRaw) return null;
  const sn = normalizeStaffNumber(identity.staffNoRaw);
  if (!sn || ctx.staffNoOwner.has(sn) || !STAFF_NUMBER_NUMBER_RE.test(sn)) return null;
  const scheme = sn.match(/^[A-Z]+/)?.[0];
  if (!scheme || scheme.length > 4) return null;
  const existing = ctx.staffNumbersByGuard.get(guardId) ?? [];
  if (existing.some((n) => n.status === "current" && n.scheme === scheme)) return null;
  return { scheme, number: sn };
}

function identityOverrideKey(identity: HistIdentityInput): { staffNo: string; nameRaw: string } {
  return { staffNo: identity.staffNoRaw ? normalizeStaffNumber(identity.staffNoRaw) : "", nameRaw: identity.nameRaw.trim() };
}

function aliasToAdd(guard: HistGuardRow, name: string): string | null {
  const n = name.trim();
  return n && n !== guard.nameZh.trim() && !guard.nameAliases.includes(n) ? n : null;
}

async function historyCellsByGuard(ctx: HistPlanContext, guardIds: string[], siteIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(guardIds.map((id) => [id, 0]));
  const family = new Set<string>();
  for (const sid of siteIds) for (const f of ctx.siteFamily.get(sid) ?? [sid]) family.add(f);
  if (family.size === 0 || guardIds.length === 0) return out;
  const from = new Date(Date.UTC(ctx.month.getUTCFullYear(), ctx.month.getUTCMonth() - 3, 1));
  const to = new Date(Date.UTC(ctx.month.getUTCFullYear(), ctx.month.getUTCMonth() + 4, 1));
  const rows = await ctx.prisma.shiftRecord.groupBy({
    by: ["guardId"],
    where: { guardId: { in: guardIds }, siteId: { in: [...family] }, workDate: { gte: from, lt: to }, status: { not: "cancelled" } },
    _count: { _all: true },
  });
  for (const r of rows) out.set(r.guardId, r._count._all);
  return out;
}

async function remainingCandidates(ctx: HistPlanContext, guardIds: string[], siteIds: string[]): Promise<HistRemainingCandidate[]> {
  const hist = await historyCellsByGuard(ctx, guardIds, siteIds);
  return guardIds.map((id) => ({
    guardId: id,
    name: guardName(ctx, id),
    staffNumbers: currentNumbers(ctx, id),
    status: ctx.guards.get(id)?.status ?? "unknown",
    sameSiteHistoryCells: hist.get(id) ?? 0,
  }));
}

/** 同一身份（工號＋姓名）連續幾多個月出現（含本月）——R1 「懷疑 DB 工號登記錯」抽查提示用。 */
async function consecutiveMonthsForIdentity(ctx: HistPlanContext, identity: HistIdentityInput): Promise<number> {
  if (identity.staffNoRawVariants.length === 0) return 0;
  const rows = await ctx.prisma.rosterUploadRow.findMany({
    where: { staffNoRaw: { in: identity.staffNoRawVariants }, nameRaw: identity.nameRaw, upload: { status: { notIn: ["superseded", "voided"] } } },
    select: { upload: { select: { month: true } } },
    distinct: ["uploadId"],
  });
  return longestConsecutiveRunContaining(
    rows.map((r) => r.upload.month),
    ctx.month,
  );
}

function linkAction(ctx: HistPlanContext, identity: HistIdentityInput, guardId: string, rule: HistInferenceRule, decision: string, evidence: string[], opts: { addStaffNumber: boolean }): Omit<LinkAction, "seq"> {
  const g = ctx.guards.get(guardId)!;
  const inference = inferenceOf(rule, identity, decision, evidence);
  return {
    type: "link",
    guardId,
    reason: `HIST5 ${rule}：${decision}`,
    addStaffNumber: opts.addStaffNumber ? staffNumberAddition(ctx, identity, guardId) : null,
    addAlias: aliasToAdd(g, identity.nameRaw),
    addOverrides: [identityOverrideKey(identity)],
    inference,
  };
}

export interface HistDecideInput {
  identity: HistIdentityInput;
  /** 電話層對到嘅唯一 guard（findByTel／byHkid 指向嘅人）；冇＝null。 */
  telGuardId: string | null;
}

/** 單一身份決定：link／create_minimal／merge／remaining／fallthrough（交返原有邏輯）。 */
export async function decideHistoricalIdentity(ctx: HistPlanContext, input: HistDecideInput): Promise<HistDecision> {
  const { identity, telGuardId } = input;
  const sn = identity.staffNoRaw ? normalizeStaffNumber(identity.staffNoRaw) : null;
  const snOwnerId = sn ? (ctx.staffNoOwner.get(sn) ?? null) : null;
  const cands = foldCandidates(ctx, identity.nameRaw);
  const nameText = `「${identity.nameRaw}」`;

  // 已有 active override 但身份仍然未配對＝override 冇生效（姓名／工號鍵唔夾）——唔好每輪重複產生同一個動作。
  const ownKey = identityOverrideKey(identity);
  const overrideAlreadyThere = ctx.activeOverrideKeys.has(overrideKeyOf(ownKey.staffNo, ownKey.nameRaw));

  if (cands.length === 1) {
    const bId = cands[0]!;
    const b = ctx.guards.get(bId)!;
    if (overrideAlreadyThere) return overrideNotEffective(ctx, identity, [bId]);
    // R1：工號屬別人、姓名唯一
    if (sn && snOwnerId && snOwnerId !== bId) {
      const evidence = [
        `更表工號 ${sn} 屬 DB 另一位保安員「${guardName(ctx, snOwnerId)}」（姓名對唔上）`,
        `更表姓名${nameText}（本名∪別名，簡繁／後綴折返）唯一對到「${b.nameZh}」（${numbersText(ctx, bId)}）`,
        ...(telGuardId && telGuardId !== bId ? [`更表電話屬另一位保安員「${guardName(ctx, telGuardId)}」`] : []),
      ];
      const hints: Array<Omit<HistReviewHint, "cells">> = [];
      const months = await consecutiveMonthsForIdentity(ctx, identity);
      if (months >= 3) {
        evidence.push(`同一工號＋姓名連續 ${months} 個月出現`);
        hints.push({
          rule: "R1",
          subject: inferenceOf("R1", identity, "", []).subject,
          hint: `懷疑 DB 工號登記錯：更表連續 ${months} 個月都用工號 ${sn}（DB 登記屬「${guardName(ctx, snOwnerId)}」），但姓名唯一對到「${b.nameZh}」（${numbersText(ctx, bId)}）——建議抽查工號主檔`,
          evidence: [...evidence],
        });
      }
      return { kind: "link", link: linkAction(ctx, identity, bId, "R1", `連結到「${b.nameZh}」（寫配對覆寫，唔加工號）`, evidence, { addStaffNumber: false }), hints };
    }
    // R2a：電話屬別人 A，姓名唯一對到另一位 B
    if (telGuardId && telGuardId !== bId) {
      const evidence = [`更表電話屬另一位保安員「${guardName(ctx, telGuardId)}」（疑共用電話）`, `更表姓名${nameText}唯一對到「${b.nameZh}」（${numbersText(ctx, bId)}）`];
      return { kind: "link", link: linkAction(ctx, identity, bId, "R2a", `連結到「${b.nameZh}」（唔加電話）`, evidence, { addStaffNumber: true }), hints: [] };
    }
    // R2b：姓名變體唯一對到一位（含電話主人同呢位一致）
    const exactSame = b.nameZh.trim() === identity.nameRaw.trim() || b.nameAliases.includes(identity.nameRaw.trim());
    const evidence = [
      exactSame ? `更表姓名${nameText}唯一對到「${b.nameZh}」（本名∪別名）` : `更表姓名${nameText}同「${b.nameZh}」係同一個名嘅變體（簡繁／NFKC／後綴），DB 內唯一`,
      ...(telGuardId === bId ? ["電話亦指向同一位保安員"] : ["冇電話／工號衝突，淨靠姓名（唯一）"]),
    ];
    return { kind: "link", link: linkAction(ctx, identity, bId, "R2b", `連結到「${b.nameZh}」並加更表用名做別名`, evidence, { addStaffNumber: true }), hints: [] };
  }

  if (cands.length === 0) {
    if (telGuardId) {
      const a = ctx.guards.get(telGuardId);
      if (!a) return { kind: "fallthrough" };
      if (overrideAlreadyThere) return overrideNotEffective(ctx, identity, [telGuardId]);
      const aNames = [a.nameZh, ...a.nameAliases];
      const variant = aNames.some((n) => isNameVariant(identity.nameRaw, n));
      if (variant) {
        // HIST-5.1：淨係「3 字名姓同、名差一字」（形近／同音）先中 → 信心降 0.05。
        const loose = !aNames.some((n) => isStrictNameVariant(identity.nameRaw, n));
        const evidence = [
          `更表電話屬「${a.nameZh}」（${numbersText(ctx, telGuardId)}）`,
          `更表姓名${nameText}同「${a.nameZh}」係變體（簡繁／NFKC／後綴／相差一字${loose ? "；3 字名姓相同、名差一字（形近／同音）" : ""}）`,
          ...(snOwnerId && snOwnerId !== telGuardId ? [`更表工號 ${sn} 屬另一位「${guardName(ctx, snOwnerId)}」，唔加工號`] : []),
        ];
        const la = linkAction(ctx, identity, telGuardId, "R2b", `連結到「${a.nameZh}」並加更表用名做別名`, evidence, { addStaffNumber: true });
        if (loose && la.inference) la.inference = { ...la.inference, confidence: Math.round((la.inference.confidence - 0.05) * 100) / 100 };
        return { kind: "link", link: la, hints: [] };
      }
      const evidence = [`更表電話屬另一位保安員「${a.nameZh}」，但更表姓名${nameText}DB 冇、同「${a.nameZh}」亦唔係變體`, "疑共用電話（家人／雞頭電話）→ 建獨立保安員，電話留空"];
      return {
        kind: "create_minimal",
        create: {
          type: "create_minimal",
          nameZh: identity.nameRaw,
          tel: null,
          reason: "電話屬另一人，疑共用電話",
          staffNumber: sn && !snOwnerId ? staffNumberAddition(ctx, identity, "") : null,
          overrides: [ownKey],
          inference: inferenceOf("R2c", identity, "新建保安員（電話留空）", evidence),
        },
      };
    }
    return { kind: "fallthrough" };
  }

  // ---- cands >= 2：R3 ----
  const candRows = cands.map((id) => ctx.guards.get(id)!);
  const exact = candRows.filter((g) => g.nameZh.trim() === identity.nameRaw.trim());
  const othersAreSuffixVariants = (keeper: HistGuardRow) => candRows.filter((g) => g.id !== keeper.id).every((g) => foldName(g.nameZh) === foldName(identity.nameRaw));
  const allMinimal = candRows.every((g) => isHistoricalMinimalGuard(ctx, g));
  if (overrideAlreadyThere) return overrideNotEffective(ctx, identity, cands);

  const mergeAction = (keeper: HistGuardRow, rule: "R3a" | "R3b" | "R3d", mergeIds: string[], evidence: string[]): HistDecision => ({
    kind: "merge",
    merge: {
      type: "merge_guards",
      keepGuardId: keeper.id,
      mergeGuardIds: mergeIds,
      reason: `HIST5 ${rule}：合併同名歷史導入 minimal guard`,
      addStaffNumber: staffNumberAddition(ctx, identity, keeper.id),
      addAlias: aliasToAdd(keeper, identity.nameRaw),
      addOverrides: [ownKey],
      inference: inferenceOf(rule, identity, `保留「${keeper.nameZh}」，合併 ${mergeIds.length} 個重複 guard`, evidence),
    },
  });

  // R3b：一個本名完全相同＋其餘係後綴／簡繁變體
  if (exact.length === 1 && othersAreSuffixVariants(exact[0]!)) {
    const keeper = exact[0]!;
    const others = candRows.filter((g) => g.id !== keeper.id);
    const mergeable = others.filter((g) => isHistoricalMinimalGuard(ctx, g)).map((g) => g.id);
    const evidence = [`DB 有 ${cands.length} 個候選，其中一個本名同更表完全相同，其餘係變體（${others.map((g) => `「${g.nameZh}」`).join("、")}）`, `保留本名相同嗰個（${numbersText(ctx, keeper.id)}）`];
    if (mergeable.length > 0) {
      evidence.push(`${mergeable.length} 個變體係歷史導入 minimal guard（冇工號冇電話）→ 合併`);
      return mergeAction(keeper, "R3b", mergeable, evidence);
    }
    evidence.push("變體候選有工號／電話，唔合併，只連結");
    return { kind: "link", link: linkAction(ctx, identity, keeper.id, "R3b", `連結到本名完全相同嗰個「${keeper.nameZh}」`, evidence, { addStaffNumber: true }), hints: [] };
  }
  // R3a：全部係歷史導入 minimal → 合併，保留最早建嗰個
  if (allMinimal) {
    const keeper = [...candRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]!;
    const evidence = [`DB 同名候選 ${cands.length} 個，全部係歷史導入自己建嘅 minimal guard（冇工號冇電話）`, "保留最早建立嗰個，其餘 shift_records／長工崗位改指保留者"];
    return mergeAction(keeper, "R3a", cands.filter((id) => id !== keeper.id), evidence);
  }

  // R3d（HIST-5.1）：剛好一個真實 guard，其餘全部係歷史導入 minimal → 併入真實嗰個（真實有同盤盤史信心 0.75，否則 0.7）。
  const realCands = candRows.filter((g) => !isHistoricalMinimalGuard(ctx, g));
  if (realCands.length === 1) {
    const keeper = realCands[0]!;
    const minimalIds = candRows.filter((g) => g.id !== keeper.id).map((g) => g.id);
    const keeperHist = (await historyCellsByGuard(ctx, [keeper.id], identity.siteIds)).get(keeper.id) ?? 0;
    const evidence = [
      `DB 同名候選 ${cands.length} 個：1 個真實保安員「${keeper.nameZh}」（${numbersText(ctx, keeper.id)}）＋${minimalIds.length} 個歷史導入 minimal guard（冇工號冇電話）`,
      keeperHist > 0 ? `真實保安員喺同一盤（含子盤）±3 個月內有 ${keeperHist} 條更次` : "真實保安員喺同一盤±3 個月內冇更次",
      "minimal 嘅 shift_records／長工崗位／覆寫併入真實保安員",
    ];
    const d = mergeAction(keeper, "R3d", minimalIds, evidence);
    if (d.kind === "merge") {
      if (keeperHist > 0) d.merge.inference = { ...d.merge.inference, confidence: 0.75 };
      d.hints = [{ rule: "R3d", subject: d.merge.inference.subject, hint: "歷史 minimal 同名併入真實保安員", evidence: [...evidence] }];
    }
    return d;
  }

  // R3c：用盤史揀
  const hist = await historyCellsByGuard(ctx, cands, identity.siteIds);
  const withHist = cands.filter((id) => (hist.get(id) ?? 0) > 0);
  if (withHist.length === 1) {
    const pick = withHist[0]!;
    const g = ctx.guards.get(pick)!;
    const evidence = [`DB 同名候選 ${cands.length} 個（非全部係歷史導入 minimal）`, `淨係「${g.nameZh}」（${numbersText(ctx, pick)}）喺同一盤（含子盤）±3 個月內有 ${hist.get(pick)} 條更次，其餘冇`];
    return { kind: "link", link: linkAction(ctx, identity, pick, "R3c", `連結到盤史唯一有更次嘅「${g.nameZh}」`, evidence, { addStaffNumber: true }), hints: [] };
  }
  const candidates = await remainingCandidates(ctx, cands, identity.siteIds);
  const bestCount = Math.max(...candidates.map((c) => c.sameSiteHistoryCells));
  const top = candidates.filter((c) => c.sameSiteHistoryCells === bestCount);
  const recommendedPick = bestCount > 0 ? top[0]! : (candidates.find((c) => c.status === "active") ?? candidates[0]!);
  return {
    kind: "remaining",
    remaining: {
      subject: inferenceOf("R3c", identity, "", []).subject,
      reasonCode: withHist.length === 0 ? "same_name_multi_no_history" : "same_name_multi_both_history",
      cells: identity.totalCellCount,
      candidates,
      recommended: {
        action: "link",
        guardId: recommendedPick.guardId,
        name: recommendedPick.name,
        confidence: bestCount > 0 ? 0.6 : 0.5,
        why: bestCount > 0 ? `同盤歷史更次最多（${bestCount} 條）` : "兩個候選同盤都冇歷史更次，揀仍然 active（或最早）嗰個",
      },
    },
  };
}

function overrideNotEffective(ctx: HistPlanContext, identity: HistIdentityInput, guardIds: string[]): HistDecision {
  return {
    kind: "remaining",
    remaining: {
      subject: inferenceOf("R1", identity, "", []).subject,
      reasonCode: "override_exists_but_unmatched",
      cells: identity.totalCellCount,
      candidates: guardIds.map((id) => ({ guardId: id, name: guardName(ctx, id), staffNumbers: currentNumbers(ctx, id), status: ctx.guards.get(id)?.status ?? "unknown", sameSiteHistoryCells: 0 })),
      recommended: { action: "none", confidence: 0, why: "已有配對覆寫但重新解析後仍未配對，請檢查覆寫指向嘅保安員（外部資料問題）" },
    },
  };
}

/** conflicting_methods（電話同身份證指唔同人）：歷史模式理論上唔出現；出現就 remaining，recommended 用姓名規則揀。 */
export async function conflictingMethodsRemaining(ctx: HistPlanContext, identity: HistIdentityInput, guardIds: string[]): Promise<HistRemaining> {
  const byName = foldCandidates(ctx, identity.nameRaw).filter((id) => guardIds.includes(id));
  const candidates = await remainingCandidates(ctx, guardIds, identity.siteIds);
  const pick = byName.length === 1 ? byName[0]! : null;
  return {
    subject: inferenceOf("R2a", identity, "", []).subject,
    reasonCode: "conflicting_methods",
    cells: identity.totalCellCount,
    candidates,
    recommended: pick
      ? { action: "link", guardId: pick, name: guardName(ctx, pick), confidence: 0.6, why: "電話同身份證指唔同人；更表姓名只對到其中一位" }
      : { action: "none", confidence: 0, why: "電話同身份證指唔同人，姓名亦判斷唔到" },
  };
}

/** 其餘 needs_boss 原因（U Team 名單被拒等）→ remaining，recommended 建獨立保安員（電話留空、待核）。 */
export async function needsBossToRemaining(ctx: HistPlanContext, identity: HistIdentityInput, nb: { code?: string; reason: string; candidateGuardIds: string[] }): Promise<HistRemaining> {
  const ids = nb.candidateGuardIds.filter((id) => ctx.guards.has(id));
  return {
    subject: inferenceOf("R5", identity, "", []).subject,
    reasonCode: nb.code ?? "other",
    cells: identity.totalCellCount,
    candidates: await remainingCandidates(ctx, ids, identity.siteIds),
    recommended: { action: "create", name: identity.nameRaw, confidence: 0.5, why: `${nb.reason}；建議按更表姓名建獨立保安員（無工號、電話留空）待核` },
  };
}



// ---------------------------------------------------------------------------
// HIST-5.1 R6：U Team 名單同名多行（`uRowsByName.length > 1`）——分辨，唔再 needs_boss。
// ---------------------------------------------------------------------------

export interface UTeamDupPick {
  via: "number" | "R6a" | "R6b";
  row: UTeamRow;
}

/** 名單同名多行，按次序揀：(1) 更表工號等於其中一行 U 號；(2) R6a 各行身份證全部相同（≥1 行有身份證，其餘空）→ 有身份證嗰行優先；
 * (3) R6b 更表電話剛好等於其中一行電話。都唔得＝null（caller 走 R6c）。純函數，唔睇 DB。 */
export function pickUTeamDuplicateRow(rows: UTeamRow[], staffNoRaw: string | null, telRaw: string | null): UTeamDupPick | null {
  const uNumber = staffNoRaw ? uNumberKey(staffNoRaw) : null;
  if (uNumber) {
    const hits = rows.filter((r) => r.uNumber && uNumberKey(r.uNumber) === uNumber);
    if (hits.length > 0) return { via: "number", row: hits.find((r) => r.hkid) ?? hits[0]! };
  }
  const hkids = new Set(rows.map((r) => r.hkid).filter((h): h is string => !!h));
  if (hkids.size === 1) return { via: "R6a", row: rows.find((r) => r.hkid) ?? rows[0]! };
  const rowTel = telRaw ? normalizeTel(telRaw) : null;
  if (rowTel) {
    const hits = rows.filter((r) => r.tel && normalizeTel(r.tel) === rowTel);
    if (hits.length === 1) return { via: "R6b", row: hits[0]! };
  }
  return null;
}

/** R6a／R6b 選中名單行之後照舊 `create`，帶呢個推斷（evidence 唔出電話／身份證值）。 */
export function uteamPickInference(identity: HistIdentityInput, rule: "R6a" | "R6b", rowCount: number): HistInference {
  const nameText = `「${identity.nameRaw}」`;
  const evidence =
    rule === "R6a"
      ? [`U Team 名單有 ${rowCount} 個同名行${nameText}，身份證全部一致（有身份證嗰行優先）→ 判斷為名單重複行`, "用第一行（有身份證嗰行）建保安員（身份證／入職日／U 號照名單）"]
      : [`U Team 名單有 ${rowCount} 個同名行${nameText}`, "更表電話剛好等於其中一行嘅電話 → 用嗰行建保安員（身份證／入職日／U 號照名單）"];
  return inferenceOf(rule, identity, rule === "R6a" ? "名單同名重複行，用第一行建保安員" : "名單同名多行，按電話揀行建保安員", evidence);
}

/** R6c：分辨唔到邊行（或選中行被原有 refuse 條件拒）→ 唔用名單資料，按更表姓名建獨立保安員（待核）。
 * tel：caller 已按 R2 規則處理（電話屬別人就傳 null）。更表工號 DB 冇人用就登記 current，否則只寫 override。 */
export function decideUTeamDuplicateMinimal(ctx: HistPlanContext, identity: HistIdentityInput, opts: { tel: string | null; rowCount: number; refuse?: string }): Extract<HistDecision, { kind: "create_minimal" }> {
  const nameText = `「${identity.nameRaw}」`;
  const staffNumber = staffNumberAddition(ctx, identity, "");
  const evidence = [
    `U Team 名單有 ${opts.rowCount} 個同名行${nameText}，${opts.refuse ? `選中嘅行被拒（${opts.refuse}）` : "身份證唔一致、電話亦對唔上，分辨唔到邊一行"}`,
    "唔用名單資料，按更表姓名建獨立保安員",
    staffNumber ? `更表工號 ${staffNumber.number} DB 冇人用，登記做 current` : identity.staffNoRaw ? "更表工號 DB 已有人用／格式唔啱，唔登記，只寫配對覆寫" : "更表冇工號，只寫配對覆寫",
    ...(opts.tel ? [] : ["電話留空（更表冇電話或電話屬別人）"]),
  ];
  const inference = inferenceOf("R6c", identity, "唔用名單資料，按更表姓名建獨立保安員", evidence);
  return {
    kind: "create_minimal",
    create: {
      type: "create_minimal",
      nameZh: identity.nameRaw,
      tel: opts.tel,
      reason: `HIST5 R6c：U Team 名單同名 ${opts.rowCount} 行${opts.refuse ? `（${opts.refuse}）` : "分辨唔到"}——唔用名單資料，按更表姓名建獨立保安員，待核`,
      staffNumber,
      overrides: [identityOverrideKey(identity)],
      inference,
    },
    hints: [
      {
        rule: "R6c",
        subject: inference.subject,
        hint: `名單有 ${opts.rowCount} 個同名行，未用名單資料（身份證／入職日未補）${opts.refuse ? `；選中行被拒：${opts.refuse}` : ""}`,
        evidence: [...evidence],
      },
    ],
  };
}
