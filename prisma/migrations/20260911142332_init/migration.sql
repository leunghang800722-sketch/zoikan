-- CreateEnum
CREATE TYPE "BrokerKind" AS ENUM ('broker', 'internal_cash', 'internal_longterm', 'external', 'special');

-- CreateEnum
CREATE TYPE "SettlementType" AS ENUM ('cash', 'autopay', 'salary', 'none');

-- CreateEnum
CREATE TYPE "ActiveStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('active', 'paused', 'ended');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('cash_casual', 'longterm_autopay', 'external', 'casual_event');

-- CreateEnum
CREATE TYPE "BillingModel" AS ENUM ('per_shift', 'monthly_fixed', 'admin_fee', 'special');

-- CreateEnum
CREATE TYPE "ProrataBasis" AS ENUM ('div_31', 'div_month_days');

-- CreateEnum
CREATE TYPE "BillingGroup" AS ENUM ('per_shift', 'monthly_ic');

-- CreateEnum
CREATE TYPE "RecordType" AS ENUM ('shift', 'ot', 'leave');

-- CreateEnum
CREATE TYPE "LeaveCode" AS ENUM ('RD', 'AL', 'SL', 'NL', 'SH');

-- CreateEnum
CREATE TYPE "ShiftRecordStatus" AS ENUM ('draft', 'pending_approval', 'confirmed', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "SpecialItemKind" AS ENUM ('casual_event', 'standalone_broker_fee', 'individual_broker_event', 'shuttle', 'per_hour', 'supplemental', 'cross_month_adjustment', 'other');

-- CreateEnum
CREATE TYPE "PermissionAction" AS ENUM ('view', 'create', 'update', 'void', 'export');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "PayoutBatchStatus" AS ENUM ('draft', 'pending_approval', 'approved', 'paid');

-- CreateTable
CREATE TABLE "brokers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "BrokerKind" NOT NULL,
    "settlement_type" "SettlementType" NOT NULL,
    "bank_info" JSONB,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "is_internal" BOOLEAN NOT NULL DEFAULT false,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ActiveStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "brokers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_site_assignments" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "broker_site_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_fee_rates" (
    "id" TEXT NOT NULL,
    "broker_id" TEXT NOT NULL,
    "site_id" TEXT,
    "month" DATE NOT NULL,
    "fee_per_shift" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "referral_fee_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guards" (
    "id" TEXT NOT NULL,
    "staff_no" TEXT,
    "staff_no_mw" TEXT,
    "name_zh" TEXT NOT NULL,
    "name_en" TEXT,
    "tel" TEXT,
    "default_broker_id" TEXT,
    "employment_type" "EmploymentType" NOT NULL,
    "monthly_salary" DECIMAL(12,2),
    "sia_permit_expiry" DATE,
    "polo_size" TEXT,
    "merged_from" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ActiveStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "guards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "client_name" TEXT NOT NULL,
    "client_group" TEXT,
    "parent_site_id" TEXT,
    "billing_model" "BillingModel" NOT NULL,
    "monthly_fee" DECIMAL(12,2),
    "monthly_posts" INTEGER,
    "prorata_basis" "ProrataBasis",
    "in_scope" BOOLEAN NOT NULL DEFAULT true,
    "status" "SiteStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_types" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "start_time" TIME,
    "end_time" TIME,
    "hours" DECIMAL(5,2),
    "headcount_required" INTEGER,
    "billing_group" "BillingGroup" NOT NULL DEFAULT 'per_shift',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "shift_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "shift_type_id" TEXT,
    "broker_id" TEXT,
    "guard_id" TEXT,
    "client_rate" DECIMAL(12,2),
    "guard_wage" DECIMAL(12,2),
    "broker_fee" DECIMAL(12,2),
    "payout_rate" DECIMAL(12,2),
    "billing_model" "BillingModel",
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "source" TEXT,
    "evidence" TEXT,
    "confidence" TEXT,
    "status" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_records" (
    "id" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "site_id" TEXT NOT NULL,
    "shift_type_id" TEXT NOT NULL,
    "guard_id" TEXT NOT NULL,
    "settlement_broker_id" TEXT,
    "operational_broker_id" TEXT,
    "referral_fee_snapshot" DECIMAL(12,2),
    "rescue_rate" DECIMAL(12,2),
    "record_type" "RecordType" NOT NULL DEFAULT 'shift',
    "leave_code" "LeaveCode",
    "ot_hours" DECIMAL(5,2),
    "parent_shift_id" TEXT,
    "location_tag" TEXT,
    "is_external" BOOLEAN NOT NULL DEFAULT false,
    "billed" BOOLEAN NOT NULL DEFAULT false,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "settlement_page" TEXT,
    "client_rate_snapshot" DECIMAL(12,2),
    "guard_wage_snapshot" DECIMAL(12,2),
    "broker_fee_snapshot" DECIMAL(12,2),
    "source" TEXT,
    "provenance" JSONB,
    "status" "ShiftRecordStatus" NOT NULL DEFAULT 'confirmed',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "shift_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_requirements" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "shift_type_id" TEXT NOT NULL,
    "work_date" DATE NOT NULL,
    "headcount_required" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "daily_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "special_items" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "site_id" TEXT,
    "broker_id" TEXT,
    "kind" "SpecialItemKind" NOT NULL,
    "shifts" INTEGER,
    "revenue" DECIMAL(12,2),
    "cost" DECIMAL(12,2),
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "special_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "month_closes" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "roster_version_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "month_closes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payout_approval_limit" DECIMAL(12,2),
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "base_role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" "PermissionAction" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tel" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "guard_id" TEXT,
    "broker_id" TEXT,
    "payout_approval_limit" DECIMAL(12,2),
    "allowed_ip" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMP(3),
    "last_login_ip" TEXT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "must_change_pwd" BOOLEAN NOT NULL DEFAULT false,
    "token_version" INTEGER NOT NULL DEFAULT 1,
    "otp_enabled" TIMESTAMP(3),
    "otp_secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "table_name" TEXT NOT NULL,
    "row_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_batches" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "broker_id" TEXT,
    "status" "PayoutBatchStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "site_id" TEXT,
    "category" TEXT,
    "amount" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brokers_code_key" ON "brokers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "broker_site_assignments_broker_id_site_id_month_key" ON "broker_site_assignments"("broker_id", "site_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "referral_fee_rates_broker_id_site_id_month_key" ON "referral_fee_rates"("broker_id", "site_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "guards_staff_no_key" ON "guards"("staff_no");

-- CreateIndex
CREATE UNIQUE INDEX "sites_canonical_name_key" ON "sites"("canonical_name");

-- CreateIndex
CREATE UNIQUE INDEX "shift_types_site_id_code_start_time_key" ON "shift_types"("site_id", "code", "start_time");

-- CreateIndex
CREATE INDEX "shift_records_site_id_work_date_idx" ON "shift_records"("site_id", "work_date");

-- CreateIndex
CREATE INDEX "shift_records_work_date_idx" ON "shift_records"("work_date");

-- CreateIndex
CREATE UNIQUE INDEX "shift_records_guard_id_work_date_shift_type_id_key" ON "shift_records"("guard_id", "work_date", "shift_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "daily_requirements_site_id_shift_type_id_work_date_key" ON "daily_requirements"("site_id", "shift_type_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "month_closes_month_key" ON "month_closes"("month");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_module_action_key" ON "permissions"("module", "action");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_id_key" ON "role_permissions"("role_id", "permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tel_key" ON "users"("tel");

-- CreateIndex
CREATE INDEX "audit_log_table_name_row_id_idx" ON "audit_log"("table_name", "row_id");

-- AddForeignKey
ALTER TABLE "broker_site_assignments" ADD CONSTRAINT "broker_site_assignments_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_site_assignments" ADD CONSTRAINT "broker_site_assignments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_fee_rates" ADD CONSTRAINT "referral_fee_rates_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_fee_rates" ADD CONSTRAINT "referral_fee_rates_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guards" ADD CONSTRAINT "guards_default_broker_id_fkey" FOREIGN KEY ("default_broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_parent_site_id_fkey" FOREIGN KEY ("parent_site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_types" ADD CONSTRAINT "shift_types_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_shift_type_id_fkey" FOREIGN KEY ("shift_type_id") REFERENCES "shift_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_records" ADD CONSTRAINT "shift_records_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_records" ADD CONSTRAINT "shift_records_shift_type_id_fkey" FOREIGN KEY ("shift_type_id") REFERENCES "shift_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_records" ADD CONSTRAINT "shift_records_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_records" ADD CONSTRAINT "shift_records_settlement_broker_id_fkey" FOREIGN KEY ("settlement_broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_records" ADD CONSTRAINT "shift_records_operational_broker_id_fkey" FOREIGN KEY ("operational_broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_records" ADD CONSTRAINT "shift_records_parent_shift_id_fkey" FOREIGN KEY ("parent_shift_id") REFERENCES "shift_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_requirements" ADD CONSTRAINT "daily_requirements_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_requirements" ADD CONSTRAINT "daily_requirements_shift_type_id_fkey" FOREIGN KEY ("shift_type_id") REFERENCES "shift_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_items" ADD CONSTRAINT "special_items_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "special_items" ADD CONSTRAINT "special_items_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_guard_id_fkey" FOREIGN KEY ("guard_id") REFERENCES "guards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_broker_id_fkey" FOREIGN KEY ("broker_id") REFERENCES "brokers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 手寫 raw SQL（Prisma schema DSL 表達唔到，squash 成單一 init migration
-- 時要人手保留，唔會由 `prisma migrate dev` 自動生成）：
-- ---------------------------------------------------------------------------

-- referral_fee_rates：標準 UNIQUE(broker_id, site_id, month) 喺 Postgres
-- NULL 唔算相等，唔會擋到同一個雞頭有兩行 site_id=NULL 嘅「預設費率」
-- （月份唔同就照樣得，但同一 broker+month 淨係應該得一行 DEFAULT）。
-- partial unique index 補呢個洞。
CREATE UNIQUE INDEX "referral_fee_rates_broker_month_default_key"
  ON "referral_fee_rates" ("broker_id", "month")
  WHERE "site_id" IS NULL;

-- audit_log 只寫入：DB trigger 拒絕 UPDATE / DELETE（設計文件§3.2、P1計劃硬性規則3）
CREATE OR REPLACE FUNCTION audit_log_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- audit_log 只有 row-level trigger 擋 UPDATE/DELETE 唔夠——TRUNCATE 係
-- statement-level 事件，row-level trigger 擋唔到，要加 statement-level
-- trigger 先真係做到「append-only」。
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
