// 載入交叉核對來源：U Team 名單、Maxwell 前線名單、dev DB guards。全部只喺記憶體，唔寫出 PII。
import { promises as fs } from 'node:fs';
import ExcelJS from 'exceljs';
import { PrismaClient } from '@prisma/client';
import { canonicalHkid } from './hkid';
import { parseLooseDate } from './compare';
import { parseMaxwellWorkbook } from '@/lib/longterm-payroll/maxwell-import';

export interface RefRow {
  src: 'utem' | 'maxwell' | 'db';
  ref: string; // 內部定位用（行號／guard id 前綴），唔含 PII
  staffNos: string[];
  hkid: string | null;
  nameZh: string | null;
  nameEn: string | null;
  dob: string | null;
  tels: string[];
  addresses: string[];
}

function cell(row: ExcelJS.Row, c: number): string | null {
  const v: unknown = row.getCell(c).value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const o = v as Record<string, unknown>;
    if ('richText' in o) return (o.richText as { text?: string }[]).map((t) => t.text ?? '').join('').trim() || null;
    if ('result' in o) return o.result === null || o.result === undefined ? null : String(o.result).trim() || null;
    return null;
  }
  return String(v).trim() || null;
}

export async function loadUTeam(file: string): Promise<RefRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  const out: RefRow[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const no = (cell(row, 14) ?? cell(row, 1))?.toUpperCase().replace(/\s+/g, '') ?? null;
    const nameZh = cell(row, 16);
    if (!no && !nameZh) continue;
    const sur = cell(row, 17);
    const giv = cell(row, 18);
    out.push({
      src: 'utem',
      ref: `utem:${r}`,
      staffNos: no ? [no] : [],
      hkid: canonicalHkid(cell(row, 15)),
      nameZh,
      nameEn: [sur, giv].filter(Boolean).join(' ') || null,
      dob: parseLooseDate(cell(row, 19)),
      tels: [cell(row, 10)].filter((x): x is string => !!x),
      addresses: [cell(row, 20)].filter((x): x is string => !!x),
    });
  }
  return out;
}

export async function loadMaxwell(file: string): Promise<RefRow[]> {
  const parsed = await parseMaxwellWorkbook(await fs.readFile(file));
  return parsed.rows.map((m) => ({
    src: 'maxwell' as const,
    ref: `maxwell:${m.sheetRow}`,
    staffNos: m.staffNo ? [m.staffNo.toUpperCase().replace(/\s+/g, '')] : [],
    hkid: null,
    nameZh: m.name,
    nameEn: m.nameEn,
    dob: m.dob,
    tels: m.tel ? [m.tel] : [],
    addresses: [],
  }));
}

export async function loadDb(): Promise<RefRow[]> {
  const prisma = new PrismaClient();
  try {
    const gs = await prisma.guard.findMany({
      select: {
        id: true,
        nameZh: true,
        nameEn: true,
        hkid: true,
        dateOfBirth: true,
        tel: true,
        staffNumbers: { select: { number: true } },
        phones: { select: { tel: true } },
        addresses: { select: { address: true } },
      },
    });
    return gs.map((g) => ({
      src: 'db' as const,
      ref: `db:${g.id.slice(0, 8)}`,
      staffNos: g.staffNumbers.map((s) => s.number.toUpperCase()),
      hkid: canonicalHkid(g.hkid),
      nameZh: g.nameZh,
      nameEn: g.nameEn,
      dob: g.dateOfBirth ? g.dateOfBirth.toISOString().slice(0, 10) : null,
      tels: [g.tel, ...g.phones.map((p) => p.tel)].filter((x): x is string => !!x),
      addresses: g.addresses.map((a) => a.address),
    }));
  } finally {
    await prisma.$disconnect();
  }
}
