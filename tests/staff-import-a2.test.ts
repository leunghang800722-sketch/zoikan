// WP-STAFF-IMPORT Stage A2：旋轉救援、電話裁圖定位、電話最終值、多檔合併規則（合成資料）。
import { describe, expect, it } from "vitest";
import { aggregateDoc } from "../scripts/staff-import/lib/aggregate";
import { buildIndex, crosscheck } from "../scripts/staff-import/lib/crosscheck";
import { findDocDate, parseDatesLoose } from "../scripts/staff-import/lib/extract";
import { mergeGroup, type MergeDoc } from "../scripts/staff-import/lib/merge";
import type { OcrLine, OcrPage } from "../scripts/staff-import/lib/ocr";
import { resolvePhone, type VisionRead } from "../scripts/staff-import/lib/phone";
import { locatePhoneBox, toPixels } from "../scripts/staff-import/lib/phone-crop";
import type { RefRow } from "../scripts/staff-import/lib/refs";

const L = (t: string, x: number, y: number, c = 0.9): OcrLine => ({ t, c, x, y, w: 0.1, h: 0.01 });
const card = (): OcrLine[] => [
  L("香港永久性居民身份證", 0.5, 0.8),
  L("HONG KONG PERMANENT IDENTITY CARD", 0.45, 0.77),
  L("測試保安員", 0.45, 0.7),
  L("CHAN, Tai Man", 0.45, 0.67),
  L("出生日期 Date of Birth", 0.55, 0.62),
  L("01-02-1980 男M", 0.55, 0.6),
  L("A123456（3）", 0.6, 0.5),
];

describe("旋轉／300dpi 候選頁救返 hkid", () => {
  it("原頁讀唔到，候選頁讀到 → 用候選頁並記 rot", () => {
    const orig: OcrPage = { page: 3, lines: [L("亂碼", 0.1, 0.1)] };
    const alt: OcrPage = { page: 3, lines: card(), alt: true, rot: 180 };
    const d = aggregateDoc("x", [orig, alt]);
    expect(d.hkid?.value).toBe("A1234563");
    expect(d.rescuedRot).toBe(180);
    expect(d.pages).toHaveLength(1); // 候選頁唔計頁數
  });
  it("原頁已讀到 → 唔當救返", () => {
    const d = aggregateDoc("x", [{ page: 3, lines: card() }, { page: 3, lines: card(), alt: true, rot: 0 }]);
    expect(d.rescuedRot).toBeNull();
  });
});

describe("電話裁圖定位", () => {
  it("範本 A：手提電話同行右邊，唔跨去緊急聯絡人電話列", () => {
    const loc = locatePhoneBox([L("手提電話：", 0.48, 0.56), L("關係： 電話：", 0.48, 0.54), L("通訊地址", 0.13, 0.59)]);
    expect(loc?.template).toBe("A");
    expect(loc!.box.y0).toBeGreaterThan(0.545);
    expect(loc!.box.y1).toBeLessThan(0.59);
    expect(loc!.box.x0).toBeGreaterThan(0.4);
  });
  it("範本 B：聯絡電話／Phone No. 下一行，左欄，唔包住所電話", () => {
    const loc = locatePhoneBox([L("聯絡電話", 0.06, 0.66), L("Phone No.：", 0.06, 0.65), L("住所電話", 0.39, 0.66), L("地址：", 0.06, 0.62)]);
    expect(loc?.template).toBe("B");
    expect(loc!.box.x1).toBeLessThan(0.39);
    expect(loc!.box.y0).toBeGreaterThan(0.6);
  });
  it("搵唔到 label → null；toPixels 以左上做原點", () => {
    expect(locatePhoneBox([L("姓名", 0.1, 0.5)])).toBeNull();
    expect(toPixels({ x0: 0.1, x1: 0.6, y0: 0.5, y1: 0.6 }, 1000, 2000)).toEqual({ x: 100, y: 800, w: 500, h: 200 });
  });
});

describe("電話最終值", () => {
  const v = (digits: string | null, legible: VisionRead["legible"]): VisionRead => ({ docId: "d", page: 1, digits, legible });
  it("clear＋名單一致 → confirmed；clear＋OCR 一致 → confirmed", () => {
    expect(resolvePhone([v("91234567", "clear")], null, ["9123 4567"], true).status).toBe("confirmed");
    const r = resolvePhone([v("91234567", "clear")], "91234567", [], true);
    expect(r.status).toBe("confirmed");
    expect(r.by).toEqual(["ocr"]);
  });
  it("clear 但同名單唔同 → differs（兩個值都留）；冇名單 → vision_only", () => {
    const d = resolvePhone([v("91234567", "clear")], null, ["92345678"], true);
    expect(d.status).toBe("differs");
    expect(d.value).toBe("91234567");
    expect(d.listValues).toEqual(["92345678"]);
    expect(resolvePhone([v("91234567", "clear")], null, [], true).status).toBe("vision_only");
  });
  it("unsure／illegible／冇 label／未讀 → unresolved，唔寫值", () => {
    expect(resolvePhone([v("91234567", "unsure")], "91234567", ["91234567"], true)).toMatchObject({ status: "unresolved", value: null, reason: "unsure" });
    expect(resolvePhone([v(null, "illegible")], null, [], true).reason).toBe("illegible");
    expect(resolvePhone([], null, [], false).reason).toBe("no_label_or_form");
    expect(resolvePhone([], null, [], true).reason).toBe("not_read");
  });
});

