// P1-WP2 假數據 fixture——認證/RBAC/雞頭隔離/audit/月結鎖定 integration
// test 共用。冇任何真名/工號/電話（PDPO），全部「測試XX」呢類假資料。
//
// Roles/permissions/6 個固定測試用戶喺 tests/global-setup.ts 種一次、成個
// test run 唔變（見嗰個檔案同 tests/lib/db.ts clearAll() 嘅註解解釋點解）；
// 呢度淨係負責「業務資料」（broker/site/guard/rate_card/shift_record…）
// ——呢啲表 clearAll() 會刪、每個 test 重新種。
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db";
import { sealSession, type SessionData } from "../../src/lib/auth/session";
import type { RoleName } from "../../src/lib/rbac/matrix";
import { TEST_USER_TEL, TEST_USER_PASSWORD, TEST_USER_SLOTS, roleNameForSlot, type TestUserSlot } from "./test-users";

export const TEST_PASSWORD = TEST_USER_PASSWORD;

// 6 個固定測試用戶係全 test run 共用（唔喺 clearAll() 度刪，見檔案頂
// 註解），但改密碼/登入鎖定呢類 test 會改到佢哋嘅 password_hash／
// failed_attempts／locked_until——每個 test 開始要重置返呢幾個 auth 欄位，
// 否則前一個 test 嘅登入side effect 會漏到下一個 test。password hash 用
// memoize，唔使每個 test 都重新 bcrypt.hash 一次（慢）。
let cachedPasswordHash: Promise<string> | null = null;
function testPasswordHash(): Promise<string> {
  if (!cachedPasswordHash) cachedPasswordHash = bcrypt.hash(TEST_USER_PASSWORD, 4);
  return cachedPasswordHash;
}

// Opus 驗收殘留1/2 加固之後：測試會改到呢 6 個全局固定用戶嘅 role_id
// （殘留1「改角色 bump token_version」個 test）、token_version（logout/
// void/改密碼/改角色都會 bump）、status（void user 個 test 會設
// inactive）——呢啲亦要每個 test 開始就重置返出廠狀態，否則一個 test
// 改咗會永久污染成個 test run 之後嘅測試（已實測發生過兩次：(a)
// wp2-token-version.test.ts 將「測試會計」個 role_id 改咗做主管；(b)
// 同一個檔案「void user」個 test 將「測試主管」status 設咗 inactive，
// 兩次都冇重置就一路帶落去，累到 wp2-rbac-matrix.test.ts）。
async function resetAuthState(): Promise<void> {
  const passwordHash = await testPasswordHash();
  const roles = await prisma.role.findMany({ where: { isCustom: false } });
  const roleIdByName = Object.fromEntries(roles.map((r) => [r.name, r.id])) as Record<RoleName, string>;

  for (const slot of TEST_USER_SLOTS) {
    const roleId = roleIdByName[roleNameForSlot(slot)];
    await prisma.user.update({
      where: { tel: TEST_USER_TEL[slot] },
      data: {
        passwordHash,
        roleId,
        status: "active",
        tokenVersion: 1,
        failedAttempts: 0,
        lockedUntil: null,
        lastLoginAt: null,
        lastLoginIp: null,
        mustChangePwd: false,
        brokerId: null,
      },
    });
  }
}

export interface Wp2Fixture {
  roleIds: Record<RoleName, string>;
  userIds: Record<RoleName, string>; // 每個角色一個代表用戶（雞頭 = 雞頭A，掛 brokerA）
  brokerA: { id: string; name: string };
  brokerB: { id: string; name: string };
  brokerInternal: { id: string; name: string };
  guardA: { id: string; name: string }; // 掛 brokerA
  guardB: { id: string; name: string }; // 掛 brokerB
  site: { id: string; name: string };
  siteUnassigned: { id: string; name: string }; // brokerA 冇 broker_site_assignments 嘅盤，C1 negative test 用
  shiftType: { id: string };
  rateCardGeneric: { id: string }; // broker_id = null，通用價，含 client_rate
  rateCardBrokerA: { id: string };
  shiftRecordA: { id: string }; // settlement=operational=brokerA
  shiftRecordB: { id: string };
  dailyRequirement: { id: string };
  unlockedMonth: Date; // 2026-08-01，寫入測試用
  lockedMonth: Date; // 2026-06-01，鎖定測試用
  lockedMonthCloseId: string;
}

async function userIdForSlot(slot: TestUserSlot): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { tel: TEST_USER_TEL[slot] } });
  return user.id;
}

