// P7.1：Node runtime 專用嘅排程器啟動（由 src/instrumentation.ts 動態 import）。
import { isSchedulerEnabled, startScheduler } from "@/lib/scheduler/start";

if (isSchedulerEnabled()) startScheduler();
