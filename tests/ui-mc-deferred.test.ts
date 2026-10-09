// WP-MC-UI：答題延遲送出（5 秒撤銷）——fake timers。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeferredSender, DEFERRED_UNDO_MS, type DeferredItem, type SendResult } from "@/components/month-close/deferred";

const item = (id: string, kind: "confirm" | "skip" = "confirm"): DeferredItem => ({ id, kind, title: `盤${id}`, doneLabel: "一撳確認", answer: kind === "skip" ? { option: "skip" } : { option: "mc_accept" } });

function make(result: SendResult = { ok: true }) {
  const send = vi.fn(async (...args: [DeferredItem]): Promise<SendResult> => (args.length ? result : result));
  const sent: string[] = [];
  const failed: Array<[string, string]> = [];
  const s = new DeferredSender({ send, onSent: (i) => sent.push(i.id), onFailed: (i, m) => failed.push([i.id, m]) });
  return { s, send, sent, failed };
}

describe("DeferredSender", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("確認後 5 秒內撤銷 → API 0 次", async () => {
    const { s, send } = make();
    await s.schedule(item("a"));
    expect(send).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(DEFERRED_UNDO_MS - 1000);
    expect(s.undo()?.id).toBe("a");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(0);
    expect(s.hasPending()).toBe(false);
  });

  it("確認後等 5 秒 → API 1 次", async () => {
    const { s, send, sent } = make();
    await s.schedule(item("a"));
    await vi.advanceTimersByTimeAsync(DEFERRED_UNDO_MS - 1);
    expect(send).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(["a"]);
  });

  it("確認後即刻撳下一題 → 上一題已送出，下一題成 pending", async () => {
    const { s, send, sent } = make();
    await s.schedule(item("a"));
    await s.schedule(item("b", "skip"));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].id).toBe("a");
    expect(sent).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(DEFERRED_UNDO_MS + 10);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].kind).toBe("skip");
  });

  it("關閉對話框 flush → 即刻送出，timer 唔會再送第二次", async () => {
    const { s, send } = make();
    await s.schedule(item("a"));
    await s.flush();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("API 失敗 → onFailed，唔食咗", async () => {
    const { s, failed, sent } = make({ ok: false, message: "409 已改變" });
    await s.schedule(item("a"));
    await s.flush();
    expect(sent).toEqual([]);
    expect(failed).toEqual([["a", "409 已改變"]]);
  });

  it("send throw → 同樣當失敗", async () => {
    const send = vi.fn(async () => {
      throw new Error("network");
    });
    const failed: string[] = [];
    const s = new DeferredSender({ send, onSent: () => {}, onFailed: (_i, m) => failed.push(m) });
    await s.schedule(item("a"));
    await s.flush();
    expect(failed).toEqual(["network"]);
  });

  it("失敗時 flush 返回 false，成功返回 true", async () => {
    const bad = make({ ok: false, message: "500" });
    await bad.s.schedule(item("a"));
    expect(await bad.s.flush()).toBe(false);
    const good = make();
    await good.s.schedule(item("a"));
    expect(await good.s.flush()).toBe(true);
  });

  it("A 送出期間 schedule B、C → A、B、C 各送一次、次序正確；in-flight 全部收埋", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const views: string[][] = [];
    const s = new DeferredSender({
      send: async (i) => {
        order.push(i.id);
        if (i.id === "a") await gate;
        return { ok: true };
      },
      onSent: () => {},
      onFailed: () => {},
      onChange: (v) => views.push(v.inFlight),
    });
    await s.schedule(item("a"));
    await s.schedule(item("b")); // a 排入送出（卡住），b 成 pending
    await s.schedule(item("c")); // b 排入隊列，c 成 pending
    expect(s.inFlightIds().sort()).toEqual(["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(["a"]); // 逐個送，a 未完 b 未開始
    release();
    await s.flush();
    expect(order).toEqual(["a", "b", "c"]);
    expect(s.inFlightIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("timer 自動送出失敗 → 失敗集合保留，之後 flush 都係 false（唔會被重設）", async () => {
    const { s, failed } = make({ ok: false, message: "500" });
    await s.schedule(item("a"));
    await vi.advanceTimersByTimeAsync(DEFERRED_UNDO_MS + 1500);
    expect(failed).toEqual([["a", "500"]]);
    expect(s.failedCount()).toBe(1);
    expect(await s.flush()).toBe(false);
    expect(await s.flush()).toBe(false);
  });

  it("A 由 B 觸發送出失敗、B 由 timer 送出失敗 → 兩個都保留；重試先清", async () => {
    const { s } = make({ ok: false, message: "x" });
    await s.schedule(item("a"));
    await s.schedule(item("b"));
    await vi.advanceTimersByTimeAsync(DEFERRED_UNDO_MS + 1500);
    expect(s.failedCount()).toBe(2);
    await s.schedule(item("a")); // 重試 a
    expect(s.failedCount()).toBe(1);
  });

  it("冇 pending 時 flush／undo 無副作用", async () => {
    const { s, send } = make();
    await s.flush();
    expect(s.undo()).toBeNull();
    expect(send).toHaveBeenCalledTimes(0);
  });
});
