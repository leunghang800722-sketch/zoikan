// TE-1：分流題「覆核證據裁圖」（docs/plans/triage-evidence-crops-plan.md；Opus 條件 M1–M9／S1–S5）。
//  - 只存欄位裁圖（唔存成頁）；image_bytes＝AES-256-GCM 密文（key 由 SESSION_SECRET 經 HKDF，info "triage-evidence-v1"，唔加新 secret）。
//  - **bytes 白名單（M4）**：`imageBytes`／`iv`／`tag` 只喺本檔出現（insert／loadImageBytes）；其餘一律 EVIDENCE_META_SELECT。
//  - **保留不變式（M5）**：圖以 (session_id, person_key, field) 為鍵；只要仍有 open／skipped 題需要該欄，圖就存在；否則同一 tx 刪除（deleteUnneeded）。
//  - 權限（M3）：姓名／出生日期／地址／身份證號 → 「保安員個人資料:view」；電話／牌照號 → 「保安員:view」；銀行欄剔除範圍；加 restrictedKindsFor／canAccessOwnedBy。
//  - 優先順序（老闆 2026-10-18 補充，方案 §7）：每欄有優先來源（priority 1）同退而求其次（priority 2）；每欄 ≤2 張，優先排前。
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID, createHash } from "node:crypto";
import type { Prisma, TriageQuestion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canonicalHkid } from "@/lib/guards/identity";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { serverPersonKey } from "@/lib/guards/import/person-key";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import type { QuestionEvidence, ReviewField } from "./types";
import { ENC_VERSION, EVIDENCE_FIELDS, SKIPPED_RETENTION_DAYS, type DocKind, type EvidenceField, type ImageInfo } from "./evidence-format";

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------
export {
  MAX_PAGES_PER_PERSON,
  MAX_PAGE_IMAGE_BYTES,
  DOC_KINDS,
  DOC_KIND_LABEL,
  EVIDENCE_FIELDS,
  FIELD_DOC_PRIORITY,
  MAX_IMAGE_BYTES,
  MAX_PER_FIELD,
  MAX_PER_PERSON,
  RETENTION_DAYS,
  SKIPPED_RETENTION_DAYS,
  inspectImage,
  priorityOf,
  type DocKind,
  type EvidenceField,
} from "./evidence-format";

// ---------------------------------------------------------------------------
// 欄位映射
// ---------------------------------------------------------------------------
const REVIEW_TO_EVIDENCE: Record<ReviewField, EvidenceField> = { nameZh: "name_zh", nameEn: "name_en", dateOfBirth: "dob", phone: "phone", address: "address" };

/**
 * 一條題需要邊啲欄嘅證據圖（由 kind／review_fields／ext_review 推）。銀行欄剔除範圍。
 * 純函數：只睇 kind 同 evidence。
 */
