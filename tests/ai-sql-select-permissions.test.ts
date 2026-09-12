// 規劃裁定（推翻 WP-AI1 執行時嘅第一版判斷）：AI 助手要同畫面權限一致
// ——「你冇權見嘅報表，助手都唔答」。`sql_select` 由 `FROM`/`JOIN` 抽
// 表名，逐張表對應嗰個 module 嘅 view 權（`src/lib/ai/sql-guard.ts`
// 嘅 `TABLE_MODULE_MAP`），抽唔到就拒絕。呢個檔案直接 call `sql_select`
// 工具嘅 `.run()`（用 `buildAiTools()` 起真工具，帶住真 session），
// 逐張表/逐角色斷言（≥8 條，規劃裁定明文要求）。
import { describe, it, expect, beforeAll } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildAiTools } from "@/lib/ai/tools";
import { computeFieldVisibility } from "@/lib/ai/field-scrub";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { RoleName } from "@/lib/rbac/matrix";

async function sessionFor(fx: Wp2Fixture, role: RoleName): Promise<AuthedSession> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds[role] }, include: { role: true } });
  return {
    userId: user.id,
    tel: user.tel,
    name: user.name,
    roleId: user.roleId,
    roleName: user.role.name,
    baseRole: user.role.baseRole as RoleName,
    brokerId: user.brokerId,
    guardId: user.guardId,
    payoutApprovalLimit: user.payoutApprovalLimit ? user.payoutApprovalLimit.toString() : null,
    tokenVersion: user.tokenVersion,
    loggedInAt: new Date().toISOString(),
  };
}

async function sqlSelectRunFor(fx: Wp2Fixture, role: RoleName, query: string): Promise<Record<string, unknown>> {
  const session = await sessionFor(fx, role);
  const fieldVisibility = await computeFieldVisibility(session);
  const tools = buildAiTools({ session, fieldVisibility });
  const tool = tools.find((t) => (t as { name?: string }).name === "sql_select")!;
  const raw = await (tool as { run: (args: unknown) => Promise<string> }).run({ query });
  return JSON.parse(raw);
}

/** 直接改 role_permissions.granted——模擬「老闆喺角色權限畫面開/關咗
 * 某個 module」，測試邊個 table 對邊個 module 嘅對照喺冇天然出廠 off
 * 場景（例如「更表」三個角色出廠都係 grant）嗰陣都測到。 */
async function setGranted(roleName: RoleName, mod: string, granted: boolean): Promise<void> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
  const permission = await prisma.permission.findFirstOrThrow({ where: { module: mod, action: "view" } });
  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    create: { roleId: role.id, permissionId: permission.id, granted, createdBy: "test:ai-sql-select-permissions" },
    update: { granted },
  });
}

describe("規劃裁定：sql_select 逐 table 權限（跟返畫面 module）", () => {
  let fx: Wp2Fixture;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("查一張抽唔到對應 module 嘅表 → 拒絕（unknown_table）", async () => {
    const result = await sqlSelectRunFor(fx, "老闆", "SELECT * FROM ai.this_table_does_not_exist");
    expect(result.error).toBe("unknown_table");
  });

  it("ai.users（用戶管理:view 主管硬性 deny）→ 主管拒絕", async () => {
    const result = await sqlSelectRunFor(fx, "主管", "SELECT id, name FROM ai.users");
    expect(result.error).toBe("permission_denied");
  });

  it("ai.users（用戶管理:view 會計硬性 deny）→ 會計拒絕", async () => {
    const result = await sqlSelectRunFor(fx, "會計", "SELECT id, name FROM ai.users");
    expect(result.error).toBe("permission_denied");
  });

  it("ai.users（老闆有用戶管理:view）→ 老闆放行", async () => {
    const result = await sqlSelectRunFor(fx, "老闆", "SELECT id, name FROM ai.users");
    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it("ai.audit_log（操作紀錄:view 主管出廠 off）→ 主管拒絕", async () => {
    const result = await sqlSelectRunFor(fx, "主管", "SELECT id, action FROM ai.audit_log");
    expect(result.error).toBe("permission_denied");
  });

  it("ai.audit_log（老闆有操作紀錄:view）→ 老闆放行", async () => {
    const result = await sqlSelectRunFor(fx, "老闆", "SELECT id, action FROM ai.audit_log");
    expect(result.error).toBeUndefined();
  });

  it("ai.special_items（月結總表:view 主管出廠 off）→ 主管拒絕", async () => {
    const result = await sqlSelectRunFor(fx, "主管", "SELECT id, kind FROM ai.special_items");
    expect(result.error).toBe("permission_denied");
  });

  it("ai.month_closes（月結總表:view 會計出廠 grant）→ 會計放行", async () => {
    const result = await sqlSelectRunFor(fx, "會計", "SELECT id, month FROM ai.month_closes");
    expect(result.error).toBeUndefined();
  });

  it("ai.shift_records（更表:view 主管出廠 grant）→ 主管放行；手動關咗「更表」之後 → 拒絕", async () => {
    const before = await sqlSelectRunFor(fx, "主管", "SELECT id FROM ai.shift_records");
    expect(before.error).toBeUndefined();

    await setGranted("主管", "更表", false);
    try {
      const after = await sqlSelectRunFor(fx, "主管", "SELECT id FROM ai.shift_records");
      expect(after.error).toBe("permission_denied");
    } finally {
      await setGranted("主管", "更表", true); // 還原，唔污染第啲 test
    }
  });

  it("多表 JOIN（ai.guards + ai.shift_records）：關咗「安員」之後，即使「更表」仲有都要拒絕", async () => {
    await setGranted("主管", "安員", false);
    try {
      const result = await sqlSelectRunFor(
        fx,
        "主管",
        "SELECT g.name_zh, sr.work_date FROM ai.shift_records sr JOIN ai.guards g ON g.id = sr.guard_id",
      );
      expect(result.error).toBe("permission_denied");
    } finally {
      await setGranted("主管", "安員", true);
    }
  });

  it("rate_cards（出街價:view 老闆出廠 grant）→ 老闆放行", async () => {
    const result = await sqlSelectRunFor(fx, "老闆", "SELECT id FROM ai.rate_cards");
    expect(result.error).toBeUndefined();
  });
});
