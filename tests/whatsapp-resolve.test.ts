// W1：程式碼配對（人／盤／更／請假／衝突／routed 判定）。用記憶體 repo，零 DB。全部假名「測試甲／乙」、假電話 9000xxxx。
import { describe, it, expect } from "vitest";
import { buildGuardMatchIndex } from "@/lib/roster-upload/match";
import { resolveIntents, mapLeaveCode, type ResolveContext, type ResolveRepo, type ExistingRecord, type ShiftTypeLite } from "@/lib/whatsapp/resolve";
import type { ParsedIntent } from "@/lib/whatsapp/parse";

const FRI = new Date("2026-10-16T05:00:00Z"); // HK 2026-10-16 13:00 星期五
const DAWN = new Date("2026-10-16T18:00:00Z"); // HK 2026-10-17 02:00

const S1 = "site-1";
const S2 = "site-2";
const guards = [
  { id: "g1", nameZh: "測試甲", tel: "90000011", staffNo: null, staffNoMw: null, nameAliases: ["阿甲"] },
  { id: "g2", nameZh: "測試乙", tel: "90000012", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g3", nameZh: "測試同名", tel: "90000013", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g4", nameZh: "測試同名", tel: "90000014", staffNo: null, staffNoMw: null, nameAliases: [] },
  { id: "g5", nameZh: "測試丁", tel: null, staffNo: null, staffNoMw: null, nameAliases: ["細丁"] },
];
const index = buildGuardMatchIndex({ guards, staffNumbers: [], phones: [] });
const sites = [
  { id: S1, canonicalName: "測試盤", aliases: ["測試盤本部"] },
  { id: S2, canonicalName: "測試二號盤", aliases: [] },
];
const types: Record<string, ShiftTypeLite[]> = {
  [S1]: [
    { id: "t-a", siteId: S1, code: "A", label: "早更", startHour: 7 },
    { id: "t-b", siteId: S1, code: "B", label: "中更", startHour: 15 },
    { id: "t-n", siteId: S1, code: "N", label: "夜更", startHour: 19 },
  ],
  [S2]: [
    { id: "t2-n1", siteId: S2, code: "N", label: "夜更一", startHour: 19 },
    { id: "t2-n2", siteId: S2, code: "N", label: "夜更二", startHour: 22 },
  ],
};

interface RepoOpts {
  existing?: Record<string, ExistingRecord[]>;
  locked?: Set<string>;
  headcount?: { required: number | null; current: number };
  quota?: { target: number; actual: number } | null;
  recentSite?: string[];
  recentBroker?: string[];
}
function repo(o: RepoOpts = {}): ResolveRepo {
  return {
    shiftTypes: async (s) => types[s] ?? [],
    recentGuardIdsAtSite: async () => new Set(o.recentSite ?? []),
    recentGuardIdsOfBroker: async () => new Set(o.recentBroker ?? []),
    existing: async (g, d) => o.existing?.[`${g}|${d}`] ?? [],
    headcount: async () => o.headcount ?? { required: null, current: 0 },
    quota: async () => o.quota ?? null,
    monthLocked: async (d) => o.locked?.has(d.slice(0, 7)) ?? false,
  };
}
function ctx(over: Partial<ResolveContext> = {}, ro: RepoOpts = {}): ResolveContext {
  return {
    ts: FRI,
    group: { id: "grp1", kind: "site", siteId: S1, brokerId: null, shiftWordMap: { 夜: "N", 早: "A" }, autoWrite: true },
    senderGuardId: "g1",
    senderTelNorm: "90000011",
    sites,
    index,
    repo: repo(ro),
    ...over,
  };
}
function mk(over: Partial<ParsedIntent> = {}): ParsedIntent {
  return { type: "shift", date: { raw: "聽日", kind: "relative" }, site_raw: null, persons: [], self_reference: true, shift_raw: "早", shift_code_guess: null, hours: null, leave_raw: null, leave_code_guess: null, confidence: 0.9, ...over } as ParsedIntent;
}
const one = async (i: ParsedIntent, c = ctx()) => (await resolveIntents([i], c))[0]!;

