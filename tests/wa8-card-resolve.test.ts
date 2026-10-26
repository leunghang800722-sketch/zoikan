// WA-8 C：工卡相歸屬（人／日期／盤／更）——記憶體 repo＋假 deps，零 DB。全部假名、假工號（U9xxxx／MP9xxx）。
import { describe, it, expect } from "vitest";
import { buildGuardMatchIndex } from "@/lib/roster-upload/match";
import type { ResolveContext, ResolveRepo, ShiftTypeLite } from "@/lib/whatsapp/resolve";
import { resolveCardPhoto, shiftBySlot, type CardDeps, type CardInput } from "@/lib/whatsapp/card-resolve";
import type { CardPhotoResult, PhotoCard } from "@/lib/whatsapp/card-ocr";
import { pickWaKind, optionsForWa } from "@/lib/whatsapp/triage-types";

const S1 = "site-1";
const S2 = "site-2";
const MON_9AM = new Date("2026-10-19T01:00:00Z"); // HK 2026-10-19 09:00（星期一）
const DAWN = new Date("2026-10-18T18:30:00Z"); // HK 2026-10-19 02:30
const guards = [
  { id: "g1", nameZh: "測試甲", tel: "90000011", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g2", nameZh: "測試乙", tel: "90000012", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g3", nameZh: "測試同名", tel: "90000013", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g4", nameZh: "測試同名", tel: "90000014", staffNo: null, staffNoMw: null, nameAliases: [] },
];
const index = buildGuardMatchIndex({
  guards,
  staffNumbers: [
    { number: "U90001", guardId: "g1", status: "current" },
    { number: "MP9002", guardId: "g2", status: "current" },
    { number: "U90003", guardId: "g3", status: "former" },
  ],
  phones: [],
});
const types: Record<string, ShiftTypeLite[]> = {
  [S1]: [
    { id: "t-d", siteId: S1, code: "D", label: "日更", startHour: 8 },
    { id: "t-n", siteId: S1, code: "N", label: "夜更", startHour: 20 },
  ],
  [S2]: [{ id: "t2-d", siteId: S2, code: "D", label: "日更", startHour: 7 }, { id: "t2-e", siteId: S2, code: "E", label: "中更", startHour: 8 }],
};
const repo = (existing: Record<string, Array<{ id: string; siteId: string; shiftTypeId: string; recordType: "shift"; leaveCode: null; status: string }>> = {}): ResolveRepo => ({
  shiftTypes: async (s) => types[s] ?? [],
  recentGuardIdsAtSite: async () => new Set(),
  recentGuardIdsOfBroker: async () => new Set(),
  existing: async (g, d) => existing[`${g}|${d}`] ?? [],
  headcount: async () => ({ required: null, current: 0 }),
  quota: async () => null,
  monthLocked: async () => false,
});
const ctx = (over: Partial<ResolveContext> = {}, wordMap: Record<string, string> = {}): ResolveContext => ({
  ts: MON_9AM,
  group: { id: "grp", kind: "site", siteId: S1, brokerId: null, shiftWordMap: wordMap, autoWrite: true },
  senderGuardId: null,
  senderTelNorm: null,
  sites: [{ id: S1, canonicalName: "測試盤", aliases: [] }, { id: S2, canonicalName: "測試二號盤", aliases: [] }],
  index,
  repo: repo(),
  ...over,
});
const deps = (o: { scheduled?: Record<string, Array<{ siteId: string; shiftTypeId: string }>>; recent?: Record<string, Record<string, number>> } = {}): CardDeps => ({
  scheduled: async (g, d) => o.scheduled?.[`${g}|${d}`] ?? [],
  recentSites: async (g) => new Map(Object.entries(o.recent?.[g] ?? {})),
});
const pc = (over: Partial<PhotoCard> = {}): PhotoCard => ({ staff_no: "U90001", name_zh: null, name_en: null, status: "confirmed", reasons: [], candidates: [], votes: 2, ...over });
const photo = (cards: PhotoCard[], arbiter = false): CardInput => ({ kind: "photo", photo: { kind: "cards", cards, usage: [], arbiter_used: arbiter, engines: [] } as CardPhotoResult });

describe("WA-8 C 歸屬", () => {
  it("單盤群＋工號配到唯一 guard＋日更預設（開工→D）→ auto_write（寫入前仍過衝突／鎖月檢查）", async () => {
    const [r] = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc()]), mediaId: "m1", deps: deps() });
    expect(r).toMatchObject({ kind: "shift", guardId: "g1", siteId: S1, shiftTypeId: "t-d", workDate: "2026-10-19", routed: "auto_write" });
    expect(r!.resolution.basis).toMatchObject({ person: "card_staff_no", shift: "word_map" });
    expect(r!.src?.card).toMatchObject({ media_id: "m1", staff_no_read: "U90001", votes: 2, index: 1, total: 1 });
  });
  it("冇群組對照 → 按訊息 ts 對該盤更開始時段（±2 小時）推更；推唔到（相差太遠）出題", async () => {
    const [r] = await resolveCardPhoto({ ctx: ctx(), input: photo([pc()]), mediaId: null, deps: deps() }); // 09:00 對 D(08:00)
    expect(r).toMatchObject({ shiftTypeId: "t-d", routed: "auto_write" });
    const [far] = await resolveCardPhoto({ ctx: ctx({ ts: new Date("2026-10-19T06:00:00Z") }), input: photo([pc()]), mediaId: null, deps: deps() }); // 14:00
    expect(far!.resolution.reasons).toContain("shift_unmapped");
    expect(far!.routed).toBe("triage");
    expect(shiftBySlot(types[S2]!, new Date("2026-10-19T00:00:00Z")).reasons).toEqual([]); // 08:00 ＝ D(07)／E(08) 取最近
    expect(shiftBySlot([{ id: "a", siteId: S1, code: "A", label: null, startHour: 8 }, { id: "b", siteId: S1, code: "B", label: null, startHour: 8 }], MON_9AM).reasons).toContain("shift_ambiguous");
  });
  it("凌晨 00:00–05:00 → 沿用日期降級（date_ambiguous 候選今日／前一日）出題", async () => {
    const [r] = await resolveCardPhoto({ ctx: ctx({ ts: DAWN }, { 開工: "N" }), input: photo([pc()]), mediaId: null, deps: deps() });
    expect(r!.resolution.reasons).toContain("date_ambiguous");
    expect(r!.resolution.candidates.dates).toEqual(expect.arrayContaining(["2026-10-18", "2026-10-19"]));
    expect(r!.routed).toBe("triage");
    expect(pickWaKind(r!.resolution.reasons, "shift")).toBe("wa_date_ambiguous");
  });
  it("工號系統冇 → person_unknown；former 工號／姓名同系統唔夾 → 一撳確認（wa_card_confirm）", async () => {
    const [unknown] = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc({ staff_no: "U99999" })]), mediaId: null, deps: deps() });
    expect(unknown!.resolution.reasons).toEqual(expect.arrayContaining(["person_unknown", "card_staff_no_unknown"]));
    const [former] = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc({ staff_no: "U90003" })]), mediaId: null, deps: deps() });
    expect(former!.guardId).toBe("g3");
    expect(former!.resolution.reasons).toContain("card_former_number");
    expect(pickWaKind(former!.resolution.reasons, "shift")).toBe("wa_card_confirm");
    const [mismatch] = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc({ name_zh: "測試乙" })]), mediaId: null, deps: deps() });
    expect(mismatch!.resolution.reasons).toContain("card_name_mismatch");
    expect(mismatch!.routed).toBe("triage");
    const [same] = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc({ name_zh: "測試甲" })]), mediaId: null, deps: deps() });
    expect(same!.routed).toBe("auto_write");
  });
  it("群組冇開自動寫入 → card_confirm → wa_card_confirm 題（一撳確認）", async () => {
    const c = ctx({ group: { id: "grp", kind: "site", siteId: S1, brokerId: null, shiftWordMap: { 開工: "D" }, autoWrite: false } });
    const [r] = await resolveCardPhoto({ ctx: c, input: photo([pc()]), mediaId: "m1", deps: deps() });
    expect(r!.routed).toBe("triage");
    expect(r!.resolution.reasons).toEqual(["card_confirm"]);
    expect(pickWaKind(r!.resolution.reasons, "shift")).toBe("wa_card_confirm");
    expect(optionsForWa("wa_card_confirm", { candidates: { guard_ids: [], site_ids: [], dates: [], shift_type_ids: [], existing_record_ids: [] }, reasons: r!.resolution.reasons, intent: { kind: "shift", work_date: null, site_id: null, guard_id: null, shift_type_id: null, leave_code: null, confidence: 1 }, human: {} }).map((o) => o.id)).toEqual(["wa_accept", "wa_manual", "wa_ignore", "skip"]);
  });
  it("review 卡（單票）→ 候選工號對應 guard 俾人揀（wa_person_ambiguous）；候選全部系統冇 → wa_person_unknown", async () => {
    const [amb] = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc({ staff_no: "U90001", status: "review", votes: 1, candidates: ["U90001", "MP9002"], reasons: ["card_disputed"] })]), mediaId: null, deps: deps() });
    expect(amb!.guardId).toBeNull();
    expect(amb!.resolution.candidates.guard_ids).toEqual(expect.arrayContaining(["g1", "g2"]));
    expect(pickWaKind(amb!.resolution.reasons, "shift")).toBe("wa_person_ambiguous");
    const [unk] = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc({ staff_no: "U98888", status: "review", votes: 1, candidates: ["U98888"] })]), mediaId: null, deps: deps() });
    expect(pickWaKind(unk!.resolution.reasons, "shift")).toBe("wa_person_unknown");
  });
  it("冇工號只有姓名：唯一 → 一撳確認；同名多人 → 揀人；永遠唔自動", async () => {
    const [one] = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc({ staff_no: null, name_zh: "測試乙", status: "review", votes: 0, reasons: ["card_name_only"] })]), mediaId: null, deps: deps() });
    expect(one).toMatchObject({ guardId: "g2", routed: "triage" });
    expect(pickWaKind(one!.resolution.reasons, "shift")).toBe("wa_card_confirm");
    const [multi] = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc({ staff_no: null, name_zh: "測試同名", status: "review", votes: 0 })]), mediaId: null, deps: deps() });
    expect(multi!.resolution.candidates.guard_ids).toEqual(expect.arrayContaining(["g3", "g4"]));
    expect(pickWaKind(multi!.resolution.reasons, "shift")).toBe("wa_person_ambiguous");
  });
  it("一張相多張卡 → 逐張一個 intent（各自證據 index／total）", async () => {
    const rs = await resolveCardPhoto({ ctx: ctx({}, { 開工: "D" }), input: photo([pc(), pc({ staff_no: "MP9002" })]), mediaId: "m1", deps: deps() });
    expect(rs.map((r) => [r.guardId, r.src?.card?.index, r.src?.card?.total])).toEqual([["g1", 1, 2], ["g2", 2, 2]]);
  });
  it("大群／判頭群：當日更表預排 → 用該盤（及已排更別）；冇預排 → 近 60 日唯一同盤（要確認）；多個盤／冇紀錄 → wa_site_ambiguous", async () => {
    const group = { id: "grp", kind: "broker" as const, siteId: null, brokerId: "b1", shiftWordMap: {}, autoWrite: true };
    const [sched] = await resolveCardPhoto({ ctx: ctx({ group }), input: photo([pc()]), mediaId: null, deps: deps({ scheduled: { "g1|2026-10-19": [{ siteId: S2, shiftTypeId: "t2-e" }] } }) });
    expect(sched).toMatchObject({ siteId: S2, shiftTypeId: "t2-e" });
    expect(sched!.resolution.basis.site).toBe("scheduled");
    const [rec] = await resolveCardPhoto({ ctx: ctx({ group }), input: photo([pc()]), mediaId: null, deps: deps({ recent: { g1: { [S1]: 12 } } }) });
    expect(rec).toMatchObject({ siteId: S1, routed: "triage" });
    expect(rec!.resolution.reasons).toContain("card_confirm");
    const [multi] = await resolveCardPhoto({ ctx: ctx({ group }), input: photo([pc()]), mediaId: null, deps: deps({ recent: { g1: { [S1]: 12, [S2]: 3 } } }) });
    expect(multi!.resolution.candidates.site_ids).toEqual([S1, S2]);
    expect(pickWaKind(multi!.resolution.reasons, "shift")).toBe("wa_site_ambiguous");
    const [none] = await resolveCardPhoto({ ctx: ctx({ group }), input: photo([pc()]), mediaId: null, deps: deps() });
    expect(pickWaKind(none!.resolution.reasons, "shift")).toBe("wa_site_ambiguous");
  });
  it("相片過期／唔係工卡／讀唔到 → 一條 wa_card_confirm 題（只可人手／忽略），帶 none 原因", async () => {
    for (const [input, code, none] of [
      [{ kind: "dead", why: "expired" } as CardInput, "card_media_expired", "expired"],
      [{ kind: "photo", photo: { kind: "not_card", cards: [], usage: [], arbiter_used: false, engines: [] } } as CardInput, "card_not_card", "not_card"],
      [{ kind: "photo", photo: { kind: "unreadable", cards: [], usage: [], arbiter_used: true, engines: [] } } as CardInput, "card_unreadable", "unreadable"],
    ] as const) {
      const rs = await resolveCardPhoto({ ctx: ctx(), input, mediaId: "m1", deps: deps() });
      expect(rs).toHaveLength(1);
      expect(rs[0]).toMatchObject({ kind: "unclear", routed: "triage" });
      expect(rs[0]!.resolution.reasons).toEqual([code]);
      expect(rs[0]!.src?.card?.none).toBe(none);
      expect(pickWaKind(rs[0]!.resolution.reasons, "unclear")).toBe("wa_card_confirm");
      expect(optionsForWa("wa_card_confirm", { candidates: { guard_ids: [], site_ids: [], dates: [], shift_type_ids: [], existing_record_ids: [] }, reasons: rs[0]!.resolution.reasons, intent: { kind: "unclear", work_date: null, site_id: null, guard_id: null, shift_type_id: null, leave_code: null, confidence: 0 }, human: {} }).map((o) => o.id)).toEqual(["wa_manual", "wa_ignore", "skip"]);
    }
  });
  it("同日同更已存在 → 唔重複（ignored）", async () => {
    const c = ctx({ repo: repo({ "g1|2026-10-19": [{ id: "r1", siteId: S1, shiftTypeId: "t-d", recordType: "shift", leaveCode: null, status: "confirmed" }] }) }, { 開工: "D" });
    const [r] = await resolveCardPhoto({ ctx: c, input: photo([pc()]), mediaId: null, deps: deps() });
    expect(r).toMatchObject({ routed: "ignored" });
    expect(r!.resolution.reasons).toEqual(["already_exists"]);
  });
});
