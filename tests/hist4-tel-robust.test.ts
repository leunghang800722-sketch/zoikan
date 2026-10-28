// HIST-4：電話隱形字元正規化、單欄無效唔令整輪 apply 失敗、錯誤訊息零 PII。全部合成資料（fakeTel、T- 工號）。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { fakeTel } from "./helpers/fake-tel";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createUpload } from "@/app/api/roster-uploads/route";
import { markHistoricalMonth } from "@/lib/month-close/historical";
import { runHistoricalImport, claimHistoricalImportRun } from "@/lib/month-close/historical-import";
import { normalizeTel, isValidTel, createGuardPhone } from "@/lib/guards/contacts";
import { normalizeTelHk } from "@/lib/guards/identity";
import { safeErrorSummary } from "@/lib/api/http";
import { upsertCurrentStaffNumber } from "@/lib/guards/staff-numbers";

const MAR = new Date(Date.UTC(2026, 2, 1));

describe("HIST-4 項1：normalizeTel／normalizeTelHk 剝隱形字元", () => {
  const t = fakeTel();
  const cases: Array<[string, string]> = [
    ["U+202C 尾", `${t}‬`],
    ["U+202A 頭＋U+202C 尾", `‪${t}‬`],
    ["U+200B 零寬空格", `${t.slice(0, 4)}​${t.slice(4)}`],
    ["U+FEFF BOM", `﻿${t}`],
    ["NBSP", `${t.slice(0, 4)} ${t.slice(4)}`],
    ["U+2060 word joiner", `${t}⁠`],
    ["全形數字 NFKC", t.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)))],
    ["全形連字符＋空格", `${t.slice(0, 4)}－${t.slice(4)} `],
  ];
  for (const [label, raw] of cases) {
    it(`normalizeTel：${label}`, () => {
      expect(normalizeTel(raw)).toBe(t);
      expect(isValidTel(normalizeTel(raw))).toBe(true);
    });
    it(`normalizeTelHk：${label}`, () => {
      expect(normalizeTelHk(raw)).toBe(t);
    });
  }
  it("真正無效仍然無效", () => {
    expect(isValidTel(normalizeTel("12345‬"))).toBe(false);
    expect(isValidTel(normalizeTel("abc"))).toBe(false);
  });
});

