import { NextResponse } from "next/server";
import { getSessionFromRequest, clearSessionCookie } from "@/lib/auth/session";
import { bumpTokenVersion } from "@/lib/auth/token-version";
import { writeAudit } from "@/lib/audit";
import { getClientIp, handleApiError } from "@/lib/api/http";

export async function POST(req: Request) {
  try {
    const session = await getSessionFromRequest(req);
    const res = NextResponse.json({ ok: true });
    clearSessionCookie(res);
    if (session) {
      // Opus 驗收殘留1：logout 要 bump token_version，唔淨係清 cookie——
      // 否則一份俾人偷咗嘅舊 cookie（未過 TTL）喺「登出」之後照樣用得。
      await bumpTokenVersion(session.userId);
      await writeAudit({ actorUserId: session.userId, tableName: "users", rowId: session.userId, action: "logout", ip: getClientIp(req) });
    }
    return res;
  } catch (err) {
    return handleApiError(err);
  }
}
