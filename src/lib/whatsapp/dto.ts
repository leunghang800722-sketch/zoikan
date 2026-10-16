// W0：whatsapp_groups 對外／審計共用 DTO（純函數，只有 type import——audit-dto 引用，避免循環依賴）。
// shift_word_map 對外一律係 [{word, code}] 陣列（唔係物件）——API 回應會做 camel→snake 轉 key，
// 物件 key（例如 "OT"）會被轉成 "_o_t"；陣列值唔受影響。DB 內仍存物件 { 口語: 更碼 }。
import type { WhatsappGroup } from "@prisma/client";
import { brandSafeResponse, type Dto } from "@/lib/api/serialize";

export interface WordPair {
  word: string;
  code: string;
}

function wordMapToPairs(v: unknown): WordPair[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.entries(v as Record<string, unknown>)
    .filter(([, c]) => typeof c === "string")
    .map(([word, code]) => ({ word, code: code as string }));
}

/** 審計／API 共用嘅群組 DTO（白名單；全部非 PII：群 jid 係群 id 唔係個人電話）。 */
export function toWaGroupDTO(row: Record<string, unknown>): Dto {
  const g = row as unknown as WhatsappGroup;
  return brandSafeResponse({
    id: g.id,
    group_jid: g.groupJid,
    label: g.label,
    kind: g.kind,
    site_id: g.siteId,
    broker_id: g.brokerId,
    shift_word_map: wordMapToPairs(g.shiftWordMap),
    auto_write: g.autoWrite,
    auto_confirm: g.autoConfirm,
    active: g.active,
    last_message_at: g.lastMessageAt ? g.lastMessageAt.toISOString() : null,
    created_by: g.createdBy,
    created_at: g.createdAt instanceof Date ? g.createdAt.toISOString() : g.createdAt,
    updated_at: g.updatedAt instanceof Date ? g.updatedAt.toISOString() : g.updatedAt,
  });
}

