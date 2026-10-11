// WP-AI-DIAG（§37.3）：助手「診斷工具」嘅唯讀 reader（純讀、Prisma 讀；**無任何寫入方法調用**）。
// 放喺 `src/lib/reports/`（結構性守門 allowlist 已涵蓋「純讀 report builder」），tool 檔（`src/lib/ai/tools/`）
// 只 import 呢度嘅 function，唔含 `prisma.`／`@/lib/db` 字面。
//
// 鐵律：每個 function 嘅回傳**自己寫投影**——只有數字、id、盤名、更種代號、雞頭顯示名（`brokerDisplayName()`），
// **冇保安員姓名／工號／電話／身份證**。唔直接回傳 `questionViews()` 之類帶候選人資料嘅物件。
import { getSystemUserId } from "@/lib/system-user";
import { prisma } from "@/lib/db";
import { monthRange, monthStart as toMonthStart } from "./money";
import { findOneClickRuns } from "@/lib/month-close/one-click-read";
import { monthCloseRunStalled } from "@/lib/month-close/one-click";
import { stepOfAutoCardNote } from "@/lib/month-close/auto/dependency";
import { buildMonthHealth } from "@/lib/ops/month-health";
import { buildOpsDigest } from "@/lib/ops/digest";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import { brokerDisplayName } from "../ai/tools/common";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { scrubUnknownShape, type AiFieldVisibility } from "../ai/field-scrub";

const GUARD_MATCH_FIXED_TEXT = "保安員配對要核實（明細要去分診頁，由有權限同事處理）";
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const cut = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : null);

export function monthFromYm(ym: string): Date {
  return toMonthStart(new Date(`${ym}-01T00:00:00.000Z`));
}

// ---------------------------------------------------------------------------
// 1. one_click_status
// ---------------------------------------------------------------------------
interface StepLike {
  key?: unknown;
  label?: unknown;
  status?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  numbers?: unknown;
  warnings?: unknown;
  needsHuman?: unknown;
}

export async function readOneClickStatus(month: Date, vis?: AiFieldVisibility) {
  const runs = await findOneClickRuns(month, 5);
  const run = runs[0];
  if (!run) return { month: month.toISOString().slice(0, 7), run: null, runs_in_month: 0 };
  const steps = (Array.isArray(run.stepsJson) ? (run.stepsJson as StepLike[]) : []).map((s) => ({
    key: s.key ?? null,
    label: s.label ?? null,
    status: s.status ?? null,
    numbers: s.numbers && typeof s.numbers === "object" ? s.numbers : {},
    // warnings／needsHuman 原文（一鍵結算設計上冇姓名／工號／電話，見 month-close/types.ts）
    warnings: Array.isArray(s.warnings) ? s.warnings.map((w) => cut(w, 400)) : [],
    needs_human: Array.isArray(s.needsHuman) ? s.needsHuman.map((w) => cut(w, 400)) : [],
  }));
  const report = (run.reportJson ?? null) as { auto?: { summary?: unknown; undone?: unknown; review?: Array<{ kind?: unknown; text?: unknown; confidence?: unknown; questionId?: unknown }> }; totals?: unknown; unpriced?: unknown; lockPrecondition?: unknown } | null;
  const result = {
    month: run.month.toISOString().slice(0, 7),
    runs_in_month: runs.length,
    run: {
      id: run.id,
      status: run.status,
      started_at: iso(run.startedAt),
      finished_at: iso(run.finishedAt),
      current_step: run.currentStep,
      stalled: monthCloseRunStalled(run),
      error_message: cut(run.errorMessage, 300),
      steps,
      // auto.summary（含 postorder_dependency）：by design 冇 PII
      auto_summary: report?.auto?.summary ?? null,
      auto_undone: report?.auto?.undone ?? null,
      // guard_match 類 review 文字可能帶保安員名／工號：同 triage_summary 一樣出固定句，唔原樣傳
      auto_review: (report?.auto?.review ?? []).slice(0, 30).map((r) => ({
        kind: r.kind ?? null,
        text: r.kind === "month_close_guard_match" ? GUARD_MATCH_FIXED_TEXT : cut(r.text, 300),
        confidence: r.confidence ?? null,
        question_id: r.questionId ?? null,
      })),
      unpriced: report?.unpriced ?? null,
      lock_precondition: report?.lockPrecondition ?? null,
    },
  };
  // steps[].numbers／auto_summary 等按查閱者權限遮收客價／出街價類欄位（同其他工具一致）
  return vis ? scrubUnknownShape(result, vis) : result;
}

