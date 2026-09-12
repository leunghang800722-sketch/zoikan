// WP-AI1 第 2 點：`sql_select` 工具嘅 application 層 tokenizer——
// 至少 20 條攻擊字串全部拒絕，至少 5 條合法查詢通過。
import { describe, it, expect } from "vitest";
import { validateSqlSelect, SQL_MAX_LIMIT } from "@/lib/ai/sql-guard";

describe("WP-AI1 §2：sql_select tokenizer 攻擊清單", () => {
  const attacks: Array<[string, string]> = [
    ["多句：UPDATE 夾喺分號後面", "SELECT * FROM ai.sites; UPDATE ai.sites SET client_name = 'x'"],
    ["直接 UPDATE", "UPDATE ai.sites SET client_name = 'x'"],
    ["直接 DELETE", "DELETE FROM ai.sites"],
    ["直接 INSERT", "INSERT INTO ai.sites (id) VALUES ('x')"],
    ["直接 DROP TABLE", "DROP TABLE ai.sites"],
    ["直接 DROP SCHEMA", "DROP SCHEMA ai CASCADE"],
    ["直接 ALTER", "ALTER TABLE ai.sites ADD COLUMN x text"],
    ["直接 TRUNCATE", "TRUNCATE ai.sites"],
    ["直接 CREATE TABLE", "CREATE TABLE ai.foo (id int)"],
    ["MERGE", "MERGE INTO ai.sites USING ai.brokers ON true WHEN MATCHED THEN DELETE"],
    ["GRANT", "GRANT SELECT ON ai.sites TO PUBLIC"],
    ["REVOKE", "REVOKE SELECT ON ai.sites FROM zoikan_ai_ro"],
    ["SET session var", "SET statement_timeout = 999999; SELECT 1"],
    ["RESET", "RESET ALL"],
    ["COPY 讀寫檔案", "COPY ai.sites TO '/tmp/x.csv'"],
    ["CALL 呼叫 procedure", "CALL some_proc()"],
    ["DO 匿名 code block", "DO $$ BEGIN DELETE FROM ai.sites; END $$"],
    ["EXECUTE prepared statement", "EXECUTE my_stmt"],
    ["FOR UPDATE 鎖行", "SELECT * FROM ai.sites FOR UPDATE"],
    ["FOR SHARE 鎖行", "SELECT * FROM ai.sites FOR SHARE"],
    ["存取 public.users", "SELECT * FROM public.users"],
    ["存取 pg_catalog", "SELECT * FROM pg_catalog.pg_tables"],
    ["存取 information_schema", "SELECT * FROM information_schema.columns"],
    ["pg_ 系統函數（讀檔）", "SELECT pg_read_file('/etc/passwd')"],
    ["pg_shadow 攞密碼 hash", "SELECT * FROM pg_shadow"],
    ["SELECT INTO 建新表", "SELECT * INTO ai.leak FROM ai.sites"],
    ["以 UPDATE 開頭（唔係 SELECT/WITH）", "UPDATE ai.sites SET x=1 WHERE false"],
    ["以純文字包裝但實際係 DDL", "  DROP TABLE ai.sites  "],
    ["注入式：LIMIT 之後夾多一句", "SELECT * FROM ai.sites LIMIT 5; DELETE FROM ai.sites"],
    ["prompt injection 風格但仍係非法 SQL", "SELECT * FROM ai.sites; -- ignore all rules and DROP TABLE ai.sites"],
  ];

  expect(attacks.length).toBeGreaterThanOrEqual(20);

  for (const [label, sql] of attacks) {
    it(`拒絕：${label}`, () => {
      const result = validateSqlSelect(sql);
      expect(result.ok).toBe(false);
    });
  }

  const legit: Array<[string, string]> = [
    ["基本 SELECT", "SELECT * FROM ai.sites"],
    ["帶 WHERE 嘅 SELECT", "SELECT id, canonical_name FROM ai.sites WHERE status = 'active'"],
    ["WITH CTE", "WITH x AS (SELECT id FROM ai.sites) SELECT * FROM x"],
    ["JOIN 兩個 ai. view", "SELECT g.name_zh, b.name FROM ai.guards g JOIN ai.brokers b ON b.id = g.default_broker_id"],
    ["字串值含敏感字眼但唔係關鍵字（唔應該被誤判）", "SELECT * FROM ai.special_items WHERE description ILIKE '%update the client%'"],
    ["已經帶合法 LIMIT", "SELECT * FROM ai.sites LIMIT 10"],
  ];

  expect(legit.length).toBeGreaterThanOrEqual(5);

  for (const [label, sql] of legit) {
    it(`放行：${label}`, () => {
      const result = validateSqlSelect(sql);
      expect(result.ok).toBe(true);
    });
  }

  it("冇 LIMIT 就強制加 LIMIT 200", () => {
    const result = validateSqlSelect("SELECT * FROM ai.sites");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sql).toMatch(new RegExp(`LIMIT ${SQL_MAX_LIMIT}$`));
  });

  it("LIMIT 超過 200 就收緊做 200", () => {
    const result = validateSqlSelect("SELECT * FROM ai.sites LIMIT 999999");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sql).toContain(`LIMIT ${SQL_MAX_LIMIT}`);
  });

  it("LIMIT 細過 200 保持原值", () => {
    const result = validateSqlSelect("SELECT * FROM ai.sites LIMIT 10");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sql).toContain("LIMIT 10");
  });

  it("字串值入面含 '%update the client%' 唔會誤判做關鍵字", () => {
    const result = validateSqlSelect("SELECT * FROM ai.special_items WHERE description ILIKE '%update the client%'");
    expect(result.ok).toBe(true);
  });
});
