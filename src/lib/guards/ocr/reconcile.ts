// WP-GUARD-OCR §29／WP-OCR-4：兩個獨立讀數（＋可選第三讀仲裁）→ 欄位結果。純函數。
// 規則（不變）：兩讀「正規化後逐字相同」＋格式驗證通過先 confirmed；其餘 review／missing。
// WP-OCR-4：兩讀各自嘅 alternatives 併入候選池，按格式驗證排序（value＝最高分候選）；
//   仲裁讀數（source arbiter）入池加權，唔自動 confirmed——除非仲裁值同其中一讀（正規化後）一致且 valid（2/3 一致）。
import type { OcrFieldKey } from "./config";
import type { FieldRead } from "./field-read";
import { isUnclear, normalizeField, type FieldResult } from "./normalize";
import { rankFieldCandidates, type RankInput } from "./rank";

export type ReadInput = string | null | undefined | FieldRead;

const asRead = (x: ReadInput): FieldRead => (x !== null && typeof x === "object" ? x : { value: x ?? null });
const usableAlts = (r: FieldRead): string[] => (r.alternatives ?? []).filter((v) => !isUnclear(v));

export function reconcile(key: OcrFieldKey, a: ReadInput, b: ReadInput, now: Date = new Date(), arbiter?: ReadInput): FieldResult {
  const ra = asRead(a);
  const rb = asRead(b);
  const rr = arbiter === undefined ? null : asRead(arbiter);
  const ua = isUnclear(ra.value);
  const ub = isUnclear(rb.value);
  const urr = rr ? isUnclear(rr.value) : true;
  const pool: RankInput[] = [];
  const pushMain = (src: string, r: FieldRead, unclear: boolean) => {
    if (!unclear) pool.push({ value: r.value!, source: src, ...(r.confidence ? { confidence: r.confidence } : {}) });
  };
  pushMain("a", ra, ua);
  pushMain("b", rb, ub);
  if (rr) pushMain("arbiter", rr, urr);
  for (const [src, r] of [["a", ra], ["b", rb], ...(rr ? [["arbiter", rr] as const] : [])] as const) for (const v of usableAlts(r)) pool.push({ value: v, source: `${src}_alt` });

  // WP-OCR-3：電話 9–10 位 → 剔走疑似分格線「1」嘅推算候選入池（排序靠格式驗證；唔自動確認）
  if (key === "phone") {
    for (const [src, r, unclear] of [["a", ra, ua], ["b", rb, ub], ...(rr ? [["arbiter", rr, urr] as const] : [])] as const) {
      if (unclear) continue;
      for (const v of normalizeField(key, r.value!, now).extra ?? []) pool.push({ value: v, source: `${src}_grid` });
    }
  }

  if (ua && ub && pool.length === 0) return { status: "missing", value: "", candidates: [], candidates_ranked: [], reason: "unclear" };
  const na = ua ? null : normalizeField(key, ra.value!, now);
  const nb = ub ? null : normalizeField(key, rb.value!, now);

  if (na && nb && na.canon === nb.canon) {
    if (na.valid) return { status: "confirmed", value: na.display, candidates: [], candidates_ranked: [] };
    const ranked = rankFieldCandidates(key, pool, now);
    return { status: "review", value: ranked[0]?.value ?? na.display, candidates: ranked.map((c) => c.value), candidates_ranked: ranked, reason: na.reason ?? "invalid_format" };
  }

  if (na && nb) {
    // 兩讀唔同：仲裁值同其中一讀一致且 valid → 2/3 一致，confirmed；否則照樣 review（仲裁值只入候選池加權）
    let tag: FieldResult["arbiter"];
    if (rr && urr) tag = "unclear";
    else if (rr) {
      const nr = normalizeField(key, rr.value!, now);
      tag = nr.canon === na.canon ? "agree_a" : nr.canon === nb.canon ? "agree_b" : "independent";
      if (nr.valid && tag !== "independent") return { status: "confirmed", value: nr.display, candidates: [], candidates_ranked: [], arbiter: tag };
    }
    const ranked = rankFieldCandidates(key, pool, now);
    return { status: "review", value: ranked[0]?.value ?? na.display, candidates: ranked.map((c) => c.value), candidates_ranked: ranked, reason: "reads_differ", ...(tag ? { arbiter: tag } : {}) };
  }

  // 只有一個主讀數（或兩個主讀數都 unclear 但有 alternatives）
  const ranked = rankFieldCandidates(key, pool, now);
  return { status: "review", value: ranked[0]?.value ?? (na ?? nb)?.display ?? "", candidates: ranked.map((c) => c.value), candidates_ranked: ranked, reason: ua && ub ? "both_unclear_alternatives" : "one_read_unclear" };
}
