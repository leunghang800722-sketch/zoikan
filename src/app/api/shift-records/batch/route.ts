// P1-WP3：更表編輯器「批量儲存」——同一 site × month 內多格一次寫入
// （設計文件§4.1/§4.2、P1-執行計劃.md §4 WP3）。逐格同樣過閘，任何一格
// 驗證失敗（403/400）令**成批 rollback**（唔會部分寫入）：做法係先逐格
// validate 晒（唔掂 DB 寫入），一有錯即刻 throw（乜都未寫），驗證全過
// 先開一個 `prisma.$transaction()` 逐格寫入（DB 層面嘅 unique 衝突都會
// 令成個 transaction rollback，回 409）。
//
// 每格代表一個「行」（guard_id + shift_type_id，即更別／時段）× 一日
// （work_date）：
//   code = null/""  → 清格。已存在嘅記錄先有嘢做——status=cancelled
//                      （硬性規則「只有作廢冇刪除」，唔做真刪除）。
//                      雞頭淨係可以清自己**未 confirm**（draft/
//                      pending_approval）嘅格；已經 confirmed 嘅要主管
//                      用 /api/shift-records/:id/void（附原因）。
//   code = 更別本身代號（cell.shift_type_id 嗰個 shift_type.code）
//                    → record_type=shift（出勤）。
//   code = LeaveCode（AL/NL/RD/SL/SH）→ record_type=leave。
//   其他 code            → 400（同呢行嘅更別／請假代號都對唔上）。
//
// 已存在記錄嘅狀態轉移（設計文件§4.2「雞頭改自己已confirmed嘅更→重入
// 審批」）：
//   - 雞頭改自己 status=confirmed 嘅格 → 新狀態一律 pending_approval
//     （唔理 brokers.requires_approval，改咗就要再批）。
//   - 雞頭改自己 status=draft/pending_approval 嘅格 → 維持
//     pending_approval/draft 邏輯：新建時用 requires_approval 決定，
//     修改未批嘅內容唔使再轉一次（本身都仲未批）。
//   - 內部角色（老闆/主管，有「更表:update」）直接改，status 一律
//     confirmed，唔使入審批隊列（設計文件§4.2「主管或有權者直接改」）。
import { prisma } from "@/lib/db";
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import {
  isBrokerRole,
  requireOwnBrokerId,
  assertGuardOwnedByBroker,
  assertSiteAssignedToBroker,
  assertSettlementBrokerIdsValid,
} from "@/lib/broker-isolation";
import { assertMonthNotLocked, assertMonthNotLockedTx, monthStart } from "@/lib/month-lock";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { ShiftRecordBatchSchema } from "@/lib/api/schemas";
import { brandSafeResponse } from "@/lib/api/serialize";
import { BadRequest, Forbidden, Conflict } from "@/lib/api/errors";
import { type ShiftRecordStatus } from "@prisma/client";
// WP-PRICE（老闆 2026-09-16 拍板）：儲存時自動計價——見
// src/lib/pricing/resolve-rate.ts 頂註解。W2：plan 型別／計價／tx 寫入／警示已抽到共用 write service
// （src/lib/shift-records/write.ts），WhatsApp 入口共用同一套；行為 byte-for-byte 不變。
import { journalAutoCardUsesSafe, type AutoCardUse } from "@/lib/pricing/auto-card-journal";
import { LEAVE_CODES, applyShiftPlansTx, computePlanPricing, computeWarnings, type Cell, type PlannedOp } from "@/lib/shift-records/write";
// P0（Opus 驗收重現）：新建記錄冇 settlement_broker_id 就喺糧明細完全
// 消失——見 settlement-broker-fallback.ts 頂註解嘅完整 fallback 鏈。
import { createSettlementBrokerFallbackResolver } from "@/lib/pricing/settlement-broker-fallback";


