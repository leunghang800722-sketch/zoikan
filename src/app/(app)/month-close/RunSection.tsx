"use client";
// 1a ② 一鍵結算：一行「上次 … 跑完 · 用咗 N 秒 · 用緊 N 份更表」＋掣（已跑過降級 secondary）。
import { Button } from "@/components/ui/Button";
import type { RunDTO } from "@/components/month-close/types";
import { fmtMdHm, runSeconds, stepByKey } from "@/components/month-close/derive";
import { BackfillButton } from "./BackfillButton";

export function RunSection({ month, run, busy, locked, havePostorder = false, onStart }: { month: string; run: RunDTO | null; busy: boolean; locked: boolean; havePostorder?: boolean; onStart: () => void }) {
  const running = !!run && run.status === "running" && !run.stalled;
  const secs = runSeconds(run);
  const files = typeof stepByKey(run, "parse_health")?.numbers.uploadCount === "number" ? (stepByKey(run, "parse_health")!.numbers.uploadCount as number) : null;
  const bits: string[] = [];
  if (run) {
    if (running) bits.push(`${fmtMdHm(run.started_at)} 開始，執行緊……（可以熄屏，返嚟會接住）`);
    else {
      bits.push(`上次 ${fmtMdHm(run.finished_at ?? run.started_at)} ${run.status === "failed" || run.stalled ? (run.stalled ? "卡住" : "失敗") : "跑完"}`);
      if (secs !== null && run.status === "done") bits.push(`用咗 ${secs} 秒`);
    }
    if (files !== null) bits.push(`用緊 ${files} 份更表`);
  } else bits.push("未跑過——上載完更表同名單就可以撳");
  const ranBefore = !!run && run.status === "done";
  return (
    <section className="flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-[10px] border border-zk-border bg-white px-4 py-3.5" data-testid="run-section">
      <h2 className="text-[14px] font-semibold text-zk-text">② 一鍵結算</h2>
      <span className="min-w-0 text-[12.5px] text-zk-muted">{bits.join(" · ")}</span>
      <Button variant={ranBefore ? "secondary" : "primary"} className="ml-auto !px-4 !py-2 font-semibold" onClick={onStart} disabled={busy || running || locked}>
        {ranBefore ? "重新一鍵結算" : "一鍵結算"} {month}
      </Button>
      <BackfillButton month={month} havePostorder={havePostorder} locked={locked} />
    </section>
  );
}
