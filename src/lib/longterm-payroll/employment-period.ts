// EMP-P3：長工聘用段（入職／離職日）改讀 MG 工號卡鏈，而唔係人卡 `guards.hire_date`／`leave_date`。
//
// 聘用段 = MG（長工體系，staff_schemes.is_longterm）卡鏈：由該月有效（或最近）嘅卡沿 `predecessor_id` 串返去，
//   段起點＝鏈最早一張卡嘅 `valid_from`；段終點＝鏈尾卡嘅 `valid_to`（只計 `end_reason=resigned`；replaced／cancelled／舊資料 null 唔係終點）。
// 讀日期次序：卡有日期就用卡，否則 fallback 人卡兩欄。兩邊都有而唔一致 → 用卡、回 warning `card_guard_date_mismatch`。
// 再入職：人卡 leave_date 早過當前鏈起點＝第二段聘用——段起點＝鏈起點、忽略舊 leave_date、回 warning `rehire_detected`（唔再跳過出糧）。
// 生效月：`LONGTERM_CARD_DATES_EFFECTIVE_FROM`（2026-10-01，老闆拍板）——早過佢嘅月份全部照舊讀人卡（7／8／9 月 gate 數字不變）。
//   要改生效月：只改下面常數＋docs/api.md「EMP-P3」一節。純函數，唔讀 DB。
export const LONGTERM_CARD_DATES_EFFECTIVE_FROM = new Date(Date.UTC(2026, 9, 1));

export interface PeriodCard {
  id: string;
  scheme: string;
  status: "current" | "former";
  validFrom: Date | null;
  validTo: Date | null;
  endReason: string | null;
  predecessorId: string | null;
}

type PeriodWarningCode = "card_guard_date_mismatch" | "rehire_detected";
export interface PeriodWarning {
  code: PeriodWarningCode;
  guardId: string;
  /** mismatch 先有：hire＝入職日、leave＝離職日 */
  field?: "hire" | "leave";
  /** 卡嘅日期（YYYY-MM-DD）／人卡嘅日期（YYYY-MM-DD） */
  cardDate: string | null;
  guardDate: string | null;
}

export interface LongtermPeriod {
  /** 聘用段起點（讀日期次序之後）；null＝兩邊都冇 */
  start: Date | null;
  /** 聘用段終點；null＝仍在職／冇資料 */
  end: Date | null;
  startSource: "card" | "guard" | null;
  endSource: "card" | "guard" | null;
  /** 命中嘅 MG 卡鏈（最早→最新）；冇＝[] */
  chainCardIds: string[];
  /** 偵測到再入職（人卡舊 leave_date 早過鏈起點）：舊 leave_date 已忽略 */
  rehire: boolean;
  /** 係咪行咗卡日期路徑（false＝生效前月份或冇卡鏈，純人卡） */
  usedCards: boolean;
  warnings: PeriodWarning[];
}

const iso = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
const t = (d: Date): number => d.getTime();

/** 建 MG 卡鏈（每條 earliest→tip）。predecessor 唔喺同體系卡集合內＝鏈頭；防循環。 */
function buildChains(cards: readonly PeriodCard[]): PeriodCard[][] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const hasSuccessor = new Set(cards.map((c) => c.predecessorId).filter((x): x is string => !!x && byId.has(x)));
  const chains: PeriodCard[][] = [];
  for (const tip of cards) {
    if (hasSuccessor.has(tip.id)) continue;
    const chain: PeriodCard[] = [];
    const seen = new Set<string>();
    let cur: PeriodCard | undefined = tip;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.predecessorId ? byId.get(cur.predecessorId) : undefined;
    }
    chains.push(chain);
  }
  return chains;
}

const chainStart = (c: PeriodCard[]): Date | null => c[0]!.validFrom;
function chainEnd(c: PeriodCard[]): Date | null {
  const tip = c[c.length - 1]!;
  return tip.status === "former" && tip.endReason === "resigned" && tip.validTo ? tip.validTo : null;
}

