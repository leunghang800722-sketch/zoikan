// WA-8 A：工卡相媒體擷取——schema、fetchMedia（SSRF／大小／magic bytes）、加密暫存、ingest（card_photo_mode 開／關、拉唔到＝expired）。合成資料。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture } from "./fixtures/wp2-fixture";
import { WebhookEnvelopeSchema, normalizeEvent } from "@/lib/whatsapp/schema";
import { fetchMedia, internalMediaUrl, loadMediaEvidence, purgeExpiredMedia, sniffImage, WA_MEDIA_MAX_BYTES } from "@/lib/whatsapp/media";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import { runWhatsappRetention } from "@/lib/jobs/whatsapp-retention";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
const G = "wa8-g1@g.us";
const resp = (body: Buffer | string, init: ResponseInit = {}) => new Response(body as never, { status: 200, ...init });

function envelope(media: Record<string, unknown> | null, id = "wa8-m1") {
  return WebhookEnvelopeSchema.parse({
    event: "message",
    session: "default",
    payload: { id, timestamp: Math.floor(Date.now() / 1000), from: G, participant: "85290000001@c.us", fromMe: false, body: "", hasMedia: media !== null, ...(media ? { media } : {}) },
  });
}
const norm = (media: Record<string, unknown> | null, id?: string) => normalizeEvent("message", envelope(media, id))!;

