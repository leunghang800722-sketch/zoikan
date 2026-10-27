// WA-9 (7)：真數據格式特徵（全部假名）——多日累積名單解析、預定更表、短訊分類、O→0 修正、判頭群 assume_today。
import { describe, it, expect } from "vitest";
import { detectRosterList, detectRosterPlan, refineNames } from "@/lib/whatsapp/roster-list";
import { classifyText, fixOcrDigits, normalizeReportText } from "@/lib/whatsapp/report-kinds";
import { scoreMessage } from "@/lib/whatsapp/filter";
import { normNameVariant } from "@/lib/names/variants";

const TS = new Date("2026-10-27T05:00:00Z"); // HK 2026-10-27 13:00
const A = "孫測壹", B = "陳測貳", C = "許測叁", D = "黃測肆", E = "謝測伍", F = "劉測陸";
const days = (r: ReturnType<typeof detectRosterList>) => r?.days.map((d) => `${d.date}:${d.names.map((n) => n.raw).join("+")}`) ?? null;

describe("detectRosterList v2：多日累積名單", () => {
  it("標題行忽略；粗體星號＋尾空格；逐日一行日期＋一行名", () => {
    const t = `*10月 報開工請打自己名 傳送簽到表及打卡記錄*\n\n*01/10/2026*\n${A} ${B} ${C}\n*02/10/2026* \n${B} ${A}\n*03/10/2026*  \n${C} ${A}`;
    const r = detectRosterList(t, TS)!;
    expect(r.kind).toBe("roster_list");
    expect(r.header_lines).toBe(1);
    expect(days(r)).toEqual([`2026-10-01:${A}+${B}+${C}`, `2026-10-02:${B}+${A}`, `2026-10-03:${C}+${A}`]);
  });
  it("2O26／1O（英文 O 代 0）、全形斜線、日期無年份", () => {
    const r = detectRosterList(`23/1O/2O26\n${A} ${B}\n24／10／2026\n${B} ${C}\n25/10\n${A} ${C}`, TS)!;
    expect(r.days.map((d) => d.date)).toEqual(["2026-10-23", "2026-10-24", "2026-10-25"]);
  });
  it("轉發前綴剝走；同一日期出現兩次（拼埋兩段）以後者為準", () => {
    const t = `[18/10 20:17] [電話已遮]: 10月開始 報開工\n1/10/2026\n${A} ${B}\n2/10/2026\n${A} ${C}\n1/10/2026\n${A} ${B} ${D}\n2/10/2026\n${A} ${C} ${D}`;
    const r = detectRosterList(t, TS)!;
    expect(r.days).toHaveLength(2);
    expect(r.days.find((d) => d.date === "2026-10-01")!.names.map((n) => n.raw)).toEqual([A, B, D]);
  });
  it("名行雜質：雙空格、尾句號、同日重複、姓同名分開、簡體同繁體", () => {
    const r = detectRosterList(`27/10/2026\n${A}  ${B}.  ${A} 許 測叁 谢测伍`, TS)!;
    expect(r.days[0]!.names.map((n) => n.raw)).toEqual([A, B, "許測叁", "谢测伍"]);
    expect(normNameVariant("谢测伍")).toBe(normNameVariant(E));
  });
  it("黏名（兩個名黏埋）：detect 保留，有已知名集就拆開；拆唔到原樣保留", () => {
    const known = new Set([A, B, C, E].map(normNameVariant));
    const r = detectRosterList(`27/10/2026\n${A}${B} ${C} 谢测伍${A}`, TS, { knownNames: known })!;
    expect(r.days[0]!.names.map((n) => n.raw)).toEqual([A, B, C, "谢测伍", A].filter((x, i, a) => a.indexOf(x) === i));
    const raw = detectRosterList(`27/10/2026\n${A}${B} ${C}`, TS)!;
    expect(raw.days[0]!.names.map((n) => n.raw)).toEqual([`${A}${B}`, C]);
    expect(refineNames([{ raw: `${A}${B}`, shift_hint: null }], known).map((n) => n.raw)).toEqual([A, B]);
  });
  it("長名單：27 日、55 行、>1,200 字都得；超過 31 日／8,000 字唔當名單", () => {
    const d = (n: number) => `*${String(n).padStart(2, "0")}/10/2026*\n${[A, B, C, D, E, F, `${A}`, B, C, D, E, F].join(" ")}`;
    const t = "*10月 報開工*\n\n" + Array.from({ length: 27 }, (_, i) => d(i + 1)).join("\n");
    expect(t.split("\n").length).toBeGreaterThanOrEqual(55);
    const r = detectRosterList(t, TS)!;
    expect(r.days).toHaveLength(27);
    expect(r.days[0]!.names).toHaveLength(6); // 同日重複去重
    expect(detectRosterList("x".repeat(8100), TS)).toBeNull();
    const many = Array.from({ length: 32 }, (_, i) => `${String((i % 28) + 1).padStart(2, "0")}/${i < 28 ? "10" : "09"}/2026\n${A} ${B}`).join("\n");
    expect(detectRosterList(many, TS)).toBeNull();
  });
  it("含請假／替更／問號嘅日子唔當名單；其餘日子照用", () => {
    const r = detectRosterList(`1/10/2026\n${A} ${B}\n2/10/2026\n${A} ${B} 病假\n3/10/2026\n${A} ${C}`, TS)!;
    expect(r.days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-03"]);
    expect(detectRosterList(`1/10/2026\n${A} ${B} 病假`, TS)).toBeNull();
  });
});

describe("detectRosterPlan：預定更表（日序名單）", () => {
  it("`20 名 名`、兩段（空行分隔）；日 ≥ 今日日數 → 本月，否則下月", () => {
    const p = detectRosterPlan(`27 ${A} ${B} ${C}\n\n5 ${A} ${D} ${E}`, TS)!;
    expect(p.kind).toBe("roster_plan");
    expect(p.days.map((d) => d.date)).toEqual(["2026-10-27", "2026-11-05"]);
    expect(p.days[0]!.names).toEqual([A, B, C]);
  });
  it("唔係：有日期斜線、夾雜普通句子、得一個名、請假", () => {
    for (const t of [`1/10/2026 ${A} ${B}`, `5 開會 帶齊 文件`, `20 ${A}`, `20 ${A} ${B} 病假`, `今日 20 ${A} ${B}`]) expect(detectRosterPlan(t, TS), t).toBeNull();
  });
});

describe("短訊分類", () => {
  it("相 caption：報開工／返工／開工／收工／報收工", () => {
    expect(classifyText(`${A}報開工`)).toEqual({ kind: "name_caption", name: A, action: "checkin" });
    expect(classifyText("趙測柒開工")).toEqual({ kind: "name_caption", name: "趙測柒", action: "checkin" });
    expect(classifyText(`${B}返工`)).toMatchObject({ action: "checkin" });
    expect(classifyText(`${C}收工`)).toEqual({ kind: "name_caption", name: C, action: "checkout" });
    expect(classifyText(`${C}報收工🙏`)).toMatchObject({ action: "checkout" });
    expect(classifyText("今日開工")).toBeNull(); // 唔係姓名
  });
  it("A代B、多日假期、月度摘要、純問句", () => {
    expect(classifyText(`${A}代${B}`)).toEqual({ kind: "substitution", worker: A, replaced: B });
    expect(classifyText(`${C}11月份假期3,12,18,26🙏🙏`)).toEqual({ kind: "leave_notice", name: C, month: 11, days: [3, 12, 18, 26] });
    expect(classifyText(`${D}10月份返測試廠考勤紀錄，休息6日：2，11，12，16，23，30`)).toMatchObject({ kind: "attendance_summary", month: 10, rest_days: [2, 11, 12, 16, 23, 30], claimed: 6 });
    expect(classifyText(`請問今早${A}有無返🙏`)).toEqual({ kind: "plain_question" });
  });
  it("工號／日期 token 內 O→0（唔改全文）；時間範圍連字號統一", () => {
    expect(fixOcrDigits("U9OO11 梁測伍 22/1O/2026 數碼港夜更報開工")).toBe("U90011 梁測伍 22/10/2026 數碼港夜更報開工");
    expect(fixOcrDigits("U9O011梁測伍23/1O/2O26數碼港夜更報開工")).toBe("U90011梁測伍23/10/2026數碼港夜更報開工");
    expect(fixOcrDigits("OK 聽日 Open 1O點")).toBe("OK 聽日 Open 1O點");
    expect(normalizeReportText("U90222測試廠日更0700一1900")).toBe("U90222測試廠日更0700-1900");
    expect(normalizeReportText("測試園2200—0615上班")).toBe("測試園2200-0615上班");
  });
});

describe("filter：新 reason", () => {
  const base = { groupActive: true, ts: TS };
  it("相 caption／代班／假期／摘要 → candidate；純問句 → ignore", () => {
    expect(scoreMessage({ ...base, groupKind: "site", mediaType: "image", text: `${A}報開工` })).toMatchObject({ decision: "candidate", reasons: ["name_shift_caption"] });
    expect(scoreMessage({ ...base, groupKind: "site", text: `${A}代${B}` }).reasons).toEqual(["substitution_notice"]);
    expect(scoreMessage({ ...base, groupKind: "site", text: `${C}11月份假期3,12` }).reasons).toEqual(["leave_notice"]);
    expect(scoreMessage({ ...base, groupKind: "site", text: `請問今早${A}有無返🙏` })).toMatchObject({ decision: "ignore", reasons: ["plain_question"] });
    expect(scoreMessage({ ...base, groupKind: "site", text: `20 ${A} ${B} ${C}` })).toMatchObject({ decision: "candidate", reasons: ["roster_plan"] });
  });
  it("累積名單（>300 字）唔被 long_forward 扣走", () => {
    const t = "*10月 報開工*\n" + Array.from({ length: 20 }, (_, i) => `*${String(i + 1).padStart(2, "0")}/10/2026*\n${A} ${B} ${C} ${D} ${E} ${F}`).join("\n");
    expect(t.length).toBeGreaterThan(300);
    expect(scoreMessage({ ...base, groupKind: "site", text: t }).reasons).toEqual(["roster_list"]);
  });
  it("盤別名先做字形折疊：別名「厚德」配到「厚徳商場」（異體字）", () => {
    const f = (text: string) => scoreMessage({ ...base, groupKind: "multi_site", siteAliases: ["厚德"], text });
    expect(f("5號 厚徳商場 夜更").reasons).toContain("site_alias");
    expect(f("5號 厚德商場 夜更").reasons).toContain("site_alias");
    expect(f("5號 別處商場 夜更").reasons).not.toContain("site_alias");
  });
  it("判頭群冇日期＝今日：(盤別名｜工號 token｜已知姓名) ＋ (更次詞｜HHMM-HHMM，容許「一」)", () => {
    const aliases = ["測試廠", "測試園"];
    const f = (text: string, extra: object = {}) => scoreMessage({ ...base, groupKind: "broker", siteAliases: aliases, text, ...extra });
    expect(f("U90222測試廠日更0700一1900")).toMatchObject({ decision: "candidate" });
    expect(f("U90222測試廠日更0700一1900").reasons).toContain("assume_today");
    expect(f(`${A}報測試園2200-0615上班`).reasons).toContain("assume_today");
    expect(f(`欣明夜更${A}`, { nameHit: true })).toMatchObject({ decision: "candidate" });
    expect(f("測試廠日更").reasons).toContain("assume_today"); // 盤別名＋更次詞
    // 有日期就唔係 assume_today；非判頭群唔套用
    expect(f("5號U90222測試廠日更").reasons).not.toContain("assume_today");
    expect(scoreMessage({ ...base, groupKind: "site", siteAliases: aliases, text: "U90222測試廠日更0700一1900" }).reasons).not.toContain("assume_today");
    // 冇任何身份訊號
    expect(f("日更0700一1900").decision).toBe("ignore");
  });
});
