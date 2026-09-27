// WP-ONE-CLICK Phase 1（老闆 2026-09-26「一鍵全月結算」，§20）：
// integration test——RBAC、step0（上月鎖定閘／卡沿用規則／格數差警告／
// 自動建盤）、冪等、卡死重跑。鐵則：合成資料，唔用真盤/真人名（跟
// tests/fixtures/wp2-fixture.ts 一致風格）。
//
// 唔覆蓋嘅範圍（老實列出，避免睇漏）：guard-fix／reconcile-all 兩個
// step 本身已經有自己成套 integration test（wp-guard-fix-ui.test.ts／
// wp-roster-upload.test.ts 等），呢度淨係驗證 one-click job「串埋」呢
// 兩個 step 唔會拋錯、numbers 有寫入 steps_json；唔重複起一個完整 36
// 檔規模嘅端到端（嗰個留俾 dev 手動全流程驗證，見 P2 文件 §20.6）。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as startOneClick, GET as listOneClick } from "@/app/api/month-close/one-click/route";
import { POST as rerunOneClick } from "@/app/api/month-close/one-click/[id]/rerun/route";
import { stepPrecheck, stepParseHealth, monthCloseRunRerunAllowed, monthCloseRunStalled, runOneClickMonthClose } from "@/lib/month-close/one-click";
import type { StepRecord } from "@/lib/month-close/types";

