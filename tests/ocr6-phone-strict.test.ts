// OCR-6：手寫電話收緊——confirmed 必須 a、b、仲裁三讀逐字相同＋valid；其他欄規則不變。假資料 9000xxxx。
import { describe, expect, it } from "vitest";
import { reconcile } from "@/lib/guards/ocr/reconcile";

const NOW = new Date("2026-10-20T00:00:00Z");

describe("reconcile phone（OCR-6）", () => {
  it("1. 三讀一致且 valid → confirmed（正規化後逐字相同，容許空格／+852）", () => {
    expect(reconcile("phone", "9000 1111", "+852 9000-1111", NOW, "90001111", undefined, ["+852 9000 1111"])).toMatchObject({ status: "confirmed", value: "90001111", arbiter: "agree_a", candidates: [] }); // OCR-6.1：再加獨立來源
  });
  it("2. 兩讀相同但冇仲裁／仲裁 unclear／仲裁讀到另一個值 → review phone_needs_three_way，預填兩讀值", () => {
    expect(reconcile("phone", "90001111", "90001111", NOW)).toMatchObject({ status: "review", value: "90001111", reason: "phone_needs_three_way" });
    expect(reconcile("phone", "90001111", "90001111", NOW, { value: "unclear" })).toMatchObject({ status: "review", value: "90001111", reason: "phone_needs_three_way", arbiter: "unclear" });
    expect(reconcile("phone", "90001111", "90001111", NOW, "90001112")).toMatchObject({ status: "review", value: "90001111", reason: "phone_needs_three_way", arbiter: "independent" });
  });
  it("3. 2/3 一致（仲裁同其中一讀）→ review，預填一致嗰個值，arbiter agree_a|agree_b", () => {
    expect(reconcile("phone", "90001111", "90001112", NOW, "90001111")).toMatchObject({ status: "review", value: "90001111", arbiter: "agree_a", reason: "phone_needs_three_way" });
    expect(reconcile("phone", "90001111", "90001112", NOW, "9000 1112")).toMatchObject({ status: "review", value: "90001112", arbiter: "agree_b", reason: "phone_needs_three_way" });
    // 三讀全唔同／冇仲裁：照舊 reads_differ
    expect(reconcile("phone", "90001111", "90001112", NOW, "90001113")).toMatchObject({ status: "review", reason: "reads_differ", arbiter: "independent" });
    expect(reconcile("phone", "90001111", "90001112", NOW)).toMatchObject({ status: "review", reason: "reads_differ" });
  });
  it("4. 任何一讀位數唔係 8 → review phone_digit_count（含分格線嫌疑 9 位；三讀一致都唔 confirmed）", () => {
    expect(reconcile("phone", "900011111", "900011111", NOW, "900011111")).toMatchObject({ status: "review", reason: "phone_digit_count" });
    expect(reconcile("phone", "90001111", "90001111", NOW, "9000111")).toMatchObject({ status: "review", reason: "phone_digit_count", arbiter: "independent" });
    expect(reconcile("phone", "9000111", "90001111", NOW, "90001111")).toMatchObject({ status: "review", reason: "phone_digit_count" });
    const g = reconcile("phone", "912345678", "912345678", NOW, "912345678");
    expect(g).toMatchObject({ status: "review", reason: "phone_digit_count", value: "92345678" });
    expect(g.candidates).toContain("912345678");
  });
  it("5. 三讀一致但格式不合（非 2–9 開頭）→ review，唔 confirmed", () => {
    expect(reconcile("phone", "10001111", "10001111", NOW, "10001111")).toMatchObject({ status: "review" });
  });
  it("6. 其他欄規則不變：兩讀一致照 confirmed；2/3 仲裁照 confirmed", () => {
    expect(reconcile("name_zh", "測試甲", "測試甲", NOW)).toMatchObject({ status: "confirmed" });
    expect(reconcile("name_zh", "測試甲", "測試乙", NOW, "測試甲")).toMatchObject({ status: "confirmed", arbiter: "agree_a" });
  });
});
