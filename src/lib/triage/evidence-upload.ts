// TE-1：`POST /api/triage/sessions/:id/evidence-images` 嘅核心——zip 解析（M6）＋身份防呆（M7）＋寫入。
//  - zip 限制：≤400 entry、解壓總量 ≤32 MB、每張 ≤120 KB、entry 名必須 `^[a-f0-9]{16,64}\.(jpg|png)$`（唔准真名）、magic bytes、manifest 必須有 match（冇就整個 400）。
//  - 伺服器**唔回顯** entry 名／manifest 內容：回應、錯誤訊息、audit 全部只有計數。
//  - 只收該 session 仍有 open／skipped 題需要嘅欄（其餘計 skipped_not_needed）；每欄 ≤3、每人 ≤18；優先來源排前。
//  - TE-7：整頁原稿（field=page／doc_kind=full_page，抽取失敗人嘅例外，≤400 KB／長邊 ≤1600，每人 ≤8 頁另計）＋manifest.people[].doc_ref（來源檔案線索）。
import JSZip from "jszip";
import { z } from "zod";
import type { TriageQuestion } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ApiError, BadRequest } from "@/lib/api/errors";
import { writeAuditTx } from "@/lib/audit";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { TRIAGE_LOCK, restrictedKindsFor } from "./session";
import {
  DOC_KINDS,
  EVIDENCE_FIELDS,
  MAX_IMAGE_BYTES,
  MAX_PAGE_IMAGE_BYTES,
  MAX_PAGES_PER_PERSON,
  MAX_PER_FIELD,
  MAX_PER_PERSON,
  RETENTION_DAYS,
  SKIPPED_RETENTION_DAYS,
  derivePersonKey,
  inspectImage,
  insertEvidenceImage,
  matchIdentityOk,
  priorityOf,
  requiredFieldsFor,
  sha256Hex,
  withdrawImages,
  restoreEvidenceImage,
  type DocKind,
  type EvidenceField,
} from "./evidence-images";

export const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 400;
const MAX_UNZIPPED_BYTES = 32 * 1024 * 1024;
const ENTRY_NAME_RE = /^[a-f0-9]{16,64}\.(jpg|png)$/;
const DAY_MS = 86_400_000;

const matchSchema = z
  .object({ hkid: z.string().max(20).nullable().optional(), staff_numbers: z.array(z.string().min(1).max(32)).max(20).optional(), package_key: z.string().min(1).max(80).nullable().optional(), prod_person_key: z.string().min(1).max(80).nullable().optional() })
  .strict()
  .refine((m) => !!(m.hkid && m.hkid.trim()) || (m.staff_numbers?.length ?? 0) > 0 || !!m.package_key?.trim() || !!m.prod_person_key?.trim());
const itemSchema = z
  .object({
    file: z.string().regex(ENTRY_NAME_RE),
    field: z.enum(EVIDENCE_FIELDS),
    doc_kind: z.enum(DOC_KINDS),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    /** TE-7：整頁原稿頁碼（field=page／doc_kind=full_page 必填） */
    page_no: z.number().int().min(1).max(500).optional(),
    /** TE-1.7：本機 Vision 驗證相似度（淨數字 0–1，可選；伺服器唔使用，只容許通過 strict schema） */
    verify_score: z.number().min(0).max(1).optional(),
    match: matchSchema,
  })
  .strict()
  .refine((i) => (i.field === "page") === (i.doc_kind === "full_page") && (i.field !== "page" || i.page_no !== undefined));
/** TE-7：每人來源檔案線索（file_name 係 Drive 檔名，可能含人名＝題目資料級，唔入 ai schema；只補唔覆蓋） */
const docRefSchema = z
  .object({ file_name: z.string().max(200), page_count: z.number().int().min(0).max(2000), pages_by_kind: z.record(z.string().max(30), z.number().int().min(0).max(2000)) })
  .strict();
type DocRef = z.infer<typeof docRefSchema>;
/** TE-8：取代模式——對 manifest 入面有圖嘅每個人，將同欄同 doc_kind 嘅舊圖（唔喺今次 manifest sha 內）軟刪 */
const replaceSchema = z.object({ doc_kind: z.enum(DOC_KINDS), field: z.enum(EVIDENCE_FIELDS) }).strict();
export const evidenceManifestSchema = z
  .object({ version: z.literal(1), items: z.array(itemSchema).max(MAX_ENTRIES), replace: z.array(replaceSchema).max(10).optional(), people: z.array(z.object({ match: matchSchema, doc_ref: docRefSchema }).strict()).max(MAX_ENTRIES).optional() })
  .strict();
