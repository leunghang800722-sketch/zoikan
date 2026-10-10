// P3-3：舊路徑保留（redirect），唔 404。page 係 server component，直接 call 佢，攞 NEXT_REDIRECT 嘅目標。
import { describe, expect, it } from "vitest";
import ShortfallRedirectPage from "@/app/(app)/reports/shortfall/page";

async function target(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    const m = /^NEXT_REDIRECT;[^;]*;([^;]*);/.exec(digest);
    if (m) return m[1]!;
    throw e;
  }
  throw new Error("冇 redirect");
}

describe("P3-3 舊路徑 redirect", () => {
  it("/reports/shortfall → /（保留合法 ?date=）", async () => {
    expect(await target(() => ShortfallRedirectPage({ searchParams: Promise.resolve({}) }))).toBe("/");
    expect(await target(() => ShortfallRedirectPage({ searchParams: Promise.resolve({ date: "2026-07-15" }) }))).toBe("/?date=2026-07-15");
    expect(await target(() => ShortfallRedirectPage({ searchParams: Promise.resolve({ date: "<x>" }) }))).toBe("/");
  });
});
