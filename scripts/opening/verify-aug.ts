// WP-AUG-OPENING：verify-aug.ts
// 喺 apply-aug-plan.ts --apply 之後跑，用嚟驗證「8 月開盤資料包」交付
// 效果：
//   (b) 預設（**正式站都可以跑，唯讀**）：對 101 組（price_site_time_broker.json）
//       逐組用 resolveShiftPricingFromCards() 計價，同 E／F 比較，印差異清單；
//       8 個逐人卡用真實 guard 驗。
//   (a) 加 `--with-uploads` 先跑（**淨係 dev DB**，script 會拒絕非本機
//       DATABASE_URL，亦會拒絕 DB 入面已經有 8 月上載嘅情況）：逐個上載
//       36 個 8 月更表檔案（用 seed 老闆 user），印每檔 site 對到？
//       unmatched_shift_type／ambiguous_shift_type／unmatched_sub_site／
//       guard unmatched 數，同埋有冇檔被同盤同月另一個檔 supersede（目標
//       0）；再逐格用 resolver 對 8 月試算 shifts_priced.json（淨係印彙總，
//       冇人名／工號）。跑完刪晒 verify 自己上載嘅 roster_uploads（
//       roster_upload_rows／roster_reconcile_decisions 靠 ON DELETE CASCADE
//       跟住刪），唔留 8 月資料喺 dev DB。
//       **唔可以喺正式站跑 (a)**：會喺正式 roster_uploads 建 36 個上載、
//       supersede 會計已經上載咗嘅版本，再刪走。
import { PrismaClient } from "@prisma/client";
import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { processRosterUpload } from "@/lib/roster-upload/service";
import { fetchEffectiveRateCards, resolveShiftPricingFromCards } from "@/lib/pricing/resolve-rate";
import { loadPriceSiteTimeBroker, loadPriceOverrides } from "./lib/sources";
import { SITE_ID_TO_CANONICAL_NAME } from "./lib/site-code-map";

const prisma = new PrismaClient();

const AUG_ROSTERS_DIR = path.resolve(process.cwd(), "data/2026-09/aug-rosters");
const MONTH = new Date("2026-08-01T00:00:00.000Z");
// 101 組价目喺月頭／月中／月尾三個日子都要一致（8 月卡 effective_from=
// 2026-08-01，確認冇任何卡喺月內中途失效或者俾 7 月卡蓋過）。
const CHECK_DATES = ["2026-08-01", "2026-08-15", "2026-08-31"].map((d) => new Date(`${d}T00:00:00.000Z`));
const WITH_UPLOADS = process.argv.includes("--with-uploads");
// Opus 5.5 驗收：「CTB 6907」檔 siteRaw 寫「城巴車廠」但實際係「創富廠IC」，
// 上載時要人手揀盤（見 P2-版面重設計計劃.md §17.5）——verify 用 siteIdHint
// 模擬呢個操作。用檔名前綴認，唔寫死完整檔名。
const SITE_HINT_BY_FILE_PREFIX: Record<string, string> = { "Roster - CTB 6907": "創富廠IC" };
// build-aug-plan.ts PSTB_KEY_SITE_OVERRIDE 同一份：Event 組价掛喺獨立盤。
const PSTB_KEY_SITE_OVERRIDE: Record<string, string> = { "S017|1000-1900|K": "啟航1331 Event" };

function assertLocalDb(): void {
  const raw = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    host = "";
  }
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`--with-uploads 淨係可以對本機 dev DB 跑（而家 DATABASE_URL host=「${host || "解析唔到"}」）——正式站淨係跑預設嘅定價部分。`);
  }
}

