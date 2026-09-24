// WP-AUG-OPENING：build-aug-plan.ts
// 讀 8 月試算輸出（data/2026-09/aug-payroll-trial，只讀）＋dev DB 現況，
// 計出「要新建/要改嘅盤、更種、價目卡、散工」，寫成
// data/2026-09/aug-opening/plan.json（gitignored，apply-aug-plan.ts 用）
// ＋ plan-summary.md（數目＋盤名，冇人名）。
//
// 呢個 script 唔寫 DB——淨係讀（dev DB，用嚟對現有 sites/shift_types/
// rate_cards/brokers/guards）同讀 data/ 嘅試算輸出。
//
// 設計原則（詳細判斷理由見 P2-版面重設計計劃.md §17）：
//   - site_id（S0xx／X0x，101 組價目嘅盤碼）→ dev DB 盤嘅對應表
//     `SITE_CODE_MAP` 係人手核對出嚟（比對 revenue_site.json 嘅盤名、
//     records.jsonl 嘅逐格代號/時段/人數、現有 64 個盤嘅 canonical_name/
//     aliases 逐一核實），唔靠字串模糊配對（44 個盤碼，人手核對一次
//     好過將來配錯）。
//   - 收客价（client_rate）判斷"月費 vs 逐更"：規則 5「上單价 ≥$5,000
//     嘅崗位行=月費」——逐個 E 值（可能一組有多過一個值，即混合月費／
//     逐更）分開判斷，≥5000 嘅唔起逐更卡（交俾 site 級 flat 卡，用
//     revenue_site.json 嘅 revenue_monthly）；<5000 先起逐更卡。
//     例外：恆星樓——8 月試算嗰組 E 值（806.45）本身已經係「月費÷更數」
//     嘅倒算值（唔係真逐更价，site.billing_model 已經係 monthly_fixed、
//     revenue_monthly 呢個試算月份反而係 0——即總表個 704.45×62≈50000
//     先係真正月費，唔係逐更价），起逐更卡會同現有月費安排衝突，
//     淨係跳過佢嘅 client 卡（payout 卡照起，長工/雞頭出街价係真逐更）。
//   - 出街价（guard_wage/broker_fee）永遠當逐更（規則 3 講明雞頭冇獨立
//     抽佣，F 就係外判价／公司兵工資，唔受「月費」呢個概念影響）。
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import {
  loadPriceSiteTimeBroker,
  loadRevenueSite,
  loadPriceOverrides,
  loadRosterRecords,
  loadRosterFixture,
  type RosterRecord,
} from "./lib/sources";
import { MIXED_BILLING_SITES, siteHasFlatRevenue } from "./lib/mixed-billing-sites";
import type { AugPlan, NewSitePlan, SiteAliasUpdatePlan, NewRateCardPlan, RateCardCloseJulyPlan } from "./lib/types";

const prisma = new PrismaClient();

const AS_OF_DATE = new Date("2026-08-15T00:00:00.000Z"); // 準日，用嚟查現有卡會計出咩價
const EFFECTIVE_FROM = "2026-08-01";

// ---------------------------------------------------------------------------
// site_id（101 組價目嘅盤碼）→ dev DB 盤嘅對應表。人手核對，見檔頭註解。
// ---------------------------------------------------------------------------
type SiteResolution =
  | { kind: "existing"; canonicalName: string }
  | { kind: "new"; site: NewSitePlan };

const CITYBUS_PARENT = "城巴車廠";

const SITE_CODE_MAP: Record<string, SiteResolution> = {
  S001: { kind: "existing", canonicalName: "殷樺花園" },
  S002: { kind: "existing", canonicalName: "IFC" },
  S003: { kind: "existing", canonicalName: "粉嶺安樂村貨倉" },
  S004: { kind: "existing", canonicalName: "Weave OL" },
  S005: { kind: "existing", canonicalName: "皓日" },
  S006: { kind: "existing", canonicalName: "HKU Y更" },
  S007: { kind: "existing", canonicalName: "HKU座頭" },
  S008: { kind: "existing", canonicalName: "HKU 醫學院" },
  S009: { kind: "existing", canonicalName: "屯門凱和山" },
  S010: { kind: "existing", canonicalName: "數碼港 CP1-4" },
  S011: { kind: "existing", canonicalName: "數碼港 CP5" },
  S012: { kind: "existing", canonicalName: "數碼港 CP5 IC" },
  S013: { kind: "existing", canonicalName: "數碼港 數據中心" },
  // S014「Weave ML」：revenue_site.json 話 36 更（0800-2000×4、2000-0800×32），
  // 呢個更數分佈（4＋32＝36）同「Roster - Weave Hospital Road - Aug
  // 2026.xlsx」嘅更表逐格數（D 0800-2000×4、N 2000-0800×32）完全脗合，
  // 判斷 S014「Weave ML」其實就係現有盤「Weave Hospital Road」（唔係
  // 冇對應更表嘅新盤——首版判斷錯咗，未見到呢個更數脗合，已改正）。
  S014: { kind: "existing", canonicalName: "Weave Hospital Road" },
  S015: { kind: "existing", canonicalName: "Weave Robinson" },
  S016: { kind: "existing", canonicalName: "九龍企業大廈" },
  S017: { kind: "existing", canonicalName: "啟航1331" },
  S018: { kind: "existing", canonicalName: "城巴-柴灣車廠" },
  S019: { kind: "existing", canonicalName: "城巴-創富車廠" },
  S020: { kind: "existing", canonicalName: "城巴-屯門車廠" },
  S021: { kind: "existing", canonicalName: "城巴-東涌車廠" },
  S022: { kind: "existing", canonicalName: "城巴-將軍澳車廠" },
  S023: { kind: "existing", canonicalName: "城巴-黃竹坑車廠" },
  S024: { kind: "existing", canonicalName: "城巴-西九龍車廠" },
  S025: { kind: "existing", canonicalName: "城巴-上環車廠" },
  S026: { kind: "existing", canonicalName: "創富廠IC" },
  S027: { kind: "existing", canonicalName: "屯門小欖樂怡街5號" },
  S028: { kind: "existing", canonicalName: "怡安168" },
  S029: { kind: "existing", canonicalName: "淺水灣道11號蔚峰園" },
  S030: { kind: "existing", canonicalName: "美心集團中心" },
  S031: { kind: "existing", canonicalName: "控制室" },
  S032: { kind: "existing", canonicalName: "都會大學夜巡邏" },
  S033: { kind: "existing", canonicalName: "都會大學學生宿舍" },
  S034: { kind: "existing", canonicalName: "M+" },
  S035: { kind: "existing", canonicalName: "東濤苑" },
  S036: { kind: "existing", canonicalName: "恆星樓" },
  S037: { kind: "existing", canonicalName: "葵發大廈" },
  S038: { kind: "existing", canonicalName: "國泰城" },
  S046: { kind: "existing", canonicalName: "Garden East" },
  // X01：revenue_site.json 標「機場CDF／免稅店(新盤)」，但 po_cells_sited.json
  // 逐格 client 全部係「機場Cdf」；同 records.jsonl 對比，「免稅店」呢個 8
  // 月更表檔案嘅逐格數（D 0700-1500×5、M 1500-2330×5 中嘅 2）同 X01 兩個
  // time slot 嘅 n（5、2）完全脗合——即 X01 呢個盤碼實際上就係「免稅店」
  // 呢個新盤（總表個 client 欄寫「機場Cdf」淨係個地點/客戶標籤，唔係
  // 第二個獨立盤）。
  X01: {
    kind: "new",
    site: {
      canonicalName: "免稅店",
      clientName: "機場Cdf",
      clientGroup: null,
      aliases: ["免稅店"],
      billingModel: "per_shift",
      monthlyFee: null,
      monthlyPosts: null,
      parentCanonicalName: null,
      guardsPaidByClient: false,
      note: "8 月新盤。revenue_site.json X01「機場CDF／免稅店(新盤)」，po_cells_sited.json 逐格 client=機場Cdf；同 records.jsonl「Roster - 免稅店 Aug 2026.xlsx」逐格數（D 0700-1500×5、M 1500-2330×2）同 X01 兩個 time slot 嘅 n 完全脗合，判斷係同一個盤（總表 client 欄嘅「機場Cdf」係地點標籤）。",
    },
  },
  X02: {
    kind: "new",
    site: {
      canonicalName: "新皇崗口岸",
      clientName: "新皇崗口岸",
      clientGroup: null,
      aliases: ["新皇崗口岸"],
      billingModel: "per_shift",
      monthlyFee: null,
      monthlyPosts: null,
      parentCanonicalName: null,
      guardsPaidByClient: false,
      note: "8 月新盤（revenue_site.json X02「新皇崗口岸(新盤)」）。",
    },
  },
  X03: {
    kind: "new",
    site: {
      canonicalName: "港深創新及科技園",
      clientName: "港深創新及科技園",
      clientGroup: null,
      aliases: ["港深創新及科技園"],
      billingModel: "per_shift",
      monthlyFee: null,
      monthlyPosts: null,
      parentCanonicalName: null,
      guardsPaidByClient: false,
      note: "8 月新盤（revenue_site.json X03「港深創新及科技園(新盤)」）。records.jsonl 顯示 21 格入面 14 格冇雞頭碼欄，靠總表補 K——規則 8「冇雞頭碼欄嘅盤用系統內設定」呢層 WP-ATTRIB 仲未起，先起呢張 broker=K 嘅通用卡，冇雞頭碼嗰 14 格上載後會 unmatched_broker，要人手覆核。",
    },
  },
  X04: {
    kind: "new",
    site: {
      canonicalName: "城巴-海洋公園車廠",
      clientName: "城巴",
      clientGroup: "城巴車廠",
      aliases: ["海洋公園城巴車廠"],
      billingModel: "per_shift",
      monthlyFee: null,
      monthlyPosts: null,
      parentCanonicalName: CITYBUS_PARENT,
      guardsPaidByClient: false,
      note: "8 月新子盤（revenue_site.json X04「城巴-海洋公園車廠(新子盤)」），掛喺新起嘅「城巴車廠」母盤底下，alias 用返「城巴車廠」總表入面嘅子盤名。",
    },
  },
  X05: {
    kind: "new",
    site: {
      canonicalName: "希慎廣場",
      clientName: "希慎廣場",
      clientGroup: null,
      aliases: ["希慎廣場"],
      billingModel: "per_shift",
      monthlyFee: null,
      monthlyPosts: null,
      parentCanonicalName: null,
      guardsPaidByClient: false,
      note: "8 月新盤（revenue_site.json X05「希慎廣場(新盤)」）。時段：更表檔案寫 1930-0730（冇雞頭碼欄），總表/pstb 寫 1930-0930——老闆話兩個都啱就兩個更種都建（2026-09-24 §15 第 5 項再確認：建埋），見下面 shift_types 部分。",
    },
  },
};

// 恆星樓：見上面檔頭註解，淨係跳過佢個「逐更」client 卡。
// 九龍企業大廈（Opus 5.5 驗收加）：同一原因——夜更 E=822.58＝25,500÷31，
// 係月費倒算值唔係真逐更价（sites.monthly_fee 25,500 × monthly_posts 2
// ＝51,000＝revenue_site.json S016 revenue_total），兩個崗都係月費，收入
// 交俾 site flat 卡（見第 5 步），唔起逐更 client 卡。
const SKIP_PER_SHIFT_CLIENT_SITES = new Set(["恆星樓", "九龍企業大廈"]);

