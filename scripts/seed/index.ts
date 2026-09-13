// P1-WP1 seed：由 tools/importer/out/{wp2b,wp3} 同 mappings/*.csv 讀入 7 月真數據，
// 寫入本機 embedded-postgres。Idempotent：每次執行先清空再入。
// PDPO：呢個檔案唔含任何真名/電話/工號——真數據淨係喺 runtime 由 CSV 讀入。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "./lib/db";
import { readCsv, num, bool, str, dateOnly, timeOnly, arr } from "./lib/csv";
import { CSV, DATA } from "./lib/paths";
import {
  mapBrokerKind,
  mapSettlementType,
  mapBillingModel,
  mapEmploymentType,
  settlementUnitToBrokerCsvId,
  MASTER_BROKER_CODE_TO_BROKER_CSV_ID,
} from "./lib/mapping";
import { canonicalNameFor } from "./lib/broker-names";
import { knownUnmappedSettlementUnits, monthlySalaryOverrides, brokerFeeRules } from "./lib/seed-overrides";
import { applyBrokerFeeSplit } from "./lib/broker-fee-split";
import { bochkAmountForName } from "./lib/bochk";
import { loadReferralFees, siteCsvIdForBlock } from "./lib/referral-fees";
import { excludedClientNames } from "../../src/lib/reports/private-overrides";
import type { RecordType, LeaveCode } from "@prisma/client";
import { backfillDefaultBrokerId } from "./lib/backfill-broker";
import { ROLE_NAMES } from "../../src/lib/rbac/matrix";
import { seedRolesPermissionsMatrix } from "../../src/lib/rbac/seed";
import { seedRosterLayouts } from "./lib/roster-layout";
import { enrichLeaveCodeRawText } from "./lib/leave-code-raw";
import { enrichShiftRecordsWithRawRow } from "./lib/roster-raw";

const stats: Record<string, number> = {};

// ---------------------------------------------------------------------------
// P1-WP4：雞頭費拆分（見 lib/broker-fee-split.ts 頂註解）要用嘅兩個
// 輔助對照表——broker_csv_id → kind、site_id(csv) → canonical_name。
// 淨係讀返 CSV，唔碰 DB，seedRateCards()／seedShiftRecords() 兩處共用。
function loadBrokerKindByCsvId(): Map<string, string> {
  const rows = readCsv<{ broker_id: string; kind: string }>(CSV.brokers);
  return new Map(rows.map((r) => [r.broker_id, mapBrokerKind(r.kind)]));
}
function loadSiteCanonicalNameByCsvId(): Map<string, string> {
  const rows = readCsv<{ site_id: string; canonical_name: string }>(CSV.sites);
  return new Map(rows.map((r) => [r.site_id, r.canonical_name]));
}

async function clearAll() {
  console.log("[seed] 清空現有數據...");
  // 注意：audit_log 唔清——佢係 append-only（DB trigger 拒絕
  // UPDATE/DELETE，呢個係設計本意，唔係漏咗）。
  //
  // P1-WP3：`users` 一旦寫過一條 audit_log（登入、任何 API 寫入……），
  // `audit_log.actor_user_id` 嗰個 FK 嘅 `ON DELETE SET NULL` 就會觸發
  // 一個 UPDATE audit_log——即刻俾 append-only trigger 拒絕，
  // `prisma.user.deleteMany({})` 成句 fail（Postgres FK RESTRICT/UPDATE
  // 係成句 statement 一齊 rollback，唔會淨係跳過嗰幾行）。舊版呢度盲目
  // 刪晒 users/roles/permissions，喺一個從未有人登入過嘅全新 DB 冇事，
  // 但一旦有人（包括自動化 e2e/smoke test）登入過一次，之後嘅
  // `npm run db:seed` 就會 100% fail。而家淨係刪冇 audit_log 歷史嘅
  // user；roles/permissions/role_permissions 唔再刪表（`seedRoles()`／
  // `seedPermissions()` 而家用 upsert，見 src/lib/rbac/seed.ts；
  // `seedUsers()` 都改用 upsert，見下面），令重複執行 db:seed 永遠安全，
  // 唔理 DB 之前有冇人用過。
  await prisma.shiftRecord.updateMany({ data: { parentShiftId: null } });
  await prisma.shiftRecord.deleteMany({});
  await prisma.brokerSiteAssignment.deleteMany({}); // C1：清埋先可以安全刪 site/broker
  await prisma.dailyRequirement.deleteMany({});
  await prisma.rateCard.deleteMany({});
  await prisma.referralFeeRate.deleteMany({});
  await prisma.specialItem.deleteMany({});
  await prisma.monthClose.deleteMany({});
  await prisma.rolePermission.deleteMany({});
  // D-P1-1：真人帳號（createdBy 以 seed:D-P1-1 開頭）永遠唔喺 db:seed 刪走，
  // 否則測試套件重跑 seed 會令佢哋被重建、密碼變咗。只有 db:reset（drop DB）
  // 先會清走——正式環境永遠唔准跑 db:reset。
  const deletableUserIds = (
    await prisma.user.findMany({
      where: { auditLogs: { none: {} }, NOT: { createdBy: { startsWith: "seed:D-P1-1" } } },
      select: { id: true },
    })
  ).map((u) => u.id);
  if (deletableUserIds.length) await prisma.user.deleteMany({ where: { id: { in: deletableUserIds } } });
  await prisma.guard.updateMany({ data: { defaultBrokerId: null } });
  await prisma.guard.deleteMany({});
  await prisma.shiftType.deleteMany({});
  await prisma.site.updateMany({ data: { parentSiteId: null } });
  await prisma.site.deleteMany({});
  await prisma.broker.deleteMany({});
}

// ---------------------------------------------------------------------------
async function seedBrokers() {
  type Row = {
    broker_id: string;
    code: string;
    canonical_name: string;
    kind: string;
    settlement_type: string;
    aliases: string;
  };
  const rows = readCsv<Row>(CSV.brokers);
  const idMap = new Map<string, string>();
  for (const r of rows) {
    const kind = mapBrokerKind(r.kind);
    const created = await prisma.broker.create({
      data: {
        code: str(r.code) ?? r.broker_id, // 有幾個 broker 冇單字母代號（個別雞頭/external/獨立雞頭…），用 broker_id 頂住保持 unique
        // PDPO 裁定（Opus 對抗式驗收）：唔再直接用 out/wp2b/brokers.csv
        // 嘅 canonical_name（雖然嗰個檔案本身已經 gitignored，但「呢個
        // 名會唔會係真名」而家統一由 data/mappings-private/brokers.csv
        // 呢個檔案存唔存在決定——冇嗰個檔就淨係用代號做名，行為
        // deterministic，唔靠零散幾個 gitignored 檔各自嘅內容）。
        name: canonicalNameFor(r.broker_id, str(r.code)),
        kind,
        settlementType: mapSettlementType(r.settlement_type),
        isInternal: kind === "internal_cash" || kind === "internal_longterm",
        aliases: arr(r.aliases),
        createdBy: "seed:wp2b/brokers.csv",
      },
    });
    idMap.set(r.broker_id, created.id);
  }
  stats.brokers = rows.length;
  return idMap;
}

