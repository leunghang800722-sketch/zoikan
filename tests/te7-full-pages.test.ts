// TE-7：本機腳本整頁原稿（--full-pages-for-failed）＋doc_ref manifest。全部合成（ImageMagick 畫嘅假頁），唔讀 data。
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildEvidenceZips, imageOk, isFailedPerson, matchOfPerson } from "../scripts/staff-import/lib/triage-evidence-core";
import { emptyStats, parseArgs, pageJpeg, produceItems, type Deps, type PersonInput } from "../scripts/staff-import/20-triage-evidence";
import { readEvidenceZip } from "@/lib/triage/evidence-upload";
import { inspectImage } from "@/lib/triage/evidence-format";
import type { PkgPerson } from "../scripts/staff-import/lib/triage-reread-core";

const sh = promisify(execFile);
const MAGICK = existsSync("/opt/homebrew/bin/magick") ? "/opt/homebrew/bin/magick" : "magick";
const hasMagick = await sh(MAGICK, ["-version"]).then(() => true, () => false);
const lf = (value: string | null, status: "confirmed" | "review" | "missing" = "missing") => ({ value, status });
const failed = (over: Partial<PkgPerson> = {}): PkgPerson => ({ key: "pk-failed", hkid: lf(null), nameZh: lf(null), nameEn: lf(null), dateOfBirth: lf(null), phone: lf(null), address: lf(null), staffNumbers: [], rating: "fail", ...over }) as PkgPerson;

describe("isFailedPerson／matchOfPerson", () => {
  it("rating fail 或六欄全無＋冇工號＝失敗人；有值／有工號且非 fail＝唔係", () => {
    expect(isFailedPerson(failed())).toBe(true);
    expect(isFailedPerson(failed({ rating: "review" }))).toBe(true); // 全欄 missing 冇工號
    expect(isFailedPerson(failed({ rating: "review", staffNumbers: [{ number: "U1" }] }))).toBe(false);
    expect(isFailedPerson(failed({ rating: "fail", hkid: lf("A1234563", "review") }))).toBe(true);
    expect(isFailedPerson(failed({ rating: "review", phone: lf("91234567", "review") }))).toBe(false);
    expect(matchOfPerson(failed())).toEqual({ hkid: null, staff_numbers: [], package_key: "pk-failed" });
    expect(matchOfPerson(failed({ staffNumbers: [{ number: "U1" }] }))).toEqual({ hkid: null, staff_numbers: ["U1"] });
  });
  it("參數 --full-pages-for-failed 預設關", () => {
    expect(parseArgs(["--dry"]).fullPagesForFailed).toBe(false);
    expect(parseArgs(["--full-pages-for-failed"]).fullPagesForFailed).toBe(true);
  });
});

