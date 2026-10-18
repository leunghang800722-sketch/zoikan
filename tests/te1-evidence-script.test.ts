// TE-1：本機腳本 scripts/staff-import/20-triage-evidence.ts（--dry 合成證件版面；唔讀 data、唔打 API）。
// 涵蓋：來源優先順序（有證件用證件／冇證件退入職表／兩者都有次序）、身份證裁圖幾何（避開相片區，M8）、
//       manifest／zip 格式（用伺服器自己嘅 readEvidenceZip 驗，M6）、zip 分批上限、現成裁圖索引。
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import {
  buildExistingIndex,
  dryFixture,
  drawSyntheticPage,
  emptyStats,
  finalizeImage,
  parseArgs,
  produceItems,
  run,
  syntheticFormPage,
  syntheticIdCardPage,
  type Deps,
  type PersonInput,
} from "../scripts/staff-import/20-triage-evidence";
import {
  buildEvidenceZips,
  entryNameOf,
  evidenceFieldsOf,
  intersects,
  locateFormFieldBox,
  locateIdCardBoxes,
  matchOfPerson,
  planRequests,
  ZIP_MAX_ENTRIES,
} from "../scripts/staff-import/lib/triage-evidence-core";
import type { DocPage } from "../scripts/staff-import/lib/triage-reread-core";
import { readEvidenceZip, evidenceManifestSchema } from "@/lib/triage/evidence-upload";
import { MAX_IMAGE_BYTES, inspectImage } from "@/lib/triage/evidence-format";
import { fakeJpeg } from "./lib/te1-images";

const sh = promisify(execFile);
const MAGICK = existsSync("/opt/homebrew/bin/magick") ? "/opt/homebrew/bin/magick" : "magick";
const hasMagick = await sh(MAGICK, ["-version"]).then(() => true, () => false);

const doc = (type: DocPage["type"], n = 1): DocPage => ({ type, docId: `d${n}-${type}`, page: 1 });
const lf = (value: string | null, status: "confirmed" | "review" | "missing") => ({ value, status });

describe("來源優先順序（老闆 2026-10-18 補充，方案 §7）", () => {
  const ID = doc("id_card");
  const AP = doc("address_proof");
  const FORM = doc("onboarding_form");
  const sig = (docs: DocPage[], fields: Parameters<typeof planRequests>[0]) => planRequests(fields, docs).map((r) => `${r.field}:${r.docKind}:${r.priority}`);

  it("有證件用證件（身份證欄 priority 1），入職表排第二（兩張都出，優先排前）", () => {
    expect(sig([FORM, ID], ["hkid", "name_zh", "name_en", "dob"])).toEqual([
      "hkid:id_card:1", "hkid:onboarding_form:2",
      "name_zh:id_card:1", "name_zh:onboarding_form:2",
      "name_en:id_card:1", "name_en:onboarding_form:2",
      "dob:id_card:1", "dob:onboarding_form:2",
    ]);
  });

  it("冇證件退入職表（priority 2）；冇入職表就只有證件", () => {
    expect(sig([FORM], ["name_zh", "dob", "hkid"])).toEqual(["name_zh:onboarding_form:2", "dob:onboarding_form:2", "hkid:onboarding_form:2"]);
    expect(sig([ID], ["name_zh"])).toEqual(["name_zh:id_card:1"]);
    expect(sig([], ["name_zh"])).toEqual([]);
  });

  it("住址：住址證明優先、入職表次之；冇住址證明先用入職表；身份證唔係住址來源", () => {
    expect(sig([ID, FORM, AP], ["address"])).toEqual(["address:address_proof:1", "address:onboarding_form:2"]);
    expect(sig([ID, FORM], ["address"])).toEqual(["address:onboarding_form:2"]);
    expect(sig([ID, AP], ["address"])).toEqual(["address:address_proof:1"]);
  });

  it("電話只有入職表（priority 1）；證件唔出電話", () => {
    expect(sig([ID, AP, FORM], ["phone"])).toEqual(["phone:onboarding_form:1"]);
    expect(sig([ID, AP], ["phone"])).toEqual([]);
  });

  it("evidenceFieldsOf：review 欄；身份證號 review／missing 都要；confirmed 唔出", () => {
    const p = (o: object) => ({ key: "k", hkid: lf(null, "missing"), nameZh: lf("測試甲", "confirmed"), nameEn: lf("A", "confirmed"), dateOfBirth: lf("1990-01-01", "confirmed"), phone: lf("9", "confirmed"), address: lf("x", "confirmed"), staffNumbers: [{ number: "U1" }], ...o }) as never;
    expect(evidenceFieldsOf(p({}))).toEqual(["hkid"]);
    expect(evidenceFieldsOf(p({ hkid: lf("Z1", "confirmed") }))).toEqual([]);
    expect(evidenceFieldsOf(p({ hkid: lf("Z1", "review"), phone: lf("9", "review"), address: lf("x", "review") }))).toEqual(["hkid", "phone", "address"]);
  });

  it("match 由同一條 package 記錄產生：身份證值＋工號", () => {
    const p = { key: "k", hkid: lf(" Z900001(1) ", "review"), staffNumbers: [{ number: "U1" }, { number: "U2" }] } as never;
    expect(matchOfPerson(p)).toEqual({ hkid: "Z900001(1)", staff_numbers: ["U1", "U2"] });
    expect(matchOfPerson({ key: "k", hkid: lf(null, "missing"), staffNumbers: [] } as never)).toEqual({ hkid: null, staff_numbers: [] });
  });
});

