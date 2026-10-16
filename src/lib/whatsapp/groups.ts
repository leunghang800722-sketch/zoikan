// W0：whatsapp_groups 嘅 DTO／輸入驗證／WAHA 同步（server-only）。
// shift_word_map 對外一律係 [{word, code}] 陣列（唔係物件）——因為 API 回應會做 camel→snake 轉 key，
// 物件 key（例如 "OT"）會被轉成 "_o_t"；陣列值唔受影響。DB 內仍存物件 { 口語: 更碼 }。
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { listGroups, type WahaResult } from "./waha";
import type { WordPair } from "./dto";

const GROUP_KINDS = ["site", "multi_site", "broker", "office", "ignored"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

const PairSchema = z.object({ word: z.string().trim().min(1).max(20), code: z.string().trim().min(1).max(12) });

export const GroupPatchSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().max(200).optional(),
  kind: z.enum(GROUP_KINDS).optional(),
  site_id: z.string().min(1).max(64).nullable().optional(),
  broker_id: z.string().min(1).max(64).nullable().optional(),
  shift_word_map: z.array(PairSchema).max(30).optional(),
  auto_write: z.boolean().optional(),
  auto_confirm: z.boolean().optional(),
  active: z.boolean().optional(),
});

export function pairsToWordMap(pairs: WordPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    if (Object.prototype.hasOwnProperty.call(out, p.word)) throw BadRequest(`口語對照重覆：「${p.word}」`);
    out[p.word] = p.code;
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
}

export type SyncResult = { ok: true; summary: SyncSummary } | { ok: false; error: Extract<WahaResult<never>, { ok: false }>["error"]; status?: number };

/** 由 WAHA 同步群組：新群 kind=ignored（自動寫入全關）；已存在嘅群只更新群名（label），唔改綁定。 */
export async function syncGroupsFromWaha(actorUserId: string, ip: string | null, fetchImpl: typeof fetch = fetch): Promise<SyncResult> {
  const r = await listGroups(fetchImpl);
  if (!r.ok) return { ok: false, error: r.error, ...(r.status !== undefined ? { status: r.status } : {}) };
  const found = r.data;
  const summary: SyncSummary = { total: found.length, created: 0, relabelled: 0 };
  await prisma.$transaction(async (tx) => {
    const existing = await tx.whatsappGroup.findMany({ where: { groupJid: { in: found.map((g) => g.jid) } }, select: { id: true, groupJid: true, label: true } });
    const byJid = new Map(existing.map((e) => [e.groupJid, e]));
    for (const g of found) {
      const cur = byJid.get(g.jid);
      if (!cur) {
        const res = await tx.whatsappGroup.createMany({ data: [{ groupJid: g.jid, label: g.name, kind: "ignored", createdBy: actorUserId }], skipDuplicates: true });
        summary.created += res.count;
      } else if (g.name && g.name !== cur.label) {
        await tx.whatsappGroup.update({ where: { id: cur.id }, data: { label: g.name } });
        summary.relabelled++;
      }
    }
    await writeAuditTx(tx as Prisma.TransactionClient, { actorUserId, tableName: "whatsapp_groups", rowId: "sync", action: "whatsapp_group_sync", after: summary, ip });
  });
  return { ok: true, summary };
}
