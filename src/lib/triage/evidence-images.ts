// TE-1：分流題「覆核證據裁圖」（docs/plans/triage-evidence-crops-plan.md；Opus 條件 M1–M9／S1–S5）。
//  - 只存欄位裁圖（唔存成頁）；image_bytes＝AES-256-GCM 密文（key 由 SESSION_SECRET 經 HKDF，info "triage-evidence-v1"，唔加新 secret）。
//  - **bytes 白名單（M4）**：`imageBytes`／`iv`／`tag` 只喺本檔出現（insert／loadImageBytes）；其餘一律 EVIDENCE_META_SELECT。
//  - **保留不變式（M5）**：圖以 (session_id, person_key, field) 為鍵；只要仍有 open／skipped 題需要該欄，圖就存在；否則同一 tx 刪除（deleteUnneeded）。
//  - 權限（M3）：姓名／出生日期／地址／身份證號 → 「安員個人資料:view」；電話／牌照號 → 「安員:view」；銀行欄剔除範圍；加 restrictedKindsFor／canAccessOwnedBy。
//  - 優先順序（老闆 2026-10-18 補充，方案 §7）：每欄有優先來源（priority 1）同退而求其次（priority 2）；每欄 ≤2 張，優先排前。
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID, createHash } from "node:crypto";
import type { Prisma, TriageQuestion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canonicalHkid } from "@/lib/guards/identity";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { serverPersonKey } from "@/lib/guards/import/person-key";
import { hasPermission, type AuthedSession } from "@/lib/rbac/requirePermission";
import type { QuestionEvidence, ReviewField } from "./types";

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------
export const EVIDENCE_FIELDS = ["hkid", "name_zh", "name_en", "dob", "phone", "address", "permit_no"] as const;
export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];
export const DOC_KINDS = ["id_card", "onboarding_form", "address_proof", "sia_permit"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** 每欄來源優先順序（方案 §7）：index 0＝優先來源（priority 1），index 1＝退而求其次（priority 2）。 */
export const FIELD_DOC_PRIORITY: Record<EvidenceField, readonly DocKind[]> = {
  hkid: ["id_card", "onboarding_form"],
  name_zh: ["id_card", "onboarding_form"],
  name_en: ["id_card", "onboarding_form"],
  dob: ["id_card", "onboarding_form"],
  address: ["address_proof", "onboarding_form"],
  phone: ["onboarding_form"],
  permit_no: ["sia_permit", "onboarding_form"],
};
/** doc_kind 喺該欄嘅 priority（1／2）；唔屬該欄允許來源＝null。 */
export function priorityOf(field: EvidenceField, doc: DocKind): 1 | 2 | null {
  const i = FIELD_DOC_PRIORITY[field].indexOf(doc);
  return i === 0 ? 1 : i === 1 ? 2 : null;
}
export const DOC_KIND_LABEL: Record<DocKind, string> = { id_card: "身份證副本", address_proof: "住址證明", onboarding_form: "入職表手寫", sia_permit: "牌照卡副本" };

export const MAX_IMAGE_BYTES = 120 * 1024;
export const MAX_PER_FIELD = 2;
export const MAX_PER_PERSON = 12;
export const RETENTION_DAYS = 180;
export const SKIPPED_RETENTION_DAYS = 30;
export const ENC_VERSION = 1;
const DAY_MS = 86_400_000;

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
  switch (q.kind) {
    case "name_not_confirmed":
      out.add("name_zh");
      break;
    case "hkid_not_confirmed":
    case "no_id_card":
      out.add("hkid");
      break;
    case "field_review":
      for (const r of ev?.review_fields ?? []) {
        const f = REVIEW_TO_EVIDENCE[r.field];
        if (f) out.add(f);
      }
      break;
    case "ext_identity_check":
    case "ext_field_conflict":
    case "ext_field_review":
      for (const r of ev?.ext_review ?? []) if (r.key === "siaPermit.no") out.add("permit_no");
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
export type EvidenceMeta = Prisma.TriageEvidenceImageGetPayload<{ select: typeof EVIDENCE_META_SELECT }>;

/** 對外 DTO（snake_case 由 ok() 轉）：只有 id／欄／來源／priority／尺寸。 */
export interface EvidenceImageView {
  id: string;
  field: EvidenceField;
  doc_kind: DocKind;
  priority: number;
  width: number;
  height: number;
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
// 圖片 header 驗證（S4）：magic bytes、尺寸、剝走 EXIF／APPn／文字 chunk
// ---------------------------------------------------------------------------
export interface ImageInfo {
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
}

/** 回 null＝唔合格（唔係 JPEG／PNG、太大、仲有 EXIF／APPn／comment／文字 chunk、讀唔到尺寸）。 */
export function inspectImage(buf: Uint8Array): ImageInfo | null {
  if (buf.length < 16 || buf.length > MAX_IMAGE_BYTES) return null;
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return inspectJpeg(b);
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return inspectPng(b);
  return null;
}

function inspectJpeg(b: Buffer): ImageInfo | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    if (m === 0xd9) return null; // EOI 先於 SOF
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    // APP1–APP15（EXIF／XMP／ICC／Adobe…）同 COM 一律唔收；APP0（JFIF）准
    if ((m >= 0xe1 && m <= 0xef) || m === 0xfe) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (len < 8) return null;
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width > 0 && height > 0 && width <= 4000 && height <= 4000 ? { mime: "image/jpeg", width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

function inspectPng(b: Buffer): ImageInfo | null {
  let i = 8;
  let dims: { width: number; height: number } | null = null;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString("latin1", i + 4, i + 8);
    if (len > b.length) return null;
    if (type === "IHDR") {
      if (len !== 13) return null;
      dims = { width: b.readUInt32BE(i + 8), height: b.readUInt32BE(i + 12) };
    } else if (type === "eXIf" || type === "tEXt" || type === "iTXt" || type === "zTXt" || type === "iCCP") return null;
    else if (type === "IEND") break;
    i += 12 + len;
  }
  return dims && dims.width > 0 && dims.height > 0 && dims.width <= 4000 && dims.height <= 4000 ? { mime: "image/png", ...dims } : null;
}

// ---------------------------------------------------------------------------
// 權限（M3）
// ---------------------------------------------------------------------------
const PII_FIELDS: readonly EvidenceField[] = ["hkid", "name_zh", "name_en", "dob", "address"];
const INTERNAL_ROLES = ["老闆", "主管", "會計"];

/** 讀者可以睇邊啲欄嘅證據圖（空 Set＝完全唔准）。雞頭／安員硬性 deny。 */
export async function viewableFields(actor: AuthedSession): Promise<Set<EvidenceField>> {
  if (!INTERNAL_ROLES.includes(actor.baseRole)) return new Set();
  const [triage, pii, guard] = await Promise.all([hasPermission(actor, "導入分診", "view"), hasPermission(actor, "安員個人資料", "view"), hasPermission(actor, "安員", "view")]);
  if (!triage) return new Set();
  return new Set(EVIDENCE_FIELDS.filter((f) => (PII_FIELDS.includes(f) ? pii : guard)));
}

export async function canViewField(actor: AuthedSession, field: EvidenceField): Promise<boolean> {
  return (await viewableFields(actor)).has(field);
}

// ---------------------------------------------------------------------------
// M5 不變式：deleteUnneeded
// ---------------------------------------------------------------------------
type Db = Prisma.TransactionClient | typeof prisma;

/** (session, personKey) 而家仍然需要嘅欄（open／skipped 題）。 */
export async function neededFields(db: Db, sessionId: string, personKey: string): Promise<Set<EvidenceField>> {
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
  const r = await prisma.triageEvidenceImage.findUnique({ where: { id }, select: { imageBytes: true, iv: true, tag: true, mime: true, encVersion: true } });
  if (!r || r.encVersion !== ENC_VERSION) return null;
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
}

/** match 推導嘅 personKey；hkid 唔合法而又冇工號＝null（唔准用包內 key 兜底）。 */
export function derivePersonKey(m: EvidenceMatch): string | null {
  const hasHkid = !!canonicalHkid(m.hkid?.trim() || null);
  const nos = (m.staff_numbers ?? []).filter((x) => x.trim());
  if (!hasHkid && nos.length === 0) return null;
  return serverPersonKey({ key: "evidence-match", hkid: { value: m.hkid ?? null }, staffNumbers: nos.map((number) => ({ number })) });
}

/** 推導 key 要等於題目 personKey，而且 match 嘅身份證／工號集合要同題目 evidence.person 一致。 */
export function matchIdentityOk(q: Pick<TriageQuestion, "personKey" | "evidenceJson">, m: EvidenceMatch): boolean {
  const ep = (q.evidenceJson as unknown as QuestionEvidence | null)?.person;
  if (!ep) return false;
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
    where: { sessionId: { in: [...new Set(withKey.map((r) => r.sessionId))] }, personKey: { in: [...new Set(withKey.map((r) => r.personKey!))] } },
    select: EVIDENCE_META_SELECT,
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  if (imgs.length === 0) return out;
  for (const r of withKey) {
    const need = new Set(requiredFieldsFor(r).filter((f) => can.has(f)));
    const mine = imgs.filter((i) => i.sessionId === r.sessionId && i.personKey === r.personKey && need.has(i.field as EvidenceField));
    if (mine.length) out.set(r.id, mine.map((i) => ({ id: i.id, field: i.field as EvidenceField, doc_kind: i.docKind as DocKind, priority: i.priority, width: i.width, height: i.height })));
  }
  return out;
}
