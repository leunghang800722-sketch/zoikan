// 一次性修正腳本（2026-09-13，老闆質詢後跟進，P1-WP4）。
//
// 背景：殷樺花園（S001）雞頭 K（B01）7 月 25 條更次（source=
// master_roster_site，settlement_page=總表確認-K）由頭到尾冇任何 K 嘅
// rate_cards 卡——唔係「有卡但價錯」，係「連卡都冇」，令
// shift_records.guard_wage_snapshot 一直留空，呢 25 更靜靜哋變咗 $0 成本
// （P0 自己嘅糧明細/月結都冇計過呢筆），令 K 糧明細少咗 21,250、7 月成本
// 少咗 21,250。P0 在勤總表（tools/importer/out/wp5/master_posts.csv，
// property=殷樺，block「城巴車廠 12hrs (N/S)」Night）寫明 client_rate
// 900、payout_rate 850，本腳本用呢個外判價補返呢張卡。
//
// 呢個修正喺 `npm run db:seed`（本機/dev）已經用 seed-overrides.json 嘅
// extraRateCards + scripts/seed/lib/extra-rate-cards.ts 做咗一份，方便
// 本機重 seed 保持一致；呢個腳本係做返完全同一件事，但直接對住一個
// **已經喺用緊嘅正式庫**（唔可以再重 seed，只可以就地 UPDATE），並且
// 留低 audit_log 記錄呢次人手修正嘅原因。
//
// 幂等：
// - 攞「呢個 site+broker(settlement)、record_type=shift、billed=true、
//   guard_wage_snapshot 仲係 null」嘅記錄做「缺價目標」——已經補好嘅記錄
//   guard_wage_snapshot 唔再係 null，唔會再俾呢個腳本揀中，所以重複跑
//   第二次會即刻見到「冇缺價更次」然後乾淨退出，唔會再建多一張卡或者
//   再寫多一次 audit_log。
// - 建卡前額外檢查番呢個 site+shift_type+broker+guard=null 组合係咪已經
//   有一張未作廢嘅卡（防止「建咗卡但更新記錄嗰步中途失敗」之後重跑會
//   建多一張重複卡）。
//
// 用法（喺已經授權嘅環境，指向要修正嗰個庫）：
//   DATABASE_URL="postgresql://...正式庫連接字串..." \
//     npx tsx scripts/db/one-off/2026-09-13-yinwah-k.ts
//
// 重要：呢個腳本喺呢個 AI agent session 入面只喺本機 dev DB
// （embedded-postgres，`npm run db:start` 起嗰個）驗證過跑得通、邏輯啱
// ——**冇自己對正式庫執行過**。老闆覆核完呢個檔案之後，麻煩親自用正式庫
// 嘅 DATABASE_URL 執行。
import { prisma } from "../../../src/lib/db";
import { writeAudit } from "../../../src/lib/audit";
import { applyBrokerFeeSplit } from "../../seed/lib/broker-fee-split";
import { brokerFeeRules } from "../../seed/lib/seed-overrides";

const SITE_CANONICAL_NAME = "殷樺花園"; // 盤名，唔算 PDPO 定義嘅真名
const BROKER_CODE = "K"; // 業務代號
const BROKER_CSV_ID = "B01"; // 對應 data/mappings-private/brokers.csv 嘅 broker_csv_id；brokerFeeRules()（seed-overrides.json）用呢個做 key
const PAYOUT_RATE = 850; // tools/importer/out/wp5/master_posts.csv MP0244（property=殷樺，城巴車廠 12hrs (N/S) Night，payout_rate 欄）
const CLIENT_RATE: number | null = null; // 呢個 site 已經有一張獨立嘅收客價卡（R2 月結 row20，收客價 900），呢張卡淨係補成本側，唔重複記 client_rate
const EFFECTIVE_FROM = new Date(Date.UTC(2026, 6, 1));
const SOURCE = "master_roster_payout(殷樺)";
const NOTE = "P0 漏價，2026-09-13 由總表外判價補";
const OVERRIDE_REASON =
  "老闆 2026-09-13 質詢後補 P0 漏價：殷樺花園 K 雞頭 25 條 7 月更次（source=master_roster_site，settlement_page=總表確認-K）由頭到尾冇任何 rate_cards 卡，guard_wage_snapshot 一直留空，令 K 糧明細少咗 21,250、7 月成本少咗 21,250。P0 在勤總表（master_posts.csv，property=殷樺，block「城巴車廠 12hrs (N/S)」Night）寫明 client_rate 900、payout_rate 850，用嚟補呢張卡（scripts/db/one-off/2026-09-13-yinwah-k.ts）。";

