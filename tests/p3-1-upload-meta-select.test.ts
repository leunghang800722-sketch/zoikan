// P3-1.4：roster_uploads／postorder_uploads／staff_list_uploads 有 bytea 欄，
// 所有 find* 呼叫必須明確寫 `select`（唔讀 file_bytes／*_csv_bytes）；
// 真係要解析原檔嘅呼叫列入下面白名單，並寫明原因。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MODELS = ["rosterUpload", "postorderUpload", "staffListUpload"];
const FIND_RE = new RegExp(`\\b(?:${MODELS.join("|")})\\.(?:findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow)\\(`, "g");

// key＝`<相對 src 路徑>#<第 n 個無 select 嘅呼叫>`；值＝原因。
const NEEDS_BYTES: Record<string, string> = {
  "lib/roster-upload/service.ts#1": "reparseRosterUpload：重新解析原檔 xlsx",
  "app/api/guard-fix/plan/route.ts#1": "guard-fix plan：解析 U Team 名單 xlsx",
  "app/api/guard-fix/plan/route.ts#2": "guard-fix plan：解析 Postorder 檔／CSV",
  "app/api/guard-fix/runs/[id]/apply/route.ts#1": "guard-fix apply：重新解析 U Team 名單",
  "app/api/guard-fix/runs/[id]/apply/route.ts#2": "guard-fix apply：重新解析 Postorder",
  "lib/month-close/one-click.ts#1": "一鍵結算：解析 U Team 名單（loadPostorderForPlan 前）",
  "lib/month-close/one-click.ts#2": "一鍵結算：解析 Postorder（guard-fix 收斂 loop）",
  "lib/month-close/one-click.ts#3": "一鍵結算：step6 Postorder 對照",
  "lib/month-close/auto/context.ts#1": "一鍵結算自動改動：Postorder 證據解析",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 由 `(` 後面開始取到對應 `)` 為止嘅呼叫參數文字。 */
function callArgs(src: string, openIdx: number): string {
  let depth = 1;
  let i = openIdx;
  while (i < src.length && depth > 0) {
    const c = src[i++];
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return src.slice(openIdx, i - 1);
}

describe("P3-1.4 上載表 find* 必須有 select（唔讀 bytea）", () => {
  it("冇白名單以外嘅無 select 呼叫；白名單冇過期項", () => {
    const root = path.resolve(__dirname, "../src");
    const missing: string[] = [];
    const seenAllowed = new Set<string>();
    for (const file of walk(root)) {
      const src = fs.readFileSync(file, "utf8");
      const rel = path.relative(root, file).split(path.sep).join("/");
      let n = 0;
      for (const m of src.matchAll(FIND_RE)) {
        const args = callArgs(src, m.index! + m[0].length);
        if (/\bselect\s*:/.test(args)) continue;
        n++;
        const key = `${rel}#${n}`;
        if (key in NEEDS_BYTES) seenAllowed.add(key);
        else missing.push(`${key}  ${m[0]}`);
      }
    }
    expect(missing).toEqual([]);
    expect([...seenAllowed].sort()).toEqual(Object.keys(NEEDS_BYTES).sort());
  });
});
