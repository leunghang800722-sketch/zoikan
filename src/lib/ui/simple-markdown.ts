// WP-AI2：側欄 AI 助手回覆嘅簡單 markdown 解析——淨係支援設計要求嘅
// 四樣嘢：段落、列表（有序/無序）、**粗體**、表格（GFM 風格 `| a | b |`
// + `| --- | --- |`）。刻意唔引入第三方 markdown 套件——助手回覆嚟自
// LLM，範圍可控，一個簡單 parser 夠用，亦方便逐行睇得晒（少一個
// 第三方套件嘅 attack surface／bundle size）。純函數，唔掂 DOM，方便
// vitest 直接測。
export type MdInline = { type: "text"; text: string } | { type: "bold"; text: string };

export type MdBlock =
  | { type: "paragraph"; inline: MdInline[] }
  | { type: "list"; ordered: boolean; items: MdInline[][] }
  | { type: "table"; header: MdInline[][]; rows: MdInline[][][] };

function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    out.push({ type: "bold", text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  if (out.length === 0) out.push({ type: "text", text: "" });
  return out;
}

const LIST_ITEM_RE = /^\s*([-*]|\d+\.)\s+(.*)$/;

/** 表格分隔行（第二行）：淨係得 `|`、`-`、`:`、空白，至少一個 `-`。 */
function isTableSeparatorRow(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes("-") && line.includes("|");
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

export function parseSimpleMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 表格：呢行有 `|`，下一行係分隔行。
    if (line.includes("|") && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      const header = splitTableRow(line).map(parseInline);
      i += 2;
      const rows: MdInline[][][] = [];
      while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    // 列表：連續幾行都係 `- `/`* `/`1. ` 開頭。
    if (LIST_ITEM_RE.test(line)) {
      const firstMarker = line.match(LIST_ITEM_RE)![1];
      const ordered = /\d+\./.test(firstMarker);
      const items: MdInline[][] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM_RE);
        if (!m) break;
        items.push(parseInline(m[2]));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // 段落：一路收到空行/列表行/表格行為止。
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !LIST_ITEM_RE.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", inline: parseInline(paraLines.join(" ")) });
  }

  return blocks;
}
