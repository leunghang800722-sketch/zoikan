// P6.4：對所有 /api/* 套用 CSRF defense-in-depth 檢查（見 src/lib/api/csrf.ts）。
import { NextResponse, type NextRequest } from "next/server";
import { checkCsrf } from "@/lib/api/csrf";

export function middleware(req: NextRequest) {
  const verdict = checkCsrf(req.method, req.headers);
  if (!verdict.ok) {
    return NextResponse.json({ error: "csrf_blocked", message: "跨站請求被拒絕" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
