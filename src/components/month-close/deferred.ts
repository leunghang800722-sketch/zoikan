// WP-MC-UI：答題「延遲送出」——撳確認／跳過之後唔即刻 call API，先俾用戶 5 秒撤銷。
// 純 class（唔依賴 React），timer 用全域 setTimeout，方便 vitest fake timers 測試。
// 規則：同時只有一個 pending；schedule() 先 flush 上一個；flush() 一定會真係 call send()；
// send 失敗經 onFailed 交返畀 UI（唔准靜靜食咗）。
export const DEFERRED_UNDO_MS = 5000;

export type SendResult = { ok: true; detail?: string } | { ok: false; message: string };

export interface DeferredItem {
  /** 題目 id（同一時間只有一個 pending）。 */
  id: string;
  kind: "confirm" | "skip";
  /** toast 用嘅短標題（盤名／題目）。 */
  title: string;
  /** 完成清單用嘅動作標籤（例「一撳確認」）。 */
  doneLabel: string;
  /** 真正送出時用嘅 answer body（同原本 API 一樣）。 */
  answer: Record<string, unknown>;
}

export interface DeferredView {
  pending: DeferredItem | null;
  deadline: number | null;
  sending: boolean;
}

export class DeferredSender {
  private pending: DeferredItem | null = null;
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly opts: {
      delayMs?: number;
      send: (item: DeferredItem) => Promise<SendResult>;
      onSent: (item: DeferredItem, detail?: string) => void;
      onFailed: (item: DeferredItem, message: string) => void;
      onChange?: (view: DeferredView) => void;
    },
  ) {}

  private notify() {
    this.opts.onChange?.({ pending: this.pending, deadline: this.deadline, sending: this.inflight !== null });
  }

  hasPending(): boolean {
    return this.pending !== null || this.inflight !== null;
  }

  /** 排一個新 pending；上一個（如有）先真正送出。 */
  async schedule(item: DeferredItem): Promise<void> {
    await this.flush();
    this.pending = item;
    this.deadline = Date.now() + (this.opts.delayMs ?? DEFERRED_UNDO_MS);
    this.timer = setTimeout(() => void this.flush(), this.opts.delayMs ?? DEFERRED_UNDO_MS);
    this.notify();
  }

  /** 撤銷：唔 call API，題目返回未答。 */
  undo(): DeferredItem | null {
    if (!this.pending) return null;
    const it = this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.deadline = null;
    this.notify();
    return it;
  }

  /** 即刻真正送出 pending（5 秒到、撳下一題、關閉對話框、切 tab、離開頁面都經呢度）。 */
  flush(): Promise<void> {
    if (!this.pending) return this.inflight ?? Promise.resolve();
    const item = this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.deadline = null;
    const run = (async () => {
      let res: SendResult;
      try {
        res = await this.opts.send(item);
      } catch (e) {
        res = { ok: false, message: e instanceof Error ? e.message : "送出失敗" };
      }
      if (res.ok) this.opts.onSent(item, res.detail);
      else this.opts.onFailed(item, res.message);
    })();
    const tracked: Promise<void> = run.finally(() => {
      if (this.inflight === tracked) this.inflight = null;
      this.notify();
    });
    this.inflight = tracked;
    this.notify();
    return tracked;
  }
}
