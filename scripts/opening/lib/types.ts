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
  source: string;
  note: string;
  level: RateCardLevel;
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
  };
  guards: {
    create: NewGuardPlan[];
  };
  needsBossReview: string[];
}
