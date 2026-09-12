// WP-AI2：`parseSimpleMarkdown()`（`src/lib/ui/simple-markdown.ts`）純
// 函數——側欄 AI 助手回覆支援嘅簡單 markdown（段落／列表／**粗體**／
// 表格，任務指示 §2）。
import { describe, it, expect } from "vitest";
import { parseSimpleMarkdown } from "@/lib/ui/simple-markdown";

describe("WP-AI2 parseSimpleMarkdown——助手回覆簡單 markdown", () => {
  it("純段落＋粗體", () => {
    const blocks = parseSimpleMarkdown("你好，**在勤**助手可以幫你。");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      inline: [
        { type: "text", text: "你好，" },
        { type: "bold", text: "在勤" },
        { type: "text", text: "助手可以幫你。" },
      ],
    });
  });

  it("無序列表", () => {
    const blocks = parseSimpleMarkdown("- 第一點\n- 第二點");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    if (blocks[0].type === "list") {
      expect(blocks[0].items).toEqual([[{ type: "text", text: "第一點" }], [{ type: "text", text: "第二點" }]]);
    }
  });

  it("有序列表", () => {
    const blocks = parseSimpleMarkdown("1. 開更表\n2. 填人");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: true });
  });

  it("表格（GFM 風格 header + 分隔行 + body）", () => {
    const md = "| 盤 | 更數 |\n| --- | --- |\n| 啟航1331 | 12 |\n| 龍運廣場 | 8 |";
    const blocks = parseSimpleMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("table");
    if (blocks[0].type === "table") {
      expect(blocks[0].header.map((c) => c.map((n) => n.text).join(""))).toEqual(["盤", "更數"]);
      expect(blocks[0].rows).toHaveLength(2);
      expect(blocks[0].rows[0].map((c) => c.map((n) => n.text).join(""))).toEqual(["啟航1331", "12"]);
    }
  });

  it("段落＋空行＋列表 → 兩個獨立 block", () => {
    const blocks = parseSimpleMarkdown("開場白\n\n- 一\n- 二");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list"]);
  });

  it("冇粗體嘅純文字段落，inline 淨係一個 text node", () => {
    const blocks = parseSimpleMarkdown("純文字，冇任何 markdown 語法。");
    expect(blocks[0]).toEqual({ type: "paragraph", inline: [{ type: "text", text: "純文字，冇任何 markdown 語法。" }] });
  });

  it("空字串 → 冇 block", () => {
    expect(parseSimpleMarkdown("")).toEqual([]);
  });
});
