// WA-9 (7)／Opus M2：名單／相片差異題「一日一條」之後，題已答／跳過，同日再有新差異 → 開下一輪（:r2…）；同一差異重跑冪等；open 時併入。全部假名、假資料。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture } from "./fixtures/wp2-fixture";
import { runWhatsappParse } from "@/lib/jobs/whatsapp-parse";
import { ingestEvent } from "@/lib/whatsapp/ingest";
import type { NormalizedWaEvent } from "@/lib/whatsapp/schema";
import type { CardEngine, CardEngineName, EngineOutcome } from "@/lib/whatsapp/card-engines";

const T0 = new Date("2026-10-19T05:00:00Z"); // HK 2026-10-19 13:00
const NOW = new Date(T0.getTime() + 60_000);
const G1 = "wa9-mm-g1@g.us";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9), Buffer.from([0xff, 0xd9])]);
const N = ["孫測壹", "陳測貳", "許測叁", "黃測肆", "謝測伍"];
let site: string;

const out = (name: string): EngineOutcome => ({ ok: true, is_card: true, cards: [{ is_card: true, staff_no: null, name_zh: name, name_en: null, confidence: "high" as const }], usage: null, doc_type: "punch_card" });
const eng = (name: CardEngineName, n: string): CardEngine => ({ name, model: "fake", read: async () => out(n) });
const run = (n: string) => runWhatsappParse(NOW, { force: true, cardEngines: { tesseract: eng("tesseract", n), deepseek: eng("deepseek", n), claude: eng("claude", n) } });
const ev = (mid: string, over: Partial<NormalizedWaEvent>): NormalizedWaEvent => ({ kind: "message", session: "default", messageId: mid, chatJid: G1, senderJid: "85290009998@c.us", fromMe: false, ts: T0, text: "", mediaType: null, quotedMessageId: null, eventId: `e-${mid}`, ...over });
const photo = (mid: string) => ingestEvent(ev(mid, { mediaType: "image", mediaUrl: "http://x/api/files/default/a.jpg", mediaError: false }), NOW);
const mm = () => prisma.triageQuestion.findMany({ where: { kind: "wa_roster_mismatch" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
const photoOnly = (q: { evidenceJson: unknown }): string[] => ((q.evidenceJson as { mismatch: { photo_only: string[] } }).mismatch.photo_only).sort();

beforeEach(async () => {
  process.env.WA_CARD_OCR_STRATEGY = "S1";
  await clearAll();
  await prisma.triageQuestion.deleteMany({});
  await prisma.triageSession.deleteMany({});
  const fx = await seedWp2Fixture();
  process.env.WAHA_BASE_URL = "http://waha.test:3000";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JPEG as never, { status: 200 })));
  const s = await prisma.site.create({ data: { canonicalName: "測試盤MM", clientName: "測試客戶MM", billingModel: "per_shift", createdBy: "test:mm" } });
  site = s.id;
  const tD = await prisma.shiftType.create({ data: { siteId: s.id, code: "D", label: "日更", startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T20:00:00Z"), hours: 12, createdBy: "test:mm" } as never });
  for (const [i, n] of N.entries()) {
    const g = await prisma.guard.create({ data: { nameZh: n, employmentType: "cash_casual", tel: `9000008${i}`, createdBy: "test:mm" } });
    await prisma.shiftRecord.create({ data: { workDate: new Date("2026-10-01T00:00:00Z"), siteId: s.id, shiftTypeId: tD.id, guardId: g.id, recordType: "shift", status: "confirmed", createdBy: "test:mm" } as never });
  }
  await prisma.whatsappGroup.create({ data: { groupJid: G1, label: "MM群", kind: "site", siteId: s.id, shiftWordMap: { 開工: "D" }, autoWrite: true, cardPhotoMode: true, createdBy: fx.userIds["老闆"] } });
  await ingestEvent(ev("roster", { text: `19/10/2026 ${N[0]} ${N[1]}` }), NOW);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WAHA_BASE_URL;
});

describe("wa_roster_mismatch：輪次", () => {
  it("相有名單冇 → 一條題；open 時第二張相併入；已跳過後新差異開 :r2；同一差異重跑冪等", async () => {
    await run(N[0]!); // 先處理名單
    expect((await prisma.shiftRecord.findMany({ where: { siteId: site, workDate: new Date("2026-10-19T00:00:00Z") } })).length).toBe(2);
    await photo("p1");
    await run(N[2]!);
    let qs = await mm();
    expect(qs).toHaveLength(1);
    expect(photoOnly(qs[0]!)).toHaveLength(1);
    expect(qs[0]!.groupKey).toMatch(/^rm:.+:2026-10-19$/);
    // 第二張相、另一個名、題仲 open → 併入同一條
    await photo("p2");
    await run(N[3]!);
    qs = await mm();
    expect(qs).toHaveLength(1);
    expect(photoOnly(qs[0]!)).toHaveLength(2);
    // 人答咗（跳過）→ 同一個差異再嚟（重發相）冪等：唔開新題
    await prisma.triageQuestion.update({ where: { id: qs[0]!.id }, data: { status: "skipped" } });
    await photo("p3");
    await run(N[3]!);
    expect(await mm()).toHaveLength(1);
    // 新差異 → 下一輪
    await photo("p4");
    await run(N[4]!);
    qs = await mm();
    expect(qs).toHaveLength(2);
    expect(qs[1]!.groupKey).toMatch(/:r2$/);
    expect(qs[1]!.status).toBe("open");
    expect(photoOnly(qs[1]!)).toHaveLength(1);
    // r2 open 時再有舊差異（已喺 r1）→ 唔重複；新差異併入 r2
    await photo("p5");
    await run(N[3]!);
    expect(photoOnly((await mm())[1]!)).toHaveLength(1);
  });
});
