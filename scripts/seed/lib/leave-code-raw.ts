// P1-WP3 第三輪規劃裁定（point B）：狀態代號保留原始字面——`LeaveCode`
// enum 已經擴充做 `tools/importer/mappings/status_codes.csv` 全部代號
// （見 prisma/schema.prisma）；呢個函數負責逐條 `record_type=leave` 嘅
// shift_record，由原檔（`data/2026-07/*.xlsx`）讀返嗰一格嘅原始字面
// （P0 wp2b 已經歸一過，DB 原本淨係存到歸一後嘅值），如果原始字面同
// DB 而家嘅值唔同（例：原檔寫「NPL」，DB 歸一咗做「NL」）就更新
// `leaveCode` 做返原始字面——冇任何 literal 寫死，全部 runtime 由
// `data/` 讀出。
import ExcelJS from "exceljs";
import type { PrismaClient, LeaveCode } from "@prisma/client";
import { DATA } from "./paths";
import fs from "node:fs";

const LABEL_COL: Record<string, number> = { standard: 6, digital_port: 7, citybus: 7 };
const KNOWN_LEAVE_CODES = new Set<string>(["RD", "OFF", "AL", "SL", "NL", "NPL", "SH"]);

function parseCellRow(cellRef: string): number | null {
  const m = cellRef.match(/^[A-Za-z]+(\d+)$/);
  return m ? Number(m[1]) : null;
}

function cellPlainText(cell: ExcelJS.Cell): string | null {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !(v instanceof Date)) {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      const s = (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
      return s || null;
    }
    if ("formula" in o || "sharedFormula" in o) {
      const r = cell.result;
      return typeof r === "string" ? r.trim() || null : null;
    }
    return null;
  }
  if (typeof v === "string") return v.trim() || null;
  return null;
}

export async function enrichLeaveCodeRawText(prisma: PrismaClient): Promise<{ updated: number; skippedReason?: string }> {
  const dataDir = DATA("2026-07");
  if (!fs.existsSync(dataDir)) {
    return { updated: 0, skippedReason: "data/2026-07/ 唔存在——跳過（唔會令成個 seed fail）" };
  }

  const records = await prisma.shiftRecord.findMany({
    where: { recordType: "leave" },
    include: { site: { select: { rosterLayout: true } } },
  });

  const workbookCache = new Map<string, ExcelJS.Workbook | null>();
  async function getWorkbook(file: string): Promise<ExcelJS.Workbook | null> {
    if (workbookCache.has(file)) return workbookCache.get(file)!;
    const filePath = `${dataDir}/${file}`;
    if (!fs.existsSync(filePath)) {
      workbookCache.set(file, null);
      return null;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    workbookCache.set(file, wb);
    return wb;
  }

  let updated = 0;
  for (const r of records) {
    const provenance = (r.provenance ?? {}) as Record<string, unknown>;
    const file = typeof provenance.file === "string" ? provenance.file : null;
    const cell = typeof provenance.cell === "string" ? provenance.cell : null;
    if (!file || !cell) continue;
    const row = parseCellRow(cell);
    if (row === null) continue;

    const template = r.site.rosterLayout as { layout?: string } | null;
    const layout = template && typeof template.layout === "string" ? template.layout : "standard";
    const labelCol = LABEL_COL[layout] ?? 6;
    const day = r.workDate.getUTCDate();
    const col = labelCol + day;

    const wb = await getWorkbook(file);
    if (!wb) continue;
    const ws = wb.getWorksheet("2026") ?? wb.worksheets[0];
    if (!ws) continue;

    const raw = cellPlainText(ws.getCell(row, col));
    if (!raw || !KNOWN_LEAVE_CODES.has(raw)) continue;
    if (raw === r.leaveCode) continue;

    await prisma.shiftRecord.update({ where: { id: r.id }, data: { leaveCode: raw as LeaveCode } });
    updated++;
  }

  return { updated };
}
