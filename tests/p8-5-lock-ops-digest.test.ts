// P8.5：鎖月後推送每月修正摘要——無 AI 設定時仍推數字摘要、AI 成功附 AI 摘要、AI 失敗／guard／含 PII 退回數字、同月只一次、內容 PII 掃描。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { runLockOpsDigest, lockOpsDigestJob, numericDigestText } from "@/lib/jobs/lock-ops-digest";
import { ensureJobRows } from "@/lib/scheduler/runner";
import { buildOpsDigest } from "@/lib/ops/digest";
import { getJobReaderSession } from "@/lib/jobs/session";
import { setLlmClientForTests, type LlmClient } from "@/lib/ai/llm";
import { ensureSystemUser } from "@/lib/system-user";
import { assertNoPii } from "@/lib/notify/create";

const AUG = new Date(Date.UTC(2026, 7, 1));
const AI_ENV = ["AI_LLM", "AI_PROVIDER", "CLAUDE_API_KEY", "DEEPSEEK_API_KEY", "AI_HUB_API_KEY"] as const;

function stubClient(text: string | Error): LlmClient {
  return {
    chat: async () => {
      if (text instanceof Error) throw text;
      return { text, toolsUsed: [], inputTokens: 11, outputTokens: 7 } as never;
    },
  } as unknown as LlmClient;
}

describe("P8.5 lock_ops_digest", () => {
  let fx: Wp2Fixture;
  const saved: Record<string, string | undefined> = {};
  beforeEach(async () => {
    for (const k of AI_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    setLlmClientForTests(undefined);
    await clearAll();
    fx = await seedWp2Fixture();
    await ensureJobRows([lockOpsDigestJob]);
    await prisma.monthClose.upsert({ where: { month: AUG }, create: { month: AUG, lockedAt: new Date(), lockedBy: fx.userIds["老闆"], createdBy: "test" }, update: { lockedAt: new Date() } });
  });
  afterEach(() => {
    for (const k of AI_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    setLlmClientForTests(undefined);
  });

  const digestNotes = (label = "2026-08") => prisma.appNotification.findMany({ where: { kind: "ops_digest_ready", title: { startsWith: label } } });

  it("冇 AI 設定：仍推數字摘要（只通知老闆、連結 ops-digest）、無 PII、數字同 digest 一致", async () => {
    const r = await runLockOpsDigest(new Date());
    expect((r.summary as { months: Record<string, { ai: boolean }> }).months["2026-08"]).toEqual({ ai: false, notified: true });
    const ns = await digestNotes();
    expect(ns).toHaveLength(1);
    expect(ns[0]!.audience).toEqual(["老闆"]);
    expect(ns[0]!.href).toBe("/reports/ops-digest?month=2026-08");
    expect(ns[0]!.body).not.toContain("AI 摘要");
    const digest = await buildOpsDigest(AUG, await getJobReaderSession());
    expect(ns[0]!.body).toBe(numericDigestText(digest));
    expect(ns[0]!.body).toMatch(/^2026-08 每月修正摘要：/);
    expect(() => assertNoPii(ns[0]!.title, ns[0]!.body)).not.toThrow();
    expect(await prisma.auditLog.count({ where: { tableName: "ai_chat", rowId: "lock_ops_digest" } })).toBe(0);
  });

  it("有 AI：附 AI 摘要文字＋ai_chat audit（actor null、by_job）", async () => {
    process.env.AI_PROVIDER = "fake";
    setLlmClientForTests(stubClient("本月最大修正係更次修正，同上月相比下降，建議補價卡減少未定價。"));
    const r = await runLockOpsDigest(new Date());
    expect((r.summary as { months: Record<string, { ai: boolean }> }).months["2026-08"]!.ai).toBe(true);
    const n = (await digestNotes())[0]!;
    expect(n.body).toContain("\nAI 摘要：本月最大修正係更次修正");
    expect(() => assertNoPii(n.title, n.body)).not.toThrow();
    const audits = await prisma.auditLog.findMany({ where: { tableName: "ai_chat", rowId: "lock_ops_digest" } });
    const a = audits.find((x) => (x.after as { month?: string }).month === "2026-08")!;
    expect(a.actorUserId).toBe(await ensureSystemUser());
    expect(a.after).toMatchObject({ source: "ops_digest", by_job: "lock_ops_digest", month: "2026-08", input_tokens: 11, output_tokens: 7 });
  });

  it("AI 失敗：只推數字摘要，job 唔爆", async () => {
    process.env.AI_PROVIDER = "fake";
    setLlmClientForTests(stubClient(new Error("provider down")));
    const r = await runLockOpsDigest(new Date());
    expect((r.summary as { months: Record<string, { ai: boolean }> }).months["2026-08"]).toEqual({ ai: false, notified: true });
    expect((await digestNotes())[0]!.body).not.toContain("AI 摘要");
  });

  it("AI 文字含個人資料（8 位電話／電郵）：assertNoPii 拒絕後退回只推數字", async () => {
    process.env.AI_PROVIDER = "fake";
    setLlmClientForTests(stubClient("請聯絡 91234567 或 a@b.com 跟進。"));
    await runLockOpsDigest(new Date());
    const n = (await digestNotes())[0]!;
    expect(n.body).not.toContain("91234567");
    expect(n.body).not.toContain("AI 摘要");
  });

  it("輸出 guard 觸發（模型出 SQL）：丟棄 AI 文字，只推數字", async () => {
    process.env.AI_PROVIDER = "fake";
    setLlmClientForTests(stubClient("你可以執行 DROP TABLE guards 來修正。"));
    await runLockOpsDigest(new Date());
    expect((await digestNotes())[0]!.body).not.toContain("AI 摘要");
  });

  it("同月只一次（dedupe）；重新鎖月再跑唔重複推送；未鎖月份唔推", async () => {
    await runLockOpsDigest(new Date());
    await prisma.monthClose.update({ where: { month: AUG }, data: { lockedAt: new Date(Date.now() + 5000) } });
    await runLockOpsDigest(new Date(Date.now() + 60_000));
    expect(await digestNotes()).toHaveLength(1);
    await prisma.monthClose.deleteMany({});
    await prisma.appNotification.deleteMany({});
    const r = await runLockOpsDigest(new Date(Date.now() + 120_000));
    expect(r.status).toBe("skipped");
    expect(await prisma.appNotification.count({ where: { kind: "ops_digest_ready" } })).toBe(0);
  });
});
