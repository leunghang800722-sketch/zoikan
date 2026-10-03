// WP-STAFF-IMPORT B3：導入 API 共用——body 解析（錯誤訊息淨帶欄位路徑，唔帶值）＋權限。
import { z } from "zod";
import { BadRequest, Forbidden } from "@/lib/api/errors";
import { requirePermission, hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
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

/** 老闆權限：module「安員」create＋「安員個人資料」（preview=view，apply=update）。 */
export async function requireImportPermission(req: Request, mode: "preview" | "apply"): Promise<AuthedSession> {
  const session = await requirePermission(req, "安員", "create");
  if (!(await hasPermission(session, "安員個人資料", mode === "preview" ? "view" : "update"))) {
    throw Forbidden(`冇「安員個人資料」${mode === "preview" ? "睇" : "改"}權限，唔可以${mode === "preview" ? "預覽" : "套用"}證件資料導入`);
  }
  return session;
}

const decisionSchema = z.object({ action: z.enum(["confirm", "replace", "skip"]), value: z.string().trim().max(500).optional() }).strict();
const personDecisionSchema = z
  .object({
    name_zh: decisionSchema.optional(),
    name_en: decisionSchema.optional(),
    date_of_birth: decisionSchema.optional(),
    phone: decisionSchema.optional(),
    address: decisionSchema.optional(),
  })
  .strict();

export const applyBodySchema = z
  .object({
    package: z.unknown(),
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
