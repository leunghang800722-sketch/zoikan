// TE-12：24-open-gap-audit（production 未答題差距自檢）——全部合成、無 PII、唔打 API。
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, main, parseArgs, dryData } from "../scripts/staff-import/24-open-gap-audit";
import { auditOpenGap, requiredFields, summarizeGap } from "../scripts/staff-import/lib/open-gap-audit";
import { ArgError } from "../scripts/staff-import/lib/eval-ocr-core";

describe("24-open-gap-audit", () => {
  it("--dry：9 題逐題分類（每個分類有代表）；原因碼唔含值", async () => {
    const r = await run({ openQuestions: null, package: null, proposals: null, out: null, dry: true });
    expect(r.summary.by_category).toEqual({ auto_answerable: 2, proposal_not_auto: 1, wrong_field: 1, no_proposal: 2, no_docs: 1, person_unmatched: 1, kind_unsupported: 1 });
    const by = (k: string) => r.rows.find((x) => x.person_key === `srv-${k}`)!;
    expect(by("P1")).toMatchObject({ category: "auto_answerable" });
    expect(by("P2")).toMatchObject({ category: "proposal_not_auto", reason: "nameZh:medium+form_conflict" });
    expect(by("P3")).toMatchObject({ category: "wrong_field", reason: "has:nameEn|need:hkid" });
    expect(by("P4")).toMatchObject({ category: "no_proposal", reason: "nameZh:not_confirmed" });
    expect(by("P5")).toMatchObject({ category: "no_proposal", reason: "address:wrong_source,phone:typed_list_disagrees" });
    expect(by("P6")).toMatchObject({ category: "no_docs" });
    expect(by("nope7")).toMatchObject({ category: "person_unmatched" });
    expect(by("P9")).toMatchObject({ category: "kind_unsupported", reason: "no_id_card" });
    expect(by("P10")).toMatchObject({ category: "auto_answerable" });
    expect(JSON.stringify(r.rows)).not.toMatch(/測試|Z90000|1990/);
    expect(r.summary.no_proposal_reasons).toEqual({ "nameZh:not_confirmed": 1, "address:wrong_source": 1, "phone:typed_list_disagrees": 1 });
  });
  it("review_fields 別名（name_en／dob）；冇診斷 → no_diag；空 review_fields → kind_unsupported", () => {
    expect(requiredFields({ person_key: "a", staff_numbers: [], kind: "field_review", review_fields: ["name_en", "dob", "bogus"] })).toEqual(["nameEn", "dateOfBirth"]);
    expect(requiredFields({ person_key: "a", staff_numbers: [], kind: "field_review", review_fields: [] })).toBeNull();
    const d = dryData();
    const rows = auditOpenGap([{ person_key: "x", staff_numbers: ["P4"], kind: "name_not_confirmed" }], d.persons, [], []);
    expect(rows[0]).toMatchObject({ category: "no_proposal", reason: "nameZh:no_diag" });
    expect(auditOpenGap([{ person_key: "x", staff_numbers: ["P4"], kind: "field_review", review_fields: [] }], d.persons, [], [])[0]).toMatchObject({ category: "kind_unsupported" });
    expect(summarizeGap([]).questions_total).toBe(0);
  });
  it("main：--dry 只印計數；真跑冇 --out 或缺參數 → ArgError；--out 寫檔（data/ 下）", async () => {
    expect(parseArgs(["--dry"]).dry).toBe(true);
    expect(() => parseArgs(["--bogus"])).toThrow(ArgError);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      expect(await main(["--dry"])).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).not.toMatch(/測試|Z90000/);
    await expect(main(["--package", "x"])).rejects.toThrow(ArgError);
    const tmp = await mkdtemp(path.join(os.tmpdir(), "te12-"));
    try {
      await expect(main(["--dry", "--out", path.join(tmp, "o.json")])).rejects.toThrow();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
