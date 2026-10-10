// WP-UPLOAD-AUTOFIX 個案 1（P2-版面重設計計劃.md §17.11）：更表上載完全
// 自動——integration test（真係經 POST /api/roster-uploads 上載合成
// xlsx），驗證：
//   §1 檔名鍵優先於檔內盤名：合成「CTB 6907」式場景——xlsx 內文盤名寫
//      同母盤一樣，但檔名含目標盤嘅 `roster_file_keys` → 上載去目標盤，
//      唔會同母盤主檔撞版（母盤自己嘅上載唔會被 supersede）。
//   §2 母盤無子盤安全網：xlsx 內文盤名冧中一個有子盤嘅母盤，但呢個檔
//      案本身冇子盤欄位資料（standard layout，subSiteNames 一定係
//      空）→ site_id=null，列入 GET 嘅 unresolved_uploads，唔自動掛
//      母盤（防止撞版）。
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listUploads, POST as createUpload } from "@/app/api/roster-uploads/route";

function aug(day: number): Date {
  return new Date(Date.UTC(2026, 7, day));
}

// 同 tests/wp-roster-upload.test.ts 嘅 buildXlsx 一致風格（standard
// layout：A-E 識別欄、F=Name、G 開始日期欄，冇 subSite 欄）。
async function buildStandardXlsx(opts: { siteName: string; staffNo?: string; name?: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = opts.siteName;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = aug(1);
  ws.getCell("A5").value = "Broker";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Staff No.";
  ws.getCell("E5").value = "Tel";
  ws.getCell("F5").value = "Name";
  ws.getCell("A6").value = "TEST-BA";
  ws.getCell("B6").value = "0700-1900";
  ws.getCell("C6").value = "日更保安員";
  ws.getCell("D6").value = opts.staffNo ?? "T-A01";
  ws.getCell("E6").value = "6100001";
  ws.getCell("F6").value = opts.name ?? "測試保安員甲";
  ws.getCell("G6").value = "D";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// citybus layout（同 §15.3「一檔多子盤」現實格式一致）：A-F 識別欄含
// sub_site，G=Name，日期欄由 H 開始。用嚟合成「母盤自己嘅真上載」（真正
// 多子盤檔一定有 sub_site 欄值，同「CTB 6907」呢類冇子盤資料嘅檔唔同）。
async function buildCitybusXlsx(opts: { siteName: string; subSiteName: string; staffNo?: string; name?: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = opts.siteName;
  ws.getCell("G4").value = "Date";
  ws.getCell("H4").value = aug(1);
  // "Property Name" 係 citybus layout 嘅 marker（`layout.ts`
  // `CITYBUS_MARKER`）——headerRow 入面搵到就會用 citybus 嘅 6 欄 offset
  // （含 sub_site），唔係靠 "Broker"／"Time" 呢啲字面（純粹 positional）。
  ws.getCell("A5").value = "Property Name";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Sub Site";
  ws.getCell("E5").value = "Staff No.";
  ws.getCell("F5").value = "Tel";
  ws.getCell("G5").value = "Name";
  ws.getCell("A6").value = "TEST-BA";
  ws.getCell("B6").value = "0700-1900";
  ws.getCell("C6").value = "日更保安員";
  ws.getCell("D6").value = opts.subSiteName;
  ws.getCell("E6").value = opts.staffNo ?? "T-B01";
  ws.getCell("F6").value = "6100002";
  ws.getCell("G6").value = opts.name ?? "測試保安員乙";
  ws.getCell("H6").value = "D";
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function reqJson(url: string, cookie: string) {
  return new Request(url, { method: "GET", headers: { "content-type": "application/json", cookie } });
}

function reqMultipart(url: string, cookie: string, buffer: Buffer, month: string, fileName: string): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buffer)], fileName));
  form.set("month", month);
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