export async function POST(req: Request) {
  return withApiError(async () => {
    // baseline 進閘：更表:create（雞頭出廠 grant——「雞頭配額內填人」；
    // 內部角色逐格再視乎新建/修改/清格細分要求 create/update/void）。
    const session = await requirePermission(req, "更表", "create");
    const rawBody = await readJson(req);
    const parsed = parseBody(ShiftRecordBatchSchema, rawBody);

    const monthParsed = new Date(parsed.month.length <= 7 ? `${parsed.month}-01` : parsed.month);
    if (Number.isNaN(monthParsed.getTime())) throw BadRequest("month 格式唔啱（YYYY-MM）");
    const month = monthStart(monthParsed);
    const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));

    const broker = isBrokerRole(session) ? requireOwnBrokerId(session) : null;
    if (broker) {
      await assertSiteAssignedToBroker(parsed.site_id, broker, month);
    }

    await assertMonthNotLocked({ workDate: month, actorUserId: session.userId, tableName: "shift_records", rowId: "batch", ip: getClientIp(req) });

    // ---- 逐格 validate（未寫入任何嘢）----------------------------------
    const cells = parsed.cells as Cell[];
    // EMP-P1：雞頭 session 唔准指定工號卡（歸屬由 server 推導）；內部角色可揀（會驗證屬同一個 guard）。
    if (isBrokerRole(session)) for (const c of cells) c.staff_number_id = undefined;
    for (const c of cells) {
      if (c.work_date < month || c.work_date > monthEnd) {
        throw BadRequest(`work_date ${c.work_date.toISOString().slice(0, 10)} 唔屬於 ${parsed.month}`);
      }
    }

    const shiftTypeIds = [...new Set(cells.map((c) => c.shift_type_id))];
    const shiftTypes = await prisma.shiftType.findMany({ where: { id: { in: shiftTypeIds } } });
    const shiftTypeById = new Map(shiftTypes.map((s) => [s.id, s]));
    for (const stId of shiftTypeIds) {
      const st = shiftTypeById.get(stId);
      if (!st) throw BadRequest(`shift_type_id ${stId} 唔存在`);
      if (st.siteId !== parsed.site_id) throw BadRequest(`shift_type_id ${stId} 唔屬於呢個 site_id`);
    }

    const guardIds = [...new Set(cells.map((c) => c.guard_id))];
    const guards = await prisma.guard.findMany({ where: { id: { in: guardIds } } });
    const guardById = new Map(guards.map((g) => [g.id, g]));
    for (const gId of guardIds) {
      if (!guardById.get(gId)) throw BadRequest(`guard_id ${gId} 唔存在`);
    }
    if (broker) {
      for (const gId of guardIds) {
        await assertGuardOwnedByBroker(gId, broker); // C1：guard 嫁接防線
      }
    }

    // 應修 4：cells 入面帶嘅 settlement_broker_id／operational_broker_id
    // 一定要存在（唔存在→400，唔留低俾後面 create()/update() 嘅 FK
    // constraint 撞 500）；雞頭 session 帶咗唔係自己嘅 broker id→403
    // （之前呢批 payload 值喺雞頭分支完全冇讀過，靜靜用自己個 id 蓋過
    // 去——而家改做明確話畀佢知個 payload 有問題）。
    await assertSettlementBrokerIdsValid(
      cells.flatMap((c) => [c.settlement_broker_id, c.operational_broker_id]),
      broker,
    );

    const canVoid = await hasPermission(session, "更表", "void");
    const canUpdate = await hasPermission(session, "更表", "update");

    const existing = await prisma.shiftRecord.findMany({
      where: {
        siteId: parsed.site_id,
        workDate: { gte: month, lte: monthEnd },
        guardId: { in: guardIds },
        shiftTypeId: { in: shiftTypeIds },
      },
    });
    const existingByKey = new Map(existing.map((r) => [`${r.guardId}|${r.workDate.toISOString().slice(0, 10)}|${r.shiftTypeId}`, r]));

    let requiresApprovalForNewBroker: boolean | null = null;
    if (broker) {
      const brokerRow = await prisma.broker.findUniqueOrThrow({ where: { id: broker }, select: { requiresApproval: true } });
      requiresApprovalForNewBroker = brokerRow.requiresApproval;
    }

    // P0：memoize（同一 guard 喺呢批 cells 入面可能出現好多次，唔逐格
    // 都打 DB）——見 settlement-broker-fallback.ts。
    const resolveSettlementBrokerFallback = createSettlementBrokerFallbackResolver(prisma);
    // P3-2.5：內部角色逐格 fallback 會逐個 guard 查 2–3 條——先一次過批量預填（雞頭 session 唔行 fallback）。
    if (!broker) {
      await resolveSettlementBrokerFallback.prefetch(
        guardIds.map((gId) => {
          const g = guardById.get(gId)!;
          return { guardId: gId, siteId: parsed.site_id, employmentType: g.employmentType, defaultBrokerId: g.defaultBrokerId };
        }),
      );
    }
    const plans: PlannedOp[] = [];
    for (const c of cells) {
      const st = shiftTypeById.get(c.shift_type_id)!;
      const key = `${c.guard_id}|${c.work_date.toISOString().slice(0, 10)}|${c.shift_type_id}`;
      const record = existingByKey.get(key) ?? null;
      const code = c.code && c.code.trim() !== "" ? c.code.trim() : null;

      if (code === null) {
        if (!record) {
          plans.push({ kind: "noop", cell: c });
          continue;
        }
        if (broker) {
          if (record.status === "confirmed" || record.status === "completed") {
            throw Forbidden(`已確認嘅更次（${key}）唔可以自己清格，請聯絡主管作廢`);
          }
          if (record.settlementBrokerId !== broker && record.operationalBrokerId !== broker) {
            throw Forbidden(`呢格（${key}）唔屬於你`);
          }
          plans.push({ kind: "clear", cell: c, existingId: record.id });
          continue;
        }
        if (!canVoid) throw Forbidden("冇「更表:void」權限，唔可以清格");
        plans.push({ kind: "clear", cell: c, existingId: record.id });
        continue;
      }

      const isLeave = LEAVE_CODES.has(code);
      const isOwnShiftCode = code === st.code;
      if (!isLeave && !isOwnShiftCode) {
        throw BadRequest(`code "${code}"（${key}）同呢行嘅更別代號「${st.code}」／請假代號都對唔上`);
      }

      // 必修 1(a)（Opus 第二輪驗收）：code="PR"（糧明細生成 reconciliation
      // placeholder，見 src/lib/pricing/resolve-rate.ts 頂註解）嘅更別淨係
      // P0 匯入時對數用，唔係真正嘅更表更別——**新建**記錄（呢格本身冇
      // 現存記錄）400，防止用戶（甚至誤操作嘅「複製上月」）將呢類 7 月
      // 遺留 placeholder 帶入 8 月變成真更（見恆星樓/葵發 PR+T 個案：7 月
      // 600/30 → 8 月如果照計會變 630/0，因為 resolver 對 PR 用
      // `requireExactShiftTypeMatch()`，冇卡夾中就靜靜計錯）。更新**既有**
      // 記錄（`record` 有值，例如 7 月已鎖定嘅記錄本身）唔受影響。
      if (!record && st.code === "PR") {
        throw BadRequest(`更別「${st.code}」係糧明細生成嘅對數佔位更別（${key}），唔可以排更`);
      }

      let settlementBrokerId: string | null;
      let operationalBrokerId: string | null;
      let status: ShiftRecordStatus;
      // B1-5（WP-ATTRIB）：呢格嘅 settlement_broker_id 係咪靠
      // resolveSettlementBrokerFallback() 推算出嚟（唔係 payload／現存
      // 記錄直接畀嘅）——雞頭 session 一律唔算推算（伺服器強制等於自己
      // broker_id，唔行 fallback 鏈）。
      let settlementInferredFlag = false;

      if (broker) {
        settlementBrokerId = broker;
        operationalBrokerId = broker;
        if (record && (record.status === "confirmed" || record.status === "completed")) {
          status = "pending_approval"; // §4.2：雞頭改自己已confirmed嘅更→重入審批
        } else if (record) {
          status = record.status; // 未批嘅內容自己再改，狀態不變
        } else {
          status = requiresApprovalForNewBroker ? "pending_approval" : "confirmed";
        }
      } else {
        if (record && !canUpdate) throw Forbidden("冇「更表:update」權限，唔可以改呢格");
        if (!record && !(await hasPermission(session, "更表", "create"))) throw Forbidden("冇「更表:create」權限");
        const guardRow = guardById.get(c.guard_id)!;
        // P0：payload → 現存記錄 → （helper）同盤最近一條 → 任何盤最近
        // 一條 → guard.default_broker_id → 長工揀 internal_longterm →
        // null。settlement／operational 分開 resolve（一般同值，但
        // operational 理論上可以自己一條鏈——依家兩者都用同一個 helper，
        // 同舊行為「兩個都跟 default_broker_id」一致，淨係加強咗
        // fallback 深度）。
        const settlementNeedsFallback = c.settlement_broker_id == null && record?.settlementBrokerId == null;
        settlementBrokerId =
          c.settlement_broker_id ??
          record?.settlementBrokerId ??
          (await resolveSettlementBrokerFallback({
            guardId: c.guard_id,
            siteId: parsed.site_id,
            employmentType: guardRow.employmentType,
            defaultBrokerId: guardRow.defaultBrokerId,
          }));
        operationalBrokerId =
          c.operational_broker_id ??
          record?.operationalBrokerId ??
          (await resolveSettlementBrokerFallback({
            guardId: c.guard_id,
            siteId: parsed.site_id,
            employmentType: guardRow.employmentType,
            defaultBrokerId: guardRow.defaultBrokerId,
          }));
        status = "confirmed"; // 主管/有權者直接改，唔使入審批隊列
        settlementInferredFlag = settlementNeedsFallback && settlementBrokerId !== null;
      }

      plans.push({
        kind: "upsert",
        cell: c,
        existingId: record?.id ?? null,
        recordType: isLeave ? "leave" : "shift",
        leaveCode: isLeave ? code : null,
        settlementBrokerId,
        operationalBrokerId,
        status,
        existingIsExternal: record?.isExternal ?? false,
        pricing: null,
        settlementInferred: settlementInferredFlag,
        manualSource: !record || record.status === "cancelled" || record.recordType !== (isLeave ? "leave" : "shift") || (record.leaveCode ?? null) !== (isLeave ? code : null),
      });
    }

    // ---- WP-PRICE：計價（老闆 2026-09-16 拍板）------------------------
    // 喺 plans 起晒之後、開 transaction 之前一次過計——一次 query 攞晒
    // 呢個盤本月範圍嘅有效卡（`fetchEffectiveRateCards`），逐格喺記憶體
    // 揀價（`resolveShiftPricingFromCards`），唔逐格打 DB。淨係
    // record_type=shift 先計「未定價」統計（leave 冇「呢更嘅價」呢個
    // 概念，resolver 本身對 leave 已經回全 null＋unpriced:false）。
    //
    // S4（Opus 驗收）：舊版每次都無條件覆寫已存在記錄嘅 snapshot——人手
    // 改過嘅出街價／收客價會被靜靜計返覆蓋（例如老闆手動補咗一個特殊
    // 價，之後個雞頭改咗呢格另一個唔相干欄位，snapshot 又俾 resolver
    // 計出嚟嘅「標準價」蓋走）。而家淨係下面幾種情況先「全部重計」：
    //   1. 新建記錄（existingId=null）；
    //   2. record_type 變咗（shift↔leave）；
    //   3. settlement_broker 變咗（邊個雞頭出糧變咗，出街價自然要追）；
    //   4. 現存三個 snapshot 全部 null（本身就未定價，冇嘢好「保留」）；
    //   5.（應修，Opus 第二輪驗收）is_external 翻轉咗但 snapshot 未追——
    //      現存記錄 `is_external=true`（external 記錄理應收客價／出街價
    //      全部 null）但 snapshot 仲有非 null 值，即係呢條記錄嘅
    //      external 狀態同 snapshot 唔一致（例如原本內部記錄，之後有人
    //      經 PATCH 改咗 is_external，但冇追過 snapshot）——強制全部重計
    //      令 external 記錄嘅 snapshot 追返正確（全部 null）。
    // 除咗上面「全部重計」，仲加一種（應修）局部補漏：唔夠全部重計嘅
    // 條件，但現存三個 snapshot 入面**部份**（唔係全部）係 null，而
    // resolver 對嗰個欄位計到有值——淨係補嗰個 null 欄位，非 null 嘅
    // 欄位（人手改過嘅）保持原封不動，唔會被 resolver 嘅「標準價」
    // 覆蓋。其他情況（改嘅淨係狀態／清咗又填返同一個值等，三個欄位都
    // 已經有值或者都啱）保留現有 snapshot 原封不動。
    const { upsertPlans, pricedCount, unpricedCount, unpricedByKey } = await computePlanPricing({ siteId: parsed.site_id, month, monthEnd, plans, existingByKey, shiftTypeById });

    // ---- 全部 validate 過關，先開 transaction 寫入 --------------------
    // G4：audit 同 shift 寫入喺同一個 `$transaction`——tx 內收集 audit 素材，
    // tx 最後一步（所有 shift 寫入之後）用 `writeAuditMany(…, tx)`（一條 createMany）寫入；
    // 任何一步失敗成個 tx（shift＋audit）一齊 rollback，唔會有孤兒 audit。
    const ip = getClientIp(req);
    let results: Array<{ key: string; id: string; action: string; settlement_inferred?: boolean }> = [];
    let autoCardUses: AutoCardUse[] = [];
    let noStaffNumberCount = 0;
    try {
      await prisma.$transaction(
        async (tx) => {
          // P6.1f（H6）：tx 開頭 FOR SHARE 再查鎖月——route 層嗰次檢查喺 tx 外面，
          // 驗證／配價期間鎖咗月嘅話呢度擋住（鎖月 route 用 FOR UPDATE 會等呢個 tx）。
          await assertMonthNotLockedTx(tx, { workDate: month, actorUserId: session.userId, tableName: "shift_records", rowId: "batch", ip });
          // P3-2.5：批量化寫入核心已抽到 write service（行為不變；tests/p3-2-batch-write.test.ts 對比）。
          const applied = await applyShiftPlansTx(tx, { plans, siteId: parsed.site_id, actorUserId: session.userId, ip });
          results = applied.results;
          autoCardUses = applied.autoCardUses;
          noStaffNumberCount = applied.noStaffNumberCount;
        },
        // P3-1.7（B-3）：Prisma interactive tx 預設 5 s——放寬到 60 s。
        { timeout: 60_000, maxWait: 10_000 },
      );
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
        throw Conflict("批量寫入撞到唯一約束（同一保安員、同一日、同一更別已經有記錄）——成批已 rollback");
      }
      throw err;
    }

    // G4：audit 已喺 tx 內同 shift 一齊 commit。
    await journalAutoCardUsesSafe(autoCardUses);

    const warnings = await computeWarnings(guardIds, parsed.site_id, month, monthEnd, broker);

    // WP-PRICE：「未定價」＝清楚警告，唔准靜靜 0——回應加返呢次儲存嘅計價
    // 結果，等 RosterEditor 儲存後可以即刻 toast/Notice 出嚟（見
    // src/components/roster/RosterEditor.tsx）。
    const pricing = { priced: pricedCount, unpriced: unpricedCount, unpriced_cells: [...unpricedByKey.values()] };

    // P0（D 項）：就算加強咗 fallback 鏈，理論上仍然可能出現全部級都搵
    // 唔到嘅情況（全新保安員、乜記錄都冇、又唔係長工）——呢種格唔准再靜靜
    // 消失，response 帶 `no_settlement_count` 等前端 toast／banner 明確
    // 講畀用戶知呢幾格「唔會出現喺糧單」。
    const noSettlementCount = upsertPlans.filter((p) => p.recordType === "shift" && p.settlementBrokerId === null).length;

    // B1-5（WP-ATTRIB）：幾多格結算單位係靠 fallback 推算（唔係 payload/
    // 現存記錄直接畀）——RosterEditor 儲存完可以喺度 toast「N 格結算單位
    // 推算，建議覆核」。
    const settlementInferredCount = results.filter((r) => r.settlement_inferred).length;
    return ok(brandSafeResponse({ results, warnings, pricing, no_settlement_count: noSettlementCount, no_staff_number_count: noStaffNumberCount, settlement_inferred_count: settlementInferredCount }), 200);
  });
}

