// WP-PHASE3（§20.4 Phase 3 item 2）：「轉長工」一步動作——`POST /api/
// guards/:id/convert-to-longterm`：一次過設 `employment_type=longterm_
// autopay`＋建崗位盤（`guard_longterm_posts`）＋（可選）介紹雞頭＋
// （可選）合約起始月薪（`guard_longterm_contracts`）。
//
// RBAC 拆兩層（唔可以合併成一個 module，兩張表原本屬於唔同 module）：
// - employment_type／崗位盤／介紹雞頭——「安員」module（老闆／主管出廠
//   ✓，跟安員抽屜「長工」區一致粒度，見 GuardsClient.tsx）。
// - 合約月薪——「長工糧」module（同「安員銀行資料」一致粒度，主管硬性
//   拒）。冇呢個權限嘅 session（例如主管）送咗 `monthly_salary` 都唔會
//   靜靜掉走唔講——回應 `contract:null`＋`warning` 講明原因，等前端提示
//   「請老闆／會計去長工糧頁補合約」，唔扮做完。
import { prisma } from "@/lib/db";
import { requirePermission, hasPermission } from "@/lib/rbac/requirePermission";
import { isBrokerRole } from "@/lib/broker-isolation";
import { assertMonthRangeNotLocked } from "@/lib/month-lock";
import { toGuardFullDTO, toGuardLongtermPostDTO } from "@/lib/api/dto";
import { toLongtermContractDTO } from "@/lib/longterm-payroll/dto";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { GuardConvertToLongtermSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { NotFound, Forbidden } from "@/lib/api/errors";
import type { Guard, GuardLongtermPost, GuardLongtermContract } from "@prisma/client";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 「轉長工」淨係內部角色（老闆／主管），跟安員抽屜「長工」區一致——
    // 唔用 isBrokerRole() 揀「自己安員」module，雞頭一律硬性拒絕（呢個
    // 動作會改 employment_type／建崗位盤，唔係雞頭自己安員名冊管理嘅
    // 範圍）。
    const session = await requirePermission(req, "安員", "update");
    if (isBrokerRole(session)) throw Forbidden("雞頭唔可以轉長工");
    const { id } = await params;
    const before = await prisma.guard.findUnique({ where: { id } });
    if (!before) throw NotFound();

    const body = await readJson(req);
    const parsed = parseBody(GuardConvertToLongtermSchema, body);
    const site = await prisma.site.findUnique({ where: { id: parsed.site_id }, select: { id: true } });
    if (!site) throw NotFound("搵唔到呢個盤");
    if (parsed.referral_broker_id) {
      const broker = await prisma.broker.findUnique({ where: { id: parsed.referral_broker_id }, select: { id: true } });
      if (!broker) throw NotFound("搵唔到呢個介紹雞頭");
    }

    // 合約要唔要建，喺 transaction 之前就要知（會影響落唔落
    // `assertMonthRangeNotLocked()`，佢自己會查 DB，唔可以喺 tx 入面
    // call）。
    const canWriteContract = parsed.monthly_salary !== undefined && (await hasPermission(session, "長工糧", "create"));
    if (parsed.monthly_salary !== undefined && canWriteContract) {
      await assertMonthRangeNotLocked({
        effectiveFrom: parsed.effective_from,
        effectiveTo: null,
        actorUserId: session.userId,
        tableName: "guard_longterm_contracts",
        rowId: "new",
        ip: getClientIp(req),
      });
    }

    const ip = getClientIp(req);
    const result = await prisma.$transaction(async (tx) => {
      const guardAfter: Guard = await tx.guard.update({
        where: { id },
        data: {
          employmentType: "longterm_autopay",
          ...(parsed.referral_broker_id !== undefined ? { referralBrokerId: parsed.referral_broker_id } : {}),
        },
      });

      // 冪等：呢個盤已經有生效（未作廢、未終止）崗位記錄就唔重複建。
      const existingPost = await tx.guardLongtermPost.findFirst({
        where: { guardId: id, siteId: parsed.site_id, voidedAt: null, OR: [{ effectiveTo: null }, { effectiveTo: { gte: parsed.effective_from } }] },
      });
      let post: GuardLongtermPost;
      let postCreated = false;
      if (existingPost) {
        post = existingPost;
      } else {
        post = await tx.guardLongtermPost.create({
          data: {
            guardId: id,
            siteId: parsed.site_id,
            effectiveFrom: parsed.effective_from,
            effectiveTo: null,
            source: "manual",
            note: "轉長工",
            createdBy: session.userId,
          },
        });
        postCreated = true;
      }

      let contract: GuardLongtermContract | null = null;
      let contractSkippedReason: string | null = null;
      if (parsed.monthly_salary !== undefined) {
        if (canWriteContract) {
          contract = await tx.guardLongtermContract.create({
            data: {
              guardId: id,
              effectiveFrom: parsed.effective_from,
              effectiveTo: null,
              monthlySalary: parsed.monthly_salary,
              source: "manual",
              note: "轉長工（起始合約）",
              createdBy: session.userId,
            },
          });
        } else {
          contractSkippedReason = "session 冇「長工糧」權限，未建合約——請老闆／會計去長工糧頁（/reports/longterm-payroll）補合約";
        }
      }

      return { guardAfter, post, postCreated, contract, contractSkippedReason };
    });

    await writeAudit({ actorUserId: session.userId, tableName: "guards", rowId: id, action: "update", before, after: result.guardAfter, ip });
    if (result.postCreated) {
      await writeAudit({ actorUserId: session.userId, tableName: "guard_longterm_posts", rowId: result.post.id, action: "create", after: result.post, ip });
    }
    if (result.contract) {
      await writeAudit({ actorUserId: session.userId, tableName: "guard_longterm_contracts", rowId: result.contract.id, action: "create", after: result.contract, ip });
    }

    return ok(
      brandSafeResponse({
        guard: toGuardFullDTO(result.guardAfter),
        longterm_post: toGuardLongtermPostDTO(result.post),
        post_reused: !result.postCreated,
        contract: result.contract ? toLongtermContractDTO(result.contract) : null,
        warning: result.contractSkippedReason,
      }),
      201,
    );
  });
}
