-- AI-PII-2（老闆 2026-10-20 定版 PII 規則）：AI 可講 姓名／工號／人卡 id／月薪／入職離職日／僱傭類型／牌照到期／
-- 緊急聯絡人姓名／別名／黑名單查核日期；唔可講 身份證／出生日期／住址／銀行任何欄／所有電話（含緊急聯絡人電話）。
-- 純 CREATE OR REPLACE VIEW（ai schema），冇改任何資料／表。ai.guards 沿用 20260912130100 定義逐字，只加欄；
-- 新 view：guard_staff_numbers／guard_longterm_contracts／longterm_payroll_runs／longterm_payroll_lines。
-- 絕對唔加：hkid／date_of_birth／address／tel／emergency_contact_tel／bank_*／blacklist_check_result。
-- ai.audit_log 嘅 scrub 清單（20261027000000）已經包含 emergency_contact_tel 等，今次不變。

CREATE OR REPLACE VIEW ai.guards AS
SELECT
  id, staff_no, staff_no_mw, name_zh, name_en, default_broker_id,
  employment_type, monthly_salary, sia_permit_expiry, polo_size, merged_from,
  status, created_at, updated_at, created_by,
  hire_date, leave_date, probation_months, emergency_contact_name, name_aliases,
  blacklist_check_date, sia_permit_no, sia_permit_type, sia_permit_a_expiry, sia_permit_b_expiry,
  safety_card_no, safety_card_expiry, qas_issue_date, qas_expiry_date
FROM public.guards;

-- 工號卡（人卡 id＝guard_id；號碼、體系、有效期、結束原因、換號鏈）。唔含 note／created_by。
CREATE OR REPLACE VIEW ai.guard_staff_numbers AS
SELECT id, guard_id, scheme, number, status, valid_from, valid_to, end_reason, predecessor_id, source
FROM public.guard_staff_numbers;

-- 長工合約段（月薪／日薪／試用期／年假日數；唔含 note／created_by）。
CREATE OR REPLACE VIEW ai.guard_longterm_contracts AS
SELECT id, guard_id, effective_from, effective_to, monthly_salary, pay_basis, daily_rate,
       probation_months, annual_leave_days, voided_at
FROM public.guard_longterm_contracts;

CREATE OR REPLACE VIEW ai.longterm_payroll_runs AS
SELECT id, month, status, voided_at, confirmed_at
FROM public.longterm_payroll_runs;

-- 長工糧逐人行（只列未作廢 run 嘅行；month 由 run join）。is_leaver 由 al_daily_rate_basis 不為 null 推
-- （離職結算先有年假日薪口徑）。唔含 notes_json／contract_snapshot／al_adw_json。
CREATE OR REPLACE VIEW ai.longterm_payroll_lines AS
SELECT l.id, l.run_id, l.guard_id, r.month AS month, l.work_days, l.days_in_month, l.net_basic,
       l.ot_hours, l.ot_amount, l.al_payment, l.gross, l.mpf_ee, l.mpf_er, l.autopay,
       (l.al_daily_rate_basis IS NOT NULL) AS is_leaver, l.al_daily_rate_basis
FROM public.longterm_payroll_lines l
JOIN public.longterm_payroll_runs r ON r.id = l.run_id
WHERE r.voided_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zoikan_ai_ro') THEN
    GRANT SELECT ON ai.guard_staff_numbers, ai.guard_longterm_contracts, ai.longterm_payroll_runs, ai.longterm_payroll_lines TO zoikan_ai_ro;
  END IF;
END
$$;
