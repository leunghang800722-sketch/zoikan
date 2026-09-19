// WP-MULTI（老闆 2026-09-19 拍板「全部資料都要保留，唔好揀一個」）：
// 電話／緊急聯絡人／地址三張新子表——同 tests/wp-staffno.test.ts 一致
// 嘅 route-handler-level 測試手法（直接 import route function，用假
// Request + session cookie call，唔起真 HTTP server）。
//
// §1 電話：第一個自動 primary；第二個跟 is_primary；設 primary 自動降級
//    舊嗰個；DELETE primary 自動升下一個；UNIQUE(guard_id, tel) 撞號
//    409；格式唔啱 400；雞頭讀得（窄版 DTO）寫唔得（硬性 403）
// §2 地址：同電話一致嘅 primary 手法
// §3 緊急聯絡人：name／tel 唔可以同時空；sort_order 排序；代表行＝
//    sort_order 最細
// §4 legacy PATCH /api/guards/:id（tel／address／emergency_contact_*）
//    ——加一行並設做主要／新代表行，舊嗰個保留；值冇變唔起新行、唔 409
// §5 GET /api/guards?q= 搵到任何一個電話（唔止 primary）
// §6 離職／作廢保留：void guard 之後三張表＋員工編號全部原封不動
// §7 audit_log：create／update／delete 三種 action 都留底
// §8 audit_log 讀出嗰陣一樣要經 field-group gate（同 guards resource 一
//    致模型）：主管有「操作紀錄:view」冇「安員個人資料:view」→ GET
//    /api/audit-log 見唔到 guard_addresses/guard_emergency_contacts 嘅
//    address/name/tel/relationship（但 guard_phones 嘅 tel 唔受影響，
//    跟「安員」module，一直畀睇）。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { findKeysDeep } from "@/lib/api/serialize";
import { GET as guardsList, POST as guardCreate } from "@/app/api/guards/route";
import { GET as guardDetail, PATCH as guardUpdate } from "@/app/api/guards/[id]/route";
import { GET as phonesList, POST as phoneCreate } from "@/app/api/guards/[id]/phones/route";
import { PATCH as phoneUpdate, DELETE as phoneDelete } from "@/app/api/guards/[id]/phones/[phoneId]/route";
import { GET as addressesList, POST as addressCreate } from "@/app/api/guards/[id]/addresses/route";
import { PATCH as addressUpdate, DELETE as addressDelete } from "@/app/api/guards/[id]/addresses/[addressId]/route";
import { GET as contactsList, POST as contactCreate } from "@/app/api/guards/[id]/emergency-contacts/route";
import { PATCH as contactUpdate, DELETE as contactDelete } from "@/app/api/guards/[id]/emergency-contacts/[contactId]/route";
import { GET as auditLogGet } from "@/app/api/audit-log/route";

