// TE-10：身份證中文名裁圖唔再被 OCR 行 box 切走尾字——右邊界按預期字數延伸（相片 barrier 仍成立）、Vision 字數規則、自檢。全部合成。
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { boxForRequest, capBox, expectLenOf, locateFormCell, type CropRequest } from "../scripts/staff-import/lib/triage-evidence-core";
import { cropRequest, drawSyntheticPage, syntheticIdCardPage, verifyCrop, type VisionRunner } from "../scripts/staff-import/20-triage-evidence";
import { auditName, summarizeNameAudit } from "../scripts/staff-import/lib/name-crop-audit";
import { dryPersons, run as runNameAudit, parseArgs as nameAuditArgs } from "../scripts/staff-import/22-name-crop-audit";
import type { OcrLine } from "../scripts/staff-import/lib/ocr";

const sh = promisify(execFile);
const MAGICK = existsSync("/opt/homebrew/bin/magick") ? "/opt/homebrew/bin/magick" : "magick";
const hasMagick = await sh(MAGICK, ["-version"]).then(() => true, () => false);
const A4 = 210 / 297;
const doc = { type: "id_card" as const, docId: "d", page: 1 };
const req = (expect?: CropRequest["expect"]): CropRequest => ({ field: "name_zh", docKind: "id_card", priority: 1, doc, ...(expect ? { expect } : {}) });
/** 卡上 3 字名，OCR 只讀到 2 字（行 box 闊 0.08 而唔係 0.12） */
const twoCharCard = () => {
  const c = syntheticIdCardPage();
  return { ...c, lines: c.lines.map((l) => (l.t === "測試甲" ? { ...l, t: "測試", w: 0.08 } : l)) };
};

describe("expectLenOf", () => {
  it("中文姓名＝中文字數×1 em；英文姓名＝字元數×0.55 em；其他欄／冇值＝undefined", () => {
    expect(expectLenOf("name_zh", "測試甲")).toEqual({ chars: 3, em: 1 });
    expect(expectLenOf("name_zh", "陳𠝹 A")).toEqual({ chars: 2, em: 1 });
    expect(expectLenOf("name_en", "TESTER ALPHA")).toEqual({ chars: 12, em: 0.55 });
    expect(expectLenOf("hkid", "A1234563")).toBeUndefined();
    expect(expectLenOf("name_zh", null)).toBeUndefined();
  });
});

describe("身份證左欄裁圖右邊界按預期字數延伸", () => {
  it("OCR 只讀到 2 字、預期 3 字 → 裁圖右界延伸夠 3 字（但唔入相片區）；冇預期值＝照舊（OCR 行 box＋padding）", () => {
    const { lines, photo } = twoCharCard();
    const noExp = boxForRequest(req(), lines, A4).box!;
    const withExp = boxForRequest(req({ chars: 3, em: 1 }), lines, A4).box!;
    expect(withExp.x1).toBeLessThan(noExp.x1); // 冇預期值＝延伸到 barrier（之後 capBox 收窄）；有預期字數＝只延伸到預期字數
    expect(withExp.x1).toBeGreaterThanOrEqual(0.1 + 0.12 - 0.01); // 3 字（0.04/字）右緣約 0.22
    expect(withExp.x1).toBeLessThan(photo.x0); // 相片 barrier 仍成立
    expect(withExp.x0).toBeCloseTo(noExp.x0, 6);
  });
  it("capBox 長度上限考慮預期字數：延伸後唔被收窄；冇預期字數就會被收窄", () => {
    const { lines } = twoCharCard();
    const r = boxForRequest(req({ chars: 3, em: 1 }), lines, A4);
    const W = 2000;
    const H = 2800;
    expect(capBox(r.box!, r.anchor!, W, H).capped).toBe(false);
    expect(capBox(r.box!, { ...r.anchor!, expect: undefined }, W, H).capped).toBe(true);
  });
  it("預期字數好大（例如 30）→ 仍然止於相片左緣 barrier／下一個 OCR 行左邊", () => {
    const { lines, photo } = twoCharCard();
    const b = boxForRequest(req({ chars: 30, em: 1 }), lines, A4).box!;
    expect(b.x1).toBeLessThanOrEqual(photo.x0 - 0.005 + 1e-9);
    // 同一行右邊有另一個 OCR 行 → 止於其左邊
    const withRight = [...lines, { t: "XYZ", c: 0.9, x: 0.2, y: 0.66, w: 0.03, h: 0.025 } as OcrLine];
    const b2 = boxForRequest(req({ chars: 30, em: 1 }), withRight, A4).box!;
    expect(b2.x1).toBeLessThanOrEqual(0.2 + 1e-9);
  });
});

describe("入職表姓名欄：值後冇其他 OCR 行、OCR 值漏尾字 → 右界按預期字數延伸", () => {
  const form: OcrLine[] = [{ t: "職位申請表 EMPLOYMENT APPLICATION", c: 0.9, x: 0.1, y: 0.92, w: 0.5, h: 0.025 }, { t: "中文姓名：", c: 0.9, x: 0.08, y: 0.8, w: 0.12, h: 0.025 }, { t: "測試", c: 0.9, x: 0.21, y: 0.8, w: 0.08, h: 0.025 }];
  it("有預期 3 字：x1 延伸；冇預期：照舊", () => {
    const a = locateFormCell("name_zh", form, 0, null, A4).box!;
    const b = locateFormCell("name_zh", form, 0, null, A4, { chars: 3, em: 1 }).box!;
    expect(b.x1).toBeGreaterThan(a.x1 + 0.01);
    expect(b.x1).toBeGreaterThanOrEqual(0.21 + 3 * (0.025 / A4) - 1e-6);
    // 同行右邊有其他 OCR 行（stopper）→ 唔延伸過佢
    const withStopper = [...form, { t: "English Name:", c: 0.9, x: 0.31, y: 0.8, w: 0.14, h: 0.025 } as OcrLine];
    expect(locateFormCell("name_zh", withStopper, 0, null, A4, { chars: 3, em: 1 }).box!.x1).toBeLessThanOrEqual(0.31);
  });
});