// ---------------------------------------------------------------------------
async function seedSites() {
  type Row = {
    site_id: string;
    canonical_name: string;
    client_name: string;
    client_group: string;
    billing_model: string;
    monthly_fee: string;
    aliases: string;
    in_p0_scope: string;
    parent_site_id: string;
  };
  const rows = readCsv<Row>(CSV.sites);
  const idMap = new Map<string, string>();

  // 第一輪：唔設 parent，避免 FK 順序問題
  for (const r of rows) {
    const created = await prisma.site.create({
      data: {
        canonicalName: r.canonical_name,
        aliases: arr(r.aliases),
        clientName: str(r.client_name) ?? r.canonical_name,
        outsideMonthlyClose: excludedClientNames().includes(str(r.client_name) ?? r.canonical_name),
        clientGroup: str(r.client_group),
        billingModel: mapBillingModel(r.billing_model),
        monthlyFee: num(r.monthly_fee),
        inScope: bool(r.in_p0_scope),
        createdBy: "seed:wp2b/sites.csv",
      },
    });
    idMap.set(r.site_id, created.id);
  }
  // 第二輪：補 parent_site_id
  for (const r of rows) {
    if (str(r.parent_site_id)) {
      await prisma.site.update({
        where: { id: idMap.get(r.site_id)! },
        data: { parentSiteId: idMap.get(r.parent_site_id) },
      });
    }
  }
  // §3 P1計劃指定嘅 monthly_posts/prorata_basis（P0 §8 逐盤金額裁定；sites.csv
  // 冇呢兩個欄，呢度用 canonical_name 對返個 site，數值嚟自 P1-執行計劃.md 要做清單）
  // P1-WP4（規劃裁定 2026-09-12）：`prorataBasis` 補做 "div_31"（schema
  // 定義「固定除 31」）俾*真正 billing_model=monthly_fixed*嘅盤——呢個
  // 值 WP1 一直冇填（sites.csv 源頭本身冇呢欄），而家用嚟做
  // monthly-close.ts 嘅 pro-rata fallback 公式（見嗰個檔案「已知限制」
  // 註解：分子暫時預設足月，冇逐月 SL 輸入機制）。
  const monthlyPostsPlan: Array<{ name: string; monthlyFee: number; monthlyPosts: number; prorataBasis?: "div_31" }> = [
    { name: "九龍企業大廈", monthlyFee: 25500, monthlyPosts: 2, prorataBasis: "div_31" },
    { name: "恆星樓", monthlyFee: 25000, monthlyPosts: 2, prorataBasis: "div_31" },
    { name: "屯門小欖樂怡街5號", monthlyFee: 24000, monthlyPosts: 2 },
    { name: "屯門凱和山", monthlyFee: 27000, monthlyPosts: 1, prorataBasis: "div_31" },
    { name: "淺水灣道11號蔚峰園", monthlyFee: 29000, monthlyPosts: 3, prorataBasis: "div_31" },
    { name: "IFC", monthlyFee: 35000, monthlyPosts: 1, prorataBasis: "div_31" },
    { name: "數碼港 CP5 IC", monthlyFee: 32000, monthlyPosts: 1, prorataBasis: "div_31" },
    { name: "創富廠IC", monthlyFee: 25200, monthlyPosts: 1 },
    { name: "M+", monthlyFee: 17800, monthlyPosts: 1, prorataBasis: "div_31" },
    { name: "都會大學夜巡邏", monthlyFee: 19804, monthlyPosts: 1 },
  ];
  for (const p of monthlyPostsPlan) {
    await prisma.site.updateMany({
      where: { canonicalName: p.name },
      data: {
        monthlyFee: p.monthlyFee,
        monthlyPosts: p.monthlyPosts,
        prorataBasis: p.prorataBasis ?? null,
      },
    });
  }

  stats.sites = rows.length;
  return idMap;
}

// ---------------------------------------------------------------------------
async function seedShiftTypes(siteIdMap: Map<string, string>) {
  type Row = {
    shift_type_id: string;
    site_id: string;
    code: string;
    start_time: string;
    end_time: string;
    hours: string;
    label: string;
    billing_group: string;
    source: string;
  };
  const rows = readCsv<Row>(CSV.shiftTypes);
  const idMap = new Map<string, string>();

  // 規劃 session 裁定（2026-09-11）：DB 層加咗 UNIQUE(site_id, code, start_time)。
  // master-roster-only 合成更別（例：國泰城 S038）源頭 CSV 會有同一盤同一個
  // 佔位 code（"MR"）、甚至同一時段嘅多個獨立 post——seed 時逐個 post 改用
  // `MR-<label>-<n>` 做 code；如果改完仲撞（同 site/code/start_time 完全一樣），
  // 加數字尾綴保證唯一，唔淨係得 master_roster_only 先咁做，任何來源撞埋都
  // 一視同仁咁處理，先至真係「唔准撞」。
  const seenKey = new Map<string, number>(); // `${site_id}|${code}|${start_time}` -> 出現次數
  for (const r of rows) {
    let code = r.code;
    if (r.source === "master_roster_only") {
      code = `MR-${str(r.label) ?? r.code}`;
    }
    const key = `${r.site_id}|${code}|${r.start_time}`;
    const n = (seenKey.get(key) ?? 0) + 1;
    seenKey.set(key, n);
    if (n > 1) code = `${code}-${n}`;

    const created = await prisma.shiftType.create({
      data: {
        siteId: siteIdMap.get(r.site_id)!,
        code,
        label: str(r.label),
        startTime: timeOnly(r.start_time),
        endTime: timeOnly(r.end_time),
        hours: num(r.hours),
        billingGroup: r.billing_group === "monthly_ic" ? "monthly_ic" : "per_shift",
        createdBy: "seed:wp2b/shift_types.csv",
      },
    });
    idMap.set(r.shift_type_id, created.id);
  }
  stats.shiftTypes = rows.length;
  return idMap;
}

// ---------------------------------------------------------------------------
async function seedGuards() {
  type Row = {
    guard_id: string;
    staff_no: string;
    name_zh: string;
    name_en: string;
    tel: string;
    is_external: string;
    is_longterm: string;
    staff_no_mw: string;
    monthly_salary: string;
  };
  const rows = readCsv<Row>(CSV.guards);

  // 規劃 session 第三輪 item 1：employment_type 唔准淨靠 wp2b/guards.csv
  // 自己嘅 is_longterm（呢個判定漏咗 P0-執行計劃§8 Q10 提到嘅個案，PDPO：
  // 唔喺呢度寫真名）。權威來源改用兩個 gitignored 私隱檔嘅聯集：
  //   (a) data/mappings-private/longterm_staff_2026-07.csv（Maxwell 48人，
  //       staff_no_mw 對得上）
  //   (b) data/mappings-private/names_en.csv tier=longterm（BOCHK autopay
  //       長工 tier，51 人，name_zh 對得上）
  const longtermMwNos = new Set(
    readCsv<{ staff_no_mw: string }>(CSV.longtermStaff)
      .map((r) => str(r.staff_no_mw))
      .filter((v): v is string => v !== null),
  );
  const longtermNameZh = new Set(
    readCsv<{ name_zh: string; tier: string }>(CSV.namesEn)
      .filter((r) => r.tier === "longterm" && str(r.name_zh))
      .map((r) => r.name_zh),
  );

  // P1-WP4 WP1 遺留 item 5（規劃裁定，2026-09-12）：長工月薪缺數用 BOCHK
  // 權威值——呢部機已經有 tools/importer/venv/（裝咗 msoffcrypto/xlrd），
  // 唔使裝嘢。優先順序：(1) wp2b/guards.csv 本身有值就用；(2) BOCHK 長工
  // autopay 發薪表（scripts/seed/lib/bochk.ts，按 name_en 對——呢個係
  // 「嗰個月實際過數金額」，唔完全等於 Maxwell 表嗰粒固定「Monthly
  // Salary」欄，但係規劃裁定明文要求嘅權威來源）；(3) 冇 venv/BOCHK 檔嗰種
  // 環境（CI／未授權機器）先跌返用 data/mappings-private/seed-
  // overrides.json 嘅靜態值（Maxwell 上月已知值，見
  // scripts/seed/lib/seed-overrides.ts）。
  const salaryOverrides = monthlySalaryOverrides();
  let salaryOverrideAppliedBochk = 0;
  let salaryOverrideAppliedStatic = 0;

  const idMap = new Map<string, string>();
  let longtermCount = 0;
  for (const r of rows) {
    const isLongterm =
      bool(r.is_longterm) || (str(r.staff_no_mw) !== null && longtermMwNos.has(r.staff_no_mw)) || longtermNameZh.has(r.name_zh);
    const employmentType = mapEmploymentType({ isExternal: bool(r.is_external), isLongterm });
    if (employmentType === "longterm_autopay") longtermCount++;
    let monthlySalary = num(r.monthly_salary);
    let salarySource = "csv";
    if (monthlySalary === null) {
      const bochkAmount = bochkAmountForName(r.name_en);
      if (bochkAmount !== null) {
        monthlySalary = bochkAmount;
        salarySource = "bochk";
        salaryOverrideAppliedBochk++;
      } else if (str(r.staff_no) && r.staff_no in salaryOverrides) {
        monthlySalary = salaryOverrides[r.staff_no];
        salarySource = "static_override";
        salaryOverrideAppliedStatic++;
      }
    }
    const created = await prisma.guard.create({
      data: {
        staffNo: str(r.staff_no),
        staffNoMw: str(r.staff_no_mw),
        nameZh: r.name_zh,
        nameEn: str(r.name_en),
        tel: str(r.tel),
        employmentType,
        monthlySalary,
        createdBy: `seed:wp2b/guards.csv+longterm_staff_2026-07.csv+names_en.csv+monthly_salary_source=${salarySource}`,
      },
    });
    idMap.set(r.guard_id, created.id);
  }
  stats.guards = rows.length;
  stats.guardsLongtermAutopay = longtermCount;
  stats.guardsMonthlySalaryOverrideAppliedBochk = salaryOverrideAppliedBochk;
  stats.guardsMonthlySalaryOverrideAppliedStatic = salaryOverrideAppliedStatic;
  // names_en.csv tier=longterm 51 人入面有 3 人 name_zh 留空（只有英文
  // 名，PDPO：唔喺呢度寫真名），guards.csv 嘅 name_en 亦冇對應值可以配對
  // ——P0-執行計劃§8 D5 話某一位「已補配」中文名，但現存 names_en.csv
  // 未見更新。呢個係源頭資料完整性缺口，唔係 seed 邏輯漏咗，已喺 WP1
  // 回報標明，交返規劃 session 決定要唔要補 names_en.csv。
  stats.namesEnLongtermUnmatched = [...longtermNameZh].length - [...longtermNameZh].filter((n) => rows.some((r) => r.name_zh === n)).length;
  return idMap;
}

