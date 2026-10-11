// P6.4：CSRF defense-in-depth（Origin／Sec-Fetch-Site）＋安全 response headers。
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { checkCsrf } from "@/lib/api/csrf";
import { middleware, config } from "@/middleware";
import nextConfig from "../next.config";

const h = (o: Record<string, string>) => new Headers(o);

describe("checkCsrf（純函數）", () => {
  it("GET／HEAD／OPTIONS 永遠放行（即使 cross-site）", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect(checkCsrf(m, h({ "sec-fetch-site": "cross-site" })).ok).toBe(true);
  });
  it("Sec-Fetch-Site: same-origin／none 放行；same-site、cross-site 拒絕", () => {
    expect(checkCsrf("POST", h({ "sec-fetch-site": "same-origin" })).ok).toBe(true);
    expect(checkCsrf("DELETE", h({ "sec-fetch-site": "none" })).ok).toBe(true);
    expect(checkCsrf("POST", h({ "sec-fetch-site": "cross-site" })).ok).toBe(false);
    expect(checkCsrf("PATCH", h({ "sec-fetch-site": "same-site" })).ok).toBe(false);
  });
  it("Sec-Fetch-Site 優先：即使 Origin 同 Host 一樣，cross-site 照拒", () => {
    expect(checkCsrf("POST", h({ "sec-fetch-site": "cross-site", origin: "https://a.test", host: "a.test" })).ok).toBe(false);
  });
  it("冇 Sec-Fetch-Site：Origin host 要等於 Host（或 X-Forwarded-Host）", () => {
    expect(checkCsrf("POST", h({ origin: "https://app.example.com", host: "app.example.com" })).ok).toBe(true);
    expect(checkCsrf("POST", h({ origin: "https://app.example.com", host: "internal:3000", "x-forwarded-host": "app.example.com" })).ok).toBe(true);
    expect(checkCsrf("POST", h({ origin: "https://evil.example", host: "app.example.com" })).ok).toBe(false);
    expect(checkCsrf("POST", h({ origin: "null", host: "app.example.com" })).ok).toBe(false);
  });
  it("兩個 header 都冇（curl／server-to-server／Playwright request API）→ 放行", () => {
    expect(checkCsrf("POST", h({ host: "app.example.com" })).ok).toBe(true);
  });
});

describe("middleware：/api/* 非 GET", () => {
  it("matcher 係 /api/:path*", () => {
    expect(config.matcher).toBe("/api/:path*");
  });
  it("cross-site POST → 403 csrf_blocked；same-origin POST 放行（NextResponse.next）", async () => {
    const bad = middleware(new NextRequest("http://localhost:3000/api/sites", { method: "POST", headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } }));
    expect(bad.status).toBe(403);
    expect((await bad.json()).error).toBe("csrf_blocked");
    const good = middleware(new NextRequest("http://localhost:3000/api/sites", { method: "POST", headers: { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" } }));
    expect(good.status).toBe(200);
    expect(good.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("next.config headers", () => {
  it("全站 X-Frame-Options DENY／nosniff／Referrer-Policy same-origin", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    const map = Object.fromEntries(all.headers.map((x) => [x.key, x.value]));
    expect(map["X-Frame-Options"]).toBe("DENY");
    expect(map["X-Content-Type-Options"]).toBe("nosniff");
    expect(map["Referrer-Policy"]).toBe("same-origin");
  });
});
