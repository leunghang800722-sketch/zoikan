// P3-0.2：src/app/(app) 內所有 href="/…" 字面值（含 template literal）都要對應 src/app 現有 page。
// 允許 query／hash／動態段；/api/ 開頭係 route handler（下載連結），唔係頁面，跳過。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const APP = join(process.cwd(), "src/app");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function pageRoutes(): string[][] {
  return walk(APP)
    .filter((f) => /[\\/]page\.tsx$/.test(f))
    .map((f) =>
      relative(APP, f)
        .split(sep)
        .slice(0, -1)
        .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")"))),
    );
}

function matches(route: string[], parts: string[]): boolean {
  if (route.length !== parts.length) return false;
  return route.every((seg, i) => (seg.startsWith("[") ? parts[i] !== "" : seg === parts[i]));
}

describe("src/app/(app) href 都對應現有 page", () => {
  const routes = pageRoutes();
  const files = walk(join(APP, "(app)")).filter((f) => /\.tsx?$/.test(f));
  const re = /href=(?:"(\/[^"]*)"|\{`(\/[^`]*)`\})/g;

  it("掃到 page 同 href", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it("冇死連結", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(re)) {
        let raw = m[1] ?? m[2];
        raw = raw.replace(/\$\{[^}]*\}/g, "__dyn__");
        const path = raw.split(/[?#]/)[0];
        if (path === "/api" || path.startsWith("/api/")) continue;
        const parts = path === "/" ? [] : path.replace(/^\//, "").replace(/\/$/, "").split("/");
        checked += 1;
        if (!routes.some((r) => matches(r, parts))) bad.push(`${relative(process.cwd(), f)}: ${raw}`);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });
});
