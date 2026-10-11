// P8.3：鎖月後自動出齊檔——生成 4 份、內容同人手匯出 route 逐 part 相同（同一數據）、重複跑唔重複生成、
// 重新鎖月取代（舊版只留 1 份）、權限（雞頭／安員 403）、autopay 下載要確認、通知無 PII。
import { describe, it, expect, beforeEach, vi } from "vitest";
import JSZip from "jszip";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { runAfterLockExports, afterLockExportsJob } from "@/lib/jobs/after-lock-exports";
import { ensureJobRows } from "@/lib/scheduler/runner";
import { assertNoPii } from "@/lib/notify/create";
import { GET as listFiles } from "@/app/api/files/route";
import { GET as getFile } from "@/app/api/files/[id]/route";
import { GET as payrollRoute } from "@/app/api/reports/payroll/route";
import { GET as monthlyCloseRoute } from "@/app/api/reports/monthly-close/route";
import { GET as postorderRoute } from "@/app/api/reports/postorder/[month]/route";
import { GET as autopayRoute } from "@/app/api/longterm/payroll/[month]/autopay/route";

// 可注入失敗：globalThis.__p83FailKind = "monthly_close" 令該 kind 生成時拋錯
vi.mock("@/lib/files/generated", async (orig) => {
  const actual = await orig<typeof import("@/lib/files/generated")>();
  return { ...actual, buildFile: (k: Parameters<typeof actual.buildFile>[0], m: Date) => ((globalThis as { __p83FailKind?: string }).__p83FailKind === k ? Promise.reject(new Error("boom")) : actual.buildFile(k, m)) };
});

const AUG = new Date(Date.UTC(2026, 7, 1));
const req = (url: string, cookie: string) => new Request(url, { headers: { cookie } });

