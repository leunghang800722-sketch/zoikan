// WA-8 B：工卡相辨識策略（成本優先；Claude 只做仲裁）。
//   兩個便宜引擎各讀一次：工號一致＋格式合法 → confirmed（零仲裁成本）；唔一致／其中一個讀唔到 → 仲裁引擎讀一次（三取二）；
//   三個都唔一致 → review（出分流題）。工號為主；姓名只輔助（resolve 時核對同工號對到嘅 guard）。
//   一張相可以有幾張卡 → 逐個工號判定。冇值用 caption 以外嘅文字推斷（呢度完全唔睇 caption）。
import { createEngine, type CardEngine, type CardEngineName, type EngineOverrides, type EngineUsage } from "./card-engines";
import type { CardRead } from "./card-parse";

export const CARD_STRATEGIES = {
  S1: { primary: ["tesseract", "deepseek"], arbiter: "claude" },
  S2: { primary: ["tesseract", "deepseek"], arbiter: "haiku" },
  S3: { primary: ["deepseek", "haiku"], arbiter: "claude" },
  S4: { primary: ["tesseract", "qwen"], arbiter: "haiku" },
  S5: { primary: ["qwen", "deepseek"], arbiter: "claude" },
} as const satisfies Record<string, { primary: readonly [CardEngineName, CardEngineName]; arbiter: CardEngineName }>;
export type CardStrategy = keyof typeof CARD_STRATEGIES;

/** 生產預設策略：env WA_CARD_OCR_STRATEGY（S1–S5），預設 S1；唔認得當 S1。 */
export function cardStrategyFromEnv(): CardStrategy {
  const v = process.env.WA_CARD_OCR_STRATEGY?.trim().toUpperCase();
  return v && v in CARD_STRATEGIES ? (v as CardStrategy) : "S1";
}

export interface PhotoCard {
  staff_no: string | null;
  name_zh: string | null;
  name_en: string | null;
  status: "confirmed" | "review";
  /** review 原因碼：card_disputed（只得一票）｜card_arbiter_unavailable｜card_name_only */
  reasons: string[];
  /** 該卡出現過嘅所有工號讀數（review 時畀人揀；只有格式合法嘅） */
  candidates: string[];
  /** 支持呢個工號嘅引擎票數（confirmed ≥2） */
  votes: number;
}
export interface CardPhotoResult {
  /** cards＝有卡｜not_card＝相入面冇工卡（兩個引擎都話唔係）｜unreadable＝讀唔到（引擎全部失敗／冇任何可用讀數） */
  kind: "cards" | "not_card" | "unreadable";
  cards: PhotoCard[];
  usage: EngineUsage[];
  arbiter_used: boolean;
  /** 逐引擎結果（唔含值）：ok／張數 */
  engines: Array<{ engine: CardEngineName; ok: boolean; cards: number }>;
}

type Ran = { engine: CardEngineName; out: Awaited<ReturnType<CardEngine["read"]>> };

const nosOf = (cards: readonly CardRead[]): string[] => [...new Set(cards.flatMap((c) => (c.staff_no ? [c.staff_no] : [])))];
const norm = (s: string | null): string | null => (s ? s.normalize("NFKC").replace(/\s+/g, "").toLowerCase() || null : null);

function pickName(reads: readonly (CardRead | undefined)[], key: "name_zh" | "name_en"): string | null {
  const tally = new Map<string, { raw: string; n: number }>();
  for (const r of reads) {
    const raw = r?.[key];
    const k = norm(raw ?? null);
    if (!raw || !k) continue;
    const cur = tally.get(k);
    if (cur) cur.n += 1;
    else tally.set(k, { raw, n: 1 });
  }
  return [...tally.values()].sort((a, b) => b.n - a.n)[0]?.raw ?? null;
}

export interface ReadPhotoOptions {
  strategy?: CardStrategy;
  /** 測試／bench 注入引擎（冇注入就用 createEngine） */
  engines?: Partial<Record<CardEngineName, CardEngine>>;
  overrides?: EngineOverrides;
}