describe("W1 resolve：人", () => {
  it("自己（發訊人電話對應保安員）→ auto_write", async () => {
    const r = await one(mk());
    expect(r).toMatchObject({ guardId: "g1", siteId: S1, shiftTypeId: "t-a", workDate: "2026-10-17", routed: "auto_write" });
    expect(r.resolution.basis.person).toBe("sender_phone");
  });
  it("自己：senderGuardId 缺，用電話（全表唯一）", async () => {
    const r = await one(mk(), ctx({ senderGuardId: null }));
    expect(r.guardId).toBe("g1");
  });
  it("自己：電話對唔到 → person_unknown，triage", async () => {
    const r = await one(mk(), ctx({ senderGuardId: null, senderTelNorm: "90009999" }));
    expect(r.guardId).toBeNull();
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("person_unknown");
  });
  it("人名唯一 → 硬鍵", async () => {
    const r = await one(mk({ self_reference: false, persons: [{ raw: "測試乙", role: "worker" }] }));
    expect(r.guardId).toBe("g2");
    expect(r.routed).toBe("auto_write");
  });
  it("花名唯一（alias）→ 採用", async () => {
    const r = await one(mk({ self_reference: false, persons: [{ raw: "阿甲", role: "worker" }] }));
    expect(r.guardId).toBe("g1");
    expect(r.resolution.basis.person).toBe("alias");
  });
  it("同名多人 → person_ambiguous，候選按近 60 日同盤有更者優先", async () => {
    const r = await one(mk({ self_reference: false, persons: [{ raw: "測試同名", role: "worker" }] }), ctx({}, { recentSite: ["g4"] }));
    expect(r.guardId).toBeNull();
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("person_ambiguous");
    expect(r.resolution.candidates.guard_ids).toEqual(["g4", "g3"]);
  });
  it("判頭群：同名多人候選限該判頭近 60 日保安員（只影響候選範圍）", async () => {
    const c = ctx({ group: { id: "grp2", kind: "broker", siteId: null, brokerId: "b1", shiftWordMap: {}, autoWrite: true } }, { recentBroker: ["g3"] });
    const r = await one(mk({ self_reference: false, site_raw: "測試盤", persons: [{ raw: "測試同名", role: "worker" }] }), c);
    expect(r.resolution.candidates.guard_ids).toEqual(["g3"]);
    expect(r.guardId).toBeNull(); // 全表唯一性唔變：仍然 ambiguous
  });
  it("判頭群：名全表唯一但唔喺該判頭名單 → 照常採用（唔影響唯一判定）", async () => {
    const c = ctx({ group: { id: "grp2", kind: "broker", siteId: null, brokerId: "b1", shiftWordMap: {}, autoWrite: true } }, { recentBroker: [] });
    const r = await one(mk({ self_reference: false, site_raw: "測試盤", persons: [{ raw: "測試乙", role: "worker" }] }), c);
    expect(r.guardId).toBe("g2");
  });
  it("識唔到嘅名 → person_unknown", async () => {
    const r = await one(mk({ self_reference: false, persons: [{ raw: "吳無名氏", role: "worker" }] }));
    expect(r.resolution.reasons).toContain("person_unknown");
    expect(r.routed).toBe("triage");
  });
  it("冇任何人（冇 self、冇 persons）→ person_unknown，唔默認發訊人", async () => {
    const r = await one(mk({ self_reference: false, persons: [] }));
    expect(r.guardId).toBeNull();
    expect(r.routed).toBe("triage");
  });
  it("persons 寫「我」→ 當自己", async () => {
    const r = await one(mk({ self_reference: false, persons: [{ raw: "我", role: "worker" }] }));
    expect(r.guardId).toBe("g1");
  });
  it("兩個 worker → 兩條 intent", async () => {
    const rs = await resolveIntents([mk({ self_reference: false, persons: [{ raw: "測試甲", role: "worker" }, { raw: "測試乙", role: "worker" }] })], ctx());
    expect(rs.map((r) => r.guardId)).toEqual(["g1", "g2"]);
  });
});

