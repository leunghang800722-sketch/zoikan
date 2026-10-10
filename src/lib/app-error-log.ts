// WP-AI-DIAG（§37.3 / 37.6）：應用層錯誤日誌——`app_error_log` 表（public schema，**唔入 `ai` schema**，
// 唔開 view 俾 `zoikan_ai_ro`）。Zeabur runtime log 應用程式讀唔到，呢張表係「助手 recent_app_errors」嘅替代來源。
//
// 鐵律：
// - 只存 method／route（pathname，**唔存 query string**）／status／錯誤類別／已遮罩訊息（≤300 字）／actor_user_id（有 session 先填）。
//   **唔存 body、header、IP、stack**。
// - 寫入（`writeAppErrorLog`）fire-and-forget：內部全部 try/catch，永遠唔 throw、唔改原本 response；DB 唔通就靜靜放棄。
// - 寫入時順手 prune 30 日前紀錄（Prisma deleteMany，唔用 raw SQL；同一 process 最多每 10 分鐘 prune 一次）。
// - 讀取（`listRecentAppErrors()`）搬咗去 `src/lib/reports/app-errors.ts`（助手 tool 檔 import 嗰邊，結構守門 allowlist 已涵蓋 reports/）；呢個檔淨係寫入＋遮罩。
import { prisma } from "./db";

const MAX_MESSAGE_CHARS = 300;
export const APP_ERROR_LOG_RETENTION_DAYS = 30;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
let lastPruneAt = 0;

/** 遮罩：email → `[email]`；`sk-` 開頭 token → `[redacted]`；連續 ≥6 位數字 → `[num]`；最後截 300 字。 */
export function maskErrorMessage(raw: string): string {
  return raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/\d{6,}/g, "[num]")
    .slice(0, MAX_MESSAGE_CHARS);
}

/** route 只取 pathname：優先用 Next 嘅 route pattern（例如 `/api/sites/[id]`，連 id 都唔入），否則剝走 `?` 之後嘅嘢。 */
export function pathnameOnly(route: string): string {
  const q = route.indexOf("?");
  const h = route.indexOf("#");
  const cut = [q, h].filter((i) => i >= 0);
  return (cut.length ? route.slice(0, Math.min(...cut)) : route).slice(0, 200);
}

async function currentRoute(): Promise<string | null> {
  try {
    const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
    const store = workAsyncStorage.getStore();
    if (store?.route) return store.route;
  } catch {
    // 唔喺 Next request scope（例如 vitest／script）
  }
  return null;
}

export interface AppErrorLogInput {
  status: number;
  errorCode?: string | null;
  errorName?: string | null;
  /** 已經係 `safeErrorSummary()` 嘅輸出（類別＋最後一行），呢度再遮罩一次。 */
  message: string;
  method?: string | null;
  route?: string | null;
  actorUserId?: string | null;
}

/** fire-and-forget 用：`void writeAppErrorLog(...)`。永遠唔 throw。 */
export async function writeAppErrorLog(input: AppErrorLogInput): Promise<void> {
  try {
    const route = pathnameOnly(input.route ?? (await currentRoute()) ?? "(unknown)");
    await prisma.appErrorLog.create({
      data: {
        method: input.method ?? null,
        route,
        status: input.status,
        errorCode: input.errorCode ?? null,
        errorName: input.errorName ? input.errorName.slice(0, 80) : null,
        messageMasked: maskErrorMessage(input.message),
        actorUserId: input.actorUserId ?? null,
      },
    });
    const now = Date.now();
    if (now - lastPruneAt > PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      await prisma.appErrorLog.deleteMany({ where: { createdAt: { lt: new Date(now - APP_ERROR_LOG_RETENTION_DAYS * 86_400_000) } } });
    }
  } catch {
    // DB 唔通／表未建——靜靜放棄，絕不影響原本 response
  }
}

/** 測試用：重置 prune 節流。 */
export function resetAppErrorLogPruneForTests(): void {
  lastPruneAt = 0;
}