/** 揀該月相關嘅鏈：期間（起點 null＝無下限、終點 null＝無上限）同該月重疊；多條取起點最遲；全部唔重疊就取起點最遲嗰條（最近一段）。 */
function pickChain(chains: PeriodCard[][], monthStart: Date, monthEnd: Date): PeriodCard[] | null {
  if (chains.length === 0) return null;
  const latest = (list: PeriodCard[][]) => [...list].sort((a, b) => (chainStart(b)?.getTime() ?? -Infinity) - (chainStart(a)?.getTime() ?? -Infinity))[0]!;
  const overlapping = chains.filter((c) => {
    const s = chainStart(c);
    const e = chainEnd(c);
    return (s === null || t(s) <= t(monthEnd)) && (e === null || t(e) >= t(monthStart));
  });
  return latest(overlapping.length ? overlapping : chains);
}

export function resolveLongtermPeriod(
  guard: { id: string; hireDate: Date | null; leaveDate: Date | null },
  cards: readonly PeriodCard[],
  month: Date,
  longtermSchemes: ReadonlySet<string> = new Set(["MG"]),
): LongtermPeriod {
  const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
  const legacy: LongtermPeriod = {
    start: guard.hireDate,
    end: guard.leaveDate,
    startSource: guard.hireDate ? "guard" : null,
    endSource: guard.leaveDate ? "guard" : null,
    chainCardIds: [],
    rehire: false,
    usedCards: false,
    warnings: [],
  };
  if (t(monthStart) < t(LONGTERM_CARD_DATES_EFFECTIVE_FROM)) return legacy;
  const chain = pickChain(buildChains(cards.filter((c) => longtermSchemes.has(c.scheme))), monthStart, monthEnd);
  if (!chain) return legacy;

  const warnings: PeriodWarning[] = [];
  const cardStart = chainStart(chain);
  const cardEnd = chainEnd(chain);
  const gHire = guard.hireDate;
  const gLeave = guard.leaveDate;

  // 再入職：人卡舊 leave_date 早過鏈起點
  const rehire = !!cardStart && !!gLeave && t(gLeave) < t(cardStart);
  if (rehire) warnings.push({ code: "rehire_detected", guardId: guard.id, cardDate: iso(cardStart), guardDate: iso(gLeave) });

  let start: Date | null;
  let startSource: LongtermPeriod["startSource"];
  if (cardStart) {
    start = cardStart;
    startSource = "card";
    if (!rehire && gHire && t(gHire) !== t(cardStart)) warnings.push({ code: "card_guard_date_mismatch", guardId: guard.id, field: "hire", cardDate: iso(cardStart), guardDate: iso(gHire) });
  } else {
    start = gHire;
    startSource = gHire ? "guard" : null;
  }

  let end: Date | null;
  let endSource: LongtermPeriod["endSource"];
  if (cardEnd) {
    end = cardEnd;
    endSource = "card";
    if (!rehire && gLeave && t(gLeave) !== t(cardEnd)) warnings.push({ code: "card_guard_date_mismatch", guardId: guard.id, field: "leave", cardDate: iso(cardEnd), guardDate: iso(gLeave) });
  } else if (rehire) {
    end = null; // 舊段離職日已忽略
    endSource = null;
  } else {
    end = gLeave;
    endSource = gLeave ? "guard" : null;
  }
  return { start, end, startSource, endSource, chainCardIds: chain.map((c) => c.id), rehire, usedCards: true, warnings };
}

/** 警告文字（aggregate warnings 用；帶 guardId 同兩個日期，唔帶其他個人資料）。 */
export function periodWarningText(w: PeriodWarning, guardName: string): string {
  if (w.code === "rehire_detected") {
    return `[rehire_detected] ${guardName}（${w.guardId}）：人卡離職日 ${w.guardDate} 早過現行 MG 卡鏈起點 ${w.cardDate}——當第二段聘用，舊離職日已忽略（建議清走人卡離職日）`;
  }
  return `[card_guard_date_mismatch] ${guardName}（${w.guardId}）：${w.field === "hire" ? "入職日" : "離職日"}工號卡 ${w.cardDate} 同人卡 ${w.guardDate} 唔一致，用工號卡`;
}
