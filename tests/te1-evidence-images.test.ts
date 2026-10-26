// TE-1：分流題覆核證據裁圖（docs/plans/triage-evidence-crops-plan.md；Opus 條件 M1–M9／S1–S5；§7 來源優先順序）。
// 全部合成資料：假名「導入測試員X」、合法 check digit 假 HKID、合成 header-only JPEG/PNG（tests/lib/te1-images.ts）。
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { hkidCheckDigitValid } from "@/lib/guards/identity";
import { hashPackage, importPackageSchema, personKeyForHkid, type PackagePerson } from "@/lib/guards/import/package";
import { serverPersonKey } from "@/lib/guards/import/person-key";
import { POST as applyRoute } from "@/app/api/guards/import/apply/route";
import { GET as sessionRoute } from "@/app/api/triage/sessions/[id]/route";
import { POST as uploadRoute } from "@/app/api/triage/sessions/[id]/evidence-images/route";
import { GET as imageRoute } from "@/app/api/triage/evidence-images/[id]/route";
import { POST as withdrawRoute } from "@/app/api/triage/evidence-images/[id]/withdraw/route";
import { POST as previewRoute } from "@/app/api/triage/questions/[id]/preview/route";
import { POST as answerRoute } from "@/app/api/triage/questions/[id]/answer/route";
import {
  DOC_KIND_LABEL,
  EVIDENCE_META_SELECT,
  FIELD_DOC_PRIORITY,
  MAX_PER_FIELD,
  MAX_PER_PERSON,
  MAX_IMAGE_BYTES,
  decryptImage,
  deleteUnneeded,
  encryptImage,
  inspectImage,
  insertEvidenceImage,
  loadImageBytes,
  priorityOf,
  requiredFieldsFor,
  viewableFields,
} from "@/lib/triage/evidence-images";
import { readEvidenceZip } from "@/lib/triage/evidence-upload";
import { evidenceManifestSchema } from "@/lib/triage/evidence-upload";
import { runTriageEvidenceCleanup } from "@/lib/jobs/triage-evidence-cleanup";
import { JOBS } from "@/lib/jobs/registry";
import { triageEvidenceCleanupJob } from "@/lib/jobs/triage-evidence-cleanup";
import { createGuardImportTriage } from "@/lib/triage/session";
import { previewAnswer, submitAnswer } from "@/lib/triage/apply";
import { viewerCaps, explainBlocked, BLOCK_TEXT, loadDecisionCandidates } from "@/lib/triage/view";
import { EXTRA_NAME_OPTIONS } from "@/lib/triage/types";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { buildZip, entryName, fakeJpeg, fakePng, zipOf } from "./lib/te1-images";

function mkHkid(prefix: string, digits: string): string {
  const base = `${prefix}${digits}`;
  const c = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A"].find((x) => hkidCheckDigitValid(base + x))!;
  return base + c;
}
const H = Array.from({ length: 14 }, (_, i) => mkHkid(String.fromCharCode(65 + i), `20000${i % 10}`));

type St = "confirmed" | "review" | "missing";
const F = (value: string | null, status: St) => (value ? { value, status } : { value: null, status: "missing" as St });
function person(o: { hkid?: string | null; hkidStatus?: St; name?: string; nameStatus?: St; nos?: string[]; rating?: "auto_ok" | "review" | "fail" }): PackagePerson {
  const hk = o.hkid === undefined ? H[0]! : o.hkid;
  return {
    key: personKeyForHkid(hk ?? `none-${o.name ?? "x"}-${(o.nos ?? []).join("")}`),
    hkid: F(hk, o.hkidStatus ?? "confirmed"),
    nameZh: F(o.name ?? "導入測試員甲", o.nameStatus ?? "confirmed"),
    nameEn: F("TEST AYUEN KAP", "review"),
    dateOfBirth: F("1990-05-06", "confirmed"),
    sex: F("M", "confirmed"),
    phone: F(null, "confirmed"),
    address: { ...F("測試道123號測試大廈4樓A室", "review") },
    staffNumbers: (o.nos ?? []).map((n) => ({ scheme: n.match(/^[A-Z]+/)![0], number: n })),
    rating: o.rating ?? "auto_ok",
    reasons: [],
    conflicts: [],
  } as PackagePerson;
}
const pkgOf = (persons: PackagePerson[], at = "2026-10-04T00:00:00.000Z") => ({ version: 2 as const, generatedAt: at, persons });

