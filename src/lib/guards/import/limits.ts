// WP-AI-OPS 驗收（第三輪）：非老闆導入規模限制（防止用批量 hkid／姓名探測現有保安員）。老闆唔受限。
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { writeAudit, writeAuditTx } from "@/lib/audit";
import { randomUUID } from "node:crypto";
import type { AuthedSession } from "@/lib/rbac/requirePermission";

/** 非老闆每個導入包最多人數。 */
export const NON_BOSS_MAX_PERSONS = 500;
/** 非老闆每個用戶每 24 小時 preview＋apply（自動項）合共最多次數。覆核 decisions 嘅 apply 同分診作答唔計。 */
export const NON_BOSS_MAX_RUNS_PER_DAY = 20;
/** WP-GUARD-OCR §29：`source:"single_ocr"` 單人包獨立配額（唔食上面 20 次）：非老闆每 24 小時單人包 preview＋apply 合計。 */
export const NON_BOSS_MAX_SINGLE_OCR_RUNS_PER_DAY = 100;
/** 非老闆每 24 小時證件辨識（POST /api/guards/ocr/read）次數。 */
export const NON_BOSS_MAX_OCR_READS_PER_DAY = 100;
const OCR_QUOTA_MSG = "今日證件辨識次數已達上限，請搵老闆，或者全部自己輸入";
const QUOTA_MSG = "今日導入次數已達上限，請搵老闆";

export type QuotaKind = "ocr" | "batch" | "single_ocr";
const QUOTA_LIMIT: Record<QuotaKind, number> = { ocr: NON_BOSS_MAX_OCR_READS_PER_DAY, batch: NON_BOSS_MAX_RUNS_PER_DAY, single_ocr: NON_BOSS_MAX_SINGLE_OCR_RUNS_PER_DAY };
const QUOTA_MSG_BY_KIND: Record<QuotaKind, string> = { ocr: OCR_QUOTA_MSG, batch: QUOTA_MSG, single_ocr: QUOTA_MSG };
const QUOTA_BUSY_MSG = "上一個請求未完成，請稍後再試";
/** 預留行 action：限額「只數」呢種行；結果 audit（guard_ocr_read／guard_import_preview／guard_import_apply）唔計，冇雙重計數。 */
export const QUOTA_RESERVE_ACTION = "guard_quota_reserve";

/**
 * 數過去 24 小時某用戶某類預留行。cutoff 喺 JS 計（UTC ISO）：created_at 係冇時區 timestamp（存 UTC），唔可以用 now()（受 session 時區影響）。
 * 過渡：部署時過去 24 小時冇預留行＝由 0 開始計（舊版以結果 audit 計數，唔回溯），可以接受。
 */
export async function countReservations(db: Pick<typeof prisma, "$queryRaw">, userId: string, kind: QuotaKind): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log
    WHERE actor_user_id = ${userId} AND action = ${QUOTA_RESERVE_ACTION} AND created_at > ${since}::timestamp
      AND (after->>'kind') = ${kind}`;
  return rows[0]?.n ?? 0;
}

/**
 * 預留式配額（並發安全、唔佔長連線）：
 *  短 transaction：按用戶 pg_advisory_xact_lock → 數預留行 → 未超就寫一條預留 audit（只有 kind＋request_id，冇 PII）→ commit。
 *  鎖喺 commit 即釋放；之後先（鎖外）呼叫模型／做 preview／apply。失敗／超時唔退還次數。
 *  攞唔到連線／鎖（pool 滿、等太耐）→ 429「上一個請求未完成」，唔係 500。
 *  老闆唔受限，亦唔寫預留行。
 */
export async function reserveQuota(session: Pick<AuthedSession, "baseRole" | "userId">, kind: QuotaKind): Promise<void> {
  if (session.baseRole === "老闆") return;
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`guard_quota:${session.userId}`}))`;
        if ((await countReservations(tx, session.userId, kind)) >= QUOTA_LIMIT[kind]) throw new ApiError(429, "too_many_requests", QUOTA_MSG_BY_KIND[kind]);
        await writeAuditTx(tx, { actorUserId: session.userId, tableName: "guard_quota", rowId: session.userId, action: QUOTA_RESERVE_ACTION as never, after: { kind, request_id: randomUUID() } });
      },
      { maxWait: 3000, timeout: 8000 },
    );
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // Prisma P2028（拿唔到連線／transaction 逾時）：當作上一個請求仲未完成
    if (typeof e === "object" && e && (e as { code?: string }).code === "P2028") throw new ApiError(429, "too_many_requests", QUOTA_BUSY_MSG);
    throw e;
  }
}

/** preview 都寫一條 audit（計次數用）：淨係人數／計數／package_hash，冇 PII。 */
export async function auditImportPreview(session: Pick<AuthedSession, "userId">, ip: string | null, packageHash: string, persons: number, personStats: Record<string, number>, packageSource?: string): Promise<void> {
  await writeAudit({ actorUserId: session.userId, tableName: "guard_import", rowId: session.userId, action: "guard_import_preview", after: { persons, person_stats: personStats, package_hash: packageHash, ...(packageSource ? { package_source: packageSource } : {}) }, ip });
}
