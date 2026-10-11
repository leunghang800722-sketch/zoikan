// WP-PII（Opus 驗收必修 1c）：AI 助手經 `recent_audit`／`sql_select ai.
// audit_log` 讀 guards 嘅 update audit row——老闆／主管兩個角色（都有
// 「操作紀錄:view」，老闆出廠有、主管呢度手動開返嚟模擬老闆已經開咗）
// 讀出嚟嘅 before/after 一律零 hkid／bank 值（連 key 都冇）。呢個唔係
// permission-based scrub（field-scrub.ts 嘅 guardPiiVisible/
// guardBankVisible 淨係管其他 recent_audit/sql_select 讀到嘅「泛用形狀」
// 資料）——hkid/bank_account_no 呢類，一路都係 DB 層 `ai.audit_log` view
// 嘅 `ai.scrub_json()` 無條件剝（唔理問嗰個人有幾大權限，AI 呢條管道
// 一律唔准見），所以老闆同主管兩個都應該零命中，唔係得主管先擋到。
import { describe, it, expect, beforeAll } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { findKeysDeep } from "@/lib/api/serialize";
import { buildAiTools } from "@/lib/ai/tools";
import { computeFieldVisibility } from "@/lib/ai/field-scrub";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { RoleName } from "@/lib/rbac/matrix";

import { PATCH as guardUpdate } from "@/app/api/guards/[id]/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

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

async function toolRun(fx: Wp2Fixture, role: RoleName, toolName: string, args: unknown): Promise<Record<string, unknown>> {
  const session = await sessionFor(fx, role);
  const fieldVisibility = await computeFieldVisibility(session);
  const tools = buildAiTools({ session, fieldVisibility });
  const tool = tools.find((t) => (t as { name?: string }).name === toolName)!;
  const raw = await (tool as { run: (a: unknown) => Promise<string> }).run(args);
  return JSON.parse(raw);
}

async function grantAuditLogView(roleName: RoleName): Promise<void> {
  const role = await prisma.role.findFirstOrThrow({ where: { name: roleName } });
  const permission = await prisma.permission.findFirstOrThrow({ where: { module: "操作紀錄", action: "view" } });
  await prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    create: { roleId: role.id, permissionId: permission.id, granted: true, createdBy: "test:wp-pii-ai-audit-log-scrub" },
    update: { granted: true },
  });
}

const PII_BANK_KEYS = [
  "hkid",
  "date_of_birth",
  "address",
  "emergency_contact_name",
  "emergency_contact_tel",
  "bank_name",
  "bank_account_no",
  "bank_payee_name",
  "blacklist_check_result",
  "blacklist_check_date",
];

describe("WP-PII：AI 助手 recent_audit／sql_select 讀 guards audit row——零 hkid/bank", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await grantAuditLogView("主管"); // 主管出廠冇「操作紀錄:view」，模擬老闆已經開咗

    // 老闆經真正 PATCH route 寫一條帶齊 hkid/銀行/PII 嘅 guards update
    // audit row（同 wp-pii-field-groups.test.ts 一致做法——行真實寫入
    // 路徑，audit_log.before/after 先會係 writeAudit() 實際會產生嘅
    // DTO 形狀）。
    const patchRes = await guardUpdate(
      req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", {
        hkid: "A123456(3)",
        date_of_birth: "1990-01-01",
        address: "測試地址（AI audit scrub test）",
        emergency_contact_name: "測試聯絡人",
        emergency_contact_tel: "61000099",
        blacklist_check_result: "clear",
        blacklist_check_date: "2026-01-01",
        bank_name: "測試銀行",
        bank_account_no: "999-888777-001",
        bank_payee_name: "測試保安員甲",
      }),
      { params: Promise.resolve({ id: fx.guardA.id }) },
    );
    expect(patchRes.status).toBe(200);
  });

  it("老闆：recent_audit（table=guards）零命中 hkid/bank key", async () => {
    const result = await toolRun(fx, "老闆", "recent_audit", { table: "guards", limit: 10 });
    expect(findKeysDeep(result, PII_BANK_KEYS)).toEqual([]);
  });

  it("主管：recent_audit（table=guards）零命中 hkid/bank key", async () => {
    const result = await toolRun(fx, "主管", "recent_audit", { table: "guards", limit: 10 });
    expect(findKeysDeep(result, PII_BANK_KEYS)).toEqual([]);
  });

  it("老闆：sql_select ai.audit_log（table_name='guards'）零命中 hkid/bank key", async () => {
    const result = await toolRun(fx, "老闆", "sql_select", {
      query: "SELECT id, table_name, action, before, after FROM ai.audit_log WHERE table_name = 'guards' ORDER BY created_at DESC",
    });
    expect(result.error).toBeUndefined();
    expect((result.rows as unknown[]).length).toBeGreaterThan(0);
    expect(findKeysDeep(result, PII_BANK_KEYS)).toEqual([]);
  });

  it("主管：sql_select 引用 ai.audit_log.before／after（任意 resource 嘅 DTO JSON，可含收客價／出街價）→ P6.2 起整條拒絕", async () => {
    const result = await toolRun(fx, "主管", "sql_select", {
      query: "SELECT id, table_name, action, before, after FROM ai.audit_log WHERE table_name = 'guards' ORDER BY created_at DESC",
    });
    expect(result.error).toBe("permission_denied");
    expect(result.rows).toBeUndefined();
    expect(findKeysDeep(result, PII_BANK_KEYS)).toEqual([]);
  });

  it("主管：sql_select ai.audit_log 唔引用 before／after 嘅欄位照常放行，零命中 hkid/bank key", async () => {
    const result = await toolRun(fx, "主管", "sql_select", {
      query: "SELECT id, table_name, action FROM ai.audit_log WHERE table_name = 'guards' ORDER BY created_at DESC",
    });
    expect(result.error).toBeUndefined();
    expect((result.rows as unknown[]).length).toBeGreaterThan(0);
    expect(findKeysDeep(result, PII_BANK_KEYS)).toEqual([]);
  });

  it("反過嚟核實呢條 audit row 真係有帶 hkid/bank（唔係啱啱好行路寫失敗，令上面斷言形同虛設）——直接查 public.audit_log", async () => {
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { tableName: "guards", action: "update" },
      orderBy: { createdAt: "desc" },
    });
    const after = row.after as Record<string, unknown>;
    expect(after.hkid).toBe("A1234563");
    expect(after.bank_account_no).toBe("999-888777-001");
  });
});
