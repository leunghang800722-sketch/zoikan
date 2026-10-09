// 記憶體保險（正式站 2026-10-08 實證：4.1MB .xlsm 成本載入 exceljs → Node heap OOM → 全站 502）：
// 大過 1.5MB 嘅 xlsm／xlsx 一律 400（改上載 CSV），喺 exceljs 載入之前擋；CSV 路徑不變。
import { describe, it, expect, beforeEach, vi } from "vitest";
import ExcelJS from "exceljs";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as uploadPostorder } from "@/app/api/guard-fix/postorder/route";
import { MAX_WORKBOOK_BYTES, loadPostorderWorkbook, parsePostorderUploadRow, parsePostorderWorkbookBuffer } from "@/lib/guard-fix/postorder";
import { seedPostorder } from "./lib/one-click-auto";

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
function bigZip(bytes: number): Buffer {
  return Buffer.concat([ZIP, Buffer.alloc(bytes - 4, 7)]);
}
function xlsmReq(cookie: string, buf: Buffer): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buf)], "postorder.xlsm"));
  form.set("month", "2026-09");
  return new Request("http://x/api/guard-fix/postorder", { method: "POST", headers: { cookie }, body: form });
}

describe("Postorder xlsm 記憶體保險", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("2MB+ 合成 xlsm：400＋講明改上載 CSV，冇存 postorder_uploads，exceljs 冇被叫", async () => {
    const spy = vi.spyOn(ExcelJS.Workbook.prototype.xlsx, "load");
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const res = await uploadPostorder(xlsmReq(cookie, bigZip(2.5 * 1024 * 1024)));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string; error?: { message?: string } };
    expect(JSON.stringify(body)).toContain("另存做 CSV");
    expect(await prisma.postorderUpload.count()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("上限邊界：剛好 1.5MB 唔被大小閘擋（行到 exceljs 解析，壞檔另有錯誤）；超 1 byte 就擋", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const over = await uploadPostorder(xlsmReq(cookie, bigZip(MAX_WORKBOOK_BYTES + 1)));
    expect(over.status).toBe(400);
    expect(JSON.stringify(await over.json())).toContain("另存做 CSV");
    const at = await uploadPostorder(xlsmReq(cookie, bigZip(MAX_WORKBOOK_BYTES)));
    const txt = JSON.stringify(await at.json());
    expect(txt).not.toContain("另存做 CSV");
  });

  it("所有入口共用 loadPostorderWorkbook／parsePostorderWorkbookBuffer／parsePostorderUploadRow：大檔未載入就 reject", async () => {
    await expect(loadPostorderWorkbook(bigZip(MAX_WORKBOOK_BYTES + 1))).rejects.toThrow(/另存做 CSV/);
    await expect(parsePostorderWorkbookBuffer(bigZip(MAX_WORKBOOK_BYTES + 1))).rejects.toThrow(/另存做 CSV/);
    await expect(parsePostorderUploadRow({ fileBytes: bigZip(MAX_WORKBOOK_BYTES + 1) })).rejects.toThrow(/另存做 CSV/);
  });

  it("已存嘅超大 xlsm（保險加入前上載）：一鍵結算唔爆，Postorder 證據略過", async () => {
    const up = await seedPostorder(new Date(Date.UTC(2026, 8, 1)), fx.userIds["老闆"]);
    await prisma.postorderUpload.update({ where: { id: up.id }, data: { fileBytes: new Uint8Array(bigZip(2 * 1024 * 1024)) } });
    const { AutoCollector } = await import("@/lib/month-close/auto/context");
    const ctx = new AutoCollector(null, new Date(Date.UTC(2026, 8, 1)), fx.userIds["老闆"], null);
    expect(await ctx.postorder()).toBeNull();
    expect(ctx.warnings.join("")).toContain("CSV");
  });

  it("CSV 路徑不變：postorder_csv 照樣上載成功", async () => {
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const form = new FormData();
    form.set("postorder_csv", new File(["客戶名稱,Customer Code,物業名稱,更份,上單價,外判價,時間\n"], "PostOrder.csv", { type: "text/csv" }));
    form.set("month", "2026-09");
    const res = await uploadPostorder(new Request("http://x/api/guard-fix/postorder", { method: "POST", headers: { cookie }, body: form }));
    expect(res.status).toBeLessThan(300);
    expect(await prisma.postorderUpload.count()).toBe(1);
  });
});
