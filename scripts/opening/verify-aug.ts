// WP-AUG-OPENING：verify-aug.ts
// 喺 apply-aug-plan.ts --apply 之後跑，用嚟驗證「8 月開盤資料包」交付
// 效果：
//   (a) 逐個上載 36 個 8 月更表檔案（用 seed 老闆 user），印每檔 site 對
//       到？unmatched_shift_type／ambiguous_shift_type／unmatched_sub_site／
//       guard unmatched 數（目標：前三個 0，guard unmatched 只印數目，
//       唔要求 0——散工資料覆蓋率唔係呢個 WP 範圍）。
//   (b) 對 101 組（price_site_time_broker.json）逐組用
//       resolveShiftPricingFromCards() 計價，同 E／F 比較，印差異清單。
// 跑完刪晒 verify 自己上載嘅 roster_uploads（連 roster_upload_rows 一齊
// cascade），唔留 8 月資料喺 dev DB。
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { processRosterUpload } from "@/lib/roster-upload/service";
import { fetchEffectiveRateCards, resolveShiftPricingFromCards } from "@/lib/pricing/resolve-rate";
import { loadPriceSiteTimeBroker, loadPriceOverrides } from "./lib/sources";
import { SITE_ID_TO_CANONICAL_NAME } from "./lib/site-code-map";

const prisma = new PrismaClient();

const AUG_ROSTERS_DIR = path.resolve(process.cwd(), "data/2026-09/aug-rosters");
const MONTH = new Date("2026-08-01T00:00:00.000Z");
const AS_OF_DATE = new Date("2026-08-15T00:00:00.000Z");

async function verifyUploads() {
  console.log("\n===== (a) 逐個上載 36 個 8 月更表檔案 =====");
  const boss = await prisma.user.findFirst({ where: { role: { name: "老闆" } } });
  if (!boss) throw new Error("搵唔到 seed 老闆 user（role.name='老闆'）——先 npm run db:seed。");

  if (!readFileSyncOk(AUG_ROSTERS_DIR)) {
    console.log(`[verify-aug] ${AUG_ROSTERS_DIR} 唔存在，skip 呢部分（同 gate:roster-parse 一致做法，唔擋 CI/新 clone 環境）。`);
    return { uploadIds: [] as string[], totals: null };
  }
  const files = readdirSync(AUG_ROSTERS_DIR).filter((f) => f.endsWith(".xlsx"));
  console.log(`[verify-aug] 搵到 ${files.length} 個 .xlsx 檔。`);

  const uploadIds: string[] = [];
  let siteUnmatched = 0;
  let totalUnmatchedShiftType = 0;
  let totalAmbiguousShiftType = 0;
  let totalUnmatchedSubSite = 0;
  let totalUnmatchedGuard = 0;
  let totalAmbiguousGuard = 0;

  for (const fileName of files) {
    const buf = readFileSync(path.join(AUG_ROSTERS_DIR, fileName));
    let result;
    try {
      result = await processRosterUpload({ fileBuffer: buf, fileName, month: MONTH, uploaderUserId: boss.id });
    } catch (e) {
      console.log(`  [錯誤] ${fileName}：${(e as Error).message}`);
      continue;
    }
    uploadIds.push(result.upload.id);
    const s = result.upload.parseSummary as null | {
      unmatchedShiftTypeCount?: number;
      ambiguousShiftTypeCount?: number;
      unmatchedSubSiteCount?: number;
      unmatchedGuardCount?: number;
      ambiguousGuardCount?: number;
    };
    const siteMatched = result.upload.siteId !== null;
    if (!siteMatched) siteUnmatched++;
    const ust = s?.unmatchedShiftTypeCount ?? 0;
    const ast = s?.ambiguousShiftTypeCount ?? 0;
    const uss = s?.unmatchedSubSiteCount ?? 0;
    const ug = s?.unmatchedGuardCount ?? 0;
    const ag = s?.ambiguousGuardCount ?? 0;
    totalUnmatchedShiftType += ust;
    totalAmbiguousShiftType += ast;
    totalUnmatchedSubSite += uss;
    totalUnmatchedGuard += ug;
    totalAmbiguousGuard += ag;
    console.log(
      `  ${siteMatched ? "✓" : "✗"} ${fileName}：site${siteMatched ? "已對到" : "未對到"}／unmatched_shift_type=${ust}／ambiguous_shift_type=${ast}／unmatched_sub_site=${uss}／guard unmatched=${ug}／guard ambiguous=${ag}`,
    );
  }

  console.log(`\n[verify-aug] (a) 總計：`);
  console.log(`  site 未對到：${siteUnmatched}／${files.length}（目標 0）`);
  console.log(`  unmatched_shift_type 總格數：${totalUnmatchedShiftType}（目標 0）`);
  console.log(`  ambiguous_shift_type 總格數：${totalAmbiguousShiftType}（目標 0）`);
  console.log(`  unmatched_sub_site 總格數：${totalUnmatchedSubSite}（目標 0）`);
  console.log(`  guard unmatched 總格數：${totalUnmatchedGuard}（只印數目，唔要求 0——散工資料覆蓋率唔係呢個 WP 範圍）`);
  console.log(`  guard ambiguous 總格數：${totalAmbiguousGuard}`);

  return { uploadIds, totals: { siteUnmatched, totalUnmatchedShiftType, totalAmbiguousShiftType, totalUnmatchedSubSite, totalUnmatchedGuard, totalAmbiguousGuard } };
}

