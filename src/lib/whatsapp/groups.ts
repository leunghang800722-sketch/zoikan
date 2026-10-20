// W0：whatsapp_groups 嘅 DTO／輸入驗證／WAHA 同步（server-only）。
// shift_word_map 對外一律係 [{word, code}] 陣列（唔係物件）——因為 API 回應會做 camel→snake 轉 key，
// 物件 key（例如 "OT"）會被轉成 "_o_t"；陣列值唔受影響。DB 內仍存物件 { 口語: 更碼 }。
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit, writeAuditTx } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { listGroups, type WahaResult } from "./waha";
import type { WordPair } from "./dto";

const GROUP_KINDS = ["site", "multi_site", "broker", "office", "ignored"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

const PairSchema = z.object({ word: z.string().trim().min(1).max(20), code: z.string().trim().min(1).max(12) });

/** W5：群組可覆寫嘅請假碼（內建對照見 resolve.ts LEAVE_TABLE）。 */
export const LEAVE_OVERRIDE_CODES = ["SL", "AL", "NL", "RD", "SH"] as const;
const LeavePairSchema = z.object({ word: z.string().trim().min(2, "口語詞最少 2 個字").max(20), code: z.enum(LEAVE_OVERRIDE_CODES) });

export const GroupPatchSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().max(200).optional(),
  kind: z.enum(GROUP_KINDS).optional(),
  site_id: z.string().min(1).max(64).nullable().optional(),
  broker_id: z.string().min(1).max(64).nullable().optional(),
  shift_word_map: z.array(PairSchema).max(30).optional(),
  leave_word_map: z.array(LeavePairSchema).max(30).optional(),
  auto_write: z.boolean().optional(),
  auto_confirm: z.boolean().optional(),
  active: z.boolean().optional(),
  /** W3：每群每日自動寫入上限（0–1000；0＝全部改 Triage）。 */
  auto_write_daily_cap: z.number().int().min(0).max(1000).optional(),
  /** W1：第 0 層過濾閾值（0–100）；null＝用預設 40。 */
  filter_threshold: z.number().int().min(0).max(100).nullable().optional(),
});

/** minLen：更碼對照 1（LLM 嘅 shift_raw 多數單字，如「早／夜」）；請假詞 2（單字太易誤中，包含式匹配）。 */
export function pairsToWordMap(pairs: WordPair[], minLen = 1): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    // W5：詞先 NFKC 正規化（resolve 配對用 NFKC），全形／半形算重覆
    const word = p.word.normalize("NFKC").trim();
    if (word.length < minLen) throw BadRequest(minLen > 1 ? `口語詞最少 ${minLen} 個字` : "口語詞唔可以留空");
    if (Object.prototype.hasOwnProperty.call(out, word)) throw BadRequest(`口語對照重覆：「${word}」`);
    out[word] = p.code;
  }
  return out;
}

/** 合併 PATCH 之後嘅一致性檢查（保守）：site 群要綁盤、判頭群要綁判頭；ignored／office 唔准開自動；auto_confirm 要 auto_write。 */
export function assertGroupConsistent(next: { kind: GroupKind; siteId: string | null; brokerId: string | null; autoWrite: boolean; autoConfirm: boolean }): void {
  if (next.kind === "site" && !next.siteId) throw BadRequest("單盤群要綁定盤口");
  if (next.kind === "broker" && !next.brokerId) throw BadRequest("判頭群要綁定判頭");
  if ((next.kind === "ignored" || next.kind === "office") && (next.autoWrite || next.autoConfirm)) throw BadRequest("「略過」或「辦公室」群唔可以開自動寫入／自動確認");
  if (next.autoConfirm && !next.autoWrite) throw BadRequest("自動確認要先開自動寫入");
}

interface SyncSummary {
  total: number;
  created: number;
  relabelled: number;
  /** WA-6：由已收訊息（chat_jid 以 @g.us 結尾而 whatsapp_groups 冇）補咗幾個群 */
  from_messages: number;
}

type WahaSyncError = Extract<WahaResult<never>, { ok: false }>["error"];
/** WA-6：WAHA 唔可達／回錯時照樣由訊息補群，回 ok＋waha_error（錯誤碼，唔含 URL／key）。 */
interface WahaSyncFailure {
  kind: WahaSyncError;
  status?: number;
  /** 分類碼：waha_timeout／waha_http_error／waha_bad_response／waha_unavailable／waha_not_configured */
  code: string;
  /** 人話（唔含 URL／key） */
  message: string;
}
export type SyncResult = { ok: true; summary: SyncSummary; waha_error?: WahaSyncFailure };

