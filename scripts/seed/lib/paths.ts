import path from "node:path";

// P0 轉換工具輸出（PDPO：呢啲檔含真名/工號/電話，一律 gitignored，
// 只可以由呢度讀入本機 DB，唔准抄入任何入 git 嘅檔案）
export const IMPORTER_ROOT = path.resolve(process.cwd(), "tools/importer");
export const OUT = (p: string) => path.join(IMPORTER_ROOT, "out", p);
export const MAPPINGS = (p: string) => path.join(IMPORTER_ROOT, "mappings", p);
export const REPO_ROOT = process.cwd();
export const DATA = (p: string) => path.join(REPO_ROOT, "data", p);

export const CSV = {
  brokers: OUT("wp2b/brokers.csv"),
  sites: OUT("wp2b/sites.csv"),
  shiftTypes: OUT("wp2b/shift_types.csv"),
  guards: OUT("wp2b/guards.csv"),
  shiftRecords: OUT("wp2b/shift_records.csv"),
  dailyRequirements: OUT("wp2b/daily_requirements.csv"),
  rateCards: OUT("wp3/rate_cards.csv"),
  shiftRecordsPriced: OUT("wp3/shift_records_priced.csv"),
  billingAdjustments: OUT("wp3/billing_adjustments.csv"),
  referralFeeRates: MAPPINGS("referral_fee_rates.csv"),
  // PDPO：以下兩個喺 data/mappings-private/（gitignored），含真名/工號，
  // 只可以喺 seed runtime 讀入，唔准抄落任何入 git 嘅檔案（規劃 session
  // 第三輪 item 1：employment_type 判定嘅權威來源）
  longtermStaff: DATA("mappings-private/longterm_staff_2026-07.csv"),
  namesEn: DATA("mappings-private/names_en.csv"),
  adjustments: DATA("2026-07/transcribed/adjustments.csv"),
};
