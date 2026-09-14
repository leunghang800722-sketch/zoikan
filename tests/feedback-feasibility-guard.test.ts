// P2.5「現場反映」開會模式——可行性 guard 字眼表：≥10 正例（訪談員自己
// 落可行性判斷，要換做標準句）、≥5 反例（包括標準句本身、單純問句，
// 唔可以被誤殺）。
import { describe, it, expect } from "vitest";
import { checkFeasibilityGuard, FEASIBILITY_STANDARD_REPLY } from "@/lib/ai/feasibility-guard";

describe("P2.5：checkFeasibilityGuard() 正例——訪談員答咗可行性判斷，要換做標準句", () => {
  const positives = [
    "可以做到，我幫你改。",
    "呢個做唔到，系統結構唔容許。",
    "技術上可行，冇問題。",
    "我會幫你改返呢個功能。",
    "系統會加返呢個掣。",
    "冇問題可以加，好快。",
    "可行性高，應該幾快可以搞掂。",
    "應該可以改，唔難。",
    "呢個可以改，我即刻整。",
    "呢樣應該可以加落去。",
    "呢個改動好容易改，冇乜難度。",
    "幫你加返呢個功能落去。",
    "技術上唔可行，做唔到。",
  ];
  it.each(positives)("「%s」→ 觸發，換做標準句", (text) => {
    const result = checkFeasibilityGuard(text);
    expect(result.triggered).toBe(true);
    expect(result.text).toBe(FEASIBILITY_STANDARD_REPLY);
  });
});

describe("P2.5：checkFeasibilityGuard() 反例——唔可以誤殺", () => {
  const negatives = [
    FEASIBILITY_STANDARD_REPLY,
    "可行性由 Eric 同技術團隊評估，我淨係幫你整理清楚訴求。",
    "你想反映嘅係邊一頁嘅邊個功能？可以講多少少例子嗎？",
    "明白，即係你想更表編輯器喺手機版嘅格仔大啲，方便撳？",
    "咁呢個問題幾常出現？每次填更表都撞到，定係偶爾先撞到？",
  ];
  it.each(negatives)("「%s」→ 唔觸發", (text) => {
    const result = checkFeasibilityGuard(text);
    expect(result.triggered).toBe(false);
    expect(result.text).toBe(text);
  });
});
