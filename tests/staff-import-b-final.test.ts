// WP-STAFF-IMPORT 最終細修：keep_pending 淨准 name_zh；normAddr 保留 CJK 擴展區。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser } from "./fixtures/wp2-fixture";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { hashPackage, importPackageSchema } from "@/lib/guards/import/package";
import { normAddr } from "../scripts/staff-import/lib/person-fields";

const f = (value: string | null, status: "confirmed" | "review" | "missing") => ({ value, status });
const pkg = importPackageSchema.parse({
  version: 2,
  generatedAt: "2026-10-03T00:00:00.000Z",
  persons: [{ key: "k1", hkid: f("A1234563", "confirmed"), nameZh: f("導入測試員甲", "review"), nameEn: f(null, "missing"), dateOfBirth: f(null, "missing"), sex: f(null, "missing"), phone: f(null, "missing"), address: f(null, "missing"), staffNumbers: [], rating: "review", reasons: [] }],
});

describe("keep_pending 淨准 name_zh", () => {
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  const call = (decisions: unknown) =>
    applyRoute(new Request("http://t/api/guards/import/apply", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ package: pkg, package_hash: hashPackage(pkg), decisions }) }));

  it("其他欄帶 keep_pending → 400；name_zh 帶 → 200", async () => {
    for (const field of ["name_en", "date_of_birth", "phone", "address"]) {
      expect((await call({ k1: { [field]: { action: "keep_pending" } } })).status).toBe(400);
    }
    expect((await call({ k1: { name_zh: { action: "keep_pending" } } })).status).toBe(200);
  });
});

describe("normAddr 保留 CJK 擴展區", () => {
  it("擴展區 B 罕見字（U+20000）唔會被刪走，兩讀數差一個擴展區字＝唔一致", () => {
    const rare = String.fromCodePoint(0x20000);
    const extA = String.fromCodePoint(0x3400);
    expect(normAddr(`測試道${rare}號`)).toBe(`測試道${rare}號`);
    expect(normAddr(`測試道${extA}號`)).toBe(`測試道${extA}號`);
    expect(normAddr(`測試道${rare}號`)).not.toBe(normAddr("測試道號"));
    expect(normAddr(`測試道${rare}號`)).not.toBe(normAddr(`測試道${extA}號`));
    expect(normAddr("Ａ１ ｂ，c")).toBe("A1BC");
  });
});
