// WP-PII（Opus 驗收必修 1c）：`ai.audit_log` view 結構性測試——直接查
// `pg_get_viewdef('ai.audit_log')`（Postgres 實際嘅 view 定義文字，唔係
// 「跑一條查詢睇個 row 冇嗰粒 key」呢類間接斷言），確保 WP-PII 12 個新
// blocked key 全部真係喺 `ai.scrub_json()` 嘅 blocked_keys 陣列入面
// （見 prisma/migrations/20260917010000_wp_pii_ai_audit_log_scrub）。
//
// 「牌照類別／到期、平安卡到期、入離職日期可以留」——`sia_permit_type`／
// `safety_card_expiry`／`hire_date`／`leave_date` 刻意唔擋，呢個 test
// 都反過來斷言呢 4 個**冇**喺 blocked_keys（防止有人手多多連呢啲都擋咗，
// 令 audit_log 追溯能力無端端收窄）。
import { describe, it, expect } from "vitest";
import { prisma } from "./lib/db";

const WP_PII_AUDIT_LOG_BLOCKED_NEW_FIELDS = [
  "hkid",
  "date_of_birth",
  "address",
  "emergency_contact_name",
  "emergency_contact_tel",
  "sia_permit_no",
  "safety_card_no",
  "bank_name",
  "bank_account_no",
  "bank_payee_name",
  "blacklist_check_result",
  "blacklist_check_date",
];

const PRE_EXISTING_BLOCKED_FIELDS = ["password_hash", "otp_secret", "tel", "bank_info"];

const WP_PII_AUDIT_LOG_ALLOWED_NEW_FIELDS = ["sia_permit_type", "safety_card_expiry", "hire_date", "leave_date"];

// WP-BOSS5 §25.4（老闆 2026-09-28 決定 6）：guards.bank_code（HKICL 銀行
// 編號）同上面 bank_name/bank_account_no/bank_payee_name 一組「保安員銀行
// 資料」PII，一樣要喺 scrub_json blocked_keys（見
// prisma/migrations/20260929010000_wp_boss5_bank_code）。

async function auditLogViewDef(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ viewdef: string }>>(
    `SELECT pg_get_viewdef('ai.audit_log'::regclass, true) AS viewdef`,
  );
  return rows[0]?.viewdef ?? "";
}

describe("WP-PII：ai.audit_log view 結構性測試——scrub_json blocked_keys 齊 16 個", () => {
  it("view 定義文字含全部 12 個 WP-PII 新 blocked 名 + 4 個原有嘅", async () => {
    const viewdef = await auditLogViewDef();
    expect(viewdef.length).toBeGreaterThan(0);
    for (const field of [...WP_PII_AUDIT_LOG_BLOCKED_NEW_FIELDS, ...PRE_EXISTING_BLOCKED_FIELDS]) {
      expect(viewdef).toContain(field);
    }
  });

  it("刻意唔擋嘅 4 個（牌照類別/到期、平安卡到期、入離職日期）唔喺 blocked_keys 陣列——齊全但唔過度擋", async () => {
    const viewdef = await auditLogViewDef();
    // scrub_json(...) 嘅 ARRAY[...] 參數係一段連續文字，抽出嚟核對，
    // 避免同 SELECT list 其他地方（例如 column alias）撞名產生假陽性。
    const arrayMatch = viewdef.match(/scrub_json\(before,\s*ARRAY\[([^\]]*)\]/i);
    expect(arrayMatch).not.toBeNull();
    const blockedArrayText = arrayMatch![1];
    for (const field of WP_PII_AUDIT_LOG_ALLOWED_NEW_FIELDS) {
      expect(blockedArrayText).not.toContain(`'${field}'`);
    }
  });

  it("WP-BOSS5 §25.4：view 定義文字含 bank_code", async () => {
    const viewdef = await auditLogViewDef();
    expect(viewdef).toContain("bank_code");
  });

  it("before／after 兩邊嘅 scrub_json 用返同一份 blocked_keys（唔係得 before 加齊、after 漏咗）", async () => {
    const viewdef = await auditLogViewDef();
    const beforeMatch = viewdef.match(/scrub_json\(before,\s*ARRAY\[([^\]]*)\]/i);
    const afterMatch = viewdef.match(/scrub_json\(after,\s*ARRAY\[([^\]]*)\]/i);
    expect(beforeMatch).not.toBeNull();
    expect(afterMatch).not.toBeNull();
    const normalize = (s: string) => s.split(",").map((x) => x.trim()).sort().join(",");
    expect(normalize(afterMatch![1])).toBe(normalize(beforeMatch![1]));
  });
});
