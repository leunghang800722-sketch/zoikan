// 小型 helper，跨 resource route 共用，減少重複。
//
// A1（Opus 對抗式驗收第三輪）：`take` 舊版 `Math.min(n || 100, 500)` 冧
// 唔到負數——`take=-1` 係 truthy，`-1 || 100` 照樣係 -1，`Math.min(-1,
// 500)` 仍然係 -1，一個負數 `take` 直接傳落 Prisma `findMany({ take:
// -1 })` 會拋一個未捕捉嘅 Prisma 錯誤（500，唔係乾淨嘅 4xx）。而家改用
// `Math.max(1, Math.min(n, 500))` 做完整 clamp（下限 1，上限 500）：
// `take=-1`／`take=0` 都 clamp 到 1，唔係 400——揀 clamp 唔係 reject，
// 保持同其他查詢參數一致嘅寬鬆行為。冇傳／傳咗個唔係數字嘅值先跌返
// 用預設 100（clamp 之後一樣喺 [1,500] 範圍內）。
//
// C4（Opus 對抗式驗收第四輪）：`take=1.5` 呢類非整數之前冧唔到——clamp
// 之後仲係 1.5，直接傳落 Prisma 嘅 `take`/`skip`（要求整數）會出錯。加
// `Math.floor()`（喺 clamp 之後做，避免 floor 完先 clamp 引致邊界*剛好*
// 半個位嘅落差）。
export function paginationParams(url: URL): { skip: number; take: number } {
  const takeRaw = url.searchParams.get("take");
  const takeNum = takeRaw === null ? 100 : Number(takeRaw);
  const take = Number.isFinite(takeNum) ? Math.floor(Math.max(1, Math.min(takeNum, 500))) : 100;
  const skipRaw = Number(url.searchParams.get("skip"));
  const skip = Number.isFinite(skipRaw) ? Math.floor(Math.max(skipRaw, 0)) : 0;
  return { skip, take };
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
