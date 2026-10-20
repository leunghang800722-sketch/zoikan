// OCR-6.1：電話盲讀仲裁（prompt 唔帶候選值）＋獨立來源佐證（打字名單／已存電話）＋ eval 診斷（breakdown／--phone-blind）。假資料 9000xxxx。
import { describe, it, expect } from "vitest";
import { reconcile } from "@/lib/guards/ocr/reconcile";
import { buildArbiterSystemPrompt, buildArbiterUserText, buildArbiterUserTextCrops } from "@/lib/guards/ocr/prompts";
import { buildReport, classifyPhoneWrong, evalCase, fakeClientsFor, type CaseOutcome, type EvalCase, type EvalDeps, type FieldEval } from "../scripts/staff-import/lib/eval-ocr-core";
import { parseArgs } from "../scripts/staff-import/eval-ocr";

const NOW = new Date("2026-10-20T00:00:00Z");

describe("reconcile phone：獨立來源佐證（OCR-6.1）", () => {
  it("三讀一致＋獨立來源（正規化後）相同 → confirmed", () => {
    expect(reconcile("phone", "9000 1111", "90001111", NOW, "90001111", undefined, ["+852 9000-1111"])).toMatchObject({ status: "confirmed", value: "90001111" });
    expect(reconcile("phone", "90001111", "90001111", NOW, "90001111", undefined, ["90001112", "90001111"])).toMatchObject({ status: "confirmed" }); // 多個來源其中一個啱
  });
  it("三讀一致但冇獨立來源（undefined／null／空陣列／全部格式唔合）→ review phone_no_independent_source，預填 OCR 值", () => {
    for (const ind of [undefined, null, [], ["abc"], ["1234"]]) {
      const r = reconcile("phone", "90001111", "90001111", NOW, "90001111", undefined, ind);
      expect(r, JSON.stringify(ind)).toMatchObject({ status: "review", value: "90001111", reason: "phone_no_independent_source", arbiter: "agree_a" });
    }
  });
  it("獨立來源唔同 → review phone_differs_from_list，候選兩個（OCR 值預填）", () => {
    const r = reconcile("phone", "90001111", "90001111", NOW, "90001111", undefined, ["9000 1119"]);
    expect(r).toMatchObject({ status: "review", value: "90001111", reason: "phone_differs_from_list" });
    expect(r.candidates).toEqual(expect.arrayContaining(["90001111", "90001119"]));
    expect(r.candidates_ranked.some((c) => c.sources.includes("list"))).toBe(true);
  });
  it("三讀唔一致時，獨立來源同其中一讀相同都唔 confirmed；位數唔係 8 照舊 phone_digit_count", () => {
    expect(reconcile("phone", "90001111", "90001111", NOW, "90001112", undefined, ["90001111"])).toMatchObject({ status: "review", reason: "phone_needs_three_way" });
    expect(reconcile("phone", "90001111", "90001112", NOW, "90001111", undefined, ["90001111"])).toMatchObject({ status: "review", reason: "phone_needs_three_way", arbiter: "agree_a" });
    expect(reconcile("phone", "900011111", "900011111", NOW, "900011111", undefined, ["900011111"])).toMatchObject({ status: "review", reason: "phone_digit_count" });
  });
  it("其他欄不變：independent 參數對非電話欄冇影響", () => {
    expect(reconcile("name_zh", "測試甲", "測試甲", NOW, undefined, undefined, ["x"])).toMatchObject({ status: "confirmed" });
    expect(reconcile("name_zh", "測試甲", "測試乙", NOW, "測試甲")).toMatchObject({ status: "confirmed", arbiter: "agree_a" });
  });
});

describe("盲讀仲裁 prompt（OCR-6.1）", () => {
  const cands = { phone: ["90001111", "90001112"], name_zh: ["測試甲", "測試乙"] } as const;
  it("blind=[phone]：user text／crops 版都唔含電話候選值，帶 BLIND 指示；其他欄候選照舊；system prompt 講明盲讀", () => {
    for (const t of [buildArbiterUserText("onboarding_form", cands, 4, {}, ["phone"]), buildArbiterUserTextCrops("onboarding_form", cands, ["phone", "name_zh"], {}, ["phone"])]) {
      expect(t).not.toContain("90001111");
      expect(t).not.toContain("90001112");
      expect(t).toContain("BLIND");
      expect(t).toContain("測試甲"); // 其他欄候選不變
    }
    expect(buildArbiterSystemPrompt("onboarding_form", ["phone", "name_zh"], ["phone"])).toContain("BLIND");
  });
  it("冇 blind（預設）＝舊行為：候選全部列出，冇 BLIND 字樣", () => {
    const t = buildArbiterUserText("onboarding_form", cands, 4);
    expect(t).toContain("90001111");
    expect(t).not.toContain("BLIND");
    expect(buildArbiterSystemPrompt("onboarding_form", ["phone"])).not.toContain("BLIND");
  });
});

