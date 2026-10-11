// @vitest-environment jsdom
// P13.6：back-nav——trackPath stack、goBack（有上一頁 router.back／冇就去父路徑）、parentPath。
import { describe, expect, it, beforeEach, vi } from "vitest";
import { goBack, hasPrevious, parentPath, readStack, trackPath } from "@/lib/ui/back-nav";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("back-nav", () => {
  it("parentPath：深層頁返所屬 index，其餘返 /", () => {
    expect(parentPath("/month-close/files")).toBe("/month-close");
    expect(parentPath("/roster/abc/2026-10/editor")).toBe("/roster");
    expect(parentPath("/roster-uploads/x/reconcile")).toBe("/roster-uploads");
    expect(parentPath("/guards/import")).toBe("/guards");
    expect(parentPath("/triage")).toBe("/");
    expect(parentPath("/settings/jobs")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });

  it("trackPath：push、同頁唔重複、返去上上一頁＝pop、上限 50", () => {
    trackPath("/");
    trackPath("/triage");
    trackPath("/triage");
    expect(readStack()).toEqual(["/", "/triage"]);
    trackPath("/"); // 返去上一頁
    expect(readStack()).toEqual(["/"]);
    for (let i = 0; i < 60; i++) trackPath(`/p${i}`);
    expect(readStack().length).toBeLessThanOrEqual(50);
  });

  it("goBack：有上一頁 → router.back；冇 → push 父路徑（或指定 fallback）", () => {
    const router = { back: vi.fn(), push: vi.fn() };
    trackPath("/month-close/files");
    goBack(router, "/month-close/files");
    expect(router.back).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith("/month-close");
    goBack(router, "/month-close/files", "/custom");
    expect(router.push).toHaveBeenLastCalledWith("/custom");
    // 有紀錄（jsdom history.length 先要 >1）
    window.history.pushState({}, "", "/a");
    window.history.pushState({}, "", "/b");
    trackPath("/a");
    trackPath("/b");
    expect(hasPrevious()).toBe(true);
    goBack(router, "/b");
    expect(router.back).toHaveBeenCalledTimes(1);
  });
});
