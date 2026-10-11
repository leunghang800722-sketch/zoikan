// P8.3：鎖月後自動生成嘅匯出檔——種類定義（對應原匯出 route 嘅權限 module）＋存檔 helper。
// 內容一律由現有匯出 lib 生成（writePayrollBuffer／writeMonthlyCloseBuffer／buildPostorderWorkbook／buildBochkAutopayWorkbook），
// 同人手匯出 route 同一份數據、同一份 code；呢度唔重算任何數字。
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { monthLabel } from "@/lib/reports/money";
import { writePayrollBuffer } from "@/lib/reports/payroll";
import { writeMonthlyCloseBuffer } from "@/lib/reports/monthly-close";
import { buildPostorderWorkbook } from "@/lib/reports/postorder-export";
import { buildBochkAutopayWorkbook } from "@/lib/longterm-payroll/bochk-autopay-export";
import type { Module } from "@/lib/rbac/matrix";

export const FILE_KINDS = ["payroll_detail", "monthly_close", "postorder", "longterm_autopay"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_KIND_META: Record<FileKind, { label: string; module: Module }> = {
  payroll_detail: { label: "糧明細 Excel", module: "糧明細" },
  monthly_close: { label: "月結總表 Excel", module: "月結總表" },
  postorder: { label: "Postorder 格式總表", module: "月結總表" },
  longterm_autopay: { label: "BOCHK autopay 檔（長工糧）", module: "長工糧" },
};

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const AFTER_LOCK_EXPORTS_BY = "job:after_lock_exports";

export interface BuiltFile {
  filename: string;
  content: Buffer;
}

/** 生成某種檔；長工糧未計過（無 longterm_payroll_run）→ null（呼叫方標 skipped）。其他錯誤照拋。 */
export async function buildFile(kind: FileKind, month: Date): Promise<BuiltFile | null> {
  const label = monthLabel(month);
  switch (kind) {
    case "payroll_detail":
      return { filename: `payroll-${label}.xlsx`, content: await writePayrollBuffer(month) };
    case "monthly_close":
      return { filename: `monthly-close-${label}.xlsx`, content: await writeMonthlyCloseBuffer(month) };
    case "postorder": {
      const r = await buildPostorderWorkbook(month);
      return { filename: `Postorder - ${label}.xlsx`, content: Buffer.from(await r.workbook.xlsx.writeBuffer()) };
    }
    case "longterm_autopay": {
      const run = await prisma.longtermPayrollRun.findFirst({ where: { month, voidedAt: null, status: { not: "void" } }, select: { id: true } });
      if (!run) return null;
      const r = await buildBochkAutopayWorkbook(month);
      return { filename: `longterm-autopay-BOCHK-PayrollEditor-${r.month}.xlsx`, content: Buffer.from(await r.workbook.xlsx.writeBuffer()) };
    }
  }
}

/** 存檔：同月同 kind 取代 current（舊版 current=false 保留 1 份，更舊嘅刪走）。 */
export async function saveGeneratedFile(input: { month: Date; kind: FileKind; file: BuiltFile; generatedBy: string; sourceLockedAt: Date | null }): Promise<string> {
  const sha256 = createHash("sha256").update(input.file.content).digest("hex");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`generated_files:${input.month.toISOString().slice(0, 10)}:${input.kind}`}, 0))`;
    await tx.generatedFile.updateMany({ where: { month: input.month, kind: input.kind, current: true }, data: { current: false } });
    const created = await tx.generatedFile.create({
      data: {
        month: input.month,
        kind: input.kind,
        filename: input.file.filename,
        content: new Uint8Array(input.file.content),
        size: input.file.content.length,
        sha256,
        generatedBy: input.generatedBy,
        sourceLockedAt: input.sourceLockedAt,
        current: true,
      },
      select: { id: true },
    });
    // 保留 1 份舊版：non-current 按時間新→舊，第 2 份起刪
    const olds = await tx.generatedFile.findMany({ where: { month: input.month, kind: input.kind, current: false }, orderBy: [{ generatedAt: "desc" }, { id: "desc" }], select: { id: true } });
    if (olds.length > 1) await tx.generatedFile.deleteMany({ where: { id: { in: olds.slice(1).map((o) => o.id) } } });
    return created.id;
  });
}
