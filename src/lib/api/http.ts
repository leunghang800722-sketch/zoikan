import { NextResponse } from "next/server";
import { withReportContext } from "@/lib/reports/context";
import { gzipSync } from "node:zlib";
import { ApiError } from "./errors";
import { camelToSnakeDeep, type Dto } from "./serialize";
import { writeAppErrorLog } from "../app-error-log";

export function getClientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return null;
}

// 統一 API 回應：JSON key 一律 snake_case（同 DB 欄位／CSV 欄位名一致，
// 亦令雞頭隔離 fuzz test 可以直接遞歸搜尋字面 "client_rate" 呢類字串）。
//
// N2（Opus 對抗式驗收第三輪）：`data` 嘅型別淨係接受 `Dto`（見
// ./serialize.ts 嘅 brand）——一定要經 `pickWhitelist()`（`toXxxDTO()`/
// `mapListDTO()`/`mapListForBroker()` 呢啲最終都係經佢）或者人手
// `brandSafeResponse()` 先產生得到嘅值。一個原始 Prisma row（或者佢嘅
// spread，例如 `{ ...row, extra }`）冇呢個 phantom property，直接
// `ok(rawRow)` 會喺 tsc 層面紅——呢個先係「內部角色都唔准 raw row 出
// 街」嘅結構性保證，唔淨係靠逐個 route 自己記得转 DTO。
export function ok(data: Dto | Dto[] | null, init?: number): NextResponse {
  return NextResponse.json(camelToSnakeDeep(data), { status: init ?? 200 });
}

// 2026-09-13：App Router 嘅 Route Handler 回應唔會被 next.config `compress` 壓縮（正式站實測
// 帶 Accept-Encoding: gzip 都係原大送出），大列表（更次／保安員）喺手機網絡極慢。呢個 helper
// 同 ok() 一樣只收 Dto（型別層保證白名單），但當 client 接受 gzip 而 body ≥ 8KB 就手動 gzip。
const GZIP_MIN_BYTES = 8 * 1024;
export function okGzip(req: Request, data: Dto | Dto[] | null, init?: number): NextResponse {
  const json = JSON.stringify(camelToSnakeDeep(data));
  const accept = req.headers.get("accept-encoding") ?? "";
  if (!/\bgzip\b/i.test(accept) || json.length < GZIP_MIN_BYTES) {
    return new NextResponse(json, { status: init ?? 200, headers: { "content-type": "application/json", vary: "accept-encoding" } });
  }
  const body = gzipSync(Buffer.from(json, "utf8"));
  return new NextResponse(new Uint8Array(body), {
    status: init ?? 200,
    headers: { "content-type": "application/json", "content-encoding": "gzip", vary: "accept-encoding", "content-length": String(body.length) },
  });
}

// Opus 驗收殘留4：console.error 唔准噴 payload。Prisma 嘅
// PrismaClientValidationError 呢類錯誤，`err.message`／`String(err)`
// 成段包住成個 query（包括 `data: { work_date: "...", ... }`），直接
// `console.error("...", err)` 會將呢啲值全部印落 server log——如果個
// payload 有保安員個人資料就漏晒。呢度淨係揀最後一行（Prisma 錯誤訊息嘅
// 慣例：診斷句喺最尾一行，中間先係俾佢拆爛嘅 query dump），加個長度上限，
// 唔會有成個物件被 console.error 遞歸 inspect。
export function safeErrorSummary(err: unknown): string {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1]! : "";
  return `${name}: ${lastLine}`.slice(0, 300);
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, { status: err.status });
  }
  const summary = safeErrorSummary(err);
  console.error("[api] 未預期錯誤", summary);
  // WP-AI-DIAG：fire-and-forget 寫應用層錯誤日誌（遮罩、冇 body／header／IP／stack）；永遠唔影響下面嘅 response。
  // `writeAppErrorLog` 內部全 try/catch；呢度再包一層防萬一同步拋錯。actorUserId 留 null（呢度冇 session，唔為咗攞 user id 改 route 簽名）。
  try {
    void writeAppErrorLog({ status: 500, errorCode: "internal_error", errorName: err instanceof Error ? err.constructor.name : typeof err, message: summary });
  } catch {
    // ignore
  }
  return NextResponse.json({ error: "internal_error", message: "系統錯誤" }, { status: 500 });
}

export async function withApiError(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    // P3-2.1：每個 API request 一個報表 memo context（同 request 內唔重複計同一月報表；
    // 唔跨 request，見 src/lib/reports/context.ts）。
    return await withReportContext(fn);
  } catch (err) {
    return handleApiError(err);
  }
}
