// HIST-3：歷史導入第一輪真數據修正（項 2／3／4／6）——端到端，全部合成 fixture
// （測試…名、T- 工號、fakeTel），零真資料、零讀 data/。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createUpload } from "@/app/api/roster-uploads/route";
import { markHistoricalMonth } from "@/lib/month-close/historical";
import { runHistoricalImport, claimHistoricalImportRun, type HistImportReport } from "@/lib/month-close/historical-import";
import { stepParseHealth } from "@/lib/month-close/one-click";

const MAR = new Date(Date.UTC(2026, 2, 1));

interface Person {
  staffNo: string;
  name: string;
  broker?: string;
  time?: string;
  rank?: string;
  codes: string[];
}

async function rosterXlsx(opts: { site: string; people: Person[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("202603");
  ws.getCell("A2").value = opts.site;
  ws.getCell("F4").value = "Date";
  const ndays = opts.people[0]!.codes.length;
  for (let d = 0; d < ndays; d++) ws.getRow(4).getCell(7 + d).value = new Date(Date.UTC(2026, 2, d + 1));
  for (const [c, v] of [["A5", "Broker"], ["B5", "Time"], ["C5", "Rank"], ["D5", "Staff No."], ["E5", "Tel"], ["F5", "Name"]] as const) ws.getCell(c).value = v;
  opts.people.forEach((p, i) => {
    const r = 6 + i;
    if (p.broker) ws.getCell(`A${r}`).value = p.broker;
    if (p.time) ws.getCell(`B${r}`).value = p.time;
    ws.getCell(`C${r}`).value = p.rank ?? "日更保安員";
    ws.getCell(`D${r}`).value = p.staffNo;
    ws.getCell(`F${r}`).value = p.name;
    p.codes.forEach((code, d) => {
      if (code) ws.getRow(r).getCell(7 + d).value = code;
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("HIST-3 歷史導入：更種自動建立", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await markHistoricalMonth(MAR, fx.userIds["老闆"], { ip: null });
  });

  async function upload(bytes: Buffer, name = "h3.xlsx"): Promise<void> {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], name));
    form.set("month", "2026-03");
    const res = await createUpload(new Request("http://test.local/api/roster-uploads", { method: "POST", headers: { cookie }, body: form }));
    expect(res.status).toBe(201);
  }
  async function runImport(): Promise<{ report: HistImportReport; status: string }> {
    const runId = await claimHistoricalImportRun(MAR, fx.userIds["老闆"]);
    await runHistoricalImport(runId, MAR, fx.userIds["老闆"], null);
    const run = await prisma.historicalImportRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.errorMessage).toBeNull();
    return { report: run.reportJson as unknown as HistImportReport, status: run.status };
  }

  it("項2：新盤時段欄唔係時間（SG／7.5hrs）→ 建冇開始時間更種（以代號為鍵），格全部落到；報告列出", async () => {
    await upload(
      await rosterXlsx({
        site: "測試新盤無時段",
        people: [
          { staffNo: "T-A01", name: "測試保安員甲", broker: "TEST-BA", time: "SG", codes: ["D", "D", "N"] },
          { staffNo: "T-B01", name: "測試保安員乙", broker: "TEST-BA", time: "7.5hrs", codes: ["N", "D", "D"] },
        ],
      }),
    );
    const { report, status } = await runImport();
    expect(status).toBe("done");
    const site = await prisma.site.findFirstOrThrow({ where: { canonicalName: "測試新盤無時段" } });
    const types = await prisma.shiftType.findMany({ where: { siteId: site.id, voidedAt: null }, orderBy: { code: "asc" } });
    expect(types.map((t) => t.code)).toEqual(["D", "N"]);
    expect(types.every((t) => t.startTime === null && t.endTime === null)).toBe(true);
    expect(report.created.noTimeShiftTypes.map((x) => x.code).sort()).toEqual(["D", "N"]);
    expect(report.created.noTimeShiftTypes[0]!.site).toBe("測試新盤無時段");
    expect(report.perSite[0]!.cells).toBe(6);
    expect(report.perSite[0]!.unresolved).toBe(0);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id } })).toBe(6);
  });

  it("項2 對照：非歷史 stepParseHealth 照舊唔建冇時間更種（出時段解析唔到警告）", async () => {
    await prisma.monthClose.updateMany({ data: { historical: false } });
    await upload(await rosterXlsx({ site: "測試新盤無時段", people: [{ staffNo: "T-A01", name: "測試保安員甲", broker: "TEST-BA", time: "SG", codes: ["D", "D", "D"] }] }));
    const r = await stepParseHealth(MAR, fx.userIds["老闆"]);
    expect(r.warnings.some((x) => x.includes("時段解析唔到"))).toBe(true);
    const site = await prisma.site.findFirstOrThrow({ where: { canonicalName: "測試新盤無時段" } });
    expect(await prisma.shiftType.count({ where: { siteId: site.id } })).toBe(0);
  });

  it("項3：現有盤出現新代號＋時段（M 1430-2330）→ 歷史模式自動建 M@14:30，格落到；非歷史不變", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "測試現有盤", clientName: "測試客戶X", billingModel: "per_shift", createdBy: "test" } });
    await prisma.shiftType.create({ data: { siteId: site.id, code: "N", startTime: new Date(Date.UTC(1970, 0, 1, 23, 0)), endTime: new Date(Date.UTC(1970, 0, 1, 7, 0)), hours: 8, billingGroup: "per_shift", createdBy: "test" } });
    await upload(
      await rosterXlsx({
        site: "測試現有盤",
        people: [
          { staffNo: "T-A01", name: "測試保安員甲", broker: "TEST-BA", time: "1430-2330", codes: ["M", "M", "M"] },
          { staffNo: "T-B01", name: "測試保安員乙", broker: "TEST-BA", time: "2300-0700", codes: ["N", "N", ""] },
        ],
      }),
    );
    const { report } = await runImport();
    const types = await prisma.shiftType.findMany({ where: { siteId: site.id, voidedAt: null }, orderBy: { code: "asc" } });
    expect(types.map((t) => t.code)).toEqual(["M", "N"]);
    const m = types.find((t) => t.code === "M")!;
    expect(m.startTime?.toISOString().slice(11, 16)).toBe("14:30");
    expect(m.endTime?.toISOString().slice(11, 16)).toBe("23:30");
    expect(report.created.shiftTypes).toBe(1);
    expect(report.perSite[0]!.unresolved).toBe(0);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id } })).toBe(5);
  });

  it("項3：現有盤同代號多個更種、時段唔夾（歧義）→ 歷史模式補建準確時段更種", async () => {
    const site = await prisma.site.create({ data: { canonicalName: "測試現有盤二", clientName: "測試客戶Y", billingModel: "per_shift", createdBy: "test" } });
    for (const [h, e] of [[7, 15], [14, 22]] as const) {
      await prisma.shiftType.create({ data: { siteId: site.id, code: "IC", startTime: new Date(Date.UTC(1970, 0, 1, h, 0)), endTime: new Date(Date.UTC(1970, 0, 1, e, 0)), hours: 8, billingGroup: "per_shift", createdBy: "test" } });
    }
    await upload(await rosterXlsx({ site: "測試現有盤二", people: [{ staffNo: "T-A01", name: "測試保安員甲", broker: "TEST-BA", time: "2230-0730", rank: "夜Zone IC", codes: ["IC", "IC", "IC"] }] }));
    const { report } = await runImport();
    const types = await prisma.shiftType.findMany({ where: { siteId: site.id, voidedAt: null } });
    expect(types).toHaveLength(3);
    expect(report.perSite[0]!.unresolved).toBe(0);
    expect(await prisma.shiftRecord.count({ where: { siteId: site.id } })).toBe(3);
  });

  it("項3 對照：非歷史 stepParseHealth 唔補現有盤更種", async () => {
    await prisma.monthClose.updateMany({ data: { historical: false } });
    const site = await prisma.site.create({ data: { canonicalName: "測試現有盤", clientName: "測試客戶X", billingModel: "per_shift", createdBy: "test" } });
    await prisma.shiftType.create({ data: { siteId: site.id, code: "N", startTime: new Date(Date.UTC(1970, 0, 1, 23, 0)), endTime: new Date(Date.UTC(1970, 0, 1, 7, 0)), hours: 8, billingGroup: "per_shift", createdBy: "test" } });
    await upload(await rosterXlsx({ site: "測試現有盤", people: [{ staffNo: "T-A01", name: "測試保安員甲", broker: "TEST-BA", time: "1430-2330", codes: ["M", "M", "M"] }] }));
    await stepParseHealth(MAR, fx.userIds["老闆"]);
    expect(await prisma.shiftType.count({ where: { siteId: site.id } })).toBe(1);
  });
});
