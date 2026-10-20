import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { monthStart } from "@/lib/month-lock";
import { toMonthCloseDTO, mapListDTO } from "@/lib/api/dto";
import { toBrokerMonthCloseDTO, mapListForBroker } from "@/lib/broker-dto";
import { isBrokerRole } from "@/lib/broker-isolation";
import { applyFieldGroupGate, applyFieldGroupGateToList } from "@/lib/api/field-groups";
import { ok, getClientIp, withApiError } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { MonthCloseCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest, Conflict } from "@/lib/api/errors";

export async function GET(req: Request) {
  return withApiError(async () => {
    // 規劃裁定（Opus 對抗式驗收第三輪，應修）：月結鎖定狀態本身（邊個月
    // 鎖咗）屬於「更表」呢個關注面（幾時可以再改更表/日常操作），唔係
    // 「糧務」（金錢）——主管出廠有「更表:view」冇「糧務:view」（P3 之後
    // 兩者已經分開），但主管都應該見到邊個月鎖咗先知自己仲改唔改得。
    // 金額類聚合欄（營業額／毛利／成本，WP3/WP4 先會加落 month_closes
    // 嘅欄）一樣要經 applyFieldGroupGate()（冇「收客價」/「出街價」
    // view 就剝），唔受呢個 permission 轉換影響。lock/unlock 寫入操作
    // 照舊淨係 `月結鎖定解鎖` 先做得（見 [id]/lock、[id]/unlock）。
    const session = await requirePermission(req, "更表", "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    // A1（Opus 整合驗收，additive）：`?month=` 俾月結工作台（
    // reports/monthly-close/page.tsx）入頁時查「呢個月有冇 month_closes
    // 行」，唔使成個列表攞晒自己喺前端篩。接受 "YYYY-MM" 或
    // "YYYY-MM-DD"；格式唔啱就當冇篩（同其他 list route 嘅寬鬆 filter
    // 一致，呢個 route 冇金錢敏感度，唔使 400）。
    const monthRaw = url.searchParams.get("month");
    const parsedMonth = monthRaw ? new Date(monthRaw.length <= 7 ? `${monthRaw}-01` : monthRaw) : null;
    const where = parsedMonth && !Number.isNaN(parsedMonth.getTime()) ? { month: monthStart(parsedMonth) } : undefined;
    const [rows, total] = await Promise.all([
      prisma.monthClose.findMany({ where, skip, take, orderBy: [{ month: "desc" }, { id: "asc" }] }),
      prisma.monthClose.count({ where }),
    ]);
    // C1（Opus 對抗式驗收第四輪）：雞頭而家有「更表:view」入得嚟，但淨係
    // 應該見到 { id, month, locked_at }——rosterVersionNote/lockedBy/
    // createdBy 呢類內部備註/用戶 id 唔畀。
    if (isBrokerRole(session)) {
      return ok(mapListForBroker({ rows, total, skip, take }, toBrokerMonthCloseDTO));
    }
    const dto = mapListDTO({ rows, total, skip, take }, toMonthCloseDTO);
    return ok(await applyFieldGroupGateToList(session, "month_closes", dto));
  });
}

// 建立某個月份嘅 month_close 追蹤行（未鎖定狀態）。真正鎖定經 /lock。
export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "糧務", "create");
    const body = await readJson(req);
    const input = parseBody(MonthCloseCreateSchema, body);
    const parsedDate = new Date(input.month);
    if (Number.isNaN(parsedDate.getTime())) throw BadRequest("month 格式唔啱（YYYY-MM-DD 或 YYYY-MM）");
    const month = monthStart(parsedDate);
    // HIST-1：historical=true 標記歷史月份（只上載更表＋對數＋落更；唔跑月結／糧／介紹費／鎖月，排程 job 跳過）。
    // 該月已有 month_closes 行：未鎖、冇任何一鍵結算 run、冇長工糧 run → 就地標記；否則 409（唔可以將已做過月結嘅月份標做歷史）。
    if (input.historical) {
      const existing = await prisma.monthClose.findUnique({ where: { month } });
      if (existing) {
        const runs = await prisma.monthCloseRun.count({ where: { month } });
        const payruns = await prisma.longtermPayrollRun.count({ where: { month } });
        if (existing.lockedAt || runs > 0 || payruns > 0) throw Conflict("呢個月已經鎖定或者做過月結／長工糧，唔可以標做歷史月份");
        const upd = await prisma.monthClose.update({ where: { id: existing.id }, data: { historical: true } });
        await writeAudit({ actorUserId: session.userId, tableName: "month_closes", rowId: upd.id, action: "update", before: existing, after: upd, ip: getClientIp(req) });
        return ok(await applyFieldGroupGate(session, "month_closes", toMonthCloseDTO(upd)), 200);
      }
    }
    const created = await prisma.monthClose.create({ data: { month, rosterVersionNote: input.roster_version_note ?? null, historical: input.historical ?? false, createdBy: session.userId } });
    await writeAudit({ actorUserId: session.userId, tableName: "month_closes", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    return ok(await applyFieldGroupGate(session, "month_closes", toMonthCloseDTO(created)), 201);
  });
}