async function verifyUploads() {
  console.log("\n===== (a) 逐個上載 36 個 8 月更表檔案 =====");
  const boss = await prisma.user.findFirst({ where: { role: { name: "老闆" } } });
  if (!boss) throw new Error("搵唔到 seed 老闆 user（role.name='老闆'）——先 npm run db:seed。");

  if (!readFileSyncOk(AUG_ROSTERS_DIR)) {
    console.log(`[verify-aug] ${AUG_ROSTERS_DIR} 唔存在，skip 呢部分（同 gate:roster-parse 一致做法，唔擋 CI/新 clone 環境）。`);
    return { uploadIds: [] as string[], totals: null };
  }
  const files = readdirSync(AUG_ROSTERS_DIR)
    .filter((f) => f.endsWith(".xlsx"))
    .sort();
  console.log(`[verify-aug] 搵到 ${files.length} 個 .xlsx 檔。`);
  const preexisting = await prisma.rosterUpload.count({ where: { month: MONTH } });
  if (preexisting > 0) {
    throw new Error(`DB 已經有 ${preexisting} 個 2026-08 上載——verify 會 supersede 佢哋再刪走自己嘅上載，唔跑。先 npm run db:reset && npm run db:seed。`);
  }
  const hintSiteIds = new Map<string, string>();
  for (const [prefix, name] of Object.entries(SITE_HINT_BY_FILE_PREFIX)) {
    const site = await prisma.site.findUnique({ where: { canonicalName: name } });
    if (site) hintSiteIds.set(prefix, site.id);
  }

  const uploadIds: string[] = [];
  let siteUnmatched = 0;
  let totalUnmatchedShiftType = 0;
  let totalAmbiguousShiftType = 0;
  let totalUnmatchedSubSite = 0;
  let totalUnmatchedGuard = 0;
  let totalAmbiguousGuard = 0;
  let uploadErrors = 0;

  // 檔名可能有人名／工號（例：CTB 6907 檔），印嘅時候淨係印序號＋對到嘅盤名。
  let fileNo = 0;
  for (const fileName of files) {
    fileNo++;
    const buf = readFileSync(path.join(AUG_ROSTERS_DIR, fileName));
    let result;
    try {
      const hintPrefix = Object.keys(SITE_HINT_BY_FILE_PREFIX).find((p) => fileName.startsWith(p));
      const siteIdHint = hintPrefix ? hintSiteIds.get(hintPrefix) : undefined;
      result = await processRosterUpload({ fileBuffer: buf, fileName, month: MONTH, uploaderUserId: boss.id, siteIdHint });
    } catch (e) {
      uploadErrors++;
      console.log(`  [錯誤] 檔 #${fileNo}：${(e as Error).message}`);
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
    const siteName = result.upload.siteId ? (await prisma.site.findUnique({ where: { id: result.upload.siteId }, select: { canonicalName: true } }))?.canonicalName : null;
    console.log(
      `  ${siteMatched ? "✓" : "✗"} 檔 #${fileNo} → ${siteName ?? "（未對到）"}：unmatched_shift_type=${ust}／ambiguous_shift_type=${ast}／unmatched_sub_site=${uss}／guard unmatched=${ug}／guard ambiguous=${ag}${result.supersededIds.length ? `／**supersede 咗 ${result.supersededIds.length} 個之前嘅上載**` : ""}`,
    );
  }
  // 同盤同月撞盤：兩個唔同檔對到同一個盤，後上載嗰個會 supersede 前一個
  // （B-0 版本邏輯）——36 個檔全部應該各自一個盤。
  const superseded = await prisma.rosterUpload.count({ where: { id: { in: uploadIds }, status: "superseded" } });

  console.log(`\n[verify-aug] (a) 總計：`);
  console.log(`  site 未對到：${siteUnmatched}／${files.length}（目標 0）`);
  console.log(`  unmatched_shift_type 總格數：${totalUnmatchedShiftType}（目標 0）`);
  console.log(`  ambiguous_shift_type 總格數：${totalAmbiguousShiftType}（目標 0）`);
  console.log(`  unmatched_sub_site 總格數：${totalUnmatchedSubSite}（目標 0）`);
  console.log(`  guard unmatched 總格數：${totalUnmatchedGuard}（只印數目，唔要求 0——散工資料覆蓋率唔係呢個 WP 範圍）`);
  console.log(`  guard ambiguous 總格數：${totalAmbiguousGuard}`);
  console.log(`  上載出錯：${uploadErrors}（目標 0）`);
  console.log(`  被同盤同月另一檔 supersede：${superseded}（目標 0——唔係 0 即係有兩個檔撞咗同一個盤）`);

  await verifyCP5RankNarrowing(uploadIds);

  return { uploadIds, totals: { siteUnmatched, totalUnmatchedShiftType, totalAmbiguousShiftType, totalUnmatchedSubSite, totalUnmatchedGuard, totalAmbiguousGuard, uploadErrors, superseded } };
}

/**
 * 補丁（§17.7 未修第一項）：數碼港 CP5 rank 收窄逐格明細——上載嗰陣
 * `matchShiftType()` 第三層收窄（match.ts）要靠更表 Rank 欄自動分流
 * 「早更保安員」→`D-2`（per_shift）／「早更IC」→`D`（monthly_ic），
 * 逐盤逐 rank 印返配咗邊個更種、有幾多格，同埋呢個盤嘅 ambiguous 格數
 * （目標 0）。冇人名／工號，淨係印 rank／代號／格數。 */
async function verifyCP5RankNarrowing(uploadIds: string[]): Promise<void> {
  const cp5Site = await prisma.site.findUnique({ where: { canonicalName: "數碼港 CP5" } });
  if (!cp5Site) return;
  console.log("\n----- (a-補) 數碼港 CP5 rank 收窄明細（補丁驗證，§17.7 未修第一項）-----");
  const rows = await prisma.rosterUploadRow.findMany({
    where: { uploadId: { in: uploadIds }, resolvedSiteId: cp5Site.id, codeKind: "shift" },
    include: { shiftType: true },
  });
  const byKey = new Map<string, number>();
  let ambiguousOrUnmatched = 0;
  for (const r of rows) {
    if (!r.shiftTypeId) ambiguousOrUnmatched += 1;
    const key = `${r.rankRaw ?? "（冇 rank）"}｜代號=${r.rawCode}｜配到更種=${r.shiftType?.code ?? "（冇配到）"}(${r.shiftType?.billingGroup ?? "-"})`;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...byKey.entries()].sort()) console.log(`    ${v} 格　${k}`);
  console.log(`  數碼港 CP5 未配到更別（ambiguous／unmatched）總格數：${ambiguousOrUnmatched}（目標 0）`);
}

