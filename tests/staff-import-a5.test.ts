// WP-STAFF-IMPORT Stage A5：地址 confirmed 必須兩個獨立讀數一致——全部合成資料。
import { describe, expect, it } from "vitest";
import type { DocExtract } from "../scripts/staff-import/lib/aggregate";
import type { PhoneFinal } from "../scripts/staff-import/lib/phone";
import { normAddr, resolvePerson, type PersonDocIn } from "../scripts/staff-import/lib/person-fields";

const ph: PhoneFinal = { value: null, status: "unresolved", candidates: [], reasons: [] } as unknown as PhoneFinal;
const A = "FLAT 12, 3/F SAMPLE HOUSE DEMO ESTATE TSUEN WAN, NT";
const exOf = (address: string | null): DocExtract =>
  ({
    docId: "d1", pageCount: 5, pages: [], hkid: { value: "A1234563", level: "high", conf: 0.9, page: 3, evidence: "x" }, hkidValid: true,
    nameZh: { value: "測試安員", level: "medium", conf: 0.5, page: 3, evidence: "x" },
    nameEn: { value: "CHAN Tai Man", level: "medium", conf: 0.5, page: 3, evidence: "x" },
    dob: null, sex: null,
    address: address ? { value: address, level: "high", conf: 0.5, page: 5, evidence: "x" } : null,
    addressRecipient: "TAI MAN CHAN", phone: null, aux: { formHkid: null, permitHkid: null, formAddress: null, formNameZh: null, formNameEn: null },
    flags: [], rescuedRot: null,
  }) as unknown as DocExtract;
const run = (local: string | null, v1: string | null, v2: { address: string | null; legible: "clear" | "unsure" } | null) => {
  const ex = exOf(local);
  const d: PersonDocIn = { docId: "d1", ex, fileNameZh: "測試安員", phone: ph, listZh: [], listEn: [], listTels: [] };
  return resolvePerson({
    key: "k", docs: [d], idDocId: "d1", addressDocId: "d1",
    nameVision: { docId: "d1", zh: "測試安員", en: "CHAN, TAI MAN", legible: "clear" },
    addrVision: v1 === null ? null : { docId: "d1", page: 5, recipient: "TAI MAN CHAN", address: v1, legible: "clear", complete: true },
    addrVision2: v2 ? { docId: "d1", page: 5, recipient: "TAI MAN CHAN", ...v2 } : null,
  }).address;
};

describe("地址：兩個獨立讀數一致先 confirmed", () => {
  it("第一視覺＝本機 OCR（正規化後）→ confirmed", () => {
    expect(run(A, "flat 12，3/f Sample House Demo Estate Tsuen Wan NT", null).status).toBe("confirmed");
  });
  it("冇本機 OCR、兩個視覺讀數一致（全半形／標點／大小寫差異）→ confirmed，兩值留 candidates", () => {
    const r = run(null, A, { address: "ＦＬＡＴ 12 3/F sample house, demo estate; tsuen wan NT", legible: "clear" });
    expect(r.status).toBe("confirmed");
    expect(r.candidates.length).toBe(1);
  });
  it("兩個視覺讀數差一個字 → review address_reads_disagree，兩值都留", () => {
    const r = run(null, A, { address: A.replace("SAMPLE", "SAMPLF"), legible: "clear" });
    expect(r.status).toBe("review");
    expect(r.reasons).toContain("address_reads_disagree");
    expect(r.candidates).toContain(A.replace("SAMPLE", "SAMPLF"));
    expect(r.value).toBe(A);
  });
  it("第二讀 unsure → review address_single_read", () => {
    const r = run(null, A, { address: null, legible: "unsure" });
    expect(r.status).toBe("review");
    expect(r.reasons).toContain("address_single_read");
  });
  it("冇第二讀、亦冇本機一致 → review address_single_read", () => {
    const r = run(null, A, null);
    expect(r.status).toBe("review");
    expect(r.reasons).toContain("address_single_read");
  });
  it("normAddr：全半形統一、唔做模糊", () => {
    expect(normAddr("Ａ１ ｂ，c")).toBe("A1BC");
    expect(normAddr("ABC")).not.toBe(normAddr("ABD"));
  });
});
