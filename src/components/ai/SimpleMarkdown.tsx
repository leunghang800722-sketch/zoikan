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
        // table
        return (
          <div key={i} className="overflow-x-auto">
            <table className="min-w-full border-collapse text-xs">
              <thead>
                <tr>
                  {block.header.map((cell, j) => (
                    <th key={j} className="border border-gray-300 bg-gray-50 px-2 py-1 text-left font-medium">
                      {renderInline(cell, `th${i}-${j}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} className="border border-gray-200 px-2 py-1">
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
