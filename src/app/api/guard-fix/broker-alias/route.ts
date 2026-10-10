// 驗收修正（2026-09-26，同 branch）：雞頭稱呼對應搬入 guard-fix 頁——
// Postorder 解析出「對唔到嘅雞頭稱呼」（`plan.postorder.unresolvedBrokerLabels`，
// 見 `src/lib/guard-fix/plan.ts`）之前要靠本機 `scripts/opening/
// sync-broker-aliases.ts`（讀 private CSV）先同步得到，老闆而家要喺
// app 度逐個揀「呢個稱呼係邊個系統雞頭」→ 呢個 endpoint 寫入
// `brokers.aliases`（冪等、audit）。`sync-broker-aliases.ts` 已於 2026-09-28 刪除（原本留低做
// dev 便利（一次過同步私隱 CSV 嘅稱呼），唔再係正式站流程一部分。
//
// 權限：同呢一頁其餘寫入 action 一致用「保安員配對修復」（老闆專用 gate，
// 見 page.tsx 檔頭註解）；讀雞頭清單（前端揀「系統雞頭」下拉）用現有
// `GET /api/brokers`，本身已經係「雞頭」module view gate——兩層都行過。
//
// 鐵則：`label` 係雞頭喺 Postorder 入面嘅稱呼原文（人名，PII）——淨係
// 存入 DB（`brokers.aliases`／`audit_log`），唔准出現喺 code／commit
// message／測試 fixture。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { parseBody } from "@/lib/api/validate";
import { readJson } from "@/lib/api/query";
import { GuardFixBrokerAliasBodySchema } from "@/lib/api/schemas";
import { Conflict, NotFound } from "@/lib/api/errors";
import { writeAuditTx } from "@/lib/audit";

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "安員配對修復", "create");
    const body = parseBody(GuardFixBrokerAliasBodySchema, await readJson(req));

    const broker = await prisma.broker.findUnique({ where: { id: body.broker_id }, select: { id: true, code: true, name: true, aliases: true } });
    if (!broker) throw NotFound("搵唔到呢個雞頭");

    const label = body.label.trim();
    // `matchBroker()`（src/lib/roster-upload/match.ts）係 trim＋大小寫無關
    // 嘅整串比對（先 code 後 aliases，`find` 攞第一個）——呢度用同一個
    // 正規化判斷冪等同撞名。
    const norm = label.toUpperCase();
    const sameAs = (s: string) => s.trim().toUpperCase() === norm;
    // 同 code／name 一樣，或者已經喺 aliases 度——冪等，唔使再寫。
    const already = sameAs(broker.code) || label === broker.name || broker.aliases.some(sameAs);

    // 驗收修正（Opus 5.5）：稱呼已經係另一個雞頭嘅 code／alias → 加落嚟會
    // 令 `matchBroker()` 兩個都中、靜靜雞揀第一個（或者永遠俾 code 搶先），
    // 唔准寫，要老闆先去雞頭管理頁處理。錯誤訊息唔帶稱呼本身（PII）。
    if (!already) {
      const others = await prisma.broker.findMany({ where: { id: { not: broker.id } }, select: { code: true, aliases: true } });
      const clash = others.find((b) => sameAs(b.code) || b.aliases.some(sameAs));
      if (clash) throw Conflict(`呢個稱呼已經係雞頭 ${clash.code} 嘅代號／稱呼，唔可以再對應去 ${broker.code}`);
    }

    if (already) {
      return ok(
        brandSafeResponse({
          broker: { id: broker.id, code: broker.code, name: broker.name },
          added: false,
        }),
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.broker.update({ where: { id: broker.id }, data: { aliases: [...broker.aliases, label] } });
      await writeAuditTx(tx, {
        actorUserId: session.userId,
        tableName: "brokers",
        rowId: row.id,
        action: "update",
        before: { aliasesCount: broker.aliases.length },
        after: { aliasesCount: row.aliases.length, source: "guard-fix-broker-alias" },
        ip: getClientIp(req),
      });
      return row;
    });

    return ok(
      brandSafeResponse({
        broker: { id: updated.id, code: updated.code, name: updated.name },
        added: true,
      }),
      201,
    );
  });
}
