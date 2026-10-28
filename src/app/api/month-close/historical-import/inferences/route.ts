// HIST-5：`GET /api/month-close/historical-import/inferences?from=YYYY-MM&to=YYYY-MM`
// 合併多個月「最新一個 done 嘅歷史導入 run」報告入面嘅 AI 推斷（inferences）、仍需決定（remaining）、抽查提示（review_hints），
// 方便一次攞六個月逐條抽查。權限同歷史導入 GET 一致（「一鍵結算」view：老闆／主管／會計）。
// 報告入面姓名／工號可以出（老闆 2026-10-20 PII 規則）；電話／身份證／銀行／住址／出生日期一律唔出（寫入報告時已保證）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, withApiError } from "@/lib/api/http";
import { BadRequest } from "@/lib/api/errors";
import type { HistInference, HistRemaining, HistReviewHint } from "@/lib/month-close/hist-inference";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MONTHS = 12;

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
    if (out.length > MAX_MONTHS) break;
  }
  return out;
}

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "一鍵結算", "view");
    const url = new URL(req.url);
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? from;
    if (!MONTH_RE.test(from) || !MONTH_RE.test(to)) throw BadRequest("請傳 from／to（YYYY-MM）");
    if (from > to) throw BadRequest("from 要早過或等於 to");
    const months = monthsBetween(from, to);
    if (months.length > MAX_MONTHS) throw BadRequest(`一次最多 ${MAX_MONTHS} 個月`);

    const inferences: Array<HistInference & { month: string }> = [];
    const remaining: Array<HistRemaining & { month: string }> = [];
    const reviewHints: Array<HistReviewHint & { month: string }> = [];
    const perMonth: Array<{ month: string; runId: string | null; finishedAt: string | null; inferences: number; remaining: number; reviewHints: number }> = [];
    for (const month of months) {
      const run = await prisma.historicalImportRun.findFirst({ where: { month: new Date(`${month}-01T00:00:00.000Z`), status: "done" }, orderBy: { finishedAt: "desc" }, select: { id: true, finishedAt: true, reportJson: true } });
      const report = (run?.reportJson ?? null) as { inferences?: HistInference[]; remaining?: HistRemaining[]; reviewHints?: HistReviewHint[] } | null;
      const inf = report?.inferences ?? [];
      const rem = report?.remaining ?? [];
      const hints = report?.reviewHints ?? [];
      inferences.push(...inf.map((x) => ({ ...x, month })));
      remaining.push(...rem.map((x) => ({ ...x, month })));
      reviewHints.push(...hints.map((x) => ({ ...x, month })));
      perMonth.push({ month, runId: run?.id ?? null, finishedAt: run?.finishedAt?.toISOString() ?? null, inferences: inf.length, remaining: rem.length, reviewHints: hints.length });
    }
    return ok(
      brandSafeResponse({
        from,
        to,
        months: perMonth,
        totals: { inferences: inferences.length, inferenceCells: inferences.reduce((s, x) => s + x.cells, 0), remaining: remaining.length, reviewHints: reviewHints.length },
        inferences,
        remaining,
        reviewHints,
      }),
    );
  });
}
