// WP-ONE-CLICK-AUTO 測試共用 helper——合成資料（盤名／保安員名全部「測試」開頭，工號 U9xxxx，電話 6xxxxxxx），
// 唔讀 data/，唔用真名。
import ExcelJS from "exceljs";
import type { BrokerKind, EmploymentType } from "@prisma/client";
import { prisma } from "./db";
import { processRosterUpload } from "@/lib/roster-upload/service";

export const SEPT = new Date(Date.UTC(2026, 8, 1));
export const AUG = new Date(Date.UTC(2026, 7, 1));
export const sep = (day: number): Date => new Date(Date.UTC(2026, 8, day));
export const aug = (day: number): Date => new Date(Date.UTC(2026, 7, day));

export async function mkBroker(code: string, kind: BrokerKind, extra: { aliases?: string[]; name?: string } = {}) {
  return prisma.broker.create({
    data: {
      code,
      name: extra.name ?? `測試雞頭${code}`,
      kind,
      settlementType: kind === "internal_longterm" ? "autopay" : kind === "external" ? "none" : "cash",
      isInternal: kind === "internal_cash" || kind === "internal_longterm",
      aliases: extra.aliases ?? [],
      createdBy: "test-one-click-auto",
    },
  });
}

let guardSeq = 0;
export async function mkGuard(opts: { name?: string; employmentType?: EmploymentType; defaultBrokerId?: string | null; staffNo?: string; tel?: string } = {}) {
  guardSeq++;
  const n = String(guardSeq).padStart(4, "0");
  return prisma.guard.create({
    data: {
      nameZh: opts.name ?? `測試保安員${n}`,
      staffNo: opts.staffNo ?? `U9${n}`,
      tel: opts.tel ?? `6${String(guardSeq).padStart(7, "0")}`,
      employmentType: opts.employmentType ?? "cash_casual",
      defaultBrokerId: opts.defaultBrokerId ?? null,
      createdBy: "test-one-click-auto",
    },
  });
}

export interface RosterLine {
  broker?: string;
  time?: string;
  rank?: string;
  staffNo: string;
  tel?: string;
  name: string;
  /** day-of-month → 代號 */
  codes: Record<number, string>;
}