// ---------------------------------------------------------------------------
async function seedRateCards(
  siteIdMap: Map<string, string>,
  shiftTypeIdMap: Map<string, string>,
  brokerIdMap: Map<string, string>,
  guardIdMap: Map<string, string>,
) {
  type Row = {
    rate_id: string;
    site_id: string;
    shift_type_id: string;
    broker_id: string;
    guard_id: string;
    client_rate: string;
    guard_wage: string;
    broker_fee: string;
    payout_rate: string;
    billing_model: string;
    effective_from: string;
    effective_to: string;
    source: string;
    evidence: string;
    confidence: string;
    status: string;
    note: string;
  };
  const rows = readCsv<Row>(CSV.rateCards);
  const brokerKindByCsvId = loadBrokerKindByCsvId();
  const siteCanonicalNameByCsvId = loadSiteCanonicalNameByCsvId();
  const feeRules = brokerFeeRules();
  let n = 0;
  let feeSplitCards = 0;
  for (const r of rows) {
    const siteId = siteIdMap.get(r.site_id);
    if (!siteId) continue; // 理論上唔會發生，rate_cards 嘅 site_id 一定喺 sites.csv 出現過

    // P1-WP4：老闆 2026-09-13 批准嘅雞頭費率（見 lib/broker-fee-split.ts）——
    // 「合計卡」（出街價冚埋工資+雞頭費，冇拆開）拆做 guard_wage/broker_fee，
    // 出街價（下面 payoutRate）保持不變。
    const brokerCsvId = str(r.broker_id);
    const split = applyBrokerFeeSplit(feeRules, {
      brokerCsvId,
      brokerKind: brokerCsvId ? brokerKindByCsvId.get(brokerCsvId) ?? null : null,
      siteCanonicalName: siteCanonicalNameByCsvId.get(r.site_id) ?? null,
      guardWage: num(r.guard_wage),
      brokerFee: num(r.broker_fee),
    });
    if (split.split) feeSplitCards++;

    await prisma.rateCard.create({
      data: {
        siteId,
        shiftTypeId: str(r.shift_type_id) ? shiftTypeIdMap.get(r.shift_type_id) : null,
        brokerId: str(r.broker_id) ? brokerIdMap.get(r.broker_id) : null,
        guardId: str(r.guard_id) ? guardIdMap.get(r.guard_id) : null,
        clientRate: num(r.client_rate),
        guardWage: split.guardWage,
        brokerFee: split.brokerFee,
        // 2026-09-12 老闆批准：出街價＝保安員工資＋雞頭費（P0 §3.5 定義）。P0 反推嘅
        // payout_rate 有三張雞頭 T 逐人卡係「糧單總額÷含半更嘅更數」嘅混合價
        // （679.45／628.70／29.68），半更屬調整項，唔應該入卡。
        payoutRate: split.guardWage != null || split.brokerFee != null ? (split.guardWage ?? 0) + (split.brokerFee ?? 0) : num(r.payout_rate),
        billingModel: str(r.billing_model) ? mapBillingModel(r.billing_model) : null,
        effectiveFrom: dateOnly(r.effective_from)!,
        effectiveTo: dateOnly(r.effective_to),
        source: str(r.source),
        evidence: str(r.evidence),
        confidence: str(r.confidence),
        status: str(r.status),
        note: str(r.note),
        createdBy: "seed:wp3/rate_cards.csv",
      },
    });
    n++;
  }
  stats.rateCards = n;
  stats.brokerFeeSplitCards = feeSplitCards;
}

// ---------------------------------------------------------------------------
const LEAVE_CODE_MAP: Record<string, LeaveCode> = {
  RD: "RD",
  AL: "AL",
  SL: "SL",
  NL: "NL",
  SH: "SH",
  NPL: "NL", // 知會：NPL＝NL
  OFF: "RD", // 知會：OFF＝RD
};

