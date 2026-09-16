// WP-PRICE（老闆 2026-09-16 拍板）：`POST /api/shift-records/reprice`——
// 重新計价（例如價目卡補咗／改咗之後，令舊有 snapshot 追返卡）。權限
// 「出街價:update」（老闆出廠有，主管/會計可以由老闆開；雞頭/安員硬性
// deny，見 rbac/matrix.ts，呢度唔改矩陣，淨係用返現有 module）。
//
// 月份已鎖定 → 409（唔用共用嘅 `Locked()`——嗰個係 403，呢個 endpoint
// 規劃裁定明文要 409，因為「重新計价」語意上係「同呢個月已經鎖定嘅狀態
// 有衝突」，唔係純粹權限拒絕）。
//
// M3（Opus 驗收「reprice 清空數據」修正，2026-09-16）：
//   1. resolver 搵唔到某個欄位（收客价冇 clientCard／出街价冇
//      payoutCard）就**保留原值**，唔准靜靜清做 null（之前嘅版本一律
//      覆蓋，令一張卡臨時冇咗都會將舊有正確 snapshot 洗走）——計入
//      `kept_unresolved`。
//   2. `dry_run`（預設 true）：唔寫 DB，淨係回 diff 摘要（changed／
//      unchanged／kept_unresolved 數 + 前 50 條 before→after，用 id＋
//      盤／更別／日期，唔用真名）——前端「重新計价」掣要先 dry-run
//      俾用戶睇過先撳確認，先真係 `dry_run:false` 寫入。
//   3. audit 一行（`reprice_month`），`after` 除咗 counts 之外，仲要含
//      *全部* changed 記錄嘅 `{id, before, after}`（可逆，等日後要 revert
//      有得查）。
// S6：分批 500 條一個 transaction（避免一個 transaction 揸住成個月幾千
// 條）；`findMany` 用 `select`（唔攞成行）；盤級卡查詢用 `Promise.all`。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isMonthLocked, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { ShiftRecordRepriceSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { writeAudit } from "@/lib/audit";
import { Conflict, NotFound } from "@/lib/api/errors";
import { monthRange } from "@/lib/reports/money";
import { fetchEffectiveRateCards, resolveShiftPricingFromCards, type BrokerKindLike } from "@/lib/pricing/resolve-rate";

const BATCH_SIZE = 500;

