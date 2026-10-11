// P3-1.8（B-4）：offset 分頁 list route 嘅 orderBy 必須有 `id` 做 tie-breaker（否則同值行次序不穩定，
// 第 1／2 頁之間可能重複或漏行）；P3-1.7（B-3）：三個大 interactive tx 必須有 timeout。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../src");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/route\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 括號配對攞 `orderBy: [ ... ]` 陣列內容（元素內可以有巢狀 `[]`／`{}`），再睇有冇頂層 `{ id: "asc"|"desc" }` 元素。 */
function orderByHasIdTieBreaker(line: string): boolean {
  const m = /orderBy:\s*\[/.exec(line);
  if (!m) return false;
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let k = m.index + m[0].length - 1; k < line.length; k++) {
    const ch = line[k];
    if (ch === "[") {
      if (depth === 0) start = k + 1;
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = k;
        break;
      }
    }
  }
  if (start < 0 || end < 0) return false;
  // 頂層元素：以逗號分隔（忽略巢狀括號內嘅逗號）。
  const elems: string[] = [];
  let d = 0;
  let cur = "";
  for (const ch of line.slice(start, end)) {
    if ("[{(".includes(ch)) d++;
    if ("]})".includes(ch)) d--;
    if (ch === "," && d === 0) {
      elems.push(cur);
      cur = "";
    } else cur += ch;
  }
  elems.push(cur);
  return elems.some((e) => /^\s*\{\s*id:\s*"(asc|desc)"\s*\}\s*$/.test(e));
}

describe("P3-1.8 分頁 orderBy 加 id tie-breaker", () => {
  it("括號配對 helper：巢狀陣列／物件都識處理", () => {
    expect(orderByHasIdTieBreaker('findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })')).toBe(true);
    expect(orderByHasIdTieBreaker('findMany({ orderBy: [{ a: { b: [1, 2] } }, { id: "desc" }], skip, take })')).toBe(true);
    expect(orderByHasIdTieBreaker('findMany({ orderBy: [{ a: { b: [1, 2] } }, { name: "asc" }], skip, take })')).toBe(false);
    expect(orderByHasIdTieBreaker('findMany({ orderBy: [{ id: "asc" }, { name: "asc" }] })')).toBe(true);
    expect(orderByHasIdTieBreaker('findMany({ orderBy: { id: "asc" } })')).toBe(false);
  });

  it("所有帶 skip＋take 嘅 findMany，orderBy 都含 id", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const file of walk(path.join(root, "app/api"))) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\.findMany\(/.test(line) || !/\bskip\b/.test(line) || !/\btake\b/.test(line)) return;
        checked++;
        if (!orderByHasIdTieBreaker(line)) bad.push(`${path.relative(root, file)}:${i + 1}`);
      });
    }
    expect(checked).toBeGreaterThanOrEqual(15);
    expect(bad).toEqual([]);
  });
});

describe("P3-1.7 大 interactive transaction 有 timeout", () => {
  it.each([
    ["app/api/shift-records/batch/route.ts"],
    ["lib/months/open-month.ts"], // P7.2：開月核心由 route 抽去 lib（route 只剩權限＋response）
    ["lib/roster-upload/service.ts"],
  ])("%s 含 timeout: 60_000", (rel) => {
    expect(fs.readFileSync(path.join(root, rel), "utf8")).toContain("timeout: 60_000, maxWait: 10_000");
  });
});

// P3-1.9（B-5）：前端 apiGetAll 逐頁拉齊 total，唔再 take=500 靜默截斷。
import { vi, afterEach } from "vitest";
import { apiGetAll } from "@/lib/ui/api-client";

describe("P3-1.9 apiGetAll（ui client）", () => {
  afterEach(() => vi.unstubAllGlobals());
  function stubServer(total: number, pageCap = 500) {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const u = new URL(url, "http://t");
        const skip = Number(u.searchParams.get("skip"));
        const take = Math.min(Number(u.searchParams.get("take")), pageCap);
        const rows = Array.from({ length: Math.max(0, Math.min(take, total - skip)) }, (_, i) => ({ n: skip + i }));
        return new Response(JSON.stringify({ rows, total, skip, take }), { status: 200 });
      }),
    );
    return urls;
  }

  it("1,234 行 → 3 頁，全部拉齊、次序連續", async () => {
    const urls = stubServer(1234);
    const res = await apiGetAll<{ n: number }>("/api/x?include_inactive=1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rows).toHaveLength(1234);
    expect(res.data.rows.map((r) => r.n)).toEqual(Array.from({ length: 1234 }, (_, i) => i));
    expect(res.data.total).toBe(1234);
    expect(urls).toEqual(["/api/x?include_inactive=1&skip=0&take=500", "/api/x?include_inactive=1&skip=500&take=500", "/api/x?include_inactive=1&skip=1000&take=500"]);
  });

  it("≤500 行只 1 次請求；0 行唔死循環；中途失敗回該錯誤", async () => {
    const u1 = stubServer(64);
    const r1 = await apiGetAll("/api/y");
    expect(r1.ok && r1.data.rows.length).toBe(64);
    expect(u1).toEqual(["/api/y?skip=0&take=500"]);
    stubServer(0);
    const r0 = await apiGetAll("/api/y");
    expect(r0.ok && r0.data.rows.length).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden", message: "冇權限" }), { status: 403 })));
    const rf = await apiGetAll("/api/y");
    expect(rf.ok).toBe(false);
  });

  it("P3-2：server 喺分頁後剔走個別行（rows<take）→ skip 仍然按頁（0／500／1000）前進，唔重複唔錯位", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const u = new URL(url, "http://t");
        const skip = Number(u.searchParams.get("skip"));
        const take = Number(u.searchParams.get("take"));
        // 每頁 DB 行 skip..skip+take，但 server 剔走偶數行
        const rows = Array.from({ length: Math.max(0, Math.min(take, 1234 - skip)) }, (_, i) => ({ n: skip + i })).filter((r) => r.n % 2 === 1);
        return new Response(JSON.stringify({ rows, total: 1234, skip, take }), { status: 200 });
      }),
    );
    const res = await apiGetAll<{ n: number }>("/api/z");
    expect(urls).toEqual(["/api/z?skip=0&take=500", "/api/z?skip=500&take=500", "/api/z?skip=1000&take=500"]);
    expect(res.ok && new Set(res.data.rows.map((r) => r.n)).size).toBe(617);
  });
});
