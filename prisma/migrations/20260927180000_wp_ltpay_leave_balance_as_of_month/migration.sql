-- WP-LTPAY §21 任務 4b(f)：`guard_leave_balances` 寫回邏輯要分清「呢個
-- 月自己」同「之前月結轉」，先可以做到「同一個月重算兩次唔會愈計愈多」
-- （run 冪等，void 舊建新）。`as_of_month`＝最近一次寫入嘅結算月份；
-- `*_opening`＝截至嗰個月**前一個月**月尾嘅累積（唔含 as_of_month 自己）。
-- 純 additive，冇 data backfill。

-- AlterTable
ALTER TABLE "guard_leave_balances" ADD COLUMN     "al_taken_opening" DECIMAL(6,2) NOT NULL DEFAULT 0,
ADD COLUMN     "as_of_month" DATE,
ADD COLUMN     "sl_taken_opening" DECIMAL(6,2) NOT NULL DEFAULT 0;
