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
const F = (value: string | null, status = "confirmed", reasons: string[] = []) => ({ value, status: value ? status : "missing", candidates: [], sources: [], reasons });
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
    key: HA, keyKind: "hkid", hasDocs: true, staffNos: ["U90001"], flags: [],
    fields: {
      siaPermitNo: F("K-300001-1-001"), siaPermitAExpiry: F("2027-03-04"), siaPermitBExpiry: F("2028-01-02"),
      qasIssueDate: F("2021-01-01", "confirmed", ["handwritten_unverified"]), // 唔入包
      safetyCardExpiry: F("2027-13-45"), // 唔合法 → 轉 missing
      hireDate: F("2020-01-02"),
      staffNumbers: [{ staffNo: "U90001", hireDate: F("2020-01-02") }],
      bankCode: F("004", "confirmed"), bankName: F("匯豐銀行"), bankAccountNo: F("000012345678"), bankPayeeName: F("TEST PAYEE", "review", ["bank_copy_disagrees"]),
      emergencyContacts: [{ name: F("測試聯絡人甲"), relationship: F("朋友"), tel: F("91000011") }, { name: F("測試聯絡人乙"), relationship: F(null), tel: F("91000012") }, { name: F("丙"), relationship: F(null), tel: F("91000013") }],
    },
  },
  { key: HB, keyKind: "hkid", hasDocs: true, staffNos: ["U90002"], flags: ["possible_duplicate_of:xyz"], fields: { siaPermitNo: F("L-300002-1-001"), emergency1Name: F("測試聯絡人丁"), emergency1Tel: F("91000014") } },
  { key: HC, keyKind: "hkid", hasDocs: false, staffNos: ["MG90003"], flags: ["typed_list_only_person"], fields: { hireDate: F("2022-02-02"), staffNumbers: [{ staffNo: "MG90003", hireDate: F("2022-02-02") }] } },
  { key: "pe:004:abc", keyType: "x", keyKind: "internal", hasDocs: false, flags: ["payroll_editor_only_person"], fields: { bankCode: F("004"), bankAccountNo: F("000099998888"), bankPayeeName: F("TEST UNKNOWN", "review") } } as never,
  { key: "pe:999:bad", keyKind: "internal", hasDocs: false, flags: ["payroll_editor_only_person"], fields: { bankCode: F("999"), bankAccountNo: F("000011110000"), bankPayeeName: F("TEST BADCODE", "review") } },
];

describe("v3 builder", () => {
  it("327＋打字名單＋Payroll Editor 對不到人：v3 形狀、降級、略過、容忍舊格式", () => {
    const { pkg, counts } = buildPackageV3(v2, ext, { maxwell: [{ hkid: HC, nameZh: "測試打字員", nameEn: "TEST TYPED", staffNo: "MG90003" }] });
    expect(pkg.version).toBe(3);
    expect(pkg.persons).toHaveLength(3);
    expect(counts).toMatchObject({ persons_with_docs: 2, persons_typed_only: 1, unassigned_bank: 1, unassigned_dropped: 1, leaves_skipped_handwritten_unverified: 1, identity_check_persons: 1 });
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
    expect(b.siaPermit?.no.status).toBe("review");
    expect(b.reasons).toContain("ext_identity_check");
    expect(b.emergencyContacts?.[0]?.tel.status).toBe("review");
    // 打字名單 only：hkid／姓名 review（唔會用嚟自動建人）；工號帶逐工號入職日期
    const c = pkg.persons[2]!;
    expect(c.hkid.status).toBe("review");
    expect(c.nameZh.status).toBe("review");
    expect(c.staffNumbers[0]).toMatchObject({ scheme: "MG", number: "MG90003" });
    expect(c.staffNumbers[0]!.hireDate?.value).toBe("2022-02-02");
    expect(pkg.unassignedBankAccounts).toHaveLength(1);
    expect(pkg.unassignedBankAccounts![0]!.key).toBe("pe:004:abc");
  });
  it("輸出檔缺欄位／冇 typed-sources 都唔爆", () => {
    const { pkg } = buildPackageV3(v2, [{ key: HA, hasDocs: true }], {});
    expect(pkg.persons).toHaveLength(2);
  });
});
