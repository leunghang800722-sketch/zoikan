import { describe, expect, it } from "vitest";
import { crossCheckWithRoster, rosterOnly, type CrossCheckDeps } from "@/lib/whatsapp/roster-crosscheck";
import { pickWaKind, optionsForWa, rosterMismatchKey } from "@/lib/whatsapp/triage-types";
import type { ResolvedIntent } from "@/lib/whatsapp/resolve";

const card = (guardId: string | null, name: string, on: string | null, off: string | null): ResolvedIntent => ({
  kind: "shift", workDate: "2026-10-20", siteId: "s1", guardId, shiftTypeId: "t1", leaveCode: null, hours: null, confidence: 1,
  resolution: { type: "shift", reasons: [], notes: [], basis: {}, candidates: {}, group_id: "g1", group_auto_write: true } as never,
  routed: "auto_write",
  src: { person_raw: name, site_raw: null, date_raw: null, shift_raw: null, leave_raw: null, replaced_raw: null, card: { media_id: null, staff_no_read: null, name_zh_read: name, name_en_read: null, votes: 2, index: 1, total: 1, arbiter: false, candidates: [], time_on: on, time_off: off } },
});

function deps(roster: Record<string, string> | null) {
  const calls: Array<{ guardId: string; timeOn: string | null; timeOff: string | null }> = [];
  const d: CrossCheckDeps = {
    rosterOfDay: async () => (roster ? { guards: new Map(Object.entries(roster)) } : null),
    setReported: async (a) => { calls.push({ guardId: a.guardId, timeOn: a.timeOn, timeOff: a.timeOff }); return 1; },
  };
  return { d, calls };
}

describe("WA-9 roster cross-check", () => {
  it("冇名單 → 原樣", async () => {
    const r = [card("a", "甲", "08:00", null)];
    const { d, calls } = deps(null);
    const x = await crossCheckWithRoster({ chatJid: "c", day: "2026-10-20", groupId: "g1", resolved: r, deps: d });
    expect(x.hadRoster).toBe(false);
    expect(x.resolved).toBe(r);
    expect(calls).toHaveLength(0);
  });
  it("全部對到名單 → 補時間、唔出題、唔另寫記錄", async () => {
    const { d, calls } = deps({ a: "m1", b: "m1" });
    const x = await crossCheckWithRoster({ chatJid: "c", day: "2026-10-20", groupId: "g1", resolved: [card("a", "甲", "07:58", "19:02"), card("b", "乙", "08:01", null)], deps: d });
    expect(x.resolved).toEqual([]);
    expect(x.matched).toBe(2);
    expect(calls).toEqual([{ guardId: "a", timeOn: "07:58", timeOff: "19:02" }, { guardId: "b", timeOn: "08:01", timeOff: null }]);
  });
  it("相有名單冇／配唔到人 → 一條合併題（含對到嗰啲仍補時間）", async () => {
    const { d, calls } = deps({ a: "m1" });
    const x = await crossCheckWithRoster({ chatJid: "c", day: "2026-10-20", groupId: "g1", resolved: [card("a", "甲", "08:00", null), card("z", "丙", null, null), card(null, "丁", null, null)], deps: d, nameOfGuard: (g) => (g === "z" ? "丙" : null) });
    expect(calls).toHaveLength(1);
    expect(x.resolved).toHaveLength(1);
    const q = x.resolved[0]!;
    expect(q.routed).toBe("triage");
    expect(q.src?.mismatch?.photo_only.sort()).toEqual(["丁", "丙"]);
    expect(pickWaKind(["roster_mismatch"], "unclear")).toBe("wa_roster_mismatch");
    expect(optionsForWa("wa_roster_mismatch", {} as never).map((o) => o.id)).toContain("wa_ignore");
    expect(rosterMismatchKey("g1", "2026-10-20")).toBe("rm:g1:2026-10-20");
  });
  it("日終：名單有而相冇", () => {
    expect(rosterOnly({ guards: new Map([["a", "m"], ["b", "m"]]) }, new Set(["a"]))).toEqual(["b"]);
  });
});