describe("W1 resolve：盤口", () => {
  it("單盤群冇講盤 → 群綁定盤", async () => {
    expect((await one(mk())).resolution.basis.site).toBe("group");
  });
  it("單盤群文字指同一個盤（exact）→ 採用", async () => {
    const r = await one(mk({ site_raw: "測試盤" }));
    expect(r.siteId).toBe(S1);
    expect(r.routed).toBe("auto_write");
  });
  describe("WA-9 (7) 盤口群綁定盤分層（兄弟盤調人係常態，唔一刀切）", () => {
    const G = "site-g";
    const B = "site-b";
    const C = "site-c";
    const X = "site-x";
    const layered = [
      { id: G, canonicalName: "測試CP五盤", aliases: ["數碼港"], client: "測試客甲" },
      { id: B, canonicalName: "測試數據中心", aliases: ["數據中心", "共用區"], client: "測試客甲" },
      { id: C, canonicalName: "測試丙盤", aliases: ["共用區"], client: "測試客甲" },
      { id: X, canonicalName: "測試別客戶盤", aliases: ["別客戶區"], client: "測試客乙" },
    ];
    const gctx = () => ctx({ sites: layered, group: { id: "grpG", kind: "site", siteId: G, brokerId: null, shiftWordMap: { 夜: "N", 早: "A" }, autoWrite: true }, repo: { ...repo(), shiftTypes: async (sid) => [{ id: `t-${sid}`, siteId: sid, code: "A", label: "早更", startHour: 7 }] } });
    it("0. 文字命中群盤自己（含多盤共用嘅「數碼港」）→ 群盤，唔出題", async () => {
      const r = await one(mk({ site_raw: "數碼港" }), gctx());
      expect(r.siteId).toBe(G);
      expect(r.resolution.reasons).not.toContain("site_ambiguous");
    });
    it("1. 命中同客戶兄弟盤獨有嘅名（「數據中心」）→ site_ambiguous 題，候選＝群盤＋兄弟盤，唔自動寫", async () => {
      const r = await one(mk({ site_raw: "數據中心" }), gctx());
      expect(r.routed).toBe("triage");
      expect(r.resolution.reasons).toContain("site_ambiguous");
      expect(r.resolution.candidates.site_ids).toEqual([G, B]);
      expect(r.resolution.basis.site).toBe("sibling_site_text");
    });
    it("2. 只命中多盤共用嘅區域名（別名掛喺 ≥2 個兄弟盤、群盤冇）→ 群盤，唔出題（group_over_alias）", async () => {
      const r = await one(mk({ site_raw: "共用區" }), gctx());
      expect(r.siteId).toBe(G);
      expect(r.resolution.reasons).not.toContain("site_ambiguous");
      expect(r.resolution.basis.site).toBe("group_over_alias");
    });
    it("2b. 多盤共用嘅名但掛住嘅盤橫跨唔同客戶 → 出 site_ambiguous 題（候選＝群盤＋該些盤），唔當區域名放行", async () => {
      const mixed = [...layered, { id: "site-y", canonicalName: "測試乙客戶盤", aliases: ["跨客區"], client: "測試客乙" }, { id: "site-z", canonicalName: "測試丙客戶盤", aliases: ["跨客區"], client: "測試客甲" }];
      const r = await one(mk({ site_raw: "跨客區" }), ctx({ sites: mixed, group: { id: "grpG", kind: "site", siteId: G, brokerId: null, shiftWordMap: { 夜: "N", 早: "A" }, autoWrite: true }, repo: { ...repo(), shiftTypes: async (sid) => [{ id: `t-${sid}`, siteId: sid, code: "A", label: "早更", startHour: 7 }] } }));
      expect(r.siteId).toBe(G);
      expect(r.routed).toBe("triage");
      expect(r.resolution.reasons).toContain("site_ambiguous");
      expect(r.resolution.candidates.site_ids).toEqual([G, "site-y", "site-z"]);
      expect(r.resolution.basis.site).toBe("shared_name_cross_client");
    });
    it("3. 命中唔同客戶嘅盤 → 用群盤但要確認（唔自動寫）", async () => {
      const r = await one(mk({ site_raw: "別客戶區" }), gctx());
      expect(r.siteId).toBe(G);
      expect(r.routed).toBe("triage");
      expect(r.resolution.reasons).toContain("site_ambiguous");
      expect(r.resolution.candidates.site_ids).toEqual([G, X]);
      expect(r.resolution.basis.site).toBe("other_client_site");
    });
    it("4. 完全唔識嘅盤名 → 照舊出題（候選＝群盤）", async () => {
      const r = await one(mk({ site_raw: "完全唔識嘅地方" }), gctx());
      expect(r.routed).toBe("triage");
      expect(r.resolution.reasons).toContain("site_ambiguous");
      expect(r.resolution.basis.site).toBe("text_unknown");
    });
  });
  it("大群冇講盤 → site_ambiguous", async () => {
    const c = ctx({ group: { id: "g", kind: "multi_site", siteId: null, brokerId: null, shiftWordMap: {}, autoWrite: true } });
    const r = await one(mk(), c);
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("site_ambiguous");
  });
  it("大群文字 exact／alias → 採用並可 auto_write", async () => {
    const c = ctx({ group: { id: "g", kind: "multi_site", siteId: null, brokerId: null, shiftWordMap: { 夜: "N" }, autoWrite: true } });
    const r = await one(mk({ site_raw: "測試盤本部", shift_raw: "夜" }), c);
    expect(r).toMatchObject({ siteId: S1, shiftTypeId: "t-n", routed: "auto_write" });
  });
  it("文字完全唔識嘅盤（new）→ ambiguous", async () => {
    const r = await one(mk({ site_raw: "完全唔存在嘅地方" }));
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("site_ambiguous");
  });
});

