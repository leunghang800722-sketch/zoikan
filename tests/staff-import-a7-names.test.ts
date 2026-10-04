// WP-STAFF-IMPORT A7：姓名以身份證副本為準——兩個獨立讀數逐字相同先 confirmed。全部合成資料。
import { describe, expect, it } from "vitest";
import type { DocExtract } from "../scripts/staff-import/lib/aggregate";
import type { PhoneFinal } from "../scripts/staff-import/lib/phone";
import { exactEn, exactZh, resolvePerson, type NameVision, type PersonDocIn } from "../scripts/staff-import/lib/person-fields";

const ph = { value: null, status: "unresolved", candidates: [], reasons: [] } as unknown as PhoneFinal;
const exOf = (zh: string | null, en: string | null, id = "d1"): DocExtract =>
  ({
    docId: id, pageCount: 5, pages: [], hkid: { value: "A1234563", level: "high", conf: 0.9, page: 3, evidence: "x" }, hkidValid: true,
    nameZh: zh ? { value: zh, level: "medium", conf: 0.5, page: 3, evidence: "x" } : null,
    nameEn: en ? { value: en, level: "medium", conf: 0.5, page: 3, evidence: "x" } : null,
    dob: null, sex: null, address: null, addressRecipient: null, phone: null,
    aux: { formHkid: null, permitHkid: null, formAddress: null, formNameZh: null, formNameEn: null }, flags: [], rescuedRot: null,
  }) as unknown as DocExtract;
const V = (zh: string | null, en: string | null, legible: "clear" | "unsure" = "clear"): NameVision => ({ docId: "d1", zh, en, legible });
const run = (o: { local?: [string | null, string | null]; fileZh?: string | null; listZh?: string[]; v1: NameVision | null; v2?: NameVision | null }) => {
  const d: PersonDocIn = { docId: "d1", ex: exOf(o.local?.[0] ?? null, o.local?.[1] ?? null), fileNameZh: o.fileZh ?? null, phone: ph, listZh: o.listZh ?? [], listEn: [], listTels: [] };
  return resolvePerson({ key: "k", docs: [d], idDocId: "d1", addressDocId: null, nameVision: o.v1, nameVision2: o.v2, addrVision: null });
};

describe("姓名：兩個獨立讀數逐字相同", () => {
  it("第一＋第二讀 clear 且相同（無檔名／名單佐證）→ confirmed，source=id_card", () => {
    const r = run({ v1: V("測試安員", "CHAN, TAI MAN"), v2: V("測試安員", "chan tai  man") });
    expect(r.nameZh).toMatchObject({ status: "confirmed", value: "測試安員", source: "id_card" });
    expect(r.nameEn).toMatchObject({ status: "confirmed", value: "CHAN, TAI MAN", source: "id_card" });
  });
  it("差一字／繁簡異體唔正規化 → review，兩值都留", () => {
    const r = run({ v1: V("測試安員", "CHAN, TAI MAN"), v2: V("测试安员", "CHAN, TAI MEN") });
    expect(r.nameZh.status).toBe("review");
    expect(r.nameZh.candidates).toContain("测试安员");
    expect(r.nameZh.reasons).toContain("nameZh_reads_disagree");
    expect(r.nameEn.status).toBe("review");
    expect(r.nameEn.reasons).toContain("nameEn_reads_disagree");
  });
  it("第二讀 unsure／冇第二讀 → 維持現狀（無佐證 review）", () => {
    expect(run({ v1: V("測試安員", null), v2: V("測試安員", null, "unsure") }).nameZh.status).toBe("review");
    expect(run({ v1: V("測試安員", null), v2: null }).nameZh.reasons).toContain("nameZh_vision_uncorroborated");
  });
  it("現有規則成立（檔名一致）→ 照舊 confirmed，唔需要第二讀", () => {
    expect(run({ v1: V("測試安員", null), fileZh: "測試安員" }).nameZh.status).toBe("confirmed");
  });
  it("檔名／名單差一字：唔再阻 confirmed，資訊性 reason；兩讀數不一致仍 review", () => {
    const ok = run({ local: ["測試安員", null], fileZh: "測試安貝", v1: V("測試安員", null), v2: V("測試安員", null) });
    expect(ok.nameZh.status).toBe("confirmed");
    expect(ok.nameZh.reasons).toEqual(["name_differs_from_filename_or_list"]);
    const bad = run({ local: ["測試安員", null], fileZh: "測試安貝", v1: V("測試安員", null), v2: V("測試安貝", null) });
    expect(bad.nameZh.status).toBe("review");
  });
  it("同人多檔卡面姓名唔同 → 仍然 review", () => {
    const mk = (id: string, zh: string): PersonDocIn => ({ docId: id, ex: exOf(zh, null, id), fileNameZh: null, phone: ph, listZh: [], listEn: [], listTels: [] });
    const r = resolvePerson({ key: "k", docs: [mk("d1", "測試安員"), mk("d2", "測試安貝")], idDocId: "d1", addressDocId: null, nameVision: V("測試安員", null), nameVision2: V("測試安員", null), addrVision: null });
    expect(r.nameZh.status).toBe("review");
    expect(r.nameZh.reasons).toContain("nameZh_differs_between_files");
  });
  it("比對函數", () => {
    expect(exactZh(" 測試 安員 ")).toBe("測試安員");
    expect(exactZh("測試安員")).not.toBe(exactZh("测试安员"));
    expect(exactEn("Chan,  Tai Man")).toBe("CHAN TAI MAN");
  });
});
