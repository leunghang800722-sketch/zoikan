// @vitest-environment jsdom
// P3-3.2：useMonthState 初始值次序（URL → sessionStorage → 預設），第一次 render 就係最終值（只 fetch 一次）。
import { describe, expect, it, beforeEach } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useMonthState } from "@/components/ui/MonthPicker";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function run(def?: string) {
  const renders: string[] = [];
  let setter: (m: string) => void = () => {};
  function C() {
    const [m, set] = useMonthState(def);
    renders.push(m);
    setter = set;
    return null;
  }
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(createElement(C)));
  const unmount = () => act(() => root.unmount());
  return { renders, set: (m: string) => act(() => setter(m)), unmount };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/x");
});

describe("useMonthState", () => {
  it("URL 贏 sessionStorage；第一次 render 已係 URL 月份，冇先 render 預設", () => {
    window.sessionStorage.setItem("zk.month", "2026-08");
    window.history.replaceState(null, "", "/x?month=2026-09");
    const r = run("2026-10");
    expect(r.renders[0]).toBe("2026-09");
    expect(new Set(r.renders)).toEqual(new Set(["2026-09"]));
    expect(window.sessionStorage.getItem("zk.month")).toBe("2026-09");
    r.unmount();
  });
  it("冇 URL：用 sessionStorage，第一次 render 已係該月，並補返 ?month=", () => {
    window.sessionStorage.setItem("zk.month", "2026-08");
    const r = run("2026-10");
    expect(r.renders[0]).toBe("2026-08");
    expect(new Set(r.renders)).toEqual(new Set(["2026-08"]));
    expect(new URLSearchParams(window.location.search).get("month")).toBe("2026-08");
    r.unmount();
  });
  it("都冇：預設，唔寫 storage（persistDefault 先寫）", () => {
    const r = run("2026-10");
    expect(r.renders[0]).toBe("2026-10");
    expect(window.sessionStorage.getItem("zk.month")).toBeNull();
    r.unmount();
  });
  it("setMonth：更新 state、URL、sessionStorage；非法值只改 state", () => {
    const r = run("2026-10");
    r.set("2026-07");
    expect(r.renders[r.renders.length - 1]).toBe("2026-07");
    expect(window.sessionStorage.getItem("zk.month")).toBe("2026-07");
    expect(new URLSearchParams(window.location.search).get("month")).toBe("2026-07");
    r.set("");
    expect(r.renders[r.renders.length - 1]).toBe("");
    expect(window.sessionStorage.getItem("zk.month")).toBe("2026-07");
    r.unmount();
  });
});
