// WA-8 B：工卡相辨識策略（成本優先；Claude 只做仲裁）。
//   兩個便宜引擎各讀一次：工號一致＋格式合法 → confirmed（零仲裁成本）；唔一致／其中一個讀唔到 → 仲裁引擎讀一次（三取二）；
//   三個都唔一致 → review（出分流題）。工號為主；姓名只輔助（resolve 時核對同工號對到嘅 guard）。
//   一張相可以有幾張卡 → 逐個工號判定。冇值用 caption 以外嘅文字推斷（呢度完全唔睇 caption）。
import { createEngine, type CardEngine, type CardEngineName, type EngineOverrides, type EngineUsage } from "./card-engines";
import { normStaffNo, type CardRead, type DocType, type SheetRow } from "./card-parse";

export const CARD_STRATEGIES = {
  S1: { primary: ["tesseract", "deepseek"], arbiter: "claude" },
  S2: { primary: ["tesseract", "deepseek"], arbiter: "haiku" },
  S3: { primary: ["deepseek", "haiku"], arbiter: "claude" },
  S4: { primary: ["tesseract", "qwen"], arbiter: "haiku" },
  S5: { primary: ["qwen", "deepseek"], arbiter: "claude" },
  // WA-9：預設——qwen-vl-ocr + haiku 兩讀，分歧先 opus（claude）仲裁；haiku 唔可用（冇 key／失敗）→ 用 deepseek 頂上；tesseract 唔使（可選）
  S6: { primary: ["qwen", "haiku"], arbiter: "claude", fallback: { for: "haiku", use: "deepseek" } },
} as const satisfies Record<string, { primary: readonly [CardEngineName, CardEngineName]; arbiter: CardEngineName; fallback?: { for: CardEngineName; use: CardEngineName } }>;
export type CardStrategy = keyof typeof CARD_STRATEGIES;

/** 生產預設策略：env WA_CARD_OCR_STRATEGY（S1–S6），預設 S6；唔認得當 S6。 */
export function cardStrategyFromEnv(): CardStrategy {
  const v = process.env.WA_CARD_OCR_STRATEGY?.trim().toUpperCase();
  return v && v in CARD_STRATEGIES ? (v as CardStrategy) : "S6";
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
  /** 支持呢個工號嘅引擎票數（confirmed ≥2）；冇工號嘅姓名卡＝支持呢個姓名嘅引擎票數 */
  votes: number;
  /** WA-9：相片文件類型（引擎多數）；唔肯定＝null */
  doc_type?: DocType | null;
  /** WA-9：相入面讀到嘅時間（打卡紙／app 截圖／簽到表當日行，HH:MM）；多數票，冇＝null */
  time_on?: string | null;
  time_off?: string | null;
  /** WA-9：冇工號、姓名分歧時嘅姓名候選（合併成一條題用） */
  name_candidates?: string[];
  /** WA-9 值勤表逐行：該行日期（YYYY-MM-DD）／工號欄原樣（唔係 U 格式嘅 Wilson 編號、手寫 L13xxxx／413xxxx；暫存、唔用嚟配對）／行號 */
  row_date?: string | null;
  wilson_staff_no_raw?: string | null;
  row_no?: number | null;
}
export interface CardPhotoResult {
  /** cards＝有卡｜not_card＝相入面冇工卡（兩個引擎都話唔係）｜unreadable＝讀唔到（引擎全部失敗／冇任何可用讀數） */
  kind: "cards" | "not_card" | "unreadable";
  /** WA-9：相片文件類型（多數票；null＝引擎冇講／冇共識） */
  doc_type?: DocType | null;
  cards: PhotoCard[];
  usage: EngineUsage[];
  arbiter_used: boolean;
  /** 逐引擎結果（唔含值）：ok／張數 */
  engines: Array<{ engine: CardEngineName; ok: boolean; cards: number }>;
}

type Ran = { engine: CardEngineName; out: Awaited<ReturnType<CardEngine["read"]>> };

const nosOf = (cards: readonly CardRead[]): string[] => [...new Set(cards.flatMap((c) => (c.staff_no ? [c.staff_no] : [])))];
const norm = (s: string | null): string | null => (s ? s.normalize("NFKC").replace(/\s+/g, "").toLowerCase() || null : null);