// ---------------------------------------------------------------------------
// 2. triage_summary
// ---------------------------------------------------------------------------
interface McEvidenceLike {
  kind?: string;
  summary?: string;
  confidence?: string;
  prefillCandidateId?: string | null;
  candidates?: Array<{ id?: unknown }>;
  action?: {
    type?: string;
    siteId?: string;
    siteNameRaw?: string;
    siteLabel?: string;
    cellCount?: number;
    count?: number;
    group?: { siteId?: string; shiftTypeId?: string; brokerId?: string | null; ot?: boolean };
    groups?: Array<{ siteId?: string; shiftTypeId?: string; brokerId?: string | null }>;
  };
}

export async function readTriageSummary(month: Date, actor: Pick<AuthedSession, "baseRole" | "userId">) {
  const ym = month.toISOString().slice(0, 7);
  const runs = await prisma.monthCloseRun.findMany({ where: { month }, select: { id: true } });
  const boss = actor.baseRole === "老闆";
  const sessions = await prisma.triageSession.findMany({
    where: {
      OR: [{ sourceType: "month_close", sourceRef: { in: runs.map((r) => r.id) } }, { sourceType: "postorder_backfill", sourceRef: ym }],
      ...(boss ? {} : { ownerUserId: { in: [actor.userId, (await getSystemUserId()) ?? actor.userId] } }),
    },
    select: { id: true, sourceType: true },
  });
  const questions = sessions.length
    ? await prisma.triageQuestion.findMany({
        where: { sessionId: { in: sessions.map((s) => s.id) }, status: { not: "superseded" } },
        orderBy: [{ status: "asc" }, { sort: "asc" }, { id: "asc" }],
        take: 600,
        select: { id: true, sessionId: true, kind: true, status: true, evidenceJson: true, optionsJson: true },
      })
    : [];

  const siteIds = new Set<string>();
  const shiftTypeIds = new Set<string>();
  const brokerIds = new Set<string>();
  for (const q of questions) {
    const a = (q.evidenceJson as McEvidenceLike).action;
    if (!a) continue;
    if (a.siteId) siteIds.add(a.siteId);
    if (a.group?.siteId) siteIds.add(a.group.siteId);
    if (a.group?.shiftTypeId) shiftTypeIds.add(a.group.shiftTypeId);
    if (a.group?.brokerId) brokerIds.add(a.group.brokerId);
    for (const g of a.groups ?? []) {
      if (g.siteId) siteIds.add(g.siteId);
      if (g.shiftTypeId) shiftTypeIds.add(g.shiftTypeId);
      if (g.brokerId) brokerIds.add(g.brokerId);
    }
  }
  const [sites, shiftTypes, brokers] = await Promise.all([
    siteIds.size ? prisma.site.findMany({ where: { id: { in: [...siteIds] } }, select: { id: true, canonicalName: true } }) : [],
    shiftTypeIds.size ? prisma.shiftType.findMany({ where: { id: { in: [...shiftTypeIds] } }, select: { id: true, code: true } }) : [],
    brokerIds.size ? prisma.broker.findMany({ where: { id: { in: [...brokerIds] } }, select: { id: true, code: true, name: true, kind: true } }) : [],
  ]);
  const siteName = new Map(sites.map((s) => [s.id, s.canonicalName]));
  const stCode = new Map(shiftTypes.map((s) => [s.id, s.code]));
  const brokerDisp = new Map(brokers.map((b) => [b.id, brokerDisplayName({ name: b.name, code: b.code, kind: b.kind })]));

  const by_kind: Record<string, number> = {};
  const by_confidence: Record<string, number> = {};
  const by_status: Record<string, number> = {};
  const rows = questions.map((q) => {
    const ev = q.evidenceJson as McEvidenceLike;
    const a = ev.action;
    const g = a?.group ?? a?.groups?.[0];
    const siteId = a?.siteId ?? g?.siteId;
    const kind = q.kind;
    const confidence = ev.confidence ?? "unknown";
    by_kind[kind] = (by_kind[kind] ?? 0) + 1;
    by_confidence[confidence] = (by_confidence[confidence] ?? 0) + 1;
    by_status[q.status] = (by_status[q.status] ?? 0) + 1;
    // guard_match 題嘅 summary／候選可能帶人名：只出固定句，唔回 summary／候選／identity
    const summary =
      kind === "month_close_guard_match"
        ? `${a?.cellCount ?? 0} 格保安員配對要核實（明細要去分診頁，由有權限同事處理）`
        : cut(ev.summary, 240);
    return {
      id: q.id,
      kind,
      status: q.status,
      confidence,
      site: siteId ? (siteName.get(siteId) ?? null) : (a?.siteNameRaw ?? a?.siteLabel ?? null),
      shift_type: g?.shiftTypeId ? (stCode.get(g.shiftTypeId) ?? null) : null,
      broker_display: g?.brokerId ? (brokerDisp.get(g.brokerId) ?? null) : null,
      // P8.2：有系統預填建議答案（可批量接受）；confidence 已喺上面
      has_suggestion: !!ev.prefillCandidateId && (Array.isArray(q.optionsJson) ? (q.optionsJson as Array<{ id?: unknown }>) : []).some((o) => o.id === "mc_accept"),
      summary,
      // 只 id（唔含名／label）：triage_answer 卡嘅 option／candidate_id 一定要用呢度嘅 id
      options: (Array.isArray(q.optionsJson) ? (q.optionsJson as Array<{ id?: unknown }>) : []).map((o) => o.id).filter((x): x is string => typeof x === "string" && x !== "skip"),
      candidates: (ev.candidates ?? []).map((c) => c.id).filter((x): x is string => typeof x === "string").slice(0, 10),
    };
  });
  return {
    month: ym,
    sessions: sessions.length,
    total: rows.length,
    by_kind,
    by_confidence,
    by_status,
    questions: rows.slice(0, 80),
    questions_truncated: rows.length > 80,
  };
}