export function requiredFieldsFor(q: Pick<TriageQuestion, "kind" | "evidenceJson">): EvidenceField[] {
  const ev = q.evidenceJson as unknown as QuestionEvidence | null;
  const out = new Set<EvidenceField>();
  const addExt = () => {
    for (const r of ev?.ext_review ?? []) {
      if (r.key === "siaPermit.no") out.add("permit_no");
      // TE-2：入職日期（ext key `hireDate`／`staffHire.<工號>`）
      if (r.key === "hireDate" || r.key.startsWith("staffHire.")) out.add("hire_date");
    }
  };
  // TE-3：邊個欄位有問題就只顯示嗰個欄嘅裁圖。姓名題：包內中文名有值就中文名，冇值先退到英文名
  const nameField = (): EvidenceField => (ev?.person?.nameZh?.value?.trim() ? "name_zh" : "name_en");
  // TE-3：建人類題（冇身份證號／身份證號未確認／確認身份）答呢題必須補姓名——包內冇中文名就要睇中文名圖；中英文名都冇就兩樣都要
  const addNamesIfMissing = () => {
    const zh = !!ev?.person?.nameZh?.value?.trim();
    const en = !!ev?.person?.nameEn?.value?.trim();
    if (!zh) out.add("name_zh");
    if (!zh && !en) out.add("name_en");
  };
  // TE-7：文件抽取失敗人（評級 fail，或六欄全空而且冇工號；同本機腳本 isFailedPerson 一致）＋建人／核對類題型 → 加整頁原稿（field=page；需最高權限先睇到）
  const pp = ev?.person;
  const allMissing = !!pp && ![pp.hkid, pp.nameZh, pp.nameEn, pp.dateOfBirth, pp.phone, pp.address].some((f) => !!f?.value?.trim()) && (pp.staffNumbers?.length ?? 0) === 0;
  const failedPerson = !!pp && (pp.rating === "fail" || allMissing);
  const addPage = () => {
    if (failedPerson) out.add("page");
  };
  switch (q.kind) {
    case "name_not_confirmed":
      out.add(nameField());
      break;
    case "hkid_not_confirmed":
      out.add("hkid");
      addNamesIfMissing();
      addPage();
      break;
    case "no_id_card":
      // TE-3：問題係冇身份證號，所以身份證號裁圖（TE-2 曾帶埋姓名／出生日期，老闆話唔要）；包內冇姓名先加姓名圖（要補姓名先建到人）
      out.add("hkid");
      addNamesIfMissing();
      addPage();
      break;
    case "name_only_candidate":
      out.add(nameField());
      addPage();
      break;
    case "tel_only_candidate":
    case "dup_tel_across_persons":
      out.add("phone");
      break;
    case "field_review":
      for (const r of ev?.review_fields ?? []) {
        const f = REVIEW_TO_EVIDENCE[r.field];
        if (f) out.add(f);
      }
      addPage();
      break;
    case "ext_identity_check":
      // TE-3：確認身份——身份證號（另加 ext 欄：牌照號、入職日期；包內冇姓名先加姓名圖）
      out.add("hkid");
      addNamesIfMissing();
      addExt();
      addPage();
      break;
    case "ext_field_conflict":
    case "ext_field_review":
      addExt();
      break;
    default:
      break;
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// META_SELECT（永不含 bytes）
// ---------------------------------------------------------------------------
export const EVIDENCE_META_SELECT = {
  id: true,
  sessionId: true,
  questionId: true,
  personKey: true,
  guardId: true,
  field: true,
  docKind: true,
  priority: true,
  pageNo: true,
  withdrawnAt: true,
  encVersion: true,
  width: true,
  height: true,
  mime: true,
  sha256: true,
  source: true,
  createdBy: true,
  createdAt: true,
  expiresAt: true,
} as const satisfies Prisma.TriageEvidenceImageSelect;

/** 對外 DTO（snake_case 由 ok() 轉）：只有 id／欄／來源／priority／尺寸。 */
export interface EvidenceImageView {
  id: string;
  field: EvidenceField;
  doc_kind: DocKind;
  priority: number;
  width: number;
  height: number;
  /** TE-7：整頁原稿頁碼 */
  page_no?: number | null;
}

// ---------------------------------------------------------------------------
// 加密（S1）
// ---------------------------------------------------------------------------
function encKey(): Buffer {
  const k = process.env.SESSION_SECRET;
  if (!k || k.length < 32) throw new Error("SESSION_SECRET 未設定或長度不足 32 字符");
  return Buffer.from(hkdfSync("sha256", k, Buffer.alloc(0), "triage-evidence-v1", 32));
}

/** AES-256-GCM；AAD＝圖 id（令密文唔可以搬去另一行用）。 */
export function encryptImage(plain: Uint8Array, id: string, key: Buffer = encKey()): { bytes: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(id, "utf8"));
  const bytes = Buffer.concat([c.update(plain), c.final()]);
  return { bytes, iv, tag: c.getAuthTag() };
}

export function decryptImage(enc: { bytes: Uint8Array; iv: Uint8Array; tag: Uint8Array }, id: string, key: Buffer = encKey()): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, enc.iv);
  d.setAAD(Buffer.from(id, "utf8"));
  d.setAuthTag(Buffer.from(enc.tag));
  return Buffer.concat([d.update(enc.bytes), d.final()]);
}

// ---------------------------------------------------------------------------
// 權限（M3）
// ---------------------------------------------------------------------------
const PII_FIELDS: readonly EvidenceField[] = ["hkid", "name_zh", "name_en", "dob", "address"];
const INTERNAL_ROLES = ["老闆", "主管", "會計"];