export async function seedWp2Fixture(): Promise<Wp2Fixture> {
  await resetAuthState();
  const roles = await prisma.role.findMany();
  const roleIds = Object.fromEntries(roles.map((r) => [r.name, r.id])) as Record<RoleName, string>;

  const userIds = {
    老闆: await userIdForSlot("老闆"),
    主管: await userIdForSlot("主管"),
    會計: await userIdForSlot("會計"),
    雞頭: await userIdForSlot("雞頭A"),
    安員: await userIdForSlot("安員"),
  } as Record<RoleName, string>;
  const brokerBUserId = await userIdForSlot("雞頭B");

  const brokerA = await prisma.broker.create({
    data: { code: "TEST-BA", name: "測試雞頭A", kind: "broker", settlementType: "cash", createdBy: "test-fixture:wp2" },
  });
  const brokerB = await prisma.broker.create({
    data: { code: "TEST-BB", name: "測試雞頭B", kind: "broker", settlementType: "cash", createdBy: "test-fixture:wp2" },
  });
  const brokerInternal = await prisma.broker.create({
    data: { code: "TEST-Y", name: "測試公司兵", kind: "internal_cash", settlementType: "cash", isInternal: true, createdBy: "test-fixture:wp2" },
  });

  // 雞頭A/B 兩個固定測試用戶掛返新鮮起嘅 broker（broker 每個 test 都重新
  // 起，舊嘅已經俾 clearAll() 刪咗，user.broker_id 之前已經俾 clearAll()
  // update 返做 null，呢度重新掛）。
  await prisma.user.update({ where: { id: userIds["雞頭"] }, data: { brokerId: brokerA.id } });
  await prisma.user.update({ where: { id: brokerBUserId }, data: { brokerId: brokerB.id } });

  const guardA = await prisma.guard.create({
    data: { staffNo: "T-A01", nameZh: "測試保安員甲", employmentType: "cash_casual", defaultBrokerId: brokerA.id, tel: "6100001", createdBy: "test-fixture:wp2" },
  });
  const guardB = await prisma.guard.create({
    data: { staffNo: "T-B01", nameZh: "測試保安員乙", employmentType: "cash_casual", defaultBrokerId: brokerB.id, tel: "6100002", createdBy: "test-fixture:wp2" },
  });

  const site = await prisma.site.create({
    data: { canonicalName: "測試盤WP2", clientName: "測試客戶WP2", billingModel: "per_shift", createdBy: "test-fixture:wp2" },
  });
  const siteUnassigned = await prisma.site.create({
    data: { canonicalName: "測試盤WP2-冇份", clientName: "測試客戶WP2-冇份", billingModel: "per_shift", createdBy: "test-fixture:wp2" },
  });
  const shiftType = await prisma.shiftType.create({
    data: { siteId: site.id, code: "N", label: "測試夜更", hours: 12, createdBy: "test-fixture:wp2" },
  });

  // M5（Opus 對抗式驗收）：rate_cards 月鎖而家 check 成個
  // [effective_from, effective_to] 區間（effective_to=null 當「今日+1
  // 個月」）。呢兩張卡嘅生效區間要避開 fx.lockedMonth（2026-06，下面先
  // 起）——用明確 effective_to 界住（2026-12-31），唔靠「今日」嗰個
  // 隨時間漂移嘅動態上限，令 test 唔會因為跑測試嗰日唔同而突然變咗
  // 覆蓋到 6 月。
  const rateCardGeneric = await prisma.rateCard.create({
    data: {
      siteId: site.id,
      shiftTypeId: shiftType.id,
      clientRate: 999,
      guardWage: 700,
      brokerFee: 50,
      payoutRate: 750,
      effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
      effectiveTo: new Date(Date.UTC(2026, 11, 31)),
      createdBy: "test-fixture:wp2",
    },
  });
  const rateCardBrokerA = await prisma.rateCard.create({
    data: {
      siteId: site.id,
      shiftTypeId: shiftType.id,
      brokerId: brokerA.id,
      clientRate: 888,
      guardWage: 650,
      brokerFee: 60,
      payoutRate: 710,
      effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
      effectiveTo: new Date(Date.UTC(2026, 11, 31)),
      createdBy: "test-fixture:wp2",
    },
  });

  const unlockedMonth = new Date(Date.UTC(2026, 7, 1)); // 2026-08-01
  const lockedMonth = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01

  // C1（Opus 對抗式驗收）：broker_site_assignments 白名單——brokerA/brokerB
  // 兩個都喺 `site` 有份（鎖定月/未鎖定月都有，覆蓋晒 create/scope test
  // 用到嘅月份）；`siteUnassigned` 兩個都冇份，專登留低嚟做「自己冇份嘅
  // 盤開更→403」嘅 negative test。
  for (const brokerId of [brokerA.id, brokerB.id]) {
    for (const month of [unlockedMonth, lockedMonth]) {
      await prisma.brokerSiteAssignment.create({ data: { brokerId, siteId: site.id, month, createdBy: "test-fixture:wp2" } });
    }
  }

  const shiftRecordA = await prisma.shiftRecord.create({
    data: {
      workDate: new Date(Date.UTC(2026, 7, 1)),
      siteId: site.id,
      shiftTypeId: shiftType.id,
      guardId: guardA.id,
      settlementBrokerId: brokerA.id,
      operationalBrokerId: brokerA.id,
      recordType: "shift",
      clientRateSnapshot: 999,
      guardWageSnapshot: 700,
      brokerFeeSnapshot: 50,
      createdBy: "test-fixture:wp2",
    },
  });
  const shiftRecordB = await prisma.shiftRecord.create({
    data: {
      workDate: new Date(Date.UTC(2026, 7, 1)),
      siteId: site.id,
      shiftTypeId: shiftType.id,
      guardId: guardB.id,
      settlementBrokerId: brokerB.id,
      operationalBrokerId: brokerB.id,
      recordType: "shift",
      clientRateSnapshot: 999,
      guardWageSnapshot: 700,
      brokerFeeSnapshot: 50,
      createdBy: "test-fixture:wp2",
    },
  });

  const dailyRequirement = await prisma.dailyRequirement.create({
    data: { siteId: site.id, shiftTypeId: shiftType.id, workDate: new Date(Date.UTC(2026, 7, 1)), headcountRequired: 3, createdBy: "test-fixture:wp2" },
  });

  const lockedMonthClose = await prisma.monthClose.create({
    data: { month: lockedMonth, lockedAt: new Date(), lockedBy: userIds["老闆"], createdBy: "test-fixture:wp2" },
  });

  return {
    roleIds,
    userIds,
    brokerA: { id: brokerA.id, name: brokerA.name },
    brokerB: { id: brokerB.id, name: brokerB.name },
    brokerInternal: { id: brokerInternal.id, name: brokerInternal.name },
    guardA: { id: guardA.id, name: guardA.nameZh },
    guardB: { id: guardB.id, name: guardB.nameZh },
    site: { id: site.id, name: site.canonicalName },
    siteUnassigned: { id: siteUnassigned.id, name: siteUnassigned.canonicalName },
    shiftType: { id: shiftType.id },
    rateCardGeneric: { id: rateCardGeneric.id },
    rateCardBrokerA: { id: rateCardBrokerA.id },
    shiftRecordA: { id: shiftRecordA.id },
    shiftRecordB: { id: shiftRecordB.id },
    dailyRequirement: { id: dailyRequirement.id },
    unlockedMonth,
    lockedMonth,
    lockedMonthCloseId: lockedMonthClose.id,
  };
}

