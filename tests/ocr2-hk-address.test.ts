// WP-OCR-2：香港地址正規化（形近字／parts／ALS 外送字串唔含樓層室號）、ALS fake client、reconcile 地址分支。
// 全部合成地址（虛構門牌＋真實公開街道／屋邨名）；fake ALS，唔打網絡。
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { normalizeHkAddress, alsQueryFromParts, hasFloorUnitText, composeAddressZh, zhNumeralToInt } from "@/lib/guards/ocr/hk-address";
import { fetchAls, lookupAlsCandidate, parseAlsResponse, setAlsOverride, type AlsHit, type AlsLookup } from "@/lib/guards/ocr/als-client";
import { reconcile } from "@/lib/guards/ocr/reconcile";
import { normalizeField } from "@/lib/guards/ocr/normalize";
import { readDocument } from "@/lib/guards/ocr/read";
import { getReadClients, type ReadClients } from "@/lib/guards/ocr/clients";
import { setVisionClientForTests, type VisionClient, type VisionRequest, type VisionResponse } from "@/lib/guards/ocr/vision-client";
import { cmpAddress } from "../scripts/staff-import/lib/compare";

const canon = (s: string) => normalizeHkAddress(s).canon;

describe("形近／同音／簡繁字：歸一後 canon 一致（≥30 條合成）", () => {
  const PAIRS: [string, string][] = [
    ["石籬村 測試樓 12樓A室", "石籬邨 測試樓 12樓A室"],
    ["九龍深水步青山道999號", "九龍深水埗青山道999號"],
    ["新界東湧東涌路999號", "新界東涌東涌路999號"],
    ["香港鰂魚湧英皇道999號", "香港鰂魚涌英皇道999號"],
    ["香港則魚涌英皇道999號", "香港鰂魚涌英皇道999號"],
    ["新界大浦廣福道999號", "新界大埔廣福道999號"],
    ["香港灣仔告士打道999號", "香港灣仔告士打道999號"],
    ["香港湾仔告士打道999號", "香港灣仔告士打道999號"],
    ["九龍茘景邨測試樓", "九龍荔景邨測試樓"],
    ["葵涌邨測試樓", "葵涌邨測試樓"],
    ["癸涌邨測試樓", "葵涌邨測試樓"],
    ["新界粉岭和合石路999號", "新界粉嶺和合石路999號"],
    ["新界砂田正街999號", "新界沙田正街999號"],
    ["新界將軍奧寶琳路999號", "新界將軍澳寶琳路999號"],
    ["新界水边圍邨測試樓", "新界水邊圍邨測試樓"],
    ["新界屯門測試花园999號", "新界屯門測試花園999號"],
    ["測試大楼 15楼A室", "測試大樓 15樓A室"],
    ["九龍測試大厦 15樓A室", "九龍測試大廈 15樓A室"],
    ["新界長兴街999號", "新界長興街999號"],
    ["香港華富村999座", "香港華富邨999座"],
    ["香港华富邨 5座", "香港華富邨 5座"],
    ["新界豐盛街999號", "新界丰盛街999號"],
    ["新界宝琳邨 10座", "新界寶琳邨 10座"],
    ["九龍丽瑤邨 3座", "九龍麗瑤邨 3座"],
    ["九龍榮昌村 8座", "九龍荣昌邨 8座"],
    ["九龙測試街999号", "九龍測試街999號"],
    ["測試街 999 號 15樓 A 室", "測試街999號15樓A室"],
    ["測試街999号1203室", "測試街999號1203室"],
    ["Flat A, 15/F, Block 2, 測試邨", "2座 15F A室 測試邨"],
    ["Room 1203, 12/F, 測試大廈", "測試大廈 12樓 1203室".split(" ").reverse().reverse().join("")],
    ["測試邨 第二座 十二樓 三室", "測試邨 第2座 12樓 3室"],
    ["測試邨 二座 壹拾貳樓", "測試邨 2座 12樓"],
  ];
  for (const [a, b] of PAIRS) {
    it(`${a} ≡ ${b}`, () => {
      // 單位詞排序唔同嘅（Flat A 前置 vs 後置）只比對 token 集合：呢兩條改用排序後字元比較
      if (/Flat|Room/.test(a)) {
        const sortChars = (s: string) => [...s.replace(/\s/g, "")].sort().join("");
        expect(sortChars(canon(a))).toBe(sortChars(canon(b)));
      } else expect(canon(a)).toBe(canon(b));
    });
  }
  it("數量 ≥30", () => expect(PAIRS.length).toBeGreaterThanOrEqual(30));
  it("易混字 旺咀／旺角 只做候選（canon 唔同、edits 標 candidate_only）", () => {
    const r = normalizeHkAddress("九龍旺咀彌敦道999號");
    expect(r.canon).not.toBe(canon("九龍旺角彌敦道999號"));
    expect(r.edits).toEqual([{ from: "旺咀", to: "旺角", reason: "candidate_only", index: 2 }]);
    expect(r.suggested).toBe("九龍旺角彌敦道999號");
  });
  it("命中表先建議（edits 帶 from／to／reason／index）；唔命中唔改", () => {
    const r = normalizeHkAddress("九龍深水步石硤尾村 5座");
    expect(r.edits.map((e) => [e.from, e.to, e.reason])).toEqual([["深水步", "深水埗", "variant_char"], ["石硤尾村", "石硤尾邨", "variant_char"]]);
    expect(r.suggested).toBe("九龍深水埗石硤尾邨 5座");
    expect(r.display).toBe("九龍深水步石硤尾村 5座");
    const none = normalizeHkAddress("新界某某村 5座"); // 唔喺表入面（村落）
    expect(none.edits).toEqual([]);
    expect(none.suggested).toBe(none.display);
  });
  it("屋邨名本身就寫村（健康村、漁光村）唔當錯", () => {
    expect(normalizeHkAddress("香港健康村 3座").edits).toEqual([]);
  });
  it("中文數字轉換", () => {
    expect([zhNumeralToInt("十二"), zhNumeralToInt("二十三"), zhNumeralToInt("一二〇三"), zhNumeralToInt("壹拾貳"), zhNumeralToInt("一百")]).toEqual([12, 23, 1203, 12, 100]);
  });
});

