// P2.5「現場反映」開會模式——可行性 guard 字眼表：≥20 正例（訪談員自己
// 落可行性判斷，要換做標準句，覆蓋 Opus 驗收發現嘅漏網類別：英文、口語
// 肯定、否定判斷、工期／版本承諾）、≥10 反例（包括標準句本身、單純問句
// ／覆述，唔可以被誤殺）。
//
// 呢度嘅句子係獨立寫嘅（唔係抄 feasibility-guard.ts 個 regex 陣列嘅字面
// 同義反覆）——每句都係一個完整、有語境嘅訪談員回覆，用嚟驗證 regex
// 實際攔唔攔到、誤唔誤殺。
import { describe, it, expect } from "vitest";
import { checkFeasibilityGuard, FEASIBILITY_STANDARD_REPLY } from "@/lib/ai/feasibility-guard";

describe("P2.5：checkFeasibilityGuard() 正例——訪談員答咗可行性判斷，要換做標準句", () => {
  const positives = [
    // 原有 12 類（廣東話直接判斷句式）
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

    // Opus 驗收應修②——漏網類別 1：英文
    "Yes, this is feasible, no problem at all.",
    "Sorry, this is not feasible with the current setup.",
    "We can add this in the next update.",
    "This can't be done with the current system architecture.",
    "This is easy to add, just give me a day.",

    // 漏網類別 2：口語肯定
    "得㗎，呢個好快加得到俾你。",
    "一定得，呢個唔難整。",
    "搞得掂嘅，你唔使擔心。",
    "好易啫，加個掣就得。",
    "加個掣就得，唔使大改成個系統。",
    "Easy 啦，我兩日就整好俾你。",
    "冇問題，我哋會加返呢個功能落去。",

    // 漏網類別 3：否定判斷
    "而家個系統支援唔到呢樣嘢。",
    "呢個技術上實現唔到。",
    "呢個做法而家唔 work，要另外諗過。",
    "而家個系統唔 support 呢種格式。",
    "而家個架構唔支援呢種做法。",

    // 漏網類別 4：工期／版本承諾
    "大概三日就做好俾你，你放心。",
    "一個星期就完成，唔使擔心。",
    "兩個月內應該做完，唔使急住。",
    "下個版本會有呢個功能，你等等。",
    "呢個交俾我，我一定搞掂。",
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
    "你想點改？",
    "我明白你想……",
    "呢個功能而家係咁運作。",
    "Eric 會評估。",
    "你想反映嘅係邊一頁嘅邊個功能？可以講多少少例子嗎？",
    "明白，即係你想更表編輯器喺手機版嘅格仔大啲，方便撳？",
    "咁呢個問題幾常出現？每次填更表都撞到，定係偶爾先撞到？",
    "你想幾時方便再傾多次？我哋再約時間跟進。",
    "呢個 idea 幾有意思，多謝你講咁清楚，我記低咗先。",
  ];
  it.each(negatives)("「%s」→ 唔觸發", (text) => {
    const result = checkFeasibilityGuard(text);
    expect(result.triggered).toBe(false);
    expect(result.text).toBe(text);
  });
});