function readFileSyncOk(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

type Cards = Awaited<ReturnType<typeof fetchEffectiveRateCards>>;

function parseTimeSlot(slot: string): [string, string] | null {
  const m = slot.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;
  return [`${m[1]}:${m[2]}`, `${m[3]}:${m[4]}`];
}

function modalKey(counts: Record<string, number>): string | undefined {
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
}

const SKIP_PER_SHIFT_CLIENT_SITES = new Set(["恆星樓", "九龍企業大廈"]); // 同 build-aug-plan.ts

/**
 * (b) 101 組逐組驗（Opus 5.5 驗收重寫）：原本做法係「呢個盤**任何**一個
 * shift_type 計到夾就算過」＋「E 有 ≥5000 就當 client 過」——7 月舊卡夾中
 * 都當過，實際驗唔到 8 月卡。改做：用 rate_cards.source 認返「呢組 build
 * 出嚟嘅 8 月卡掛喺邊個 shift_type」，淨係喺嗰啲 shift_type 上面、用呢組
 * 嘅雞頭、喺 8/1、8/15、8/31 三日計，**全部**要等於 E／F。
 */
async function verifyPricing() {
  console.log("\n===== (b) 101 組價目逐組對 resolver（8/1、8/15、8/31）=====");
  const pstb = loadPriceSiteTimeBroker();
  const overrides = loadPriceOverrides();
  const sites = await prisma.site.findMany({ select: { id: true, canonicalName: true } });
  const siteIdByName = new Map(sites.map((s) => [s.canonicalName, s.id]));
  const brokers = await prisma.broker.findMany({ select: { id: true, code: true, kind: true } });
  const brokerByCode = new Map(brokers.map((b) => [b.code, b]));
  const shiftTypes = await prisma.shiftType.findMany({ where: { voidedAt: null }, select: { id: true, siteId: true, code: true, startTime: true, endTime: true, billingGroup: true } });
  const stById = new Map(shiftTypes.map((st) => [st.id, st]));
  const augCards = await prisma.rateCard.findMany({ where: { voidedAt: null, effectiveFrom: MONTH, source: { startsWith: "aug-opening:" } }, select: { siteId: true, shiftTypeId: true, source: true } });

  let checked = 0;
  let matched = 0;
  const diffs: string[] = [];
  const skipped: string[] = [];
  const cardsCache = new Map<string, Cards>();

  for (const [key, entry] of Object.entries(pstb)) {
    const [siteCode, time, brokerCode] = key.split("|");
    if (!parseTimeSlot(time)) {
      skipped.push(`${key}（時段唔係 HHMM-HHMM，OT 組，resolver 唔計 OT 价）`);
      continue;
    }
    const canonicalName = PSTB_KEY_SITE_OVERRIDE[key] ?? SITE_ID_TO_CANONICAL_NAME[siteCode];
    const siteId = canonicalName ? siteIdByName.get(canonicalName) : undefined;
    if (!siteId) {
      diffs.push(`${key}：盤「${canonicalName ?? siteCode}」搵唔到（apply 咗未？）`);
      continue;
    }
    const broker = brokerByCode.get(brokerCode);
    const eKeys = Object.keys(entry.E).map(Number);
    const under5000 = eKeys.filter((e) => e < 5000);
    const expClient = SKIP_PER_SHIFT_CLIENT_SITES.has(canonicalName!) || under5000.length !== 1 ? null : under5000[0];
    const modalF = modalKey(entry.F);
    if (!broker) {
      skipped.push(`${key}（雞頭代號 ${brokerCode} 系統冇，冇起卡）`);
      continue;
    }
    // 呢組嘅 8 月卡掛喺邊啲 shift_type（source 有呢組 key：pstb 組／zone／逐人組）
    const stIds = new Set(
      augCards
        .filter((c) => c.siteId === siteId && c.shiftTypeId && ((c.source ?? "").includes(`["${key}"]`) || (c.source ?? "").includes(`["${key}|`)))
        .map((c) => c.shiftTypeId as string),
    );
    if (stIds.size === 0) {
      if (expClient === null && modalF === undefined) {
        skipped.push(`${key}（E 全部 ≥5000／F 冇值——月費，交俾 site flat 卡，見 (b-flat)）`);
        continue;
      }
      diffs.push(`${key}：搵唔到呢組嘅 8 月逐更卡`);
      continue;
    }
    if (!cardsCache.has(siteId)) cardsCache.set(siteId, await fetchEffectiveRateCards(siteId, new Date("2026-08-01"), new Date("2026-08-31")));
    const cards = cardsCache.get(siteId)!;
    checked++;
    let groupOk = true;
    for (const stId of stIds) {
      const st = stById.get(stId)!;
      const zone = overrides.zone[`${key}|${st.code}`];
      const expF = zone ? zone.F : modalF !== undefined ? Number(modalF) : null;
      for (const d of CHECK_DATES) {
        const priced = resolveShiftPricingFromCards(cards, {
          siteId,
          shiftTypeId: st.id,
          shiftTypeCode: st.code,
          shiftTypeBillingGroup: st.billingGroup,
          settlementBrokerId: broker.id,
          brokerKind: broker.kind,
          guardId: "verify-aug-placeholder-guard",
          workDate: d,
          isExternal: false,
          recordType: "shift",
        });
        const gotF = priced.guardWage === null && priced.brokerFee === null ? null : (priced.guardWage ?? 0) + (priced.brokerFee ?? 0);
        const cOk = expClient === null ? priced.clientRate === null : priced.clientRate !== null && Math.abs(priced.clientRate - expClient) < 0.005;
        // B07（長工）等 F 冇值嘅組唔驗 F（長工月薪唔經逐更卡）
        const fOk = expF === null || (gotF !== null && Math.abs(gotF - expF) < 0.005);
        if (!cOk || !fOk) {
          groupOk = false;
          diffs.push(`${key} @${st.code} ${d.toISOString().slice(0, 10)}：resolver client=${priced.clientRate} 出街=${gotF}；預期 client=${expClient} F=${expF}${st.billingGroup !== "per_shift" ? `（更種 billing_group=${st.billingGroup}，唔出收客价）` : ""}`);
        }
      }
    }
    if (groupOk) matched++;
  }

  console.log(`[verify-aug] (b) 總計：101 組入面驗咗 ${checked} 組，一致 ${matched}，差異 ${diffs.length} 條，略過 ${skipped.length} 組`);
  for (const s of skipped) console.log(`    · 略過 ${s}`);
  for (const d of diffs) console.log(`    - ${d}`);

  // (b-flat) 月費盤 flat 卡：每日揀中嘅 flat 卡（月結 monthly-close.ts 同一個揀法：effective 範圍覆蓋、effective_from 最新）
  console.log("\n----- (b-flat) 月費盤 site 級 flat 卡（8/1、8/15、8/31 揀中邊張）-----");
  const flatSites = new Set((await prisma.rateCard.findMany({ where: { voidedAt: null, effectiveFrom: MONTH, shiftTypeId: null, brokerId: null, guardId: null, source: { startsWith: "aug-opening:" } }, select: { siteId: true } })).map((c) => c.siteId));
  for (const siteId of flatSites) {
    const vals: string[] = [];
    for (const d of CHECK_DATES) {
      const card = await prisma.rateCard.findFirst({
        where: { siteId, voidedAt: null, shiftTypeId: null, brokerId: null, guardId: null, billingModel: { in: ["monthly_fixed", "admin_fee", "special"] }, effectiveFrom: { lte: d }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }] },
        orderBy: { effectiveFrom: "desc" },
      });
      vals.push(`${d.toISOString().slice(5, 10)}=${card ? `${card.clientRate}${card.effectiveFrom.getTime() === MONTH.getTime() ? "(8月卡)" : "(舊卡!)"}` : "冇"}`);
    }
    console.log(`    ${sites.find((s) => s.id === siteId)?.canonicalName}：${vals.join("／")}`);
  }
}

