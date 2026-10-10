// WP-AI-DIAG（§37.4）：建議動作卡——模型輸出 → 畫面掣 → 現有 API。
//
// 模型喺回覆文字最後附一個 fenced block（```actions\n[...]\n```）。Server（chat route）喺安全 guard 之前先
// `extractActions(text)`：剝走 block，剩低文字照舊行 guard；guard triggered 就丟棄全部 actions。
// 呢個檔案純函數、零 import（除 zod）、零 DB——前端 `ActionCards` 一樣 import 呢度嘅 schema 再擋一次。
//
// 鐵律：
// - type 白名單以外一律丟棄；params 用 `.strict()`（多餘 key＝成張卡丟棄）；id 類欄位限制字元（會砌入 API 路徑，唔准有 `/`、`.`、`?`）。
// - `open_page.href`：必須以 `/` 開頭、唔含 `//`／反斜線／控制字元／協議，正規化後 pathname 喺允許前綴清單。
// - 每張卡 `label` ≤60 字、`basis` ≤200 字；最多 5 張。
// - 模型輸出永遠唔會被自動執行：呢度只係「解析＋白名單」，執行要用戶喺畫面撳掣（現有 API、現有權限、5 秒撤銷）。
import { z } from "zod";

export const MAX_ACTION_CARDS = 5;
export const ACTION_LABEL_MAX = 60;
export const ACTION_BASIS_MAX = 200;

/** `open_page` 允許嘅頁面路徑前綴（對照 src/app/(app) 現有頁面）。 */
export const ALLOWED_PAGE_PREFIXES = [
  "/month-close",
  "/roster-uploads",
  "/guards",
  "/guard-fix",
  "/sites",
  "/brokers",
  "/rate-cards",
  "/reports",
  "/triage",
] as const;

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "id 格式唔啱");
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month 要 YYYY-MM");

/** 回傳正規化後嘅內部 href，唔合格回 null。 */
export function normalizeInternalHref(href: string): string | null {
  if (typeof href !== "string" || href.length === 0 || href.length > 300) return null;
  if (!href.startsWith("/")) return null;
  if (href.includes("//") || href.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(href)) return null;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href, "http://zk.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://zk.invalid") return null;
  if (url.pathname.split("/").some((seg) => seg === "..")) return null;
  const okPrefix = ALLOWED_PAGE_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`));
  if (!okPrefix) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

const base = { label: z.string().trim().min(1).max(ACTION_LABEL_MAX), basis: z.string().trim().min(1).max(ACTION_BASIS_MAX) };

const hrefSchema = z
  .string()
  .refine((h) => normalizeInternalHref(h) !== null, "href 唔合格")
  .transform((h) => normalizeInternalHref(h) as string);

export const actionCardSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open_page"), ...base, params: z.object({ href: hrefSchema }).strict() }),
  z.object({
    type: z.literal("triage_answer"),
    ...base,
    params: z.object({ question_id: ID, option: z.string().regex(/^[a-z0-9_]{1,40}$/), candidate_id: ID.optional() }).strict(),
  }),
  z.object({ type: z.literal("site_set_default_broker"), ...base, params: z.object({ site_id: ID, broker_id: ID }).strict() }),
  z.object({ type: z.literal("roster_reparse"), ...base, params: z.object({ upload_id: ID }).strict() }),
  z.object({ type: z.literal("one_click_run"), ...base, params: z.object({ month: MONTH }).strict() }),
  z.object({ type: z.literal("backfill_from_postorder"), ...base, params: z.object({ month: MONTH }).strict() }),
]);

export type ActionCard = z.infer<typeof actionCardSchema>;
export type ActionCardType = ActionCard["type"];

/** 要寫入嘅 type（open_page 唯一唔寫入）。 */
export const WRITE_ACTION_TYPES: readonly ActionCardType[] = ["triage_answer", "site_set_default_broker", "roster_reparse", "one_click_run", "backfill_from_postorder"];

/** 呢兩種要 server 查月份鎖（其餘寫入 type 靠現有 API 本身嘅鎖月檢查）。 */
export const MONTH_LOCK_FILTERED_TYPES: readonly ActionCardType[] = ["one_click_run", "backfill_from_postorder"];

/** 前端／存落對話 history 嘅陣列驗證：逐張驗，唔合格嘅丟棄，最多 5 張。 */
export function sanitizeActionCards(input: unknown): ActionCard[] {
  if (!Array.isArray(input)) return [];
  const out: ActionCard[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== "object") continue;
    const parsed = actionCardSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
    if (out.length >= MAX_ACTION_CARDS) break;
  }
  return out;
}

const CLOSED_BLOCK = /```actions[ \t]*\r?\n([\s\S]*?)```/g;
const OPEN_BLOCK = /```actions[\s\S]*$/;

/** 由模型文字剝走 ```actions block，回傳（乾淨文字，驗證過嘅動作卡）。冇 block／JSON 壞＝冇卡，文字照回。 */
export function extractActions(text: string): { text: string; actions: ActionCard[] } {
  const blocks: string[] = [];
  let stripped = text.replace(CLOSED_BLOCK, (_m, body: string) => {
    blocks.push(body);
    return "";
  });
  // 冇收尾嘅 block（被截斷）：由 fence 起剝到尾，唔俾半截 JSON 出現喺回覆
  stripped = stripped.replace(OPEN_BLOCK, "");
  const cleanText = stripped.replace(/\s+$/, "");
  const actions: ActionCard[] = [];
  for (const body of blocks) {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      continue;
    }
    for (const card of sanitizeActionCards(json)) {
      if (actions.length < MAX_ACTION_CARDS) actions.push(card);
    }
  }
  return { text: cleanText, actions };
}
