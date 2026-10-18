// WP-AI-OPS §28.4：`GET /api/triage/sessions/:id[?status=open]`——session＋逐題（證據按「保安員個人資料」欄位權限遮罩）。
// 非老闆攞人哋嘅 session id → 403。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { getSessionFor, isSupplementary, restrictedKindsFor } from "@/lib/triage/session";
import { SUPPLEMENTARY_KINDS } from "@/lib/triage/types";
import { BadRequest } from "@/lib/api/errors";
import { questionViews, viewerCaps } from "@/lib/triage/view";
import { waCaps, waQuestionViews } from "@/lib/whatsapp/triage-answer";
import { mcQuestionViews } from "@/lib/month-close/auto/triage";
import { evidenceViewsFor } from "@/lib/triage/evidence-images";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    const actor = await requirePermission(req, "導入分診", "view");
    const { id } = await params;
    const session = await getSessionFor(actor, id);
    const statusParam = new URL(req.url).searchParams.get("status");
    const onlyOpen = statusParam === "open";
    const openOrSkipped = statusParam === "open,skipped"; // P13.3「由頭開始」：連跳過咗嘅一齊攞，可以重新答
    // P13.1 分頁（additive）：`take`（0..50，0＝淨攞 counts）＋`cursor`（上一頁最後一題 id）＋`tier`（important｜supplementary）。
    // 冇 `take` ＝舊行為（成個 session 一次過，回應冇 next_cursor）。
    const sp = new URL(req.url).searchParams;
    const takeRaw = sp.get("take");
    let take: number | null = null;
    if (takeRaw !== null) {
      if (!/^\d{1,4}$/.test(takeRaw)) throw BadRequest("take 要係 0 至 50 嘅整數");
      take = Math.min(Number(takeRaw), 50);
    }
    const tier = sp.get("tier");
    if (tier !== null && tier !== "important" && tier !== "supplementary") throw BadRequest("tier 只可以係 important 或 supplementary");
    const cursorId = sp.get("cursor");
    let cursorWhere: object = {};
    if (cursorId) {
      const cur = await prisma.triageQuestion.findFirst({ where: { id: cursorId, sessionId: session.id }, select: { sort: true, id: true } });
      if (!cur) throw BadRequest("cursor 無效");
      cursorWhere = { OR: [{ sort: { gt: cur.sort } }, { sort: cur.sort, id: { gt: cur.id } }] };
    }
    const supp = [...SUPPLEMENTARY_KINDS];
    const where = { sessionId: session.id, ...(onlyOpen ? { status: "open" } : openOrSkipped ? { status: { in: ["open", "skipped"] } } : {}), ...(tier === "supplementary" ? { kind: { in: supp } } : tier === "important" ? { kind: { notIn: supp } } : {}), ...cursorWhere };
    const fetched = take === 0 ? [] : await prisma.triageQuestion.findMany({ where, orderBy: [{ sort: "asc" }, { id: "asc" }], ...(take !== null ? { take: take + 1 } : {}) });
    const hasMore = take !== null && take > 0 && fetched.length > take;
    const rows = hasMore ? fetched.slice(0, take!) : fetched;
    const counts = await prisma.triageQuestion.groupBy({ by: ["status", "kind"], where: { sessionId: session.id }, _count: { _all: true } });
    const restricted = new Set(await restrictedKindsFor(actor));
    const c = { open: 0, answered: 0, skipped: 0, superseded: 0, total: 0, important_open: 0, supplementary_open: 0, restricted_open: 0 };
    for (const g of counts) {
      if (g.status === "superseded") {
        c.superseded += g._count._all;
        continue;
      }
      if (g.status === "open" || g.status === "answered" || g.status === "skipped") c[g.status] += g._count._all;
      if (g.status === "open" && !restricted.has(g.kind)) c[isSupplementary(g.kind) ? "supplementary_open" : "important_open"] += g._count._all;
      if (g.status === "open" && restricted.has(g.kind)) c.restricted_open += g._count._all;
      c.total += g._count._all;
    }
    const caps = await viewerCaps(actor);
    // WP-ONE-CLICK-AUTO：month_close 分診題（一鍵結算自我修復）用自己嘅 DTO，唔經保安員導入證據遮罩。
    const questions =
      session.sourceType === "whatsapp"
        ? await waQuestionViews(rows, await waCaps(actor))
        : session.sourceType === "month_close" || session.sourceType === "postorder_backfill"
          ? await mcQuestionViews(rows, { pii: caps.pii })
          : await questionViews(rows, caps);
    // TE-1（additive）：覆核證據裁圖 meta（唔含 bytes）；淨係 guard_import，按欄位權限／答得到嘅 kind 過濾
    const evImages = session.sourceType === "guard_import" ? await evidenceViewsFor(actor, rows, restricted) : new Map();
    return ok(
      brandSafeResponse({
        session: { id: session.id, source_type: session.sourceType, owner_user_id: session.ownerUserId, status: session.status, created_at: session.createdAt, completed_at: session.completedAt, counts: c },
        questions: questions.map((q) => ({ ...q, evidence_images: evImages.get(q.id) ?? [] })),
        ...(take !== null ? { next_cursor: hasMore ? rows[rows.length - 1]!.id : null } : {}),
      }),
    );
  });
}