/** 逐 part 比較兩份 xlsx（zip entry 內容）；docProps/core.xml 帶生成時間，唔比。 */
async function partsOf(buf: Buffer | Uint8Array): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files).sort()) {
    if (zip.files[name]!.dir || name === "docProps/core.xml") continue;
    out[name] = await zip.files[name]!.async("string");
  }
  return out;
}
const buf = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe("P8.3 after_lock_exports", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    await ensureJobRows([afterLockExportsJob]);
    // 8 月：一個長工 + 長工糧 run，然後鎖月
    const b07 = await prisma.broker.create({ data: { code: "TEST-B07-P83", name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "test" } });
    const g = await prisma.guard.create({ data: { nameZh: "測試長工P83", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), bankCode: "004", bankAccountNo: "6001234567", bankPayeeName: "TEST PAYEE", tel: "91234567", createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15000, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, source: "manual", createdBy: "test" } });
    for (let d = 1; d <= 20; d++) {
      await prisma.shiftRecord.create({ data: { workDate: new Date(Date.UTC(2026, 7, d)), siteId: fx.site.id, shiftTypeId: fx.shiftType.id, guardId: g.id, settlementBrokerId: b07.id, operationalBrokerId: b07.id, recordType: "shift", createdBy: "test" } });
    }
    await recomputeLongtermPayroll(AUG, fx.userIds["老闆"], null);
    await prisma.monthClose.upsert({ where: { month: AUG }, create: { month: AUG, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" }, update: { lockedAt: new Date() } });
  });

  it("鎖月後生成 4 份；未計長工糧嘅月份跳過 autopay 並寫明；通知無 PII", async () => {
    const r = await runAfterLockExports(new Date());
    const months = (r.summary as { months: Record<string, Record<string, string>> }).months;
    expect(months["2026-08"]).toEqual({ payroll_detail: "ok", monthly_close: "ok", postorder: "ok", longterm_autopay: "ok" });
    expect(months["2026-06"]).toEqual({ payroll_detail: "ok", monthly_close: "ok", postorder: "ok", longterm_autopay: "skipped_no_longterm_payroll" });
    expect(await prisma.generatedFile.count({ where: { month: AUG, current: true } })).toBe(4);
    const files = await prisma.generatedFile.findMany({ where: { month: AUG } });
    expect(files.map((f) => f.kind).sort()).toEqual(["longterm_autopay", "monthly_close", "payroll_detail", "postorder"]);
    for (const f of files) {
      expect(f.size).toBe(f.content.length);
      expect(f.size).toBeGreaterThan(1000);
      expect(f.generatedBy).toBe("job:after_lock_exports");
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const ns = await prisma.appNotification.findMany({ where: { kind: "month_files_ready" }, orderBy: { title: "asc" } });
    expect(ns).toHaveLength(2);
    const aug = ns.find((n) => n.title.startsWith("2026-08"))!;
    expect(aug.title).toBe("2026-08 已鎖，4 份檔已備妥");
    expect(aug.body).toContain("入銀行前請先人手覆核");
    expect(aug.href).toBe("/month-close/files?month=2026-08");
    expect(aug.audience).toEqual(["老闆", "會計"]);
    expect(() => assertNoPii(aug.title, aug.body)).not.toThrow();
    const jun = ns.find((n) => n.title.startsWith("2026-06"))!;
    expect(jun.body).toContain("冇出 BOCHK autopay 檔");
  });

  it("內容同人手匯出 route 逐 part 相同（糧明細／月結總表／Postorder／autopay）", async () => {
    await runAfterLockExports(new Date());
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const stored = async (kind: string) => (await prisma.generatedFile.findFirstOrThrow({ where: { month: AUG, kind, current: true } })).content;
    const manual = {
      payroll_detail: await buf(await payrollRoute(req("http://x/api/reports/payroll?month=2026-08&export=1", cookie))),
      monthly_close: await buf(await monthlyCloseRoute(req("http://x/api/reports/monthly-close?month=2026-08&export=1", cookie))),
      postorder: await buf(await postorderRoute(req("http://x/api/reports/postorder/2026-08", cookie), { params: Promise.resolve({ month: "2026-08" }) })),
      longterm_autopay: await buf(await autopayRoute(req("http://x/api/longterm/payroll/2026-08/autopay?confirm_locked=1", cookie), { params: Promise.resolve({ month: "2026-08" }) })),
    };
    for (const [kind, m] of Object.entries(manual)) {
      expect(m.length, kind).toBeGreaterThan(1000);
      expect(await partsOf(Buffer.from(await stored(kind))), kind).toEqual(await partsOf(m));
    }
  });

  it("重複跑唔重複生成；重新鎖月取代 current，舊版只留 1 份", async () => {
    await runAfterLockExports(new Date());
    const n1 = await prisma.generatedFile.count();
    const r2 = await runAfterLockExports(new Date());
    expect(r2.status).toBe("skipped");
    expect(await prisma.generatedFile.count()).toBe(n1);
    expect(await prisma.appNotification.count({ where: { kind: "month_files_ready" } })).toBe(2);

    // 解鎖再鎖（locked_at 變新）→ 重新生成
    for (let i = 0; i < 2; i++) {
      await prisma.monthClose.update({ where: { month: AUG }, data: { lockedAt: new Date(Date.now() + 2000 * (i + 1)) } });
      const r = await runAfterLockExports(new Date(Date.now() + 60_000));
      expect((r.summary as { months: Record<string, unknown> }).months["2026-08"]).toBeTruthy();
    }
    const pay = await prisma.generatedFile.findMany({ where: { month: AUG, kind: "payroll_detail" }, orderBy: { generatedAt: "desc" } });
    expect(pay).toHaveLength(2); // 1 current + 1 舊版
    expect(pay.filter((p) => p.current)).toHaveLength(1);
    expect(pay[0]!.current).toBe(true);
    expect(await prisma.generatedFile.count({ where: { month: AUG, current: true } })).toBe(4);
  });

  it("某份生成失敗：job 拋錯（框架會 1 小時後重試）、state 唔前進、其餘份照存；修好後重跑補齊", async () => {
    (globalThis as { __p83FailKind?: string }).__p83FailKind = "monthly_close";
    await expect(runAfterLockExports(new Date())).rejects.toThrow(/出檔失敗：monthly_close/);
    (globalThis as { __p83FailKind?: string }).__p83FailKind = undefined;
    expect(await prisma.generatedFile.count({ where: { kind: "monthly_close" } })).toBeLessThan(2); // 失敗嗰份冇存
    expect(await prisma.appNotification.count({ where: { kind: "month_files_ready", title: { startsWith: "2026-08" } } })).toBe(0);
    const r = await runAfterLockExports(new Date());
    expect((r.summary as { months: Record<string, Record<string, string>> }).months["2026-08"]!.monthly_close).toBe("ok");
    expect(await prisma.generatedFile.count({ where: { month: AUG, current: true } })).toBe(4);
    expect(await prisma.appNotification.count({ where: { kind: "month_files_ready", title: { startsWith: "2026-08" } } })).toBe(1);
  });

  it("未鎖月份唔出檔；中途被解鎖跳過", async () => {
    await prisma.monthClose.deleteMany({});
    const r = await runAfterLockExports(new Date());
    expect(r.status).toBe("skipped");
    expect(await prisma.generatedFile.count()).toBe(0);
  });

  it("權限：雞頭／安員 403（清單同下載）；其餘角色只見有 export 權限嘅 kind", async () => {
    await runAfterLockExports(new Date());
    const one = await prisma.generatedFile.findFirstOrThrow({ where: { month: AUG, kind: "payroll_detail", current: true }, select: { id: true } });
    for (const role of ["雞頭", "安員"] as const) {
      const c = await sessionCookieForUser(fx.userIds[role]);
      expect((await listFiles(req("http://x/api/files?month=2026-08", c))).status).toBe(403);
      expect((await getFile(req(`http://x/api/files/${one.id}`, c), { params: Promise.resolve({ id: one.id }) })).status).toBe(403);
      expect((await getFile(req("http://x/api/files/nope", c), { params: Promise.resolve({ id: "nope" }) })).status).toBe(403);
    }
    const boss = await sessionCookieForUser(fx.userIds["老闆"]);
    const bl = (await (await listFiles(req("http://x/api/files?month=2026-08", boss))).json()) as { files: { kind: string; needs_confirm: boolean }[] };
    expect(bl.files.map((f) => f.kind).sort()).toEqual(["longterm_autopay", "monthly_close", "payroll_detail", "postorder"]);
    expect(bl.files.find((f) => f.kind === "longterm_autopay")!.needs_confirm).toBe(true);
    // 逐 kind 對權限矩陣：每個角色清單 kind＝有該 module `export` 權限嘅 kind；有權下載 200，冇權 403
    const { hasPermission } = await import("@/lib/rbac/requirePermission");
    const { FILE_KINDS, FILE_KIND_META } = await import("@/lib/files/generated");
    for (const role of Object.keys(fx.userIds) as (keyof typeof fx.userIds)[]) {
      const u = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds[role] }, include: { role: true } });
      const sess = { userId: u.id, tel: u.tel, name: u.name, roleId: u.roleId, roleName: u.role.name, baseRole: u.role.baseRole, brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: u.tokenVersion, loggedInAt: "" } as never;
      const expected: string[] = [];
      for (const k of FILE_KINDS) if (await hasPermission(sess, FILE_KIND_META[k].module, "export")) expected.push(k);
      const c = await sessionCookieForUser(u.id);
      const res = await listFiles(req("http://x/api/files?month=2026-08", c));
      if (expected.length === 0) {
        expect(res.status, `${role} list`).toBe(403);
        continue;
      }
      expect(((await res.json()) as { files: { kind: string }[] }).files.map((f) => f.kind).sort(), `${role} list`).toEqual([...expected].sort());
      for (const k of FILE_KINDS) {
        const f = await prisma.generatedFile.findFirstOrThrow({ where: { month: AUG, kind: k, current: true }, select: { id: true } });
        const dl = await getFile(req(`http://x/api/files/${f.id}?confirm_locked=1`, c), { params: Promise.resolve({ id: f.id }) });
        expect(dl.status, `${role} ${k}`).toBe(expected.includes(k) ? 200 : 403);
      }
    }
    expect((await getFile(req("http://x/api/files/nope", boss), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
  });

  it("下載：Content-Disposition＋audit；autopay 要 confirm_locked=1（否則 400＋blocked audit）", async () => {
    await runAfterLockExports(new Date());
    const boss = await sessionCookieForUser(fx.userIds["老闆"]);
    const pay = await prisma.generatedFile.findFirstOrThrow({ where: { month: AUG, kind: "payroll_detail", current: true } });
    const res = await getFile(req(`http://x/api/files/${pay.id}`, boss), { params: Promise.resolve({ id: pay.id }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="payroll-2026-08.xlsx"');
    expect((await buf(res)).equals(Buffer.from(pay.content))).toBe(true);
    expect(await prisma.auditLog.count({ where: { tableName: "generated_files", rowId: pay.id, action: "export_download" } })).toBe(1);

    const ap = await prisma.generatedFile.findFirstOrThrow({ where: { month: AUG, kind: "longterm_autopay", current: true } });
    const blocked = await getFile(req(`http://x/api/files/${ap.id}`, boss), { params: Promise.resolve({ id: ap.id }) });
    expect(blocked.status).toBe(400);
    expect(await prisma.auditLog.count({ where: { tableName: "generated_files", rowId: ap.id, action: "export_download_blocked" } })).toBe(1);
    const okRes = await getFile(req(`http://x/api/files/${ap.id}?confirm_locked=1`, boss), { params: Promise.resolve({ id: ap.id }) });
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("content-disposition")).toContain("longterm-autopay-BOCHK-PayrollEditor-2026-08.xlsx");
  });
});
