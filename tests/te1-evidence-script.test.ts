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
  SYNTHETIC_FORM_PHOTO,
  syntheticAddressProofPage,
  finalizeChecked,
  darkBandRatios,
  cropRequest,
  hasSyntheticFonts,
  resolveVisionBin,
  makeVisionRunner,
  verifyCrop,
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
  locateFormCell,
  detectUprightRotation,
  rotateLines,
  FORM_PHOTO_BOX,
  addressRegionLikely,
  locateIdCardBoxes,
  matchOfPerson,
  planRequests,
  ZIP_MAX_ENTRIES,
  similarity,
  scoreAgainst,
  bestWindowSimilarity,
  lcsRatio,
  VERIFY_THRESHOLD,
  expectedValuesFor,
  textUprightness,
  capBox,
  findOverflow,
} from "../scripts/staff-import/lib/triage-evidence-core";
import type { DocPage } from "../scripts/staff-import/lib/triage-reread-core";
import { readEvidenceZip, evidenceManifestSchema } from "@/lib/triage/evidence-upload";
import { MAX_IMAGE_BYTES, inspectImage } from "@/lib/triage/evidence-format";
import { fakeJpeg } from "./lib/te1-images";
import { run as run_ } from "../scripts/staff-import/20-triage-evidence";

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

  it("號碼框向上最多外擴到相片下緣（相片緊貼號碼頂，所以實際得 ~0.0015）、向下有外擴；左邊欄位右緣喺相片左緣之前", () => {
    const { lines, photo } = syntheticIdCardPage();
    const g = locateIdCardBoxes(1, lines);
    const hk = lineOf(lines, "Z900001");
    expect(g.hkid!.y1).toBeLessThanOrEqual(hk.y + hk.h + 0.0016);
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

  it("入職表單格裁（c）：每欄只含自己嗰格（label 包埋）；右界＝下一個 label；上下界唔過上一行／下一行 label；冇 label＝null", () => {
    const f = syntheticFormPage();
    const lineOf = (t: string) => f.find((l) => l.t.includes(t))!;
    const inside = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => l.x >= b.x0 - 1e-9 && l.x + l.w <= b.x1 + 1e-9 && l.y >= b.y0 - 1e-9 && l.y + l.h <= b.y1 + 1e-9;
    const overlapsAny = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => intersects(b, { x0: l.x, x1: l.x + l.w, y0: l.y, y1: l.y + l.h });
    const cell = (field: Parameters<typeof locateFormCell>[0]) => locateFormCell(field, f).box!;
    // hkid 行三格並排：只含 hkid 格（label＋值），唔含出生日期格／出生地點格
    const hk = cell("hkid");
    expect(inside(hk, lineOf("香港身份證"))).toBe(true);
    expect(inside(hk, lineOf("Z900001"))).toBe(true);
    expect(overlapsAny(hk, lineOf("出生日期"))).toBe(false);
    expect(overlapsAny(hk, lineOf("15-01-1990"))).toBe(false);
    expect(overlapsAny(hk, lineOf("出生地點"))).toBe(false);
    expect(hk.x1).toBeLessThan(lineOf("出生日期").x); // 右界喺下一個 label 左邊
    // 出生日期格：右界＝出生地點 label 左邊
    const dob = cell("dob");
    expect(inside(dob, lineOf("15-01-1990"))).toBe(true);
    expect(overlapsAny(dob, lineOf("出生地點"))).toBe(false);
    expect(overlapsAny(dob, lineOf("Z900001"))).toBe(false);
    // name_zh：冇露出下一行（hkid 行）；冇 English Name 格
    const zh = cell("name_zh");
    expect(inside(zh, lineOf("測試甲"))).toBe(true);
    expect(overlapsAny(zh, lineOf("English Name"))).toBe(false);
    expect(overlapsAny(zh, lineOf("香港身份證"))).toBe(false);
    expect(overlapsAny(zh, lineOf("Z900001"))).toBe(false);
    expect(zh.y0).toBeGreaterThan(lineOf("香港身份證").y + lineOf("香港身份證").h);
    // name_en：右界冇伸去表格右邊（相片格）
    const en = cell("name_en");
    expect(inside(en, lineOf("TESTER ALPHA"))).toBe(true);
    expect(en.x1).toBeLessThanOrEqual(FORM_PHOTO_BOX.x0);
    // phone：只含手提電話格（唔含住所電話、下一行住址）
    const ph = cell("phone");
    expect(inside(ph, lineOf("90001110"))).toBe(true);
    expect(overlapsAny(ph, lineOf("住所電話"))).toBe(false);
    expect(overlapsAny(ph, lineOf("住址："))).toBe(false);
    expect(overlapsAny(ph, lineOf("火炭"))).toBe(false);
    // address：含值，唔含通訊地址 label／手提電話行
    const ad = cell("address");
    expect(inside(ad, lineOf("火炭"))).toBe(true);
    expect(overlapsAny(ad, lineOf("通訊地址"))).toBe(false);
    expect(overlapsAny(ad, lineOf("90001110"))).toBe(false);
    // 全部唔入相片格
    for (const b of [hk, dob, zh, en, ph, ad]) expect(intersects(b, FORM_PHOTO_BOX)).toBe(false);
    expect(locateFormCell("name_zh", []).reason).toBe("form_label_not_located");
    expect(locateFormCell("dob", f.filter((l) => !/出生日期/.test(l.t))).box).toBeNull();
  });

  it("入職表相片格：label 喺相片區入面／右界被夾到切入 label → 跳過 form_photo_overlap；一般夾右緣到相片左邊", () => {
    const lab = (t: string, x: number, y: number, w: number) => ({ t, c: 0.9, x, y, w, h: 0.025 });
    // 出生地點 label 喺相片區（x≥0.75、y≥0.65）內：唔應該裁
    const inZone = [lab("職位申請表 EMPLOYMENT APPLICATION", 0.1, 0.92, 0.5), lab("出生日期：", 0.78, 0.8, 0.1), lab("15-01-1990", 0.89, 0.8, 0.08)];
    expect(locateFormCell("dob", inZone)).toMatchObject({ box: null, reason: "form_photo_overlap" });
    // 冇下一個 label、手寫字伸入相片區：右緣夾到相片左邊
    const wide = [lab("職位申請表 EMPLOYMENT APPLICATION", 0.1, 0.92, 0.5), lab("中文姓名：", 0.08, 0.8, 0.12), lab("測試甲甲甲甲甲甲甲甲甲", 0.21, 0.8, 0.65)];
    const r = locateFormCell("name_zh", wide);
    expect(r.box).not.toBeNull();
    expect(r.box!.x1).toBeLessThanOrEqual(FORM_PHOTO_BOX.x0);
  });

  it.skipIf(!hasMagick)("入職表像素級：右上深色相片格、hkid 行三格並排——hkid 裁圖冇相片色；name_zh／phone 裁圖冇露出下一行（唔含 hkid 值／電話行）", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1f-"));
    try {
      const lines = syntheticFormPage();
      const png = path.join(tmp, "form.png");
      await drawSyntheticPage({ doc: doc("onboarding_form"), lines, photo: SYNTHETIC_FORM_PHOTO }, png);
      const dark = async (file: string) => Number((await sh(MAGICK, [file, "-colorspace", "Gray", "-threshold", "70%", "-format", "%[fx:1-mean]", "info:"])).stdout);
      const crop = async (field: Parameters<typeof locateFormCell>[0]) => {
        const box = locateFormCell(field, lines).box!;
        const r = await finalizeChecked(png, box, tmp, { bandCheck: true });
        expect("bytes" in r, field).toBe(true);
        const out = path.join(tmp, `f-${field}.jpg`);
        await (await import("node:fs/promises")).writeFile(out, (r as { bytes: Uint8Array }).bytes);
        return out;
      };
      for (const f of ["hkid", "name_zh", "name_en", "dob", "phone", "address"] as const) {
        const out = await crop(f);
        // 裁圖內深色大塊（相片格係深色）比例：整張圖暗像素比例要細（文字細條）
        expect(await dark(out), `${f} 冇大塊深色`).toBeLessThan(0.3);
      }
      // 對照：成頁一定有大塊深色
      expect(await dark(png)).toBeGreaterThan(0.03);
      // 唔含下一行：name_zh 裁圖高度細過兩行；crop 高度 ≤ label 行高 ×(1+0.5)+字高變化
      const zhBox = locateFormCell("name_zh", lines).box!;
      expect(zhBox.y1 - zhBox.y0).toBeLessThan(0.025 * 2);
      const phBox = locateFormCell("phone", lines).box!;
      expect(phBox.y1 - phBox.y0).toBeLessThan(0.025 * 2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("身份證：相片緊貼名行底（長英文名橫跨相片 x 範圍）", () => {
  const inside = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => l.x >= b.x0 - 1e-9 && l.x + l.w <= b.x1 + 1e-9 && l.y >= b.y0 - 1e-9 && l.y + l.h <= b.y1 + 1e-9;

  it("英文名框唔入相片：向下 padding 收窄到相片頂以上（最少 0.05×行高），完整包住名字；其他欄不變", () => {
    const { lines, photo } = syntheticIdCardPage(true, 0.005, { longName: true });
    const g = locateIdCardBoxes(1, lines);
    const en = lines.find((l) => l.t.includes("LONGFAMILY"))!;
    expect(en.x + en.w).toBeGreaterThan(photo.x0); // 名行橫跨相片 x 範圍
    expect(g.name_en).not.toBeNull();
    expect(intersects(g.name_en!, photo)).toBe(false);
    expect(intersects(g.name_en!, g.photo!)).toBe(false);
    expect(inside(g.name_en!, en)).toBe(true);
    expect(g.name_en!.y0).toBeGreaterThanOrEqual(photo.y1 - 1e-9);
    expect(en.y - g.name_en!.y0).toBeGreaterThanOrEqual(0.05 * en.h - 1e-9); // 最少 0.05×行高 padding
    // 垂直 padding ≤0.3×行高
    expect(g.name_en!.y1 - (en.y + en.h)).toBeLessThanOrEqual(0.3 * en.h + 1e-9);
    for (const k of ["hkid", "name_zh", "dob"] as const) {
      expect(g[k], k).not.toBeNull();
      expect(intersects(g[k]!, photo), k).toBe(false);
    }
    expect(g.overlap).toBeUndefined();
  });

  it("名行底同相片頂之間冇 0.05×行高空位（相片貼死名行）→ 收窄右緣仍切到字 → 跳過 id_photo_overlap", () => {
    const { lines } = syntheticIdCardPage(true, 0.005, { longName: true });
    const g = locateIdCardBoxes(1, lines);
    expect(g.name_en).not.toBeNull();
    // 把名行改成貼死：令相片估算頂高過 base.y0 - minPad —— 用兩行英文名（第二行橫跨相片區）模擬
    const wrapped = [...lines, { t: "SECOND-SEGMENT", c: 0.9, x: 0.1, y: 0.69 - 0.001, w: 0.45, h: 0.02 }];
    const g2 = locateIdCardBoxes(1, wrapped);
    for (const k of ["name_en"] as const) if (g2[k]) expect(intersects(g2[k]!, g2.photo!)).toBe(false);
  });

  it("id_card 垂直 padding ≤0.3×行高、左右 0.3×；號碼框右 0.6×行高（括號唔被切），向上外擴到相片下緣為止", () => {
    const { lines } = syntheticIdCardPage();
    const g = locateIdCardBoxes(1, lines);
    const zh = lines.find((l) => l.t.includes("測試甲"))!;
    expect(zh.x - g.name_zh!.x0).toBeLessThanOrEqual(0.3 * zh.h + 0.0021);
    expect(g.name_zh!.y1 - (zh.y + zh.h)).toBeLessThanOrEqual(0.3 * zh.h + 0.0021);
    const hk = lines.find((l) => l.t.includes("Z900001"))!;
    expect(g.hkid!.x1 - (hk.x + hk.w)).toBeGreaterThan(0.3 * hk.h); // 右邊 padding 較闊
    expect(g.hkid!.x1 - (hk.x + hk.w)).toBeLessThanOrEqual(0.6 * hk.h + 1e-9);
    expect(hk.y - g.hkid!.y0).toBeLessThanOrEqual(0.3 * hk.h + 0.0021);
    expect(g.hkid!.y1).toBeGreaterThan(hk.y + hk.h); // 上半截唔再被切（TE-1.7）
  });

  it.skipIf(!hasMagick)("像素級：長英文名橫跨相片 x 範圍、相片緊貼名行底——四個 id 欄裁圖冇相片色", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1l-"));
    try {
      const { lines, photo } = syntheticIdCardPage(true, 0.005, { longName: true });
      const png = path.join(tmp, "p.png");
      await drawSyntheticPage({ doc: doc("id_card"), lines, photo }, png);
      const g = locateIdCardBoxes(1, lines);
      for (const k of ["hkid", "name_zh", "name_en", "dob"] as const) {
        const r = await finalizeChecked(png, g[k], tmp, { bandCheck: true });
        expect("bytes" in r, k).toBe(true);
        const out = path.join(tmp, `o-${k}.jpg`);
        await (await import("node:fs/promises")).writeFile(out, (r as { bytes: Uint8Array }).bytes);
        const m = await sh(MAGICK, [out, "-fx", "r-g", "-format", "%[fx:maxima]", "info:"]);
        expect(Number(m.stdout), `${k} 冇紅色`).toBeLessThan(0.15);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("防線二：邊緣帶暗像素檢查（所有 doc_kind）", () => {
  const mk = async (tmp: string, name: string, draw: string[]) => {
    const f = path.join(tmp, name);
    await sh(MAGICK, ["-size", "200x100", "xc:white", ...draw, f]);
    return f;
  };
  it.skipIf(!hasMagick)("底部大塊深色（>35%）→ 先收窄 20% 再量，仍超標就跳過 photo_suspect；乾淨圖／細印刷線條唔觸發", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1b-"));
    try {
      const big = await mk(tmp, "big.png", ["-fill", "black", "-draw", "rectangle 0,55 199,99"]); // 底部 45% 深色
      expect(await finalizeChecked(big, null, tmp, { bandCheck: true })).toEqual({ reason: "photo_suspect" });
      expect((await darkBandRatios(big)).bottom).toBeGreaterThan(0.35);
      // 只有最底 18% 深色：收窄 20% 後就乾淨 → 通過（輸出高度細咗）
      const thin = await mk(tmp, "thin.png", ["-fill", "black", "-draw", "rectangle 0,82 199,99"]);
      const r = await finalizeChecked(thin, null, tmp, { bandCheck: true });
      expect("bytes" in r).toBe(true);
      // 白底細線（表格線＋少少字）：唔觸發
      const lines = await mk(tmp, "lines.png", ["-fill", "gray20", "-draw", "rectangle 0,0 199,1", "-draw", "rectangle 0,98 199,99", "-draw", "rectangle 20,40 90,55"]);
      expect("bytes" in (await finalizeChecked(lines, null, tmp, { bandCheck: true }))).toBe(true);
      // 左／右邊大塊深色亦觸發
      const side = await mk(tmp, "side.png", ["-fill", "black", "-draw", "rectangle 130,0 199,99"]);
      expect(await finalizeChecked(side, null, tmp, { bandCheck: true })).toEqual({ reason: "photo_suspect" });
      // 唔開檢查就照出（舊行為）
      expect("bytes" in (await finalizeChecked(big, null, tmp))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("轉頁方向（90／180／270）", () => {
  const turn = (d: number) => ((360 - d) % 360) as 0 | 90 | 180 | 270;
  it("rotateLines：四個方向連續轉回原位；轉 90 後 w／h 互換", () => {
    const { lines } = syntheticIdCardPage();
    const r = rotateLines(rotateLines(rotateLines(rotateLines(lines, 90), 90), 90), 90);
    r.forEach((l, i) => {
      for (const k of ["x", "y", "w", "h"] as const) expect(l[k]).toBeCloseTo(lines[i]![k], 9);
    });
    const a = rotateLines(lines, 90)[0]!;
    expect(a.w).toBeCloseTo(lines[0]!.h, 9);
  });

  it("detectUprightRotation（身份證／入職表）：θ 度擺反嘅頁偵測到要轉 360-θ；正向回 0；住址證明正向回 0", () => {
    const id = syntheticIdCardPage().lines;
    const form = syntheticFormPage();
    for (const th of [0, 90, 180, 270] as const) {
      expect(detectUprightRotation("id_card", rotateLines(id, th)), `id ${th}`).toBe(turn(th));
      expect(detectUprightRotation("onboarding_form", rotateLines(form, th)), `form ${th}`).toBe(turn(th));
    }
    expect(detectUprightRotation("address_proof", syntheticAddressProofPage())).toBe(0);
    expect(detectUprightRotation("id_card", [])).toBeNull();
  });

  it.skipIf(!hasMagick)("像素級：90／180／270 嘅頁經 cropRequest 轉正後，輸出同正向版本幾乎一致（身份證四欄＋入職表 hkid／phone）", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1r-"));
    try {
      const idPage = syntheticIdCardPage();
      const formLines = syntheticFormPage();
      const cases: { docKind: "id_card" | "onboarding_form"; field: "hkid" | "name_zh" | "name_en" | "dob" | "phone"; lines: typeof idPage.lines; photo: typeof idPage.photo | undefined }[] = [
        ...(["hkid", "name_zh", "name_en", "dob"] as const).map((field) => ({ docKind: "id_card" as const, field, lines: idPage.lines, photo: idPage.photo })),
        ...(["hkid", "phone"] as const).map((field) => ({ docKind: "onboarding_form" as const, field, lines: formLines, photo: SYNTHETIC_FORM_PHOTO })),
      ];
      for (const c of cases) {
        const d = doc(c.docKind);
        const req = { field: c.field, docKind: c.docKind, priority: 1 as const, doc: d };
        const outs: Record<number, string> = {};
        for (const th of [0, 90, 180, 270] as const) {
          const png = path.join(tmp, `p-${c.docKind}-${th}.png`);
          await drawSyntheticPage({ doc: d, lines: c.lines, photo: c.photo }, png, { w: 1000, h: 1400 }, th);
          const r = await cropRequest(req, png, rotateLines(c.lines, th), tmp);
          expect("bytes" in r, `${c.docKind}/${c.field}/${th}`).toBe(true);
          const f = path.join(tmp, `o-${c.docKind}-${c.field}-${th}.jpg`);
          await (await import("node:fs/promises")).writeFile(f, (r as { bytes: Uint8Array }).bytes);
          outs[th] = f;
        }
        for (const th of [90, 180, 270]) {
          const id0 = await sh(MAGICK, ["identify", "-format", "%w %h", outs[0]!]);
          const idT = await sh(MAGICK, ["identify", "-format", "%w %h", outs[th]!]);
          const [w0, h0] = id0.stdout.split(" ").map(Number) as [number, number];
          const [wt, ht] = idT.stdout.split(" ").map(Number) as [number, number];
          expect(Math.abs(wt - w0), `${c.field}/${th} 寬`).toBeLessThanOrEqual(3);
          expect(Math.abs(ht - h0), `${c.field}/${th} 高`).toBeLessThanOrEqual(3);
          // 縮到同一尺寸再比 RMSE（正規化 0–1）
          const cmp = await sh(MAGICK, ["compare", "-metric", "RMSE", outs[0]!, "(", outs[th]!, "-resize", `${w0}x${h0}!`, ")", "null:"]).then((r) => r.stderr, (e: { stderr: string }) => e.stderr);
          const norm = Number(/\(([0-9.]+)\)/.exec(cmp)?.[1]);
          expect(norm, `${c.docKind}/${c.field}/${th} 同正向版本幾乎一致`).toBeLessThan(0.2);
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("住址證明地址區 sanity：框內冇數字／樓／室／座／F／FLAT → address_region_unlikely；正常地址通過", () => {
    const ap = syntheticAddressProofPage();
    const box = { x0: 0.05, x1: 0.5, y0: 0.6, y1: 0.72 };
    expect(addressRegionLikely(box, ap)).toBe(true);
    const logo = [{ t: "某某機構 有限公司", c: 0.9, x: 0.1, y: 0.9, w: 0.3, h: 0.03 }];
    expect(addressRegionLikely({ x0: 0.05, x1: 0.5, y0: 0.88, y1: 0.95 }, logo)).toBe(false);
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
    const r = await run(parseArgs(["--dry", "--no-verify"]));
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
  it("只認 address-crops*（住址證明）；phone*-crops（成行裁、含下一行同相片）／name-crops／其他一律忽略；路徑相對 json 上一層", () => {
    const e = (docId: string, page: number, file: string) => ({ docId, page, file });
    const { index, ignored } = buildExistingIndex([
      { name: "phone-crops.json", base: "/base", entries: [e("d1", 3, "crops/phone/d1-p3.png")] },
      { name: "phone2-crops.json", base: "/base", entries: [e("d2", 1, "crops/phone2/d2-p1.png")] },
      { name: "address-crops-new.json", base: "/base", entries: [e("d3", 2, "crops/address/d3-p2.png")] },
      { name: "name-crops.json", base: "/base", entries: [e("d4", 1, "crops/name/d4.png"), e("d5", 1, "crops/name/d5.png")] },
      { name: "crops-manifest.json", base: "/base", entries: [e("d6", 1, "crops/form/x.png")] },
    ]);
    expect(index.has("phone|onboarding_form|d1|3")).toBe(false);
    expect(index.get("address|address_proof|d3|2")).toBe("/base/crops/address/d3-p2.png");
    expect(index.size).toBe(1);
    expect(ignored).toBe(5);
  });

  it.skipIf(!hasMagick)("produceItems：住址證明用現成裁圖；身份證／入職表欄就算 existing 有圖都唔用（一律即時裁）", async () => {
    const fx = dryFixture();
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1x-"));
    try {
      const existingPng = path.join(tmp, "existing.png");
      await sh(MAGICK, ["-size", "300x60", "xc:white", "-fill", "rgb(60,60,60)", "-draw", "rectangle 10,25 200,32", existingPng]);
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
      expect(sig).toContain("address:address_proof:1");
      expect(sig.some((s) => s.includes("id_card") || s.includes("onboarding_form"))).toBe(false); // render 失敗＋身份證／入職表唔用現成圖
      expect(asked.every((a) => a.endsWith(":address_proof"))).toBe(true); // 連問都冇問過
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

// ===========================================================================
// TE-1.7
// ===========================================================================
describe("TE-1.7 預期值相似度（純函數）", () => {
  it("號碼／電話／日期用 alnum 視窗比對；全形括號、空格、卡面日期印法都 OK；錯一兩個字仍過門檻；唔相干 <門檻", () => {
    expect(similarity("hkid", "Z900001（2） 90001110", ["Z900001(2)"])).toBe(1);
    expect(similarity("hkid", "Z9OOOO1(2)", ["Z900001(2)"])).toBeLessThan(1); // O／0 混淆扣分但仍高
    expect(similarity("hkid", "Z900091(2)", ["Z900001(2)"])).toBeGreaterThanOrEqual(VERIFY_THRESHOLD.hkid);
    expect(similarity("hkid", "A123456(7)", ["Z900001(2)"])).toBeLessThan(VERIFY_THRESHOLD.hkid);
    expect(similarity("phone", "手提電話： 9000 1110", ["90001110"])).toBe(1);
    expect(similarity("phone", "住所電話 23456789", ["90001110"])).toBeLessThan(VERIFY_THRESHOLD.phone);
    expect(similarity("dob", "出生日期 Date of Birth 15-01-1990", ["1990-01-15"])).toBe(1); // ISO → 卡面 DD-MM-YYYY
    expect(similarity("dob", "15-01-1991", ["1990-01-15"])).toBeLessThan(1);
    expect(similarity("dob", "香港", ["1990-01-15"])).toBeLessThan(VERIFY_THRESHOLD.dob);
  });

  it("姓名：中文用字元集合重疊；英文用 token 覆蓋（次序／標點唔影響）；多個候選取最高", () => {
    expect(scoreAgainst("name_zh", "中文姓名： 測試甲", "測試甲")).toBe(1);
    expect(scoreAgainst("name_zh", "測試乙", "測試甲")).toBeCloseTo(2 / 3, 5);
    expect(scoreAgainst("name_zh", "陳大文", "測試甲")).toBe(0);
    expect(similarity("name_zh", "測試乙", ["陳大文", "測試甲"])).toBeCloseTo(2 / 3, 5);
    expect(scoreAgainst("name_en", "TESTER, Alpha", "TESTER ALPHA")).toBe(1);
    expect(scoreAgainst("name_en", "Alpha Tester", "TESTER ALPHA")).toBe(1);
    expect(scoreAgainst("name_en", "CHAN, Tai Man", "TESTER ALPHA")).toBeLessThan(VERIFY_THRESHOLD.name_en);
  });

  it("地址用 alnum 最長公共子序列比例；識別 bestWindowSimilarity／lcsRatio 邊界", () => {
    expect(scoreAgainst("address", "住址： 火炭示範街99號 虛構大廈15樓A室", "火炭示範街99號虛構大廈15樓A室")).toBe(1);
    expect(scoreAgainst("address", "九龍某某道8號", "火炭示範街99號虛構大廈15樓A室")).toBeLessThan(VERIFY_THRESHOLD.address);
    expect(scoreAgainst("address", "火炭示範街99號 (OCR 漏咗後半)", "火炭示範街99號虛構大廈15樓A室")).toBeGreaterThanOrEqual(VERIFY_THRESHOLD.address);
    expect(bestWindowSimilarity("", "abc")).toBe(0);
    expect(bestWindowSimilarity("ABC", "")).toBe(0);
    expect(lcsRatio("", "abc")).toBe(0);
    expect(lcsRatio("abc", "abc")).toBe(1);
  });

  it("expectedValuesFor：package 該欄值＋額外候選，去重；冇值＝空（無法驗證）；textUprightness 按圖寬高比", () => {
    const p = { key: "k", hkid: lf(null, "missing"), nameZh: { value: "測試甲", status: "review" as const, candidates: ["測試乙"] }, nameEn: lf("A B", "review"), dateOfBirth: lf(null, "missing"), phone: lf("9", "review"), address: lf("x", "review"), staffNumbers: [] } as never;
    expect(expectedValuesFor("hkid", p)).toEqual([]);
    expect(expectedValuesFor("name_zh", p, ["測試丙", "測試甲"])).toEqual(["測試甲", "測試乙", "測試丙"]);
    expect(expectedValuesFor("permit_no", p)).toEqual([]);
    // 正規化 w=0.8,h=0.4 喺 616x105 圖＝實際橫排；喺 105x616（轉咗）＝實際側躺
    expect(textUprightness([{ t: "ABCDEF", w: 0.8, h: 0.4 }], 616, 105)).toBeGreaterThan(0);
    expect(textUprightness([{ t: "ABCDEF", w: 0.4, h: 0.9 }], 105, 616)).toBeLessThan(0);
  });
});

describe("TE-1.7 入職表格界：任何 OCR 行做 barrier（三格並排／堆疊行／大格）", () => {
  const lab = (t: string, x: number, y: number, w: number, h = 0.025) => ({ t, c: 0.9, x, y, w, h });
  const ov = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => intersects(b, { x0: l.x, x1: l.x + l.w, y0: l.y, y1: l.y + l.h });
  const inside = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => l.x >= b.x0 - 1e-9 && l.x + l.w <= b.x1 + 1e-9 && l.y >= b.y0 - 1e-9 && l.y + l.h <= b.y1 + 1e-9;
  const title = lab("職位申請表 EMPLOYMENT APPLICATION", 0.1, 0.95, 0.5);

  it("舊範本三格並排「香港身份證號碼：｜出生日期：｜出生地點：」（值留空）：hkid 右界停喺下一格 label 之前，唔再整行", () => {
    const hk = lab("香港身份證號碼：", 0.08, 0.6, 0.16);
    const dob = lab("出生日期：", 0.36, 0.6, 0.11);
    const pob = lab("出生地點：", 0.62, 0.6, 0.11);
    const r = locateFormCell("hkid", [title, hk, dob, pob]);
    expect(r.box).not.toBeNull();
    expect(r.box!.x1).toBeLessThan(dob.x);
    expect(ov(r.box!, dob)).toBe(false);
    expect(ov(r.box!, pob)).toBe(false);
    // 值係「手寫非 label」：值之後同行最近嘅任何 OCR 行（即使唔似 label）都做右界
    const val = lab("Z900001(2)", 0.25, 0.6, 0.1);
    const unknown = lab("某某某某", 0.5, 0.6, 0.1); // 唔似 label 嘅行
    const r2 = locateFormCell("hkid", [title, hk, val, unknown, pob]);
    expect(inside(r2.box!, val)).toBe(true);
    expect(ov(r2.box!, unknown)).toBe(false);
  });

  it("堆疊行：每行只裁自己嗰行，上下界唔過水平重疊嘅任何行（含唔似 label 嘅手寫／雜行）", () => {
    const zhL = lab("中文姓名：", 0.08, 0.8, 0.12);
    const zhV = lab("測試甲", 0.21, 0.8, 0.12);
    const junkBelow = lab("ABCxyz987", 0.2, 0.775 - 0.001, 0.2); // 緊貼下面、唔係 label 樣式
    const enL = lab("英文姓名：", 0.08, 0.73, 0.12);
    const enV = lab("TESTER ALPHA", 0.21, 0.73, 0.16);
    const nat = lab("國籍：", 0.08, 0.66, 0.08);
    const lines = [title, zhL, zhV, junkBelow, enL, enV, nat];
    const zh = locateFormCell("name_zh", lines).box!;
    expect(inside(zh, zhV) && inside(zh, zhL)).toBe(true);
    expect(ov(zh, junkBelow)).toBe(false);
    expect(ov(zh, enL)).toBe(false);
    const en = locateFormCell("name_en", lines).box!;
    expect(inside(en, enV)).toBe(true);
    expect(ov(en, nat)).toBe(false);
    expect(ov(en, junkBelow)).toBe(false);
    expect(en.y0).toBeGreaterThan(nat.y + nat.h);
  });

  it("「地址」大格範本：label 自成一行、值喺下面幾行——取到下一個 label 樣式行為止；水平範圍＝值行聯集左右各 0.6×行高", () => {
    const L1 = lab("地址：", 0.08, 0.5, 0.06);
    const v1 = lab("火炭示範街99號", 0.12, 0.465, 0.2);
    const v2 = lab("虛構大廈15樓", 0.12, 0.435, 0.18);
    const v3 = lab("A室", 0.12, 0.405, 0.05);
    const next = lab("通訊地址：", 0.08, 0.36, 0.1);
    const tel = lab("手提電話：", 0.08, 0.3, 0.1);
    const r = locateFormCell("address", [title, L1, v1, v2, v3, next, tel]);
    expect(r.box).not.toBeNull();
    for (const v of [L1, v1, v2, v3]) expect(inside(r.box!, v), v.t).toBe(true);
    expect(ov(r.box!, next)).toBe(false);
    expect(ov(r.box!, tel)).toBe(false);
    expect(r.box!.x1).toBeGreaterThanOrEqual(v1.x + v1.w + 0.5 * 0.025); // 唔係淨係 label 寬度
    expect(r.box!.x1).toBeLessThanOrEqual(v1.x + v1.w + 0.6 * 0.025 + 1e-9);
  });

  it("「住址：」同行範本：續行（同值左邊對齊）算同一格；通訊地址／電話行唔包", () => {
    const L1 = lab("住址：", 0.08, 0.5, 0.06);
    const v1 = lab("火炭示範街99號虛構大廈", 0.15, 0.5, 0.35);
    const v2 = lab("15樓A室", 0.15, 0.478, 0.1);
    const mail = lab("通訊地址：", 0.08, 0.44, 0.1);
    const tel = lab("手提電話：", 0.08, 0.4, 0.1);
    const r = locateFormCell("address", [title, L1, v1, v2, mail, tel]).box!;
    expect(inside(r, v1) && inside(r, v2)).toBe(true);
    expect(ov(r, mail)).toBe(false);
    expect(ov(r, tel)).toBe(false);
  });

  it("姓名／電話 label 含「聯絡人／緊急／擔保／見證／僱主」唔當本人欄（就算喺更高位置）", () => {
    const emN = lab("遇有緊急事故聯絡人姓名：", 0.08, 0.9, 0.3);
    const zhL = lab("中文姓名：", 0.08, 0.8, 0.12);
    const zhV = lab("測試甲", 0.21, 0.8, 0.12);
    const r = locateFormCell("name_zh", [title, emN, zhL, zhV]).box!;
    expect(inside(r, zhV)).toBe(true);
    expect(ov(r, emN)).toBe(false);
    const emT = lab("緊急聯絡人電話：", 0.08, 0.7, 0.2);
    const mob = lab("手提電話：", 0.08, 0.6, 0.11);
    const mv = lab("90001110", 0.2, 0.6, 0.12);
    const rp = locateFormCell("phone", [title, emT, mob, mv]).box!;
    expect(inside(rp, mv)).toBe(true);
    expect(ov(rp, emT)).toBe(false);
    expect(locateFormCell("name_zh", [title, emN]).reason).toBe("form_label_not_located");
  });
});

const visionBin = await resolveVisionBin(null).catch(() => null);
const canVision = hasMagick && hasSyntheticFonts && !!visionBin;

describe.skipIf(!canVision)("TE-1.7 Vision 驗證（真 Apple Vision，合成字）", () => {
  const FONT_LATIN = "/System/Library/Fonts/Supplemental/Arial.ttf";
  const FONT_CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc";
  const run = makeVisionRunner(visionBin!);
  /** 畫一張橫排「裁圖」，可選順時針轉 deg */
  const crop = async (tmp: string, name: string, text: string, deg = 0, cjk = false) => {
    const f = path.join(tmp, `${name}.png`);
    await sh(MAGICK, ["-size", `${Math.max(420, text.length * (cjk ? 70 : 38) + 60)}x110`, "xc:white", "-font", cjk ? FONT_CJK : FONT_LATIN, "-pointsize", "58", "-fill", "black", "-annotate", "+24+78", text, ...(deg ? ["-rotate", String(deg)] : []), f]);
    return f;
  };
  const turn = (d: number) => ((360 - d) % 360) as 0 | 90 | 180 | 270;

  it("方向：Latin／數字裁圖 0／90／180／270 → 揀中使圖轉正嘅方向（.fast 對方向敏感），相似度過門檻", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1vv-"));
    try {
      const cases: { field: "hkid" | "phone" | "name_en" | "dob"; text: string; expected: string[] }[] = [
        { field: "hkid", text: "Z900001(2)", expected: ["Z900001(2)"] },
        { field: "phone", text: "Mobile 90001110", expected: ["90001110"] },
        { field: "name_en", text: "TESTER, Alpha", expected: ["TESTER ALPHA"] },
        { field: "dob", text: "15-01-1990", expected: ["1990-01-15"] },
      ];
      for (const c of cases) {
        for (const deg of [0, 90, 180, 270]) {
          const f = await crop(tmp, `${c.field}-${deg}`, c.text, deg);
          const v = await verifyCrop(f, c.field, c.expected, run, tmp);
          expect(v.ok, `${c.field}/${deg}`).toBe(true);
          if (v.ok) {
            expect(v.score).not.toBeNull();
            expect(v.score!).toBeGreaterThanOrEqual(VERIFY_THRESHOLD[c.field]);
            expect(v.rotate, `${c.field}/${deg} 轉返正`).toBe(turn(deg));
          }
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("裁錯欄／錯人／其他字 → value_mismatch；中文名用字元重疊；冇預期值＝未驗證（score null，唔轉）", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1vm-"));
    try {
      const other = await crop(tmp, "other", "TESTER ALPHA");
      expect(await verifyCrop(other, "hkid", ["Z900001(2)"], run, tmp)).toMatchObject({ ok: false, reason: "value_mismatch" });
      expect(await verifyCrop(other, "phone", ["90001110"], run, tmp)).toMatchObject({ ok: false, reason: "value_mismatch" });
      const zh = await crop(tmp, "zh", "測試甲", 0, true);
      const okZh = await verifyCrop(zh, "name_zh", ["測試甲"], run, tmp);
      expect(okZh.ok && okZh.score).toBe(1);
      expect(await verifyCrop(zh, "name_zh", ["陳大文"], run, tmp)).toMatchObject({ ok: false, reason: "value_mismatch" });
      // 多個候選讀數：其中一個對得上就過
      expect((await verifyCrop(zh, "name_zh", ["陳大文", "測試甲"], run, tmp)).ok).toBe(true);
      expect(await verifyCrop(zh, "hkid", [], run, tmp)).toEqual({ ok: true, score: null, rotate: 0 });
      const addr = await crop(tmp, "addr", "火炭示範街99號 虛構大廈15樓A室", 0, true);
      const va = await verifyCrop(addr, "address", ["火炭示範街99號虛構大廈15樓A室"], run, tmp);
      expect(va.ok && va.score! >= VERIFY_THRESHOLD.address).toBe(true);
      expect((await verifyCrop(addr, "address", ["九龍某某道8號某某樓"], run, tmp)).ok).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("限制：純中文裁圖側躺（.fast 讀唔到中文）→ 分唔出 90／270 → orientation_unknown（唔猜）", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1vo-"));
    try {
      const side = await crop(tmp, "zh90", "測試甲 火炭", 90, true);
      const v = await verifyCrop(side, "name_zh", ["測試甲"], run, tmp);
      expect(v.ok ? "ok" : v.reason).toBe("orientation_unknown");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("整合：錯人預期值（hkid 唔同）→ 身份證／入職表 hkid 裁圖全部 value_mismatch，唔出圖；其他欄照出並帶 verify_score", async () => {
    const fx = dryFixture();
    const base = fx.people[0]!;
    const wrong = { ...base, person: { ...base.person, hkid: lf("Y123456(7)", "review") } };
    const deps: Deps = {
      async lines(d) {
        return fx.docs.get(`${d.docId}|${d.page}`)?.lines ?? null;
      },
      existing: () => null,
      async render(d) {
        const dd = fx.docs.get(`${d.docId}|${d.page}`)!;
        const out = path.join(os.tmpdir(), `te1w-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
        await drawSyntheticPage(dd, out);
        return out;
      },
      async cleanup(png) {
        await rm(png, { force: true });
      },
      vision: run,
    };
    const stats = emptyStats();
    const items = await produceItems([wrong as PersonInput], deps, stats);
    expect(items.some((i) => i.field === "hkid")).toBe(false);
    expect(stats.skipped.value_mismatch).toBeGreaterThanOrEqual(2); // 身份證＋入職表
    const good = items.filter((i) => i.field !== "hkid");
    expect(good.length).toBeGreaterThan(0);
    for (const i of good) {
      expect(typeof i.verifyScore).toBe("number");
      expect(i.verifyScore!).toBeGreaterThan(0);
      expect(i.verifyScore!).toBeLessThanOrEqual(1);
    }
    expect(stats.verified).toBe(good.length);
  }, 180_000);

  it("--dry 有 Vision：全部 verify，manifest 帶 verify_score（淨數字 0–1）並過伺服器 strict manifest schema；console 淨計數", async () => {
    const r = await run_(parseArgs(["--dry", "--vision-bin", visionBin!]));
    expect(r.stats.verified).toBe(r.items.length);
    expect(r.stats.unverified).toBe(0);
    const { manifest } = await readEvidenceZip(r.zips[0]!);
    expect(evidenceManifestSchema.safeParse(manifest).success).toBe(true);
    const raw = JSON.parse(await (await JSZip.loadAsync(r.zips[0]!)).file("manifest.json")!.async("string")) as { items: { verify_score?: number }[] };
    for (const it of raw.items) {
      expect(typeof it.verify_score).toBe("number");
      expect(it.verify_score!).toBeGreaterThanOrEqual(0);
      expect(it.verify_score!).toBeLessThanOrEqual(1);
    }
    const { statsLines } = await import("../scripts/staff-import/20-triage-evidence");
    expect(statsLines(r.stats).join("\n")).not.toMatch(/測試甲|Z900001|TESTER/);
  }, 180_000);
});

describe("TE-1.7 參數與 no-verify", () => {
  it("--no-verify／--vision-bin 解析；--dry --no-verify 照出圖但全部未驗證，manifest 冇 verify_score", async () => {
    expect(parseArgs(["--no-verify"]).noVerify).toBe(true);
    expect(parseArgs(["--vision-bin", "/x/y"]).visionBin).toBe("/x/y");
    expect(parseArgs([]).noVerify).toBe(false);
    expect(await resolveVisionBin("/definitely/not/there")).toBeNull();
    if (!hasMagick) return;
    const r = await run_(parseArgs(["--dry", "--no-verify"]));
    expect(r.stats.verified).toBe(0);
    expect(r.stats.unverified).toBe(r.items.length);
    const raw = JSON.parse(await (await JSZip.loadAsync(r.zips[0]!)).file("manifest.json")!.async("string")) as { items: Record<string, unknown>[] };
    expect(raw.items.every((i) => !("verify_score" in i))).toBe(true);
  }, 120_000);
});

// ===========================================================================
// TE-1.8
// ===========================================================================
describe("TE-1.8 硬性尺寸上限 capBox（輸出 frame、按像素；唔依賴方向／版面推算）", () => {
  const W = 2000;
  const H = 2800;
  const hline = { t: "Z900001(2)", c: 0.9, x: 0.44, y: 0.54, w: 0.12, h: 0.035 }; // 橫排：行高 98px
  const t = 0.035 * H;
  const px = (b: { x0: number; x1: number; y0: number; y1: number }) => ({ w: (b.x1 - b.x0) * W, h: (b.y1 - b.y0) * H });

  it("id：超高（包住相片）→ 收窄到行 bbox ± 0.3×行厚（唔係跳過）；厚度 ≤1.8×、闊度 ≤行闊＋1.2×行厚", () => {
    const huge = { x0: 0.4, x1: 0.6, y0: 0.4, y1: 0.8 };
    const r = capBox(huge, { own: [hline], mode: "id" }, W, H);
    expect(r.capped).toBe(true);
    const d = px(r.box);
    expect(d.h).toBeLessThanOrEqual(1.8 * t + 0.5);
    expect(d.w).toBeLessThanOrEqual(0.12 * W + 1.2 * t + 0.5);
    expect(r.box.y0).toBeCloseTo(0.54 - (0.3 * t) / H, 6);
    // 合理 padding 唔動
    const ok = { x0: 0.44 - 0.3 * t / W, x1: 0.56 + 0.6 * t / W, y0: 0.54 - 0.3 * t / H, y1: 0.575 + 0.3 * t / H };
    expect(capBox(ok, { own: [hline], mode: "id" }, W, H)).toEqual({ box: ok, capped: false });
  });

  it("id：側躺（90° frame，行 box 高而窄）→ 厚度方向係闊；長度方向係高；一樣收窄", () => {
    // 轉 90 後：x'=y, y'=1-x-w, w'=h, h'=w（頁面 2800×2000）
    const [Wr, Hr] = [H, W];
    const vline = { t: "Z900001(2)", c: 0.9, x: 0.54, y: 1 - 0.44 - 0.12, w: 0.035, h: 0.12 };
    const tr = Math.min(vline.w * Wr, vline.h * Hr); // 厚度＝98px
    const huge = { x0: 0.3, x1: 0.8, y0: 0.2, y1: 0.9 };
    const r = capBox(huge, { own: [vline], mode: "id" }, Wr, Hr);
    expect(r.capped).toBe(true);
    expect((r.box.x1 - r.box.x0) * Wr).toBeLessThanOrEqual(1.8 * tr + 0.5); // 厚度方向＝闊
    expect((r.box.y1 - r.box.y0) * Hr).toBeLessThanOrEqual(vline.h * Hr + 1.2 * tr + 0.5);
  });

  it("form 單行欄：高度 ≤2.2×label 行高；超出收窄到 label 行 ± 0.25×行高，闊度（長度方向）照舊", () => {
    const label = { t: "香港身份證：", c: 0.9, x: 0.08, y: 0.7, w: 0.12, h: 0.025 };
    const tl = 0.025 * H;
    const two = { x0: 0.08, x1: 0.5, y0: 0.7 - 0.03, y1: 0.7 + 0.025 + 0.03 };
    const r = capBox(two, { own: [label], mode: "form" }, W, H);
    expect(r.capped).toBe(true);
    expect(px(r.box).h).toBeLessThanOrEqual(0.025 * H + 0.5 * tl + 0.5);
    expect(r.box.x0).toBe(two.x0);
    expect(r.box.x1).toBe(two.x1);
    const fine = { x0: 0.08, x1: 0.5, y0: 0.7 - 0.25 * 0.025, y1: 0.725 + 0.25 * 0.025 };
    expect(capBox(fine, { own: [label], mode: "form" }, W, H).capped).toBe(false);
    expect(capBox(two, { own: [], mode: "form" }, W, H).capped).toBe(false);
  });
});

describe.skipIf(!hasMagick)("TE-1.8 90／270 身份證——轉正前相片喺號碼行旁邊：即使方向偵測失敗，hkid 裁圖都唔包相片", () => {
  it("assumeRot=null（偵測失敗，喺側躺 frame 直接定位）＋偵測正常，兩條路 hkid 裁圖厚度 ≤1.8×行厚、冇相片色", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1c-"));
    try {
      const { lines, photo } = syntheticIdCardPage();
      const d = doc("id_card");
      const req = { field: "hkid" as const, docKind: "id_card" as const, priority: 1 as const, doc: d };
      const rowThickness = 0.035 * 2800; // 98px
      for (const th of [90, 270] as const) {
        const png = path.join(tmp, `p-${th}.png`);
        await drawSyntheticPage({ doc: d, lines, photo }, png, { w: 2000, h: 2800 }, th);
        for (const mode of ["detected", "failed"] as const) {
          const r = await cropRequest(req, png, rotateLines(lines, th), tmp, undefined, undefined, mode === "failed" ? { assumeRot: null } : {});
          expect("bytes" in r, `${th}/${mode}`).toBe(true);
          const f = path.join(tmp, `o-${th}-${mode}.jpg`);
          await (await import("node:fs/promises")).writeFile(f, (r as { bytes: Uint8Array }).bytes);
          const id = await sh(MAGICK, ["identify", "-format", "%w %h", f]);
          const [w, h] = id.stdout.split(" ").map(Number) as [number, number];
          // 偵測正常＝已轉正（厚度＝高）；偵測失敗＝仍然側躺（厚度＝闊）
          const thick = mode === "detected" ? h : w;
          expect(thick, `${th}/${mode} 厚度`).toBeLessThanOrEqual(1.8 * rowThickness + 1);
          const m = await sh(MAGICK, [f, "-fx", "r-g", "-format", "%[fx:maxima]", "info:"]);
          expect(Number(m.stdout), `${th}/${mode} 冇紅色`).toBeLessThan(0.15);
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("TE-1.8 入職表裁圖越界（Vision 讀到其他欄 label 關鍵詞）", () => {
  const vl = (t: string, x: number, y: number, w: number, h = 0.3) => ({ t, x, y, w, h });
  it("findOverflow：成行合併 line → 右界（關鍵詞左緣比例按字元估）；其他行 → below／above；自己欄 label 唔算；冇就 null", () => {
    const merged = [vl("香港身份證號碼： Z900001(2) 出生日期： 15-01-1990", 0.02, 0.35, 0.95)];
    const hit = findOverflow("hkid", merged, (l) => /身份證/.test(l.t));
    expect(hit?.side).toBe("right");
    expect(hit!.frac).toBeGreaterThan(0.3);
    expect(hit!.frac).toBeLessThan(0.8);
    // 自己欄：只有自己 label → null
    expect(findOverflow("hkid", [vl("香港身份證號碼： Z900001(2)", 0.02, 0.35, 0.6)], (l) => /身份證/.test(l.t))).toBeNull();
    // 分開兩條 line、同一行 → right，frac＝該 line 左緣
    const sep = [vl("香港身份證號碼： Z900001(2)", 0.02, 0.35, 0.45), vl("出生日期： 15-01-1990", 0.55, 0.35, 0.4)];
    expect(findOverflow("hkid", sep, (l) => /身份證/.test(l.t))).toEqual({ side: "right", frac: 0.55 });
    // 下一行 label 露出（below）：frac＝關鍵詞頂緣比例（由上）
    const below = [vl("中文姓名： 測試甲", 0.02, 0.5, 0.5, 0.3), vl("English Name:", 0.02, 0.02, 0.4, 0.12)];
    expect(findOverflow("name_zh", below, (l) => /中文姓名/.test(l.t))).toMatchObject({ side: "below" });
    const b = findOverflow("name_zh", below, (l) => /中文姓名/.test(l.t))!;
    expect(b.frac).toBeCloseTo(1 - 0.14, 5);
    // 上一行露出（above）
    const above = [vl("國籍： 香港", 0.02, 0.88, 0.4, 0.1), vl("手提電話： 90001110", 0.02, 0.4, 0.5, 0.25)];
    expect(findOverflow("phone", above, (l) => /電話/.test(l.t))).toMatchObject({ side: "above" });
    // name_zh 自己 label 含「姓名」，English Name 先係越界
    expect(findOverflow("name_en", [vl("English Name: TESTER", 0.02, 0.4, 0.6)], (l) => /English/.test(l.t))).toBeNull();
    expect(findOverflow("hkid", [], () => false)).toBeNull();
  });

  it("cropRequest 越界重裁：右溢出 → 收右界重驗；再 below → 收下界；第三次仍越界 → cell_overflow 跳過（假 verify hook）", async () => {
    // 用假頁（不涉 magick 內容）：只量 box 調整；finalizeChecked 需要 magick
    if (!hasMagick) return;
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1o-"));
    try {
      const lines = syntheticFormPage();
      const png = path.join(tmp, "form.png");
      await drawSyntheticPage({ doc: doc("onboarding_form"), lines, photo: SYNTHETIC_FORM_PHOTO }, png);
      const req = { field: "name_zh" as const, docKind: "onboarding_form" as const, priority: 2 as const, doc: doc("onboarding_form") };
      const seen: number[] = [];
      let n = 0;
      const hook = async () => {
        n += 1;
        seen.push(n);
        if (n === 1) return { ok: true as const, score: 0.9, rotate: 0 as const, overflow: { side: "right" as const, frac: 0.6 } };
        if (n === 2) return { ok: true as const, score: 0.9, rotate: 0 as const, overflow: { side: "below" as const, frac: 0.7 } };
        return { ok: true as const, score: 0.9, rotate: 0 as const };
      };
      const r = await cropRequest(req, png, lines, tmp, undefined, hook);
      expect("bytes" in r).toBe(true);
      expect(seen).toEqual([1, 2, 3]); // 重裁兩次，第三次通過
      let m = 0;
      const always = async () => {
        m += 1;
        return { ok: true as const, score: 0.9, rotate: 0 as const, overflow: { side: "right" as const, frac: 0.6 } };
      };
      const r2 = await cropRequest(req, png, lines, tmp, undefined, always);
      expect(r2).toMatchObject({ reason: "cell_overflow" });
      expect(m).toBeGreaterThanOrEqual(2); // 每次越界都收窄再驗，最多重裁兩次；收窄到切入 label 就提早跳過
      expect(m).toBeLessThanOrEqual(3);
      // 收窄後切到 label 本身 → 直接 cell_overflow（唔再裁）
      const cutsLabel = async () => ({ ok: true as const, score: 0.9, rotate: 0 as const, overflow: { side: "right" as const, frac: 0.01 } });
      expect(await cropRequest(req, png, lines, tmp, undefined, cutsLabel)).toMatchObject({ reason: "cell_overflow" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.skipIf(!canVision)("真 Vision：OCR 將「出生日期＋值」併成一條 line（值行唔似 label）→ hkid 格右溢出，重裁後輸出入面冇「出生日期」", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1m-"));
    try {
      const L = (t: string, x: number, y: number, w: number, h = 0.025) => ({ t, c: 0.9, x, y, w, h });
      // OCR 行：label 獨立；值同後面兩格併成一條（digits >2 → 唔係 label 樣式）
      const lines = [
        L("職位申請表 EMPLOYMENT APPLICATION", 0.1, 0.92, 0.5),
        L("香港身份證號碼：", 0.08, 0.7, 0.18),
        L("Z900001(2) 出生日期： 15-01-1990 出生地點： 香港", 0.27, 0.7, 0.62),
        L("手提電話：", 0.08, 0.5, 0.11),
      ];
      const png = path.join(tmp, "m.png");
      await drawSyntheticPage({ doc: doc("onboarding_form"), lines }, png);
      const run = makeVisionRunner(visionBin!);
      const req = { field: "hkid" as const, docKind: "onboarding_form" as const, priority: 2 as const, doc: doc("onboarding_form") };
      const hook = (c: string) => verifyCrop(c, "hkid", ["Z900001(2)"], run, tmp, { checkOverflow: true });
      const r = await cropRequest(req, png, lines, tmp, undefined, hook);
      expect("bytes" in r, JSON.stringify("reason" in r ? r.reason : "")).toBe(true);
      const out = path.join(tmp, "o.jpg");
      await (await import("node:fs/promises")).writeFile(out, (r as { bytes: Uint8Array }).bytes);
      const [pg] = await run([out], false);
      const text = pg!.lines.map((l) => l.t).join(" ");
      expect(text).toContain("Z900001");
      expect(text).not.toContain("出生日期");
      expect(text).not.toContain("15");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("TE-1.8 診斷：value_mismatch 最高相似度分佈（只計數）", () => {
  it.skipIf(!canVision)("錯人預期值 → hkid 落喺 mismatch_hist；statsLines 印得出、冇值／姓名", async () => {
    const fx = dryFixture();
    const base = fx.people[0]!;
    const wrong = { ...base, person: { ...base.person, hkid: lf("Y123456(7)", "review"), nameZh: lf("陳大文", "review") } };
    const run = makeVisionRunner(visionBin!);
    const deps: Deps = {
      async lines(d) {
        return fx.docs.get(`${d.docId}|${d.page}`)?.lines ?? null;
      },
      existing: () => null,
      async render(d) {
        const out = path.join(os.tmpdir(), `te1h-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
        await drawSyntheticPage(fx.docs.get(`${d.docId}|${d.page}`)!, out);
        return out;
      },
      async cleanup(png) {
        await rm(png, { force: true });
      },
      vision: run,
    };
    const stats = emptyStats();
    await produceItems([wrong as PersonInput], deps, stats);
    expect(stats.skipped.value_mismatch).toBeGreaterThanOrEqual(2);
    const hk = stats.mismatch_hist.hkid!;
    expect(hk.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);
    expect(hk.length).toBe(4);
    const zh = stats.mismatch_hist.name_zh!;
    expect(zh[0]).toBeGreaterThanOrEqual(1); // 完全唔夾（0 重疊）→ 第一格
    const { statsLines } = await import("../scripts/staff-import/20-triage-evidence");
    const txt = statsLines(stats).join("\n");
    expect(txt).toContain("value_mismatch 最高相似度分佈");
    expect(txt).not.toMatch(/Y123456|陳大文|Z900001/);
  }, 120_000);
});
