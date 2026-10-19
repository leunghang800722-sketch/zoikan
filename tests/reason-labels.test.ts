// TE-7：reason code 人話 label 覆蓋——掃 generators／match／apply／extract／crosscheck／person-fields 等原始碼入面 push 落 reasons／flags 嘅字面 code，
// 每個都要有人話 label（唔再落「其他原因」兜底）；兜底只對真未知 code。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { REASON_LABEL, reasonLabel } from "@/lib/triage/reason-labels";

const roots = ["src/lib/guards/import", "src/lib/triage", "scripts/staff-import", "scripts/staff-import/lib"];
function files(): string[] {
  const out: string[] = [];
  for (const r of roots) for (const f of readdirSync(r)) if (/\.ts$/.test(f) && !/triage-reread|triage-evidence|card-reread|hkid\.ts|eval-ocr|embedded-card/.test(f)) out.push(path.join(r, f));
  return out;
}

describe("reason code label 覆蓋", () => {
  it("原始碼 push 落 reasons／flags／rs 嘅靜態 code 全部有人話 label", () => {
    const codes = new Set<string>();
    for (const f of files()) {
      const src = readFileSync(f, "utf-8");
      for (const m of src.matchAll(/\b(?:reasons|flags|rs|enReasons|dob\.reasons|sex\.reasons|nameEn\.reasons)\.push\(\s*['"]([A-Za-z0-9_]+)['"]/g)) codes.add(m[1]!);
      for (const m of src.matchAll(/return '(nameEn_missing_[a-z_]+)'/g)) codes.add(m[1]!);
    }
    expect(codes.size).toBeGreaterThan(60);
    const missing = [...codes].filter((c) => reasonLabel(c) === "其他原因");
    expect(missing).toEqual([]);
  });
  it("動態前綴 code 有 label；真未知 code 先兜底；label 全部係人話（唔含英文碼）", () => {
    for (const c of ["mismatch_nameZh", "mismatch_dob", "hkid_repaired", "hkid_conflict_form", "phone_unresolved_no_form", "ref_ambiguous_x"]) expect(reasonLabel(c)).not.toBe("其他原因");
    expect(reasonLabel("totally_unknown_code")).toBe("其他原因");
    for (const [k, v] of Object.entries(REASON_LABEL)) expect(v, k).not.toMatch(/^[a-zA-Z_]+$/);
  });
  it("老闆個案：extract_fail／nameEn_missing_no_id_page／address_recipient_not_matched 都有人話", () => {
    for (const c of ["extract_fail", "nameEn_missing_no_id_page", "address_recipient_not_matched"]) expect(reasonLabel(c)).not.toBe("其他原因");
  });
});
