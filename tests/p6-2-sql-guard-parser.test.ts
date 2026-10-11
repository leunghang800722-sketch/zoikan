// P6.2（H7）：sql-guard 真 parser——繞過嘗試（逗號 join、AS 改名、子查詢、
// CTE、*、UNION、函數包欄、注釋混淆…）按權限正確擋；合法查詢照過。
import { describe, it, expect, beforeAll } from "vitest";
import { validateSqlSelect, deniedMaskedHits, modulesForTables, SQL_MAX_LIMIT, type SqlAnalysis } from "@/lib/ai/sql-guard";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildAiTools } from "@/lib/ai/tools";
import { computeFieldVisibility } from "@/lib/ai/field-scrub";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { RoleName } from "@/lib/rbac/matrix";

const NOTHING = { clientRateVisible: false, settlementVisible: false, guardPiiVisible: false, guardBankVisible: false };
const EVERYTHING = { clientRateVisible: true, settlementVisible: true, guardPiiVisible: true, guardBankVisible: true };

function analysisOf(sql: string): SqlAnalysis {
  const r = validateSqlSelect(sql);
  if (!r.ok) throw new Error(`expected ok but got: ${r.reason}`);
  return r.analysis;
}
function denied(sql: string): string[] {
  return [...new Set(deniedMaskedHits(analysisOf(sql), NOTHING).map((h) => h.what))].sort();
}

describe("P6.2：relation 抽取（全部 relation）", () => {
  it("逗號 join：兩張表都抽到，模組權限各自要", () => {
    const a = analysisOf("SELECT g.name_zh FROM ai.sites s, ai.guards g");
    expect(a.tables.sort()).toEqual(["guards", "sites"]);
    expect(modulesForTables(a.tables).sort()).toEqual(["安員", "盤"].sort());
  });
  it("JOIN … ON、子查詢、CTE、UNION 內嘅表全部抽到", () => {
    expect(analysisOf("SELECT 1 FROM ai.sites s JOIN ai.brokers b ON b.id = s.id").tables.sort()).toEqual(["brokers", "sites"]);
    expect(analysisOf("SELECT x FROM (SELECT id AS x FROM ai.quotas) t").tables).toEqual(["quotas"]);
    expect(analysisOf("WITH c AS (SELECT id FROM ai.users) SELECT id FROM c").tables).toEqual(["users"]);
    expect(analysisOf("SELECT id FROM ai.sites UNION SELECT id FROM ai.guards").tables.sort()).toEqual(["guards", "sites"]);
    expect(analysisOf("SELECT id FROM ai.sites WHERE id IN (SELECT site_id FROM ai.quotas)").tables.sort()).toEqual(["quotas", "sites"]);
  });
  it("未登記嘅 relation 列入 unknown；非 ai schema 一律拒絕；CTE 同 ai 表同名拒絕", () => {
    expect(analysisOf("SELECT * FROM ai.not_a_view").unknown).toEqual(["not_a_view"]);
    expect(validateSqlSelect("SELECT * FROM sites, public.users").ok).toBe(false);
    expect(validateSqlSelect("WITH sites AS (SELECT 1 AS id) SELECT * FROM sites").ok).toBe(false);
  });
});

