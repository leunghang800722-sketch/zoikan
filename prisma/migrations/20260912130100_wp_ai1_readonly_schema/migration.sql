-- WP-AI1：AI 助手唯讀 schema——`ai.*` 只讀 view，DB 級保證助手見到嘅嘢
-- 一定唔包含電話／銀行資料／密碼／OTP（老闆 2026-09-12 批准業務數據送
-- Anthropic，但硬性擋呢四類）。呢個 migration 淨係建 schema/view/scrub
-- function；實際「建立 zoikan_ai_ro 呢個登入角色 + GRANT」由
-- `scripts/db/ensure-ai-role.ts`（`npm run db:ensure-ai-role`）負責，
-- 唔喺 migration 度做（migration 喺冇 AI_DB_PASSWORD 嘅環境都要跑得過）。
--
-- 安全模型：Postgres view 預設用「view owner」（呢度即係跑 migration 嗰個
-- 主連線用戶，通常係 postgres）嘅權限讀底層 public.* 表，唔使 ai_ro 呢個
-- 角色本身有 public.* 嘅 SELECT 權——ai_ro 淨係要 USAGE ON SCHEMA ai +
-- SELECT ON ai.* 呢兩層授權就夠，接觸唔到 public schema 任何一張表/view
-- 以外嘅嘢（ensure-ai-role.ts 唔會再畀任何 public.* 權限）。

CREATE SCHEMA IF NOT EXISTS ai;

-- 預設 REVOKE 晒，避免 PUBLIC 呢個隱含角色都攞到 schema usage（Postgres
-- 對 schema owner 自己一律有權，呢度淨係防第三方角色）。
REVOKE ALL ON SCHEMA ai FROM PUBLIC;

-- 遞歸剝走 jsonb 入面指定嘅 key（唔理巢狀幾深、唔理喺 object 定 array
-- 入面）——ai.audit_log 用嚟剝 before/after 入面可能殘留嘅
-- password_hash／otp_secret／tel／bank_info（正常寫入路徑已經經
-- src/lib/api/audit-dto.ts 嘅白名單 DTO 剝過一次，呢度係 DB 層第二重
-- defense-in-depth，防止未來新 table_name 漏註冊喺嗰個對照表、或者
-- login/logout 呢類 ad-hoc payload 手多多塞咗敏感欄落去）。
CREATE OR REPLACE FUNCTION ai.scrub_json(input jsonb, blocked_keys text[])
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  result jsonb;
  k text;
  v jsonb;
  elem jsonb;
BEGIN
  IF input IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(input) = 'object' THEN
    result := '{}'::jsonb;
    FOR k, v IN SELECT * FROM jsonb_each(input) LOOP
      IF EXISTS (SELECT 1 FROM unnest(blocked_keys) bk WHERE lower(bk) = lower(k)) THEN
        CONTINUE;
      END IF;
      result := result || jsonb_build_object(k, ai.scrub_json(v, blocked_keys));
    END LOOP;
    RETURN result;
  ELSIF jsonb_typeof(input) = 'array' THEN
    result := '[]'::jsonb;
    FOR elem IN SELECT * FROM jsonb_array_elements(input) LOOP
      result := result || jsonb_build_array(ai.scrub_json(elem, blocked_keys));
    END LOOP;
    RETURN result;
  ELSE
    RETURN input;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 主數據／事實表——逐個表列明欄位（唔用 SELECT *），方便一眼睇晒邊啲欄
