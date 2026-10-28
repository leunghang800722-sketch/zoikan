// HIST-5 測試共用：假資料 builder（測試…名、U9xxxx 工號、fakeTel），零真資料、零讀 data/。
import ExcelJS from "exceljs";
import { prisma } from "../lib/db";
import { fakeTel } from "./fake-tel";
import { buildGuardFixPlan } from "@/lib/guard-fix/plan";
import { applyGuardFixPlan } from "@/lib/guard-fix/apply";
import type { GuardFixPlan } from "@/lib/guard-fix/types";

export const MAR = new Date(Date.UTC(2026, 2, 1));

export async function mkSite(name: string, parentSiteId: string | null = null) {
  return prisma.site.create({ data: { canonicalName: name, clientName: `${name}客戶`, billingModel: "per_shift", parentSiteId, createdBy: "test" } });
}

export async function mkShiftType(siteId: string, code: string, startHHMM: string | null, endHHMM: string | null, hours: number | null = 12) {
  const d = (hhmm: string | null) => (hhmm ? new Date(Date.UTC(1970, 0, 1, Number(hhmm.slice(0, 2)), Number(hhmm.slice(2, 4)))) : null);
  return prisma.shiftType.create({ data: { siteId, code, startTime: d(startHHMM), endTime: d(endHHMM), hours, billingGroup: "per_shift", createdBy: "test" } });
}

export async function mkGuard(opts: { name: string; aliases?: string[]; staffNo?: string; tel?: string | null; status?: "active" | "inactive"; createdBy?: string; createdAt?: Date }) {
  const g = await prisma.guard.create({
    data: { nameZh: opts.name, nameAliases: opts.aliases ?? [], employmentType: "cash_casual", status: opts.status ?? "active", createdBy: opts.createdBy ?? "test", ...(opts.createdAt ? { createdAt: opts.createdAt } : {}), tel: opts.tel ?? null },
  });
  if (opts.staffNo) {
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: opts.staffNo.match(/^[A-Z]+/)![0], number: opts.staffNo, status: "current", source: "test" } });
    await prisma.guard.update({ where: { id: g.id }, data: { staffNo: opts.staffNo } });
  }
  if (opts.tel) await prisma.guardPhone.create({ data: { guardId: g.id, tel: opts.tel, isPrimary: true, source: "test" } });
  return g;
}

export async function mkUpload(opts: { siteId: string; siteName: string; month?: Date; userId: string; status?: "parsed" | "confirmed" }) {
  return prisma.rosterUpload.create({
    data: { month: opts.month ?? MAR, siteId: opts.siteId, siteNameRaw: opts.siteName, uploaderUserId: opts.userId, fileName: `t-${Math.random()}.xlsx`, fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1, status: opts.status ?? "parsed" },
  });
}

let rowSeq = 100;
/** 直接插一格「未配對／多候選」行（唔經 parser）。day＝日（月內）；monthDate 預設 3 月。 */
export async function mkRow(opts: { uploadId: string; siteId: string; staffNo?: string | null; name: string; tel?: string | null; code?: string; kind?: "unmatched" | "ambiguous"; day?: number; month?: Date; rowIndex?: number; timeRaw?: string | null }) {
  const m = opts.month ?? MAR;
  rowSeq += 1;
  return prisma.rosterUploadRow.create({
    data: {
      uploadId: opts.uploadId,
      rowIndex: opts.rowIndex ?? rowSeq,
      workDate: new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), opts.day ?? 1)),
      rawCode: opts.code ?? "D",
      codeKind: "shift",
      resolvedSiteId: opts.siteId,
      staffNoRaw: opts.staffNo ?? null,
      nameRaw: opts.name,
      telRaw: opts.tel ?? null,
      timeRaw: opts.timeRaw ?? null,
      guardMatch: opts.kind ?? "unmatched",
    },
  });
}

/** 多格同一身份。 */
export async function mkRows(opts: Parameters<typeof mkRow>[0], count: number) {
  for (let i = 0; i < count; i++) await mkRow({ ...opts, day: (opts.day ?? 1) + i, rowIndex: opts.rowIndex });
}

export async function planAndApply(historical = true): Promise<{ plan: GuardFixPlan; diffs: Awaited<ReturnType<typeof applyGuardFixPlan>> }> {
  await prisma.broker.upsert({ where: { code: "Y" }, create: { code: "Y", name: "測試Y", kind: "internal_cash", settlementType: "cash", createdBy: "test" }, update: {} });
  const plan = await buildGuardFixPlan({ prisma, month: MAR, uTeamRows: [], historical });
  const diffs = await applyGuardFixPlan({ prisma, plan, planOnly: false, month: MAR, historicalRoster: historical });
  return { plan, diffs };
}

export { fakeTel };

// ---- 端到端（經 parser）用 ----
export interface RosterPerson {
  staffNo?: string;
  tel?: string;
  name: string;
  broker?: string;
  time?: string;
  rank?: string;
  codes: string[];
}

export async function rosterXlsx(opts: { site: string; people: RosterPerson[]; year?: number; month?: number; startDay?: number }): Promise<Buffer> {
  const year = opts.year ?? 2026;
  const month = opts.month ?? 3;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`${year}${String(month).padStart(2, "0")}`);
  ws.getCell("A2").value = opts.site;
  ws.getCell("F4").value = "Date";
  const ndays = opts.people[0]!.codes.length;
  for (let d = 0; d < ndays; d++) ws.getRow(4).getCell(7 + d).value = new Date(Date.UTC(year, month - 1, (opts.startDay ?? 1) + d));
  for (const [c, v] of [["A5", "Broker"], ["B5", "Time"], ["C5", "Rank"], ["D5", "Staff No."], ["E5", "Tel"], ["F5", "Name"]] as const) ws.getCell(c).value = v;
  opts.people.forEach((p, i) => {
    const r = 6 + i;
    if (p.broker) ws.getCell(`A${r}`).value = p.broker;
    if (p.time) ws.getCell(`B${r}`).value = p.time;
    ws.getCell(`C${r}`).value = p.rank ?? "日更保安員";
    if (p.staffNo) ws.getCell(`D${r}`).value = p.staffNo;
    if (p.tel) ws.getCell(`E${r}`).value = p.tel;
    ws.getCell(`F${r}`).value = p.name;
    p.codes.forEach((code, d) => {
      if (code) ws.getRow(r).getCell(7 + d).value = code;
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 最少 U Team 名單（一個無關人）——令 guard_fix step 唔會因為「未上載名單」而略過。 */
export async function seedStaffList(userId: string): Promise<void> {
  const sl = new ExcelJS.Workbook();
  const ws = sl.addWorksheet("sheet1");
  ws.getRow(1).getCell(14).value = "員工編號";
  ws.getRow(2).getCell(14).value = "U99999";
  ws.getRow(2).getCell(16).value = "測試名單無關人";
  ws.getRow(2).getCell(10).value = fakeTel();
  await prisma.staffListUpload.create({ data: { uploaderId: userId, fileName: "u.xlsx", fileSha256: `u-${Math.random()}`, fileBytes: new Uint8Array(Buffer.from(await sl.xlsx.writeBuffer())), fileSize: 10, rowCount: 1, status: "parsed" } });
}
