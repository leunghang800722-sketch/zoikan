// WP-LTPAY Phase 2：`POST /api/longterm/contracts/import` RBAC + 上載
// integration test（module「長工糧」——老闆／會計 200，主管／雞頭／
// 安員 403）。合成 fixture，跟 tests/wp-roster-upload.test.ts 一致風格。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as importContracts } from "@/app/api/longterm/contracts/import/route";

async function buildWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("在職名單");
  ws.getCell(2, 3).value = "Staff No.";
  ws.getCell(2, 5).value = "Name";
  ws.getCell(3, 3).value = "MG9201";
  ws.getCell(3, 5).value = "測試長工戊";
  ws.getCell(3, 18).value = new Date("2024-01-01");
  ws.getCell(3, 23).value = 15200;
  wb.addWorksheet("離職名單");
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function reqMultipart(url: string, cookie: string, buffer: Buffer, fileName = "maxwell.xlsx"): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buffer)], fileName));
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

describe("POST /api/longterm/contracts/import", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let supervisorCookie: string;
  let accountantCookie: string;
  let brokerCookie: string;
  let guardSelfCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);
    accountantCookie = await sessionCookieForUser(fx.userIds["會計"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    guardSelfCookie = await sessionCookieForUser(fx.userIds["安員"]);
  });

  it("主管／雞頭／安員 403（硬性拒——長工糧同安員銀行資料一致粒度）", async () => {
    const buf = await buildWorkbook();
    for (const cookie of [supervisorCookie, brokerCookie, guardSelfCookie]) {
      const res = await importContracts(reqMultipart("http://test.local/api/longterm/contracts/import", cookie, buf));
      expect(res.status).toBe(403);
    }
  });

  it("老闆上載成功：回 summary，unmatched 列出對唔到嘅行", async () => {
    const buf = await buildWorkbook();
    const res = await importContracts(reqMultipart("http://test.local/api/longterm/contracts/import", ownerCookie, buf));
    expect(res.status).toBe(200);
    const body = await res.json();
    // ok() 經 camelToSnakeDeep()，body key 一律 snake_case。
    expect(body.summary.total_rows).toBe(1);
    expect(body.summary.unmatched.length).toBe(1); // fixture 冇呢個 MG 號，對唔到
  });

  it("會計都可以上載（任務書：只老闆／會計可用）", async () => {
    const buf = await buildWorkbook();
    const res = await importContracts(reqMultipart("http://test.local/api/longterm/contracts/import", accountantCookie, buf));
    expect(res.status).toBe(200);
  });

  it("唔係 xlsx 檔案 → 400", async () => {
    const res = await importContracts(reqMultipart("http://test.local/api/longterm/contracts/import", ownerCookie, Buffer.from("not an xlsx")));
    expect(res.status).toBe(400);
  });

  it("Opus 5.5 驗收：CSV 路徑（active_csv／left_csv）老闆 200；上載 xlsx 做 CSV → 400", async () => {
    const header = Array.from({ length: 30 }, (_, i) => (i === 2 ? "Staff No." : i === 4 ? "Name" : "")).join(",");
    const row = Array.from({ length: 30 }, (_, i) => (i === 2 ? "MG9202" : i === 4 ? "測試長工己" : i === 17 ? "2024-01-01" : i === 22 ? "15200" : "")).join(",");
    const form = new FormData();
    form.set("active_csv", new File([`title\n${header}\n${row}`], "active.csv"));
    form.set("left_csv", new File([`title\n${header}\n`], "left.csv"));
    const res = await importContracts(new Request("http://test.local/api/longterm/contracts/import", { method: "POST", headers: { cookie: ownerCookie }, body: form }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.total_rows).toBe(1);

    const bad = new FormData();
    bad.set("active_csv", new File([new Uint8Array(await buildWorkbook())], "active.csv"));
    const res2 = await importContracts(new Request("http://test.local/api/longterm/contracts/import", { method: "POST", headers: { cookie: ownerCookie }, body: bad }));
    expect(res2.status).toBe(400);

    const form3 = new FormData();
    form3.set("active_csv", new File([`title\n${header}\n${row}`], "active.csv"));
    const res3 = await importContracts(new Request("http://test.local/api/longterm/contracts/import", { method: "POST", headers: { cookie: supervisorCookie }, body: form3 }));
    expect(res3.status).toBe(403);
  });
});