describe.skipIf(!hasMagick)("整頁原稿 JPEG／zip", () => {
  it("pageJpeg：大圖（雜訊）→ 長邊 ≤1600、≤400 KB、冇 EXIF；過伺服器 inspectImage(page)；一般裁圖規格（120 KB／800）唔過", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "te7-"));
    try {
      const png = path.join(dir, "p.png");
      await sh(MAGICK, ["-size", "2480x3508", "plasma:fractal", "-blur", "0x2", png]);
      const bytes = await pageJpeg(png, dir);
      expect(bytes).not.toBeNull();
      const info = inspectImage(bytes!, { page: true })!;
      expect(info.mime).toBe("image/jpeg");
      expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(1600);
      expect(bytes!.byteLength).toBeLessThanOrEqual(400 * 1024);
      expect(inspectImage(bytes!)).toBeNull(); // 裁圖規格（≤120 KB／≤800）唔收
      expect(imageOk(bytes!, true)).toBe(true);
      expect(imageOk(bytes!, false)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produceItems --full-pages：失敗人每頁出 full_page（≤8 頁）；非失敗人唔出；manifest 帶 page_no／people.doc_ref，伺服器 readEvidenceZip 收", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "te7-"));
    try {
      const mk = async (n: number) => {
        const f = path.join(dir, `src-${n}-${Math.random().toString(36).slice(2)}.png`);
        await sh(MAGICK, ["-size", "800x1100", "xc:white", "-fill", "gray", "-draw", `rectangle ${20 + n},20 700,${100 + n}`, f]);
        return f;
      };
      const deps: Deps = { lines: async () => null, existing: () => null, render: async () => mk(Math.floor(Math.random() * 1000)), cleanup: async (f) => void (await rm(f, { force: true })) };
      const allPages = Array.from({ length: 10 }, (_, i) => ({ docId: "d1", page: i + 1 }));
      const docRef = { file_name: "失敗檔案.pdf", page_count: 10, pages_by_kind: { other: 10 } };
      const people: PersonInput[] = [
        { person: failed(), docs: [], allPages, docRef },
        { person: failed({ key: "ok-person", rating: "auto_ok", staffNumbers: [{ number: "U9" }], phone: lf("91234567", "review") }), docs: [], allPages, docRef },
      ];
      const stats = emptyStats();
      const items = await produceItems(people, deps, stats, { fullPages: true });
      const pages = items.filter((i) => i.field === "page");
      expect(pages).toHaveLength(8); // 每人 ≤8，淨失敗人
      expect(pages.every((p) => p.docKind === "full_page" && p.priority === 1 && p.match.package_key === "pk-failed")).toBe(true);
      expect(pages.map((p) => p.pageNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(stats.full_pages_out).toBe(8);
      expect((await produceItems(people, deps, emptyStats(), { fullPages: false })).filter((i) => i.field === "page")).toHaveLength(0);
      const built = await buildEvidenceZips(items, { docRefs: [{ match: matchOfPerson(failed()), doc_ref: docRef }] });
      expect(built.zips).toHaveLength(1);
      const { manifest } = await readEvidenceZip(built.zips[0]!);
      expect(manifest.items.every((i) => i.field === "page" && i.doc_kind === "full_page" && typeof i.page_no === "number")).toBe(true);
      expect(manifest.people?.[0]?.doc_ref).toEqual(docRef);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("TE-7.2：doc_ref 隨該人嘅圖放入「每個」有佢圖嘅 zip（唔再淨係第一個）；冇圖嘅人放第一個；matchOfPerson 帶 prod_person_key", async () => {
    const ref = (k: string) => ({ match: { hkid: null, staff_numbers: [], package_key: k }, doc_ref: { file_name: `${k}.pdf`, page_count: 1, pages_by_kind: {} } });
    const jpeg = (n: number) => new Uint8Array(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, n, 2, 3, 0xff, 0xd9]));
    const it = (k: string, n: number) => ({ bytes: jpeg(n), field: "page" as const, docKind: "full_page" as const, priority: 1 as const, pageNo: 1, match: { hkid: null, staff_numbers: [], package_key: k } });
    // maxEntries 1：A 圖喺 zip0、B 圖喺 zip1；C 冇圖
    const built = await buildEvidenceZips([it("A", 1), it("B", 2)], { maxEntries: 1, docRefs: [ref("A"), ref("B"), ref("C")] });
    expect(built.zips).toHaveLength(2);
    const names = async (z: Uint8Array) => ((await readEvidenceZip(z)).manifest.people ?? []).map((p) => p.match.package_key).sort();
    expect(await names(built.zips[0]!)).toEqual(["A", "C"]);
    expect(await names(built.zips[1]!)).toEqual(["B"]);
    expect(matchOfPerson(failed(), "abc123abc123abc123abc123")).toEqual({ hkid: null, staff_numbers: [], package_key: "pk-failed", prod_person_key: "abc123abc123abc123abc123" });
    expect(matchOfPerson(failed({ staffNumbers: [{ number: "U1" }] }), "abc")).toEqual({ hkid: null, staff_numbers: ["U1"] }); // 有工號唔用 prod key
    expect(parseArgs(["--person-key-map", "m.json"]).personKeyMap).toBe("m.json");
  });

  it("冇圖都帶 doc_ref（人冇裁圖亦要俾老闆搵到檔案）", async () => {
    const built = await buildEvidenceZips([], { docRefs: [{ match: { hkid: null, staff_numbers: [], package_key: "k" }, doc_ref: { file_name: "x.pdf", page_count: 1, pages_by_kind: {} } }] });
    expect(built.zips).toHaveLength(1);
    expect((await readEvidenceZip(built.zips[0]!)).manifest.people).toHaveLength(1);
  });
});
