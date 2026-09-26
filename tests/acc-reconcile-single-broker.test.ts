// 驗收（Opus 5.5，2026-09-26）：更表有雞頭碼欄但部分行漏填——同張上載同
// 一個盤其他行只有一個雞頭碼，漏填行跟佢（同總表「補：總表該盤唯一雞頭」
// 一致）；多過一個雞頭就唔估（跌返規則 8 fallback 鏈）。合成 fixture。
import { describe, it, expect, beforeEach } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { loadReconcileInput } from "@/lib/roster-upload/reconcile";

const MONTH = new Date("2026-08-01T00:00:00.000Z");

describe("reconcile：漏填雞頭碼跟同盤唯一雞頭", () => {
  beforeEach(async () => {
    await clearAll();
  });

  async function setup(codes: (string | null)[]) {
    const role = await prisma.role.findFirstOrThrow({ where: { name: "老闆" } });
    const user = await prisma.user.create({ data: { name: "測試老闆", tel: `9${Math.floor(1000000 + Math.random() * 8999999)}`, passwordHash: "x", roleId: role.id, createdBy: "test" } });
    const brokers = new Map<string, string>();
    for (const c of ["TK", "TW", "TY"]) brokers.set(c, (await prisma.broker.create({ data: { code: c, name: `測試${c}`, kind: c === "TY" ? "internal_cash" : "broker", settlementType: "cash", createdBy: "test" } })).id);
    const site = await prisma.site.create({ data: { canonicalName: "測試漏填盤", clientName: "測試客戶", billingModel: "per_shift", createdBy: "test" } });
    const st = await prisma.shiftType.create({ data: { siteId: site.id, code: "D", label: "日更", hours: 12, createdBy: "test" } });
    const upload = await prisma.rosterUpload.create({
      data: { month: MONTH, siteId: site.id, siteNameRaw: "測試漏填盤", uploaderUserId: user.id, fileName: "t.xlsx", fileSha256: `sha-${Math.random()}`, fileBytes: Buffer.from("x"), fileSize: 1 },
    });
    const guardIds: string[] = [];
    for (let i = 0; i < codes.length; i++) {
      // 新散工：冇歷史、default_broker 係 TY（guard-fix 冇雞頭資料嗰陣嘅預設）
      const g = await prisma.guard.create({ data: { nameZh: `測試散工${i}`, employmentType: "cash_casual", defaultBrokerId: brokers.get("TY")!, createdBy: "test" } });
      guardIds.push(g.id);
      await prisma.rosterUploadRow.create({
        data: { uploadId: upload.id, rowIndex: 10 + i, workDate: new Date("2026-08-03"), rawCode: "D", codeKind: "shift", shiftTypeId: st.id, resolvedSiteId: site.id, guardId: g.id, guardMatch: "by_name", settlementBrokerId: codes[i] ? brokers.get(codes[i]!)! : null, brokerCodeRaw: codes[i] },
      });
    }
    return { upload, brokers, guardIds };
  }

  it("其他行得一個雞頭（TK）→ 漏填行跟 TK，標 inferred", async () => {
    const { upload, brokers, guardIds } = await setup(["TK", "TK", null]);
    const input = await loadReconcileInput(upload.id);
    const blank = input.rosterEntries.find((e) => e.guardId === guardIds[2])!;
    expect(blank.settlementBrokerId).toBe(brokers.get("TK"));
    expect(blank.operationalBrokerId).toBe(brokers.get("TK"));
    expect(blank.settlementInferred).toBe(true);
  });

  it("其他行有兩個雞頭 → 唔估，跌返 fallback（default_broker TY）", async () => {
    const { upload, brokers, guardIds } = await setup(["TK", "TW", null]);
    const input = await loadReconcileInput(upload.id);
    const blank = input.rosterEntries.find((e) => e.guardId === guardIds[2])!;
    expect(blank.settlementBrokerId).toBe(brokers.get("TY"));
  });

  it("成張冇雞頭碼 → 行為不變（fallback）", async () => {
    const { upload, brokers, guardIds } = await setup([null, null]);
    const input = await loadReconcileInput(upload.id);
    expect(input.rosterEntries.find((e) => e.guardId === guardIds[0])!.settlementBrokerId).toBe(brokers.get("TY"));
  });
});
