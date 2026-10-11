// P7.1：Next.js instrumentation——server 起身時啟動排程器（只喺 Node runtime；edge 唔會 import）。
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isSchedulerEnabled, startScheduler } = await import("./lib/scheduler/start");
  if (!isSchedulerEnabled()) return;
  startScheduler();
}