describe("WA-8 A 媒體擷取", () => {
  beforeEach(async () => {
    await clearAll();
    process.env.WAHA_BASE_URL = "http://waha.test:3000";
    process.env.WAHA_API_KEY = "fake-waha-key";
    await seedWp2Fixture();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.WAHA_BASE_URL;
    delete process.env.WAHA_API_KEY;
  });

  it("schema：接受 media.url／filename／error；url 唔落 DB（normalize 只帶記憶體欄）", () => {
    const e = norm({ mimetype: "image/jpeg", url: "http://waha:3000/api/files/default/abc.jpg", filename: "abc.jpg" });
    expect(e).toMatchObject({ mediaType: "image", mediaUrl: "http://waha:3000/api/files/default/abc.jpg", mediaError: false });
    expect(norm({ mimetype: "image/jpeg", error: { message: "x" } }).mediaError).toBe(true);
    expect(norm(null).mediaUrl).toBeNull();
  });

  it("internalMediaUrl：只取 path+query 拼落自己嘅 WAHA_BASE_URL（唔信 payload host）", () => {
    expect(internalMediaUrl("http://evil.example/api/files/default/a.jpg?x=1", "http://waha.test:3000")).toBe("http://waha.test:3000/api/files/default/a.jpg?x=1");
    expect(internalMediaUrl("/api/files/a.jpg", "http://waha.test:3000")).toBe("http://waha.test:3000/api/files/a.jpg");
    expect(internalMediaUrl("ftp://x/a", "http://waha.test:3000")).toBeNull();
    expect(internalMediaUrl("/a", "")).toBeNull();
  });

  it("fetchMedia：成功（帶 X-Api-Key、打去自己 WAHA）／404／唔係圖／太大／timeout／冇設定", async () => {
    const calls: Array<{ url: string; key: string | null }> = [];
    const mk = (r: () => Response | Promise<Response>): typeof fetch => (async (u: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(u), key: new Headers(init?.headers).get("x-api-key") });
      return r();
    }) as never;
    const ok = await fetchMedia("http://other-host/api/files/default/a.jpg", mk(() => resp(JPEG)));
    expect(ok).toMatchObject({ ok: true, mime: "image/jpeg" });
    expect(calls[0]).toEqual({ url: "http://waha.test:3000/api/files/default/a.jpg", key: "fake-waha-key" });
    expect(await fetchMedia("/a", mk(() => resp("nope", { status: 404 })))).toEqual({ ok: false, error: "http_error" });
    expect(await fetchMedia("/a", mk(() => resp("<html>")))).toEqual({ ok: false, error: "not_image" });
    expect(await fetchMedia("/a", mk(() => resp(JPEG, { headers: { "content-length": String(WA_MEDIA_MAX_BYTES + 1) } })))).toEqual({ ok: false, error: "too_large" });
    expect(await fetchMedia("/a", mk(() => resp(Buffer.concat([JPEG, Buffer.alloc(WA_MEDIA_MAX_BYTES)]))))).toEqual({ ok: false, error: "too_large" });
    expect(await fetchMedia("/a", (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as never)).toEqual({ ok: false, error: "timeout" });
    delete process.env.WAHA_BASE_URL;
    expect(await fetchMedia("/a", mk(() => resp(JPEG)))).toEqual({ ok: false, error: "not_configured" });
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
  });

  it("ingest：群組開 card_photo_mode → 即時拉圖、加密暫存（密文≠明文）、media_state=stored；讀返一致", async () => {
    await prisma.whatsappGroup.create({ data: { groupJid: G, label: "測試工卡群", kind: "multi_site", cardPhotoMode: true, createdBy: "t" } });
    const f = vi.fn(async () => resp(JPEG));
    vi.stubGlobal("fetch", f);
    expect(await ingestEvent(norm({ mimetype: "image/jpeg", url: "http://x/api/files/default/a.jpg" }))).toBe("inserted");
    expect(f).toHaveBeenCalledTimes(1);
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: "wa8-m1" } })).mediaState).toBe("stored");
    const row = await prisma.whatsappMediaEvidence.findUniqueOrThrow({ where: { messageId: "wa8-m1" } });
    expect(Buffer.from(row.imageBytes).equals(JPEG)).toBe(false);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const back = await loadMediaEvidence("wa8-m1");
    expect(back?.bytes.equals(JPEG)).toBe(true);
    // 冪等：重送唔重複存
    await ingestEvent(norm({ mimetype: "image/jpeg", url: "http://x/api/files/default/a.jpg" }));
    expect(await prisma.whatsappMediaEvidence.count()).toBe(1);
  });

  it("ingest：拉唔到／冇 url／media.error → media_state=expired（訊息照落庫，冇暫存）", async () => {
    await prisma.whatsappGroup.create({ data: { groupJid: G, label: "測試工卡群", kind: "multi_site", cardPhotoMode: true, createdBy: "t" } });
    vi.stubGlobal("fetch", vi.fn(async () => resp("gone", { status: 404 })));
    expect(await ingestEvent(norm({ mimetype: "image/jpeg", url: "http://x/api/files/default/a.jpg" }, "m-404"))).toBe("inserted");
    expect(await ingestEvent(norm({ mimetype: "image/jpeg" }, "m-nourl"))).toBe("inserted");
    expect(await ingestEvent(norm({ mimetype: "image/jpeg", url: "http://x/a.jpg", error: "boom" }, "m-err"))).toBe("inserted");
    for (const id of ["m-404", "m-nourl", "m-err"]) expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: id } })).mediaState).toBe("expired");
    expect(await prisma.whatsappMediaEvidence.count()).toBe(0);
  });

  it("card_photo_mode 關住：即使有 media.url 都唔拉、唔存任何圖（media_state=null）；非圖片媒體唔處理", async () => {
    await prisma.whatsappGroup.create({ data: { groupJid: G, label: "測試普通群", kind: "multi_site", cardPhotoMode: false, createdBy: "t" } });
    const f = vi.fn(async () => resp(JPEG));
    vi.stubGlobal("fetch", f);
    await ingestEvent(norm({ mimetype: "image/jpeg", url: "http://x/api/files/default/a.jpg" }, "m-off"));
    expect(f).not.toHaveBeenCalled();
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: "m-off" } })).mediaState).toBeNull();
    expect(await prisma.whatsappMediaEvidence.count()).toBe(0);
    await prisma.whatsappGroup.update({ where: { groupJid: G }, data: { cardPhotoMode: true } });
    await ingestEvent(norm({ mimetype: "video/mp4", url: "http://x/v.mp4" }, "m-video"));
    expect(f).not.toHaveBeenCalled();
  });

  it("保留期 job 清走過期暫存圖", async () => {
    await prisma.whatsappGroup.create({ data: { groupJid: G, label: "測試工卡群", kind: "multi_site", cardPhotoMode: true, createdBy: "t" } });
    vi.stubGlobal("fetch", vi.fn(async () => resp(JPEG)));
    await ingestEvent(norm({ mimetype: "image/jpeg", url: "http://x/api/files/default/a.jpg" }));
    expect(await purgeExpiredMedia(new Date())).toBe(0);
    const r = await runWhatsappRetention(new Date(Date.now() + 8 * 86_400_000));
    expect(r.summary).toMatchObject({ media_purged: 1 });
    expect(await loadMediaEvidence("wa8-m1")).toBeNull();
  });
});
