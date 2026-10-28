// WA-9 (9)：2026-10-28 早上真數據三項——E 盤別名當人名、F 全庫近似候選、G LLM 路徑單一更別。純記憶體，假名假數據。
import { describe, it, expect } from "vitest";
import { buildGuardMatchIndex } from "@/lib/roster-upload/match";
import { resolveIntents, resolveShift, type ResolveContext, type ResolveRepo, type ShiftTypeLite } from "@/lib/whatsapp/resolve";
import { personForName } from "@/lib/whatsapp/roster-resolve";
import { normNameNear, normNameVariant } from "@/lib/names/variants";
import type { ParsedIntent } from "@/lib/whatsapp/parse";

const FRI = new Date("2026-10-16T05:00:00Z");
const SA = "site-a"; // 掛咗「欣明」別名
const SB = "site-b"; // 單一更別、冇開工時間
const SC = "site-c"; // 掛咗「測試甲」別名（撞人名）
const guards = [
  { id: "g1", nameZh: "測試甲", tel: "90000011", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g2", nameZh: "陳測試", tel: "90000012", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g3", nameZh: "孫測一", tel: "90000013", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g4", nameZh: "孫璧", tel: "90000014", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g5", nameZh: "周大", tel: "90000015", staffNo: null, staffNoMw: null, nameAliases: [] },
];
const index = buildGuardMatchIndex({ guards, staffNumbers: [], phones: [] });
const sites = [
  { id: SA, canonicalName: "測試盤甲", aliases: ["欣明"], client: "客戶一", brokerId: "b1" },
  { id: SB, canonicalName: "測試盤乙", aliases: ["厚測"], client: "客戶二", brokerId: "b2" },
  { id: SC, canonicalName: "測試盤丙", aliases: ["測試甲", "丙盤"], client: "客戶三", brokerId: "b3" },
];
const types: Record<string, ShiftTypeLite[]> = {
  [SA]: [{ id: "ta-n", siteId: SA, code: "N", label: "夜更", startHour: 19 }],
  [SB]: [{ id: "tb-pr", siteId: SB, code: "PR", label: null, startHour: null }],
  [SC]: [{ id: "tc-n", siteId: SC, code: "N", label: "夜更", startHour: 19 }, { id: "tc-d", siteId: SC, code: "D", label: "日更", startHour: 7 }],
};
const repo: ResolveRepo = {
  shiftTypes: async (s) => types[s] ?? [],
  recentGuardIdsAtSite: async () => new Set(),
  recentGuardIdsOfBroker: async () => new Set(),
  existing: async () => [],
  headcount: async () => ({ required: null, current: 0 }),
  quota: async () => null,
  monthLocked: async () => false,
};
const brokerCtx = (brokerId = "b1"): ResolveContext => ({ ts: FRI, group: { id: "grpB", kind: "broker", siteId: null, brokerId, shiftWordMap: { 夜: "N" }, autoWrite: true }, senderGuardId: "g5", senderTelNorm: "90000015", sites, index, repo });
const mk = (over: Partial<ParsedIntent> = {}): ParsedIntent => ({ type: "shift", date: { raw: "聽日", kind: "relative" }, site_raw: null, persons: [], self_reference: false, shift_raw: "夜", shift_code_guess: null, hours: null, leave_raw: null, leave_code_guess: null, confidence: 0.9, ...over }) as ParsedIntent;
const one = async (i: ParsedIntent, c: ResolveContext) => (await resolveIntents([i], c))[0]!;