describe("normalizeHkAddress parts 抽取（≥20 條）", () => {
  const CASES: [string, Record<string, string>][] = [
    ["九龍深水埗青山道999號15樓A室", { district: "九龍深水埗", street: "青山道", number: "999號", floor: "15樓", unit: "A室" }],
    ["新界大埔廣福道999號3樓B室", { district: "新界大埔", street: "廣福道", number: "999號", floor: "3樓", unit: "B室" }],
    ["香港仔鴨脷洲邨 利美樓 1203室", { district: "香港仔", estate: "鴨脷洲邨", unit: "1203室" }],
    ["石籬邨 5座 12樓3室", { estate: "石籬邨", block: "5座", floor: "12樓", unit: "3室" }],
    ["測試街 999 號 地下 5 舖", { street: "測試街", number: "999號", floor: "地下", unit: "5舖" }],
    ["九龍彌敦道999號 新世界中心 五樓 3室", { district: "九龍", street: "彌敦道", number: "999號", floor: "5樓", unit: "3室" }],
    ["深水埗區 青山道 999號 二十三樓", { district: "深水埗區", street: "青山道", number: "999號", floor: "23樓" }],
    ["將軍澳寶琳邨 寶盈樓 12樓1室", { district: "將軍澳", estate: "寶琳邨", building: "寶盈樓", floor: "12樓", unit: "1室" }],
    ["Flat A, 15/F, Block 2, Wah Fu Estate, 1 Nathan Road", { unit: "A室", floor: "15樓", block: "2座", estate: "WAH FU ESTATE", street: "NATHAN ROAD", number: "1" }],
    ["Room 1203, 12/F, Sample Court, 5 Demo Street", { unit: "1203室", floor: "12樓", street: "DEMO STREET", number: "5" }],
    ["15F Flat B Block 3 Tsz Wan Shan", { floor: "15樓", unit: "B室", block: "3座" }],
    ["測試街15-17號 8字樓 C室", { street: "測試街", number: "15-17號", floor: "8字樓", unit: "C室" }],
    ["元朗青山公路999號 高層 5B室", { street: "青山公路", number: "999號", floor: "高層", unit: "5B室" }],
    ["荃灣大河道 99 號 荃灣中心 二期 1203室", { street: "大河道", number: "99號", unit: "1203室", phase: "2期" }],
    ["美孚新邨 第三期 百老匯街 8座 9樓A室", { estate: "美孚新邨", street: "百老匯街", phase: "3期", block: "8座", floor: "9樓", unit: "A室" }],
    ["沙田第一城 10座 25樓 G室", { estate: "沙田第一城", block: "10座", floor: "25樓", unit: "G室" }],
    ["屯門測試苑 A座 G/F 3室", { district: "屯門", estate: "測試苑", block: "A座", floor: "地下", unit: "3室" }],
    ["九龍城區 馬頭圍道 999號 低層 10室", { district: "九龍城區", street: "馬頭圍道", number: "999號", floor: "低層", unit: "10室" }],
    ["香港灣仔告士打道 999 號 12/F", { district: "香港灣仔", street: "告士打道", number: "999號", floor: "12樓" }],
    ["新界元朗天水圍 天耀邨 耀楓樓 1203室", { district: "新界元朗天水圍", estate: "天耀邨", building: "耀楓樓", unit: "1203室" }],
    ["柴灣道 365 號 柴灣邨 4座 1 樓 2 室", { street: "柴灣道", number: "365號", estate: "柴灣邨", block: "4座", floor: "1樓", unit: "2室" }],
    ["測試街 12 號 10 號舖", { street: "測試街", number: "12號", unit: "10號舖" }],
    ["Shop 5, G/F, Demo Centre, 9 Test Road", { unit: "5舖", floor: "地下", street: "TEST ROAD", number: "9" }],
    ["九龍測試道 999 號 一 樓 A 室", { street: "測試道", number: "999號", floor: "1樓", unit: "A室" }],
  ];
  for (const [input, want] of CASES) {
    it(input, () => {
      const { parts } = normalizeHkAddress(input);
      for (const [k, v] of Object.entries(want)) expect(parts[k as keyof typeof parts], `${k}`).toBe(v);
    });
  }
  it("數量 ≥20", () => expect(CASES.length).toBeGreaterThanOrEqual(20));
});

