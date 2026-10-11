// P9.2 三個細補：AI 每日額度原子（並發不超限）、POST /api/users 擋系統帳號電話、Maxwell 導入遇鎖月逐行跳過。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { assertUnderDailyLimit, releaseDailySlot, countTodayAiChats } from "@/lib/ai-rate-limit";
import { POST as createUser } from "@/app/api/users/route";
import { SYSTEM_USER_TEL, ensureSystemUser } from "@/lib/system-user";
import { importMaxwellContracts } from "@/lib/longterm-payroll/import-service";

describe("P9.2 AI 每日額度原子", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });
  afterEach(() => {
    delete process.env.AI_DAILY_LIMIT;
  });

  it("並發 20 個請求，已用 90、上限 100 → 只放行 10 個（used<limit）", async () => {
    const userId = fx.userIds["安員"];
    const limit = (await countTodayAiChats(userId)) + 100; // 用現有 audit 起點，令「已用」可控
    process.env.AI_DAILY_LIMIT = String(limit);
    // 先用 90 次
    for (let i = 0; i < 90; i++) await assertUnderDailyLimit(userId);
    const results = await Promise.all(Array.from({ length: 20 }, () => assertUnderDailyLimit(userId)));
    expect(results.filter((r) => r.used < r.limit)).toHaveLength(10);
    expect(results.every((r) => r.limit === limit)).toBe(true);
    const row = await prisma.aiDailyUsage.findFirstOrThrow({ where: { userId } });
    expect(row.used).toBe(limit); // 計數封頂喺上限，唔會超
  });

  it("audit_log 今日次數較高時以 audit 為準；releaseDailySlot 退還一次", async () => {
    const userId = fx.userIds["會計"];
    process.env.AI_DAILY_LIMIT = String((await countTodayAiChats(userId)) + 3);
    const r1 = await assertUnderDailyLimit(userId);
    expect(r1.used).toBeLessThan(r1.limit);
    await assertUnderDailyLimit(userId);
    await assertUnderDailyLimit(userId);
    const full = await assertUnderDailyLimit(userId);
    expect(full.used).toBeGreaterThanOrEqual(full.limit);
    await releaseDailySlot(userId);
    const again = await assertUnderDailyLimit(userId);
    expect(again.used).toBeLessThan(again.limit);
    // 之後 audit 補寫（模擬真實 call 完成）→ 以較大者為準，唔會雙重計
    await prisma.auditLog.create({ data: { actorUserId: userId, tableName: "ai_chat", rowId: userId, action: "ai_chat", after: {} } });
    const after = await assertUnderDailyLimit(userId);
    expect(after.used).toBeGreaterThanOrEqual(after.limit);
  });
});

describe("P9.2 POST /api/users 擋系統帳號電話", () => {
  it("tel = 系統帳號電話 → 403 system_account（系統帳號未建或已建都一樣）", async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const role = await prisma.role.findFirstOrThrow({ where: { name: "會計" } });
    const body = { name: "測試用戶", tel: SYSTEM_USER_TEL, password: "Abcd1234x", role_id: role.id };
    const mk = () => createUser(new Request("http://t/api/users", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    let res = await mk();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("system_account");
    await ensureSystemUser();
    res = await mk();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("system_account");
  });
});

describe("P9.2 Maxwell 導入遇鎖月逐行跳過", () => {
  async function wb(rows: Array<{ staffNo: string; name: string; basic: number; commencement: string }>) {
    const w = new ExcelJS.Workbook();
    const ws = w.addWorksheet("在職名單");
    ws.getCell(2, 3).value = "Staff No.";
    ws.getCell(2, 5).value = "Name";
    rows.forEach((r, i) => {
      const row = 3 + i;
      ws.getCell(row, 3).value = r.staffNo;
      ws.getCell(row, 5).value = r.name;
      ws.getCell(row, 18).value = new Date(r.commencement);
      ws.getCell(row, 20).value = "1";
      ws.getCell(row, 23).value = r.basic;
    });
    w.addWorksheet("離職名單");
    return Buffer.from(await w.xlsx.writeBuffer());
  }
  it("鎖月嗰行跳過（summary 列 N 行），其餘照導入", async () => {
    await clearAll();
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
    await prisma.monthClose.create({ data: { month: new Date(Date.UTC(2026, 5, 1)), lockedAt: new Date(), lockedBy: user.id, createdBy: "test" } });
    const mk = async (no: string, name: string, from: string) => {
      const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", staffNoMw: no, createdBy: "test" } });
      await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15000, effectiveFrom: new Date(from), effectiveTo: null, source: "maxwell_import", createdBy: "test" } });
      return g;
    };
    const locked = await mk("MG9301", "測試長工甲", "2024-01-01"); // 蓋 6 月（鎖）
    const fine = await mk("MG9302", "測試長工乙", "2026-07-01"); // 7 月起
    const buf = await wb([
      { staffNo: "MG9301", name: "測試長工甲", basic: 16000, commencement: "2024-01-01" },
      { staffNo: "MG9302", name: "測試長工乙", basic: 17000, commencement: "2026-07-01" },
    ]);
    const s = await importMaxwellContracts(buf, user.id, null);
    expect(s.skippedLockedRows).toBe(1);
    expect(s.contractsCreated).toBe(1);
    expect(await prisma.guardLongtermContract.count({ where: { guardId: locked.id, voidedAt: null } })).toBe(1);
    expect(Number((await prisma.guardLongtermContract.findFirstOrThrow({ where: { guardId: locked.id, voidedAt: null } })).monthlySalary)).toBe(15000);
    expect(Number((await prisma.guardLongtermContract.findFirstOrThrow({ where: { guardId: fine.id, voidedAt: null } })).monthlySalary)).toBe(17000);
    expect(s.warnings.some((w) => w.includes("鎖"))).toBe(true);
    // 重跑冪等：鎖月嗰行再跳過、第二行 unchanged
    const s2 = await importMaxwellContracts(buf, user.id, null);
    expect(s2.skippedLockedRows).toBe(1);
    expect(s2.contractsCreated).toBe(0);
  });
});
