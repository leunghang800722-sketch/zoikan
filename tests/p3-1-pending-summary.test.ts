// P3-1.5：pending-summary 批量 loader／月份窗口／mapLimit。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as pendingSummary } from "@/app/api/roster-uploads/pending-summary/route";
import { loadReconcileInput, loadReconcileInputs, reconcileUpload, reconcileRosterUpload } from "@/lib/roster-upload/reconcile";
import { buildPendingSummary } from "@/lib/roster-upload/pending-summary";
import { mapLimit } from "@/lib/async/map-limit";
import { hkMonthStart } from "@/lib/dates";

function monthAgo(n: number): Date {
  const cur = hkMonthStart(new Date());
  return new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() - n, 1));
}

let seq = 0;
async function mkUpload(fx: Wp2Fixture, month: Date, rowCount: number, siteId: string | null = fx.site.id) {
  seq += 1;
  const up = await prisma.rosterUpload.create({
    data: { month, siteId, siteNameRaw: "測試盤", uploaderUserId: fx.userIds["老闆"], fileName: `p31-${seq}.xlsx`, fileSha256: `p31-${seq}`.padEnd(64, "0"), fileBytes: Buffer.from("x"), fileSize: 1, status: "parsed" },
  });
  for (let i = 1; i <= rowCount; i++) {
    await prisma.rosterUploadRow.create({
      data: {
        uploadId: up.id,
        rowIndex: i,
        workDate: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), i)),
        rawCode: i % 3 === 0 ? "OFF" : "N",
        codeKind: i % 3 === 0 ? "leave" : "shift",
        shiftTypeId: i % 3 === 0 ? null : fx.shiftType.id,
        resolvedSiteId: siteId,
        guardId: i % 2 ? fx.guardA.id : fx.guardB.id,
        guardMatch: "by_staff_no",
        settlementBrokerId: i % 4 === 0 ? null : fx.brokerA.id,
      },
    });
  }
  return up;
}

describe("P3-1.5 pending-summary", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
  });

  it("批量 loadReconcileInputs 每份結果同逐份 loadReconcileInput 完全一致（含對數分類）", async () => {
    const a = await mkUpload(fx, monthAgo(0), 9);
    const b = await mkUpload(fx, monthAgo(1), 7);
    const c = await mkUpload(fx, monthAgo(1), 5, null);
    const batch = await loadReconcileInputs([a.id, b.id, c.id]);
    for (const id of [a.id, b.id, c.id]) {
      const single = await loadReconcileInput(id);
      const strip = (x: Awaited<ReturnType<typeof loadReconcileInput>>) => {
        const { uploadMeta, ...rest } = x;
        void uploadMeta;
        const sorted = (arr: { rowId?: string; id?: string }[]) => [...arr].sort((p, q) => String(p.rowId ?? p.id).localeCompare(String(q.rowId ?? q.id)));
        return { ...rest, rosterEntries: sorted(rest.rosterEntries), unresolvedEntries: sorted(rest.unresolvedEntries), systemEntries: sorted(rest.systemEntries) };
      };
      expect(strip(batch.get(id)!)).toEqual(strip(single));
      expect(reconcileRosterUpload(batch.get(id)!)).toEqual((await reconcileUpload(id)).items);
    }
  });

  it("上載 id 不存在就拋錯", async () => {
    await expect(loadReconcileInputs(["00000000-0000-0000-0000-000000000000"])).rejects.toThrow();
  });

  it("預設只計本月＋上月；months=0 全部；months=1 淨本月；帶 month 照舊", async () => {
    const cur = await mkUpload(fx, monthAgo(0), 3);
    const prev = await mkUpload(fx, monthAgo(1), 3);
    const old = await mkUpload(fx, monthAgo(5), 3);
    const ids = (r: { entries: { upload_id: string }[] }) => r.entries.map((e) => e.upload_id).sort();

    expect(ids(await buildPendingSummary(null))).toEqual([cur.id, prev.id].sort());
    expect(ids(await buildPendingSummary(null, { months: 0 }))).toEqual([cur.id, prev.id, old.id].sort());
    expect(ids(await buildPendingSummary(null, { months: 1 }))).toEqual([cur.id]);
    expect(ids(await buildPendingSummary(monthAgo(5)))).toEqual([old.id]);

    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const call = async (q: string) => (await pendingSummary(new Request(`http://t/api/roster-uploads/pending-summary${q}`, { headers: { cookie } }))).json() as Promise<{ entries: { upload_id: string }[] }>;
    expect(ids(await call(""))).toEqual([cur.id, prev.id].sort());
    expect(ids(await call("?months=0"))).toEqual([cur.id, prev.id, old.id].sort());
    expect((await pendingSummary(new Request("http://t/api/roster-uploads/pending-summary?months=abc", { headers: { cookie } }))).status).toBe(400);
  });

  it("批量計算結果同逐份 reconcileUpload 一致（pending_count）", async () => {
    const ups = [await mkUpload(fx, monthAgo(0), 12), await mkUpload(fx, monthAgo(1), 8)];
    const summary = await buildPendingSummary(null, { months: 0 });
    for (const u of ups) {
      const { items } = await reconcileUpload(u.id);
      const expected = items.filter((i) => i.category !== "match").length;
      const got = summary.entries.find((e) => e.upload_id === u.id)?.pending_count ?? 0;
      expect(got).toBe(expected);
    }
  });
});

describe("mapLimit", () => {
  it("保持次序、最多 limit 併發", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
  it("任何一個 reject 就 reject；空陣列返空", async () => {
    await expect(mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("x"); return n; })).rejects.toThrow("x");
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
