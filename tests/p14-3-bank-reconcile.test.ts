// P14.3：銀行 Payroll Editor 對數——合成 xls fixture（表頭第 11 行、英文名有空格、備考號全空/部分、1 行金額壞）。
// 唔用真人資料（測試甲乙、U9xxx）。
import { describe, it, expect, beforeEach } from "vitest";
import * as XLSX from "xlsx";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { compareBankToSystem, parseBankPayrollEditor, type BankRow, type SystemLineInfo } from "@/lib/longterm-payroll/bank-reconcile";
import { normalizeEnName } from "@/lib/longterm-payroll/name-norm";
import { POST as upload, GET as getResult } from "@/app/api/longterm/payroll/[month]/reconcile/route";
import { PATCH as patchRow } from "@/app/api/longterm/reconcile-rows/[id]/route";
import { buildMonthHealth } from "@/lib/ops/month-health";
import fs from "node:fs";
import path from "node:path";

const HEADER = ["編號", "員工賬戶銀行編號", "員工賬戶類型*", "員工賬戶號碼 *", "員工賬戶名稱", "金額 (HKD/…)", "備考號", "備註"];
function buildBank(rows: Array<[string, string, string | number, string]>, bookType: "biff8" | "xlsx" = "biff8"): Buffer {
  const aoa: unknown[][] = [["BOCHK Payroll Editor"], [], ["Company", "TEST CO"]];
  while (aoa.length < 10) aoa.push([]);
  aoa.push(HEADER);
  rows.forEach(([acct, name, amount, remark], i) => aoa.push([i + 1, "012", "BBAN", acct, name, amount, remark, ""]));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Payroll Editor");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType }));
}
const sys = (lineId: string, autopay: number, o: Partial<SystemLineInfo> = {}): SystemLineInfo => ({ lineId, guardId: `g-${lineId}`, autopay, staffNums: [], account: "", enNames: [], ...o });
const bank = (rowNo: number, amount: number | null, o: Partial<BankRow> = {}): BankRow => ({ rowNo, account: "", nameNorm: "", amount, remark: "", ...o });