function req(url: string, cookie: string, method = "GET", body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

describe("WP-MULTI", () => {
  let fx: Wp2Fixture;
  let ownerCookie: string;
  let brokerACookie: string;

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    brokerACookie = await sessionCookieForUser(fx.userIds["雞頭"]);
    // Opus 覆核必修 1（自癒）：fixture guardA 直接 `prisma.guard.create()`
    // 起、`tel="6100001"`（唔經路由）——即係「有 dirty legacy tel、
    // guard_phones 0 行」嘅舊資料狀態。而家加咗「自癒」之後，呢個檔案
    // 入面淨係想測一般電話 CRUD／地址／緊急聯絡人／void 保留／audit log
    // 嘅 test 唔想俾第一次 `phoneCreate()` 觸發自癒多加一行，擾亂咗佢哋
    // 自己嘅行數／primary 斷言——統一喺呢度清返做 `null`；專門想測「自
    // 癒」呢個行為嘅 test 自己再手動設返 dirty 值（見 §1「自癒」／§4）。
    await prisma.guard.update({ where: { id: fx.guardA.id }, data: { tel: null } });
  });

  // ---------------------------------------------------------------------
  describe("§1 電話（guard_phones）", () => {
    it("第一個電話自動變 primary；guards.tel 同步", async () => {
      const res = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "6900-0001" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { is_primary: boolean; tel: string };
      expect(body.is_primary).toBe(true);
      expect(body.tel).toBe("69000001"); // 去咗連字符
      const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.tel).toBe("69000001");
    });

    it("第二個電話 is_primary=false 唔會變 primary；設做 primary 會自動降級舊嗰個", async () => {
      const r1 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000001" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const p1 = (await r1.json()) as { id: string };
      const r2 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000002", label: "屋企" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(r2.status).toBe(201);
      const p2 = (await r2.json()) as { id: string; is_primary: boolean };
      expect(p2.is_primary).toBe(false);

      const r3 = await phoneUpdate(req(`http://test.local/api/guards/${fx.guardA.id}/phones/${p2.id}`, ownerCookie, "PATCH", { is_primary: true }), {
        params: Promise.resolve({ id: fx.guardA.id, phoneId: p2.id }),
      });
      expect(r3.status).toBe(200);
      const after = (await r3.json()) as { is_primary: boolean };
      expect(after.is_primary).toBe(true);

      const oldPrimary = await prisma.guardPhone.findUniqueOrThrow({ where: { id: p1.id } });
      expect(oldPrimary.isPrimary).toBe(false);
      const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.tel).toBe("69000002");
      // 舊電話冇被刪——「有幾多個記幾多個」，只係唔再係 primary。
      const count = await prisma.guardPhone.count({ where: { guardId: fx.guardA.id } });
      expect(count).toBe(2);
    });

    it("同一個 guard 重複電話（POST 已存在嘅電話）→ 冪等（200/201，唔係 409），唔會起多一行", async () => {
      // M（實測揭發，見 src/lib/guards/contacts.ts createGuardPhone()
      // 大註解）：`UNIQUE(guard_id, tel)` 呢個 constraint 淨係「同一個
      // guard」先撞到——呢種情況冧當做冪等（唔係衝突），因為 legacy
      // PATCH（applyLegacyGuardContactPatch()）嘅「值冇變就當冇改」判斷
      // 只係比對緊現時 primary，追唔切「呢個 guard 曾經記錄過但而家唔
      // 係 primary」嘅舊電話——一撞就 409 會令呢類已存在嘅重複送出（例
      // 如人手改返 legacy 欄之後、新表冇跟住清）永遠出錯。
      const r1 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000003" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const p1 = (await r1.json()) as { id: string };
      const res = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "6900 0003" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      expect(body.id).toBe(p1.id); // 兜返同一行，唔係新起一行
      const count = await prisma.guardPhone.count({ where: { guardId: fx.guardA.id, tel: "69000003" } });
      expect(count).toBe(1);
    });

    it("格式唔啱（太短）→ 400", async () => {
      const res = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "123" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(400);
    });

    it("國際號（+ 開頭）接受", async () => {
      const res = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "+886912345678" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(201);
    });

    it("DELETE primary 自動升最舊一行做新 primary；淨返一行都刪走 → 子表 0 行，legacy tel 保留最後已知值（唔再變 null，Opus 覆核：子表 0 行唔准將 legacy 值寫做 null）", async () => {
      const r1 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000010" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const p1 = (await r1.json()) as { id: string };
      const r2 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000011" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const p2 = (await r2.json()) as { id: string };

      const delRes = await phoneDelete(req(`http://test.local/api/guards/${fx.guardA.id}/phones/${p1.id}`, ownerCookie, "DELETE"), {
        params: Promise.resolve({ id: fx.guardA.id, phoneId: p1.id }),
      });
      expect(delRes.status).toBe(200);
      const promoted = await prisma.guardPhone.findUniqueOrThrow({ where: { id: p2.id } });
      expect(promoted.isPrimary).toBe(true);
      let guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.tel).toBe("69000011");

      await phoneDelete(req(`http://test.local/api/guards/${fx.guardA.id}/phones/${p2.id}`, ownerCookie, "DELETE"), {
        params: Promise.resolve({ id: fx.guardA.id, phoneId: p2.id }),
      });
      guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      // Opus 第二輪覆核：用戶經 DELETE **明確刪走最後一行**＝明確操作，legacy `tel`
      // 要跟住清（被動 0 行先至保留）——否則下次新增時自癒會令已刪嘅號復活。
      expect(guard.tel).toBeNull();
      expect(await prisma.guardPhone.count({ where: { guardId: fx.guardA.id } })).toBe(0);
    });

    it("刪走最後一個電話再加新號：舊號唔會復活，新號做主要", async () => {
      const r1 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000041" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const p1 = (await r1.json()) as { id: string };
      await phoneDelete(req(`http://test.local/api/guards/${fx.guardA.id}/phones/${p1.id}`, ownerCookie, "DELETE"), {
        params: Promise.resolve({ id: fx.guardA.id, phoneId: p1.id }),
      });
      const r2 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000042" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(r2.status).toBe(201);
      const rows = await prisma.guardPhone.findMany({ where: { guardId: fx.guardA.id } });
      expect(rows.map((r) => r.tel)).toEqual(["69000042"]);
      expect(rows[0].isPrimary).toBe(true);
      expect((await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } })).tel).toBe("69000042");
    });

    it("自癒：guardA 有 dirty legacy tel（0 行）→ POST 加新電話 → 自癒補返原號做 primary，新號非主要；地址／緊急聯絡人（同樣 dirty 0 行）唔受影響", async () => {
      // 模擬舊資料：呢個 guard 一直都有電話／地址／緊急聯絡人記喺
      // legacy 欄，但三張新表全部 0 行（例如未行過自癒之前嘅舊資料）。
      await prisma.guard.update({
        where: { id: fx.guardA.id },
        data: { tel: "61000091", address: "自癒測試地址", emergencyContactName: "自癒測試聯絡人", emergencyContactTel: "61000092" },
      });
      const res = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000091" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { is_primary: boolean; tel: string };
      // 子資源 POST 冇帶 is_primary——自癒補返嘅原號保持主要，新號非主要
      // （同「舊寫法 PATCH＝新嘅設主要、原本保留」有分別，見檔案大註解）。
      expect(body.is_primary).toBe(false);
      expect(body.tel).toBe("69000091");

      const rows = await prisma.guardPhone.findMany({ where: { guardId: fx.guardA.id }, orderBy: { createdAt: "asc" } });
      expect(rows.length).toBe(2);
      expect(rows[0]!.tel).toBe("61000091");
      expect(rows[0]!.isPrimary).toBe(true);
      expect(rows[0]!.source).toBe("backfill:legacy-on-write");
      expect(rows[1]!.tel).toBe("69000091");
      expect(rows[1]!.isPrimary).toBe(false);

      const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.tel).toBe("61000091"); // 原號繼續做 primary，legacy 欄不變
      expect(guard.address).toBe("自癒測試地址"); // address 呢組完全未受影響
      expect(guard.emergencyContactName).toBe("自癒測試聯絡人");
      expect(guard.emergencyContactTel).toBe("61000092");
      expect(await prisma.guardAddress.count({ where: { guardId: fx.guardA.id } })).toBe(0);
      expect(await prisma.guardEmergencyContact.count({ where: { guardId: fx.guardA.id } })).toBe(0);
    });

    it("雞頭讀自己安員嘅電話：200，窄版 DTO（冇 note/source/created_by）", async () => {
      await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000020", note: "內部備註" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const res = await phonesList(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, brokerACookie), { params: Promise.resolve({ id: fx.guardA.id }) });
      expect(res.status).toBe(200);
      const rows = (await res.json()) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      expect("note" in rows[0]!).toBe(false);
      expect("source" in rows[0]!).toBe(false);
      expect("created_by" in rows[0]!).toBe(false);
      expect(rows[0]!.tel).toBe("69000020");
    });

    it("雞頭寫自己安員嘅電話（POST/PATCH/DELETE）一律 403（硬性）", async () => {
      const r1 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, brokerACookie, "POST", { tel: "69000030" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(r1.status).toBe(403);

      const created = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69000031" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const p = (await created.json()) as { id: string };
      const r2 = await phoneUpdate(req(`http://test.local/api/guards/${fx.guardA.id}/phones/${p.id}`, brokerACookie, "PATCH", { label: "屋企" }), {
        params: Promise.resolve({ id: fx.guardA.id, phoneId: p.id }),
      });
      expect(r2.status).toBe(403);
      const r3 = await phoneDelete(req(`http://test.local/api/guards/${fx.guardA.id}/phones/${p.id}`, brokerACookie, "DELETE"), {
        params: Promise.resolve({ id: fx.guardA.id, phoneId: p.id }),
      });
      expect(r3.status).toBe(403);
    });

    it("雞頭讀第二個雞頭嘅安員 → 404（scopeGuardWhere 隔離）", async () => {
      const res = await phonesList(req(`http://test.local/api/guards/${fx.guardB.id}/phones`, brokerACookie), { params: Promise.resolve({ id: fx.guardB.id }) });
      expect(res.status).toBe(404);
    });

    it("POST /api/guards 帶初始 tel → 建立時已經起一行 primary 電話（唔係得 guards.tel 有值但新表 0 行）", async () => {
      const res = await guardCreate(
        req("http://test.local/api/guards", ownerCookie, "POST", {
          name_zh: "測試新安員",
          tel: "69000099",
          employment_type: "cash_casual",
        }),
      );
      expect(res.status).toBe(201);
      const created = (await res.json()) as { id: string; tel?: string | null };
      expect(created.tel).toBe("69000099");
      const rows = await prisma.guardPhone.findMany({ where: { guardId: created.id } });
      expect(rows.length).toBe(1);
      expect(rows[0]!.isPrimary).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  describe("§2 地址（guard_addresses）", () => {
    it("第一個地址自動 primary；第二個設做 primary 會降級舊嗰個；舊嗰個保留", async () => {
      const r1 = await addressCreate(req(`http://test.local/api/guards/${fx.guardA.id}/addresses`, ownerCookie, "POST", { address: "測試地址一" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const a1 = (await r1.json()) as { id: string; is_primary: boolean };
      expect(a1.is_primary).toBe(true);
      const r2 = await addressCreate(req(`http://test.local/api/guards/${fx.guardA.id}/addresses`, ownerCookie, "POST", { address: "測試地址二" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const a2 = (await r2.json()) as { id: string };

      const setPrimary = await addressUpdate(req(`http://test.local/api/guards/${fx.guardA.id}/addresses/${a2.id}`, ownerCookie, "PATCH", { is_primary: true }), {
        params: Promise.resolve({ id: fx.guardA.id, addressId: a2.id }),
      });
      expect(setPrimary.status).toBe(200);
      const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.address).toBe("測試地址二");
      const count = await prisma.guardAddress.count({ where: { guardId: fx.guardA.id } });
      expect(count).toBe(2); // 舊地址仲喺度
    });

    it("空白地址 → 400", async () => {
      const res = await addressCreate(req(`http://test.local/api/guards/${fx.guardA.id}/addresses`, ownerCookie, "POST", { address: "   " }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(400);
    });

    it("DELETE primary 地址 → 自動升下一行；淨返一行都刪走 → 子表 0 行，legacy address 跟住清（明確刪除）", async () => {
      const r1 = await addressCreate(req(`http://test.local/api/guards/${fx.guardA.id}/addresses`, ownerCookie, "POST", { address: "測試地址甲" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const a1 = (await r1.json()) as { id: string };
      const r2 = await addressCreate(req(`http://test.local/api/guards/${fx.guardA.id}/addresses`, ownerCookie, "POST", { address: "測試地址乙" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const a2 = (await r2.json()) as { id: string };

      await addressDelete(req(`http://test.local/api/guards/${fx.guardA.id}/addresses/${a1.id}`, ownerCookie, "DELETE"), {
        params: Promise.resolve({ id: fx.guardA.id, addressId: a1.id }),
      });
      let guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.address).toBe("測試地址乙");

      await addressDelete(req(`http://test.local/api/guards/${fx.guardA.id}/addresses/${a2.id}`, ownerCookie, "DELETE"), {
        params: Promise.resolve({ id: fx.guardA.id, addressId: a2.id }),
      });
      guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      // Opus 第二輪覆核：用戶明確刪走最後一行＝明確操作，legacy `address` 跟住清（被動 0 行先至保留）。
      expect(guard.address).toBeNull();
      expect(await prisma.guardAddress.count({ where: { guardId: fx.guardA.id } })).toBe(0);
    });

    it("雞頭讀／寫地址一律 403（「安員個人資料」module 對雞頭硬性拒）", async () => {
      const r1 = await addressesList(req(`http://test.local/api/guards/${fx.guardA.id}/addresses`, brokerACookie), { params: Promise.resolve({ id: fx.guardA.id }) });
      expect(r1.status).toBe(403);
      const r2 = await addressCreate(req(`http://test.local/api/guards/${fx.guardA.id}/addresses`, brokerACookie, "POST", { address: "測試地址" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(r2.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------
  describe("§3 緊急聯絡人（guard_emergency_contacts）", () => {
    it("name／tel 同時空 → 400", async () => {
      const res = await contactCreate(req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts`, ownerCookie, "POST", {}), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(400);
    });

    it("多個聯絡人：sort_order 排序；代表行＝sort_order 最細（同步落 guards.emergency_contact_*）", async () => {
      const r1 = await contactCreate(
        req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts`, ownerCookie, "POST", { name: "聯絡人一", tel: "69100001" }),
        { params: Promise.resolve({ id: fx.guardA.id }) },
      );
      const c1 = (await r1.json()) as { id: string; sort_order: number };
      expect(c1.sort_order).toBe(0);
      const r2 = await contactCreate(
        req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts`, ownerCookie, "POST", { name: "聯絡人二", tel: "69100002" }),
        { params: Promise.resolve({ id: fx.guardA.id }) },
      );
      const c2 = (await r2.json()) as { id: string; sort_order: number };
      expect(c2.sort_order).toBe(1);

      let guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.emergencyContactName).toBe("聯絡人一");

      // 將聯絡人二排先（sort_order=-1）——代表行變佢。
      await contactUpdate(req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts/${c2.id}`, ownerCookie, "PATCH", { sort_order: -1 }), {
        params: Promise.resolve({ id: fx.guardA.id, contactId: c2.id }),
      });
      guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.emergencyContactName).toBe("聯絡人二");

      const listRes = await contactsList(req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts`, ownerCookie), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const rows = (await listRes.json()) as Array<{ name: string }>;
      expect(rows.map((r) => r.name)).toEqual(["聯絡人二", "聯絡人一"]);
    });

    it("刪走代表行之後，代表變返剩低嗰個 sort_order 最細；全刪晒 → 子表 0 行，legacy emergency_contact_* 跟住清（明確刪除）", async () => {
      const r1 = await contactCreate(req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts`, ownerCookie, "POST", { name: "聯絡人一" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const c1 = (await r1.json()) as { id: string };
      const r2 = await contactCreate(req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts`, ownerCookie, "POST", { name: "聯絡人二" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const c2 = (await r2.json()) as { id: string };

      await contactDelete(req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts/${c1.id}`, ownerCookie, "DELETE"), {
        params: Promise.resolve({ id: fx.guardA.id, contactId: c1.id }),
      });
      let guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.emergencyContactName).toBe("聯絡人二");

      await contactDelete(req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts/${c2.id}`, ownerCookie, "DELETE"), {
        params: Promise.resolve({ id: fx.guardA.id, contactId: c2.id }),
      });
      guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      // Opus 第二輪覆核：用戶明確刪走最後一行＝明確操作，legacy 欄跟住清（被動 0 行先至保留）。
      expect(guard.emergencyContactName).toBeNull();
      expect(guard.emergencyContactTel).toBeNull(); // 「聯絡人二」本身冇填電話，代表值一直都係 null（唔係俾呢次刪走整出嚟）
      expect(await prisma.guardEmergencyContact.count({ where: { guardId: fx.guardA.id } })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  describe("§4 legacy PATCH /api/guards/:id（tel／address／emergency_contact_*）", () => {
    it("PATCH tel（新值，guardA 有 dirty legacy tel、guard_phones 0 行）→ 自癒先補返原號，新號加做主要、原號降級保留", async () => {
      // 手動整返「有 dirty legacy tel、guard_phones 0 行」嘅舊資料狀態
      // （beforeEach 已經將 fixture 原本嘅 dirty tel 清做 null，呢個
      // test 專登想測呢種狀態，自己設返）。
      await prisma.guard.update({ where: { id: fx.guardA.id }, data: { tel: "61000018" } });
      const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { tel: "69200001" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(200);
      const rows = await prisma.guardPhone.findMany({ where: { guardId: fx.guardA.id }, orderBy: { createdAt: "asc" } });
      // 自癒（healLegacyContactBeforeWrite()）先補返原號做一行 primary，
      // 跟住先起新號做 primary（原號降級）——即係 2 行，唔係 1 行。
      expect(rows.length).toBe(2);
      expect(rows[0]!.tel).toBe("61000018");
      expect(rows[0]!.source).toBe("backfill:legacy-on-write");
      expect(rows[0]!.isPrimary).toBe(false);
      expect(rows[1]!.tel).toBe("69200001");
      expect(rows[1]!.isPrimary).toBe(true);
      expect(rows[1]!.source).toBe("manual:legacy-patch(tel)");
      const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.tel).toBe("69200001");
    });

    it("PATCH 送返同一個 tel（未改）→ 唔起新行、唔 409", async () => {
      await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { tel: "69200010" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { tel: "69200010", name_zh: "測試安員甲改名" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(200);
      const rows = await prisma.guardPhone.count({ where: { guardId: fx.guardA.id } });
      expect(rows).toBe(1);
    });

    it("PATCH tel 改新值 → 加一行做主要，原本嗰個保留做非主要（永遠唔會因為改電話而冇咗舊電話）", async () => {
      await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { tel: "69200020" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { tel: "69200021" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const rows = await prisma.guardPhone.findMany({ where: { guardId: fx.guardA.id }, orderBy: { createdAt: "asc" } });
      expect(rows.length).toBe(2);
      expect(rows[0]!.tel).toBe("69200020");
      expect(rows[0]!.isPrimary).toBe(false);
      expect(rows[1]!.tel).toBe("69200021");
      expect(rows[1]!.isPrimary).toBe(true);
    });

    it("PATCH 送空字串 tel → no-op，唔刪任何行", async () => {
      await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { tel: "69200030" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const res = await guardUpdate(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { tel: "" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      expect(res.status).toBe(200);
      const rows = await prisma.guardPhone.count({ where: { guardId: fx.guardA.id } });
      expect(rows).toBe(1);
      const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.tel).toBe("69200030"); // 冇被清走
    });

    it("PATCH address／emergency_contact_name／tel（老闆有安員個人資料權限）——加返行，同步落 guards 舊欄", async () => {
      const res = await guardUpdate(
        req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", {
          address: "測試地址ABC",
          emergency_contact_name: "緊急聯絡人ABC",
          emergency_contact_tel: "69300001",
        }),
        { params: Promise.resolve({ id: fx.guardA.id }) },
      );
      expect(res.status).toBe(200);
      const guard = await prisma.guard.findUniqueOrThrow({ where: { id: fx.guardA.id } });
      expect(guard.address).toBe("測試地址ABC");
      expect(guard.emergencyContactName).toBe("緊急聯絡人ABC");
      expect(guard.emergencyContactTel).toBe("69300001");
      expect(await prisma.guardAddress.count({ where: { guardId: fx.guardA.id } })).toBe(1);
      expect(await prisma.guardEmergencyContact.count({ where: { guardId: fx.guardA.id } })).toBe(1);
    });
    it("Opus 第二輪覆核：舊寫法 emergency_contact_tel——新嘅髒值 400；舊髒值冇改、只改姓名 → 200 照搬", async () => {
      const bad = await guardUpdate(
        req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { emergency_contact_name: "聯絡人甲", emergency_contact_tel: "唔係電話 / abc" }),
        { params: Promise.resolve({ id: fx.guardA.id }) },
      );
      expect(bad.status).toBe(400);
      expect(await prisma.guardEmergencyContact.count({ where: { guardId: fx.guardA.id } })).toBe(0);

      await prisma.guard.update({ where: { id: fx.guardA.id }, data: { emergencyContactName: "舊聯絡人", emergencyContactTel: "6930 0001 / 6930 0002" } });
      const ok = await guardUpdate(
        req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie, "PATCH", { emergency_contact_name: "舊聯絡人改名", emergency_contact_tel: "6930 0001 / 6930 0002" }),
        { params: Promise.resolve({ id: fx.guardA.id }) },
      );
      expect(ok.status).toBe(200);
      const rows = await prisma.guardEmergencyContact.findMany({ where: { guardId: fx.guardA.id }, orderBy: { sortOrder: "asc" } });
      expect(rows.map((r) => r.name)).toEqual(["舊聯絡人改名", "舊聯絡人"]); // 舊嗰個經自癒保留
      expect(rows[0].tel).toBe("6930 0001 / 6930 0002");
    });
    it("Opus 第三輪覆核：髒 tel 行（自癒／舊寫法照搬）經子資源 PATCH 改姓名／label 唔會 400；改做新髒值先 400", async () => {
      const contact = await prisma.guardEmergencyContact.create({ data: { guardId: fx.guardA.id, name: "舊聯絡人", tel: "6930 0001 / 6930 0002", sortOrder: 0, source: "backfill:legacy-on-write" } });
      const r1 = await contactUpdate(
        req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts/${contact.id}`, ownerCookie, "PATCH", { name: "舊聯絡人改名", tel: "6930 0001 / 6930 0002" }),
        { params: Promise.resolve({ id: fx.guardA.id, contactId: contact.id }) },
      );
      expect(r1.status).toBe(200);
      expect((await prisma.guardEmergencyContact.findUniqueOrThrow({ where: { id: contact.id } })).tel).toBe("6930 0001 / 6930 0002");
      const r2 = await contactUpdate(
        req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts/${contact.id}`, ownerCookie, "PATCH", { tel: "abc / def" }),
        { params: Promise.resolve({ id: fx.guardA.id, contactId: contact.id }) },
      );
      expect(r2.status).toBe(400);

      const phone = await prisma.guardPhone.create({ data: { guardId: fx.guardA.id, tel: "6931 0001 / 6931 0002", isPrimary: true, source: "backfill:legacy-on-write" } });
      const r3 = await phoneUpdate(
        req(`http://test.local/api/guards/${fx.guardA.id}/phones/${phone.id}`, ownerCookie, "PATCH", { tel: "6931 0001 / 6931 0002", label: "屋企" }),
        { params: Promise.resolve({ id: fx.guardA.id, phoneId: phone.id }) },
      );
      expect(r3.status).toBe(200);
      const after = await prisma.guardPhone.findUniqueOrThrow({ where: { id: phone.id } });
      expect(after.tel).toBe("6931 0001 / 6931 0002");
      expect(after.label).toBe("屋企");
      const r4 = await phoneUpdate(
        req(`http://test.local/api/guards/${fx.guardA.id}/phones/${phone.id}`, ownerCookie, "PATCH", { tel: "唔係電話" }),
        { params: Promise.resolve({ id: fx.guardA.id, phoneId: phone.id }) },
      );
      expect(r4.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------
  describe("§5 GET /api/guards?q= 搵到任何一個電話（唔止 primary）", () => {
    it("second（非 primary）電話都搜到", async () => {
      await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69400001" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69400099", label: "屋企" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const res = await guardsList(req(`http://test.local/api/guards?q=69400099`, ownerCookie));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: Array<{ id: string }> };
      expect(body.rows.some((r) => r.id === fx.guardA.id)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  describe("§6 離職／作廢資料完整保留", () => {
    it("void guard 之後電話／地址／緊急聯絡人／員工編號全部原封不動", async () => {
      await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69500001" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      await addressCreate(req(`http://test.local/api/guards/${fx.guardA.id}/addresses`, ownerCookie, "POST", { address: "測試地址留底" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      await contactCreate(req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts`, ownerCookie, "POST", { name: "留底聯絡人" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });

      const before = {
        phones: await prisma.guardPhone.count({ where: { guardId: fx.guardA.id } }),
        addresses: await prisma.guardAddress.count({ where: { guardId: fx.guardA.id } }),
        contacts: await prisma.guardEmergencyContact.count({ where: { guardId: fx.guardA.id } }),
      };
      expect(before.phones).toBeGreaterThan(0);
      expect(before.addresses).toBeGreaterThan(0);
      expect(before.contacts).toBeGreaterThan(0);

      await prisma.guard.update({ where: { id: fx.guardA.id }, data: { status: "inactive", leaveDate: new Date("2026-09-19") } });

      const after = {
        phones: await prisma.guardPhone.count({ where: { guardId: fx.guardA.id } }),
        addresses: await prisma.guardAddress.count({ where: { guardId: fx.guardA.id } }),
        contacts: await prisma.guardEmergencyContact.count({ where: { guardId: fx.guardA.id } }),
      };
      expect(after).toEqual(before);

      const detailRes = await guardDetail(req(`http://test.local/api/guards/${fx.guardA.id}`, ownerCookie), { params: Promise.resolve({ id: fx.guardA.id }) });
      const detail = (await detailRes.json()) as { status: string; tel?: string | null };
      expect(detail.status).toBe("inactive");
      expect(detail.tel).toBe("69500001"); // 電話冇因為離職被清
    });
  });

  // ---------------------------------------------------------------------
  describe("§7 audit_log：create／update／delete 三種 action 留底", () => {
    it("新增電話寫 create；設做 primary（降級舊嗰個）寫多一條 update；DELETE 寫 delete", async () => {
      const r1 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69600001" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const p1 = (await r1.json()) as { id: string };
      const createLog = await prisma.auditLog.findFirst({ where: { tableName: "guard_phones", rowId: p1.id, action: "create" } });
      expect(createLog).not.toBeNull();

      const r2 = await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69600002" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      const p2 = (await r2.json()) as { id: string };
      await phoneUpdate(req(`http://test.local/api/guards/${fx.guardA.id}/phones/${p2.id}`, ownerCookie, "PATCH", { is_primary: true }), {
        params: Promise.resolve({ id: fx.guardA.id, phoneId: p2.id }),
      });
      const demoteLog = await prisma.auditLog.findFirst({ where: { tableName: "guard_phones", rowId: p1.id, action: "update" } });
      expect(demoteLog).not.toBeNull();

      await phoneDelete(req(`http://test.local/api/guards/${fx.guardA.id}/phones/${p1.id}`, ownerCookie, "DELETE"), {
        params: Promise.resolve({ id: fx.guardA.id, phoneId: p1.id }),
      });
      const deleteLog = await prisma.auditLog.findFirst({ where: { tableName: "guard_phones", rowId: p1.id, action: "delete" } });
      expect(deleteLog).not.toBeNull();
      expect(deleteLog?.after).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  describe("§8 GET /api/audit-log 讀出嗰陣一樣要經 field-group gate", () => {
    async function grantAuditLogView(roleId: string) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: "操作紀錄", action: "view" } } });
      await prisma.rolePermission.update({ where: { roleId_permissionId: { roleId, permissionId: permission.id } }, data: { granted: true } });
    }

    it("主管有「操作紀錄:view」冇「安員個人資料:view」→ 地址／緊急聯絡人 audit 剝晒 address/name/tel/relationship，電話 audit 唔受影響", async () => {
      await grantAuditLogView(fx.roleIds["主管"]);
      const supervisorCookie = await sessionCookieForUser(fx.userIds["主管"]);

      await addressCreate(req(`http://test.local/api/guards/${fx.guardA.id}/addresses`, ownerCookie, "POST", { address: "測試地址N1敏感街1號" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });
      await contactCreate(
        req(`http://test.local/api/guards/${fx.guardA.id}/emergency-contacts`, ownerCookie, "POST", { name: "測試N1聯絡人", tel: "69900001", relationship: "配偶" }),
        { params: Promise.resolve({ id: fx.guardA.id }) },
      );
      await phoneCreate(req(`http://test.local/api/guards/${fx.guardA.id}/phones`, ownerCookie, "POST", { tel: "69900002" }), {
        params: Promise.resolve({ id: fx.guardA.id }),
      });

      const res = await auditLogGet(req("http://test.local/api/audit-log?take=500", supervisorCookie));
      expect(res.status).toBe(200);
      const json = await res.json();
      const leaked = findKeysDeep(json, ["address", "name", "relationship"]);
      // guard_emergency_contacts/guard_addresses 嘅 address/name/relationship
      // 一律唔見得到；`tel` 唔喺呢個檢查（`guard_phones.tel` 冇受任何
      // field-group 保護，見下面斷言）。
      expect(leaked).toEqual([]);

      // guard_phones 嘅 tel 一直可見（跟「安員」module，唔係 PII 組）。
      const rows = json.rows as Array<{ table_name: string; after?: Record<string, unknown> | null }>;
      const phoneRow = rows.find((r) => r.table_name === "guard_phones" && r.after?.tel === "69900002");
      expect(phoneRow).toBeDefined();
    });
  });
});
