// WP-STAFF-IMPORT B2：更表配對加電話層＋match_basis＋name_only 警告。合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { buildGuardMatchIndex, matchGuard } from "@/lib/roster-upload/match";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as getUpload } from "@/app/api/roster-uploads/[id]/route";
import { GET as pendingSummary } from "@/app/api/roster-uploads/pending-summary/route";
import { stepPrecheck } from "@/lib/month-close/one-click";

function mkIndex(
  guards: Array<{ id: string; nameZh: string; tel?: string | null; staffNo?: string | null; aliases?: string[] }>,
  phones: Array<{ guardId: string; tel: string }> = [],
  staffNumbers: Array<{ number: string; guardId: string; status: string }> = [],
) {
  return buildGuardMatchIndex({
    guards: guards.map((g) => ({ id: g.id, nameZh: g.nameZh, tel: g.tel ?? null, staffNo: g.staffNo ?? null, staffNoMw: null, nameAliases: g.aliases ?? [] })),
    staffNumbers,
    phones,
  });
}

describe("matchGuard：match_basis 與電話層", () => {
  const idx = mkIndex(
    [
      { id: "g1", nameZh: "測試保安員甲", aliases: ["阿甲"] },
      { id: "g2", nameZh: "測試保安員乙" },
      { id: "g3", nameZh: "測試保安員丙" },
    ],
    [
      { guardId: "g1", tel: "91234567" },
      { guardId: "g2", tel: "61234567" },
    ],
    [{ number: "U90001", guardId: "g3", status: "current" }],
  );

  it("工號優先：basis=staff_no", () => {
    expect(matchGuard({ staffNoRaw: "U90001", nameRaw: "測試保安員丙", telRaw: "91234567" }, idx)).toMatchObject({ guardId: "g3", matchBasis: "staff_no" });
  });
  it("電話唯一 + 姓名夾：basis=name_tel；別名夾：alias", () => {
    expect(matchGuard({ staffNoRaw: null, nameRaw: "測試保安員甲", telRaw: "9123 4567" }, idx)).toMatchObject({ guardId: "g1", guardMatch: "by_name_tel", matchBasis: "name_tel" });
    expect(matchGuard({ staffNoRaw: null, nameRaw: "阿甲", telRaw: "91234567" }, idx)).toMatchObject({ guardId: "g1", matchBasis: "alias", matchedViaAlias: true });
  });
  it("電話唯一但姓名唔同：basis=tel，flag telMatchNameDiffers", () => {
    expect(matchGuard({ staffNoRaw: null, nameRaw: "寫錯咗嘅名", telRaw: "+852 91234567" }, idx)).toMatchObject({ guardId: "g1", matchBasis: "tel", telMatchNameDiffers: true });
  });
  it("電話對到 A、姓名唯一對到 B → ambiguous（telNameConflict），唔自動配", () => {
    expect(matchGuard({ staffNoRaw: null, nameRaw: "測試保安員乙", telRaw: "91234567" }, idx)).toMatchObject({ guardId: null, guardMatch: "ambiguous", telNameConflict: true });
  });
  it("淨姓名（無電話）：basis=name_only；別名淨配：alias", () => {
    expect(matchGuard({ staffNoRaw: null, nameRaw: "測試保安員乙", telRaw: null }, idx)).toMatchObject({ guardId: "g2", guardMatch: "by_name", matchBasis: "name_only" });
    expect(matchGuard({ staffNoRaw: null, nameRaw: "阿甲", telRaw: null }, idx)).toMatchObject({ guardId: "g1", matchBasis: "alias" });
  });
  it("配唔到：basis=null", () => {
    expect(matchGuard({ staffNoRaw: null, nameRaw: "冇呢個人", telRaw: "50000000" }, idx)).toMatchObject({ guardId: null, guardMatch: "unmatched", matchBasis: null });
  });
  it("電話層冇改變原有結果：電話唔存在於 DB 時行為同冇電話層一樣", () => {
    const withTel = matchGuard({ staffNoRaw: null, nameRaw: "測試保安員乙", telRaw: "50000000" }, idx);
    const without = matchGuard({ staffNoRaw: null, nameRaw: "測試保安員乙", telRaw: "50000000" }, { ...idx, byTel: undefined });
    expect(withTel.guardId).toBe(without.guardId);
    expect(withTel.guardMatch).toBe(without.guardMatch);
  });
});

describe("name_only 警告（上載詳情／pending-summary／precheck）", () => {
  let fx: Wp2Fixture;
  let cookie: string;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    cookie = await sessionCookieForUser(fx.userIds["老闆"]);
  });

  it("三處都見到 name_only 格數", async () => {
    const month = new Date("2026-10-01T00:00:00.000Z");
    const up = await prisma.rosterUpload.create({
      data: { month, siteId: fx.site.id, siteNameRaw: "測試盤", uploaderUserId: fx.userIds["老闆"], fileName: "x.xlsx", fileSha256: "sha-b2", fileBytes: Buffer.from("x"), fileSize: 1, status: "parsed" },
    });
    const base = { uploadId: up.id, workDate: new Date("2026-10-02T00:00:00.000Z"), rawCode: "D", codeKind: "shift" as const, guardId: fx.guardA.id };
    await prisma.rosterUploadRow.create({ data: { ...base, rowIndex: 1, guardMatch: "by_name", matchBasis: "name_only" } });
    await prisma.rosterUploadRow.create({ data: { ...base, rowIndex: 2, guardMatch: "by_name", matchBasis: "name_only" } });
    await prisma.rosterUploadRow.create({ data: { ...base, rowIndex: 3, guardMatch: "by_staff_no", matchBasis: "staff_no" } });

    const res = await getUpload(new Request(`http://t/api/roster-uploads/${up.id}?match_basis=name_only`, { headers: { cookie } }), { params: Promise.resolve({ id: up.id }) });
    const body = await res.json();
    expect(body.name_only_count).toBe(2);
    expect(body.name_only_warning).toContain("淨靠姓名配對");
    expect(body.rows.rows.length).toBe(2);
    expect(body.rows.rows[0].match_basis).toBe("name_only");

    const ps = await (await pendingSummary(new Request("http://t/api/roster-uploads/pending-summary?months=0", { headers: { cookie } }))).json();
    expect(ps.name_only.total).toBe(2);
    expect(ps.name_only.entries[0].name_only_count).toBe(2);

    const pre = await stepPrecheck(month, fx.userIds["老闆"], null);
    expect(pre.numbers.nameOnlyCells).toBe(2);
    expect(pre.warnings.some((w) => w.includes("淨靠姓名配對，建議補工號或電話"))).toBe(true);
  });
});

describe("人手 reparse 鎖月 403", () => {
  it("已鎖月份 → 403；未鎖 → 照行", async () => {
    const { POST } = await import("@/app/api/roster-uploads/[id]/reparse/route");
    await clearAll();
    const fx = await seedWp2Fixture();
    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const up = await prisma.rosterUpload.create({
      data: { month: fx.lockedMonth, siteId: fx.site.id, siteNameRaw: "測試盤", uploaderUserId: fx.userIds["老闆"], fileName: "x.xlsx", fileSha256: "sha-lock", fileBytes: Buffer.from("x"), fileSize: 1, status: "parsed" },
    });
    const res = await POST(new Request(`http://t/api/roster-uploads/${up.id}/reparse`, { method: "POST", headers: { cookie } }), { params: Promise.resolve({ id: up.id }) });
    expect(res.status).toBe(403);
  });
});
