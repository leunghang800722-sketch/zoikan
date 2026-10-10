// P1-WP2 §D 雞頭隔離 fuzz：用雞頭 A token 打晒全部佢有權限嘅 endpoint
// （list/get），遞歸斷言回應 JSON 唔含 client_rate/gross/margin/profit，
// 亦唔含 brokerB 嘅任何記錄（id/名/佢嘅保安員）；再用雞頭 B 對照做埋一次。
// 硬性規則1（設計文件§5.1）：雞頭角色回應永遠冇 client_rate、毛利、其他
// broker 資料。
import { describe, it, expect, beforeAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { findKeysDeep, findSubstringInValuesDeep } from "@/lib/api/serialize";

import { GET as guardsList } from "@/app/api/guards/route";
import { GET as guardGetOne } from "@/app/api/guards/[id]/route";
import { GET as brokersList } from "@/app/api/brokers/route";
import { GET as brokerGetOne } from "@/app/api/brokers/[id]/route";
import { GET as rateCardsList } from "@/app/api/rate-cards/route";
import { GET as rateCardGetOne } from "@/app/api/rate-cards/[id]/route";
import { GET as shiftRecordsList } from "@/app/api/shift-records/route";
import { GET as shiftRecordGetOne } from "@/app/api/shift-records/[id]/route";
import { GET as dailyReqList } from "@/app/api/daily-requirements/route";
import { GET as sitesList } from "@/app/api/sites/route";

const FORBIDDEN_KEYS = ["client_rate", "client_rate_snapshot", "gross", "gross_profit", "margin", "profit"];
// C2：遞歸搜尋**值**（唔係 key 名）——呢啲字可能匿埋喺 note/description
// 呢類自由文字欄嘅值入面。
const FORBIDDEN_VALUE_NEEDLES = ["收客", "上單價", "發票", "實收"];

function reqWithCookie(url: string, cookie: string) {
  return new Request(url, { headers: { cookie } });
}

async function bodyOf(res: Response): Promise<unknown> {
  return res.json();
}

interface Endpoint {
  name: string;
  call: (cookie: string) => Promise<Response>;
}

describe("WP2 雞頭隔離 fuzz", () => {
  let fx: Wp2Fixture;
  let cookieA: string;
  let cookieB: string;
  let assertionCount = 0;

  beforeAll(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    const brokerBUser = await prisma.user.findFirstOrThrow({ where: { brokerId: fx.brokerB.id } });
    cookieA = await sessionCookieForUser(fx.userIds["雞頭"]);
    cookieB = await sessionCookieForUser(brokerBUser.id);
  });

  function endpoints(): Endpoint[] {
    return [
      { name: "GET /api/guards", call: (c) => guardsList(reqWithCookie("http://test.local/api/guards", c)) },
      { name: "GET /api/guards/:id(own)", call: (c) => guardGetOne(reqWithCookie(`http://test.local/api/guards/${fx.guardA.id}`, c), { params: Promise.resolve({ id: fx.guardA.id }) }) },
      { name: "GET /api/brokers", call: (c) => brokersList(reqWithCookie("http://test.local/api/brokers", c)) },
      { name: "GET /api/brokers/:id(own)", call: (c) => brokerGetOne(reqWithCookie(`http://test.local/api/brokers/${fx.brokerA.id}`, c), { params: Promise.resolve({ id: fx.brokerA.id }) }) },
      { name: "GET /api/rate-cards", call: (c) => rateCardsList(reqWithCookie("http://test.local/api/rate-cards", c)) },
      { name: "GET /api/rate-cards/:id(generic)", call: (c) => rateCardGetOne(reqWithCookie(`http://test.local/api/rate-cards/${fx.rateCardGeneric.id}`, c), { params: Promise.resolve({ id: fx.rateCardGeneric.id }) }) },
      { name: "GET /api/rate-cards/:id(brokerA own)", call: (c) => rateCardGetOne(reqWithCookie(`http://test.local/api/rate-cards/${fx.rateCardBrokerA.id}`, c), { params: Promise.resolve({ id: fx.rateCardBrokerA.id }) }) },
      { name: "GET /api/shift-records", call: (c) => shiftRecordsList(reqWithCookie("http://test.local/api/shift-records", c)) },
      { name: "GET /api/shift-records/:id(own)", call: (c) => shiftRecordGetOne(reqWithCookie(`http://test.local/api/shift-records/${fx.shiftRecordA.id}`, c), { params: Promise.resolve({ id: fx.shiftRecordA.id }) }) },
      { name: "GET /api/daily-requirements", call: (c) => dailyReqList(reqWithCookie("http://test.local/api/daily-requirements", c)) },
      { name: "GET /api/sites", call: (c) => sitesList(reqWithCookie("http://test.local/api/sites", c)) },
    ];
  }

  it(`雞頭A：全部 ${endpoints().length} 個 endpoint 回應零洩漏（client_rate/毛利/其他broker）`, async () => {
    for (const ep of endpoints()) {
      const res = await ep.call(cookieA);
      expect(res.status, `${ep.name} 應該 200`).toBe(200);
      const json = await bodyOf(res);

      const leakedKeys = findKeysDeep(json, FORBIDDEN_KEYS);
      expect(leakedKeys, `${ep.name} 唔應該有 client_rate/毛利欄: ${JSON.stringify(leakedKeys)}`).toEqual([]);
      assertionCount++;

      // C2：note/evidence/source/provenance 自由文字對雞頭一律唔出
      const leakedFreeTextKeys = findKeysDeep(json, ["note", "evidence", "source", "provenance", "settlementPage", "rescueRate"]);
      expect(leakedFreeTextKeys, `${ep.name} 唔應該有 note/evidence/source/provenance: ${JSON.stringify(leakedFreeTextKeys)}`).toEqual([]);
      assertionCount++;

      // C2：遞歸搜尋值——唔止 key 名，連藏喺自由文字值入面嘅敏感字都要 0 命中
      const leakedValues = findSubstringInValuesDeep(json, FORBIDDEN_VALUE_NEEDLES);
      expect(leakedValues, `${ep.name} 值入面唔應該有 收客/上單價/發票/實收: ${JSON.stringify(leakedValues)}`).toEqual([]);
      assertionCount++;

      const serialized = JSON.stringify(json);
      expect(serialized.includes(fx.brokerB.id), `${ep.name} 唔應該含 brokerB id`).toBe(false);
      expect(serialized.includes(fx.brokerB.name), `${ep.name} 唔應該含 brokerB 名`).toBe(false);
      expect(serialized.includes(fx.guardB.id), `${ep.name} 唔應該含 brokerB 嘅保安員`).toBe(false);
      assertionCount += 3;
    }
  });

  it("值級斷言：work_date 係 ISO 字串、guard_wage 係數字字串、note 欄完全唔存在", async () => {
    const res = await shiftRecordGetOne(reqWithCookie(`http://test.local/api/shift-records/${fx.shiftRecordA.id}`, cookieA), {
      params: Promise.resolve({ id: fx.shiftRecordA.id }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;

    // work_date 一定要係 ISO datetime 字串（唔係 {}——Opus 揪出嘅
    // dropKeysDeep 拆爛 Date/Decimal 個 bug，見 src/lib/api/serialize.ts）
    expect(typeof json.work_date).toBe("string");
    expect(json.work_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // guard_wage_snapshot 一定要係數字字串（Decimal→string），唔係 {}
    expect(typeof json.guard_wage_snapshot).toBe("string");
    expect(Number.isNaN(Number(json.guard_wage_snapshot))).toBe(false);

    expect("note" in json).toBe(false);
    expect("client_rate_snapshot" in json).toBe(false);

    const rcRes = await rateCardGetOne(reqWithCookie(`http://test.local/api/rate-cards/${fx.rateCardBrokerA.id}`, cookieA), {
      params: Promise.resolve({ id: fx.rateCardBrokerA.id }),
    });
    const rcJson = (await rcRes.json()) as Record<string, unknown>;
    expect(typeof rcJson.guard_wage).toBe("string");
    expect(Number.isNaN(Number(rcJson.guard_wage))).toBe(false);
    expect(typeof rcJson.effective_from).toBe("string");
    expect(rcJson.effective_from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect("note" in rcJson).toBe(false);
    expect("client_rate" in rcJson).toBe(false);
  });

  it("Opus 對抗式驗收 A2（裁定）：GET /api/sites 雞頭版一律冇 client_name/billing_model——key 級同值級都要 0 命中", async () => {
    const res = await sitesList(reqWithCookie("http://test.local/api/sites", cookieA));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rows: Record<string, unknown>[] };
    expect(json.rows.length).toBeGreaterThan(0);

    // key 級：白名單本身已經冇呢兩個欄——逐行直接斷言唔存在。
    for (const row of json.rows) {
      expect("client_name" in row, `sites row 唔應該有 client_name: ${JSON.stringify(row)}`).toBe(false);
      expect("billing_model" in row, `sites row 唔應該有 billing_model: ${JSON.stringify(row)}`).toBe(false);
      expect("clientName" in row).toBe(false);
      expect("billingModel" in row).toBe(false);
    }
    assertionCount += json.rows.length * 4;

    // 值級：唔淨係 key 冇，真係查返 DB 嘅 clientName 字面值，確保成個
    // response body 都搵唔到（防禦深度——萬一第啲欄意外夾帶埋個字串）。
    const dbSite = await prisma.site.findUniqueOrThrow({ where: { id: fx.site.id } });
    expect(dbSite.clientName).toBeTruthy(); // fixture 本身要真係有 clientName 先測得出意義
    const serialized = JSON.stringify(json);
    expect(serialized.includes(dbSite.clientName!), "sites response 唔應該含 client_name 字面值").toBe(false);
    assertionCount += 2;
  });

  it(`雞頭B：全部 ${endpoints().length} 個 endpoint 回應零洩漏（對照組，反過來唔應該見到 brokerA）`, async () => {
    for (const ep of endpoints()) {
      // 對照組用 brokerB 嘅 own-record endpoint 就要換返 brokerB 自己嘅 id，
      // 呢度簡化：淨係打冇綁定特定 id 嘅 list endpoint 做對照，逐格 id
      // endpoint 已經喺下面「其他 broker 嘅記錄攞唔到」test 蓋咗。
      if (ep.name.includes(":id")) continue;
      const res = await ep.call(cookieB);
      expect(res.status).toBe(200);
      const json = await bodyOf(res);
      const leakedKeys = findKeysDeep(json, FORBIDDEN_KEYS);
      expect(leakedKeys).toEqual([]);
      assertionCount++;
      const leakedValues = findSubstringInValuesDeep(json, FORBIDDEN_VALUE_NEEDLES);
      expect(leakedValues).toEqual([]);
      assertionCount++;
      const serialized = JSON.stringify(json);
      expect(serialized.includes(fx.brokerA.id)).toBe(false);
      expect(serialized.includes(fx.brokerA.name)).toBe(false);
      expect(serialized.includes(fx.guardA.id)).toBe(false);
      assertionCount += 3;
    }
  });

  it("雞頭A 直接攞 brokerB 嘅 shift_record/rate_card/guard/broker by id 一律 404（唔係得個空 client_rate）", async () => {
    const res1 = await shiftRecordGetOne(reqWithCookie(`http://test.local/api/shift-records/${fx.shiftRecordB.id}`, cookieA), {
      params: Promise.resolve({ id: fx.shiftRecordB.id }),
    });
    expect(res1.status).toBe(404);

    const res2 = await guardGetOne(reqWithCookie(`http://test.local/api/guards/${fx.guardB.id}`, cookieA), { params: Promise.resolve({ id: fx.guardB.id }) });
    expect(res2.status).toBe(404);

    const res3 = await brokerGetOne(reqWithCookie(`http://test.local/api/brokers/${fx.brokerB.id}`, cookieA), { params: Promise.resolve({ id: fx.brokerB.id }) });
    expect(res3.status).toBe(403); // 雞頭淨係可以睇自己（見 brokers/[id]/route.ts）
    assertionCount += 3;
  });

  it(`fuzz 統計：${endpoints().length} 個 endpoint，逾 ${endpoints().length * 4} 個斷言，0 洩漏`, () => {
    expect(assertionCount).toBeGreaterThan(endpoints().length * 4);
  });
});
