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

  it("冇 pending 時 flush／undo 無副作用", async () => {
    const { s, send } = make();
    await s.flush();
    expect(s.undo()).toBeNull();
    expect(send).toHaveBeenCalledTimes(0);
  });
});