export type EvidenceManifest = z.infer<typeof evidenceManifestSchema>;

export interface EvidenceUploadCounts {
  dry_run: boolean;
  items_total: number;
  /** 配對到嘅題目數（至少有一張被接受）；dry 同 apply 同一定義 */
  matched_questions: number;
  accepted_images: number;
  skipped_invalid: number;
  skipped_invalid_image: number;
  skipped_identity_mismatch: number;
  skipped_no_question: number;
  skipped_not_needed: number;
  skipped_restricted: number;
  skipped_duplicate: number;
  skipped_over_limit: number;
  /** TE-7：寫入（dry＝會寫入）doc_ref 嘅題目數 */
  doc_refs_set: number;
  /** TE-8：重上載已被撤回嘅同 sha 圖 */
  skipped_withdrawn: number;
  /** TE-8：取代模式會軟刪（apply＝已軟刪）嘅舊圖張數 */
  would_withdraw: number;
}

const GENERIC_ZIP_ERR = "zip 檔案格式唔啱或超出限制";

interface StreamHelper {
  on(ev: "data", cb: (chunk: Uint8Array) => void): StreamHelper;
  on(ev: "end", cb: () => void): StreamHelper;
  on(ev: "error", cb: (e: unknown) => void): StreamHelper;
  pause(): StreamHelper;
  resume(): StreamHelper;
}
const MANIFEST_MAX_BYTES = 1_000_000;

/**
 * 逐 entry 串流解壓（M6）：**唔信 zip 自己宣告嘅尺寸**。邊解邊計 bytes，超過 limit 即刻 pause 並放棄（回 null＝超大），
 * 之後嘅 chunk 一律丟棄唔儲存；`seen` 累計所有見過嘅解壓 bytes（含被丟棄），由 caller 對總量設上限。
 * 解壓出錯（資料壞／宣告尺寸同實際唔符）→ reject（caller 轉固定句 400）。
 */
function readEntryBounded(e: JSZip.JSZipObject, limit: number, onSeen: (n: number) => void, onKept?: (n: number) => void): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let kept = 0;
    let done = false;
    const h = (e as unknown as { internalStream(t: "uint8array"): StreamHelper }).internalStream("uint8array");
    h.on("data", (chunk) => {
      onSeen(chunk.byteLength);
      if (done) return;
      if (kept + chunk.byteLength > limit) {
        done = true;
        h.pause();
        resolve(null);
        return;
      }
      kept += chunk.byteLength;
      onKept?.(chunk.byteLength);
      chunks.push(chunk);
    });
    h.on("error", () => {
      if (done) return;
      done = true;
      reject(new Error("unzip"));
    });
    h.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    h.resume();
  });
}

/** 解 zip：所有失敗一律同一句 400，唔回顯 entry 名／內部訊息。回 manifest 同 entries（name → bytes；超大單張唔入 map）。 */
export async function readEvidenceZip(buf: Uint8Array, hooks: { onKept?: (n: number) => void; onSeen?: (n: number) => void } = {}): Promise<{ manifest: EvidenceManifest; images: Map<string, Uint8Array> }> {
  if (buf.byteLength === 0 || buf.byteLength > MAX_ZIP_BYTES) throw BadRequest("zip 檔案太大或係空嘅（上限 8 MB）");
  try {
    return await readEvidenceZipInner(buf, hooks);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw BadRequest(GENERIC_ZIP_ERR); // JSZip／pako 嘅內部錯誤訊息可能帶 entry 名，一律唔回顯
  }
}

