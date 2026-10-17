// W0：GET /api/whatsapp/health——WAHA session 狀態、最後收到時間、積壓（status=received）、24h 錯誤數。
// view 權。WAHA 連線 5s timeout；失敗只回錯誤碼（唔洩漏 URL／key）。
import { requirePermission } from "@/lib/rbac/requirePermission";
import { prisma } from "@/lib/db";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";
import { getSessionStatus } from "@/lib/whatsapp/waha";
import { waEnabled, wahaBaseUrl } from "@/lib/whatsapp/config";

export async function GET(req: Request) {
  return withApiError(async () => {
    await requirePermission(req, "WhatsApp 報更", "view");
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [waha, last, backlog, errors24h, messages24h, alerts] = await Promise.all([
      wahaBaseUrl() ? getSessionStatus() : Promise.resolve({ ok: false as const, error: "not_configured" as const }),
      prisma.whatsappMessage.aggregate({ _max: { createdAt: true } }),
      prisma.whatsappMessage.count({ where: { status: "received" } }),
      prisma.whatsappMessage.count({ where: { status: "error", updatedAt: { gte: since } } }),
      prisma.whatsappMessage.count({ where: { createdAt: { gte: since } } }),
      // W5：最近 5 條健康告警（通知內容只有狀態碼／數字，無 PII）
      prisma.appNotification.findMany({ where: { kind: "whatsapp_health" }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, title: true, body: true, createdAt: true } }),
    ]);
    return ok(
      brandSafeResponse({
        enabled: waEnabled(),
        waha_configured: !!wahaBaseUrl(),
        waha_ok: waha.ok,
        waha_status: waha.ok ? waha.data.status : null,
        waha_error: waha.ok ? null : waha.error,
        last_received_at: last._max.createdAt ? last._max.createdAt.toISOString() : null,
        backlog,
        errors_24h: errors24h,
        messages_24h: messages24h,
        recent_alerts: alerts.map((a) => ({ id: a.id, title: a.title, body: a.body, created_at: a.createdAt.toISOString() })),
      }),
    );
  });
}