async function seedShiftRecords(
  siteIdMap: Map<string, string>,
  shiftTypeIdMap: Map<string, string>,
  guardIdMap: Map<string, string>,
  brokerIdMap: Map<string, string>,
) {
  type Row = {
    shift_id: string;
    work_date: string;
    site_id: string;
    sub_site: string;
    shift_type_id: string;
    guard_id: string;
    settlement_unit: string;
    broker_id: string;
    settlement_page: string;
    master_broker_code: string;
    master_broker_source: string;
    referral_broker: string;
    referral_fee_snapshot: string;
    source: string;
    roster_broker_code: string;
    record_type: string;
    leave_code: string;
    ot_hours: string;
    parent_shift_id: string;
    is_external: string;
    out_of_scope: string;
    location_tag: string;
    provenance_file: string;
    provenance_cell: string;
    payroll_ref: string;
  };
  type PricedRow = {
    shift_id: string;
    client_rate_snapshot: string;
    guard_wage_snapshot: string;
    broker_fee_snapshot: string;
  };
  type RateCardRow = {
    site_id: string;
    shift_type_id: string;
    broker_id: string;
    guard_id: string;
    client_rate: string;
    guard_wage: string;
    broker_fee: string;
  };
  type GuardRow = { guard_id: string; name_zh: string };

  const rows = readCsv<Row>(CSV.shiftRecords);
  const pricedRows = readCsv<PricedRow>(CSV.shiftRecordsPriced);
  const pricedMap = new Map(pricedRows.map((p) => [p.shift_id, p]));
  const guardNameByCsvId = new Map(readCsv<GuardRow>(CSV.guards).map((g) => [g.guard_id, g.name_zh]));
  // PDPO 裁定：settlement_unit（真名）→ broker_csv_id 對照喺 runtime
  // 合埋讀（見 mapping.ts 頂註解），唔再係 git-tracked 嘅靜態 object。
  const settlementUnitMap = settlementUnitToBrokerCsvId();
  // P1-WP4：雞頭費拆分（見 lib/broker-fee-split.ts）要用嘅對照表同規則。
  const brokerKindByCsvId = loadBrokerKindByCsvId();
  const siteCanonicalNameByCsvId = loadSiteCanonicalNameByCsvId();
  const feeRules = brokerFeeRules();
  let brokerFeeSplitRecords = 0;

  // Gate（規劃裁定，Opus 對抗式驗收第三輪）：CSV 入面每個 distinct
  // settlement_unit／master_broker_code 都要 map 到一個已知 broker，或者
  // 係已經記錄喺案嘅「已知冇對應 broker」例外——唔准靜默跌返 null。執到
  // 未登記嘅新值即刻 throw 中止 seed，逼人手覆核／登記新雞頭，唔會產生
  // 「睇落 seed 成功，但其實個 broker link 靜靜哋漏咗」嘅假象。
  // B2：呢個 Set 嘅內容（可能含真實承辦商公司名）由 gitignored 嘅
  // data/mappings-private/seed-overrides.json 讀入，唔喺呢度硬編碼
  // （見 scripts/seed/lib/seed-overrides.ts 頂註解）。
  const KNOWN_UNMAPPED_SETTLEMENT_UNITS = new Set<string>(knownUnmappedSettlementUnits());
  const KNOWN_UNMAPPED_MASTER_BROKER_CODES = new Set<string>([
    "LT", // 長工桶，冇 wp5 總表覆蓋，operational_broker_id 跌返用 settlement_unit（見下面 item 1 註解）。
  ]);
  // B2(c)（Opus 對抗式驗收第四輪）：throw 訊息本身唔准印 settlement_unit
  // 呢類可能含真名嘅值出嚟（就算淨係印落 console/CI log，都算「真名跑咗
  // 出去唔喺 gitignored 範圍」）——只印代號／數量，詳細清單（含真名）
  // 寫去 gitignored 嘅 out/seed-unmapped.txt，開發者自己開嚟睇。
  const UNMAPPED_DETAIL_FILE = path.resolve(process.cwd(), "out", "seed-unmapped.txt");
  function writeUnmappedDetailAndThrow(kind: string, values: string[], guidance: string): never {
    fs.mkdirSync(path.dirname(UNMAPPED_DETAIL_FILE), { recursive: true });
    const existing = fs.existsSync(UNMAPPED_DETAIL_FILE) ? fs.readFileSync(UNMAPPED_DETAIL_FILE, "utf-8") : "";
    fs.writeFileSync(
      UNMAPPED_DETAIL_FILE,
      `${existing}[${new Date().toISOString()}] ${kind}：${values.map((v) => `「${v}」`).join("、")}\n`,
    );
    throw new Error(`seed 中止：${kind} ${values.length} 個未對應嘅 broker，詳情見 ${path.relative(process.cwd(), UNMAPPED_DETAIL_FILE)}（gitignored）。${guidance}`);
  }
  const distinctSettlementUnits = new Set(rows.map((r) => str(r.settlement_unit)).filter((v): v is string => v !== null));
  const unmappedSettlementUnits = [...distinctSettlementUnits].filter(
    (unit) => !settlementUnitMap[unit] && !KNOWN_UNMAPPED_SETTLEMENT_UNITS.has(unit),
  );
  if (unmappedSettlementUnits.length) {
    writeUnmappedDetailAndThrow(
      "settlement_unit",
      unmappedSettlementUnits,
      "需要人手覆核（登記入 data/mappings-private/brokers.csv 或者 scripts/seed/lib/mapping.ts 嘅 SAFE_SETTLEMENT_UNIT_TO_BROKER_CSV_ID，或者加入 KNOWN_UNMAPPED_SETTLEMENT_UNITS）先可以再 seed。",
    );
  }
  const distinctMasterBrokerCodes = new Set(rows.map((r) => str(r.master_broker_code)).filter((v): v is string => v !== null));
  const unmappedMasterBrokerCodes = [...distinctMasterBrokerCodes].filter(
    (code) => !(code in MASTER_BROKER_CODE_TO_BROKER_CSV_ID) && !KNOWN_UNMAPPED_MASTER_BROKER_CODES.has(code),
  );
  if (unmappedMasterBrokerCodes.length) {
    writeUnmappedDetailAndThrow(
      "master_broker_code",
      unmappedMasterBrokerCodes,
      "需要人手覆核（登記入 scripts/seed/lib/mapping.ts 嘅 MASTER_BROKER_CODE_TO_BROKER_CSV_ID，或者加入 KNOWN_UNMAPPED_MASTER_BROKER_CODES）先可以再 seed。",
    );
  }

  // 規劃 session 裁定（2026-09-11，item 4）：shift_id 對唔到 priced snapshot
  // 嗰陣（例：啟航1331 Event Guard 4 條、LINK C7 細盤啲 payroll-rows.csv
  // 逐人價），由 rate_cards.csv 補價，唔准留 null。兩層索引：(a) 通用卡
  // （guard_id 留空，keyed by site/shift_type/broker）；(b) 人專屬卡
  // （LINK C7 嗰批冇 shift_type_id、keyed by site/broker/guard），(a) 搵唔
  // 到先試 (b)。
  const rateCardRows = readCsv<RateCardRow>(CSV.rateCards);
  const rateCardIndex = new Map<string, RateCardRow>();
  const guardSpecificRateCardIndex = new Map<string, RateCardRow>();
  for (const rc of rateCardRows) {
    if (str(rc.guard_id)) {
      const gkey = `${rc.site_id}|${rc.broker_id}|${rc.guard_id}`;
      if (!guardSpecificRateCardIndex.has(gkey)) guardSpecificRateCardIndex.set(gkey, rc);
      continue;
    }
    const key = `${rc.site_id}|${rc.shift_type_id}|${rc.broker_id}`;
    if (!rateCardIndex.has(key)) rateCardIndex.set(key, rc);
  }
  function fallbackRateCard(siteId: string, shiftTypeId: string, brokerId: string, guardCsvId: string): RateCardRow | undefined {
    return (
      rateCardIndex.get(`${siteId}|${shiftTypeId}|${brokerId}`) ??
      rateCardIndex.get(`${siteId}|${shiftTypeId}|`) ??
      guardSpecificRateCardIndex.get(`${siteId}|${brokerId}|${guardCsvId}`)
    );
  }

  // 規劃 session 第三輪 item 2：wp2b/shift_records.csv 嘅 settlement_page
  // 欄淨係填咗紙本糧單頁（部分雞頭嘅紙本代號），冇紙本頁但由 wp5 總表
  // 確認/補入庫嘅記錄（P0 自己嘅 out/wp3/reports/payroll/*.xlsx 有另外
  // 「總表確認-K/LT/W/Y」「總表補入庫-S012/S031/S032/S034/S038/S041/S042」
  // 呢類 sheet）呢個欄留空——由 master_broker_source 反推返嗰個 sheet 名，
  // 令 DB 逐頁分組同 P0 regen 輸出嘅 sheet 名一一對應（實證：
  // master_roster_only 嘅 site 分佈同 P0 嘅 7 個「總表補入庫」sheet 完全
  // 一致；rule0.1/rule0.2 嘅 master_broker_code 同 P0 嘅 4 個「總表確認」
  // sheet 完全一致）。
  function resolveSettlementPage(r: Row): string | null {
    const raw = str(r.settlement_page);
    if (raw) return raw;
    if (r.master_broker_source === "master_roster_only") return `總表補入庫-${r.site_id}`;
    if ((r.master_broker_source === "rule0.1" || r.master_broker_source === "rule0.2") && str(r.master_broker_code)) {
      return `總表確認-${r.master_broker_code}`;
    }
    return null;
  }

  // P1-執行計劃.md §3：record_type enum 唔含 pointer（指針格唔入庫，例如
  // 數碼港「數據中心」指針格——嗰個更次已經喺數據中心更表計咗一次）
  const usable = rows.filter((r) => r.record_type !== "pointer");
  stats.shiftRecordsSourceTotal = rows.length;
  stats.shiftRecordsPointerExcluded = rows.length - usable.length;

  const keyOf = (guardId: string, workDate: string, shiftTypeId: string) => `${guardId}|${workDate}|${shiftTypeId}`;
  const seen = new Map<string, string>(); // key -> csv shift_id 已入嘅嗰條
  const csvIdToDbId = new Map<string, string>();
  const cloneCounters = new Map<string, number>(); // origGuardDbId -> 下一個 clone 編號
  let merged = 0;
  let cloned = 0;
  let operationalNeSettlement = 0;

  for (const r of usable) {
    const guardId = guardIdMap.get(r.guard_id);
    const siteId = siteIdMap.get(r.site_id);
    const shiftTypeId = shiftTypeIdMap.get(r.shift_type_id);
    if (!guardId || !siteId || !shiftTypeId) {
      throw new Error(`shift_records.csv 有未解析嘅 FK: ${JSON.stringify(r)}`);
    }

    // item 1：settlement_broker_id ← settlement_unit；operational_broker_id ←
    // master_broker_code（K/W/Y/T/D/G→對應 broker；LT／空白→跌返用 settlement）
    const settlementCsvId = settlementUnitMap[r.settlement_unit];
    const operationalCsvId = MASTER_BROKER_CODE_TO_BROKER_CSV_ID[r.master_broker_code] ?? settlementCsvId;
    const settlementBrokerId = settlementCsvId ? brokerIdMap.get(settlementCsvId) ?? null : null;
    const operationalBrokerId = operationalCsvId ? brokerIdMap.get(operationalCsvId) ?? null : null;
    if (settlementBrokerId !== operationalBrokerId) operationalNeSettlement++;

    const priced = pricedMap.get(r.shift_id);
    let clientRateSnapshot = priced ? num(priced.client_rate_snapshot) : null;
    let guardWageSnapshot = priced ? num(priced.guard_wage_snapshot) : null;
    let brokerFeeSnapshot = priced ? num(priced.broker_fee_snapshot) : null;
    // item 4：對唔到 snapshot 就由 rate_cards 補價（唔准留 null；搵唔到就係
    // 真係冇對應價卡——例如長工 autopay 冇逐更工資概念，繼續留 null 係啱嘅）
    // 規劃 session 第三輪 item 2 裁定：out_of_scope（LINK C7）嘅 shift_records
    // 喺 P0 自己嘅 wp3_pricing cascade 都刻意唔補價（rate_cards 雖然有證據，
    // 但「只記錄證據唔入shift_records_priced」——P0 自己重出嘅糧明細 xlsx
    // 逐頁 Total 都印住 $0，唔係佢漏咗）。WP1 fallback 要跟返同一刀切，
    // 唔可以幫 out_of_scope 補到價，否則會同 P0 regen 輸出唔一致。
    // Opus 驗收 item 2：fallback 仲要淨係喺 record_type==='shift' 先用——
    // leave（出勤狀態）同 ot（超時，掛靠正更）根本冇「呢更嘅收客/出街價」
    // 呢個概念，冇 priced snapshot 屬正常（leave 冇更次概念；OT 應該按鐘
    // 計＝shift rate÷hours×ot_hours，呢個計法留返 WP4 先做），唔可以用
    // 正更嘅 rate_cards 卡幫佢哋假補一個價，之前套用咗會整出 35 條 leave
    // ＋6 條 OT 嘅假價。
    if (
      r.record_type === "shift" &&
      !bool(r.out_of_scope) &&
      (clientRateSnapshot === null || guardWageSnapshot === null || brokerFeeSnapshot === null)
    ) {
      const fb = fallbackRateCard(r.site_id, r.shift_type_id, settlementCsvId ?? "", r.guard_id);
      if (fb) {
        if (clientRateSnapshot === null) clientRateSnapshot = num(fb.client_rate);
        if (guardWageSnapshot === null) guardWageSnapshot = num(fb.guard_wage);
        if (brokerFeeSnapshot === null) brokerFeeSnapshot = num(fb.broker_fee);
      }
    }

    // P1-WP4：老闆 2026-09-13 批准嘅雞頭費率——settlement broker 有登記、
    // 呢條係正更 snapshot（record_type=shift）、guard_wage_snapshot 有值、
    // broker_fee_snapshot 空／0 嘅「合計 snapshot」拆做 guard_wage_snapshot/
    // broker_fee_snapshot，出街價（兩者之和）保持不變。leave／OT 冇「呢更
    // 出街價」呢個概念，同上面 item 4 fallback 一樣唔拆。
    if (r.record_type === "shift") {
      const split = applyBrokerFeeSplit(feeRules, {
        brokerCsvId: settlementCsvId ?? null,
        brokerKind: settlementCsvId ? brokerKindByCsvId.get(settlementCsvId) ?? null : null,
        siteCanonicalName: siteCanonicalNameByCsvId.get(r.site_id) ?? null,
        guardWage: guardWageSnapshot,
        brokerFee: brokerFeeSnapshot,
      });
      if (split.split) {
        guardWageSnapshot = split.guardWage;
        brokerFeeSnapshot = split.brokerFee;
        brokerFeeSplitRecords++;
      }
    }

    const key = keyOf(guardId, r.work_date, shiftTypeId);

    const provenance = {
      orig_shift_id: r.shift_id,
      file: str(r.provenance_file),
      cell: str(r.provenance_cell),
      payroll_ref: str(r.payroll_ref),
      settlement_unit: str(r.settlement_unit),
      settlement_page: str(r.settlement_page),
      master_broker_code: str(r.master_broker_code),
      master_broker_source: str(r.master_broker_source),
      referral_broker: str(r.referral_broker),
      roster_broker_code: str(r.roster_broker_code),
      sub_site: str(r.sub_site),
      out_of_scope: bool(r.out_of_scope),
    };

    const isExternal = bool(r.is_external);
    const outOfScope = bool(r.out_of_scope);
    const buildData = (assignGuardId: string) => ({
      workDate: dateOnly(r.work_date)!,
      siteId,
      shiftTypeId,
      guardId: assignGuardId,
      settlementBrokerId,
      operationalBrokerId,
      settlementPage: resolveSettlementPage(r),
      referralFeeSnapshot: num(r.referral_fee_snapshot),
      recordType: r.record_type as RecordType,
      leaveCode: r.leave_code ? LEAVE_CODE_MAP[r.leave_code] ?? null : null,
      otHours: num(r.ot_hours),
      locationTag: str(r.location_tag),
      isExternal,
      billed: !outOfScope && !isExternal,
      paid: !outOfScope && !isExternal,
      clientRateSnapshot,
      guardWageSnapshot,
      brokerFeeSnapshot,
      source: str(r.source),
      provenance,
      createdBy: "seed:wp2b/shift_records.csv+wp3/shift_records_priced.csv+wp3/rate_cards.csv(fallback)",
    });

    if (seen.has(key)) {
      const existingDbId = csvIdToDbId.get(seen.get(key)!)!;
      const guardName = guardNameByCsvId.get(r.guard_id) ?? "";
      if (guardName.includes("臨時工")) {
        // item 5：發票反推嘅匿名「臨時工」placeholder guard 撞 key（例：
        // SOGO CWB 7/21 兩張發票行）唔准合併——clone 一個新嘅 placeholder
        // guard（臨時工-N）先至可以保住兩條記錄，更數先對得返發票。
        cloned++;
        const n = (cloneCounters.get(guardId) ?? 1) + 1;
        cloneCounters.set(guardId, n);
        const clone = await prisma.guard.create({
          data: {
            nameZh: `${guardName}-${n}`,
            employmentType: "cash_casual",
            createdBy: "seed:wp2b/shift_records.csv(臨時工撞key clone，規劃session item5)",
          },
        });
        const created = await prisma.shiftRecord.create({ data: buildData(clone.id) });
        csvIdToDbId.set(r.shift_id, created.id);
        continue;
      }
      // 唔係 placeholder：真人撞 key 屬於異常，merge 落第一條並喺 provenance
      // 記低第二條嘅來源，唔會靜靜咁丟失資料（防手誤／防資料重複嘅安全網）
      merged++;
      const existing = await prisma.shiftRecord.findUniqueOrThrow({ where: { id: existingDbId } });
      const prov = (existing.provenance as Record<string, unknown>) ?? {};
      const mergedList = Array.isArray(prov.merged_duplicates) ? (prov.merged_duplicates as unknown[]) : [];
      mergedList.push(provenance);
      await prisma.shiftRecord.update({
        where: { id: existingDbId },
        data: { provenance: JSON.parse(JSON.stringify({ ...prov, merged_duplicates: mergedList })) },
      });
      csvIdToDbId.set(r.shift_id, existingDbId);
      continue;
    }

    const created = await prisma.shiftRecord.create({ data: buildData(guardId) });
    seen.set(key, r.shift_id);
    csvIdToDbId.set(r.shift_id, created.id);
  }

  // 第二輪：補 parent_shift_id（OT 掛靠正更）
  let parentLinked = 0;
  for (const r of usable) {
    if (str(r.parent_shift_id)) {
      const childDbId = csvIdToDbId.get(r.shift_id);
      const parentDbId = csvIdToDbId.get(r.parent_shift_id);
      if (childDbId && parentDbId && childDbId !== parentDbId) {
        await prisma.shiftRecord.update({ where: { id: childDbId }, data: { parentShiftId: parentDbId } });
        parentLinked++;
      }
    }
  }

  stats.shiftRecords = csvIdToDbId.size - merged; // distinct DB rows（merged 唔重複計；clone 唔合併所以照計）
  stats.shiftRecordsMergedDuplicates = merged;
  stats.shiftRecordsClonedPlaceholderGuards = cloned;
  stats.shiftRecordsParentLinked = parentLinked;
  stats.shiftRecordsOperationalNeSettlement = operationalNeSettlement;
  stats.brokerFeeSplitRecords = brokerFeeSplitRecords;
}

