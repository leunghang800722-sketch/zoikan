// 雞頭隔離（設計文件§5.1 硬性規則1；P1-執行計劃.md §3 硬性規則1；Opus
// 對抗式驗收 C1/C2 加固）：雞頭角色嘅 API 回應永遠唔含 client_rate*、
// 毛利/gross/margin/profit 欄、其他 broker 任何記錄；寫入亦唔可以「憑空
// 開更」幫唔屬於自己嘅安員／喺自己冇份嘅盤開更次。
//
// 三重防線：
//   (a) 歸屬檢查（C1）——寫入之前驗證 guard.default_broker_id=自己、同
//       (site,month) 喺 broker_site_assignments 白名單入面，唔可以淨係
//       靠「呢個更次已經存在」反推可見性（嗰個正正係漏洞：先憑空開一條
//       更次，之後就用「有更」呢個藉口攞到唔屬於自己嘅資料）。
//   (b) query 層 scope——list/get 查詢一律加 WHERE，令其他 broker 嘅
//       record／唔屬於自己嘅 guard／自己冇份嘅盤嘅 rate_card 根本冇入到
//       結果集。
//   (c) response 白名單 DTO + blocklist scrub 雙重——C2：雞頭見到嘅每個
//       資源一律逐 route 白名單 DTO（見 broker-dto.ts），唔係淨係剝走
//       黑名單；呢個檔案嘅 scrubForBrokerSession() 做埋最後一層 blocklist
//       defense-in-depth（就算白名單有漏都仲有一層）。
import type { Prisma } from "@prisma/client";
import type { AuthedSession } from "./rbac/requirePermission";
import { prisma } from "./db";
import { dropKeysDeep, isDecimalLike } from "./api/serialize";
import { Forbidden, BadRequest } from "./api/errors";
import { monthStart } from "./month-lock";

export const BROKER_FORBIDDEN_KEYS = [
  "clientRate",
  "clientRateSnapshot",
  "gross",
  "grossProfit",
  "grossRevenue",
  "margin",
  "marginPct",
  "profit",
  "profitMargin",
  "bankInfo", // 其他 broker 嘅銀行資料絕對唔可以見（自己嘅由 scope 保證先出到嚟）
  "note",
  "evidence",
  "source",
  "provenance",
  "confidence",
  "settlementPage",
  "rescueRate",
  "revenue", // special_items.revenue——收客金額，C3 field-level gate 由 收客價:view 判斷，雞頭一律冇
];

// C1/C2：isBrokerRole 用 baseRole（唔係 roleName）判斷——自訂角色複製自
// 雞頭並改名之後，隔離規則要照跟（同 requirePermission.ts 嘅硬性 deny
// 判斷邏輯一致，都係用 base_role 做「呢個 session 本質上係咪雞頭」）。
export function isBrokerRole(session: AuthedSession): boolean {
  return session.baseRole === "雞頭";
}

// WP-STAFFNO（Opus 驗收 M2b）：「內部角色」＝老闆／主管／會計——409
// response 帶 `guard_id`（例如工號撞號）呢類結構化 detail 淨係俾內部
// 角色見到，雞頭（＋理論上嘅「安員」自助角色）一律唔畀，唔靠「唔係雞頭
// 就畀」（`!isBrokerRole()`）咁鬆——用白名單（明列三個內部角色）先係
// default-deny。
const INTERNAL_ROLES = ["老闆", "主管", "會計"] as const;
export function isInternalRole(session: AuthedSession): boolean {
  return (INTERNAL_ROLES as readonly string[]).includes(session.baseRole);
}

export function requireOwnBrokerId(session: AuthedSession): string {
  if (!session.brokerId) throw new Error("雞頭角色 session 冇 broker_id——資料有問題，拒絕繼續");
  return session.brokerId;
}

// ---------------------------------------------------------------------------
// C1：寫入前歸屬檢查——「憑空開更＋guard嫁接」防線
// ---------------------------------------------------------------------------

/** 雞頭淨係可以幫 default_broker_id=自己嘅安員開更（唔可以「嫁接」第二個雞頭嘅人）。 */
export async function assertGuardOwnedByBroker(guardId: string, brokerId: string): Promise<void> {
  const guard = await prisma.guard.findUnique({ where: { id: guardId }, select: { defaultBrokerId: true } });
  if (!guard || guard.defaultBrokerId !== brokerId) {
    throw Forbidden("呢個保安員唔屬於你（default_broker_id 唔係自己）——唔可以幫佢開更");
  }
}

/** 雞頭淨係可以喺 broker_site_assignments 白名單入面嘅 (site, 月份) 開更；
 * quotas 表 P3 先做，P1 用呢個表暫代「歸屬」判斷（唔可以靠「已經有更」
 * 反推）。 */
export async function assertSiteAssignedToBroker(siteId: string, brokerId: string, workDate: Date): Promise<void> {
  const month = monthStart(workDate);
  const assignment = await prisma.brokerSiteAssignment.findUnique({
    where: { brokerId_siteId_month: { brokerId, siteId, month } },
  });
  if (!assignment) {
    throw Forbidden("你喺呢個盤呢個月冇份（broker_site_assignments 冇呢行）——唔可以開更");
  }
}

