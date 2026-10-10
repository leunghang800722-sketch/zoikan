// P3-3.6：雞頭銀行名／戶口號碼兩格 ⇄ bank_info JSON。只用假值（銀行資料屬 PII）。
import { describe, expect, it } from "vitest";
import { buildBankInfo, readBankFields } from "@/lib/ui/broker-bank";

describe("broker-bank（P3-3.6）", () => {
  it("讀：標準 key／舊拼寫／空／非物件", () => {
    expect(readBankFields({ bank_name: "測試銀行", account_no: "000-000000-000" })).toEqual({ bankName: "測試銀行", accountNo: "000-000000-000" });
    expect(readBankFields({ bankName: "假銀行", account_number: 12345 })).toEqual({ bankName: "假銀行", accountNo: "12345" });
    expect(readBankFields(null)).toEqual({ bankName: "", accountNo: "" });
    expect(readBankFields("xx")).toEqual({ bankName: "", accountNo: "" });
    expect(readBankFields([1, 2])).toEqual({ bankName: "", accountNo: "" });
  });

  it("寫：新建用 bank_name／account_no；兩格都空且原本冇 → 唔送", () => {
    expect(buildBankInfo(undefined, " 假銀行 ", " 000 ")).toEqual({ bank_name: "假銀行", account_no: "000" });
    expect(buildBankInfo(undefined, "", "")).toBeUndefined();
    expect(buildBankInfo(null, "  ", " ")).toBeUndefined();
  });

  it("寫：舊 JSON 其他 key 原封保留，只改兩個 key；沿用舊拼寫", () => {
    const old = { bankName: "舊", account_number: "1", branch: "X區", note: { a: 1 } };
    expect(buildBankInfo(old, "新銀行", "9")).toEqual({ bankName: "新銀行", account_number: "9", branch: "X區", note: { a: 1 } });
    // 原物件唔被改動
    expect(old.bankName).toBe("舊");
  });

  it("寫：清空兩格 → 兩個 key 刪走（其他 key 保留）；原本有 JSON 但清空晒 → 空物件（唔係 undefined）", () => {
    expect(buildBankInfo({ bank_name: "a", account_no: "b", branch: "c" }, "", "")).toEqual({ branch: "c" });
    expect(buildBankInfo({ bank_name: "a", account_no: "b" }, "", "")).toEqual({});
  });
});