describe("WA-9 (9) E：LLM 把盤別名當人名", () => {
  it("「欣明夜更」persons=[欣明] → site 解到掛別名嘅盤、冇人名（用發訊人）", async () => {
    const r = await one(mk({ persons: [{ raw: "欣明", role: "worker" }] }), brokerCtx());
    expect(r.siteId).toBe(SA);
    expect(r.resolution.reasons).not.toContain("site_ambiguous");
    expect(r.resolution.reasons).not.toContain("person_unknown");
    expect(r.guardId).toBe("g5");
    expect(r.resolution.basis.site).toBe("person_was_site_alias");
    expect(r.resolution.notes).toContain("person_was_site_alias");
    expect(r.src?.site_raw).toBe("欣明");
    expect(r.routed).toBe("triage"); // 當發訊人冇第二重證據 → 確認題，唔自動寫
    expect(r.resolution.reasons).toContain("person_was_site_alias");
  });
  it("撞名保護：「欣明」同時係保安員別名 → 唔搬、唔變發訊人、唔 auto_write", async () => {
    const idx2 = buildGuardMatchIndex({ guards: [...guards, { id: "g6", nameZh: "林測欣", tel: "90000016", staffNo: null, staffNoMw: null, nameAliases: ["欣明"] }], staffNumbers: [], phones: [] });
    const r = await one(mk({ persons: [{ raw: "欣明", role: "worker" }] }), { ...brokerCtx(), index: idx2 });
    expect(r.guardId).toBe("g6");
    expect(r.guardId).not.toBe("g5");
    expect(r.resolution.notes).not.toContain("person_was_site_alias");
    expect(r.routed).not.toBe("auto_write"); // 盤口未明（判頭群冇 site_raw）
    const rs = await one(mk({ persons: [{ raw: "欣明", role: "worker" }] }), { ...brokerCtx(), index: idx2, group: { id: "grpS", kind: "site", siteId: SA, brokerId: null, shiftWordMap: { 夜: "N" }, autoWrite: true } });
    expect(rs.guardId).toBe("g6");
    expect(rs.siteId).toBe(SA);
  });
  it("發訊人唔係保安員 → 冇名路徑 person_unknown", async () => {
    const r = await one(mk({ persons: [{ raw: "欣明", role: "worker" }] }), { ...brokerCtx(), senderGuardId: null, senderTelNorm: "90009999" });
    expect(r.siteId).toBe(SA);
    expect(r.resolution.reasons).toContain("person_unknown");
  });
  it("「陳測試夜更」唔受影響（真人名照配）", async () => {
    const r = await one(mk({ persons: [{ raw: "陳測試", role: "worker" }] }), brokerCtx());
    expect(r.guardId).toBe("g2");
    expect(r.resolution.notes).not.toContain("person_was_site_alias");
    expect(r.resolution.reasons).toContain("site_ambiguous"); // 照舊
  });
  it("persons 兩個、只搬係盤名（唔係人名）嗰個；撞名者唔搬", async () => {
    const r = await one(mk({ persons: [{ raw: "丙盤", role: "worker" }, { raw: "陳測試", role: "worker" }] }), brokerCtx("b3"));
    expect(r.siteId).toBe(SC);
    expect(r.guardId).toBe("g2");
    expect(r.src?.site_raw).toBe("丙盤");
    // 別名「測試甲」同保安員全名撞 → 唔搬，照人名解析
    const c = await one(mk({ persons: [{ raw: "測試甲", role: "worker" }] }), brokerCtx("b3"));
    expect(c.guardId).toBe("g1");
    expect(c.resolution.notes).not.toContain("person_was_site_alias");
  });
  it("site_raw 已有 → 唔搬（人名照解）", async () => {
    const r = await one(mk({ site_raw: "測試盤乙", persons: [{ raw: "測試甲", role: "worker" }] }), brokerCtx("b3"));
    expect(r.siteId).toBe(SB);
    expect(r.guardId).toBe("g1");
  });
  it("只做完全等於：「欣明哥」唔搬", async () => {
    const r = await one(mk({ persons: [{ raw: "欣明哥", role: "worker" }] }), brokerCtx());
    expect(r.resolution.notes).not.toContain("person_was_site_alias");
  });
});