// ---------------------------------------------------------------------------
// 3. month_health（只出代號／嚴重度／數量／說明；明細只放行冇人名嘅「盤×更種×雞頭」類別）
// ---------------------------------------------------------------------------
const SITE_LEVEL_DETAIL_CODES = new Set(["unpriced_payout", "unpriced_client", "no_settlement", "ot_unpriced"]);
const SITE_DETAIL_KEYS = ["site_name", "shift_type_code", "broker_display", "category", "count"] as const;

/** 只放行「盤×更種×雞頭」層面明細（SITE_LEVEL_DETAIL_CODES，且只留 SITE_DETAIL_KEYS 欄）；其餘 finding 只回數量，
 * 完全冇保安員層面明細（等同 `redactMonthHealth()` 全部剝走）。 */
export async function readMonthHealth(month: Date, session: AuthedSession) {
  // 同 /api/reports/month-health 一致：睇明細要「更表:view」；冇就唔俾睇（工具層明細本身係「盤×更種×雞頭」，亦要呢個權）
  if (!(await hasPermission(session, "更表", "view"))) return { error: "permission_denied", message: "你冇權睇「更表」，月結體檢明細答唔到。" };
  const health = await buildMonthHealth(month, session);
  return {
    month: health.month,
    summary: health.summary,
    findings: health.findings.map((f) => ({
      code: f.code,
      severity: f.severity,
      count: f.count,
      message: f.message,
      fix_link: f.fixLink,
      detail:
        SITE_LEVEL_DETAIL_CODES.has(f.code) && f.detail
          ? f.detail.slice(0, 30).map((d) => Object.fromEntries(SITE_DETAIL_KEYS.filter((k) => k in d).map((k) => [k, d[k]])))
          : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// 4. ops_digest
// ---------------------------------------------------------------------------
export async function readOpsDigest(month: Date, session: AuthedSession) {
  return buildOpsDigest(month, session);
}

// ---------------------------------------------------------------------------
// 5. site_setup
// ---------------------------------------------------------------------------
async function findSitesByKeyword(keyword: string): Promise<Array<{ id: string; canonicalName: string }>> {
  const exact = await prisma.site.findFirst({ where: { canonicalName: { equals: keyword, mode: "insensitive" } }, select: { id: true, canonicalName: true } });
  if (exact) return [exact];
  return prisma.site.findMany({
    where: { OR: [{ canonicalName: { contains: keyword, mode: "insensitive" } }, { aliases: { has: keyword } }] },
    select: { id: true, canonicalName: true },
    take: 6,
    orderBy: { canonicalName: "asc" },
  });
}

export async function readSiteSetup(
  siteKeyword: string,
  month: Date,
  opts: { vis: AiFieldVisibility; canViewUploads: boolean },
) {
  const matches = await findSitesByKeyword(siteKeyword);
  if (matches.length === 0) return { error: "not_found", message: `搵唔到名稱包含「${siteKeyword}」嘅盤` };
  if (matches.length > 1) return { error: "ambiguous", message: "多過一個盤符合，請指明", candidates: matches.map((m) => ({ id: m.id, name: m.canonicalName })) };
  const siteId = matches[0]!.id;
  const { start, end } = monthRange(month);

  const [site, shiftTypes, cards, uploads] = await Promise.all([
    prisma.site.findUniqueOrThrow({
      where: { id: siteId },
      select: {
        id: true,
        canonicalName: true,
        status: true,
        billingModel: true,
        guardsPaidByClient: true,
        outsideMonthlyClose: true,
        defaultSettlementBroker: { select: { id: true, code: true, name: true, kind: true } },
      },
    }),
    prisma.shiftType.findMany({ where: { siteId, voidedAt: null }, select: { id: true, code: true, label: true, hours: true, headcountRequired: true, billingGroup: true }, orderBy: { code: "asc" } }),
    prisma.rateCard.findMany({
      where: { siteId, voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }] },
      select: { id: true, shiftTypeId: true, brokerId: true, guardId: true, clientRate: true, payoutRate: true, guardWage: true, effectiveFrom: true, effectiveTo: true, source: true, broker: { select: { code: true, name: true, kind: true } } },
    }),
    opts.canViewUploads
      ? prisma.rosterUpload.findMany({ where: { siteId, month, voidedAt: null }, select: { id: true, version: true, status: true, uploadedAt: true, parseSummary: true }, orderBy: { version: "desc" } })
      : Promise.resolve(null),
  ]);

  const stCodeById = new Map(shiftTypes.map((s) => [s.id, s.code]));
  const uploadIds = (uploads ?? []).filter((u) => u.status !== "superseded").map((u) => u.id);
  const matchGroups = uploadIds.length
    ? await prisma.rosterUploadRow.groupBy({
        by: ["guardMatch"],
        where: { uploadId: { in: uploadIds }, codeKind: { in: ["shift", "ot", "leave"] }, guardMatch: { in: ["unmatched", "ambiguous", "by_name"] } },
        _count: { _all: true },
      })
    : [];

  return {
    site: {
      id: site.id,
      name: site.canonicalName,
      status: site.status,
      billing_model: site.billingModel,
      guards_paid_by_client: site.guardsPaidByClient,
      outside_monthly_close: site.outsideMonthlyClose,
    },
    month: month.toISOString().slice(0, 7),
    shift_types: shiftTypes.map((s) => ({ id: s.id, code: s.code, label: s.label, hours: s.hours === null ? null : Number(s.hours), headcount_required: s.headcountRequired, billing_group: s.billingGroup })),
    default_settlement_broker: site.defaultSettlementBroker
      ? { id: site.defaultSettlementBroker.id, display: brokerDisplayName({ name: site.defaultSettlementBroker.name, code: site.defaultSettlementBroker.code, kind: site.defaultSettlementBroker.kind }) }
      : null,
    // 生效價卡：只講「有冇」客價／出街價；冇權限睇嗰類 → null（唔洩露有冇）
    effective_rate_cards: cards.map((c) => ({
      id: c.id,
      scope: c.guardId ? "guard" : c.shiftTypeId ? "shift_type" : "site_level",
      shift_type: c.shiftTypeId ? (stCodeById.get(c.shiftTypeId) ?? null) : null,
      broker_display: c.broker ? brokerDisplayName({ name: c.broker.name, code: c.broker.code, kind: c.broker.kind }) : "通用",
      is_auto_card: (c.source ?? "").startsWith("auto:one-click:"),
      effective_from: ymd(c.effectiveFrom),
      effective_to: ymd(c.effectiveTo),
      has_client_rate: opts.vis.clientRateVisible ? c.clientRate !== null : null,
      has_payout_rate: opts.vis.settlementVisible ? c.payoutRate !== null || c.guardWage !== null : null,
    })),
    uploads: uploads
      ? {
          count: uploads.length,
          items: uploads.map((u) => {
            const ps = (u.parseSummary ?? {}) as { shift_count?: unknown; unmatched_count?: unknown };
            return { id: u.id, version: u.version, status: u.status, uploaded_at: iso(u.uploadedAt), shift_count: typeof ps.shift_count === "number" ? ps.shift_count : null, unmatched_count: typeof ps.unmatched_count === "number" ? ps.unmatched_count : null };
          }),
        }
      : { withheld: true },
    unmatched_cells: uploads ? Object.fromEntries(matchGroups.map((g) => [g.guardMatch, g._count._all])) : null,
  };
}

// ---------------------------------------------------------------------------
// 6. pricing_explain
// ---------------------------------------------------------------------------
export async function readPricingExplain(
  params: { site: string; shiftType: string; broker?: string; month: Date },
  ctx: { session: AuthedSession; vis: AiFieldVisibility },
) {
  const matches = await findSitesByKeyword(params.site);
  if (matches.length === 0) return { error: "not_found", message: `搵唔到名稱包含「${params.site}」嘅盤` };
  if (matches.length > 1) return { error: "ambiguous", message: "多過一個盤符合，請指明", candidates: matches.map((m) => ({ id: m.id, name: m.canonicalName })) };
  const site = matches[0]!;
  const { start, end } = monthRange(params.month);
  const stRows = await prisma.shiftType.findMany({ where: { siteId: site.id, voidedAt: null, code: { equals: params.shiftType, mode: "insensitive" } }, select: { id: true, code: true } });
  if (stRows.length === 0) return { error: "shift_type_not_found", message: `盤「${site.canonicalName}」搵唔到更種「${params.shiftType}」` };
  const stIds = stRows.map((s) => s.id);

  const allBrokers = await prisma.broker.findMany({ select: { id: true, code: true, name: true, kind: true } });
  const dispOf = (b: { code: string; name: string; kind: string }) => brokerDisplayName({ name: b.name, code: b.code, kind: b.kind });
  const kw = params.broker?.trim().toLowerCase();
  const brokerFilter = kw ? allBrokers.filter((b) => b.code.toLowerCase() === kw || b.name.toLowerCase().includes(kw) || dispOf(b).toLowerCase().includes(kw)) : null;
  if (kw && brokerFilter && brokerFilter.length === 0) return { error: "broker_not_found", message: `搵唔到雞頭「${params.broker}」` };
  const brokerIdSet = brokerFilter ? new Set(brokerFilter.map((b) => b.id)) : null;
  const brokerById = new Map(allBrokers.map((b) => [b.id, b]));

  const [recordsByBroker, unpriced, cards, autoChanges, postorderUploads] = await Promise.all([
    prisma.shiftRecord.groupBy({
      by: ["settlementBrokerId"],
      where: { siteId: site.id, shiftTypeId: { in: stIds }, workDate: { gte: start, lte: end }, status: { not: "cancelled" }, recordType: { in: ["shift", "ot"] }, ...(brokerIdSet ? { settlementBrokerId: { in: [...brokerIdSet] } } : {}) },
      _count: { _all: true },
    }),
    buildUnpricedSummary(ctx.session, params.month),
    prisma.rateCard.findMany({
      where: { siteId: site.id, voidedAt: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }], AND: [{ OR: [{ shiftTypeId: { in: stIds } }, { shiftTypeId: null }] }] },
      select: { id: true, shiftTypeId: true, brokerId: true, guardId: true, clientRate: true, guardWage: true, brokerFee: true, payoutRate: true, billingModel: true, effectiveFrom: true, effectiveTo: true, source: true, note: true },
      orderBy: { effectiveFrom: "desc" },
    }),
    prisma.monthCloseAutoChange.findMany({
      where: { kind: { in: ["rate_card_created", "price_snapshots"] }, run: { month: params.month } },
      select: { kind: true, status: true, refId: true },
    }),
    prisma.postorderUpload.count({ where: { month: params.month, status: "parsed" } }),
  ]);

  const stCodeById = new Map(stRows.map((s) => [s.id, s.code]));
  const groups = unpriced.groups.filter((g) => g.site_id === site.id && stRows.some((s) => s.code.toLowerCase() === g.shift_type_code.toLowerCase()) && (!brokerFilter || brokerFilter.some((b) => b.code === g.broker_code)));
  const cardRows = cards
    .filter((c) => !brokerIdSet || c.brokerId === null || brokerIdSet.has(c.brokerId))
    .map((c) => {
      const b = c.brokerId ? brokerById.get(c.brokerId) : undefined;
      const step = stepOfAutoCardNote(c.note);
      const row: Record<string, unknown> = {
        id: c.id,
        scope: c.guardId ? "guard" : c.shiftTypeId ? "shift_type" : "site_level",
        shift_type: c.shiftTypeId ? (stCodeById.get(c.shiftTypeId) ?? null) : null,
        broker_display: b ? dispOf(b) : "通用",
        billing_model: c.billingModel,
        effective_from: ymd(c.effectiveFrom),
        effective_to: ymd(c.effectiveTo),
        is_auto_card: (c.source ?? "").startsWith("auto:one-click:"),
        auto_pricing_step: step,
        priced_from_postorder: step === 2,
        client_rate: c.clientRate === null ? null : Number(c.clientRate),
        guard_wage: c.guardWage === null ? null : Number(c.guardWage),
        broker_fee: c.brokerFee === null ? null : Number(c.brokerFee),
        payout_rate: c.payoutRate === null ? null : Number(c.payoutRate),
      };
      return row;
    });

  const totalShifts = recordsByBroker.reduce((a, g) => a + g._count._all, 0);
  // 同一條更次可以同時 payout_unpriced＋client_unpriced（分類唔互斥），所以唔加總：逐分類報，另報「最多嗰個分類」做下限
  const unpricedByCategory: Record<string, number> = {};
  for (const g of groups) unpricedByCategory[g.category] = (unpricedByCategory[g.category] ?? 0) + g.count;
  const unpricedTotal = Math.max(0, ...Object.values(unpricedByCategory));
  const reasons: string[] = [];
  const scopedCards = cardRows.filter((c) => c.scope !== "guard");
  if (totalShifts === 0) reasons.push("呢個月呢個盤＋更種（＋雞頭）冇更次記錄，所以無嘢可定價");
  if (unpricedTotal > 0 && scopedCards.length === 0) reasons.push("冇任何生效價目卡覆蓋呢個盤＋更種，所以未定價——要建價目卡（或者由 Postorder／分診補齊）");
  if (unpricedTotal > 0 && scopedCards.length > 0) reasons.push("有生效價目卡但仍有未定價更次：可能係價卡建好之後未重新計價，或者價卡只屬於另一個雞頭／欠出街價或客價");
  if (unpricedTotal === 0 && totalShifts > 0) reasons.push("呢組更次已經全部定價");
  if (cardRows.some((c) => c.is_auto_card)) reasons.push("其中有一鍵結算自動建嘅價卡（未經人確認）");

  return {
    site: { id: site.id, name: site.canonicalName },
    shift_type: stRows.map((s) => s.code),
    broker_filter: brokerFilter ? brokerFilter.map((b) => dispOf(b)) : null,
    month: params.month.toISOString().slice(0, 7),
    shifts_total: totalShifts,
    shifts_by_broker: recordsByBroker.map((g) => ({ broker_display: g.settlementBrokerId ? (brokerById.get(g.settlementBrokerId) ? dispOf(brokerById.get(g.settlementBrokerId)!) : null) : "（冇結算雞頭）", shifts: g._count._all })),
    unpriced_groups: groups.map((g) => ({ shift_type: g.shift_type_code, broker_display: g.broker_display, category: g.category, count: g.count })),
    unpriced_by_category: unpricedByCategory,
    unpriced_records_at_least: unpricedTotal,
    rate_cards: cardRows,
    one_click_auto: { rate_cards_created: autoChanges.filter((a) => a.kind === "rate_card_created").length, price_snapshot_runs: autoChanges.filter((a) => a.kind === "price_snapshots").length },
    postorder: { parsed_uploads_for_month: postorderUploads, any_card_priced_from_postorder: cardRows.some((c) => c.priced_from_postorder === true) },
    why: reasons,
  };
}
