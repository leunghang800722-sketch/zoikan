import { NextResponse } from "next/server";
import { ApiError } from "./errors";
import { camelToSnakeDeep, type Dto } from "./serialize";

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

// Opus 驗收殘留4：console.error 唔准噴 payload。Prisma 嘅
// PrismaClientValidationError 呢類錯誤，`err.message`／`String(err)`
// 成段包住成個 query（包括 `data: { work_date: "...", ... }`），直接
// `console.error("...", err)` 會將呢啲值全部印落 server log——如果個
// payload 有安員個人資料就漏晒。呢度淨係揀最後一行（Prisma 錯誤訊息嘅
// 慣例：診斷句喺最尾一行，中間先係俾佢拆爛嘅 query dump），加個長度上限，
// 唔會有成個物件被 console.error 遞歸 inspect。
function safeErrorSummary(err: unknown): string {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const lastLine = lines.length ? lines[lines.length - 1]! : "";
  return `${name}: ${lastLine}`.slice(0, 300);
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  console.error("[api] 未預期錯誤", safeErrorSummary(err));
  return NextResponse.json({ error: "internal_error", message: "系統錯誤" }, { status: 500 });
}

export async function withApiError(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    return handleApiError(err);
  }
}
