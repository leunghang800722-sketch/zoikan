// P2.5「現場反映」開會模式——模型零寫入工具（鐵律）：`buildAiTools()`
// 出返嘅工具（含 `list_feedback`）同 `src/lib/feedback/ai-tools/**` 逐個
// 檔案，原始碼掃描斷言冇任何 Prisma 寫入方法調用（`.create(`/`.update(`/
// `.upsert(`/`.delete(`/`.deleteMany(`/`.updateMany(`/`$executeRaw`/
// `$transaction`）——同 `tests/ai-structural-guard.test.ts` 一致風格
// （逐檔案原始碼文字掃描，去走 comment/string）。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildAiTools } from "@/lib/ai/tools";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { AiToolContext } from "@/lib/ai/tools/common";

const ROOT = path.resolve(__dirname, "..");

function listFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path.relative(ROOT, full)));
    else if (entry.isFile() && /\.ts$/.test(entry.name)) out.push(path.relative(ROOT, full));
  }
  return out;
}

function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== "*/") i++;
      i += 2;
      continue;
    }
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      out += ch;
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i++;
        i++;
      }
      if (i < src.length) {
        out += ch;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const WRITE_PATTERN = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;

const FEEDBACK_TOOL_FILES = listFiles("src/lib/feedback/ai-tools");

describe("P2.5：模型零寫入工具——src/lib/feedback/ai-tools/** 逐檔案掃描", () => {
  it("掃到嘅檔案數量合理（防止 glob 打空）", () => {
    expect(FEEDBACK_TOOL_FILES.length).toBeGreaterThan(0);
  });

  it.each(FEEDBACK_TOOL_FILES)("%s 冇 Prisma 寫入方法調用（去走 comment/string）", (relPath) => {
    const code = stripCommentsAndStrings(fs.readFileSync(path.join(ROOT, relPath), "utf-8"));
    expect(code).not.toMatch(WRITE_PATTERN);
    expect(code).not.toContain("$executeRaw");
    expect(code).not.toContain("$transaction");
  });
});

describe("P2.5：buildAiTools() 出返嘅全部工具（含 list_feedback）都冇寫入方法", () => {
  const fakeSession: AuthedSession = {
    userId: "test-user",
    tel: "90000000",
    name: "測試老闆",
    roleId: "role-1",
    roleName: "老闆",
    baseRole: "老闆",
    brokerId: null,
    guardId: null,
    payoutApprovalLimit: null,
    tokenVersion: 1,
    loggedInAt: new Date().toISOString(),
  };
  const ctx: AiToolContext = { session: fakeSession, fieldVisibility: { clientRateVisible: true, settlementVisible: true } };
  const tools = buildAiTools(ctx);

  it("老闆 session 出返嘅工具入面有 list_feedback", () => {
    const names = tools.map((t) => (t as unknown as { name: string }).name);
    expect(names).toContain("list_feedback");
  });

  it("每個工具嘅 `.run` function 原始碼字面冇 Prisma 寫入方法調用", () => {
    for (const tool of tools) {
      const t = tool as unknown as { name: string; run: (...args: unknown[]) => unknown };
      const src = stripCommentsAndStrings(t.run.toString());
      expect(src, `${t.name} 嘅 run() 疑似有寫入調用`).not.toMatch(WRITE_PATTERN);
    }
  });
});
