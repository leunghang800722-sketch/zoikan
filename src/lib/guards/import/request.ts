// WP-STAFF-IMPORT B3：導入 API 共用——body 解析（錯誤訊息淨帶欄位路徑，唔帶值）＋權限。
import { z } from "zod";
import { BadRequest } from "@/lib/api/errors";
import { requirePermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import { importPackageSchema, packageHasBank, type ImportPackage, type PersonField } from "./package";
import { evaluateExt, type ExtDecision } from "./ext";
import { Forbidden } from "@/lib/api/errors";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { NON_BOSS_MAX_PERSONS } from "./limits";
import { type PersonDecisions } from "./apply";

export function parsePackage(raw: unknown): ImportPackage {
  const r = importPackageSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw BadRequest(`導入包格式唔啱（${i ? i.path.join(".") : "unknown"}：${i?.code ?? "invalid"}）`);
  }
  // WP-GUARD-OCR §29：單人包只准 1 人（獨立配額唔可以變批量導入嘅後門）
  if (r.data.source === "single_ocr" && r.data.persons.length !== 1) throw BadRequest("單人證件包只可以有 1 個人");
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
    /** WP-STAFF-FIELDS：新欄逐欄決定（key＝ext key；值 confirm／replace／skip） */
    ext: z.record(z.string().regex(/^[A-Za-z.0-9-]{1,60}$/), z.enum(["confirm", "replace", "skip"])).optional(),
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

export const previewBodySchema = z.object({ package: z.unknown(), decisions: z.record(z.string().min(1).max(64), personDecisionSchema).optional() }).strict();

const SNAKE_TO_FIELD: Record<string, PersonField> = { name_zh: "nameZh", name_en: "nameEn", date_of_birth: "dateOfBirth", phone: "phone", address: "address" };

export function mapDecisions(raw: z.infer<typeof applyBodySchema>["decisions"]): Record<string, PersonDecisions> | undefined {
  if (!raw) return undefined;
  const out: Record<string, PersonDecisions> = {};
  for (const [key, d] of Object.entries(raw)) {
    const m: PersonDecisions = {};
    for (const [k, v] of Object.entries(d)) {
      if (k === "ext") {
        if (v) m.ext = v as Record<string, ExtDecision>;
        continue;
      }
      if (v) m[SNAKE_TO_FIELD[k]!] = { action: (v as { action: "confirm" | "replace" | "skip" | "keep_pending" }).action, ...((v as { value?: string }).value ? { value: (v as { value?: string }).value } : {}) };
    }
    out[key] = m;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WP-AI-OPS 驗收修正（Major-1）：「安員個人資料」權限
// ---------------------------------------------------------------------------
export { NON_BOSS_MAX_PERSONS } from "./limits";

export function assertPackageSize(session: Pick<AuthedSession, "baseRole">, pkg: ImportPackage): void {
  if (session.baseRole !== "老闆" && pkg.persons.length > NON_BOSS_MAX_PERSONS) {
    throw BadRequest(`每個導入包最多 ${NON_BOSS_MAX_PERSONS} 人，請拆細再上載`);
  }
}

// replace 覆蓋現值嘅權限檢查（出生日期／地址：「安員個人資料:update」；姓名／英文名：「安員:update」）
// 喺 applyPerson 做：只取決於「現值係咪非空」，補空欄得；403 由 applyImport 丟出（唔取決於新值）。

export { maskPreviewForViewer, maskApplyForViewer } from "./project";

/** decisions 指向包內唔存在嘅人，或者指向一個冇值又冇帶 value 嘅欄（skip 除外）→ 400。 */
export function assertDecisionTargets(pkg: ImportPackage, decisions: Record<string, Record<string, unknown>> | undefined): void {
  if (!decisions) return;
  const byKey = new Map(pkg.persons.map((p) => [p.key, p]));
  for (const [key, d0] of Object.entries(decisions)) {
    const d = d0 as Record<string, { action: string; value?: string } | undefined>;
    const person = byKey.get(key);
    if (!person) throw BadRequest("decisions 指向導入包內唔存在嘅人");
    if (d.ext) {
      const have = new Set(evaluateExt(person, null).map((i) => i.key));
      for (const k of Object.keys(d.ext)) if (!have.has(k)) throw BadRequest("decisions 指向冇值嘅新欄");
    }
    for (const [snake, dec] of Object.entries(d)) {
      if (snake === "ext") continue;
      if (!dec || dec.action === "skip") continue;
      const f = SNAKE_TO_FIELD[snake];
      if (!f) throw BadRequest("decisions 指向唔存在嘅欄位");
      const hasValue = !!dec.value?.trim() || !!person[f].value?.trim();
      if (!hasValue) throw BadRequest("decisions 指向冇值嘅欄位");
    }
  }
}

// ---------------------------------------------------------------------------
// WP-STAFF-FIELDS：銀行欄權限。包內有任何銀行欄（person.bank 有值／unassignedBankAccounts 非空）→
// preview／apply 要求上載者有「安員銀行資料:update」，冇就 403（訊息講明；唔靜靜 strip）。
// ---------------------------------------------------------------------------
export const BANK_PACKAGE_DENIED_MSG = "導入包含銀行資料，要有「安員銀行資料」修改權限嘅同事先可以上載（銀行資料冇寫入）";
export async function assertBankPermissionForPackage(session: AuthedSession, pkg: ImportPackage): Promise<void> {
  if (packageHasBank(pkg) && !(await hasPermission(session, "安員銀行資料", "update"))) throw Forbidden(BANK_PACKAGE_DENIED_MSG);
}
