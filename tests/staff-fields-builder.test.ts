// WP-STAFF-FIELDS：v3 包 builder（scripts/staff-import/lib/package-v3.ts）——全部合成資料，唔讀 data/。
import { describe, it, expect } from "vitest";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { buildPackageV3, type ExtPerson, type V2Package } from "../scripts/staff-import/lib/package-v3";

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  return base + ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
}
const HA = mkHkid("M", "300001");
const HB = mkHkid("N", "300002");
const HC = mkHkid("P", "300003");
const F = (value: string | null, status = "confirmed", reasons: string[] = [], sources: string[] = []) => ({ value, status: value ? status : "missing", candidates: [], sources, reasons });
const L = (value: string | null) => (value ? { value, status: "confirmed" as const } : { value: null, status: "missing" as const });

const v2: V2Package = {
  version: 2,
  generatedAt: "t",
  persons: [
    { key: "k1", hkid: L(HA), nameZh: L("測試員甲"), nameEn: L(null), dateOfBirth: L(null), sex: L(null), phone: L(null), address: L(null), staffNumbers: [{ scheme: "U", number: "U90001" }], rating: "auto_ok", reasons: [] },
    { key: "k2", hkid: L(HB), nameZh: L("測試員乙"), nameEn: L(null), dateOfBirth: L(null), sex: L(null), phone: L(null), address: L(null), staffNumbers: [{ scheme: "U", number: "U90002" }], rating: "auto_ok", reasons: [] },
  ],
};
const ext: ExtPerson[] = [
  {
    key: HA, keyKind: "hkid", hasDocs: true, docIds: ["d1"], staffNos: ["U90001"], flags: [],
    fields: {
      siaPermitNo: F("K-300001-1-001"), siaPermitAExpiry: F("2027-03-04"), siaPermitBExpiry: F("2028-01-02"),
      qasIssueDate: F("2021-01-01", "confirmed", ["handwritten_unverified"]), // 唔入包
      safetyCardExpiry: F("2027-13-45"), // 唔合法 → 轉 missing
      hireDate: F("2020-01-02"),
      staffNumbers: [{ staffNo: "U90001", hireDate: F("2020-01-02") }],
      bankCode: F("004", "confirmed", [], ["typed_pe"]), bankName: F("匯豐銀行", "confirmed", [], ["typed_pe"]), bankAccountNo: F("000012345678", "confirmed", [], ["typed_pe"]), bankPayeeName: F("TEST PAYEE", "review", ["bank_copy_disagrees"], ["typed_pe"]),
      emergencyContacts: [{ name: F("測試聯絡人甲"), relationship: F("朋友"), tel: F("91000011") }, { name: F("測試聯絡人乙"), relationship: F(null), tel: F("91000012") }, { name: F("丙"), relationship: F(null), tel: F("91000013") }],
    },
  },
  { key: HB, keyKind: "hkid", hasDocs: true, docIds: ["d2"], staffNos: ["U90002"], flags: ["possible_duplicate_of:xyz"], fields: { siaPermitNo: F("L-300002", "confirmed"), siaPermitAExpiry: F("2027-03-04", "review", ["single_read"]), siaPermitBExpiry: F("2027-03-05", "review", ["permit_serial_unverified"]), safetyCardExpiry: F("2027-03-06", "review", ["linked_by_staff_no_only"]), bankAccountNo: F("000022223333", "review", ["bank_copy_only"], ["bank_copy_read1"]), emergencyContacts: [{ name: F("測試聯絡人丁", "confirmed"), relationship: F("朋友", "review", ["single_read"]), tel: F("91000014", "review", ["sources_disagree"]) }] } },
  { key: HC, keyKind: "hkid", hasDocs: false, staffNos: ["MG90003"], flags: ["typed_list_only_person"], fields: { hireDate: F("2022-02-02"), staffNumbers: [{ staffNo: "MG90003", hireDate: F("2022-02-02") }] } },
  { key: "pe:004:abc", keyType: "x", keyKind: "internal", hasDocs: false, flags: ["payroll_editor_only_person"], fields: { bankCode: F("004", "review", ["bank_identity_unknown"]), bankAccountNo: F("000099998888", "review", ["bank_identity_unknown"]), bankPayeeName: F("TEST UNKNOWN", "review", ["bank_identity_unknown"]) } } as never,
  { key: "pe:999:bad", keyKind: "internal", hasDocs: false, flags: ["payroll_editor_only_person"], fields: { bankCode: F("999", "review", ["bank_identity_unknown"]), bankAccountNo: F("000011110000", "review", ["bank_identity_unknown"]), bankPayeeName: F("TEST BADCODE", "review", ["bank_identity_unknown"]) } },
];