describe("身份證裁圖幾何（M8：真卡版面——相片右上、號碼喺相片正下方）", () => {
  const lineOf = (lines: { t: string }[], t: string) => lines.find((l) => l.t.includes(t))! as { t: string; x: number; y: number; w: number; h: number };
  const inside = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => l.x >= b.x0 - 1e-9 && l.x + l.w <= b.x1 + 1e-9 && l.y >= b.y0 - 1e-9 && l.y + l.h <= b.y1 + 1e-9;

  it("真版面：所有欄位框唔入真相片矩形，亦唔入規則推出嘅相片區；號碼／中文名／英文名／出生日期各自一框", () => {
    const { lines, photo } = syntheticIdCardPage();
    const g = locateIdCardBoxes(1, lines);
    expect(g.photo).not.toBeNull();
    for (const k of ["hkid", "name_zh", "name_en", "dob"] as const) {
      const b = g[k];
      expect(b, k).not.toBeNull();
      expect(intersects(b!, photo), `${k} 唔入真相片區`).toBe(false);
      expect(intersects(b!, g.photo!), `${k} 唔入推算相片區`).toBe(false);
    }
    expect(inside(g.hkid!, lineOf(lines, "Z900001"))).toBe(true);
    expect(inside(g.name_zh!, lineOf(lines, "測試甲"))).toBe(true);
    expect(inside(g.name_en!, lineOf(lines, "TESTER"))).toBe(true);
    expect(inside(g.dob!, lineOf(lines, "15-01-1990"))).toBe(true);
    expect(inside(g.hkid!, lineOf(lines, "TESTER"))).toBe(false);
    expect(inside(g.hkid!, lineOf(lines, "測試甲"))).toBe(false);
    expect(inside(g.name_zh!, lineOf(lines, "Z900001"))).toBe(false);
    expect(inside(g.name_zh!, lineOf(lines, "TESTER"))).toBe(false);
    expect(inside(g.name_en!, lineOf(lines, "測試甲"))).toBe(false);
    expect(inside(g.dob!, lineOf(lines, "Z900001"))).toBe(false);
  });

  it("號碼框只向下外擴（向上最多 0.001，唔切入相片底）；左邊欄位右緣喺相片左緣之前", () => {
    const { lines, photo } = syntheticIdCardPage();
    const g = locateIdCardBoxes(1, lines);
    const hk = lineOf(lines, "Z900001");
    expect(g.hkid!.y1).toBeLessThanOrEqual(hk.y + hk.h + 0.0011);
    expect(g.hkid!.y0).toBeLessThan(hk.y); // 向下有外擴
    expect(g.hkid!.y1).toBeLessThanOrEqual(photo.y0);
    for (const k of ["name_zh", "name_en", "dob"] as const) expect(g[k]!.x1, k).toBeLessThanOrEqual(photo.x0);
  });

  it("邊界：號碼行緊貼相片底（相片下緣只高過行頂 0.003）→ 號碼框頂仍然低過相片底", () => {
    const { lines, photo, hkidTop } = syntheticIdCardPage(true, 0.003);
    expect(photo.y0 - hkidTop).toBeCloseTo(0.003, 6);
    const g = locateIdCardBoxes(1, lines);
    expect(g.hkid).not.toBeNull();
    expect(g.hkid!.y1).toBeLessThan(photo.y0);
    expect(intersects(g.hkid!, photo)).toBe(false);
    // 再貼近少少（0.0015）：框頂仍然唔入相片
    const tight = syntheticIdCardPage(true, 0.0015);
    const g2 = locateIdCardBoxes(1, tight.lines);
    expect(g2.hkid!.y1).toBeLessThan(tight.photo.y0);
  });

  it("右側冇文字行（版面唔同）→ 保守當相片佔右側上方 55%；號碼若喺左邊仍然唔入相片區", () => {
    const { lines } = syntheticIdCardPage();
    const left = lines.map((l) => (l.t.includes("Z900001") ? { ...l, x: 0.1, y: 0.49 } : l));
    const g = locateIdCardBoxes(1, left);
    expect(g.photo).not.toBeNull();
    for (const k of ["hkid", "name_zh", "name_en", "dob"] as const) if (g[k]) expect(intersects(g[k]!, g.photo!), k).toBe(false);
  });

  it("認唔出卡面（冇身份證 anchor）→ 一律唔裁，寧願冇圖都唔好連相片一齊裁", () => {
    const g = locateIdCardBoxes(1, syntheticIdCardPage(false).lines);
    expect(g).toMatchObject({ hkid: null, name_zh: null, name_en: null, dob: null, reason: "no_card_anchor" });
  });

  it.skipIf(!hasMagick)("像素級（真版面）：畫假證件頁（相片＝純紅，號碼喺相片正下方），經真 finalizeImage 裁出嚟嘅圖冇紅色；JPEG 過伺服器 header 檢查、≤120KB、長邊 ≤800", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1t-"));
    try {
      for (const gap of [0.005, 0.003]) {
        const { lines, photo } = syntheticIdCardPage(true, gap);
        const png = path.join(tmp, `page-${gap}.png`);
        await drawSyntheticPage({ doc: doc("id_card"), lines, photo }, png);
        const g = locateIdCardBoxes(1, lines);
        for (const k of ["hkid", "name_zh", "name_en", "dob"] as const) {
          const bytes = await finalizeImage(png, g[k], tmp);
          expect(bytes, `${gap}/${k}`).not.toBeNull();
          expect(bytes!.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
          const info = inspectImage(bytes!);
          expect(info?.mime).toBe("image/jpeg"); // 冇 EXIF／APPn（-strip）
          expect(Math.max(info!.width, info!.height)).toBeLessThanOrEqual(800);
          const out = path.join(tmp, `o-${gap}-${k}.jpg`);
          await (await import("node:fs/promises")).writeFile(out, bytes!);
          // r-g 嘅最大值：紅色相片 ≈1，灰／白 ≈0
          const m = await sh(MAGICK, [out, "-fx", "r-g", "-format", "%[fx:maxima]", "info:"]);
          expect(Number(m.stdout), `${gap}/${k} 冇紅色`).toBeLessThan(0.15);
        }
        // 對照：成頁（唔避開）一定有紅色，證明測試真係量度到相片
        const whole = await finalizeImage(png, null, tmp);
        const wp = path.join(tmp, `whole-${gap}.jpg`);
        await (await import("node:fs/promises")).writeFile(wp, whole!);
        const m2 = await sh(MAGICK, [wp, "-fx", "r-g", "-format", "%[fx:maxima]", "info:"]);
        expect(Number(m2.stdout)).toBeGreaterThan(0.5);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("入職表：電話／地址用現有幾何；姓名／身份證號／出生日期用 label 行；冇 label＝null", () => {
    const f = syntheticFormPage();
    for (const field of ["phone", "address", "name_zh", "name_en", "dob", "hkid"] as const) expect(locateFormFieldBox(field, f), field).not.toBeNull();
    expect(locateFormFieldBox("name_zh", [])).toBeNull();
    expect(locateFormFieldBox("dob", f.filter((l) => !/出生日期/.test(l.t)))).toBeNull();
  });
});

describe("--dry 全流程（合成 fixture）", () => {
  it.skipIf(!hasMagick)("每人出圖符合 §7：有證件用證件；冇證件退入職表；兩者都有次序；認唔出卡面唔裁身份證欄；冇文件／冇 review 欄唔出", async () => {
    const r = await run(parseArgs(["--dry"]));
    const bySig = (key: string) => r.items.filter((i) => i.match.staff_numbers[0] === key).map((i) => `${i.field}:${i.docKind}:${i.priority}`);
    // 人 1：三份文件齊
    expect(bySig("DRY1")).toEqual(expect.arrayContaining(["hkid:id_card:1", "hkid:onboarding_form:2", "name_zh:id_card:1", "name_zh:onboarding_form:2", "dob:id_card:1", "address:address_proof:1", "address:onboarding_form:2", "phone:onboarding_form:1"]));
    // 人 2：冇住址證明 → 住址只有入職表（priority 2）；相片喺左嘅版面一樣出
    expect(bySig("DRY2")).toContain("address:onboarding_form:2");
    expect(bySig("DRY2")).not.toContain("address:address_proof:1");
    expect(bySig("DRY2")).toContain("name_en:id_card:1");
    // 人 3：冇證件 → 退入職表
    expect(bySig("DRY3")).toEqual(expect.arrayContaining(["hkid:onboarding_form:2", "name_zh:onboarding_form:2", "name_en:onboarding_form:2", "dob:onboarding_form:2", "phone:onboarding_form:1", "address:onboarding_form:2"]));
    expect(bySig("DRY3").some((s) => s.includes("id_card"))).toBe(false);
    // 人 4 冇文件、人 6 冇 review 欄 → 冇圖
    expect(bySig("DRY4")).toEqual([]);
    expect(bySig("DRY6")).toEqual([]);
    // 人 5：認唔出卡面 → 身份證欄唔裁，退入職表
    expect(bySig("DRY5").some((s) => s.includes("id_card"))).toBe(false);
    expect(r.stats).toMatchObject({ persons_total: 6, persons_with_fields: 5, persons_no_docs: 1, persons_failed: 0 });
    expect(r.stats.skipped.no_card_anchor).toBe(4);
    // 同一欄 priority 1 一定排喺 priority 2 前面（每人內）
    for (const key of ["DRY1", "DRY2"]) {
      const mine = r.items.filter((i) => i.match.staff_numbers[0] === key);
      for (const f of new Set(mine.map((i) => i.field))) {
        const pr = mine.filter((i) => i.field === f).map((i) => i.priority);
        expect(pr).toEqual([...pr].sort());
        expect(pr.length).toBeLessThanOrEqual(2);
      }
    }
  });

  it.skipIf(!hasMagick)("zip 過伺服器自己嘅 readEvidenceZip＋manifest schema：entry 名不透明、每個 item 帶 match／doc_kind／priority、圖 ≤120KB 且冇 EXIF；console 統計淨計數", async () => {
    const r = await run(parseArgs(["--dry"]));
    expect(r.zips.length).toBe(1);
    const { manifest, images } = await readEvidenceZip(r.zips[0]!);
    expect(evidenceManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.items.length).toBe(r.items.length);
    for (const it of manifest.items) {
      expect(it.file).toMatch(/^[a-f0-9]{32}\.jpg$/);
      expect([1, 2]).toContain(it.priority);
      expect(it.match.hkid || (it.match.staff_numbers?.length ?? 0) > 0).toBeTruthy();
      const bytes = images.get(it.file)!;
      expect(bytes.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
      expect(inspectImage(bytes)).not.toBeNull();
      expect(it.file).toBe(entryNameOf(bytes));
    }
    const z = await JSZip.loadAsync(r.zips[0]!);
    expect(Object.keys(z.files).every((n) => n === "manifest.json" || /^[a-f0-9]{32}\.jpg$/.test(n))).toBe(true);
    const { statsLines } = await import("../scripts/staff-import/20-triage-evidence");
    const text = statsLines(r.stats).join("\n");
    expect(text).not.toMatch(/測試甲|Z900001|DRY\d|dry-doc/);
  });
});

describe("zip 分批與上限", () => {
  const item = (n: number, o: Partial<{ field: "name_zh"; docKind: "id_card"; priority: 1 }> = {}) => ({
    bytes: fakeJpeg(300, 60, { seed: n }),
    field: o.field ?? ("name_zh" as const),
    docKind: o.docKind ?? ("id_card" as const),
    priority: o.priority ?? (1 as const),
    match: { hkid: "Z900001(1)", staff_numbers: [`U${n}`] },
  });

  it("每 zip ≤ maxEntries 張（預設 300）；超過就分多個 zip；每個 zip 都過伺服器 readEvidenceZip", async () => {
    expect(ZIP_MAX_ENTRIES).toBe(300);
    const items = Array.from({ length: 7 }, (_, i) => item(i));
    const { zips, items: n } = await buildEvidenceZips(items, { maxEntries: 3 });
    expect(zips.length).toBe(3);
    expect(n).toBe(7);
    let total = 0;
    for (const z of zips) total += (await readEvidenceZip(z)).manifest.items.length;
    expect(total).toBe(7);
    const big = await buildEvidenceZips(Array.from({ length: 301 }, (_, i) => item(i)));
    expect(big.zips.length).toBe(2);
  });

  it("按 bytes 分批；超 120KB／帶 EXIF／唔係 JPEG 嘅圖直接丟（唔入 zip）", async () => {
    const a = item(1);
    const { zips } = await buildEvidenceZips([a, item(2), item(3)], { maxBytes: a.bytes.byteLength * 2 + 1 });
    expect(zips.length).toBe(2);
    const bad = [{ ...item(4), bytes: fakeJpeg(300, 60, { pad: MAX_IMAGE_BYTES }) }, { ...item(5), bytes: fakeJpeg(300, 60, { exif: true }) }, { ...item(6), bytes: new Uint8Array(100).fill(3) }, item(7)];
    const r = await buildEvidenceZips(bad);
    expect(r.items).toBe(1);
  });

  it("相同圖多個 item：zip 只存一次 entry", async () => {
    const x = item(9);
    const { zips } = await buildEvidenceZips([x, { ...x, field: "name_zh" as const, priority: 1 as const }]);
    const z = await JSZip.loadAsync(zips[0]!);
    expect(Object.keys(z.files).filter((n) => n !== "manifest.json")).toHaveLength(1);
  });
});

describe("現成裁圖索引（M8／M3）與依賴注入", () => {
  it("只認 phone*-crops（入職表電話）同 address-crops*（住址證明）；name-crops／其他一律忽略；路徑相對 json 上一層", () => {
    const e = (docId: string, page: number, file: string) => ({ docId, page, file });
    const { index, ignored } = buildExistingIndex([
      { name: "phone-crops.json", base: "/base", entries: [e("d1", 3, "crops/phone/d1-p3.png")] },
      { name: "phone2-crops.json", base: "/base", entries: [e("d2", 1, "crops/phone2/d2-p1.png")] },
      { name: "address-crops-new.json", base: "/base", entries: [e("d3", 2, "crops/address/d3-p2.png")] },
      { name: "name-crops.json", base: "/base", entries: [e("d4", 1, "crops/name/d4.png"), e("d5", 1, "crops/name/d5.png")] },
      { name: "crops-manifest.json", base: "/base", entries: [e("d6", 1, "crops/form/x.png")] },
    ]);
    expect(index.get("phone|onboarding_form|d1|3")).toBe("/base/crops/phone/d1-p3.png");
    expect(index.get("phone|onboarding_form|d2|1")).toBe("/base/crops/phone2/d2-p1.png");
    expect(index.get("address|address_proof|d3|2")).toBe("/base/crops/address/d3-p2.png");
    expect(index.size).toBe(3);
    expect(ignored).toBe(3);
  });

  it.skipIf(!hasMagick)("produceItems：電話／住址證明用現成裁圖；身份證欄就算 existing 有圖都唔用（一律即時裁）", async () => {
    const fx = dryFixture();
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1x-"));
    try {
      const existingPng = path.join(tmp, "existing.png");
      await sh(MAGICK, ["-size", "300x60", "xc:white", "-fill", "rgb(60,60,60)", "-draw", "rectangle 10,10 200,40", existingPng]);
      const asked: string[] = [];
      const base = {
        async lines(d: DocPage) {
          return fx.docs.get(`${d.docId}|${d.page}`)?.lines ?? null;
        },
        async render() {
          return null; // 唔應該需要渲染（全部有現成圖）或者渲染失敗
        },
        async cleanup() {},
      };
      const deps: Deps = {
        ...base,
        existing(req) {
          asked.push(`${req.field}:${req.docKind}`);
          return existingPng; // 對所有請求都「有現成圖」
        },
      };
      const stats = emptyStats();
      const people: PersonInput[] = [fx.people[0]!];
      const items = await produceItems(people, deps, stats);
      const sig = items.map((i) => `${i.field}:${i.docKind}:${i.priority}`);
      expect(sig).toContain("phone:onboarding_form:1");
      expect(sig).toContain("address:address_proof:1");
      expect(sig.some((s) => s.includes("id_card"))).toBe(false); // render 失敗＋身份證唔用現成圖
      expect(asked.some((a) => a.endsWith(":id_card"))).toBe(false); // 連問都冇問過
      expect(stats.from_existing).toBeGreaterThan(0);
      expect(stats.skipped.render_fail).toBeGreaterThan(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("參數", () => {
  it("--dry／--existing-crops 逗號分隔／--limit 驗證／唔認得參數", () => {
    expect(parseArgs(["--dry"]).dry).toBe(true);
    expect(parseArgs(["--existing-crops", "a.json,b.json", "--existing-crops", "c.json"]).existingCrops).toEqual(["a.json", "b.json", "c.json"]);
    expect(() => parseArgs(["--limit", "0"])).toThrow();
    expect(() => parseArgs(["--bogus"])).toThrow();
    expect(() => parseArgs(["--out"])).toThrow();
  });

  it("main 真跑冇 --out 或 --out 唔喺 data/ 下面 → 拒絕（唔寫）", async () => {
    const { main } = await import("../scripts/staff-import/20-triage-evidence");
    await expect(main(["--package", "x", "--person-fields", "y", "--extract", "z", "--index", "w"])).rejects.toThrow(/--out/);
    await expect(main(["--dry", "--out", "/tmp/not-under-data"])).rejects.toThrow(/data\//);
  });

  it("脚本源碼唔載 .env／唔連網／唔用 Anthropic client", async () => {
    const src = await readFile(path.resolve(__dirname, "../scripts/staff-import/20-triage-evidence.ts"), "utf8");
    const core = await readFile(path.resolve(__dirname, "../scripts/staff-import/lib/triage-evidence-core.ts"), "utf8");
    for (const s of [src, core]) {
      expect(s).not.toMatch(/dotenv|process\.env\.(CLAUDE|DEEPSEEK|AI_)|fetch\(|getReadClients|anthropic/i);
    }
  });
});
