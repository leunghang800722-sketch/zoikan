// EMP-P2：工號體系設定表（`staff_schemes`）讀取 helper。出糧方按體系（U＝Wilson 出糧、MP＝在勤出糧、MG＝在勤長工糧），
// 放設定表唔寫死；設定表讀唔到（未 migrate／被清）就跌返下面出廠預設，唔會令報表炒。
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";

type Db = PrismaClient | Prisma.TransactionClient;

export interface StaffSchemeInfo {
  code: string;
  labelZh: string;
  payerCode: string | null;
  payerLabelZh: string | null;
  payMethod: string | null;
  isFrontline: boolean;
  isLongterm: boolean;
  sort: number;
}

/** 出廠預設（同 migration 種子一致；設定表缺行時 fallback）。 */
const DEFAULTS: StaffSchemeInfo[] = [
  { code: "U", labelZh: "U（Wilson 盤）", payerCode: "wilson", payerLabelZh: "Wilson 出糧", payMethod: null, isFrontline: true, isLongterm: false, sort: 1 },
  { code: "MP", labelZh: "MP（在勤盤）", payerCode: "maxwell", payerLabelZh: "在勤出糧", payMethod: null, isFrontline: true, isLongterm: false, sort: 2 },
  { code: "MG", labelZh: "MG（在勤長工）", payerCode: "maxwell", payerLabelZh: "在勤長工糧", payMethod: "autopay", isFrontline: false, isLongterm: true, sort: 3 },
  { code: "MW", labelZh: "MW（在勤寫字樓）", payerCode: "maxwell", payerLabelZh: "在勤出糧", payMethod: null, isFrontline: false, isLongterm: false, sort: 4 },
];

export const STAFF_SCHEME_CODES = DEFAULTS.map((d) => d.code);

/** 讀全部體系（設定表優先，缺嘅 code 用出廠預設補）。key＝scheme code。 */
export async function loadStaffSchemes(db: Db = prisma): Promise<Map<string, StaffSchemeInfo>> {
  const rows = await db.staffScheme.findMany({ orderBy: { sort: "asc" } });
  const map = new Map<string, StaffSchemeInfo>(DEFAULTS.map((d) => [d.code, d]));
  for (const r of rows) map.set(r.code, r);
  return map;
}

/** 未知 scheme（例如將來自填）嘅顯示：label＝code，冇出糧方。 */
export function schemeInfoOf(map: ReadonlyMap<string, StaffSchemeInfo>, code: string | null): StaffSchemeInfo | null {
  if (!code) return null;
  return map.get(code) ?? { code, labelZh: code, payerCode: null, payerLabelZh: null, payMethod: null, isFrontline: true, isLongterm: false, sort: 99 };
}
