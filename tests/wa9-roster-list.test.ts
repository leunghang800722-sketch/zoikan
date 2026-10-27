// WA-9：文字名單偵測真值表（純函數）。全部合成姓名。
import { describe, it, expect } from "vitest";
import { detectRosterList } from "@/lib/whatsapp/roster-list";
import { scoreMessage } from "@/lib/whatsapp/filter";

const TS = new Date("2026-10-01T09:00:00Z"); // HK 2026-10-01 17:00
const DAWN = new Date("2026-09-30T18:30:00Z"); // HK 2026-10-01 02:30
const one = (t: string, ts = TS) => detectRosterList(t, ts)?.days[0] ?? null;
const names = (t: string, ts = TS) => one(t, ts)?.names.map((n) => (n.shift_hint ? `${n.raw}:${n.shift_hint}` : n.raw)) ?? null;

describe("detectRosterList 真值表", () => {
  it("老闆實例：d/m/yyyy 開頭＋空格分隔全名", () => {
    const r = detectRosterList("1/10/2026 孫測壹 陳測貳 許測叁 張測肆 梁測伍 徐測陸", TS)!;
    expect(r.days[0]!.date).toBe("2026-10-01");
    expect(r.confidence).toBe("high");
    expect(r.days[0]!.names.map((n) => n.raw)).toEqual(["孫測壹", "陳測貳", "許測叁", "張測肆", "梁測伍", "徐測陸"]);
  });
  it("多種日期寫法", () => {
    expect(one("2026-10-01 孫測壹 陳測貳", TS)?.date).toBe("2026-10-01");
    expect(one("10月1日 孫測壹 陳測貳", TS)?.date).toBe("2026-10-01");
    expect(one("1/10 孫測壹 陳測貳", TS)?.date).toBe("2026-10-01"); // 日/月
    expect(one("13/10/2026 孫測壹 陳測貳", TS)?.date).toBe("2026-10-13");
    expect(one("今日 孫測壹 陳測貳", TS)?.date).toBe("2026-10-01");
    expect(one("聽日 孫測壹 陳測貳", TS)?.date).toBe("2026-10-02");
    // 凌晨「今日」→ 降級（date null，date_raw 交 resolveIntents 出日期題）
    const dawn = one("今日 孫測壹 陳測貳", DAWN)!;
    expect(dawn.date).toBeNull();
    expect(dawn.date_raw).toBe("今日");
  });
  it("分隔符：換行／頓號／逗號／全形空格；名單可喺日期前後", () => {
    expect(names("1/10/2026\n孫測壹\n陳測貳\n許測叁")).toEqual(["孫測壹", "陳測貳", "許測叁"]);
    expect(names("1/10/2026 孫測壹、陳測貳，許測叁；張測肆")).toEqual(["孫測壹", "陳測貳", "許測叁", "張測肆"]);
    expect(names("孫測壹　陳測貳　1/10/2026")).toEqual(["孫測壹", "陳測貳"]);
  });
  it("花名／更碼後綴：「張三 D」「李四(夜)」「王五[N]」；整句更碼「夜更：…」", () => {
    expect(names("1/10/2026 張三 D 李四(夜) 王五[N] 陳大文")).toEqual(["張三:D", "李四:夜", "王五:N", "陳大文"]);
    expect(names("1/10/2026 夜更：張三 李四")).toEqual(["張三:夜更", "李四:夜更"]);
    // 名前面嘅更碼＝整句預設；接喺名後嘅更碼＝該名自己（覆寫預設）
    expect(names("1/10/2026 日 張三 李四 夜 王五 趙六")).toEqual(["張三:日", "李四:夜", "王五:日", "趙六:日"]);
  });
  it("10+ 人（含複姓、4 字名）", () => {
    const many = "孫測壹 陳測貳 許測叁 張測肆 梁測伍 徐測陸 歐陽小明 司徒嘉儀 黃大仙 李測捌 劉德華 郭測柒";
    const r = detectRosterList(`1/10/2026 ${many}`, TS)!;
    expect(r.days[0]!.names).toHaveLength(12);
    expect(r.days[0]!.names[6]!.raw).toBe("歐陽小明");
  });
  it("例外：請假／取消／替更／問句 → 唔當名單", () => {
    for (const t of ["1/10/2026 孫測壹 陳測貳 唔返", "聽日 孫測壹 陳測貳 病假", "1/10/2026 孫測壹 陳測貳 取消", "1/10/2026 孫測壹 替 陳測貳", "1/10/2026 孫測壹 陳測貳 返咩更?", "1/10/2026 孫測壹 SL"]) expect(detectRosterList(t, TS), t).toBeNull();
  });
  it("唔係名單：冇日期／得一個名／普通詞語／夾雜太多雜質", () => {
    for (const t of ["孫測壹 陳測貳 許測叁", "1/10/2026 孫測壹", "聽日 開會 準時", "1/10/2026 收到 多謝", "我聽日返早更 唔該曬", "聽日 3 點 開會 帶齊 文件 孫測壹 陳測貳"]) expect(detectRosterList(t, TS), t).toBeNull();
  });
  it("去重；姓名樣但偏門姓氏仍保留（名單成立後唔靜靜丟）", () => {
    expect(names("1/10/2026 孫測壹 孫測壹 陳測貳")).toEqual(["孫測壹", "陳測貳"]);
    expect(names("1/10/2026 孫測壹 陳測貳 許測叁 張測肆 梁測伍 徐測陸 轟小明")).toContain("轟小明");
  });
  it("filter：命中名單 → candidate、reason roster_list（唔經閾值）；請假句照舊", () => {
    const f = scoreMessage({ text: "1/10/2026 孫測壹 陳測貳 許測叁", groupKind: "site", groupActive: true, ts: TS });
    expect(f).toMatchObject({ decision: "candidate", reasons: ["roster_list"], score: 100 });
    const leave = scoreMessage({ text: "1/10/2026 孫測壹 陳測貳 病假", groupKind: "site", groupActive: true, ts: TS });
    expect(leave.reasons).not.toContain("roster_list");
    expect(scoreMessage({ text: "1/10/2026 孫測壹 陳測貳", groupKind: "ignored", ts: TS }).reasons).toEqual(["group_ignored"]);
  });
});
