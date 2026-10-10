// P1-執行計劃.md §4 WP4 item 4／設計文件§6.2：雞頭「本月應收」——
// `GET /api/reports/my-receivable?month=`（雞頭 session；`出街價:view`
// 自己）：更數×自己出街價逐日明細＋合計；零收客價、零他人。
//
// 呢個 report 一律用 session.brokerId（`requireOwnBrokerId()`）決定睇邊
// 個雞頭嘅資料——冇 query 參數可以指定第二個 broker_id，結構性排除「雞頭
// A 想睇雞頭 B 應收」呢種可能性。`scrubForBrokerSession()` 做埋
// defense-in-depth（雖然 buildMyReceivable() 輸出本身已經冇 client_rate
// 呢類收客價欄）。
//
// P2-B（README §11）additive：老闆／會計／主管（本身已經有「出街價:view」
// ——內部角色出廠一律開，唔係放寬）可以帶 `?broker=<code 或 id>` 預覽
// 某個雞頭嘅本月應收，用嚟核數／回答雞頭查詢。呢個唔算隔離漏洞——
// 老闆本身自己打 /rate-cards 就已經睇晒全部盤全部雞頭嘅出街價，呢度
// 淨係換個角度睇返同一批資料（Fable 規劃判斷，見 P2-版面重設計計劃.md
// §5）。雞頭 session 本身一定用 requireOwnBrokerId()，`?broker=` 完全
// 冇入邊個分支，結構性冇得改人。
//
// 老闆 2026-09-15 拍板：主管可以見到出街價（價目頁／本月應收預覽）。
// 所以 `?broker=` 預覽分支只要「出街價:view」（同呢個 route 本身嘅門檻一
// 樣，主管／會計／老闆出廠都有），之前 Opus 整合驗收暫定嘅「收客價:view」
// 額外門檻已移除。雞頭 session 自己嘅本月應收（`isBrokerRole` 分支）不變。
import { z } from "zod";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole, requireOwnBrokerId, scrubForBrokerSession } from "@/lib/broker-isolation";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { parseMonthParam } from "@/lib/reports/money";
import { buildMyReceivable } from "@/lib/reports/my-receivable";
import { prisma } from "@/lib/db";
import { BadRequest, Forbidden } from "@/lib/api/errors";
// WP-PRICE §3：頁頂「N 更未定價，金額未計入」Notice 要用嘅 additive 欄。
import { buildUnpricedSummary } from "@/lib/pricing/unpriced";

const monthParamSchema = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "出街價", "view");

    const url = new URL(req.url);
    const monthRaw = url.searchParams.get("month");
    const parsedMonth = monthParamSchema.safeParse(monthRaw);
    if (!parsedMonth.success) throw BadRequest("month 要帶值（YYYY-MM）");
    const month = parseMonthParam(parsedMonth.data);
    if (!month) throw BadRequest("month 要帶值（YYYY-MM）");

    let brokerId: string;
    let previewBroker: { code: string; name: string } | null = null;

    if (isBrokerRole(session)) {
      // 雞頭 session 一律用自己嘅 broker_id——`?broker=` 就算帶咗都完全
      // 忽略（唔准改人，見檔頭註解）。
      brokerId = requireOwnBrokerId(session);
    } else {
      const brokerParam = url.searchParams.get("broker");
      // 保持原有語意（additive，唔改）：冇 `?broker=` 嘅內部角色一律
      // 403（「呢個 route 淨係俾雞頭角色用」）——舊 test
      // 「老闆（非雞頭角色）打呢個 route → 403」唔改都要照過。有帶
      // `?broker=` 先進入新嘅預覽分支。
      if (!brokerParam) throw Forbidden("呢個 report 淨係俾雞頭角色用——內部角色請用 GET /api/reports/gross-margin，或者帶 ?broker=<雞頭 code 或 id> 預覽");
      const broker = await prisma.broker.findFirst({ where: { OR: [{ id: brokerParam }, { code: brokerParam }] } });
      if (!broker) throw BadRequest("搵唔到呢個雞頭（broker code 或 id 唔啱）");
      brokerId = broker.id;
      previewBroker = { code: broker.code, name: broker.name };
    }

    const [result, unpriced] = await Promise.all([buildMyReceivable(brokerId, month), buildUnpricedSummary(session, month, null, brokerId)]);
    return ok(
      scrubForBrokerSession(
        session,
        brandSafeResponse({
          ...result,
          previewing: previewBroker !== null,
          broker_code: previewBroker?.code,
          broker_name: previewBroker?.name,
          unpriced_count: unpriced.count,
          unpriced_groups: unpriced.groups,
          // WP-MIXED-BILLING：OT 未定價獨立數目（見 gross-margin/route.ts 同一段註解）。
          ot_unpriced_count: unpriced.otUnpricedCount,
        }),
      ),
    );
  });
}