describe("W1 resolve：更碼／請假碼", () => {
  it("口語對照 → 更碼", async () => {
    expect((await one(mk({ shift_raw: "夜" }))).shiftTypeId).toBe("t-n");
  });
  it("直接更碼（N更）", async () => {
    const c = ctx({ group: { id: "g", kind: "site", siteId: S1, brokerId: null, shiftWordMap: {}, autoWrite: true } });
    expect((await one(mk({ shift_raw: "N更" }), c)).shiftTypeId).toBe("t-n");
    expect((await one(mk({ shift_raw: "b" }), c)).shiftTypeId).toBe("t-b");
  });
  it("冇對照冇更碼 → 用 startTime 時段（早／中／夜）", async () => {
    const c = ctx({ group: { id: "g", kind: "site", siteId: S1, brokerId: null, shiftWordMap: {}, autoWrite: true } });
    expect((await one(mk({ shift_raw: "早" }), c)).shiftTypeId).toBe("t-a");
    expect((await one(mk({ shift_raw: "中更" }), c)).shiftTypeId).toBe("t-b");
    expect((await one(mk({ shift_raw: "通宵" }), c)).shiftTypeId).toBe("t-n");
  });
  it("同時段多個更別 → shift_ambiguous", async () => {
    const c = ctx({ group: { id: "g", kind: "site", siteId: S2, brokerId: null, shiftWordMap: {}, autoWrite: true } });
    const r = await one(mk({ shift_raw: "夜" }), c);
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("shift_ambiguous");
    expect(r.resolution.candidates.shift_type_ids).toEqual(["t2-n1", "t2-n2"]);
  });
  it("對照指向本盤冇嘅更碼 → shift_unmapped", async () => {
    const c = ctx({ group: { id: "g", kind: "site", siteId: S1, brokerId: null, shiftWordMap: { 夜: "ZZ" }, autoWrite: true } });
    const r = await one(mk({ shift_raw: "夜" }), c);
    expect(r.resolution.reasons).toContain("shift_unmapped");
  });
  it("冇更別字眼／完全唔識 → shift_unmapped；LLM 猜嘅碼只做候選（唔自動）", async () => {
    expect((await one(mk({ shift_raw: null }))).resolution.reasons).toContain("shift_unmapped");
    const r = await one(mk({ shift_raw: "怪更", shift_code_guess: "N" }));
    expect(r.shiftTypeId).toBeNull();
    expect(r.resolution.reasons).toContain("shift_ambiguous");
    expect(r.resolution.candidates.shift_type_ids).toEqual(["t-n"]);
  });
  it("請假碼對照：病假→SL、年假→AL、放假→RD、事假→NL、公假→SH", async () => {
    for (const [raw, code] of [["病假", "SL"], ["年假", "AL"], ["事假", "NL"], ["公假", "SH"], ["SL", "SL"], ["al", "AL"]] as const) {
      expect(mapLeaveCode(raw).code, raw).toBe(code);
    }
    expect(mapLeaveCode("好攰").code).toBeNull();
    for (const [raw, code] of [["例假", "RD"], ["RD", "RD"], ["OFF", "RD"]] as const) expect(mapLeaveCode(raw).code, raw).toBe(code);
    expect(mapLeaveCode("放假")).toMatchObject({ code: null, unclear: true });
    const r = await one(mk({ type: "leave", leave_raw: "病假", shift_raw: null }));
    expect(r).toMatchObject({ kind: "leave", leaveCode: "SL", routed: "auto_write" });
  });
  it("請假碼對唔到 → leave_unmapped", async () => {
    const r = await one(mk({ type: "leave", leave_raw: "有事", shift_raw: null }));
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("leave_unmapped");
  });
});

