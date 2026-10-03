// WP-STAFF-IMPORT B3：導入 API 共用——body 解析（錯誤訊息淨帶欄位路徑，唔帶值）＋權限。
import { z } from "zod";
import { BadRequest } from "@/lib/api/errors";
import { requirePermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { importPackageSchema, type ImportPackage, type PersonField } from "./package";
import type { PersonDecisions } from "./apply";

export function parsePackage(raw: unknown): ImportPackage {
  const r = importPackageSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw BadRequest(`導入包格式唔啱（${i ? i.path.join(".") : "unknown"}：${i?.code ?? "invalid"}）`);
  }
  return r.data;
}

/** 老闆專屬：module「安員批量導入」硬性淨老闆（preview=view，apply=update）；其他角色（即使開晒
 * 「安員個人資料」）一律 403。 */
export async function requireImportPermission(req: Request, mode: "preview" | "apply"): Promise<AuthedSession> {
  return requirePermission(req, "安員批量導入", mode === "preview" ? "view" : "update");
}

const decisionSchema = z.object({ action: z.enum(["confirm", "replace", "skip", "keep_pending"]), value: z.string().trim().max(500).optional() }).strict();
// keep_pending（照建但標待核對）淨係准用喺 name_zh；其他欄帶 keep_pending → 400。
const decisionNoPendingSchema = decisionSchema.refine((d) => d.action !== "keep_pending", { message: "keep_pending 淨係准用喺 name_zh" });
const personDecisionSchema = z
  .object({
    name_zh: decisionSchema.optional(),
    name_en: decisionNoPendingSchema.optional(),
    date_of_birth: decisionNoPendingSchema.optional(),
    phone: decisionNoPendingSchema.optional(),
    address: decisionNoPendingSchema.optional(),
  })
  .strict();

export const applyBodySchema = z
  .object({
    package: z.unknown(),
    /** preview 回傳嘅 `package_hash`；apply 必須帶返，否則 409。 */
    package_hash: z.string().length(64),
    person_keys: z.array(z.string().min(1).max(64)).max(5000).optional(),
    decisions: z.record(z.string().min(1).max(64), personDecisionSchema).optional(),
  })
  .strict();

const SNAKE_TO_FIELD: Record<string, PersonField> = { name_zh: "nameZh", name_en: "nameEn", date_of_birth: "dateOfBirth", phone: "phone", address: "address" };

export function mapDecisions(raw: z.infer<typeof applyBodySchema>["decisions"]): Record<string, PersonDecisions> | undefined {
  if (!raw) return undefined;
  const out: Record<string, PersonDecisions> = {};
  for (const [key, d] of Object.entries(raw)) {
    const m: PersonDecisions = {};
    for (const [k, v] of Object.entries(d)) if (v) m[SNAKE_TO_FIELD[k]!] = { action: v.action, ...(v.value ? { value: v.value } : {}) };
    out[key] = m;
  }
  return out;
}