async function verifyPersonOverrides() {
  console.log("\n===== (b-補) 8 個逐人卡：用返真實 guard 驗（8/1、8/15、8/31）=====");
  const overrides = loadPriceOverrides();
  const sites = await prisma.site.findMany({ select: { id: true, canonicalName: true } });
  const siteIdByName = new Map(sites.map((s) => [s.canonicalName, s.id]));
  const brokers = await prisma.broker.findMany({ select: { id: true, code: true, kind: true } });
  const brokerByCode = new Map(brokers.map((b) => [b.code, b]));
  const augCards = await prisma.rateCard.findMany({ where: { voidedAt: null, effectiveFrom: MONTH, source: { startsWith: "aug-opening:" } }, include: { shiftType: true } });

  let checked = 0;
  let matched = 0;
  let noGuard = 0;
  const diffs: string[] = [];
  for (const [key, v] of Object.entries(overrides.person)) {
    const parts = key.split("|");
    const name = parts[parts.length - 1];
    const [siteCode, time, brokerCode] = parts;
    const groupKey = `${siteCode}|${time}|${brokerCode}`;
    const canonicalName = SITE_ID_TO_CANONICAL_NAME[siteCode];
    const siteId = canonicalName ? siteIdByName.get(canonicalName) : undefined;
    const broker = brokerByCode.get(brokerCode);
    // 同 build 一致：淨係認現用 U 號安員（姓名對 U 號），撞名／對唔到當「冇 guard」
    const staffRows = await prisma.guardStaffNumber.findMany({ where: { scheme: "U", status: "current", guard: { nameZh: name } }, select: { guardId: true } });
    const guardId = staffRows.length === 1 ? staffRows[0].guardId : null;
    const groupCard = augCards.find((c) => c.siteId === siteId && (c.source ?? "").includes(`["${groupKey}"]`) && c.shiftType);
    if (!siteId || !broker || !groupCard?.shiftType) {
      diffs.push(`${groupKey}|<guard>：搵唔到呢組嘅 8 月組級卡`);
      continue;
    }
    const cards = await fetchEffectiveRateCards(siteId, new Date("2026-08-01"), new Date("2026-08-31"));
    checked++;
    let ok = true;
    for (const d of CHECK_DATES) {
      const priced = resolveShiftPricingFromCards(cards, {
        siteId,
        shiftTypeId: groupCard.shiftType.id,
        shiftTypeCode: groupCard.shiftType.code,
        shiftTypeBillingGroup: groupCard.shiftType.billingGroup,
        settlementBrokerId: broker.id,
        brokerKind: broker.kind,
        guardId: guardId ?? "verify-aug-unmatched-guard",
        workDate: d,
        isExternal: false,
        recordType: "shift",
      });
      if (priced.guardWage === null || Math.abs(priced.guardWage - v.F) >= 0.005 || priced.clientRate === null || Math.abs(priced.clientRate - v.E) >= 0.005) {
        ok = false;
        // 鐵則：唔准印真名，key 最後一截（姓名）用 <guard> 代替
        diffs.push(`${groupKey}|<guard>${guardId ? "" : "（dev DB 冇呢位安員，用組級預設价）"} ${d.toISOString().slice(0, 10)}：client=${priced.clientRate} guardWage=${priced.guardWage} vs E=${v.E} F=${v.F}`);
      }
    }
    if (!guardId) noGuard++;
    if (ok) matched++;
  }
  console.log(`[verify-aug] 逐人卡：檢查 ${checked}／${Object.keys(overrides.person).length}，一致 ${matched}（其中 ${noGuard} 位 DB 冇對應安員、靠組級預設价），差異 ${diffs.length} 條`);
  for (const d of diffs) console.log(`    - ${d}`);
}

