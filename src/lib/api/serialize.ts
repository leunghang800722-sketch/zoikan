// API 回應序列化 helper。
//
// 1. camelToSnakeDeep：Prisma model 用 camelCase（clientRate），DB 欄位/
//    CSV/對外 API 一律用 snake_case（client_rate）——遞歸轉換，連
//    Decimal／Date 都轉做 JSON-safe 嘅 string。
// 2. dropKeysDeep：遞歸刪走指定名嘅 key（雞頭隔離用嚟剝 client_rate* 等）。
// 3. dropForeignBrokerObjectsDeep（喺 broker-isolation.ts）：遞歸刪走
//    「呢個物件本身係另一個 broker 嘅完整 record」嘅 nested object。
// 4. pickWhitelist：白名單 DTO（C2）——淨係揀指定欄位，逐個欄位獨立
//    convert（唔會遞歸行入 Decimal/Date 內部結構）。
//
// Opus 驗收 C2 抓到嘅 bug（兩層）：
// (a) 舊版 dropKeysDeep 用 `Object.entries()` 遞歸行晒成棵物件樹，行到
//     Decimal/Date 呢類「睇落係物件但唔應該再拆落去」嘅值嗰陣，
//     `Object.entries(new Date(...))` 得返 `{}`（Date 冇 own enumerable
//     property），Decimal 就會拆出佢內部代表 `{s,e,d}` 嗰堆嘢——雞頭見到
//     嘅 `work_date` 變咗 `{}`。
// (b) 用 `instanceof Decimal` 判斷唔可靠：Vitest/Vite 嘅 module 轉譯令
//     `@prisma/client/runtime/library` 有時會俾唔同 import 路徑攞到
//     唔同嘅 module instance（dual-package hazard），令由真實 Prisma
//     query 拎返嚟嘅 Decimal 值 `instanceof` 檢查唔中，靜靜哋漏咗轉
//     string——實測過：plain `node -e` 底下 instanceof 啱，但 Vitest
//     底下 `guard_wage_snapshot` 會漏網變返 `{s,e,d}` 落 response。
// 修法：`isDecimalLike()` 唔靠 instanceof，用 decimal.js 實際內部形狀
// （`s`/`e`/`d` 三個 own property + `toFixed` method）duck-type 判斷，
// 唔理邊個 module instance 起嘅都認得到。`isOpaqueLeaf()` 判斷「呢個值
// 遇到就直接停低唔再遞歸」，dropKeysDeep／findKeysDeep／
// dropForeignBrokerObjectsDeep（broker-isolation.ts）都要用。
// N2（Opus 對抗式驗收第三輪）：結構性保證「內部角色都唔准 raw Prisma
// row 出街」——單靠 code review／文檔約定唔夠（之前 13 條 void/unvoid/
// lock/unlock route 就係咁樣漏咗）。呢個 brand 令 `ok()`（src/lib/api/
// http.ts）嘅參數型別淨係接受「經 `pickWhitelist()` 或
// `brandSafeResponse()` 產生」嘅值——一個原始 Prisma row（或者佢嘅
// spread）冇呢個 phantom property，`ok(rawRow)` 會喺 tsc 層面直接紅，
// 唔使等 runtime fuzz test 先發現。
declare const DTO_BRAND: unique symbol;
export type Dto<T extends Record<string, unknown> = Record<string, unknown>> = T & { readonly [DTO_BRAND]: true };

/**
 * 人手起一個 Dto——淨係俾「已經人手核實安全、本身冇經 pickWhitelist()」
 * 嘅細個 ad-hoc 回應用（例如 `{ ok: true }`、統計數字、permission
 * matrix cell 呢類手砌物件）。**唔准**用嚟包一個原始 Prisma row 或者佢
 * 嘅 spread（`{ ...row, extra }`）去呃過 tsc——呢個係人手約定，
 * `tests/dto-brand-guard.test.ts` 會逐個 `brandSafeResponse(` call site
 * 靜態掃描，唔准直接包住嚟自 `prisma.` query 嘅變量。
 */
export function brandSafeResponse<T extends Record<string, unknown>>(obj: T): Dto<T> {
  return obj as Dto<T>;
}

export function isDecimalLike(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.toFixed === "function" && typeof o.s === "number" && typeof o.e === "number" && Array.isArray(o.d);
}

function isOpaqueLeaf(v: unknown): boolean {
  return v instanceof Date || isDecimalLike(v);
}

function toPlain(value: unknown): unknown {
  if (isDecimalLike(value)) return String(value);
  if (value instanceof Date) return value.toISOString();
  return value;
}

function snakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function camelToSnakeDeep(value: unknown): unknown {
  const v = toPlain(value);
  if (Array.isArray(v)) return v.map(camelToSnakeDeep);
  if (v && typeof v === "object" && !isOpaqueLeaf(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[snakeKey(k)] = camelToSnakeDeep(val);
    }
    return out;
  }
  return v;
}

// key 名比較用嘅正規化：轉小寫、去底線，令 "clientRate"／"client_rate"／
// "CLIENT_RATE" 全部比對到同一個 blocklist entry。
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/_/g, "");
}

export function dropKeysDeep<T>(value: T, blockedKeys: string[]): T {
  const blocked = new Set(blockedKeys.map(normalizeKey));
  function walk(v: unknown): unknown {
    if (isOpaqueLeaf(v)) return v; // 唔好拆 Decimal/Date 內部結構
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (blocked.has(normalizeKey(k))) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  }
  return walk(value) as T;
}

// 遞歸搜尋整個物件樹係咪含有指定嘅 key 名（fuzz test 用嚟斷言「零洩漏」）。
export function findKeysDeep(value: unknown, blockedKeys: string[]): string[] {
  const blocked = new Set(blockedKeys.map(normalizeKey));
  const found: string[] = [];
  function walk(v: unknown, path: string) {
    if (isOpaqueLeaf(v)) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        if (blocked.has(normalizeKey(k))) found.push(p);
        walk(val, p);
      }
    }
  }
  walk(value, "");
  return found;
}

/**
 * 遞歸搜尋物件樹入面嘅**值**（唔係 key 名）係咪含有指定嘅子字串——C2 fuzz
 * test 要求「遞歸搜尋值入面唔含『收客』『上單價』『發票』『實收』同其他
 * 雞頭代號／名」，呢啲字可能出現喺 note/description/evidence 呢類自由
 * 文字欄嘅值入面，唔止喺 key 名。
 */
export function findSubstringInValuesDeep(value: unknown, needles: string[]): Array<{ path: string; needle: string }> {
  const found: Array<{ path: string; needle: string }> = [];
  function walk(v: unknown, path: string) {
    if (isOpaqueLeaf(v)) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        walk(val, path ? `${path}.${k}` : k);
      }
      return;
    }
    if (typeof v === "string") {
      for (const n of needles) {
        if (v.includes(n)) found.push({ path, needle: n });
      }
    }
  }
  walk(value, "");
  return found;
}

/**
 * 白名單 DTO（C2）：淨係揀 `keys` 入面嘅欄位，逐個獨立 convert（唔會
 * 遞歸行入成棵物件樹，所以冇「拆爛 Decimal/Date」呢個 bug class 嘅風險
 * ——每個欄位嘅值都經 camelToSnakeDeep() 獨立處理，Decimal/Date 一開波
 * 就轉做 string，唔會當成普通物件再遞歸落去）。
 */
export function pickWhitelist<T extends Record<string, unknown>>(row: T, keys: readonly string[]): Dto {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      out[snakeKey(k)] = camelToSnakeDeep(row[k]);
    }
  }
  return out as Dto;
}
