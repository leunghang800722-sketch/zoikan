// @vitest-environment jsdom
// P3-3.2：useMonthState——hydration 一致（初始值＝fallback，同 SSR 一樣，唔會 #418）；layout effect 解出
// URL → sessionStorage → 預設 後先 ready；頁面只用最終月份 fetch 一次。
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useMonthState } from "@/components/ui/MonthPicker";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeC(def: string | undefined, log: Array<[string, boolean]>, fetches: string[]) {
  let setter: (m: string) => void = () => {};
  function C() {
    const [m, set, ready] = useMonthState(def);
    setter = set;
    log.push([m, ready]);
    return createElement("span", null, m);
  }
  return { C, set: (m: string) => act(() => setter(m)), fetches };
}

import { useEffect } from "react";
function Page({ def, log, fetches }: { def?: string; log: Array<[string, boolean]>; fetches: string[] }) {
  const [m, , ready] = useMonthState(def);
  log.push([m, ready]);
  useEffect(() => {
    if (!ready) return;
    fetches.push(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fetches` 係測試收集器，刻意唔入依賴
  }, [m, ready]);
  return createElement("span", { "data-m": m }, m);
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/x");
});

describe("useMonthState", () => {
  it("hydration：SSR 用預設，client 有 URL 月份 → 初始 render 同 SSR 一致（冇 mismatch／recoverable error），之後先切；fetch 只一次（最終月份）", async () => {
    const html = renderToString(createElement(Page, { def: "2026-10", log: [], fetches: [] }));
    window.sessionStorage.setItem("zk.month", "2026-08");
    window.history.replaceState(null, "", "/x?month=2026-09");
    const el = document.createElement("div");
    el.innerHTML = html;
    const log: Array<[string, boolean]> = [];
    const fetches: string[] = [];
    const recoverable = vi.fn();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(el, createElement(Page, { def: "2026-10", log, fetches }), { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
    expect(log[0]).toEqual(["2026-10", false]); // 同 SSR
    expect(el.textContent).toBe("2026-09"); // URL 贏 sessionStorage
    expect(fetches).toEqual(["2026-09"]); // 只 fetch 一次，用最終月份
    expect(window.sessionStorage.getItem("zk.month")).toBe("2026-09");
  });

  it("hydration：冇 URL，用 sessionStorage；補返 ?month=；fetch 一次", async () => {
    const html = renderToString(createElement(Page, { def: "2026-10", log: [], fetches: [] }));
    window.sessionStorage.setItem("zk.month", "2026-08");
    const el = document.createElement("div");
    el.innerHTML = html;
    const fetches: string[] = [];
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(el, createElement(Page, { def: "2026-10", log: [], fetches }), { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(el.textContent).toBe("2026-08");
    expect(fetches).toEqual(["2026-08"]);
    expect(new URLSearchParams(window.location.search).get("month")).toBe("2026-08");
  });

  it("都冇：預設，唔寫 storage；fetch 一次", async () => {
    const el = document.createElement("div");
    const fetches: string[] = [];
    await act(async () => createRoot(el).render(createElement(Page, { def: "2026-10", log: [], fetches })));
    expect(el.textContent).toBe("2026-10");
    expect(fetches).toEqual(["2026-10"]);
    expect(window.sessionStorage.getItem("zk.month")).toBeNull();
  });

  it("setMonth：更新 state、URL、sessionStorage；非法值只改 state", async () => {
    const log: Array<[string, boolean]> = [];
    const h = makeC("2026-10", log, []);
    const el = document.createElement("div");
    await act(async () => createRoot(el).render(createElement(h.C)));
    h.set("2026-07");
    expect(log[log.length - 1]).toEqual(["2026-07", true]);
    expect(window.sessionStorage.getItem("zk.month")).toBe("2026-07");
    expect(new URLSearchParams(window.location.search).get("month")).toBe("2026-07");
    h.set("");
    expect(log[log.length - 1][0]).toBe("");
    expect(window.sessionStorage.getItem("zk.month")).toBe("2026-07");
  });
});
