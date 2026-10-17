// W3：訊息被編輯／撤回後，對「已經由呢條訊息寫入嘅排更記錄」嘅後續處理（計劃書 §3.3 補充；server-only）。
//   (a) 舊記錄仍 pending_approval ＋ 當月未鎖 → 自動退回：取消該記錄（status=cancelled，audit action=void，
//       after.void_reason／reject_reason＝source_message_edited｜source_message_revoked），由新 revision 重新走正常流程重寫；
//   (b) 已確認／已批核／已結算（或當月已鎖）→ 唔自動改，只標 intents.source_changed=true（排更格／待批清單顯示「⚠ 原訊息已被發訊人修改／撤回」）。
// 取捨：簡報寫「現有 reject 路徑」，但現有 reject 係 status→draft；draft 仍佔住 (guard,date,shift) 格，
//   新 revision 重寫同一格會被當「已存在」no-op、永遠寫唔返，所以呢度改用 cancelled（可重用行），audit 保留 reject_reason。
// 一律喺呼叫者 tx 內執行，並持 TRIAGE_LOCK（同 Triage 答題寫入、自動寫入序列化）。
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isMonthLockedTx } from "@/lib/month-lock";
import { cancelShiftRecordsTx } from "@/lib/shift-records/write";
import { TRIAGE_LOCK } from "@/lib/triage/session";

type Tx = Prisma.TransactionClient;
type SourceChangeReason = "source_message_edited" | "source_message_revoked";

export interface SourceChangeResult {
  /** 自動退回（取消）嘅記錄數 */
  rejected: number;
  /** 唔自動改、只標示嘅記錄數（已確認／已批核／鎖月） */
  flagged: number;
}

/** 由呢條訊息（message_id＋revision < belowRevision）寫入嘅記錄。 */
async function recordsOfMessage(tx: Tx, messageId: string, belowRevision: number | null) {
  const rows = await tx.shiftRecord.findMany({
    where: { source: "whatsapp", provenance: { path: ["message_id"], equals: messageId } },
    select: { id: true, status: true, workDate: true, provenance: true },
  });
  return rows.filter((r) => {
    if (belowRevision === null) return true;
    const rev = (r.provenance as { revision?: unknown } | null)?.revision;
    return typeof rev === "number" && rev < belowRevision;
  });
}

async function applySourceChangeTx(tx: Tx, args: { messageId: string; belowRevision: number | null; reason: SourceChangeReason; actorUserId: string; ip?: string | null }): Promise<SourceChangeResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
  const recs = await recordsOfMessage(tx, args.messageId, args.belowRevision);
  if (recs.length === 0) return { rejected: 0, flagged: 0 };
  // 鎖行再睇狀態（防同時被人批核）
  const ids = recs.map((r) => r.id);
  await tx.$queryRaw`SELECT id FROM shift_records WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  const fresh = await tx.shiftRecord.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, workDate: true } });
  const toReject: string[] = [];
  const flaggedIds: string[] = [];
  for (const r of fresh) {
    if (r.status === "cancelled") continue; // 已經冇效，唔使處理
    if (r.status === "pending_approval" && !(await isMonthLockedTx(tx, r.workDate))) toReject.push(r.id);
    else flaggedIds.push(r.id);
  }
  let rejected = 0;
  if (toReject.length > 0) {
    rejected = await cancelShiftRecordsTx(tx, { ids: toReject, actorUserId: args.actorUserId, ip: args.ip ?? null, reason: args.reason });
  }
  // intents 標記：被退回／被標示嘅記錄所屬 intent 記低後續結果（resolution.auto_write.followup）；source_changed 一律 true
  const touched = [...toReject, ...flaggedIds];
  if (touched.length > 0) {
    const intents = await tx.whatsappIntent.findMany({ where: { messageId: args.messageId, resultRef: { in: touched } }, select: { id: true, resultRef: true, resolution: true } });
    for (const it of intents) {
      const res = (it.resolution && typeof it.resolution === "object" && !Array.isArray(it.resolution) ? { ...(it.resolution as Record<string, unknown>) } : {}) as Record<string, unknown>;
      const aw = (res.auto_write && typeof res.auto_write === "object" ? { ...(res.auto_write as Record<string, unknown>) } : {}) as Record<string, unknown>;
      aw.followup = toReject.includes(it.resultRef!) ? (args.reason === "source_message_edited" ? "rejected_edited" : "rejected_revoked") : "flagged";
      res.auto_write = aw;
      await tx.whatsappIntent.update({ where: { id: it.id }, data: { sourceChanged: true, resolution: res as Prisma.InputJsonValue } });
    }
  }
  return { rejected, flagged: flaggedIds.length };
}

/** 新 revision（>1）開始處理前：舊 revision 寫過嘅記錄 pending → 退回；其餘標示。自己開 tx。 */
export async function followUpEditedMessage(messageId: string, revision: number, actorUserId: string): Promise<SourceChangeResult> {
  if (revision <= 1) return { rejected: 0, flagged: 0 };
  return prisma.$transaction((tx) => applySourceChangeTx(tx, { messageId, belowRevision: revision, reason: "source_message_edited", actorUserId }));
}

/**
 * job 每個 tick：已撤回訊息仍有 pending_approval 記錄 → 退回；已確認嘅標示（intents.source_changed 由 webhook 已標，呢度補 followup）。
 * 冪等：退回後記錄已 cancelled，下個 tick 不再命中。回退回數。
 */
export async function followUpRevokedWrites(actorUserId: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ message_id: string }[]>`
    SELECT DISTINCT provenance->>'message_id' AS message_id FROM shift_records
    WHERE source = 'whatsapp' AND status = 'pending_approval' AND provenance->>'message_id' IN (SELECT message_id FROM whatsapp_messages WHERE revoked_at IS NOT NULL)`;
  let n = 0;
  for (const r of rows) {
    if (!r.message_id) continue;
    const res = await prisma.$transaction((tx) => applySourceChangeTx(tx, { messageId: r.message_id, belowRevision: null, reason: "source_message_revoked", actorUserId }));
    n += res.rejected;
  }
  return n;
}