async function readEvidenceZipInner(buf: Uint8Array, hooks: { onKept?: (n: number) => void; onSeen?: (n: number) => void }): Promise<{ manifest: EvidenceManifest; images: Map<string, Uint8Array> }> {
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES + 1) throw BadRequest(GENERIC_ZIP_ERR);
  for (const e of entries) {
    if (e.dir) throw BadRequest(GENERIC_ZIP_ERR);
    if (e.name !== "manifest.json" && !ENTRY_NAME_RE.test(e.name)) throw BadRequest(GENERIC_ZIP_ERR); // 唔准真名／路徑
  }
  let seen = 0;
  const onSeen = (n: number) => {
    seen += n;
    hooks.onSeen?.(n);
  };
  const mf = zip.file("manifest.json");
  if (!mf) throw BadRequest(GENERIC_ZIP_ERR);
  const mfBytes = await readEntryBounded(mf, MANIFEST_MAX_BYTES, onSeen, hooks.onKept);
  if (!mfBytes) throw BadRequest(GENERIC_ZIP_ERR);
  let manifest: EvidenceManifest;
  try {
    const parsed = evidenceManifestSchema.safeParse(JSON.parse(Buffer.from(mfBytes).toString("utf8")));
    if (!parsed.success) throw new Error("schema");
    manifest = parsed.data;
  } catch {
    // 冇 match／格式唔啱：整個拒絕（唔回顯內容）
    throw BadRequest("manifest 格式唔啱（每張圖都要有 match，而且 priority／doc_kind／field 要啱規格）");
  }
  const images = new Map<string, Uint8Array>();
  const pageFiles = new Set(manifest.items.filter((i) => i.doc_kind === "full_page").map((i) => i.file));
  for (const e of entries) {
    if (e.name === "manifest.json") continue;
    // 宣告嘅壓縮後尺寸只作快速排除（唔係信任依據）：真正限制係串流計數
    const csize = (e as unknown as { _data?: { compressedSize?: number } })._data?.compressedSize;
    if (typeof csize === "number" && csize > (pageFiles.has(e.name) ? MAX_PAGE_IMAGE_BYTES : MAX_IMAGE_BYTES) + 1024) continue;
    const bytes = await readEntryBounded(e, pageFiles.has(e.name) ? MAX_PAGE_IMAGE_BYTES : MAX_IMAGE_BYTES, onSeen, hooks.onKept);
    if (seen > MAX_UNZIPPED_BYTES) throw BadRequest(GENERIC_ZIP_ERR);
    if (bytes) images.set(e.name, bytes); // 超過 120 KB＝null＝唔入 map（之後該 item 計 skipped_invalid_image）
  }
  return { manifest, images };
}

interface Plan {
  item: EvidenceManifest["items"][number];
  personKey: string;
  field: EvidenceField;
  docKind: DocKind;
  priority: number;
  plain: Uint8Array;
  info: NonNullable<ReturnType<typeof inspectImage>>;
  sha: string;
  questionId: string;
  guardId: string | null;
  anyOpen: boolean;
  qids: string[];
  pageNo: number | null;
  /** TE-8 S2：恢復被取代上載軟刪嘅同 sha 圖（更新原 row，唔 insert） */
  restoreId: string | null;
}

/**
 * 核心：dryRun＝只算計數；否則同一 tx（TRIAGE_LOCK）內寫入。
 * 呼叫前 route 已確認 session 屬 guard_import 而且 actor 有權。
 */