/** 讀者可以睇邊啲欄嘅證據圖（空 Set＝完全唔准）。雞頭／保安員硬性 deny。 */
export async function viewableFields(actor: AuthedSession): Promise<Set<EvidenceField>> {
  if (!INTERNAL_ROLES.includes(actor.baseRole)) return new Set();
  const [triage, pii, guard, bank] = await Promise.all([hasPermission(actor, "導入分診", "view"), hasPermission(actor, "安員個人資料", "view"), hasPermission(actor, "安員", "view"), hasPermission(actor, "安員銀行資料", "view")]);
  if (!triage) return new Set();
  // TE-7：整頁原稿可能有相片、銀行資料——要同時有「保安員個人資料:view」＋「保安員銀行資料:view」
  return new Set(EVIDENCE_FIELDS.filter((f) => (f === "page" ? pii && bank : PII_FIELDS.includes(f) ? pii : guard)));
}

export async function canViewField(actor: AuthedSession, field: EvidenceField): Promise<boolean> {
  return (await viewableFields(actor)).has(field);
}

// ---------------------------------------------------------------------------
// M5 不變式：deleteUnneeded
// ---------------------------------------------------------------------------
type Db = Prisma.TransactionClient | typeof prisma;

/** (session, personKey) 而家仍然需要嘅欄（open／skipped 題）。 */
async function neededFields(db: Db, sessionId: string, personKey: string): Promise<Set<EvidenceField>> {
  const qs = await db.triageQuestion.findMany({ where: { sessionId, personKey, status: { in: ["open", "skipped"] } }, select: { kind: true, evidenceJson: true } });
  return new Set(qs.flatMap((q) => requiredFieldsFor(q)));
}

/**
 * M5：刪走 (session, personKey) 下面已經冇 open／skipped 題需要嘅欄嘅圖（hard delete）。
 * 喺答題／supersede／job 同一 tx（或 job 自己嘅 tx）內，**喺新題（跟進題）建立之後** call。回刪咗幾多張。
 */
export async function deleteUnneeded(db: Db, sessionId: string, personKey: string | null | undefined): Promise<number> {
  if (!personKey) return 0;
  const need = await neededFields(db, sessionId, personKey);
  const r = await db.triageEvidenceImage.deleteMany({ where: { sessionId, personKey, ...(need.size ? { field: { notIn: [...need] } } : {}) } });
  return r.count;
}

/** 題被跳過：該 (session, person) 嘅圖保留，但最長只留 SKIPPED_RETENTION_DAYS（只會縮短，唔會延長）。 */
export async function shortenForSkipped(db: Db, q: Pick<TriageQuestion, "sessionId" | "personKey" | "kind" | "evidenceJson">, now: Date): Promise<void> {
  if (!q.personKey) return;
  const fields = requiredFieldsFor(q);
  if (fields.length === 0) return;
  const cap = new Date(now.getTime() + SKIPPED_RETENTION_DAYS * DAY_MS);
  await db.triageEvidenceImage.updateMany({ where: { sessionId: q.sessionId, personKey: q.personKey, field: { in: fields }, expiresAt: { gt: cap } }, data: { expiresAt: cap } });
}

// ---------------------------------------------------------------------------
// 寫入／讀 bytes（唯一碰 bytes 嘅地方）
// ---------------------------------------------------------------------------
export interface NewEvidenceImage {
  sessionId: string;
  questionId: string | null;
  personKey: string;
  guardId: string | null;
  field: EvidenceField;
  docKind: DocKind;
  priority: number;
  /** TE-7：整頁原稿頁碼 */
  pageNo?: number | null;
  plain: Uint8Array;
  info: ImageInfo;
  createdBy: string;
  expiresAt: Date;
  source?: "batch_crops" | "manual_upload";
}

export async function insertEvidenceImage(db: Db, n: NewEvidenceImage): Promise<void> {
  const id = randomUUID();
  const enc = encryptImage(n.plain, id);
  await db.triageEvidenceImage.create({
    data: {
      id,
      sessionId: n.sessionId,
      questionId: n.questionId,
      personKey: n.personKey,
      guardId: n.guardId,
      field: n.field,
      docKind: n.docKind,
      priority: n.priority,
      pageNo: n.pageNo ?? null,
      imageBytes: new Uint8Array(enc.bytes),
      iv: new Uint8Array(enc.iv),
      tag: new Uint8Array(enc.tag),
      encVersion: ENC_VERSION,
      width: n.info.width,
      height: n.info.height,
      mime: n.info.mime,
      sha256: sha256Hex(n.plain),
      source: n.source ?? "batch_crops",
      createdBy: n.createdBy,
      expiresAt: n.expiresAt,
    },
  });
}

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** 圖片 GET 專用：解密 bytes。 */
export async function loadImageBytes(id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const r = await prisma.triageEvidenceImage.findUnique({ where: { id }, select: { imageBytes: true, iv: true, tag: true, mime: true, encVersion: true, withdrawnAt: true } });
  if (!r || r.withdrawnAt || r.encVersion !== ENC_VERSION) return null;
  try {
    return { bytes: decryptImage({ bytes: r.imageBytes, iv: r.iv, tag: r.tag }, id), mime: r.mime };
  } catch {
    return null; // key 輪換／竄改：當搵唔到，唔洩露原因
  }
}

