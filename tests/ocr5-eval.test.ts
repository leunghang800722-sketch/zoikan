// WP-OCR-5：評估腳本——逐欄比較、報表、重試、並行、--out 限制、參數、圖片規格（同瀏覽器共用 image-plan）、--dry 端到端。
// 合成 fixture（tests/fixtures/ocr-eval/）＋fake client；唔打任何 API、唔讀 data/。
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FULL_MAX_EDGE, SOURCE_MAX_EDGE, TILE_MAX_EDGE, jpegFitsLimit, planDocumentImages, scaledSize, tileRects } from "@/lib/guards/ocr/image-plan";
import { OCR_MAX_IMAGE_CHARS } from "@/lib/guards/ocr/config";
import { tileRects as browserTileRects } from "@/lib/guards/ocr/browser-images";
import { OcrUnavailableError, type VisionRequest } from "@/lib/guards/ocr/vision-client";
import type { FieldResult } from "@/lib/guards/ocr/normalize";
import { buildReport, classifyField, evalCaseWithRetry, fakeClientsFor, parseManifest, resolveReportPath, runEval, runPool, summaryLines, type EvalCase, type EvalDeps } from "../scripts/staff-import/lib/eval-ocr-core";
import { pngSize, prepareDocumentImages } from "../scripts/staff-import/lib/eval-ocr-images";
import { main, parseArgs } from "../scripts/staff-import/eval-ocr";

const FIX = path.resolve(__dirname, "fixtures/ocr-eval");
const MAGICK = process.env.MAGICK_BIN || "/opt/homebrew/bin/magick";
const hasMagick = fs.existsSync(MAGICK);
const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";

const res = (r: Partial<FieldResult> & Pick<FieldResult, "status" | "value">): FieldResult => ({ candidates: [], candidates_ranked: [], ...r });
const ranked = (...vals: string[]) => vals.map((value) => ({ value, sources: ["a"], score: 100, reason: "valid" }));

describe("classifyField：exact／review_contains_truth／wrong／missing", () => {
  it("confirmed 且值等於 truth（用 normalize canon：電話空格、HKID 括號大小寫）→ exact", () => {
    expect(classifyField("phone", "9000 1111", res({ status: "confirmed", value: "90001111" }), "onboarding_form").outcome).toBe("exact");
    expect(classifyField("hkid", "z900001(2)", res({ status: "confirmed", value: "Z900001(2)" }), "id_card").outcome).toBe("exact");
    expect(classifyField("dob", "15-01-1990", res({ status: "confirmed", value: "1990-01-15" }), "id_card").outcome).toBe("exact");
  });
  it("confirmed 但值錯 → wrong（最危險）", () => {
    const e = classifyField("name_zh", "測試甲", res({ status: "confirmed", value: "測試乙" }), "id_card");
    expect(e).toMatchObject({ outcome: "wrong", status: "confirmed", valueCorrect: false });
  });
  it("review：預填值啱 → review_contains_truth（valueCorrect）；truth 只喺候選 → review_contains_truth（要撳）；候選都唔含 → wrong", () => {
    expect(classifyField("name_zh", "測試甲", res({ status: "review", value: "測試甲", candidates: ["測試甲", "測試乙"], candidates_ranked: ranked("測試甲", "測試乙") }), "id_card")).toMatchObject({ outcome: "review_contains_truth", valueCorrect: true, candidateCount: 2 });
    expect(classifyField("name_zh", "測試甲", res({ status: "review", value: "測試乙", candidates: ["測試乙", "測試甲"], candidates_ranked: ranked("測試乙", "測試甲") }), "id_card")).toMatchObject({ outcome: "review_contains_truth", valueCorrect: false });
    expect(classifyField("name_zh", "測試甲", res({ status: "review", value: "測試乙", candidates: ["測試乙"], candidates_ranked: ranked("測試乙") }), "id_card").outcome).toBe("wrong");
  });
  it("舊 server（冇 candidates_ranked）用 candidates 回退", () => {
    const old = { status: "review", value: "測試乙", candidates: ["測試乙", "測試甲"] } as FieldResult;
    expect(classifyField("name_zh", "測試甲", old, "id_card").outcome).toBe("review_contains_truth");
  });
  it("missing → missing", () => {
    expect(classifyField("phone", "90001111", res({ status: "missing", value: "" }), "onboarding_form")).toMatchObject({ outcome: "missing", candidateCount: 0 });
  });
});