describe("HIST-4 項3：錯誤訊息零原值", () => {
  beforeEach(async () => {
    await clearAll();
  });
  it("createGuardPhone 無效電話 → 訊息唔含電話原值", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試保安員", employmentType: "cash_casual", createdBy: "test" } });
    const bad = "9001‬23x4567";
    let msg = "";
    try {
      await prisma.$transaction((tx) => createGuardPhone(tx, { guardId: g.id, tel: bad }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("電話格式唔啱");
    expect(msg).not.toContain("9001");
    expect(msg).not.toContain("4567");
  });
  it("staff-numbers 格式錯誤訊息唔含工號原值", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試保安員", employmentType: "cash_casual", createdBy: "test" } });
    for (const input of [
      { scheme: "u1", number: "9876543210" },
      { scheme: "U", number: "X9876543210" },
      { scheme: "U", number: "U98765432109876543210" },
    ]) {
      let msg = "";
      try {
        await prisma.$transaction((tx) => upsertCurrentStaffNumber(tx, { guardId: g.id, scheme: input.scheme, number: input.number, source: "test", createdBy: "test" }));
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toBe("");
      expect(msg).not.toContain("9876543210");
    }
  });
  it("safeErrorSummary 遮罩 7 位以上連續數字", () => {
    const s = safeErrorSummary(new Error("boom 90019999 end"));
    expect(s).not.toContain("90019999");
    expect(s).toContain("***");
  });
});

describe("HIST-4 項2／4：歷史導入——單一電話無效唔令整輪失敗", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    await markHistoricalMonth(MAR, fx.userIds["老闆"], { ip: null });
  });

  async function rosterXlsx(people: Array<{ staffNo: string; name: string; tel: string; codes: string[] }>): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("202603");
    ws.getCell("A2").value = "測試電話盤";
    ws.getCell("F4").value = "Date";
    for (let d = 0; d < 3; d++) ws.getRow(4).getCell(7 + d).value = new Date(Date.UTC(2026, 2, d + 1));
    for (const [c, v] of [["A5", "Broker"], ["B5", "Time"], ["C5", "Rank"], ["D5", "Staff No."], ["E5", "Tel"], ["F5", "Name"]] as const) ws.getCell(c).value = v;
    people.forEach((p, i) => {
      const r = 6 + i;
      ws.getCell(`A${r}`).value = "TEST-BA";
      ws.getCell(`B${r}`).value = "0700-1500";
      ws.getCell(`C${r}`).value = "日更保安員";
      ws.getCell(`D${r}`).value = p.staffNo;
      ws.getCell(`E${r}`).value = p.tel;
      ws.getCell(`F${r}`).value = p.name;
      p.codes.forEach((code, d) => (ws.getRow(r).getCell(7 + d).value = code));
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  async function upload(bytes: Buffer): Promise<void> {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], "h4.xlsx"));
    form.set("month", "2026-03");
    const res = await createUpload(new Request("http://test.local/api/roster-uploads", { method: "POST", headers: { cookie }, body: form }));
    expect(res.status).toBe(201);
  }

  it("帶 U+202C 嘅電話 → 正規化後寫入；完全無效嘅電話 → 留空、照建人、run done、訊息零電話", async () => {
    const sl = new ExcelJS.Workbook();
    const sws = sl.addWorksheet("sheet1");
    sws.getRow(1).getCell(14).value = "員工編號";
    sws.getRow(2).getCell(14).value = "U99001";
    sws.getRow(2).getCell(16).value = "測試名單人";
    sws.getRow(2).getCell(10).value = fakeTel();
    await prisma.staffListUpload.create({ data: { uploaderId: fx.userIds["老闆"], fileName: "u.xlsx", fileSha256: "u", fileBytes: new Uint8Array(Buffer.from(await sl.xlsx.writeBuffer())), fileSize: 10, rowCount: 1, status: "parsed" } });
    const good = fakeTel();
    const bad = "12‬34";
    await upload(
      await rosterXlsx([
        { staffNo: "T-A01", name: "測試電話員丙", tel: `${good}‬`, codes: ["D", "D", "D"] },
        { staffNo: "T-B01", name: "測試電話員丁", tel: bad, codes: ["D", "D", "D"] },
      ]),
    );
    const runId = await claimHistoricalImportRun(MAR, fx.userIds["老闆"]);
    await runHistoricalImport(runId, MAR, fx.userIds["老闆"], null);
    const run = await prisma.historicalImportRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.errorMessage).toBeNull();
    expect(run.status).toBe("done");
    const a = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試電話員丙" } });
    const b = await prisma.guard.findFirstOrThrow({ where: { nameZh: "測試電話員丁" } });
    expect(a.tel).toBe(good);
    expect(b.tel).toBeNull();
    expect(await prisma.guardPhone.count({ where: { guardId: b.id } })).toBe(0);
    const dump = JSON.stringify(run.stepsJson) + JSON.stringify(run.reportJson ?? {});
    expect(dump).not.toContain(good);
    expect(dump).not.toContain("1234");
    expect(dump).toContain("電話格式唔啱，已留空");
  });

  it("項4：failed run 唔擋新 run 認領", async () => {
    const first = await claimHistoricalImportRun(MAR, fx.userIds["老闆"]);
    await prisma.historicalImportRun.update({ where: { id: first }, data: { status: "failed", finishedAt: new Date(), errorMessage: "x" } });
    const second = await claimHistoricalImportRun(MAR, fx.userIds["老闆"]);
    expect(second).not.toBe(first);
  });
});