// ---------------------------------------------------------------------------
// 啟航1331 Event（Opus 5.5 驗收改）：原本做法係「啟航1331 Event Guard」加
// alias 去「啟航1331」——但 Phase B-0 上載版本邏輯係「同盤同月新上載取代
// 舊版」（service.ts processRosterUpload → versionGroupWhere(siteId, month)），
// Event 檔同正常 1331 檔係兩個獨立檔，對到同一個盤就會後上載嗰個 supersede
// 前一個（dev 實測：正常 1331 檔變 superseded，千幾格冇咗）。改做獨立盤
// 「啟航1331 Event」（parent 留空——如果掛做 1331 嘅子盤，正常 1331 檔每
// 一行都會因為「有子盤但冇寫子盤名」出 warning），有自己嘅更種同价目卡；
// 總表 `S017|1000-1900|K` 呢組价（上單 1,350／外判 990，boss_answers.py 七）
// 掛喺呢個盤。
// ---------------------------------------------------------------------------
const EVENT_SITE = "啟航1331 Event";
const PSTB_KEY_SITE_OVERRIDE: Record<string, string> = { "S017|1000-1900|K": EVENT_SITE };

// ---------------------------------------------------------------------------
// 補丁（§17.7「未修」第一項——數碼港 CP5 日更收客价）：7 月 dev DB「數碼港
// CP5」0750-1950 呢個時段有兩個「D」代號嘅更種——`D`（billing_group=
// monthly_ic，IC 月費崗）同 `D-2`（per_shift，普通保安員）。8 月更表格仔
// 全部寫代號「D」，`dominantCodeForTime()` 淨係睇代號會揀中 monthly_ic
// 嗰個（`ensureShiftType()` 見到 dev DB 呢個時段有 2 個完全同時段嘅候選、
// 兩個都唔係 placeholder code，會落 needsBossReview 逐張都掛、揀第一個
// 交差——實測揀咗 monthly_ic），令 K／B07 呢兩個普通兵雞頭組（930/850，
// 246+23=269 更，見 price_site_time_broker.json）嘅收客价起錯咗喺
// monthly_ic 個更種度，resolver 對 monthly_ic 唔出收客价，變咗 null。
//
// 上載嗰邊（`matchShiftType()`，match.ts）而家有 rank_raw 第三層收窄，會
// 靠更表 Rank 欄（「早更保安員」vs「早更IC」）自動分流——但起价目卡呢層
// （呢個 script）睇唔到逐格 rank，要人手指定：K／B07 呢兩組雞頭代表嘅係
// 普通保安員（rank「早更保安員」），逐更卡實牌掛 `D-2`；IC 崗（rank
// 「早更IC」）冇獨立嘅逐更雞頭組（pstb 冇呢個 broker 嘅 S011|0750-1950
// key），留返用現有 `D`（monthly_ic）配對，收客价照舊由「數碼港 CP5 IC」
// 呢個獨立盤嘅 site 級 flat 卡負責（現有 8 月 flat 卡，唔喺呢度加逐更收
// 客卡）。
// ---------------------------------------------------------------------------
const PSTB_KEY_SHIFT_CODE_OVERRIDE: Record<string, string> = {
  "S011|0750-1950|K": "D-2",
  "S011|0750-1950|B07": "D-2",
};

// ---------------------------------------------------------------------------
// 唔喺 101 組價目入面、但要另外建 alias 先對得到 8 月更表嘅盤
// （Wilson Control/Patrol——見 P2-版面重設計計劃.md §17：clientName
// 「Wilson Service」、broker=Y(公司兵) 同「控制室」「都會大學夜巡邏」
// 完全一致，更表逐格數同呢兩個盤嘅 pstb n 脗合，判斷係同一盤嘅另一個
// 檔名寫法。**老闆 2026-09-24 已確認**（§15「8 月開盤五條」第 7 項：
// Wilson Control＝控制室、Wilson Patrol＝都會大學夜巡邏，老闆話
// 「啱」）——由推斷變定案，唔再落 needsBossReview。
// ---------------------------------------------------------------------------
const EXTRA_ALIASES: { canonicalName: string; alias: string; note: string }[] = [
  {
    canonicalName: "控制室",
    alias: "Wilson Control",
    note: "老闆 2026-09-24 已確認（§15 第 7 項）：clientName=Wilson Service、broker=Y(公司兵)，更表 47N+15RD 同 S031|1930-0730|Y n=47 脗合。",
  },
  {
    canonicalName: "都會大學夜巡邏",
    alias: "Wilson Patrol",
    note: "老闆 2026-09-24 已確認（§15 第 7 項）：clientName=都會大學、broker=Y(公司兵)，更表 25N+6RD 同 S032|1930-0730|Y n=25 脗合（時段更表寫 1900-0700，總表寫 1930-0730，30 分鐘落差）。",
  },
];

// records.jsonl 逐格記錄嘅 lookup key（cellCountBySite 用 sub_site ??
// site_raw 做 key）——「Wilson Control」份更表本身有一個 sub_site marker
// 「Head Office」（citybus layout 偵測到嘅唯一子盤名），所以逐格記錄
// 實際係存喺 "Head Office" 呢個 key 底下，唔係 "Wilson Control"。呢個
// 純粹係 build-aug-plan.ts 推斷更種代號用嘅 lookup key，**唔係**真正嘅
// sites.aliases（"Head Office" 唔應該做 alias 俾上載配對用，"控制室"
// 個盤本身冇子盤結構）。
const RECORD_LOOKUP_EXTRA_KEYS: Record<string, string[]> = {
  控制室: ["Head Office"],
};

// ---------------------------------------------------------------------------
// DB 現況快照
// ---------------------------------------------------------------------------
interface DbSnapshot {
  sites: { id: string; canonicalName: string; aliases: string[]; billingModel: string; monthlyFee: number | null; monthlyPosts: number | null; parentSiteId: string | null; clientGroup: string | null }[];
  shiftTypes: { id: string; siteId: string; code: string; startTime: Date | null; endTime: Date | null }[];
  brokers: { id: string; code: string }[];
  guards: { id: string; nameZh: string }[];
  staffNumbers: Set<string>;
}

async function loadDbSnapshot(): Promise<DbSnapshot> {
  const sites = await prisma.site.findMany({
    select: { id: true, canonicalName: true, aliases: true, billingModel: true, monthlyFee: true, monthlyPosts: true, parentSiteId: true, clientGroup: true },
  });
  const shiftTypes = await prisma.shiftType.findMany({
    where: { voidedAt: null },
    select: { id: true, siteId: true, code: true, startTime: true, endTime: true },
  });
  const brokers = await prisma.broker.findMany({ select: { id: true, code: true } });
  const guards = await prisma.guard.findMany({ select: { id: true, nameZh: true } });
  const staffNumberRows = await prisma.guardStaffNumber.findMany({ select: { number: true } });
  return {
    sites: sites.map((s) => ({ ...s, monthlyFee: s.monthlyFee ? Number(s.monthlyFee) : null })),
    shiftTypes,
    brokers,
    guards,
    staffNumbers: new Set(staffNumberRows.map((r) => r.number)),
  };
}

