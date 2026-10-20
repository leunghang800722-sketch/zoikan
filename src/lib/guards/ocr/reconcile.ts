// WP-GUARD-OCR §29／WP-OCR-4：兩個獨立讀數（＋可選第三讀仲裁）→ 欄位結果。純函數。
// 規則（不變）：兩讀「正規化後逐字相同」＋格式驗證通過先 confirmed；其餘 review／missing。
// WP-OCR-4：兩讀各自嘅 alternatives 併入候選池，按格式驗證排序（value＝最高分候選）；
//   仲裁讀數（source arbiter）入池加權，唔自動 confirmed——除非仲裁值同其中一讀（正規化後）一致且 valid（2/3 一致）。
import type { OcrFieldKey } from "./config";
import type { FieldRead } from "./field-read";
import { isUnclear, normalizeField, type FieldResult } from "./normalize";
import { rankFieldCandidates, type RankInput } from "./rank";
import { variantCharCount } from "./hk-address";

export type ReadInput = string | null | undefined | FieldRead;

const asRead = (x: ReadInput): FieldRead => (x !== null && typeof x === "object" ? x : { value: x ?? null });
const usableAlts = (r: FieldRead): string[] => (r.alternatives ?? []).filter((v) => !isUnclear(v));

/** WP-OCR-2：外部（ALS）候選——只入候選池，唔自動確認。 */
export interface ExtraCandidate {
  value: string;
  source: "als";
  als_score?: number;
}

