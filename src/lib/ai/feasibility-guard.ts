// P2.5「現場反映」開會模式——訪談員（`feedback-prompt.ts`）**唔評可行性**
// 嘅三層防線入面嘅第二層（第一層係 system prompt 明文禁止，第三層係
// 摘要範本冇可行性欄，見 `feedback-prompt.ts`／`src/lib/feedback/report.ts`
// 頂註解）。
//
// 呢度同 `output-guard.ts`（DML/DDL／指示性文字）獨立、唔互相削弱——
// `session/chat/route.ts` 兩個都行，順序：先行現有嘅
// `checkOutputGuardAndAudit()`（安全底線），先至行呢個（產品規則：訪談
// 員唔評可行性）。
//
// 設計：`checkFeasibilityGuard()` 掃嘅係「訪談員自己判斷可行性」嘅
// 肯定/否定句式（「可以做到」「做唔到」「技術上可行」「我會幫你改」
// 「系統會加」「冇問題可以加」呢類），撞到就成段換做標準句——**唔係**
// 齋齋出現「可行性」三隻字就觸發（標準句本身、用戶問「呢個做唔做到」
// 都會出現「可行」/「做唔做」字眼，唔可以連標準句自己都誤殺）。
import { writeAudit } from "../audit";

export const FEASIBILITY_STANDARD_REPLY = "可行性由 Eric 同技術團隊評估，我淨係幫你整理清楚訴求。";

// 逐條都要求「訪談員自己落判斷」嘅語感（肯定句／承諾句），唔係用戶單純
// 提出問題嗰種句式（「做唔做得到」本身唔觸發——嗰係*問題*唔係*答案*，
// 訪談員答返標準句先至觸發唔到，形成一個穩定嘅 fixed point）。
const FEASIBILITY_PATTERNS: RegExp[] = [
  /可以做到/,
  /做(得到|唔到)/,
  /技術上(可行|冇問題|做得到)/,
  /我會(幫你|即刻)?(改|整|加|處理)/,
  /系統會(加|改|整)/,
  /冇問題[,，]?可以加/,
  /(可行性|技術上)(高|低|冇問題)/,
  /應該(可以|做得到|冇問題)(改|整|加)?/,
  /呢(個|樣)(可以|應該可以)(改|整|加)/,
  /(容易|唔難|簡單)(改|整|加|做到)/,
  /幫你(加返|改返|整返)/,
  /技術上(唔|不)可行/,

  // Opus 驗收應修②——補漏網句四大類：英文、口語肯定、否定判斷、工期／
  // 版本承諾。每句都要求「訪談員自己落判斷／承諾」嘅語感，唔係單純
  // 提出問題嗰種句式（同上面原有 12 條一致嘅設計原則，見檔案頂註解）。

  // 英文——訪談員（罕見情況下）用英文答可行性判斷。
  /\bnot\s+feasible\b/i,
  /\bfeasible\b/i,
  /\bwe\s+can\s+add\b/i,
  /\bcan'?t\s+be\s+done\b/i,
  /\beasy\s+to\s+add\b/i,

  // 口語肯定——廣東話口語化嘅「得／易」判斷。
  /得㗎/,
  /一定得/,
  /搞得掂/,
  /好易啫/,
  /加個掣就得/,
  /easy\s*啦/i,
  /冇問題.{0,10}(加|做|會有)/, // 「冇問題」獨立唔觸發，要配合「加/做/會有」先算落咗判斷

  // 否定判斷——廣東話／中英夾雜嘅「做唔到」變體。
  /支援唔到/,
  /實現唔到/,
  /唔\s*work\b/i,
  /唔\s*support\b/i,
  /架構唔支援/,

  // 工期／版本承諾——訪談員承諾幾耐內會做完，或者話已經排咗落版本。
  /(?:\d+|[一二兩三四五六七八九十]+)(?:個?(?:日|星期)|個月).{0,12}(?:做好|做完|完成|上線|搞掂)/,
  /下(一)?個版本(會|就)?有/,
  /交俾我/,
];

export interface FeasibilityGuardResult {
  triggered: boolean;
  text: string;
}

/** 淨係偵測+換字，唔寫 audit——單元測試同 route.ts 分開用。 */
export function checkFeasibilityGuard(text: string): FeasibilityGuardResult {
  for (const pattern of FEASIBILITY_PATTERNS) {
    if (pattern.test(text)) {
      return { triggered: true, text: FEASIBILITY_STANDARD_REPLY };
    }
  }
  return { triggered: false, text };
}

export async function checkFeasibilityGuardAndAudit(params: {
  text: string;
  actorUserId: string;
  sessionId: string;
  ip: string | null;
}): Promise<FeasibilityGuardResult> {
  const result = checkFeasibilityGuard(params.text);
  if (result.triggered) {
    await writeAudit({
      actorUserId: params.actorUserId,
      tableName: "ai_feedback_chat",
      rowId: params.sessionId,
      action: "ai_feasibility_guard_triggered",
      after: { reason: "feasibility_language" },
      ip: params.ip,
    });
  }
  return result;
}
