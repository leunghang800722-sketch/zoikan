// TE-1：分流題覆核證據裁圖清理（計劃書 §2.3／M5）。每日 03:30（香港）：
//  1. 刪 expires_at 已過期嘅圖（建立 180 日；跳過題 30 日——安全網）；
//  2. 刪孤兒圖：(session, person, field) 已冇 open／skipped 題需要（答題／supersede／session done 之後漏網者）。
// 分批 500；每批喺 TRIAGE_LOCK 下行（同答題 commit 序列化）。只計數（summary／audit 都冇圖、欄值、檔名）。
// 排程器本身已經用 PG advisory lock 保證同一 job 唔會雙跑。
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { TRIAGE_LOCK } from "@/lib/triage/session";
import { deleteUnneeded } from "@/lib/triage/evidence-images";
import type { JobDef, JobResult } from "@/lib/scheduler/types";

export const TRIAGE_EVIDENCE_CLEANUP_KEY = "triage_evidence_cleanup";
const BATCH = 500;

export async function runTriageEvidenceCleanup(now: Date): Promise<JobResult> {
  let expired = 0;
  let orphans = 0;
  // 1. 過期（分批：先攞 id，再刪）
  for (;;) {
    const ids = await prisma.triageEvidenceImage.findMany({ where: { expiresAt: { lt: now } }, select: { id: true }, take: BATCH });
    if (ids.length === 0) break;
    const r = await prisma.triageEvidenceImage.deleteMany({ where: { id: { in: ids.map((x) => x.id) } } });
    expired += r.count;
    if (ids.length < BATCH) break;
  }
  // 2. 孤兒：逐個 (session, person) 重算需要嘅欄（先攞齊 distinct pair——只係 id 類欄，數量 ≈ 人數；再分批 500 處理）
  const pairs = await prisma.triageEvidenceImage.findMany({ select: { sessionId: true, personKey: true }, distinct: ["sessionId", "personKey"], orderBy: [{ sessionId: "asc" }, { personKey: "asc" }] });
  for (let i = 0; i < pairs.length; i += BATCH) {
    const chunk = pairs.slice(i, i + BATCH);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
      for (const p of chunk) orphans += await deleteUnneeded(tx, p.sessionId, p.personKey);
    });
  }
  const total = expired + orphans;
  if (total > 0) await writeAudit({ actorUserId: null, tableName: "triage_sessions", rowId: "evidence-cleanup", action: "triage_evidence_cleanup", after: { expired, orphans } });
  return { status: total === 0 ? "skipped" : "ok", summary: { expired, orphans } };
}

export const triageEvidenceCleanupJob: JobDef = {
  key: TRIAGE_EVIDENCE_CLEANUP_KEY,
  label: "分流覆核證據裁圖清理",
  description: "每日檢查：刪過期（建立 180 日／跳過 30 日）同已冇題目需要嘅覆核證據裁圖。只計數。",
  defaultSchedule: "30 3 * * *",
  run: async (ctx) => runTriageEvidenceCleanup(ctx.now),
};