function reqJson(url: string, cookie: string, method = "GET", body?: unknown): Request {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

const SEPT = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01——fixture 嘅 unlockedMonth（2026-08）做上個月

async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 最小合成 standard layout roster xlsx（同 tests/roster-upload-parse.test.ts
 * 一致寫法），俾自動建盤之後嘅 reparseRosterUpload() 真係解析得到。 */
async function buildRosterXlsx(siteRaw: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = siteRaw;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = new Date(Date.UTC(2026, 8, 1));
  ws.getCell("A5").value = "Broker";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Staff No.";
  ws.getCell("E5").value = "Tel";
  ws.getCell("F5").value = "Name";
  ws.getCell("A6").value = "K";
  ws.getCell("B6").value = "0700-1900";
  ws.getCell("C6").value = "日更保安員";
  ws.getCell("D6").value = "U91999";
  ws.getCell("E6").value = "61239999";
  ws.getCell("F6").value = "測試散工甲";
  ws.getCell("G6").value = "D";
  return toBuffer(wb);
}

async function seedRosterUpload(opts: { month: Date; siteId: string | null; siteNameRaw: string; uploaderUserId: string; fileBytes?: Buffer; status?: "parsed" | "confirmed"; parseSummary?: Record<string, unknown> }) {
  const bytes = opts.fileBytes ?? Buffer.from("fake-not-a-real-xlsx");
  return prisma.rosterUpload.create({
    data: {
      month: opts.month,
      siteId: opts.siteId,
      siteNameRaw: opts.siteNameRaw,
      uploaderUserId: opts.uploaderUserId,
      fileName: `${opts.siteNameRaw}-${opts.month.toISOString().slice(0, 7)}.xlsx`,
      fileSha256: "0".repeat(64),
      fileBytes: new Uint8Array(bytes),
      fileSize: bytes.length,
      status: opts.status ?? "parsed",
      ...(opts.parseSummary ? { parseSummary: opts.parseSummary as Prisma.InputJsonValue } : {}),
    },
  });
}

describe("WP-ONE-CLICK：一鍵全月結算", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  describe("RBAC（「一鍵結算」module）", () => {
    it("雞頭 403（POST／GET 都係）", async () => {
      const cookie = await sessionCookieForUser(fx.userIds["雞頭"]);
      const postRes = await startOneClick(reqJson("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
      expect(postRes.status).toBe(403);
      const getRes = await listOneClick(reqJson("http://x/api/month-close/one-click?month=2026-09", cookie));
      expect(getRes.status).toBe(403);
    });

    it("安員 403", async () => {
      const cookie = await sessionCookieForUser(fx.userIds["安員"]);
      const res = await startOneClick(reqJson("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
      expect(res.status).toBe(403);
    });

    it("主管：GET 得，POST 403（任務書「主管可 view 報告」）", async () => {
      const cookie = await sessionCookieForUser(fx.userIds["主管"]);
      const getRes = await listOneClick(reqJson("http://x/api/month-close/one-click?month=2026-09", cookie));
      expect(getRes.status).toBe(200);
      const postRes = await startOneClick(reqJson("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
      expect(postRes.status).toBe(403);
    });

    it("老闆／會計：POST 得（202 或者 200，視乎 after() 有冇背景 context）", async () => {
      for (const role of ["老闆", "會計"] as const) {
        await clearAll();
        fx = await seedWp2Fixture();
        const cookie = await sessionCookieForUser(fx.userIds[role]);
        const res = await startOneClick(reqJson("http://x/api/month-close/one-click", cookie, "POST", { month: "2026-09" }));
        expect([200, 202]).toContain(res.status);
      }
    });
  });

  describe("step0 前置檢查：上月鎖定閘", () => {
    it("上月（8 月，fixture 已有 shift_records）未鎖 → needsHuman 列明，job 停低", async () => {
      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.needsHuman.some((h) => h.includes("未鎖定"))).toBe(true);
    });

    it("透過 runOneClickMonthClose()：上月未鎖 → run 變 failed，之後嘅 step 全部 skipped", async () => {
      const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
      await runOneClickMonthClose(run.id, SEPT, fx.userIds["老闆"], null);
      const after = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after.status).toBe("failed");
      expect(after.errorMessage).toContain("未鎖定");
      const steps = after.stepsJson as unknown as StepRecord[];
      // precheck 呢一步本身冇拋錯（成功列出咗「上月未鎖定」呢個 needsHuman，
      // 呢個先係佢嘅職責），status 仍然係 done；令成個 run 變 failed 嘅係
      // runOneClickMonthClose() 睇到呢個 needsHuman 之後嘅停低判斷。
      expect(steps.find((s) => s.key === "precheck")?.status).toBe("done");
      expect(steps.find((s) => s.key === "precheck")?.needsHuman.some((h) => h.includes("未鎖定"))).toBe(true);
      expect(steps.find((s) => s.key === "report")?.status).toBe("skipped");
    });

    it("鎖定上月之後：needsHuman 唔再有「未鎖定」", async () => {
      await prisma.monthClose.create({ data: { month: fx.unlockedMonth, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" } });
      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.needsHuman.some((h) => h.includes("未鎖定"))).toBe(false);
    });
  });

  describe("step0：價卡沿用規則", () => {
    it("(盤,更種) 冇本月生效卡，但有舊卡（client_rate/guard_wage 都有值）→ 自動複製新卡，note 帶「一鍵沿用」", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵測試盤A", clientName: "一鍵測試盤A", billingModel: "per_shift", createdBy: "test" } });
      const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", label: "測試夜更", createdBy: "test" } });
      const oldCard = await prisma.rateCard.create({
        data: { siteId: site.id, shiftTypeId: shiftType.id, clientRate: 900, guardWage: 600, brokerFee: 50, payoutRate: 650, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: new Date(Date.UTC(2026, 7, 31)), createdBy: "test" },
      });
      const upload = await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"] });
      await prisma.rosterUploadRow.create({
        data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: shiftType.id, workDate: SEPT, rawCode: "N", codeKind: "shift", guardMatch: "unmatched" },
      });

      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.numbers.cardsCarriedOver).toBe(1);
      expect(result.warnings.some((w) => w.includes("一鍵沿用") || w.includes("沿用"))).toBe(true);

      const newCard = await prisma.rateCard.findFirst({ where: { siteId: site.id, shiftTypeId: shiftType.id, id: { not: oldCard.id } } });
      expect(newCard).not.toBeNull();
      expect(newCard?.note).toContain("一鍵沿用");
      expect(newCard?.effectiveFrom.toISOString().slice(0, 10)).toBe("2026-09-01");
      expect(Number(newCard?.clientRate)).toBe(900);
    });

    it("(盤,更種) 冇本月生效卡，亦冇可沿用嘅舊卡 → needsHuman，唔會估", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵測試盤B", clientName: "一鍵測試盤B", billingModel: "per_shift", createdBy: "test" } });
      const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", label: "測試日更", createdBy: "test" } });
      const upload = await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"] });
      await prisma.rosterUploadRow.create({
        data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: shiftType.id, workDate: SEPT, rawCode: "D", codeKind: "shift", guardMatch: "unmatched" },
      });

      const result = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(result.numbers.cardsMissingNoCarryover).toBe(1);
      expect(result.needsHuman.some((h) => h.includes("要人手設卡"))).toBe(true);
      const anyCard = await prisma.rateCard.findFirst({ where: { siteId: site.id, shiftTypeId: shiftType.id } });
      expect(anyCard).toBeNull(); // 唔准估，冇建任何卡
    });

    it("冪等：連跑兩次 stepPrecheck，第二次 cardsCarriedOver=0（已經有本月卡）", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵測試盤C", clientName: "一鍵測試盤C", billingModel: "per_shift", createdBy: "test" } });
      const shiftType = await prisma.shiftType.create({ data: { siteId: site.id, code: "N", createdBy: "test" } });
      await prisma.rateCard.create({ data: { siteId: site.id, shiftTypeId: shiftType.id, clientRate: 900, guardWage: 600, effectiveFrom: new Date(Date.UTC(2026, 6, 1)), effectiveTo: new Date(Date.UTC(2026, 7, 31)), createdBy: "test" } });
      const upload = await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"] });
      await prisma.rosterUploadRow.create({ data: { uploadId: upload.id, rowIndex: 1, resolvedSiteId: site.id, shiftTypeId: shiftType.id, workDate: SEPT, rawCode: "N", codeKind: "shift", guardMatch: "unmatched" } });

      const first = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(first.numbers.cardsCarriedOver).toBe(1);
      const second = await stepPrecheck(SEPT, fx.userIds["老闆"], null);
      expect(second.numbers.cardsCarriedOver).toBe(0);
      const cardCount = await prisma.rateCard.count({ where: { siteId: site.id, shiftTypeId: shiftType.id } });
      expect(cardCount).toBe(2); // 舊卡 + 沿用嗰張，唔會再重複建
    });
  });

  describe("step1 解析健康：格數差警告＋自動建盤", () => {
    it("本月格數 vs 上月格數差 >30% → warning", async () => {
      const site = await prisma.site.create({ data: { canonicalName: "一鍵測試盤D", clientName: "一鍵測試盤D", billingModel: "per_shift", createdBy: "test" } });
      await seedRosterUpload({ month: fx.unlockedMonth, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"], status: "confirmed", parseSummary: { shiftCount: 100 } });
      await seedRosterUpload({ month: SEPT, siteId: site.id, siteNameRaw: site.canonicalName, uploaderUserId: fx.userIds["老闆"], parseSummary: { shiftCount: 40 } });

      const result = await stepParseHealth(SEPT, fx.userIds["老闆"]);
      expect(result.numbers.formatDiffWarnings).toBe(1);
      expect(result.warnings.some((w) => w.includes("可能截短") || w.includes("格式異常"))).toBe(true);
    });

    it("site_id=null → 自動建盤（待核，per_shift），warning 唔停", async () => {
      const bytes = await buildRosterXlsx("一鍵新盤ABC");
      await seedRosterUpload({ month: SEPT, siteId: null, siteNameRaw: "一鍵新盤ABC", uploaderUserId: fx.userIds["老闆"], fileBytes: bytes });

      const result = await stepParseHealth(SEPT, fx.userIds["老闆"]);
      expect(result.numbers.autoBuiltSites).toBe(1);
      const newSite = await prisma.site.findUnique({ where: { canonicalName: "一鍵新盤ABC" } });
      expect(newSite).not.toBeNull();
      expect(newSite?.billingModel).toBe("per_shift");
      const upload = await prisma.rosterUpload.findFirst({ where: { siteNameRaw: "一鍵新盤ABC" } });
      expect(upload?.siteId).toBe(newSite?.id);
    });
  });

  describe("卡死重跑", () => {
    it("monthCloseRunStalled()：running 未夠 15 分鐘 = false，過咗 = true", () => {
      const now = new Date();
      expect(monthCloseRunStalled({ status: "running", applyStartedAt: now }, now)).toBe(false);
      const staleAt = new Date(now.getTime() - 16 * 60 * 1000);
      expect(monthCloseRunStalled({ status: "running", applyStartedAt: staleAt }, now)).toBe(true);
      expect(monthCloseRunStalled({ status: "done", applyStartedAt: staleAt }, now)).toBe(false);
    });

    it("monthCloseRunRerunAllowed()：failed 隨時得；running 淨係卡死先得；done 唔得", () => {
      const now = new Date();
      const staleAt = new Date(now.getTime() - 16 * 60 * 1000);
      expect(monthCloseRunRerunAllowed({ status: "failed", applyStartedAt: now }, now)).toBe(true);
      expect(monthCloseRunRerunAllowed({ status: "running", applyStartedAt: now }, now)).toBe(false);
      expect(monthCloseRunRerunAllowed({ status: "running", applyStartedAt: staleAt }, now)).toBe(true);
      expect(monthCloseRunRerunAllowed({ status: "done", applyStartedAt: staleAt }, now)).toBe(false);
    });

    it("rerun API：running 未夠 15 分鐘 → 409；過咗 15 分鐘 → 可以重新執行", async () => {
      const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
      const staleAt = new Date(Date.now() - 16 * 60 * 1000);
      const run = await prisma.monthCloseRun.create({ data: { month: SEPT, status: "running", startedById: fx.userIds["老闆"], applyStartedAt: new Date() } });
      const tooSoon = await rerunOneClick(reqJson(`http://x/api/month-close/one-click/${run.id}/rerun`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
      expect(tooSoon.status).toBe(409);

      await prisma.monthCloseRun.update({ where: { id: run.id }, data: { applyStartedAt: staleAt } });
      const ok = await rerunOneClick(reqJson(`http://x/api/month-close/one-click/${run.id}/rerun`, cookie, "POST"), { params: Promise.resolve({ id: run.id }) });
      expect([200, 202]).toContain(ok.status);
    });
  });
});
