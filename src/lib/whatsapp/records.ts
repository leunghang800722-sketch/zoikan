// W3：由 WhatsApp 寫入嘅排更記錄 ↔ 原訊息對照（待批清單、排更格 tooltip 共用；server-only）。
// 記錄經 shift_records.provenance.message_id／revision 連去 whatsapp_messages。
// 「⚠ 原訊息已被發訊人修改／撤回」＝原訊息現時 revision > 寫入時 revision，或已撤回。
// 原話／姓名只喺 canSee（「保安員:view」）時回傳。
import { prisma } from "@/lib/db";

export interface WaRecordInfo {
  record_id: string;
  message_ts: string | null;
  group_label: string | null;
  sender: string;
  text: string | null;
  text_redacted: boolean;
  source_changed: boolean;
  revoked: boolean;
}

interface RecLite {
  id: string;
  provenance: unknown;
}

export async function waRecordInfos(recs: readonly RecLite[], canSee: boolean): Promise<Map<string, WaRecordInfo>> {
  const out = new Map<string, WaRecordInfo>();
  const prov = (r: RecLite) => (r.provenance && typeof r.provenance === "object" ? (r.provenance as { message_id?: unknown; revision?: unknown }) : {});
  const mids = [...new Set(recs.map((r) => prov(r).message_id).filter((x): x is string => typeof x === "string"))];
  const msgs = mids.length
    ? await prisma.whatsappMessage.findMany({
        where: { messageId: { in: mids } },
        select: { messageId: true, chatJid: true, ts: true, text: true, redactedAt: true, revision: true, revokedAt: true, senderTelNorm: true, senderGuard: { select: { nameZh: true } } },
      })
    : [];
  const byMid = new Map(msgs.map((m) => [m.messageId, m]));
  const jids = [...new Set(msgs.map((m) => m.chatJid))];
  const groups = jids.length ? await prisma.whatsappGroup.findMany({ where: { groupJid: { in: jids } }, select: { groupJid: true, label: true } }) : [];
  const gBy = new Map(groups.map((g) => [g.groupJid, g.label]));
  for (const r of recs) {
    const p = prov(r);
    const m = typeof p.message_id === "string" ? byMid.get(p.message_id) : undefined;
    const tail = m?.senderTelNorm ? m.senderTelNorm.slice(-4) : null;
    out.set(r.id, {
      record_id: r.id,
      message_ts: m ? m.ts.toISOString() : null,
      group_label: m ? gBy.get(m.chatJid) || "（未命名）" : null,
      sender: m ? (canSee && m.senderGuard ? m.senderGuard.nameZh : tail ? `…${tail}` : "未知") : "未知",
      text: canSee && m && !m.redactedAt ? m.text : null,
      text_redacted: !!m?.redactedAt,
      source_changed: !!m && ((typeof p.revision === "number" && m.revision > p.revision) || m.revokedAt !== null),
      revoked: !!m && m.revokedAt !== null,
    });
  }
  return out;
}
