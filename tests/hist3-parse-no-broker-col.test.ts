// HIST-3 目標 1：舊模板（雞頭碼欄位置直接係時段、隔籬係職級、再隔籬制服尺碼）——
// 雞頭碼欄值全部係 HHMM-HHMM 時段 → 當冇雞頭碼欄（noBrokerCol），time／rank 向左移一格。
// 全部合成 fixture（exceljs 生成），零 PII、零讀 data/。
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseRosterWorkbook } from "@/lib/roster-upload/parse";

const DAYS = [1, 2, 3].map((d) => new Date(Date.UTC(2026, 0, d)));

interface PersonSpec {
  col2: string | null; // digital_port 雞頭碼欄位置
  col3: string | null; // 時段欄位置
  col4: string | null; // 職級欄位置
  staffNo: string;
  name: string;
  codes: string[];
}

/** digital_port 排法：Name 喺 H 欄，B=雞頭碼欄、C=時段、D=職級、E=工號、F=Tel、G=英文名（表頭留空）。 */
async function digitalPortXlsx(people: PersonSpec[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("202601");
  ws.getCell("A2").value = "測試舊模板盤";
  ws.getCell("H4").value = "Date";
  DAYS.forEach((dt, i) => {
    ws.getRow(4).getCell(9 + i).value = dt;
  });
  ws.getCell("F5").value = "Tel";
  ws.getCell("H5").value = "Name";
  people.forEach((p, i) => {
    const r = 6 + i;
    if (p.col2) ws.getCell(`B${r}`).value = p.col2;
    if (p.col3) ws.getCell(`C${r}`).value = p.col3;
    if (p.col4) ws.getCell(`D${r}`).value = p.col4;
    ws.getCell(`E${r}`).value = p.staffNo;
    ws.getCell(`H${r}`).value = p.name;
    p.codes.forEach((c, d) => {
      ws.getRow(r).getCell(9 + d).value = c;
    });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("roster parse：雞頭碼欄係時段（舊模板）", () => {
  it("雞頭碼欄全部係時段 → brokerCode=null、timeRaw=時段、rankRaw=職級，layoutKey 帶 no-broker-col", async () => {
    // 舊模板：B=時段、C=職級、D=制服尺碼
    const buf = await digitalPortXlsx([
      { col2: "1930-0730", col3: "夜更保安員", col4: "M", staffNo: "U91001", name: "測試甲", codes: ["N", "N", "N"] },
      { col2: "0730-1930", col3: "早Zone IC", col4: "XL", staffNo: "U91002", name: "測試乙", codes: ["IC", "IC", "IC"] },
    ]);
    const r = await parseRosterWorkbook(buf, "old-template.xlsx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(6);
    expect(r.rows.every((x) => x.brokerCodeRaw === null)).toBe(true);
    const a = r.rows.find((x) => x.nameRaw === "測試甲")!;
    expect(a.timeRaw).toBe("1930-0730");
    expect(a.rankRaw).toBe("夜更保安員");
    expect(a.staffNoRaw).toBe("U91001");
    const b = r.rows.find((x) => x.nameRaw === "測試乙")!;
    expect(b.timeRaw).toBe("0730-1930");
    expect(b.rankRaw).toBe("早Zone IC");
    expect(r.layoutKey).toContain("no-broker-col");
    expect(r.sheets[0]!.noBrokerCol).toBe(true);
  });

  it("雞頭碼欄有真雞頭碼 → 照舊（brokerCode／time／rank 各歸各位）", async () => {
    const buf = await digitalPortXlsx([
      { col2: "K", col3: "1930-0730", col4: "夜更保安員", staffNo: "U91001", name: "測試甲", codes: ["N", "N", "N"] },
      { col2: "W", col3: "0730-1930", col4: "早更保安員", staffNo: "U91002", name: "測試乙", codes: ["D", "D", "D"] },
    ]);
    const r = await parseRosterWorkbook(buf, "new-template.xlsx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.rows.find((x) => x.nameRaw === "測試甲")!;
    expect(a.brokerCodeRaw).toBe("K");
    expect(a.timeRaw).toBe("1930-0730");
    expect(a.rankRaw).toBe("夜更保安員");
    expect(r.layoutKey).not.toContain("no-broker-col");
  });

  it("雞頭碼欄只要有一個唔係時段 → 唔移欄（保守）", async () => {
    const buf = await digitalPortXlsx([
      { col2: "1930-0730", col3: "夜更保安員", col4: "M", staffNo: "U91001", name: "測試甲", codes: ["N", "N", "N"] },
      { col2: "K", col3: "0730-1930", col4: "早更保安員", staffNo: "U91002", name: "測試乙", codes: ["D", "D", "D"] },
    ]);
    const r = await parseRosterWorkbook(buf, "mixed.xlsx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.find((x) => x.nameRaw === "測試甲")!.brokerCodeRaw).toBe("1930-0730");
    expect(r.layoutKey).not.toContain("no-broker-col");
  });

  it("雞頭碼欄全空 → 唔當時段欄（唔移欄）", async () => {
    const buf = await digitalPortXlsx([{ col2: null, col3: "1930-0730", col4: "夜更保安員", staffNo: "U91001", name: "測試甲", codes: ["N", "N", "N"] }]);
    const r = await parseRosterWorkbook(buf, "empty-broker.xlsx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.rows[0]!;
    expect(a.brokerCodeRaw).toBeNull();
    expect(a.timeRaw).toBe("1930-0730");
    expect(a.rankRaw).toBe("夜更保安員");
  });
});
