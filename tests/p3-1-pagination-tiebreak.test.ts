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

describe("P3-1.8 分頁 orderBy 加 id tie-breaker", () => {
  it("所有帶 skip＋take 嘅 findMany，orderBy 都含 id", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const file of walk(path.join(root, "app/api"))) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\.findMany\(/.test(line) || !/\bskip\b/.test(line) || !/\btake\b/.test(line)) return;
        checked++;
        if (!/orderBy:\s*\[[^\]]*\{\s*id:\s*"(asc|desc)"\s*\}\s*\]/.test(line)) bad.push(`${path.relative(root, file)}:${i + 1}`);
      });
    }
    expect(checked).toBeGreaterThanOrEqual(15);
    expect(bad).toEqual([]);
  });
});

describe("P3-1.7 大 interactive transaction 有 timeout", () => {
  it.each([
    ["app/api/shift-records/batch/route.ts"],
    ["app/api/months/[month]/open/route.ts"],
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
});