/** (c) 逐格：verify 自己上載嘅 36 檔每一格（record 種類=shift），用 8 月試算
 * shifts_priced.json 嗰格嘅結算單位計价，同試算 client_rate／payout_rate
 * 比較。長工（is_longterm）用 B07。淨係印「盤|更種|雞頭|數字」彙總，冇人名工號。 */
async function verifyCells(uploadIds: string[]) {
  console.log("\n===== (c) 逐格 resolver 對 8 月試算 shifts_priced.json =====");
  const spPath = path.resolve(process.cwd(), "data/2026-09/aug-payroll-trial/out/shifts_priced.json");
  if (!existsSync(spPath) || uploadIds.length === 0) {
    console.log("[verify-aug] 冇 shifts_priced.json 或者冇上載，skip。");
    return;
  }
  type SP = { date: string; file: string; staff_no: string | null; name: string | null; code: string; kind: string; eff_broker: string | null; client_rate: number | null; client_rate_is_monthly: boolean; payout_rate: number | null; price_source: string; is_longterm: boolean };
  const sp: SP[] = JSON.parse(readFileSync(spPath, "utf8"));
  const norm = (x: string | null) => (x ?? "").replace(/\s+/g, "").toUpperCase();
  const idx = new Map<string, SP[]>();
  for (const x of sp) {
    if (x.kind !== "work") continue;
    const k = `${x.file.replace(/\s+/g, " ")}|${x.date}|${norm(x.code)}|${norm(x.staff_no) || norm(x.name)}`;
    idx.set(k, [...(idx.get(k) ?? []), x]);
  }
  const brokers = await prisma.broker.findMany();
  const bByCode = new Map(brokers.map((b) => [b.code, b]));
  const siteName = new Map((await prisma.site.findMany({ select: { id: true, canonicalName: true } })).map((x) => [x.id, x.canonicalName]));
  const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: { in: uploadIds }, codeKind: "shift" }, include: { upload: { select: { fileName: true } }, shiftType: true } });
  const cache = new Map<string, Cards>();
  const bad = new Map<string, number>();
  let ok = 0;
  let noJoin = 0;
  let trialUnpriced = 0;
  let noShiftType = 0;
  for (const r of rows) {
    const k = `${r.upload.fileName.replace(/\s+/g, " ")}|${r.workDate.toISOString().slice(0, 10)}|${norm(r.rawCode)}|${norm(r.staffNoRaw) || norm(r.nameRaw)}`;
    const t = idx.get(k)?.shift();
    if (!t) {
      noJoin++;
      continue;
    }
    if (t.price_source.startsWith("無對應")) {
      trialUnpriced++;
      continue;
    }
    if (!r.resolvedSiteId || !r.shiftTypeId || !r.shiftType) {
      noShiftType++;
      continue;
    }
    if (!cache.has(r.resolvedSiteId)) cache.set(r.resolvedSiteId, await fetchEffectiveRateCards(r.resolvedSiteId, new Date("2026-08-01"), new Date("2026-08-31")));
    const b = t.is_longterm ? bByCode.get("B07") : t.eff_broker ? bByCode.get(t.eff_broker) : undefined;
    const pr = resolveShiftPricingFromCards(cache.get(r.resolvedSiteId)!, { siteId: r.resolvedSiteId, shiftTypeId: r.shiftTypeId, shiftTypeCode: r.shiftType.code, shiftTypeBillingGroup: r.shiftType.billingGroup, settlementBrokerId: b?.id ?? null, brokerKind: b?.kind ?? null, guardId: r.guardId ?? "verify-aug-unmatched-guard", workDate: r.workDate, isExternal: false, recordType: "shift" });
    const expC = t.client_rate_is_monthly ? null : t.client_rate;
    const gotF = pr.guardWage === null && pr.brokerFee === null ? null : (pr.guardWage ?? 0) + (pr.brokerFee ?? 0);
    const cOk = expC === null ? pr.clientRate === null : pr.clientRate !== null && Math.abs(expC - pr.clientRate) < 0.005;
    const fOk = !t.payout_rate ? !gotF : gotF !== null && Math.abs(t.payout_rate - gotF) < 0.005;
    if (cOk && fOk) {
      ok++;
      continue;
    }
    const label = `${siteName.get(r.resolvedSiteId)}|${r.shiftType.code}|${t.is_longterm ? "長工" : (t.eff_broker ?? "-")}|試算 client=${expC} 出街=${t.payout_rate}｜resolver client=${pr.clientRate} 出街=${gotF}${r.guardId ? "" : "（安員未配對）"}`;
    bad.set(label, (bad.get(label) ?? 0) + 1);
  }
  const badN = [...bad.values()].reduce((a, b) => a + b, 0);
  console.log(`[verify-aug] (c) 逐格：一致 ${ok}，唔一致 ${badN}，對唔返試算 ${noJoin}，試算本身未定價 ${trialUnpriced}，冇更種 ${noShiftType}`);
  for (const [label, n] of [...bad.entries()].sort()) console.log(`    - ${n} 格 ${label}`);
}

