// WP-POSTORDER-PAIRS-CSV（老闆 2026-09-27 緊急）：`POST /api/guard-fix/
// postorder` 第三條路徑（`longterm_pairs_csv` ＋可選 `postorder_csv`）
// integration test——同 `tests/wp-postorder-csv-upload-route.test.ts`
// 一致風格。
//
// 鐵則：合成 fixture 用假人名。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as listPostorder, POST as uploadPostorder } from "@/app/api/guard-fix/postorder/route";

function reqJson(url: string, cookie: string, method = "GET"): Request {
  return new Request(url, { method, headers: { cookie } });
}

function reqMultipartPairsCsv(url: string, cookie: string, pairsCsv: string | null, postorderCsv: string | null, month: string): Request {
  const form = new FormData();
  if (pairsCsv !== null) form.set("longterm_pairs_csv", new File([pairsCsv], "longterm-pairs.csv", { type: "text/csv" }));
  if (postorderCsv !== null) form.set("postorder_csv", new File([postorderCsv], "PostOrder.csv", { type: "text/csv" }));
  form.set("month", month);
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

const VALID_PAIRS_CSV = ["site_label,site_short,guard_name,cell_count", "測試盤 甲蟲蟲,測試,甲蟲蟲,10", "另一盤 乙屎蟲,另一,乙屎蟲,5"].join("\r\n") + "\r\n";

interface PostorderUploadDTO {
  id: string;
  parse_summary: {
    longterm_site_count: number;
    longterm_post_pair_count: number;
    longterm_cell_count: number;
    referral_row_count: number;
    missing_sheets: string[];
    parse_error: string | null;
  } | null;
}

describe("WP-POSTORDER-PAIRS-CSV：POST /api/guard-fix/postorder longterm_pairs_csv 路徑", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerCookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerCookie = await sessionCookieForUser(fx.userIds["雞頭"]);
  });

  it("老闆上載 longterm_pairs_csv（冇 postorder_csv）→ 200，長工格／組合數啱，missing_sheets 記低 PostOrder", async () => {
    const res = await uploadPostorder(reqMultipartPairsCsv("http://test.local/api/guard-fix/postorder", ownerCookie, VALID_PAIRS_CSV, null, "2026-08-01"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: PostorderUploadDTO; parse_ok: boolean };
    expect(body.parse_ok).toBe(true);
    expect(body.upload.parse_summary?.longterm_post_pair_count).toBe(2);
    expect(body.upload.parse_summary?.longterm_cell_count).toBe(15);
    expect(body.upload.parse_summary?.referral_row_count).toBe(0);
    expect(body.upload.parse_summary?.missing_sheets).toEqual(["PostOrder"]);

    const row = await prisma.postorderUpload.findUnique({ where: { id: body.upload.id } });
    expect(row?.longtermPairsCsvBytes).toBeTruthy();
    expect(row?.postorderCsvBytes).toBeNull();
    expect(row?.fileBytes.length).toBeGreaterThan(0);

    const getRes = await listPostorder(reqJson("http://test.local/api/guard-fix/postorder?month=2026-08-01", ownerCookie));
    const getBody = (await getRes.json()) as { current: PostorderUploadDTO | null };
    expect(getBody.current?.id).toBe(body.upload.id);
  });

  it("老闆上載 longterm_pairs_csv＋postorder_csv → 200，PostOrder 唔會記喺 missing_sheets", async () => {
    const postorderCsv = "客戶名稱,Customer Code,物業名稱\r\n";
    const res = await uploadPostorder(reqMultipartPairsCsv("http://test.local/api/guard-fix/postorder", ownerCookie, VALID_PAIRS_CSV, postorderCsv, "2026-08-01"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: PostorderUploadDTO };
    expect(body.upload.parse_summary?.missing_sheets).toEqual([]);

    const row = await prisma.postorderUpload.findUnique({ where: { id: body.upload.id } });
    expect(row?.longtermPairsCsvBytes).toBeTruthy();
    expect(row?.postorderCsvBytes).toBeTruthy();
  });

  it("雞頭上載 → 403（保安員配對修復淨係老闆）", async () => {
    const res = await uploadPostorder(reqMultipartPairsCsv("http://test.local/api/guard-fix/postorder", brokerCookie, VALID_PAIRS_CSV, null, "2026-08-01"));
    expect(res.status).toBe(403);
  });

  it("longterm_pairs_csv 表頭錯 → 201 但 parse_ok:false，status=parse_failed", async () => {
    const res = await uploadPostorder(reqMultipartPairsCsv("http://test.local/api/guard-fix/postorder", ownerCookie, "唔啱嘅表頭\n1,2,3\n", null, "2026-08-01"));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { upload: PostorderUploadDTO & { status: string }; parse_ok: boolean };
    expect(body.parse_ok).toBe(false);
    expect(body.upload.status).toBe("parse_failed");
  });

  it("三個路徑都冇帶（冇 file／roster_csv+postorder_csv／longterm_pairs_csv）→ 400", async () => {
    const form = new FormData();
    form.set("month", "2026-08-01");
    const res = await uploadPostorder(new Request("http://test.local/api/guard-fix/postorder", { method: "POST", headers: { cookie: ownerCookie }, body: form }));
    expect(res.status).toBe(400);
  });
});
