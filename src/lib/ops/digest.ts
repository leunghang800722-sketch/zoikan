// WP-AI-OPS §28.2（第 0 期）：每月修正摘要＋基線。
//
// `buildOpsDigest(month)`——純讀、批量查詢（每個月固定條數 query，冇逐盤／
// 逐人 N+1），唔改任何現有報表數字。統計「呢個月結算要人手／系統修正咗乜」：
// guard-fix、對數決定、配對規則、價卡、更次修正、安員身份欄、批量導入、特殊項、
// 鎖月；加基線指標（一鍵結算次數／耗時、name_only／unmatched／ambiguous
// 格數、未定價、上載檔數、月尾到鎖月日數）同「連續出現」嘅重複類別。
//
// 鐵則：輸出**冇人名／工號／hkid／電話**——只有類別、盤名、雞頭代號、數字。
// （digest 會交俾 AI 摘要掣，亦會俾有「月結總表」view 嘅會計睇。）
//
// 「結算視窗」（時間類統計用）：由該月第一次（未作廢）更表上載起，計到鎖月或者
// 下個月第一次上載為止（取較早者；未鎖又冇下個月就到而家）。相鄰月份視窗唔重疊，
// 每件按時間嘅事只歸一個月。該月冇上載＝冇視窗＝按時間類別全部 0（window=null）。
// 有明確所屬月份嘅統計（更次修正按 work_date、特殊項
// 按 month、對數決定按上載月份、guard-fix 按 run 月份）唔用視窗，直接按月份。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { monthRange, monthStart as toMonthStart } from "@/lib/reports/money";
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { DIGEST_REPEAT_MIN_STREAK, DIGEST_TOP_N } from "./thresholds";

/**
 * 經批量導入／分診寫入嘅 guards audit 帶硬標記 `after.import_via`（guard_import｜triage，見 src/lib/guards/import/apply.ts auditTx），
 * 身份欄統計直接排除。冇標記嘅紀錄（標記上線前嘅舊資料，或者人手改）一律行舊啟發式 fallback：
 * 同一 actor 喺該筆之後 30 分鐘內有 guard_import_apply summary 就當導入。（冇日期分界，唔受時區影響。）
 */

export type DigestGroupKey = "guard_fix" | "reconcile" | "match" | "pricing" | "shifts" | "identity" | "import" | "special" | "lock";

export const DIGEST_GROUP_LABELS: Record<DigestGroupKey, string> = {
  guard_fix: "安員修復",
  reconcile: "對數決定",
  match: "配對規則",
  pricing: "價卡",
  shifts: "更次修正",
  identity: "安員身份欄",
  import: "批量導入",
  special: "特殊項",
  lock: "鎖月",
};

export const DIGEST_CATEGORIES: ReadonlyArray<{ key: string; group: DigestGroupKey; label: string }> = [
  { key: "guard_fix_link", group: "guard_fix", label: "連結到現有安員（link）" },
  { key: "guard_fix_create", group: "guard_fix", label: "新建安員（create）" },
  { key: "guard_fix_create_minimal", group: "guard_fix", label: "最簡新建（待 HR 補資料）" },
  { key: "guard_fix_skipped", group: "guard_fix", label: "跳過項（衝突／已處理）" },
  { key: "reconcile_keep_system", group: "reconcile", label: "對數：保留系統" },
  { key: "reconcile_exception", group: "reconcile", label: "對數：例外" },
  { key: "reconcile_apply_write", group: "reconcile", label: "對數：以更表為準（寫入更次）" },
  { key: "match_override_added", group: "match", label: "新增配對 override" },
  { key: "alias_added", group: "match", label: "新增別名" },
  { key: "rate_card_manual_created", group: "pricing", label: "價卡：人手新增" },
  { key: "rate_card_copied", group: "pricing", label: "價卡：複製上月" },
  { key: "rate_card_updated", group: "pricing", label: "價卡：修改" },
  { key: "reprice", group: "pricing", label: "重新計價（reprice）次數" },
  { key: "shift_manual_create", group: "shifts", label: "更次：人手新增" },
  { key: "shift_manual_update", group: "shifts", label: "更次：人手改" },
  { key: "shift_manual_void", group: "shifts", label: "更次：人手取消" },
  { key: "shift_approve", group: "shifts", label: "更次：審批批准" },
  { key: "shift_reject", group: "shifts", label: "更次：審批退回" },
  { key: "shift_auto_resync", group: "shifts", label: "更次：系統重配結算單位" },
  { key: "identity_hkid", group: "identity", label: "身份證欄修改" },
  { key: "identity_date_of_birth", group: "identity", label: "出生日期修改" },
  { key: "identity_address", group: "identity", label: "地址修改" },
  { key: "identity_name", group: "identity", label: "姓名修改" },
  { key: "identity_tel", group: "identity", label: "電話修改" },
  { key: "import_apply_runs", group: "import", label: "批量導入套用次數" },
  { key: "import_guards_created", group: "import", label: "導入新建安員" },
  { key: "import_guards_updated", group: "import", label: "導入更新安員" },
  { key: "import_field_conflicts", group: "import", label: "導入欄位衝突" },
  { key: "import_review_decisions", group: "import", label: "導入覆核決定" },
  { key: "special_item_create", group: "special", label: "特殊項：新增" },
  { key: "special_item_update", group: "special", label: "特殊項：修改" },
  { key: "special_item_void", group: "special", label: "特殊項：作廢" },
  { key: "month_lock", group: "lock", label: "鎖月" },
  { key: "month_unlock", group: "lock", label: "解鎖" },
];