describe("ALS 查詢字串（q）：樓層室號絕不外送（≥10 種寫法）", () => {
  const WRITINGS = [
    "九龍深水埗青山道999號15樓A室",
    "九龍深水埗青山道999號 15/F Flat A",
    "九龍深水埗青山道999號 Flat A, 15/F",
    "九龍深水埗青山道999號 Room 1203",
    "九龍深水埗青山道999號 Rm 1203, 12/F",
    "九龍深水埗青山道999號 12F",
    "九龍深水埗青山道999號 G/F",
    "九龍深水埗青山道999號 地下",
    "九龍深水埗青山道999號 二十三樓 五室",
    "九龍深水埗青山道999號 高層 B單位",
    "九龍深水埗青山道999號 5舖",
    "九龍深水埗青山道999號 Shop 5, G/F",
    "九龍深水埗青山道999號 8字樓 C室",
    "九龍深水埗青山道999號 第5層",
    "石籬邨 5座 12樓3室",
    "Flat 3, 12/F, Block 5, Shek Lei Estate, 999 Demo Road",
    "九龍深水埗青山道999號 UNIT 12",
    "九龍深水埗青山道999號 Floor 12",
    "九龍深水埗青山道999號 FLAT B 3/F",
    "九龍深水埗青山道999號 1 樓 1 室",
  ];
  for (const w of WRITINGS) {
    it(w, () => {
      const q = alsQueryFromParts(normalizeHkAddress(w).parts);
      expect(q).not.toBeNull();
      expect(hasFloorUnitText(q!)).toBe(false);
      for (const bad of [/樓/, /室/, /Flat/i, /Room/i, /\bRm\b/i, /\/F/i, /\b\d+F\b/i, /舖/, /單位/, /層/, /Shop/i, /Unit/i, /Floor/i, /地下/]) expect(q!, String(bad)).not.toMatch(bad);
    });
  }
  it("數量 ≥10", () => expect(WRITINGS.length).toBeGreaterThanOrEqual(10));
  it("q 保留 district／street／number／estate／block", () => {
    expect(alsQueryFromParts(normalizeHkAddress("九龍深水埗青山道999號15樓A室").parts)).toBe("九龍深水埗 青山道 999號");
    expect(alsQueryFromParts(normalizeHkAddress("石籬邨 5座 12樓3室").parts)).toBe("石籬邨 5座");
  });
  it("大廈名含「樓」（xx樓）→ 該部件唔送；資訊太少 → null（唔查詢）", () => {
    expect(alsQueryFromParts({ district: "香港仔", building: "利美樓" })).toBeNull();
    expect(alsQueryFromParts({ district: "九龍" })).toBeNull();
    expect(alsQueryFromParts({ street: "測試街", floor: "15樓", unit: "A室" })).toBe("測試街");
  });
  it("斷言：任何 q 都唔過 hasFloorUnitText", () => {
    expect(hasFloorUnitText("測試街 999號 15樓")).toBe(true);
    expect(hasFloorUnitText("Flat A")).toBe(true);
    expect(hasFloorUnitText("測試街 999號")).toBe(false);
  });
  it("fetchAls：q 含樓層室號 → 直接拋（唔發網絡）", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    await expect(fetchAls("測試街 15樓")).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });
});

