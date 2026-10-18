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
  syntheticPermitPageWithEmbeddedCard,
  syntheticCertificatePage,
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
  clipToPhoto,
  detectEmbeddedCards,
  findPrintedHkidLines,
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
      "hkid:id_card:1", "hkid:onboarding_form:3",
      "name_zh:id_card:1", "name_zh:onboarding_form:2",
      "name_en:id_card:1", "name_en:onboarding_form:2",
      "dob:id_card:1", "dob:onboarding_form:2",
    ]);
  });

  it("冇證件退入職表（priority 2）；冇入職表就只有證件", () => {
    expect(sig([FORM], ["name_zh", "dob", "hkid"])).toEqual(["name_zh:onboarding_form:2", "dob:onboarding_form:2", "hkid:onboarding_form:3"]);
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
    // TE-2：所有非 confirmed 欄（review／missing／absent）＋入職日期一律出
    expect(evidenceFieldsOf(p({}))).toEqual(["hkid", "hire_date"]);
    expect(evidenceFieldsOf(p({ hkid: lf("Z1", "confirmed") }))).toEqual(["hire_date"]);
    expect(evidenceFieldsOf(p({ hkid: lf("Z1", "review"), phone: lf("9", "review"), address: lf("x", "review") }))).toEqual(["hkid", "phone", "address", "hire_date"]);
    expect(evidenceFieldsOf(p({ nameZh: lf(null, "missing"), dateOfBirth: undefined }))).toEqual(["hkid", "name_zh", "dob", "hire_date"]);
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
  it.skipIf(!hasMagick)("每人出圖符合 §7：有證件用證件；冇證件退入職表；兩者都有次序；認唔出卡面唔裁身份證欄；冇文件／冇 review 欄唔出", { timeout: 180_000 }, async () => {
    const r = await run(parseArgs(["--dry"]));
    const bySig = (key: string) => r.items.filter((i) => i.match.staff_numbers[0] === key).map((i) => `${i.field}:${i.docKind}:${i.priority}`);
    // 人 1：三份文件齊
    expect(bySig("DRY1")).toEqual(expect.arrayContaining(["hkid:id_card:1", "hkid:onboarding_form:3", "name_zh:id_card:1", "name_zh:onboarding_form:2", "dob:id_card:1", "address:address_proof:1", "address:onboarding_form:2", "phone:onboarding_form:1"]));
    // 人 2：冇住址證明 → 住址只有入職表（priority 2）；相片喺左嘅版面一樣出
    expect(bySig("DRY2")).toContain("address:onboarding_form:2");
    expect(bySig("DRY2")).not.toContain("address:address_proof:1");
    expect(bySig("DRY2")).toContain("name_en:id_card:1");
    // 人 3：冇證件 → 退入職表
    expect(bySig("DRY3")).toEqual(expect.arrayContaining(["hkid:onboarding_form:3", "name_zh:onboarding_form:2", "name_en:onboarding_form:2", "dob:onboarding_form:2", "phone:onboarding_form:1", "address:onboarding_form:2"]));
    expect(bySig("DRY3").some((s) => s.includes("id_card"))).toBe(false);
    // 人 4 冇文件、人 6 冇 review 欄 → 冇圖
    expect(bySig("DRY4")).toEqual([]);
    expect(bySig("DRY6")).toEqual([]); // 冇文件（confirmed 欄；入職日期亦無頁可裁）
    // 人 5：認唔出卡面 → 身份證欄唔裁，退入職表
    expect(bySig("DRY5").some((s) => s.includes("id_card"))).toBe(false);
    expect(r.stats).toMatchObject({ persons_total: 8, persons_with_fields: 8, persons_no_docs: 2, persons_failed: 0 });
    expect(r.stats.skipped.no_card_anchor).toBe(4);
    // 同一欄 priority 1 一定排喺 priority 2 前面（每人內）
    for (const key of ["DRY1", "DRY2"]) {
      const mine = r.items.filter((i) => i.match.staff_numbers[0] === key);
      for (const f of new Set(mine.map((i) => i.field))) {
        const pr = mine.filter((i) => i.field === f).map((i) => i.priority);
        expect(pr).toEqual([...pr].sort());
        expect(pr.length).toBeLessThanOrEqual(3);
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
      expect([1, 2, 3]).toContain(it.priority);
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
      expect(await verifyCrop(zh, "hkid", [], run, tmp)).toMatchObject({ ok: true, score: null, rotate: 0 });
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
    const good = items.filter((i) => i.field !== "hkid" && i.field !== "hire_date"); // hire_date 無預期值＝不驗證
    expect(good.length).toBeGreaterThan(0);
    for (const i of good) {
      expect(typeof i.verifyScore).toBe("number");
      expect(i.verifyScore!).toBeGreaterThan(0);
      expect(i.verifyScore!).toBeLessThanOrEqual(1);
    }
    expect(stats.verified).toBe(good.length);
    expect(stats.unverified).toBe(items.length - good.length);
  }, 180_000);

  it("--dry 有 Vision：全部 verify，manifest 帶 verify_score（淨數字 0–1）並過伺服器 strict manifest schema；console 淨計數", async () => {
    const r = await run_(parseArgs(["--dry", "--vision-bin", visionBin!]));
    expect(r.stats.verified + r.stats.unverified).toBe(r.items.length);
    expect(r.stats.verified).toBeGreaterThan(0);
    expect(r.stats.unverified).toBeGreaterThan(0); // hire_date／全 missing 嘅人冇預期值
    const { manifest } = await readEvidenceZip(r.zips[0]!);
    expect(evidenceManifestSchema.safeParse(manifest).success).toBe(true);
    const raw = JSON.parse(await (await JSZip.loadAsync(r.zips[0]!)).file("manifest.json")!.async("string")) as { items: { verify_score?: number }[] };
    for (const it of raw.items) {
      if (it.verify_score === undefined) continue; // 冇預期值
      expect(typeof it.verify_score).toBe("number");
      expect(it.verify_score).toBeGreaterThanOrEqual(0);
      expect(it.verify_score).toBeLessThanOrEqual(1);
    }
    expect(raw.items.filter((i) => i.verify_score !== undefined).length).toBe(r.stats.verified);
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
    expect(findOverflow("hkid", sep, (l) => /身份證/.test(l.t))).toEqual({ side: "right", frac: 0.55, group: "dob" });
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

// ===========================================================================
// TE-1.9
// ===========================================================================
describe("TE-1.9 S1：capBox 收窄之後再同相片範圍做相交檢查", () => {
  const photo = { x0: 0.4, x1: 0.56, y0: 0.5775, y1: 0.78 };
  const line = (t: string, x: number, y: number, w: number, h = 0.035) => ({ t, c: 0.9, x, y, w, h });

  it("clipToPhoto：冇相交原樣；號碼框（行喺相片 x 範圍內）夾 y 到相片下緣；左邊欄夾 x 到相片左緣", () => {
    const hk = line("Z900001(2)", 0.44, 0.54, 0.12);
    const clean = { x0: 0.43, x1: 0.57, y0: 0.53, y1: 0.57 };
    expect(clipToPhoto(clean, photo, [hk])).toEqual(clean);
    expect(clipToPhoto(clean, null, [hk])).toEqual(clean);
    // 收窄後向上 0.3×行厚（0.0105）伸入相片
    const narrowed = { x0: 0.43, x1: 0.57, y0: 0.53, y1: 0.54 + 0.035 + 0.0105 };
    const c = clipToPhoto(narrowed, photo, [hk])!;
    expect(c).not.toBeNull();
    expect(c.y1).toBeLessThan(photo.y0);
    expect(c.y1).toBeGreaterThanOrEqual(hk.y + hk.h);
    expect(intersects(c, photo)).toBe(false);
    // 左邊欄（行喺相片左邊）：右緣夾到相片左緣
    const en = line("TESTER, Alpha", 0.1, 0.7, 0.25, 0.025);
    const wideEn = { x0: 0.09, x1: 0.5, y0: 0.69, y1: 0.73 };
    const ce = clipToPhoto(wideEn, photo, [en])!;
    expect(ce.x1).toBeLessThan(photo.x0);
    expect(ce.x1).toBeGreaterThanOrEqual(en.x + en.w);
    expect(intersects(ce, photo)).toBe(false);
  });

  it("夾唔走（字本身伸入相片區）或者夾走咗字 → null（呼叫者計 id_photo_overlap）", () => {
    const longEn = line("TESTER-LONGFAMILYNAME, Alphabeta", 0.1, 0.7, 0.45, 0.025);
    const box = { x0: 0.09, x1: 0.56, y0: 0.52, y1: 0.73 }; // 同相片重疊，而名行本身 x 伸入相片範圍
    expect(clipToPhoto(box, photo, [longEn])).toBeNull();
    // 號碼行本身喺相片裡面（理論上唔會發生）→ y 夾會夾走字 → null
    const inside = line("Z900001(2)", 0.44, 0.6, 0.12);
    expect(clipToPhoto({ x0: 0.43, x1: 0.57, y0: 0.59, y1: 0.64 }, photo, [inside])).toBeNull();
  });

  it("capBox 窄化出嚟嘅框經 cropRequest 都會過 clipToPhoto：成個 id 欄流程冇相片色（hkid 緊貼相片底、行厚 98px）", async () => {
    if (!hasMagick) return;
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1s1-"));
    try {
      const { lines, photo: ph } = syntheticIdCardPage(true, 0.003);
      const d = doc("id_card");
      const png = path.join(tmp, "p.png");
      await drawSyntheticPage({ doc: d, lines, photo: ph }, png);
      const r = await cropRequest({ field: "hkid", docKind: "id_card", priority: 1, doc: d }, png, lines, tmp);
      expect("bytes" in r).toBe(true);
      const f = path.join(tmp, "o.jpg");
      await (await import("node:fs/promises")).writeFile(f, (r as { bytes: Uint8Array }).bytes);
      const m = await sh(MAGICK, [f, "-fx", "r-g", "-format", "%[fx:maxima]", "info:"]);
      expect(Number(m.stdout)).toBeLessThan(0.15);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("TE-1.9 S2：真跑搵唔到 Vision 就停（exit 1），除非明確 --no-verify；--dry 降級 warn", () => {
  it("run（非 dry）：--vision-bin 唔存在 → ArgError（提示 --no-verify），唔讀任何檔；加 --no-verify 就唔會因 Vision 而停", async () => {
    const deps: Deps = { lines: async () => null, existing: () => null, render: async () => null, cleanup: async () => {} };
    const args = parseArgs(["--vision-bin", "/definitely/not/there", "--out", "data/x"]);
    await expect(run(args, { people: [], deps })).rejects.toThrow(/--no-verify/);
    await expect(run(args, { people: [], deps })).rejects.toThrow(/vision-ocr/);
    const ok = await run(parseArgs(["--no-verify", "--out", "data/x"]), { people: [], deps });
    expect(ok.items).toEqual([]);
  });

  it("main：真跑 --vision-bin 唔存在 → 喺讀 package 之前 reject（CLI 層 exit 1）；--no-verify 就越過呢關（之後先因檔案唔存在失敗）", async () => {
    const { main } = await import("../scripts/staff-import/20-triage-evidence");
    const base = ["--package", "/nope/a.json", "--person-fields", "/nope/b.json", "--extract", "/nope/c.json", "--index", "/nope/d.json", "--out", "data/te1-s2-test"];
    await expect(main([...base, "--vision-bin", "/definitely/not/there"])).rejects.toThrow(/--no-verify/);
    await expect(main([...base, "--no-verify"])).rejects.not.toThrow(/vision-ocr/);
  });

  it.skipIf(!hasMagick)("--dry 搵唔到 Vision：warn 後自動 no-verify，照出圖（全部未驗證）", async () => {
    const warn: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warn.push(a.join(" "));
    try {
      const r = await run_(parseArgs(["--dry", "--vision-bin", "/definitely/not/there"]));
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.stats.verified).toBe(0);
      expect(r.stats.unverified).toBe(r.items.length);
      expect(warn.join("\n")).toContain("no-verify");
    } finally {
      console.warn = orig;
    }
  }, 120_000);
});

describe.skipIf(!canVision)("TE-1.9 S3：純中文姓名方向沿用同頁其他欄", () => {
  const FONT_LATIN = "/System/Library/Fonts/Supplemental/Arial.ttf";
  const FONT_CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc";
  const run = makeVisionRunner(visionBin!);
  const crop = async (tmp: string, name: string, text: string, deg = 0, cjk = false) => {
    const f = path.join(tmp, `${name}.png`);
    await sh(MAGICK, ["-size", `${Math.max(420, text.length * (cjk ? 70 : 38) + 60)}x110`, "xc:white", "-font", cjk ? FONT_CJK : FONT_LATIN, "-pointsize", "58", "-fill", "black", "-annotate", "+24+78", text, ...(deg ? ["-rotate", String(deg)] : []), f]);
    return f;
  };

  it("verifyCrop：Latin 欄判到 180°（decisive）；純中文 180° 冇證據→0（decisive=false）；帶 pagePrior=180 就跟（followedPage）；側躺跟 90／270，prior 唔屬候選→unknown", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te1s3-"));
    try {
      const en = await crop(tmp, "en", "TESTER, Alpha", 180);
      const ve = await verifyCrop(en, "name_en", ["TESTER ALPHA"], run, tmp);
      expect(ve).toMatchObject({ ok: true, rotate: 180, decisive: true });
      const zh = await crop(tmp, "zh", "測試甲", 180, true);
      expect(await verifyCrop(zh, "name_zh", ["測試甲"], run, tmp)).toMatchObject({ ok: true, rotate: 0, decisive: false });
      expect(await verifyCrop(zh, "name_zh", ["測試甲"], run, tmp, { pagePrior: 180 })).toMatchObject({ ok: true, rotate: 180, decisive: false, followedPage: true });
      expect(await verifyCrop(zh, "name_zh", ["測試甲"], run, tmp, { pagePrior: null })).toMatchObject({ ok: true, rotate: 0 });
      const side = await crop(tmp, "zh90", "測試甲 火炭", 90, true);
      expect(await verifyCrop(side, "name_zh", ["測試甲"], run, tmp, { pagePrior: 270 })).toMatchObject({ ok: true, rotate: 270, followedPage: true });
      expect(await verifyCrop(side, "name_zh", ["測試甲"], run, tmp, { pagePrior: 180 })).toEqual({ ok: false, reason: "orientation_unknown" });
      expect(await verifyCrop(side, "name_zh", ["測試甲"], run, tmp)).toEqual({ ok: false, reason: "orientation_unknown" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("produceItems：整頁 180° 倒轉（Vision 睇到嘅裁圖全部上下顛倒）——英文名／號碼等判到 180°，中文名排最後並沿用；全頁冇欄判到就維持 prior", async () => {
    const fx = dryFixture();
    const base = run;
    const flip: typeof base = async (paths, fast) => {
      const tmp2 = await mkdtemp(path.join(os.tmpdir(), "te1flip-"));
      try {
        const outs = await Promise.all(paths.map(async (pth, i) => {
          const o = path.join(tmp2, `f${i}.png`);
          await sh(MAGICK, [pth, "-rotate", "180", o]);
          return o;
        }));
        return await base(outs, fast);
      } finally {
        await rm(tmp2, { recursive: true, force: true });
      }
    };
    const mk = (vision: typeof base): Deps => ({
      async lines(d) {
        return fx.docs.get(`${d.docId}|${d.page}`)?.lines ?? null;
      },
      existing: () => null,
      async render(d) {
        const out = path.join(os.tmpdir(), `te1s3p-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
        await drawSyntheticPage(fx.docs.get(`${d.docId}|${d.page}`)!, out);
        return out;
      },
      async cleanup(png) {
        await rm(png, { force: true });
      },
      vision,
    });
    const person = fx.people[0]!;
    const stats = emptyStats();
    const items = await produceItems([person], mk(flip), stats);
    const zhIdx = items.map((i, k) => (i.field === "name_zh" ? k : -1)).filter((k) => k >= 0);
    const others = items.map((i, k) => (i.field !== "name_zh" && i.field !== "hire_date" ? k : -1)).filter((k) => k >= 0); // hire_date（無預期值）排得更後
    expect(zhIdx.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...zhIdx)).toBeGreaterThan(Math.max(...others)); // name_zh 排最後
    expect(stats.skipped.orientation_unknown ?? 0).toBe(0);
    expect(stats.page_orientation_followed).toBeGreaterThanOrEqual(1); // 中文名沿用同頁方向
    // 正向版本（冇倒轉）：英文名等判到 0°（decisive），中文名跟 0°，同樣有 followed
    const stats2 = emptyStats();
    const items2 = await produceItems([person], mk(base), stats2);
    expect(items2.some((i) => i.field === "name_zh")).toBe(true);
    expect(stats2.page_orientation_followed).toBeGreaterThanOrEqual(1);
  }, 240_000);
});

// ===========================================================================
// TE-2
// ===========================================================================
import { findEmbeddedCards, isHkidFormatLine } from "../scripts/staff-import/lib/embedded-card";
import { hkidCheckDigitValid } from "../scripts/staff-import/lib/hkid";
import { classifyPage } from "../scripts/staff-import/lib/extract";
import { aggregateDoc } from "../scripts/staff-import/lib/aggregate";

describe("TE-2 嵌入式身份證／印刷號碼偵測（純函數）", () => {
  const A4 = 210 / 297;
  it("isHkidFormatLine：整行 HKID 格式（容許全形括號）；多餘字／缺括號內容唔算", () => {
    const mk = (letters: string, six: string) => {
      const c = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(`${letters}${six}${x}`))!;
      return `${letters}${six}${c}`;
    };
    const z = mk("Z", "900001"); // 有效 check digit
    const ab = mk("AB", "123456");
    for (const t of [`${z.slice(0, -1)}(${z.slice(-1)})`, `${z.slice(0, -1)}（${z.slice(-1)}）`, z, `${z.slice(0, -1)} (${z.slice(-1)})`, `${ab.slice(0, -1)}(${ab.slice(-1)})`]) expect(isHkidFormatLine(t), t).toBe(true);
    for (const t of ["香港身份證號碼 Z900001(2)", `${z} 90001110`, "12345678", "Z90000", ""]) expect(isHkidFormatLine(t), t).toBe(false);
    // TE-2.1 A：格式啱但 check digit 錯 → 唔當 HKID；保安牌照號（A＋7 位數字）排除
    const bad = z.slice(0, -1) + (z.endsWith("0") ? "1" : "0");
    expect(isHkidFormatLine(bad)).toBe(false);
    expect(isHkidFormatLine("A1234567")).toBe(false);
    expect(isHkidFormatLine("A1234567(8)")).toBe(false);
  });

  it("findEmbeddedCards：牌照頁右下角細卡→一個卡區（含號碼行同 label，卡比例 85.6×54）；冇 label／冇號碼行→無", () => {
    const { lines } = syntheticPermitPageWithEmbeddedCard();
    const cards = findEmbeddedCards(lines, A4);
    expect(cards).toHaveLength(1);
    const c = cards[0]!;
    expect(c.hkid.t).toContain("Z900001");
    expect(c.labels.length).toBeGreaterThanOrEqual(1);
    const wPx = (c.box.x1 - c.box.x0) * A4; // 頁高單位
    const hPx = c.box.y1 - c.box.y0;
    expect(wPx / hPx).toBeGreaterThan(1.4);
    expect(wPx / hPx).toBeLessThan(1.8);
    // 卡內行都喺卡區入面
    for (const t of ["TESTER", "測試甲", "15-01-1990"]) {
      const l = lines.find((x) => x.t.includes(t))!;
      expect(l.x).toBeGreaterThanOrEqual(c.box.x0 - 1e-9);
      expect(l.x + l.w).toBeLessThanOrEqual(c.box.x1 + 1e-9);
    }
    expect(findEmbeddedCards(lines.filter((l) => !/出生日期|簽發日期/.test(l.t)), A4)).toEqual([]);
    expect(findEmbeddedCards(lines.filter((l) => !l.t.includes("Z900001")), A4)).toEqual([]);
  });

  it("detectEmbeddedCards：頁面擺反（90／180／270）都搵到，回要轉幾多度同轉正後卡區", () => {
    const { lines } = syntheticPermitPageWithEmbeddedCard();
    for (const th of [0, 90, 180, 270] as const) {
      const det = detectEmbeddedCards(rotateLines(lines, th), A4);
      expect(det, `θ=${th}`).not.toBeNull();
      expect(det!.rot).toBe(((360 - th) % 360) as 0 | 90 | 180 | 270);
      expect(det!.cards).toHaveLength(1);
    }
  });

  it("findPrintedHkidLines：證書頁印刷號碼行（唔喺卡區內）；卡內嗰行唔算；有身份證標題嘅整頁身份證唔算", () => {
    const cert = syntheticCertificatePage();
    const pr = findPrintedHkidLines(cert, A4);
    expect(pr).toHaveLength(1);
    expect(pr[0]!.rot).toBe(0);
    expect(pr[0]!.line.t).toContain("Z900001");
    const { lines } = syntheticPermitPageWithEmbeddedCard();
    const det = detectEmbeddedCards(lines, A4)!;
    expect(findPrintedHkidLines(lines, A4, (l) => det.cards.some((c) => c.hkid.t === l.t))).toEqual([]);
    expect(findPrintedHkidLines(syntheticIdCardPage().lines, A4)).toEqual([]); // 真身份證頁有 anchor
    // 側躺嘅印刷行 → rot 90
    const side = rotateLines(cert, 90);
    expect(findPrintedHkidLines(side, A4)[0]!.rot).toBe(90);
  });
});

describe("TE-2 來源優先順序：身份證副本 1 ＞ 印刷 2 ＞ 入職表手寫 3；每欄 ≤3、每人 ≤18", () => {
  const FORM = doc("onboarding_form");
  const ID = doc("id_card");
  const sig = (docs: DocPage[], fields: Parameters<typeof planRequests>[0], extra: Parameters<typeof planRequests>[2] = {}) => planRequests(fields, docs, extra).map((r) => `${r.field}:${r.docKind}:${r.priority}${r.variant !== undefined ? `#${r.variant}` : ""}${r.embedded ? "@emb" : ""}${r.printed ? "@prt" : ""}`);
  const emb = { doc: doc("id_card", 9), rot: 0 as const, region: { x0: 0.5, x1: 0.8, y0: 0.1, y1: 0.24 } };
  const prt = { doc: doc("id_card", 8), rot: 0 as const, line: { t: "Z900001(2)", c: 0.9, x: 0.4, y: 0.6, w: 0.12, h: 0.02 } };

  it("冇整頁身份證副本：嵌入式身份證做 priority 1，印刷 2，入職表 3；hkid 三張，其餘身份證欄 1＋入職表 2", () => {
    expect(sig([FORM], ["hkid", "name_zh", "dob"], { embedded: [emb], printed: [prt] })).toEqual([
      "hkid:id_card:1@emb", "hkid:printed:2@prt", "hkid:onboarding_form:3",
      "name_zh:id_card:1@emb", "name_zh:onboarding_form:2",
      "dob:id_card:1@emb", "dob:onboarding_form:2",
    ]);
  });

  it("有整頁身份證副本就唔用嵌入式；冇印刷來源就跳過；hire_date 入職表兩格（入職日期先）；phone／address 不受印刷影響", () => {
    expect(sig([FORM, ID], ["hkid"], { embedded: [emb], printed: [] })).toEqual(["hkid:id_card:1", "hkid:onboarding_form:3"]);
    expect(sig([FORM], ["hire_date"])).toEqual(["hire_date:onboarding_form:1#0", "hire_date:onboarding_form:1#1"]);
    expect(sig([], ["hire_date"])).toEqual([]);
    expect(sig([FORM], ["phone", "address"], { printed: [prt] })).toEqual(["phone:onboarding_form:1", "address:onboarding_form:2"]);
  });

  it("人數上限：全欄全來源 ≤ 18（最多 hkid3＋name_zh2＋name_en2＋dob2＋phone1＋address2＋hire2＝14）", () => {
    const r = planRequests(["hkid", "name_zh", "name_en", "dob", "phone", "address", "hire_date"], [FORM, doc("address_proof")], { embedded: [emb], printed: [prt] });
    expect(r.length).toBe(14);
    expect(r.length).toBeLessThanOrEqual(18);
    for (const f of new Set(r.map((x) => x.field))) expect(r.filter((x) => x.field === f).length).toBeLessThanOrEqual(3);
  });
});

describe("TE-2 入職日期兩格（入職日期／可到職日期；OCR 誤讀「人職」都認）", () => {
  const lab = (t: string, x: number, y: number, w: number, h = 0.025) => ({ t, c: 0.9, x, y, w, h });
  const ov = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => intersects(b, { x0: l.x, x1: l.x + l.w, y0: l.y, y1: l.y + l.h });
  it("variant 0＝入職日期格（格內空白都裁）；variant 1＝可到職日期格（含值）；兩格互不包含對方 label", () => {
    const lines = syntheticFormPage();
    const l0 = lines.find((l) => l.t.includes("入職日期"))!;
    const l1 = lines.find((l) => l.t.includes("可到職日期"))!;
    const v1 = lines.find((l) => l.t.includes("2026-11-01"))!;
    const c0 = locateFormCell("hire_date", lines, 0).box!;
    const c1 = locateFormCell("hire_date", lines, 1).box!;
    expect(c0.x0).toBeLessThanOrEqual(l0.x);
    expect(c0.x1).toBeGreaterThanOrEqual(l0.x + l0.w);
    expect(ov(c0, l1)).toBe(false);
    expect(c0.x1).toBeLessThan(l1.x); // 入職日期格右界停喺下一格 label 之前（值空白）
    expect(c1.x0).toBeLessThanOrEqual(l1.x);
    expect(c1.x1).toBeGreaterThanOrEqual(v1.x + v1.w);
    expect(ov(c1, l0)).toBe(false);
    expect(locateFormCell("hire_date", lines.filter((l) => !l.t.includes("可到職")), 1).reason).toBe("form_label_not_located");
  });
  it("OCR 誤讀「人職日期」照認；「可到職日期」唔會被當入職日期格", () => {
    const f = [lab("職位申請表 EMPLOYMENT APPLICATION", 0.1, 0.92, 0.5), lab("人職日期：", 0.08, 0.6, 0.11), lab("可到職日期：", 0.4, 0.6, 0.13)];
    const c0 = locateFormCell("hire_date", f, 0).box!;
    expect(ov(c0, f[2]!)).toBe(false);
    expect(c0.x0).toBeLessThanOrEqual(0.08);
    const only = [f[0]!, f[2]!];
    expect(locateFormCell("hire_date", only, 0).reason).toBe("form_label_not_located");
  });
});

describe("TE-2 導入流程分類：一頁多 kind（牌照頁＋嵌入身份證）", () => {
  it("classifyPage：牌照頁夾細身份證 → kinds 含 sia_permit＋id_card（embeddedCard），primary 仍然 sia_permit；整頁普通牌照頁／整頁身份證不變", () => {
    const { lines } = syntheticPermitPageWithEmbeddedCard();
    const c = classifyPage({ page: 1, lines });
    expect(c.kinds).toEqual(expect.arrayContaining(["sia_permit", "id_card"]));
    expect(c.primary).toBe("sia_permit");
    expect(c.embeddedCard).toBe(true);
    const plain = classifyPage({ page: 1, lines: lines.filter((l) => !/出生日期|簽發日期|TESTER|測試甲|15-01|Z900001/.test(l.t)).concat([{ t: "備註", c: 0.9, x: 0.1, y: 0.7, w: 0.1, h: 0.02 }]) });
    expect(plain.kinds).not.toContain("id_card");
    const idPage = classifyPage({ page: 1, lines: syntheticIdCardPage().lines });
    expect(idPage.kinds).toContain("id_card");
    expect(idPage.embeddedCard).toBeUndefined();
  });

  it("aggregateDoc：身份證抽取對嵌入卡區行做——抽到卡上嘅號碼／姓名／出生日期（唔掃整頁牌照資料）", () => {
    const { lines } = syntheticPermitPageWithEmbeddedCard();
    const d = aggregateDoc("d-embedded", [{ page: 1, lines }]);
    expect(d.hkid?.value).toContain("Z900001");
    expect(d.pages[0]!.kinds).toContain("id_card");
  });
});

describe.skipIf(!hasMagick || !hasSyntheticFonts)("TE-2 嵌入式身份證裁圖（像素級）：牌照頁右下角細卡", () => {
  it("四個身份證欄都裁到（doc_kind id_card、卡區內、行現有相片區／barrier／capBox 邏輯），冇相片色；印刷行裁細 padding", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te2e-"));
    try {
      const permit = syntheticPermitPageWithEmbeddedCard();
      const d = doc("id_card", 7);
      const png = path.join(tmp, "permit.png");
      await drawSyntheticPage({ doc: d, lines: permit.lines, photo: permit.photo }, png);
      const det = detectEmbeddedCards(permit.lines, 2000 / 2800)!;
      for (const field of ["hkid", "name_zh", "name_en", "dob"] as const) {
        const req = { field, docKind: "id_card" as const, priority: 1 as const, doc: d, embedded: { rot: det.rot, region: det.cards[0]!.box } };
        const r = await cropRequest(req, png, permit.lines, tmp);
        expect("bytes" in r, field).toBe(true);
        const f = path.join(tmp, `o-${field}.jpg`);
        await (await import("node:fs/promises")).writeFile(f, (r as { bytes: Uint8Array }).bytes);
        const m = await sh(MAGICK, [f, "-fx", "r-g", "-format", "%[fx:maxima]", "info:"]);
        expect(Number(m.stdout), `${field} 冇相片色`).toBeLessThan(0.15);
        const id = await sh(MAGICK, ["identify", "-format", "%w %h", f]);
        const [w, h] = id.stdout.split(" ").map(Number) as [number, number];
        expect(h, `${field} 唔係成頁`).toBeLessThan(300);
        expect(w).toBeLessThan(800);
      }
      // 印刷行（證書頁）
      const cert = syntheticCertificatePage();
      const cd = doc("id_card", 70);
      const cpng = path.join(tmp, "cert.png");
      await drawSyntheticPage({ doc: cd, lines: cert }, cpng);
      const pr = findPrintedHkidLines(cert, 2000 / 2800)[0]!;
      const pr2 = await cropRequest({ field: "hkid", docKind: "printed", priority: 2, doc: cd, printed: pr }, cpng, cert, tmp);
      expect("bytes" in pr2).toBe(true);
      const pf = path.join(tmp, "printed.jpg");
      await (await import("node:fs/promises")).writeFile(pf, (pr2 as { bytes: Uint8Array }).bytes);
      const pid = await sh(MAGICK, ["identify", "-format", "%w %h", pf]);
      const [pw, ph] = pid.stdout.split(" ").map(Number) as [number, number];
      expect(ph).toBeLessThan(120); // 只係該行＋小 padding
      expect(pw).toBeLessThan(400);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("--dry 人 7（全部欄 missing）：嵌入卡四欄＋印刷 hkid＋入職表 hkid／phone／address／hire_date×2 全部出圖；無預期值不驗證但方向照做", async () => {
    const r = await run_(parseArgs(["--dry", "--no-verify"]));
    const mine = r.items.filter((i) => i.match.staff_numbers[0] === "DRY7").map((i) => `${i.field}:${i.docKind}:${i.priority}`);
    expect(mine).toEqual(expect.arrayContaining(["hkid:id_card:1", "hkid:printed:2", "hkid:onboarding_form:3", "name_zh:id_card:1", "name_en:id_card:1", "dob:id_card:1", "phone:onboarding_form:1", "address:onboarding_form:2"]));
    expect(mine.filter((s) => s.startsWith("hire_date"))).toHaveLength(2);
  }, 120_000);

  it.skipIf(!canVision)("--dry 人 7 有 Vision：冇預期值→未驗證（無 verify_score），其餘照出", async () => {
    const r = await run_(parseArgs(["--dry", "--vision-bin", visionBin!]));
    const seven = r.items.filter((i) => i.match.staff_numbers[0] === "DRY7");
    expect(seven.length).toBeGreaterThanOrEqual(10);
    expect(seven.every((i) => i.verifyScore === undefined)).toBe(true);
    expect(r.items.filter((i) => i.match.staff_numbers[0] === "DRY1").some((i) => i.verifyScore !== undefined)).toBe(true);
  }, 240_000);
});

// ===========================================================================
// TE-2.1
// ===========================================================================
import { splitMergedLines, locateFormCell as locateCell } from "../scripts/staff-import/lib/triage-evidence-core";
import { crossNameOk, detectFormPhoto, pageResidual, readabilityScore, secondStageLines } from "../scripts/staff-import/20-triage-evidence";

describe("TE-2.1 A：HKID checksum（牌照號唔當 HKID）", () => {
  const A4 = 210 / 297;
  const L = (t: string, x: number, y: number, w: number, h = 0.02) => ({ t, c: 0.9, x, y, w, h });
  it("printed 偵測：保安牌照號（A＋7 位）、check digit 錯嘅號碼都唔收；有效號碼收", () => {
    const page = [L("保安人員許可證 PERMIT", 0.1, 0.9, 0.5), L("A1234567", 0.52, 0.49, 0.1), L("B7654321", 0.52, 0.45, 0.1), L("Z900002(9)", 0.5, 0.4, 0.1)];
    // Z900002(9)：check digit 係刻意錯嘅（有效嗰個係 Z900001(?) 嗰類，呢度另選）
    const valid = syntheticCertificatePage().find((l) => l.t.includes("Z900001"))!;
    expect(findPrintedHkidLines(page, A4)).toEqual([]);
    expect(findPrintedHkidLines([...page, valid], A4)).toHaveLength(1);
    // 牌照號喺卡區附近亦唔會推出卡區
    const permit = syntheticPermitPageWithEmbeddedCard().lines.map((l) => (l.t.includes("Z900001") ? { ...l, t: "A1234567" } : l));
    expect(findEmbeddedCards(permit, A4)).toEqual([]);
  });
});

describe("TE-2.1 B：merged OCR line——label 關鍵詞偏移定位", () => {
  const lab = (t: string, x: number, y: number, w: number, h = 0.025) => ({ t, c: 0.9, x, y, w, h });
  const title = lab("職位申請表 EMPLOYMENT APPLICATION", 0.1, 0.95, 0.5);
  const ov = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => intersects(b, { x0: l.x, x1: l.x + l.w, y0: l.y, y1: l.y + l.h });

  it("splitMergedLines：39 字併行切成 label／值 virtual 行，x 按字元寬度比例單調遞增；最後冇值嘅 label 帶 endX＝行尾；單 label 行原樣", () => {
    const merged = lab("香港身份證號碼：Z900001(2) 出生日期： 15-01-1990 出生地點：", 0.131, 0.672, 0.595);
    const segs = splitMergedLines([merged]);
    expect(segs.map((x) => x.t)).toEqual(["香港身份證號碼：", "Z900001(2)", "出生日期：", "15-01-1990", "出生地點："]);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.x).toBeGreaterThan(segs[i - 1]!.x);
    expect(segs[0]!.x).toBeCloseTo(0.131, 6);
    expect(segs[4]!.endX).toBeCloseTo(0.131 + 0.595, 6);
    expect(segs.every((x) => x.x >= 0.131 - 1e-9 && x.x + x.w <= 0.131 + 0.595 + 1e-6)).toBe(true);
    const single = lab("手提電話：", 0.08, 0.5, 0.11);
    expect(splitMergedLines([single])).toEqual([single]);
    // 描述字 + label（無數字）屬同一 label：「遇有緊急事故聯絡人姓名：」唔切開
    expect(splitMergedLines([lab("遇有緊急事故聯絡人姓名： 陳大文", 0.1, 0.4, 0.5)]).map((x) => x.t)).toEqual(["遇有緊急事故聯絡人姓名：", "陳大文"]);
  });

  it("老闆個案第 1 頁：「香港身份證號碼：｜出生日期：｜出生地點：」成行一條 39 字 line（手寫號碼 OCR 冇讀到）→ hkid 格只裁第一格（右界＝出生日期關鍵詞推算 x），不含出生日期／出生地點", () => {
    const merged = lab("香港身份證號碼： 出生日期： 出生地點：", 0.131, 0.672, 0.595);
    const segs = splitMergedLines([merged]);
    const dob = segs.find((x) => x.t.startsWith("出生日期"))!;
    const pob = segs.find((x) => x.t.startsWith("出生地點"))!;
    const hk = locateCell("hkid", [title, merged]);
    expect(hk.box).not.toBeNull();
    expect(hk.box!.x0).toBeLessThanOrEqual(0.131);
    expect(hk.box!.x1).toBeLessThanOrEqual(dob.x);
    expect(hk.box!.x1).toBeGreaterThan(0.131 + 0.05);
    const d = locateCell("dob", [title, merged]).box!;
    expect(d.x0).toBeGreaterThanOrEqual(dob.x - 1e-9);
    expect(d.x1).toBeLessThanOrEqual(pob.x);
    expect(ov(d, { x: pob.x, y: 0.672, w: pob.w, h: 0.025 })).toBe(false);
  });

  it("入職日期：「許可證號碼｜許可證屆滿日期｜入職日期：」併行（格內空白）→ 只裁入職日期格（行尾為界），唔包牌照號同屆滿日", () => {
    const merged = lab("許可證號碼： 許可證屆滿日期： 入職日期：", 0.1, 0.55, 0.7);
    const segs = splitMergedLines([merged]);
    const hire = segs.find((x) => x.t.startsWith("入職日期"))!;
    const exp = segs.find((x) => x.t.startsWith("許可證屆滿日期"))!;
    const r = locateCell("hire_date", [title, merged], 0);
    expect(r.box).not.toBeNull();
    expect(r.box!.x0).toBeGreaterThanOrEqual(exp.x + exp.w - 1e-6); // 唔包屆滿日期格
    expect(r.box!.x0).toBeLessThanOrEqual(hire.x);
    expect(r.box!.x1).toBeCloseTo(0.1 + 0.7 + 0.8 * 0.025, 4); // 行尾 + 0.8×行高（TE-2.2）
  });
});

describe("TE-2.1 C：範本 B 兩行 label block", () => {
  const lab = (t: string, x: number, y: number, w: number, h = 0.022) => ({ t, c: 0.9, x, y, w, h });
  const ov = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => intersects(b, { x0: l.x, x1: l.x + l.w, y0: l.y, y1: l.y + l.h });
  it("「香港身份證:」＋「H.K. I.D. Card No.:」兩行 label、值寫喺右邊跨兩行 → 合併 block，cell 高度＝block＋0.25×行高，值兩行都包；下一行 label 唔入；cap 以 block 計唔切走值", () => {
    const zh = lab("香港身份證:", 0.08, 0.6, 0.13);
    const en = lab("H.K. I.D. Card No.:", 0.08, 0.576, 0.17);
    const v1 = lab("Z900001", 0.28, 0.6, 0.1);
    const v2 = lab("(2)", 0.28, 0.576, 0.05);
    const next = lab("出生日期:", 0.08, 0.53, 0.12);
    const title = lab("職位申請表 EMPLOYMENT APPLICATION", 0.1, 0.95, 0.5);
    const lines = [title, zh, en, v1, v2, next];
    const r = locateCell("hkid", lines);
    expect(r.box).not.toBeNull();
    for (const l of [zh, en, v1, v2]) expect(ov(r.box!, l)).toBe(true);
    expect(r.box!.y0).toBeLessThanOrEqual(en.y);
    expect(r.box!.y1).toBeGreaterThanOrEqual(zh.y + zh.h);
    expect(ov(r.box!, next)).toBe(false);
    expect(r.box!.y1 - r.box!.y0).toBeLessThanOrEqual(0.022 * 2 + 0.002 + 0.25 * 0.046 * 2 + 0.01); // block 高度＋上下 pad
    // label 即 block：cap 錨喺 block，唔會把雙行值切走
    const b = capBox(r.box!, { own: [r.label!], mode: "form" }, 2000, 2800);
    expect(b.capped).toBe(false);
    // 單行 label（冇英文翻譯行）照舊
    const single = locateCell("hkid", [title, zh, v1]);
    expect(single.box!.y0).toBeGreaterThan(en.y);
  });
});

describe("TE-2.1 D：姓名 label 只喺申請人個人資料段落；表頭「姓 名」唔算", () => {
  const lab = (t: string, x: number, y: number, w: number, h = 0.022) => ({ t, c: 0.9, x, y, w, h });
  it("有標題：個人資料段內嘅「中文姓名：」中；頁底「諮詢人資料」表格嘅「姓 名」（同行有地址／電話／關係）唔中", () => {
    const lines = [
      lab("申請人個人資料 Personal Particulars", 0.08, 0.9, 0.5),
      lab("中文姓名：", 0.08, 0.82, 0.12), lab("測試甲", 0.21, 0.82, 0.1),
      lab("過去 3 年受僱記錄", 0.08, 0.5, 0.3),
      lab("諮詢人資料", 0.08, 0.2, 0.2),
      lab("姓 名", 0.08, 0.15, 0.06), lab("地址", 0.3, 0.15, 0.06), lab("電話", 0.5, 0.15, 0.06), lab("關係", 0.7, 0.15, 0.06),
    ];
    const r = locateCell("name_zh", lines);
    expect(r.box).not.toBeNull();
    expect(r.box!.y0).toBeGreaterThan(0.5); // 喺個人資料段
    // 個人資料段冇姓名 label、淨得頁底表頭 → 唔中
    const onlyHeader = lines.filter((l) => !l.t.includes("中文姓名") && l.t !== "測試甲");
    expect(locateCell("name_zh", onlyHeader).reason).toBe("form_label_not_located");
    // 冇標題：取頁頂 50%——頁底（y<0.5）嘅「姓名：」唔中
    const noHeading = [lab("姓名：", 0.08, 0.2, 0.08), lab("陳大文", 0.17, 0.2, 0.1)];
    expect(locateCell("name_zh", noHeading).reason).toBe("form_label_not_located");
    expect(locateCell("name_zh", [lab("姓名：", 0.08, 0.7, 0.08), lab("陳大文", 0.17, 0.7, 0.1)]).box).not.toBeNull();
  });
});

describe.skipIf(!hasMagick)("TE-2.1 E：相片格要真係有相先排除", () => {
  it("detectFormPhoto：右上 25%×35% 有深色相片格→回 FORM_PHOTO_BOX；冇相→null；冇相片格時右上格（English Name／出生地點）唔被 form_photo_overlap 殺", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te21e-"));
    try {
      const lines = syntheticFormPage();
      const withPhoto = path.join(tmp, "with.png");
      const noPhoto = path.join(tmp, "no.png");
      await drawSyntheticPage({ doc: doc("onboarding_form"), lines, photo: SYNTHETIC_FORM_PHOTO }, withPhoto);
      await drawSyntheticPage({ doc: doc("onboarding_form"), lines }, noPhoto);
      expect(await detectFormPhoto(withPhoto, 0, tmp)).toEqual(FORM_PHOTO_BOX);
      expect(await detectFormPhoto(noPhoto, 0, tmp)).toBeNull();
      // 右上格：English Name（x .55–.71，y .8）喺 FORM_PHOTO_BOX 之外；造一格喺相片區內嘅 label
      const rightTop = [lab0("職位申請表 EMPLOYMENT APPLICATION", 0.1, 0.95, 0.5), lab0("中文姓名：", 0.08, 0.8, 0.12), lab0("English Name:", 0.78, 0.8, 0.13), lab0("TESTER ALPHA", 0.78, 0.77, 0.15)];
      expect(locateCell("name_en", rightTop).reason).toBe("form_photo_overlap"); // 預設當有相片格
      expect(locateCell("name_en", rightTop, 0, null).box).not.toBeNull(); // 冇相片格：照裁
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
const lab0 = (t: string, x: number, y: number, w: number, h = 0.025) => ({ t, c: 0.9, x, y, w, h });

describe.skipIf(!canVision)("TE-2.1 F：冇預期值嘅方向判斷", () => {
  const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
  const run = makeVisionRunner(visionBin!);
  const crop = async (tmp: string, name: string, text: string, deg = 0) => {
    const f = path.join(tmp, `${name}.png`);
    await sh(MAGICK, ["-size", `${Math.max(480, text.length * 36 + 60)}x110`, "xc:white", "-font", FONT, "-pointsize", "56", "-fill", "black", "-annotate", "+24+78", text, ...(deg ? ["-rotate", String(deg)] : []), f]);
    return f;
  };
  it("readabilityScore：字母數字＋字典詞命中", () => {
    expect(readabilityScore("English Name: TESTER")).toBeGreaterThan(readabilityScore("OLLL0006 (z)"));
    expect(readabilityScore("")).toBe(0);
  });
  it("有同頁 prior→跟 prior（followedPage）；冇 prior→.fast 四方向讀數明顯差距先決定（180°→rotate 180）；差距唔明顯→維持 prior（0，非側躺）", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te21f-"));
    try {
      const up = await crop(tmp, "up", "English Name: TESTER ALPHA");
      const d180 = await crop(tmp, "d180", "English Name: TESTER ALPHA", 180);
      expect(await verifyCrop(d180, "hire_date", [], run, tmp, { pagePrior: 180 })).toMatchObject({ ok: true, score: null, rotate: 180, followedPage: true });
      expect(await verifyCrop(d180, "hire_date", [], run, tmp)).toMatchObject({ ok: true, score: null, rotate: 180, decisive: true });
      expect(await verifyCrop(up, "hire_date", [], run, tmp)).toMatchObject({ ok: true, score: null, rotate: 0, decisive: true });
      const side = await crop(tmp, "side", "English Name: TESTER ALPHA", 90);
      expect(await verifyCrop(side, "hire_date", [], run, tmp)).toMatchObject({ ok: true, rotate: 270 });
      const blank = path.join(tmp, "blank.png");
      await sh(MAGICK, ["-size", "400x100", "xc:white", blank]);
      expect(await verifyCrop(blank, "hire_date", [], run, tmp)).toMatchObject({ ok: true, rotate: 0, decisive: false });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!canVision || !hasMagick)("TE-2.1 G：嵌入卡二階段局部 OCR（200dpi 整頁 OCR 讀唔到細卡）", () => {
  it("secondStageLines：300dpi 切 2×2＋中間，行座標映射返全頁，搵到細卡（detectEmbeddedCards）；第一階段 lines 冇卡", async () => {
    const fx = dryFixture();
    const d = [...fx.docs.values()].find((x) => x.doc.docId.includes("8-sia_permit"))!;
    expect(detectEmbeddedCards(d.lines, 210 / 297)).toBeNull(); // 整頁 OCR 讀唔到
    const deps: Deps = {
      lines: async () => d.lines,
      existing: () => null,
      render: async () => {
        const out = path.join(os.tmpdir(), `te21g-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
        await drawSyntheticPage(d, out);
        return out;
      },
      cleanup: async (p) => {
        await rm(p, { force: true });
      },
      vision: makeVisionRunner(visionBin!),
    };
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te21g-"));
    try {
      const s2 = await secondStageLines(d.doc, deps, tmp);
      expect(s2).not.toBeNull();
      const det = detectEmbeddedCards(s2!.lines, s2!.aspect);
      expect(det).not.toBeNull();
      const box = det!.cards[0]!.box;
      expect(box.x0).toBeGreaterThan(0.4);
      expect(box.y1).toBeLessThan(0.4); // 右下角
      expect(await secondStageLines(d.doc, { ...deps, vision: undefined }, tmp)).toBeNull(); // 冇 Vision 唔做
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 180_000);

  it("--dry 人 8（hkid missing、牌照頁細卡只有二階段先讀到）：二階段頁數 ≥1，嵌入卡四欄出圖；有 Vision 先做", async () => {
    const r = await run_(parseArgs(["--dry", "--vision-bin", visionBin!]));
    expect(r.stats.second_stage_pages).toBeGreaterThanOrEqual(1);
    const eight = r.items.filter((i) => i.match.staff_numbers[0] === "DRY8").map((i) => `${i.field}:${i.docKind}:${i.priority}`);
    expect(eight).toEqual(expect.arrayContaining(["hkid:id_card:1", "name_en:id_card:1", "dob:id_card:1"]));
    // 冇 Vision（--no-verify）→ 唔做二階段，人 8 搵唔到嵌入卡
    const r2 = await run_(parseArgs(["--dry", "--no-verify"]));
    expect(r2.stats.second_stage_pages).toBe(0);
    expect(r2.items.filter((i) => i.match.staff_numbers[0] === "DRY8").some((i) => i.docKind === "id_card")).toBe(false);
    // H：按欄跳過原因分佈只有計數
    const { statsLines } = await import("../scripts/staff-import/20-triage-evidence");
    const txt = statsLines(r.stats).join("\n");
    expect(txt).toContain("按欄跳過原因");
    expect(txt).toContain("二階段局部 OCR 頁數");
    expect(txt).not.toMatch(/Z900001|TESTER|測試甲/);
  }, 300_000);
});

describe("TE-2.1 S3：非個人資料欄溢出到個人資料格——直接跳過（cell_overflow_pii），個人資料欄之間照收界重裁", () => {
  it.skipIf(!hasMagick)("hire_date／phone 遇上個人資料關鍵詞（hkid／dob／name／address）→ cell_overflow_pii 唔重裁；溢出到電話（非 PII）照收界；hkid 旁邊出生日期（PII↔PII）照重裁", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te21s3-"));
    try {
      const lines = syntheticFormPage();
      const png = path.join(tmp, "form.png");
      await drawSyntheticPage({ doc: doc("onboarding_form"), lines, photo: SYNTHETIC_FORM_PHOTO }, png);
      const mk = (field: "hire_date" | "phone" | "hkid") => ({ field, docKind: "onboarding_form" as const, priority: 1 as const, doc: doc("onboarding_form") });
      const hookOnce = (group: string) => {
        let n = 0;
        return async () => {
          n += 1;
          return n === 1 ? { ok: true as const, score: null, rotate: 0 as const, overflow: { side: "right" as const, frac: 0.6, group } } : { ok: true as const, score: null, rotate: 0 as const };
        };
      };
      for (const g of ["hkid", "dob", "name_en", "address", "pob"]) {
        expect(await cropRequest(mk("hire_date"), png, lines, tmp, undefined, hookOnce(g)), `hire_date→${g}`).toMatchObject({ reason: "cell_overflow_pii" });
        expect(await cropRequest(mk("phone"), png, lines, tmp, undefined, hookOnce(g)), `phone→${g}`).toMatchObject({ reason: "cell_overflow_pii" });
      }
      // 非 PII 關鍵詞（電話）：照收界重裁
      expect("bytes" in (await cropRequest(mk("hire_date"), png, lines, tmp, undefined, hookOnce("phone")))).toBe(true);
      // 個人資料欄之間：hkid 格旁邊係出生日期 → 照舊收界重裁
      expect("bytes" in (await cropRequest(mk("hkid"), png, lines, tmp, undefined, hookOnce("dob")))).toBe(true);
      // findOverflow 帶 group
      expect(findOverflow("hire_date", [{ t: "入職日期： 香港身份證號碼：", x: 0.02, y: 0.35, w: 0.9, h: 0.3 }], (l) => /入職/.test(l.t))).toMatchObject({ side: "right", group: "hkid" });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("TE-2.1 S4：無預期值 hkid 圖（printed／嵌入卡）交叉一致性——confirmed 姓名要喺同頁 OCR 行出現", () => {
  const p0 = (over: Record<string, unknown>) => ({ key: "k", hkid: lf(null, "missing"), nameZh: lf(null, "missing"), nameEn: lf(null, "missing"), dateOfBirth: lf(null, "missing"), phone: lf(null, "missing"), address: lf(null, "missing"), staffNumbers: [], ...over }) as never;
  const page = syntheticCertificatePage(); // 「姓名 NAME TESTER ALPHA」
  it("crossNameOk：冇 confirmed 姓名→true；英文名 token 覆蓋 ≥0.5→true；中文字元重疊 ≥0.5→true；有 confirmed 姓名但頁面完全唔夾→false；非 confirmed 姓名唔計", () => {
    expect(crossNameOk(p0({}), page)).toBe(true);
    expect(crossNameOk(p0({ nameEn: lf("TESTER ALPHA", "confirmed") }), page)).toBe(true);
    expect(crossNameOk(p0({ nameEn: lf("CHAN TAI MAN", "confirmed") }), page)).toBe(false);
    expect(crossNameOk(p0({ nameEn: lf("CHAN TAI MAN", "review") }), page)).toBe(true); // review 唔計
    const withZh = [...page, { t: "測試甲", c: 0.9, x: 0.1, y: 0.7, w: 0.1, h: 0.02 }];
    expect(crossNameOk(p0({ nameZh: lf("測試甲", "confirmed") }), withZh)).toBe(true);
    expect(crossNameOk(p0({ nameZh: lf("陳大文", "confirmed") }), withZh)).toBe(false);
    // 中英其中一個夾就過
    expect(crossNameOk(p0({ nameZh: lf("陳大文", "confirmed"), nameEn: lf("TESTER ALPHA", "confirmed") }), page)).toBe(true);
  });

  it.skipIf(!hasMagick)("produceItems：人 7（printed＋嵌入卡）——confirmed 姓名唔夾→hkid 嵌入卡／印刷圖 cross_name_mismatch 跳過（入職表 hkid 照出）；夾→照出；冇 confirmed→照出", async () => {
    const mkDeps = (fx: ReturnType<typeof dryFixture>): Deps => ({
      lines: async (d) => fx.docs.get(`${d.docId}|${d.page}`)?.lines ?? null,
      existing: () => null,
      render: async (d) => {
        const out = path.join(os.tmpdir(), `te21s4-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
        await drawSyntheticPage(fx.docs.get(`${d.docId}|${d.page}`)!, out);
        return out;
      },
      cleanup: async (png) => {
        await rm(png, { force: true });
      },
    });
    const fx = dryFixture();
    const seven = fx.people.find((x) => x.person.staffNumbers[0]!.number === "DRY7")!;
    const run1 = async (over: Record<string, unknown>) => {
      const stats = emptyStats();
      const items = await produceItems([{ ...seven, person: { ...seven.person, ...over } }], mkDeps(fx), stats);
      return { items, stats, hk: items.filter((i) => i.field === "hkid").map((i) => `${i.docKind}:${i.priority}`) };
    };
    const bad = await run1({ nameEn: lf("CHAN TAI MAN", "confirmed") });
    expect(bad.hk).toEqual(["onboarding_form:3"]);
    expect(bad.stats.skipped_by_field.hkid?.cross_name_mismatch).toBe(2); // 嵌入卡＋印刷
    const good = await run1({ nameEn: lf("TESTER ALPHA", "confirmed") });
    expect(good.hk).toEqual(expect.arrayContaining(["id_card:1", "printed:2", "onboarding_form:3"]));
    const none = await run1({});
    expect(none.hk).toEqual(expect.arrayContaining(["id_card:1", "printed:2"]));
  }, 180_000);
});

// ===========================================================================
// TE-2.2
// ===========================================================================
describe("TE-2.2 範本 B 姓名欄：兩行 label（中文＋Name (English)／Name (Chinese)）、單獨「Name：」", () => {
  const lab = (t: string, x: number, y: number, w: number, h = 0.022) => ({ t, c: 0.9, x, y, w, h });
  const ov = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => intersects(b, { x0: l.x, x1: l.x + l.w, y0: l.y, y1: l.y + l.h });
  const inside = (b: { x0: number; x1: number; y0: number; y1: number }, l: { x: number; y: number; w: number; h: number }) => l.x >= b.x0 - 1e-9 && l.x + l.w <= b.x1 + 1e-9 && l.y >= b.y0 - 1e-9 && l.y + l.h <= b.y1 + 1e-9;
  const head = lab("申請人個人資料 Personal Particulars", 0.08, 0.92, 0.5);

  it("「英文姓名:」＋下一行「Name (English):」、值寫喺右邊偏下 → block 包埋值兩行；唔包下一格（中文姓名）", () => {
    const en = lab("英文姓名:", 0.08, 0.8, 0.12);
    const tr = lab("Name (English):", 0.08, 0.776, 0.16);
    const v1 = lab("TESTER", 0.3, 0.79, 0.1);
    const v2 = lab("ALPHA", 0.3, 0.768, 0.1); // 偏下
    const zh = lab("中文姓名:", 0.08, 0.7, 0.12);
    const ztr = lab("Name (Chinese):", 0.08, 0.676, 0.16);
    const zv = lab("測試甲", 0.3, 0.68, 0.1);
    const lines = [head, en, tr, v1, v2, zh, ztr, zv];
    const e = locateCell("name_en", lines);
    expect(e.box).not.toBeNull();
    for (const l of [en, tr, v1, v2]) expect(inside(e.box!, l), l.t).toBe(true);
    expect(ov(e.box!, zh)).toBe(false);
    const z = locateCell("name_zh", lines);
    for (const l of [zh, ztr, zv]) expect(inside(z.box!, l), l.t).toBe(true);
    expect(ov(z.box!, en)).toBe(false); // 唔包上一格
    expect(ov(z.box!, v2)).toBe(false);
  });

  it("互不當翻譯行：「中文姓名:」下一行係獨立嘅「English Name:」行 → 唔合併；x 範圍重疊 <50% 或垂直 >1.2×行高 → 唔合併", () => {
    const zh = lab("中文姓名:", 0.08, 0.8, 0.12);
    const en = lab("English Name:", 0.08, 0.776, 0.14);
    const zv = lab("測試甲", 0.25, 0.8, 0.1);
    const r = locateCell("name_zh", [head, zh, en, zv]);
    expect(ov(r.box!, en)).toBe(false);
    const far = lab("Name (Chinese):", 0.08, 0.7, 0.16); // 垂直太遠
    const r2 = locateCell("name_zh", [head, zh, far, zv]);
    expect(ov(r2.box!, far)).toBe(false);
    const side = lab("Name (Chinese):", 0.6, 0.776, 0.16); // 水平冇重疊
    const r3 = locateCell("name_zh", [head, zh, side, zv]);
    expect(r3.box!.x1).toBeLessThanOrEqual(0.6);
  });

  it("單獨「Name：」label（冇 English／中文）→ 認作英文姓名；值分幾段、離 label 好遠都取到下一個 label／行尾", () => {
    const nm = lab("Name：", 0.08, 0.8, 0.07);
    const a = lab("TESTER", 0.4, 0.8, 0.08);
    const b = lab("ALPHA KAP", 0.52, 0.8, 0.12); // 同行、隔咗 >3×行高
    const next = lab("出生日期：", 0.75, 0.8, 0.1);
    const r = locateCell("name_en", [head, nm, a, b, next]);
    expect(r.box).not.toBeNull();
    expect(inside(r.box!, a) && inside(r.box!, b)).toBe(true);
    expect(r.box!.x1).toBeLessThan(next.x);
    // 冇下一個 label：取到行尾（最後一段值右邊 +0.6×行高）
    const r2 = locateCell("name_en", [head, nm, a, b]);
    expect(r2.box!.x1).toBeGreaterThanOrEqual(b.x + b.w);
  });
});

describe("TE-2.2 hire_date merged row：label 喺行尾冇值／空格／人職／前綴描述字", () => {
  const lab = (t: string, x: number, y: number, w: number, h = 0.025) => ({ t, c: 0.9, x, y, w, h });
  const title = lab("職位申請表 EMPLOYMENT APPLICATION", 0.1, 0.95, 0.5);

  it("splitMergedLines：容許「入 職日期」「人職日期」；前綴「申請職位 Position Apply ……」切開（唔令成行變 label）", () => {
    for (const t of ["許可證號碼： 許可證屆滿日期： 入 職日期：", "許可證號碼： 許可證屆滿日期： 人職日期：", "許 可證號碼： 許可證屆滿日期： 入職日期："]) {
      const segs = splitMergedLines([lab(t, 0.1, 0.55, 0.7)]);
      expect(segs.map((x) => x.t).length, t).toBe(3);
      expect(segs[2]!.endX).toBeCloseTo(0.8, 6);
    }
    const pos = splitMergedLines([lab("申請職位 Position Apply ……可到職日期：", 0.1, 0.6, 0.7)]);
    expect(pos.map((x) => x.t)).toEqual(["申請職位 Position Apply ……", "可到職日期："]);
    expect(pos[1]!.x).toBeGreaterThan(0.1 + 0.2);
    // 聯絡人類前綴仍然屬 label
    expect(splitMergedLines([lab("遇有緊急事故聯絡人姓名：", 0.1, 0.4, 0.3)]).map((x) => x.t)).toEqual(["遇有緊急事故聯絡人姓名："]);
  });

  it("「許可證號碼｜許可證屆滿日期｜入職日期：」label 喺行尾冇值 → 裁「label 推算 x 起到行右邊＋0.8×行高」嘅格（空白格照出），唔包牌照號同屆滿日", () => {
    const merged = lab("許可證號碼： 許可證屆滿日期： 入職日期：", 0.1, 0.55, 0.7);
    const segs = splitMergedLines([merged]);
    const hire = segs[2]!;
    const exp = segs[1]!;
    const r = locateCell("hire_date", [title, merged], 0).box!;
    expect(r.x0).toBeGreaterThanOrEqual(exp.x + exp.w - 1e-6);
    expect(r.x0).toBeLessThanOrEqual(hire.x);
    expect(r.x1).toBeCloseTo(0.8 + 0.8 * 0.025, 4);
    // 含數值嘅併行（牌照號＋屆滿日）
    const withVals = lab("許可證號碼： A1234567 許可證屆滿日期： 01-01-2028 入職日期：", 0.1, 0.55, 0.8);
    const r2 = locateCell("hire_date", [title, withVals], 0).box!;
    const s2 = splitMergedLines([withVals]);
    const h2 = s2.find((x) => x.t.startsWith("入職日期"))!;
    expect(r2.x0).toBeGreaterThanOrEqual(s2.find((x) => x.t === "01-01-2028")!.x + 0.001);
    expect(r2.x0).toBeLessThanOrEqual(h2.x);
  });

  it("「申請職位 Position Apply ……可到職日期：」→ variant 1 只裁可到職日期格，唔包申請職位", () => {
    const merged = lab("申請職位 Position Apply ……可到職日期：", 0.1, 0.6, 0.7);
    const segs = splitMergedLines([merged]);
    const r = locateCell("hire_date", [title, merged], 1).box!;
    expect(r.x0).toBeGreaterThanOrEqual(segs[0]!.x + segs[0]!.w - 1e-6);
    expect(r.x1).toBeCloseTo(0.8 + 0.8 * 0.025, 4);
    expect(locateCell("hire_date", [title, merged], 0).reason).toBe("form_label_not_located");
  });

  it("越界檢查：hire_date 裁圖 Vision 讀到「許可證／屆滿／申請職位」→ findOverflow 回 permit／position 組（非 PII：S3 唔跳過，收界重裁）", () => {
    const vl = (t: string, x: number, y: number, w: number, h = 0.3) => ({ t, x, y, w, h });
    const hit = findOverflow("hire_date", [vl("入職日期： 許可證屆滿日期：", 0.02, 0.35, 0.9)], (l) => /入職/.test(l.t));
    expect(hit).toMatchObject({ side: "right", group: "permit" });
    expect(PII_OVERFLOW_GROUPS_TEST.has(hit!.group!)).toBe(false);
    expect(findOverflow("hire_date", [vl("入職日期： 申請職位 Position", 0.02, 0.35, 0.9)], (l) => /入職/.test(l.t))).toMatchObject({ group: "position" });
  });
});
import { PII_OVERFLOW_GROUPS as PII_OVERFLOW_GROUPS_TEST } from "../scripts/staff-import/lib/triage-evidence-core";

describe.skipIf(!canVision || !hasMagick || !hasSyntheticFonts)("TE-2.2 頁面級方向判斷（入職表頁／印刷行所在頁）", () => {
  const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
  const run = makeVisionRunner(visionBin!);
  const page = async (tmp: string, name: string, deg = 0, blank = false) => {
    const f = path.join(tmp, `${name}.png`);
    const args = ["-size", "1400x1980", "xc:white"];
    if (!blank) {
      args.push("-font", FONT, "-pointsize", "44", "-fill", "black");
      const texts = ["EMPLOYMENT APPLICATION FORM", "English Name: TESTER ALPHA", "Phone: 90001110", "Address: FLAT 15 TEST STREET", "Date of Birth: 15-01-1990", "Position Applied: GUARD"];
      texts.forEach((t, i) => args.push("-annotate", `+80+${120 + i * 120}`, t));
    }
    await sh(MAGICK, [...args, ...(deg ? ["-rotate", String(deg)] : []), f]);
    return f;
  };
  it("pageResidual：正向→0、倒轉→180、空白→null；先按 prior 轉正再判（prior 90 嘅側躺頁）", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te22p-"));
    try {
      expect(await pageResidual(await page(tmp, "up"), 0, tmp, undefined, run)).toBe(0);
      expect(await pageResidual(await page(tmp, "flip", 180), 0, tmp, undefined, run)).toBe(180);
      expect(await pageResidual(await page(tmp, "blank", 0, true), 0, tmp, undefined, run)).toBeNull();
      // 頁面順時針轉咗 90°，版面 prior 話要轉 270 先正向；轉正後係正向 → 0
      const side = await page(tmp, "side", 90);
      expect(await pageResidual(side, 270, tmp, new Map(), run)).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }, 120_000);

  it("produceItems：整份入職表倒轉（Vision 睇到嘅圖全部上下顛倒）→ 頁面級方向判到 180°，hire_date 等無預期值裁圖沿用（followedPage），page_oriented_pages ≥1；每頁只判一次", async () => {
    const fx = dryFixture();
    const base = run;
    const flip: typeof base = async (paths, fast) => {
      const t2 = await mkdtemp(path.join(os.tmpdir(), "te22flip-"));
      try {
        const outs = await Promise.all(paths.map(async (pth, i) => {
          const o = path.join(t2, `f${i}.png`);
          await sh(MAGICK, [pth, "-rotate", "180", o]);
          return o;
        }));
        return await base(outs, fast);
      } finally {
        await rm(t2, { recursive: true, force: true });
      }
    };
    let pageCalls = 0;
    const counting: typeof base = async (paths, fast) => {
      if (fast && paths.length === 2 && paths.every((p) => /po(0|180)-/.test(p))) pageCalls += 1;
      return flip(paths, fast);
    };
    const deps: Deps = {
      lines: async (d) => fx.docs.get(`${d.docId}|${d.page}`)?.lines ?? null,
      existing: () => null,
      render: async (d) => {
        const out = path.join(os.tmpdir(), `te22i-${process.pid}-${Math.random().toString(36).slice(2)}.png`);
        await drawSyntheticPage(fx.docs.get(`${d.docId}|${d.page}`)!, out);
        return out;
      },
      cleanup: async (p) => {
        await rm(p, { force: true });
      },
      vision: counting,
    };
    const seven = fx.people.find((x) => x.person.staffNumbers[0]!.number === "DRY7")!;
    const stats = emptyStats();
    const items = await produceItems([seven], deps, stats);
    expect(items.filter((i) => i.field === "hire_date")).toHaveLength(2);
    expect(stats.page_oriented_pages).toBeGreaterThanOrEqual(1);
    expect(stats.page_orientation_followed).toBeGreaterThanOrEqual(2);
    expect(pageCalls).toBeLessThanOrEqual(3); // 入職表頁＋印刷行頁（牌照／證書頁）各一次
  }, 240_000);
});

describe("TE-2.2.1 Opus M：name_en 唔可以揀中緊急聯絡人／其他人物欄（錯證據）", () => {
  const lab = (t: string, x: number, y: number, w: number, h = 0.022) => ({ t, c: 0.9, x, y, w, h });
  const head = lab("申請人個人資料 Personal Particulars", 0.08, 0.92, 0.5);
  const end = lab("過去 3 年受僱記錄", 0.08, 0.4, 0.3);

  it("情況 2：申請人「英文姓名：」冇 OCR 到，只剩緊急聯絡人表頭「Name」（同行有 Tel／關係／地址）→ 唔揀（not located），唔會裁聯絡人", () => {
    const emHeader = [lab("緊急聯絡人 Emergency Contact", 0.08, 0.6, 0.4), lab("Name：", 0.08, 0.56, 0.07), lab("陳大文", 0.17, 0.56, 0.1), lab("Tel：", 0.45, 0.56, 0.06), lab("關係：", 0.7, 0.56, 0.08)];
    expect(locateCell("name_en", [head, ...emHeader, end]).reason).toBe("form_label_not_located");
    // 表頭「Name」同行只有 Address／Phone 亦當表頭
    expect(locateCell("name_en", [head, lab("Name：", 0.08, 0.56, 0.07), lab("Address：", 0.4, 0.56, 0.1), end]).reason).toBe("form_label_not_located");
    // 同行冇表頭詞，但上一行係「Emergency Contact」標題 → 單獨 Name 唔接受
    expect(locateCell("name_en", [head, lab("Emergency Contact", 0.08, 0.64, 0.3), lab("Name：", 0.08, 0.61, 0.07), lab("陳大文", 0.17, 0.61, 0.1), end]).reason).toBe("form_label_not_located");
    // 申請人自己嘅「英文姓名：」仍然優先／正常
    const own = [lab("英文姓名：", 0.08, 0.8, 0.12), lab("TESTER ALPHA", 0.22, 0.8, 0.15)];
    expect(locateCell("name_en", [head, ...own, ...emHeader, end]).box).not.toBeNull();
    expect(locateCell("name_en", [head, ...own, ...emHeader, end]).box!.y0).toBeGreaterThan(0.7);
  });

  it("情況 3：「Emergency Contact English Name:」（切開前綴 + English Name）唔當申請人英文姓名；英文其他人物詞（Guarantor／Witness／Employer／Referee／Reference／Spouse）同樣排除；中文 諮詢人／介紹人／配偶", () => {
    for (const t of ["Emergency Contact English Name:", "Guarantor English Name:", "Witness English Name:", "Employer English Name:", "Referee English Name:", "Reference English Name:", "Spouse English Name:"]) {
      const r = locateCell("name_en", [head, lab(t, 0.08, 0.7, 0.4), lab("CHAN", 0.5, 0.7, 0.1), end]);
      expect(r.reason, t).toBe("form_label_not_located");
    }
    for (const t of ["諮詢人英文姓名：", "介紹人中文姓名：", "配偶中文姓名：", "緊急聯絡人姓名："]) {
      const f = t.includes("英文") ? "name_en" : "name_zh";
      expect(locateCell(f, [head, lab(t, 0.08, 0.7, 0.3), lab("陳大文", 0.4, 0.7, 0.1), end]).reason, t).toBe("form_label_not_located");
    }
    // 同一行或上一行冇其他人物詞時，單獨 Name 照收（個人資料段頂部 40%）
    expect(locateCell("name_en", [head, lab("Name：", 0.08, 0.85, 0.07), lab("TESTER", 0.18, 0.85, 0.1), end]).box).not.toBeNull();
    // 但喺個人資料段下半部（頂部 40% 以外）單獨 Name 唔接受
    expect(locateCell("name_en", [head, lab("Name：", 0.08, 0.5, 0.07), lab("TESTER", 0.18, 0.5, 0.1), end]).reason).toBe("form_label_not_located");
    // 冇標題：取頁頂 50% 嘅頂 40%（cy ≥ 0.8）
    expect(locateCell("name_en", [lab("Name：", 0.08, 0.9, 0.07), lab("TESTER", 0.18, 0.9, 0.1)]).box).not.toBeNull();
    expect(locateCell("name_en", [lab("Name：", 0.08, 0.65, 0.07), lab("TESTER", 0.18, 0.65, 0.1)]).reason).toBe("form_label_not_located");
  });

  it("phone／address label 亦排除英文其他人物詞（Emergency Contact Phone 唔當本人電話）；一般 Contact 字眼（聯絡電話）照收", () => {
    expect(locateCell("phone", [head, lab("Emergency Contact Phone No.:", 0.08, 0.7, 0.4), lab("91234567", 0.5, 0.7, 0.1), end]).reason).toBe("form_label_not_located");
    expect(locateCell("phone", [head, lab("聯絡電話：", 0.08, 0.7, 0.12), lab("90001110", 0.22, 0.7, 0.1), end]).box).not.toBeNull();
  });
});