// 應修 4（Opus 驗收覆核）：`settlement_broker_id`／`operational_broker_id`
// 嘅 zod schema（src/lib/api/schemas.ts）淨係校驗格式（`uuid`），冇校驗
// 呢個 id 真係存在——之前傳一個格式啱但唔存在嘅 UUID，會一路帶到
// `prisma.shiftRecord.create()`/`update()` 先至撞 FK constraint，兩個
// route 都冇 catch `P2003`，變成未經處理嘅 500（唔係乾淨嘅 400）。DB
// existence 呢種要打 DB 嘅檢查唔屬於 zod（呢個 repo 嘅 schemas.ts 一路
// 淨係做同步格式校驗，冇任何 async DB 查詢），所以放呢度（同
// `assertGuardOwnedByBroker`／`assertSiteAssignedToBroker` 呢類 route-級
// async assert helper 同一種）。
//
// 順便補埋雞頭隔離：之前 batch/route.ts 嘅雞頭分支完全冇讀 payload 嘅
// `settlement_broker_id`（一律靜靜用自己個 broker id 蓋過去）——雞頭帶
// 咗第二個雞頭嘅 id 落嚟，之前會「靜靜忽略」（冚咗自己個 id，睇落好似
// 冧啱，但用戶完全唔知自己個 payload 本身就唔啱）。而家改做明確 403，
// 話畀佢知個 payload 有問題，唔係得個「好彩冚啱」。
/** 校驗一批（可以帶 null/undefined，會自動剔走）settlement／operational
 * broker id：(a) 全部一定要喺 `brokers` 表存在，唔存在 → 400；
 * (b) `ownBrokerId` 非 null（即雞頭 session）嗰陣，帶咗嘅 id 一定要
 * 同 `ownBrokerId` 一致，唔一致 → 403（雞頭唔可以幫第二個雞頭寫呢個
 * 欄，就算嗰個 broker id 真係存在都唔准）。 */
export async function assertSettlementBrokerIdsValid(brokerIds: Array<string | null | undefined>, ownBrokerId: string | null): Promise<void> {
  const ids = [...new Set(brokerIds.filter((v): v is string => v != null))];
  if (ids.length === 0) return;
  if (ownBrokerId) {
    for (const id of ids) {
      if (id !== ownBrokerId) {
        throw Forbidden(`settlement_broker_id／operational_broker_id 唔可以係第二個雞頭嘅 id（${id}）——雞頭淨係可以用自己嘅 broker id`);
      }
    }
  }
  const found = await prisma.broker.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const foundIds = new Set(found.map((b) => b.id));
  for (const id of ids) {
    if (!foundIds.has(id)) throw BadRequest(`broker id ${id} 唔存在`);
  }
}

// ---------------------------------------------------------------------------
// Query-層 scope
// ---------------------------------------------------------------------------
export function scopeShiftRecordWhere(session: AuthedSession, where: Prisma.ShiftRecordWhereInput = {}): Prisma.ShiftRecordWhereInput {
  if (!isBrokerRole(session)) return where;
  const brokerId = requireOwnBrokerId(session);
  return {
    AND: [where, { OR: [{ settlementBrokerId: brokerId }, { operationalBrokerId: brokerId }] }],
  };
}

export function scopeRateCardWhere(session: AuthedSession, where: Prisma.RateCardWhereInput = {}): Prisma.RateCardWhereInput {
  if (!isBrokerRole(session)) return where;
  const brokerId = requireOwnBrokerId(session);
  // C1：加盤 scope——淨係見到自己有份（broker_site_assignments）嘅盤嘅
  // rate_card；「通用價」（broker_id=null）都要跟埋盤 scope，唔係自己
  // 有份嘅盤，就算通用價都唔畀見（避免反推其他盤嘅收費結構）。
  return {
    AND: [
      where,
      { OR: [{ brokerId }, { brokerId: null }] },
      { site: { brokerAssignments: { some: { brokerId } } } },
    ],
  };
}

export function scopeGuardWhere(session: AuthedSession, where: Prisma.GuardWhereInput = {}): Prisma.GuardWhereInput {
  if (!isBrokerRole(session)) return where;
  const brokerId = requireOwnBrokerId(session);
  // C1 修正：舊版「OR shiftRecords.some(...)」淨係睇「有冇更次」就畀睇，
  // 呢個係漏洞（可以憑空開一條更次幫任何 guard_id「解鎖」可見性）。而家
  // 條件收緊做「嗰條更次仲要係喺 broker_site_assignments 白名單入面嘅盤
  // 先算數」——同 assertSiteAssignedToBroker() 寫入時嘅檢查一致，先至
  // 保證「淨係靠寫入路徑正常建立嘅更次先會令個 guard 見得到」。
  return {
    AND: [
      where,
      {
        OR: [
          { defaultBrokerId: brokerId },
          {
            shiftRecords: {
              some: {
                OR: [{ settlementBrokerId: brokerId }, { operationalBrokerId: brokerId }],
                site: { brokerAssignments: { some: { brokerId } } },
              },
            },
          },
        ],
      },
    ],
  };
}

