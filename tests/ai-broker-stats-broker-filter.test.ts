// 老闆正式站 feedback（2026-09-14）：問完「阿淦 7 月派咗幾多更」再追問
// 「有邊幾個盤」，模型冇直接工具可以答「某個雞頭逐盤分佈」，有時會跳去
// list_sites 答全公司盤名單。修法之一：broker_stats 加可選 `broker`
// 篩選＋ `sites` 逐盤分佈。呢度用 wp2 fixture（brokerA 一更／brokerB 一更，
// 同一個盤，2026-08）斷言：(a) 帶 broker 淨係回嗰個雞頭＋sites／site_count；
// (b) 口語「阿」開頭都對到；(c) 唔帶 broker 冇 sites 欄（舊行為不變）；
// (d) 對唔到任何雞頭 → brokers 空、site_count 0。
// PDPO：fixture 全部假名。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";
import { resetAiDbPoolForTests } from "@/lib/ai/db";
import { seedWp2Fixture, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { buildAiTools } from "@/lib/ai/tools";
import { computeFieldVisibility } from "@/lib/ai/field-scrub";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { RoleName } from "@/lib/rbac/matrix";

async function sessionFor(fx: Wp2Fixture, role: RoleName): Promise<AuthedSession> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: fx.userIds[role] }, include: { role: true } });
  return {
    userId: user.id,
    tel: user.tel,
    name: user.name,
    roleId: user.roleId,
    roleName: user.role.name,
    baseRole: user.role.baseRole as RoleName,
    brokerId: user.brokerId,
    guardId: user.guardId,
    payoutApprovalLimit: user.payoutApprovalLimit ? user.payoutApprovalLimit.toString() : null,
    tokenVersion: user.tokenVersion,
    loggedInAt: new Date().toISOString(),
  };
}

type BrokerStatsResult = {
  broker: string | null;
  site_count?: number;
  sites?: Array<{ site_name: string; shift_count: unknown; guard_count: unknown }>;
  brokers: Array<{ broker_display_name: string; shift_count: unknown }>;
  totals: { shift_count: number; guard_count: number };
  latest_month_with_data: string | null;
};

async function brokerStats(fx: Wp2Fixture, args: Record<string, unknown>): Promise<BrokerStatsResult> {
  const session = await sessionFor(fx, "老闆");
  const fieldVisibility = await computeFieldVisibility(session);
  const tools = buildAiTools({ session, fieldVisibility });
  const tool = tools.find((t) => (t as { name?: string }).name === "broker_stats")!;
  const raw = await (tool as { run: (args: unknown) => Promise<string> }).run(args);
  return JSON.parse(raw);
}

describe("broker_stats 雞頭篩選＋逐盤分佈（追問「有邊幾個盤」用）", () => {
  let fx: Wp2Fixture;

  // 注意：全局 setup 淨係將 DATABASE_URL 指去 zoikan_test，AI 唯讀
  // pool（AI_DATABASE_URL）預設仍然讀 .env（dev DB，冇 fixture）——呢個
  // test 要查真數據，所以自己喺 zoikan_test 建 zoikan_ai_ro 角色再指過去
  // （同 ai-ro-connection.test.ts 一樣做法）。
  const TEST_AI_PASSWORD = "test-ai-ro-password-0123456789";
  const prevAiUrl = process.env.AI_DATABASE_URL;

  beforeAll(async () => {
    await ensureAiRole({ databaseUrl: process.env.DATABASE_URL!, password: TEST_AI_PASSWORD });
    const url = new URL(process.env.DATABASE_URL!);
    url.username = AI_RO_ROLE;
    url.password = TEST_AI_PASSWORD;
    process.env.AI_DATABASE_URL = url.toString();
    resetAiDbPoolForTests();
    await clearAll();
    fx = await seedWp2Fixture();
  });

  afterAll(() => {
    process.env.AI_DATABASE_URL = prevAiUrl;
    resetAiDbPoolForTests();
  });

  it("(a) 帶 broker → 淨係回嗰個雞頭，並帶 sites／site_count，sites 更數加埋＝totals", async () => {
    const r = await brokerStats(fx, { broker: fx.brokerA.name, month: "2026-08" });
    expect(r.broker).toBe(fx.brokerA.name);
    expect(r.brokers).toHaveLength(1);
    expect(r.brokers[0].broker_display_name).toBe(fx.brokerA.name);
    expect(r.site_count).toBe(1);
    expect(r.sites).toHaveLength(1);
    expect(r.sites![0].site_name).toBe(fx.site.name);
    expect(Number(r.sites![0].shift_count)).toBe(1);
    expect(Number(r.sites![0].guard_count)).toBe(1);
    expect(r.totals.shift_count).toBe(1);
    expect(r.totals.guard_count).toBe(1);
    expect(r.latest_month_with_data).toBe("2026-08");
  });

  it("(b) 口語「阿＋名」都對到同一個雞頭", async () => {
    const r = await brokerStats(fx, { broker: `阿${fx.brokerA.name}`, month: "2026-08" });
    expect(r.broker).toBe(fx.brokerA.name);
    expect(r.brokers).toHaveLength(1);
    expect(r.site_count).toBe(1);
  });

  it("(c) 唔帶 broker → 舊行為：全部雞頭、冇 sites 欄", async () => {
    const r = await brokerStats(fx, { month: "2026-08" });
    expect(r.broker).toBeNull();
    expect(r.sites).toBeUndefined();
    expect(r.site_count).toBeUndefined();
    expect(r.brokers.length).toBeGreaterThanOrEqual(2);
    expect(r.totals.shift_count).toBe(2);
  });

  it("(d) 對唔到任何雞頭 → brokers 空、site_count 0（唔會跌落全公司）", async () => {
    const r = await brokerStats(fx, { broker: "唔存在嘅雞頭名", month: "2026-08" });
    expect(r.brokers).toHaveLength(0);
    expect(r.site_count).toBe(0);
    expect(r.totals.shift_count).toBe(0);
  });
});
