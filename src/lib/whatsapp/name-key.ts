// WA-9 (8)：「(群, 日, 名)」固定 groupKey——名單路徑同短訊（LLM）路徑共用同一把 key，
// 同一人同一日唔會因為來源唔同而開兩張揀人題。純函數，唔入 DB。
import { createHash } from "node:crypto";
import { normNameVariant } from "@/lib/names/variants";

export const rosterNameKey = (groupId: string, date: string, name: string): string => `rn:${groupId}:${date}:${createHash("sha1").update(normNameVariant(name)).digest("hex").slice(0, 12)}`;