-- 出咗街；`ai.brokers` 冇 bank_info，`ai.guards` 冇 tel。收客價/出街價
-- 呢類 field-level 敏感度留返 src/lib/ai/tools/*.ts 用現有
-- src/lib/api/field-groups.ts 嘅邏輯逐個工具、跟返問嗰個人嘅權限再剝，
-- 呢層 DB view 本身唔知道邊個問緊（唯讀連線係固定嘅 service role）。
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW ai.sites AS
SELECT
  id, canonical_name, aliases, client_name, client_group, parent_site_id,
  billing_model, monthly_fee, monthly_posts, prorata_basis, in_scope,
  outside_monthly_close, status, roster_layout, created_at, updated_at, created_by
FROM public.sites;

CREATE OR REPLACE VIEW ai.shift_types AS
SELECT
  id, site_id, code, label, start_time, end_time, hours, headcount_required,
  billing_group, created_at, updated_at, created_by, voided_at, voided_by
FROM public.shift_types;

-- 冇 bank_info。
CREATE OR REPLACE VIEW ai.brokers AS
SELECT
  id, code, name, kind, settlement_type, requires_approval, is_internal,
  aliases, status, created_at, updated_at, created_by
FROM public.brokers;

-- 冇 tel（guards 冇銀行類欄）。
CREATE OR REPLACE VIEW ai.guards AS
SELECT
  id, staff_no, staff_no_mw, name_zh, name_en, default_broker_id,
  employment_type, monthly_salary, sia_permit_expiry, polo_size, merged_from,
  status, created_at, updated_at, created_by
FROM public.guards;

CREATE OR REPLACE VIEW ai.shift_records AS
SELECT
  id, work_date, site_id, shift_type_id, guard_id, settlement_broker_id,
  operational_broker_id, referral_fee_snapshot, rescue_rate, record_type,
  leave_code, ot_hours, parent_shift_id, location_tag, is_external, billed,
  paid, settlement_page, client_rate_snapshot, guard_wage_snapshot,
  broker_fee_snapshot, source, provenance, status, created_at, updated_at, created_by
FROM public.shift_records;

CREATE OR REPLACE VIEW ai.daily_requirements AS
SELECT
  id, site_id, shift_type_id, work_date, headcount_required,
  created_at, updated_at, created_by, voided_at, voided_by
FROM public.daily_requirements;

CREATE OR REPLACE VIEW ai.quotas AS
SELECT
  id, month, site_id, shift_type_id, broker_id, target_shifts,
  created_at, updated_at, created_by, voided_at, voided_by
FROM public.quotas;

CREATE OR REPLACE VIEW ai.rate_cards AS
SELECT
  id, site_id, shift_type_id, broker_id, guard_id, client_rate, guard_wage,
  broker_fee, payout_rate, billing_model, effective_from, effective_to,
  source, evidence, confidence, status, note,
  created_at, updated_at, created_by, voided_at, voided_by
FROM public.rate_cards;

CREATE OR REPLACE VIEW ai.referral_fee_rates AS
SELECT
  id, broker_id, site_id, month, fee_per_shift,
  created_at, updated_at, created_by, voided_at, voided_by
FROM public.referral_fee_rates;

CREATE OR REPLACE VIEW ai.special_items AS
SELECT
  id, month, site_id, broker_id, kind, shifts, revenue, cost, description,
  created_at, updated_at, created_by, voided_at, voided_by
FROM public.special_items;

CREATE OR REPLACE VIEW ai.month_closes AS
SELECT
  id, month, locked_at, locked_by, roster_version_note,
  created_at, updated_at, created_by
FROM public.month_closes;

CREATE OR REPLACE VIEW ai.broker_site_assignments AS
SELECT id, broker_id, site_id, month, created_at, created_by
FROM public.broker_site_assignments;

-- before/after 已經係 src/lib/api/audit-dto.ts 白名單 DTO 之後嘅 JSON
-- （正常寫入路徑），呢度用 ai.scrub_json() 再剝一次做 defense-in-depth。
CREATE OR REPLACE VIEW ai.audit_log AS
SELECT
  id, actor_user_id, table_name, row_id, action,
  ai.scrub_json(before, ARRAY['password_hash', 'otp_secret', 'tel', 'bank_info']) AS before,
  ai.scrub_json(after, ARRAY['password_hash', 'otp_secret', 'tel', 'bank_info']) AS after,
  ip, created_at
FROM public.audit_log;

-- 只 id／name／role／status（冇 tel／password_hash／otp_secret）。
CREATE OR REPLACE VIEW ai.users AS
SELECT u.id, u.name, u.role_id, r.name AS role_name, u.status
FROM public.users u
JOIN public.roles r ON r.id = u.role_id;
