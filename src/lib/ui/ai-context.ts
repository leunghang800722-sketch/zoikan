// WP-AI2：側欄 AI 助手送問題嗰陣附嘅 `context`——由目前網址（path +
// query）解析出嚟，等後端 system prompt 知道「呢個盤／今個月」指邊個
// （見 `src/lib/ai/system-prompt.ts` 嘅 `formatContext()`）。純函數、
// 唔掂 DOM／localStorage，方便 vitest 直接測（唔使起成個 component）。
//
// 刻意設計：呢度淨係「解析」，唔做任何驗證/授權判斷——`context` 對後端
// 嚟講永遠只係提示字串，唔係已驗證嘅指令（見 system-prompt.ts 頭註）。
export interface AiPageContext {
  path: string;
  site_id?: string;
  month?: string;
  broker?: string;
}

type ParamsLike = URLSearchParams | Record<string, string | null | undefined> | null | undefined;

function getParam(params: ParamsLike, key: string): string | null {
  if (!params) return null;
  if (params instanceof URLSearchParams) return params.get(key);
  return params[key] ?? null;
}

/** `/roster/[site]/[month]` （可帶 `?broker=`）。 */
const ROSTER_PATH_RE = /^\/roster\/([^/?#]+)\/([^/?#]+)/;

export function deriveAiContext(pathname: string, searchParams?: ParamsLike): AiPageContext {
  const path = pathname || "/";
  const context: AiPageContext = { path };

  const rosterMatch = path.match(ROSTER_PATH_RE);
  if (rosterMatch) {
    context.site_id = decodeURIComponent(rosterMatch[1]);
    context.month = decodeURIComponent(rosterMatch[2]);
    const broker = getParam(searchParams, "broker");
    if (broker) context.broker = broker;
    return context;
  }

  if (path.startsWith("/reports/gross-margin")) {
    const month = getParam(searchParams, "month");
    if (month) context.month = month;
    return context;
  }

  return context;
}