async function main() {
  const site = await prisma.site.findFirst({ where: { canonicalName: SITE_CANONICAL_NAME } });
  if (!site) throw new Error(`搵唔到盤「${SITE_CANONICAL_NAME}」——請先確認 sites.canonical_name 冇改名，或者呢個腳本要更新。`);

  const broker = await prisma.broker.findFirst({ where: { code: BROKER_CODE } });
  if (!broker) throw new Error(`搵唔到 broker code=${BROKER_CODE}`);
  if (broker.kind !== "broker") {
    throw new Error(`broker code=${BROKER_CODE} 而家 kind=${broker.kind}，唔係外判雞頭（"broker"）——呢個腳本嘅假設同而家數據唔夾，停手，需要人手覆核先可以繼續。`);
  }

  // 缺價目標：呢個 site + settlement broker 組合入面，正更、已入帳
  // （billed）、guard_wage_snapshot 仲係空嘅記錄——先反推缺價嘅
  // shift_type_id（唔喺呢度手動寫死，避免人手估漏或者估錯更型）。
  const gapRecords = await prisma.shiftRecord.findMany({
    where: {
      siteId: site.id,
      settlementBrokerId: broker.id,
      recordType: "shift",
      billed: true,
      guardWageSnapshot: null,
    },
    select: { id: true, shiftTypeId: true },
  });

  const gapShiftTypeIds = [...new Set(gapRecords.map((r) => r.shiftTypeId))];
  console.log(`[one-off] 缺價更次: ${gapRecords.length} 條，涉及 ${gapShiftTypeIds.length} 個 shift_type_id: ${gapShiftTypeIds.join(", ") || "(無)"}`);

  if (gapRecords.length === 0) {
    console.log("[one-off] 冇任何缺價更次——可能之前已經跑過呢個腳本（幂等），或者呢單漏價已經用其他方式補咗。冇嘢好做，正常退出。");
    return;
  }

  const feeRules = brokerFeeRules();
  const split = applyBrokerFeeSplit(feeRules, {
    brokerCsvId: BROKER_CSV_ID,
    brokerKind: broker.kind,
    siteCanonicalName: site.canonicalName,
    guardWage: PAYOUT_RATE,
    brokerFee: null,
  });
  if (!split.split) {
    throw new Error(
      `applyBrokerFeeSplit() 冇拆分 broker_csv_id=${BROKER_CSV_ID}（可能 seed-overrides.json 嘅 brokerFeeRules 冇登記呢個 broker，或者已經俾第三方改咗格式）——停手，需要人手覆核先可以繼續，唔應該用未拆分嘅合計價落卡。`,
    );
  }
  console.log(`[one-off] 拆分結果：guard_wage=${split.guardWage}，broker_fee=${split.brokerFee}（payout=${PAYOUT_RATE} 不變）`);

  let cardsCreated = 0;
  let cardsSkippedExisting = 0;
  let recordsUpdated = 0;
  let recordsSkippedAlreadyPriced = 0;

  for (const shiftTypeId of gapShiftTypeIds) {
    const existingCard = await prisma.rateCard.findFirst({
      where: { siteId: site.id, shiftTypeId, brokerId: broker.id, guardId: null, voidedAt: null },
    });

    if (existingCard) {
      cardsSkippedExisting++;
      console.log(`[one-off] shift_type_id=${shiftTypeId} 已經有未作廢嘅卡（${existingCard.id}），跳過建卡（幂等）。`);
    } else {
      const created = await prisma.rateCard.create({
        data: {
          siteId: site.id,
          shiftTypeId,
          brokerId: broker.id,
          guardId: null,
          clientRate: CLIENT_RATE,
          guardWage: split.guardWage,
          brokerFee: split.brokerFee,
          payoutRate: (split.guardWage ?? 0) + (split.brokerFee ?? 0),
          billingModel: "per_shift",
          effectiveFrom: EFFECTIVE_FROM,
          effectiveTo: null,
          source: SOURCE,
          note: NOTE,
          createdBy: "one-off:2026-09-13-yinwah-k.ts",
        },
      });
      cardsCreated++;
      await writeAudit({
        actorUserId: null,
        tableName: "rate_cards",
        rowId: created.id,
        action: "create",
        after: { ...created, override_reason: OVERRIDE_REASON },
      });
      console.log(`[one-off] 建咗新卡 ${created.id}（shift_type_id=${shiftTypeId}，guard_wage=${split.guardWage}，broker_fee=${split.brokerFee}）`);
    }

    for (const r of gapRecords.filter((g) => g.shiftTypeId === shiftTypeId)) {
      const before = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: r.id } });
      if (before.guardWageSnapshot !== null) {
        // 幂等安全網：理論上唔會發生（上面 gapRecords 揀嗰陣已經篩咗
        // guard_wage_snapshot=null），但兩步之間（select→逐條 update）
        // 如果有第三方並行寫入，寧願安全咁跳過都唔覆蓋。
        recordsSkippedAlreadyPriced++;
        continue;
      }
      const updated = await prisma.shiftRecord.update({
        where: { id: r.id },
        data: { guardWageSnapshot: split.guardWage, brokerFeeSnapshot: split.brokerFee },
      });
      recordsUpdated++;
      await writeAudit({
        actorUserId: null,
        tableName: "shift_records",
        rowId: r.id,
        action: "update",
        before,
        after: { ...updated, override_reason: OVERRIDE_REASON },
      });
    }
  }

  console.log(
    `[one-off] 完成：建卡 ${cardsCreated} 張（已存在跳過 ${cardsSkippedExisting} 張），更新快照 ${recordsUpdated} 條（幂等跳過 ${recordsSkippedAlreadyPriced} 條）。`,
  );
}

main()
  .catch((err) => {
    console.error("[one-off] 失敗", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