// P1-WP3：雞頭需要睇到自己有份嗰啲盤嘅基本資料（名／別名）先識揀盤入
// 更表編輯器（設計文件§4.1）——「盤」module 本身對雞頭硬性 deny（盤
// 管理，同雞頭角色無關），GET 呢個 route 用 module resolver 改行「更表」
// （見 sites/route.ts），呢度淨係加 query-scope；白名單見
// broker-dto.ts 嘅 toBrokerSiteDTO（冇 monthly_fee/monthly_posts 呢類
// 財務欄，同 clientGroup/parentSiteId/createdBy 呢類後台欄）。
export function scopeSiteWhere(session: AuthedSession, where: Prisma.SiteWhereInput = {}): Prisma.SiteWhereInput {
  if (!isBrokerRole(session)) return where;
  const brokerId = requireOwnBrokerId(session);
  return { AND: [where, { brokerAssignments: { some: { brokerId } } }] };
}

export function scopeBrokerWhere(session: AuthedSession, where: Prisma.BrokerWhereInput = {}): Prisma.BrokerWhereInput {
  if (!isBrokerRole(session)) return where;
  const brokerId = requireOwnBrokerId(session);
  return { AND: [where, { id: brokerId }] };
}

/**
 * 通用 scope：資源本身冇 broker_id（例如 daily_requirements 只有
 * site_id/shift_type_id/work_date），但跟住個 site 走——C1 改用
 * broker_site_assignments 白名單（唔係「有冇更次」）判斷雞頭見唔見到
 * 呢個盤嘅資料。
 */
export function scopeBySiteHavingBrokerShifts<W extends Record<string, unknown>>(
  session: AuthedSession,
  where: W,
  siteRelation: "site" = "site",
): W {
  if (!isBrokerRole(session)) return where;
  const brokerId = requireOwnBrokerId(session);
  return {
    AND: [where, { [siteRelation]: { brokerAssignments: { some: { brokerId } } } }],
  } as unknown as W;
}

// S6：broker_site_assignments 管理 API——雞頭 GET 淨係見自己。
export function scopeBrokerSiteAssignmentWhere<W extends Record<string, unknown>>(session: AuthedSession, where: W): W {
  if (!isBrokerRole(session)) return where;
  const brokerId = requireOwnBrokerId(session);
  return { AND: [where, { brokerId }] } as unknown as W;
}

// P1-WP3：quotas（配額）——雞頭 GET 只見自己（`配額` module，見
// src/lib/rbac/matrix.ts）。
export function scopeQuotaWhere(session: AuthedSession, where: Prisma.QuotaWhereInput = {}): Prisma.QuotaWhereInput {
  if (!isBrokerRole(session)) return where;
  const brokerId = requireOwnBrokerId(session);
  return { AND: [where, { brokerId }] };
}

export function scopeReferralFeeRateWhere(
  session: AuthedSession,
  where: Prisma.ReferralFeeRateWhereInput = {},
): Prisma.ReferralFeeRateWhereInput {
  if (!isBrokerRole(session)) return where;
  const brokerId = requireOwnBrokerId(session);
  return { AND: [where, { brokerId }] };
}

// ---------------------------------------------------------------------------
// Response-層 scrub（defense-in-depth，見檔案頂註解 (c)）
// ---------------------------------------------------------------------------
function dropForeignBrokerObjectsDeep(value: unknown, ownBrokerId: string): unknown {
  if (value instanceof Date) return value; // Opus 驗收 C2：唔好拆 Date/Decimal（見 serialize.ts isOpaqueLeaf 同一個 bug class）
  if (isDecimalLike(value)) return value; // 用 duck-type（唔係 instanceof——Vitest 底下有 dual-module 問題，見 serialize.ts 註解）
  if (Array.isArray(value)) return value.map((v) => dropForeignBrokerObjectsDeep(v, ownBrokerId));
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    // 認得「呢個物件本身係一張 Broker record」：同時有 code/kind/settlementType
    // 呢幾個 Broker model 獨有欄位，而且 id 唔係自己個 broker——連 nested
    // relation include（例如 shift_record.settlementBroker）都要剝。
    const looksLikeBroker = typeof v.code !== "undefined" && typeof v.kind !== "undefined" && typeof v.settlementType !== "undefined";
    if (looksLikeBroker && typeof v.id === "string" && v.id !== ownBrokerId) {
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = dropForeignBrokerObjectsDeep(val, ownBrokerId);
    }
    return out;
  }
  return value;
}

/** 喺 route handler 出 response 之前，雞頭角色一律經呢個 scrub（白名單
 * DTO 之後嘅最後一層 defense-in-depth，見 broker-dto.ts）。 */
export function scrubForBrokerSession<T>(session: AuthedSession, data: T): T {
  if (!isBrokerRole(session)) return data;
  const brokerId = requireOwnBrokerId(session);
  const withoutForbiddenKeys = dropKeysDeep(data, BROKER_FORBIDDEN_KEYS);
  return dropForeignBrokerObjectsDeep(withoutForbiddenKeys, brokerId) as T;
}