export async function readCardPhoto(bytes: Buffer, opts: ReadPhotoOptions = {}): Promise<CardPhotoResult> {
  const strat = CARD_STRATEGIES[opts.strategy ?? cardStrategyFromEnv()];
  const eng = (n: CardEngineName): CardEngine => opts.engines?.[n] ?? createEngine(n, opts.overrides);
  const usage: EngineUsage[] = [];
  const run = async (n: CardEngineName): Promise<Ran> => {
    const out = await eng(n).read(bytes);
    if (out.usage) usage.push(out.usage);
    return { engine: n, out };
  };
  const primaries = await Promise.all(strat.primary.map(run));
  const summary = (rs: readonly Ran[]) => rs.map((r) => ({ engine: r.engine, ok: r.out.ok, cards: r.out.ok ? r.out.cards.length : 0 }));
  const okReads = (rs: readonly Ran[]) => rs.flatMap((r) => (r.out.ok ? [r.out] : []));

  const sets = primaries.map((r) => (r.out.ok ? new Set(nosOf(r.out.cards)) : null));
  const [A, B] = sets;
  const anyCardClaim = okReads(primaries).some((o) => o.is_card && o.cards.length > 0);
  const bothOk = A !== null && B !== null;

  // 兩個都讀得到而且都話冇卡 → 唔係工卡
  if (bothOk && !anyCardClaim) return { kind: "not_card", cards: [], usage, arbiter_used: false, engines: summary(primaries) };

  const union = new Set<string>([...(A ?? []), ...(B ?? [])]);
  const agreed = bothOk ? [...A].filter((x) => B.has(x)) : [];
  const disputed = [...union].filter((x) => !agreed.includes(x));
  // 有分歧／其中一個引擎失敗 → 仲裁（兩個引擎都冇工號但讀到姓名＝姓名輔助，唔仲裁）
  const needArbiter = disputed.length > 0 || !bothOk;

  let all: Ran[] = [...primaries];
  let arbiterUsed = false;
  let arbiter: Ran | null = null;
  if (needArbiter) {
    arbiterUsed = true;
    arbiter = await run(strat.arbiter);
    all = [...primaries, arbiter];
  }
  const C = arbiter && arbiter.out.ok ? new Set(nosOf(arbiter.out.cards)) : null;

  // 逐工號判定
  const readsByNo = new Map<string, CardRead[]>();
  for (const r of all) if (r.out.ok) for (const c of r.out.cards) if (c.staff_no) readsByNo.set(c.staff_no, [...(readsByNo.get(c.staff_no) ?? []), c]);
  const votesOf = (no: string): number => all.filter((r) => r.out.ok && nosOf(r.out.cards).includes(no)).length;
  const cards: PhotoCard[] = [];
  const allNos = [...new Set([...union, ...(C ?? [])])];
  const confirmedNos = allNos.filter((n) => votesOf(n) >= 2);
  const singles = allNos.filter((n) => votesOf(n) < 2);
  // 所有讀得到嘅引擎都只讀到 ≤1 張卡 → 單票讀數只可能係同一張卡嘅誤讀；只要有任何一個引擎見到 ≥2 張卡，單票讀數就唔准丟（可能係漏讀嘅第二個人）
  const singleCardPhoto = all.every((r) => !r.out.ok || nosOf(r.out.cards).length <= 1);
  const arbiterDown = arbiterUsed && !!arbiter && !arbiter.out.ok;
  const mk = (no: string | null, status: PhotoCard["status"], reasons: string[], candidates: string[], votes: number): PhotoCard => {
    const reads = no ? (readsByNo.get(no) ?? []) : okReads(all).flatMap((o) => o.cards);
    return { staff_no: no, name_zh: pickName(reads, "name_zh"), name_en: pickName(reads, "name_en"), status, reasons, candidates, votes };
  };
  for (const no of confirmedNos) cards.push(mk(no, "confirmed", [], singleCardPhoto ? singles : [], votesOf(no)));
  if (singleCardPhoto) {
    // 淨係單票讀數、冇一個確認 → 同一張卡嘅分歧讀數，合併成一條題列晒全部候選（唔出幾條）
    if (confirmedNos.length === 0 && singles.length > 0) cards.push(mk(singles.length === 1 ? singles[0]! : null, "review", [arbiterDown ? "card_arbiter_unavailable" : "card_disputed"], singles, Math.max(...singles.map(votesOf))));
  } else {
    for (const no of singles) {
      // 已有確認嘅卡而又只得一票 → 疑似漏讀嘅另一張卡：出題畀人剔（列明已確認嗰張＋疑似嗰張）
      const reasons = confirmedNos.length > 0 ? ["card_suspect_second"] : [arbiterDown ? "card_arbiter_unavailable" : "card_disputed"];
      cards.push(mk(no, "review", reasons, allNos, votesOf(no)));
    }
  }
  // 冇任何工號，但有人讀到姓名 → 姓名輔助配對（永遠 review）
  if (cards.length === 0) {
    const reads = okReads(all).flatMap((o) => o.cards);
    const zh = pickName(reads, "name_zh");
    const en = pickName(reads, "name_en");
    if (zh || en) cards.push({ staff_no: null, name_zh: zh, name_en: en, status: "review", reasons: ["card_name_only"], candidates: [], votes: 0 });
  }
  if (cards.length === 0) {
    const dead = all.every((r) => !r.out.ok);
    return { kind: dead || anyCardClaim || arbiterUsed ? "unreadable" : "not_card", cards: [], usage, arbiter_used: arbiterUsed, engines: summary(all) };
  }
  return { kind: "cards", cards, usage, arbiter_used: arbiterUsed, engines: summary(all) };
}
