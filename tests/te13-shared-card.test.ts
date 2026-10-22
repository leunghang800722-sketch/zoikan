// TE-13：「同一工號／電話出現喺多個人」題卡——evidence.shared_with、view 遮罩、題卡渲染、選項文案。全部合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React, { createElement } from "react";
import { clearAll } from "./lib/db";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { evaluateImportPackage } from "@/lib/guards/import/apply";
import { draftGuardImportQuestions } from "@/lib/triage/generators/guard-import";
import { questionViews, type ViewerCaps } from "@/lib/triage/view";
import { sharedHeadline, noCropText } from "@/lib/triage/shared-card";
import { SharedPersonsCard, StaffNoOnlyPerson } from "@/components/triage/SharedPersonsCard";
import { EvidenceSection } from "@/components/EvidenceImages";
import type { TriageQuestion } from "@prisma/client";

// vitest esbuild 用 classic JSX → 組件內 JSX 需要全域 React
(globalThis as { React?: unknown }).React = React;

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  const c = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
  return base + c;
}
const HK = mkHkid("Q", "700001");
const HK2 = mkHkid("R", "700002");
type St = "confirmed" | "review" | "missing";
const F = (v: string | null, s: St = "confirmed") => (v ? { value: v, status: s } : { value: null, status: "missing" as St });
function person(o: { key: string; hkid?: string | null; name?: string | null; tel?: string | null; nos: string[]; pages?: number; rating?: "auto_ok" | "review" | "fail" }): PackagePerson {
  return {
    key: o.key,
    hkid: F(o.hkid ?? null),
    nameZh: F(o.name ?? null),
    nameEn: F(null),
    dateOfBirth: F(null),
    sex: F(null),
    phone: F(o.tel ?? null),
    address: F(null),
    staffNumbers: o.nos.map((n) => ({ scheme: n.match(/^[A-Z]+/)![0], number: n })),
    rating: o.rating ?? "review",
    reasons: [],
    ...(o.pages !== undefined ? { docInfo: { pageCount: o.pages, pagesByKind: {} } } : {}),
  } as PackagePerson;
}
const pkgOf = (persons: PackagePerson[]) => ({ version: 2 as const, generatedAt: "2026-10-04T00:00:00.000Z", persons });

async function drafts(persons: PackagePerson[]) {
  const pkg = pkgOf(persons);
  const { evals } = await evaluateImportPackage(pkg as never);
  return draftGuardImportQuestions(pkg as never, evals);
}

describe("evidence.shared_with（generator）", () => {
  beforeEach(clearAll);
  it("共用工號：每個人嘅題列出其他共用者（狀態／文件頁數／工號），唔含 HKID／電話值", async () => {
    const a = person({ key: personKeyForHkid(HK), hkid: HK, name: "導入測試員甲", tel: "90000011", nos: ["U91001"], pages: 3 });
    const b = person({ key: "pkg-b", hkid: HK2, name: "導入測試員乙", tel: "90000012", nos: ["U91001", "MP91002"], pages: 2 });
    const ds = (await drafts([a, b])).filter((d) => d.kind === "staffno_shared_by_persons");
    expect(ds).toHaveLength(2);
    const da = ds.find((d) => d.evidence.person.nameZh.value === "導入測試員甲")!;
    expect(da.evidence.shared_with).toHaveLength(1);
    expect(da.evidence.shared_with![0]).toMatchObject({ name_zh: "導入測試員乙", hkid_status: "confirmed", has_docs: true, doc_count: 2, staff_numbers: ["U91001", "MP91002"], tel_status: "confirmed" });
    const txt = JSON.stringify(da.evidence.shared_with);
    expect(txt).not.toContain(HK2);
    expect(txt).not.toContain("90000012");
    // 選項文案
    expect(da.options.map((o) => o.label)).toEqual(expect.arrayContaining(["工號係呢個人嘅（其他人唔用）", "工號唔係呢個人嘅（由呢個人剔走）"]));
  });
  it("共用電話：shared_with 按電話反查；選項講電話", async () => {
    const a = person({ key: "pa", hkid: HK, name: "導入測試員甲", tel: "90000013", nos: ["U91011"], pages: 1 });
    const b = person({ key: "pb", hkid: HK2, name: "導入測試員乙", tel: "90000013", nos: ["U91012"], pages: 0 });
    const ds = (await drafts([a, b])).filter((d) => d.kind === "dup_tel_across_persons");
    expect(ds).toHaveLength(2);
    const d0 = ds[0]!;
    expect(d0.evidence.shared_with).toHaveLength(1);
    expect(JSON.stringify(d0.evidence.shared_with)).not.toContain("90000013");
    expect(d0.options.map((o) => o.label)).toEqual(expect.arrayContaining(["電話係呢個人嘅（其他人唔用）", "電話唔係呢個人嘅（由呢個人剔走）"]));
  });
});