export interface DigestWindow {
  from: string;
  to: string;
  basis: "first_upload_to_lock" | "first_upload_to_next_month" | "first_upload_to_now";
}

export interface DigestCategoryRow {
  key: string;
  group: DigestGroupKey;
  label: string;
  count: number;
  prevCount: number;
  /** 連續幾個月（包括本月，最多 3）呢個類別都 >0。 */
  streak: number;
}

export interface DigestBaseline {
  oneClick: {
    runs: number;
    doneRuns: number;
    failedRuns: number;
    avgDurationSec: number | null;
    maxDurationSec: number | null;
    /** 每次 run 嘅 needs_human 條數（按開始時間先到後）。 */
    needsHumanPerRun: number[];
  };
  nameOnlyCells: number;
  unmatchedCells: number;
  ambiguousCells: number;
  unpricedRecords: number;
  uploads: { files: number; reuploads: number; voided: number; superseded: number };
  /** 月尾（最後一日）到鎖月嘅日數；未鎖 null。 */
  daysMonthEndToLock: number | null;
}

export interface OpsDigest {
  month: string;
  prevMonth: string;
  /** null＝該月冇上載，按時間類別全部 0。 */
  window: DigestWindow | null;
  categories: DigestCategoryRow[];
  groupTotals: Array<{ group: DigestGroupKey; label: string; count: number; prevCount: number }>;
  baseline: DigestBaseline;
  prevBaseline: DigestBaseline;
  repeats: Array<{ key: string; label: string; streak: number }>;
  topSites: Array<{ siteName: string; count: number }>;
  topBrokers: Array<{ brokerCode: string; count: number }>;
  /** 更次修正總量（人手新增／改／取消＋對數寫入），top N 排名用。 */
  correctionTotal: number;
}

function label(month: Date): string {
  return month.toISOString().slice(0, 7);
}

export function addMonths(month: Date, delta: number): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + delta, 1));
}

interface UploadLite {
  id: string;
  status: string;
  version: number;
  voidedAt: Date | null;
  uploadedAt: Date;
}

interface MonthContext {
  month: Date;
  label: string;
  uploads: UploadLite[];
  monthCloseId: string | null;
  lockedAt: Date | null;
  window: DigestWindow | null;
}

/** 純函數：計結算視窗（有單元測試）。[首份未作廢上載, min(鎖月, 下個月視窗開始))；冇上載 → null。 */
export function computeDigestWindow(
  uploads: Array<{ voidedAt: Date | null; status: string; uploadedAt: Date }>,
  lockedAt: Date | null,
  now: Date,
  nextWindowStart: Date | null,
): DigestWindow | null {
  const live = uploads.filter((u) => !u.voidedAt && u.status !== "voided");
  if (live.length === 0) return null;
  const from = new Date(Math.min(...live.map((u) => u.uploadedAt.getTime())));
  let to = now;
  let basis: DigestWindow["basis"] = "first_upload_to_now";
  if (lockedAt && lockedAt.getTime() <= to.getTime()) {
    to = lockedAt;
    basis = "first_upload_to_lock";
  }
  if (nextWindowStart && nextWindowStart.getTime() <= to.getTime()) {
    to = nextWindowStart;
    basis = "first_upload_to_next_month";
  }
  if (to.getTime() < from.getTime()) to = from;
  return { from: from.toISOString(), to: to.toISOString(), basis };
}