// ---------------------------------------------------------------------------
async function seedDailyRequirements(siteIdMap: Map<string, string>, shiftTypeIdMap: Map<string, string>) {
  type Row = { site_id: string; shift_type_id: string; work_date: string; headcount_required: string };
  const rows = readCsv<Row>(CSV.dailyRequirements);
  let n = 0;
  let conflicts = 0;
  let skipped = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    const siteId = siteIdMap.get(r.site_id);
    const shiftTypeId = shiftTypeIdMap.get(r.shift_type_id);
    if (!siteId || !shiftTypeId) {
      skipped++;
      continue;
    }
    const workDate = dateOnly(r.work_date)!;
    const key = `${siteId}|${shiftTypeId}|${r.work_date}`;
    // 源頭 CSV 有 31 個 (site,shift_type,work_date) 撞key（同一份更表入面兩個
    // 唔同 sub-block 各自嘅「所需人手」統計行畀咗唔同數——見 WP1 回報已知落差）。
    // 策略：以最後出現嘅一行為準（upsert），唔靜靜咁掉資料，用 conflicts 計數。
    if (seen.has(key)) conflicts++;
    seen.add(key);
    await prisma.dailyRequirement.upsert({
      where: { siteId_shiftTypeId_workDate: { siteId, shiftTypeId, workDate } },
      create: {
        siteId,
        shiftTypeId,
        workDate,
        headcountRequired: Number(r.headcount_required) || 0,
        createdBy: "seed:wp2b/daily_requirements.csv",
      },
      update: {
        headcountRequired: Number(r.headcount_required) || 0,
      },
    });
    n++;
  }
  stats.dailyRequirements = n - conflicts;
  stats.dailyRequirementsConflicts = conflicts;
  // Opus 驗收細嘢：CSV 有幾行嘅 site_id/shift_type_id 喺 siteIdMap/
  // shiftTypeIdMap 度冇對應（wp2b 嘅 daily_requirements.csv 同 sites.csv/
  // shift_types.csv 之間有極少數唔同步嘅孤兒行）——之前靜靜 continue 咗，
  // 而家如實計數同回報，唔會扮冇發生過。
  stats.dailyRequirementsSkipped = skipped;
}

