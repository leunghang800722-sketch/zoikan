// POST /api/auth/refresh：滑動續期。App shell 開頁／返前景時（有節流）打一次。
// - 冇登入／session 已作廢（token_version 唔啱、停用）／過絕對上限 → 401，唔產生任何 cookie。
// - 距上次簽發 <24 小時 → 200 {renewed:false}，唔重簽。
// - ≥24 小時 → 重簽 cookie（loggedInAt、tokenVersion 不變）。
// - 重簽失敗唔拋錯（回 renewed:false），原 cookie 照用。
import { NextResponse } from "next/server";
import { getSessionFromRequest, needsRenewal, setSessionCookie } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { tokenVersion: true, status: true } });
    if (!user || user.status !== "active" || user.tokenVersion !== session.tokenVersion) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!needsRenewal(session)) return NextResponse.json({ renewed: false });
    const res = NextResponse.json({ renewed: true });
    await setSessionCookie(res, session);
    return res;
  } catch {
    return NextResponse.json({ renewed: false });
  }
}
