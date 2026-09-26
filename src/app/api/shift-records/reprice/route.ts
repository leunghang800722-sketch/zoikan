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
import { scopeShiftRecordWhere } from "@/lib/broker-isolation";
import { isMonthLocked, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { ShiftRecordRepriceSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { writeAudit } from "@/lib/audit";
import { Conflict, NotFound } from "@/lib/api/errors";
import { monthRange } from "@/lib/reports/money";
import { fetchEffectiveRateCards, type BrokerKindLike } from "@/lib/pricing/resolve-rate";
import { decideReprice } from "@/lib/pricing/reprice";
// 必修 2（Opus 第二輪驗收）：「未定价」口徑（response 嘅 `unpriced`／
// `groups`）一律用同 `buildUnpricedSummary()`（GET /api/shift-records/
// unpriced、頁首 banner 嗰個 API）共用嘅核心邏輯——`computeUnpricedSummary()`
// 係抽出嚟嘅純函數，dry-run 用「模擬寫入之後」嘅 in-memory 記錄餵佢，
// commit 之後直接再打一次 `buildUnpricedSummary()` 攞返寫入咗之後嘅
// 真實 DB 狀態，兩條路徑口徑保證同 GET /api/shift-records/unpriced 一致，
// 唔會各自另計一套數。
import { isMixedBillingMonth, loadMixedBillingInfo } from "@/lib/reports/mixed-billing";
import { computeUnpricedSummary, buildUnpricedSummary, type UnpricedRecordLike, type UnpricedLookups, type UnpricedGroup } from "@/lib/pricing/unpriced";

const BATCH_SIZE = 500;
// 應修（Opus 第二輪驗收）：audit `changed_records` 上限 1,000 條，超過就
// 存前 1,000 條＋`truncated:true`＋總數（避免一個月幾千條改動令
// audit_log 一行 JSON 過大）。
const AUDIT_CHANGED_RECORDS_LIMIT = 1000;

type RepriceGroup = UnpricedGroup;
// 必修（本輪 vitest 全跑發現）：`preview`／audit `changed_records` 兩個
// 對外可見嘅 before/after 用 snake_case＋同 shift_records 資源嘅
// field-group 白名單同名（`client_rate_snapshot`／`guard_wage_snapshot`／
// `broker_fee_snapshot`，見 src/lib/api/field-groups.ts
// CLIENT_RATE_FIELDS／SETTLEMENT_FIELDS）——先可以畀 GET /api/audit-log
// 嘅 `gateAuditBlob()`（src/app/api/audit-log/route.ts）遞歸落
// `changed_records[]` 逐條 `applyFieldGroupGate()` 一次，冇「收客價:view」
// ／「出街價:view」嘅讀者先至真係睇唔到（之前用 camelCase
// `clientRate`／`guardWage`／`brokerFee`，audit-log 嘅 field-group gate
// 淨係識做頂層 key，完全冇拆到呢個 nested array，令冇權限嘅主管一樣經
// GET /api/audit-log 見到 reprice 改過嘅收客/出街价——wp2-n1-audit-log-
// gate.test.ts 全 suite 一齊跑就會發現）。
type AuditSnapshot = { client_rate_snapshot: number | null; guard_wage_snapshot: number | null; broker_fee_snapshot: number | null };
type PreviewRow = { id: string; site_name: string; shift_type_code: string; work_date: string; before: AuditSnapshot; after: AuditSnapshot };

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

    // Opus 第三輪 S1：dry-run 同 commit 後嘅 buildUnpricedSummary() 一樣行
    // scopeShiftRecordWhere()（現時只有老闆有 出街價:update，唔受隔離；
    // 但自訂內部角色一旦獲授權，兩個數要一致）。
    const records = await prisma.shiftRecord.findMany({
      where: scopeShiftRecordWhere(session, {
        recordType: "shift",
        status: { not: "cancelled" },
        workDate: { gte: start, lte: end },
        ...(parsed.site_id ? { siteId: parsed.site_id } : {}),
      }),
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
      // WP-MISC（老闆 2026-09-20 拍板）：加 `guardsPaidByClient`——LINK
      // 呢類盤 reprice 全部保留現值（唔掂），見下面 loop。
      prisma.site.findMany({ where: { id: { in: siteIdList } }, select: { id: true, canonicalName: true, billingModel: true, guardsPaidByClient: true } }),
      // 應修：加 billingGroup——收客价 resolver／未定价判斷而家用
      // shift_type.billing_group（唔再用 site.billing_model）。
      prisma.shiftType.findMany({ where: { id: { in: shiftTypeIdList } }, select: { id: true, code: true, billingGroup: true } }),
    ]);
    const siteById = new Map(sites.map((s) => [s.id, s]));
    const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s]));
    // WP-MISC：LINK（TKO Gateway 厚A/B/C）呢類盤——`guardsPaidByClient`。
    const guardsPaidByClientById = new Map(sites.map((s) => [s.id, s.guardsPaidByClient]));
    const unpricedLookups: UnpricedLookups = {
      brokerKindById: new Map(brokers.map((b) => [b.id, b.kind as BrokerKindLike])),
      brokerCodeById: new Map(brokers.map((b) => [b.id, b.code])),
      siteNameById: new Map(sites.map((s) => [s.id, s.canonicalName])),
      siteBillingModelById: new Map(sites.map((s) => [s.id, (s.billingModel as string | null) ?? null])),
      shiftTypeCodeById: new Map(shiftTypes.map((s) => [s.id, s.code])),
      shiftTypeBillingGroupById: new Map(shiftTypes.map((s) => [s.id, s.billingGroup])),
      siteGuardsPaidByClientById: guardsPaidByClientById,
      // WP-MIXED-BILLING（Opus 5.5 驗收）：同 buildUnpricedSummary() 一致——8 月起月費盤「逐更另收」判斷。
      mixedBillingInfoBySiteId: isMixedBillingMonth(start) ? await loadMixedBillingInfo(siteIdList, start, end) : undefined,
    };

    // S6：一次過（Promise.all，唔逐個 site 排隊 await）攞晒每個盤喺呢個
    // 月範圍嘅有效卡。
    const cardsEntries = await Promise.all(siteIdList.map(async (siteId) => [siteId, await fetchEffectiveRateCards(siteId, start, end)] as const));
    const cardsBySite = new Map(cardsEntries);

    type Update = { id: string; clientRate: number | null; guardWage: number | null; brokerFee: number | null };
    const updates: Update[] = [];
    const previewRows: PreviewRow[] = [];
    let changedCount = 0;
    let unchangedCount = 0;
    let keptUnresolvedCount = 0;

    // 驗收修正：單條記錄嘅「幾時覆蓋、幾時保留」規則抽咗去
    // `src/lib/pricing/reprice.ts` `decideReprice()`（`mode:"full"`）——
    // 同 `runReconcileAllForMonth()` 開頭自動 reprice（`mode:
    // "fill_and_fix_b07"`）共用同一個純函數，避免兩處各自維護令規則
    // 拗開。呢度嘅 `unpricedLookups` 結構同 `RepriceLookups` 一致
    // （`brokerKindById`／`shiftTypeCodeById`／`shiftTypeBillingGroupById`／
    // `siteGuardsPaidByClientById`），直接傳落去。
    for (const r of records) {
      const decision = decideReprice(r, unpricedLookups, cardsBySite.get(r.siteId) ?? [], "full");
      if (decision.keptUnresolved) keptUnresolvedCount++;

      updates.push({ id: r.id, clientRate: decision.after.clientRate, guardWage: decision.after.guardWage, brokerFee: decision.after.brokerFee });

      if (!decision.changed) {
        unchangedCount++;
      } else {
        changedCount++;
        if (previewRows.length < 50) {
          previewRows.push({
            id: r.id,
            site_name: siteById.get(r.siteId)?.canonicalName ?? r.siteId.slice(0, 8),
            shift_type_code: shiftTypeById.get(r.shiftTypeId)?.code ?? r.shiftTypeId.slice(0, 8),
            work_date: r.workDate.toISOString().slice(0, 10),
            before: { client_rate_snapshot: decision.before.clientRate, guard_wage_snapshot: decision.before.guardWage, broker_fee_snapshot: decision.before.brokerFee },
            after: { client_rate_snapshot: decision.after.clientRate, guard_wage_snapshot: decision.after.guardWage, broker_fee_snapshot: decision.after.brokerFee },
          });
        }
      }
    }

    // 必修 2：「未定价」統計（`unpriced`／`groups`）唔再喺上面嗰個 loop
    // 各自另計一套（`clientNotFound && payoutNotFound`）——而家用「模擬
    // 寫入之後」嘅記錄，餵返 `computeUnpricedSummary()`（同 `buildUnpriced
    // Summary()` 共用嘅核心邏輯），保證同 GET /api/shift-records/unpriced
    // 顯示嘅口徑一致（例如 external/longterm 唔會被計做未定价）。
    const simulatedRecords: UnpricedRecordLike[] = records.map((r, i) => {
      const u = updates[i]!;
      return {
        siteId: r.siteId,
        shiftTypeId: r.shiftTypeId,
        settlementBrokerId: r.settlementBrokerId,
        status: "confirmed",
        guardWageSnapshot: u.guardWage,
        brokerFeeSnapshot: u.brokerFee,
        clientRateSnapshot: u.clientRate,
        isExternal: r.isExternal,
      };
    });
    // WP-MIXED-BILLING：帶 `month` 落去，等 isClientUnpricedShift() 嘅
    // 「盤層面豁免」判斷同 GET /api/shift-records/unpriced 一致（只對
    // 2026-08 之前嘅月份生效）。
    const simulatedSummary = computeUnpricedSummary(simulatedRecords, unpricedLookups, { month });
    const groups: RepriceGroup[] = simulatedSummary.groups;

    if (dryRun) {
      // M3：dry-run 淨係回 diff 摘要，乜都唔寫；`unpriced`／`groups` 用
      // 上面模擬寫入之後嘅 `computeUnpricedSummary()` 結果（同 GET
      // /api/shift-records/unpriced 同一套口徑）。
      return ok(
        brandSafeResponse({
          dry_run: true,
          month: parsed.month,
          site_id: parsed.site_id ?? null,
          repriced: 0,
          changed: changedCount,
          unchanged: unchangedCount,
          kept_unresolved: keptUnresolvedCount,
          unpriced: simulatedSummary.count,
          unpriced_payout: simulatedSummary.payoutCount,
          unpriced_client: simulatedSummary.clientCount,
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
    // 用 id＋盤／更別／日期，唔存真名（PDPO）。應修：上限
    // AUDIT_CHANGED_RECORDS_LIMIT（1,000）條，超過就淨係存前 1,000＋
    // `truncated:true`＋總數（唔想一個月幾千條改動令 audit_log 一行
    // JSON 過大）。
    const changedIdSet = new Set(changedUpdates.map((u) => u.id));
    const auditChangedRowsAll = records
      .filter((r) => changedIdSet.has(r.id))
      .map((r) => {
        const u = updates.find((x) => x.id === r.id)!;
        return {
          id: r.id,
          before: { client_rate_snapshot: numOrNull(r.clientRateSnapshot), guard_wage_snapshot: numOrNull(r.guardWageSnapshot), broker_fee_snapshot: numOrNull(r.brokerFeeSnapshot) },
          after: { client_rate_snapshot: u.clientRate, guard_wage_snapshot: u.guardWage, broker_fee_snapshot: u.brokerFee },
        };
      });
    const auditTruncated = auditChangedRowsAll.length > AUDIT_CHANGED_RECORDS_LIMIT;
    const auditChangedRows = auditTruncated ? auditChangedRowsAll.slice(0, AUDIT_CHANGED_RECORDS_LIMIT) : auditChangedRowsAll;

    // 必修 2：commit 之後直接打一次真正嘅 `buildUnpricedSummary()`（讀返
    // 寫入咗之後嘅 DB 狀態）——response 嘅 `unpriced`／`groups` 用呢個
    // 權威結果，唔用上面 dry-run 嗰個「模擬」數（DB 已經寫咗，唔使再靠
    // 模擬）。
    const postCommitUnpriced = await buildUnpricedSummary(session, month, parsed.site_id ?? null);

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
        unpriced: postCommitUnpriced.count,
        changed_records: auditChangedRows,
        changed_records_total: auditChangedRowsAll.length,
        truncated: auditTruncated,
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
        unpriced: postCommitUnpriced.count,
        unpriced_payout: postCommitUnpriced.payoutCount,
        unpriced_client: postCommitUnpriced.clientCount,
        groups: postCommitUnpriced.groups,
        preview: previewRows,
      }),
    );
  });
}