describe("manifest／報表／路徑", () => {
  it("parseManifest：合法 → ok；多餘 key／錯 doc type → 只回欄位路徑（唔回值）", () => {
    expect(parseManifest({ cases: [{ id: "c1", docs: [{ type: "id_card", image: "x.png" }], truth: { hkid: "Z900001(2)" } }] }).ok).toBe(true);
    const bad = parseManifest({ cases: [{ id: "c1", docs: [{ type: "passport", image: "SECRET.png" }], truth: {} }] });
    expect(bad).toEqual({ ok: false, path: "cases.0.docs.0.type" });
    expect(JSON.stringify(bad)).not.toContain("SECRET");
    expect(parseManifest({ cases: [{ id: "c1", docs: [{ type: "id_card", image: "x" }], truth: { nope: "1" } }] }).ok).toBe(false);
  });
  it("resolveReportPath：只准 data/ 之下", () => {
    expect(resolveReportPath("data/2026-10/ocr-eval/r.json", "/w")).toBe("/w/data/2026-10/ocr-eval/r.json");
    expect(() => resolveReportPath("out/r.json", "/w")).toThrow("--out 必須喺 data/ 之下");
    expect(() => resolveReportPath("data/../etc/r.json", "/w")).toThrow("--out 必須喺 data/ 之下");
    expect(() => resolveReportPath("/tmp/r.json", "/w")).toThrow("--out 必須喺 data/ 之下");
  });
  it("runPool：保持次序、並行度受限", async () => {
    let active = 0;
    let peak = 0;
    const out = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
  it("buildReport：計數、百分比、review 率、平均候選、人手改字／撳候選估算、usage；per_case 冇值", () => {
    const mk = (id: string, ev: Parameters<typeof buildReport>[0][number]["fields"]) => ({ id, ok: true, fields: ev, usage: { calls: 3, prompt_tokens: 100, completion_tokens: 10, arbiter_calls: 1, by_provider: { claude: { calls: 2, prompt_tokens: 80, completion_tokens: 8 }, deepseek: { calls: 1, prompt_tokens: 20, completion_tokens: 2 } } }, skipped_truth_fields: ["bank_account"] });
    const f = (outcome: "exact" | "review_contains_truth" | "wrong" | "missing", status: "confirmed" | "review" | "missing", valueCorrect = false, candidateCount = 0, field: "phone" | "hkid" = "phone") => ({ doc: (field === "hkid" ? "id_card" : "onboarding_form") as "id_card" | "onboarding_form", field, outcome, status, valueCorrect, candidateCount });
    const r = buildReport([
      mk("c1", [f("exact", "confirmed", true), f("review_contains_truth", "review", true, 2), f("review_contains_truth", "review", false, 3, "hkid")]),
      mk("c2", [f("wrong", "confirmed"), f("missing", "missing")]),
      { id: "c3", ok: false, error: "OcrUnavailableError:429", fields: [], usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0, arbiter_calls: 0, by_provider: { claude: { calls: 0, prompt_tokens: 0, completion_tokens: 0 }, deepseek: { calls: 0, prompt_tokens: 0, completion_tokens: 0 } } }, skipped_truth_fields: [] },
    ], { mode: "dry", limit: null, onlyDocType: null, concurrency: 2, now: new Date("2026-10-15T00:00:00Z") });
    expect(r.cases).toEqual({ total: 3, ok: 2, failed: 1 });
    expect(r.overall).toMatchObject({ n: 5, exact: 1, review_contains_truth: 2, wrong: 1, missing: 1, confirmed_wrong: 1, review_total: 2, review_value_correct: 1, manual_edits_estimate: 2, chip_taps_estimate: 1, avg_candidates: 2.5, review_rate_pct: 40 });
    expect(r.overall.pct).toEqual({ exact: 20, review_contains_truth: 40, wrong: 20, missing: 20 });
    expect(r.by_field.phone!.n).toBe(4);
    expect(r.by_field.hkid!.n).toBe(1);
    expect(r.by_doc_field["onboarding_form.phone"]!.n).toBe(4);
    expect(r.usage).toMatchObject({ calls: 6, prompt_tokens: 200, completion_tokens: 20, arbiter_calls: 2 });
    expect(r.per_case[0]).toEqual({ id: "c1", ok: true, outcomes: { "onboarding_form.phone": "review_contains_truth", "id_card.hkid": "review_contains_truth" } });
    expect(r.per_case[2]).toMatchObject({ ok: false, error: "OcrUnavailableError:429" });
    expect(r.notes.join("|")).toContain("bank_account");
    expect(summaryLines(r).join("\n")).toContain("review 率 40%");
  });
});

describe("evalCaseWithRetry：失敗重試 1 次", () => {
  const c: EvalCase = { id: "t1", docs: [{ type: "onboarding_form", image: "form.png" }], truth: { phone: "90001111" } };
  const base = (over: Partial<EvalDeps> = {}): EvalDeps => ({
    clientsFor: fakeClientsFor,
    prepare: async () => ({ full: IMG, tiles: [IMG, IMG, IMG, IMG] }),
    baseDir: FIX,
    onlyDocType: null,
    ...over,
  });
  it("第 1 次 429、第 2 次成功 → ok", async () => {
    let n = 0;
    const r = await evalCaseWithRetry(c, base({ prepare: async () => { if (n++ === 0) throw new OcrUnavailableError(429, "rate_limit"); return { full: IMG, tiles: [IMG] }; } }));
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0]).toMatchObject({ field: "phone", outcome: "exact" });
  });
  it("兩次都失敗 → ok:false，error 只係類別（reason），唔帶內容", async () => {
    let n = 0;
    const r = await evalCaseWithRetry(c, base({ prepare: async () => { n++; throw new OcrUnavailableError(500, "api_error"); } }));
    expect(n).toBe(2);
    expect(r).toMatchObject({ ok: false, error: "OcrUnavailableError:api_error", fields: [] });
  });
  it("--only-doc-type 過濾：唔包含嘅文件唔讀、truth 欄記入 skipped", async () => {
    const c2: EvalCase = { id: "t2", docs: [{ type: "id_card", image: "a.png" }, { type: "onboarding_form", image: "b.png" }], truth: { sex: "M", phone: "90001111" } };
    const seen: string[] = [];
    const r = await evalCaseWithRetry(c2, base({ onlyDocType: "onboarding_form", prepare: async (p) => { seen.push(path.basename(p)); return { full: IMG, tiles: [IMG] }; } }));
    expect(seen).toEqual(["b.png"]);
    expect(r.fields.map((e) => e.field)).toEqual(["phone"]);
    expect(r.skipped_truth_fields).toContain("sex");
  });
  it("runEval --limit／進度回調", async () => {
    const manifest = { cases: [c, { ...c, id: "t3" }, { ...c, id: "t4" }] };
    const progress: number[] = [];
    const rep = await runEval({ manifest, deps: base(), mode: "dry", limit: 2, concurrency: 2, onProgress: (d) => progress.push(d) });
    expect(rep.cases.total).toBe(2);
    expect(progress).toEqual([1, 2]);
  });
});

