// WP-STAFF-IMPORT B3：導入 API 共用——body 解析（錯誤訊息淨帶欄位路徑，唔帶值）＋權限。
import { z } from "zod";
import { BadRequest, Forbidden } from "@/lib/api/errors";
import { hasPermission, requirePermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { importPackageSchema, type ImportPackage, type PersonField } from "./package";
import { PII_OVERWRITE_DENIED_MSG, type ApplyResult, type PersonDecisions, type PreviewResult } from "./apply";

export function parsePackage(raw: unknown): ImportPackage {
  const r = importPackageSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw BadRequest(`導入包格式唔啱（${i ? i.path.join(".") : "unknown"}：${i?.code ?? "invalid"}）`);
  }
  return r.data;
}

/** module「安員批量導入」（preview=view，apply=update）：老闆／會計／主管（WP-AI-OPS §28.4，老闆 2026-10-04 開放）；
 * 雞頭／安員硬性 403。導入包唔入 DB、冇「批次」可以俾人睇，所以「非老闆淨係自己上載嗰批」由分診 session
 * （owner＝上載者）強制。 */
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

// ---------------------------------------------------------------------------
// WP-AI-OPS 驗收修正（Major-1）：「安員個人資料」權限
// ---------------------------------------------------------------------------
/** 非老闆每個包最多人數（防止用 hkid 批量撞名探測現有安員）。 */
export const NON_BOSS_MAX_PERSONS = 2000;

export function assertPackageSize(session: Pick<AuthedSession, "baseRole">, pkg: ImportPackage): void {
  if (session.baseRole !== "老闆" && pkg.persons.length > NON_BOSS_MAX_PERSONS) {
    throw BadRequest(`每個導入包最多 ${NON_BOSS_MAX_PERSONS} 人，請拆細再上載`);
  }
}

/** 冇「安員個人資料:update」唔准用 replace 改出生日期／地址（會覆蓋現值）。 */
export async function assertDecisionsAllowed(session: AuthedSession, decisions: z.infer<typeof applyBodySchema>["decisions"]): Promise<void> {
  if (!decisions) return;
  const needs = Object.values(decisions).some((d) => d.date_of_birth?.action === "replace" || d.address?.action === "replace");
  if (needs && !(await hasPermission(session, "安員個人資料", "update"))) throw Forbidden(PII_OVERWRITE_DENIED_MSG);
}

const PII_FIELDS: PersonField[] = ["hkid", "dateOfBirth", "phone", "address"];
const HIDDEN_CHECKS = new Set(["same", "differs", "conflict", "fill"]);

/** 冇「安員個人資料:view」：逐欄 check（反映現有 DB 值嘅比較結果）一律剝走，免得變成探測現有身份證／電話嘅 oracle。 */
export function maskPreviewForViewer(p: PreviewResult, pii: boolean): PreviewResult {
  if (pii) return p;
  return {
    ...p,
    rows: p.rows.map((r) => ({
      ...r,
      fields: Object.fromEntries(Object.entries(r.fields).map(([f, v]) => [f, PII_FIELDS.includes(f as PersonField) && HIDDEN_CHECKS.has(v.check) ? { ...v, check: "hidden" } : v])) as typeof r.fields,
    })),
  };
}

export function maskApplyForViewer(a: ApplyResult, pii: boolean): ApplyResult {
  if (pii) return a;
  return {
    ...a,
    results: a.results.map((r) => ({
      ...r,
      fields: Object.fromEntries(Object.entries(r.fields).map(([f, v]) => [f, PII_FIELDS.includes(f as PersonField) && (v === "same" || v === "conflict") ? "not_written" : v])) as typeof r.fields,
    })),
  };
}