type RepriceGroup = { site_id: string; site_name: string; shift_type_code: string; broker_code: string | null; broker_display: string; count: number };
type Snapshot = { clientRate: number | null; guardWage: number | null; brokerFee: number | null };
type PreviewRow = { id: string; site_name: string; shift_type_code: string; work_date: string; before: Snapshot; after: Snapshot };

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  return Number((v as { toString(): string }).toString());
}
function sameValue(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.005;
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "update");
    const rawBody = await readJson(req);
    const parsed = parseBody(ShiftRecordRepriceSchema, rawBody);
    const dryRun = parsed.dry_run ?? true; // M3：預設 dry-run，一定要明確 dry_run:false 先真係寫

    const month = monthStart(new Date(`${parsed.month}-01`));
    const { start, end } = monthRange(month);

    if (parsed.site_id) {
      // S5：site_id 帶咗但唔存在 → 404（之前會靜靜當「呢個盤冇記錄」回
      // repriced:0，用戶會以為「冇嘢好計」，其實係打錯 id）。
      const site = await prisma.site.findUnique({ where: { id: parsed.site_id }, select: { id: true } });
      if (!site) throw NotFound(`site_id ${parsed.site_id} 唔存在`);
    }

    if (await isMonthLocked(month)) {
      throw Conflict(`${parsed.month} 已鎖定，唔可以重新計价`);
    }

    const records = await prisma.shiftRecord.findMany({
      where: {
        recordType: "shift",
        status: { not: "cancelled" },
        workDate: { gte: start, lte: end },
        ...(parsed.site_id ? { siteId: parsed.site_id } : {}),
      },
      select: {
        id: true,
        siteId: true,
        shiftTypeId: true,
        guardId: true,
        settlementBrokerId: true,
        workDate: true,
        isExternal: true,
        clientRateSnapshot: true,
        guardWageSnapshot: true,
        brokerFeeSnapshot: true,
      },
    });

    if (records.length === 0) {
      return ok(
        brandSafeResponse({
          dry_run: dryRun,
          month: parsed.month,
          site_id: parsed.site_id ?? null,
          repriced: 0,
          changed: 0,
          unchanged: 0,
          kept_unresolved: 0,
          unpriced: 0,
          groups: [] as RepriceGroup[],
          preview: [] as PreviewRow[],
        }),
      );
    }

    const brokerIds = [...new Set(records.map((r) => r.settlementBrokerId).filter((v): v is string => v !== null))];
    const siteIdList = [...new Set(records.map((r) => r.siteId))];
    const shiftTypeIdList = [...new Set(records.map((r) => r.shiftTypeId))];
    const [brokers, sites, shiftTypes] = await Promise.all([
      brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, kind: true, code: true } }) : Promise.resolve([]),
      prisma.site.findMany({ where: { id: { in: siteIdList } }, select: { id: true, canonicalName: true } }),
      prisma.shiftType.findMany({ where: { id: { in: shiftTypeIdList } }, select: { id: true, code: true } }),
    ]);
    const brokerById = new Map(brokers.map((b) => [b.id, b]));
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s]));

    // S6：一次過（Promise.all，唔逐個 site 排隊 await）攞晒每個盤喺呢個
    // 月範圍嘅有效卡。
    const cardsEntries = await Promise.all(siteIdList.map(async (siteId) => [siteId, await fetchEffectiveRateCards(siteId, start, end)] as const));
    const cardsBySite = new Map(cardsEntries);

    type Update = { id: string; clientRate: number | null; guardWage: number | null; brokerFee: number | null };
    const updates: Update[] = [];
    const groupsMap = new Map<string, RepriceGroup>();
    const previewRows: PreviewRow[] = [];
    let unpricedCount = 0;
    let changedCount = 0;
    let unchangedCount = 0;
    let keptUnresolvedCount = 0;

    for (const r of records) {
      const brokerRow = r.settlementBrokerId ? brokerById.get(r.settlementBrokerId) : undefined;
      const brokerKind: BrokerKindLike = (brokerRow?.kind as BrokerKindLike) ?? null;
      const pricing = resolveShiftPricingFromCards(cardsBySite.get(r.siteId) ?? [], {
        siteId: r.siteId,
        shiftTypeId: r.shiftTypeId,
        shiftTypeCode: shiftTypeById.get(r.shiftTypeId)?.code ?? "",
        settlementBrokerId: r.settlementBrokerId,
        brokerKind,
        guardId: r.guardId,
        workDate: r.workDate,
        isExternal: r.isExternal,
        recordType: "shift",
      });

      const beforeClient = numOrNull(r.clientRateSnapshot);
      const beforeWage = numOrNull(r.guardWageSnapshot);
      const beforeFee = numOrNull(r.brokerFeeSnapshot);

      // M3：resolver 搵唔到收客价（冇 clientCard）就保留原值，唔清做
      // null；出街价（wage/fee 一齊嚟自同一張 payoutCard）同理——
      // `pricing.unpriced===true` 先代表「真係搵唔到」（external／
      // longterm 兩種「正常冇出街价」嘅情況 unpriced 一律 false，唔會
      // 喺呢度被當「keep」）。
      const clientNotFound = pricing.clientRate === null;
      const payoutNotFound = pricing.unpriced === true;
      const afterClient = clientNotFound ? beforeClient : pricing.clientRate;
      const afterWage = payoutNotFound ? beforeWage : pricing.guardWage;
      const afterFee = payoutNotFound ? beforeFee : pricing.brokerFee;

      const keptClientMeaningful = clientNotFound && beforeClient !== null;
      const keptPayoutMeaningful = payoutNotFound && (beforeWage !== null || beforeFee !== null);
      if (keptClientMeaningful || keptPayoutMeaningful) keptUnresolvedCount++;

      updates.push({ id: r.id, clientRate: afterClient, guardWage: afterWage, brokerFee: afterFee });

      const unchanged = sameValue(beforeClient, afterClient) && sameValue(beforeWage, afterWage) && sameValue(beforeFee, afterFee);
      if (unchanged) {
        unchangedCount++;
      } else {
        changedCount++;
        if (previewRows.length < 50) {
          previewRows.push({
            id: r.id,
            site_name: siteById.get(r.siteId)?.canonicalName ?? r.siteId.slice(0, 8),
            shift_type_code: shiftTypeById.get(r.shiftTypeId)?.code ?? r.shiftTypeId.slice(0, 8),
            work_date: r.workDate.toISOString().slice(0, 10),
            before: { clientRate: beforeClient, guardWage: beforeWage, brokerFee: beforeFee },
            after: { clientRate: afterClient, guardWage: afterWage, brokerFee: afterFee },
          });
        }
      }

      // 「未定价」統計——收客价／出街价都搵唔到（同 dry-run/commit 都要
      // 一致，等用戶睇到嘅預覽數同真係寫入之後嘅數一致）。
      if (clientNotFound && payoutNotFound) {
        unpricedCount++;
        const key = `${r.siteId}|${r.shiftTypeId}|${r.settlementBrokerId ?? "none"}`;
        const existing = groupsMap.get(key);
        if (existing) {
          existing.count++;
        } else {
          groupsMap.set(key, {
            site_id: r.siteId,
            site_name: siteById.get(r.siteId)?.canonicalName ?? r.siteId.slice(0, 8),
            shift_type_code: shiftTypeById.get(r.shiftTypeId)?.code ?? r.shiftTypeId.slice(0, 8),
            broker_code: brokerRow?.code ?? null,
            broker_display: brokerRow?.code ?? "冇雞頭",
            count: 1,
          });
        }
      }
    }

    const groups = [...groupsMap.values()].sort((a, b) => a.site_name.localeCompare(b.site_name) || a.shift_type_code.localeCompare(b.shift_type_code));

    if (dryRun) {
      // M3：dry-run 淨係回 diff 摘要，乜都唔寫。
      return ok(
        brandSafeResponse({
          dry_run: true,
          month: parsed.month,
          site_id: parsed.site_id ?? null,
          repriced: 0,
          changed: changedCount,
          unchanged: unchangedCount,
          kept_unresolved: keptUnresolvedCount,
          unpriced: unpricedCount,
          groups,
          preview: previewRows,
        }),
      );
    }

    // ---- 真係寫入：淨係更新真係「changed」嘅記錄，分批 500 條一個
    // transaction（S6，避免一個 transaction 揸住成個月幾千條）--------
    const changedUpdates = updates.filter((u, i) => {
      const r = records[i]!;
      return !(sameValue(numOrNull(r.clientRateSnapshot), u.clientRate) && sameValue(numOrNull(r.guardWageSnapshot), u.guardWage) && sameValue(numOrNull(r.brokerFeeSnapshot), u.brokerFee));
    });
    for (let i = 0; i < changedUpdates.length; i += BATCH_SIZE) {
      const batch = changedUpdates.slice(i, i + BATCH_SIZE);
      await prisma.$transaction(
        batch.map((u) =>
          prisma.shiftRecord.update({
            where: { id: u.id },
            data: { clientRateSnapshot: u.clientRate, guardWageSnapshot: u.guardWage, brokerFeeSnapshot: u.brokerFee },
          }),
        ),
      );
    }

    // audit：after 含全部 changed 記錄嘅 {id, before, after}（可逆）——
    // 用 id＋盤／更別／日期，唔存真名（PDPO）。
    const changedIdSet = new Set(changedUpdates.map((u) => u.id));
    const auditChangedRows = records
      .filter((r) => changedIdSet.has(r.id))
      .map((r) => {
        const u = updates.find((x) => x.id === r.id)!;
        return {
          id: r.id,
          before: { clientRate: numOrNull(r.clientRateSnapshot), guardWage: numOrNull(r.guardWageSnapshot), brokerFee: numOrNull(r.brokerFeeSnapshot) },
          after: { clientRate: u.clientRate, guardWage: u.guardWage, brokerFee: u.brokerFee },
        };
      });
    await writeAudit({
      actorUserId: session.userId,
      tableName: "shift_records",
      rowId: `reprice:${parsed.month}${parsed.site_id ? `:${parsed.site_id}` : ""}`,
      action: "reprice_month",
      after: {
        month: parsed.month,
        site_id: parsed.site_id ?? null,
        repriced: changedUpdates.length,
        changed: changedCount,
        unchanged: unchangedCount,
        kept_unresolved: keptUnresolvedCount,
        unpriced: unpricedCount,
        changed_records: auditChangedRows,
      },
      ip: getClientIp(req),
    });

    return ok(
      brandSafeResponse({
        dry_run: false,
        month: parsed.month,
        site_id: parsed.site_id ?? null,
        repriced: changedUpdates.length,
        changed: changedCount,
        unchanged: unchangedCount,
        kept_unresolved: keptUnresolvedCount,
        unpriced: unpricedCount,
        groups,
        preview: previewRows,
      }),
    );
  });
}
