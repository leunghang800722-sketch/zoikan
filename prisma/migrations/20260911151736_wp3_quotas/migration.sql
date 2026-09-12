-- P1-WP3：quotas 配額（設計文件§3.2、§4.1）——主管派俾雞頭嘅月度軟性配額
-- （盤 × 更別 × 雞頭 × 更數）。軟性限制：超配額唔擋寫入，UI 黃警示；
-- audit_log + 月鎖適用（見 src/lib/month-lock.ts assertMonthNotLocked）。
-- CreateTable
CREATE TABLE "quotas" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "site_id" TEXT NOT NULL,
    "shift_type_id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "target_shifts" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "quotas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "quotas_month_site_id_shift_type_id_broker_id_key" ON "quotas"("month", "site_id", "shift_type_id", "broker_id");

-- AddForeignKey
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_shift_type_id_fkey" FOREIGN KEY ("shift_type_id") REFERENCES "shift_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotas" ADD CONSTRAINT "quotas_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