function readFileSyncOk(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

async function verifyPricing() {
  console.log("\n===== (b) 101 組價目逐組對 resolver =====");
  const pstb = loadPriceSiteTimeBroker();
  const overrides = loadPriceOverrides();
  // 逐人組（multi_price_groups）嘅 F（guard_wage）唔喺呢個逐組通用 check
  // 度驗（冇通用卡，本身就係逐人卡先啱），落面另外用真實 guard 逐個驗。
  const multiPriceGroupKeys = new Set(overrides.multi_price_groups);
  const sites = await prisma.site.findMany({ select: { id: true, canonicalName: true } });
  const siteIdByName = new Map(sites.map((s) => [s.canonicalName, s.id]));
  const brokers = await prisma.broker.findMany({ select: { id: true, code: true, kind: true } });
  const brokerByCode = new Map(brokers.map((b) => [b.code, b]));
  const shiftTypes = await prisma.shiftType.findMany({ where: { voidedAt: null }, select: { id: true, siteId: true, code: true, startTime: true, endTime: true, billingGroup: true } });

  function parseTimeSlot(slot: string): [string, string] | null {
    const m = slot.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (!m) return null;
    return [`${m[1]}:${m[2]}`, `${m[3]}:${m[4]}`];
  }

  let checked = 0;
  let matched = 0;
  const diffs: string[] = [];
  const noSite: string[] = [];
  const noShiftType: string[] = [];

  const cardsCache = new Map<string, Awaited<ReturnType<typeof fetchEffectiveRateCards>>>();

  for (const [key, entry] of Object.entries(pstb)) {
    const [siteCode, time, brokerCode] = key.split("|");
    const canonicalName = SITE_ID_TO_CANONICAL_NAME[siteCode];
    if (!canonicalName) {
      noSite.push(`${key}（SITE_ID_TO_CANONICAL_NAME 冇 ${siteCode}）`);
      continue;
    }
    const siteId = siteIdByName.get(canonicalName);
    if (!siteId) {
      noSite.push(`${key}（盤「${canonicalName}」dev DB 搵唔到，apply 咗未？）`);
      continue;
    }
    const parsed = parseTimeSlot(time);
    if (!parsed) continue;
    const [start] = parsed;
    // 呢個盤全部 shift_type 都試（唔淨係開工時間夾中嗰啲）——
    // build-aug-plan.ts 對部分盤（例如殷樺花園）刻意跟返更表檔案嘅開工
    // 時間起卡，同總表時段有落差；亦有啲盤（例如都會大學夜巡邏）總表
    // 時段啱好同一個舊 placeholder shift_type（MR-…）撞正開工時間，如果
    // 淨係揀「開工時間夾中」嗰個就會漏咗真正嗰張新卡。逐個試、揀夾得中
    // 嗰個，唔夾中先算差異。
    const candidates = shiftTypes.filter((st) => st.siteId === siteId);
    if (candidates.length === 0) {
      noShiftType.push(`${key}（「${canonicalName}」開工時間 ${start} 搵唔到 shift_type）`);
      continue;
    }
    const broker = brokerByCode.get(brokerCode);
    checked++;

    if (!cardsCache.has(siteId)) {
      cardsCache.set(siteId, await fetchEffectiveRateCards(siteId, new Date("2026-08-01"), new Date("2026-08-31")));
    }
    const cards = cardsCache.get(siteId)!;

    // 逐個候選 shift_type 都試（呢個時段有幾個 shift_type 嘅盤，例如啟航1331
    // 2230-0730 IC/SIC，逐個計，largest match 話咗事就算通過）。
    let bestDiff: string | null = "（冇候選 shift_type 計到）";
    let anyMatched = false;
    for (const st of candidates) {
      const priced = resolveShiftPricingFromCards(cards, {
        siteId,
        shiftTypeId: st.id,
        shiftTypeCode: st.code,
        shiftTypeBillingGroup: st.billingGroup,
        settlementBrokerId: broker?.id ?? null,
        brokerKind: broker?.kind ?? null,
        guardId: "verify-aug-placeholder-guard",
        workDate: AS_OF_DATE,
        isExternal: false,
        recordType: "shift",
      });
      const isMultiPriceGroup = multiPriceGroupKeys.has(key);
      const eKeys = Object.keys(entry.E).map(Number);
      const fKeys = Object.keys(entry.F).map(Number);
      // 恆星樓：build-aug-plan.ts 刻意唔起呢個盤嘅逐更 client 卡（見
      // build-aug-plan.ts 檔頭「例外：恆星樓」註解——嗰組 E 值本身係
      // 「月費÷更數」嘅倒算值，唔係真逐更价），呢度同一個判斷，clientRate
      // 保持 null 屬預期，唔算差異。
      const eOk =
        canonicalName === "恆星樓" ||
        eKeys.length === 0 ||
        eKeys.some((e) => Math.abs(e - (priced.clientRate ?? NaN)) < 0.5) ||
        eKeys.some((e) => e >= 5000); // ≥5000 交俾 site flat 卡，呢度唔會有 shiftType 級 client 卡，屬預期
      // 逐人組（multi_price_groups）冇通用 F 卡係啱嘅設計（逐人卡先有
      // 呢個价）——呢度唔可以當差異，落面 verifyPersonOverrides() 先用
      // 真實 guard 驗。
      const fOk = isMultiPriceGroup || fKeys.length === 0 || fKeys.some((f) => Math.abs(f - (priced.guardWage ?? NaN)) < 0.5);
      if (eOk && fOk) {
        anyMatched = true;
        break;
      }
      bestDiff = `resolver: clientRate=${priced.clientRate} guardWage=${priced.guardWage} vs E=${JSON.stringify(entry.E)} F=${JSON.stringify(entry.F)}（shift_type ${st.code}@${start}）`;
    }
    if (anyMatched) {
      matched++;
    } else {
      diffs.push(`${key}：${bestDiff}`);
    }
  }

  console.log(`[verify-aug] (b) 總計：檢查 ${checked}／101 組，一致 ${matched}，差異 ${diffs.length}`);
  if (noSite.length > 0) {
    console.log(`  盤對唔到（${noSite.length}）：`);
    for (const s of noSite) console.log(`    - ${s}`);
  }
  if (noShiftType.length > 0) {
    console.log(`  shift_type 對唔到（${noShiftType.length}）：`);
    for (const s of noShiftType) console.log(`    - ${s}`);
  }
  if (diffs.length > 0) {
    console.log(`  差異清單（${diffs.length}）：`);
    for (const d of diffs) console.log(`    - ${d}`);
  }
}

async function verifyPersonOverrides() {
  console.log("\n===== (b-補) 8 個逐人卡：用返真實 guard 驗 =====");
  const overrides = loadPriceOverrides();
  const sites = await prisma.site.findMany({ select: { id: true, canonicalName: true } });
  const siteIdByName = new Map(sites.map((s) => [s.canonicalName, s.id]));
  const brokers = await prisma.broker.findMany({ select: { id: true, code: true, kind: true } });
  const brokerByCode = new Map(brokers.map((b) => [b.code, b]));
  const shiftTypes = await prisma.shiftType.findMany({ where: { voidedAt: null }, select: { id: true, siteId: true, code: true, startTime: true, endTime: true, billingGroup: true } });
  function parseTimeSlot(slot: string): [string, string] | null {
    const m = slot.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (!m) return null;
    return [`${m[1]}:${m[2]}`, `${m[3]}:${m[4]}`];
  }

  let checked = 0;
  let matched = 0;
  const diffs: string[] = [];
  for (const [key, v] of Object.entries(overrides.person)) {
    const parts = key.split("|");
    const name = parts[parts.length - 1];
    const [siteCode, time, brokerCode] = parts;
    const canonicalName = SITE_ID_TO_CANONICAL_NAME[siteCode];
    const siteId = canonicalName ? siteIdByName.get(canonicalName) : undefined;
    const guard = siteId ? await prisma.guard.findFirst({ where: { nameZh: name } }) : null;
    const broker = brokerByCode.get(brokerCode);
    if (!siteId || !guard) continue; // 對唔到嘅已經喺 plan 嘅 needsBossReview 度報過，呢度唔再重覆
    const parsed = parseTimeSlot(time);
    if (!parsed) continue;
    const candidates = shiftTypes.filter((st) => st.siteId === siteId);
    if (candidates.length === 0) continue;
    const cards = await fetchEffectiveRateCards(siteId, new Date("2026-08-01"), new Date("2026-08-31"));
    checked++;
    let ok = false;
    let lastPriced = "";
    for (const st of candidates) {
      const priced = resolveShiftPricingFromCards(cards, {
        siteId,
        shiftTypeId: st.id,
        shiftTypeCode: st.code,
        shiftTypeBillingGroup: st.billingGroup,
        settlementBrokerId: broker?.id ?? null,
        brokerKind: broker?.kind ?? null,
        guardId: guard.id,
        workDate: AS_OF_DATE,
        isExternal: false,
        recordType: "shift",
      });
      lastPriced = `guardWage=${priced.guardWage}`;
      if (priced.guardWage !== null && Math.abs(priced.guardWage - v.F) < 0.5) {
        ok = true;
        break;
      }
    }
    if (ok) matched++;
    else diffs.push(`${siteCode}|${time}|<guard>：${lastPriced} vs F=${v.F}`); // 鐵則：唔准印真名，key 最後一截（姓名）用 <guard> 代替
  }
  console.log(`[verify-aug] 逐人卡：檢查 ${checked}／8，一致 ${matched}，差異 ${diffs.length}`);
  for (const d of diffs) console.log(`    - ${d}`);
}

async function cleanup(uploadIds: string[]) {
  console.log("\n===== 清走 verify 自己上載嘅 roster_uploads =====");
  if (uploadIds.length === 0) {
    console.log("[verify-aug] 冇上載過嘢，唔使清。");
    return;
  }
  const deleted = await prisma.rosterUpload.deleteMany({ where: { id: { in: uploadIds } } });
  console.log(`[verify-aug] 刪咗 ${deleted.count} 個 roster_uploads（roster_upload_rows 靠 CASCADE 自動跟住刪）。`);
}

async function main() {
  const { uploadIds } = await verifyUploads();
  await verifyPricing();
  await verifyPersonOverrides();
  await cleanup(uploadIds);
  console.log("\n[verify-aug] 完成。");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