const hit = (over: Partial<AlsHit> = {}): AlsHit => ({ score: 90, district: "深水埗區", street: "青山道", number: "999號", ...over });

describe("N2／N6：廿卅、Flat-3、12樓A、12A、12/F 1203；N5 英文 q 門牌喺街名前；N3 仲裁選中 ALS 唔加權", () => {
  it("廿／卅 數字", () => {
    expect([zhNumeralToInt("廿"), zhNumeralToInt("廿三"), zhNumeralToInt("卅"), zhNumeralToInt("卅五")]).toEqual([20, 23, 30, 35]);
    expect(normalizeHkAddress("測試街999號 廿三樓 A室").parts.floor).toBe("23樓");
    expect(canon("測試街999號廿三樓")).toBe(canon("測試街999號23樓"));
  });
  const CASES: [string, { floor?: string; unit?: string }][] = [
    ["測試街999號 Flat-3, 5/F", { floor: "5樓", unit: "3室" }],
    ["測試街999號 FLAT-A 15/F", { floor: "15樓", unit: "A室" }],
    ["測試街999號 12樓A", { floor: "12樓", unit: "A室" }],
    ["測試街999號 12樓 B", { floor: "12樓", unit: "B室" }],
    ["測試街999號 12/F 1203", { floor: "12樓", unit: "1203室" }],
    ["測試街999號 12/F, 1203A", { floor: "12樓", unit: "1203A室" }],
    ["測試街999號 12A", { unit: "12A" }],
    ["測試街999號 卅樓 C室", { floor: "30樓", unit: "C室" }],
  ];
  for (const [input, want] of CASES) {
    it(input, () => {
      const { parts } = normalizeHkAddress(input);
      for (const [k, v] of Object.entries(want)) expect(parts[k as "floor" | "unit"]).toBe(v);
      const q = alsQueryFromParts(parts);
      expect(q).toBe("測試街 999號");
      expect(hasFloorUnitText(q!)).toBe(false);
      // 本地拼返：floor／unit 照樣保留
      expect(composeAddressZh({ street: "測試街", number: "999號" }, parts)).toContain(parts.unit ?? parts.floor!);
    });
  }
  it("英文門牌係街名一部分（12A Nathan Road）唔當單位", () => {
    const { parts } = normalizeHkAddress("12A Nathan Road, Flat 3");
    expect(parts.unit).toBe("3室");
    expect(parts.number).toBe("12A");
  });
  it("N5：英文 q 門牌喺街名前；中文維持街名＋號", () => {
    expect(alsQueryFromParts(normalizeHkAddress("Flat A, 15/F, 999 Test Road").parts)).toBe("999 TEST ROAD");
    expect(alsQueryFromParts(normalizeHkAddress("九龍青山道999號15樓").parts)).toBe("九龍 青山道 999號");
  });
  it("N3：仲裁選中 ALS 值 → 唔加 ARBITER_BONUS、分數封頂（唔搶預填）", () => {
    const ALS = "深水埗區青山道999號15樓A室";
    const r = reconcile("address", "九龍青山道999號15樓A室", "九龍青山道999號16樓A室", new Date(), ALS, [{ value: ALS, source: "als", als_score: 90 }]);
    expect(r.status).toBe("review");
    expect(r.value).toBe("九龍青山道999號15樓A室");
    const c = r.candidates_ranked.find((x) => x.value === ALS)!;
    expect(c.score).toBeLessThanOrEqual(r.candidates_ranked[0]!.score);
    expect(r.candidates_ranked[0]!.sources).not.toContain("arbiter");
  });
});