describe("TE-1 證據裁圖", () => {
  let fx: Wp2Fixture;
  let owner: string;
  let accountant: string;
  let supervisor: string;
  let broker: string;
  let guardUser: string;

  beforeEach(async () => {
    await clearAll();
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    fx = await seedWp2Fixture();
    const mkUser = async (role: "會計" | "主管") => {
      const tel = `6${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
      return (await prisma.user.create({ data: { name: `測試${role}新`, tel, passwordHash: "x", roleId: fx.roleIds[role], createdBy: "t" } })).id;
    };
    fx.userIds["會計"] = await mkUser("會計");
    fx.userIds["主管"] = await mkUser("主管");
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
    accountant = await sessionCookieForUser(fx.userIds["會計"]);
    supervisor = await sessionCookieForUser(fx.userIds["主管"]);
    broker = await sessionCookieForUser(fx.userIds["雞頭"]);
    guardUser = await sessionCookieForUser(fx.userIds["安員"]);
  });

  const json = (route: (r: Request, c: never) => Promise<Response>, url: string, cookie: string, body: unknown, id: string) =>
    route(new Request(`http://t${url}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);
  const upload = async (cookie: string, sid: string, zip: Uint8Array | null, dry = false) => {
    const fd = new FormData();
    if (zip) fd.append("file", new Blob([zip as BlobPart], { type: "application/zip" }), "x.zip");
    const res = await uploadRoute(new Request(`http://t/api/triage/sessions/${sid}/evidence-images${dry ? "?dry_run=1" : ""}`, { method: "POST", headers: { cookie }, body: fd }), { params: Promise.resolve({ id: sid }) } as never);
    return { status: res.status, text: await res.clone().text(), body: await res.json() };
  };
  const getImage = (cookie: string, id: string) => imageRoute(new Request(`http://t/api/triage/evidence-images/${id}`, { headers: { cookie } }), { params: Promise.resolve({ id }) } as never);
  const getSession = async (cookie: string, sid: string) => {
    const res = await sessionRoute(new Request(`http://t/api/triage/sessions/${sid}`, { headers: { cookie } }), { params: Promise.resolve({ id: sid }) } as never);
    return { status: res.status, text: await res.clone().text(), body: await res.json() };
  };
  const confirm = async (cookie: string, qid: string, ans: unknown) => {
    const pv = await (await json(previewRoute as never, `/api/triage/questions/${qid}/preview`, cookie, { answer: ans }, qid)).json();
    return json(answerRoute as never, `/api/triage/questions/${qid}/answer`, cookie, { answer: ans, preview_hash: pv.preview_hash }, qid);
  };
  const applyPkg = async (cookie: string, persons: PackagePerson[], at?: string) => {
    const pkg = pkgOf(persons, at);
    const res = await json(applyRoute as never, "/api/guards/import/apply", cookie, { package: pkg, package_hash: hashPackage(importPackageSchema.parse(pkg)) }, "x");
    return { status: res.status, body: await res.json() };
  };

  /** 甲：name_not_confirmed（nameZh review）＋ field_review(nameEn,address)；乙：hkid_not_confirmed；丑：field_review(nameEn,address) */
  async function seed() {
    const pa = person({ hkid: H[1], name: "導入測試員甲", nameStatus: "review", nos: ["U90001"] });
    const pb = person({ hkid: H[2], hkidStatus: "review", name: "導入測試員乙", nos: ["U90002"] });
    const pc = person({ hkid: H[12], name: "導入測試員丑", nos: ["U90012"] });
    const r = await applyPkg(accountant, [pa, pb, pc]);
    expect(r.status).toBe(200);
    const sid = r.body.triage.session_id as string;
    const key = (p: PackagePerson) => serverPersonKey({ key: p.key, hkid: { value: p.hkid.value }, staffNumbers: p.staffNumbers });
    return { pa, pb, pc, sid, ka: key(pa), kb: key(pb), kc: key(pc) };
  }
  const matchOf = (p: PackagePerson) => ({ hkid: p.hkid.value, staff_numbers: p.staffNumbers.map((n) => n.number) });
  const qOf = (kind: string, personKey?: string) => prisma.triageQuestion.findFirstOrThrow({ where: { kind, ...(personKey ? { personKey } : {}) } });
  const imgCount = (where: object = {}) => prisma.triageEvidenceImage.count({ where });
  const J = (n: number, o: Parameters<typeof fakeJpeg>[2] = {}) => fakeJpeg(320, 80, { seed: n, ...o });

  // -------------------------------------------------------------------------
  describe("加密（S1）", () => {
    it("往返成功、密文唔同明文、錯 key／錯 AAD／改 tag／改密文都失敗", () => {
      const plain = J(1);
      const key = randomBytes(32);
      const e = encryptImage(plain, "img-1", key);
      expect(Buffer.from(e.bytes).equals(Buffer.from(plain))).toBe(false);
      expect(new Uint8Array(decryptImage(e, "img-1", key))).toEqual(plain);
      expect(() => decryptImage(e, "img-1", randomBytes(32))).toThrow();
      expect(() => decryptImage(e, "img-2", key)).toThrow();
      expect(() => decryptImage({ ...e, tag: Buffer.alloc(16) }, "img-1", key)).toThrow();
      const bad = Buffer.from(e.bytes);
      bad[0] = bad[0]! ^ 1;
      expect(() => decryptImage({ ...e, bytes: bad }, "img-1", key)).toThrow();
      // 每次 iv 唔同
      expect(encryptImage(plain, "img-1", key).iv.equals(e.iv)).toBe(false);
    });

    it("預設 key 由 SESSION_SECRET HKDF 派生：SESSION_SECRET 一變就解唔開（DB 內存嘅係密文）", async () => {
      const { sid, kc } = await seed();
      const plain = J(7);
      await insertEvidenceImage(prisma, { sessionId: sid, questionId: null, personKey: kc, guardId: null, field: "name_en", docKind: "id_card", priority: 1, plain, info: inspectImage(plain)!, createdBy: fx.userIds["會計"], expiresAt: new Date(Date.now() + 1e9) });
      const row = await prisma.triageEvidenceImage.findFirstOrThrow({ select: { id: true, imageBytes: true, iv: true, tag: true } });
      expect(Buffer.from(row.imageBytes).equals(Buffer.from(plain))).toBe(false);
      expect(Buffer.from(row.imageBytes).indexOf(Buffer.from([0xff, 0xd8, 0xff]))).toBe(-1);
      expect(new Uint8Array(decryptImage({ bytes: row.imageBytes, iv: row.iv, tag: row.tag }, row.id))).toEqual(plain);
      const old = process.env.SESSION_SECRET;
      process.env.SESSION_SECRET = "another-session-secret-for-rotation-test-0123456789";
      try {
        expect(() => decryptImage({ bytes: row.imageBytes, iv: row.iv, tag: row.tag }, row.id)).toThrow();
        expect(await loadImageBytes(row.id)).toBeNull(); // 讀唔開＝null（route 回 404），唔洩露原因
      } finally {
        process.env.SESSION_SECRET = old;
      }
    });
  });

  describe("圖片 header 驗證（S4／M6）", () => {
    it("合法 JPEG／PNG 過；EXIF／XMP(APP1)／COM／PNG 文字 chunk／garbage／超 120KB／空白 一律唔過", () => {
      expect(inspectImage(fakeJpeg(300, 50, { seed: 1 }))).toEqual({ mime: "image/jpeg", width: 300, height: 50 });
      expect(inspectImage(fakePng(200, 60))).toEqual({ mime: "image/png", width: 200, height: 60 });
      expect(inspectImage(fakeJpeg(300, 50, { exif: true }))).toBeNull();
      expect(inspectImage(fakePng(200, 60, { exif: true }))).toBeNull();
      expect(inspectImage(new Uint8Array(40).fill(7))).toBeNull();
      expect(inspectImage(new Uint8Array(0))).toBeNull();
      expect(inspectImage(fakeJpeg(300, 50, { pad: MAX_IMAGE_BYTES }))).toBeNull();
      expect(inspectImage(fakeJpeg(0, 0))).toBeNull();
      // S-a：掃到 EOI；SOF 之後嘅 APPn／COM、EOI 後尾巴、長邊 >800 都拒
      const j = fakeJpeg(300, 50, { seed: 3 });
      const sofIdx = j.findIndex((v, i) => v === 0xff && j[i + 1] === 0xc0);
      const sosIdx = j.findIndex((v, i) => i > sofIdx && v === 0xff && j[i + 1] === 0xda);
      const app1 = [0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 0, 0];
      const withAfterSof = new Uint8Array([...j.slice(0, sosIdx), ...app1, ...j.slice(sosIdx)]);
      expect(inspectImage(withAfterSof)).toBeNull();
      const com = new Uint8Array([...j.slice(0, sosIdx), 0xff, 0xfe, 0, 4, 0x68, 0x69, ...j.slice(sosIdx)]);
      expect(inspectImage(com)).toBeNull();
      expect(inspectImage(new Uint8Array([...j, 1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull(); // EOI 後有尾巴
      expect(inspectImage(j.slice(0, j.length - 2))).toBeNull(); // 冇 EOI
      expect(inspectImage(fakeJpeg(801, 50))).toBeNull();
      expect(inspectImage(fakeJpeg(800, 800))).not.toBeNull();
      expect(inspectImage(fakePng(801, 50))).toBeNull();
      expect(inspectImage(new TextEncoder().encode("GIF89a-not-allowed-here-xxxxxxxxxxxxxxxx"))).toBeNull();
    });
  });

  describe("requiredFieldsFor／優先順序表", () => {
    it("由 kind／review_fields／ext_review 推欄；銀行欄剔除", () => {
      const ev = (extra: object) => ({ v: 1, person: person({}), reasons: [], candidate_guard_ids: [], ...extra }) as never;
      expect(requiredFieldsFor({ kind: "name_not_confirmed", evidenceJson: ev({}) })).toEqual(["name_zh"]);
      expect(requiredFieldsFor({ kind: "hkid_not_confirmed", evidenceJson: ev({}) })).toEqual(["hkid"]);
      expect(requiredFieldsFor({ kind: "no_id_card", evidenceJson: ev({}) })).toEqual(["hkid"]); // TE-3：淨係有問題嘅欄（身份證號）
      expect(requiredFieldsFor({ kind: "field_review", evidenceJson: ev({ review_fields: [{ field: "nameEn", check: "x" }, { field: "dateOfBirth", check: "x" }, { field: "phone", check: "x" }, { field: "address", check: "x" }, { field: "nameZh", check: "x" }] }) }).sort()).toEqual(["address", "dob", "name_en", "name_zh", "phone"]);
      expect(requiredFieldsFor({ kind: "ext_field_review", evidenceJson: ev({ ext_review: [{ key: "siaPermit.no", check: "x", status: "review" }, { key: "bank", check: "x", status: "review" }, { key: "hireDate", check: "x", status: "review" }] }) }).sort()).toEqual(["hire_date", "permit_no"]);
      expect(requiredFieldsFor({ kind: "bank_review", evidenceJson: ev({ ext_review: [{ key: "bank", check: "x", status: "review" }] }) })).toEqual([]);
      expect(requiredFieldsFor({ kind: "wa_unparsed", evidenceJson: ev({}) })).toEqual([]);
    });

    it("§7 來源優先順序表：證件欄＝身份證優先、住址＝住址證明優先、電話＝入職表；priorityOf 1／2／null", () => {
      for (const f of ["name_zh", "name_en", "dob"] as const) {
        expect(FIELD_DOC_PRIORITY[f]).toEqual(["id_card", "onboarding_form"]);
        expect(priorityOf(f, "id_card")).toBe(1);
        expect(priorityOf(f, "onboarding_form")).toBe(2);
        expect(priorityOf(f, "address_proof")).toBeNull();
      }
      // TE-2：身份證號 身份證副本 1 ＞ 牌照／證書印刷 2 ＞ 入職表手寫 3；入職日期只有入職表
      expect(FIELD_DOC_PRIORITY.hkid).toEqual(["id_card", "printed", "onboarding_form"]);
      expect(priorityOf("hkid", "id_card")).toBe(1);
      expect(priorityOf("hkid", "printed")).toBe(2);
      expect(priorityOf("hkid", "onboarding_form")).toBe(3);
      expect(priorityOf("name_zh", "printed")).toBeNull();
      expect(priorityOf("hire_date", "onboarding_form")).toBe(1);
      expect(priorityOf("hire_date", "id_card")).toBeNull();
      expect(DOC_KIND_LABEL.printed).toBe("牌照／證書印刷");
      expect(MAX_PER_FIELD).toBe(3);
      expect(MAX_PER_PERSON).toBe(18);
      expect(priorityOf("address", "address_proof")).toBe(1);
      expect(priorityOf("address", "onboarding_form")).toBe(2);
      expect(priorityOf("address", "id_card")).toBeNull();
      expect(priorityOf("phone", "onboarding_form")).toBe(1);
      expect(priorityOf("phone", "id_card")).toBeNull();
      expect(DOC_KIND_LABEL.id_card).toBe("身份證副本");
      expect(DOC_KIND_LABEL.address_proof).toBe("住址證明");
      expect(DOC_KIND_LABEL.onboarding_form).toBe("入職表手寫");
    });
  });

  describe("M4 bytes 白名單", () => {
    it("META_SELECT 永不含 bytes／iv／tag；source 內 imageBytes 只喺 evidence-images.ts（WA-8：另加 whatsapp/media.ts，同一加密暫存紀律）；冇 include evidenceImages", () => {
      for (const k of ["imageBytes", "iv", "tag"]) expect(Object.keys(EVIDENCE_META_SELECT)).not.toContain(k);
      const root = path.resolve(__dirname, "../src");
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.(ts|tsx)$/.test(e.name)) {
            const s = fs.readFileSync(p, "utf8");
            const rel = path.relative(root, p).split(path.sep).join("/");
            if (/\bimageBytes\b|\bimage_bytes\b/.test(s) && rel !== "lib/triage/evidence-images.ts" && rel !== "lib/whatsapp/media.ts") hits.push(`${rel}: imageBytes`);
            if (/\bevidenceImages\b/.test(s)) hits.push(`${rel}: evidenceImages`);
            // 凡係讀 triageEvidenceImage 嘅 find*，必須有 select
            for (const m of s.matchAll(/triageEvidenceImage\.(findMany|findFirst|findUnique)\(\s*\{([\s\S]{0,400}?)\}\s*\)/g)) if (!/select\s*:/.test(m[2]!)) hits.push(`${rel}: find without select`);
          }
        }
      };
      walk(root);
      expect(hits).toEqual([]);
    });

    it("session GET JSON 只有 evidence_images meta：永不含 bytes／iv／tag／密文 base64", async () => {
      const { pa, sid, ka } = await seed();
      const z = await zipOf([{ bytes: J(11), field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(pa) }]);
      expect((await upload(accountant, sid, z)).body.accepted_images).toBe(1);
      const row = await prisma.triageEvidenceImage.findFirstOrThrow({ select: { imageBytes: true, iv: true, tag: true } });
      const s = await getSession(accountant, sid);
      expect(s.status).toBe(200);
      for (const bad of ["image_bytes", "imageBytes", "\"iv\"", "\"tag\"", Buffer.from(row.imageBytes).toString("base64").slice(0, 16)]) expect(s.text).not.toContain(bad);
      const q = s.body.questions.find((x: { kind: string }) => x.kind === "name_not_confirmed");
      expect(q.evidence_images).toHaveLength(1);
      expect(Object.keys(q.evidence_images[0]).sort()).toEqual(["doc_kind", "field", "height", "id", "priority", "width"]);
      expect(q.evidence_images[0]).toMatchObject({ field: "name_zh", doc_kind: "id_card", priority: 1, width: 320, height: 80 });
      void ka;
    });
  });

  describe("上載 zip（M6／M7／S2）", () => {
    it("dry_run 只計數唔寫；apply 後存密文；回應／audit 淨計數（冇檔名、冇身份證、冇姓名）", async () => {
      const { pa, pb, sid } = await seed();
      const a = J(21);
      const z = await zipOf([
        { bytes: a, field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(pa) },
        { bytes: J(22), field: "hkid", doc_kind: "id_card", priority: 1, match: matchOf(pb) },
      ]);
      const dry = await upload(accountant, sid, z, true);
      expect(dry.status).toBe(200);
      expect(dry.body).toMatchObject({ dry_run: true, items_total: 2, matched_questions: 2, accepted_images: 2 });
      expect(await imgCount()).toBe(0);
      const audits0 = await prisma.auditLog.count({ where: { action: "triage_evidence_upload" } }); // audit_log append-only，跨 test 累積，用差值
      expect(await prisma.auditLog.count({ where: { action: "triage_evidence_upload" } })).toBe(audits0);
      const res = await upload(accountant, sid, z);
      expect(res.body).toMatchObject({ dry_run: false, accepted_images: 2, matched_questions: 2 });
      expect(await imgCount()).toBe(2);
      expect(await prisma.auditLog.count({ where: { action: "triage_evidence_upload" } })).toBe(audits0 + 1);
      const aud = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_evidence_upload", rowId: sid }, orderBy: { createdAt: "desc" } });
      const blob = JSON.stringify(aud) + res.text + dry.text;
      for (const bad of [entryName(a), H[1]!, H[2]!, "導入測試員", "U90001", "manifest"]) expect(blob).not.toContain(bad);
      expect(aud.after).toMatchObject({ accepted_images: 2, session_id: sid });
      // 重覆上載同一 zip：全部 duplicate
      expect((await upload(accountant, sid, z)).body).toMatchObject({ accepted_images: 0, skipped_duplicate: 2 });
      expect(await imgCount()).toBe(2);
    });

    it("manifest 冇 match → 整個 400（唔寫）；match 空物件亦 400", async () => {
      const { pa, sid } = await seed();
      const bytes = J(31);
      const file = entryName(bytes);
      const bad = await buildZip({ [file]: bytes, "manifest.json": JSON.stringify({ version: 1, items: [{ file, field: "name_zh", doc_kind: "id_card", priority: 1 }] }) });
      const r = await upload(accountant, sid, bad);
      expect(r.status).toBe(400);
      expect(r.text).not.toContain(file);
      const empty = await buildZip({ [file]: bytes, "manifest.json": JSON.stringify({ version: 1, items: [{ file, field: "name_zh", doc_kind: "id_card", priority: 1, match: {} }] }) });
      expect((await upload(accountant, sid, empty)).status).toBe(400);
      // 一個有 match、一個冇 → 整個拒絕（唔會部分收）
      const b2 = J(32);
      const mixed = await buildZip({ [file]: bytes, [entryName(b2)]: b2, "manifest.json": JSON.stringify({ version: 1, items: [{ file, field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(pa) }, { file: entryName(b2), field: "name_zh", doc_kind: "id_card", priority: 1 }] }) });
      expect((await upload(accountant, sid, mixed)).status).toBe(400);
      expect(await imgCount()).toBe(0);
    });

    it("entry 名唔係不透明 id（真名／路徑／副檔名唔啱）→ 400，唔回顯 entry 名", async () => {
      const { pa, sid } = await seed();
      const bytes = J(41);
      for (const name of ["導入測試員甲.jpg", "../evil.jpg", "dir/aaaaaaaaaaaaaaaa.jpg", "AAAAAAAAAAAAAAAAAAAA.jpg", "abc.jpg", "aaaaaaaaaaaaaaaa.gif"]) {
        const z = await buildZip({ [name]: bytes, "manifest.json": JSON.stringify({ version: 1, items: [{ file: entryName(bytes), field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(pa) }] }) });
        const r = await upload(accountant, sid, z);
        expect(r.status).toBe(400);
        expect(r.text).not.toContain(name);
        expect(r.text).not.toContain("evil");
      }
      // manifest 指向唔合規格嘅 file 名 → 400
      const z2 = await buildZip({ [entryName(bytes)]: bytes, "manifest.json": JSON.stringify({ version: 1, items: [{ file: "導入測試員甲.jpg", field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(pa) }] }) });
      expect((await upload(accountant, sid, z2)).status).toBe(400);
    });

    it("entry 數 >400 → 400；zip >8 MB／唔係 zip／冇 manifest／冇 file → 400", async () => {
      const { sid } = await seed();
      const many: Record<string, Uint8Array | string> = { "manifest.json": JSON.stringify({ version: 1, items: [] }) };
      for (let i = 0; i < 401; i++) many[`${String(i).padStart(32, "a")}.jpg`.replace(/a/g, (c, idx) => ((idx + i) % 16).toString(16))] = J(i);
      expect(Object.keys(many).length).toBeGreaterThan(401);
      expect((await upload(accountant, sid, await buildZip(many))).status).toBe(400);
      expect((await upload(accountant, sid, new Uint8Array(8 * 1024 * 1024 + 10).fill(1))).status).toBe(400);
      expect((await upload(accountant, sid, new TextEncoder().encode("not a zip"))).status).toBe(400);
      expect((await upload(accountant, sid, await buildZip({ [entryName(J(1))]: J(1) }))).status).toBe(400);
      expect((await upload(accountant, sid, null)).status).toBe(400);
    });

    /** 把 zip 內所有 entry 宣告嘅解壓前／後尺寸（central dir＋local header）改成 fake（zip 檔自己作假）。 */
    const forgeDeclaredSize = (zip: Uint8Array, fake: number): Uint8Array => {
      const b = Buffer.from(zip);
      for (let i = 0; i + 46 < b.length; i++) {
        if (b.readUInt32LE(i) === 0x02014b50) b.writeUInt32LE(fake, i + 24); // central: uncompressed size
        else if (b.readUInt32LE(i) === 0x04034b50) b.writeUInt32LE(fake, i + 22); // local: uncompressed size
      }
      return new Uint8Array(b);
    };

    it("M6 zip bomb（宣告尺寸作假：宣告 1000 bytes、實際 40 MB）→ 串流計數喺 120 KB 中止：保留 ≤120KB、唔爆記憶體、唔 500", async () => {
      const { sid } = await seed();
      const big = new Uint8Array(40 * 1024 * 1024); // 40 MB 零，壓縮後細
      const name = entryName(big);
      const zip = forgeDeclaredSize(await buildZip({ [name]: big, "manifest.json": JSON.stringify({ version: 1, items: [] }) }), 1000);
      expect(zip.byteLength).toBeLessThan(500 * 1024);
      let kept = 0;
      let seen = 0;
      const before = process.memoryUsage();
      const r = await readEvidenceZip(zip, { onKept: (n) => (kept += n), onSeen: (n) => (seen += n) }).then((x) => ({ ok: true as const, x }), (e) => ({ ok: false as const, e }));
      const after = process.memoryUsage();
      expect(kept).toBeLessThanOrEqual(MAX_IMAGE_BYTES); // 保留（會 buffer）嘅 bytes 唔會超過 120 KB
      expect(seen).toBeLessThan(40 * 1024 * 1024); // 冇真係解晒 40 MB
      expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(30 * 1024 * 1024);
      if (r.ok) expect(r.x.images.has(name)).toBe(false); // 超大單張唔入 map
      // 經 route：回 200（該 item 之後計 skipped_invalid_image）或固定句 400，絕不 500，亦唔回顯 entry 名
      const res = await upload(accountant, sid, zip, true);
      expect([200, 400]).toContain(res.status);
      expect(res.text).not.toContain(name);
    });

    it("M6 解壓錯誤（宣告尺寸同實際唔符）一律固定句 400：唔回顯 entry 名／內部訊息（唔係 500）", async () => {
      const { sid } = await seed();
      const bytes = J(77, { pad: 5000 });
      const name = entryName(bytes);
      const zip = forgeDeclaredSize(await buildZip({ [name]: bytes, "manifest.json": JSON.stringify({ version: 1, items: [] }) }), 1000);
      const res = await upload(accountant, sid, zip, true);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("zip 檔案格式唔啱或超出限制");
      expect(res.text).not.toContain(name);
      expect(res.text.toLowerCase()).not.toContain("mismatch");
    });

    it("M6 總量上限：300 張各 ≤120KB 但解壓合共 >32 MB（zip 只有幾十 KB）→ 400", async () => {
      const { sid } = await seed();
      const entries: Record<string, Uint8Array | string> = { "manifest.json": JSON.stringify({ version: 1, items: [] }) };
      for (let i = 0; i < 300; i++) entries[`${i.toString(16).padStart(32, "c")}.jpg`] = new Uint8Array(120_000).fill(0);
      const zip = await buildZip(entries);
      expect(zip.byteLength).toBeLessThan(2 * 1024 * 1024);
      expect((await upload(accountant, sid, zip, true)).status).toBe(400);
    });

    it("S-b 上載 body 串流上限：冇 content-length header 都擋（>8 MB → 413 固定句），唔會照讀成個 body", async () => {
      const { sid } = await seed();
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(ctl) {
          pulled += 1;
          if (pulled > 40) return ctl.close();
          ctl.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      const req = new Request(`http://t/api/triage/sessions/${sid}/evidence-images`, { method: "POST", headers: { cookie: accountant, "content-type": "multipart/form-data; boundary=x" }, body: stream, duplex: "half" } as RequestInit);
      expect(req.headers.get("content-length")).toBeNull();
      const res = await uploadRoute(req, { params: Promise.resolve({ id: sid }) } as never);
      expect(res.status).toBe(413);
      expect((await res.json()).message).toBe("zip 檔案太大（上限 8 MB）");
      expect(pulled).toBeLessThan(20); // 讀到超限即中止，冇讀晒 40 MB
    });

    it("單張 >120KB／magic bytes 唔啱／帶 EXIF／副檔名同格式唔符 → skipped_invalid_image（其餘照收）", async () => {
      const { pa, sid } = await seed();
      const m = matchOf(pa);
      const items = [
        { bytes: J(51, { pad: 130 * 1024 }), field: "name_zh", doc_kind: "id_card", priority: 1 as const, match: m }, // 太大
        { bytes: new Uint8Array(64).fill(9), field: "name_zh", doc_kind: "id_card", priority: 1 as const, match: m }, // magic 唔啱
        { bytes: J(52, { exif: true }), field: "name_zh", doc_kind: "id_card", priority: 1 as const, match: m }, // EXIF
        { bytes: fakePng(100, 50, { seed: 53 }), field: "name_zh", doc_kind: "id_card", priority: 1 as const, match: m, ext: "jpg" as const }, // PNG 但 .jpg
        { bytes: J(54), field: "name_zh", doc_kind: "id_card", priority: 1 as const, match: m }, // OK
      ];
      const r = await upload(accountant, sid, await zipOf(items), true);
      expect(r.body).toMatchObject({ items_total: 5, accepted_images: 1, skipped_invalid_image: 4 });
    });

    it("身份防呆：match 同題目 evidence 唔一致／推唔到 key／冇題 → 對應計數；不被接受", async () => {
      const { pa, pc, sid } = await seed();
      const wrongHkid = { hkid: H[7]!, staff_numbers: ["U90001"] };
      const wrongNos = { hkid: pa.hkid.value, staff_numbers: ["U90001", "U99999"] };
      const noKey = { hkid: "ZZZ", staff_numbers: [] };
      const nobody = { hkid: H[9]!, staff_numbers: ["U77777"] };
      const r = await upload(
        accountant,
        sid,
        await zipOf([
          { bytes: J(61), field: "name_zh", doc_kind: "id_card", priority: 1, match: wrongHkid },
          { bytes: J(62), field: "name_zh", doc_kind: "id_card", priority: 1, match: wrongNos },
          { bytes: J(63), field: "name_zh", doc_kind: "id_card", priority: 1, match: noKey },
          { bytes: J(64), field: "name_zh", doc_kind: "id_card", priority: 1, match: nobody },
          { bytes: J(65), field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(pa) },
        ]),
        true,
      );
      // 錯身份證＝推出另一個 key，session 冇呢個人（no_question）；同 key 但工號集合唔同／推唔到 key＝identity_mismatch
      expect(r.body).toMatchObject({ accepted_images: 1, skipped_identity_mismatch: 2, skipped_no_question: 2 });
      void pc;
    });

    it("只收題目需要嘅欄／來源（§7）：不需要欄、來源唔啱欄、priority 同來源唔符 → 各自計數", async () => {
      const { pa, pb, sid } = await seed();
      const r = await upload(
        accountant,
        sid,
        await zipOf([
          { bytes: J(71), field: "phone", doc_kind: "onboarding_form", priority: 1, match: matchOf(pa) }, // 甲冇 phone 題
          { bytes: J(72), field: "hkid", doc_kind: "id_card", priority: 1, match: matchOf(pa) }, // 甲冇 hkid 題
          { bytes: J(73), field: "address", doc_kind: "id_card", priority: 1, match: matchOf(pa) }, // 住址唔可以用身份證
          { bytes: J(74), field: "name_zh", doc_kind: "id_card", priority: 2, match: matchOf(pa) }, // priority 同來源唔符
          { bytes: J(75), field: "hkid", doc_kind: "id_card", priority: 1, match: matchOf(pb) }, // OK
        ]),
        true,
      );
      expect(r.body).toMatchObject({ accepted_images: 1, skipped_not_needed: 2, skipped_invalid: 2 });
    });

    it("每欄 ≤3：優先來源排前；第 4 張 over_limit", async () => {
      const { pc, sid } = await seed();
      const m = matchOf(pc);
      // 丑 field_review: nameEn + address。nameEn：id_card(1)、onboarding_form(2)、再一張 id_card → 超額
      const r = await upload(
        accountant,
        sid,
        await zipOf([
          { bytes: J(81), field: "name_en", doc_kind: "onboarding_form", priority: 2, match: m },
          { bytes: J(82), field: "name_en", doc_kind: "id_card", priority: 1, match: m },
          { bytes: J(83), field: "name_en", doc_kind: "id_card", priority: 1, match: m },
          { bytes: J(85), field: "name_en", doc_kind: "id_card", priority: 1, match: m },
          { bytes: J(84), field: "address", doc_kind: "address_proof", priority: 1, match: m },
        ]),
      );
      expect(r.body).toMatchObject({ accepted_images: 4, skipped_over_limit: 1 });
      const rows = await prisma.triageEvidenceImage.findMany({ where: { field: "name_en" }, select: { docKind: true, priority: true }, orderBy: { createdAt: "asc" } });
      expect(rows.map((x) => x.priority)).toEqual([1, 1, 1]); // 優先來源保住；入職表（priority 2）因超額被擠走
      expect(rows.map((x) => x.docKind)).toEqual(["id_card", "id_card", "id_card"]);
    });

    it("TE: 有證件用證件、冇證件退入職表、兩者都有次序（session GET evidence_images 次序＝priority）", async () => {
      const { pc, pa, pb, sid } = await seed();
      // 丑：name_en 只有入職表（冇證件）→ 退入職表；address 兩者都有（入職表先上載，住址證明後上載）
      await upload(
        accountant,
        sid,
        await zipOf([
          { bytes: J(91), field: "name_en", doc_kind: "onboarding_form", priority: 2, match: matchOf(pc) },
          { bytes: J(92), field: "address", doc_kind: "onboarding_form", priority: 2, match: matchOf(pc) },
          { bytes: J(93), field: "address", doc_kind: "address_proof", priority: 1, match: matchOf(pc) },
        ]),
      );
      // 甲：name_zh 有身份證
      await upload(accountant, sid, await zipOf([{ bytes: J(94), field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(pa) }]));
      void pb;
      const s = await getSession(accountant, sid);
      const fr = s.body.questions.find((x: { kind: string; evidence_images: unknown[] }) => x.kind === "field_review" && x.evidence_images.length > 0);
      const byField = (f: string) => fr.evidence_images.filter((i: { field: string }) => i.field === f);
      expect(byField("name_en").map((i: { doc_kind: string }) => i.doc_kind)).toEqual(["onboarding_form"]); // 冇證件：退入職表
      expect(byField("address").map((i: { doc_kind: string; priority: number }) => `${i.priority}:${i.doc_kind}`)).toEqual(["1:address_proof", "2:onboarding_form"]); // 兩者都有：優先排前
      const na = s.body.questions.find((x: { kind: string }) => x.kind === "name_not_confirmed");
      expect(na.evidence_images.map((i: { doc_kind: string }) => i.doc_kind)).toEqual(["id_card"]);
    });

    it("session 類型／權限：非 guard_import 400；雞頭／安員 403；他人 session（主管）403；老闆可", async () => {
      const { pa, sid } = await seed();
      const z = await zipOf([{ bytes: J(101), field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(pa) }]);
      expect((await upload(broker, sid, z, true)).status).toBe(403);
      expect((await upload(guardUser, sid, z, true)).status).toBe(403);
      expect((await upload(supervisor, sid, z, true)).status).toBe(403);
      expect((await upload(owner, sid, z, true)).status).toBe(200);
      const other = await prisma.triageSession.create({ data: { sourceType: "month_close", sourceRef: "te1-mc", ownerUserId: fx.userIds["會計"], createdBy: fx.userIds["會計"] } });
      expect((await upload(accountant, other.id, z, true)).status).toBe(400);
    });
  });

  describe("讀圖 GET + 欄位級權限（M3／M9／S3）", () => {
    async function oneImage(field: "name_zh" | "phone" | "name_en", kind: "name_not_confirmed" | "field_review" = "name_not_confirmed") {
      const s = await seed();
      void kind;
      const target = field === "phone" ? null : s.pa;
      if (!target) {
        // 為 phone 造一條需要電話嘅 field_review 題
        const q = await qOf("field_review", s.kc);
        const ev = q.evidenceJson as { review_fields: object[] };
        await prisma.triageQuestion.update({ where: { id: q.id }, data: { evidenceJson: { ...ev, review_fields: [...ev.review_fields, { field: "phone", check: "fill" }] } as never } });
        await upload(accountant, s.sid, await zipOf([{ bytes: J(111), field: "phone", doc_kind: "onboarding_form", priority: 1, match: matchOf(s.pc) }]));
      } else if (field === "name_zh") {
        await upload(accountant, s.sid, await zipOf([{ bytes: J(112), field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(s.pa) }]));
      } else {
        await upload(accountant, s.sid, await zipOf([{ bytes: J(113), field: "name_en", doc_kind: "id_card", priority: 1, match: matchOf(s.pc) }]));
      }
      const img = await prisma.triageEvidenceImage.findFirstOrThrow({ select: { id: true } });
      return { ...s, id: img.id };
    }

    it("回解密後 image/jpeg；no-store、nosniff；內容＝原圖；寫一條只計數嘅 view audit", async () => {
      const { id } = await oneImage("name_zh");
      const res = await getImage(accountant, id);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(J(112));
      const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_evidence_view" } });
      expect(a.after).toMatchObject({ images: 1 });
      expect(JSON.stringify(a)).not.toContain("導入測試員");
    });

    it("權限矩陣：老闆／會計(擁有人)可；主管(非擁有人)403；雞頭／安員 403；未登入 401", async () => {
      const { id } = await oneImage("name_zh");
      expect((await getImage(owner, id)).status).toBe(200);
      expect((await getImage(accountant, id)).status).toBe(200);
      expect((await getImage(supervisor, id)).status).toBe(403);
      expect((await getImage(broker, id)).status).toBe(403);
      expect((await getImage(guardUser, id)).status).toBe(403);
      expect((await getImage("", id)).status).toBe(401);
      expect((await getImage(owner, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });

    it("欄位級：冇「安員個人資料:view」睇唔到姓名圖(403)，睇到電話圖(200)；冇「安員:view」兩樣都唔得；session GET 亦按此過濾", async () => {
      const { id: nameId, sid } = await oneImage("name_zh");
      const setPerm = async (role: "會計", module: string, granted: boolean) => {
        const perm = await prisma.permission.findFirstOrThrow({ where: { module, action: "view" } });
        await prisma.rolePermission.updateMany({ where: { roleId: fx.roleIds[role], permissionId: perm.id }, data: { granted } });
      };
      await setPerm("會計", "安員個人資料", false);
      expect((await getImage(accountant, nameId)).status).toBe(403);
      const s1 = await getSession(accountant, sid);
      expect(s1.body.questions.every((q: { evidence_images: unknown[] }) => q.evidence_images.length === 0)).toBe(true);
      const caps = await viewableFields({ userId: fx.userIds["會計"], baseRole: "會計", roleId: fx.roleIds["會計"] } as unknown as AuthedSession);
      expect(caps.has("phone")).toBe(true);
      expect(caps.has("name_zh")).toBe(false);
      expect(caps.has("hkid")).toBe(false);
      expect(caps.has("address")).toBe(false);
      await setPerm("會計", "安員個人資料", true);
      await setPerm("會計", "安員", false);
      const caps2 = await viewableFields({ userId: fx.userIds["會計"], baseRole: "會計", roleId: fx.roleIds["會計"] } as unknown as AuthedSession);
      expect(caps2.has("phone")).toBe(false);
      expect(caps2.has("permit_no")).toBe(false);
      expect(caps2.has("name_zh")).toBe(true);
      await setPerm("會計", "安員", true);
    });

    it("電話圖用「安員:view」：冇「安員個人資料:view」仍可睇", async () => {
      const { id } = await oneImage("phone");
      const perm = await prisma.permission.findFirstOrThrow({ where: { module: "安員個人資料", action: "view" } });
      await prisma.rolePermission.updateMany({ where: { roleId: fx.roleIds["會計"], permissionId: perm.id }, data: { granted: false } });
      expect((await getImage(accountant, id)).status).toBe(200);
    });

    it("restricted kind（讀者答唔到）唔回圖；答完後（圖已刪）404", async () => {
      const { id, pa } = await oneImage("name_zh");
      expect((await getImage(accountant, id)).status).toBe(200);
      const q = await qOf("name_not_confirmed");
      expect((await confirm(accountant, q.id, { option: "use_package_name" })).status).toBe(200);
      expect((await getImage(accountant, id)).status).toBe(404);
      void pa;
    });
  });

  describe("M5 保留不變式（答題即刪）", () => {
    const put = async (sid: string, personKey: string, field: "name_zh" | "hkid" | "name_en" | "address" | "dob", n: number, expiresAt = new Date(Date.now() + 100 * 86400000)) => {
      const plain = J(n);
      await insertEvidenceImage(prisma, { sessionId: sid, questionId: null, personKey, guardId: null, field, docKind: field === "address" ? "address_proof" : "id_card", priority: 1, plain, info: inspectImage(plain)!, createdBy: fx.userIds["會計"], expiresAt });
    };

    it("1. 答題即刪：submitAnswer 後同一 tx 內該題嘅圖已冇；audit 帶 evidence_deleted 計數；其他人嘅圖唔受影響", async () => {
      const { sid, ka, kb } = await seed();
      await put(sid, ka, "name_zh", 1);
      await put(sid, kb, "hkid", 2);
      const q = await qOf("name_not_confirmed", ka);
      expect((await confirm(accountant, q.id, { option: "use_package_name" })).status).toBe(200);
      expect(await imgCount({ personKey: ka, field: "name_zh" })).toBe(0);
      expect(await imgCount({ personKey: kb })).toBe(1);
      const a = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_answer", rowId: q.id } });
      expect((a.after as { evidence_deleted?: number }).evidence_deleted).toBe(1);
    });

    it("2. 同一人另一條仍 open 題需要同一欄 → 圖保留，直至最後一條答完", async () => {
      const { sid, kc } = await seed();
      const fr = await qOf("field_review", kc);
      // 同人再有一條需要 name_en 嘅 open 題
      const dup = await prisma.triageQuestion.create({ data: { sessionId: sid, kind: "field_review", groupKey: "te1-dup", personKey: kc, sort: fr.sort + 1, title: "dup", evidenceJson: fr.evidenceJson as never, optionsJson: fr.optionsJson as never } });
      await put(sid, kc, "name_en", 3);
      const ans = { option: "apply_fields", fields: { nameEn: { action: "skip" }, address: { action: "skip" } } };
      expect((await confirm(accountant, fr.id, ans)).status).toBe(200);
      expect(await imgCount({ personKey: kc, field: "name_en" })).toBe(1); // dup 仍需要
      expect((await confirm(accountant, dup.id, ans)).status).toBe(200);
      expect(await imgCount({ personKey: kc })).toBe(0);
    });

    it("3. TR-2 部分作答：只刪已答欄嘅圖，剩餘欄（跟進題）嘅圖保留", async () => {
      const { sid, kc } = await seed();
      await put(sid, kc, "name_en", 4);
      await put(sid, kc, "address", 5);
      // 直接經 lib（submitAnswer＋followUp，同 TR-2 一樣）答 nameEn；唔用 proposals route（佢嘅 triage_proposals_import audit 會污染 triage-proposals.test 嘅無排序 findFirst）
      const actor = { userId: fx.userIds["會計"], baseRole: "會計", roleId: fx.roleIds["會計"], tokenVersion: 0 } as unknown as AuthedSession;
      const q0 = await qOf("field_review", kc);
      const ans = { option: "apply_fields", fields: { nameEn: { action: "confirm", value: "TEST CHAU" } } };
      const caps = await viewerCaps(actor);
      const pv = await previewAnswer(actor, q0, ans, caps, null);
      const out = await submitAnswer(actor, q0, ans, pv.preview_hash, caps, null, { source: "ocr_reread", followUp: { groupKey: `${q0.groupKey}:rest`, restFields: ["address"] } });
      expect(out.follow_up_created).toBe(true);
      expect(await imgCount({ personKey: kc, field: "name_en" })).toBe(0);
      expect(await imgCount({ personKey: kc, field: "address" })).toBe(1);
      // 剩餘欄再答 → 全刪
      const rest = await prisma.triageQuestion.findFirstOrThrow({ where: { personKey: kc, status: "open", groupKey: { endsWith: ":rest" } } });
      expect((await confirm(accountant, rest.id, { option: "apply_fields", fields: { address: { action: "skip" } } })).status).toBe(200);
      expect(await imgCount({ personKey: kc })).toBe(0);
    });

    it("4. 跳過保留：圖仍在，expires_at 縮到 ≤30 日；跳過後再答 → 即刪", async () => {
      const { sid, ka } = await seed();
      await put(sid, ka, "name_zh", 6, new Date(Date.now() + 170 * 86400000));
      const q = await qOf("name_not_confirmed", ka);
      expect((await confirm(accountant, q.id, { option: "skip" })).status).toBe(200);
      const row = await prisma.triageEvidenceImage.findFirstOrThrow({ where: { personKey: ka }, select: { expiresAt: true } });
      expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 86400000 + 5000);
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
      expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("skipped");
      expect((await confirm(accountant, q.id, { option: "use_package_name" })).status).toBe(200); // skipped 可再答
      expect(await imgCount({ personKey: ka, field: "name_zh" })).toBe(0);
    });

    it("5a. supersede(re-import)：同人同欄新題沿用舊圖（同 session）", async () => {
      const { sid, ka, pa, pb, pc } = await seed();
      await put(sid, ka, "name_zh", 7);
      const before = await prisma.triageQuestion.findFirstOrThrow({ where: { personKey: ka, kind: "name_not_confirmed" } });
      // 同一包再 apply：舊 open 題被作廢、新 open 題（新 row）建立喺同一 session
      const again = await applyPkg(accountant, [pa, pb, pc]);
      expect(again.status).toBe(200);
      expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: before.id } })).status).toBe("superseded");
      const fresh = await prisma.triageQuestion.findFirst({ where: { personKey: ka, kind: "name_not_confirmed", status: "open" } });
      expect(fresh).not.toBeNull();
      expect(fresh!.sessionId).toBe(sid);
      expect(await imgCount({ personKey: ka, field: "name_zh" })).toBe(1);
    });

    it("5b. supersede(key 輪換)：SESSION_SECRET 指紋唔同 → 舊 session open 題作廢、舊 person_key 嘅圖即刪", async () => {
      const { sid, ka, pa } = await seed();
      await put(sid, ka, "name_zh", 8);
      await prisma.triageSession.update({ where: { id: sid }, data: { keyFp: "00000000" } });
      const actor = { userId: fx.userIds["會計"], baseRole: "會計", roleId: fx.roleIds["會計"], tokenVersion: 0 } as unknown as AuthedSession;
      const other = pkgOf([person({ hkid: H[5], name: "導入測試員戊", nameStatus: "review", nos: ["U90055"] })], "2026-10-05T00:00:00.000Z");
      const parsed = importPackageSchema.parse(other);
      await createGuardImportTriage({ pkg: parsed, packageHash: hashPackage(parsed), actor, ip: null });
      expect((await prisma.triageQuestion.findFirstOrThrow({ where: { personKey: ka } })).status).toBe("superseded");
      expect(await imgCount({ sessionId: sid })).toBe(0);
      void pa;
    });

    it("6. session done 後漏網／孤兒：每日 job 清（孤兒＋過期）；registry 有登記；summary 淨計數", async () => {
      expect(JOBS).toContain(triageEvidenceCleanupJob);
      expect(triageEvidenceCleanupJob.defaultSchedule).toBe("30 3 * * *");
      const { sid, ka, kb } = await seed();
      await put(sid, ka, "name_zh", 9); // 甲 name_zh 仍有 open 題 → 保留
      await put(sid, ka, "dob", 10); // 甲冇 dob 題 → 孤兒
      await put(sid, kb, "hkid", 11, new Date(Date.now() - 1000)); // 過期
      await put(sid, "stray-person-key", "hkid", 12); // 完全冇題
      const r = await runTriageEvidenceCleanup(new Date());
      expect(r.summary).toEqual({ expired: 1, orphans: 2 });
      expect(await imgCount()).toBe(1);
      expect(await imgCount({ personKey: ka, field: "name_zh" })).toBe(1);
      expect(JSON.stringify(r)).not.toContain(ka);
      const aud = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_evidence_cleanup" } });
      expect(aud.after).toMatchObject({ expired: 1, orphans: 2 });
      // 冇嘢可清 → skipped
      expect((await runTriageEvidenceCleanup(new Date())).status).toBe("skipped");
      // session 全部答晒（done）後再有漏網圖 → job 清走
      for (const q of await prisma.triageQuestion.findMany({ where: { sessionId: sid, status: "open" } })) await prisma.triageQuestion.update({ where: { id: q.id }, data: { status: "answered" } });
      expect((await runTriageEvidenceCleanup(new Date())).summary).toEqual({ expired: 0, orphans: 1 });
      expect(await imgCount()).toBe(0);
    });

    it("deleteUnneeded 直接：冇 personKey 唔做嘢；只刪不被需要嘅欄", async () => {
      const { sid, ka } = await seed();
      await put(sid, ka, "name_zh", 13);
      await put(sid, ka, "hkid", 14);
      expect(await deleteUnneeded(prisma, sid, null)).toBe(0);
      expect(await deleteUnneeded(prisma, sid, ka)).toBe(1);
      expect(await imgCount({ personKey: ka })).toBe(1);
    });
  });

  describe("TE-2：題型→所需欄擴闊、印刷來源 priority 1–3、入職日期 hire_date", () => {
    const evq = (extra: object) => ({ v: 1, person: person({}), reasons: [], candidate_guard_ids: [], ...extra }) as never;
    it("requiredFieldsFor 映射（TE-3：只顯示有問題嗰個欄）：name_only_candidate／name_not_confirmed→name_zh（包內中文名冇值先退 name_en）；tel_only／dup_tel→phone；ext_identity_check→hkid（＋ext 欄）；no_id_card→hkid；ext 入職日期（hireDate／staffHire.*）→hire_date", () => {
      const f = (kind: string, extra: object = {}) => requiredFieldsFor({ kind, evidenceJson: evq(extra) }).sort();
      expect(f("name_only_candidate")).toEqual(["name_zh"]);
      expect(f("name_not_confirmed")).toEqual(["name_zh"]);
      // 包內中文名冇值 → 退到英文名
      const noZh = { person: { ...person({}), nameZh: { value: null, status: "missing" } } };
      expect(f("name_only_candidate", noZh)).toEqual(["name_en"]);
      expect(f("name_not_confirmed", noZh)).toEqual(["name_en"]);
      expect(f("name_not_confirmed", { person: { ...person({}), nameZh: { value: "  ", status: "review" } } })).toEqual(["name_en"]);
      expect(f("tel_only_candidate")).toEqual(["phone"]);
      expect(f("dup_tel_across_persons")).toEqual(["phone"]);
      expect(f("ext_identity_check")).toEqual(["hkid"]);
      expect(f("ext_identity_check", { ext_review: [{ key: "staffHire.U90001", check: "x", status: "review" }, { key: "siaPermit.no", check: "x", status: "review" }, { key: "bank", check: "x", status: "review" }] })).toEqual(["hire_date", "hkid", "permit_no"]);
      expect(f("no_id_card")).toEqual(["hkid"]);
      expect(f("ext_field_review", { ext_review: [{ key: "staffHire.U90001", check: "x", status: "review" }] })).toEqual(["hire_date"]);
      expect(f("ext_field_review", { ext_review: [{ key: "hireDate", check: "x", status: "review" }] })).toEqual(["hire_date"]);
      expect(f("staffno_shared_by_persons")).toEqual([]);
      expect(f("bank_review", { ext_review: [{ key: "bank", check: "x", status: "review" }] })).toEqual([]);
    });

    it("上載：hkid 身份證副本1＋印刷2＋入職表3 三張都收；第 4 張 over_limit；priority 同來源唔符、印刷用喺 name_zh→skipped_invalid；manifest 收 verify_score", async () => {
      const { pb, sid } = await seed(); // 乙：hkid_not_confirmed
      const m = matchOf(pb);
      const r = await upload(
        accountant,
        sid,
        await zipOf([
          { bytes: J(201), field: "hkid", doc_kind: "id_card", priority: 1, match: m },
          { bytes: J(202), field: "hkid", doc_kind: "printed", priority: 2, match: m },
          { bytes: J(203), field: "hkid", doc_kind: "onboarding_form", priority: 3, match: m },
          { bytes: J(204), field: "hkid", doc_kind: "onboarding_form", priority: 3, match: m }, // 第 4 張
          { bytes: J(205), field: "hkid", doc_kind: "printed", priority: 3, match: m }, // priority 同來源唔符
          { bytes: J(206), field: "name_zh", doc_kind: "printed", priority: 2, match: m }, // 印刷淨限 hkid
        ]),
      );
      expect(r.body).toMatchObject({ accepted_images: 3, skipped_over_limit: 1, skipped_invalid: 2 });
      const s2 = await getSession(accountant, sid);
      const q = s2.body.questions.find((x: { kind: string }) => x.kind === "hkid_not_confirmed");
      expect(q.evidence_images.map((i: { doc_kind: string; priority: number }) => `${i.priority}:${i.doc_kind}`)).toEqual(["1:id_card", "2:printed", "3:onboarding_form"]);
      // verify_score（可選淨數字）通過 strict schema；越界值／非數字拒絕
      const pr = (x: unknown) => evidenceManifestSchema.safeParse(x);
      expect(pr({ version: 1, items: [{ file: "a".repeat(16) + ".jpg", field: "hkid", doc_kind: "printed", priority: 2, match: { hkid: "Z900001(2)" }, verify_score: 0.93 }] }).success).toBe(true);
      expect(pr({ version: 1, items: [{ file: "a".repeat(16) + ".jpg", field: "hkid", doc_kind: "printed", priority: 4, match: { hkid: "Z900001(2)" } }] }).success).toBe(false);
      expect(pr({ version: 1, items: [{ file: "a".repeat(16) + ".jpg", field: "hkid", doc_kind: "printed", priority: 2, match: { hkid: "Z900001(2)" }, verify_score: 1.5 }] }).success).toBe(false);
      expect(pr({ version: 1, items: [{ file: "a".repeat(16) + ".jpg", field: "hkid", doc_kind: "printed", priority: 2, match: { hkid: "Z900001(2)" }, verify_score: "高" }] }).success).toBe(false);
    });

    /** 為某人造一條指定 kind 嘅 open 題（同 seed 人同 personKey） */
    const mkQ = async (sid: string, personKey: string, kind: string, evidence: object, over: object = {}) =>
      prisma.triageQuestion.create({ data: { sessionId: sid, kind, groupKey: `te2-${kind}-${Math.random().toString(36).slice(2)}`, personKey, sort: 50, title: kind, evidenceJson: evidence as never, optionsJson: [{ id: "skip", label: "skip" }] as never, ...over } });

    it("hire_date：ext_field_review（入職日期）題接受入職表圖（priority 1，最多 3）；GET 權限跟「保安員:view」——冇「保安員個人資料:view」仍睇到；題卡 evidence_images 帶 hire_date", async () => {
      const { pa, ka, sid } = await seed();
      const ev = (await qOf("name_not_confirmed", ka)).evidenceJson as object;
      await mkQ(sid, ka, "ext_field_review", { ...ev, ext_review: [{ key: "staffHire.U90001", check: "new", status: "review" }] });
      const m = matchOf(pa);
      const r = await upload(accountant, sid, await zipOf([
        { bytes: J(211), field: "hire_date", doc_kind: "onboarding_form", priority: 1, match: m },
        { bytes: J(212), field: "hire_date", doc_kind: "onboarding_form", priority: 1, match: m },
        { bytes: J(213), field: "hire_date", doc_kind: "id_card", priority: 1, match: m }, // 入職日期唔係身份證來源
      ]));
      expect(r.body).toMatchObject({ accepted_images: 2, skipped_invalid: 1 });
      const img = await prisma.triageEvidenceImage.findFirstOrThrow({ where: { field: "hire_date" }, select: { id: true } });
      const perm = await prisma.permission.findFirstOrThrow({ where: { module: "安員個人資料", action: "view" } });
      await prisma.rolePermission.updateMany({ where: { roleId: fx.roleIds["會計"], permissionId: perm.id }, data: { granted: false } });
      expect((await getImage(accountant, img.id)).status).toBe(200); // 非敏感
      const s2 = await getSession(accountant, sid);
      const q = s2.body.questions.find((x: { kind: string }) => x.kind === "ext_field_review");
      expect(q.evidence_images.map((i: { field: string }) => i.field)).toEqual(["hire_date", "hire_date"]);
      const caps = await viewableFields({ userId: fx.userIds["會計"], baseRole: "會計", roleId: fx.roleIds["會計"] } as unknown as AuthedSession);
      expect(caps.has("hire_date")).toBe(true);
      expect(caps.has("hkid")).toBe(false);
    });

    it("映射上載（TE-3）：name_only_candidate 只收 name_zh 圖（name_en 係 skipped_not_needed）；tel_only_candidate 收 phone 圖；其他欄 skipped_not_needed", async () => {
      const { pa, ka, sid } = await seed();
      const ev = (await qOf("name_not_confirmed", ka)).evidenceJson as object;
      await prisma.triageQuestion.updateMany({ where: { personKey: ka }, data: { status: "answered" } });
      await mkQ(sid, ka, "name_only_candidate", ev);
      await mkQ(sid, ka, "tel_only_candidate", ev);
      const m = matchOf(pa);
      const r = await upload(accountant, sid, await zipOf([
        { bytes: J(221), field: "name_zh", doc_kind: "id_card", priority: 1, match: m },
        { bytes: J(222), field: "name_en", doc_kind: "id_card", priority: 1, match: m },
        { bytes: J(223), field: "phone", doc_kind: "onboarding_form", priority: 1, match: m },
        { bytes: J(224), field: "hkid", doc_kind: "id_card", priority: 1, match: m }, // 呢兩題唔需要 hkid
        { bytes: J(225), field: "dob", doc_kind: "id_card", priority: 1, match: m },
      ]));
      expect(r.body).toMatchObject({ accepted_images: 2, skipped_not_needed: 3 });
    });

    it("(8) 答題即刪：no_id_card（淨 hkid）——多餘欄（name／dob／phone）嘅舊圖讀取時唔顯示、GET 404、答咗題一併當孤兒刪；hkid 圖答咗即刪", async () => {
      const { sid } = await seed();
      // 無證嘅人：no_id_card 題
      const pn = person({ hkid: null, name: "導入測試員無證", nos: ["U90003"], rating: "fail" });
      const r0 = await applyPkg(accountant, [pn]);
      expect(r0.status).toBe(200);
      const sid2 = r0.body.triage.session_id as string;
      const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid2, kind: "no_id_card" } });
      const kn = qn.personKey!;
      const put = async (field: "hkid" | "name_zh" | "name_en" | "dob" | "phone", n: number, session = sid2, key = kn) => {
        const plain = J(n);
        await insertEvidenceImage(prisma, { sessionId: session, questionId: null, personKey: key, guardId: null, field, docKind: field === "phone" ? "onboarding_form" : "id_card", priority: 1, plain, info: inspectImage(plain)!, createdBy: fx.userIds["會計"], expiresAt: new Date(Date.now() + 1e9) });
      };
      for (const [i, f] of (["hkid", "name_zh", "name_en", "dob"] as const).entries()) await put(f, 230 + i);
      await put("phone", 235); // no_id_card 唔需要 phone
      expect(await imgCount({ sessionId: sid2 })).toBe(5);
      expect([...requiredFieldsFor(qn)].sort()).toEqual(["hkid", "page"]); // rating fail 人另加整頁原稿（TE-7）
      // 讀取時只回 hkid 圖（舊版上載過嘅多餘欄圖唔顯示），多餘欄圖 GET 404
      const sv = await getSession(accountant, sid2);
      const qv = sv.body.questions.find((x: { kind: string }) => x.kind === "no_id_card");
      expect(qv.evidence_images.map((i: { field: string }) => i.field)).toEqual(["hkid"]);
      const extra = await prisma.triageEvidenceImage.findFirstOrThrow({ where: { sessionId: sid2, field: "name_zh" }, select: { id: true } });
      expect((await getImage(accountant, extra.id)).status).toBe(404);
      const own = await prisma.triageEvidenceImage.findFirstOrThrow({ where: { sessionId: sid2, field: "hkid" }, select: { id: true } });
      expect((await getImage(accountant, own.id)).status).toBe(200);
      const ans = { option: "enter_hkid", value: H[9] };
      const res = await confirm(accountant, qn.id, ans);
      expect(res.status).toBe(200);
      expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } })).status).toBe("answered");
      // hkid 圖刪；冇題需要嘅其他欄舊圖亦一併刪（孤兒）
      expect(await imgCount({ sessionId: sid2 })).toBe(0);
      void sid;
    });

    it("TE-3(2) 冇姓名嘅無證人：requiredFieldsFor 加 name_zh＋name_en；預覽返 needs_fields＋reason_text；補 extra 先寫入（建檔帶姓名），唔補 → 422；答咗 hkid＋兩個姓名圖都刪", async () => {
      await seed();
      const base = person({ hkid: null, name: "x", nos: ["U90021"], rating: "fail" });
      const pn = { ...base, nameZh: F(null, "missing"), nameEn: F(null, "missing") } as PackagePerson;
      const r0 = await applyPkg(accountant, [pn]);
      expect(r0.status).toBe(200);
      const sid2 = r0.body.triage.session_id as string;
      const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid2, kind: "no_id_card" } });
      expect([...requiredFieldsFor(qn)].sort()).toEqual(["hkid", "name_en", "name_zh", "page"]);
      for (const [i, f] of (["hkid", "name_zh", "name_en"] as const).entries()) {
        const plain = J(250 + i);
        await insertEvidenceImage(prisma, { sessionId: sid2, questionId: null, personKey: qn.personKey!, guardId: null, field: f, docKind: "id_card", priority: 1, plain, info: inspectImage(plain)!, createdBy: fx.userIds["會計"], expiresAt: new Date(Date.now() + 1e9) });
      }
      const sv = await getSession(accountant, sid2);
      expect(sv.body.questions.find((x: { kind: string }) => x.kind === "no_id_card").evidence_images.map((i: { field: string }) => i.field).sort()).toEqual(["hkid", "name_en", "name_zh"]);
      const prev = async (ans: unknown) => (await json(previewRoute as never, `/api/triage/questions/${qn.id}/preview`, accountant, { answer: ans }, qn.id)).json();
      // 預覽：未補姓名 → 唔可以確認，帶 needs_fields＋人話 reason_text
      const p1 = await prev({ option: "enter_hkid", value: H[9] });
      expect(p1.impact.can_confirm).toBe(false);
      expect(p1.impact.needs_fields).toEqual([
        { field: "name_zh", label: "中文姓名", required: true },
        { field: "name_en", label: "英文姓名", required: false },
      ]);
      expect(p1.impact.reason_text.length).toBeGreaterThan(5);
      expect(p1.impact.reason_text).not.toMatch(/create_no_name/);
      // 直接答（冇 extra）→ 422，唔寫任何嘢
      const bad = await json(answerRoute as never, `/api/triage/questions/${qn.id}/answer`, accountant, { answer: { option: "enter_hkid", value: H[9] }, preview_hash: p1.preview_hash }, qn.id);
      expect(bad.status).toBe(422);
      expect(await prisma.guard.count({ where: { hkid: H[9] } })).toBe(0);
      // 預覽同答題用同一套 code path：補 extra 之後預覽可確認
      const ans = { option: "enter_hkid", value: H[9], extra: { name_zh: "補名測試員", name_en: "BO MING" } };
      const p2 = await prev(ans);
      expect(p2.impact.can_confirm).toBe(true);
      expect(p2.impact.needs_fields).toBeUndefined();
      const ok = await json(answerRoute as never, `/api/triage/questions/${qn.id}/answer`, accountant, { answer: ans, preview_hash: p2.preview_hash }, qn.id);
      expect(ok.status).toBe(200);
      const g = await prisma.guard.findFirstOrThrow({ where: { hkid: H[9] }, select: { nameZh: true, nameEn: true } });
      expect(g.nameZh).toBe("補名測試員");
      expect(g.nameEn).toBe("BO MING");
      // audit 只記 extra 嘅 key，唔記姓名
      const au = await prisma.auditLog.findMany({ where: { tableName: "triage_questions", rowId: qn.id } });
      expect(JSON.stringify(au)).not.toContain("補名測試員");
      expect(await imgCount({ sessionId: sid2 })).toBe(0); // hkid＋兩個姓名圖答咗即刪
    });

    it("TE-3 S1：包內姓名已確認嘅人，answer／preview 帶 extra 姓名 → 400（唔准人手蓋已確認姓名）", async () => {
      await seed();
      const pn = person({ hkid: null, name: "導入測試員有名", nos: ["U90031"], rating: "fail" });
      const r0 = await applyPkg(accountant, [pn]);
      expect(r0.status).toBe(200);
      const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: r0.body.triage.session_id as string, kind: "no_id_card" } });
      const res = await json(previewRoute as never, `/api/triage/questions/${qn.id}/preview`, accountant, { answer: { option: "enter_hkid", value: H[9], extra: { name_zh: "另一個名" } } }, qn.id);
      expect(res.status).toBe(400);
      const ok = await json(previewRoute as never, `/api/triage/questions/${qn.id}/preview`, accountant, { answer: { option: "enter_hkid", value: H[9] } }, qn.id);
      expect(ok.status).toBe(200);
    });

    it("TE-4.2 S1：包內出生日期已確認——extra.dob 唔同 400、相同當冇事", async () => {
      await seed();
      const base = person({ hkid: null, name: "x", nos: ["U90041"], rating: "fail" }); // person() 出生日期 1990-05-06 confirmed
      const pn = { ...base, nameZh: F(null, "missing"), nameEn: F(null, "missing") } as PackagePerson;
      const r0 = await applyPkg(accountant, [pn]);
      const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: r0.body.triage.session_id as string, kind: "no_id_card" } });
      const pv = (extra: object) => json(previewRoute as never, `/api/triage/questions/${qn.id}/preview`, accountant, { answer: { option: "enter_hkid", value: H[9], extra: { name_zh: "補名測試員", ...extra } } }, qn.id);
      expect((await pv({ dob: "1991-02-03" })).status).toBe(400);
      expect((await pv({ dob: "1990-05-06" })).status).toBe(200);
      // N1：包內值帶空白（格式唔同但同一日）→ 唔應 400
      const q2 = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } });
      const ev = q2.evidenceJson as { person: { dateOfBirth: { value: string; status: string } } };
      ev.person.dateOfBirth = { value: " 1990-05-06 ", status: "confirmed" };
      await prisma.triageQuestion.update({ where: { id: qn.id }, data: { evidenceJson: ev as never } });
      expect((await pv({ dob: "1990-05-06" })).status).toBe(200);
      expect((await pv({ dob: "1990-05-07" })).status).toBe(400);
    });

    describe("TE-9 身份證號屬系統內現有保安員：連結（唔准建新人）", () => {
      async function setup9() {
        await seed();
        const owner9 = await prisma.guard.create({ data: { nameZh: "既有在職保安員甲", employmentType: "cash_casual", hkid: H[9], createdBy: "t" } });
        await prisma.guardStaffNumber.create({ data: { guardId: owner9.id, scheme: "U", number: "U90091", status: "current" } });
        const orphanBase = person({ hkid: null, name: "x", nos: [], rating: "fail" });
        const orphan = { ...orphanBase, nameZh: F(null, "missing"), nameEn: F(null, "missing"), dateOfBirth: F(null, "missing"), address: F(null, "missing"), phone: F(null, "missing") } as PackagePerson;
        const r0 = await applyPkg(accountant, [orphan]);
        const sid2 = r0.body.triage.session_id as string;
        const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid2, kind: "no_id_card" } });
        const plain = J(441);
        await insertEvidenceImage(prisma, { sessionId: sid2, questionId: null, personKey: qn.personKey!, guardId: null, field: "hkid", docKind: "printed", priority: 2, plain, info: inspectImage(plain)!, createdBy: fx.userIds["會計"], expiresAt: new Date(Date.now() + 1e9) });
        const call = (route: unknown, url: string, body: unknown, cookie = owner) => json(route as never, `/api/triage/questions/${qn.id}/${url}`, cookie, body, qn.id);
        const prev = async (extra?: object, cookie = owner) => {
          const res = await call(previewRoute, "preview", { answer: { option: "enter_hkid", value: H[9], ...(extra ? { extra } : {}) } }, cookie);
          return { status: res.status, body: await res.json() };
        };
        return { owner9, sid2, qn, call, prev };
      }

      it("preview：hkid 等於唯一一位現有保安員（唔喺候選）→ needs_decision hkid_matches_existing_guard、候選卡標 same_hkid、只可 link／skip、人話 reason_text；號碼格式（括號／小寫）唔影響", async () => {
        const { owner9, prev, call } = await setup9();
        const p = await prev();
        expect(p.status).toBe(200);
        expect(p.body.writes).toBe(false);
        expect(p.body.impact.can_confirm).toBe(false);
        expect(p.body.impact.needs_decision).toMatchObject({ reason: "hkid_matches_existing_guard", options: ["link", "skip"] });
        expect(p.body.impact.needs_decision.candidates).toHaveLength(1);
        expect(p.body.impact.needs_decision.candidates[0]).toMatchObject({ guard_id: owner9.id, same_hkid: true, has_hkid: true, staff_numbers: ["U90091"] });
        expect(p.body.impact.reason_text).toContain("已屬於系統內一位保安員");
        const lower = await call(previewRoute, "preview", { answer: { option: "enter_hkid", value: `${H[9]!.slice(0, -1)}(${H[9]!.slice(-1)})`.toLowerCase() } });
        expect((await lower.json()).impact.needs_decision.reason).toBe("hkid_matches_existing_guard");
      });

      it("冇「個人資料:view＋保安員:update」→ options 淨 skip；link 403", async () => {
        const { qn } = await setup9();
        const actor = { userId: fx.userIds["老闆"], baseRole: "老闆", roleId: fx.roleIds["老闆"], tokenVersion: 0 } as unknown as AuthedSession;
        const full = await viewerCaps(actor);
        const q0 = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } });
        const base = { option: "enter_hkid", value: H[9] } as const;
        expect((await previewAnswer(actor, q0, base, { ...full, pii: false }, null)).impact.needs_decision?.options).toEqual(["skip"]);
        expect((await previewAnswer(actor, q0, base, full, null)).impact.needs_decision?.options).toEqual(["link", "skip"]);
      });

      it("唔准建新人：extra.create_new → 400；冇 link 直接答 → 422；連去無關保安員（名／號碼都唔同）→ 400", async () => {
        const { prev, call } = await setup9();
        expect((await prev({ create_new: true })).status).toBe(400);
        const pv = await prev();
        const direct = await call(answerRoute, "answer", { answer: { option: "enter_hkid", value: H[9] }, preview_hash: pv.body.preview_hash });
        expect(direct.status).toBe(422);
        const stranger = await prisma.guard.create({ data: { nameZh: "無關路人乙", employmentType: "cash_casual", createdBy: "t" } });
        expect((await prev({ link_guard_id: stranger.id })).status).toBe(400);
      });

      it("link：連結成功——唔新增人、guard 身份證號不變、題 answered、圖答題即刪（M5）、audit 記 link decision", async () => {
        const { owner9, sid2, qn, call, prev } = await setup9();
        const before = await prisma.guard.count();
        const p = await prev({ link_guard_id: owner9.id });
        expect(p.status).toBe(200);
        expect(p.body.impact.can_confirm).toBe(true);
        expect(p.body.impact.needs_decision).toBeUndefined();
        const res = await call(answerRoute, "answer", { answer: { option: "enter_hkid", value: H[9], extra: { link_guard_id: owner9.id } }, preview_hash: p.body.preview_hash });
        expect(res.status).toBe(200);
        expect(await prisma.guard.count()).toBe(before);
        expect((await prisma.guard.findUniqueOrThrow({ where: { id: owner9.id }, select: { hkid: true } })).hkid).toBe(H[9]);
        expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } })).status).toBe("answered");
        expect(await imgCount({ sessionId: sid2 })).toBe(0);
        const au = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_answer", rowId: qn.id } });
        expect(au.after).toMatchObject({ decision: "link", link_guard_id: owner9.id });
      });

      it("資料異常：同一個身份證號（canonical）屬兩位保安員（寫法唔同）→ preview 回人話＋導航卡「去處理重複保安員」（href 唔帶個人資料）、冇連結選項；冇個人資料 view 唔出導航；直接答 422", async () => {
        const { prev, owner9, qn, call } = await setup9();
        await prisma.guard.update({ where: { id: owner9.id }, data: { hkid: `${H[9]!.slice(0, -1)}(${H[9]!.slice(-1)})` } });
        await prisma.guard.create({ data: { nameZh: "重複號碼乙", employmentType: "cash_casual", hkid: H[9], createdBy: "t" } });
        const p = await prev();
        expect(p.status).toBe(200);
        expect(p.body.writes).toBe(false);
        expect(p.body.impact).toMatchObject({ can_confirm: false, nav: { label: "去處理重複保安員", href: "/guards" } });
        expect(p.body.impact.reason_text).toContain("多位保安員");
        expect(p.body.impact.needs_decision).toBeUndefined();
        expect(JSON.stringify(p.body.impact.nav)).not.toContain(H[9]!);
        const actor = { userId: fx.userIds["老闆"], baseRole: "老闆", roleId: fx.roleIds["老闆"], tokenVersion: 0 } as unknown as AuthedSession;
        const q0 = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } });
        const noPii = await previewAnswer(actor, q0, { option: "enter_hkid", value: H[9] }, { ...(await viewerCaps(actor)), pii: false }, null);
        expect(noPii.impact.nav).toBeUndefined();
        expect((await call(answerRoute, "answer", { answer: { option: "enter_hkid", value: H[9] }, preview_hash: p.body.preview_hash })).status).toBe(422);
      });

      it("S2：連結時輸入嘅姓名同目標保安員現有姓名唔同 → preview note（保留／將覆蓋，按實際寫入變更）；相同姓名冇 note", async () => {
        const { prev, owner9 } = await setup9();
        const diff = await prev({ link_guard_id: owner9.id, name_zh: "完全另一個名字" });
        expect(diff.status).toBe(200);
        const note = (diff.body.impact.notes as string[]).find((n) => n.includes("輸入嘅姓名同現有紀錄唔同"));
        expect(note).toBeTruthy();
        const overwrites = (diff.body.impact.changes as { table: string; action: string; fields: { label: string; from: string | null }[] }[]).some((c) => c.table === "guards" && c.fields.some((f) => f.label === "中文姓名" && f.from !== null));
        expect(note).toContain(overwrites ? "將覆蓋" : "保留現有姓名");
        const same = await prev({ link_guard_id: owner9.id, name_zh: "既有在職保安員甲" });
        expect((same.body.impact.notes as string[]).some((n) => n.includes("輸入嘅姓名同現有紀錄唔同"))).toBe(false);
      });
    });

    describe("TE-8 錯圖撤回／取代上載", () => {
      const withdraw = (cookie: string, id: string, body: unknown = { reason: "wrong" }) => withdrawRoute(new Request(`http://t/api/triage/evidence-images/${id}/withdraw`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);

      it("撤回：軟刪（bytes 清空）、DTO／GET 唔再回、audit 只記 id＋原因碼、重上載同 sha 計 skipped_withdrawn；冇權限／非法原因被拒", async () => {
        const { pb, sid } = await seed();
        const m = matchOf(pb);
        const a = J(401);
        const b = J(402);
        const up = await upload(accountant, sid, await zipOf([{ bytes: a, field: "hkid", doc_kind: "printed", priority: 2, match: m }, { bytes: b, field: "hkid", doc_kind: "id_card", priority: 1, match: m }]));
        expect(up.body.accepted_images).toBe(2);
        const rowA = await prisma.triageEvidenceImage.findFirstOrThrow({ where: { sessionId: sid, docKind: "printed" } });
        expect((await withdraw(broker, rowA.id)).status).toBe(403);
        expect((await withdraw(accountant, rowA.id, { reason: "bad" })).status).toBe(400);
        expect((await withdraw(accountant, rowA.id)).status).toBe(200);
        const after = await prisma.triageEvidenceImage.findUniqueOrThrow({ where: { id: rowA.id } });
        expect(after.withdrawnAt).not.toBeNull();
        expect(after.withdrawnReason).toBe("wrong");
        expect(after.imageBytes.length).toBe(0);
        const q = (await getSession(owner, sid)).body.questions.find((x: { kind: string; evidence: { person: { hkid: unknown } } }) => x.kind === "hkid_not_confirmed");
        expect(q.evidence_images.map((i: { doc_kind: string }) => i.doc_kind)).toEqual(["id_card"]);
        expect((await getImage(owner, rowA.id)).status).toBe(404);
        expect((await withdraw(accountant, rowA.id)).status).toBe(404); // 已撤回
        const au = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_evidence_withdraw", tableName: "triage_questions" } });
        expect(au.after).toMatchObject({ image_id: rowA.id, field: "hkid", doc_kind: "printed", reason: "wrong" });
        expect(JSON.stringify(au.after)).not.toContain(H[2]!);
        // 重上載同一張 → skipped_withdrawn（唔會再出現）
        const again = await upload(accountant, sid, await zipOf([{ bytes: a, field: "hkid", doc_kind: "printed", priority: 2, match: m }]));
        expect(again.body).toMatchObject({ accepted_images: 0, skipped_withdrawn: 1 });
        expect(await imgCount({ sessionId: sid, withdrawnAt: null })).toBe(1);
      });

      it("取代模式 replace：manifest 有圖嘅人，同欄同 doc_kind 嘅舊圖（sha 唔喺今次）軟刪；其他欄／其他 doc_kind／manifest 冇嘅人唔受影響；dry 唔刪只計 would_withdraw", async () => {
        const { pa, pb, sid } = await seed();
        const mb = matchOf(pb);
        const oldP = J(411);
        const idImg = J(412);
        const nameImg = J(413);
        await upload(accountant, sid, await zipOf([{ bytes: oldP, field: "hkid", doc_kind: "printed", priority: 2, match: mb }, { bytes: idImg, field: "hkid", doc_kind: "id_card", priority: 1, match: mb }, { bytes: nameImg, field: "name_zh", doc_kind: "id_card", priority: 1, match: matchOf(pa) }]));
        expect(await imgCount({ sessionId: sid })).toBe(3);
        const newP = J(414);
        const mk = async () => {
          const f = entryName(newP);
          return buildZip({ [f]: newP, "manifest.json": JSON.stringify({ version: 1, items: [{ file: f, field: "hkid", doc_kind: "printed", priority: 2, match: mb }], replace: [{ doc_kind: "printed", field: "hkid" }] }) });
        };
        const dry = await upload(accountant, sid, await mk(), true);
        expect(dry.body).toMatchObject({ accepted_images: 1, would_withdraw: 1 });
        expect(await imgCount({ sessionId: sid, withdrawnAt: null })).toBe(3); // dry 唔刪
        const r = await upload(accountant, sid, await mk());
        expect(r.body).toMatchObject({ accepted_images: 1, would_withdraw: 1 });
        const rows = await prisma.triageEvidenceImage.findMany({ where: { sessionId: sid }, select: { docKind: true, field: true, withdrawnAt: true, withdrawnReason: true, sha256: true } });
        const withdrawn = rows.filter((x) => x.withdrawnAt);
        expect(withdrawn).toHaveLength(1);
        expect(withdrawn[0]).toMatchObject({ docKind: "printed", field: "hkid", withdrawnReason: "replaced_by_upload" });
        expect(rows.filter((x) => !x.withdrawnAt).map((x) => `${x.docKind}:${x.field}`).sort()).toEqual(["id_card:hkid", "id_card:name_zh", "printed:hkid"]);
        const au = await prisma.auditLog.findMany({ where: { action: "triage_evidence_withdraw", tableName: "triage_evidence_images" } });
        expect(au).toHaveLength(1);
        expect(au[0]!.after).toMatchObject({ reason: "replaced_by_upload", field: "hkid", doc_kind: "printed" });
        // 同一個 manifest 再上載：新圖已存在（重複），舊圖冇嘢可取代
        const r2 = await upload(accountant, sid, await mk());
        expect(r2.body).toMatchObject({ accepted_images: 0, would_withdraw: 0, skipped_duplicate: 1 });
      });

      it("取代模式 M1：冇新圖頂替就唔軟刪——manifest 只有 people[]；新圖唔合格（超大）→ would_withdraw 0、舊圖保留", async () => {
        const { pb, sid } = await seed();
        const mb = matchOf(pb);
        await upload(accountant, sid, await zipOf([{ bytes: J(421), field: "hkid", doc_kind: "printed", priority: 2, match: mb }]));
        const docRef = { file_name: "x.pdf", page_count: 1, pages_by_kind: {} };
        // (a) 只有 people[]（冇 items）
        const onlyPeople = await buildZip({ "manifest.json": JSON.stringify({ version: 1, items: [], replace: [{ doc_kind: "printed", field: "hkid" }], people: [{ match: mb, doc_ref: docRef }] }) });
        expect((await upload(accountant, sid, onlyPeople, true)).body.would_withdraw).toBe(0);
        expect((await upload(accountant, sid, onlyPeople)).body.would_withdraw).toBe(0);
        expect(await imgCount({ sessionId: sid, withdrawnAt: null })).toBe(1);
        // (b) 新圖唔合格（>120 KB 裁圖規格）
        const big = fakeJpeg(320, 80, { seed: 422, pad: 130 * 1024 });
        const f = entryName(big);
        const bad = await buildZip({ [f]: big, "manifest.json": JSON.stringify({ version: 1, items: [{ file: f, field: "hkid", doc_kind: "printed", priority: 2, match: mb }], replace: [{ doc_kind: "printed", field: "hkid" }] }) });
        for (const dry of [true, false]) expect((await upload(accountant, sid, bad, dry)).body).toMatchObject({ accepted_images: 0, skipped_invalid_image: 1, would_withdraw: 0 });
        expect(await imgCount({ sessionId: sid, withdrawnAt: null })).toBe(1);
        // (c) 新圖身份對唔上（match 錯）→ 唔計
        const other = await buildZip({ [entryName(J(423))]: J(423), "manifest.json": JSON.stringify({ version: 1, items: [{ file: entryName(J(423)), field: "hkid", doc_kind: "printed", priority: 2, match: { hkid: H[7], staff_numbers: ["U99999"] } }], replace: [{ doc_kind: "printed", field: "hkid" }] }) });
        expect((await upload(accountant, sid, other)).body.would_withdraw).toBe(0);
        expect(await imgCount({ sessionId: sid, withdrawnAt: null })).toBe(1);
      });

      it("S2：被取代上載軟刪嘅圖，同 sha 重上載＝恢復（原 row、audit restored、GET 得）；人手撤回（wrong）嘅仍然 skipped_withdrawn", async () => {
        const { pb, sid } = await seed();
        const mb = matchOf(pb);
        const oldP = J(431);
        const newP = J(432);
        const item = (b: Uint8Array, extra: object = {}) => zipOf([{ bytes: b, field: "hkid", doc_kind: "printed", priority: 2, match: mb }], {}).then(async (z) => {
          void extra;
          return z;
        });
        await upload(accountant, sid, await item(oldP));
        const rowOld = await prisma.triageEvidenceImage.findFirstOrThrow({ where: { sessionId: sid, docKind: "printed" } });
        const replaceZip = async (b: Uint8Array) => {
          const f = entryName(b);
          return buildZip({ [f]: b, "manifest.json": JSON.stringify({ version: 1, items: [{ file: f, field: "hkid", doc_kind: "printed", priority: 2, match: mb }], replace: [{ doc_kind: "printed", field: "hkid" }] }) });
        };
        expect((await upload(accountant, sid, await replaceZip(newP))).body).toMatchObject({ accepted_images: 1, would_withdraw: 1 });
        expect((await prisma.triageEvidenceImage.findUniqueOrThrow({ where: { id: rowOld.id } })).withdrawnReason).toBe("replaced_by_upload");
        // 舊圖重上載（唔帶 replace）→ 恢復
        const back = await upload(accountant, sid, await item(oldP));
        expect(back.body).toMatchObject({ accepted_images: 1, skipped_withdrawn: 0 });
        const restored = await prisma.triageEvidenceImage.findUniqueOrThrow({ where: { id: rowOld.id } });
        expect(restored.withdrawnAt).toBeNull();
        expect(restored.withdrawnReason).toBeNull();
        expect(restored.imageBytes.length).toBeGreaterThan(0);
        expect((await getImage(owner, rowOld.id)).status).toBe(200);
        expect(await prisma.triageEvidenceImage.count({ where: { sessionId: sid } })).toBe(2); // 冇多 insert
        const au = await prisma.auditLog.findMany({ where: { action: "triage_evidence_withdraw", tableName: "triage_evidence_images", rowId: rowOld.id } });
        expect(au.map((x) => (x.after as { reason: string }).reason).sort()).toEqual(["replaced_by_upload", "restored"]);
        // 人手撤回（wrong）嘅唔恢復
        expect((await withdraw(accountant, rowOld.id)).status).toBe(200);
        expect((await upload(accountant, sid, await item(oldP))).body).toMatchObject({ accepted_images: 0, skipped_withdrawn: 1 });
      });
    });

    describe("TE-7 整頁原稿暫存圖＋doc_ref（抽取失敗人）", () => {
      /** 全欄 missing、冇身份證號、冇工號嘅人（抽取失敗）→ no_id_card 題 */
      async function setupFailed() {
        await seed();
        const base = person({ hkid: null, name: "x", nos: [], rating: "fail" });
        const pf = { ...base, nameZh: F(null, "missing"), nameEn: F(null, "missing"), dateOfBirth: F(null, "missing"), address: F(null, "missing"), phone: F(null, "missing") } as PackagePerson;
        const r0 = await applyPkg(accountant, [pf]);
        expect(r0.status).toBe(200);
        const sid2 = r0.body.triage.session_id as string;
        const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid2, kind: "no_id_card" } });
        const match = { package_key: pf.key };
        const page = (n: number, o: { pad?: number; w?: number; h?: number } = {}) => fakeJpeg(o.w ?? 1200, o.h ?? 1600, { seed: 300 + n, pad: o.pad ?? 300 * 1024 });
        const docRef = { file_name: "測試檔案夾/入職文件.pdf", page_count: 3, pages_by_kind: { application_form: 1, other: 2 } };
        const zipPages = async (pages: { bytes: Uint8Array; no: number }[], extra: object = {}) => {
          const entries: Record<string, Uint8Array | string> = {};
          const items = pages.map((p) => {
            const file = entryName(p.bytes);
            entries[file] = p.bytes;
            return { file, field: "page", doc_kind: "full_page", priority: 1, page_no: p.no, match };
          });
          entries["manifest.json"] = JSON.stringify({ version: 1, items, people: [{ match, doc_ref: docRef }], ...extra });
          return buildZip(entries);
        };
        return { pf, sid2, qn, match, page, docRef, zipPages };
      }

      it("requiredFieldsFor：抽取失敗人（rating fail，或全欄 missing 冇工號）＋建人／核對類題型加 page；rating 非 fail 而且有資料就唔加", () => {
        const ev = (person: object) => ({ v: 1, person, reasons: [], candidate_guard_ids: [] }) as never;
        const empty = { ...person({ hkid: null, name: "x" }), nameZh: F(null, "missing"), nameEn: F(null, "missing"), dateOfBirth: F(null, "missing"), address: F(null, "missing"), phone: F(null, "missing"), staffNumbers: [] };
        for (const kind of ["no_id_card", "hkid_not_confirmed", "ext_identity_check", "name_only_candidate", "field_review"]) expect(requiredFieldsFor({ kind, evidenceJson: ev(empty) } as never)).toContain("page");
        const some = { ...empty, phone: F("91234567", "review") };
        const withNo = { ...empty, staffNumbers: [{ scheme: "U", number: "U1" }] };
        // rating ok：有資料／有工號 → 唔需要；全空冇工號 → 需要
        expect(requiredFieldsFor({ kind: "no_id_card", evidenceJson: ev({ ...some, rating: "auto_ok" }) } as never)).not.toContain("page");
        expect(requiredFieldsFor({ kind: "no_id_card", evidenceJson: ev({ ...withNo, rating: "review" }) } as never)).not.toContain("page");
        expect(requiredFieldsFor({ kind: "no_id_card", evidenceJson: ev({ ...empty, rating: "auto_ok" }) } as never)).toContain("page");
        // rating fail：即使有 1–3 個欄有值／有工號，都屬抽取失敗人 → 需要
        expect(requiredFieldsFor({ kind: "no_id_card", evidenceJson: ev({ ...some, rating: "fail" }) } as never)).toContain("page");
        expect(requiredFieldsFor({ kind: "hkid_not_confirmed", evidenceJson: ev({ ...withNo, rating: "fail" }) } as never)).toContain("page");
        expect(requiredFieldsFor({ kind: "tel_only_candidate", evidenceJson: ev(empty) } as never)).not.toContain("page");
      });

      it("manifest 驗證：page 項要有 page_no、field=page 同 doc_kind=full_page 要成對；package_key 單獨可作 match", async () => {
        const { page, match, zipPages } = await setupFailed();
        const b = page(1);
        const f = entryName(b);
        const mk = (item: object) => buildZip({ [f]: b, "manifest.json": JSON.stringify({ version: 1, items: [{ file: f, priority: 1, match, ...item }] }) });
        await expect(readEvidenceZip(await mk({ field: "page", doc_kind: "full_page" }))).rejects.toMatchObject({ status: 400 }); // 冇 page_no
        await expect(readEvidenceZip(await mk({ field: "hkid", doc_kind: "full_page", page_no: 1 }))).rejects.toMatchObject({ status: 400 });
        await expect(readEvidenceZip(await mk({ field: "page", doc_kind: "id_card", page_no: 1 }))).rejects.toMatchObject({ status: 400 });
        const ok = await readEvidenceZip(await zipPages([{ bytes: b, no: 1 }]));
        expect(ok.manifest.items).toHaveLength(1);
        expect(ok.images.get(f)!.byteLength).toBeGreaterThan(120 * 1024); // 整頁放寬到 400 KB
      });

      it("上載：尺寸／大小規格（≤400 KB、長邊 ≤1600）、頁數上限 8（另計）、doc_ref 寫入唔覆蓋；dry 同 apply 同計數；圖加密落庫帶 page_no", async () => {
        const { sid2, page, zipPages, qn } = await setupFailed();
        const good = [1, 2].map((n) => ({ bytes: page(n), no: n }));
        const zip = await zipPages([...good, { bytes: page(3, { pad: 410 * 1024 }), no: 3 }, { bytes: page(4, { w: 1000, h: 1700 }), no: 4 }]);
        const dry = await upload(accountant, sid2, zip, true);
        expect(dry.status).toBe(200);
        expect(dry.body).toMatchObject({ accepted_images: 2, skipped_invalid_image: 2, doc_refs_set: 1 });
        expect(await imgCount({ sessionId: sid2, field: "page" })).toBe(0);
        const r = await upload(accountant, sid2, zip);
        expect(r.body).toMatchObject({ accepted_images: 2, skipped_invalid_image: 2, doc_refs_set: 1 });
        const rows = await prisma.triageEvidenceImage.findMany({ where: { sessionId: sid2, field: "page" }, orderBy: { pageNo: "asc" } });
        expect(rows.map((x) => [x.pageNo, x.docKind, x.priority])).toEqual([[1, "full_page", 1], [2, "full_page", 1]]);
        expect(Buffer.from(rows[0]!.imageBytes).includes(Buffer.from("JFIF"))).toBe(false); // 密文
        // doc_ref 寫入題目 evidence；再上載唔同 doc_ref 唔覆蓋
        const q1 = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } });
        expect((q1.evidenceJson as { doc_ref?: { page_count: number } }).doc_ref?.page_count).toBe(3);
        const again = await zipPages([{ bytes: page(6), no: 6 }]);
        const r2 = await upload(accountant, sid2, again);
        expect(r2.body.doc_refs_set).toBe(0); // 已有 doc_ref＝只補唔覆蓋
        expect(((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } })).evidenceJson as { doc_ref: { file_name: string } }).doc_ref.file_name).toBe("測試檔案夾/入職文件.pdf");
        expect(await imgCount({ sessionId: sid2, field: "page" })).toBe(3);
      });

      it("每人 ≤8 頁（另計，唔食 18 張裁圖額度）", async () => {
        const { sid2, page, zipPages } = await setupFailed();
        const r = await upload(accountant, sid2, await zipPages(Array.from({ length: 10 }, (_, i) => ({ bytes: page(10 + i), no: i + 1 }))));
        expect(r.body).toMatchObject({ accepted_images: 8, skipped_over_limit: 2 });
      });

      it("權限：整頁原稿要「個人資料:view」＋「銀行資料:view」；冇權限嘅人 DTO 唔回圖、回頁數；GET 圖 403；有權限（老闆）見到圖＋可讀", async () => {
        const { sid2, page, zipPages, qn } = await setupFailed();
        await upload(accountant, sid2, await zipPages([1, 2, 3].map((n) => ({ bytes: page(20 + n), no: n }))));
        const ownerView = await getSession(owner, sid2);
        const qo = ownerView.body.questions.find((x: { id: string }) => x.id === qn.id);
        expect(qo.evidence_images.filter((i: { field: string }) => i.field === "page").map((i: { page_no: number }) => i.page_no)).toEqual([1, 2, 3]);
        expect(qo.evidence_pages_hidden).toBe(0);
        expect(qo.evidence.doc_ref).toMatchObject({ page_count: 3 });
        const pageId = qo.evidence_images.find((i: { field: string }) => i.field === "page").id as string;
        const ok = await getImage(owner, pageId);
        expect(ok.status).toBe(200);
        expect(ok.headers.get("cache-control")).toBe("private, no-store");
        // 會計本來有個人資料＋銀行資料 view（睇得到頁）；撤走銀行資料 view → 頁圖唔回、回頁數、GET 圖被拒
        const actor = { userId: fx.userIds["會計"], baseRole: "會計", roleId: fx.roleIds["會計"], tokenVersion: 0 } as unknown as AuthedSession;
        expect((await viewableFields(actor)).has("page")).toBe(true);
        const accOk = (await getSession(accountant, sid2)).body.questions.find((x: { id: string }) => x.id === qn.id);
        expect(accOk.evidence_images.filter((i: { field: string }) => i.field === "page")).toHaveLength(3);
        await prisma.rolePermission.updateMany({ where: { roleId: fx.roleIds["會計"], permission: { module: "安員銀行資料", action: "view" } }, data: { granted: false } });
        const actor2 = { ...actor } as unknown as AuthedSession; // 權限集按 session 物件快取，要新物件
        expect((await viewableFields(actor2)).has("page")).toBe(false);
        const accNo = (await getSession(accountant, sid2)).body.questions.find((x: { id: string }) => x.id === qn.id);
        expect(accNo.evidence_images.filter((i: { field: string }) => i.field === "page")).toHaveLength(0);
        expect(accNo.evidence_pages_hidden).toBe(3);
        expect((await getImage(accountant, pageId)).status).toBe(403);
        // 雞頭／保安員硬性 deny
        expect((await getImage(broker, pageId)).status).toBe(403);
      });

      it("TE-7.2 prod_person_key：冇身份證號／工號嘅失敗人（本機 key 同 production 唔同）——用 production key（題目 personKey 或原 package key）配對；仍驗身份集合為空、題型需要 page；有工號嘅人唔准用", async () => {
        await seed();
        const keyless = { ...person({ hkid: null, name: "x", nos: [], rating: "fail" }), nameZh: F(null, "missing"), nameEn: F(null, "missing"), dateOfBirth: F(null, "missing"), address: F(null, "missing"), phone: F(null, "missing") } as PackagePerson;
        const withNo = { ...person({ hkid: null, name: "有工號甲", nos: ["U90081"], rating: "fail" }) } as PackagePerson;
        const r0 = await applyPkg(accountant, [keyless, withNo]);
        const sid2 = r0.body.triage.session_id as string;
        const qk = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid2, kind: "no_id_card", personKey: { not: null } , evidenceJson: { path: ["person", "staffNumbers"], equals: [] } } });
        const qs = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid2, kind: "no_id_card", NOT: { id: qk.id } } });
        const page = (n: number) => fakeJpeg(1000, 1400, { seed: 920 + n, pad: 80 * 1024 });
        const docRef = { file_name: "孤兒.pdf", page_count: 1, pages_by_kind: { other: 1 } };
        const mk = async (match: object, n: number) => {
          const b = page(n);
          const f = entryName(b);
          return buildZip({ [f]: b, "manifest.json": JSON.stringify({ version: 1, items: [{ file: f, field: "page", doc_kind: "full_page", priority: 1, page_no: 1, match }], people: [{ match, doc_ref: docRef }] }) });
        };
        // (a) prod_person_key＝題目 personKey（24hex 派生）
        const a = await upload(accountant, sid2, await mk({ hkid: null, staff_numbers: [], package_key: "local-key-not-in-prod", prod_person_key: qk.personKey }, 1));
        expect(a.body).toMatchObject({ accepted_images: 1, doc_refs_set: 1, skipped_identity_mismatch: 0 });
        const view = (await getSession(owner, sid2)).body.questions.find((x: { id: string }) => x.id === qk.id);
        expect(view.evidence.doc_ref).toMatchObject({ file_name: "孤兒.pdf" });
        expect(view.evidence_images.filter((i: { field: string }) => i.field === "page")).toHaveLength(1);
        // (b) prod_person_key＝production 原 package key（經 serverPersonKey 推）
        const b = await upload(accountant, sid2, await mk({ hkid: null, staff_numbers: [], prod_person_key: keyless.key }, 2), true);
        expect(b.body).toMatchObject({ accepted_images: 1 });
        // (c) 有工號嘅人嘅題：即使 prod_person_key 對中，身份集合唔為空 → 唔收
        const c = await upload(accountant, sid2, await mk({ hkid: null, staff_numbers: [], prod_person_key: qs.personKey }, 3));
        expect(c.body).toMatchObject({ accepted_images: 0, doc_refs_set: 0 });
        expect(c.body.skipped_identity_mismatch).toBeGreaterThan(0);
        // (d) match 帶工號時 prod_person_key 唔生效（照工號推 key）；錯 key → 唔收
        const d = await upload(accountant, sid2, await mk({ hkid: null, staff_numbers: [], prod_person_key: "deadbeefdeadbeefdeadbeef" }, 4));
        expect(d.body).toMatchObject({ accepted_images: 0 });
      });

      it("有工號匹配嘅失敗人：上載（dry＋apply）後 doc_ref 寫入題目，並由 session DTO 回傳（file_name 按權限）；只補唔覆蓋", async () => {
        await seed();
        const base = person({ hkid: null, name: "x", nos: ["U90071"], rating: "fail" });
        const pf = { ...base, nameZh: F(null, "missing"), nameEn: F(null, "missing"), dateOfBirth: F(null, "missing"), address: F(null, "missing"), phone: F(null, "missing") } as PackagePerson;
        const r0 = await applyPkg(accountant, [pf]);
        const sid2 = r0.body.triage.session_id as string;
        const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid2, kind: "no_id_card" } });
        const match = { hkid: null, staff_numbers: ["U90071"] };
        const docRef = { file_name: "有工號.pdf", page_count: 5, pages_by_kind: { other: 5 } };
        const b = fakeJpeg(1000, 1400, { seed: 910, pad: 100 * 1024 });
        const f = entryName(b);
        // 圖喺另一個 zip（冇 people）：唔影響；doc_ref 喺只有 people（冇 items）嘅 zip
        const onlyPeople = await buildZip({ "manifest.json": JSON.stringify({ version: 1, items: [], people: [{ match, doc_ref: docRef }] }) });
        const dry = await upload(accountant, sid2, onlyPeople, true);
        expect(dry.body.doc_refs_set).toBe(1);
        expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } })).evidenceJson).not.toHaveProperty("doc_ref");
        expect((await upload(accountant, sid2, onlyPeople)).body.doc_refs_set).toBe(1);
        const view = (await getSession(owner, sid2)).body.questions.find((x: { id: string }) => x.id === qn.id);
        expect(view.evidence.doc_ref).toEqual({ file_name: "有工號.pdf", page_count: 5, pages_by_kind: { other: 5 } });
        // 之後上載頁圖（zip 冇 people）：doc_ref 保持
        const pages = await buildZip({ [f]: b, "manifest.json": JSON.stringify({ version: 1, items: [{ file: f, field: "page", doc_kind: "full_page", priority: 1, page_no: 1, match }] }) });
        expect((await upload(accountant, sid2, pages)).body).toMatchObject({ accepted_images: 1, doc_refs_set: 0 });
        expect((await getSession(owner, sid2)).body.questions.find((x: { id: string }) => x.id === qn.id).evidence.doc_ref.page_count).toBe(5);
      });

      it("rating fail 但有部分欄／工號嘅人：page 照需要（上載收、題 open 時保留）；該人冇 open／skipped 題需要 page 時即刪（deleteUnneeded）", async () => {
        await seed();
        const base = person({ hkid: null, name: "x", nos: ["U90061"], rating: "fail" }); // 有工號、有 phone 以外嘅資料（出生日期 confirmed），但 rating fail
        const pf = { ...base, nameZh: F(null, "missing"), nameEn: F(null, "missing"), phone: F("91234567", "review") } as PackagePerson;
        const r0 = await applyPkg(accountant, [pf]);
        expect(r0.status).toBe(200);
        const sid2 = r0.body.triage.session_id as string;
        const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid2, kind: "no_id_card" } });
        expect(requiredFieldsFor(qn)).toContain("page");
        const match = { staff_numbers: ["U90061"] };
        const b = fakeJpeg(1200, 1600, { seed: 901, pad: 200 * 1024 });
        const f = entryName(b);
        const zip = await buildZip({ [f]: b, "manifest.json": JSON.stringify({ version: 1, items: [{ file: f, field: "page", doc_kind: "full_page", priority: 1, page_no: 1, match }] }) });
        expect((await upload(accountant, sid2, zip)).body).toMatchObject({ accepted_images: 1 });
        expect(await imgCount({ sessionId: sid2, field: "page" })).toBe(1);
        // 題仍 open：deleteUnneeded 唔刪
        expect(await deleteUnneeded(prisma, sid2, qn.personKey)).toBe(0);
        // 題答咗／冇題需要：即刪
        await prisma.triageQuestion.update({ where: { id: qn.id }, data: { status: "answered" } });
        expect(await deleteUnneeded(prisma, sid2, qn.personKey)).toBe(1);
        expect(await imgCount({ sessionId: sid2, field: "page" })).toBe(0);
      });

      it("答題即刪：補完資料答題後整頁原稿圖一併刪；跳過題縮到 ≤30 日", async () => {
        const { sid2, page, zipPages, qn } = await setupFailed();
        await upload(accountant, sid2, await zipPages([1, 2].map((n) => ({ bytes: page(30 + n), no: n }))));
        expect(await imgCount({ sessionId: sid2, field: "page" })).toBe(2);
        const res = await confirm(owner, qn.id, { option: "enter_hkid", value: H[11], extra: { name_zh: "整頁原稿測試員" } });
        expect(res.status).toBe(200);
        expect(await imgCount({ sessionId: sid2 })).toBe(0);
      });
    });

    describe("TE-5 同名現有保安員：needs_decision → 連結／建新人", () => {
      const NM = "導入測試員同名甲";
      async function setup(existing: { hkid?: string | null; no?: string } = {}) {
        await seed();
        const g = await prisma.guard.create({ data: { nameZh: NM, employmentType: "cash_casual", ...(existing.hkid ? { hkid: existing.hkid } : {}), createdBy: "t" } });
        const base = person({ hkid: null, name: "x", nos: ["U90051"], rating: "fail" });
        const pn = { ...base, nameZh: F(null, "missing"), nameEn: F(null, "missing"), dateOfBirth: F(null, "missing") } as PackagePerson;
        const r0 = await applyPkg(accountant, [pn]);
        expect(r0.status).toBe(200);
        const sid2 = r0.body.triage.session_id as string;
        const qn = await prisma.triageQuestion.findFirstOrThrow({ where: { sessionId: sid2, kind: "no_id_card" } });
        for (const [i, f] of (["hkid", "name_zh", "name_en"] as const).entries()) {
          const plain = J(260 + i);
          await insertEvidenceImage(prisma, { sessionId: sid2, questionId: null, personKey: qn.personKey!, guardId: null, field: f, docKind: "id_card", priority: 1, plain, info: inspectImage(plain)!, createdBy: fx.userIds["會計"], expiresAt: new Date(Date.now() + 1e9) });
        }
        const call = async (route: unknown, url: string, body: unknown) => json(route as never, `/api/triage/questions/${qn.id}/${url}`, owner, body, qn.id);
        const prev = async (extra: object) => {
          const res = await call(previewRoute, "preview", { answer: { option: "enter_hkid", value: H[9], extra: { name_zh: NM, dob: "1991-02-03", ...extra } } });
          return { status: res.status, body: await res.json() };
        };
        const ans = async (extra: object) => {
          const answer = { option: "enter_hkid", value: H[9], extra: { name_zh: NM, dob: "1991-02-03", ...extra } };
          const pv = await (await call(previewRoute, "preview", { answer })).json();
          return call(answerRoute, "answer", { answer, preview_hash: pv.preview_hash });
        };
        return { g, qn, sid2, prev, ans };
      }

      it("preview：同名候選 → needs_decision（候選卡欄位）＋人話 reason_text，writes=false；唔按姓名自動連結", async () => {
        const { g, prev, sid2 } = await setup();
        const p = await prev({});
        expect(p.status).toBe(200);
        expect(p.body.impact.can_confirm).toBe(false);
        expect(p.body.writes).toBe(false);
        expect(p.body.impact.needs_decision.reason).toBe("name_only_candidate");
        expect(p.body.impact.needs_decision.options).toEqual(["link", "create_new"]);
        expect(p.body.impact.reason_text).toContain("同名保安員");
        expect(p.body.impact.needs_decision.candidates).toHaveLength(1);
        expect(p.body.impact.needs_decision.candidates[0]).toMatchObject({ guard_id: g.id, name_zh: NM, has_hkid: false, has_dob: false, staff_numbers: [], last_shift_month: null, active: true });
        expect(Object.keys(p.body.impact.needs_decision.candidates[0]).sort()).toEqual(["active", "created_at", "guard_id", "has_dob", "has_hkid", "last_shift_month", "name_en", "name_zh", "phone_masked", "staff_numbers"]);
        expect(await imgCount({ sessionId: sid2 })).toBe(3); // 未決定，圖仍在
        // 欄位級權限：冇「保安員個人資料:view」→ 英文名唔回、電話遮罩
        await prisma.guard.update({ where: { id: g.id }, data: { nameEn: "TEST SAME", tel: "91234567" } });
        const lo = (await loadDecisionCandidates(NM, { pii: false, piiUpdate: false, guardUpdate: false, bankView: false, bankUpdate: false })).candidates;
        expect(lo[0]).toMatchObject({ name_en: null });
        expect(lo[0]!.phone_masked).not.toBe("91234567");
        const hi = (await loadDecisionCandidates(NM, { pii: true, piiUpdate: true, guardUpdate: true, bankView: true, bankUpdate: true })).candidates;
        expect(hi[0]).toMatchObject({ name_en: "TEST SAME", phone_masked: "91234567" });
      });

      it("link：連去該位——寫入身份證號／出生日期到該 guard（唔新增人）；圖刪；audit 記 decision＋guard id（唔記值）", async () => {
        const { g, prev, ans, qn, sid2 } = await setup();
        const p = await prev({ link_guard_id: g.id });
        expect(p.body.impact.can_confirm).toBe(true);
        expect(p.body.impact.needs_decision).toBeUndefined();
        const before = await prisma.guard.count();
        expect((await ans({ link_guard_id: g.id })).status).toBe(200);
        expect(await prisma.guard.count()).toBe(before);
        const after = await prisma.guard.findUniqueOrThrow({ where: { id: g.id }, select: { hkid: true, dateOfBirth: true } });
        expect(after.hkid).toBe(H[9]);
        expect(after.dateOfBirth?.toISOString().slice(0, 10)).toBe("1991-02-03");
        expect(await imgCount({ sessionId: sid2 })).toBe(0);
        const au = await prisma.auditLog.findFirstOrThrow({ where: { action: "triage_answer", rowId: qn.id } });
        expect(au.after).toMatchObject({ decision: "link", link_guard_id: g.id });
        expect(JSON.stringify(au.after)).not.toContain(H[9]!);
      });

      it("create_new：建新人（同名兩個）", async () => {
        const { g, ans } = await setup();
        expect((await ans({ create_new: true })).status).toBe(200);
        const gs = await prisma.guard.findMany({ where: { nameZh: NM }, select: { id: true, hkid: true } });
        expect(gs).toHaveLength(2);
        expect(gs.find((x) => x.id !== g.id)?.hkid).toBe(H[9]);
        expect(gs.find((x) => x.id === g.id)?.hkid).toBeNull();
      });

      it("M1：link_guard_id 唔係同名候選（無關保安員）→ 400（preview／answer 都係），冇寫入", async () => {
        const { ans, prev, qn } = await setup();
        const stranger = await prisma.guard.create({ data: { nameZh: "導入測試員無關路人", employmentType: "cash_casual", createdBy: "t" } });
        expect((await prev({ link_guard_id: stranger.id })).status).toBe(400);
        expect((await ans({ link_guard_id: stranger.id })).status).toBe(400);
        expect((await prisma.guard.findUniqueOrThrow({ where: { id: stranger.id }, select: { hkid: true } })).hkid).toBeNull();
        expect((await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } })).status).toBe("open");
        expect((await prev({ link_guard_id: "00000000-0000-4000-8000-00000000dead" })).status).toBe(400);
      });

      it("M2：冇「保安員個人資料:view」＋「保安員:update」→ link 403；preview 嘅 needs_decision 淨提供 create_new", async () => {
        const { g, qn } = await setup();
        const actor = { userId: fx.userIds["老闆"], baseRole: "老闆", roleId: fx.roleIds["老闆"], tokenVersion: 0 } as unknown as AuthedSession;
        const full = await viewerCaps(actor);
        expect(full.pii && full.guardUpdate).toBe(true);
        const lowCaps = { ...full, pii: false, guardUpdate: false };
        const q0 = await prisma.triageQuestion.findUniqueOrThrow({ where: { id: qn.id } });
        const base = { option: "enter_hkid", value: H[9], extra: { name_zh: NM } } as const;
        const pv = await previewAnswer(actor, q0, base, lowCaps, null);
        expect(pv.impact.needs_decision?.options).toEqual(["create_new"]);
        const withCaps = await previewAnswer(actor, q0, base, { ...full, pii: true, guardUpdate: true }, null);
        expect(withCaps.impact.needs_decision?.options).toEqual(["link", "create_new"]);
        await expect(previewAnswer(actor, q0, { ...base, extra: { name_zh: NM, link_guard_id: g.id } }, lowCaps, null)).rejects.toMatchObject({ status: 403 });
        await expect(previewAnswer(actor, q0, { ...base, extra: { name_zh: NM, link_guard_id: g.id } }, { ...full, pii: true, guardUpdate: false }, null)).rejects.toMatchObject({ status: 403 });
        expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id }, select: { hkid: true } })).hkid).toBeNull();
      });

      it("S1：同名多過 5 位 → 只列 5 位，truncated=true", async () => {
        const { prev } = await setup();
        for (let i = 0; i < 6; i++) await prisma.guard.create({ data: { nameZh: NM, employmentType: "cash_casual", createdBy: "t" } });
        const p = await prev({});
        expect(p.body.impact.needs_decision.candidates).toHaveLength(5);
        expect(p.body.impact.needs_decision.truncated).toBe(true);
      });

      it("身份檢查照舊：link 去已有另一個身份證號嘅同名者 → 攔（422）；身份證號屬第三者 → 攔；link／create_new 同時帶或選項唔啱 → 400", async () => {
        const { g, ans, prev, qn } = await setup({ hkid: H[10] });
        // 同名但 hkid 唔同（H[10]）：輸入 H[9] 係 same_name_different_hkid → 自動走建新人，唔需要決定；硬 link 去佢 → guard_hkid_differs 攔
        expect((await ans({ link_guard_id: g.id })).status).toBe(422);
        expect((await prev({ link_guard_id: g.id, create_new: true })).status).toBe(400);
        const third = await prisma.guard.create({ data: { nameZh: "導入測試員第三者", employmentType: "cash_casual", hkid: H[9], createdBy: "t" } });
        const g2 = await prisma.guard.create({ data: { nameZh: NM, employmentType: "cash_casual", createdBy: "t" } });
        const r = await ans({ link_guard_id: g2.id });
        expect(r.status).toBe(422); // H[9] 屬第三者 → 唔准連去另一位
        expect(await prisma.guard.findUniqueOrThrow({ where: { id: third.id }, select: { nameZh: true } })).toMatchObject({ nameZh: "導入測試員第三者" });
        const bad = await json(previewRoute as never, `/api/triage/questions/${qn.id}/preview`, accountant, { answer: { option: "keep", extra: { link_guard_id: g.id } } }, qn.id);
        expect(bad.status).toBe(400);
      });
    });

    it("TE-3(2) explainBlocked：每個 reason code 都有人話；可補嘅（create_no_name／name_not_confirmed）帶 needs_fields，其餘講下一步", () => {
      for (const code of Object.keys(BLOCK_TEXT)) {
        const e = explainBlocked([code], "enter_hkid", EXTRA_NAME_OPTIONS, false);
        expect(e.reason_text!.length, code).toBeGreaterThan(0);
        expect(e.reason_text!, code).not.toMatch(/^[a-z_]+$/);
        if (code === "create_no_name" || code === "name_not_confirmed") expect(e.needs_fields, code).toHaveLength(2);
        else expect(e.needs_fields, code).toBeUndefined();
      }
      expect(explainBlocked(["create_no_name"], "skip_x", EXTRA_NAME_OPTIONS, false).needs_fields).toBeUndefined();
      expect(explainBlocked(["create_no_name"], "enter_hkid", EXTRA_NAME_OPTIONS, true).needs_fields).toBeUndefined();
      expect(explainBlocked(["totally_unknown_code"], "enter_hkid", EXTRA_NAME_OPTIONS, false).reason_text).toContain("跳過");
    });

    it("(8) 同一人兩條題需要不同欄：答 name_only_candidate（name_zh；name_en 舊圖係孤兒）後 name 兩欄都刪；tel_only_candidate 需要嘅 phone 圖保留", async () => {
      const { ka, sid } = await seed();
      const base = await qOf("name_not_confirmed", ka);
      await prisma.triageQuestion.updateMany({ where: { personKey: ka }, data: { status: "answered" } });
      const nq = await mkQ(sid, ka, "name_only_candidate", base.evidenceJson as object);
      await mkQ(sid, ka, "tel_only_candidate", base.evidenceJson as object);
      const put = async (field: "name_zh" | "name_en" | "phone", n: number) => {
        const plain = J(n);
        await insertEvidenceImage(prisma, { sessionId: sid, questionId: null, personKey: ka, guardId: null, field, docKind: field === "phone" ? "onboarding_form" : "id_card", priority: 1, plain, info: inspectImage(plain)!, createdBy: fx.userIds["會計"], expiresAt: new Date(Date.now() + 1e9) });
      };
      await put("name_zh", 241);
      await put("name_en", 242);
      await put("phone", 243);
      // 直接走 deleteUnneeded（submitAnswer 喺 tx 內 call 同一函數；answer 已 answered 嘅狀態＋重算）
      await prisma.triageQuestion.update({ where: { id: nq.id }, data: { status: "answered" } });
      expect(await deleteUnneeded(prisma, sid, ka)).toBe(2);
      expect(await imgCount({ personKey: ka, field: "phone" })).toBe(1);
      expect(await imgCount({ personKey: ka, field: { in: ["name_zh", "name_en"] } })).toBe(0);
    });
  });

  describe("M9 AI 隔離", () => {
    it("ai.audit_log view 排除 triage_evidence_images；ai schema 冇呢張表；真 zoikan_ai_ro 連線讀 public 表被拒", async () => {
      const def = (await prisma.$queryRawUnsafe<{ viewdef: string }[]>(`SELECT pg_get_viewdef('ai.audit_log'::regclass, true) AS viewdef`))[0]!.viewdef;
      expect(def).toContain("'triage_evidence_images'");
      expect(def).toContain("'whatsapp_messages'"); // 舊排除清單逐字保留
      expect(def).toContain("'triage_questions'");
      const names = (await prisma.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai'`)).map((r) => r.table_name);
      expect(names).not.toContain("triage_evidence_images");
      const { Client } = await import("pg");
      const c = new Client({ connectionString: process.env.AI_DATABASE_URL });
      await c.connect();
      try {
        await expect(c.query(`SELECT count(*) FROM public.triage_evidence_images`)).rejects.toThrow(/permission denied/i);
        await expect(c.query(`SELECT image_bytes FROM public.triage_evidence_images LIMIT 1`)).rejects.toThrow(/permission denied/i);
        await expect(c.query(`SELECT count(*) FROM ai.triage_evidence_images`)).rejects.toThrow();
        // 寫 audit（table_name 係本表）→ ai.audit_log 睇唔到
        const admin = await prisma.user.findFirstOrThrow();
        await prisma.auditLog.create({ data: { actorUserId: admin.id, tableName: "triage_evidence_images", rowId: "ai-iso-probe", action: "update", before: {}, after: { n: 1 } } });
        const r = await c.query(`SELECT count(*)::int AS n FROM ai.audit_log WHERE table_name = 'triage_evidence_images'`);
        expect(r.rows[0].n).toBe(0);
      } finally {
        await c.end();
      }
    });
  });
});