// ---------------------------------------------------------------------------
async function seedReferralFeeRates(siteIdMap: Map<string, string>, brokerIdMap: Map<string, string>) {
  type Row = { broker_id: string; site_id: string; rate_per_shift: string; note: string };
  const rows = readCsv<Row>(CSV.referralFeeRates);
  const month = dateOnly("2026-07-01")!;
  let n = 0;
  for (const r of rows) {
    const brokerId = brokerIdMap.get(r.broker_id);
    if (!brokerId) continue;
    // 規劃 session 裁定（item 2）：site_id="DEFAULT" = 該雞頭全盤預設費率，
    // schema 已經改咗 nullable，seedSite_id=null；有真實 site_id 嘅行覆蓋預設。
    const siteId = r.site_id === "DEFAULT" ? null : siteIdMap.get(r.site_id);
    if (r.site_id !== "DEFAULT" && !siteId) continue;
    await prisma.referralFeeRate.create({
      data: {
        brokerId,
        siteId,
        month,
        feePerShift: num(r.rate_per_shift) ?? 0,
        createdBy: "seed:mappings/referral_fee_rates.csv",
      },
    });
    n++;
  }
  stats.referralFeeRates = n;
}

// ---------------------------------------------------------------------------
// special_items：P1-執行計劃.md 工作包 C 逐項列明嘅 7 月特殊項
// （金額嚟自 P0-執行計劃.md §8 D3／N5／Q10 已老闆確認嘅數字，唔係猜測）
async function seedSpecialItems(siteIdMap: Map<string, string>) {
  const month = dateOnly("2026-07-01")!;
  const S = (name: string) => siteIdMap.get(name);
  const items: Array<{
    siteCsvId?: string;
    kind: "standalone_broker_fee" | "individual_broker_event" | "supplemental" | "other";
    shifts?: number;
    revenue?: number;
    cost?: number;
    description: string;
  }> = [
    {
      siteCsvId: "S006", // HKU Y更
      kind: "standalone_broker_fee",
      shifts: 94,
      revenue: 84600,
      cost: 69200,
      description:
        "獨立雞頭費——HKU Y更下半月5人散Event（老闆2026-09-10確認係散更/活動性質，唔屬任何雞頭）。維持盤級調整，唔拆逐人shift_records（P0-執行計劃§8 N2/N2a）。",
    },
    {
      siteCsvId: "S064", // HKW（個別雞頭 Event 客戶）
      kind: "individual_broker_event",
      revenue: 15000,
      cost: 2872,
      description: "Tenti 保鏢——個別雞頭 Event 特殊收入項（P0-執行計劃§8 D3）。",
    },
    {
      siteCsvId: "S064",
      kind: "individual_broker_event",
      revenue: 34020,
      cost: 5116,
      description: "HKW 展覽——個別雞頭 Event 特殊收入項（P0-執行計劃§8 D3）。",
    },
    {
      siteCsvId: "S043", // 龍譽
      kind: "supplemental",
      shifts: 0,
      revenue: 800,
      description: "龍譽補單——發票 MW-2026-07042，冇更表冇糧單來源，只記總額（P0-執行計劃§2 B4）。",
    },
    {
      siteCsvId: "S044", // 惠康貨倉
      kind: "supplemental",
      shifts: 0,
      revenue: 780,
      description: "惠康補單——發票 MW-2026-07043，冇更表冇糧單來源，只記總額（P0-執行計劃§2 B4）。",
    },
    {
      kind: "other",
      cost: 23620,
      description:
        "BOCHK small tier 19人——特別中特別嘅更，老闆指示（2026-09-10）唔使理，唔對更表唔拆盤，只記cost（P0-執行計劃§8 N5）。",
    },
    {
      siteCsvId: "S064",
      kind: "individual_broker_event",
      cost: 20000,
      description: "個別雞頭本人 7 月薪金（cost only，非更次制，P0-執行計劃§8 D3）。",
    },
  ];

  let n = 0;
  for (const it of items) {
    await prisma.specialItem.create({
      data: {
        month,
        siteId: it.siteCsvId ? S(it.siteCsvId) ?? null : null,
        kind: it.kind,
        shifts: it.shifts ?? null,
        revenue: it.revenue ?? null,
        cost: it.cost ?? null,
        description: it.description,
        createdBy: "seed:P1-執行計劃.md工作包C",
      },
    });
    n++;
  }
  stats.specialItems = n;
}

// ---------------------------------------------------------------------------
// P1-WP4（規劃裁定，2026-09-12）：長工雞頭費（referral fee）——由
// scripts/seed/lib/py/extract_referral_fees.py（透過
// tools/importer/venv 行 P0 code `master_roster.validate_referral_fee_
// rates()`，唔改 P0 code）攞返老闆已核實嘅費用行金額，逐
// (broker_id, block) seed 做 special_items（kind=referral_fee，cost=
// 金額）。冇 venv／master roster xlsx 嗰種環境（CI／未授權機器）就
// fail-soft 跳過（唔 throw，同 roster_layout 呢類 P1-WP3 已有慣例一致）。
async function seedReferralFeeSpecialItems(siteIdMap: Map<string, string>, brokerIdMap: Map<string, string>) {
  const payload = loadReferralFees();
  if (!payload || !payload.by_broker_block) {
    stats.referralFeeSpecialItems = 0;
    stats.referralFeeSpecialItemsSkippedNoVenv = 1;
    return;
  }
  const month = dateOnly("2026-07-01")!;
  let n = 0;
  let unattributed = 0;
  for (const row of payload.by_broker_block) {
    const brokerId = brokerIdMap.get(row.broker_id);
    if (!brokerId) continue;
    const siteCsvId = siteCsvIdForBlock(row.block);
    const siteId = siteCsvId ? (siteIdMap.get(siteCsvId) ?? null) : null;
    if (!siteId) unattributed++;
    await prisma.specialItem.create({
      data: {
        month,
        siteId,
        brokerId,
        kind: "referral_fee",
        cost: num(row.amount),
        description: `長工雞頭費——${row.block}（P0 在勤總表已核實，見 out/referral-fees.json；scripts/seed/lib/py/extract_referral_fees.py 由 master_roster.validate_referral_fee_rates() 攞）`,
        createdBy: "seed:master_roster.validate_referral_fee_rates()(via tools/importer/venv)",
      },
    });
    n++;
  }
  stats.referralFeeSpecialItems = n;
  stats.referralFeeSpecialItemsUnattributedSite = unattributed;
}

