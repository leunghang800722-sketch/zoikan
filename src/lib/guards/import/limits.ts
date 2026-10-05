// WP-AI-OPS 驗收（第三輪）：非老闆導入規模限制（防止用批量 hkid／姓名探測現有安員）。老闆唔受限。
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

/** 非老闆每個導入包最多人數。 */
export const NON_BOSS_MAX_PERSONS = 500;
/** 非老闆每個用戶每 24 小時 preview＋apply（自動項）合共最多次數。覆核 decisions 嘅 apply 同分診作答唔計。 */
export const NON_BOSS_MAX_RUNS_PER_DAY = 20;
/** WP-GUARD-OCR §29：`source:"single_ocr"` 單人包獨立配額（唔食上面 20 次）：非老闆每 24 小時單人包 preview＋apply 合計。 */
export const NON_BOSS_MAX_SINGLE_OCR_RUNS_PER_DAY = 100;
/** 非老闆每 24 小時證件辨識（POST /api/guards/ocr/read）次數。 */
export const NON_BOSS_MAX_OCR_READS_PER_DAY = 100;
export const OCR_QUOTA_MSG = "今日證件辨識次數已達上限，請搵老闆，或者全部自己輸入";
export const QUOTA_MSG = "今日導入次數已達上限，請搵老闆";

export async function assertImportQuota(
  session: Pick<AuthedSession, "baseRole" | "userId">,
  db: Pick<typeof prisma, "$queryRaw"> = prisma,
  source?: "single_ocr",
): Promise<void> {
  if (session.baseRole === "老闆") return;
  // cutoff 喺 JS 計（UTC ISO）：created_at 係冇時區 timestamp（存 UTC），唔可以用 now()（受 session 時區影響）
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  if (source === "single_ocr") {
    // 單人包獨立配額：preview＋apply（含 decisions）合計；只數 package_source=single_ocr 嘅紀錄
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM audit_log
      WHERE actor_user_id = ${session.userId} AND created_at > ${since}::timestamp
        AND action IN ('guard_import_preview', 'guard_import_apply') AND (after->>'package_source') = 'single_ocr'`;
    if ((rows[0]?.n ?? 0) >= NON_BOSS_MAX_SINGLE_OCR_RUNS_PER_DAY) throw new ApiError(429, "too_many_requests", QUOTA_MSG);
    return;
  }
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log
    WHERE actor_user_id = ${session.userId} AND created_at > ${since}::timestamp
      AND (after->>'package_source') IS DISTINCT FROM 'single_ocr'
      AND (action = 'guard_import_preview'
        OR (action = 'guard_import_apply' AND (after->>'via') IS NULL AND coalesce((after->>'review_decisions')::int, 0) = 0))`;
  if ((rows[0]?.n ?? 0) >= NON_BOSS_MAX_RUNS_PER_DAY) throw new ApiError(429, "too_many_requests", QUOTA_MSG);
}

/** 證件辨識讀取每日上限（含失敗嗰次——audit 照寫）。老闆唔受限。 */
export async function assertOcrReadQuota(session: Pick<AuthedSession, "baseRole" | "userId">, db: Pick<typeof prisma, "$queryRaw"> = prisma): Promise<void> {
  if (session.baseRole === "老闆") return;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log
    WHERE actor_user_id = ${session.userId} AND created_at > ${since}::timestamp AND action = 'guard_ocr_read'`;
  if ((rows[0]?.n ?? 0) >= NON_BOSS_MAX_OCR_READS_PER_DAY) throw new ApiError(429, "too_many_requests", OCR_QUOTA_MSG);
}

/** preview 都寫一條 audit（計次數用）：淨係人數／計數／package_hash，冇 PII。 */
export async function auditImportPreview(session: Pick<AuthedSession, "userId">, ip: string | null, packageHash: string, persons: number, personStats: Record<string, number>, packageSource?: string): Promise<void> {
  await writeAudit({ actorUserId: session.userId, tableName: "guard_import", rowId: session.userId, action: "guard_import_preview", after: { persons, person_stats: personStats, package_hash: packageHash, ...(packageSource ? { package_source: packageSource } : {}) }, ip });
}

/**
 * 並發安全：非老闆喺「檢查配額 → 做嘢 → 寫 audit（計數用）」整段內按用戶持有 advisory lock（pg_advisory_xact_lock），
 * 令同一用戶嘅並發請求逐個過 check（後面嘅一定睇到前面已寫嘅 audit），唔會同時通過「先檢查後寫 audit」嘅空窗。
 * 內部嘅 DB 寫入照用全域 prisma（另一條 connection，已 commit 先釋放 lock）。老闆唔受限、唔上鎖。
 */
export async function withUserQuotaLock<T>(session: Pick<AuthedSession, "baseRole" | "userId">, scope: "import" | "ocr", fn: () => Promise<T>): Promise<T> {
  if (session.baseRole === "老闆") return fn();
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`guard_${scope}_quota:${session.userId}`}))`;
      return fn();
    },
    { timeout: 170_000, maxWait: 60_000 },
  );
}
