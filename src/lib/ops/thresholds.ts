// WP-AI-OPS §28.2／§28.3：每月修正摘要＋鎖月前體檢嘅門檻常數——集中喺
// 呢一個檔，改門檻唔使撈 lib 邏輯。體檢只係提示，唔擋鎖月。

/** 單月單人出更（shift 記錄）超過呢個數字就提示。 */
export const MAX_SHIFTS_PER_GUARD_MONTH = 26;

/** 逐盤同上月比較：變幅（絕對值）超過呢個百分比先提示。 */
export const SWING_PCT = 30;
/** 逐盤毛利率變幅門檻（百分點，絕對值）。 */
export const MARGIN_SWING_POINTS = 5;
/** 上月基數太細就唔比較（避免 2 更變 4 更都彈出嚟）。 */
export const MIN_BASE_SHIFTS = 20;
export const MIN_BASE_AMOUNT = 10_000;

/** 逐雞頭應付／介紹費總額同上月比較嘅變幅門檻（%）。 */
export const BROKER_PAYABLE_SWING_PCT = 30;
export const REFERRAL_SWING_PCT = 30;

/** 明細最多回幾多行（每個 finding）。 */
export const MAX_DETAIL_ROWS = 50;

/** 修正摘要：top N 盤／雞頭代號。 */
export const DIGEST_TOP_N = 5;

/** 修正摘要：連續出現幾個月先算「重複」。 */
export const DIGEST_REPEAT_MIN_STREAK = 2;