// ---------------------------------------------------------------------------
// 規劃 session 第三輪 item 3：跨月調整（例：某雞頭頁「扣 Weave 醫院道
// 17/6 一更」-800；某雞頭-1331 頁「補6月1331早IC」+750／「扣HKU長工7月」
// -24150，真名見 P1-執行計劃.md 本身，呢個檔案唔重複）由
// data/2026-07/transcribed/adjustments.csv 逐行讀入（note 含「跨月」
// 就係），入 special_items kind=cross_month_adjustment，broker 掛
// settlement_unit 對應嘅雞頭（搵唔到就 null）。全部 runtime 由 CSV 讀，
// 呢個檔案本身唔含任何真名（金額/代號淨係數字）。
async function seedCrossMonthAdjustments(brokerIdMap: Map<string, string>) {
  if (!fs.existsSync(CSV.adjustments)) {
    stats.crossMonthAdjustments = 0;
    return;
  }
  type Row = { settlement_unit: string; description: string; amount: string; note: string };
  const rows = readCsv<Row>(CSV.adjustments);
  const month = dateOnly("2026-07-01")!;
  const settlementUnitMap = settlementUnitToBrokerCsvId();
  let n = 0;
  for (const r of rows) {
    if (!r.note.includes("跨月")) continue;
    const brokerCsvId = settlementUnitMap[r.settlement_unit];
    await prisma.specialItem.create({
      data: {
        month,
        brokerId: brokerCsvId ? brokerIdMap.get(brokerCsvId) ?? null : null,
        kind: "cross_month_adjustment",
        cost: num(r.amount),
        description: `${r.description}（${r.note}）`,
        createdBy: "seed:data/2026-07/transcribed/adjustments.csv",
      },
    });
    n++;
  }
  stats.crossMonthAdjustments = n;
}

