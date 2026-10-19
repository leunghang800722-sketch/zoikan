// TE-6：身份證號輸入即時狀態（client-safe 純模組 hkid-pure）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { hkidInputState, canonicalHkid, hkidCheckDigitValid, formatHkid } from "@/lib/guards/hkid-pure";
import * as identity from "@/lib/guards/identity";

describe("hkidInputState", () => {
  it("空／格式未齊／檢查碼唔啱／合法", () => {
    expect(hkidInputState("")).toEqual({ state: "empty", canon: null });
    expect(hkidInputState("   ").state).toBe("empty");
    for (const t of ["A", "A1234", "A123456", "A123456(", "1234567(8)", "AB12345(6"]) expect(hkidInputState(t).state).toBe("partial");
    expect(hkidInputState("A123456(7)")).toEqual({ state: "bad_check", canon: "A1234567" });
    expect(hkidInputState("A123456(3)")).toEqual({ state: "valid", canon: "A1234563" });
  });
  it("接受全形括號／全形英數／空格／小寫（canonical 後送出）", () => {
    for (const t of ["A123456（3）", "a123456(3)", " A 123456 ( 3 ) ", "Ａ１２３４５６（３）", "a1234563"]) expect(hkidInputState(t)).toEqual({ state: "valid", canon: "A1234563" });
    expect(hkidInputState("ａ１２３４５６（７）").state).toBe("bad_check");
  });
  it("identity.ts re-export 同純模組同一函數行為；hkid-pure 冇 import 任何 server 依賴", () => {
    expect(identity.canonicalHkid("A123456(3)")).toBe(canonicalHkid("A123456(3)"));
    expect(identity.hkidCheckDigitValid("A123456(3)")).toBe(hkidCheckDigitValid("A123456(3)"));
    expect(formatHkid("A1234563")).toBe("A123456(3)");
    const src = readFileSync("src/lib/guards/hkid-pure.ts", "utf-8");
    expect(src).not.toMatch(/^import /m);
  });
});
