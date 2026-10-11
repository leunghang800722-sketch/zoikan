// P13：合成「保安員證件資料導入」分診題（無 PII：全部係虛構名／號）。vitest 同 Playwright 共用。
// 比例仿正式站：重要題（name_not_confirmed）＋補充題（field_review）。
export interface SeedQuestion {
  kind: string;
  groupKey: string;
  sort: number;
  title: string;
  evidenceJson: object;
  optionsJson: object;
}

function person(i: number, key: string) {
  const f = (value: string | null, status = "review") => ({ value, status });
  return {
    key,
    hkid: f(`Z9${String(100000 + i).slice(-6)}(${i % 10})`),
    nameZh: f(`測試人${i}`),
    nameEn: f(`TEST PERSON ${i}`),
    dateOfBirth: f("1980-01-01"),
    sex: f("M"),
    phone: f(`6${String(1000000 + i).slice(-7)}`),
    address: { value: `測試地址${i}號 虛構大廈 第${i}座 九龍 香港（合成資料，非真實）`, status: "review", source: "address_proof" },
    staffNumbers: [{ scheme: "T", number: `T${String(i).padStart(5, "0")}` }],
    rating: "review",
    reasons: ["name_not_confirmed"],
    siaPermit: { no: { value: `S-${String(100000 + i).slice(-6)}-1`, status: "review" }, aExpiry: f("2030-01-01"), bExpiry: f("2030-06-01") },
    safetyCard: { no: f(`CARD${i}`), expiry: f("2029-01-01") },
    emergencyContacts: [{ name: f(`虛構聯絡人${i}`), relationship: f("朋友"), tel: f(`9${String(2000000 + i).slice(-7)}`) }],
  };
}

/** n 條題：頭 important 條係重要題，其餘係補充題；sort 按次序遞增。 */
export function seedGuardImportQuestions(total: number, important: number): SeedQuestion[] {
  const out: SeedQuestion[] = [];
  for (let i = 1; i <= total; i++) {
    const imp = i <= important;
    const key = `p13-${i}`;
    out.push({
      kind: imp ? "name_not_confirmed" : "field_review",
      groupKey: key,
      sort: i,
      title: `${imp ? "重要" : "補充"}測試題 ${i}`,
      evidenceJson: {
        v: 1,
        person: person(i, key),
        reasons: imp ? ["name_not_confirmed"] : [],
        candidate_guard_ids: [],
        ...(imp ? {} : { review_fields: [{ field: "nameEn", check: "fill" }, { field: "address", check: "fill" }], guard_id: null }),
      },
      optionsJson: imp
        ? [{ id: "use_package_name", label: "用導入包嘅姓名" }, { id: "enter_name", label: "輸入中文姓名", input: "text" }, { id: "skip", label: "跳過，留返人手" }]
        : [{ id: "apply_fields", label: "逐欄核對" }, { id: "skip", label: "跳過，留返人手" }],
    });
  }
  return out;
}
