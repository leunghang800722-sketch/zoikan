-- 驗收（Opus 5.5，2026-09-26）：更表「工號衝突」保守預設——見 prisma/schema.prisma
-- GuardMatchOverride 註解。淨係加表，冇資料改動、冇 backfill。

-- CreateTable
CREATE TABLE "guard_match_overrides" (
    "id" TEXT NOT NULL,
    "staff_no" TEXT NOT NULL,
    "name_raw" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "guard_match_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guard_match_overrides_staff_no_name_raw_key" ON "guard_match_overrides"("staff_no", "name_raw");

-- CreateIndex
CREATE INDEX "guard_match_overrides_guard_id_idx" ON "guard_match_overrides"("guard_id");

-- AddForeignKey
ALTER TABLE "guard_match_overrides" ADD CONSTRAINT "guard_match_overrides_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