describe("圖片規格（browser／Node 共用 image-plan）", () => {
  it("tileRects 同瀏覽器 re-export 一致；分格 0.6、2×2、重疊 20%", () => {
    expect(browserTileRects).toBe(tileRects);
    expect(tileRects(1000, 500)).toEqual([[0, 0, 600, 300], [400, 0, 600, 300], [0, 200, 600, 300], [400, 200, 600, 300]]);
  });
  it("scaledSize／planDocumentImages：長邊 1,600／1,000、唔放大", () => {
    expect(scaledSize(2400, 1200, FULL_MAX_EDGE)).toEqual({ w: 1600, h: 800 });
    expect(scaledSize(800, 500, FULL_MAX_EDGE)).toEqual({ w: 800, h: 500 });
    const p = planDocumentImages(2400, 1600);
    expect(p.full).toEqual({ w: 1600, h: 1067 });
    expect(p.tiles).toHaveLength(4);
    expect(p.tiles[0]!.out).toEqual({ w: 1000, h: 667 });
    expect(SOURCE_MAX_EDGE).toBe(2400);
    expect(TILE_MAX_EDGE).toBe(1000);
  });
  it("jpegFitsLimit：data URL 字元數 ≤ 單張上限", () => {
    expect(jpegFitsLimit(100_000)).toBe(true);
    expect(jpegFitsLimit(Math.ceil(OCR_MAX_IMAGE_CHARS / 4) * 3)).toBe(false);
  });
  it.skipIf(!hasMagick)("prepareDocumentImages：合成 1200×800 → 全圖 1,200 長邊（唔放大）＋4 格 JPEG data URL，尺寸符合 plan", async () => {
    const p = await prepareDocumentImages(path.join(FIX, "form.png"));
    expect(p.tiles).toHaveLength(4);
    const dims = (u: string) => {
      const out = execFileSync(MAGICK, ["jpg:-", "-format", "%w %h", "info:"], { input: Buffer.from(u.replace("data:image/jpeg;base64,", ""), "base64") }).toString();
      return out.split(" ").map(Number);
    };
    expect(p.full.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(dims(p.full)).toEqual([1200, 800]);
    const plan = planDocumentImages(1200, 800);
    expect(dims(p.tiles[0]!)).toEqual([plan.tiles[0]!.out.w, plan.tiles[0]!.out.h]);
    expect(plan.tiles[0]!.out).toEqual({ w: 720, h: 480 });
  });
  it.skipIf(!hasMagick)("大圖（3000×2000）先縮 2,400 再出 1,600 全圖／1,000 格；PNG 尺寸讀取", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr5-test-"));
    try {
      const big = path.join(dir, "big.png");
      execFileSync(MAGICK, ["-size", "3000x2000", "xc:white", "-fill", "black", "-draw", "rectangle 100,100 900,300", big]);
      const p = await prepareDocumentImages(big);
      const full = Buffer.from(p.full.replace("data:image/jpeg;base64,", ""), "base64");
      expect(execFileSync(MAGICK, ["jpg:-", "-format", "%w %h", "info:"], { input: full }).toString()).toBe("1600 1067");
      expect(pngSize(fs.readFileSync(big))).toEqual({ w: 3000, h: 2000 });
      await expect(prepareDocumentImages("relative/big.png")).rejects.toThrow("path_not_absolute");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it.skipIf(!hasMagick || !fs.existsSync("/opt/homebrew/bin/pdftoppm"))("PDF 頁：magick 生成合成 PDF → pdftoppm → 同規格出圖", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr5-test-"));
    try {
      const pdf = path.join(dir, "x.pdf");
      execFileSync(MAGICK, [path.join(FIX, "form.png"), pdf]);
      const p = await prepareDocumentImages(pdf, 1);
      expect(p.tiles).toHaveLength(4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("eval-ocr CLI：參數同 --dry 端到端", () => {
  it("parseArgs：預設 concurrency 2；--limit／--only-doc-type／--concurrency；非法值拋錯", () => {
    expect(parseArgs([])).toMatchObject({ dry: false, concurrency: 2, limit: null, onlyDocType: null });
    expect(parseArgs(["--dry", "--limit", "3", "--only-doc-type", "id_card", "--concurrency", "4", "--out", "data/x.json", "--manifest", "m.json"])).toMatchObject({ dry: true, limit: 3, onlyDocType: "id_card", concurrency: 4, out: "data/x.json", manifest: "m.json" });
    expect(() => parseArgs(["--only-doc-type", "passport"])).toThrow();
    expect(() => parseArgs(["--nope"])).toThrow();
    for (const bad of ["0", "-3", "abc", "2.5", ""]) expect(() => parseArgs(["--limit", bad])).toThrow("--limit 必須係正整數");
    expect(() => parseArgs(["--limit"])).toThrow();
  });
  it("合成 manifest 格式正確，且 fixture 檔案存在", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIX, "manifest.dry.json"), "utf-8"));
    const m = parseManifest(raw);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    for (const c of m.manifest.cases) for (const d of c.docs) expect(fs.existsSync(path.join(FIX, d.image))).toBe(true);
  });
  it.skipIf(!hasMagick)("--dry 用合成 manifest 跑通：數字固定（候選字／仲裁／check digit 排序／缺值／錯值），console 冇值冇姓名", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    try {
      const code = await main(["--dry", "--manifest", path.join(FIX, "manifest.dry.json")]);
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const text = logs.join("\n");
    expect(text).toContain("dry（fake client）");
    expect(text).toContain("cases 6/6 ok");
    // OCR-1.2：入職表 name_zh／hkid／dob 係交叉核對欄，唔計入總體（同 OCR-5 基線 13 欄可比），另出 cross_fields
    expect(text).toContain("已評估欄位 13");
    expect(text).toContain("exact 8 (61.5%)"); // OCR-2.2：地址 exact 用 strict，syn-06 大厦／大廈 由 exact 變 review_contains_truth
    expect(text).toContain("review_contains_truth 3 (23.1%)");
    expect(text).toContain("wrong 1 (7.7%)，其中 confirmed 但錯 0");
    expect(text).toContain("missing 1 (7.7%)");
    expect(text).toContain("交叉核對欄（入職表 name_zh/hkid/dob，不計入總體）：n=3 exact 3｜wrong 0｜missing 0");
    expect(text).toContain("注入 refs 入職表文件 1｜cross match 3 / differs 0 / unreadable 0");
    expect(text).toContain("仲裁 2 份文件"); // OCR-2：大厦／大廈 canon 一致，唔再入仲裁（改為 review 兩個寫法），故 3 → 2
    expect(text).toContain("ALS 政府地址庫：開｜查過文件 1｜出候選文件 1｜失敗 0｜review_contains_truth 入面真值來自 ALS 候選 0");
    for (const v of ["測試甲", "Z900001", "90001111", "示範街", "syn-0", "form.png"]) expect(text).not.toContain(v);
  });
  it.skipIf(!hasMagick)("--out 寫入 cwd/data/ 之下：JSON 淨有 case id＋逐欄結果類別，冇值冇路徑", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr5-cwd-"));
    const cwd = process.cwd();
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.chdir(dir);
      expect(await main(["--dry", "--manifest", path.join(FIX, "manifest.dry.json"), "--out", "data/2026-10/ocr-eval/r.json", "--limit", "2"])).toBe(0);
      const txt = fs.readFileSync(path.join(dir, "data/2026-10/ocr-eval/r.json"), "utf-8");
      const j = JSON.parse(txt);
      expect(j.cases).toEqual({ total: 2, ok: 2, failed: 0 });
      expect(j.mode).toBe("dry");
      expect(Object.keys(j.per_case[0].outcomes)).toContain("id_card.hkid");
      for (const v of ["測試甲", "Z900001", "90001111", "示範街", "form.png", "id-card.png"]) expect(txt).not.toContain(v);
    } finally {
      process.chdir(cwd);
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("--out 唔喺 data/ 之下 → main 拋 out_not_under_data（唔寫檔）", async () => {
    await expect(main(["--dry", "--manifest", path.join(FIX, "manifest.dry.json"), "--out", "/tmp/ocr5-never.json"])).rejects.toThrow("--out 必須喺 data/ 之下");
    expect(fs.existsSync("/tmp/ocr5-never.json")).toBe(false);
  });
  it("缺 --manifest 又唔係 --dry → exit 2；manifest 壞 → exit 2（只印路徑）", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main([])).toBe(2);
      const bad = path.join(os.tmpdir(), `ocr5-bad-${process.pid}.json`);
      fs.writeFileSync(bad, JSON.stringify({ cases: [{ id: "x", docs: [], truth: {} }] }));
      expect(await main(["--manifest", bad])).toBe(2);
      fs.rmSync(bad);
    } finally {
      err.mockRestore();
    }
  });
});

describe("fakeClientsFor（dry 用）", () => {
  it("預設按 truth 完美回應；case.fake 覆蓋讀 A（object 格式）；仲裁預設讀啱", async () => {
    const c: EvalCase = { id: "t", docs: [{ type: "onboarding_form", image: "x" }], truth: { phone: "90001111" }, fake: { onboarding_form: { a: { phone: { value: "90001112", confidence: "low" } } } } };
    const cl = fakeClientsFor(c, "onboarding_form");
    const req = (fields: string[]): VisionRequest => ({ system: "s", userText: "u", images: [IMG], fields });
    expect(JSON.parse((await cl.a.complete(req(["phone", "address"]))).text)).toEqual({ phone: { value: "90001112", confidence: "low" }, address: null });
    expect(JSON.parse((await cl.b.complete(req(["phone"]))).text)).toEqual({ phone: "90001111" });
    expect(JSON.parse((await cl.arbiter!.complete(req(["phone"]))).text)).toEqual({ phone: "90001111" });
    expect(cl.a.provider).toBe("claude");
    expect(cl.b.provider).toBe("deepseek");
  });
});