describe("crosscheck 電話規則", () => {
  const ref: RefRow = { src: "utem", ref: "utem:1", staffNos: ["U99999"], hkid: null, nameZh: "測試保安員", nameEn: null, dob: "1980-02-01", tels: ["92345678"], addresses: [] };
  const idx = { utem: buildIndex([ref]), maxwell: buildIndex([]), db: buildIndex([]) };
  const doc = () => aggregateDoc("a", [{ page: 3, lines: card() }]);
  it("視覺 clear 同名單唔同 → phone_differs_from_list，唔係 auto_ok", () => {
    const c = crosscheck(doc(), "U99999", "測試保安員", idx, { vision: [{ docId: "a", page: 1, digits: "91234567", legible: "clear" }], hasCrop: true });
    expect(c.phoneFinal.status).toBe("differs");
    expect(c.reasons).toContain("phone_differs_from_list");
    expect(c.grade).not.toBe("auto_ok");
  });
  it("視覺 unsure → phone_unresolved", () => {
    const c = crosscheck(doc(), "U99999", "測試保安員", idx, { vision: [{ docId: "a", page: 1, digits: null, legible: "unsure" }], hasCrop: true });
    expect(c.reasons).toEqual(expect.arrayContaining(["phone_unresolved", "phone_unresolved_unsure"]));
    expect(c.present.phone).toBe(false);
  });
});

describe("單據日期", () => {
  it("label 附近優先，否則頁內最新", () => {
    expect(findDocDate([L("發出日期：16/04/2026", 0.5, 0.9), L("2025-01-02", 0.1, 0.5)])).toBe("2026-04-16");
    expect(findDocDate([L("2025-01-02", 0.1, 0.5), L("03/05/2024", 0.1, 0.4)])).toBe("2025-01-02");
    expect(findDocDate([L("冇日期", 0.1, 0.5)])).toBeNull();
    expect(parseDatesLoose("31/02/1999")).toEqual([]);
  });
});

describe("同人多檔合併", () => {
  const base = (o: Partial<MergeDoc>): MergeDoc => ({
    docId: "d", staffNo: null, grade: "review", hkidConf: 0.5,
    id: { hkid: "A1234563", nameZh: "測試保安員", nameEn: null, dob: null, sex: null },
    address: null, phone: null, ...o,
  });
  it("身份證取評級較好嗰份，缺嘅欄由另一份補；MP＋U 工號全保留", () => {
    const a = base({ docId: "a", staffNo: "MP1", grade: "review", id: { hkid: "A1234563", nameZh: "測試保安員", nameEn: null, dob: "1980-02-01", sex: null } });
    const b = base({ docId: "b", staffNo: "U1", grade: "auto_ok", id: { hkid: "A1234563", nameZh: "測試保安員", nameEn: "CHAN Tai Man", dob: null, sex: null } });
    const m = mergeGroup([a, b]);
    expect(m.idDocId).toBe("b");
    expect(m.nameEn).toBe("CHAN Tai Man");
    expect(m.dob).toBe("1980-02-01");
    expect(m.staffNos.sort()).toEqual(["MP1", "U1"]);
  });
  it("地址取日期較新；日期缺而地址唔同 → review 理由", () => {
    const a = base({ docId: "a", address: { value: "ROOM 1 SAMPLE HOUSE DEMO ESTATE", date: "2025-01-01", level: "high" } });
    const b = base({ docId: "b", address: { value: "FLAT 9 OTHER COURT ELSEWHERE", date: "2026-03-01", level: "high" } });
    expect(mergeGroup([a, b]).addressDocId).toBe("b");
    const c = base({ docId: "c", address: { value: "FLAT 9 OTHER COURT ELSEWHERE", date: null, level: "low" } });
    expect(mergeGroup([a, c]).reasons).toContain("address_dates_unknown_conflict");
    expect(mergeGroup([a, base({ docId: "e", address: { value: "ROOM 1 SAMPLE HOUSE DEMO ESTATE", date: null, level: "low" } })]).reasons).toEqual([]);
  });
  it("電話：一致 → 取；唔同 → review 並兩個值都留", () => {
    const a = base({ docId: "a", phone: { value: "91234567", status: "confirmed" } });
    const b = base({ docId: "b", phone: { value: "9123 4567", status: "vision_only" } });
    expect(mergeGroup([a, b]).phone).toBe("91234567");
    const c = base({ docId: "c", phone: { value: "92345678", status: "differs" } });
    const m = mergeGroup([a, c]);
    expect(m.phone).toBeNull();
    expect(m.phones.sort()).toEqual(["91234567", "92345678"]);
    expect(m.reasons).toEqual(expect.arrayContaining(["phone_conflict_between_files", "phone_differs_from_list"]));
  });
});
