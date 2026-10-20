// WP-PII（老闆 2026-09-17 拍板）：老闆決定「AI 助手明確排除呢批新欄位，
// 唔准讀到」——`ai.guards` view（prisma/migrations/
// 20260912130100_wp_ai1_readonly_schema）明列欄位（唔用 SELECT *），加落
// `public.guards` 嘅新欄除非有人手動改埋 view 定義先會出現。呢個
// 結構性測試直接查 `information_schema.columns`（唔係讀 view 嘅 SQL
// 文字，係讀 Postgres 實際嘅 view 定義），斷言呢 16 個新欄全部唔存在於
// `ai.guards`。
import { describe, it, expect } from "vitest";
import { prisma } from "./lib/db";

const WP_PII_NEW_GUARD_COLUMNS = [
  "hkid",
  "date_of_birth",
  "address",
  "emergency_contact_name",
  "emergency_contact_tel",
  "sia_permit_no",
  "sia_permit_type",
  "safety_card_no",
  "safety_card_expiry",
  "hire_date",
  "leave_date",
  "bank_name",
  "bank_account_no",
  "bank_payee_name",
  "blacklist_check_result",
  "blacklist_check_date",
];
// AI-PII-2（老闆 2026-10-20 定版）：以下 16 欄之中，呢批 AI 可講，ai.guards 而家有（migration 20261030000000_ai_pii2_views）；
// 其餘（身份證／出生日期／住址／電話／緊急聯絡人電話／銀行／黑名單查核結果）永遠唔准出現喺任何 ai.* view。
const AI_PII2_ALLOWED_GUARD_COLUMNS = ["emergency_contact_name", "sia_permit_no", "sia_permit_type", "safety_card_no", "safety_card_expiry", "hire_date", "leave_date", "blacklist_check_date"];
const AI_BLOCKED_COLUMNS = ["hkid", "date_of_birth", "address", "tel", "emergency_contact_tel", "bank_name", "bank_account_no", "bank_payee_name", "bank_code", "blacklist_check_result"];
// WP-BOSS5 §25.4：新增嘅 bank_code（HKICL 銀行編號）同上面呢批一樣屬於
// 「保安員銀行資料」PII，一樣要驗證 ai.guards 睇唔到——獨立一個 array（唔
// 塞入上面果個「16 個新欄」常數，避免改埋成班歷史測試名/註解嘅 magic
// number），下面兩條 it() 各自加一段。
const WP_BOSS5_BANK_CODE_COLUMN = "bank_code";

describe("WP-PII：ai.guards view 結構性測試——16 個新欄全部唔存在", () => {
  it("information_schema.columns：ai.guards 唔包含任何一個新 PII/牌照/銀行欄", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'guards'`,
    );
    const columns = new Set(rows.map((r) => r.column_name));
    const leaked = WP_PII_NEW_GUARD_COLUMNS.filter((c) => columns.has(c) && !AI_PII2_ALLOWED_GUARD_COLUMNS.includes(c));
    expect(leaked).toEqual([]);
    // AI-PII-2：老闆規則允許嘅欄 ai.guards 要有
    expect(AI_PII2_ALLOWED_GUARD_COLUMNS.filter((c) => !columns.has(c))).toEqual([]);
  });

  it("AI-PII-2：任何 ai.* view 都冇身份證／出生日期／住址／電話／緊急聯絡人電話／銀行（bank_*）／黑名單查核結果欄", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'ai'`,
    );
    const bad = rows.filter((r) => AI_BLOCKED_COLUMNS.includes(r.column_name) || /^bank_/.test(r.column_name) || /(^|_)tel$/.test(r.column_name));
    expect(bad).toEqual([]);
    const tables = new Set(rows.map((r) => r.table_name));
    for (const v of ["guards", "guard_staff_numbers", "guard_longterm_contracts", "longterm_payroll_lines", "longterm_payroll_runs"]) expect(tables.has(v), v).toBe(true);
  });

  it("WP-BOSS5 §25.4：ai.guards 唔包含 bank_code", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'guards'`,
    );
    const columns = new Set(rows.map((r) => r.column_name));
    expect(columns.has(WP_BOSS5_BANK_CODE_COLUMN)).toBe(false);
  });

  it("防止 view 打空令上面斷言形同虛設——ai.guards 仲有返舊嗰 10 個欄", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'guards'`,
    );
    const columns = new Set(rows.map((r) => r.column_name));
    expect(columns.has("id")).toBe(true);
    expect(columns.has("name_zh")).toBe(true);
    expect(columns.has("monthly_salary")).toBe(true);
    expect(columns.has("sia_permit_expiry")).toBe(true); // 已有欄，唔係 WP-PII 新加，理應留低
    expect(columns.has("tel")).toBe(false); // 舊有規則：guards 冇 tel
  });

  it("public.guards 本身真係有呢 16 個新欄（confirm migration 生效，唔係測試斷言錯咗方向）", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'guards'`,
    );
    const columns = new Set(rows.map((r) => r.column_name));
    const missing = WP_PII_NEW_GUARD_COLUMNS.filter((c) => !columns.has(c));
    expect(missing).toEqual([]);
  });

  it("WP-BOSS5 §25.4：public.guards 本身真係有 bank_code（confirm migration 生效）", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'guards'`,
    );
    const columns = new Set(rows.map((r) => r.column_name));
    expect(columns.has(WP_BOSS5_BANK_CODE_COLUMN)).toBe(true);
  });
});