export async function runEvidenceUpload(actor: AuthedSession, sessionId: string, zipBytes: Uint8Array, opts: { dryRun: boolean; ip: string | null; now?: Date }): Promise<EvidenceUploadCounts> {
  const now = opts.now ?? new Date();
  const { manifest, images } = await readEvidenceZip(zipBytes);
  const restricted = new Set(await restrictedKindsFor(actor));

  const body = async (db: Pick<typeof prisma, "triageQuestion" | "triageEvidenceImage">): Promise<{ plans: Plan[]; counts: EvidenceUploadCounts; docRefs: { qid: string; docRef: DocRef }[]; withdrawIds: string[]; withdrawInfo: { id: string; field: string; docKind: string }[] }> => {
    const counts: EvidenceUploadCounts = { dry_run: opts.dryRun, items_total: manifest.items.length, matched_questions: 0, accepted_images: 0, skipped_invalid: 0, skipped_invalid_image: 0, skipped_identity_mismatch: 0, skipped_no_question: 0, skipped_not_needed: 0, skipped_restricted: 0, skipped_duplicate: 0, skipped_over_limit: 0, doc_refs_set: 0, skipped_withdrawn: 0, would_withdraw: 0 };
    const qs = await db.triageQuestion.findMany({ where: { sessionId, status: { in: ["open", "skipped"] }, personKey: { not: null } }, orderBy: [{ sort: "asc" }, { id: "asc" }] });
    const byKey = new Map<string, TriageQuestion[]>();
    for (const q of qs) byKey.set(q.personKey!, [...(byKey.get(q.personKey!) ?? []), q]);
    const perField = new Map<string, number>();
    const perPerson = new Map<string, number>();
    const seenSha = new Set<string>();
    const existing = await db.triageEvidenceImage.findMany({ where: { sessionId }, select: { id: true, personKey: true, field: true, docKind: true, sha256: true, withdrawnAt: true, withdrawnReason: true } });
    // TE-8：取代模式——只喺今次真係「接受咗」同一人、同一欄、同一 doc_kind 嘅新圖，先將該組舊圖（sha 唔喺今次 manifest）軟刪；
    // 只出現喺 people[]、或新圖唔合格／被跳過嘅人唔會被軟刪（見下面逐 item 處理）。
    const withdrawIds = new Set<string>();
    const shaByPerson = new Map<string, Set<string>>();
    if (manifest.replace?.length) {
      const known = new Set(byKey.keys());
      for (const it of manifest.items) {
        const pk = derivePersonKey(it.match, known);
        if (!pk || !(byKey.get(pk) ?? []).some((q) => matchIdentityOk(q, it.match))) continue;
        const plain = images.get(it.file);
        if (plain) (shaByPerson.get(pk) ?? shaByPerson.set(pk, new Set()).get(pk)!).add(sha256Hex(plain));
      }
    }
    const withdrawnSha = new Map<string, { id: string; reason: string | null }>();
    for (const e of existing) {
      if (e.withdrawnAt) {
        withdrawnSha.set(`${e.personKey}|${e.field}|${e.sha256}`, { id: e.id, reason: e.withdrawnReason });
        continue;
      }
      perField.set(`${e.personKey}|${e.field}`, (perField.get(`${e.personKey}|${e.field}`) ?? 0) + 1);
      if (e.field !== "page") perPerson.set(e.personKey, (perPerson.get(e.personKey) ?? 0) + 1);
      seenSha.add(`${e.personKey}|${e.field}|${e.sha256}`);
    }
    const plans: Plan[] = [];
    const matchedQ = new Set<string>();
    // 優先來源先處理（同欄超額時，保留 priority 1）
    const items = [...manifest.items].sort((a, b) => a.priority - b.priority);
    for (const item of items) {
      if (priorityOf(item.field, item.doc_kind) !== item.priority) {
        counts.skipped_invalid += 1;
        continue;
      }
      const plain = images.get(item.file);
      const info = plain ? inspectImage(plain, { page: item.field === "page" }) : null;
      if (!plain || !info || (info.mime === "image/jpeg") !== item.file.endsWith(".jpg")) {
        counts.skipped_invalid_image += 1;
        continue;
      }
      const personKey = derivePersonKey(item.match, new Set(byKey.keys()));
      const cands = personKey ? (byKey.get(personKey) ?? []) : [];
      if (!personKey) {
        counts.skipped_identity_mismatch += 1;
        continue;
      }
      if (cands.length === 0) {
        counts.skipped_no_question += 1;
        continue;
      }
      const ok = cands.filter((q) => matchIdentityOk(q, item.match));
      if (ok.length === 0) {
        counts.skipped_identity_mismatch += 1;
        continue;
      }
      const needing = ok.filter((q) => requiredFieldsFor(q).includes(item.field));
      if (needing.length === 0) {
        counts.skipped_not_needed += 1;
        continue;
      }
      const allowed = needing.filter((q) => !restricted.has(q.kind));
      if (allowed.length === 0) {
        counts.skipped_restricted += 1;
        continue;
      }
      const sha = sha256Hex(plain);
      const shaKey = `${personKey}|${item.field}|${sha}`;
      // TE-8 S2：被「取代上載」軟刪嘅圖，同 sha 重上載＝恢復；人手撤回（wrong／unrelated）嘅圖永遠唔再收
      const wd = withdrawnSha.get(shaKey);
      if (wd && wd.reason !== "replaced_by_upload") {
        counts.skipped_withdrawn += 1;
        continue;
      }
      if (seenSha.has(shaKey)) {
        counts.skipped_duplicate += 1;
        continue;
      }
      const fk = `${personKey}|${item.field}`;
      // TE-7：整頁原稿另計（每人 ≤8 頁，唔計入 18）
      const isPage = item.field === "page";
      // 取代模式：呢張新圖若被接受，同組舊圖會被軟刪，先暫時釋出佢哋佔嘅額度
      const freed = manifest.replace?.some((r) => r.field === item.field && r.doc_kind === item.doc_kind)
        ? existing.filter((e) => !e.withdrawnAt && !withdrawIds.has(e.id) && e.personKey === personKey && e.field === item.field && e.docKind === item.doc_kind && !shaByPerson.get(personKey)?.has(e.sha256))
        : [];
      const ofField = (perField.get(fk) ?? 0) - freed.length;
      const ofPerson = (perPerson.get(personKey) ?? 0) - (isPage ? 0 : freed.length);
      if (ofField >= (isPage ? MAX_PAGES_PER_PERSON : MAX_PER_FIELD) || (!isPage && ofPerson >= MAX_PER_PERSON)) {
        counts.skipped_over_limit += 1;
        continue;
      }
      for (const e of freed) withdrawIds.add(e.id);
      perField.set(fk, ofField);
      if (!isPage) perPerson.set(personKey, ofPerson);
      seenSha.add(shaKey);
      perField.set(fk, (perField.get(fk) ?? 0) + 1);
      if (!isPage) perPerson.set(personKey, (perPerson.get(personKey) ?? 0) + 1);
      for (const q of allowed) matchedQ.add(q.id);
      plans.push({ item, personKey, field: item.field, docKind: item.doc_kind, priority: item.priority, plain, info, sha, questionId: allowed[0]!.id, guardId: allowed[0]!.targetGuardId, anyOpen: allowed.some((q) => q.status === "open"), qids: allowed.map((q) => q.id), pageNo: item.page_no ?? null, restoreId: wd?.id ?? null });
    }
    counts.would_withdraw = withdrawIds.size;
    counts.accepted_images = plans.length;
    counts.matched_questions = matchedQ.size;
    // TE-7：每人來源檔案線索 doc_ref——寫入該人所有 open／skipped 題嘅 evidence.doc_ref（只補，唔覆蓋）
    const docRefs: { qid: string; docRef: DocRef }[] = [];
    const doneQ = new Set<string>();
    for (const pe of manifest.people ?? []) {
      const pk = derivePersonKey(pe.match, new Set(byKey.keys()));
      if (!pk) continue;
      for (const q of byKey.get(pk) ?? []) {
        if (doneQ.has(q.id) || restricted.has(q.kind) || !matchIdentityOk(q, pe.match)) continue;
        if ((q.evidenceJson as { doc_ref?: unknown } | null)?.doc_ref) continue;
        doneQ.add(q.id);
        docRefs.push({ qid: q.id, docRef: pe.doc_ref });
      }
    }
    counts.doc_refs_set = docRefs.length;
    return { plans, counts, docRefs, withdrawIds: [...withdrawIds], withdrawInfo: existing.filter((e) => withdrawIds.has(e.id)) };
  };

  if (opts.dryRun) return (await body(prisma)).counts;
  let final!: EvidenceUploadCounts;
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRIAGE_LOCK}))`;
      const { plans, counts, docRefs, withdrawIds, withdrawInfo } = await body(tx);
      final = counts;
      if (withdrawIds.length > 0) {
        await withdrawImages(tx, { id: { in: withdrawIds } }, "replaced_by_upload", now);
        for (const w of withdrawInfo) await writeAuditTx(tx, { actorUserId: actor.userId, tableName: "triage_evidence_images", rowId: w.id, action: "triage_evidence_withdraw", after: { session_id: sessionId, image_id: w.id, field: w.field, doc_kind: w.docKind, reason: "replaced_by_upload" }, ip: opts.ip });
      }
      for (const d of docRefs) {
        const cur = await tx.triageQuestion.findUnique({ where: { id: d.qid }, select: { evidenceJson: true } });
        const ej = (cur?.evidenceJson ?? {}) as Record<string, unknown>;
        if (cur && !ej.doc_ref) await tx.triageQuestion.update({ where: { id: d.qid }, data: { evidenceJson: { ...ej, doc_ref: d.docRef } as never } });
      }
      for (const p of plans) {
        if (p.restoreId) {
          await restoreEvidenceImage(tx, p.restoreId, p.plain, p.info, new Date(now.getTime() + (p.anyOpen ? RETENTION_DAYS : SKIPPED_RETENTION_DAYS) * DAY_MS));
          await writeAuditTx(tx, { actorUserId: actor.userId, tableName: "triage_evidence_images", rowId: p.restoreId, action: "triage_evidence_withdraw", after: { session_id: sessionId, image_id: p.restoreId, field: p.field, doc_kind: p.docKind, reason: "restored" }, ip: opts.ip });
          continue;
        }
        await insertEvidenceImage(tx, {
          sessionId,
          questionId: p.questionId,
          personKey: p.personKey,
          guardId: p.guardId,
          field: p.field,
          docKind: p.docKind,
          priority: p.priority,
          pageNo: p.pageNo,
          plain: p.plain,
          info: p.info,
          createdBy: actor.userId,
          // 只有 skipped 題需要＝30 日；有 open 題需要＝180 日（安全網上限）
          expiresAt: new Date(now.getTime() + (p.anyOpen ? RETENTION_DAYS : SKIPPED_RETENTION_DAYS) * DAY_MS),
          source: "batch_crops",
        });
      }
      await writeAuditTx(tx, { actorUserId: actor.userId, tableName: "triage_sessions", rowId: sessionId, action: "triage_evidence_upload", after: { session_id: sessionId, ...counts }, ip: opts.ip });
    },
    { timeout: 60_000, maxWait: 30_000 },
  );
  return final;
}
