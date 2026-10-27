// WA-9 (8)：首晚真數據 A／B／C 三項（盤名前綴、人名黐工號、判頭群時間段）。純記憶體，零 DB。全部假名／9 字頭假工號。
import { describe, it, expect } from "vitest";
import { buildGuardMatchIndex } from "@/lib/roster-upload/match";
import { resolveIntents, resolveShift, parseTimeRangeStart, stripStaffToken, isGroupNamePrefix, type ResolveContext, type ResolveRepo, type ShiftTypeLite } from "@/lib/whatsapp/resolve";
import type { ParsedIntent } from "@/lib/whatsapp/parse";

const TS = new Date("2026-10-16T05:00:00Z"); // HK 2026-10-16 13:00
const mk = (over: Partial<ParsedIntent> = {}): ParsedIntent => ({ type: "shift", date: { raw: "聽日", kind: "relative" }, site_raw: null, persons: [], self_reference: false, shift_raw: "早", shift_code_guess: null, hours: null, leave_raw: null, leave_code_guess: null, confidence: 0.9, ...over }) as ParsedIntent;
const repoOf = (types: (siteId: string) => ShiftTypeLite[]): ResolveRepo => ({
  shiftTypes: async (s) => types(s),
  recentGuardIdsAtSite: async () => new Set(),
  recentGuardIdsOfBroker: async () => new Set(),
  existing: async () => [],
  headcount: async () => ({ required: null, current: 0 }),
  quota: async () => null,
  monthLocked: async () => false,
});
const defaultTypes = (siteId: string): ShiftTypeLite[] => [{ id: `t-${siteId}`, siteId, code: "A", label: "早更", startHour: 7 }];

describe("WA-9 (8) A：群盤名前綴", () => {
  const G = "site-cp5";
  const SIB = "site-cp14";
  const OTHER = "site-x";
  const sites = [
    { id: G, canonicalName: "數碼港 CP5", aliases: [], client: "測試客甲" },
    { id: SIB, canonicalName: "數碼港 CP1-4", aliases: ["數碼港"], client: "測試客甲" },
    { id: OTHER, canonicalName: "測試別客戶盤", aliases: ["別客戶區"], client: "測試客乙" },
  ];
  const ctx = (): ResolveContext => ({
    ts: TS,
    group: { id: "grpG", kind: "site", siteId: G, brokerId: null, shiftWordMap: { 早: "A" }, autoWrite: true },
    senderGuardId: null,
    senderTelNorm: null,
    sites,
    index: buildGuardMatchIndex({ guards: [{ id: "g1", nameZh: "測試甲", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] }], staffNumbers: [], phones: [] }),
    repo: repoOf(defaultTypes),
  });
  const site = async (raw: string) => (await resolveIntents([mk({ site_raw: raw, persons: [{ raw: "測試甲", role: "worker" }] })], ctx()))[0]!;

  it("文字「數碼港」（群盤名「數碼港 CP5」嘅前綴，別名只掛兄弟盤）→ 群盤，唔出 site_ambiguous，basis group_name_prefix", async () => {
    const r = await site("數碼港");
    expect(r.siteId).toBe(G);
    expect(r.resolution.reasons).not.toContain("site_ambiguous");
    expect(r.resolution.basis.site).toBe("group_name_prefix");
    expect(r.routed).toBe("auto_write");
  });
  it("空格分隔 token「CP5」、去空格前綴「數碼港CP」→ 群盤", async () => {
    expect((await site("CP5")).resolution.basis.site).toBe("group_name_prefix");
    expect((await site("數碼港cp")).resolution.basis.site).toBe("group_name_prefix");
  });
  it("過短文字（「CP」「數」）唔命中前綴 → 照舊（text_unknown 出題）", async () => {
    for (const t of ["CP", "數"]) {
      const r = await site(t);
      expect(r.resolution.basis.site).not.toBe("group_name_prefix");
      expect(r.resolution.reasons).toContain("site_ambiguous");
    }
  });
  it("明確指兄弟盤（「數碼港 CP1-4」）→ 仍然 sibling_site_text 出題；唔同客戶盤 → other_client_site", async () => {
    const a = await site("數碼港 CP1-4");
    expect(a.resolution.basis.site).toBe("sibling_site_text");
    expect(a.resolution.reasons).toContain("site_ambiguous");
    expect((await site("別客戶區")).resolution.basis.site).toBe("other_client_site");
  });
  it("isGroupNamePrefix：純 ASCII 要 ≥3 字；別名一樣算", () => {
    expect(isGroupNamePrefix("cp", ["數碼港 CP5"])).toBe(false);
    expect(isGroupNamePrefix("數碼", ["數碼港 CP5"])).toBe(true);
    expect(isGroupNamePrefix("港區", ["數碼港 CP5", "港區大樓"])).toBe(true);
    expect(isGroupNamePrefix("碼港", ["數碼港 CP5"])).toBe(false);
  });
});