describe("P6.2：被引用嘅遮罩欄（AS 改名無效）", () => {
  it("AS 改名：SELECT cost AS revenue", () => {
    expect(denied("SELECT cost AS revenue FROM ai.special_items")).toEqual(["special_items.cost"]);
  });
  it("子查詢／CTE 內引用", () => {
    expect(denied("SELECT x FROM (SELECT revenue AS x FROM ai.special_items) t")).toEqual(["special_items.revenue"]);
    expect(denied("WITH c AS (SELECT cost AS a FROM ai.special_items) SELECT a FROM c")).toEqual(["special_items.cost"]);
    expect(denied("WITH c AS (SELECT id FROM ai.special_items) SELECT * FROM c")).toEqual([]);
  });
  it("SELECT * ／ t.* ／整行引用：有遮罩欄嘅表拒絕，冇遮罩欄嘅表放行", () => {
    expect(denied("SELECT * FROM ai.shift_records")).toContain("shift_records.*");
    expect(denied("SELECT s.* FROM ai.shift_records s")).toContain("shift_records.*");
    expect(denied("SELECT to_jsonb(g) FROM ai.guards g")).toContain("guards.*");
    expect(denied("SELECT * FROM ai.shift_types")).toEqual([]);
    expect(denied("SELECT count(*) FROM ai.shift_records")).toEqual([]);
  });
  it("UNION 任何一支引用遮罩欄", () => {
    expect(denied("SELECT id AS v FROM ai.sites UNION ALL SELECT cost AS v FROM ai.special_items")).toEqual(["special_items.cost"]);
  });
  it("函數包欄、WHERE、JOIN ON、ORDER BY、GROUP BY、USING 都算引用", () => {
    expect(denied("SELECT upper(monthly_salary::text) FROM ai.guards")).toEqual(["guards.monthly_salary"]);
    expect(denied("SELECT id FROM ai.special_items WHERE revenue > 0")).toEqual(["special_items.revenue"]);
    expect(denied("SELECT s.id FROM ai.sites s JOIN ai.special_items i ON i.cost > 0")).toEqual(["special_items.cost"]);
    expect(denied("SELECT id FROM ai.special_items ORDER BY cost")).toEqual(["special_items.cost"]);
    expect(denied("SELECT count(*) FROM ai.special_items GROUP BY revenue")).toEqual(["special_items.revenue"]);
    expect(denied("SELECT 1 FROM ai.sites a JOIN ai.rate_cards r USING (client_rate)")).toEqual(["rate_cards.client_rate"]);
  });
  it("相關子查詢（外層表欄位喺內層引用）", () => {
    expect(denied("SELECT (SELECT max(revenue) FROM ai.special_items) FROM ai.sites")).toEqual(["special_items.revenue"]);
    expect(denied("SELECT id FROM ai.sites s WHERE EXISTS (SELECT 1 FROM ai.special_items i WHERE i.site_id = s.id AND i.cost > 1)")).toEqual(["special_items.cost"]);
  });
  it("注釋混淆：注釋內嘅字唔影響；注釋夾住嘅關鍵字照樣睇到", () => {
    expect(denied("SELECT cost /* ai.sites */ AS a FROM ai.special_items -- harmless")).toEqual(["special_items.cost"]);
    expect(denied("SELECT co/**/st FROM ai.special_items").length).toBe(0); // `co st`：語法錯誤或唔同欄，唔會當 cost
    const r = validateSqlSelect("SELECT id FROM ai.sites /* , ai.guards */");
    expect(r.ok && r.analysis.tables).toEqual(["sites"]);
    expect(r.ok && r.sql.includes("/*")).toBe(false); // 執行嘅係剝咗注釋嗰份
  });
  it("audit_log 嘅 before／after JSON：引用或 * 一律當掂到全部四組", () => {
    expect(denied("SELECT after->>'hkid' FROM ai.audit_log")).toEqual(["audit_log.after"]);
    expect(deniedMaskedHits(analysisOf("SELECT * FROM ai.audit_log"), { ...EVERYTHING, guardBankVisible: false }).length).toBeGreaterThan(0);
    expect(denied("SELECT id, action, table_name FROM ai.audit_log")).toEqual([]);
  });
  it("同名欄唔同表唔誤殺：brokers.name／users.name 唔係保安員個人資料", () => {
    expect(denied("SELECT name FROM ai.brokers")).toEqual([]);
    expect(denied("SELECT name, role_name FROM ai.users")).toEqual([]);
  });
  it("有全部權限 → 冇任何 denied", () => {
    expect(deniedMaskedHits(analysisOf("SELECT * FROM ai.shift_records"), EVERYTHING)).toEqual([]);
  });
});

