-- CreateTable
CREATE TABLE "roster_reconcile_decisions" (
    "id" TEXT NOT NULL,
    "upload_id" TEXT NOT NULL,
    "reconcile_key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "decided_by" TEXT NOT NULL,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_reconcile_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roster_reconcile_decisions_upload_id_idx" ON "roster_reconcile_decisions"("upload_id");

-- CreateIndex
CREATE UNIQUE INDEX "roster_reconcile_decisions_upload_id_reconcile_key_key" ON "roster_reconcile_decisions"("upload_id", "reconcile_key");

-- CreateIndex
CREATE INDEX "roster_upload_rows_resolved_site_id_idx" ON "roster_upload_rows"("resolved_site_id");

-- AddForeignKey
ALTER TABLE "roster_reconcile_decisions" ADD CONSTRAINT "roster_reconcile_decisions_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "roster_uploads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WP-ROSTER-UPLOAD Phase B-1（同 20260923000000_wp_roster_upload_a 嗰段
-- 一致做法）：新表 `roster_reconcile_decisions.reason` 係會計自由文字
-- 輸入（例：解釋點解「保留系統」），有機會手打埋姓名/電話呢類 PII——同
-- `roster_uploads`／`roster_upload_rows` 一齊排除出 `ai.audit_log`，AI
-- 助手結構上讀唔到呢個 table 嘅 audit 記錄。
CREATE OR REPLACE VIEW ai.audit_log AS
SELECT
  id, actor_user_id, table_name, row_id, action,
  ai.scrub_json(before, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name',
    'blacklist_check_result', 'blacklist_check_date'
  ]) AS before,
  ai.scrub_json(after, ARRAY[
    'password_hash', 'otp_secret', 'tel', 'bank_info',
    'hkid', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_tel', 'sia_permit_no', 'safety_card_no',
    'bank_name', 'bank_account_no', 'bank_payee_name',
    'blacklist_check_result', 'blacklist_check_date'
  ]) AS after,
  ip, created_at
FROM public.audit_log
WHERE table_name NOT IN (
  'guard_phones', 'guard_emergency_contacts', 'guard_addresses',
  'roster_uploads', 'roster_upload_rows', 'roster_reconcile_decisions'
);
