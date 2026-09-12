// 固定假電話（PDPO：唔係真人）——WP2 全部 test 共用嘅 6 個測試帳號，喺
// tests/global-setup.ts 種一次（成個 test run 淨係種一次，見
// tests/lib/db.ts clearAll() 頂嘅註解解釋點解唔可以每個 test 清一次）。
// "雞頭A"/"雞頭B" 兩個 slot 都係「雞頭」呢個角色，分別用嚟做雞頭隔離對照組。
import type { RoleName } from "../../src/lib/rbac/matrix";

export const TEST_USER_SLOTS = ["老闆", "主管", "會計", "雞頭A", "雞頭B", "安員"] as const;
export type TestUserSlot = (typeof TEST_USER_SLOTS)[number];

export const TEST_USER_TEL: Record<TestUserSlot, string> = {
  老闆: "91000001",
  主管: "92000001",
  會計: "93000001",
  雞頭A: "94000001",
  雞頭B: "94000002",
  安員: "95000001",
};

export function roleNameForSlot(slot: TestUserSlot): RoleName {
  return slot.startsWith("雞頭") ? "雞頭" : (slot as RoleName);
}

export const TEST_USER_PASSWORD = "Fixture0Pwd";
