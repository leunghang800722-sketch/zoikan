// 一鍵結算（one-click.ts）同 HIST-2 歷史月份一鍵導入（historical-import.ts）共用嘅「逐步紀錄」runner：
// 每步寫 running → 跑 fn() → 寫 done／failed，進度經 `persist` 回調寫返對應嘅 run 表（steps_json）。
// 由 one-click.ts 內部 class 抽出嚟，行為不變。
import { safeErrorSummary } from "@/lib/api/http";

type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface StepRecordOf<K extends string> {
  key: K;
  label: string;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  numbers: Record<string, unknown>;
  warnings: string[];
  needsHuman: string[];
}

/** 寫入 `error_message`／step warnings 嘅錯誤訊息——自己 throw 嘅
 * `Error`（中文說明句）原文保留；其他（Prisma／lib）錯誤一律經
 * `safeErrorSummary()` 淨係攞最後一行＋長度上限，唔會將 query payload
 * （可能有姓名／電話）寫落 DB 俾主管睇到。 */
export function jobErrorMessage(e: unknown): string {
  if (e instanceof Error && e.constructor === Error) return (e.message.split("\n").pop() ?? "").replace(/\d{7,}/g, "[num]").slice(0, 300);
  return safeErrorSummary(e);
}

export class StepRunner<K extends string, R extends StepRecordOf<K> = StepRecordOf<K>> {
  constructor(
    private readonly steps: R[],
    private readonly persistFn: (steps: R[], currentStep: K | null) => Promise<void>,
  ) {}

  private async persist(currentStep: K | null): Promise<void> {
    await this.persistFn(this.steps, currentStep);
  }

  get(key: K): R {
    return this.steps.find((s) => s.key === key)!;
  }

  /** 執行一步：寫 running → 跑 fn() → 寫 done（或者 failed，然後 rethrow
   * 俾外層決定成個 run 停唔停）。`fn` 回傳嘅 `numbers`/`warnings`/
   * `needsHuman` 冧咗就直接覆蓋（每步重跑安全，唔會累積舊值）。 */
  async run(key: K, fn: () => Promise<{ numbers: Record<string, unknown>; warnings?: string[]; needsHuman?: string[] }>): Promise<R> {
    const rec = this.get(key);
    rec.status = "running";
    rec.startedAt = new Date().toISOString();
    rec.finishedAt = null;
    await this.persist(key);
    try {
      const { numbers, warnings, needsHuman } = await fn();
      rec.status = "done";
      rec.numbers = numbers;
      rec.warnings = warnings ?? [];
      rec.needsHuman = needsHuman ?? [];
      rec.finishedAt = new Date().toISOString();
      await this.persist(key);
      return rec;
    } catch (e) {
      rec.status = "failed";
      rec.warnings = [...rec.warnings, jobErrorMessage(e)];
      rec.finishedAt = new Date().toISOString();
      await this.persist(key);
      throw e;
    }
  }

  skipRest(fromKey: K, reason: string): void {
    const idx = this.steps.findIndex((s) => s.key === fromKey);
    for (let i = idx; i < this.steps.length; i++) {
      const rec = this.steps[i]!;
      if (rec.status === "pending") {
        rec.status = "skipped";
        rec.warnings = [reason];
      }
    }
  }

  async flush(currentStep: K | null): Promise<void> {
    await this.persist(currentStep);
  }

  allNeedsHuman(): string[] {
    return this.steps.flatMap((s) => s.needsHuman.map((h) => `【${s.label}】${h}`));
  }

  allWarnings(): string[] {
    return this.steps.flatMap((s) => s.warnings.map((w) => `【${s.label}】${w}`));
  }
}
