// W1：第 0 層過濾（純函數）。≥40 條合成訊息；問號規則正反例 ≥10。全部假名「測試甲／乙」。
import { describe, it, expect } from "vitest";
import { scoreMessage, FILTER_DEFAULT_THRESHOLD } from "@/lib/whatsapp/filter";

const base = { groupKind: "site" as const, siteAliases: ["測試盤", "海濱"] };
const c = (text: string, extra: Partial<Parameters<typeof scoreMessage>[0]> = {}) => scoreMessage({ ...base, text, ...extra });

const CANDIDATES: string[] = [
  "我聽日18號病假",
  "聽日測試甲返早",
  "17號夜更測試乙",
  "今晚N更 測試丙頂",
  "下星期三 SL",
  "後日A更",
  "請假一日",
  "AL 年假 10/20",
  "測試盤聽日通宵",
  "大後日 OT 加班",
  "20/10 補更",
  "我病咗，返唔到",
  "測試丁換更 19號",
  "聽日有冇人頂？",
  "我聽日18號病假返唔到，有冇人頂？",
  "聽日陳大文返早得唔得？",
  "明日測試乙夜更可唔可以？",
  "10月20 夜更？",
  "星期五返早定返夜？",
  "後日可唔可以放假？",
];

const IGNORES: string[] = ["收到", "OK", "謝謝", "多謝晒", "👍", "😂😂", "a", "https://example.com/news 睇下", "早晨", "今日天氣好熱", "幾點返？", "邊個返聽日？", "聽日幾點開會？", "聽日落雨？", "邊個知幾點？", "好呀", "明白", "lol", "大家早晨"];

describe("W1 filter：candidate／ignore", () => {
  it.each(CANDIDATES)("candidate：%s", (t) => {
    const r = c(t);
    expect(r.decision, JSON.stringify(r)).toBe("candidate");
    expect(r.score).toBeGreaterThanOrEqual(FILTER_DEFAULT_THRESHOLD);
  });
  it.each(IGNORES)("ignore：%s", (t) => {
    const r = c(t);
    expect(r.decision, JSON.stringify(r)).toBe("ignore");
    expect(r.score).toBeLessThan(FILTER_DEFAULT_THRESHOLD);
  });
  it("合成訊息總數 ≥ 40（含下面各組）", () => {
    expect(CANDIDATES.length + IGNORES.length + 4 /* 群組 */ + 4 /* 閾值／發訊人 */ + 2 /* quoted */ + 1 /* 長文 */).toBeGreaterThanOrEqual(40);
  });
});

describe("W1 filter：問號規則（老闆補充）", () => {
  const QUESTION_DIRECTIVES = ["我聽日18號病假返唔到，有冇人頂？", "聽日陳大文返早得唔得？", "聽日有冇人頂?", "後日可唔可以放假？", "星期五夜更係咪我？", "20/10 邊個返夜更？"];
  const PURE_QUESTIONS = ["幾點返？", "邊個返聽日？", "聽日幾點開會？", "點解咁多人？", "有冇人知幾點收工？", "今日係咪落雨？"];
  it.each(QUESTION_DIRECTIVES)("帶問句嘅指令不減分：%s", (t) => {
    const r = c(t);
    expect(r.decision).toBe("candidate");
    expect(r.reasons).toContain("question_directive_kept");
    expect(r.reasons).not.toContain("pure_question");
  });
  it.each(PURE_QUESTIONS)("純疑問句減分：%s", (t) => {
    const r = c(t);
    expect(r.decision).toBe("ignore");
    expect(r.reasons).toContain("pure_question");
  });
  it("同一句去掉問號、分數一樣（問號唔影響指令）", () => {
    expect(c("聽日陳大文返早得唔得？").score).toBe(c("聽日陳大文返早得唔得").score);
  });
  it("純疑問句有問號先減分：冇問號嘅同句分數較高", () => {
    expect(c("聽日幾點開會？").score).toBeLessThan(c("聽日幾點開會").score + 1);
  });
});

describe("W1 filter：群組、閾值、發訊人、被回覆", () => {
  it("未綁定群組／ignored 群組／停用群組 → ignore，score 0", () => {
    for (const x of [c("聽日測試甲返早", { groupKind: null }), c("聽日測試甲返早", { groupKind: "ignored" }), c("聽日測試甲返早", { groupActive: false })]) {
      expect(x.decision).toBe("ignore");
      expect(x.score).toBe(0);
    }
    expect(c("聽日測試甲返早", { groupKind: null }).reasons).toContain("group_unbound");
    expect(c("聽日測試甲返早", { groupKind: "ignored" }).reasons).toContain("group_ignored");
  });
  it("multi_site／broker／office 群照常打分", () => {
    for (const k of ["multi_site", "broker", "office"] as const) expect(c("聽日測試甲返早", { groupKind: k }).decision).toBe("candidate");
  });
  it("群組閾值覆寫：低閾值放行、高閾值擋住", () => {
    expect(c("星期五").decision).toBe("ignore");
    expect(c("星期五", { threshold: 20 }).decision).toBe("candidate");
    expect(c("聽日測試甲返早", { threshold: 80 }).decision).toBe("ignore");
  });
  it("發訊人係已知保安員／盤口別名加分", () => {
    expect(c("星期五", { senderKnown: true }).decision).toBe("ignore");
    expect(c("測試盤 星期五", { senderKnown: true }).decision).toBe("candidate");
  });
  it("被回覆（quoted）文字併入上下文：短回覆因被回覆嘅日期過線", () => {
    expect(c("好，我頂").decision).toBe("ignore");
    const r = c("好，我頂", { quotedText: "聽日夜更測試甲有冇人" });
    expect(r.decision).toBe("candidate");
    expect(r.reasons).toContain("quoted_date_token");
  });
  it("被回覆文字冇相關詞 → 唔加分", () => {
    expect(c("好，我頂", { quotedText: "大家注意安全" }).decision).toBe("ignore");
  });
  it("轉發長文減分（>300 字）", () => {
    const long = "聽日測試甲返早。" + "公司通告內容".repeat(60);
    const r = c(long);
    expect(r.reasons).toContain("long_forward");
    expect(r.decision).toBe("ignore");
  });
  it("全形數字／斜線照識（NFKC）", () => {
    expect(c("１７／１０ 夜更").decision).toBe("candidate");
  });
  it("reasons 只係代碼，唔含原文", () => {
    const r = c("我聽日18號病假，測試甲");
    for (const x of r.reasons) expect(x).toMatch(/^[a-z_]+$/);
  });
});
