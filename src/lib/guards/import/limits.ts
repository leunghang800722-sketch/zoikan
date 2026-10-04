// WP-AI-OPS 驗收（第三輪）：非老闆導入規模限制（防止用批量 hkid／姓名探測現有安員）。老闆唔受限。
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

/** 非老闆每個導入包最多人數。 */
export const NON_BOSS_MAX_PERSONS = 500;
/** 非老闆每個用戶每 24 小時 preview＋apply（自動項）合共最多次數。覆核 decisions 嘅 apply 同分診作答唔計。 */
export const NON_BOSS_MAX_RUNS_PER_DAY = 20;
export const QUOTA_MSG = "今日導入次數已達上限，請搵老闆";

export async function assertImportQuota(session: Pick<AuthedSession, "baseRole" | "userId">, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<void> {
  if (session.baseRole === "老闆") return;
  // cutoff 喺 JS 計（UTC ISO）：created_at 係冇時區 timestamp（存 UTC），唔可以用 now()（受 session 時區影響）
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log
    WHERE actor_user_id = ${session.userId} AND created_at > ${since}::timestamp
      AND (action = 'guard_import_preview'
        OR (action = 'guard_import_apply' AND (after->>'via') IS NULL AND coalesce((after->>'review_decisions')::int, 0) = 0))`;
  if ((rows[0]?.n ?? 0) >= NON_BOSS_MAX_RUNS_PER_DAY) throw new ApiError(429, "too_many_requests", QUOTA_MSG);
}

/** preview 都寫一條 audit（計次數用）：淨係人數／計數／package_hash，冇 PII。 */
export async function auditImportPreview(session: Pick<AuthedSession, "userId">, ip: string | null, packageHash: string, persons: number, personStats: Record<string, number>): Promise<void> {
  await writeAudit({ actorUserId: session.userId, tableName: "guard_import", rowId: session.userId, action: "guard_import_preview", after: { persons, person_stats: personStats, package_hash: packageHash }, ip });
}