describe("WA-9 (9) F：全庫近似候選", () => {
  it("normNameNear 折疊壁／璧，normNameVariant（精確）唔折", () => {
    expect(normNameNear("孫壁")).toBe(normNameNear("孫璧"));
    expect(normNameVariant("孫壁")).not.toBe(normNameVariant("孫璧"));
  });
  it("名單：scope 冇、全庫同姓共用字（孫測壹 vs 孫測一）→ person_ambiguous roster_name_near_global", () => {
    const p = personForName(index, "孫測壹", new Set(["g5"]));
    expect(p).toMatchObject({ guardId: null, reasons: ["person_ambiguous"], basis: "roster_name_near_global" });
    expect(p.candidates).toEqual(["g3"]);
  });
  it("名單：壁／璧混淆字（孫壁 → 孫璧）→ 候選，唔自動配", () => {
    const p = personForName(index, "孫壁", new Set());
    expect(p.guardId).toBeNull();
    expect(p.candidates).toContain("g4");
    expect(p.basis).toBe("roster_name_near_global");
  });
  it("稱謂尾（孫小姐／孫生）→ 唔出全庫候選", () => {
    expect(personForName(index, "孫小姐", new Set())).toMatchObject({ reasons: ["person_unknown"] });
    expect(personForName(index, "孫生", new Set())).toMatchObject({ reasons: ["person_unknown"] });
  });
  it("名單：完全唔似（異姓）→ 仍 person_unknown", () => {
    expect(personForName(index, "吳某某", new Set())).toMatchObject({ reasons: ["person_unknown"], candidates: [] });
  });
  it("LLM 路徑：精確配唔到 → person_ambiguous name_near_global", async () => {
    const r = await one(mk({ site_raw: "測試盤甲", persons: [{ raw: "孫測壹", role: "worker" }] }), brokerCtx());
    expect(r.guardId).toBeNull();
    expect(r.resolution.reasons).toContain("person_ambiguous");
    expect(r.resolution.basis.person).toBe("name_near_global");
    expect(r.resolution.candidates.guard_ids).toEqual(["g3"]);
  });
});

describe("WA-9 (9) G：LLM 路徑單一更別", () => {
  it("單一更別（無開工時間）「夜更」→ 配到 single_shift_type", async () => {
    const r = await one(mk({ site_raw: "測試盤乙", self_reference: true, shift_raw: "夜更" }), { ...brokerCtx("b2"), group: { ...brokerCtx("b2").group, shiftWordMap: {} } });
    expect(r.shiftTypeId).toBe("tb-pr");
    expect(r.resolution.basis.shift).toBe("single_shift_type");
    expect(r.resolution.reasons).not.toContain("shift_unmapped");
  });
  it.each(["OT", "加班", "半更", "補鐘", "4小時", "夜間", "N", "N更", "休息", "off", "請假", "日更", "D"])("單一更別（夜更盤 startHour 19／無開工時間盤）「%s」→ 仍 shift_unmapped", (w) => {
    const night = [{ id: "n", siteId: SC, code: "X", label: null, startHour: 19 }];
    const day = [{ id: "d", siteId: SC, code: "X", label: null, startHour: 8 }];
    const none = [{ id: "z", siteId: SC, code: "X", label: null, startHour: null }];
    for (const t of [night, day, none]) expect(resolveShift(w, null, t, {}), `${w}`).toMatchObject({ shiftTypeId: null, reasons: ["shift_unmapped"] });
  });
  it.each(["返工", "開工", "返工更", "開工 "])("單一更別「%s」→ single_shift_type", (w) => {
    expect(resolveShift(w, null, types[SB]!, {})).toMatchObject({ basis: "single_shift_type", reasons: [] });
    expect(resolveShift(w, null, [{ id: "d", siteId: SC, code: "X", label: null, startHour: 8 }], {})).toMatchObject({ basis: "single_shift_type" });
  });
  it("兩個更別、冇時間資料 → 照舊 shift_unmapped", () => {
    const t = [{ id: "x1", siteId: SC, code: "PR", label: null, startHour: null }, { id: "x2", siteId: SC, code: "ST", label: null, startHour: null }];
    expect(resolveShift("夜更", null, t, {})).toMatchObject({ shiftTypeId: null, reasons: ["shift_unmapped"] });
  });
  it("shiftRaw 空 → 照舊 no_shift_word（唔套單一更別）", () => {
    expect(resolveShift("", null, types[SB]!, {})).toMatchObject({ shiftTypeId: null, basis: "no_shift_word" });
  });
  it("單一更別有開工時間但同講明時段矛盾（日更盤講夜更）→ 照舊 shift_unmapped", () => {
    expect(resolveShift("夜", null, [{ id: "d", siteId: SC, code: "D", label: null, startHour: 7 }], {})).toMatchObject({ shiftTypeId: null, reasons: ["shift_unmapped"] });
  });
});