describe("v3 builder", () => {
  it("327＋打字名單＋Payroll Editor 對不到人：v3 形狀、降級、略過、容忍舊格式", () => {
    const { pkg, counts, report } = buildPackageV3(v2, ext, { maxwell: [{ hkid: HC, nameZh: "測試打字員", nameEn: "TEST TYPED", staffNo: "MG90003" }] }, { v2DocIds: [["d1"], ["d2"]] });
    expect(pkg.version).toBe(3);
    expect(pkg.persons).toHaveLength(3);
    expect(counts).toMatchObject({ persons_with_docs: 2, persons_typed_only: 1, unassigned_bank: 1, unassigned_dropped: 1, identity_check_persons: 1, join_by_index: 2, join_failed: 0 });
    expect(counts.leaves_dropped_invalid).toBeGreaterThanOrEqual(1);
    const a = pkg.persons[0]!;
    expect(a.qas?.issueDate.status).toBe("missing");
    expect(a.safetyCard?.expiry.status).toBe("missing");
    expect(a.siaPermit?.no.status).toBe("confirmed");
    expect(a.bank?.payeeName.status).toBe("review");
    expect(a.reasons).toContain("bank_copy_disagrees");
    expect(a.emergencyContacts).toHaveLength(3);
    expect(a.staffNumbers[0]!.hireDate?.value).toBe("2020-01-02");
    // 疑似重複 → 全降 review＋ext_identity_check（舊格式 emergency1* 也讀到）
    const b = pkg.persons[1]!;
    expect(b.reasons).toContain("ext_identity_check");
    // 減題：單一讀數／未核實序號 review 唔入包；可由人直接決定嘅（linked_by_staff_no_only）入包（降 review）；銀行副本 only 唔入包
    expect(b.siaPermit?.aExpiry.status).toBe("missing");
    expect(b.siaPermit?.bExpiry.status).toBe("missing");
    expect(b.safetyCard?.expiry.status).toBe("review");
    expect(b.bank?.accountNo.status).toBe("missing");
    expect(counts.bank_copy_only_skipped).toBeGreaterThanOrEqual(1);
    expect(b.emergencyContacts?.[0]?.name.status).toBe("review");
    expect(b.emergencyContacts?.[0]?.relationship.status).toBe("missing");
    expect(report.some((r) => r.reason === "permit_serial_unverified")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("000022223333");
    // 打字名單 only：hkid／姓名 review（唔會用嚟自動建人）；工號帶逐工號入職日期
    const c = pkg.persons[2]!;
    expect(c.hkid.status).toBe("review");
    expect(c.nameZh.status).toBe("review");
    expect(c.staffNumbers[0]).toMatchObject({ scheme: "MG", number: "MG90003" });
    expect(c.staffNumbers[0]!.hireDate?.value).toBe("2022-02-02");
    expect(pkg.unassignedBankAccounts).toHaveLength(1);
    expect(pkg.unassignedBankAccounts![0]!.key).toBe("pe:004:abc");
  });
  it("次序 join 逐對核對：錯位一行／docIds 唔同 → join_failed（唔寫新欄）；身份證對唔上 → 成批放棄次序 join 改用 key", () => {
    // docIds 錯位
    const a = buildPackageV3(v2, ext.slice(0, 2), {}, { v2DocIds: [["d2"], ["d1"]] });
    expect(a.counts.join_failed).toBe(2);
    expect(a.pkg.persons.every((p) => !p.siaPermit)).toBe(true);
    // 身份證對唔上（兩個 ext 調轉）→ 放棄次序 join，用 key join 仍然得 2 對
    const b = buildPackageV3(v2, [ext[1]!, ext[0]!], {}, { v2DocIds: [["d1"], ["d2"]] });
    expect(b.counts.join_by_index).toBe(0);
    expect(b.counts.join_fallback).toBe(2);
    // 冇 docIds 可核對 → 唔做次序 join
    const c = buildPackageV3(v2, ext.slice(0, 2), {});
    expect(c.counts.join_by_index).toBe(0);
    // 同一份 ext 唔可以用兩次（重複 key）：兩個 v2 人同 hkid，只有一份 ext → key join 下第二個 join_failed，新欄只出現喺一個人
    const twin = { ...v2.persons[1]!, hkid: v2.persons[0]!.hkid, staffNumbers: [] };
    const dup = buildPackageV3({ ...v2, persons: [v2.persons[0]!, twin] }, [ext[0]!], {});
    expect(dup.counts.join_failed).toBe(1);
    expect(dup.pkg.persons.filter((p) => p.siaPermit).length).toBe(1);
  });
  it("輸出檔缺欄位／冇 typed-sources 都唔爆", () => {
    const { pkg } = buildPackageV3(v2, [{ key: HA, hasDocs: true }], {});
    expect(pkg.persons).toHaveLength(2);
  });
});