/** 合成 standard layout 更表（A2 盤名、row4 日期、row5 表頭、row6 起逐個保安員）。 */
export async function buildRosterXlsx(siteRaw: string, month: Date, lines: RosterLine[], opts: { dayCount?: number } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("2026");
  ws.getCell("A2").value = siteRaw;
  const dayCount = opts.dayCount ?? Math.max(1, ...lines.flatMap((l) => Object.keys(l.codes).map(Number)));
  ws.getCell("F4").value = "Date";
  for (let d = 1; d <= dayCount; d++) ws.getCell(4, 6 + d).value = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), d));
  ws.getCell("A5").value = "Broker";
  ws.getCell("B5").value = "Time";
  ws.getCell("C5").value = "Rank";
  ws.getCell("D5").value = "Staff No.";
  ws.getCell("E5").value = "Tel";
  ws.getCell("F5").value = "Name";
  lines.forEach((l, i) => {
    const r = 6 + i;
    if (l.broker) ws.getCell(r, 1).value = l.broker;
    if (l.time) ws.getCell(r, 2).value = l.time;
    if (l.rank) ws.getCell(r, 3).value = l.rank;
    ws.getCell(r, 4).value = l.staffNo;
    if (l.tel) ws.getCell(r, 5).value = l.tel;
    ws.getCell(r, 6).value = l.name;
    for (const [day, code] of Object.entries(l.codes)) ws.getCell(r, 6 + Number(day)).value = code;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let fileSeq = 0;
export async function uploadRoster(args: { siteRaw: string; month: Date; lines: RosterLine[]; uploaderUserId: string; siteIdHint?: string | null; fileName?: string; dayCount?: number }) {
  fileSeq++;
  const buf = await buildRosterXlsx(args.siteRaw, args.month, args.lines, { dayCount: args.dayCount });
  return processRosterUpload({ fileBuffer: buf, fileName: args.fileName ?? `測試更表-${fileSeq}.xlsx`, month: args.month, siteIdHint: args.siteIdHint ?? null, uploaderUserId: args.uploaderUserId });
}

/** 直接起上載行（唔經 xlsx）——variance／settlement 單元測試用。 */
export async function seedUploadWithRows(opts: {
  month: Date;
  siteId: string | null;
  siteNameRaw: string;
  uploaderUserId: string;
  status?: "parsed" | "confirmed";
  parseSummary?: Record<string, unknown>;
  rows: Array<{
    day: number;
    rawCode?: string;
    codeKind?: "shift" | "ot" | "leave";
    shiftTypeId?: string | null;
    guardId?: string | null;
    staffNoRaw?: string | null;
    nameRaw?: string | null;
    rankRaw?: string | null;
    timeRaw?: string | null;
    settlementBrokerId?: string | null;
    brokerCodeRaw?: string | null;
    resolvedSiteId?: string | null;
  }>;
}) {
  fileSeq++;
  const upload = await prisma.rosterUpload.create({
    data: {
      month: opts.month,
      siteId: opts.siteId,
      siteNameRaw: opts.siteNameRaw,
      uploaderUserId: opts.uploaderUserId,
      fileName: `seed-${fileSeq}.xlsx`,
      fileSha256: `sha-${fileSeq}`,
      fileBytes: Buffer.from("x"),
      fileSize: 1,
      status: opts.status ?? "parsed",
      ...(opts.parseSummary ? { parseSummary: opts.parseSummary as never } : {}),
    },
  });
  if (opts.rows.length) {
    await prisma.rosterUploadRow.createMany({
      data: opts.rows.map((r, i) => ({
        uploadId: upload.id,
        rowIndex: i + 1,
        workDate: new Date(Date.UTC(opts.month.getUTCFullYear(), opts.month.getUTCMonth(), r.day)),
        rawCode: r.rawCode ?? "D",
        codeKind: r.codeKind ?? "shift",
        shiftTypeId: r.shiftTypeId ?? null,
        resolvedSiteId: r.resolvedSiteId === undefined ? opts.siteId : r.resolvedSiteId,
        guardId: r.guardId ?? null,
        guardMatch: r.guardId ? ("by_staff_no" as const) : ("unmatched" as const),
        staffNoRaw: r.staffNoRaw ?? null,
        nameRaw: r.nameRaw ?? null,
        rankRaw: r.rankRaw ?? null,
        timeRaw: r.timeRaw ?? null,
        settlementBrokerId: r.settlementBrokerId ?? null,
        brokerCodeRaw: r.brokerCodeRaw ?? null,
      })),
    });
  }
  return upload;
}

/** 起一張 PostOrder CSV（Google Sheets 匯出形狀）——表頭 + 若干崗位行；`block` 行只有 col A。
 * 欄：客戶名稱,Customer Code,物業名稱,更份,上單價,外判價,時間,<31 日>,Total Shift */
export function postorderCsv(lines: Array<{ block: string } | { label: string; prop?: string; shift?: "Day" | "Night" | "Middle"; client?: number | null; payout?: number | string | null; time?: string; total?: number }>): string {
  const header = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間", ...Array.from({ length: 31 }, (_, i) => `${i + 1}-9月`), "Total Shift"];
  const rows: string[][] = [[], [], [], [], [], [], header];
  const pad = (cells: string[]): string[] => {
    const out = [...cells];
    while (out.length < header.length) out.push("");
    return out;
  };
  for (const l of lines) {
    if ("block" in l) rows.push(pad([l.block]));
    else rows.push(pad([l.label, "", l.prop ?? "", l.shift ?? "Day", l.client === null || l.client === undefined ? "" : String(l.client), l.payout === null || l.payout === undefined ? "" : String(l.payout), l.time ?? "", ...Array.from({ length: 31 }, () => ""), String(l.total ?? 0)]));
  }
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => (r.length ? pad(r).map(q).join(",") : ",".repeat(header.length - 1))).join("\n");
}

export async function seedPostorder(month: Date, uploaderUserId: string, opts: { postorderCsv?: string; rosterCsv?: string } = {}) {
  return prisma.postorderUpload.create({
    data: {
      month,
      uploaderId: uploaderUserId,
      rowCount: 0,
      fileName: "測試 Postorder.csv",
      fileSha256: "p".repeat(64),
      fileBytes: Buffer.from("x"),
      fileSize: 1,
      status: "parsed",
      ...(opts.postorderCsv ? { postorderCsvBytes: Buffer.from(opts.postorderCsv, "utf-8") } : {}),
      ...(opts.rosterCsv ? { rosterCsvBytes: Buffer.from(opts.rosterCsv, "utf-8") } : {}),
    },
  });
}

/** 起一張 Roster 分頁 CSV（逐日 7 欄 block：日期／雞頭名／備註／其他／救更價／Unbilled／Paid）。
 * `days[day]` = 雞頭名原文，例如 "(2) PK"、"(8) 長工"。 */
export function rosterCsv(rows: Array<{ label: string; prop: string; shift: "Day" | "Night" | "Middle"; days: Record<number, string> }>): string {
  const dayHeader = (d: number) => [`${d}-9月`, "雞頭名", "備註", "其他", "救更價", "Unbilled (Y=1 /N = 0 )", "Paid (Y=1 /N = 0 )"];
  const header = ["客戶名稱", "Customer Code", "物業名稱", "更份", "上單價", "外判價", "時間", ...Array.from({ length: 31 }, (_, i) => dayHeader(i + 1)).flat()];
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) lines.push(",".repeat(header.length - 1));
  lines.push(header.map(q).join(","));
  for (const r of rows) {
    const cells = [r.label, "", r.prop, r.shift, "", "", ""];
    for (let d = 1; d <= 31; d++) {
      const b = r.days[d];
      cells.push(b ? r.prop : "", b ?? "", "", "", "", "", "");
    }
    lines.push(cells.map(q).join(","));
  }
  return lines.join("\n");
}