/** months 要由新到舊（[M, M-1, M-2]）；下個月（M+1）嘅視窗開始時間用嚟截 M 嘅視窗尾。 */
async function loadContexts(months: Date[], now: Date): Promise<MonthContext[]> {
  const next = addMonths(months[0]!, 1);
  const all = [next, ...months];
  const [uploads, closes] = await Promise.all([
    prisma.rosterUpload.findMany({ where: { month: { in: all } }, select: { id: true, month: true, status: true, version: true, voidedAt: true, uploadedAt: true } }),
    prisma.monthClose.findMany({ where: { month: { in: all } }, select: { id: true, month: true, lockedAt: true } }),
  ]);
  const upOf = (m: Date) => uploads.filter((u) => u.month.getTime() === m.getTime());
  const startOf = (m: Date): Date | null => {
    const w = computeDigestWindow(upOf(m), null, now, null);
    return w ? new Date(w.from) : null;
  };
  return months.map((m, i) => {
    const mc = closes.find((c) => c.month.getTime() === m.getTime());
    const nextStart = startOf(i === 0 ? next : months[i - 1]!);
    return {
      month: m,
      label: label(m),
      uploads: upOf(m),
      monthCloseId: mc?.id ?? null,
      lockedAt: mc?.lockedAt ?? null,
      window: computeDigestWindow(upOf(m), mc?.lockedAt ?? null, now, nextStart),
    };
  });
}

