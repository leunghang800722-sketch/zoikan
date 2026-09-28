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
// WP-BOSS5 §25.4：新增嘅 bank_code（HKICL 銀行編號）同上面呢批一樣屬於
// 「安員銀行資料」PII，一樣要驗證 ai.guards 睇唔到——獨立一個 array（唔
// 塞入上面果個「16 個新欄」常數，避免改埋成班歷史測試名/註解嘅 magic
// number），下面兩條 it() 各自加一段。
const WP_BOSS5_BANK_CODE_COLUMN = "bank_code";

describe("WP-PII：ai.guards view 結構性測試——16 個新欄全部唔存在", () => {
  it("information_schema.columns：ai.guards 唔包含任何一個新 PII/牌照/銀行欄", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'ai' AND table_name = 'guards'`,
    );
    const columns = new Set(rows.map((r) => r.column_name));
    const leaked = WP_PII_NEW_GUARD_COLUMNS.filter((c) => columns.has(c));
    expect(leaked).toEqual([]);
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
