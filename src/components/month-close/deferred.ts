// WP-MC-UI：答題「延遲送出」——撳確認／跳過之後唔即刻 call API，先俾用戶 5 秒撤銷。
// 純 class（唔依賴 React），timer 用全域 setTimeout，方便 vitest fake timers 測試。
// 規則：
// - 同一時間只有一個「可撤銷 pending」；schedule() 同步設新 pending，上一個 pending 即刻交俾 FIFO 送出隊列
//   （逐個送，次序保證；送出期間再 schedule 唔會丟、唔會重複）。
// - inFlightIds()＝pending＋送出中／排隊中嘅題目 id，UI 一律收埋。
// - flush() 返回 Promise<boolean>：全部送出成功＝true；有失敗＝false（失敗經 onFailed 交返 UI，唔准靜靜食咗）。
export const DEFERRED_UNDO_MS = 5000;

export type SendResult = { ok: true; detail?: string } | { ok: false; message: string };

export interface DeferredItem {
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
  /** pending＋送出中／排隊中嘅題目 id。 */
  inFlight: string[];
}

export class DeferredSender {
  private pending: DeferredItem | null = null;
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private queued = new Set<string>();
  /** 送出失敗（含 timer 自動送出失敗）嘅題目：只有該題重試（schedule）先清，唔會因 flush 而重設。 */
  private failed = new Map<string, string>();

  constructor(
    private readonly opts: {
      delayMs?: number;
      send: (item: DeferredItem) => Promise<SendResult>;
      onSent: (item: DeferredItem, detail?: string) => void;
      onFailed: (item: DeferredItem, message: string) => void;
      onChange?: (view: DeferredView) => void;
    },
  ) {}

  private view(): DeferredView {
    const inFlight = [...this.queued];
    if (this.pending) inFlight.push(this.pending.id);
    return { pending: this.pending, deadline: this.deadline, sending: this.queued.size > 0, inFlight };
  }

  private notify() {
    this.opts.onChange?.(this.view());
  }

  /** 未送出（失敗）嘅題目數。 */
  failedCount(): number {
    return this.failed.size;
  }

  inFlightIds(): string[] {
    return this.view().inFlight;
  }

  hasPending(): boolean {
    return this.pending !== null || this.queued.size > 0;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 交俾 FIFO 隊列真正送出（唔等）。 */
  private dispatch(item: DeferredItem) {
    this.queued.add(item.id);
    this.chain = this.chain.then(async () => {
      let res: SendResult;
      try {
        res = await this.opts.send(item);
      } catch (e) {
        res = { ok: false, message: e instanceof Error ? e.message : "送出失敗" };
      }
      this.queued.delete(item.id);
      if (res.ok) {
        this.failed.delete(item.id);
        this.opts.onSent(item, res.detail);
      } else {
        this.failed.set(item.id, res.message);
        this.opts.onFailed(item, res.message);
      }
      this.notify();
    });
  }

  /** 同步設新 pending（可撤銷 5 秒）；上一個 pending（如有）即刻排入送出隊列。 */
  schedule(item: DeferredItem): Promise<void> {
    this.failed.delete(item.id); // 用戶重新答呢題＝重試
    if (this.pending) {
      const prev = this.pending;
      this.pending = null;
      this.clearTimer();
      this.dispatch(prev);
    }
    this.pending = item;
    this.deadline = Date.now() + (this.opts.delayMs ?? DEFERRED_UNDO_MS);
    this.clearTimer();
    this.timer = setTimeout(() => void this.flush(), this.opts.delayMs ?? DEFERRED_UNDO_MS);
    this.notify();
    return Promise.resolve();
  }

  /** 撤銷：唔 call API，題目返回未答。 */
  undo(): DeferredItem | null {
    if (!this.pending) return null;
    const it = this.pending;
    this.clearTimer();
    this.pending = null;
    this.deadline = null;
    this.notify();
    return it;
  }

  /** 即刻真正送出 pending，等晒隊列送完。全部成功＝true。 */
  flush(): Promise<boolean> {
    if (this.pending) {
      const it = this.pending;
      this.pending = null;
      this.deadline = null;
      this.clearTimer();
      this.dispatch(it);
      this.notify();
    }
    return this.chain.then(() => this.failed.size === 0);
  }
}
