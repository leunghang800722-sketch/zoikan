// WP-ROSTER-UPLOAD Phase A（§15.3）：上載 API integration test。
// 鐵則：合成 xlsx fixture 自己起（exceljs），名用「測試安員甲」、U 號
// `U9xxxx`、電話 `6xxxxxxx`（跟 tests/fixtures/wp2-fixture.ts 現有假
// 資料一致風格）。
//
// §1 權限：雞頭／安員 GET/POST 一律 403（硬性 deny，`更表上載` module）
// §2 POST 上載成功：解析、盤／更別／雞頭／安員配對、寫 roster_uploads
//    （status=parsed）+ roster_upload_rows，audit 一條
// §3 同盤同月重複上載：舊版 supersede，version 遞增
// §4 GET list（?month=）：逐盤狀態
// §5 GET detail：rows 分頁 + ?guard_match=unmatched 篩選
// §6 PATCH site_id：人手指定盤之後自動重新配對（更別對到）
// §7 POST reparse：唔使重新上載都可以重新配對
// §8 field-group gate：冇「安員個人資料:view」見唔到 name_raw/tel_raw/
//    staff_no_raw
// §9 解析失敗（壞檔）：status=parse_failed，parse_error 有原因
import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listUploads, POST as createUpload } from "@/app/api/roster-uploads/route";
import { GET as getUpload, PATCH as patchUpload } from "@/app/api/roster-uploads/[id]/route";
import { POST as reparseUpload } from "@/app/api/roster-uploads/[id]/reparse/route";

function aug(day: number): Date {
  return new Date(Date.UTC(2026, 7, day));
}

async function buildXlsx(opts: { siteName: string; brokerCode?: string; staffNo?: string; name?: string; tel?: string; shiftCode?: string; codes?: Array<[number, string]> }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = opts.siteName;
  ws.getCell("F4").value = "Date";
  ws.getCell("G4").value = aug(1);
  ws.getCell("H4").value = aug(2);
  ws.getCell("I4").value = aug(3);
  ws.getCell("A5").value = "Broker";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Staff No.";
  ws.getCell("E5").value = "Tel";
  ws.getCell("F5").value = "Name";
  ws.getCell("A6").value = opts.brokerCode ?? "TEST-BA";
  ws.getCell("B6").value = "0700-1900";
  ws.getCell("C6").value = "日更保安員";
  ws.getCell("D6").value = opts.staffNo ?? "T-A01";
  ws.getCell("E6").value = opts.tel ?? "6100001";
  ws.getCell("F6").value = opts.name ?? "測試安員甲";
  const codes = opts.codes ?? [[1, opts.shiftCode ?? "N"]];
  const colByDay: Record<number, string> = { 1: "G", 2: "H", 3: "I" };
  for (const [day, code] of codes) {
    ws.getCell(`${colByDay[day]}6`).value = code;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function reqJson(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

function reqMultipart(url: string, cookie: string, buffer: Buffer, month: string, siteId?: string, fileName = "test-roster.xlsx"): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buffer)], fileName));
  form.set("month", month);
  if (siteId) form.set("site_id", siteId);
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

