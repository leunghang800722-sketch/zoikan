// P3-2.9：months/[month]/open 批量化——結果、audit、already_open 語意不變；查詢數唔隨行數增長。
import { describe, it, expect, beforeEach, vi } from "vitest";

const queries = await vi.hoisted(async () => {
  const { PrismaClient } = await import("@prisma/client");
  const list: string[] = [];
  const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  (client as unknown as { $on: (e: string, cb: (q: { query: string }) => void) => void }).$on("query", (q) => list.push(q.query));
  (globalThis as unknown as { prisma: unknown }).prisma = client;
  return list;
});
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { prisma } from "@/lib/db";
import { POST as openMonth } from "@/app/api/months/[month]/open/route";

const open = (cookie: string, month: string) =>
  openMonth(new Request(`http://t/api/months/${month}/open`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" }), { params: Promise.resolve({ month }) });

describe("P3-2.9 開新月批量化", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("複製 daily_requirements／quotas／assignments，audit 逐行一條，重開 already_open", async () => {
    const stIds: string[] = [fx.shiftType.id];
    for (let i = 0; i < 4; i++) stIds.push((await prisma.shiftType.create({ data: { siteId: fx.site.id, code: `X${i}`, label: `x${i}`, hours: 8, headcountRequired: 1, createdBy: "t" } })).id);
    const rows = stIds.flatMap((st) => Array.from({ length: 31 }, (_, d) => ({ siteId: fx.site.id, shiftTypeId: st, workDate: new Date(Date.UTC(2026, 6, 1 + d)), headcountRequired: 2, createdBy: "t" })));
    await prisma.dailyRequirement.createMany({ data: rows, skipDuplicates: true });
    await prisma.quota.create({ data: { siteId: fx.site.id, shiftTypeId: fx.shiftType.id, brokerId: fx.brokerA.id, month: new Date(Date.UTC(2026, 6, 1)), targetShifts: 5, createdBy: "t" } });
    const srcDR = await prisma.dailyRequirement.count({ where: { workDate: { gte: new Date(Date.UTC(2026, 6, 1)), lte: new Date(Date.UTC(2026, 6, 31)) }, voidedAt: null } });
    const srcAssign = await prisma.brokerSiteAssignment.count({ where: { month: new Date(Date.UTC(2026, 6, 1)) } });
    const auditsBefore = await prisma.auditLog.count({ where: { tableName: { in: ["daily_requirements", "quotas", "broker_site_assignments"] } } });

    const res = await open(cookie, "2026-08"); // 8 月份有 31 日，7 月 31 日 → 8 月 31 日
    const b = await res.json();
    expect(res.status).toBe(201);
    expect(b.daily_requirements_created).toBe(srcDR - 1); // 7 月 31 日 → 8 月 31 日全部有對應日；fixture 已有 8/1 一行 → 跳過
    expect(b.quotas_created).toBe(1);
    expect(b.broker_site_assignments_created).toBe(srcAssign);
    const created = b.daily_requirements_created + b.quotas_created + b.broker_site_assignments_created;
    const auditsAfter = await prisma.auditLog.count({ where: { tableName: { in: ["daily_requirements", "quotas", "broker_site_assignments"] } } });
    expect(auditsAfter - auditsBefore).toBe(created);
    const sample = await prisma.auditLog.findFirst({ where: { tableName: "quotas", action: "create" }, orderBy: { createdAt: "desc" } });
    expect((sample!.after as Record<string, unknown>).copied_from).toBe("2026-07");

    const again = await open(cookie, "2026-08");
    expect(again.status).toBe(200);
    expect((await again.json()).already_open).toBe(true);
  });

  it("查詢數唔隨 daily_requirements 行數增長", async () => {
    const mk = async (n: number, month: number) => {
      const st = await prisma.shiftType.create({ data: { siteId: fx.site.id, code: `Q${n}${month}`, label: "q", hours: 8, headcountRequired: 1, createdBy: "t" } });
      await prisma.dailyRequirement.createMany({ data: Array.from({ length: n }, (_, d) => ({ siteId: fx.site.id, shiftTypeId: st.id, workDate: new Date(Date.UTC(2026, month, 1 + (d % 28))), headcountRequired: 1, createdBy: "t" })), skipDuplicates: true });
    };
    await mk(10, 8); // 9 月少量（來源）
    const q0 = queries.length;
    expect((await open(cookie, "2026-10")).status).toBe(201);
    const small = queries.length - q0;
    for (let i = 0; i < 8; i++) await mk(28, 10); // 11 月 ~224 行（來源）
    const q1 = queries.length;
    expect((await open(cookie, "2026-12")).status).toBe(201);
    const big = queries.length - q1;
    expect(big - small).toBeLessThanOrEqual(4);
  });
});