// ---------------------------------------------------------------------------
// 身份配對（同 TR-1 proposals.ts N1 一致；上載一律要 match）
// ---------------------------------------------------------------------------
export interface EvidenceMatch {
  hkid?: string | null;
  staff_numbers?: string[];
  /** TE-7：全無身份證號／工號嘅人（抽取失敗）——用包內 key 推 personKey（serverPersonKey 同一函數）；只喺 hkid、工號都冇時先採用 */
  package_key?: string | null;
  /** TE-7.2：production 現有題目嘅 person key（本機 package key 同 production 舊 package 唔同時，由 --person-key-map 對照表帶入）；只對冇身份證號／工號嘅人生效 */
  prod_person_key?: string | null;
}

const identityless = (m: EvidenceMatch): boolean => !canonicalHkid(m.hkid?.trim() || null) && (m.staff_numbers ?? []).filter((x) => x.trim()).length === 0;
/** prod_person_key 可能係題目 personKey 本身（HMAC），或者 production package 嘅原 key（要經 serverPersonKey 推）——兩樣都收 */
function prodKeyCandidates(m: EvidenceMatch): string[] {
  const pk = m.prod_person_key?.trim();
  return pk ? [pk, serverPersonKey({ key: pk, hkid: { value: null }, staffNumbers: [] })] : [];
}

/** match 推導嘅 personKey；hkid 唔合法而又冇工號＝null（唔准用包內 key 兜底）。 */
export function derivePersonKey(m: EvidenceMatch, known?: ReadonlySet<string>): string | null {
  // TE-7.2：冇身份證號／工號 + prod_person_key → 揀一個真係存在題目嘅 key（冇 known 就唔解析）
  if (identityless(m) && m.prod_person_key?.trim() && known) {
    const hit = prodKeyCandidates(m).find((k) => known.has(k));
    if (hit) return hit;
  }
  const hasHkid = !!canonicalHkid(m.hkid?.trim() || null);
  const nos = (m.staff_numbers ?? []).filter((x) => x.trim());
  if (!hasHkid && nos.length === 0) {
    const pk = m.package_key?.trim();
    return pk ? serverPersonKey({ key: pk, hkid: { value: null }, staffNumbers: [] }) : null;
  }
  return serverPersonKey({ key: "evidence-match", hkid: { value: m.hkid ?? null }, staffNumbers: nos.map((number) => ({ number })) });
}

/** 推導 key 要等於題目 personKey，而且 match 嘅身份證／工號集合要同題目 evidence.person 一致。 */
export function matchIdentityOk(q: Pick<TriageQuestion, "personKey" | "evidenceJson">, m: EvidenceMatch): boolean {
  const ep = (q.evidenceJson as unknown as QuestionEvidence | null)?.person;
  if (!ep) return false;
  // TE-7.2：prod_person_key——只對冇身份證號／工號嘅人，而且題目 evidence 身份集合為空
  if (identityless(m) && m.prod_person_key?.trim()) {
    const qk = q.personKey ?? ep.key;
    if (prodKeyCandidates(m).includes(qk) && !canonicalHkid(ep.hkid?.value ?? null) && (ep.staffNumbers ?? []).length === 0) return true;
  }
  const derived = derivePersonKey(m);
  if (!derived || derived !== (q.personKey ?? ep.key)) return false;
  if ((canonicalHkid(m.hkid ?? null) ?? null) !== (canonicalHkid(ep.hkid?.value ?? null) ?? null)) return false;
  const a = [...new Set((m.staff_numbers ?? []).map(normalizeStaffNumber))].sort().join(",");
  const b = [...new Set((ep.staffNumbers ?? []).map((n) => normalizeStaffNumber(n.number)))].sort().join(",");
  return a === b;
}