function jsonLen(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

interface CategoryResult {
  counts: Map<string, number>;
  topSites: Array<{ siteName: string; count: number }>;
  topBrokers: Array<{ brokerCode: string; count: number }>;
}

/** 一個月嘅類別統計——固定 7 條 query（guard-fix runs、plan alias、決定、視窗 audit、
 * 月份 audit、top 盤、top 雞頭），唔隨盤數／人數增加。 */
async function collectCategories(ctx: MonthContext, withTop: boolean): Promise<CategoryResult> {
  const counts = new Map<string, number>();
  const add = (k: string, n: number) => counts.set(k, (counts.get(k) ?? 0) + n);
  const w0 = ctx.window;
  const from = new Date(w0?.from ?? 0);
  const to = new Date(w0?.to ?? 0);
  const lbl = ctx.label;

  const [fixRuns, aliasRows, decisions, win, lockRows, byMonth, topSitesRaw, topBrokersRaw] = await Promise.all([
    prisma.guardFixRun.findMany({ where: { month: ctx.month, status: "applied" }, select: { resultJson: true } }),
    prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM guard_fix_runs r,
           jsonb_array_elements(CASE WHEN jsonb_typeof(r.plan_json->'actions'->'link') = 'array' THEN r.plan_json->'actions'->'link' ELSE '[]'::jsonb END) e
      WHERE r.month = ${ctx.label + '-01'}::date AND r.status = 'applied' AND e->>'addAlias' IS NOT NULL`),
    prisma.rosterReconcileDecision.groupBy({ by: ["action"], where: { upload: { month: ctx.month } }, _count: { _all: true } }),
    w0
      ? prisma.$queryRaw<Array<Record<string, number>>>(Prisma.sql`
      SELECT
        count(*) FILTER (WHERE table_name = 'rate_cards' AND action = 'create' AND (after->>'copied_from') IS NOT NULL)::int AS rate_card_copied,
        count(*) FILTER (WHERE table_name = 'rate_cards' AND action = 'create' AND (after->>'copied_from') IS NULL)::int AS rate_card_manual_created,
        count(*) FILTER (WHERE table_name = 'rate_cards' AND action IN ('update', 'extend_effective_to'))::int AS rate_card_updated,
        count(*) FILTER (WHERE table_name = 'guard_match_overrides' AND action = 'create')::int AS match_override_added,
        count(*) FILTER (WHERE table_name = 'guards' AND action = 'update' AND jsonb_typeof(before) = 'object' AND jsonb_typeof(after) = 'object'
          AND jsonb_typeof(before->'name_aliases') = 'array' AND jsonb_typeof(after->'name_aliases') = 'array'
          AND jsonb_array_length(after->'name_aliases') > jsonb_array_length(before->'name_aliases'))::int AS alias_added_audit,
        count(*) FILTER (WHERE table_name = 'guards' AND action = 'update' AND jsonb_typeof(before) = 'object' AND jsonb_typeof(after) = 'object' AND (before->>'hkid') IS DISTINCT FROM (after->>'hkid') AND (after->>'import_via') IS NULL AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.table_name = 'guard_import' AND s.action = 'guard_import_apply' AND s.actor_user_id IS NOT DISTINCT FROM audit_log.actor_user_id AND s.created_at >= audit_log.created_at AND s.created_at <= audit_log.created_at + interval '30 minutes'))::int AS identity_hkid,
        count(*) FILTER (WHERE table_name = 'guards' AND action = 'update' AND jsonb_typeof(before) = 'object' AND jsonb_typeof(after) = 'object' AND (before->>'date_of_birth') IS DISTINCT FROM (after->>'date_of_birth') AND (after->>'import_via') IS NULL AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.table_name = 'guard_import' AND s.action = 'guard_import_apply' AND s.actor_user_id IS NOT DISTINCT FROM audit_log.actor_user_id AND s.created_at >= audit_log.created_at AND s.created_at <= audit_log.created_at + interval '30 minutes'))::int AS identity_date_of_birth,
        count(*) FILTER (WHERE table_name = 'guards' AND action = 'update' AND jsonb_typeof(before) = 'object' AND jsonb_typeof(after) = 'object' AND (before->>'address') IS DISTINCT FROM (after->>'address') AND (after->>'import_via') IS NULL AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.table_name = 'guard_import' AND s.action = 'guard_import_apply' AND s.actor_user_id IS NOT DISTINCT FROM audit_log.actor_user_id AND s.created_at >= audit_log.created_at AND s.created_at <= audit_log.created_at + interval '30 minutes'))::int AS identity_address,
        count(*) FILTER (WHERE table_name = 'guards' AND action = 'update' AND jsonb_typeof(before) = 'object' AND jsonb_typeof(after) = 'object' AND (before->>'name_zh') IS DISTINCT FROM (after->>'name_zh') AND (after->>'import_via') IS NULL AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.table_name = 'guard_import' AND s.action = 'guard_import_apply' AND s.actor_user_id IS NOT DISTINCT FROM audit_log.actor_user_id AND s.created_at >= audit_log.created_at AND s.created_at <= audit_log.created_at + interval '30 minutes'))::int AS identity_name,
        count(*) FILTER (WHERE table_name = 'guards' AND action = 'update' AND jsonb_typeof(before) = 'object' AND jsonb_typeof(after) = 'object' AND (before->>'tel') IS DISTINCT FROM (after->>'tel') AND (after->>'import_via') IS NULL AND NOT EXISTS (SELECT 1 FROM audit_log s WHERE s.table_name = 'guard_import' AND s.action = 'guard_import_apply' AND s.actor_user_id IS NOT DISTINCT FROM audit_log.actor_user_id AND s.created_at >= audit_log.created_at AND s.created_at <= audit_log.created_at + interval '30 minutes'))::int AS identity_tel,
        count(*) FILTER (WHERE table_name = 'guard_import' AND action = 'guard_import_apply')::int AS import_apply_runs,
        coalesce(sum((after->>'guards_created')::int) FILTER (WHERE table_name = 'guard_import' AND action = 'guard_import_apply'), 0)::int AS import_guards_created,
        coalesce(sum((after->>'guards_updated')::int) FILTER (WHERE table_name = 'guard_import' AND action = 'guard_import_apply'), 0)::int AS import_guards_updated,
        coalesce(sum((after->>'field_conflicts')::int) FILTER (WHERE table_name = 'guard_import' AND action = 'guard_import_apply'), 0)::int AS import_field_conflicts,
        coalesce(sum((after->>'review_decisions')::int) FILTER (WHERE table_name = 'guard_import' AND action = 'guard_import_apply'), 0)::int AS import_review_decisions
      FROM audit_log
      WHERE created_at >= ${from.toISOString()}::timestamp AND created_at < ${to.toISOString()}::timestamp
        AND table_name IN ('rate_cards', 'guard_match_overrides', 'guards', 'guard_import')`)
      : Promise.resolve([] as Array<Record<string, number>>),
    ctx.monthCloseId
      ? prisma.auditLog.groupBy({ by: ["action"], where: { tableName: "month_closes", rowId: ctx.monthCloseId, action: { in: ["lock_month", "unlock_month"] } }, _count: { _all: true } })
      : Promise.resolve([] as Array<{ action: string; _count: { _all: number } }>),
    prisma.$queryRaw<Array<{ cls: string; n: number }>>(Prisma.sql`
      SELECT cls, count(*)::int AS n FROM (
        SELECT CASE
          WHEN table_name = 'shift_records' AND action = 'reprice_month' THEN 'reprice'
          WHEN table_name = 'shift_records' AND action = 'void' AND coalesce(after->>'void_reason', '') LIKE 'roster_reconcile:%' THEN 'reconcile_apply_write'
          WHEN table_name = 'shift_records' AND action = 'create' AND coalesce(after->>'source', '') = 'roster_upload' THEN 'reconcile_apply_write'
          WHEN table_name = 'shift_records' AND action = 'update' AND coalesce(after->>'source', '') = 'roster_upload' AND jsonb_typeof(before) = 'object'
            AND (after->'provenance') IS DISTINCT FROM (before->'provenance') THEN 'reconcile_apply_write'
          WHEN table_name = 'shift_records' AND action = 'create' THEN 'shift_manual_create'
          WHEN table_name = 'shift_records' AND action = 'update' AND jsonb_typeof(before) = 'object' AND jsonb_typeof(after) = 'object'
            AND (after - 'updated_at' - 'settlement_broker_id' - 'operational_broker_id' - 'settlement_page') = (before - 'updated_at' - 'settlement_broker_id' - 'operational_broker_id' - 'settlement_page') THEN 'shift_auto_resync'
          WHEN table_name = 'shift_records' AND action = 'update' AND jsonb_typeof(before) = 'object' AND before->>'status' = 'pending_approval' AND (after->>'reject_reason') IS NOT NULL THEN 'shift_reject'
          WHEN table_name = 'shift_records' AND action = 'update' AND jsonb_typeof(before) = 'object' AND before->>'status' = 'pending_approval' AND after->>'status' = 'confirmed' THEN 'shift_approve'
          WHEN table_name = 'shift_records' AND action IN ('update', 'unvoid') THEN 'shift_manual_update'
          WHEN table_name = 'shift_records' AND action = 'void' THEN 'shift_manual_void'
          WHEN table_name = 'special_items' AND action = 'create' THEN 'special_item_create'
          WHEN table_name = 'special_items' AND action IN ('update', 'unvoid') THEN 'special_item_update'
          WHEN table_name = 'special_items' AND action = 'void' THEN 'special_item_void'
        END AS cls
        FROM audit_log
        WHERE table_name IN ('shift_records', 'special_items')
          AND (
            (table_name = 'shift_records' AND action = 'reprice_month' AND row_id LIKE ${"reprice:" + lbl + "%"})
            OR (table_name = 'shift_records' AND action <> 'reprice_month' AND left(coalesce(after->>'work_date', before->>'work_date', ''), 7) = ${lbl})
            OR (table_name = 'special_items' AND left(coalesce(after->>'month', before->>'month', ''), 7) = ${lbl})
          )
      ) t WHERE cls IS NOT NULL GROUP BY cls`),
    withTop
      ? prisma.$queryRaw<Array<{ name: string | null; n: number }>>(Prisma.sql`
          SELECT s.canonical_name AS name, count(*)::int AS n
          FROM audit_log a
          LEFT JOIN sites s ON s.id::text = coalesce(a.after->>'site_id', a.before->>'site_id')
          WHERE a.table_name = 'shift_records' AND a.action IN ('create', 'update', 'void', 'unvoid')
            AND left(coalesce(a.after->>'work_date', a.before->>'work_date', ''), 7) = ${lbl}
            AND NOT (a.action = 'update' AND jsonb_typeof(a.before) = 'object' AND jsonb_typeof(a.after) = 'object'
              AND (a.after - 'updated_at' - 'settlement_broker_id' - 'operational_broker_id' - 'settlement_page') = (a.before - 'updated_at' - 'settlement_broker_id' - 'operational_broker_id' - 'settlement_page'))
          GROUP BY s.canonical_name ORDER BY n DESC, s.canonical_name ASC LIMIT ${DIGEST_TOP_N}`)
      : Promise.resolve([]),
    withTop
      ? prisma.$queryRaw<Array<{ code: string | null; n: number }>>(Prisma.sql`
          SELECT b.code AS code, count(*)::int AS n
          FROM audit_log a
          LEFT JOIN brokers b ON b.id::text = coalesce(a.after->>'settlement_broker_id', a.before->>'settlement_broker_id')
          WHERE a.table_name = 'shift_records' AND a.action IN ('create', 'update', 'void', 'unvoid')
            AND left(coalesce(a.after->>'work_date', a.before->>'work_date', ''), 7) = ${lbl}
            AND NOT (a.action = 'update' AND jsonb_typeof(a.before) = 'object' AND jsonb_typeof(a.after) = 'object'
              AND (a.after - 'updated_at' - 'settlement_broker_id' - 'operational_broker_id' - 'settlement_page') = (a.before - 'updated_at' - 'settlement_broker_id' - 'operational_broker_id' - 'settlement_page'))
          GROUP BY b.code ORDER BY n DESC, b.code ASC LIMIT ${DIGEST_TOP_N}`)
      : Promise.resolve([]),
  ]);

  // guard-fix：applied runs 嘅 result_json.diffs.{link,create,createMinimal}.{create,skip}
  for (const r of fixRuns) {
    const diffs = (r.resultJson as { diffs?: Record<string, { create?: unknown; skip?: unknown }> } | null)?.diffs;
    if (!diffs) continue;
    add("guard_fix_link", jsonLen(diffs.link?.create));
    add("guard_fix_create", jsonLen(diffs.create?.create));
    add("guard_fix_create_minimal", jsonLen(diffs.createMinimal?.create));
    add("guard_fix_skipped", jsonLen(diffs.link?.skip) + jsonLen(diffs.create?.skip) + jsonLen(diffs.createMinimal?.skip));
  }
  for (const d of decisions) {
    if (d.action === "keep_system") add("reconcile_keep_system", d._count._all);
    else if (d.action === "exception") add("reconcile_exception", d._count._all);
  }
  const w = win[0] ?? {};
  for (const k of ["rate_card_copied", "rate_card_manual_created", "rate_card_updated", "match_override_added", "identity_hkid", "identity_date_of_birth", "identity_address", "identity_name", "identity_tel", "import_apply_runs", "import_guards_created", "import_guards_updated", "import_field_conflicts", "import_review_decisions"]) {
    add(k, Number(w[k] ?? 0));
  }
  for (const r of lockRows) add(r.action === "lock_month" ? "month_lock" : "month_unlock", r._count._all);
  add("alias_added", Number(aliasRows[0]?.n ?? 0) + Number(w.alias_added_audit ?? 0));
  for (const r of byMonth) add(r.cls, r.n);

  return {
    counts,
    topSites: topSitesRaw.filter((r) => r.name).map((r) => ({ siteName: r.name as string, count: r.n })),
    topBrokers: topBrokersRaw.filter((r) => r.code).map((r) => ({ brokerCode: r.code as string, count: r.n })),
  };
}

function stepsNeedsHuman(stepsJson: unknown): number {
  if (!Array.isArray(stepsJson)) return 0;
  let n = 0;
  for (const s of stepsJson as Array<Record<string, unknown>>) {
    n += jsonLen(s.needsHuman ?? s.needs_human);
  }
  return n;
}

/** 純函數：一鍵結算 runs → 基線（有單元測試）。 */
export function summarizeOneClickRuns(runs: Array<{ status: string; startedAt: Date; finishedAt: Date | null; stepsJson: unknown }>): DigestBaseline["oneClick"] {
  const sorted = [...runs].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const durations = sorted.filter((r) => r.finishedAt).map((r) => Math.round(((r.finishedAt as Date).getTime() - r.startedAt.getTime()) / 100) / 10);
  return {
    runs: sorted.length,
    doneRuns: sorted.filter((r) => r.status === "done").length,
    failedRuns: sorted.filter((r) => r.status === "failed").length,
    avgDurationSec: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
    maxDurationSec: durations.length ? Math.max(...durations) : null,
    needsHumanPerRun: sorted.map((r) => stepsNeedsHuman(r.stepsJson)),
  };
}

async function collectBaseline(ctx: MonthContext, session: AuthedSession): Promise<DigestBaseline> {
  const activeIds = ctx.uploads.filter((u) => (u.status === "parsed" || u.status === "confirmed") && !u.voidedAt).map((u) => u.id);
  const [runs, rowGroups, unpriced] = await Promise.all([
    prisma.monthCloseRun.findMany({ where: { month: ctx.month }, select: { status: true, startedAt: true, finishedAt: true, stepsJson: true } }),
    activeIds.length
      ? prisma.rosterUploadRow.groupBy({
          by: ["guardMatch", "matchBasis"],
          where: { uploadId: { in: activeIds }, codeKind: { in: ["shift", "ot", "leave"] } },
          _count: { _all: true },
        })
      : Promise.resolve([] as Array<{ guardMatch: string; matchBasis: string | null; _count: { _all: number } }>),
    buildUnpricedSummary(session, ctx.month),
  ]);
  let nameOnly = 0;
  let unmatched = 0;
  let ambiguous = 0;
  for (const g of rowGroups) {
    if (g.matchBasis === "name_only" && g.guardMatch !== "unmatched" && g.guardMatch !== "ambiguous") nameOnly += g._count._all;
    if (g.guardMatch === "unmatched") unmatched += g._count._all;
    if (g.guardMatch === "ambiguous") ambiguous += g._count._all;
  }
  const { end } = monthRange(ctx.month);
  return {
    oneClick: summarizeOneClickRuns(runs),
    nameOnlyCells: nameOnly,
    unmatchedCells: unmatched,
    ambiguousCells: ambiguous,
    unpricedRecords: unpriced.count,
    uploads: {
      files: ctx.uploads.length,
      reuploads: ctx.uploads.filter((u) => u.version > 1).length,
      voided: ctx.uploads.filter((u) => u.status === "voided" || u.voidedAt).length,
      superseded: ctx.uploads.filter((u) => u.status === "superseded").length,
    },
    daysMonthEndToLock: ctx.lockedAt ? Math.round((ctx.lockedAt.getTime() - (end.getTime() + 86_400_000)) / 86_400_000 * 10) / 10 : null,
  };
}

export async function buildOpsDigest(month: Date, session: AuthedSession, now: Date = new Date()): Promise<OpsDigest> {
  const m0 = toMonthStart(month);
  const m1 = addMonths(m0, -1);
  const m2 = addMonths(m0, -2);
  const [c0, c1, c2] = await loadContexts([m0, m1, m2], now);

  const [r0, r1, r2, b0, b1] = await Promise.all([
    collectCategories(c0!, true),
    collectCategories(c1!, false),
    collectCategories(c2!, false),
    collectBaseline(c0!, session),
    collectBaseline(c1!, session),
  ]);

  const categories: DigestCategoryRow[] = DIGEST_CATEGORIES.map((c) => {
    const cur = r0.counts.get(c.key) ?? 0;
    const p1 = r1.counts.get(c.key) ?? 0;
    const p2 = r2.counts.get(c.key) ?? 0;
    const streak = cur > 0 ? 1 + (p1 > 0 ? 1 + (p2 > 0 ? 1 : 0) : 0) : 0;
    return { key: c.key, group: c.group, label: c.label, count: cur, prevCount: p1, streak };
  });
  const groupTotals = (Object.keys(DIGEST_GROUP_LABELS) as DigestGroupKey[]).map((g) => ({
    group: g,
    label: DIGEST_GROUP_LABELS[g],
    count: categories.filter((c) => c.group === g).reduce((a, c) => a + c.count, 0),
    prevCount: categories.filter((c) => c.group === g).reduce((a, c) => a + c.prevCount, 0),
  }));
  const correctionKeys = ["shift_manual_create", "shift_manual_update", "shift_manual_void", "reconcile_apply_write"];
  return {
    month: c0!.label,
    prevMonth: c1!.label,
    window: c0!.window,
    categories,
    groupTotals,
    baseline: b0,
    prevBaseline: b1,
    repeats: categories.filter((c) => c.streak >= DIGEST_REPEAT_MIN_STREAK).map((c) => ({ key: c.key, label: c.label, streak: c.streak })),
    topSites: r0.topSites,
    topBrokers: r0.topBrokers,
    correctionTotal: categories.filter((c) => correctionKeys.includes(c.key)).reduce((a, c) => a + c.count, 0),
  };
}
