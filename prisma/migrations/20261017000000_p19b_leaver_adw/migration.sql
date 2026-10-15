-- P19b：離職者年假補償日薪來源。只新增、冪等、nullable。
ALTER TABLE "longterm_payroll_lines" ADD COLUMN IF NOT EXISTS "al_daily_rate_basis" TEXT;
ALTER TABLE "longterm_payroll_lines" ADD COLUMN IF NOT EXISTS "al_adw_json" JSONB;
