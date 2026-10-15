// WP-STAFF-IMPORT Stage A6：冇住址證明嘅人用申請表地址（兩讀數互證）——純函數，合成資料。
import { describe, expect, it } from "vitest";
import { locateFormAddressBox } from "../scripts/staff-import/lib/form-address-crop";
import type { OcrLine } from "../scripts/staff-import/lib/ocr";
import { resolveFormAddress, type FieldOut, type PersonIn, type FormAddrVision } from "../scripts/staff-import/lib/person-fields";

const L = (t: string, x: number, y: number): OcrLine => ({ t, c: 0.9, x, y, w: 0.1, h: 0.01 });
const base: FieldOut = { status: "missing", value: null, candidates: [], reasons: ["address_unresolved"] };
const v = (docId: string, address: string | null, legible: FormAddrVision["legible"] = "clear", page = 1): FormAddrVision => ({ docId, page, address, legible });
const P = (o: Partial<PersonIn>): PersonIn => ({ key: "k", docs: [], idDocId: null, addressDocId: null, nameVision: null, addrVision: null, formPages: 1, ...o });

describe("申請表地址定位", () => {
  it("範本 A：住址同行右邊，下界喺『通訊地址』上面；OCR 誤讀『生址／佳址』都認", () => {
    for (const lab of ["住址：", "生址：", "佳址："]) {
      const r = locateFormAddressBox([L("居港年期", 0.13, 0.62), L(lab, 0.13, 0.595), L("通訊地址（如與上述不同請提供）：", 0.13, 0.575)], "a");
      expect(r?.template).toBe("A");
      expect(r!.box.y0).toBeGreaterThan(0.575);
      expect(r!.box.y1).toBeLessThan(0.66);
    }
  });
  it("範本 B：地址／Address 下面，下界喺『香港身份證』行上面", () => {
    const r = locateFormAddressBox([L("地址：", 0.06, 0.62), L("Address：", 0.06, 0.61), L("香港身份證：", 0.06, 0.57), L("聯絡電話", 0.06, 0.5)], "b");
    expect(r?.template).toBe("B");
    expect(r!.box.y0).toBeGreaterThan(0.57);
    // WP-OCR-3：外擴按行高比例（variant b 最少 0.042），上界＝label 頂 0.63 + 0.042
    expect(r!.box.y1).toBeLessThan(0.68);
  });
  it("後備：只有『通訊地址』／『香港身份證：』label；全冇 → null", () => {
    expect(locateFormAddressBox([L("通訊地址（如與上述不同請提供）：", 0.13, 0.575)], "a")?.template).toBe("A");
    expect(locateFormAddressBox([L("香港身份證：", 0.06, 0.66)], "a")?.template).toBe("B");
    expect(locateFormAddressBox([L("姓名", 0.1, 0.5)], "a")).toBeNull();
  });
});

describe("申請表地址規則（老闆 2026-10-03）", () => {
  it("兩讀數都 clear 且 normAddr 逐字一致 → confirmed，source=application_form", () => {
    const r = resolveFormAddress(P({ formAddrVision: [v("d", "FLAT 1, 2/F, TEST HSE")], formAddrVision2: [v("d", "Flat 1 2/F  test hse")] }), base);
    expect(r).toMatchObject({ status: "confirmed", source: "application_form", value: "FLAT 1, 2/F, TEST HSE" });
  });
  it("第二讀數檔未存在 → review（address_single_read），唔 confirmed", () => {
    const r = resolveFormAddress(P({ formAddrVision: [v("d", "測試道1號")], formAddrVision2: null }), base);
    expect(r.status).toBe("review");
    expect(r.reasons).toContain("address_single_read");
    expect(r.source).toBe("application_form");
  });
  it("第二讀數唔 clear／缺／唔一致（唔准模糊匹配）→ review", () => {
    expect(resolveFormAddress(P({ formAddrVision: [v("d", "測試道1號")], formAddrVision2: [v("d", "測試道1號", "unsure")] }), base).status).toBe("review");
    expect(resolveFormAddress(P({ formAddrVision: [v("d", "測試道1號")], formAddrVision2: [] }), base).status).toBe("review");
    const dis = resolveFormAddress(P({ formAddrVision: [v("d", "測試道1號3樓")], formAddrVision2: [v("d", "測試道1號3樓A")] }), base);
    expect(dis.status).toBe("review");
    expect(dis.reasons).toContain("address_reads_disagree");
    expect(dis.candidates).toContain("測試道1號3樓A");
  });
  it("同人多份申請表地址唔同 → review（form_address_differs_between_forms），兩值都留", () => {
    const r = resolveFormAddress(P({ formAddrVision: [v("d1", "測試道1號"), v("d2", "測試道2號")], formAddrVision2: [v("d1", "測試道1號"), v("d2", "測試道2號")] }), base);
    expect(r.status).toBe("review");
    expect(r.reasons).toContain("form_address_differs_between_forms");
    expect(r.candidates.length).toBe(1);
  });
  it("第一讀數睇唔清／冇申請表／冇 label → 維持 missing 並帶原因", () => {
    expect(resolveFormAddress(P({ formAddrVision: [v("d", null, "unsure")] }), base)).toMatchObject({ status: "missing" });
    expect(resolveFormAddress(P({ formAddrVision: [v("d", null, "unsure")] }), base).reasons).toContain("form_address_unreadable");
    expect(resolveFormAddress(P({ formPages: 0 }), base).reasons).toContain("form_address_no_form");
    expect(resolveFormAddress(P({ formNoLabel: 1 }), base).reasons).toContain("form_address_no_label");
  });
});
