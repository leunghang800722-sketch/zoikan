// EMP-P2 第 1 部分：工號體系設定表 staff_schemes——migration 種子、讀取 helper、設定 API（老闆專用、code 固定、寫 audit）。
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listSchemes } from "@/app/api/admin/staff-schemes/route";
import { PATCH as patchScheme } from "@/app/api/admin/staff-schemes/[code]/route";
import { loadStaffSchemes, schemeInfoOf } from "@/lib/guards/staff-schemes";

const req = (url: string, cookie: string, method = "GET", body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

describe("EMP-P2 staff_schemes", () => {
  let fx: Wp2Fixture;
  let boss: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    boss = await sessionCookieForUser(fx.userIds["老闆"]);
    // 還原出廠種子（其他測試可能改過）
    await prisma.staffScheme.deleteMany({});
    await prisma.staffScheme.createMany({
      data: [
        { code: "U", labelZh: "U（Wilson 盤）", payerCode: "maxwell", payerLabelZh: "在勤出糧", payMethod: null, isFrontline: true, isLongterm: false, sort: 1 },
        { code: "MP", labelZh: "MP（在勤盤）", payerCode: "maxwell", payerLabelZh: "在勤出糧", payMethod: null, isFrontline: true, isLongterm: false, sort: 2 },
        { code: "MG", labelZh: "MG（在勤長工）", payerCode: "maxwell", payerLabelZh: "在勤長工糧", payMethod: "autopay", isFrontline: false, isLongterm: true, sort: 3 },
        { code: "MW", labelZh: "MW（在勤寫字樓）", payerCode: "maxwell", payerLabelZh: "在勤出糧", payMethod: null, isFrontline: false, isLongterm: false, sort: 4 },
      ],
    });
  });

  it("migration：純加表＋ON CONFLICT DO NOTHING 種四行，冇 gen_random_uuid／RAISE／UPDATE／DELETE FROM／DROP", () => {
    const dir = readdirSync(path.join(process.cwd(), "prisma/migrations")).find((d) => d.endsWith("_emp_p2_staff_schemes"))!;
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations", dir, "migration.sql"), "utf-8");
    expect(sql).not.toMatch(/gen_random_uuid|\bRAISE\b|\bUPDATE\s+"|\bDELETE\s+FROM\b|\bDROP\b|\bTRUNCATE\b/i);
    expect(sql).toContain("ON CONFLICT");
    for (const c of ["'U'", "'MP'", "'MG'", "'MW'"]) expect(sql).toContain(c);
  });

  it("EMP-P2.2：出廠預設四個體系出糧方全部 maxwell（U 都係在勤出糧）；更正 migration 只 UPDATE staff_schemes U 行（wilson→maxwell），冇 RAISE／gen_random_uuid／DELETE／DROP", async () => {
    await prisma.staffScheme.deleteMany({});
    const m = await loadStaffSchemes(); // 表空 → 出廠預設
    for (const c of ["U", "MP", "MG", "MW"]) expect(m.get(c)!.payerCode).toBe("maxwell");
    expect(m.get("U")).toMatchObject({ payerLabelZh: "在勤出糧", labelZh: expect.stringContaining("Wilson") });
    const dir = readdirSync(path.join(process.cwd(), "prisma/migrations")).find((d) => d.endsWith("_emp_p2_2_payer_fix"))!;
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations", dir, "migration.sql"), "utf-8");
    expect(sql).not.toMatch(/gen_random_uuid|\bRAISE\b|\bDELETE\s+FROM\b|\bDROP\b|\bTRUNCATE\b|\bINSERT\b/i);
    expect(sql).toMatch(/UPDATE "staff_schemes" SET "payer_code" = 'maxwell'[^;]*WHERE "code" = 'U' AND "payer_code" = 'wilson'/);
    // 套用 migration：舊種子 wilson → maxwell；老闆自己改過（非 wilson）就唔郁
    await prisma.staffScheme.createMany({ data: [{ code: "U", labelZh: "U（Wilson 盤）", payerCode: "wilson", payerLabelZh: "Wilson 出糧", isFrontline: true, isLongterm: false, sort: 1 }, { code: "MP", labelZh: "MP", payerCode: "custom", payerLabelZh: "自訂", isFrontline: true, isLongterm: false, sort: 2 }] });
    await prisma.$executeRawUnsafe(sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"));
    expect(await prisma.staffScheme.findUniqueOrThrow({ where: { code: "U" } })).toMatchObject({ payerCode: "maxwell", payerLabelZh: "在勤出糧" });
    expect(await prisma.staffScheme.findUniqueOrThrow({ where: { code: "MP" } })).toMatchObject({ payerCode: "custom" });
    await prisma.$executeRawUnsafe(sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")); // 冪等
    expect(await prisma.staffScheme.findUniqueOrThrow({ where: { code: "U" } })).toMatchObject({ payerCode: "maxwell" });
  });

  it("loadStaffSchemes：設定表優先、缺行用出廠預設補；未知 scheme 顯示 code", async () => {
    await prisma.staffScheme.delete({ where: { code: "MW" } });
    const m = await loadStaffSchemes();
    expect([...m.keys()].sort()).toEqual(["MG", "MP", "MW", "U"]);
    expect(m.get("MP")).toMatchObject({ payerCode: "maxwell", isFrontline: true });
    expect(m.get("MG")).toMatchObject({ isLongterm: true, payMethod: "autopay" });
    expect(m.get("MW")!.labelZh).toContain("MW"); // fallback 預設
    expect(schemeInfoOf(m, "ZZ")).toMatchObject({ code: "ZZ", labelZh: "ZZ", payerCode: null });
    expect(schemeInfoOf(m, null)).toBeNull();
  });

  it("API：老闆可讀可改 label／payer／pay_method，寫 audit；主管／雞頭 403；code 固定（未知 404、body 帶 code 400）", async () => {
    const list = await listSchemes(req("http://test.local/api/admin/staff-schemes", boss));
    expect(list.status).toBe(200);
    expect((await list.json()).schemes.map((s: { code: string }) => s.code)).toEqual(["U", "MP", "MG", "MW"]);
    const patch = (code: string, body: unknown, c = boss) => patchScheme(req(`http://test.local/api/admin/staff-schemes/${code}`, c, "PATCH", body), { params: Promise.resolve({ code }) });
    const ok = await patch("MP", { payer_label_zh: "在勤（Maxwell）出糧", pay_method: "cash" });
    expect(ok.status).toBe(200);
    expect(await prisma.staffScheme.findUniqueOrThrow({ where: { code: "MP" } })).toMatchObject({ payerLabelZh: "在勤（Maxwell）出糧", payMethod: "cash", payerCode: "maxwell" });
    const audit = await prisma.auditLog.findFirst({ where: { tableName: "staff_schemes", rowId: "MP" }, orderBy: { createdAt: "desc" } });
    expect((audit!.after as { pay_method?: string }).pay_method).toBe("cash");
    expect((await patch("MP", { pay_method: null })).status).toBe(200);
    expect((await prisma.staffScheme.findUniqueOrThrow({ where: { code: "MP" } })).payMethod).toBeNull();
    expect((await patch("XX", { label_zh: "x" })).status).toBe(404);
    expect((await patch("MP", { code: "ZZ" })).status).toBe(400);
    expect((await patch("MP", { pay_method: "bogus" })).status).toBe(400);
    const sup = await sessionCookieForUser(fx.userIds["主管"]);
    expect((await patch("MP", { label_zh: "x" }, sup)).status).toBe(403);
    expect((await listSchemes(req("http://test.local/api/admin/staff-schemes", sup))).status).toBe(403);
    const brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    expect((await listSchemes(req("http://test.local/api/admin/staff-schemes", brokerCookie))).status).toBe(403);
  });
});

describe("EMP-P2.1 ai.audit_log 白名單", () => {
  it("staff_schemes 變更 audit 俾 AI 助手睇到（無 PII）；其他未登記表照舊唔入", async () => {
    const { aiQuery } = await import("@/lib/ai/db");
    // 個別 test（wp-one-click-auto-isolation）會重跑舊 migration 令 view 退回舊定義，所以先重跑本 migration（CREATE OR REPLACE VIEW，冪等）確保測的係 migration 本身嘅定義
    const dir = readdirSync(path.join(process.cwd(), "prisma/migrations")).find((d) => d.endsWith("_emp_p2_1_ai_audit_staff_schemes"))!;
    await prisma.$executeRawUnsafe(readFileSync(path.join(process.cwd(), "prisma/migrations", dir, "migration.sql"), "utf-8"));
    await clearAll();
    const fx = await seedWp2Fixture();
    const marker = `ai-wl-${Date.now()}`;
    for (const t of ["staff_schemes", "guard_staff_numbers"]) {
      await prisma.auditLog.create({ data: { actorUserId: fx.userIds["老闆"], tableName: t, rowId: marker, action: "update", after: { label_zh: "x", tel: "90000000" } } });
    }
    const { rows } = await aiQuery(`SELECT table_name, after FROM ai.audit_log WHERE row_id = '${marker}'`);
    expect(rows.map((r) => (r as { table_name: string }).table_name)).toEqual(["staff_schemes"]);
    expect(JSON.stringify((rows[0] as { after: unknown }).after)).not.toContain("90000000"); // tel 被 scrub
  });
});
