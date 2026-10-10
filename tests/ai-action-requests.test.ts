// WP-AI-DIAG（§37.4／2.5）：撳建議動作卡發出嘅 request 必須同人手操作嗰個頁面「一字不差」。
// 兩層斷言：(1) 卡 → request 對照等於預期字面（URL／method／body）；(2) 掃人手操作 call site 原始碼，
// 確認呢啲 call site 仍然係同樣形狀（如果有人改咗人手頁面，呢度會紅，逼人同步改卡）；(3) 真係經 apiPost／apiPatch 發出（mock fetch）。
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sanitizeActionCards, type ActionCard } from "@/lib/ai/actions";
import { requestForAction, triagePreviewRequest, triageAnswerRequest, triageAnswerOf, runSpec, describeAction } from "@/lib/ui/ai-action-requests";

const ROOT = path.resolve(__dirname, "..");
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

function card(c: unknown): ActionCard {
  const r = sanitizeActionCards([c]);
  if (r.length !== 1) throw new Error("test card invalid");
  return r[0]!;
}
const base = { label: "測試動作", basis: "測試依據" };

describe("卡 → request（字面對照）", () => {
  it("one_click_run", () => {
    expect(requestForAction(card({ type: "one_click_run", ...base, params: { month: "2026-09" } }))).toEqual({ method: "POST", url: "/api/month-close/one-click", body: { month: "2026-09" } });
  });
  it("backfill_from_postorder", () => {
    expect(requestForAction(card({ type: "backfill_from_postorder", ...base, params: { month: "2026-09" } }))).toEqual({ method: "POST", url: "/api/rate-cards/backfill-from-postorder", body: { month: "2026-09" } });
  });
  it("site_set_default_broker", () => {
    expect(requestForAction(card({ type: "site_set_default_broker", ...base, params: { site_id: "site-1", broker_id: "brk-1" } }))).toEqual({
      method: "PATCH",
      url: "/api/sites/site-1",
      body: { default_settlement_broker_id: "brk-1" },
    });
  });
  it("roster_reparse（冇 body）", () => {
    const spec = requestForAction(card({ type: "roster_reparse", ...base, params: { upload_id: "up-1" } }))!;
    expect(spec).toEqual({ method: "POST", url: "/api/roster-uploads/up-1/reparse" });
    expect("body" in spec).toBe(false);
  });
  it("open_page 同 triage_answer 唔經 requestForAction", () => {
    expect(requestForAction(card({ type: "open_page", ...base, params: { href: "/triage" } }))).toBeNull();
    expect(requestForAction(card({ type: "triage_answer", ...base, params: { question_id: "q1", option: "mc_accept" } }))).toBeNull();
  });
  it("triage preview → answer（帶 preview_hash）", () => {
    const c = card({ type: "triage_answer", ...base, params: { question_id: "q-1", option: "mc_pick", candidate_id: "c-1" } }) as Extract<ActionCard, { type: "triage_answer" }>;
    expect(triageAnswerOf(c)).toEqual({ option: "mc_pick", candidate_id: "c-1" });
    expect(triagePreviewRequest(c)).toEqual({ method: "POST", url: "/api/triage/questions/q-1/preview", body: { answer: { option: "mc_pick", candidate_id: "c-1" } } });
    expect(triageAnswerRequest(c, "h".repeat(64))).toEqual({
      method: "POST",
      url: "/api/triage/questions/q-1/answer",
      body: { answer: { option: "mc_pick", candidate_id: "c-1" }, preview_hash: "h".repeat(64) },
    });
    const noCand = card({ type: "triage_answer", ...base, params: { question_id: "q-2", option: "mc_ack" } }) as Extract<ActionCard, { type: "triage_answer" }>;
    expect(triageAnswerOf(noCand)).toEqual({ option: "mc_ack" });
  });
  it("每種 type 都有「會做乜」一句", () => {
    for (const c of [
      { type: "open_page", params: { href: "/triage" } },
      { type: "one_click_run", params: { month: "2026-09" } },
      { type: "backfill_from_postorder", params: { month: "2026-09" } },
      { type: "site_set_default_broker", params: { site_id: "s", broker_id: "b" } },
      { type: "roster_reparse", params: { upload_id: "u" } },
      { type: "triage_answer", params: { question_id: "q", option: "mc_ack" } },
    ]) {
      expect(describeAction(card({ ...c, ...base })).length).toBeGreaterThan(5);
    }
  });
});

describe("人手操作 call site 仍然同卡一致（原始碼掃描）", () => {
  it("月結頁「一鍵結算」：apiPost(`/api/month-close/one-click`, { month })", () => {
    expect(src("src/app/(app)/month-close/page.tsx")).toContain("apiPost<{ run_id: string; status: string }>(`/api/month-close/one-click`, { month })");
  });
  it("補齊價目卡掣：apiPost(\"/api/rate-cards/backfill-from-postorder\", { month })", () => {
    expect(src("src/app/(app)/month-close/BackfillButton.tsx")).toContain('apiPost<BackfillRes>("/api/rate-cards/backfill-from-postorder", { month })');
  });
  it("盤管理「採用預設雞頭」：apiPatch(`/api/sites/${editingId}`, { default_settlement_broker_id })", () => {
    expect(src("src/app/(app)/sites/page.tsx")).toContain("apiPatch(`/api/sites/${editingId}`, { default_settlement_broker_id: suggestion.suggestion.broker_id })");
  });
  it("更表上載「重新解析」：apiPost(`/api/roster-uploads/${uploadId}/reparse`)（冇 body）", () => {
    expect(src("src/app/(app)/roster-uploads/RosterUploadsClient.tsx")).toContain("apiPost(`/api/roster-uploads/${uploadId}/reparse`)");
  });
  it("分診：preview { answer } → answer { answer, preview_hash }", () => {
    const s = src("src/components/MonthCloseTriageDialog.tsx");
    expect(s).toContain("`/api/triage/questions/${item.id}/preview`, { answer: item.answer }");
    expect(s).toContain("`/api/triage/questions/${item.id}/answer`, { answer: item.answer, preview_hash: pv.data.preview_hash }");
  });
});

describe("經現有 client 真係發出（mock fetch）", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POST 帶 JSON body；roster_reparse 冇 body；PATCH 帶 body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    await runSpec(requestForAction(card({ type: "one_click_run", ...base, params: { month: "2026-09" } }))!);
    await runSpec(requestForAction(card({ type: "roster_reparse", ...base, params: { upload_id: "up-1" } }))!);
    await runSpec(requestForAction(card({ type: "site_set_default_broker", ...base, params: { site_id: "site-1", broker_id: "brk-1" } }))!);
    expect(calls.map((c) => [c.init.method, c.url, c.init.body])).toEqual([
      ["POST", "/api/month-close/one-click", JSON.stringify({ month: "2026-09" })],
      ["POST", "/api/roster-uploads/up-1/reparse", undefined],
      ["PATCH", "/api/sites/site-1", JSON.stringify({ default_settlement_broker_id: "brk-1" })],
    ]);
  });

  it("API 失敗 → 回傳 message（卡上顯示）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "month_locked", message: "月份已鎖定" }), { status: 403 })));
    const res = await runSpec(requestForAction(card({ type: "one_click_run", ...base, params: { month: "2026-09" } }))!);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe("月份已鎖定");
  });
});