describe("W1 resolve：衝突與守則", () => {
  const rec = (over: Partial<ExistingRecord>): ExistingRecord => ({ id: "r1", siteId: S1, shiftTypeId: "t-a", recordType: "shift", leaveCode: null, status: "confirmed", ...over });
  it("同人同日同更已存在 → no-op（routed ignored，already_exists）", async () => {
    const r = await one(mk(), ctx({}, { existing: { "g1|2026-10-17": [rec({})] } }));
    expect(r.routed).toBe("ignored");
    expect(r.resolution.reasons).toEqual(["already_exists"]);
  });
  it("已取消嘅同更唔算", async () => {
    const r = await one(mk(), ctx({}, { existing: { "g1|2026-10-17": [rec({ status: "cancelled" })] } }));
    expect(r.routed).toBe("auto_write");
  });
  it("同日已有另一更 → conflict_other_shift，triage", async () => {
    const r = await one(mk(), ctx({}, { existing: { "g1|2026-10-17": [rec({ shiftTypeId: "t-n" })] } }));
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("conflict_other_shift");
  });
  it("OT 記錄唔算撞更", async () => {
    const r = await one(mk(), ctx({}, { existing: { "g1|2026-10-17": [rec({ recordType: "ot", shiftTypeId: "t-n" })] } }));
    expect(r.routed).toBe("auto_write");
  });
  it("同日已有請假，再報更 → conflict_leave", async () => {
    const r = await one(mk(), ctx({}, { existing: { "g1|2026-10-17": [rec({ recordType: "leave", leaveCode: "AL" })] } }));
    expect(r.resolution.reasons).toContain("conflict_leave");
  });
  it("報請假但當日有更 → conflict_shift_vs_leave；同一請假已存在 → no-op（OFF≈RD）", async () => {
    const a = await one(mk({ type: "leave", leave_raw: "病假", shift_raw: null }), ctx({}, { existing: { "g1|2026-10-17": [rec({})] } }));
    expect(a.resolution.reasons).toContain("conflict_shift_vs_leave");
    const b = await one(mk({ type: "leave", leave_raw: "例假", shift_raw: null }), ctx({}, { existing: { "g1|2026-10-17": [rec({ recordType: "leave", leaveCode: "OFF" })] } }));
    expect(b.routed).toBe("ignored");
  });
  it("鎖月 → month_locked", async () => {
    const r = await one(mk(), ctx({}, { locked: new Set(["2026-10"]) }));
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("month_locked");
  });
  it("日期超出 −2～+45 → date_out_of_range", async () => {
    const r = await one(mk({ date: { raw: "12月1日", kind: "absolute" } }));
    expect(r.resolution.reasons).toContain("date_out_of_range");
    expect(r.routed).toBe("triage");
    const past = await one(mk({ date: { raw: "琴日", kind: "relative" } }));
    expect(past.routed).toBe("auto_write"); // −1 日仍喺窗口內
  });
  it("額滿（DailyRequirement／headcount）→ slot_full；配額滿 → quota_full", async () => {
    const full = await one(mk(), ctx({}, { headcount: { required: 2, current: 2 } }));
    expect(full.resolution.reasons).toContain("slot_full");
    const q = await one(mk(), ctx({}, { quota: { target: 10, actual: 10 } }));
    expect(q.resolution.reasons).toContain("quota_full");
    const okc = await one(mk(), ctx({}, { headcount: { required: 2, current: 1 }, quota: { target: 10, actual: 9 } }));
    expect(okc.routed).toBe("auto_write");
  });
  it("凌晨「今晚」→ date_ambiguous（候選當日／前一日），唔自動", async () => {
    const r = await one(mk({ date: { raw: "今晚", kind: "relative" } }), ctx({ ts: DAWN }));
    expect(r.workDate).toBeNull();
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("date_ambiguous");
    expect(r.resolution.candidates.dates).toEqual(["2026-10-17", "2026-10-16"]);
  });
  it("range 展開成逐日 intent", async () => {
    const rs = await resolveIntents([mk({ date: { raw: "17-19號", kind: "range" } })], ctx());
    expect(rs.map((r) => r.workDate)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(rs.every((r) => r.routed === "auto_write")).toBe(true);
  });
  it("同一訊息重覆指令 → 第二條 duplicate_in_message（ignored）", async () => {
    const rs = await resolveIntents([mk(), mk()], ctx());
    expect(rs.map((r) => r.routed)).toEqual(["auto_write", "ignored"]);
    expect(rs[1]!.resolution.reasons).toEqual(["duplicate_in_message"]);
  });
  it("群組 auto_write 關：判定仍照 §6.1 第 1–6 項，記 note group_auto_write_off", async () => {
    const c = ctx({ group: { id: "g", kind: "site", siteId: S1, brokerId: null, shiftWordMap: { 早: "A" }, autoWrite: false } });
    const r = await one(mk(), c);
    expect(r.routed).toBe("auto_write");
    expect(r.resolution.group_auto_write).toBe(false);
    expect(r.resolution.notes).toContain("group_auto_write_off");
  });
});

describe("W1 resolve：信心與放假", () => {
  it("信心 < 0.6 → low_confidence，唔 auto_write；0.6 剛好過", async () => {
    const lo = await one(mk({ confidence: 0.59 }));
    expect(lo.routed).toBe("triage");
    expect(lo.resolution.reasons).toEqual(["low_confidence"]);
    expect((await one(mk({ confidence: 0.6 }))).routed).toBe("auto_write");
  });
  it("「放假」唔自動對 RD：leave_code 空＋leave_code_unclear（triage）", async () => {
    const r = await one(mk({ type: "leave", leave_raw: "放假", shift_raw: null }));
    expect(r.leaveCode).toBeNull();
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).toContain("leave_code_unclear");
    expect((await one(mk({ type: "leave", leave_raw: "例假", shift_raw: null }))).leaveCode).toBe("RD");
  });
});