describe.skipIf(!hasMagick)("像素級：卡上 3 字名而 OCR 只有 2 字 box → 裁圖含第 3 字", () => {
  it("cropRequest 輸出闊度 ≥ 3 字寬（冇預期字數時只得 2 字寬＋padding）", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "te10-"));
    try {
      const { lines, photo } = twoCharCard();
      const full = syntheticIdCardPage().lines.find((l) => l.t === "測試甲")!; // 實際印咗 3 字
      const png = path.join(dir, "p.png");
      await drawSyntheticPage({ doc, lines, hidden: [full], photo } as never, png);
      const width = async (bytes: Uint8Array) => {
        const f = path.join(dir, `o-${Math.random().toString(36).slice(2)}.jpg`);
        await writeFile(f, bytes);
        return Number((await sh(MAGICK, [f, "-format", "%w", "info:"])).stdout);
      };
      const a = await cropRequest(req(), png, lines, dir);
      const b = await cropRequest(req({ chars: 3, em: 1 }), png, lines, dir);
      expect("bytes" in a && "bytes" in b).toBe(true);
      const wa = await width((a as { bytes: Uint8Array }).bytes);
      const wb = await width((b as { bytes: Uint8Array }).bytes);
      // 輸出縮放（長邊 ≤800）前後比例相同——3 字版本一定闊過 2 字版本
      expect(wb).toBeGreaterThan(wa * 1.15);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("Vision 字數規則＋延伸重裁：讀數少字 → name_truncated 後延伸一次重驗；通過先出圖；仍少字就跳過 name_truncated", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "te10-"));
    try {
      const { lines, photo } = twoCharCard();
      const full = syntheticIdCardPage().lines.find((l) => l.t === "測試甲")!;
      const png = path.join(dir, "p.png");
      await drawSyntheticPage({ doc, lines, hidden: [full], photo } as never, png);
      const widths: number[] = [];
      const hook = (okAt: number) => async (crop: string) => {
        widths.push(Number((await sh(MAGICK, [crop, "-format", "%w", "info:"])).stdout));
        return widths.length >= okAt ? ({ ok: true as const, score: 1, rotate: 0 as const }) : ({ ok: false as const, reason: "name_truncated" as const, score: 0.67, missing: 1 });
      };
      const r1 = await cropRequest(req({ chars: 3, em: 1 }), png, lines, dir, undefined, hook(2));
      expect("bytes" in r1).toBe(true);
      expect(widths).toHaveLength(2);
      expect(widths[1]!).toBeGreaterThan(widths[0]!); // 第二次比第一次闊
      widths.length = 0;
      const r2 = await cropRequest(req({ chars: 3, em: 1 }), png, lines, dir, undefined, hook(99));
      expect(r2).toMatchObject({ reason: "name_truncated" });
      expect(widths).toHaveLength(2); // 只重裁一次
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verifyCrop：中文姓名讀數字數 < 包內字數 → name_truncated（即使重疊 ≥0.5）；字數夠＋重疊 ≥0.5 → 通過；重疊低 → value_mismatch", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "te10-"));
    try {
      const png = path.join(dir, "c.png");
      await sh(MAGICK, ["-size", "300x60", "xc:white", png]);
      const reading = (t: string): VisionRunner => async (paths) => paths.map(() => ({ lines: [{ t, c: 0.9, x: 0.1, y: 0.2, w: 0.5, h: 0.5 }] }));
      const v = (t: string, exp = ["測試甲"]) => verifyCrop(png, "name_zh", exp, reading(t), dir);
      expect(await v("測試")).toMatchObject({ ok: false, reason: "name_truncated", missing: 1 });
      expect(await v("測試甲")).toMatchObject({ ok: true });
      expect(await v("測試乙")).toMatchObject({ ok: true }); // 字數夠、重疊 2/3
      expect(await v("測")).toMatchObject({ ok: false, reason: "value_mismatch" });
      expect(await v("測試", ["測試"])).toMatchObject({ ok: true }); // 包內只有 2 字
      expect(await v("測試甲乙", ["測試甲"])).toMatchObject({ ok: true }); // 多讀唔算少字
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("22-name-crop-audit 自檢", () => {
  it("auditName／summarize：潛在切字人數同分佈；--dry 固定 fixture；輸出冇姓名值", async () => {
    const people = dryPersons();
    const rows = people.map(auditName);
    expect(rows.find((r) => r.key === "dry-1")).toMatchObject({ compared: true, deficit: 1 });
    expect(rows.find((r) => r.key === "dry-4")).toMatchObject({ compared: true, deficit: 0 });
    expect(rows.find((r) => r.key === "dry-5")).toMatchObject({ hasIdPage: false, compared: false });
    expect(rows.find((r) => r.key === "dry-6")).toMatchObject({ compared: false });
    const r = await runNameAudit(nameAuditArgs(["--dry"]));
    expect(r.summary).toEqual(summarizeNameAudit(rows));
    expect(r.summary).toMatchObject({ persons: 6, with_id_page: 5, compared: 4, short: 3, deficit_1: 1, deficit_2: 1, deficit_3plus: 1 });
    expect(r.affected.map((a) => a.person_key).sort()).toEqual(["dry-1", "dry-2", "dry-3"]);
    expect(JSON.stringify(r)).not.toMatch(/測試/);
    void readFile;
  });
});
