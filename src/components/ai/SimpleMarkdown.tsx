"use client";
// WP-AI2：將 `parseSimpleMarkdown()`（純函數，`src/lib/ui/simple-markdown.ts`）
// 嘅 AST 轉做 JSX——助手訊息用，支援段落／列表／**粗體**／表格。
import { parseSimpleMarkdown, type MdBlock, type MdInline } from "@/lib/ui/simple-markdown";

function renderInline(inline: MdInline[], keyPrefix: string): React.ReactNode[] {
  return inline.map((node, idx) =>
    node.type === "bold" ? <strong key={`${keyPrefix}-${idx}`}>{node.text}</strong> : <span key={`${keyPrefix}-${idx}`}>{node.text}</span>,
  );
}

export function SimpleMarkdown({ text }: { text: string }) {
  const blocks: MdBlock[] = parseSimpleMarkdown(text);
  return (
    <div className="space-y-2">
      {blocks.map((block, i) => {
        if (block.type === "paragraph") {
          return (
            <p key={i} className="whitespace-pre-wrap">
              {renderInline(block.inline, `p${i}`)}
            </p>
          );
        }
        if (block.type === "list") {
          const items = block.items.map((item, j) => <li key={j}>{renderInline(item, `l${i}-${j}`)}</li>);
          return block.ordered ? (
            <ol key={i} className="list-decimal space-y-0.5 pl-5">
              {items}
            </ol>
          ) : (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {items}
            </ul>
          );
        }
        // table——README「AI 助手面板」：內嵌小表 `1px solid #e5e7eb` 圓角
        // 6px、每行 k/v 12px（原型示例其實係逐行 flex k/v，唔係傳統
        // <table> 框線；呢度為咗兼容任意欄數嘅 markdown table，保留
        // <table> 結構但換晒配色/字級去貼近個示例：淡灰表頭、行分隔線
        // `#f1f5f9`、字 12px，最後一欄（通常係數值）用 600 突出）。
        return (
          <div key={i} className="overflow-x-auto rounded-md border border-zk-border bg-white" data-testid="ai-message-table">
            <table className="w-full min-w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-zk-header">
                  {block.header.map((cell, j) => (
                    <th key={j} className="border-b border-zk-border px-2.5 py-[5px] text-left font-semibold text-zk-muted">
                      {renderInline(cell, `th${i}-${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r} className={r < block.rows.length - 1 ? "border-b border-[#f1f5f9]" : ""}>
                    {row.map((cell, c) => (
                      <td key={c} className={`px-2.5 py-[5px] ${c === row.length - 1 ? "font-semibold text-zk-text" : "text-zk-text-secondary"}`}>
                        {renderInline(cell, `td${i}-${r}-${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
