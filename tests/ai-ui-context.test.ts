// WP-AI2：`deriveAiContext()`（`src/lib/ui/ai-context.ts`）純函數——側欄
// AI 助手送問題嗰陣附嘅 `context`（見任務指示 §3），由目前網址解析出
// 邊個盤／邊個月。
import { describe, it, expect } from "vitest";
import { deriveAiContext } from "@/lib/ui/ai-context";

describe("WP-AI2 deriveAiContext——側欄 AI 助手網址解析", () => {
  it("更表頁 /roster/:site/:month → site_id/month", () => {
    const ctx = deriveAiContext("/roster/abc-123/2026-08");
    expect(ctx).toEqual({ path: "/roster/abc-123/2026-08", site_id: "abc-123", month: "2026-08" });
  });

  it("更表頁帶 ?broker= → broker", () => {
    const ctx = deriveAiContext("/roster/abc-123/2026-08", new URLSearchParams("broker=K"));
    expect(ctx.broker).toBe("K");
  });

  it("更表頁冇 ?broker= → context 冇 broker 呢個 key", () => {
    const ctx = deriveAiContext("/roster/abc-123/2026-08", new URLSearchParams());
    expect(ctx.broker).toBeUndefined();
  });

  it("毛利即時表 /reports/gross-margin?month= → 帶 month，冇 site_id", () => {
    const ctx = deriveAiContext("/reports/gross-margin", new URLSearchParams("month=2026-07"));
    expect(ctx.month).toBe("2026-07");
    expect(ctx.site_id).toBeUndefined();
  });

  it("其他頁面（例如 /guards）淨係帶 path", () => {
    expect(deriveAiContext("/guards")).toEqual({ path: "/guards" });
  });

  it("URL-encoded site/month 會 decode", () => {
    const ctx = deriveAiContext("/roster/%E5%95%9F%E8%88%AA1331/2026-08");
    expect(ctx.site_id).toBe("啟航1331");
  });

  it("接受 plain object 形式嘅 searchParams（唔一定要係 URLSearchParams instance）", () => {
    const ctx = deriveAiContext("/roster/site1/2026-07", { broker: "M" });
    expect(ctx.broker).toBe("M");
  });

  it("空 path fallback 做 /", () => {
    expect(deriveAiContext("")).toEqual({ path: "/" });
  });
});
