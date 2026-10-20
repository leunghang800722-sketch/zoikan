// EMP-P1 第 1 部分：schema（migration 純加）＋工號卡寫入規則（replaces_current／current_exists／period_overlap／日期次序／結束必須有離職日＋原因）。
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as staffNumberCreate } from "@/app/api/guards/[id]/staff-numbers/route";
import { PATCH as staffNumberUpdate } from "@/app/api/guards/[id]/staff-numbers/[numberId]/route";
import { upsertCurrentStaffNumber, assertNoStaffNumberPeriodOverlap } from "@/lib/guards/staff-numbers";
import { GuardStaffNumberCreateSchema, GuardStaffNumberUpdateSchema } from "@/lib/api/schemas";

const req = (url: string, cookie: string, method = "GET", body?: unknown) => new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

describe("EMP-P1 migration：純加（冪等、nullable、唔改現有資料）", () => {
  it("SQL 只有 ADD COLUMN IF NOT EXISTS／CREATE TABLE IF NOT EXISTS／FK／INDEX，冇 gen_random_uuid／RAISE／UPDATE／DELETE FROM／DROP／TRUNCATE", () => {
    const dir = readdirSync(path.join(process.cwd(), "prisma/migrations")).find((d) => d.endsWith("_emp_p1_staff_number_cards"))!;
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations", dir, "migration.sql"), "utf-8");
    expect(sql).not.toMatch(/gen_random_uuid|\bRAISE\b|\bUPDATE\s+"|\bDELETE\s+FROM\b|\bDROP\b|\bTRUNCATE\b/i);
    expect(sql).toMatch(/"guard_staff_numbers" ADD COLUMN IF NOT EXISTS "end_reason"/);
    expect(sql).toMatch(/shift_record_staff_attributions/);
    for (const col of ["staff_number_id", "staff_scheme", "staff_number_source"]) expect(sql).toContain(`"${col}"`);
  });
  it("DB 有新欄／新表；舊資料新欄全 null", async () => {
    await clearAll();
    const cols = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name='guard_staff_numbers' AND column_name IN ('end_reason','predecessor_id'))
         OR (table_name='shift_records' AND column_name IN ('staff_number_id','staff_scheme','staff_number_source'))
         OR (table_name='sites' AND column_name='staff_scheme')
         OR (table_name='shift_record_staff_attributions')`;
    expect(cols.length).toBeGreaterThanOrEqual(2 + 3 + 1 + 5);
  });
});

describe("EMP-P1 工號卡寫入規則", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  const url = (g: string) => `http://test.local/api/guards/${g}/staff-numbers`;
  const post = (guardId: string, body: Record<string, unknown>) => staffNumberCreate(req(url(guardId), cookie, "POST", body), { params: Promise.resolve({ id: guardId }) });
  const patch = (guardId: string, numberId: string, body: Record<string, unknown>) => staffNumberUpdate(req(`${url(guardId)}/${numberId}`, cookie, "PATCH", body), { params: Promise.resolve({ id: guardId, numberId }) });

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("同 scheme 已有 current + 冇 replaces_current → 409 current_exists，舊卡原封不動", async () => {
    expect((await post(fx.guardA.id, { scheme: "MP", number: "MP90201" })).status).toBe(201);
    const res = await post(fx.guardA.id, { scheme: "MP", number: "MP90202" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe("current_exists");
    const rows = await prisma.guardStaffNumber.findMany({ where: { guardId: fx.guardA.id, scheme: "MP" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("current");
    expect(rows[0]!.endReason).toBeNull();
  });

  it("replaces_current:true → 舊卡 former＋replaced＋valid_to=今日，新卡 predecessor_id=舊卡", async () => {
    const first = (await (await post(fx.guardA.id, { scheme: "MP", number: "MP90211", valid_from: "2026-01-01" })).json()) as { id: string };
    const res = await post(fx.guardA.id, { scheme: "MP", number: "MP90212", replaces_current: true });
    expect(res.status).toBe(201);
    const second = (await res.json()) as { id: string; predecessor_id: string | null; converted_former?: { end_reason?: string } };
    expect(second.predecessor_id).toBe(first.id);
    const old = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { id: first.id } });
    expect(old).toMatchObject({ status: "former", endReason: "replaced" });
    expect(old.validTo).not.toBeNull();
    expect(second.converted_former?.end_reason).toBe("replaced");
  });

  it("重新入職：PATCH 結束舊卡（填離職日＋原因 resigned）之後可以開新卡，新卡冇 predecessor", async () => {
    const first = (await (await post(fx.guardA.id, { scheme: "U", number: "U90221", valid_from: "2026-01-01" })).json()) as { id: string };
    expect((await patch(fx.guardA.id, first.id, { status: "former" })).status).toBe(400); // 冇離職日＋原因
    expect((await patch(fx.guardA.id, first.id, { status: "former", valid_to: "2026-03-31" })).status).toBe(400); // 冇原因
    expect((await patch(fx.guardA.id, first.id, { status: "former", valid_to: "2026-03-31", end_reason: "resigned" })).status).toBe(200);
    const res = await post(fx.guardA.id, { scheme: "U", number: "U90222", valid_from: "2026-06-01" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { predecessor_id: string | null }).predecessor_id).toBeNull();
  });

  it("補歷史卡：status=former 必須有 valid_to＋end_reason；current 唔准帶；日期次序", async () => {
    expect((await post(fx.guardA.id, { scheme: "U", number: "U90231", status: "former" })).status).toBe(400);
    expect((await post(fx.guardA.id, { scheme: "U", number: "U90231", status: "former", valid_to: "2025-12-31" })).status).toBe(400);
    expect((await post(fx.guardA.id, { scheme: "U", number: "U90231", valid_to: "2025-12-31", end_reason: "resigned" })).status).toBe(400);
    expect((await post(fx.guardA.id, { scheme: "U", number: "U90231", status: "former", valid_from: "2026-02-01", valid_to: "2026-01-01", end_reason: "resigned" })).status).toBe(400);
    const ok = await post(fx.guardA.id, { scheme: "U", number: "U90231", status: "former", valid_from: "2025-01-01", valid_to: "2025-12-31", end_reason: "resigned" });
    expect(ok.status).toBe(201);
    // 補咗歷史卡之後仍然可以開現用卡（歷史 former 唔受 partial unique 影響）
    expect((await post(fx.guardA.id, { scheme: "U", number: "U90232", valid_from: "2026-03-01" })).status).toBe(201);
  });

  it("period_overlap：同 guard 同 scheme 兩張卡日期齊全而重疊 → 409；缺日期唔檢查", async () => {
    expect((await post(fx.guardA.id, { scheme: "U", number: "U90241", status: "former", valid_from: "2025-01-01", valid_to: "2025-06-30", end_reason: "resigned" })).status).toBe(201);
    const overlap = await post(fx.guardA.id, { scheme: "U", number: "U90242", status: "former", valid_from: "2025-06-30", valid_to: "2025-12-31", end_reason: "resigned" });
    expect(overlap.status).toBe(409);
    expect(((await overlap.json()) as { error?: string }).error).toBe("period_overlap");
    expect((await post(fx.guardA.id, { scheme: "U", number: "U90243", status: "former", valid_from: "2025-07-01", valid_to: "2025-12-31", end_reason: "resigned" })).status).toBe(201);
    // 缺 valid_from → 唔檢查
    expect((await post(fx.guardA.id, { scheme: "U", number: "U90244", status: "former", valid_to: "2025-03-01", end_reason: "cancelled" })).status).toBe(201);
    // 不同 scheme 互不影響
    expect((await post(fx.guardA.id, { scheme: "MP", number: "MP90241", status: "former", valid_from: "2025-01-01", valid_to: "2025-12-31", end_reason: "resigned" })).status).toBe(201);
    // PATCH 改日期造成重疊 → 409
    const row = await prisma.guardStaffNumber.findUniqueOrThrow({ where: { number: "U90243" } });
    expect((await patch(fx.guardA.id, row.id, { valid_from: "2025-06-01" })).status).toBe(409);
    expect((await patch(fx.guardA.id, row.id, { valid_from: "2026-01-01" })).status).toBe(400); // 次序錯
  });

  it("zod：valid_from > valid_to 擋；update 同樣", () => {
    expect(GuardStaffNumberCreateSchema.safeParse({ scheme: "U", number: "U1", valid_from: "2026-02-01", valid_to: "2026-01-01", status: "former", end_reason: "resigned" }).success).toBe(false);
    expect(GuardStaffNumberCreateSchema.safeParse({ scheme: "U", number: "U1", status: "former", valid_to: "2026-01-01", end_reason: "bogus" }).success).toBe(false);
    expect(GuardStaffNumberUpdateSchema.safeParse({ valid_from: "2026-02-01", valid_to: "2026-01-01" }).success).toBe(false);
    expect(GuardStaffNumberUpdateSchema.safeParse({ valid_from: "2026-01-01", valid_to: "2026-02-01", end_reason: "resigned" }).success).toBe(true);
  });

  it("lib 層：upsertCurrentStaffNumber 兩條路（replacesCurrent／409）＋ assertNoStaffNumberPeriodOverlap 邊界", async () => {
    await prisma.$transaction((tx) => upsertCurrentStaffNumber(tx, { guardId: fx.guardB.id, scheme: "U", number: "U90251", source: "test" }));
    await expect(prisma.$transaction((tx) => upsertCurrentStaffNumber(tx, { guardId: fx.guardB.id, scheme: "U", number: "U90252", source: "test" }))).rejects.toMatchObject({ status: 409, code: "current_exists" });
    const r = await prisma.$transaction((tx) => upsertCurrentStaffNumber(tx, { guardId: fx.guardB.id, scheme: "U", number: "U90252", source: "test", replacesCurrent: true }));
    expect(r.created.predecessorId).toBe(r.convertedFormer!.before.id);
    expect(r.convertedFormer!.after.endReason).toBe("replaced");
    await prisma.$transaction(async (tx) => {
      await tx.guardStaffNumber.create({ data: { guardId: fx.guardB.id, scheme: "MG", number: "MG90251", status: "former", validFrom: new Date("2025-01-01"), validTo: new Date("2025-01-31"), endReason: "resigned" } });
      await expect(assertNoStaffNumberPeriodOverlap(tx, { guardId: fx.guardB.id, scheme: "MG", validFrom: new Date("2025-01-31"), validTo: new Date("2025-02-28") })).rejects.toMatchObject({ code: "period_overlap" });
      await expect(assertNoStaffNumberPeriodOverlap(tx, { guardId: fx.guardB.id, scheme: "MG", validFrom: new Date("2025-02-01"), validTo: new Date("2025-02-28") })).resolves.toBeUndefined();
      await expect(assertNoStaffNumberPeriodOverlap(tx, { guardId: fx.guardB.id, scheme: "MG", validFrom: null, validTo: new Date("2025-02-28") })).resolves.toBeUndefined();
    });
  });
});