function hhmm(d: Date | null): string | null {
  if (!d) return null;
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "0700-1500" → ["07:00","15:00"]（同 normalizeTimeRange 精神一致，呢度只做簡單直讀，pstb/zone 嘅 key 已經係乾淨嘅 4 位數字格式） */
function parseTimeSlot(slot: string): [string, string] | null {
  const m = slot.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  if (!m) return null;
  return [`${m[1]}:${m[2]}`, `${m[3]}:${m[4]}`];
}

// ---------------------------------------------------------------------------
// Plan 累積器
// ---------------------------------------------------------------------------
const plan: AugPlan = {
  generatedAt: new Date().toISOString(),
  sourceNote: "由 data/2026-09/aug-payroll-trial（8 月試算輸出，只讀）＋dev DB 現況生成，唔入 git。",
  sites: { create: [], updateAliases: [], updateClientGroup: [], setParent: [] },
  shiftTypes: { create: [] },
  rateCards: { create: [], closeJuly: [] },
  guards: { create: [] },
  needsBossReview: [],
};

function addAlias(target: SiteAliasUpdatePlan[], canonicalName: string, alias: string, note: string) {
  let entry = target.find((e) => e.canonicalName === canonicalName);
  if (!entry) {
    entry = { canonicalName, addAliases: [], note };
    target.push(entry);
  }
  if (!entry.addAliases.includes(alias)) entry.addAliases.push(alias);
}

async function main() {
  console.log("[build-aug-plan] 讀試算輸出＋dev DB 現況……");
  const db = await loadDbSnapshot();
  const pstb = loadPriceSiteTimeBroker();
  const revenue = loadRevenueSite();
  const overrides = loadPriceOverrides();
  const records = loadRosterRecords();
  const fixture = loadRosterFixture();

  const siteByName = new Map(db.sites.map((s) => [s.canonicalName, s]));

  // -------------------------------------------------------------------
  // 1. 盤：新建／aliases／parent／client_group
  // -------------------------------------------------------------------
  // 1a. 城巴車廠母盤（純粹分組用，唔逐更收費）
  plan.sites.create.push({
    canonicalName: CITYBUS_PARENT,
    clientName: "城巴",
    clientGroup: "城巴車廠",
    aliases: [],
    billingModel: "per_shift",
    monthlyFee: null,
    monthlyPosts: null,
    parentCanonicalName: null,
    guardsPaidByClient: false,
    note: "新建母盤，純粹分組用（一檔多子盤）；8 個現有「城巴-*」車廠盤＋新建「城巴-海洋公園車廠」掛落嚟做 parent_site_id。母盤本身唔起 shift_types/rate_cards。",
  });
  const CITYBUS_CHILDREN = [
    "城巴-上環車廠",
    "城巴-創富車廠",
    "城巴-將軍澳車廠",
    "城巴-屯門車廠",
    "城巴-東涌車廠",
    "城巴-柴灣車廠",
    "城巴-西九龍車廠",
    "城巴-黃竹坑車廠",
  ];
  for (const name of CITYBUS_CHILDREN) {
    plan.sites.setParent.push({ canonicalName: name, parentCanonicalName: CITYBUS_PARENT, note: "掛落新起嘅「城巴車廠」母盤（原本 parent_site_id=null）。" });
  }

  // 1a-2. 啟航1331 Event 獨立盤（見上面 EVENT_SITE 註解）
  plan.sites.create.push({
    canonicalName: EVENT_SITE,
    clientName: "啟德", // 同現有「啟航1331」盤嘅 client_name 一致
    clientGroup: "啟航1331",
    aliases: ["啟航1331 Event Guard"],
    billingModel: "per_shift",
    monthlyFee: null,
    monthlyPosts: null,
    parentCanonicalName: null,
    guardsPaidByClient: false,
    note: "8 月新盤（Event 崗，boss_answers.py 七：雞頭 K、外判 990／更、上單 1,350／更，8 月起）。獨立盤而唔係「啟航1331」alias：B-0 上載「同盤同月新上載取代舊版」，同一個盤會令 Event 檔同正常 1331 檔互相 supersede。",
  });

  // 1b. site_id → 新建盤
  for (const [siteId, res] of Object.entries(SITE_CODE_MAP)) {
    if (res.kind === "new") {
      if (!plan.sites.create.find((s) => s.canonicalName === res.site.canonicalName)) {
        plan.sites.create.push(res.site);
      }
    } else if (!siteByName.has(res.canonicalName)) {
      plan.needsBossReview.push(`SITE_CODE_MAP 話 ${siteId} 係現有盤「${res.canonicalName}」，但 dev DB 搵唔到呢個 canonical_name——要人手核對。`);
    }
  }

  // 1c. 額外 aliases（Wilson Control/Patrol——老闆 2026-09-24 已確認，唔
  //     再落 needsBossReview，見 EXTRA_ALIASES 頭段註解）
  for (const { canonicalName, alias, note } of EXTRA_ALIASES) {
    addAlias(plan.sites.updateAliases, canonicalName, alias, note);
  }

  // 1d. clientGroup='卓弘'（規則 12a：恆星樓／葵發大廈）
  for (const name of ["恆星樓", "葵發大廈"]) {
    const site = siteByName.get(name);
    if (site && site.clientGroup !== "卓弘") {
      plan.sites.updateClientGroup.push({ canonicalName: name, clientGroup: "卓弘", note: "規則 12a：客戶「卓弘」底下盤唔計長工介紹費（老闆 2026-09-22）。" });
    }
  }

  // 1e. 36 個 8 月檔 siteRaw 逐個要對到一個盤——用返同 matchSite() 一致嘅邏輯
  //     （exact canonicalName 然後 alias），核對 plan 生效之後係咪全部對得到。
  const plannedNewNames = new Set(plan.sites.create.map((s) => s.canonicalName));
  const plannedAliasesByName = new Map<string, string[]>();
  for (const s of plan.sites.create) plannedAliasesByName.set(s.canonicalName, s.aliases);
  for (const u of plan.sites.updateAliases) {
    const existing = siteByName.get(u.canonicalName);
    plannedAliasesByName.set(u.canonicalName, [...(existing?.aliases ?? []), ...u.addAliases]);
  }
  function resolveAfterPlan(siteRaw: string): string | null {
    for (const s of db.sites) if (s.canonicalName === siteRaw) return s.canonicalName;
    for (const name of plannedNewNames) if (name === siteRaw) return name;
    for (const s of db.sites) if (s.aliases.includes(siteRaw)) return s.canonicalName;
    for (const [name, aliases] of plannedAliasesByName) if (aliases.includes(siteRaw)) return name;
    return null;
  }
  const unresolvedFiles: string[] = [];
  for (const [fileName, f] of Object.entries(fixture.files)) {
    if (!resolveAfterPlan(f.siteRaw)) unresolvedFiles.push(`${fileName}（siteRaw="${f.siteRaw}"）`);
  }
  if (unresolvedFiles.length > 0) {
    plan.needsBossReview.push(`plan 生效之後仲有 ${unresolvedFiles.length} 個 8 月檔 siteRaw 對唔到任何盤：${unresolvedFiles.join("；")}`);
  }

  // -------------------------------------------------------------------
  // 2. records.jsonl 彙總：(site_raw, sub_site) → (code_raw,time_slot,broker_code) 出現次數
  //    用嚟幫新盤/新更種推斷實際代號（唔用啟發式猜）。
  // -------------------------------------------------------------------
  type CellKey = string; // code|time
  const cellCountBySite = new Map<string, Map<CellKey, number>>();
  for (const r of records) {
    if (r.kind !== "work" && r.kind !== "shift" && r.time_slot == null) continue;
    const siteKey = r.sub_site ?? r.site_raw;
    if (!siteKey || !r.time_slot) continue;
    const m = cellCountBySite.get(siteKey) ?? new Map<CellKey, number>();
    const k = `${r.code_raw}|${r.time_slot}`;
    m.set(k, (m.get(k) ?? 0) + 1);
    cellCountBySite.set(siteKey, m);
  }
  /** 有啲盤（例：城巴-海洋公園車廠）records.jsonl 入面係用子盤名
   * （sub_site）做 key，唔係盤嘅 canonical_name——呢個函數將 canonicalName
   * 本身＋佢所有已知 alias（DB 現有 + plan 度加緊嘅）嘅 cellCountBySite
   * entry 合埋一齊，先搵得到。 */
  function mergedCellMap(canonicalName: string): Map<CellKey, number> | null {
    const keys = new Set<string>([canonicalName]);
    const dbSite = siteByName.get(canonicalName);
    for (const a of dbSite?.aliases ?? []) keys.add(a);
    for (const a of plannedAliasesByName.get(canonicalName) ?? []) keys.add(a);
    for (const a of RECORD_LOOKUP_EXTRA_KEYS[canonicalName] ?? []) keys.add(a);
    let merged: Map<CellKey, number> | null = null;
    for (const k of keys) {
      const m = cellCountBySite.get(k);
      if (!m) continue;
      merged = merged ?? new Map();
      for (const [ck, n] of m) merged.set(ck, (merged.get(ck) ?? 0) + n);
    }
    return merged;
  }
  function dominantCodeForTime(siteRawOrSub: string, timeSlot: string): string | null {
    const m = mergedCellMap(siteRawOrSub);
    if (!m) return null;
    let best: string | null = null;
    let bestN = -1;
    for (const [k, n] of m) {
      const [code, t] = k.split("|");
      if (t !== timeSlot) continue;
      if (n > bestN) {
        best = code;
        bestN = n;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------
  // 3. ShiftType：逐個 pstb 組（siteId|time|broker）+ zone 組 攞晒要用嘅 (site,time)
  //    對現有 shift_types。
  //
  //    重要落差：總表（pstb 嘅 key）嘅時段同更表檔案（records.jsonl）嘅
  //    time_slot 逐盤都可以差 30 分鐘至 1 小時（例：殷樺花園總表
  //    1930-0730、更表 1900-0700；啟航1331 IC 總表 1430-2330、更表
  //    1430-2230）——呢個係總表本身時段寫法習慣，唔係兩個唔同嘅更。規則
  //    11／15.1：計糧以更表檔案為準，所以 shift_type 嘅時間跟更表
  //    （records.jsonl），總表淨係用嚟計價（E/F）。做法：(1) 先試 pstb
  //    嘅時段做 exact match；(2) 搵唔到就用「開工時間」（HH:MM 開始
  //    嗰段）响 dev DB 嘅 shift_types／records.jsonl 逐個試，開工時間
  //    夾中就當同一個更（用嗰個結果嘅實際 end time，唔勉強套用 pstb 嘅
  //    end）；(3) 兩者都搵唔到、而個盤有更表檔案資料就用更表嘅時段起新
  //    shift_type；(4) 完全新盤（冇更表檔案，例如 Weave ML）就用 pstb
  //    嘅時段起。
  // -------------------------------------------------------------------
  const shiftTypeCreateKey = new Set<string>(); // dedupe：canonicalName|code|start|end
  function dbCandidatesAt(site: { id: string }, start: string, end: string | null) {
    return db.shiftTypes.filter((st) => st.siteId === site.id && hhmm(st.startTime) === start && (end === null || hhmm(st.endTime) === end));
  }
  function rosterTimeSlotsStartingAt(canonicalName: string, startHHMM: string): string[] {
    const m = mergedCellMap(canonicalName);
    if (!m) return [];
    const wantStart = startHHMM.replace(":", "");
    const out = new Set<string>();
    for (const k of m.keys()) {
      const [, t] = k.split("|");
      if (t?.startsWith(wantStart)) out.add(t);
    }
    return [...out];
  }
  // MR-<label>（master-roster-only 合成更別，見 schema 註解）／PR（糧明細
  // 生成 reconciliation placeholder，見 resolve-rate.ts requireExactShiftTypeMatch()
  // 註解）——呢兩類都係「更表冇對應資料，靠總表/糧明細倒推出嚟」嘅合成
  // code，更表檔案嘅真實代號（D/N/…）唔會同呢類 code 撞（DB unique 淨係
  // site+code+start_time，code 唔同就唔撞），所以搵到更表嘅真實代號時，
  // 唔可以「淨係睇時段啱就當呢個更」咁重用 placeholder shift_type——要
  // 另外起一個真代號嘅（國泰城/M+/恆星樓 3 個盤嘅已知缺口，見 §15.5
  // Phase B-0 記錄）。
  function isPlaceholderCode(code: string): boolean {
    return code.startsWith("MR-") || code === "PR";
  }
  function ensureShiftType(canonicalName: string, timeSlot: string, codeHint: string | null, note: string): { code: string; startTime: string; endTime: string } | null {
    const parsed = parseTimeSlot(timeSlot);
    if (!parsed) {
      plan.needsBossReview.push(`「${canonicalName}」時段字串 "${timeSlot}" 解析唔到（唔係 HHMM-HHMM 格式），跳過。`);
      return null;
    }
    const [start, end] = parsed;
    const site = siteByName.get(canonicalName);
    // 更表檔案有幾多真實代號可以推斷（唔理邊個時段）——用嚟判斷 exact/
    // start-only match 揾到嘅 placeholder code 應唔應該畀真代號取代。
    const rosterHasRealCode = dominantCodeForTime(canonicalName, timeSlot) !== null || (mergedCellMap(canonicalName)?.size ?? 0) > 0;

    // (1) exact match
    if (site) {
      const exact = dbCandidatesAt(site, start, end);
      if (exact.length === 1 && !(isPlaceholderCode(exact[0].code) && rosterHasRealCode)) {
        return { code: exact[0].code, startTime: start, endTime: end };
      }
      if (exact.length > 1) {
        // 冪等補丁（Opus 驗收提出）：`--apply` 之後再 `build`，dev DB 呢個
        // 時段可能已經有「7 月 placeholder（MR-/PR）＋ 8 月新起嘅真代號」
        // 共存（例：控制室 MR- + N + N-IC 全部 19:30-07:30；數碼港 CP5
        // D + D-2 全部 0750-1950）——舊版淨係揀 `exact[0]`（DB 查詢次序，
        // 唔保證跨 run 一致），令第二次 build 有機會揀中 placeholder 或者
        // 揀錯代號，起多咗一張本來應該同第一次 build 一樣嘅卡（plan diff
        // 唔再係 0，唔冪等）。而家：(a) 已知想要邊個代號（`codeHint`，通
        // 常係 `dominantCodeForTime()` 嘅結果）就直接搵嗰個代號嘅 exact
        // match，搵到就用，唔理仲有幾多個其他 candidate；(b) 排除
        // placeholder 代號（`MR-`/`PR`）先至揀「剩返幾多個」；(c) 上面兩
        // 步都搵唔到先至跌落原本嘅「全部都係 placeholder」／
        // needsBossReview 呢兩層 fallback。
        if (codeHint) {
          const exactCodeMatch = exact.find((c) => c.code === codeHint);
          if (exactCodeMatch) return { code: exactCodeMatch.code, startTime: start, endTime: end };
        }
        const nonPlaceholder = exact.filter((c) => !isPlaceholderCode(c.code));
        if (nonPlaceholder.length === 1) {
          return { code: nonPlaceholder[0].code, startTime: start, endTime: end };
        }
        const realCode = dominantCodeForTime(canonicalName, timeSlot);
        if (realCode && exact.every((c) => isPlaceholderCode(c.code))) {
          // 全部候選都係 placeholder code，但更表有真實代號——照樣起一個
          // 真代號嘅（唔撞 unique，code 唔同），唔使揀邊個 placeholder。
          const dedupeKey = `${canonicalName}|${realCode}|${start}|${end}`;
          if (!shiftTypeCreateKey.has(dedupeKey)) {
            shiftTypeCreateKey.add(dedupeKey);
            plan.shiftTypes.create.push({ siteCanonicalName: canonicalName, code: realCode, startTime: start, endTime: end, billingGroup: "per_shift", note: `${note}（dev DB 呢個時段淨係得 ${exact.length} 個 placeholder code，更表話真代號係「${realCode}」，另起一個真代號嘅，冇撞 unique）。` });
          }
          return { code: realCode, startTime: start, endTime: end };
        }
        plan.needsBossReview.push(`「${canonicalName}」時段 ${timeSlot} 喺 dev DB 已經有 ${exact.length} 個完全同時段嘅 shift_type（${exact.map((c) => c.code).join(",")}，屬既有資料重複，唔喺呢個 WP 範圍改）——逐張卡都掛，人手覆核揀邊個啱。`);
        return { code: (nonPlaceholder[0] ?? exact[0]).code, startTime: start, endTime: end };
      }
    }

    // (2) 開工時間（start-only）喺 dev DB 搵——總表/更表時段寫法唔一致嘅落差。
    if (site) {
      const byStart = dbCandidatesAt(site, start, null);
      if (byStart.length === 1 && !(isPlaceholderCode(byStart[0].code) && rosterHasRealCode)) {
        const c = byStart[0];
        const realEnd = hhmm(c.endTime) ?? end;
        return { code: c.code, startTime: start, endTime: realEnd };
      }
    }

    // (2.5) 呢個盤成個更表檔案淨係得一種時段（連開工時間都可以唔啱，例如
    // 殷樺花園總表 1930-0730、更表實際 1900-0700）——冇歧義，直接用更表
    // 嗰個（一個盤一種更嘅簡單案例，用「開工時間夾埋」呢個較嚴嘅 heuristic
    // 反而會漏咗佢）。
    {
      const m = mergedCellMap(canonicalName);
      if (m) {
        const distinctTimes = new Set([...m.keys()].map((k) => k.split("|")[1]));
        if (distinctTimes.size === 1) {
          const rosterTime = [...distinctTimes][0];
          const rp = parseTimeSlot(rosterTime);
          if (rp) {
            const [rStart, rEnd] = rp;
            const code = dominantCodeForTime(canonicalName, rosterTime) ?? codeHint ?? "D";
            if (site) {
              const exact2 = dbCandidatesAt(site, rStart, rEnd);
              if (exact2.length === 1 && !isPlaceholderCode(exact2[0].code)) return { code: exact2[0].code, startTime: rStart, endTime: rEnd };
            }
            const dedupeKey = `${canonicalName}|${code}|${rStart}|${rEnd}`;
            if (!shiftTypeCreateKey.has(dedupeKey)) {
              shiftTypeCreateKey.add(dedupeKey);
              plan.shiftTypes.create.push({ siteCanonicalName: canonicalName, code, startTime: rStart, endTime: rEnd, billingGroup: "per_shift", note: `${note}（時段跟更表檔案 ${rosterTime}——呢個盤成份更表淨係一種時段，同總表時段 ${timeSlot} 有落差，以更表為準）。` });
            }
            return { code, startTime: rStart, endTime: rEnd };
          }
        }
      }
    }

    // (3) 更表檔案（records.jsonl）開工時間搵——用更表嘅實際時段起新（如果 DB 未有）。
    const rosterSlots = rosterTimeSlotsStartingAt(canonicalName, start);
    if (rosterSlots.length >= 1) {
      const rosterTime = rosterSlots[0]; // 一個盤同開工時間通常淨係一個更，唔止一個就用第一個＋落 review
      if (rosterSlots.length > 1) {
        plan.needsBossReview.push(`「${canonicalName}」開工時間 ${start} 喺更表檔案有 ${rosterSlots.length} 個唔同收工時間（${rosterSlots.join(",")}）——用咗 ${rosterTime}，人手覆核。`);
      }
      const rp = parseTimeSlot(rosterTime);
      if (rp) {
        const [rStart, rEnd] = rp;
        const code = dominantCodeForTime(canonicalName, rosterTime) ?? codeHint ?? "D";
        if (site) {
          const exact2 = dbCandidatesAt(site, rStart, rEnd);
          if (exact2.length === 1 && !isPlaceholderCode(exact2[0].code)) return { code: exact2[0].code, startTime: rStart, endTime: rEnd };
        }
        const dedupeKey = `${canonicalName}|${code}|${rStart}|${rEnd}`;
        if (!shiftTypeCreateKey.has(dedupeKey)) {
          shiftTypeCreateKey.add(dedupeKey);
          plan.shiftTypes.create.push({ siteCanonicalName: canonicalName, code, startTime: rStart, endTime: rEnd, billingGroup: "per_shift", note: `${note}（時段跟更表檔案 ${rosterTime}，同總表時段 ${timeSlot} 有落差）。` });
        }
        return { code, startTime: rStart, endTime: rEnd };
      }
    }

    // (4) 完全新盤，冇更表資料可以對——用 pstb 嘅時段起，code 用 hint 或者預設 D/N（跨午夜）。
    const code = codeHint ?? (parseInt(start.slice(0, 2), 10) >= 18 || parseInt(start.slice(0, 2), 10) < 5 ? "N" : "D");
    const dedupeKey = `${canonicalName}|${code}|${start}|${end}`;
    if (!shiftTypeCreateKey.has(dedupeKey)) {
      shiftTypeCreateKey.add(dedupeKey);
      plan.shiftTypes.create.push({ siteCanonicalName: canonicalName, code, startTime: start, endTime: end, billingGroup: "per_shift", note: `${note}（冇更表檔案資料，時段/代號跟總表＋預設 D/N 啟發式，人手覆核）。` });
      plan.needsBossReview.push(`「${canonicalName}」時段 ${timeSlot}：冇更表檔案資料可以核實代號，用咗預設「${code}」，人手覆核。`);
    }
    return { code, startTime: start, endTime: end };
  }

  // 補丁：`PSTB_KEY_SHIFT_CODE_OVERRIDE` 指定咗要掛邊個 code 嗰陣用呢個
  // 代替 `ensureShiftType()`——直接喺 dev DB 現有嘅 shift_types 搵指定
  // code＋時段嗰個（唔經 `dominantCodeForTime()` 嘅「代號多數票」邏輯，
  // 唔會撞返 monthly_ic／per_shift 兩個候選揀邊個嘅老問題）。搵唔到就
  // needsBossReview，唔會靜靜哋落去 ensureShiftType 嘅 fallback 起錯。
  function resolveExistingShiftTypeByCode(canonicalName: string, timeSlot: string, code: string, note: string): { code: string; startTime: string; endTime: string } | null {
    const parsed = parseTimeSlot(timeSlot);
    if (!parsed) {
      plan.needsBossReview.push(`「${canonicalName}」時段字串 "${timeSlot}" 解析唔到（唔係 HHMM-HHMM 格式），跳過（${note}）。`);
      return null;
    }
    const [start, end] = parsed;
    const site = siteByName.get(canonicalName);
    const found = site ? dbCandidatesAt(site, start, end).find((c) => c.code === code) : undefined;
    if (!found) {
      plan.needsBossReview.push(`「${canonicalName}」搵唔到 code=${code} 時段=${timeSlot} 嘅現有 shift_type（${note}），人手覆核。`);
      return null;
    }
    return { code: found.code, startTime: start, endTime: end };
  }

  // 希慎廣場嘅「兩個時段都建」特殊處理喺主 loop 起完 X05 嘅 shift_type/
  // rate_card 之後做（見下面「希慎廣場總表時段」一段）——唔可以喺呢度用
  // ensureShiftType 起，因為 step(2.5)「成份更表淨係一種時段」嘅 fallback
  // 會將 1930-0930 都改正做 1930-0730（啱晒其他場景，但呢度想要嘅係
  // 額外、獨立嘅第二個時段，唔係更正）。

  // -------------------------------------------------------------------
  // 4. RateCard：先處理 zone、person 覆蓋，再處理其餘 101 組。
  // -------------------------------------------------------------------
  type CardKey = string;
  const cardSeen = new Set<CardKey>();
  function pushCard(c: NewRateCardPlan) {
    const key = `${c.siteCanonicalName}|${c.shiftType ? `${c.shiftType.code}@${c.shiftType.startTime}-${c.shiftType.endTime}` : "flat"}|${c.brokerCode ?? "-"}|${c.guardStaffNo ?? "-"}|${c.clientRate ?? "-"}|${c.guardWage ?? "-"}|${c.brokerFee ?? "-"}`;
    if (cardSeen.has(key)) return;
    cardSeen.add(key);
    plan.rateCards.create.push(c);
  }

  function siteNameForCode(siteId: string): string | null {
    const res = SITE_CODE_MAP[siteId];
    if (!res) return null;
    return res.kind === "existing" ? res.canonicalName : res.site.canonicalName;
  }

  // 4a. zone 覆蓋（例：啟航1331 2230-0730 K 嘅 SIC/IC）
  const zoneHandledGroups = new Set<string>(); // "siteId|time|broker"
  for (const [key, v] of Object.entries(overrides.zone)) {
    const [siteId, time, broker, code] = key.split("|");
    const canonicalName = siteNameForCode(siteId);
    if (!canonicalName) {
      plan.needsBossReview.push(`zone 覆蓋 "${key}"：site_id ${siteId} 冇喺 SITE_CODE_MAP。`);
      continue;
    }
    zoneHandledGroups.add(`${siteId}|${time}|${broker}`);
    const parsed = parseTimeSlot(time);
    if (!parsed) continue;
    const [start, end] = parsed;
    const site = siteByName.get(canonicalName);
    const shiftType = site ? db.shiftTypes.find((st) => st.siteId === site.id && st.code === code && hhmm(st.startTime) === start && hhmm(st.endTime) === end) : null;
    if (!shiftType) {
      plan.needsBossReview.push(`zone 覆蓋 "${key}"：「${canonicalName}」搵唔到 code=${code} 時段=${time} 嘅 shift_type，人手覆核。`);
      continue;
    }
    pushCard({
      siteCanonicalName: canonicalName,
      shiftType: { code, startTime: start, endTime: end },
      brokerCode: broker,
      guardStaffNo: null,
      clientRate: v.E,
      guardWage: v.F,
      brokerFee: 0,
      billingModel: "per_shift",
      effectiveFrom: EFFECTIVE_FROM,
      source: `aug-opening:price_overrides.json#zone["${key}"]`,
      note: `zone 覆蓋（${key}）：E=${v.E} F=${v.F} n=${v.n}`,
      level: "site_shift_broker",
    });
  }

  // 4b. person 覆蓋（8 個逐人價）
  const personGroupClientDone = new Set<string>(); // "siteId|time|broker"
  const guardStaffNoByName = new Map<string, string[]>(); // nameZh -> [staffNo,...]（一個名可以夾幾個 U 號，靠 build 時人手覆核）
  {
    const staffRows = await prisma.guardStaffNumber.findMany({ where: { scheme: "U", status: "current" }, select: { number: true, guard: { select: { nameZh: true } } } });
    for (const row of staffRows) {
      const arr = guardStaffNoByName.get(row.guard.nameZh) ?? [];
      arr.push(row.number);
      guardStaffNoByName.set(row.guard.nameZh, arr);
    }
  }
  for (const [key, v] of Object.entries(overrides.person)) {
    const parts = key.split("|");
    const name = parts[parts.length - 1];
    const [siteId, time, broker] = parts;
    const canonicalName = siteNameForCode(siteId);
    if (!canonicalName) {
      plan.needsBossReview.push(`person 覆蓋 site_id ${siteId}：冇喺 SITE_CODE_MAP。`);
      continue;
    }
    const parsed = parseTimeSlot(time);
    if (!parsed) continue;
    const [start, end] = parsed;
    const site = siteByName.get(canonicalName);
    const shiftType = site ? db.shiftTypes.find((st) => st.siteId === site.id && hhmm(st.startTime) === start && hhmm(st.endTime) === end) : null;
    if (!shiftType) {
      plan.needsBossReview.push(`person 覆蓋「${canonicalName}」時段 ${time}：dev DB 搵唔到對應 shift_type，人手覆核（見 shiftTypes.create 有冇起到）。`);
      continue;
    }
    const groupKey = `${siteId}|${time}|${broker}`;
    if (!personGroupClientDone.has(groupKey)) {
      personGroupClientDone.add(groupKey);
      // Opus 5.5 驗收加：組級卡都要有一個「預設外判价」＝呢組出現次數最多
      // 嘅 F——原本 guardWage=null，逐人卡對唔到人（例：HKU座頭 2200-0615
      // 嗰位 dev DB 冇現用 U 號）或者之後新加入呢組嘅人，出街价會跌落 7 月
      // 舊卡或者變未定价。逐人卡（rank 0）照樣贏呢張組級卡（rank 2）。
      const groupF = pstb[groupKey]?.F ?? {};
      const modalF = Object.keys(groupF).sort((a, b) => groupF[b] - groupF[a])[0];
      const fallbackWage = modalF !== undefined ? Number(modalF) : null;
      pushCard({
        siteCanonicalName: canonicalName,
        shiftType: { code: shiftType.code, startTime: start, endTime: end },
        brokerCode: broker,
        guardStaffNo: null,
        clientRate: v.E,
        guardWage: fallbackWage,
        brokerFee: fallbackWage !== null ? 0 : null,
        billingModel: "per_shift",
        effectiveFrom: EFFECTIVE_FROM,
        source: `aug-opening:price_overrides.json#multi_price_groups["${groupKey}"]`,
        note: `逐人覆蓋組嘅組級卡（${groupKey}）：收客价 E=${v.E}；預設外判价 F=${fallbackWage}（組內出現次數最多；逐人卡見下，優先過呢張）`,
        level: "site_shift_generic",
      });
    }
    const staffNos = guardStaffNoByName.get(name);
    if (!staffNos || staffNos.length === 0) {
      plan.needsBossReview.push(`person 覆蓋「${canonicalName}」${time}：姓名喺 dev DB guards 對唔到現用 U 號安員——要人手核實同建卡（F=${v.F}）。`);
      continue;
    }
    if (staffNos.length > 1) {
      plan.needsBossReview.push(`person 覆蓋「${canonicalName}」${time}：姓名對到 ${staffNos.length} 個 U 號（${staffNos.join(",")}）——撞名，要人手揀。`);
      continue;
    }
    pushCard({
      siteCanonicalName: canonicalName,
      shiftType: { code: shiftType.code, startTime: start, endTime: end },
      brokerCode: broker,
      guardStaffNo: staffNos[0],
      clientRate: null,
      guardWage: v.F,
      brokerFee: 0,
      billingModel: "per_shift",
      effectiveFrom: EFFECTIVE_FROM,
      source: `aug-opening:price_overrides.json#person["${groupKey}|<姓名>"]`,
      note: `逐人外判价卡（F=${v.F}，n=${v.n}）。`,
      level: "site_shift_guard",
    });
  }

  // 4c. 其餘 101 組（扣走 zone/person 已經處理嗰啲）
  const conflictGroups: string[] = [];
  for (const [key, entry] of Object.entries(pstb)) {
    const [siteId, time, broker] = key.split("|");
    if (zoneHandledGroups.has(`${siteId}|${time}|${broker}`)) continue;
    const isMultiPriceGroup = overrides.multi_price_groups.includes(`${siteId}|${time}|${broker}`);
    if (isMultiPriceGroup) continue; // 已經喺 4b 處理晒
    const canonicalName = PSTB_KEY_SITE_OVERRIDE[key] ?? siteNameForCode(siteId);
    if (!canonicalName) {
      plan.needsBossReview.push(`pstb 組 "${key}"：site_id ${siteId} 冇喺 SITE_CODE_MAP。`);
      continue;
    }
    if (!parseTimeSlot(time)) continue;
    const codeOverride = PSTB_KEY_SHIFT_CODE_OVERRIDE[key];
    const st = codeOverride
      ? resolveExistingShiftTypeByCode(canonicalName, time, codeOverride, `pstb 組 ${key}（n=${entry.n}，rank 收窄補丁——強制掛 ${codeOverride}，見 PSTB_KEY_SHIFT_CODE_OVERRIDE）`)
      : ensureShiftType(canonicalName, time, dominantCodeForTime(canonicalName, time), `pstb 組 ${key}（n=${entry.n}）。`);
    if (!st) continue;

    const eKeys = Object.keys(entry.E);
    const fKeys = Object.keys(entry.F);
    if (eKeys.length > 1) {
      const under5000 = eKeys.filter((k) => Number(k) < 5000);
      if (under5000.length > 1) conflictGroups.push(`${key}：E 有 ${eKeys.length} 個值（${eKeys.join(",")}），扣走 ≥5000（月費）之後仲有 ${under5000.length} 個唔同嘅逐更价，唔喺 overrides 入面解釋——冇自動起卡，人手覆核。`);
    }
    if (fKeys.length > 1 && !isMultiPriceGroup) {
      conflictGroups.push(`${key}：F 有 ${fKeys.length} 個值（${fKeys.join(",")}），唔喺 multi_price_groups/zone 入面解釋——冇自動起卡，人手覆核。`);
    }

    // 收客价／出街价合併做一張卡（site+shiftType+broker 呢個組合淨係
    // 應該得一張卡——分開兩張嘅話 apply-aug-plan.ts 嘅 natural key
    // （site+shiftType+broker+guard+effective_from，冇分 client/payout）
    // 會將第二張當「已存在」靜靜跳過）。
    const skipClientSite = SKIP_PER_SHIFT_CLIENT_SITES.has(canonicalName);
    let clientRate: number | null = null;
    let clientNoteFrag = "";
    if (!skipClientSite) {
      const under5000E = eKeys.filter((k) => Number(k) < 5000);
      if (under5000E.length === 1) {
        clientRate = Number(under5000E[0]);
        clientNoteFrag = `收客价 E=${under5000E[0]}；`;
      }
      // eKeys.length===1 且 ≥5000：交俾 site flat 卡，呢度唔起。
      // under5000E.length>1：已經計咗做 conflict，唔自動起。
    }
    let guardWage: number | null = null;
    let fNoteFrag = "";
    if (fKeys.length >= 1) {
      let bestF = fKeys[0];
      if (fKeys.length > 1) {
        bestF = fKeys.reduce((a, b) => (entry.F[a] >= entry.F[b] ? a : b));
      }
      guardWage = Number(bestF);
      fNoteFrag = `外判价/公司兵工資 F=${bestF}${fKeys.length > 1 ? "（多值揀出現次數最多）" : ""}；`;
    }
    if (clientRate !== null || guardWage !== null) {
      pushCard({
        siteCanonicalName: canonicalName,
        shiftType: st,
        brokerCode: broker,
        guardStaffNo: null,
        clientRate,
        guardWage,
        brokerFee: guardWage !== null ? 0 : null,
        billingModel: "per_shift",
        effectiveFrom: EFFECTIVE_FROM,
        source: `aug-opening:price_site_time_broker.json["${key}"]`,
        note: `${clientNoteFrag}${fNoteFrag}n=${entry.n}`,
        level: "site_shift_broker",
      });
    }
  }
  if (conflictGroups.length > 0) {
    plan.needsBossReview.push(`101 組入面 ${conflictGroups.length} 組資料本身有矛盾（唔喺 overrides 解釋嘅多值）：\n  - ${conflictGroups.join("\n  - ")}`);
  }

  // -------------------------------------------------------------------
  // 4c-補. 啟航1331「OT3.5」：更表檔案有 2 格 OT3.5@1500-1830（code_kind=ot），
  // 101 組價目（price_site_time_broker.json／price_overrides.json）都冇
  // 呢個 key，冇价目資料可以起卡——起呢個 shift_type 純粹係為咗上載配對
  // 唔跌 unmatched_shift_type，唔起 rate_card。**WP-MIXED-BILLING 更新**：
  // OT 記錄而家會行落 resolve-rate.ts 嘅卡揀邏輯（唔再盲目返 null），冇
  // 起 rate_card 嘅話呢 2 條 OT 記錄（如果之後真係喺更表編輯器入咗）會
  // 變「未定价 OT」（unpriced.ts `ot_unpriced`），呢個係老闆拍板嘅預期
  // 行為（老闆：「OT 逐盤逐人人手設卡」，冇卡就係未定价，唔系統自動套
  // 公式）——留返俾會計/老闆之後人手設卡。
  // -------------------------------------------------------------------
  {
    const key = "啟航1331|OT3.5|15:00-18:30";
    if (!shiftTypeCreateKey.has(key)) {
      shiftTypeCreateKey.add(key);
      plan.shiftTypes.create.push({
        siteCanonicalName: "啟航1331",
        code: "OT3.5",
        startTime: "15:00",
        endTime: "18:30",
        billingGroup: "per_shift",
        note: "更表檔案有 2 格 OT3.5@1500-1830（code_kind=ot），101 組價目冇對應資料——純粹起 shift_type 令上載配對唔跌 unmatched，唔起 rate_card（OT 冇統一公式，老闆話逐盤逐人人手設卡，見 needsBossReview）。",
      });
      plan.needsBossReview.push("啟航1331 OT3.5@1500-1830：冇試算价目資料，冇起 rate_card——呢個 OT 要另計出街价嘅話，要老闆/會計人手起 OT 更種卡（site/broker/guard 級皆可，見 resolve-rate.ts）。冇卡嘅話呢批 OT 記錄會顯示「未定价 OT」。");
    }
  }

  // -------------------------------------------------------------------
  // 4c-補2. HKU座頭「1Hr OT」（老闆 2026-09-24 答：OT 冇統一公式，但呢個
  //     有試算价目資料就照起卡）：pstb「S007|1Hr OT|Y」E=84.85／F=73／
  //     n=1——「時段」寫「1Hr OT」（唔係 HH:MM-HH:MM 格式），`parseTimeSlot()`
  //     解析唔到，主 loop（4c）會靜靜 `continue` 跳過呢組，冇起到任何嘢。
  //     dev DB 7 月本身已經有「HKU座頭」嘅「OT1」更種（06:15-07:15，
  //     hours=1，掛喺「C1」正更 22:00-06:15 之後嗰 1 個鐘）——「1Hr OT」
  //     同「OT1」語意一致（都係 1 個鐘嘅 OT），唔使另起 shift_type（更種
  //     唔分月份，同其他正更一樣係跨月重用嘅定義），淨係加一張 8 月嘅
  //     site+shiftType 級卡（broker Y，client=84.85／guard=73，呢張卡嘅
  //     金額本身就係「每粒鐘」嘅价——OT 記錄 resolver 而家直接用嚟做
  //     client_rate_snapshot/guard_wage_snapshot，唔再除 hours，見
  //     src/lib/reports/gross-margin.ts「WP-MIXED-BILLING」段落）。
  // -------------------------------------------------------------------
  {
    const st = resolveExistingShiftTypeByCode("HKU座頭", "0615-0715", "OT1", "pstb 組 S007|1Hr OT|Y（n=1）——套用現有「OT1」更種（06:15-07:15，hours=1，語意同「1Hr OT」一致）");
    if (st) {
      pushCard({
        siteCanonicalName: "HKU座頭",
        shiftType: st,
        brokerCode: "Y",
        guardStaffNo: null,
        clientRate: 84.85,
        guardWage: 73,
        brokerFee: 0,
        billingModel: "per_shift",
        effectiveFrom: EFFECTIVE_FROM,
        source: `aug-opening:price_site_time_broker.json["S007|1Hr OT|Y"]`,
        note: "HKU座頭 1Hr OT（老闆 2026-09-24 答：OT 冇統一公式，但呢個試算有价目資料就照起卡）——site+shiftType 級（broker Y），金額本身係每粒鐘价，OT resolver 直接用（唔除 hours）。",
        level: "site_shift_broker",
      });
    } else {
      plan.needsBossReview.push("HKU座頭「1Hr OT」（pstb S007|1Hr OT|Y，E=84.85 F=73 n=1）：dev DB 搵唔到現有「OT1」更種 06:15-07:15，冇起到卡，人手覆核。");
    }
  }

  // -------------------------------------------------------------------
  // 4d. 希慎廣場：老闆話「更表檔案 Time 欄為準，兩個都啱就兩個更種都建」——
  //     上面主 loop（處理 X05｜1930-0930｜K 呢組）已經跟返更表時段
  //     （1930-0730）起卡（見 ensureShiftType step 2.5）。呢度額外補一個
  //     總表時段 1930-0930 嘅 shift_type，同用一樣嘅 client/guard 价
  //     （複製剛先幫 1930-0730 起嘅卡）。**code 唔可以都用「N」**——DB
  //     `@@unique([siteId, code, startTime])` 淨係睇 code+start_time，
  //     唔包 end_time，兩個更種開工時間一樣（19:30）就一定要用唔同
  //     code，跟現有資料（數碼港 CP5 嘅 D/D-2、國泰城嘅 MR-…／-2/-3/-4）
  //     嘅「加後綴分開」慣例，用「N-總表」標明呢個係總表時段變體。
  // -------------------------------------------------------------------
  {
    const hysanCards = plan.rateCards.create.filter((c) => c.siteCanonicalName === "希慎廣場" && c.shiftType?.startTime === "19:30" && c.shiftType?.endTime === "07:30");
    if (hysanCards.length > 0) {
      const dedupeKey = "希慎廣場|N-總表|19:30-09:30";
      if (!shiftTypeCreateKey.has(dedupeKey)) {
        shiftTypeCreateKey.add(dedupeKey);
        plan.shiftTypes.create.push({
          siteCanonicalName: "希慎廣場",
          code: "N-總表",
          startTime: "19:30",
          endTime: "09:30",
          billingGroup: "per_shift",
          note: "總表/pstb 時段 1930-0930（同更表檔案時段 1930-0730 唔一致，老闆話兩個都要建（2026-09-24 再確認）；code 用「N-總表」因為 DB unique constraint 淨係睇 code+start_time，唔可以同「N」撞同一個 19:30 開工時間）。",
        });
      }
      for (const c of hysanCards) {
        pushCard({ ...c, shiftType: { code: "N-總表", startTime: "19:30", endTime: "09:30" }, note: `${c.note}（複製俾總表時段 1930-0930 用）。` });
      }
    } else {
      plan.needsBossReview.push("希慎廣場：主 loop 冇起到 1930-0730 嘅價目卡，冇嘢可以複製俾 1930-0930——人手覆核。");
    }
  }

  // -------------------------------------------------------------------
  // 4e. 控制室（WP-MIXED-BILLING，老闆 2026-09-24 拍板方案 (a)）：呢個盤
  //     8 月同時有月薪崗（月費 22,000，25 更）同日薪崗（逐更 840，22
  //     更）——pstb「S031|1930-0730|Y」E={840,22000} 呢個組合本身已經令
  //     上面主 loop（step 4c）自動起咗一個 per_shift 更種（code 跟更表
  //     「N」）+ 逐更卡（收客 840／外判 800，under5000E 邏輯揀中 840），
  //     下面 step 5（site flat 卡）另外會起 22,000 嘅 flat 卡——但呢一個
  //     單一 per_shift 更種如果畀月薪崗同日薪崗嘅記錄一齊用，月薪崗 25
  //     更都會攞到 840 逐更 client_rate（WP-MIXED-BILLING 修咗
  //     monthly-close.ts 之後，呢部分會加落收入），令 8 月收入變
  //     22,000+47×840=61,480，唔啱（老闆拍板應該係 40,480）。
  //
  //     records.jsonl 核實過（Wilson Control 檔，見 P2-版面重設計計劃.md
  //     §17.9）：冇逐格 rank／code 欄可以分「邊行係月薪崗」（同數碼港 CP5
  //     個 rank 欄唔同）——**淨係靠「人」分得到**：一位 25 更（月薪崗）、
  //     另一位 22 更（日薪崗）。跟任務指示「如果只能靠人分，用 guard 級卡
  //     或者 rank」：呢度做法係起多一個獨立更種（同數碼港 CP5 D/D-2 一致
  //     嘅模式）——月薪崗用新起嘅 monthly_ic 更種（7 月已有嘅 MR-/PR 更種
  //     唔改），日薪崗維持用主 loop 已經起嘅 per_shift 更種。邊個保安員
  //     報邊個更種要人手喺更表編輯器逐人揀（roster upload 冇欄位可以自動
  //     分流，match.ts 嘅 rank 收窄機制用唔到——落 needsBossReview）。
  // -------------------------------------------------------------------
  {
    const controlRoomPerShiftCard = plan.rateCards.create.find(
      (c) => c.siteCanonicalName === "控制室" && c.shiftType !== null && c.shiftType.startTime === "19:30" && c.shiftType.endTime === "07:30" && c.brokerCode === "Y" && c.clientRate === 840,
    );
    if (controlRoomPerShiftCard && controlRoomPerShiftCard.shiftType) {
      const dayWageShiftType = controlRoomPerShiftCard.shiftType;
      const monthlyIcCode = `${dayWageShiftType.code}-IC`;
      const dedupeKey = `控制室|${monthlyIcCode}|${dayWageShiftType.startTime}-${dayWageShiftType.endTime}`;
      if (!shiftTypeCreateKey.has(dedupeKey)) {
        shiftTypeCreateKey.add(dedupeKey);
        plan.shiftTypes.create.push({
          siteCanonicalName: "控制室",
          code: monthlyIcCode,
          startTime: dayWageShiftType.startTime,
          endTime: dayWageShiftType.endTime,
          billingGroup: "monthly_ic",
          note: `WP-MIXED-BILLING（老闆 2026-09-24 方案 (a)）：控制室月薪崗（月費 22,000，包喺 site flat 卡，唔逐更收客）——同日薪崗嘅 per_shift 更種「${dayWageShiftType.code}」分開，避免月薪崗嘅更誤攞 840 逐更 client_rate（見 src/lib/reports/monthly-close.ts revenue 公式）。7 月已有嘅 MR-/PR 更種唔改，呢個係新起嘅 8 月更種。`,
        });
      }
      // 月薪崗更種嘅出街价——pstb F=800 對全部 47 更（月薪崗+日薪崗）都
      // 一致，起一張掛住呢個新更種嘅出街价卡（client_rate 刻意留 null：
      // 呢個更種 billing_group=monthly_ic，resolver 對呢類更種一律唔理
      // client 卡，見 resolve-rate.ts clientEligibleByShiftType）。
      pushCard({
        siteCanonicalName: "控制室",
        shiftType: { code: monthlyIcCode, startTime: dayWageShiftType.startTime, endTime: dayWageShiftType.endTime },
        brokerCode: "Y",
        guardStaffNo: null,
        clientRate: null,
        guardWage: 800,
        brokerFee: 0,
        billingModel: "per_shift",
        effectiveFrom: EFFECTIVE_FROM,
        source: `aug-opening:控制室 WP-MIXED-BILLING 月薪崗出街价（F=800，跟 pstb S031|1930-0730|Y）`,
        note: "月薪崗（billing_group=monthly_ic）出街价卡——F=800 同日薪崗一致，client_rate 刻意留 null（收入已經喺 site flat 卡）。",
        level: "site_shift_broker",
      });
      plan.needsBossReview.push(
        `【控制室－WP-MIXED-BILLING】8 月起咗兩個更種：per_shift「${dayWageShiftType.code}」（日薪崗，逐更收客 840，pstb 22 更）同 monthly_ic「${monthlyIcCode}」（月薪崗，收入包喺 site flat 卡 22,000，pstb 25 更）。但邊個保安員報邊個更種，roster upload 冇欄位可以自動分流（Wilson Control 檔冇逐格 rank/code，同數碼港 CP5 嘅 rank 收窄機制唔同、用唔到，淨係靠「人」先分得到——8 月試算 records.jsonl 顯示 2 個人：25 更 vs 22 更）——要會計/主管喺更表編輯器手動幫控制室嘅每個保安員揀啱更種（或者之後起一個「guard 級預設更種」機制先自動化到）。`,
      );
    } else {
      plan.needsBossReview.push(
        "【控制室－WP-MIXED-BILLING】主 loop 冇起到控制室 1930-0730|Y 嘅 per_shift 逐更卡（840），冇嘢可以複製起月薪崗 monthly_ic 更種——人手覆核（可能係試算 pstb 資料本身變咗）。",
      );
    }
  }

  // -------------------------------------------------------------------
  // 5. Site 級月費 flat 卡：revenue_monthly != 0 嘅 site_id，同現有卡比較。
  // -------------------------------------------------------------------
  for (const r of revenue) {
    const canonicalName = siteNameForCode(r.site_id);
    if (!canonicalName) continue;
    const site = siteByName.get(canonicalName);
    // Opus 5.5 驗收改：月結（src/lib/reports/monthly-close.ts）對有 flat 卡
    // 嘅盤，營業額＝flat 卡金額，**唔再加**逐更 client_rate_snapshot——所以
    // 月費盤嘅 flat 卡要係成個盤嘅月收入，唔可以淨係 revenue_monthly 嗰部
    // 分。盤本身設定（billing_model=monthly_fixed，monthly_fee×monthly_posts）
    // 同試算 revenue_total 一致嘅話，用 revenue_total（例：九龍企業大廈
    // 25,500×2＝51,000；恆星樓 25,000×2＝50,000——兩個盤嘅「逐更」E 都係
    // 月費÷31 倒算值）。
    const siteMonthlyTotal = site && site.billingModel === "monthly_fixed" && site.monthlyFee ? site.monthlyFee * (site.monthlyPosts ?? 1) : null;
    const targetMonthly = siteMonthlyTotal !== null && Math.abs(siteMonthlyTotal - r.revenue_total) < 0.5 ? r.revenue_total : r.revenue_monthly;
    if (!targetMonthly) continue;
    const existingFlat = site
      ? db.shiftTypes.length >= 0 &&
        (await prisma.rateCard.findMany({
          where: { siteId: site.id, voidedAt: null, shiftTypeId: null, brokerId: null, guardId: null, billingModel: { in: ["monthly_fixed", "admin_fee"] } },
        }))
      : [];
    const effective = (existingFlat as { effectiveFrom: Date; effectiveTo: Date | null; clientRate: unknown }[]).filter(
      (c) => c.effectiveFrom <= AS_OF_DATE && (c.effectiveTo === null || c.effectiveTo >= AS_OF_DATE),
    );
    const currentValue = effective.length > 0 ? Number(effective[0].clientRate) : null;
    if (currentValue !== null && Math.abs(currentValue - targetMonthly) < 0.5) continue; // 已經一致，skip
    const billingModel = site?.billingModel === "admin_fee" ? "admin_fee" : "monthly_fixed";
    // WP-MIXED-BILLING（老闆 2026-09-24 答，§15 第 4 項）：數碼港 CP5 IC
    // 8 月 flat 卡（18,580.65）要加 effective_to=2026-08-31——8 月扣假後
    // 金額，9 月起用返「正常月費」（金額未定，呢個 WP 唔建 9 月卡，落
    // needsBossReview 提老闆/會計）。其餘月費盤嘅新卡繼續無限期（同
    // WP-PRICE「rate_cards 伸長做無限期」嘅慣例一致）。
    const effectiveToOverride = canonicalName === "數碼港 CP5 IC" ? "2026-08-31" : null;
    pushCard({
      siteCanonicalName: canonicalName,
      shiftType: null,
      brokerCode: null,
      guardStaffNo: null,
      clientRate: targetMonthly,
      guardWage: null,
      brokerFee: null,
      billingModel,
      effectiveFrom: EFFECTIVE_FROM,
      effectiveTo: effectiveToOverride,
      source: `aug-opening:revenue_site.json["${r.site_id}"].${targetMonthly === r.revenue_monthly ? "revenue_monthly" : "revenue_total"}`,
      note:
        (currentValue === null ? `新增月費 flat 卡（${targetMonthly}）。` : `月費由 ${currentValue}（7 月）變 ${targetMonthly}（8 月），加新卡（唔改/唔 void 7 月嗰張）。`) +
        (effectiveToOverride ? `**加 effective_to=${effectiveToOverride}**（老闆 2026-09-24 答：8 月扣假金額，9 月起用返正常月費，金額未定）。` : ""),
      level: "site_flat",
    });
    if (canonicalName === "數碼港 CP5 IC") {
      plan.needsBossReview.push(
        "【數碼港 CP5 IC——老闆 2026-09-24 已部分答】8 月 flat 卡 18,580.65 已加 effective_to=2026-08-31（老闆：要）。**未定**：9 月起「正常月費」金額係幾多——呢個 WP 冇建 9 月卡，要老闆/會計之後定咗先起 9 月卡（唔起嘅話 9 月呢個盤會冇 flat 卡命中，跌落 pro-rata fallback 或者顯示 0）。",
      );
    }
  }

  // -------------------------------------------------------------------
  // 6. 4 位啟航1331 Event 新散工
  // -------------------------------------------------------------------
  const eventFile = "Roster - 啟航1331 Event - Aug 2026.xlsx";
  const eventGuardsByStaffNo = new Map<string, RosterRecord>();
  for (const r of records) {
    if (r.file === eventFile && r.staff_no) eventGuardsByStaffNo.set(r.staff_no, r);
  }
  for (const [staffNo, r] of eventGuardsByStaffNo) {
    if (db.staffNumbers.has(staffNo)) continue; // 已經存在，skip（冪等）
    if (!r.name) {
      plan.needsBossReview.push(`啟航1331 Event 檔 ${staffNo}：records.jsonl 冇姓名，人手補。`);
      continue;
    }
    plan.guards.create.push({
      staffNo,
      nameZh: r.name,
      tel: r.tel,
      defaultBrokerCode: "K",
      employmentType: "casual",
      note: "啟航1331 Event 檔新散工（8 月起，boss_answers.py 確認：broker K，外判 990/更，上單 1350/更）。",
    });
  }

  // -------------------------------------------------------------------
  // 6b. Opus 5.5 驗收補：dev 實測（上載 36 檔＋逐格 resolver 對 8 月試算
  //     shifts_priced.json）搵到、呢個 WP 唔可以自己決定嘅嘢，寫落
  //     needsBossReview（冇人名／工號）。
  // -------------------------------------------------------------------
  plan.needsBossReview = plan.needsBossReview.map((m) =>
    m.startsWith("「創富廠IC」時段 0700-1900：冇更表檔案資料")
      ? "「創富廠IC」D@07:00-19:00：代號「D」有更表證據——「CTB 6907」檔（siteRaw 寫「城巴車廠」、子盤標記「創富車廠」）22 格全部 D／0700-1900／雞頭 Y／rank 日更IC，同總表 S026|0700-1900|Y n=22 脗合，檔內唯一安員 7 月淨係做過創富廠IC。"
      : m,
  );
  plan.needsBossReview.push(
    "【上載操作】「CTB 6907」更表檔 siteRaw 寫「城巴車廠」但實際係「創富廠IC」——上載時一定要喺上載頁人手揀盤「創富廠IC」。唔揀嘅話會自動配去「城巴車廠」母盤：(1) 同「城巴車廠」主檔同盤同月，後上載嗰個會 supersede 前一個；(2) 22 格會歸去子盤「城巴-創富車廠」用 820/700 計，唔係創富廠IC 嘅 1050/1050。",
    "【數碼港 CP5 日更——已修】WP-AUG-OPENING-2 補丁：`matchShiftType()` 加咗 rank_raw 第三層收窄（match.ts），上載會靠更表 Rank 欄（「早更保安員」vs「早更IC」）自動分流去 `D-2`（per_shift，普通兵）／`D`（monthly_ic，IC 月費崗）；本 script 起价目卡呢層同步用 PSTB_KEY_SHIFT_CODE_OVERRIDE 將 K／B07 呢兩個普通兵雞頭組（930/850，246+23=269 更）強制掛 `D-2`，唔再撞去 monthly_ic。IC 崗收客价照舊由「數碼港 CP5 IC」獨立盤嘅 site 級 flat 卡負責，冇加逐更收客卡。dev 實測：verify-aug.ts --with-uploads 之後 CP5 檔 ambiguous_shift_type=0，269 格「早更保安員」配 D-2、13 格「早更IC」配 monthly_ic D、62 格「夜更保安員」配 N。",
    "【控制室——已修，WP-MIXED-BILLING】老闆 2026-09-24 拍板方案 (a)：8 月兩類人一位月薪崗（收客 22,000 月費，25 更）＋日薪崗（收客 840／更，22 更），試算營業額 40,480。`monthly-close.ts`／`gross-margin.ts` 已經改做「flat 卡 + per_shift 更種逐更卡」合計（只對 2026-08 起生效，7 月唔變）；本 script 而家起多一個 monthly_ic 更種（見上面 4e）分開月薪崗同日薪崗，避免月薪崗嘅更誤攞 840。**未解決**：邊個保安員報邊個更種淨係靠人分得到（見 4e 段），要會計/主管喺更表編輯器手動揀。",
    "【7 月無限期卡滲入 8 月——已部分修，WP-MIXED-BILLING】7 月卡全部 effective_to 留空（WP-PRICE migration 伸長），8 月冇新卡覆蓋嘅就照用。老闆 2026-09-24 批准兩張 7 月特殊卡加 effective_to=2026-07-31（8 月已經有對應卡先套用，見下面 rateCards.closeJuly）：(1) 啟航1331 D@10:00「special」收客卡 11,700（7 月 Event 發票）——8 月由獨立盤「啟航1331 Event」自己嘅 K 1,350 卡頂上；(2) 數碼港 CP5 IC 30,967.74 月費卡——8 月由 18,580.65 flat 卡頂上。**未修**：7 月 guard 級卡（逐人，rank 高過 8 月雞頭卡）8 月照樣贏，例：長工介紹費卡、公司兵長工日均工資卡——呢批冇喺老闆批准嘅兩張之內，鐵則唔准改，維持現狀。",
    "【OT——已修，WP-MIXED-BILLING】老闆 2026-09-24 答：OT 冇統一公式（個個盤個個人都唔同），系統唔准自動套公式計 OT 价。已改：resolve-rate.ts 嘅 OT 記錄而家行同 shift 一樣嘅卡揀邏輯（site/broker/guard 級）；gross-margin.ts「parent 更 snapshot÷hours×ot_hours」公式 fallback 對 2026-08 起嘅月份停用（7 月照舊，gate 用緊）；冇卡冇人手 snapshot 嘅 OT 記錄列做「未定价 OT」（unpriced.ts `ot_unpriced`，報表頂部 `ot_unpriced_count`）。HKU座頭「1Hr OT」（pstb S007|1Hr OT|Y，n=1）試算有价目資料，已起卡（見上面 4c-補2：site+shiftType 級，broker Y，84.85/73）。啟航1331「OT3.5」（2 格）同其餘冇試算价目資料嘅 OT 更種——**未起卡**，要老闆/會計逐盤逐人人手設卡（見 docs/api.md「OT 逐盤逐人人手設卡」段）。",
  );

  // -------------------------------------------------------------------
  // 6c. 老闆 2026-09-24 批准嘅唯一 7 月卡改動——兩張特殊卡加
  //     effective_to=2026-07-31（「8 月無就加」）：啟航1331 D@10:00 Event
  //     發票 special 卡 11,700、數碼港 CP5 IC 30,967.74 月費卡。**淨係
  //     `plan.rateCards.create` 入面已經有對應嘅 8 月替代卡先寫呢個
  //     entry**——apply-aug-plan.ts 會再核實一次先套用（DB 層面 double
  //     check，唔淨係信呢度嘅 in-memory 判斷），搵唔到就 skip＋警告，唔
  //     會幫 7 月卡加期限但冇嘢頂上。effective_to=2026-07-31 唔影響 7 月
  //     任何一日（7 月最後一日都仲喺生效區間內），7 月定价 dump 應該 0
  //     差異——見 verify-aug.ts verifyJulyCardsUnaffected()。
  // -------------------------------------------------------------------
  {
    const near = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 0.01;
    // 冪等：8 月替代卡可能已經喺一次之前嘅 apply 起咗（DB 已經有），今次
    // build 見到金額已經一致就唔會再擺入 `plan.rateCards.create`（見上面
    // 逐個 pushCard 之前嘅「已經一致，skip」判斷）——所以呢度要*同時*查
    // DB（唔淨係睇呢次 build 嘅 in-memory create 清單），先至喺 apply 完
    // 之後再 build 都仲認得返「替代卡其實已經存在」，唔會誤報 skip。
    const timeOnlyLocal = (hhmm: string): Date => {
      const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
      return new Date(Date.UTC(1970, 0, 1, h, m, 0));
    };
    const eventSiteId = siteByName.get(EVENT_SITE)?.id;
    const kBrokerId = (await prisma.broker.findUnique({ where: { code: "K" } }))?.id;
    const eventCardInDb = eventSiteId
      ? await prisma.rateCard.findFirst({
          where: { siteId: eventSiteId, brokerId: kBrokerId, billingModel: "per_shift", voidedAt: null, shiftType: { code: "D", startTime: timeOnlyLocal("10:00") } },
        })
      : null;
    const eventReplacementExists =
      plan.rateCards.create.some((c) => c.siteCanonicalName === EVENT_SITE && c.shiftType?.code === "D" && c.shiftType.startTime === "10:00" && c.brokerCode === "K" && near(c.clientRate, 1350)) ||
      (eventCardInDb !== null && near(eventCardInDb.clientRate !== null ? Number(eventCardInDb.clientRate) : null, 1350));
    const closeJuly: RateCardCloseJulyPlan[] = [
      {
        siteCanonicalName: "啟航1331",
        billingModel: "special",
        shiftTypeCode: "D",
        // 「啟航1331」呢個盤有兩個 code=D 嘅更種（07:30-19:30 同
        // 10:00-19:00）——淨係搵 code 會撞唔知邊個，一定要加時段先精確
        // 搵返嗰張 special 卡掛住嘅 10:00-19:00 呢個。
        shiftTypeStartTime: "10:00",
        clientRate: 11700,
        setEffectiveTo: "2026-07-31",
        requireAugReplacementCard: { siteCanonicalName: EVENT_SITE, billingModel: "per_shift", shiftTypeCode: "D", shiftTypeStartTime: "10:00", clientRate: 1350 },
        reason: "老闆 2026-09-24 批",
        note: "啟航1331 D@10:00「special」收客卡 11,700（7 月 Event 發票，唔按更數拆）——8 月由獨立盤「啟航1331 Event」自己嘅 D@10:00-19:00／K 1,350 卡頂上。",
      },
      {
        siteCanonicalName: "數碼港 CP5 IC",
        billingModel: "monthly_fixed",
        shiftTypeCode: null,
        clientRate: 30967.74,
        setEffectiveTo: "2026-07-31",
        requireAugReplacementCard: { siteCanonicalName: "數碼港 CP5 IC", billingModel: "monthly_fixed", shiftTypeCode: null, clientRate: 18580.65 },
        reason: "老闆 2026-09-24 批",
        note: "數碼港 CP5 IC 月費 flat 卡 30,967.74（7 月）——8 月由 18,580.65 flat 卡頂上（本身已加 effective_to=2026-08-31，見上面 step 5）。",
      },
    ];
    if (!eventReplacementExists) {
      plan.needsBossReview.push(
        "【7 月卡加期限——skip】啟航1331 D@10:00 11,700 special 卡：plan 冇搵到 8 月替代卡（啟航1331 Event D@10:00-19:00 K 1,350），唔套用 effective_to=2026-07-31（skip，維持 7 月卡原封不動）。",
      );
    } else {
      plan.rateCards.closeJuly.push(closeJuly[0]);
    }
    // 數碼港 CP5 IC 嘅 8 月替代卡一定存在（step 5 剛先起咗，見上面
    // effectiveToOverride 段），呢度直接加，唔使額外 exists check——如果
    // step 5 冇起到（例如 targetMonthly 同 7 月一致而 skip 咗），都要
    // 補做 exists check 先套用，做法同上面一致，保守起見都檢查一次。
    const cp5IcSiteId = siteByName.get("數碼港 CP5 IC")?.id;
    const cp5IcCardInDb = cp5IcSiteId
      ? await prisma.rateCard.findFirst({ where: { siteId: cp5IcSiteId, shiftTypeId: null, brokerId: null, guardId: null, billingModel: "monthly_fixed", voidedAt: null, clientRate: { gte: 18580.64, lte: 18580.66 } } })
      : null;
    const cp5IcReplacementExists =
      plan.rateCards.create.some((c) => c.siteCanonicalName === "數碼港 CP5 IC" && c.shiftType === null && c.billingModel === "monthly_fixed" && near(c.clientRate, 18580.65)) || cp5IcCardInDb !== null;
    if (!cp5IcReplacementExists) {
      plan.needsBossReview.push(
        "【7 月卡加期限——skip】數碼港 CP5 IC 30,967.74 月費卡：plan 冇搵到 8 月替代卡（18,580.65 flat 卡），唔套用 effective_to=2026-07-31（skip，維持 7 月卡原封不動）。",
      );
    } else {
      plan.rateCards.closeJuly.push(closeJuly[1]);
    }
  }

  // -------------------------------------------------------------------
  // 6d. WP-MIXED-BILLING（Opus 5.5 驗收）：flat 收入盤唔起「倒算」逐更收客卡。
  //     報表（src/lib/reports/mixed-billing.ts）將 effective_from>=2026-08-01
  //     嘅逐更收客卡當「逐更另收」加落 flat 收入之上——flat 收入盤（盤級
  //     flat 卡覆蓋 8 月，包括 7 月無限期卡；或者 monthly_fixed pro-rata）
  //     上面 E 值其實係「月費÷更數」（IFC／蔚峰園／創富廠IC…），起咗就會雙重
  //     計。除咗 MIXED_BILLING_SITES（老闆拍板，控制室），呢類卡 client_rate
  //     一律清走（出街价照留；兩邊都冇就成張唔起）。
  // -------------------------------------------------------------------
  {
    const planFlatSites = new Set(plan.rateCards.create.filter((c) => c.level === "site_flat").map((c) => c.siteCanonicalName));
    const siteRows = await prisma.site.findMany({ select: { id: true, canonicalName: true, billingModel: true, monthlyFee: true } });
    const flatRows = await prisma.rateCard.findMany({
      where: { voidedAt: null, shiftTypeId: null, brokerId: null, guardId: null, billingModel: { in: ["monthly_fixed", "admin_fee", "special"] } },
      select: { siteId: true, effectiveFrom: true, effectiveTo: true },
    });
    const flatSites = new Set(planFlatSites);
    for (const s of siteRows) {
      if (siteHasFlatRevenue(s, flatRows.filter((c) => c.siteId === s.id), AS_OF_DATE)) flatSites.add(s.canonicalName);
    }
    for (const sp of plan.sites.create) if (sp.billingModel === "monthly_fixed" && sp.monthlyFee) flatSites.add(sp.canonicalName);
    const stripped: string[] = [];
    plan.rateCards.create = plan.rateCards.create.filter((c) => {
      if (c.level === "site_flat" || c.billingModel !== "per_shift" || c.clientRate === null) return true;
      if (!flatSites.has(c.siteCanonicalName) || MIXED_BILLING_SITES.has(c.siteCanonicalName)) return true;
      stripped.push(`${c.siteCanonicalName}|${c.shiftType ? `${c.shiftType.code}@${c.shiftType.startTime}` : "盤級"}|${c.brokerCode ?? "-"}（E=${c.clientRate}）`);
      c.note = `${c.note}【WP-MIXED-BILLING：flat 收入盤，收客 E=${c.clientRate} 係月費倒算值，唔起逐更收客（收入包喺 flat 卡）】`;
      c.clientRate = null;
      return c.guardWage !== null || c.brokerFee !== null;
    });
    if (stripped.length > 0) {
      plan.needsBossReview.push(
        `【WP-MIXED-BILLING——flat 收入盤唔起逐更收客卡】以下 ${stripped.length} 組試算 E 值係「月費÷更數」倒算值，收入由盤級 flat 卡計（包括 7 月無限期 flat 卡），唔起逐更收客（出街价照起）：${stripped.join("；")}。如果其中有盤其實係「月費＋逐更另收」（好似控制室），要老闆拍板加入 scripts/opening/lib/mixed-billing-sites.ts 嘅 MIXED_BILLING_SITES。**注意淺水灣道11號蔚峰園**：8 月試算收入 92,612.90（935.48×99 更，逐更口徑），但 7 月 flat 卡 84,193.55 無限期覆蓋 8 月——月結 8 月會顯示 84,193.55（同 main 一樣，唔係今次引入），要老闆定 8 月係咪要新 flat 卡／改做逐更盤。`,
      );
    }
  }

  // -------------------------------------------------------------------
  // 7. 寫 plan.json + plan-summary.md
  // -------------------------------------------------------------------
  const outDir = path.resolve(process.cwd(), "data/2026-09/aug-opening");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "plan.json"), JSON.stringify(plan, null, 2), "utf8");

  const summary = buildSummary(plan);
  writeFileSync(path.join(outDir, "plan-summary.md"), summary, "utf8");

  console.log(summary);
  console.log(`\n[build-aug-plan] 完成。plan.json / plan-summary.md 已寫入 ${outDir}（gitignored）。`);
}

function buildSummary(p: AugPlan): string {
  const lines: string[] = [];
  lines.push(`# WP-AUG-OPENING plan 摘要（${p.generatedAt}）\n`);
  lines.push(`## 盤`);
  lines.push(`- 新建：${p.sites.create.length} 個 — ${p.sites.create.map((s) => s.canonicalName).join("、")}`);
  lines.push(`- 加 alias：${p.sites.updateAliases.length} 個 — ${p.sites.updateAliases.map((s) => `${s.canonicalName}(+${s.addAliases.join(",")})`).join("、")}`);
  lines.push(`- 改 client_group：${p.sites.updateClientGroup.length} 個 — ${p.sites.updateClientGroup.map((s) => `${s.canonicalName}→${s.clientGroup}`).join("、")}`);
  lines.push(`- 設 parent：${p.sites.setParent.length} 個 — ${p.sites.setParent.map((s) => `${s.canonicalName}→${s.parentCanonicalName}`).join("、")}`);
  lines.push(`\n## 更種`);
  lines.push(`- 新建：${p.shiftTypes.create.length} 個`);
  for (const st of p.shiftTypes.create) lines.push(`  - ${st.siteCanonicalName} ${st.code}@${st.startTime}-${st.endTime}`);
  lines.push(`\n## 價目卡`);
  lines.push(`- 新建：${p.rateCards.create.length} 張`);
  const byLevel = new Map<string, number>();
  for (const c of p.rateCards.create) byLevel.set(c.level, (byLevel.get(c.level) ?? 0) + 1);
  for (const [lvl, n] of byLevel) lines.push(`  - ${lvl}：${n} 張`);
  lines.push(`- 7 月卡加 effective_to（老闆 2026-09-24 批，見 apply 階段 double-check）：${p.rateCards.closeJuly.length} 項 — ${p.rateCards.closeJuly.map((c) => `${c.siteCanonicalName}|${c.shiftTypeCode ?? "flat"}|${c.clientRate}`).join("、")}`);
  lines.push(`\n## 散工`);
  lines.push(`- 新建：${p.guards.create.length} 位（U 號新散工，冇姓名——見 plan.json，gitignored）`);
  lines.push(`\n## 要問老闆 / 人手覆核（${p.needsBossReview.length} 項）`);
  for (const item of p.needsBossReview) lines.push(`- ${item}`);
  return lines.join("\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