/** WA-6：WAHA 失敗分類（真正原因唔再壓成「連唔到 WAHA」）。 */
function classifyWahaFailure(kind: WahaSyncError, status?: number): WahaSyncFailure {
  const base = status !== undefined ? { status } : {};
  switch (kind) {
    case "timeout":
      return { kind, ...base, code: "waha_timeout", message: "WAHA 回應超時（群組太多或 WAHA 忙），請稍後再試" };
    case "http_error":
      return { kind, ...base, code: "waha_http_error", message: `WAHA 回應 HTTP ${status ?? "?"}` };
    case "bad_response":
      return { kind, ...base, code: "waha_bad_response", message: "WAHA 回應格式唔識讀" };
    case "not_configured":
      return { kind, ...base, code: "waha_not_configured", message: "WAHA 未設定（WAHA_BASE_URL）" };
    default:
      return { kind, ...base, code: "waha_unavailable", message: "連唔到 WAHA" };
  }
}

const UNNAMED_GROUP_PREFIX = "未命名群組";
/** 由訊息補群嘅預設群名：「未命名群組（尾 6 位 jid）」。 */
function unnamedGroupLabel(jid: string): string {
  const bare = jid.replace(/@g\.us$/, "");
  return `${UNNAMED_GROUP_PREFIX}（${bare.slice(-6)}）`;
}

/**
 * 由 WAHA 同步群組：新群 kind=ignored（自動寫入全關）；已存在嘅群只更新群名（label，labelLocked=false 先改），唔改綁定。
 * WA-6：WAHA 列表之後，再由 whatsapp_messages 補群（NOWEB 冇 store 時 /groups 回空）：distinct chatJid 以 @g.us 結尾而 whatsapp_groups 冇 →
 * createMany（kind ignored、label「未命名群組（尾 6 位）」、labelLocked=false），下次 WAHA 列表有名就會自動改名。WAHA 錯誤唔令 sync 失敗。
 */
export async function syncGroupsFromWaha(actorUserId: string, ip: string | null, fetchImpl: typeof fetch = fetch): Promise<SyncResult> {
  const r = await listGroups(fetchImpl);
  const found = r.ok ? r.data : [];
  const summary: SyncSummary = { total: found.length, created: 0, relabelled: 0, from_messages: 0 };
  await prisma.$transaction(async (tx) => {
    const existing = await tx.whatsappGroup.findMany({ where: { groupJid: { in: found.map((g) => g.jid) } }, select: { id: true, groupJid: true, label: true, labelLocked: true } });
    const byJid = new Map(existing.map((e) => [e.groupJid, e]));
    for (const g of found) {
      const cur = byJid.get(g.jid);
      if (!cur) {
        const res = await tx.whatsappGroup.createMany({ data: [{ groupJid: g.jid, label: g.name, kind: "ignored", createdBy: actorUserId }], skipDuplicates: true });
        summary.created += res.count;
      } else if (g.name && g.name !== cur.label && !cur.labelLocked) {
        await tx.whatsappGroup.update({ where: { id: cur.id }, data: { label: g.name } });
        summary.relabelled++;
      }
    }
    const msgJids = await tx.whatsappMessage.findMany({ where: { chatJid: { endsWith: "@g.us" } }, distinct: ["chatJid"], select: { chatJid: true } });
    if (msgJids.length) {
      const have = new Set((await tx.whatsappGroup.findMany({ where: { groupJid: { in: msgJids.map((m) => m.chatJid) } }, select: { groupJid: true } })).map((g) => g.groupJid));
      const missing = msgJids.map((m) => m.chatJid).filter((j) => !have.has(j));
      if (missing.length) {
        const res = await tx.whatsappGroup.createMany({ data: missing.map((jid) => ({ groupJid: jid, label: unnamedGroupLabel(jid), labelLocked: false, kind: "ignored" as const, createdBy: actorUserId })), skipDuplicates: true });
        summary.from_messages = res.count;
      }
    }
    await writeAuditTx(tx as Prisma.TransactionClient, { actorUserId, tableName: "whatsapp_groups", rowId: "sync", action: "whatsapp_group_sync", after: summary, ip });
  });
  if (r.ok) return { ok: true, summary };
  // 失敗：一行 log（唔 log URL／key／內容）＋audit（after 只有 kind／status）；已經由訊息補群，仍回 ok
  console.warn(`[whatsapp] group sync failed kind=${r.error} status=${r.status ?? "-"}`);
  await writeAudit({ actorUserId, tableName: "whatsapp_groups", rowId: "sync", action: "whatsapp_group_sync_failed", after: { kind: r.error, ...(r.status !== undefined ? { status: r.status } : {}) }, ip });
  return { ok: true, summary, waha_error: classifyWahaFailure(r.error, r.status) };
}
