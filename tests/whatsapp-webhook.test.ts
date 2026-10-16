// W0：POST /api/webhooks/whatsapp——HMAC／header／總開關／冪等／過濾／編輯／撤回／媒體／大小／schema。
// 全部假資料（假電話 85290000001、假群 test-g1@g.us、假名「測試甲」）。
import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { POST } from "@/app/api/webhooks/whatsapp/route";

const KEY = "unit-test-hmac-key";
const SECRET = "unit-test-header-secret";
const GROUP = "test-g1@g.us";
const SENDER = "85290000001@c.us";
const URL_ = "http://test.local/api/webhooks/whatsapp";

function sign(raw: string, key = KEY): string {
  return createHmac("sha512", key).update(raw).digest("hex");
}

interface PostOpts {
  sig?: string | null;
  hook?: string | null;
  raw?: string;
  contentLength?: number;
  headers?: Record<string, string>;
}
async function post(body: unknown, o: PostOpts = {}): Promise<Response> {
  const raw = o.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.headers ?? {}) };
  const sig = o.sig === undefined ? sign(raw) : o.sig;
  if (sig !== null) {
    headers["x-webhook-hmac"] = sig;
    headers["x-webhook-hmac-algorithm"] = "sha512";
  }
  const hook = o.hook === undefined ? SECRET : o.hook;
  if (hook !== null) headers["x-zoikan-hook"] = hook;
  if (o.contentLength !== undefined) headers["content-length"] = String(o.contentLength);
  return POST(new Request(URL_, { method: "POST", headers, body: raw }));
}

const nowSec = () => Math.floor(Date.now() / 1000);
function msgEvent(id: string, over: Record<string, unknown> = {}, event = "message", extra: Record<string, unknown> = {}) {
  return {
    event,
    session: "default",
    payload: { id, timestamp: nowSec(), from: GROUP, participant: SENDER, fromMe: false, body: "測試甲 聽日返早", hasMedia: false, ...over, ...extra },
  };
}
const MID = (n: string) => `false_${GROUP}_TESTMSG${n}_${SENDER}`;