describe("WA-9 (8) B：人名黐住工號", () => {
  const S1 = "site-1";
  const index = buildGuardMatchIndex({
    guards: [
      { id: "g1", nameZh: "孫測壹", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] },
      { id: "g2", nameZh: "陳測貳", tel: null, staffNo: null, staffNoMw: null, nameAliases: [] },
    ],
    staffNumbers: [
      { number: "U90369", guardId: "g1", status: "current" },
      { number: "U90370", guardId: "g2", status: "current" },
      { number: "MP9123", guardId: "g2", status: "current" },
    ],
    phones: [],
  });
  const ctx = (): ResolveContext => ({
    ts: TS,
    group: { id: "grp1", kind: "site", siteId: S1, brokerId: null, shiftWordMap: { 早: "A" }, autoWrite: true },
    senderGuardId: null,
    senderTelNorm: null,
    sites: [{ id: S1, canonicalName: "測試盤", aliases: [] }],
    index,
    repo: repoOf(defaultTypes),
  });
  const who = async (raw: string) => (await resolveIntents([mk({ persons: [{ raw, role: "worker" }] })], ctx()))[0]!;

  it("stripStaffToken：開頭／結尾、O→0、全形、MP 前綴；全 O 唔當工號", () => {
    expect(stripStaffToken("U90369孫測壹")).toEqual({ number: "U90369", rest: "孫測壹" });
    expect(stripStaffToken("U9O369孫測壹")).toEqual({ number: "U90369", rest: "孫測壹" });
    expect(stripStaffToken("Ｕ90369 孫測壹")).toEqual({ number: "U90369", rest: "孫測壹" });
    expect(stripStaffToken("孫測壹 u9O369")).toEqual({ number: "U90369", rest: "孫測壹" });
    expect(stripStaffToken("MP9123陳測貳")).toEqual({ number: "MP9123", rest: "陳測貳" });
    expect(stripStaffToken("孫測壹")).toBeNull();
    expect(stripStaffToken("UOOO孫測壹")).toBeNull();
  });
  it("工號＋名黐埋（工號、名一致）→ 直接配到，basis staff_number，auto_write", async () => {
    const r = await who("U90369孫測壹");
    expect(r.guardId).toBe("g1");
    expect(r.resolution.basis.person).toBe("staff_number");
    expect(r.routed).toBe("auto_write");
  });
  it("字母 O 被轉 0／混用（U9O369）都得；只有工號都得；名喺前、號喺後都得", async () => {
    expect((await who("U9O369孫測壹")).guardId).toBe("g1");
    expect((await who("U90369")).guardId).toBe("g1");
    expect((await who("陳測貳 MP9123")).guardId).toBe("g2");
  });
  it("工號指甲、名係乙 → person_ambiguous，候選兩個", async () => {
    const r = await who("U90370孫測壹");
    expect(r.guardId).toBeNull();
    expect(r.resolution.reasons).toContain("person_ambiguous");
    expect([...(r.resolution.candidates.guard_ids ?? [])].sort()).toEqual(["g1", "g2"]);
    expect(r.resolution.basis.person).toBe("staff_number_name_mismatch");
  });
  it("工號查唔到 → 用剝走工號後嘅淨名配；淨名都唔識／只有未知工號 → person_unknown", async () => {
    const a = await who("U90999孫測壹");
    expect(a.guardId).toBe("g1");
    expect(a.resolution.basis.person).toBe("name");
    expect((await who("U90999無此人")).resolution.reasons).toContain("person_unknown");
    expect((await who("U90999")).resolution.reasons).toContain("person_unknown");
  });
});

