// S-batch-1021：背景 job 體驗（error summary 唔含 PII、stale 門檻）、保安員 left／inactive 分開、HKID canonical index。全部合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { errorSummary } from "@/lib/sites/staff-scheme-jobs";
import { sweepStaleRuns } from "@/lib/scheduler/runner";
import { guardStatusLabel } from "@/components/reconcile/derive";
import { storedPhonesForHkid } from "@/lib/guards/ocr/stored-phones";

describe("job 失敗 summary：error_code＋短訊息，唔含 PII", () => {
  it("err.name 做 error_code；message 最多 120 字；數字串（電話／證件號）一律換 #", () => {
    const e = Object.assign(new Error("duplicate key phone 90001111 hkid Z9000012 " + "x".repeat(300)), { name: "PrismaClientKnownRequestError" });
    const s = errorSummary(e) as { error: string; error_code: string; message: string };
    expect(s.error_code).toBe("PrismaClientKnownRequestError");
    expect(s.error).toBe("PrismaClientKnownRequestError"); // 舊欄保留
    expect(s.message.length).toBeLessThanOrEqual(120);
    expect(s.message).not.toMatch(/\d/);
    expect(s.message).toContain("phone #");
    expect(errorSummary("boom")).toMatchObject({ error_code: "error", message: "error: " });
  });
});

describe("sweepStaleRuns：site_scheme_backfill 15 分鐘，其他 1 小時", () => {
  beforeEach(clearAll);
  it("盤體系 job 20 分鐘 → error；10 分鐘仍 running；其他 job 20 分鐘仍 running、2 小時 error", async () => {
    const mk = (jobKey: string, minsAgo: number) => prisma.jobRun.create({ data: { jobKey, trigger: "manual", status: "running", startedAt: new Date(Date.now() - minsAgo * 60_000) } });
    const a = await mk("site_scheme_backfill", 20);
    const b = await mk("site_scheme_backfill", 10);
    const c = await mk("some_other_job", 20);
    const d = await mk("some_other_job", 120);
    expect(await sweepStaleRuns()).toBe(2);
    const st = async (id: string) => (await prisma.jobRun.findUniqueOrThrow({ where: { id } })).status;
    expect([await st(a.id), await st(b.id), await st(c.id), await st(d.id)]).toEqual(["error", "running", "running", "error"]);
  });
});

describe("保安員 left／inactive 分開", () => {
  beforeEach(clearAll);
  it("label：left 已離職、inactive 已停用", () => {
    expect(guardStatusLabel("left")).toBe("已離職");
    expect(guardStatusLabel("inactive")).toBe("已停用");
  });
  it("DB 可存 left；status=active 過濾（預設列表／勤工獎／雞頭人數）唔含 left 同 inactive", async () => {
    await prisma.guard.createMany({ data: [
      { nameZh: "測試甲", employmentType: "cash_casual", status: "active" },
      { nameZh: "測試乙", employmentType: "cash_casual", status: "left" },
      { nameZh: "測試丙", employmentType: "cash_casual", status: "inactive" },
    ] });
    const act = await prisma.guard.findMany({ where: { status: "active" }, select: { nameZh: true } });
    expect(act.map((g) => g.nameZh)).toEqual(["測試甲"]);
    expect(await prisma.guard.count({ where: { status: "left" } })).toBe(1);
  });
});

describe("HKID canonical expression index", () => {
  beforeEach(clearAll);
  it("index 存在，storedPhonesForHkid 仍配對帶括號舊資料", async () => {
    const idx = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'guards' AND indexname = 'guards_hkid_canon_idx'`;
    expect(idx).toHaveLength(1);
    await prisma.guard.create({ data: { nameZh: "測試丁", employmentType: "cash_casual", hkid: "z900003(4)", tel: "90003333" } });
    expect(await storedPhonesForHkid("Z9000034")).toEqual(["90003333"]);
  });
});
