// @vitest-environment jsdom
// P13.5：useHistoryOverlay——開覆蓋層 push 一格 history；返回（popstate）關覆蓋層；UI 關閉 history.back；嵌套後開先關。
import { describe, expect, it, beforeEach } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { useHistoryOverlay } from "@/lib/ui/use-history-overlay";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

let api: { openA: () => void; openB: () => void; closeA: () => void; closeB: () => void; a: boolean; b: boolean; navClose: () => void } | null = null;
function App({ enabled = true }: { enabled?: boolean }) {
  const [a, setA] = useState(false);
  const [b, setB] = useState(false);
  const ha = useHistoryOverlay(a, () => setA(false), "A", enabled);
  const hb = useHistoryOverlay(b, () => setB(false), "B", enabled);
  api = { openA: () => setA(true), openB: () => setB(true), closeA: ha.close, closeB: hb.close, a, b, navClose: ha.closeForNavigation };
  return createElement("span", null, `${a}-${b}`);
}

let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  window.history.replaceState(null, "", "/p");
  const el = document.createElement("div");
  document.body.replaceChildren(el);
  root = createRoot(el);
  await act(async () => root.render(createElement(App)));
});

describe("useHistoryOverlay", () => {
  it("開 → push（同 URL）；返回 → 關，URL 不變", async () => {
    const len = window.history.length;
    await act(async () => api!.openA());
    expect(window.history.length).toBe(len + 1);
    expect(location.pathname).toBe("/p");
    expect(api!.a).toBe(true);
    await act(async () => window.history.back());
    await tick();
    expect(api!.a).toBe(false);
    expect(location.pathname).toBe("/p");
  });

  it("UI 關閉 → history.back（entry 清走，之後再返回唔會多一格）", async () => {
    await act(async () => api!.openA());
    await act(async () => api!.closeA());
    await tick();
    expect(api!.a).toBe(false);
    expect((window.history.state as { zkOverlay?: string } | null)?.zkOverlay).toBeUndefined();
  });

  it("嵌套：後開先關；再返回關第一層", async () => {
    await act(async () => api!.openA());
    await act(async () => api!.openB());
    await act(async () => window.history.back());
    await tick();
    expect(api!.b).toBe(false);
    expect(api!.a).toBe(true);
    await act(async () => window.history.back());
    await tick();
    expect(api!.a).toBe(false);
  });

  it("程式直接關（setOpen false 而 entry 仲喺頂）→ 自動清走 entry", async () => {
    await act(async () => api!.openA());
    await act(async () => api!.navClose()); // closeForNavigation：留低 entry，由 global 跳過
    await tick();
    expect(api!.a).toBe(false);
  });

  it("enabled=false：唔入 history，close 直接 onClose", async () => {
    await act(async () => root.render(createElement(App, { enabled: false })));
    const len = window.history.length;
    await act(async () => api!.openA());
    expect(window.history.length).toBe(len);
    await act(async () => api!.closeA());
    expect(api!.a).toBe(false);
  });
});
