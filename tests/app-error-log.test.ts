// WP-AI-DIAG（§37.3）：`app_error_log`——遮罩 function、寫入、prune、「log 寫入失敗唔影響 response」、只存 pathname。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { maskErrorMessage, pathnameOnly, writeAppErrorLog, resetAppErrorLogPruneForTests } from "@/lib/app-error-log";
import { listRecentAppErrors } from "@/lib/reports/app-errors";
import { handleApiError, withApiError } from "@/lib/api/http";
import { ApiError } from "@/lib/api/errors";

describe("maskErrorMessage", () => {
  it("連續 ≥6 位數字 → [num]；5 位以下保留", () => {
    expect(maskErrorMessage("fail for 91234567 and 123456 and 12345")).toBe("fail for [num] and [num] and 12345");
  });
  it("email → [email]", () => {
    expect(maskErrorMessage("send to test.user+x@example.com failed")).toBe("send to [email] failed");
  });
  it("sk- 開頭 token → [redacted]", () => {
    expect(maskErrorMessage("bad key sk-abcDEF123_xyz-9999 used")).toBe("bad key [redacted] used");
  });
  it("截 300 字", () => {
    expect(maskErrorMessage("字".repeat(500))).toHaveLength(300);
  });
});

describe("pathnameOnly", () => {
  it("剝走 query／hash", () => {
    expect(pathnameOnly("/api/sites?month=2026-09&tel=91234567")).toBe("/api/sites");
    expect(pathnameOnly("/api/x#frag")).toBe("/api/x");
    expect(pathnameOnly("/api/sites/[id]")).toBe("/api/sites/[id]");
  });
});

describe("writeAppErrorLog / handleApiError", () => {
  beforeEach(async () => {
    await clearAll();
    resetAppErrorLogPruneForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it("寫入：只有指定欄位，message 已遮罩，route 冇 query", async () => {
    await writeAppErrorLog({ status: 500, errorCode: "internal_error", errorName: "TypeError", message: "boom 91234567 a@b.co", method: "POST", route: "/api/foo?tel=91234567" });
    const rows = await prisma.appErrorLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "POST", route: "/api/foo", status: 500, errorCode: "internal_error", errorName: "TypeError", messageMasked: "boom [num] [email]", actorUserId: null });
    const list = await listRecentAppErrors(10);
    expect(list[0]).toMatchObject({ route: "/api/foo", status: 500, message: "boom [num] [email]" });
  });

  it("寫入時 prune 30 日前紀錄", async () => {
    await prisma.appErrorLog.create({ data: { route: "/old", status: 500, messageMasked: "old", createdAt: new Date(Date.now() - 31 * 86_400_000) } });
    await prisma.appErrorLog.create({ data: { route: "/recent", status: 500, messageMasked: "recent", createdAt: new Date(Date.now() - 5 * 86_400_000) } });
    await writeAppErrorLog({ status: 500, message: "new", route: "/new" });
    const routes = (await prisma.appErrorLog.findMany()).map((r) => r.route).sort();
    expect(routes).toEqual(["/new", "/recent"]);
  });

  it("handleApiError：非 ApiError → 500 JSON 不變，並 fire-and-forget 寫 log", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleApiError(new Error("kaboom 12345678"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error", message: "系統錯誤" });
    await vi.waitFor(async () => {
      const rows = await prisma.appErrorLog.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.messageMasked).toContain("[num]");
      expect(rows[0]!.messageMasked).not.toContain("12345678");
      expect(rows[0]!.status).toBe(500);
    });
  });

  it("handleApiError：ApiError（4xx）唔寫 log", async () => {
    const res = handleApiError(new ApiError(403, "forbidden", "冇權限"));
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 100));
    expect(await prisma.appErrorLog.count()).toBe(0);
  });

  it("log 寫入失敗（DB 拋錯）→ response 仍然係同一個 500 JSON，唔拋錯", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(prisma.appErrorLog, "create");
    // 用真 prisma client（lib/db 同 tests/lib/db 係唔同 instance）→ 改用 src/lib/db 嘅 client 令佢拋錯
    const { prisma: appPrisma } = await import("@/lib/db");
    const failing = vi.spyOn(appPrisma.appErrorLog, "create").mockRejectedValue(new Error("db down"));
    const res = await withApiError(async () => {
      throw new Error("route exploded");
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error", message: "系統錯誤" });
    await vi.waitFor(() => expect(failing).toHaveBeenCalled());
    spy.mockRestore();
  });

  it("writeAppErrorLog 本身永遠唔 throw（DB 拋錯）", async () => {
    const { prisma: appPrisma } = await import("@/lib/db");
    vi.spyOn(appPrisma.appErrorLog, "create").mockRejectedValue(new Error("db down"));
    await expect(writeAppErrorLog({ status: 500, message: "x", route: "/x" })).resolves.toBeUndefined();
  });
});

// 鎖住對 Next 內部 `work-async-storage.external` 嘅依賴（app-error-log.ts 用佢攞 route pattern）。Next 升級令內部路徑改咗就喺度 fail，唔會靜靜變成 route="(unknown)"。
describe("Next 內部依賴（work-async-storage.external）", () => {
  it("可以 import，workAsyncStorage.getStore 存在", async () => {
    const mod = await import("next/dist/server/app-render/work-async-storage.external");
    expect(typeof mod.workAsyncStorage.getStore).toBe("function");
  });
  it("normalizeAppPath 由 app route 檔案路徑出 pattern", async () => {
    const { normalizeAppPath } = await import("next/dist/shared/lib/router/utils/app-paths");
    expect(normalizeAppPath("/api/sites/[id]/route")).toBe("/api/sites/[id]");
  });
  it("app-error-log.ts 原始碼仍然 import 呢個內部模組", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/lib/app-error-log.ts", import.meta.url), "utf-8");
    expect(src).toContain("next/dist/server/app-render/work-async-storage.external");
  });
});