// ---------------------------------------------------------------------------
// 題目 DTO：additive `evidence_images`（唔含 bytes）
// ---------------------------------------------------------------------------
/**
 * 每條題對應嘅證據圖 meta：只回該題需要嘅欄、讀者有權睇嘅欄；讀者答唔到（restricted）嘅 kind 唔回。
 * 優先來源（priority 1）排前。
 */
export async function evidenceViewsFor(actor: AuthedSession, rows: readonly TriageQuestion[], restrictedKinds: ReadonlySet<string>): Promise<Map<string, EvidenceImageView[]>> {
  const out = new Map<string, EvidenceImageView[]>();
  const withKey = rows.filter((r) => r.personKey && (r.status === "open" || r.status === "skipped") && !restrictedKinds.has(r.kind));
  if (withKey.length === 0) return out;
  const can = await viewableFields(actor);
  if (can.size === 0) return out;
  const imgs = await prisma.triageEvidenceImage.findMany({
    where: { withdrawnAt: null, sessionId: { in: [...new Set(withKey.map((r) => r.sessionId))] }, personKey: { in: [...new Set(withKey.map((r) => r.personKey!))] } },
    select: EVIDENCE_META_SELECT,
    orderBy: [{ priority: "asc" }, { pageNo: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  if (imgs.length === 0) return out;
  for (const r of withKey) {
    const need = new Set(requiredFieldsFor(r).filter((f) => can.has(f)));
    const mine = imgs.filter((i) => i.sessionId === r.sessionId && i.personKey === r.personKey && need.has(i.field as EvidenceField));
    if (mine.length) out.set(r.id, mine.map((i) => ({ id: i.id, field: i.field as EvidenceField, doc_kind: i.docKind as DocKind, priority: i.priority, width: i.width, height: i.height, ...(i.field === "page" ? { page_no: i.pageNo } : {}) })));
  }
  return out;
}

/** TE-7：有整頁原稿但讀者冇權睇（冇「個人資料」＋「銀行資料」view）→ 每條題回頁數，題卡顯示「有 N 頁原稿，需最高權限查看」。 */
export async function hiddenPageCounts(actor: AuthedSession, rows: readonly TriageQuestion[], restrictedKinds: ReadonlySet<string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const withKey = rows.filter((r) => r.personKey && (r.status === "open" || r.status === "skipped") && !restrictedKinds.has(r.kind) && requiredFieldsFor(r).includes("page"));
  if (withKey.length === 0) return out;
  const can = await viewableFields(actor);
  if (can.has("page")) return out;
  const groups = await prisma.triageEvidenceImage.groupBy({ by: ["sessionId", "personKey"], where: { withdrawnAt: null, field: "page", sessionId: { in: [...new Set(withKey.map((r) => r.sessionId))] }, personKey: { in: [...new Set(withKey.map((r) => r.personKey!))] } }, _count: { _all: true } });
  for (const r of withKey) {
    const n = groups.find((g) => g.sessionId === r.sessionId && g.personKey === r.personKey)?._count._all ?? 0;
    if (n > 0) out.set(r.id, n);
  }
  return out;
}

/** TE-8：軟刪證據圖（錯圖撤回／取代上載）：清空 bytes（保留 sha 令重上載計 skipped_withdrawn）、記時間同原因碼。回受影響張數。 */
export async function withdrawImages(db: Db, where: Prisma.TriageEvidenceImageWhereInput, reason: string, now: Date): Promise<number> {
  const r = await db.triageEvidenceImage.updateMany({ where: { ...where, withdrawnAt: null }, data: { withdrawnAt: now, withdrawnReason: reason, imageBytes: new Uint8Array(0), iv: new Uint8Array(0), tag: new Uint8Array(0) } });
  return r.count;
}

/** TE-8 S2：恢復被「取代上載」軟刪嘅圖（同 sha 重上載）——用原 row id 重新加密寫返 bytes，清走 withdrawn 標記。 */
export async function restoreEvidenceImage(db: Db, id: string, plain: Uint8Array, info: ImageInfo, expiresAt: Date): Promise<void> {
  const enc = encryptImage(plain, id);
  await db.triageEvidenceImage.update({
    where: { id },
    data: { imageBytes: new Uint8Array(enc.bytes), iv: new Uint8Array(enc.iv), tag: new Uint8Array(enc.tag), encVersion: ENC_VERSION, width: info.width, height: info.height, mime: info.mime, withdrawnAt: null, withdrawnReason: null, expiresAt },
  });
}
