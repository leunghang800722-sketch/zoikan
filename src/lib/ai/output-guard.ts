// WP-AI1：輸出過濾——最終回覆入面如果混入 DML/DDL 語句樣式、
// prisma./npm run db:/migrate、或者「以下步驟可以改…」類指示性文字，
// 成段換做標準回覆，並記一條 audit_log（action=ai_guard_triggered）。
// 呢個係最後一道防線（system prompt 已經明文禁止，呢度係唔信任模型
// 一定跟得到、用 code 再擋一次）。
import { writeAudit } from "../audit";
import { STANDARD_REDIRECT_REPLY } from "./system-prompt";

const DML_DDL_PATTERN =
  /\b(UPDATE\s+\w|INSERT\s+INTO|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE\s+TABLE|CREATE\s+TABLE|GRANT\s+\w|REVOKE\s+\w)\b/i;

const LITERAL_MARKERS = ["prisma.", "npm run db:", "npx prisma migrate", "migrate deploy", "migrate dev", "$executeRaw", "$transaction"];

// 「跟住做就可以改到數據」風格嘅指示性文字——粗略關鍵詞＋pattern，寧枉勿縱。
const INSTRUCTIONAL_KEYWORDS = [
  "以下步驟",
  "跟住以下",
  "跟以下指示",
  "跟住咁做",
  "手動執行",
  "手動跑",
  "教你點改",
  "咁樣就可以改",
  "執行以下",
  "step by step 教你改",
  "curl -X",
];
const INSTRUCTIONAL_PATTERN = /步驟[\s\S]{0,15}(可以|去|就能?)[\s\S]{0,15}改/;

export interface OutputGuardResult {
  triggered: boolean;
  reason?: string;
  text: string;
}

export function checkOutputGuard(text: string): OutputGuardResult {
  if (DML_DDL_PATTERN.test(text)) {
    return { triggered: true, reason: "dml_ddl_pattern", text: STANDARD_REDIRECT_REPLY };
  }
  for (const marker of LITERAL_MARKERS) {
    if (text.toLowerCase().includes(marker.toLowerCase())) {
      return { triggered: true, reason: `literal_marker:${marker}`, text: STANDARD_REDIRECT_REPLY };
    }
  }
  for (const kw of INSTRUCTIONAL_KEYWORDS) {
    if (text.includes(kw)) {
      return { triggered: true, reason: `instructional_keyword:${kw}`, text: STANDARD_REDIRECT_REPLY };
    }
  }
  if (INSTRUCTIONAL_PATTERN.test(text)) {
    return { triggered: true, reason: "instructional_pattern", text: STANDARD_REDIRECT_REPLY };
  }
  return { triggered: false, text };
}

export async function checkOutputGuardAndAudit(params: {
  text: string;
  actorUserId: string;
  ip: string | null;
}): Promise<OutputGuardResult> {
  const result = checkOutputGuard(params.text);
  if (result.triggered) {
    await writeAudit({
      actorUserId: params.actorUserId,
      tableName: "ai_chat",
      rowId: params.actorUserId,
      action: "ai_guard_triggered",
      after: { reason: result.reason },
      ip: params.ip,
    });
  }
  return result;
}