describe("W0 webhook", () => {
  beforeEach(async () => {
    await clearAll();
    process.env.WA_ENABLED = "1";
    process.env.WA_WEBHOOK_HMAC_KEY = KEY;
    process.env.WA_WEBHOOK_HEADER_SECRET = SECRET;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WA_ENABLED;
  });

  it("WA_ENABLED 非 1 → 503 固定字串，唔落庫（連簽名都唔使驗）", async () => {
    process.env.WA_ENABLED = "0";
    const res = await post(msgEvent(MID("1")), { sig: null, hook: null });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "whatsapp_disabled" });
    delete process.env.WA_ENABLED;
    expect((await post(msgEvent(MID("1")))).status).toBe(503);
    expect(await prisma.whatsappMessage.count()).toBe(0);
  });

  it("HMAC 啱＋header 啱 → 200 {ok:true} 落庫（revision 1、received、發訊人電話正規化）", async () => {
    const res = await post(msgEvent(MID("1")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("1") } });
    expect(row).toMatchObject({ revision: 1, status: "received", chatJid: GROUP, senderJid: SENDER, senderTelNorm: "90000001", text: "測試甲 聽日返早", session: "default", ignoreReason: null, mediaType: null });
    expect(row.textHistory).toEqual([]);
  });

  it("HMAC 錯／冇／key 唔同 → 401 唔落庫；唔 log body", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const ev = msgEvent(MID("2"), { body: "SECRET-BODY-TEXT-測試" });
    for (const o of [{ sig: "0".repeat(128) }, { sig: null }, { sig: sign(JSON.stringify(ev), "other-key") }, { sig: "abc" }]) {
      const res = await post(ev, o);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(await prisma.whatsappMessage.count()).toBe(0);
    for (const s of spies) for (const c of s.mock.calls) expect(JSON.stringify(c)).not.toContain("SECRET-BODY-TEXT");
  });

  it("HMAC 對但自訂 header 錯／冇 → 401；算法 header 唔係 sha512 → 401", async () => {
    const ev = msgEvent(MID("3"));
    expect((await post(ev, { hook: "wrong" })).status).toBe(401);
    expect((await post(ev, { hook: null })).status).toBe(401);
    const raw = JSON.stringify(ev);
    const res = POST(new Request(URL_, { method: "POST", headers: { "x-webhook-hmac": sign(raw), "x-webhook-hmac-algorithm": "sha256", "x-zoikan-hook": SECRET }, body: raw }));
    expect((await res).status).toBe(401);
    expect(await prisma.whatsappMessage.count()).toBe(0);
  });

  it("HMAC 對 raw bytes：body 多一個空白（re-serialize 唔同）→ 401", async () => {
    const raw = JSON.stringify(msgEvent(MID("4")));
    const res = await post(null, { raw: `${raw} `, sig: sign(raw) });
    expect(res.status).toBe(401);
  });

  it("key／secret 未設定 → fail closed 401", async () => {
    process.env.WA_WEBHOOK_HMAC_KEY = "";
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post(msgEvent(MID("5")), { sig: sign(JSON.stringify(msgEvent(MID("5"))), "") })).status).toBe(401);
    process.env.WA_WEBHOOK_HMAC_KEY = KEY;
    process.env.WA_WEBHOOK_HEADER_SECRET = "";
    expect((await post(msgEvent(MID("5")), { hook: "" })).status).toBe(401);
    expect(await prisma.whatsappMessage.count()).toBe(0);
  });

  it("重覆投遞同一事件 3 次 → 只有 1 行（冪等）", async () => {
    const ev = msgEvent(MID("6"));
    for (let i = 0; i < 3; i++) expect((await post(ev)).status).toBe(200);
    expect(await prisma.whatsappMessage.count({ where: { messageId: MID("6") } })).toBe(1);
  });

  it("併發重覆投遞 → 仍然 1 行", async () => {
    const ev = msgEvent(MID("7"));
    const rs = await Promise.all([post(ev), post(ev), post(ev), post(ev)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(await prisma.whatsappMessage.count({ where: { messageId: MID("7") } })).toBe(1);
  });

  it("fromMe → ignored:from_me", async () => {
    await post(msgEvent(MID("8"), { fromMe: true }));
    const row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("8") } });
    expect(row).toMatchObject({ status: "ignored", ignoreReason: "from_me" });
  });

  it("非群組（私訊）→ ignored:not_group；唔存原文、jid 以 hash 取代、唔解析電話", async () => {
    await post(msgEvent("false_85290000002@c.us_PRIV1", { from: "85290000002@c.us", participant: undefined, body: "私人訊息 不應保存" }));
    expect(await prisma.whatsappMessage.count({ where: { messageId: "false_85290000002@c.us_PRIV1" } })).toBe(0); // message_id 含電話 → 唔存原值
    const row = await prisma.whatsappMessage.findFirstOrThrow({ where: { ignoreReason: "not_group" } });
    expect(row).toMatchObject({ status: "ignored", ignoreReason: "not_group", text: "", senderTelNorm: null, senderGuardId: null });
    expect(row.messageId.startsWith("private:")).toBe(true);
    expect(row.chatJid.startsWith("private:")).toBe(true);
    // 整行（所有欄）冇任何 8 位數字、冇 @c.us、冇電話
    const dump = JSON.stringify(row);
    expect(dump).not.toMatch(/\d{8}/);
    expect(dump).not.toContain("@c.us");
    expect(dump).not.toContain("85290000002");
    // 同一私訊重覆投遞：hash 穩定，仍然 1 行
    await post(msgEvent("false_85290000002@c.us_PRIV1", { from: "85290000002@c.us", participant: undefined, body: "私人訊息 不應保存" }));
    expect(await prisma.whatsappMessage.count({ where: { ignoreReason: "not_group" } })).toBe(1);
  });

  it("stale（>72h）→ ignored:stale；71 小時內照收", async () => {
    await post(msgEvent(MID("9"), { timestamp: nowSec() - 73 * 3600 }));
    await post(msgEvent(MID("10"), { timestamp: nowSec() - 71 * 3600 }));
    expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("9") } })).toMatchObject({ status: "ignored", ignoreReason: "stale" });
    expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("10") } })).toMatchObject({ status: "received", ignoreReason: null });
  });

  it("未來 >10 分鐘 → ignored:future_ts；9 分鐘內照收；毫秒 timestamp 亦認", async () => {
    await post(msgEvent(MID("11"), { timestamp: nowSec() + 11 * 60 }));
    await post(msgEvent(MID("12"), { timestamp: nowSec() + 9 * 60 }));
    await post(msgEvent(MID("13"), { timestamp: Date.now() }));
    expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("11") } })).toMatchObject({ status: "ignored", ignoreReason: "future_ts" });
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("12") } })).status).toBe("received");
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("13") } })).status).toBe("received");
  });

  it("媒體：只記 media_type（mimetype 主類），冇下載；caption 照存", async () => {
    await post(msgEvent(MID("14"), { hasMedia: true, media: { mimetype: "image/jpeg" }, body: "圖說明" }));
    await post(msgEvent(MID("15"), { hasMedia: true, media: { mimetype: "audio/ogg; codecs=opus" }, body: "" }));
    await post(msgEvent(MID("16"), { hasMedia: true }));
    expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("14") } })).toMatchObject({ mediaType: "image", text: "圖說明" });
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("15") } })).mediaType).toBe("audio");
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("16") } })).mediaType).toBe("unknown");
  });

  it("quoted（replyTo.id）記低；群組 last_message_at 更新", async () => {
    const admin = await prisma.user.findFirstOrThrow();
    await prisma.whatsappGroup.create({ data: { groupJid: GROUP, label: "測試群", createdBy: admin.id } });
    await post(msgEvent(MID("17"), {}, "message", { replyTo: { id: "orig-1" } }));
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("17") } })).quotedMessageId).toBe("orig-1");
    const g = await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: GROUP } });
    expect(g.lastMessageAt).not.toBeNull();
  });

  it("發訊人電話對應唯一保安員 → sender_guard_id；兩個保安員同號 → 唔估（null）", async () => {
    const g1 = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "cash_casual", tel: "90000001", createdBy: "test" } });
    await post(msgEvent(MID("18")));
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("18") } })).senderGuardId).toBe(g1.id);
    await prisma.guard.create({ data: { nameZh: "測試乙", employmentType: "cash_casual", tel: "90000001", createdBy: "test" } });
    await post(msgEvent(MID("19")));
    expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("19") } })).senderGuardId).toBeNull();
  });

  describe("編輯（message.edited）", () => {
    it("revision+1、舊文字入 text_history、status 重設 received、edited_at；已有 intents 標 source_changed", async () => {
      await post(msgEvent(MID("20")));
      await prisma.whatsappMessage.update({ where: { messageId: MID("20") }, data: { status: "parsed", filterScore: 77, parsedJson: { x: 1 } } });
      await prisma.whatsappIntent.create({ data: { messageId: MID("20"), messageRevision: 1, idx: 0, kind: "shift" } });
      const res = await post(msgEvent(MID("20"), { body: "測試甲 聽日返夜" }, "message.edited"));
      expect(res.status).toBe(200);
      const row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("20") } });
      expect(row).toMatchObject({ revision: 2, text: "測試甲 聽日返夜", status: "received", filterScore: null, parsedJson: null });
      expect(row.editedAt).not.toBeNull();
      expect(row.textHistory).toEqual([expect.objectContaining({ revision: 1, text: "測試甲 聽日返早" })]);
      expect((await prisma.whatsappIntent.findFirstOrThrow({ where: { messageId: MID("20") } })).sourceChanged).toBe(true);
      expect(await prisma.whatsappMessage.count({ where: { messageId: MID("20") } })).toBe(1);
    });

    it("同一編輯事件重覆投遞 → 唔再加 revision；第二次不同編輯 → revision 3、history 2 條；payload 用 editedMessageId 指向原訊息", async () => {
      await post(msgEvent(MID("21")));
      const edit1 = msgEvent("EDIT-EVT-1", { body: "v2" }, "message.edited", { editedMessageId: MID("21") });
      await post(edit1);
      await post(edit1);
      let row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("21") } });
      expect(row.revision).toBe(2);
      await post(msgEvent("EDIT-EVT-2", { body: "v3" }, "message.edited", { editedMessageId: MID("21") }));
      row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("21") } });
      expect(row).toMatchObject({ revision: 3, text: "v3" });
      expect((row.textHistory as unknown[]).length).toBe(2);
    });

    it("空內容／已撤回／ignored 訊息 → no-op（200）", async () => {
      await post(msgEvent(MID("23")));
      await post(msgEvent(MID("23"), { body: "" }, "message.edited"));
      expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("23") } })).revision).toBe(1);
      await post(msgEvent(MID("24"), { fromMe: true }));
      await post(msgEvent(MID("24"), { body: "改" }, "message.edited"));
      expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("24") } })).revision).toBe(1);
      await post(msgEvent(MID("25")));
      await post(msgEvent(MID("25"), {}, "message.revoked"));
      await post(msgEvent(MID("25"), { body: "撤回後編輯" }, "message.edited"));
      expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("25") } })).revision).toBe(1);
    });
  });

  describe("撤回（message.revoked）", () => {
    it("revoked_at、status=revoked、intents source_changed；重覆撤回 no-op", async () => {
      await post(msgEvent(MID("30")));
      await prisma.whatsappIntent.create({ data: { messageId: MID("30"), messageRevision: 1, idx: 0, kind: "leave" } });
      expect((await post(msgEvent("REV-EVT-1", {}, "message.revoked", { revokedMessageId: MID("30") }))).status).toBe(200);
      const row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("30") } });
      expect(row.status).toBe("revoked");
      expect(row.revokedAt).not.toBeNull();
      expect((await prisma.whatsappIntent.findFirstOrThrow({ where: { messageId: MID("30") } })).sourceChanged).toBe(true);
      const t1 = row.revokedAt!.getTime();
      await post(msgEvent("REV-EVT-1", {}, "message.revoked", { revokedMessageId: MID("30") }));
      expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("30") } })).revokedAt!.getTime()).toBe(t1);
    });

    it("用 before.id 指向原訊息亦得", async () => {
      await post(msgEvent(MID("31")));
      await post(msgEvent("REV-EVT-2", {}, "message.revoked", { before: { id: MID("31") } }));
      expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("31") } })).status).toBe("revoked");
    });
  });

  describe("大小／schema", () => {
    it("body >64KB → 413（content-length 預檢＋串流計數兩條路），唔落庫", async () => {
      const big = JSON.stringify(msgEvent(MID("40"), { body: "x".repeat(70 * 1024) }));
      expect((await post(null, { raw: big, contentLength: big.length })).status).toBe(413);
      expect((await post(null, { raw: big })).status).toBe(413); // 冇 content-length
      expect(await prisma.whatsappMessage.count()).toBe(0);
    });

    it("剛好 ≤64KB 通過", async () => {
      const ev = msgEvent(MID("41"), { body: "y".repeat(60 * 1024) });
      expect((await post(ev)).status).toBe(200);
      expect(await prisma.whatsappMessage.count()).toBe(1);
    });

    it("簽名正確但 JSON 壞／schema 錯／缺 id 或 from → 400 唔落庫", async () => {
      expect((await post(null, { raw: "{not json" , sig: sign("{not json") })).status).toBe(400);
      expect((await post({ payload: { id: "a" } })).status).toBe(400); // 冇 event
      expect((await post({ event: "message" })).status).toBe(400); // 冇 payload
      expect((await post(msgEvent(MID("42"), { fromMe: "yes" }))).status).toBe(400); // 型別錯
      expect((await post(msgEvent(MID("43"), { id: undefined }))).status).toBe(400); // 缺 id
      expect((await post(msgEvent(MID("44"), { from: undefined }))).status).toBe(400); // 缺 from
      expect(await prisma.whatsappMessage.count()).toBe(0);
    });

    it("未訂閱嘅事件類型（session.status）→ 200 唔處理", async () => {
      const res = await post({ event: "session.status", session: "default", payload: { status: "WORKING" } });
      expect(res.status).toBe(200);
      expect(await prisma.whatsappMessage.count()).toBe(0);
    });

    it("body 內嘅 session 落庫；冇就 default", async () => {
      await post({ ...msgEvent(MID("45")), session: "s2" });
      expect((await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("45") } })).session).toBe("s2");
    });
  });

  describe("W0.2 驗收修正：亂序／重放／tombstone／窗口", () => {
    const T = nowSec() - 3600;
    it("S1：A→B→C 之後重放 B（舊 timestamp）或同一 event id 換新 timestamp 再送 → 仍係 C", async () => {
      await post(msgEvent(MID("60"), { timestamp: T, body: "A" }));
      await post(msgEvent("EVT-B", { timestamp: T + 10, body: "B" }, "message.edited", { editedMessageId: MID("60") }));
      await post(msgEvent("EVT-C", { timestamp: T + 20, body: "C" }, "message.edited", { editedMessageId: MID("60") }));
      await post(msgEvent("EVT-B", { timestamp: T + 10, body: "B" }, "message.edited", { editedMessageId: MID("60") })); // 舊事件重放
      let row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("60") } });
      expect(row).toMatchObject({ text: "C", revision: 3 });
      await post(msgEvent("EVT-B", { timestamp: T + 30, body: "B" }, "message.edited", { editedMessageId: MID("60") })); // 同一 event id、新時間
      row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("60") } });
      expect(row).toMatchObject({ text: "C", revision: 3 });
      expect((row.textHistory as unknown[]).length).toBe(2);
    });
    it("S1（W0.3）：合法 A→B→A（t+10、t+20）→ revision 3、文字 A；B 重放（同 event id）no-op；timestamp 等於原訊息 ts 嘅編輯照處理；無 payload id 用 hash 去重", async () => {
      await post(msgEvent(MID("70"), { timestamp: T, body: "A" }));
      await post(msgEvent("EVT-1", { timestamp: T + 10, body: "B" }, "message.edited", { editedMessageId: MID("70") }));
      await post(msgEvent("EVT-2", { timestamp: T + 20, body: "A" }, "message.edited", { editedMessageId: MID("70") }));
      let row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("70") } });
      expect(row).toMatchObject({ text: "A", revision: 3 });
      expect((row.textHistory as { event_id?: string }[]).map((h) => h.event_id)).toEqual(["EVT-1", "EVT-2"]);
      await post(msgEvent("EVT-1", { timestamp: T + 25, body: "B" }, "message.edited", { editedMessageId: MID("70") }));
      row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("70") } });
      expect(row).toMatchObject({ text: "A", revision: 3 });
      // 編輯 timestamp 等於原訊息 ts：照處理
      await post(msgEvent(MID("71"), { timestamp: T, body: "X" }));
      await post(msgEvent("EVT-3", { timestamp: T, body: "Y" }, "message.edited", { editedMessageId: MID("71") }));
      expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("71") } })).toMatchObject({ text: "Y", revision: 2 });
      // 無獨立 payload id（id＝目標訊息 id）：同一事件重送（同 ts、同文字）→ hash 去重；之後回到舊文字（新 ts）→ 照處理
      await post(msgEvent(MID("72"), { timestamp: T, body: "P" }));
      await post(msgEvent(MID("72"), { timestamp: T + 5, body: "Q" }, "message.edited"));
      await post(msgEvent(MID("72"), { timestamp: T + 5, body: "Q" }, "message.edited"));
      await post(msgEvent(MID("72"), { timestamp: T + 9, body: "P" }, "message.edited"));
      expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("72") } })).toMatchObject({ text: "P", revision: 3 });
    });
    it("N3（W0.3）：編輯先到嘅 tombstone，原訊息後到補返 sender_guard_id／media_type／quoted／群 last_message_at，唔改文字", async () => {
      const admin = await prisma.user.findFirstOrThrow();
      await prisma.whatsappGroup.create({ data: { groupJid: GROUP, label: "測試群", createdBy: admin.id } });
      const g = await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "cash_casual", tel: "90000001", createdBy: "test" } });
      await post(msgEvent("EVT-T", { timestamp: T + 5, body: "編輯後" }, "message.edited", { editedMessageId: MID("73") }));
      let row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("73") } });
      expect(row).toMatchObject({ mediaType: null, quotedMessageId: null, senderGuardId: null });
      expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: GROUP } })).lastMessageAt).toBeNull();
      await post(msgEvent(MID("73"), { timestamp: T, body: "原文", hasMedia: true, media: { mimetype: "image/png" } }, "message", { replyTo: { id: "orig-q" } }));
      row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("73") } });
      expect(row).toMatchObject({ text: "編輯後", revision: 1, pendingEdit: true, status: "received", mediaType: "image", quotedMessageId: "orig-q", senderGuardId: g.id, senderTelNorm: "90000001", senderJid: SENDER });
      expect((await prisma.whatsappGroup.findUniqueOrThrow({ where: { groupJid: GROUP } })).lastMessageAt).not.toBeNull();
    });
    it("S1：編輯／撤回事件套 72h 窗口；冇 timestamp → no-op", async () => {
      await post(msgEvent(MID("61"), { timestamp: nowSec() - 10, body: "A" }));
      await post(msgEvent(MID("61"), { timestamp: nowSec() - 73 * 3600, body: "舊編輯" }, "message.edited"));
      await post(msgEvent(MID("61"), { timestamp: undefined, body: "無時間編輯" }, "message.edited"));
      await post(msgEvent(MID("61"), { timestamp: nowSec() + 11 * 60, body: "未來編輯" }, "message.edited"));
      await post(msgEvent(MID("61"), { timestamp: nowSec() - 73 * 3600 }, "message.revoked"));
      await post(msgEvent(MID("61"), { timestamp: undefined }, "message.revoked"));
      expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("61") } })).toMatchObject({ text: "A", revision: 1, status: "received", revokedAt: null });
      // 窗口外嘅編輯／撤回亦唔會為不存在嘅訊息寫 tombstone
      await post(msgEvent(MID("62"), { timestamp: nowSec() - 73 * 3600, body: "x" }, "message.edited"));
      await post(msgEvent(MID("62"), { timestamp: nowSec() - 73 * 3600 }, "message.revoked"));
      expect(await prisma.whatsappMessage.count({ where: { messageId: MID("62") } })).toBe(0);
    });
    it("S2：撤回先於原訊息 → tombstone（revoked、text 空）；原訊息後到保持 revoked、唔還原文字", async () => {
      expect((await post(msgEvent(MID("63"), {}, "message.revoked"))).status).toBe(200);
      let row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("63") } });
      expect(row).toMatchObject({ status: "revoked", text: "", chatJid: GROUP });
      expect(row.revokedAt).not.toBeNull();
      await post(msgEvent(MID("63"), { body: "遲到嘅原文" }));
      row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("63") } });
      expect(row).toMatchObject({ status: "revoked", text: "" });
      expect(await prisma.whatsappMessage.count({ where: { messageId: MID("63") } })).toBe(1);
    });
    it("S3：編輯先於原訊息 → tombstone（received、編輯後文字、revision 1、pending_edit）；原訊息後到 no-op 保留編輯後文字", async () => {
      await post(msgEvent(MID("64"), { body: "編輯後" }, "message.edited"));
      let row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("64") } });
      expect(row).toMatchObject({ status: "received", text: "編輯後", revision: 1, pendingEdit: true });
      await post(msgEvent(MID("64"), { body: "原文（遲到）" }));
      row = await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("64") } });
      expect(row).toMatchObject({ text: "編輯後", revision: 1, pendingEdit: true });
      // 之後再有更新嘅編輯 → 正常 revision+1 並清 pending_edit
      await post(msgEvent(MID("64"), { timestamp: nowSec() + 5, body: "再編輯" }, "message.edited"));
      expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("64") } })).toMatchObject({ text: "再編輯", revision: 2, pendingEdit: false });
    });
    it("N1：編輯／撤回事件 chat 同原行唔一致 → no-op（文字、狀態不變）＋warn 計數", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await post(msgEvent(MID("65"), { body: "A" }));
      await post(msgEvent(MID("65"), { from: "other-g@g.us", body: "被偷換" }, "message.edited"));
      await post(msgEvent(MID("65"), { from: "other-g@g.us" }, "message.revoked"));
      expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("65") } })).toMatchObject({ text: "A", revision: 1, status: "received", revokedAt: null });
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("chat_mismatch")).length).toBe(2);
    });
    it("N2：message payload 冇 timestamp → ignored:no_timestamp（唔用 now）", async () => {
      await post(msgEvent(MID("66"), { timestamp: undefined }));
      expect(await prisma.whatsappMessage.findUniqueOrThrow({ where: { messageId: MID("66") } })).toMatchObject({ status: "ignored", ignoreReason: "no_timestamp" });
    });
  });

  it("速度：落庫回應 <500ms（寬鬆上限；設計目標 <50ms 唔做解析）", async () => {
    await post(msgEvent(MID("50"))); // warm up
    const t0 = performance.now();
    await post(msgEvent(MID("51")));
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
