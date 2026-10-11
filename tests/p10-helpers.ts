// P10 測試共用 fixture：合成長工＋崗位盤＋頂位更＋頂位輸入（全部假資料）。
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";

export const D = (m: number, d: number) => new Date(Date.UTC(2026, m - 1, d));
export const AUG_MONTH = D(8, 1);
export const SEP_MONTH = D(9, 1);

export interface P10Base {
  fx: Wp2Fixture;
  actorUserId: string;
  b07: { id: string };
  /** 外判雞頭（頂位更嘅 settlement）。 */
  ext: { id: string };
  /** 盤 A（長工固定崗位）、B／C／E（頂位盤）、AChild（A 嘅子盤）。 */
  sites: Record<"A" | "B" | "C" | "E" | "AChild", { id: string; name: string }>;
  st: Record<"A" | "B" | "C" | "E" | "AChild" | "CIC", string>;
}

export async function p10Base(): Promise<P10Base> {
  await clearAll();
  const fx = await seedWp2Fixture();
  const rnd = Math.random().toString(36).slice(2, 6);
  const mk = async (key: string, parentSiteId?: string) => {
    const name = `P10盤${key}-${rnd}`;
    const s = await prisma.site.create({ data: { canonicalName: name, clientName: "測試客戶", billingModel: "per_shift", parentSiteId: parentSiteId ?? null, createdBy: "test" } });
    return { id: s.id, name };
  };
  const A = await mk("A");
  const sites = { A, B: await mk("B"), C: await mk("C"), E: await mk("E"), AChild: await mk("AChild", A.id) };
  const st = { A: "", B: "", C: "", E: "", AChild: "", CIC: "" } as P10Base["st"];
  for (const k of ["A", "B", "C", "E", "AChild"] as const) st[k] = (await prisma.shiftType.create({ data: { siteId: sites[k].id, code: "N", hours: 12, createdBy: "test" } })).id;
  st.CIC = (await prisma.shiftType.create({ data: { siteId: sites.C.id, code: "SIC", hours: 12, billingGroup: "monthly_ic", createdBy: "test" } })).id;
  const b07 = await prisma.broker.create({ data: { code: `T-B07-${rnd}`, name: "測試內部長工桶", kind: "internal_longterm", settlementType: "salary", createdBy: "test" } });
  const ext = await prisma.broker.create({ data: { code: `T-EXT-${rnd}`, name: "測試外判雞頭", kind: "external", settlementType: "cash", createdBy: "test" } });
  return { fx, actorUserId: fx.userIds["老闆"], b07, ext, sites, st };
}

export async function mkLongterm(b: P10Base, name: string, opts: { post?: "A" | null; visa?: boolean } = {}) {
  const visa = opts.visa ? await prisma.broker.create({ data: { code: `T-V-${Math.random().toString(36).slice(2, 6)}`, name: "測試簽證雞頭", kind: "external", settlementType: "cash", createdBy: "test" } }) : null;
  const g = await prisma.guard.create({ data: { nameZh: name, employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), visaSponsoredByBrokerId: visa?.id ?? null, createdBy: "test" } });
  await prisma.guardLongtermContract.create({ data: { guardId: g.id, monthlySalary: 15500, effectiveFrom: new Date("2020-01-01"), effectiveTo: null, annualLeaveDays: 7, source: "manual", createdBy: b.actorUserId } });
  if (opts.post !== null) await prisma.guardLongtermPost.create({ data: { guardId: g.id, siteId: b.sites[opts.post ?? "A"].id, effectiveFrom: new Date("2020-01-01"), source: "manual", createdBy: b.actorUserId } });
  return g;
}

/** 喺某盤做一更（recordType=shift）。`ic`＝用該盤 IC 更別（只有盤 C 有）。 */
/** 頂位更（settlement＝外判雞頭，aggregate 口徑）；自己崗位更用 `ownAt`（settlement＝B07）。 */
export async function shiftAt(b: P10Base, guardId: string, site: keyof P10Base["sites"], date: Date, opts: { ic?: boolean; own?: boolean } = {}) {
  const stId = opts.ic && site === "C" ? b.st.CIC : b.st[site];
  return prisma.shiftRecord.create({ data: { workDate: date, siteId: b.sites[site].id, shiftTypeId: stId, guardId, settlementBrokerId: opts.own ? b.b07.id : b.ext.id, operationalBrokerId: opts.own ? b.b07.id : b.ext.id, recordType: "shift", createdBy: "test" } });
}

export async function coverInput(b: P10Base, guardId: string, month: Date, amount: number, note: string, status: "confirmed" | "draft" = "confirmed") {
  return prisma.longtermPayrollInput.create({ data: { month, guardId, kind: "other_allowance", amount, note, status, createdBy: b.actorUserId } });
}