function pickTime(reads: readonly (CardRead | undefined)[], key: "time_on" | "time_off"): string | null {
  const tally = new Map<string, number>();
  for (const r of reads) {
    const t = r?.[key];
    if (t) tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

/** 引擎 doc_type 多數票；平手時偏向非 other；全冇＝null。 */
function pickDocType(outs: ReadonlyArray<{ doc_type?: DocType | null }>): DocType | null {
  const tally = new Map<DocType, number>();
  for (const o of outs) if (o.doc_type) tally.set(o.doc_type, (tally.get(o.doc_type) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || Number(a[0] === "other") - Number(b[0] === "other"))[0]?.[0] ?? null;
}

function pickName(reads: readonly (CardRead | undefined)[], key: "name_zh" | "name_en"): string | null {
  const tally = new Map<string, { raw: string; n: number }>();
  for (const r of reads) {
    const raw = r?.[key];
    const k = norm(raw ?? null);
    if (!raw || !k) continue;
    const cur = tally.get(k);
    if (cur) cur.n += 1;
    else tally.set(k, { raw: key === "name_zh" ? raw.normalize("NFKC").replace(/\s+/g, "") : raw, n: 1 }); // 中文姓名去空白
  }
  return [...tally.values()].sort((a, b) => b.n - a.n)[0]?.raw ?? null;
}

export interface ReadPhotoOptions {
  strategy?: CardStrategy;
  /** 測試／bench 注入引擎（冇注入就用 createEngine） */
  engines?: Partial<Record<CardEngineName, CardEngine>>;
  overrides?: EngineOverrides;
  /** 訊息香港日（YYYY-MM-DD）：簽到表揀當日行用 */
  today?: string;
}

export async function readCardPhoto(bytes: Buffer, opts: ReadPhotoOptions = {}): Promise<CardPhotoResult> {
  const strat = CARD_STRATEGIES[opts.strategy ?? cardStrategyFromEnv()];
  const eng = (n: CardEngineName): CardEngine => opts.engines?.[n] ?? createEngine(n, opts.overrides);
  const usage: EngineUsage[] = [];
  const run = async (n: CardEngineName): Promise<Ran> => {
    const out = await eng(n).read(bytes, opts.today ? { today: opts.today } : undefined);
    if (out.usage) usage.push(out.usage);
    return { engine: n, out };
  };
  const fb = "fallback" in strat ? (strat.fallback as { for: CardEngineName; use: CardEngineName }) : null;
  const primaries = await Promise.all(
    strat.primary.map(async (n) => {
      const r = await run(n);
      // 指定引擎唔可用／失敗 → 用後備引擎頂上（呢次讀數以後備引擎名記賬）
      if (fb && n === fb.for && !r.out.ok && !(strat.primary as readonly CardEngineName[]).includes(fb.use)) return run(fb.use);
      return r;
    }),
  );
  const summary = (rs: readonly Ran[]) => rs.map((r) => ({ engine: r.engine, ok: r.out.ok, cards: r.out.ok ? r.out.cards.length : 0 }));
  const okReads = (rs: readonly Ran[]) => rs.flatMap((r) => (r.out.ok ? [r.out] : []));

  const sets = primaries.map((r) => (r.out.ok ? new Set(nosOf(r.out.cards)) : null));
  const [A, B] = sets;
  const anyCardClaim = okReads(primaries).some((o) => o.is_card && (o.cards.length > 0 || (o.rows?.length ?? 0) > 0));
  const bothOk = A !== null && B !== null;

  // WA-9：值勤／出勤記錄表（任何一個引擎話係 attendance_sheet 或者逐行抽到 rows）→ 逐行判定
  if (okReads(primaries).some((o) => (o.rows?.length ?? 0) > 0 || o.doc_type === "attendance_sheet")) return readSheet(primaries, strat.arbiter, run, usage, summary);

  // 兩個都讀得到而且都話冇卡 → 唔係工卡
  if (bothOk && !anyCardClaim) return { kind: "not_card", doc_type: pickDocType(okReads(primaries)), cards: [], usage, arbiter_used: false, engines: summary(primaries) };

  const union = new Set<string>([...(A ?? []), ...(B ?? [])]);
  const agreed = bothOk ? [...A].filter((x) => B.has(x)) : [];
  const disputed = [...union].filter((x) => !agreed.includes(x));
  // 有分歧／其中一個引擎失敗 → 仲裁（兩個引擎都冇工號但讀到姓名＝姓名輔助，唔仲裁）
  // WA-9：冇任何工號嘅相（打卡紙／簽到表／app 截圖只有姓名）——兩個引擎讀到嘅姓名唔同 → 都要仲裁
  const nameKey = (c: CardRead): string | null => norm(c.name_zh);
  const namesOf = (r: Ran): Set<string> => new Set(r.out.ok ? r.out.cards.flatMap((c) => (nameKey(c) ? [nameKey(c)!] : [])) : []);
  const nameDisputed = union.size === 0 && bothOk && (() => {
    const [na, nb] = [namesOf(primaries[0]!), namesOf(primaries[1]!)];
    return na.size + nb.size > 0 && (na.size !== nb.size || [...na].some((x) => !nb.has(x)));
  })();
  const needArbiter = disputed.length > 0 || !bothOk || nameDisputed;

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
  const docType = pickDocType(okReads(all));
  const mk = (no: string | null, status: PhotoCard["status"], reasons: string[], candidates: string[], votes: number, readsOverride?: readonly CardRead[]): PhotoCard => {
    const reads = readsOverride ?? (no ? (readsByNo.get(no) ?? []) : okReads(all).flatMap((o) => o.cards));
    return { staff_no: no, name_zh: pickName(reads, "name_zh"), name_en: pickName(reads, "name_en"), status, reasons, candidates, votes, doc_type: docType, time_on: pickTime(reads, "time_on"), time_off: pickTime(reads, "time_off") };
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
  // WA-9：冇任何工號但有人讀到姓名（打卡紙／簽到表／app 截圖）→ 以姓名為身份：≥2 個引擎讀到同一姓名＝confirmed（仍然要喺 resolve 揀盤／判頭範圍內唯一配對）
  if (cards.length === 0) {
    const byName = new Map<string, CardRead[]>();
    for (const r of all) if (r.out.ok) for (const c of r.out.cards) if (nameKey(c)) byName.set(nameKey(c)!, [...(byName.get(nameKey(c)!) ?? []), c]);
    const votesByName = (k: string): number => all.filter((r) => r.out.ok && namesOf(r).has(k)).length;
    const keys = [...byName.keys()];
    const confirmedNames = keys.filter((k) => votesByName(k) >= 2);
    const singleNames = keys.filter((k) => votesByName(k) < 2);
    for (const k of confirmedNames) cards.push(mk(null, "confirmed", ["card_name_only"], [], votesByName(k), byName.get(k)));
    const oneNamePerEngine = all.every((r) => !r.out.ok || namesOf(r).size <= 1);
    if (confirmedNames.length === 0 && singleNames.length > 0) {
      const down = arbiterUsed && !!arbiter && !arbiter.out.ok;
      const reasons = ["card_name_only", down ? "card_arbiter_unavailable" : "card_disputed"];
      if (oneNamePerEngine) {
        // 同一張卡嘅分歧姓名讀數 → 一條題列晒候選
        const merged = mk(null, "review", reasons, [], 1, singleNames.flatMap((k) => byName.get(k)!));
        cards.push({ ...merged, name_candidates: singleNames.map((k) => byName.get(k)![0]!.name_zh!) });
      } else for (const k of singleNames) cards.push({ ...mk(null, "review", reasons, [], 1, byName.get(k)), name_candidates: [byName.get(k)![0]!.name_zh!] });
    } else if (confirmedNames.length > 0 && !oneNamePerEngine) {
      for (const k of singleNames) cards.push({ ...mk(null, "review", ["card_name_only", "card_suspect_second"], [], 1, byName.get(k)), name_candidates: [byName.get(k)![0]!.name_zh!] });
    }
  }
  if (cards.length === 0) {
    const dead = all.every((r) => !r.out.ok);
    return { kind: dead || anyCardClaim || arbiterUsed ? "unreadable" : "not_card", doc_type: docType, cards: [], usage, arbiter_used: arbiterUsed, engines: summary(all) };
  }
  return { kind: "cards", doc_type: docType, cards, usage, arbiter_used: arbiterUsed, engines: summary(all) };
}

// ---------------------------------------------------------------------------
// WA-9：值勤／出勤記錄表逐行判定（多人表；一行＝一條候選記錄）
// ---------------------------------------------------------------------------
const rowName = (r: SheetRow): string => (r.name_zh ?? "").normalize("NFKC").replace(/\s+/g, "");
const rowNoKey = (r: SheetRow): string => (r.staff_no_raw ?? "").normalize("NFKC").toUpperCase().replace(/[\s\-:]/g, "");
const rowKey = (r: SheetRow): string => `${rowName(r)}|${r.date ?? ""}`;
const sameRow = (a: SheetRow, b: SheetRow): boolean => rowNoKey(a) === rowNoKey(b) && a.time_on === b.time_on && a.time_off === b.time_off;

function majority<T>(vals: readonly T[]): { value: T | null; n: number } {
  const t = new Map<string, { v: T; n: number }>();
  for (const v of vals) {
    const k = JSON.stringify(v);
    const cur = t.get(k);
    if (cur) cur.n += 1;
    else t.set(k, { v, n: 1 });
  }
  const top = [...t.values()].sort((a, b) => b.n - a.n)[0];
  return top ? { value: top.v, n: top.n } : { value: null, n: 0 };
}

async function readSheet(
  primaries: readonly Ran[],
  arbiterName: CardEngineName,
  run: (n: CardEngineName) => Promise<Ran>,
  usage: EngineUsage[],
  summary: (rs: readonly Ran[]) => Array<{ engine: CardEngineName; ok: boolean; cards: number }>,
): Promise<CardPhotoResult> {
  const rowsOf = (r: Ran): SheetRow[] => (r.out.ok ? (r.out.rows ?? []).filter((x) => rowName(x) || rowNoKey(x)) : []);
  const bothOk = primaries.every((p) => p.out.ok);
  const [ra, rb] = primaries.map(rowsOf);
  // 全部行兩邊都有而且欄位一致 → 唔仲裁（零 Claude 成本）
  const agreedAll = bothOk && ra!.length > 0 && ra!.length === rb!.length && ra!.every((x) => rb!.some((y) => rowKey(x) === rowKey(y) && sameRow(x, y)));
  let all: Ran[] = [...primaries];
  let arbiter: Ran | null = null;
  if (!agreedAll) {
    arbiter = await run(arbiterName);
    all = [...primaries, arbiter];
  }
  const arbiterDown = !!arbiter && !arbiter.out.ok;
  const reads = all.flatMap((r) => rowsOf(r).map((row) => ({ engine: r.engine, row })));
  const keys = [...new Set(reads.map((x) => rowKey(x.row)))];
  type Agg = { key: string; votes: number; row: SheetRow; ok: boolean; reasons: string[] };
  const aggs: Agg[] = keys.map((key) => {
    const rs = reads.filter((x) => rowKey(x.row) === key).map((x) => x.row);
    const base = rs[0]!;
    const sn = majority(rs.map((x) => rowNoKey(x) || null));
    const ton = majority(rs.map((x) => x.time_on));
    const toff = majority(rs.map((x) => x.time_off));
    const rawNo = rs.find((x) => rowNoKey(x) === sn.value)?.staff_no_raw ?? null;
    const lowAny = rs.some((x) => x.confidence === "low");
    const votes = new Set(reads.filter((x) => rowKey(x.row) === key).map((x) => x.engine)).size;
    const reasons: string[] = [];
    if (votes < 2) reasons.push(arbiterDown ? "card_arbiter_unavailable" : "card_disputed");
    else if (sn.n < 2 && new Set(rs.map((x) => rowNoKey(x) || null)).size > 1) reasons.push("card_disputed");
    else if (ton.n < 2 && new Set(rs.map((x) => x.time_on)).size > 1) reasons.push("card_disputed");
    if (lowAny) reasons.push("row_low_confidence");
    const row: SheetRow = { ...base, name_zh: pickName(rs.map((x) => ({ is_card: true, staff_no: null, name_zh: x.name_zh, name_en: null, confidence: x.confidence })), "name_zh"), staff_no_raw: rawNo, time_on: ton.value, time_off: toff.value, row: base.row, confidence: lowAny ? "low" : "high" };
    return { key, votes, row, ok: reasons.length === 0, reasons };
  });
  // 單票行若同已確認行**同行號同日期** → 同一行嘅誤讀（例：名讀錯一字），唔另開。冇行號就唔丟（姓名相近唔代表同一個人，丟咗會漏人）
  const okAggs = aggs.filter((a) => a.ok);
  const kept = aggs.filter((a) => a.ok || !okAggs.some((c) => c.row.row !== null && c.row.row === a.row.row && c.row.date === a.row.date));
  kept.sort((a, b) => (a.row.row ?? 1e6) - (b.row.row ?? 1e6));
  const cards: PhotoCard[] = kept.map((a) => {
    const staff = normStaffNo(a.row.staff_no_raw);
    return {
      staff_no: staff,
      name_zh: a.row.name_zh,
      name_en: null,
      status: a.ok ? "confirmed" : "review",
      reasons: a.ok ? [] : a.reasons,
      candidates: [],
      votes: a.votes,
      doc_type: "attendance_sheet",
      time_on: a.row.time_on,
      time_off: a.row.time_off,
      row_date: a.row.date,
      row_no: a.row.row,
      wilson_staff_no_raw: staff ? null : a.row.staff_no_raw,
    };
  });
  if (cards.length === 0) return { kind: "unreadable", doc_type: "attendance_sheet", cards: [], usage, arbiter_used: !!arbiter, engines: summary(all) };
  return { kind: "cards", doc_type: "attendance_sheet", cards, usage, arbiter_used: !!arbiter, engines: summary(all) };
}
