// P11.2：系統 vs Payroll Editor 逐人核對工具——合成 xls（3 個假人）＋合成 run。唔用真人資料。
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as XLSX from "xlsx";
import { prisma, clearAll } from "./lib/db";
import { parsePayrollEditorXls, loadSystemLines, comparePayrollEditor } from "../scripts/gate/lib/payroll-editor-compare";

const MONTH = new Date(Date.UTC(2026, 8, 1));
const HEADER = ["編號 No.", "員工賬戶銀行編號 Employee A/C Bank Code", "員工賬戶類型 Employee Account Type", "員工賬戶號碼 Employee A/C", "員工賬戶名稱 Employee Name", "金額 Amount", "備考號 Reference", "備註 Remark"];
const FAKE = [
  { staffNo: "T9001", name: "FAKE ALPHA", acct: "111-222-333", autopay: 15000.5 },
  { staffNo: "T9002", name: "FAKE BRAVO", acct: "444555666", autopay: 16000 },
  { staffNo: "T9003", name: "FAKE CHARLIE", acct: "777888999", autopay: 12000 },
];

function buildXls(rows: Array<(string | number)[]>, bookType: "biff8" | "xlsx" = "biff8"): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), "Payroll Editor 明細");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType }));
}

async function seedRun() {
  const run = await prisma.longtermPayrollRun.create({ data: { month: MONTH, status: "draft", createdBy: "test" } });
  for (const f of FAKE) {
    const g = await prisma.guard.create({ data: { nameZh: f.name, employmentType: "longterm_autopay", staffNo: f.staffNo, bankAccountNo: f.acct, createdBy: "test" } });
    await prisma.longtermPayrollLine.create({
      data: { runId: run.id, guardId: g.id, contractSnapshot: [], daysInMonth: 30, netBasic: f.autopay, gross: f.autopay, autopay: f.autopay },
    });
  }
}

describe("P11.2：Payroll Editor 核對", () => {
  beforeEach(async () => {
    await clearAll();
    await seedRun();
  });

  it("biff8 .xls：吻合／差額分桶／只一邊／最大差額", async () => {
    const buf = buildXls([
      [1, "012", "BBAN", "111222333", "FAKE ALPHA", 15000.5, "LT202609-T9001", "x"], // 吻合
      [2, "012", "BBAN", "444555666", "FAKE BRAVO", 16000.8, "LT202609-T9002", "x"], // +0.8（≤1）
      [3, "012", "BBAN", "000000000", "FAKE ZULU", 500, "LT202609-T9999", "x"], // 只喺 PE
    ]);
    const parsed = parsePayrollEditorXls(buf);
    expect(parsed.rows).toHaveLength(3);
    const r = comparePayrollEditor(parsed, await loadSystemLines(prisma, MONTH));
    expect(r.summary).toMatchObject({ payrollEditorRows: 3, systemLines: 3, matched: 2, equal: 1, differing: 1, onlyInPayrollEditor: 1, onlyInSystem: 1 });
    expect(r.summary.diffBuckets).toEqual({ within1: 1, from1To100: 0, over100: 0 });
    expect(r.summary.maxAbsDiff).toBe(0.8);
    expect(r.details.onlyInSystem[0].staffNo).toBe("T9003");
  });

  it("差額分佈 1–100／>100；無備考號時用戶口配對；xlsx 亦可讀", async () => {
    const buf = buildXls([
      [1, "012", "BBAN", "111-222-333", "A", 15050.5, "", ""], // 戶口配對，+50
      [2, "012", "BBAN", "444555666", "B", 17000, "LT202609-T9002", ""], // +1000
      [3, "012", "BBAN", "777888999", "C", 12000, "LT202609-T9003", ""],
    ], "xlsx");
    const r = comparePayrollEditor(parsePayrollEditorXls(buf), await loadSystemLines(prisma, MONTH));
    expect(r.summary.matched).toBe(3);
    expect(r.summary.diffBuckets).toEqual({ within1: 0, from1To100: 1, over100: 1 });
    expect(r.details.differing.find((d) => d.staffNo === "T9001")?.matchedBy).toBe("account");
    expect(r.summary.maxAbsDiff).toBe(1000);
  });

  it("重複 key 唔計入 onlyInPayrollEditor；金額讀唔到計入 badAmountRows；無明細／無表頭 throw；密碼保護中文提示", async () => {
    const buf = buildXls([
      [1, "012", "BBAN", "111222333", "A", 15000.5, "LT202609-T9001", ""],
      [2, "012", "BBAN", "111222333", "A", 15000.5, "LT202609-T9001", ""], // 重複
      [3, "012", "BBAN", "444555666", "B", "n/a", "LT202609-T9002", ""], // 金額讀唔到
    ]);
    const parsed = parsePayrollEditorXls(buf);
    expect(parsed.badAmountRows).toHaveLength(1);
    const r = comparePayrollEditor(parsed, await loadSystemLines(prisma, MONTH));
    expect(r.summary.duplicatePayrollEditorKeys).toBe(1);
    expect(r.summary.onlyInPayrollEditor).toBe(0);
    expect(r.details.duplicates).toHaveLength(1);
    expect(r.summary.badAmountRows).toBe(1);

    expect(() => parsePayrollEditorXls(buildXls([]))).toThrow(/冇讀到任何明細行/);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "S");
    expect(() => parsePayrollEditorXls(Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "biff8" })))).toThrow(/搵唔到表頭/);
    // 密碼保護：SheetJS 對帶 /encryption 流嘅 CFB 拋 "File is password-protected"
    const cfb = XLSX.CFB.utils.cfb_new();
    XLSX.CFB.utils.cfb_add(cfb, "/encryption", Buffer.alloc(8));
    expect(() => parsePayrollEditorXls(Buffer.from(XLSX.CFB.write(cfb, { type: "buffer" }) as Uint8Array))).toThrow(/有密碼保護/);
  });

  it("CLI：console 同 --out 檔唔含人名／戶口", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p11-"));
    const xls = path.join(dir, "pe.xls");
    const out = path.join(dir, "out.json");
    fs.writeFileSync(xls, buildXls(FAKE.map((f, i) => [i + 1, "012", "BBAN", f.acct, f.name, f.autopay + (i === 0 ? 5 : 0), `LT202609-${f.staffNo}`, "x"])));
    const res = spawnSync("npx", ["tsx", "scripts/gate/ltpay-vs-payrolleditor.ts", xls, "--month", "2026-09", "--out", out], { cwd: process.cwd(), encoding: "utf8", env: process.env });
    expect(res.status).toBe(0);
    const outText = fs.readFileSync(out, "utf8");
    for (const text of [res.stdout, res.stderr, outText]) {
      for (const f of FAKE) {
        expect(text).not.toContain(f.name);
        expect(text).not.toContain(f.acct.replace(/\D/g, ""));
        expect(text).not.toContain(f.acct);
      }
    }
    expect(res.stdout).toContain("吻合(±0.01) 2");
    const j = JSON.parse(outText);
    expect(j.summary.differing).toBe(1);
    expect(j.details.differing[0]).toMatchObject({ staffNo: "T9001", diff: 5 });
  }, 60000);
});
