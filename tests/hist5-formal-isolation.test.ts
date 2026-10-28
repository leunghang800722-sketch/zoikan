// HIST-5（Opus 驗收 M1）：歷史導入 AI 推斷寫嘅「淨姓名」覆寫（staffNo=''）只喺歷史月份配對生效；
// 正式月份同名新人（有自己電話）唔可以被歷史 minimal guard 搶走。全部假資料（測試…名、fakeTel）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createUpload } from "@/app/api/roster-uploads/route";
import { markHistoricalMonth } from "@/lib/month-close/historical";
import { loadGuardMatchIndex } from "@/lib/roster-upload/guard-index";
import { matchGuard } from "@/lib/roster-upload/match";
import { fakeTel, mkGuard, mkShiftType, mkSite, rosterXlsx, MAR } from "./helpers/hist5";

const NAME = "測試同名新舊人";

describe("HIST-5 淨姓名覆寫只限歷史月份", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  let histGuardId: string;
  let realGuardId: string;
  let tel: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await markHistoricalMonth(MAR, fx.userIds["老闆"], { ip: null });
    tel = fakeTel();
    const hist = await mkGuard({ name: NAME, status: "inactive", createdBy: "system:guard-fix:historical_roster" });
    const real = await mkGuard({ name: NAME, tel });
    histGuardId = hist.id;
    realGuardId = real.id;
    await prisma.guardMatchOverride.create({ data: { staffNo: "", nameRaw: NAME, guardId: histGuardId, reason: "HIST5 R2c（信心 0.85）：新建保安員（電話留空）", createdBy: "test" } });
  });

  it("loadGuardMatchIndex：預設（正式）唔載入淨姓名 HIST5 覆寫，電話照配到真人；歷史模式先載入", async () => {
    const formal = matchGuard({ staffNoRaw: null, nameRaw: NAME, telRaw: tel }, await loadGuardMatchIndex(prisma));
    expect(formal.guardId).toBe(realGuardId);
    const hist = matchGuard({ staffNoRaw: null, nameRaw: NAME, telRaw: tel }, await loadGuardMatchIndex(prisma, { includeHistInferenceOverrides: true }));
    expect(hist.guardId).toBe(histGuardId);
  });

  it("更表上載：正式月份格配到真人（電話），歷史月份格跟覆寫", async () => {
    const site = await mkSite("測試隔離盤");
    await mkShiftType(site.id, "D", "0700", "1900", 12);
    const up = async (month: number) => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(await rosterXlsx({ site: "測試隔離盤", month, people: [{ broker: "TEST-BA", time: "0700-1900", tel, name: NAME, codes: ["D"] }] }))], `iso-${month}.xlsx`));
      form.set("month", `2026-${String(month).padStart(2, "0")}`);
      const res = await createUpload(new Request("http://test.local/api/roster-uploads", { method: "POST", headers: { cookie }, body: form }));
      expect(res.status).toBe(201);
    };
    await up(9);
    await up(3);
    const rows = await prisma.rosterUploadRow.findMany({ where: { nameRaw: NAME }, select: { guardId: true, workDate: true } });
    const sep = rows.find((r) => r.workDate.getUTCMonth() === 8)!;
    const mar = rows.find((r) => r.workDate.getUTCMonth() === 2)!;
    expect(sep.guardId).toBe(realGuardId);
    expect(mar.guardId).toBe(histGuardId);
  });
});
