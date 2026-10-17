// W1：第 0 層過濾（零成本規則，純函數；docs/plans/whatsapp-roster-plan.md §5.1）。
// 打分 0–100，≥ 閾值（預設 40，群組可覆寫 filter_threshold）先交 AI。
// 問號規則（老闆 2026-10-17 補充）：日期 token＋（更別詞或請假詞）同時命中＝「帶問句嘅指令」，問號不減分；
// 只有純疑問句（冇該組合）先減分。reasons 只係固定代碼，唔含原文。
export const FILTER_DEFAULT_THRESHOLD = 40;

export interface FilterInput {
  text: string;
  /** 被回覆（quoted）訊息文字（同群 24 小時內；呼叫方負責查）。 */
  quotedText?: string | null;
  /** 群組類型；null＝未綁定群組。 */
  groupKind: "site" | "multi_site" | "broker" | "office" | "ignored" | null;
  /** 群組是否停用。 */
  groupActive?: boolean;
  /** 該群／所有盤口別名（命中加分）。 */
  siteAliases?: readonly string[];
  /** 發訊人係已知保安員／判頭。 */
  senderKnown?: boolean;
  /** 群組層覆寫閾值；冇就預設 40。 */
  threshold?: number | null;
}

export interface FilterResult {
  score: number;
  reasons: string[];
  decision: "ignore" | "candidate";
}

// 日期 token（計劃書 §5.1 ＋ 今晚／而家／今個更／琴日 等相對詞，供凌晨降級同過去日子用）
const DATE_RE = /(大後日|後日|聽日|明日|今日|今晚|今朝|今早|今夜|今個更|今更|而家|聽晚|聽朝|琴日|尋日|昨日|前日|星期[一二三四五六日天]|禮拜[一二三四五六日天]|週[一二三四五六日]|周[一二三四五六日]|\d{1,2}\s*[/／.]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}|\d{1,2}\s*[號号日])/;
// W4：補返 RD／SH／NPL 嘅口語（例假／公假／休假／公眾假期／法定假），否則「我21號例假」會被過濾層丟棄
const LEAVE_RE = /(病假|\bSL\b|\bAL\b|\bNL\b|\bNPL\b|\bRD\b|\bSH\b|年假|放假|休假|例假|公假|公眾假期|法定假|唔返|返唔到|請假|告假|事假|病咗|病倒)/i;
const SHIFT_RE = /([早中夜]更|通宵|[ABCN]\s*更|返工|開工|\bOT\b|加班|頂|替|換更|補更|返[早中夜]|[早中夜晚]班|[早夜])/i;
const ACK_RE = /^(?:謝謝|多謝|唔該|收到|ok|okay|好的|好呀|好啊|好|明白|了解|知道|得|ok啦|㊗)[\s!！.。~～]*$/i;
const URL_RE = /https?:\/\/|www\./i;
const QUESTION_RE = /[?？]|邊個|幾點|點解|有冇人|得唔得|可唔可以|係咪|咩事|幾時/;

const W_DATE = 25;
const W_SHIFT = 25;
const W_LEAVE = 40;
const W_SITE = 15;
const W_SENDER = 10;
const W_COMBO = 10;
const P_ACK = 30;
const P_URL = 40;
const P_LONG = 30;
const P_QUESTION = 20;
const LONG_CHARS = 300;

function hasLetterOrDigit(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

function norm(s: string): string {
  return s.normalize("NFKC").trim();
}

/** 純函數：打分＋決定。 */
export function scoreMessage(input: FilterInput): FilterResult {
  const reasons: string[] = [];
  const threshold = input.threshold ?? FILTER_DEFAULT_THRESHOLD;
  const finish = (score: number): FilterResult => {
    const s = Math.max(0, Math.min(100, Math.round(score)));
    return { score: s, reasons, decision: s >= threshold ? "candidate" : "ignore" };
  };

  if (input.groupKind === null) {
    reasons.push("group_unbound");
    return { score: 0, reasons, decision: "ignore" };
  }
  if (input.groupKind === "ignored" || input.groupActive === false) {
    reasons.push("group_ignored");
    return { score: 0, reasons, decision: "ignore" };
  }

  const text = norm(input.text ?? "");
  if (text.length < 2) {
    reasons.push("too_short");
    return { score: 0, reasons, decision: "ignore" };
  }
  if (!hasLetterOrDigit(text)) {
    reasons.push("emoji_only");
    return { score: 0, reasons, decision: "ignore" };
  }

  const quoted = input.quotedText ? norm(input.quotedText) : "";
  let score = 0;

  const ownDate = DATE_RE.test(text);
  const ownLeave = LEAVE_RE.test(text);
  const ownShift = SHIFT_RE.test(text);
  const quotedDate = !ownDate && quoted !== "" && DATE_RE.test(quoted);
  const quotedLeave = !ownLeave && quoted !== "" && LEAVE_RE.test(quoted);
  const quotedShift = !ownShift && quoted !== "" && SHIFT_RE.test(quoted);

  if (ownDate) {
    score += W_DATE;
    reasons.push("date_token");
  } else if (quotedDate) {
    score += W_DATE / 2;
    reasons.push("quoted_date_token");
  }
  if (ownLeave) {
    score += W_LEAVE;
    reasons.push("leave_word");
  } else if (quotedLeave) {
    score += W_LEAVE / 2;
    reasons.push("quoted_leave_word");
  }
  if (ownShift) {
    score += W_SHIFT;
    reasons.push("shift_word");
  } else if (quotedShift) {
    score += W_SHIFT / 2;
    reasons.push("quoted_shift_word");
  }

  const haystack = `${text}\n${quoted}`.toLowerCase();
  if ((input.siteAliases ?? []).some((a) => a && norm(a).length >= 2 && haystack.includes(norm(a).toLowerCase()))) {
    score += W_SITE;
    reasons.push("site_alias");
  }
  if (input.senderKnown) {
    score += W_SENDER;
    reasons.push("sender_known");
  }

  // 「帶問句嘅指令」：日期 token＋（更別詞或請假詞）——只睇訊息自己 ＋ 被回覆文字合併後嘅組合
  const anyDate = ownDate || quotedDate;
  const anyShiftOrLeave = ownShift || ownLeave || quotedShift || quotedLeave;
  const directive = anyDate && anyShiftOrLeave && (ownDate || ownShift || ownLeave);
  if (directive) {
    score += W_COMBO;
    reasons.push("date_plus_shift_or_leave");
  }

  // 減分
  if (text.length <= 8 && ACK_RE.test(text)) {
    score -= P_ACK;
    reasons.push("ack");
  }
  if (URL_RE.test(text)) {
    score -= P_URL;
    reasons.push("link");
  }
  if (text.length > LONG_CHARS) {
    score -= P_LONG;
    reasons.push("long_forward");
  }
  if (QUESTION_RE.test(text)) {
    if (directive) {
      reasons.push("question_directive_kept"); // 問號不減分
    } else {
      score -= P_QUESTION;
      reasons.push("pure_question");
    }
  }
  return finish(score);
}