async function cleanup(uploadIds: string[]) {
  console.log("\n===== 清走 verify 自己上載嘅 roster_uploads =====");
  if (uploadIds.length === 0) {
    console.log("[verify-aug] 冇上載過嘢，唔使清。");
    return;
  }
  const deleted = await prisma.rosterUpload.deleteMany({ where: { id: { in: uploadIds } } });
  const leftRows = await prisma.rosterUploadRow.count({ where: { uploadId: { in: uploadIds } } });
  console.log(`[verify-aug] 刪咗 ${deleted.count} 個 roster_uploads（roster_upload_rows／roster_reconcile_decisions 靠 CASCADE 跟住刪，剩 ${leftRows} 行）。`);
}

async function main() {
  let uploadIds: string[] = [];
  if (WITH_UPLOADS) {
    assertLocalDb();
    uploadIds = (await verifyUploads()).uploadIds;
  } else {
    console.log("[verify-aug] 淨係跑定價部分（唯讀）；要連 36 檔上載一齊驗（淨係 dev DB）加 --with-uploads。");
  }
  try {
    await verifyPricing();
    await verifyPersonOverrides();
    if (WITH_UPLOADS) await verifyCells(uploadIds);
  } finally {
    if (WITH_UPLOADS) await cleanup(uploadIds);
  }
  console.log("\n[verify-aug] 完成。");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
