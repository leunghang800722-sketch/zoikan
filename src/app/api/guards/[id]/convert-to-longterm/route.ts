// WP-PHASE3（§20.4 Phase 3 item 2）：「轉長工」一步動作——`POST /api/
// guards/:id/convert-to-longterm`：一次過設 `employment_type=longterm_
// autopay`＋建崗位盤（`guard_longterm_posts`）＋（可選）介紹雞頭＋
// （可選）合約起始月薪（`guard_longterm_contracts`）。
//
// RBAC 拆兩層（唔可以合併成一個 module，兩張表原本屬於唔同 module）：
// - employment_type／崗位盤／介紹雞頭——「保安員」module（老闆／主管出廠
//   ✓，跟保安員抽屜「長工」區一致粒度，見 GuardsClient.tsx）。
// - 合約月薪——「長工糧」module（同「保安員銀行資料」一致粒度，主管硬性
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
import { assertReferralBrokerAllowed } from "@/lib/guards/longterm-posts";
import type { Guard, GuardLongtermPost, GuardLongtermContract } from "@prisma/client";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApiError(async () => {
    // 「轉長工」淨係內部角色（老闆／主管），跟保安員抽屜「長工」區一致——
    // 唔用 isBrokerRole() 揀「自己保安員」module，雞頭一律硬性拒絕（呢個
    // 動作會改 employment_type／建崗位盤，唔係雞頭自己保安員名冊管理嘅
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
      // WP-PHASE3 Opus 5.5 驗收：同 guards PATCH 一致——B07（內部長工結算
      // 單位）唔可以做介紹雞頭。WP-BOSS5 §25.2：Y（internal_cash）都唔
      // 可以做介紹雞頭。
      await assertReferralBrokerAllowed(parsed.referral_broker_id, "介紹雞頭", { disallowInternalCash: true });
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
        // WP-PHASE3 Opus 5.5 驗收：冪等——已經有覆蓋 effective_from 嘅合約
        // 就唔再建（連撳兩次「轉長工」唔會變兩份重疊合約，糧會計兩次）。
        const existingContract = canWriteContract
          ? await tx.guardLongtermContract.findFirst({
              where: { guardId: id, voidedAt: null, effectiveFrom: { lte: parsed.effective_from }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: parsed.effective_from } }] },
              select: { id: true },
            })
          : null;
        if (existingContract) {
          contractSkippedReason = "呢個保安員喺呢個生效日已經有長工合約，冇再建——要改月薪請去長工糧頁";
        } else if (canWriteContract) {
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

    // 入職日期如果係由文件導入寫入（guards audit 有 import_via 而且帶 hire_date）→ 提示核對（只提示，唔改計算；長工糧讀 guards.hire_date）
    const importedHire = result.guardAfter.hireDate
      ? (await prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'guards' AND row_id = ${id} AND action IN ('create','update') AND after ? 'import_via' AND coalesce(after->>'hire_date', '') <> '' AND left(after->>'hire_date', 10) = ${result.guardAfter.hireDate.toISOString().slice(0, 10)} AND (before IS NULL OR before->>'hire_date' IS DISTINCT FROM after->>'hire_date')
          AND created_at = (SELECT max(created_at) FROM audit_log WHERE table_name = 'guards' AND row_id = ${id} AND action IN ('create','update') AND coalesce(after->>'hire_date', '') <> '' AND (before IS NULL OR before->>'hire_date' IS DISTINCT FROM after->>'hire_date'))`)[0]!.n > 0
      : false;
    return ok(
      brandSafeResponse({
        hire_date_import_notice: importedHire ? "入職日期由文件導入，請核對（長工糧、年假同 MPF 會用呢個日期）" : null,
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
