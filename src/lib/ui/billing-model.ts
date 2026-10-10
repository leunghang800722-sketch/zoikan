// A8（Opus 整合驗收）：`BILLING_MODELS` 之前喺 `sites/page.tsx` 同
// `rate-cards/page.tsx` 各自複製一份（一模一樣嘅陣列，容易兩邊飄開），
// 搬嚟呢度做單一 source of truth，兩頁都 import 呢度。
export const BILLING_MODELS = ["per_shift", "monthly_fixed", "admin_fee", "special"] as const;
type BillingModel = (typeof BILLING_MODELS)[number];
