// WP-UPLOAD-VOID（老闆 2026-09-25 追加要求）：更表上載頁「多檔拖放／
// 多選上載」——`src/lib/roster-upload/upload-queue.ts` 純函數單元測試
// （分類結果／並發隊列排程），零 DOM／React／DB 依賴。
import { describe, it, expect } from "vitest";
import { classifyUploadResult, runQueueWithConcurrency, summarizeOutcomes, type RosterUploadPostData, type RosterUploadApiResult, type UploadOutcome } from "@/lib/roster-upload/upload-queue";

function ok(overrides: Partial<Omit<RosterUploadPostData, "upload">> & { upload?: Partial<RosterUploadPostData["upload"]> }): RosterUploadApiResult {
  const data: RosterUploadPostData = {
    upload: {
      id: overrides.upload?.id ?? "u1",
      site_id: overrides.upload?.site_id === undefined ? "s1" : overrides.upload.site_id,
      version: overrides.upload?.version ?? 1,
      status: overrides.upload?.status ?? "parsed",
    },
    superseded_count: overrides.superseded_count ?? 0,
    parse_ok: overrides.parse_ok ?? true,
    parse_error: overrides.parse_error ?? null,
    duplicate_of_version: overrides.duplicate_of_version ?? null,
  };
  return { ok: true, status: 201, data };
}

describe("classifyUploadResult()", () => {
  it("ok:false → error，帶 message", () => {
    const outcome = classifyUploadResult({ ok: false, status: 400, error: "bad_request", message: "更新檔嘅檔名必須同舊版唔同" });
    expect(outcome.kind).toBe("error");
    expect(outcome.summary).toContain("更新檔嘅檔名必須同舊版唔同");
    expect(outcome.uploadId).toBeNull();
  });

  it("ok:true 但 parse_ok:false → parse_failed，帶 parse_error", () => {
    const outcome = classifyUploadResult(ok({ parse_ok: false, parse_error: "搵唔到 Date 表頭" }));
    expect(outcome.kind).toBe("parse_failed");
    expect(outcome.summary).toContain("搵唔到 Date 表頭");
    expect(outcome.uploadId).toBe("u1");
  });

  it("ok:true + parse_ok:true 但 site_id=null → unresolved（要指定盤）", () => {
    const outcome = classifyUploadResult(ok({ upload: { site_id: null } }));
    expect(outcome.kind).toBe("unresolved");
    expect(outcome.uploadId).toBe("u1");
  });

  it("ok:true + parse_ok:true + site_id 有值 → success", () => {
    const outcome = classifyUploadResult(ok({ upload: { version: 2 }, superseded_count: 1 }));
    expect(outcome.kind).toBe("success");
    expect(outcome.summary).toContain("v2");
    expect(outcome.summary).toContain("取代咗 1 個舊版");
  });

  it("success + duplicate_of_version → summary 提到 SHA-256 一樣", () => {
    const outcome = classifyUploadResult(ok({ duplicate_of_version: 3 }));
    expect(outcome.kind).toBe("success");
    expect(outcome.summary).toContain("第 3 版");
  });
});

describe("summarizeOutcomes()", () => {
  type Item = { status: "pending" | "uploading" | "done" | "cancelled"; outcome?: UploadOutcome };
  it("逐類數啱，pending/uploading 計入 inProgress，cancelled 唔計入任何類", () => {
    const items: Item[] = [
      { status: "done", outcome: { kind: "success", summary: "", uploadId: "1" } },
      { status: "done", outcome: { kind: "success", summary: "", uploadId: "2" } },
      { status: "done", outcome: { kind: "parse_failed", summary: "", uploadId: "3" } },
      { status: "done", outcome: { kind: "unresolved", summary: "", uploadId: "4" } },
      { status: "done", outcome: { kind: "error", summary: "", uploadId: null } },
      { status: "pending" },
      { status: "uploading" },
      { status: "cancelled" },
    ];
    const summary = summarizeOutcomes(items);
    expect(summary).toEqual({ total: 8, success: 2, parseFailed: 1, unresolved: 1, error: 1, inProgress: 2 });
  });

  it("空隊列", () => {
    expect(summarizeOutcomes([])).toEqual({ total: 0, success: 0, parseFailed: 0, unresolved: 0, error: 0, inProgress: 0 });
  });
});

describe("runQueueWithConcurrency()", () => {
  it("最多同時 concurrency 個 worker 行緊——實測某一刻同時執行數唔超過上限", async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ id: i, status: "pending" as "pending" | "uploading" | "done" }));
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];

    function pickNext() {
      const next = items.find((it) => it.status === "pending");
      if (!next) return null;
      next.status = "uploading";
      return next;
    }

    await runQueueWithConcurrency({
      items,
      concurrency: 2,
      pickNext,
      worker: async (item) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(item.id);
        await new Promise((r) => setTimeout(r, 5));
        item.status = "done";
        inFlight -= 1;
      },
    });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(order).toHaveLength(6);
    expect(items.every((it) => it.status === "done")).toBe(true);
  });

  it("冇 item（items 空）：唔會拋錯，即刻完", async () => {
    await expect(
      runQueueWithConcurrency({
        items: [] as { status: "pending" }[],
        concurrency: 2,
        pickNext: () => null,
        worker: async () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it("concurrency 大過 item 數：唔會多起 worker（冧唔起冇嘢做嘅 worker）", async () => {
    const items = [{ id: 1, status: "pending" as "pending" | "done" }];
    let started = 0;
    await runQueueWithConcurrency({
      items,
      concurrency: 5,
      pickNext: () => {
        const next = items.find((it) => it.status === "pending");
        if (!next) return null;
        next.status = "done";
        return next;
      },
      worker: async () => {
        started += 1;
      },
    });
    expect(started).toBe(1);
  });
});