describe("W1 resolve：類別", () => {
  it("cover 首階段一律 triage（W4：唔再用 type_not_auto），並記被替人＋被替者當日該更", async () => {
    const r = await one(
      mk({ type: "cover", self_reference: false, persons: [{ raw: "測試乙", role: "worker" }, { raw: "測試甲", role: "replaced" }], shift_raw: "夜" }),
      ctx({}, { existing: { "g1|2026-10-17": [{ id: "r-g1-n", siteId: S1, shiftTypeId: "t-n", recordType: "shift", leaveCode: null, status: "confirmed" }] } }),
    );
    expect(r.routed).toBe("triage");
    expect(r.resolution.reasons).not.toContain("type_not_auto");
    expect(r.guardId).toBe("g2");
    expect(r.resolution.replaced_guard_id).toBe("g1");
    expect(r.resolution.replaced_record_ids).toEqual(["r-g1-n"]);
    expect(r.resolution.notes).toContain("cover_triage");
  });
  it("cover：被替者冇當日更 → replaced_no_shift；替更者同日有其他更 → conflict_other_shift；冇講被替者 → replaced_missing", async () => {
    const base = mk({ type: "cover", self_reference: false, persons: [{ raw: "測試乙", role: "worker" }, { raw: "測試甲", role: "replaced" }], shift_raw: "夜" });
    const a = await one(base);
    expect(a.resolution.notes).toContain("replaced_no_shift");
    expect(a.resolution.replaced_record_ids).toEqual([]);
    const b = await one(base, ctx({}, { existing: { "g2|2026-10-17": [{ id: "r-g2-a", siteId: S1, shiftTypeId: "t-a", recordType: "shift", leaveCode: null, status: "confirmed" }] } }));
    expect(b.resolution.reasons).toContain("conflict_other_shift");
    expect(b.resolution.existing_record_ids).toEqual(["r-g2-a"]);
    expect(b.routed).toBe("triage");
    const c = await one(mk({ type: "cover", self_reference: false, persons: [{ raw: "測試乙", role: "worker" }], shift_raw: "夜" }));
    expect(c.resolution.notes).toContain("replaced_missing");
  });
  it("cancel 首階段一律 triage：有可取消記錄 → existing_record_ids；冇 → no_cancel_target；唔要盤口", async () => {
    const none = await one(mk({ type: "cancel", shift_raw: null }));
    expect(none.routed).toBe("triage");
    expect(none.resolution.reasons).toContain("no_cancel_target");
    const rec = { id: "r-g1-a", siteId: S1, shiftTypeId: "t-a", recordType: "shift" as const, leaveCode: null, status: "pending_approval" };
    const c = await one(mk({ type: "cancel", shift_raw: null }), ctx({}, { existing: { "g1|2026-10-17": [rec] } }));
    expect(c.routed).toBe("triage");
    expect(c.resolution.reasons).toEqual([]);
    expect(c.resolution.existing_record_ids).toEqual(["r-g1-a"]);
    const multi = await one(mk({ type: "cancel", shift_raw: null }), ctx({ group: { id: "grp2", kind: "multi_site", siteId: null, brokerId: null, shiftWordMap: {}, autoWrite: true } }, { existing: { "g1|2026-10-17": [rec] } }));
    expect(multi.resolution.reasons).not.toContain("site_ambiguous");
    expect(multi.resolution.existing_record_ids).toEqual(["r-g1-a"]);
  });
  it("question_only → ignored；unclear → triage", async () => {
    expect((await one(mk({ type: "question_only" }))).routed).toBe("ignored");
    const u = await one(mk({ type: "unclear" }));
    expect(u.routed).toBe("triage");
    expect(u.resolution.reasons).toContain("unclear");
  });
  it("resolution 唔含訊息原文（人名、原話）", async () => {
    const rs = await resolveIntents([mk({ self_reference: false, persons: [{ raw: "測試甲", role: "worker" }], evidence: "聽日測試甲返早" })], ctx());
    const s = JSON.stringify(rs[0]!.resolution);
    expect(s).not.toContain("測試甲");
    expect(s).not.toContain("聽日");
  });
});