describe("ALS fake client（lookupAlsCandidate）", () => {
  const ADDR = "九龍深水埗青山道999號15樓A室";
  it("成功：本地拼返 floor／unit；只送冇樓層室號嘅 q；每次 1 次查詢", async () => {
    const seen: string[] = [];
    const lookup: AlsLookup = async (q) => (seen.push(q), [hit({ score: 70, number: "1號" }), hit()]);
    const r = await lookupAlsCandidate(ADDR, lookup);
    expect(r).toEqual({ status: "candidate", value: "深水埗區青山道999號15樓A室", score: 90, called: true });
    expect(seen).toEqual(["九龍深水埗 青山道 999號"]);
  });
  it("Score < 60 → 唔出候選", async () => {
    const r = await lookupAlsCandidate(ADDR, async () => [hit({ score: 59 })]);
    expect(r).toEqual({ status: "none", called: true });
  });
  it("冇結果 → none", async () => expect(await lookupAlsCandidate(ADDR, async () => [])).toEqual({ status: "none", called: true }));
  it("429／500／網絡錯誤 → failed（靜靜略過，唔拋）", async () => {
    for (const msg of ["als_status_429", "als_status_500", "fetch failed"]) expect(await lookupAlsCandidate(ADDR, async () => { throw new Error(msg); })).toEqual({ status: "failed", called: true });
  });
  it("timeout（3 秒）→ failed", async () => {
    vi.useFakeTimers();
    try {
      const p = lookupAlsCandidate(ADDR, () => new Promise<AlsHit[]>(() => undefined));
      await vi.advanceTimersByTimeAsync(3_100);
      expect(await p).toEqual({ status: "failed", called: true });
    } finally {
      vi.useRealTimers();
    }
  });
  it("資訊太少（冇街道／屋邨／大廈）→ 唔查詢（called=false）", async () => {
    const lookup = vi.fn(async () => [hit()]);
    expect(await lookupAlsCandidate("九龍 15樓A室", lookup)).toEqual({ status: "none", called: false });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("parseAlsResponse：解析 SuggestedAddress（ChiPremisesAddress＋Score）", () => {
    const json = {
      AddressLookupResult: {
        SuggestedAddress: [
          { Address: { PremisesAddress: { ChiPremisesAddress: { Region: "九龍", ChiDistrict: { DcDistrict: "深水埗區" }, ChiStreet: { StreetName: "青山道", BuildingNoFrom: "999" }, ChiEstate: { EstateName: "測試邨" }, ChiBlock: { BlockDescriptor: "座", BlockNo: "5" }, BuildingName: "測試閣" } } }, ValidationInformation: { Score: 88.5 } },
          { Address: { PremisesAddress: { EngPremisesAddress: {} } }, ValidationInformation: { Score: 99 } },
          { Address: { PremisesAddress: { ChiPremisesAddress: { ChiStreet: { StreetName: "X街", BuildingNoFrom: "1", BuildingNoTo: "3" } } } }, ValidationInformation: { Score: "70" } },
        ],
      },
    };
    expect(parseAlsResponse(json)).toEqual([
      { score: 88.5, district: "深水埗區", street: "青山道", number: "999號", estate: "測試邨", block: "5座", building: "測試閣" },
      { score: 70, street: "X街", number: "1-3號" },
    ]);
    expect(parseAlsResponse(null)).toEqual([]);
    expect(composeAddressZh({ district: "深水埗區", street: "青山道", number: "999號", estate: "測試邨", block: "5座" }, { floor: "15樓", unit: "A室" })).toBe("深水埗區青山道999號測試邨5座15樓A室");
  });
});

describe("reconcile 地址分支（形近字／ALS）", () => {
  it("S1：兩讀 strict 相同、冇 edits → confirmed（空白標點差異唔影響）", () => {
    expect(reconcile("address", "新界火炭示範街99號虛構大廈15樓A室", "新界火炭示範街99號 虛構大廈 15樓A室").status).toBe("confirmed");
  });
  it("S1：只差形近／簡繁字（canon 相同、strict 唔同）→ review，兩個寫法都係候選，標準寫法排前（大厦／大廈、沙／砂、村／邨）", () => {
    const r1 = reconcile("address", "新界火炭示範街99號虛構大厦15樓A室", "新界火炭示範街99號虛構大廈15樓A室");
    expect(r1.status).toBe("review");
    expect(r1.reason).toBe("address_variant_chars");
    expect(r1.candidates).toEqual(["新界火炭示範街99號虛構大廈15樓A室", "新界火炭示範街99號虛構大厦15樓A室"]);
    expect(r1.value).toBe("新界火炭示範街99號虛構大廈15樓A室");
    const r2 = reconcile("address", "新界砂田示範街99號", "新界沙田示範街99號");
    expect(r2.status).toBe("review");
    expect(r2.candidates).toEqual(["新界沙田示範街99號", "新界砂田示範街99號"]);
    const r3 = reconcile("address", "九龍某某村 5座", "九龍某某邨 5座"); // 表外名稱：冇 edits 都唔 confirmed
    expect(r3.status).toBe("review");
    expect(r3.candidates).toHaveLength(2);
    expect(r3.value).toBe("九龍某某邨 5座");
  });
  it("S1：仲裁同某一讀只差形近字 → 唔算 agree（唔 confirmed）", () => {
    const r = reconcile("address", "九龍青山道999號15樓A室", "九龍青山道999號16樓A室", new Date(), "九龍青山道999号15樓A室");
    expect(r.status).toBe("review");
  });
  it("兩讀一模一樣但有形近字建議（村→邨）→ review，候選＝原文＋建議，預填原文", () => {
    const r = reconcile("address", "九龍柴灣村 5座 12樓3室", "九龍柴灣村 5座 12樓3室");
    expect(r.status).toBe("review");
    expect(r.reason).toBe("address_variant_suggested");
    expect(r.value).toBe("九龍柴灣村 5座 12樓3室");
    expect(r.candidates).toEqual(["九龍柴灣村 5座 12樓3室", "九龍柴灣邨 5座 12樓3室"]);
    expect(r.candidates_ranked.map((c) => c.sources)).toEqual([["a", "b"], ["hk_address"]]);
  });
  it("兩讀一邊寫村一邊寫邨（歸一後一致）：有建議 → review，兩個寫法都係候選", () => {
    const r = reconcile("address", "九龍柴灣村 5座", "九龍柴灣邨 5座");
    expect(r.status).toBe("review");
    expect(r.candidates).toEqual(["九龍柴灣邨 5座", "九龍柴灣村 5座"]); // 標準寫法（表命中）排前
  });
  it("ALS 候選：入池（source als＋Score），唔自動 confirmed、唔搶預填", () => {
    const r = reconcile("address", "九龍青山道999號15樓A室", "九龍青山道999號16樓A室", new Date(), undefined, [{ value: "深水埗區青山道999號15樓A室", source: "als", als_score: 90 }]);
    expect(r.status).toBe("review");
    expect(r.value).toBe("九龍青山道999號15樓A室");
    const als = r.candidates_ranked.find((c) => c.sources.includes("als"));
    expect(als).toMatchObject({ value: "深水埗區青山道999號15樓A室", als_score: 90 });
    expect(r.candidates_ranked[0]!.sources).not.toContain("als");
  });
  it("兩讀一致 confirmed：ALS 唔改變狀態", () => {
    const r = reconcile("address", "九龍青山道999號15樓A室", "九龍青山道999號15樓A室", new Date(), undefined, [{ value: "深水埗區青山道999號15樓A室", source: "als", als_score: 90 }]);
    expect(r.status).toBe("confirmed");
  });
  it("normalizeField address：display 保留原讀數，canon 歸一，suggested／edits 只喺命中時有", () => {
    const n = normalizeField("address", "九龍深水步青山道999號");
    expect(n.display).toBe("九龍深水步青山道999號");
    expect(n.suggested).toBe("九龍深水埗青山道999號");
    expect(normalizeField("address", "九龍青山道999號").edits).toBeUndefined();
  });
  it("舊 canon 行為保留：15/F, Block A ＝ 15/F Block A；Block 1, 23/F ≠ Block 12, 3/F", () => {
    expect(canon("15/F, Block A")).toBe(canon("15/F Block A"));
    expect(canon("Block 1, 23/F")).not.toBe(canon("Block 12, 3/F"));
  });
  it("路徑 B cmpAddress：形近字／單位詞歸一", () => {
    expect(cmpAddress("九龍柴灣村 5座 12樓3室", "九龍柴灣邨5座12樓3室")).toBe("match");
    expect(cmpAddress("九龍柴灣邨 5座 12樓3室", "九龍南昌街 8座 2樓1室")).toBe("mismatch");
  });
});

// ---------- readDocument 整合（fake vision＋fake ALS） ----------
const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
function vision(addr: string, calls?: VisionRequest[]): VisionClient {
  return {
    model: "fake",
    async complete(req: VisionRequest): Promise<VisionResponse> {
      calls?.push(req);
      return { text: JSON.stringify({ address: addr }), promptTokens: 1, completionTokens: 1 };
    },
  };
}
describe("readDocument × ALS（每份文件最多 1 次，唔含樓層室號）", () => {
  const OLD = process.env.GUARD_OCR_ALS;
  beforeEach(() => setAlsOverride(undefined));
  afterEach(() => {
    if (OLD === undefined) delete process.env.GUARD_OCR_ALS;
    else process.env.GUARD_OCR_ALS = OLD;
    setAlsOverride(undefined);
    setVisionClientForTests(null);
  });
  it("兩讀分歧 → ALS 查 1 次；候選含 als；仍 review；als 計數", async () => {
    const seen: string[] = [];
    const clients: ReadClients = { a: vision("九龍青山道999號15樓A室"), b: vision("九龍青山道999號16樓A室"), als: async (q) => (seen.push(q), [hit()]) };
    const r = await readDocument(clients, "address_proof", { full: IMG, tiles: [IMG] });
    expect(seen).toHaveLength(1);
    expect(hasFloorUnitText(seen[0]!)).toBe(false);
    const f = r.fields.address!;
    expect(f.status).toBe("review");
    expect(f.candidates_ranked.some((c) => c.sources.includes("als"))).toBe(true);
    expect(r.als).toEqual({ called: true, candidate: true, failed: false });
  });
  it("ALS 失敗（429）→ 照常 review，als.failed", async () => {
    const clients: ReadClients = { a: vision("九龍青山道999號15樓A室"), b: vision("九龍青山道999號16樓A室"), als: async () => { throw new Error("als_status_429"); } };
    const r = await readDocument(clients, "address_proof", { full: IMG, tiles: [IMG] });
    expect(r.fields.address!.status).toBe("review");
    expect(r.als).toEqual({ called: true, candidate: false, failed: true });
  });
  it("S2：兩讀 confirmed → 唔查 ALS（called=false）；missing 亦唔查", async () => {
    const lookup = vi.fn(async () => [hit()]);
    const ok = await readDocument({ a: vision("九龍青山道999號15樓A室"), b: vision("九龍青山道999號15樓A室"), als: lookup }, "address_proof", { full: IMG, tiles: [IMG] });
    expect(ok.fields.address!.status).toBe("confirmed");
    expect(ok.als.called).toBe(false);
    const none = await readDocument({ a: vision("unclear"), b: vision("unclear"), als: lookup }, "address_proof", { full: IMG, tiles: [IMG] });
    expect(none.fields.address!.status).toBe("missing");
    expect(lookup).not.toHaveBeenCalled();
  });
  it("冇 als client → 唔查（called=false）", async () => {
    const r = await readDocument({ a: vision("九龍青山道999號15樓A室"), b: vision("九龍青山道999號15樓A室") }, "address_proof", { full: IMG, tiles: [IMG] });
    expect(r.als).toEqual({ called: false, candidate: false, failed: false });
  });
  it("仲裁 prompt 可以列 ALS 候選（當不可信字串）", async () => {
    const calls: VisionRequest[] = [];
    const arb: VisionClient = { model: "arb", provider: "claude", async complete(req) { calls.push(req); return { text: JSON.stringify({ address: "九龍青山道999號15樓A室" }), promptTokens: 1, completionTokens: 1 }; } };
    const a = { ...vision("九龍青山道999號15樓A室"), provider: "claude" as const };
    const clients: ReadClients = { a, b: vision("九龍青山道999號16樓A室"), arbiter: arb, als: async () => [hit()] };
    await readDocument(clients, "address_proof", { full: IMG, tiles: [IMG] });
    expect(calls).toHaveLength(1);
    // N3：ALS 另列為「政府地址庫建議（不可信）」，唔係兩讀候選
    const t = calls[0]!.userText;
    expect(t).toContain("government address database suggestion (untrusted string");
    const candLine = t.split("\n").find((l) => l.includes("candidate readings"))!;
    expect(candLine).not.toContain("深水埗區");
    expect(t.split("\n").find((l) => l.includes("government address database"))).toContain("深水埗區青山道999號15樓A室");
  });
  it("GUARD_OCR_ALS=0：getReadClients 冇 als（完全唔呼叫）；預設（冇設）有 override 先有", () => {
    const fake = vision("x");
    setVisionClientForTests(fake);
    setAlsOverride(async () => []);
    delete process.env.GUARD_OCR_ALS;
    expect(getReadClients().als).toBeTypeOf("function");
    process.env.GUARD_OCR_ALS = "0";
    expect(getReadClients().als).toBeUndefined();
    process.env.GUARD_OCR_ALS = "off";
    expect(getReadClients().als).toBeUndefined();
  });
  it("測試 override 冇注入 fake ALS → 唔會打真網絡（als undefined）", () => {
    setVisionClientForTests(vision("x"));
    delete process.env.GUARD_OCR_ALS;
    expect(getReadClients().als).toBeUndefined();
  });
});