/** 幫手：直接 seal 一個 session cookie（唔經 /api/auth/login），用嚟快速起一個指定角色嘅已登入 Request。 */
export async function sessionCookieFor(data: SessionData): Promise<string> {
  const sealed = await sealSession(data);
  return `zoikan_session=${encodeURIComponent(sealed)}`;
}

/**
 * 由 DB 現時狀態（roleId/roleName/base_role/broker_id/token_version）起
 * 一個已登入嘅 session cookie——Opus 驗收殘留1加咗 token_version 核對之後
 * （見 requireSession()），呢個 helper 保證 seal 入面嘅 token_version 同
 * DB 一致，唔使每個 test 自己記住要 fetch 咩。`overrides` 俾少數要故意
 * 整壞 session（例如殘留2 test 想整一個「未知 base_role」）嘅 test 用。
 */
export async function sessionCookieForUser(userId: string, overrides: Partial<SessionData> = {}): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { role: true } });
  const data: SessionData = {
    userId: user.id,
    tel: user.tel,
    name: user.name,
    roleId: user.roleId,
    roleName: user.role.name,
    baseRole: user.role.baseRole,
    brokerId: user.brokerId,
    guardId: user.guardId,
    payoutApprovalLimit: user.payoutApprovalLimit ? user.payoutApprovalLimit.toString() : null,
    tokenVersion: user.tokenVersion,
    loggedInAt: new Date().toISOString(),
    ...overrides,
  };
  return sessionCookieFor(data);
}
