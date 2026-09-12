// Opus 對抗式驗收第三輪 N2（必修）：結構性保證「內部角色都唔准 raw
// Prisma row 出街」。
//
// 主要保證嚟自型別系統：`ok()`（src/lib/api/http.ts）嘅參數型別淨係
// 接受 `Dto`（src/lib/api/serialize.ts 嘅 brand）——一個原始 Prisma row
// （或者佢嘅 spread）冇呢個 phantom property，`ok(rawRow)` 會喺
// `npx tsc --noEmit` 直接紅，唔使等 runtime fuzz test 先發現。第一個
// test 實際跑一次 `tsc --noEmit` 斷言 exit code 0，將呢個保證變成一個
// 會俾 CI/test run 捉到嘅斷言（唔淨係「我頭先手動跑過一次」）。
//
// 第二個 test 係補充嘅靜態掃描（regex-based，快、唔使等成個 tsc 過）：
// 逐個 `src/app/api/**/route.ts` 掃 `ok(...)` call site，擋「bare 傳一個
// 睇落似係未轉 DTO 嘅 Prisma row 變量」呢種最常見嘅寫法（Opus 攻穿嗰
// 13＋條 void/unvoid/lock/unlock route 全部都係呢種模式：`return
// ok(after)`／`return ok(row)`）。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

// 呢啲 bare identifier 名慣常掛住一個未轉 DTO 嘅 Prisma row（`before`/
// `after`/`row`/`created`/`updated`/`user`/`broker`/`site`/`guard`/
// `role`），`ok(<呢啲名>)` 直接傳（冇包一層 `toXxxDTO(...)`）幾乎一定
// 係漏咗轉 DTO——即使而家 tsc 已經擋到（brand 唔夾），呢個測試仲係想
// 用可讀嘅訊息盡早指出邊個 route 寫錯，唔使睇 tsc 成頁 diagnostic。
const SUSPECT_BARE_NAMES = ["before", "after", "row", "created", "updated", "user", "broker", "site", "guard", "role"];

describe("N2：結構性保證——ok() 唔准直接出 raw Prisma row", () => {
  it("`npx tsc --noEmit` exit code 0（ok() 嘅 Dto brand 型別檢查係呢個保證嘅主要防線）", () => {
    expect(() => execFileSync("npx", ["tsc", "--noEmit"], { cwd: path.resolve(__dirname, ".."), stdio: "pipe" })).not.toThrow();
  }, 120_000);

  it("靜態掃描 src/app/api/**/route.ts：冇 `ok(<bare Prisma row 變量>)` 呢種寫法", () => {
    const apiDir = path.resolve(__dirname, "../src/app/api");
    const files = listRouteFiles(apiDir);
    expect(files.length).toBeGreaterThan(20);

    const violations: string[] = [];
    const bareArgRe = /\bok\(\s*([a-zA-Z_$][\w$]*)\s*[,)]/g;
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      let m: RegExpExecArray | null;
      while ((m = bareArgRe.exec(content))) {
        const arg = m[1]!;
        if (SUSPECT_BARE_NAMES.includes(arg)) {
          violations.push(`${path.relative(apiDir, file)}: ok(${arg})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("C3：靜態掃描全部 src/**：`brandSafeResponse(` 嘅參數一定要係 object literal（`{` 開頭），唔准直接傳一個 identifier/spread 變量", () => {
    // brandSafeResponse() 本身係人手「我核實過呢個係安全嘅」聲明——如果
    // 參數可以係任意 identifier（例如 `brandSafeResponse(someRawPrismaRow)`），
    // 就會變成一個繞過 Dto brand 型別檢查嘅後門，令 N2 嘅結構性保證形同
    // 虛設。要求參數一定要係一個喺 call site 本身寫低嘅 object literal
    // （`{ ... }`），先可以一眼睇得出裡面每個欄都係手砌／經白名單 DTO
    // 嚟嘅，唔係成個 row 塞落去。
    function listSrcFiles(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listSrcFiles(full));
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
      }
      return out;
    }
    const srcDir = path.resolve(__dirname, "../src");
    const files = listSrcFiles(srcDir);
    expect(files.length).toBeGreaterThan(20);

    // 掃描之前剝走 line/block comment（純粹為咗唔好自己解釋呢個規則嗰句
    // 說明文字入面出現嘅 "brandSafeResponse(" 字面 token 撞正自己個 regex
    // ——呢個 strip 唔使追求完美，呢個 codebase 冇喺 string literal 入面
    // 塞 "//" 或者 "/*" 呢類模式）。
    function stripComments(src: string): string {
      return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    }

    const violations: string[] = [];
    const callRe = /\bbrandSafeResponse\(\s*/g;
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf-8");
      const content = stripComments(raw);
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(content))) {
        const afterCall = content.slice(m.index + m[0].length);
        const nextNonSpace = afterCall.trimStart()[0];
        if (nextNonSpace !== "{") {
          const line = content.slice(0, m.index).split("\n").length;
          violations.push(`${path.relative(srcDir, file)}:${line}: brandSafeResponse(...) 參數唔係 object literal`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