describe("WA-9 (8) C：判頭群時間段更別", () => {
  const cb: ShiftTypeLite[] = [
    { id: "d", siteId: "s", code: "D", label: "日更", startHour: 7, startMinute: 0 },
    { id: "n", siteId: "s", code: "N", label: "夜更", startHour: 19, startMinute: 0 },
  ];
  const hku: ShiftTypeLite[] = [
    { id: "c1", siteId: "s", code: "C1", label: null, startHour: 22, startMinute: 0 },
    { id: "c", siteId: "s", code: "C", label: null, startHour: 23, startMinute: 0 },
    { id: "ot1", siteId: "s", code: "OT1", label: null, startHour: 6, startMinute: 15 },
  ];
  const r = (raw: string, types: ShiftTypeLite[]) => resolveShift(raw, null, types, {});

  it("parseTimeRangeStart：各種分隔符；「一」只喺前後都係數字時先當分隔；非時間段 null", () => {
    expect(parseTimeRangeStart("0700一1900")).toEqual({ hour: 7, minute: 0 });
    expect(parseTimeRangeStart("2200-0615")).toEqual({ hour: 22, minute: 0 });
    expect(parseTimeRangeStart("0615－1500")).toEqual({ hour: 6, minute: 15 });
    expect(parseTimeRangeStart("07:00-19:00")).toEqual({ hour: 7, minute: 0 });
    expect(parseTimeRangeStart("700至1900")).toEqual({ hour: 7, minute: 0 });
    expect(parseTimeRangeStart("一更")).toBeNull();
    expect(parseTimeRangeStart("第一更 1900")).toBeNull();
    expect(parseTimeRangeStart("早更")).toBeNull();
  });
  it("城巴式：0700一1900 → D；1900-0700 → N（basis time_range_start）", () => {
    expect(r("0700一1900", cb)).toMatchObject({ shiftTypeId: "d", reasons: [], basis: "time_range_start" });
    expect(r("1900-0700", cb)).toMatchObject({ shiftTypeId: "n", basis: "time_range_start" });
    expect(r("07:00-19:00", cb)).toMatchObject({ shiftTypeId: "d" });
  });
  it("HKU 式：2200-0615 → C1；2300－0700 → C；0615-1500 → OT1（分鐘要相等）", () => {
    expect(r("2200-0615", hku)).toMatchObject({ shiftTypeId: "c1", basis: "time_range_start" });
    expect(r("2300－0700", hku)).toMatchObject({ shiftTypeId: "c" });
    expect(r("0615-1500", hku)).toMatchObject({ shiftTypeId: "ot1" });
  });
  it("同一開始鐘數多個更別（無分鐘資料）→ shift_ambiguous 候選", () => {
    const two: ShiftTypeLite[] = [{ id: "a", siteId: "s", code: "A", label: null, startHour: 7 }, { id: "b", siteId: "s", code: "B", label: null, startHour: 7 }];
    const x = r("0700-1900", two);
    expect(x.shiftTypeId).toBeNull();
    expect(x.reasons).toEqual(["shift_ambiguous"]);
    expect(x.candidates.sort()).toEqual(["a", "b"]);
  });
  it("開始時間唔完全相等 → 跌落時段 bucket（0830 → 早段 D）；該段冇更別 → shift_unmapped", () => {
    expect(r("0830-1700", cb)).toMatchObject({ shiftTypeId: "d", basis: "time_range_bucket" });
    expect(r("1200-1300", cb)).toMatchObject({ shiftTypeId: null, reasons: ["shift_unmapped"] });
  });
  it("「一更」等字照舊唔受影響（走原有路徑）", () => {
    expect(r("一更", cb).basis).not.toMatch(/time_range/);
    expect(r("夜更", cb)).toMatchObject({ shiftTypeId: "n", basis: "time_slot" });
  });
});
