import { describe, it, expect, afterEach } from "vitest";
import { getClientIp } from "@/lib/api/http";

const r = (h: Record<string, string>) => new Request("http://t.local/x", { headers: h });

describe("getClientIp", () => {
  afterEach(() => { delete process.env.TRUSTED_PROXY_HOPS; });
  it("x-real-ip 優先", () => {
    expect(getClientIp(r({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("9.9.9.9");
  });
  it("hops=1（預設）取最右；hops=2 取右二", () => {
    const h = { "x-forwarded-for": "6.6.6.6, 1.1.1.1, 2.2.2.2" };
    expect(getClientIp(r(h))).toBe("2.2.2.2");
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(getClientIp(r(h))).toBe("1.1.1.1");
    process.env.TRUSTED_PROXY_HOPS = "9";
    expect(getClientIp(r(h))).toBe("6.6.6.6");
  });
  it("無效值退 1；都冇 → null", () => {
    for (const v of ["abc", "0", "-1", "1.5", ""]) {
      process.env.TRUSTED_PROXY_HOPS = v;
      expect(getClientIp(r({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("2.2.2.2");
    }
    expect(getClientIp(r({}))).toBeNull();
  });
});