// ---------------------------------------------------------------------------
// Opus 驗收 C1：broker_site_assignments 白名單——雞頭喺邊個盤邊個月有份，
// 唔再淨係靠「有冇更次」判斷（嗰個係漏洞）。quotas 表 P3 先做，P1 由 7 月
// 真實 shift_records 嘅 settlement/operational broker × site × 月份反推
// 生成（settlement 同 operational 唔同嗰啲——Q10 雙重支付個案——兩個
// broker 都算佢有份，長工掛雞頭桶嗰啲 settlement=operational=雞頭本身
// 就會生成一行）。
// S8（Opus 對抗式驗收）：淨係由 **operational** broker 反推（唔再連
// settlement 都計）——operational_broker_id 先係「總表成本桶」，即係
// 邊個雞頭實際負責呢個盤嘅營運；settlement_broker_id 淨係「邊個出糧」，
// 兩者喺 Q10 雙重支付個案會唔同，但「呢個雞頭喺呢個盤有份」呢個歸屬
// 判斷應該跟操作桶，唔跟出糧桶（一個純粹幫手出糧但冇實際帶呢個盤嘅
// 雞頭，唔應該因為咁就拎到成個盤嘅可見性/寫入權）。
async function seedBrokerSiteAssignments() {
  const rows = await prisma.shiftRecord.findMany({
    where: { operationalBrokerId: { not: null } },
    select: { siteId: true, workDate: true, operationalBrokerId: true },
  });
  const seen = new Set<string>();
  const assignments: Array<{ brokerId: string; siteId: string; month: Date }> = [];
  for (const r of rows) {
    const brokerId = r.operationalBrokerId!;
    const month = new Date(Date.UTC(r.workDate.getUTCFullYear(), r.workDate.getUTCMonth(), 1));
    const key = `${brokerId}|${r.siteId}|${month.toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assignments.push({ brokerId, siteId: r.siteId, month });
  }

  // S6：seed 預設同時生成 2026-08 = 2026-07 複本，等雞頭喺（未鎖定嘅）
  // 8 月已經有 broker_site_assignments 可以即刻開更試用，唔使人手補
  // 資料先至有得試（C1 嘅 regression test 應該用 8 月呢類開放月，唔係
  // 人手補數據——見 tests/wp2-c1-guard-attribution.test.ts）。
  const augustCopies: typeof assignments = [];
  for (const a of assignments) {
    if (a.month.getUTCFullYear() === 2026 && a.month.getUTCMonth() === 6) {
      augustCopies.push({ brokerId: a.brokerId, siteId: a.siteId, month: new Date(Date.UTC(2026, 7, 1)) });
    }
  }
  const all = [...assignments, ...augustCopies];

  if (all.length) {
    await prisma.brokerSiteAssignment.createMany({
      data: all.map((a) => ({ ...a, createdBy: "seed:derived-from-shift_records-operational-broker(S6/S8)" })),
      skipDuplicates: true,
    });
  }
  stats.brokerSiteAssignments = assignments.length;
  stats.brokerSiteAssignmentsAugustRollover = augustCopies.length;
}

// ---------------------------------------------------------------------------
async function seedMonthClose() {
  await prisma.monthClose.create({
    data: {
      month: dateOnly("2026-07-01")!,
      lockedAt: new Date("2026-09-11T00:00:00Z"),
      lockedBy: "seed:老闆2026-09-11指示",
      rosterVersionNote: "P0 老闆問題全部清零（2026-09-11），7 月鎖定入庫。數碼港 CP1-4 用 Google Sheet 最終版取代 27.07 舊版。",
      createdBy: "seed:P0-執行計劃.md §8",
    },
  });
  stats.monthCloses = 1;
}

// ---------------------------------------------------------------------------
// WP2：module × action 權限矩陣（10 module × 5 action = 50 permission）
// + 5 個預設角色 + 逐格 role_permissions（來源：src/lib/rbac/matrix.ts，
// 同設計文件§5.0/§5.1 一一對應，見嗰個檔案內逐行註解）。
//
// 「✗」＝硬性禁止：呢度**唔生成**嗰行 role_permission（連 granted=false
// 都冇），配合 requirePermission() 嘅 runtime hard-deny check，做到
// 「程式層唔存在呢個組合」。
async function seedRbacScaffold() {
  const result = await seedRolesPermissionsMatrix(prisma, "seed:src/lib/rbac/matrix.ts（設計文件§5）");
  stats.permissions = result.stats.permissions;
  stats.roles = result.stats.roles;
  stats.rolePermissions = result.stats.rolePermissionsGranted + result.stats.rolePermissionsOffByDefault;
  stats.rolePermissionsGranted = result.stats.rolePermissionsGranted;
  stats.rolePermissionsOffByDefault = result.stats.rolePermissionsOffByDefault;
  stats.rolePermissionsHardDeniedNoRow = result.stats.rolePermissionsHardDeniedNoRow;
  return result.roleIds;
}

// ---------------------------------------------------------------------------
// WP2：測試帳號（假電話號碼 9000000x，PDPO：唔係真人；密碼見 .env.example）。
// 雞頭 A/B 掛 broker_id＝B01／B02（代號，唔係真名——PDPO 裁定：雞頭
// 真名唔入 git，一律用代號 K/W/G/D/T/Y 等；真名對照見 gitignored 嘅
// data/mappings-private/brokers.csv）。真人帳號等老闆 D-P1-1 名單，見
// P1-執行計劃.md §5。
async function seedUsers(roleIds: Record<string, string>, brokerIdMap: Map<string, string>) {
  const accounts: Array<{ tel: string; name: string; password: string; roleName: (typeof ROLE_NAMES)[number]; brokerCsvId?: string }> = [
    { tel: "90000001", name: "測試老闆", password: "Passw0rd1", roleName: "老闆" },
    { tel: "90000002", name: "測試主管", password: "Passw0rd2", roleName: "主管" },
    { tel: "90000003", name: "測試會計", password: "Passw0rd3", roleName: "會計" },
    { tel: "90000004", name: "測試雞頭A", password: "Broker0004", roleName: "雞頭", brokerCsvId: "B01" }, // 代號 K
    { tel: "90000005", name: "測試雞頭B", password: "Broker0005", roleName: "雞頭", brokerCsvId: "B02" }, // 代號 W
    { tel: "90000006", name: "測試安員", password: "Guard00006", roleName: "安員" },
  ];
  // D-P1-1（2026-09-12 老闆答）：真人帳號由 gitignored 嘅
  // data/mappings-private/users.json 讀（[{tel,name,role,broker_csv_id?}]），
  // 電話號碼永遠唔入 git。初始密碼隨機生成，寫入同一目錄嘅
  // users-initial-passwords.txt（gitignored），首次登入強制改密碼；
  // 已存在嘅真人帳號重跑 seed 唔會重設密碼（同測試帳號相反）。
  // SEED_SKIP_TEST_ACCOUNTS=1 時唔起假測試帳號（正式環境用）。
  const skipTest = process.env.SEED_SKIP_TEST_ACCOUNTS === "1";
  let n = 0;
  for (const a of skipTest ? [] : accounts) {
    const passwordHash = await bcrypt.hash(a.password, 12);
    const brokerId = a.brokerCsvId ? brokerIdMap.get(a.brokerCsvId) ?? null : null;
    // P1-WP3：upsert（唔係 create）——呢個 user 如果已經有 audit_log
    // 歷史，`clearAll()` 唔會刪佢（append-only FK 擋住），改用 upsert
    // 令重複跑 `npm run db:seed` 永遠得，同時將密碼/角色/broker 重設返
    // 出廠狀態（同 tests/fixtures/wp2-fixture.ts 嘅 resetAuthState()
    // 同一個手法）；bump token_version 令舊 session 全部作廢。
    await prisma.user.upsert({
      where: { tel: a.tel },
      create: {
        name: a.name,
        tel: a.tel,
        passwordHash,
        roleId: roleIds[a.roleName],
        brokerId,
        createdBy: "seed:P1-執行計劃.md工作包WP2-A（假測試帳號）",
      },
      update: {
        name: a.name,
        passwordHash,
        roleId: roleIds[a.roleName],
        brokerId,
        status: "active",
        failedAttempts: 0,
        lockedUntil: null,
        mustChangePwd: false,
        tokenVersion: { increment: 1 },
      },
    });
    n++;
  }
  n += await seedRealUsers(roleIds, brokerIdMap);
  stats.users = n;
}

async function seedRealUsers(roleIds: Record<string, string>, brokerIdMap: Map<string, string>): Promise<number> {
  const file = DATA("mappings-private/users.json");
  if (!fs.existsSync(file)) return 0;
  const rows = JSON.parse(fs.readFileSync(file, "utf-8")) as Array<{ tel: string; name: string; role: string; broker_csv_id?: string }>;
  const pwFile = DATA("mappings-private/users-initial-passwords.txt");
  const lines: string[] = [];
  let created = 0;
  for (const r of rows) {
    if (!/^\d{8}$/.test(r.tel)) throw new Error("users.json：tel 必須係 8 位數字");
    const roleId = roleIds[r.role];
    if (!roleId) throw new Error(`users.json：未知角色 ${r.role}`);
    if (r.role === "雞頭" && !r.broker_csv_id) throw new Error("users.json：雞頭帳號必須有 broker_csv_id");
    const brokerId = r.broker_csv_id ? brokerIdMap.get(r.broker_csv_id) ?? null : null;
    const existing = await prisma.user.findUnique({ where: { tel: r.tel } });
    if (existing) {
      await prisma.user.update({ where: { tel: r.tel }, data: { name: r.name, roleId, brokerId } });
      continue;
    }
    const password = crypto.randomBytes(9).toString("base64url"); // 12 字元
    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.user.create({
      data: { name: r.name, tel: r.tel, passwordHash, roleId, brokerId, mustChangePwd: true, createdBy: "seed:D-P1-1 真人帳號（data/mappings-private/users.json）" },
    });
    lines.push(`${r.name}\t${r.tel}\t${password}\t（首次登入必須改密碼）`);
    created++;
  }
  // 每次只寫該次新建嘅帳號（覆寫，唔 append）——舊行必然已經係無效密碼
  if (lines.length) fs.writeFileSync(pwFile, `# 由 db:seed 於 ${new Date().toISOString()} 生成，交俾本人後刪走\n` + lines.join("\n") + "\n", "utf-8");
  stats.realUsersCreated = created;
  return rows.length;
}

// ---------------------------------------------------------------------------
async function main() {
  const started = Date.now();
  await clearAll();

  const brokerIdMap = await seedBrokers();
  const siteIdMap = await seedSites();
  const shiftTypeIdMap = await seedShiftTypes(siteIdMap);
  const guardIdMap = await seedGuards();
  await seedRateCards(siteIdMap, shiftTypeIdMap, brokerIdMap, guardIdMap);
  await seedShiftRecords(siteIdMap, shiftTypeIdMap, guardIdMap, brokerIdMap);
  await seedBrokerSiteAssignments();
  const backfillStats = await backfillDefaultBrokerId(prisma);
  stats.guardsDefaultBrokerBackfilled = backfillStats.backfilled;
  stats.guardsDefaultBrokerNullNoEvidence = backfillStats.nullNoBrokerKindEvidence;
  await seedDailyRequirements(siteIdMap, shiftTypeIdMap);
  await seedReferralFeeRates(siteIdMap, brokerIdMap);
  await seedReferralFeeSpecialItems(siteIdMap, brokerIdMap);
  await seedSpecialItems(siteIdMap);
  await seedCrossMonthAdjustments(brokerIdMap);
  await seedMonthClose();
  const roleIds = await seedRbacScaffold();
  await seedUsers(roleIds, brokerIdMap);

  // P1-WP3：更表版面模板（sites.roster_layout）——fail-soft（冇
  // data/2026-07/ 或者 wp1/rows.csv 就跳過，唔會令成個 db:seed throw，
  // 見 README-P1.md「data/mappings-private/ 依賴」嗰個慣例）。
  const rosterLayoutResult = await seedRosterLayouts(prisma, siteIdMap, shiftTypeIdMap);
  stats.rosterLayoutsSeeded = rosterLayoutResult.sitesUpdated;
  if (rosterLayoutResult.skippedReason) {
    console.log(`[seed] roster_layout 跳過: ${rosterLayoutResult.skippedReason}`);
  }

  // P1-WP3 第三輪 point B：狀態代號保留原始字面——要喺 roster_layout
  // seed 咗之後先做（要用 site.rosterLayout.layout 揀 labelCol）。
  const leaveCodeRawResult = await enrichLeaveCodeRawText(prisma);
  stats.leaveCodeRawUpdated = leaveCodeRawResult.updated;
  if (leaveCodeRawResult.skippedReason) {
    console.log(`[seed] leave_code_raw 跳過: ${leaveCodeRawResult.skippedReason}`);
  }

  // P1-WP3 Gate 1 階段 1（純加法）：逐個安員行嘅 raw 字面掛落
  // shift_records.provenance.raw_row。
  const rawRowResult = await enrichShiftRecordsWithRawRow(prisma);
  stats.rosterRawRowsWithData = rawRowResult.rowsWithData;
  stats.rosterRawRowsAttached = rawRowResult.rowsAttached;
  stats.rosterRawRecordsUpdated = rawRowResult.recordsUpdated;
  if (rawRowResult.skippedReason) {
    console.log(`[seed] roster_raw_row 跳過: ${rawRowResult.skippedReason}`);
  }

  const path = await import("node:path");
  const outDir = path.resolve(process.cwd(), "out/p1");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "seed-stats.json"), JSON.stringify(stats, null, 2));

  console.log("[seed] 統計:", stats);
  console.log(`[seed] 完成，耗時 ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((err) => {
    console.error("[seed] 失敗", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
