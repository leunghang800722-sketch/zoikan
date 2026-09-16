// WP-PRICE（老闆 2026-09-16 拍板）：`POST /api/shift-records/reprice`——
// 重新計价（例如價目卡補咗／改咗之後，令舊有 snapshot 追返卡）。權限
// 「出街價:update」（老闆出廠有，主管/會計可以由老闆開；雞頭/安員硬性
// deny，見 rbac/matrix.ts，呢度唔改矩陣，淨係用返現有 module）。
//
// 月份已鎖定 → 409（唔用共用嘅 `Locked()`——嗰個係 403，呢個 endpoint
// 規劃裁定明文要 409，因為「重新計价」語意上係「同呢個月已經鎖定嘅狀態
// 有衝突」，唔係純粹權限拒絕）。
//
// 全部非 cancelled 嘅 `shift` 記錄一律覆蓋重算（唔只 null——價目卡改咗
// 要生效，見 src/lib/pricing/resolve-rate.ts），一個 transaction；audit
// 一行（`reprice_month`，after 存 counts，唔存逐條 before/after）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isMonthLocked, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { ShiftRecordRepriceSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { writeAudit } from "@/lib/audit";
import { Conflict } from "@/lib/api/errors";
import { monthRange } from "@/lib/reports/money";
import { fetchEffectiveRateCards, resolveShiftPricingFromCards, type BrokerKindLike } from "@/lib/pricing/resolve-rate";

type RepriceGroup = { site_id: string; site_name: string; shift_type_code: string; broker_code: string | null; broker_display: string; count: number };

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "update");
    const rawBody = await readJson(req);
    const parsed = parseBody(ShiftRecordRepriceSchema, rawBody);

    const month = monthStart(new Date(`${parsed.month}-01`));
    const { start, end } = monthRange(month);

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
    });

    if (records.length === 0) {
      return ok(brandSafeResponse({ repriced: 0, unpriced: 0, groups: [] as RepriceGroup[] }));
    }

    const brokerIds = [...new Set(records.map((r) => r.settlementBrokerId).filter((v): v is string => v !== null))];
    const [brokers, sites, shiftTypes] = await Promise.all([
      brokerIds.length ? prisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, kind: true, code: true } }) : Promise.resolve([]),
      prisma.site.findMany({ where: { id: { in: [...new Set(records.map((r) => r.siteId))] } }, select: { id: true, canonicalName: true } }),
      prisma.shiftType.findMany({ where: { id: { in: [...new Set(records.map((r) => r.shiftTypeId))] } }, select: { id: true, code: true } }),
    ]);
    const brokerById = new Map(brokers.map((b) => [b.id, b]));
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s]));

    // 一次過攞晒每個盤喺呢個月範圍嘅有效卡（唔逐條記錄打一次 DB）。
    const cardsBySite = new Map<string, Awaited<ReturnType<typeof fetchEffectiveRateCards>>>();
    for (const siteId of new Set(records.map((r) => r.siteId))) {
      cardsBySite.set(siteId, await fetchEffectiveRateCards(siteId, start, end));
    }

    type Update = { id: string; clientRate: number | null; guardWage: number | null; brokerFee: number | null };
    const updates: Update[] = [];
    const groupsMap = new Map<string, RepriceGroup>();
    let unpricedCount = 0;

    for (const r of records) {
      const brokerRow = r.settlementBrokerId ? brokerById.get(r.settlementBrokerId) : undefined;
      const brokerKind: BrokerKindLike = (brokerRow?.kind as BrokerKindLike) ?? null;
      const pricing = resolveShiftPricingFromCards(cardsBySite.get(r.siteId) ?? [], {
        siteId: r.siteId,
        shiftTypeId: r.shiftTypeId,
        settlementBrokerId: r.settlementBrokerId,
        brokerKind,
        guardId: r.guardId,
        workDate: r.workDate,
        isExternal: r.isExternal,
        recordType: "shift",
      });
      updates.push({ id: r.id, clientRate: pricing.clientRate, guardWage: pricing.guardWage, brokerFee: pricing.brokerFee });
      if (pricing.unpriced) {
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

    await prisma.$transaction(
      updates.map((u) =>
        prisma.shiftRecord.update({
          where: { id: u.id },
          data: { clientRateSnapshot: u.clientRate, guardWageSnapshot: u.guardWage, brokerFeeSnapshot: u.brokerFee },
        }),
      ),
    );

    const groups = [...groupsMap.values()].sort((a, b) => a.site_name.localeCompare(b.site_name) || a.shift_type_code.localeCompare(b.shift_type_code));

    await writeAudit({
      actorUserId: session.userId,
      tableName: "shift_records",
      rowId: `reprice:${parsed.month}${parsed.site_id ? `:${parsed.site_id}` : ""}`,
      action: "reprice_month",
      after: { month: parsed.month, site_id: parsed.site_id ?? null, repriced: updates.length, unpriced: unpricedCount },
      ip: getClientIp(req),
    });

    return ok(brandSafeResponse({ repriced: updates.length, unpriced: unpricedCount, groups }));
  });
}