describe("eval 診斷：classifyPhoneWrong／breakdown／--phone-blind", () => {
  it("classifyPhoneWrong：truth_from_list_differs > unanimous_wrong > arbiter_anchored > other", () => {
    const u = { a: "90001119", b: "90001119", arbiter: "90001119" };
    expect(classifyPhoneWrong(u, "90001111", "90001119", "list")).toBe("truth_from_list_differs");
    expect(classifyPhoneWrong(u, "90001111", "90001119", "form")).toBe("unanimous_wrong");
    expect(classifyPhoneWrong(u, "90001111", "90001119", undefined)).toBe("unanimous_wrong");
    expect(classifyPhoneWrong({ a: "90001119", b: "90001118", arbiter: "90001119" }, "90001111", "90001119", undefined)).toBe("arbiter_anchored");
    expect(classifyPhoneWrong({ a: "90001118", b: "90001119", arbiter: "90001119" }, "90001111", "90001119", undefined)).toBe("arbiter_anchored");
    expect(classifyPhoneWrong({ a: "90001117", b: "90001118", arbiter: "90001119" }, "90001111", "90001119", undefined)).toBe("other");
    expect(classifyPhoneWrong(undefined, "90001111", "90001119", undefined)).toBe("other");
  });
  it("evalCase：三讀一致且名單同樣錯 → confirmed_wrong 計 unanimous_wrong；truth_source=list → truth_from_list_differs；breakdown 入 by_field.phone，不含值", async () => {
    const deps: EvalDeps = { clientsFor: fakeClientsFor, prepare: async () => ({ full: "data:image/png;base64,AA", tiles: [] }), baseDir: ".", onlyDocType: null, flow: "legacy", now: NOW };
    const wrong = { onboarding_form: { a: { phone: "90001119" }, b: { phone: "90001119" }, arbiter: { phone: "90001119" } } };
    const mk = (id: string, extra: Partial<EvalCase>): EvalCase => ({ id, docs: [{ type: "onboarding_form", image: "x.png" }], truth: { phone: "90001111" }, list: { phone: "90001119" }, fake: wrong, ...extra });
    const o1 = await evalCase(mk("c1", {}), deps);
    const o2 = await evalCase(mk("c2", { truth_source: { phone: "list" } }), deps);
    expect(o1.fields[0]).toMatchObject({ field: "phone", outcome: "wrong", status: "confirmed", phoneWrongKind: "unanimous_wrong" });
    expect(o2.fields[0]).toMatchObject({ phoneWrongKind: "truth_from_list_differs" });
    const rep = buildReport([o1, o2], { mode: "dry", limit: null, onlyDocType: null, concurrency: 1, flow: "legacy", now: NOW });
    expect(rep.by_field.phone).toMatchObject({ confirmed_wrong: 2, breakdown: { unanimous_wrong: 1, arbiter_anchored: 0, truth_from_list_differs: 1, other: 0 } });
    expect(JSON.stringify(rep)).not.toContain("9000111");
  });
  it("--phone-blind／--no-phone-blind：預設 on（同 app 一樣）；evalCase 傳落 phoneBlind，盲讀時仲裁 request 唔含候選值", async () => {
    expect(parseArgs([]).phoneBlind).toBe(true);
    expect(parseArgs(["--phone-blind"]).phoneBlind).toBe(true);
    expect(parseArgs(["--no-phone-blind"]).phoneBlind).toBe(false);
    const seen: string[] = [];
    const deps = (phoneBlind: boolean): EvalDeps => ({
      clientsFor: (c, doc) => {
        const cl = fakeClientsFor(c, doc);
        const arb = cl.arbiter!;
        return { ...cl, arbiter: { ...arb, complete: async (req) => { seen.push(req.userText); return arb.complete(req); } } };
      },
      prepare: async () => ({ full: "data:image/png;base64,AA", tiles: [] }),
      baseDir: ".",
      onlyDocType: null,
      flow: "legacy",
      phoneBlind,
      now: NOW,
    });
    const c: EvalCase = { id: "c", docs: [{ type: "onboarding_form", image: "x.png" }], truth: { phone: "90001111" }, fake: { onboarding_form: { a: { phone: "90001111" }, b: { phone: "90001112" } } } };
    await evalCase(c, deps(true));
    await evalCase(c, deps(false));
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toContain("90001111");
    expect(seen[0]).not.toContain("90001112");
    expect(seen[1]).toContain("90001111");
    expect(seen[1]).toContain("90001112");
  });
  it("buildReport：冇電話 confirmed_wrong 時 breakdown 全 0", () => {
    const f: FieldEval = { doc: "onboarding_form", field: "phone", outcome: "exact", status: "confirmed", valueCorrect: true, candidateCount: 0 };
    const o: CaseOutcome = { id: "x", ok: true, fields: [f], usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0, arbiter_calls: 0, by_provider: { claude: { calls: 0, prompt_tokens: 0, completion_tokens: 0 }, deepseek: { calls: 0, prompt_tokens: 0, completion_tokens: 0 } } }, skipped_truth_fields: [] };
    expect(buildReport([o], { mode: "dry", limit: null, onlyDocType: null, concurrency: 1 }).by_field.phone!.breakdown).toEqual({ unanimous_wrong: 0, arbiter_anchored: 0, truth_from_list_differs: 0, other: 0 });
  });
});