describe("P14.3 純函數：解析＋配對", () => {
  it("parse：表頭第 11 行、行號保留、英文名有空格 normalize、金額壞標 null、空行／合計行跳過", () => {
    const buf = buildBank([
      ["111-222", "TEST ALPHA", 15000.5, ""],
      ["333444", "Test  Bravo", "abc", ""],
      ["", "", "", ""],
    ]);
    const p = parseBankPayrollEditor(buf);
    expect(p.sheetName).toBe("Payroll Editor");
    expect(p.headerRow).toBe(11);
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toMatchObject({ rowNo: 12, account: "111222", nameNorm: "TESTALPHA", amount: 15000.5, remark: "" });
    expect(p.rows[1]).toMatchObject({ rowNo: 13, nameNorm: "TESTBRAVO", amount: null });
    expect(normalizeEnName(" Test-Bravo ")).toBe("TESTBRAVO");
    // xlsx 亦得
    expect(parseBankPayrollEditor(buildBank([["1", "A B", 1, ""]], "xlsx")).rows).toHaveLength(1);
  });

  it("parse：密碼保護／亂檔／冇表頭 → 400 中文提示", () => {
    const cfb = XLSX.CFB.utils.cfb_new();
    XLSX.CFB.utils.cfb_add(cfb, "/EncryptionInfo", Buffer.from([4, 0, 4, 0, 0, 0, 0, 0]));
    XLSX.CFB.utils.cfb_add(cfb, "/EncryptedPackage", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    const enc = Buffer.from(XLSX.CFB.write(cfb, { type: "buffer" }) as Buffer);
    expect(() => parseBankPayrollEditor(enc)).toThrow(/另存冇密碼版本/);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "S");
    expect(() => parseBankPayrollEditor(Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" })))).toThrow(/搵唔到 Payroll Editor 表頭/);
  });

  it("配對次序 備考號 → 戶口 → 英文名；撞名用金額縮窄；容差 ±0.01；只一邊；零 autopay 不算 system_only；重複行", () => {
    const system = [
      sys("L1", 1000, { staffNums: ["U9701"], enNames: ["ONE"] }),
      sys("L2", 2000, { account: "22222222", enNames: ["TWO"] }),
      sys("L3", 3000, { enNames: ["THREE"] }),
      sys("L4", 4000), // 只喺系統
      sys("L5", 0), // 零 autopay，銀行冇 → 不算差異
      sys("L6", 5000, { enNames: ["SAME"] }),
      sys("L7", 6000, { enNames: ["SAME"] }),
      sys("L8", 7000, { enNames: ["EIGHT"] }),
    ];
    const rows: BankRow[] = [
      bank(12, 1000.01, { remark: "LT202608-U9701", nameNorm: "THREE" }), // 備考號先贏（姓名其實係 THREE）；差 0.01 → equal
      bank(13, 2000.8, { account: "22222222" }), // 戶口；diff 0.8
      bank(14, 2850, { nameNorm: "THREE" }), // 英文名（L3 未被用）；diff -150
      bank(15, 6000, { nameNorm: "SAME" }), // 撞名 → 金額縮窄 L7
      bank(16, 5000, { nameNorm: "SAME" }), // 剩 L6
      bank(17, 500, { nameNorm: "ZULU" }), // bank_only
      bank(18, null, { nameNorm: "EIGHT" }), // 金額壞
      bank(19, 1000, { remark: "LT202608-U9701" }), // 備考號重複 → bank_only
      bank(20, 9, { remark: "LT202607-U9701" }), // 備考號月份唔啱 → 唔用備考號
    ];
    const { rows: out, summary } = compareBankToSystem(rows, system, "2026-08");
    const by = (n: number) => out.find((r) => r.bankRowNo === n)!;
    expect(by(12)).toMatchObject({ guardId: "g-L1", matchBy: "remark", status: "equal", diff: 0.01 });
    expect(by(13)).toMatchObject({ guardId: "g-L2", matchBy: "account", status: "diff", diff: 0.8 });
    expect(by(14)).toMatchObject({ guardId: "g-L3", matchBy: "name_en", status: "diff", diff: -150 });
    expect(by(15)).toMatchObject({ guardId: "g-L7", status: "equal" });
    expect(by(16)).toMatchObject({ guardId: "g-L6", status: "equal" });
    expect(by(17)).toMatchObject({ status: "bank_only", guardId: null });
    expect(by(18)).toMatchObject({ status: "bank_only", bankAmount: null, note: "金額無法解析" });
    expect(by(19).status).toBe("bank_only");
    expect(by(20).status).toBe("bank_only");
    expect(out.filter((r) => r.status === "system_only").map((r) => r.systemLineId).sort()).toEqual(["L4", "L8"]);
    expect(summary).toMatchObject({ bank_rows: 9, system_lines: 8, matched: 5, equal: 3, bank_only: 4, system_only: 2, bad_amount_rows: 1, system_zero_skipped: 1 });
    expect(summary.diff).toEqual({ total: 2, le1: 1, le100: 0, gt100: 1 });
    expect(summary.match_by).toEqual({ remark: 1, account: 1, name_en: 3 });
  });
});

describe("P14.3 route：上載／GET／PATCH／CSV", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;
  let supervisor: string;
  const month = new Date(Date.UTC(2026, 7, 1));
  const url = "http://t/api/longterm/payroll/2026-08/reconcile";
  const ctx = { params: Promise.resolve({ month: "2026-08" }) };
  const ids: Record<string, string> = {};

  function form(buf: Buffer, name = "bank.xls") {
    const f = new FormData();
    f.set("file", new File([new Uint8Array(buf)], name));
    return f;
  }
  const post = (cookie: string, buf: Buffer) => upload(new Request(url, { method: "POST", headers: { cookie }, body: form(buf) }), ctx);
  const get = (cookie: string, q = "") => getResult(new Request(url + q, { headers: { cookie } }), ctx);

  async function seedRun() {
    const run = await prisma.longtermPayrollRun.create({ data: { month, status: "draft", createdBy: "test" } });
    const defs: Array<[string, { nameEn?: string; staffNo?: string; acct?: string }, number]> = [
      ["A", { nameEn: "Test Alpha", staffNo: "U9701" }, 15000],
      ["B", { nameEn: "Test Bravo", acct: "444555666" }, 16000],
      ["C", { nameEn: "Test Charlie Chan" }, 12000],
      ["D", { nameEn: "Test Delta" }, 9000],
    ];
    for (const [k, o, amt] of defs) {
      const g = await prisma.guard.create({ data: { nameZh: `測試${k}`, nameEn: o.nameEn, staffNo: o.staffNo, bankAccountNo: o.acct, employmentType: "longterm_autopay", createdBy: "test" } });
      ids[k] = g.id;
      await prisma.longtermPayrollLine.create({ data: { runId: run.id, guardId: g.id, contractSnapshot: [], daysInMonth: 31, workDays: 26, netBasic: amt, otAmount: 100, gross: amt, autopay: amt, notesJson: ["測試備註"] } });
    }
    return run;
  }
  const bankFile = () =>
    buildBank([
      ["0001", "TEST ALPHA", 15000, "LT202608-U9701"], // equal（備考號）
      ["444555666", "SOMEONE ELSE", 16000.8, ""], // 戶口，diff +0.8
      ["0003", "TEST CHARLIE  CHAN", 11850, ""], // 英文名，diff -150
      ["0009", "TEST ZULU", 500, ""], // bank_only
    ]);

  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    accountant = await sessionCookieForUser(fx.userIds["會計"]);
    supervisor = await sessionCookieForUser(fx.userIds["主管"]);
  });

  it("冇 run → 400；非 Excel → 400；主管 403", async () => {
    expect((await post(owner, bankFile())).status).toBe(400);
    await seedRun();
    expect((await post(supervisor, bankFile())).status).toBe(403);
    const bad = await upload(new Request(url, { method: "POST", headers: { cookie: owner }, body: form(Buffer.from("hello world")) }), ctx);
    expect(bad.status).toBe(400);
  });

  it("上載→summary→GET（差異行帶組成）→PATCH 標原因→未解釋遞減；bank_only 無姓名；系統銀行名只存 hash", async () => {
    await seedRun();
    const res = await post(accountant, bankFile());
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.summary).toMatchObject({ bank_rows: 4, system_lines: 4, matched: 3, equal: 1, bank_only: 1, system_only: 1, unresolved: 4 });
    expect(j.summary.diff).toEqual({ total: 2, le1: 1, le100: 0, gt100: 1 });
    expect(j.summary.totals).toMatchObject({ bank: 43350.8, system: 52000, matched_bank: 42850.8, matched_system: 43000 });
    expect(JSON.stringify(j)).not.toMatch(/ALPHA|ZULU|SOMEONE/);

    const g = await (await get(owner)).json();
    expect(g.reconciliation.stale).toBe(false);
    expect(g.rows.map((r: { status: string }) => r.status)).toEqual(["diff", "diff", "bank_only", "system_only", "equal"]);
    const big = g.rows[0];
    expect(big).toMatchObject({ diff: -150, match_by: "name_en", guard_staff_no: null });
    expect(big.guard_name).toBe("測試C");
    expect(big.components).toMatchObject({ net_basic: 12000, ot_amount: 100, autopay: 12000, work_days: 26 });
    const bo = g.rows.find((r: { status: string }) => r.status === "bank_only");
    expect(bo).toMatchObject({ guard_id: null, guard_name: null, bank_amount: 500, components: null });
    expect(JSON.stringify(g)).not.toMatch(/ZULU|SOMEONE|TEST ALPHA/);
    const dbRows = await prisma.longtermBankReconciliationRow.findMany();
    expect(dbRows.every((r) => r.bankNameNormHash === null || /^[0-9a-f]{64}$/.test(r.bankNameNormHash))).toBe(true);

    // PATCH
    const p = await patchRow(new Request("http://t/x", { method: "PATCH", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify({ reason_code: "attendance_day", reason_note: "備忘x" }) }), { params: Promise.resolve({ id: big.id }) });
    expect(p.status).toBe(200);
    expect((await p.json()).unresolved).toBe(3);
    const badCode = await patchRow(new Request("http://t/x", { method: "PATCH", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify({ reason_code: "nope" }) }), { params: Promise.resolve({ id: big.id }) });
    expect(badCode.status).toBe(400);
    const eqRow = g.rows.find((r: { status: string }) => r.status === "equal");
    const onEqual = await patchRow(new Request("http://t/x", { method: "PATCH", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify({ reason_code: "other" }) }), { params: Promise.resolve({ id: eqRow.id }) });
    expect(onEqual.status).toBe(400);
    expect((await (await get(owner)).json()).summary.unresolved).toBe(3);

    // CSV：只差異行、冇姓名
    const csv = await (await get(owner, "?format=csv")).text();
    expect(csv.split("\r\n").length).toBe(1 + 4);
    expect(csv).toContain("attendance_day");
    expect(csv).not.toMatch(/測試[A-D]|ALPHA|ZULU|SOMEONE/);

    // 重新上載同一檔：同人同差額嘅原因帶過嚟
    const again = await (await post(owner, bankFile())).json();
    expect(again.summary.unresolved).toBe(3);
    expect(await prisma.longtermBankReconciliation.count()).toBe(2);
  });

  it("重算後 run 換咗 → GET stale=true；月結體檢：未上載／N 項未解釋", async () => {
    await seedRun();
    const health0 = await buildMonthHealth(month, { userId: fx.userIds["老闆"], baseRole: "老闆" } as never);
    expect(health0.findings.find((f) => f.code === "bank_reconcile")).toMatchObject({ count: 1, severity: "info" });
    expect(health0.findings.find((f) => f.code === "bank_reconcile")!.message).toContain("未上載");
    await post(owner, bankFile());
    const health1 = await buildMonthHealth(month, { userId: fx.userIds["老闆"], baseRole: "老闆" } as never);
    expect(health1.findings.find((f) => f.code === "bank_reconcile")!.message).toBe("本月銀行對數：4 項未解釋");
    await prisma.longtermPayrollRun.updateMany({ data: { status: "void", voidedAt: new Date() } });
    await prisma.longtermPayrollRun.create({ data: { month, status: "draft", createdBy: "test" } });
    expect((await (await get(owner)).json()).reconciliation.stale).toBe(true);
  });

  it("未上載過 GET → reconciliation:null；migration 冇 gen_random_uuid／RAISE；SheetJS 只喺 server 檔", async () => {
    const j = await (await get(owner)).json();
    expect(j).toMatchObject({ reconciliation: null, summary: null, rows: [] });
    const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261015000000_p14_bank_reconciliation/migration.sql"), "utf8");
    expect(sql).not.toMatch(/gen_random_uuid/i);
    expect(sql).not.toMatch(/\bRAISE\b/);
    expect(sql).not.toMatch(/\bai\./);
    for (const f of ["src/lib/longterm-payroll/reconcile-reasons.ts", "src/lib/longterm-payroll/name-norm.ts"]) {
      expect(fs.readFileSync(path.join(process.cwd(), f), "utf8")).not.toMatch(/from "xlsx"/);
    }
  });
});