describe("WP-UPLOAD-AUTOFIX 個案 1：更表檔名鍵自動配盤", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let parentSiteId: string;
  let keyedSiteId: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);

    const parent = await prisma.site.create({
      data: { canonicalName: "測試母盤WP-UPLOAD-AUTOFIX", clientName: "測試客戶", billingModel: "per_shift", createdBy: "test:wp-upload-autofix" },
    });
    parentSiteId = parent.id;
    // 安全網淨係「多過一個子盤」（>1）先觸發（見 match.ts
    // `resolveRosterUploadSite()` 註解——dev DB 實測「HKU座頭」得一個子盤
    // 唔屬於呢種情況），呢度起兩個子盤先合資格做「一檔多子盤」母盤。
    await prisma.site.create({
      data: { canonicalName: "測試母盤WP-UPLOAD-AUTOFIX-子盤A", clientName: "測試客戶", billingModel: "per_shift", parentSiteId: parent.id, createdBy: "test:wp-upload-autofix" },
    });
    await prisma.site.create({
      data: { canonicalName: "測試母盤WP-UPLOAD-AUTOFIX-子盤B", clientName: "測試客戶", billingModel: "per_shift", parentSiteId: parent.id, createdBy: "test:wp-upload-autofix" },
    });
    const keyed = await prisma.site.create({
      data: {
        canonicalName: "測試鍵盤WP-UPLOAD-AUTOFIX",
        clientName: "測試客戶",
        billingModel: "admin_fee",
        rosterFileKeys: ["TESTKEY001"],
        createdBy: "test:wp-upload-autofix",
      },
    });
    keyedSiteId = keyed.id;
    await prisma.shiftType.create({ data: { siteId: keyedSiteId, code: "D", label: "測試日更", hours: 12, createdBy: "test:wp-upload-autofix" } });
    await prisma.shiftType.create({ data: { siteId: parentSiteId, code: "D", label: "測試日更", hours: 12, createdBy: "test:wp-upload-autofix" } });
  });

  it("§1 檔名鍵優先於檔內盤名——CTB 6907 式場景：內文盤名寫母盤，檔名鍵配去目標盤，唔撞母盤主檔", async () => {
    // 母盤自己先上載一份（真正嘅母盤主檔——citybus layout，真係有 sub_site 欄值）。
    const parentBuf = await buildCitybusXlsx({ siteName: "測試母盤WP-UPLOAD-AUTOFIX", subSiteName: "測試母盤WP-UPLOAD-AUTOFIX-子盤A", staffNo: "T-B01", name: "測試保安員乙" });
    const parentRes = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, parentBuf, "2026-08", "Roster - 測試母盤WP-UPLOAD-AUTOFIX - Aug 2026.xlsx"));
    expect(parentRes.status).toBe(201);
    const parentBody = (await parentRes.json()) as { upload: { id: string; site_id: string } };
    expect(parentBody.upload.site_id).toBe(parentSiteId);

    // 「CTB 6907」式檔：內文盤名一樣寫「測試母盤WP-UPLOAD-AUTOFIX」，但
    // 檔名含目標盤嘅 roster_file_keys「TESTKEY001」。
    const keyedBuf = await buildStandardXlsx({ siteName: "測試母盤WP-UPLOAD-AUTOFIX", staffNo: "T-A01", name: "測試保安員甲" });
    const keyedRes = await createUpload(
      reqMultipart("http://test.local/api/roster-uploads", ownerCookie, keyedBuf, "2026-08", "Roster - TESTKEY001 測試保安員甲 Aug 2026.xlsx"),
    );
    expect(keyedRes.status).toBe(201);
    const keyedBody = (await keyedRes.json()) as { upload: { id: string; site_id: string } };
    expect(keyedBody.upload.site_id).toBe(keyedSiteId); // 唔係 parentSiteId

    // 母盤自己嗰份上載冇被 supersede（0 撞盤）。
    const parentAfter = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: parentBody.upload.id } });
    expect(parentAfter.status).not.toBe("superseded");

    // rows 逐行有「由檔名鍵…對盤」warning。
    const keyedRows = await prisma.rosterUploadRow.findMany({ where: { uploadId: keyedBody.upload.id } });
    expect(keyedRows.length).toBeGreaterThan(0);
    for (const r of keyedRows) {
      expect((r.warnings as string[] | null)?.some((w) => w.includes("由檔名鍵") && w.includes("TESTKEY001"))).toBe(true);
    }
  });

  it("§2 母盤無子盤安全網：內文盤名冧中有子盤嘅母盤，但呢個檔案冇子盤欄位資料 → 唔自動掛母盤", async () => {
    const buf = await buildStandardXlsx({ siteName: "測試母盤WP-UPLOAD-AUTOFIX" });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", "Roster - 未知檔案.xlsx"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: { id: string; site_id: string | null } };
    expect(body.upload.site_id).toBeNull();

    const upload = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: body.upload.id } });
    const summary = upload.parseSummary as { warnings: string[] } | null;
    expect(summary?.warnings.some((w) => w.includes("母盤") && w.includes("冇子盤資料"))).toBe(true);

    // GET ?month= 列入 unresolved_uploads。
    const listRes = await listUploads(reqJson("http://test.local/api/roster-uploads?month=2026-08", ownerCookie));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { unresolved_uploads: Array<{ upload: { id: string } }> };
    expect(listBody.unresolved_uploads.some((u) => u.upload.id === body.upload.id)).toBe(true);
  });
});