export function reconcile(key: OcrFieldKey, a: ReadInput, b: ReadInput, now: Date = new Date(), arbiter?: ReadInput, extras?: readonly ExtraCandidate[]): FieldResult {
  const ra = asRead(a);
  const rb = asRead(b);
  const rr = arbiter === undefined ? null : asRead(arbiter);
  const ua = isUnclear(ra.value);
  const ub = isUnclear(rb.value);
  const urr = rr ? isUnclear(rr.value) : true;
  const pool: RankInput[] = [];
  // WP-OCR-2：地址形近字——兩讀 canon 一致但 strict 唔同，變體字少嗰個（較似標準寫法）排前（同分時入池次序決定預填）
  const addrStrict = (v: string | null) => (v && !isUnclear(v) ? (normalizeField("address", v, now).strict ?? "") : "");
  const variantFirst = key === "address" && !ua && !ub && variantCharCount(rb.value!) < variantCharCount(ra.value!);
  // 仲裁值同 ALS 候選一致（strict）→ 當推導（唔加仲裁加權、分數封頂），避免 ALS 借仲裁名義搶預填
  const alsStrict = key === "address" ? new Set((extras ?? []).map((x) => addrStrict(x.value))) : null;
  const pushMain = (src: string, r: FieldRead, unclear: boolean) => {
    if (unclear) return;
    const derived = src === "arbiter" && alsStrict !== null && alsStrict.has(addrStrict(r.value));
    pool.push({ value: r.value!, source: src, ...(r.confidence ? { confidence: r.confidence } : {}), ...(derived ? { derived: true } : {}) });
  };
  if (variantFirst) {
    pushMain("b", rb, ub);
    pushMain("a", ra, ua);
  } else {
    pushMain("a", ra, ua);
    pushMain("b", rb, ub);
  }
  if (rr) pushMain("arbiter", rr, urr);
  for (const [src, r] of [["a", ra], ["b", rb], ...(rr ? [["arbiter", rr] as const] : [])] as const) for (const v of usableAlts(r)) pool.push({ value: v, source: `${src}_alt` });

  // WP-OCR-3：電話 9–10 位 → 剔走疑似分格線「1」嘅推算候選入池（排序靠格式驗證；唔自動確認）
  if (key === "phone") {
    for (const [src, r, unclear] of [["a", ra, ua], ["b", rb, ub], ...(rr ? [["arbiter", rr, urr] as const] : [])] as const) {
      if (unclear) continue;
      for (const v of normalizeField(key, r.value!, now).extra ?? []) pool.push({ value: v, source: `${src}_grid` });
    }
  }

  // WP-OCR-2（地址）：形近字糾錯建議入池（derived：分數封頂、唔搶預填）；ALS 候選同樣
  const nA = ua ? null : normalizeField(key, ra.value!, now);
  const nB = ub ? null : normalizeField(key, rb.value!, now);
  const addrEdits = key === "address" && ((nA?.edits?.length ?? 0) > 0 || (nB?.edits?.length ?? 0) > 0);
  if (key === "address") {
    for (const n of [nA, nB]) if (n?.suggested) pool.push({ value: n.suggested, source: "hk_address", derived: true });
    for (const x of extras ?? []) if (!isUnclear(x.value)) pool.push({ value: x.value, source: x.source, derived: true, ...(x.als_score !== undefined ? { als_score: x.als_score } : {}) });
  }

  if (ua && ub && pool.length === 0) return { status: "missing", value: "", candidates: [], candidates_ranked: [], reason: "unclear" };
  const na = ua ? null : normalizeField(key, ra.value!, now);
  const nb = ub ? null : normalizeField(key, rb.value!, now);

  // OCR-6：手寫電話收緊——confirmed 必須 a、b、仲裁三讀（正規化後）逐字相同＋valid（8 位、冇分格線嫌疑）。
  //   任何一讀位數唔係 8 → review phone_digit_count；兩讀相同但冇仲裁／仲裁唔同 → review phone_needs_three_way；
  //   2/3 一致（仲裁同其中一讀）→ review，預填一致嗰個值，arbiter agree_a|agree_b。
  if (key === "phone" && na && nb) {
    const nr = rr && !urr ? normalizeField(key, rr.value!, now) : null;
    const digits = (x: { canon: string }) => x.canon.replace(/\D/g, "").length;
    const tag: FieldResult["arbiter"] = rr ? (urr ? "unclear" : nr!.canon === na.canon ? "agree_a" : nr!.canon === nb.canon ? "agree_b" : "independent") : undefined;
    const withTag = (r: FieldResult): FieldResult => (tag ? { ...r, arbiter: tag } : r);
    const reviewRanked = (reason: string, prefer?: string): FieldResult => {
      const ranked = rankFieldCandidates(key, pool, now);
      return withTag({ status: "review", value: prefer ?? ranked[0]?.value ?? na.display, candidates: ranked.map((c) => c.value), candidates_ranked: ranked, reason });
    };
    if ([na, nb, ...(nr ? [nr] : [])].some((x) => digits(x) !== 8)) return reviewRanked("phone_digit_count");
    if (na.canon === nb.canon) {
      if (!na.valid) return reviewRanked(na.reason ?? "invalid_format", na.display); // 8 位但格式不合（例如非 2–9 開頭）
      if (nr && nr.canon === na.canon && nr.valid) return { status: "confirmed", value: nr.display, candidates: [], candidates_ranked: [], arbiter: "agree_a" };
      return reviewRanked("phone_needs_three_way", na.display);
    }
    if (nr && tag !== "independent") {
      const chosen = tag === "agree_a" ? na : nb;
      return reviewRanked(chosen.valid ? "phone_needs_three_way" : (chosen.reason ?? "invalid_format"), chosen.display);
    }
    // 兩讀唔同、仲裁獨立／unclear／冇仲裁 → 沿用下面 reads_differ 路徑
  }

  if (na && nb && na.canon === nb.canon) {
    // WP-OCR-2：canon（形近字歸一）只用嚟配對兩讀；地址要 strict（只做 NFKC／空白／標點）都相同且冇糾錯建議先 confirmed。
    // 只差形近／簡繁字 → review（候選＝兩個寫法，標準寫法排前）；有形近字糾錯建議 → review（候選＝原文＋建議）
    const strictSame = key !== "address" || na.strict === nb.strict;
    if (na.valid && !addrEdits && strictSame) return { status: "confirmed", value: na.display, candidates: [], candidates_ranked: [] };
    // OCR-4.4：地址只差形近字而入咗仲裁 → 仲裁值同其中一讀 strict 一致且 valid（且冇糾錯建議）= 2/3 一致，confirmed
    let vtag: FieldResult["arbiter"];
    if (key === "address" && !strictSame && !addrEdits && rr && !urr) {
      const nr = normalizeField(key, rr.value!, now);
      vtag = nr.strict === na.strict ? "agree_a" : nr.strict === nb.strict ? "agree_b" : "independent";
      // M1：只有仲裁值係標準寫法（變體字數 ≤ 另一讀）先 confirmed；否則（2/3 同意嘅係變體字寫法）維持 review
      const other = vtag === "agree_a" ? rb : ra;
      const standard = variantCharCount(rr.value!) <= variantCharCount(other.value!);
      if (nr.valid && vtag !== "independent" && standard) return { status: "confirmed", value: nr.display, candidates: [], candidates_ranked: [], arbiter: vtag };
    }
    let ranked = rankFieldCandidates(key, pool, now);
    // M1：仲裁同意變體字寫法時，仲裁加權唔可以令變體寫法搶預填——標準寫法（變體字少）排前（穩定排序，同數保持原次序）
    if (key === "address" && vtag && vtag !== "independent") {
      const rk = (v: string) => [normalizeField("address", v, now).valid ? 0 : 1, variantCharCount(v)] as const;
      ranked = ranked.map((c, i) => ({ c, i, k: rk(c.value) })).sort((x, y) => x.k[0] - y.k[0] || x.k[1] - y.k[1] || x.i - y.i).map((x) => x.c);
    }
    return { status: "review", value: ranked[0]?.value ?? na.display, candidates: ranked.map((c) => c.value), candidates_ranked: ranked, ...(vtag ? { arbiter: vtag } : {}), reason: na.valid ? (addrEdits ? "address_variant_suggested" : "address_variant_chars") : (na.reason ?? "invalid_format") };
  }

  if (na && nb) {
    // 兩讀唔同：仲裁值同其中一讀一致且 valid → 2/3 一致，confirmed；否則照樣 review（仲裁值只入候選池加權）
    let tag: FieldResult["arbiter"];
    if (rr && urr) tag = "unclear";
    else if (rr) {
      const nr = normalizeField(key, rr.value!, now);
      // 地址：仲裁同某一讀要 strict 一致先算 agree（形近字歸一唔當一致）
      const same = (x: typeof nr, y: typeof na) => (key === "address" ? x.strict === y.strict : x.canon === y.canon);
      tag = same(nr, na) ? "agree_a" : same(nr, nb) ? "agree_b" : "independent";
      if (nr.valid && tag !== "independent") return { status: "confirmed", value: nr.display, candidates: [], candidates_ranked: [], arbiter: tag };
    }
    const ranked = rankFieldCandidates(key, pool, now);
    return { status: "review", value: ranked[0]?.value ?? na.display, candidates: ranked.map((c) => c.value), candidates_ranked: ranked, reason: "reads_differ", ...(tag ? { arbiter: tag } : {}) };
  }

  // 只有一個主讀數（或兩個主讀數都 unclear 但有 alternatives）
  const ranked = rankFieldCandidates(key, pool, now);
  return { status: "review", value: ranked[0]?.value ?? (na ?? nb)?.display ?? "", candidates: ranked.map((c) => c.value), candidates_ranked: ranked, reason: ua && ub ? "both_unclear_alternatives" : "one_read_unclear" };
}
