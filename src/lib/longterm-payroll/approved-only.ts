// W4：WhatsApp 寫入（source="whatsapp"）嘅記錄仍係 pending_approval＝未經人批核，唔計入長工糧／病假草稿／勤工獎資格；
// 批核（status 變 confirmed 等）之後先計。其他來源嘅 pending_approval 行為不變（唔受影響）。
// Prisma where 片段（可直接 spread 入 shiftRecord.findMany 嘅 where；呼叫處原本冇 OR）。
import type { Prisma } from "@prisma/client";

export function excludeUnapprovedWhatsapp(): Pick<Prisma.ShiftRecordWhereInput, "OR"> {
  return { OR: [{ source: null }, { source: { not: "whatsapp" } }, { status: { not: "pending_approval" } }] };
}