describe("view：姓名按 pii 遮罩，question_id 反查", () => {
  const caps = (pii: boolean): ViewerCaps => ({ pii, piiUpdate: pii, guardUpdate: true, bankView: false, bankUpdate: false });
  const row = (over: Partial<TriageQuestion>): TriageQuestion => ({ id: "q1", sessionId: "s1", kind: "staffno_shared_by_persons", title: "t", sort: 1, status: "open", optionsJson: [], answerJson: null, impactJson: null, answeredBy: null, answeredAt: null, personKey: "k-self", ...over }) as never;
  const ev = {
    v: 1,
    person: person({ key: "k-self", nos: ["U91001"] }),
    reasons: [],
    candidate_guard_ids: [],
    shared_staff_numbers: ["U91001"],
    shared_with: [{ person_key: "k-other", name_zh: "導入測試員乙", name_en: "TEST B", hkid_status: "missing", has_docs: true, doc_count: 2, staff_numbers: ["U91001"], tel_status: "missing" }],
  };
  it("冇 pii：姓名 null＋name_hidden；有 pii：姓名照出；兩者都帶 shared_staff_numbers", async () => {
    const r = row({ evidenceJson: ev as never });
    const hidden = (await questionViews([r], caps(false)))[0]!;
    expect(hidden.evidence.shared_with[0]).toMatchObject({ name_zh: null, name_en: null, name_hidden: true, hkid_status: "missing", question_id: null });
    expect(JSON.stringify(hidden.evidence.shared_with)).not.toContain("導入測試員乙");
    const shown = (await questionViews([r], caps(true)))[0]!;
    expect(shown.evidence.shared_with[0]).toMatchObject({ name_zh: "導入測試員乙" });
    expect(shown.evidence.shared_staff_numbers).toEqual(["U91001"]);
  });
});

describe("題卡渲染", () => {
  const self = { name_zh: "導入測試員甲", name_en: null, hkid_status: "confirmed", doc_count: 3, staff_numbers: ["U91001"] };
  const other = { person_key: "k2", name_zh: null, name_en: null, hkid_status: "missing", has_docs: false, doc_count: 0, staff_numbers: ["U91001"], tel_status: "missing", question_id: "q2" };
  it("情況 1：共用卡——頭一句、本人標記、其他人狀態、去嗰條題連結（有 handler 先出）", () => {
    const html = renderToStaticMarkup(createElement(SharedPersonsCard, { kind: "staffno_shared_by_persons", sharedStaffNumbers: ["U91001"], self, others: [other], canGoto: () => true, onGoto: () => {} }));
    expect(html).toContain("工號 U91001 同時出現喺 2 個人身上，請揀邊個先係真正用呢個工號");
    expect(html).toContain("（呢條題嘅人）");
    expect(html).toContain("身份證：未讀到・冇文件");
    expect(html).toContain("去嗰條題");
    const noLink = renderToStaticMarkup(createElement(SharedPersonsCard, { kind: "dup_tel_across_persons", sharedStaffNumbers: [], self, others: [{ ...other, name_hidden: true }] }));
    expect(noLink).not.toContain("去嗰條題");
    expect(noLink).toContain("呢個電話同時出現喺 2 個人身上");
    expect(noLink).toContain("你冇權限睇姓名");
  });
  it("情況 2：空人後備——有工號都顯示「只讀到工號，冇任何文件」＋原因；冇工號顯示舊句", () => {
    const withNo = renderToStaticMarkup(createElement(StaffNoOnlyPerson, { staffNumbers: ["U91001"], reasons: ["冇身份證頁"] }));
    expect(withNo).toContain("導入包只讀到呢位嘅工號（嚟自打字名單／更表），冇任何文件");
    expect(withNo).toContain("原因：冇身份證頁");
    expect(withNo).not.toContain("—（未讀到）");
    const none = renderToStaticMarkup(createElement(StaffNoOnlyPerson, { staffNumbers: [], reasons: [] }));
    expect(none).toContain("導入包冇讀到呢位嘅任何資料");
  });
  it("情況 3：冇裁圖文案按 kind 分", () => {
    expect(noCropText("staffno_shared_by_persons")).toBe("呢類題目唔需要裁圖");
    expect(noCropText("dup_tel_across_persons")).toBe("呢類題目唔需要裁圖");
    expect(noCropText("name_not_confirmed")).toBe("冇裁圖（文件讀唔到）");
    expect(renderToStaticMarkup(createElement(EvidenceSection, { images: [], kind: "staffno_shared_by_persons" }))).toContain("呢類題目唔需要裁圖");
    expect(renderToStaticMarkup(createElement(EvidenceSection, { images: [], kind: "no_id_card" }))).toContain("冇裁圖（文件讀唔到）");
    expect(sharedHeadline("staffno_shared_by_persons", [], 1)).toBe("呢個工號 同時出現喺 2 個人身上，請揀邊個先係真正用呢個工號");
  });
});
