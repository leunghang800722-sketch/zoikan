// P14.2：批量導入檔解析（client-safe 純函數）。
import { describe, it, expect } from "vitest";
import { parseBulkText, parseCsvText } from "@/lib/longterm-payroll/bulk-parse";

describe("bulk-parse", () => {
  it("CSV：表頭、引號內逗號／換行／雙引號、BOM、空行、amount 轉數字、doctor_note_verified 轉 boolean", () => {
    const text = '﻿staff_no,kind,amount,note,doctor_note_verified,unknown_col\r\nU9701,special_allowance,500,"a,b ""x""\nline2",true,zzz\r\n\r\nU9702,deduction,abc,,,\r\n';
    const { rows, error } = parseBulkText("x.csv", text);
    expect(error).toBeNull();
    expect(rows).toEqual([
      { staff_no: "U9701", kind: "special_allowance", amount: 500, note: 'a,b "x"\nline2', doctor_note_verified: true },
      { staff_no: "U9702", kind: "deduction", amount: "abc" },
    ]);
    expect(parseCsvText("a,b\n1,2").length).toBe(2);
  });
  it("JSON 陣列或 { rows }；壞格式回 error", () => {
    expect(parseBulkText("a.json", '[{"kind":"uniform","amount":1,"staff_no":"U1"}]').rows).toHaveLength(1);
    expect(parseBulkText("a.json", '{"rows":[{"kind":"uniform"}]}').rows).toHaveLength(1);
    expect(parseBulkText("a.json", '{"x":1}').error).toMatch(/陣列/);
    expect(parseBulkText("a.json", "[oops").error).toMatch(/讀唔到/);
    expect(parseBulkText("a.csv", "staff_no\nU1").error).toMatch(/kind/);
    expect(parseBulkText("a.csv", "kind").error).toMatch(/表頭/);
  });
});