describe("WP-ROSTER-UPLOAD Phase A：上載 API", () => {
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

  it("§1 雞頭/安員 GET+POST 一律 403（硬性 deny）", async () => {
    const listRes = await listUploads(reqJson("http://test.local/api/roster-uploads?month=2026-08", brokerCookie));
    expect(listRes.status).toBe(403);
    const listRes2 = await listUploads(reqJson("http://test.local/api/roster-uploads?month=2026-08", guardSelfCookie));
    expect(listRes2.status).toBe(403);

    const buf = await buildXlsx({ siteName: fx.site.name });
    const postRes = await createUpload(reqMultipart("http://test.local/api/roster-uploads", brokerCookie, buf, "2026-08"));
    expect(postRes.status).toBe(403);
  });

  it("§2 老闆上載成功：解析、盤/更別/雞頭/安員配對全部啱，audit 一條", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: Record<string, unknown>; parse_ok: boolean };
    expect(body.parse_ok).toBe(true);
    expect(body.upload.status).toBe("parsed");
    expect(body.upload.site_id).toBe(fx.site.id);
    expect(body.upload.version).toBe(1);
    expect(body.upload.file_bytes).toBeUndefined(); // DTO 一定唔准帶 bytes 出街

    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id as string } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.guardId).toBe(fx.guardA.id);
    expect(rows[0]!.guardMatch).toBe("by_staff_no");
    expect(rows[0]!.shiftTypeId).toBe(fx.shiftType.id);
    expect(rows[0]!.settlementBrokerId).toBe(fx.brokerA.id);
    expect(rows[0]!.codeKind).toBe("shift");

    const audit = await prisma.auditLog.findFirst({ where: { tableName: "roster_uploads", rowId: body.upload.id as string, action: "create" } });
    expect(audit).not.toBeNull();
    const after = audit!.after as Record<string, unknown>;
    expect(after.file_bytes).toBeUndefined();
  });

  it("§3 同盤同月重複上載（唔同檔名）：舊版 supersede，version 遞增", async () => {
    const buf1 = await buildXlsx({ siteName: fx.site.name });
    const res1 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf1, "2026-08", undefined, "roster-v1.xlsx"));
    const body1 = (await res1.json()) as { upload: { id: string } };

    const buf2 = await buildXlsx({ siteName: fx.site.name, codes: [[1, "N"], [2, "N"]] });
    // 驗收 2026-09-23（老闆追加答）：更新檔嘅檔名要同舊版唔同——呢度用
    // 「roster-v2.xlsx」（同 §14 嘅撞名 400 場景分開測）。
    const res2 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", accountantCookie, buf2, "2026-08", undefined, "roster-v2.xlsx"));
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as { upload: { id: string; version: number }; superseded_count: number };
    expect(body2.upload.version).toBe(2);
    expect(body2.superseded_count).toBe(1);

    const old = await prisma.rosterUpload.findUniqueOrThrow({ where: { id: body1.upload.id } });
    expect(old.status).toBe("superseded");
  });

  it("§4 GET list（?month=）：逐盤狀態", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name });
    await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08"));

    const res = await listUploads(reqJson("http://test.local/api/roster-uploads?month=2026-08", supervisorCookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sites: Array<Record<string, unknown>> };
    const entry = body.sites.find((s) => s.site_id === fx.site.id);
    expect(entry).toBeDefined();
    expect(entry!.upload_status).toBe("parsed");
    const unassignedEntry = body.sites.find((s) => s.site_id === fx.siteUnassigned.id);
    expect(unassignedEntry!.upload_status).toBe("not_uploaded");
  });

  it("§5 GET detail：rows 分頁 + ?guard_match=unmatched 篩選", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name, codes: [[1, "N"]] });
    // 第二行安員（配唔到）——用另一個 File 直接寫多一個未知安員格。
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = fx.site.name;
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = aug(1);
    ws.getCell("A5").value = "Broker";
    ws.getCell("B5").value = "Time";
    ws.getCell("C5").value = "Rank";
    ws.getCell("D5").value = "Staff No.";
    ws.getCell("E5").value = "Tel";
    ws.getCell("F5").value = "Name";
    ws.getCell("A6").value = "TEST-BA";
    ws.getCell("D6").value = "T-A01";
    ws.getCell("E6").value = "6100001";
    ws.getCell("F6").value = "測試安員甲";
    ws.getCell("G6").value = "N";
    ws.getCell("A7").value = "TEST-BA";
    ws.getCell("D7").value = "U99999";
    ws.getCell("E7").value = "69999999";
    ws.getCell("F7").value = "測試安員未知";
    ws.getCell("G7").value = "N";
    const twoRowBuf = Buffer.from(await wb.xlsx.writeBuffer());
    void buf;

    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, twoRowBuf, "2026-08"));
    const body = (await res.json()) as { upload: { id: string } };

    const detailRes = await getUpload(reqJson(`http://test.local/api/roster-uploads/${body.upload.id}`, ownerCookie), { params: Promise.resolve({ id: body.upload.id }) });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { rows: { total: number; rows: Array<Record<string, unknown>> } };
    expect(detail.rows.total).toBe(2);

    const unmatchedRes = await getUpload(
      reqJson(`http://test.local/api/roster-uploads/${body.upload.id}?guard_match=unmatched`, ownerCookie),
      { params: Promise.resolve({ id: body.upload.id }) },
    );
    const unmatchedBody = (await unmatchedRes.json()) as { rows: { total: number; rows: Array<Record<string, unknown>> } };
    expect(unmatchedBody.rows.total).toBe(1);
    expect(unmatchedBody.rows.rows[0]!.staff_no_raw).toBe("U99999");
  });

  it("§6 PATCH site_id：上載時盤名對唔到，人手指定之後自動重新配對", async () => {
    const buf = await buildXlsx({ siteName: "呢個盤名喺 sites 表搵唔到" });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08"));
    const body = (await res.json()) as { upload: { id: string; site_id: string | null } };
    expect(body.upload.site_id).toBeNull();

    const beforeRows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id } });
    expect(beforeRows[0]!.shiftTypeId).toBeNull(); // 冇盤，配唔到更別

    const patchRes = await patchUpload(reqJson(`http://test.local/api/roster-uploads/${body.upload.id}`, ownerCookie, "PATCH", { site_id: fx.site.id }), {
      params: Promise.resolve({ id: body.upload.id }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { site_id: string };
    expect(patched.site_id).toBe(fx.site.id);

    const afterRows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id } });
    expect(afterRows[0]!.shiftTypeId).toBe(fx.shiftType.id); // 重新配對之後對到
  });

  it("§7 POST reparse：唔使重新上載都可以重新配對", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08"));
    const body = (await res.json()) as { upload: { id: string } };

    const reparseRes = await reparseUpload(reqJson(`http://test.local/api/roster-uploads/${body.upload.id}/reparse`, ownerCookie, "POST"), {
      params: Promise.resolve({ id: body.upload.id }),
    });
    expect(reparseRes.status).toBe(200);
    const reparsed = (await reparseRes.json()) as { status: string };
    expect(reparsed.status).toBe("parsed");
  });

  it("§8 field-group gate：冇「安員個人資料:view」見唔到 name_raw/tel_raw/staff_no_raw", async () => {
    // 收窄「主管」出廠嘅「安員個人資料」view（本身出廠已經係 off，直接用返主管 session 就得）。
    const buf = await buildXlsx({ siteName: fx.site.name });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08"));
    const body = (await res.json()) as { upload: { id: string } };

    const detailRes = await getUpload(reqJson(`http://test.local/api/roster-uploads/${body.upload.id}`, supervisorCookie), {
      params: Promise.resolve({ id: body.upload.id }),
    });
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as { rows: { rows: Array<Record<string, unknown>> } };
    const row = detail.rows.rows[0]!;
    expect(row.name_raw).toBeUndefined();
    expect(row.tel_raw).toBeUndefined();
    expect(row.staff_no_raw).toBeUndefined();
    expect(row.raw_code).toBe("N"); // 唔屬於 PII 嘅欄唔受影響

    // 老闆出廠有「安員個人資料:view」，見到全部欄。
    const ownerDetailRes = await getUpload(reqJson(`http://test.local/api/roster-uploads/${body.upload.id}`, ownerCookie), {
      params: Promise.resolve({ id: body.upload.id }),
    });
    const ownerDetail = (await ownerDetailRes.json()) as { rows: { rows: Array<Record<string, unknown>> } };
    expect(ownerDetail.rows.rows[0]!.name_raw).toBe("測試安員甲");
  });

  it("§9 壞檔（完全冇 Date 表頭）→ status=parse_failed，parse_error 有原因", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("2026").getCell("A1").value = "冇 Date 表頭嘅壞檔";
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: { status: string }; parse_ok: boolean; parse_error: string | null };
    expect(body.parse_ok).toBe(false);
    expect(body.upload.status).toBe("parse_failed");
    expect(body.parse_error).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Opus 驗收（2026-09-23）補測：版本／並發／檔案格式／月份
  // -------------------------------------------------------------------------
  it("§10 重新解析已被取代嘅舊版：保持 superseded，唔會變兩個 active", async () => {
    const r1 = (await (await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, await buildXlsx({ siteName: fx.site.name }), "2026-08", undefined, "roster-v1.xlsx"))).json()) as { upload: { id: string } };
    await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, await buildXlsx({ siteName: fx.site.name }), "2026-08", undefined, "roster-v2.xlsx"));
    const res = await reparseUpload(reqJson(`http://test.local/api/roster-uploads/${r1.upload.id}/reparse`, ownerCookie, "POST"), { params: Promise.resolve({ id: r1.upload.id }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("superseded");
    expect(await prisma.rosterUpload.count({ where: { siteId: fx.site.id, status: { not: "superseded" } } })).toBe(1);
  });

  it("§11 PATCH 指定去一個呢個月已有上載嘅盤：較新嗰個保持 active、舊嗰個 superseded、version 遞增", async () => {
    await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, await buildXlsx({ siteName: fx.site.name }), "2026-08"));
    // B1-8 第 1 項：PATCH 轉去目標盤之後，檔名唔准同目標（盤,月）組別
    // 現有版本撞——呢度特登用唔同檔名（`roster-b.xlsx`），先淨係測版本
    // 序列邏輯，唔係測撞名 400（撞名 400 見下面新增嘅 §14）。
    const u = (await (
      await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, await buildXlsx({ siteName: "對唔到嘅盤名" }), "2026-08", undefined, "roster-b.xlsx"))
    ).json()) as { upload: { id: string } };
    const res = await patchUpload(reqJson(`http://test.local/api/roster-uploads/${u.upload.id}`, ownerCookie, "PATCH", { site_id: fx.site.id }), { params: Promise.resolve({ id: u.upload.id }) });
    expect(res.status).toBe(200);
    const all = await prisma.rosterUpload.findMany({ where: { siteId: fx.site.id }, orderBy: { version: "asc" } });
    expect(all.map((x) => [x.version, x.status])).toEqual([[1, "superseded"], [2, "parsed"]]);
    expect(all[1]!.id).toBe(u.upload.id);
  });

  it("§12 PATCH site_id=null 真係清返，唔會即刻又用盤名自動配返", async () => {
    const u = (await (await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, await buildXlsx({ siteName: fx.site.name }), "2026-08"))).json()) as { upload: { id: string; site_id: string } };
    expect(u.upload.site_id).toBe(fx.site.id);
    await patchUpload(reqJson(`http://test.local/api/roster-uploads/${u.upload.id}`, ownerCookie, "PATCH", { site_id: null }), { params: Promise.resolve({ id: u.upload.id }) });
    expect((await prisma.rosterUpload.findUniqueOrThrow({ where: { id: u.upload.id } })).siteId).toBeNull();
  });

  it("§13 同時上載三次（撳多幾下）：只得一個 active，version 1/2/3", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name });
    // 驗收 2026-09-23（老闆追加答）：更新檔嘅檔名唔准同舊版一樣——呢度用
    // 三個唔同檔名，先淨係測 advisory lock 嘅版本序列（唔係撞名 400）。
    const rs = await Promise.all([1, 2, 3].map((n) => createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, `roster-concurrent-${n}.xlsx`))));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
    const all = await prisma.rosterUpload.findMany({ where: { siteId: fx.site.id }, orderBy: { version: "asc" } });
    expect(all.map((x) => x.version)).toEqual([1, 2, 3]);
    expect(all.filter((x) => x.status !== "superseded")).toHaveLength(1);
  });

  it("§14 唔係 xlsx（隨便一個檔／舊版 .xls）→ 400，唔存底", async () => {
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, Buffer.from("not an xlsx file"), "2026-08"));
    expect(res.status).toBe(400);
    const xls = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), "2026-08"));
    expect(xls.status).toBe(400);
    expect(await prisma.rosterUpload.count()).toBe(0);
  });

  it("§15 揀錯月份（8 月更表上載做 9 月）：parse_summary 有 out_of_month 警告，逐行都有", async () => {
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, await buildXlsx({ siteName: fx.site.name }), "2026-09"));
    const body = (await res.json()) as { upload: { id: string; parse_summary: { out_of_month_count: number; warnings: string[] } } };
    expect(body.upload.parse_summary.out_of_month_count).toBe(1);
    expect(body.upload.parse_summary.warnings[0]).toContain("唔係上載月份");
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id } });
    expect(JSON.stringify(rows[0]!.warnings)).toContain("唔係上載月份");
  });

  it("§16 GET ?month= 亂寫 → 400", async () => {
    const res = await listUploads(reqJson("http://test.local/api/roster-uploads?month=hello%202026", ownerCookie));
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Phase B-0（2026-09-23）補測：第 2/3/4/5 項
  // -------------------------------------------------------------------------
  it("§17 同一檔（同 SHA-256）用唔同檔名重複上載：唔擋，response 帶 duplicate_of_version", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name });
    const res1 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, "roster-a.xlsx"));
    const body1 = (await res1.json()) as { upload: { version: number }; duplicate_of_version: number | null };
    expect(body1.duplicate_of_version).toBeNull();

    const res2 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, "roster-b.xlsx"));
    expect(res2.status).toBe(201);
    const body2 = (await res2.json()) as { upload: { version: number }; duplicate_of_version: number | null };
    expect(body2.upload.version).toBe(2);
    expect(body2.duplicate_of_version).toBe(1);
  });

  it("§18 更新檔嘅檔名同該盤同月任何現有版本（active 或 superseded）一樣 → 400，唔存底、唔開版本", async () => {
    const buf1 = await buildXlsx({ siteName: fx.site.name });
    await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf1, "2026-08", undefined, "roster-same.xlsx"));

    const buf2 = await buildXlsx({ siteName: fx.site.name, codes: [[1, "N"], [2, "N"]] });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf2, "2026-08", undefined, "roster-same.xlsx"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("更新檔嘅檔名必須同舊版唔同");
    expect(await prisma.rosterUpload.count({ where: { siteId: fx.site.id } })).toBe(1); // 撞名嗰次冇存底

    // 撞嘅係 superseded 版本嘅檔名一樣攔——起返 v2（另一個名），再試用返 v1 個名。
    await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf2, "2026-08", undefined, "roster-v2.xlsx"));
    const res2 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf2, "2026-08", undefined, "roster-same.xlsx"));
    expect(res2.status).toBe(400);
    expect(await prisma.rosterUpload.count({ where: { siteId: fx.site.id } })).toBe(2);
  });

  it("§19 一檔多子盤（城巴車廠式）：sub_site_name 對到子盤 → resolved_site_id=子盤，更別配對用子盤嘅 shift_types", async () => {
    // 鐵則：seed 唔准加真盤名以外嘅嘢——用測試自己合成嘅子盤（唔改
    // seed script），parent_site_id 掛返，同 Phase B-0 第 3 項規格一致。
    const parent = await prisma.site.create({ data: { canonicalName: "測試車廠母盤", clientName: "測試客戶", billingModel: "per_shift", createdBy: "test-wp-roster-upload" } });
    const child1 = await prisma.site.create({
      data: { canonicalName: "測試車廠子盤A", clientName: "測試客戶", billingModel: "per_shift", parentSiteId: parent.id, createdBy: "test-wp-roster-upload" },
    });
    await prisma.site.create({
      data: { canonicalName: "測試車廠子盤B", clientName: "測試客戶", billingModel: "per_shift", parentSiteId: parent.id, createdBy: "test-wp-roster-upload" },
    });
    const shiftTypeChild1 = await prisma.shiftType.create({ data: { siteId: child1.id, code: "D", createdBy: "test-wp-roster-upload" } });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = parent.canonicalName;
    ws.getCell("G4").value = "Date";
    ws.getCell("H4").value = aug(1);
    ws.getRow(5).values = ["Broker", "Time", "Rank", "Property Name", "Staff No.", "Tel", "Name"];
    ws.getRow(6).values = ["TEST-BA", "0700-1900", "Guard", child1.canonicalName, "T-A01", "6100001", "測試安員甲"];
    ws.getCell("H6").value = "D";
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", parent.id, "citybus-test.xlsx"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: { id: string } };
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subSiteName).toBe(child1.canonicalName);
    expect(rows[0]!.resolvedSiteId).toBe(child1.id);
    expect(rows[0]!.shiftTypeId).toBe(shiftTypeChild1.id); // 更別跟子盤嘅 shift_types 範圍搵，唔係母盤
    expect(rows[0]!.guardId).toBe(fx.guardA.id);
  });

  it("§19b 一檔多子盤：sub_site_name 對唔到任何子盤 → resolved_site_id=null，更別配對留空＋warning", async () => {
    const parent = await prisma.site.create({ data: { canonicalName: "測試車廠母盤2", clientName: "測試客戶", billingModel: "per_shift", createdBy: "test-wp-roster-upload" } });
    await prisma.site.create({
      data: { canonicalName: "測試車廠子盤C", clientName: "測試客戶", billingModel: "per_shift", parentSiteId: parent.id, createdBy: "test-wp-roster-upload" },
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = parent.canonicalName;
    ws.getCell("G4").value = "Date";
    ws.getCell("H4").value = aug(1);
    ws.getRow(5).values = ["Broker", "Time", "Rank", "Property Name", "Staff No.", "Tel", "Name"];
    ws.getRow(6).values = ["TEST-BA", "0700-1900", "Guard", "呢個子盤名對唔到", "T-A01", "6100001", "測試安員甲"];
    ws.getCell("H6").value = "D";
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", parent.id, "citybus-unmatched.xlsx"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: { id: string; parse_summary: { unmatched_sub_site_count: number } } };
    expect(body.upload.parse_summary.unmatched_sub_site_count).toBe(1);
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id } });
    expect(rows[0]!.resolvedSiteId).toBeNull();
    expect(rows[0]!.shiftTypeId).toBeNull();
    expect(JSON.stringify(rows[0]!.warnings)).toContain("對唔到呢個盤底下嘅子盤");
  });

  it("§20 檔案工號同系統唔一致，退用姓名/電話配到 → guard_match=by_name_tel＋warning「檔案工號 X 同系統工號 Y 唔一致」", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name, staffNo: "T-ZZZ99", name: fx.guardA.name, tel: "6100001" });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, "mismatch.xlsx"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: { id: string; parse_summary: { staff_no_mismatch_count: number } } };
    expect(body.upload.parse_summary.staff_no_mismatch_count).toBe(1);
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id } });
    expect(rows[0]!.guardId).toBe(fx.guardA.id);
    expect(rows[0]!.guardMatch).toBe("by_name_tel");
    expect(JSON.stringify(rows[0]!.warnings)).toContain("檔案工號 T-ZZZ99 同系統工號 T-A01 唔一致");
  });

  it("§21 靠已取消（former）舊工號配對到 → guard_match 仍然係 by_staff_no＋warning「用已取消舊號配對」", async () => {
    await prisma.guardStaffNumber.create({ data: { guardId: fx.guardA.id, scheme: "U", number: "U88888", status: "former", source: "test-wp-roster-upload" } });
    const buf = await buildXlsx({ siteName: fx.site.name, staffNo: "U88888" });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, "stale.xlsx"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: { id: string; parse_summary: { stale_staff_no_count: number } } };
    expect(body.upload.parse_summary.stale_staff_no_count).toBe(1);
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id } });
    expect(rows[0]!.guardId).toBe(fx.guardA.id);
    expect(rows[0]!.guardMatch).toBe("by_staff_no");
    expect(JSON.stringify(rows[0]!.warnings)).toContain("用已取消舊號配對");
  });

  it("§22 更種配對用 time_raw 收窄：時段啱就配到，唔啱任何候選就保留 ambiguous 並列出候選時段", async () => {
    const siteX = await prisma.site.create({ data: { canonicalName: "測試盤時段收窄", clientName: "測試客戶", billingModel: "per_shift", createdBy: "test-wp-roster-upload" } });
    const shiftDay1 = await prisma.shiftType.create({
      data: { siteId: siteX.id, code: "D", startTime: new Date(Date.UTC(1970, 0, 1, 7, 0, 0)), endTime: new Date(Date.UTC(1970, 0, 1, 19, 0, 0)), createdBy: "test-wp-roster-upload" },
    });
    await prisma.shiftType.create({
      data: { siteId: siteX.id, code: "D", startTime: new Date(Date.UTC(1970, 0, 1, 8, 0, 0)), endTime: new Date(Date.UTC(1970, 0, 1, 20, 0, 0)), createdBy: "test-wp-roster-upload" },
    });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = siteX.canonicalName;
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = aug(1);
    ws.getRow(5).values = ["Broker", "Time", "Rank", "Staff No.", "Tel", "Name"];
    ws.getRow(6).values = ["TEST-BA", "0700-1900", "Guard", "T-A01", "6100001", "測試安員甲"];
    ws.getCell("G6").value = "D";
    ws.getRow(7).values = ["TEST-BA", "0900-2100", "Guard", "T-ZZZZ", "69999999", "測試安員未知"];
    ws.getCell("G7").value = "D";
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", siteX.id, "timerange.xlsx"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: { id: string } };
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id }, orderBy: { rowIndex: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.timeRaw).toBe("0700-1900");
    expect(rows[0]!.shiftTypeId).toBe(shiftDay1.id); // 0700-1900 岩第一個候選
    expect(rows[1]!.timeRaw).toBe("0900-2100");
    expect(rows[1]!.shiftTypeId).toBeNull(); // 兩個候選時段都唔啱，保留 null
    expect(JSON.stringify(rows[1]!.warnings)).toContain("更別配對到多過一個候選（時段：");
  });

  // ── 驗收 2026-09-23 補測 ──
  it("§23 工號唔一致 warning：?warning_flag 篩選得到；冇「安員個人資料:view」（主管出廠）嘅 warning 工號要遮", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name, staffNo: "T-ZZZ99", name: fx.guardA.name, tel: "6100001", codes: [[1, "N"], [2, "N"]] });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, "mismatch-flag.xlsx"));
    const body = (await res.json()) as { upload: { id: string } };
    const id = body.upload.id;
    const get = (cookie: string, qs: string) =>
      getUpload(reqJson(`http://test.local/api/roster-uploads/${id}${qs}`, cookie), { params: Promise.resolve({ id }) });

    const ownerRes = await get(ownerCookie, "?warning_flag=staff_no_mismatch");
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as { rows: { total: number; rows: Array<{ warnings: string[] }> } };
    expect(ownerBody.rows.total).toBe(2);
    expect(ownerBody.rows.rows[0]!.warnings.join("|")).toContain("檔案工號 T-ZZZ99 同系統工號 T-A01 唔一致");

    const staleRes = await get(ownerCookie, "?warning_flag=stale_staff_no");
    expect(((await staleRes.json()) as { rows: { total: number } }).rows.total).toBe(0);
    expect((await get(ownerCookie, "?warning_flag=bogus")).status).toBe(400);

    const supRes = await get(supervisorCookie, "?warning_flag=staff_no_mismatch");
    const supBody = (await supRes.json()) as { rows: { total: number; rows: Array<Record<string, unknown> & { warnings: string[] }> } };
    expect(supBody.rows.total).toBe(2);
    const supText = JSON.stringify(supBody.rows.rows);
    expect(supText).not.toContain("T-ZZZ99");
    expect(supText).not.toContain("T-A01");
    expect(supBody.rows.rows[0]!.warnings.join("|")).toContain("檔案工號（已隱藏）同系統工號（已隱藏）唔一致");
    expect(supBody.rows.rows[0]!.staff_no_raw).toBeUndefined();

    // warning 文字（含工號）唔會入 audit_log。
    const audits = await prisma.auditLog.findMany({ where: { rowId: id } });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain("T-ZZZ99");
  });

  it("§24 檔名規則：同盤同月大小寫／前後空白唔同都當同名 → 400；唔同盤同檔名照收", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name });
    const r1 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, "Roster-Case.xlsx"));
    expect(r1.status).toBe(201);
    const r2 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, "  roster-case.XLSX "));
    expect(r2.status).toBe(400);

    const otherSite = await prisma.site.create({ data: { canonicalName: "測試盤另一個", clientName: "測試客戶", billingModel: "per_shift", createdBy: "test-wp-roster-upload" } });
    const bufOther = await buildXlsx({ siteName: otherSite.canonicalName });
    const r3 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, bufOther, "2026-08", undefined, "Roster-Case.xlsx"));
    expect(r3.status).toBe(201);
    const b3 = (await r3.json()) as { upload: { version: number; site_id: string } };
    expect(b3.upload.site_id).toBe(otherSite.id);
    expect(b3.upload.version).toBe(1);

    // 同盤唔同月同檔名亦照收。
    const r4 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-09", undefined, "Roster-Case.xlsx"));
    expect(r4.status).toBe(201);
  });

  it("§25 同 SHA-256 撞嘅係 superseded 舊版（v1→v2→改名再上載 v1 個檔）都出提示", async () => {
    const buf1 = await buildXlsx({ siteName: fx.site.name });
    const buf2 = await buildXlsx({ siteName: fx.site.name, codes: [[1, "N"], [2, "N"]] });
    await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf1, "2026-08", undefined, "sha-v1.xlsx"));
    await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf2, "2026-08", undefined, "sha-v2.xlsx"));
    const r3 = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf1, "2026-08", undefined, "sha-v3.xlsx"));
    expect(r3.status).toBe(201);
    const b3 = (await r3.json()) as { upload: { version: number }; duplicate_of_version: number | null };
    expect(b3.upload.version).toBe(3);
    expect(b3.duplicate_of_version).toBe(1);
  });

  it("§26 冇子盤嘅盤：resolved_site_id＝上載盤（Phase B-1 對數用呢個欄）", async () => {
    const buf = await buildXlsx({ siteName: fx.site.name });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, "no-child.xlsx"));
    const body = (await res.json()) as { upload: { id: string } };
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.resolvedSiteId).toBe(fx.site.id);
  });

  it("§27 B1-8 第 1 項：PATCH 指定去一個目標（盤,月）組別已有同名檔嘅盤→400，唔准撞名", async () => {
    await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, await buildXlsx({ siteName: fx.site.name }), "2026-08", undefined, "same-name.xlsx"));
    const u = (await (
      await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, await buildXlsx({ siteName: "對唔到嘅盤名2" }), "2026-08", undefined, "same-name.xlsx"))
    ).json()) as { upload: { id: string } };
    const res = await patchUpload(reqJson(`http://test.local/api/roster-uploads/${u.upload.id}`, ownerCookie, "PATCH", { site_id: fx.site.id }), { params: Promise.resolve({ id: u.upload.id }) });
    expect(res.status).toBe(400);
    // 拒絕之後 site_id 應該維持未變（PATCH 冇部分生效）。
    expect((await prisma.rosterUpload.findUniqueOrThrow({ where: { id: u.upload.id } })).siteId).toBeNull();
  });

  it("§28 B1-8 第 2 項：有子盤嘅上載，某行冇 sub_site_name→warning「未寫子盤，歸母盤」（唔擋）", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = fx.site.name;
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
    ws.getCell("D6").value = "T-A01";
    ws.getCell("E6").value = "6100001";
    ws.getCell("F6").value = "測試安員甲";
    ws.getCell("G6").value = "N"; // 冇填 sub_site 欄（呢個 fixture 冇 subSite column，所以任何有子盤嘅盤都會觸發呢個 warning）
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    // fx.site 加一個子盤（parent_site_id 指返 fx.site）。
    const child = await prisma.site.create({
      data: { canonicalName: "測試子盤A", clientName: fx.site.name, billingModel: "per_shift", parentSiteId: fx.site.id, createdBy: fx.userIds["老闆"]! },
    });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", fx.site.id, "with-child-site.xlsx"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: { id: string } };
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id, codeKind: "shift" } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect((r.warnings as string[] | null)?.some((w) => w.includes("未寫子盤，歸母盤"))).toBe(true);
      expect(r.resolvedSiteId).toBe(fx.site.id); // 唔擋——歸母盤
    }
    await prisma.site.delete({ where: { id: child.id } });
  });

  it("§29 B1-8 第 3 項：檔案工號命中真實安員，但姓名對唔上→唔准配（ambiguous），warning「屬另一人」", async () => {
    // fx.guardA 真實 staff_no="T-A01"、name_zh="測試安員甲"——呢度故意
    // 帶正確工號但錯嘅姓名（似係打錯咗第二個人個工號），「唔准配」。
    const buf = await buildXlsx({ siteName: fx.site.name, staffNo: "T-A01", name: "測試安員己（唔存在）" });
    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08", undefined, "staffno-belongs-to-other.xlsx"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: { id: string } };
    const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId: body.upload.id } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.guardId).toBeNull();
      expect(r.guardMatch).toBe("ambiguous");
      expect((r.warnings as string[] | null)?.some((w) => w.includes("屬另一人"))).toBe(true);
    }
  });
});
