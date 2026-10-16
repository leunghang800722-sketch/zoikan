// WP-OCR-1.4：證件欄 missing／review 時，入職表手寫值做唯讀參考（referenceOnly）；唔自動填、唔改 value、來源仍係證件。
import { describe, it, expect } from "vitest";
import { mergeDocFields } from "@/lib/guards/ocr/merge-docs";
import { FORM_FILLED_MSG, ackAfterEdit, ackAfterFill } from "@/lib/guards/ocr/review-state";
import type { FieldResult } from "@/lib/guards/ocr/normalize";
import type { OcrDocType, OcrFieldKey } from "@/lib/guards/ocr/config";

const fr = (over: Partial<FieldResult> & Pick<FieldResult, "status" | "value">): FieldResult => ({ candidates: [], candidates_ranked: [], ...over });
type Doc = { type: OcrDocType; fields: Partial<Record<OcrFieldKey, FieldResult>> };
const docs = (...ds: Doc[]) => new Map(ds.map((d) => [d.type, d]));
const form = (fields: Doc["fields"]): Doc => ({ type: "onboarding_form", fields });

describe("mergeDocFields：證件欄 missing／review → 入職表手寫值做參考", () => {
  it("身份證 missing＋有手寫值 → formValue 有、referenceOnly、value 仍然空、來源 id_card（唔自動填）", () => {
    const m = mergeDocFields(docs({ type: "id_card", fields: { hkid: fr({ status: "missing", value: "", reason: "unclear" }) } }, form({ hkid: fr({ status: "confirmed", value: "Z900001(2)" }) })));
    expect(m.picks.hkid).toMatchObject({ doc: "id_card", formValue: "Z900001(2)", referenceOnly: true });
    expect(m.picks.hkid!.result.value).toBe("");
    expect(m.picks.hkid!.cross).toBeUndefined();
  });
  it("身份證 review＋有手寫值 → formValue 有、referenceOnly；預填值（身份證候選）唔變", () => {
    const m = mergeDocFields(docs({ type: "id_card", fields: { name_zh: fr({ status: "review", value: "測試甲", candidates: ["測試甲", "測試乙"], reason: "reads_differ" }) } }, form({ name_zh: fr({ status: "review", value: "測試丙", reason: "reads_differ" }) })));
    expect(m.picks.name_zh).toMatchObject({ doc: "id_card", formValue: "測試丙", referenceOnly: true });
    expect(m.picks.name_zh!.result.value).toBe("測試甲");
  });
  it("身份證 missing／review 但入職表冇手寫值（missing／空）→ 冇 formValue、冇 referenceOnly", () => {
    for (const st of ["missing", "review"] as const) {
      const m = mergeDocFields(docs({ type: "id_card", fields: { hkid: fr({ status: st, value: st === "review" ? "Z900001(2)" : "" }) } }, form({ hkid: fr({ status: "missing", value: "" }) })));
      expect(m.picks.hkid!.formValue).toBeUndefined();
      expect(m.picks.hkid!.referenceOnly).toBeUndefined();
    }
    const noForm = mergeDocFields(docs({ type: "id_card", fields: { dob: fr({ status: "missing", value: "" }) } }));
    expect(noForm.picks.dob!.formValue).toBeUndefined();
  });
  it("身份證 confirmed → 唔係 referenceOnly（沿用 OCR-1.3：有 cross 先顯示手寫值）", () => {
    const m = mergeDocFields(docs({ type: "id_card", fields: { hkid: fr({ status: "confirmed", value: "Z900001(2)" }) } }, form({ hkid: fr({ status: "confirmed", value: "Z900002(0)" }) })));
    expect(m.picks.hkid!.referenceOnly).toBeUndefined();
    expect(m.picks.hkid!.formValue).toBeUndefined();
  });
  it("住址證明 review＋有手寫地址 → 地址用住址證明、手寫地址做參考；confirmed 住址證明唔係 referenceOnly；missing 照來源規則用入職表", () => {
    const rev = mergeDocFields(docs({ type: "address_proof", fields: { address: fr({ status: "review", value: "示範街99號", reason: "reads_differ" }) } }, form({ address: fr({ status: "confirmed", value: "示範街98號" }) })));
    expect(rev.addrFrom).toBe("address_proof");
    expect(rev.picks.address).toMatchObject({ doc: "address_proof", formValue: "示範街98號", referenceOnly: true });
    expect(rev.picks.address!.result.value).toBe("示範街99號");
    const conf = mergeDocFields(docs({ type: "address_proof", fields: { address: fr({ status: "confirmed", value: "示範街99號" }) } }, form({ address: fr({ status: "confirmed", value: "示範街98號" }) })));
    expect(conf.picks.address!.referenceOnly).toBeUndefined();
    const miss = mergeDocFields(docs({ type: "address_proof", fields: { address: fr({ status: "missing", value: "" }) } }, form({ address: fr({ status: "confirmed", value: "示範街98號" }) })));
    expect(miss.addrFrom).toBe("onboarding_form");
    const noHand = mergeDocFields(docs({ type: "address_proof", fields: { address: fr({ status: "review", value: "示範街99號" }) } }, form({ address: fr({ status: "missing", value: "" }) })));
    expect(noHand.picks.address!.referenceOnly).toBeUndefined();
    expect(noHand.picks.address!.formValue).toBeUndefined();
  });
  it("填入＝人手改值：走現有 ackAfterEdit 規則（UI 對關鍵欄另外強制 ack=false，見 e2e）", () => {
    expect(ackAfterEdit("hkid", "missing", "Z900001(2)")).toBe(true); // missing：打字即算（現有規則）
    expect(ackAfterEdit("hkid", "review", "Z900001(2)")).toBe(false); // review 嘅關鍵欄：改值仍要對過證件
    expect(ackAfterEdit("address", "review", "示範街98號")).toBe(true);
  });
  it("OCR-1.5 ackAfterFill：填入後所有欄一律未確認；其後人手改字回到 ackAfterEdit 規則", () => {
    expect(ackAfterFill()).toBe(false);
    // 人手改字（ackAfterEdit）：非關鍵欄有值即確認、missing 關鍵欄打字即確認、review 關鍵欄要重新確認
    expect(ackAfterEdit("address", "review", "示範街98號A")).toBe(true);
    expect(ackAfterEdit("hkid", "review", "Z900001(2)")).toBe(false);
    expect(FORM_FILLED_MSG).toBe("已採用入職表手寫值（請對住圖確認）");
    expect(FORM_FILLED_MSG).not.toContain("已以");
  });
});