describe("P6.2：危險函數／parse 失敗／LIMIT", () => {
  it("query_to_xml 等執行字串 SQL 嘅函數拒絕", () => {
    expect(validateSqlSelect("SELECT query_to_xml('select * from ai.guards', true, true, '')").ok).toBe(false);
    expect(validateSqlSelect("SELECT set_config('statement_timeout','0',false)").ok).toBe(false);
    expect(validateSqlSelect("SELECT current_setting('x')").ok).toBe(false);
    expect(validateSqlSelect("SELECT public.foo(1)").ok).toBe(false);
  });
  it("parse 失敗一律拒絕（唔退回 regex）", () => {
    expect(validateSqlSelect("SELECT FROM WHERE ((").ok).toBe(false);
    expect(validateSqlSelect("SELECT 1 /* unterminated").ok).toBe(false);
    expect(validateSqlSelect("SELECT 'abc").ok).toBe(false);
  });
  it("LIMIT：冇就加；超過收緊；UNION 包一層", () => {
    const a = validateSqlSelect("SELECT id FROM ai.sites");
    expect(a.ok && a.sql).toBe(`SELECT id FROM ai.sites LIMIT ${SQL_MAX_LIMIT}`);
    const b = validateSqlSelect("SELECT id FROM ai.sites LIMIT 5000 OFFSET 2");
    expect(b.ok && b.sql).toBe(`SELECT id FROM ai.sites LIMIT ${SQL_MAX_LIMIT} OFFSET 2`);
    const c = validateSqlSelect("SELECT id FROM ai.sites UNION SELECT id FROM ai.guards LIMIT 99999");
    expect(c.ok && c.sql.startsWith("SELECT * FROM (")).toBe(true);
    expect(c.ok && c.sql.endsWith(`LIMIT ${SQL_MAX_LIMIT}`)).toBe(true);
    const d = validateSqlSelect("WITH c AS (SELECT id FROM ai.sites LIMIT 999999) SELECT id FROM c");
    expect(d.ok && d.sql.endsWith(`LIMIT ${SQL_MAX_LIMIT}`)).toBe(true);
    expect(d.ok && d.sql.includes("999999")).toBe(true); // CTE 內層 LIMIT 唔係 outer，不動
  });
});

async function sessionFor(fx: Wp2Fixture, role: RoleName): Promise<AuthedSession> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds[role] }, include: { role: true } });
  return {
    userId: user.id, tel: user.tel, name: user.name, roleId: user.roleId, roleName: user.role.name, baseRole: user.role.baseRole as RoleName,
    brokerId: user.brokerId, guardId: user.guardId, payoutApprovalLimit: null, tokenVersion: user.tokenVersion, loggedInAt: new Date().toISOString(),
  };
}

describe("P6.2：sql_select 工具端到端（冇出街價權限嘅角色）", () => {
  let fx: Wp2Fixture;
  async function run(role: RoleName, query: string): Promise<Record<string, unknown>> {
    const session = await sessionFor(fx, role);
    const fieldVisibility = await computeFieldVisibility(session);
    const tool = buildAiTools({ session, fieldVisibility }).find((t) => (t as { name?: string }).name === "sql_select")!;
    return JSON.parse(await (tool as { run: (a: unknown) => Promise<string> }).run({ query }));
  }
  async function setGranted(roleName: RoleName, mod: string, granted: boolean) {
    const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
    const permission = await prisma.permission.findFirstOrThrow({ where: { module: mod, action: "view" } });
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
      create: { roleId: role.id, permissionId: permission.id, granted, createdBy: "test:p6-2" },
      update: { granted },
    });
  }
  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    await setGranted("主管", "月結總表", true);
    await setGranted("主管", "安員", true);
    await setGranted("主管", "出街價", false);
    await setGranted("主管", "收客價", false);
  });

  it("AS 改名嘅出街價欄（cost AS x）→ permission_denied，唔會回 rows", async () => {
    const r = await run("主管", "SELECT cost AS x FROM ai.special_items");
    expect(r.error).toBe("permission_denied");
    expect(r.rows).toBeUndefined();
  });
  it("逗號 join 夾帶引用 guards.monthly_salary → 拒絕", async () => {
    const r = await run("主管", "SELECT s.id, g.monthly_salary AS m FROM ai.sites s, ai.guards g");
    expect(r.error).toBe("permission_denied");
  });
  it("SELECT * 掂到有遮罩欄嘅表 → 拒絕；明確列出無遮罩欄 → 放行", async () => {
    expect((await run("主管", "SELECT * FROM ai.special_items")).error).toBe("permission_denied");
    const ok = await run("主管", "SELECT id, kind FROM ai.special_items");
    expect(ok.error).toBeUndefined();
    expect(Array.isArray(ok.rows)).toBe(true);
  });
  it("老闆（全部權限）同樣查詢放行", async () => {
    const r = await run("老闆", "SELECT cost AS x FROM ai.special_items");
    expect(r.error).toBeUndefined();
  });
});
