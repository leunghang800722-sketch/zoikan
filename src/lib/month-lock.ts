// 月份鎖定：month_closes.locked_at 非空嘅月份，任何寫入拒絕（403＋audit）。
// 解鎖要專門權限（糧務:void，見 rbac/matrix.ts 註解）。
import { prisma } from "./db";
import { writeAudit } from "./audit";
import { Locked, BadRequest } from "./api/errors";
import { hkMonthStart } from "./dates";
import type { MonthClose } from "@prisma/client";

export function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export async function isMonthLocked(month: Date): Promise<boolean> {
  const mc = await prisma.monthClose.findUnique({ where: { month: monthStart(month) } });
  return !!mc?.lockedAt;
}

/**
 * 寫入 shift_records／daily_requirements／special_items／rate_cards 呢類
 * 跟月份走嘅資料之前一律要經呢個 check。搵唔到 workDate 就用傳入嘅
 * referenceMonth（例如 rate_cards 用 effective_from 所屬月）。
 */
export async function assertMonthNotLocked(params: {
  workDate: Date;
  actorUserId: string | null;
  tableName: string;
  rowId: string;
  ip: string | null;
}): Promise<void> {
  const locked = await isMonthLocked(params.workDate);
  if (!locked) return;
  await writeAudit({
    actorUserId: params.actorUserId,
    tableName: params.tableName,
    rowId: params.rowId,
    action: "permission_denied",
    after: { reason: "month_locked", month: monthStart(params.workDate).toISOString().slice(0, 10) },
    ip: params.ip,
  });
  throw Locked(`${monthStart(params.workDate).toISOString().slice(0, 7)} 已鎖定，唔可以寫入`);
}

// P1-WP4：`POST /api/month-closes/:month/generate` 嘅 URL 形狀用月份
// （"2026-07"），但呢個 action 同 lock/unlock 共用同一個 Next.js 動態
// segment `[id]`（App Router 唔准同一個路徑深度嘅 sibling 資料夾用唔同
// 嘅 dynamic segment 名）。呢個 helper 令 `[id]` 段可以接受任一種寫法：
// 一個真正嘅 month_closes.id（uuid）就直接查；一個 "YYYY-MM"／"YYYY-MM-DD"
// 就當月份，搵唔到就 upsert 一行未鎖定嘅 month_close（generate 唔應該
// 要求使用者先手動 POST /api/month-closes 開一行先）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveMonthCloseIdOrMonth(idOrMonth: string, createdBy: string | null): Promise<MonthClose> {
  if (UUID_RE.test(idOrMonth)) {
    const row = await prisma.monthClose.findUnique({ where: { id: idOrMonth } });
    if (row) return row;
    throw BadRequest(`搵唔到 month_close：${idOrMonth}`);
  }
  const parsed = new Date(idOrMonth.length <= 7 ? `${idOrMonth}-01` : idOrMonth);
  if (Number.isNaN(parsed.getTime())) throw BadRequest(`唔啱嘅月份格式：${idOrMonth}（要 YYYY-MM 或 month_close id）`);
  const month = monthStart(parsed);
  return prisma.monthClose.upsert({
    where: { month },
    create: { month, createdBy },
    update: {},
  });
}

function addMonths(month: Date, n: number): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + n, 1));
}

function enumerateMonths(from: Date, to: Date): Date[] {
  const start = monthStart(from);
  const end = monthStart(to);
  const months: Date[] = [];
  for (let m = start; m.getTime() <= end.getTime(); m = addMonths(m, 1)) {
    months.push(m);
    // 保險上限（rate_cards 生效區間理論上唔會開幾十年，防止萬一輸入錯
    // 資料令呢個 loop 跑到爆）。
    if (months.length > 1200) break;
  }
  return months;
}

/**
 * M5（Opus 對抗式驗收）：rate_cards create/update/void/unvoid 要檢查
 * `[effective_from, effective_to]` 成個區間入面**任何一個月**被鎖，唔係
 * 淨係睇 effective_from 嗰個月——否則可以用「開一張 6/1–7/31 嘅新卡」
 * 或者「PATCH 將 effective_to 伸長入 7 月」嚟繞過 7 月鎖定，因為淨係
 * effective_from（6月）冇鎖。`effective_to` = null（開放中）當「到今日
 * 起計加 1 個月」（即「而家＋下個月」都要一齊 check，避免一張『長期有
 * 效』嘅卡蓋住咗一個已經鎖定嘅月都唔被發現）。
 */
export async function assertMonthRangeNotLocked(params: {
  effectiveFrom: Date;
  effectiveTo: Date | null;
  actorUserId: string | null;
  tableName: string;
  rowId: string;
  ip: string | null;
}): Promise<void> {
  const to = params.effectiveTo ?? addMonths(hkMonthStart(), 1);
  const months = enumerateMonths(params.effectiveFrom, to);
  for (const m of months) {
    const locked = await isMonthLocked(m);
    if (!locked) continue;
    await writeAudit({
      actorUserId: params.actorUserId,
      tableName: params.tableName,
      rowId: params.rowId,
      action: "permission_denied",
      after: {
        reason: "month_locked",
        month: m.toISOString().slice(0, 10),
        effective_from: monthStart(params.effectiveFrom).toISOString().slice(0, 10),
        effective_to: params.effectiveTo ? monthStart(params.effectiveTo).toISOString().slice(0, 10) : null,
      },
      ip: params.ip,
    });
    throw Locked(`生效區間覆蓋咗已鎖定嘅 ${m.toISOString().slice(0, 7)}，唔可以寫入`);
  }
}
