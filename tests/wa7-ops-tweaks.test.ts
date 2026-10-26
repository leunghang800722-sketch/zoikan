// WA-7：訊息清單篩選／分流連結／過濾原因；圖片獨立原因碼；靜默告警口徑。全部合成資料。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as messagesGet } from "@/app/api/whatsapp/messages/route";

const req = (path: string, cookie: string) => new Request(`http://test.local${path}`, { headers: { cookie } });

describe("WA-7 訊息清單", () => {
  let fx: Wp2Fixture;
  let owner: string;
  beforeEach(async () => {
    await clearAll();
    await prisma.triageQuestion.deleteMany({});
    await prisma.triageSession.deleteMany({});
    fx = await seedWp2Fixture();
    owner = await sessionCookieForUser(fx.userIds["老闆"]);
  });
  const msg = (id: string, over: Record<string, unknown> = {}) =>
    prisma.whatsappMessage.create({ data: { session: "default", chatJid: "wa7-g1@g.us", messageId: id, senderJid: "85290000001@c.us", ts: new Date("2026-10-22T04:00:00Z"), text: "", ...over } });

  it("status 篩選支援 routed／filtered／parsed／done；分流行帶 triage_session_id；略過行帶 filter_reasons", async () => {
    await prisma.whatsappGroup.create({ data: { groupJid: "wa7-g1@g.us", label: "測試群七", createdBy: fx.userIds["老闆"] } });
    const s = await prisma.triageSession.create({ data: { sourceType: "whatsapp", sourceRef: "wa7-g1@g.us:2026-10", ownerUserId: fx.userIds["老闆"], createdBy: fx.userIds["老闆"], statsJson: {} } });
    await msg("m-routed", { status: "routed" });
    await msg("m-filtered", { status: "filtered" });
    await msg("m-parsed", { status: "parsed" });
    await msg("m-done", { status: "done" });
    await msg("m-media", { status: "ignored", ignoreReason: "filtered_out", filterScore: 0, filterReasons: ["media_only"], mediaType: "image" });
    for (const st of ["routed", "filtered", "parsed", "done"]) {
      const j = await (await messagesGet(req(`/api/whatsapp/messages?status=${st}`, owner))).json();
      expect(j.rows).toHaveLength(1);
      expect(j.rows[0].status).toBe(st);
      if (st === "routed") expect(j.rows[0].triage_session_id).toBe(s.id);
      else expect(j.rows[0].triage_session_id).toBeNull();
    }
    const ig = await (await messagesGet(req("/api/whatsapp/messages?status=ignored", owner))).json();
    expect(ig.rows[0]).toMatchObject({ ignore_reason: "filtered_out", filter_reasons: ["media_only"], media_type: "image" });
  });
});
