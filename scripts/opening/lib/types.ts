// WP-AUG-OPENING：plan.json 嘅型別定義。呢個檔冇 DB 依賴，純粹型別，
// build-aug-plan.ts／apply-aug-plan.ts 共用，保證兩邊讀寫同一份契約。

export interface NewSitePlan {
  canonicalName: string;
  clientName: string;
  clientGroup: string | null;
  aliases: string[];
  billingModel: "per_shift" | "monthly_fixed" | "admin_fee" | "special";
  monthlyFee: number | null;
  monthlyPosts: number | null;
  parentCanonicalName: string | null; // 要跟住起（好似「城巴-海洋公園車廠」跟「城巴車廠」）
  guardsPaidByClient: boolean;
  note: string; // 嚟源／判斷理由，落 plan-summary 用
}

export interface SiteAliasUpdatePlan {
  canonicalName: string;
  addAliases: string[];
  note: string;
}

export interface SiteClientGroupUpdatePlan {
  canonicalName: string;
  clientGroup: string;
  note: string;
}

export interface SiteParentUpdatePlan {
  canonicalName: string;
  parentCanonicalName: string;
  note: string;
}

export interface NewShiftTypePlan {
  siteCanonicalName: string;
  code: string;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  billingGroup: "per_shift" | "monthly_ic";
  note: string;
}

export type RateCardLevel = "site_flat" | "site_shift_broker" | "site_shift_generic" | "site_shift_guard";

export interface NewRateCardPlan {
  siteCanonicalName: string;
  // shiftType 用 (code,startTime,endTime) 三件辨識（build 階段已經保證存在，
  // apply 階段唔再重新推斷）。null＝site 級 flat 卡（月費／行政費）。
  shiftType: { code: string; startTime: string; endTime: string } | null;
  brokerCode: string | null; // null＝通用（唔限雞頭）
  guardStaffNo: string | null; // 人專屬卡：用 U 號辨識（唔存姓名喺 plan 以外嘅任何地方）
  clientRate: number | null;
  guardWage: number | null;
  brokerFee: number | null;
  billingModel: "per_shift" | "monthly_fixed" | "admin_fee" | "special";
  effectiveFrom: string; // "YYYY-MM-DD"
  // WP-MIXED-BILLING（老闆 2026-09-24 答：數碼港 CP5 IC 8 月月費卡要加
  // effective_to=2026-08-31，9 月起用返正常月費——正常月費金額未定，呢個
  // WP 唔建 9 月卡）。undefined/null＝無限期（同之前 WP-PRICE 「rate_cards
  // 伸長做無限期」嘅預設一致）。
  effectiveTo?: string | null; // "YYYY-MM-DD" | null
  source: string;
  note: string;
  level: RateCardLevel;
}

// WP-MIXED-BILLING（老闆 2026-09-24 答：7 月兩張特殊卡「8 月無就加」到期
// 日）：呢個唔係「起新卡」，係幫一張*現有*（7 月）卡加 effective_to——
// rate_cards 歷史係 append-only 精神（唔改金額，淨係畫上期限），所以獨立
// 一個 plan 分類，唔混入 `rateCards.create`。apply 階段：**淨係喺呢個月
// 已經有 8 月替代卡先准套用**（`requireAugReplacementCard` 描述緊要搵嘅
// 8 月替代卡），搵唔到就 skip＋警告，唔會靜靜哋幫 7 月卡加期限但冇嘢頂上。
export interface RateCardCloseJulyPlan {
  // 用嚟喺 DB 搵返嗰張現有 7 月卡（natural key 唔夠精確——呢批卡冇
  // shift_type/broker/guard 或者掛住 shift_type 但冇 broker，用 site+
  // billingModel+shiftTypeCode(可 null)+clientRate 辨識，同 7 月資料本身
  // 逐張核對過，見 build-aug-plan.ts 註解）。
  siteCanonicalName: string;
  billingModel: "per_shift" | "monthly_fixed" | "admin_fee" | "special";
  shiftTypeCode: string | null; // null = site 級 flat 卡
  // 淨係 code 唔夠精確嗰陣要加（例：啟航1331 同一個 code「D」有兩個唔同
  // 時段嘅 shift_type，07:30-19:30 同 10:00-19:00）——"HH:MM"，唔傳就淨係
  // 用 code 搵（要求成個盤淨係得一個呢個 code 嘅更種）。
  shiftTypeStartTime?: string;
  clientRate: number; // 用嚟核對揾到嗰張卡金額啱（唔改呢個值，淨係加 effective_to）
  setEffectiveTo: string; // "YYYY-MM-DD"（2026-07-31）
  requireAugReplacementCard: {
    siteCanonicalName: string;
    billingModel: "per_shift" | "monthly_fixed" | "admin_fee" | "special";
    shiftTypeCode: string | null;
    shiftTypeStartTime?: string;
    clientRate: number;
  };
  reason: string; // audit 用："老闆 2026-09-24 批"
  note: string;
}

export interface NewGuardPlan {
  staffNo: string; // U 號——natural key
  nameZh: string; // 只存喺 gitignored plan.json，唔入 git、唔印落 summary
  tel: string | null;
  defaultBrokerCode: string; // "K"
  employmentType: "casual";
  note: string;
}

export interface AugPlan {
  generatedAt: string;
  sourceNote: string;
  sites: {
    create: NewSitePlan[];
    updateAliases: SiteAliasUpdatePlan[];
    updateClientGroup: SiteClientGroupUpdatePlan[];
    setParent: SiteParentUpdatePlan[];
  };
  shiftTypes: {
    create: NewShiftTypePlan[];
  };
  rateCards: {
    create: NewRateCardPlan[];
    // WP-MIXED-BILLING：見 `RateCardCloseJulyPlan` 註解——幫現有 7 月卡
    // 加 effective_to（唯一老闆批准嘅 7 月卡改動），唔係新建卡。
    closeJuly: RateCardCloseJulyPlan[];
  };
  guards: {
    create: NewGuardPlan[];
  };
  needsBossReview: string[];
}
