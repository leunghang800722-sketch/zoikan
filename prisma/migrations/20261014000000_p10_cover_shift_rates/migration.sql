-- P10.1：頂位津貼價目表。只新增、冪等。
CREATE TABLE IF NOT EXISTS "cover_shift_rates" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "evidence" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,
    CONSTRAINT "cover_shift_rates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "cover_shift_rates_site_id_grade_effective_from_key" ON "cover_shift_rates"("site_id", "grade", "effective_from");
CREATE INDEX IF NOT EXISTS "cover_shift_rates_site_id_grade_idx" ON "cover_shift_rates"("site_id", "grade");
DO $$ BEGIN
  ALTER TABLE "cover_shift_rates" ADD CONSTRAINT "cover_shift_rates_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
