// EMP-P2 第 4／5 部分：長工頂位規則（2026-09-01 起睇更次 staff_scheme；U／MP 散更唔計頂位津貼；7／8 月舊邏輯）＋月結診斷兩個新數。
import { describe, it, expect, afterAll } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { loadCoverShifts } from "@/lib/longterm-payroll/cover-shifts";
import { classifyLongtermShift, LONGTERM_SCATTER_EFFECTIVE_FROM } from "@/lib/longterm-payroll/shift-classify";
import { loadStaffSchemes } from "@/lib/guards/staff-schemes";
import { buildMonthHealth } from "@/lib/ops/month-health";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import { p10Base, mkLongterm, shiftAt, D, AUG_MONTH, SEP_MONTH } from "./p10-helpers";

function sys(userId: string): AuthedSession {
  return { userId, tel: "", name: "", roleId: "", roleName: "老闆", baseRole: "老闆", brokerId: null, guardId: null, payoutApprovalLimit: null, tokenVersion: 0, loggedInAt: new Date().toISOString() };
}

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("classifyLongtermShift（EMP-P2 頂位規則）", () => {
  it("生效日 2026-09-01；之前舊邏輯；之後睇 staff_scheme：MG＝own、U／MP＝scatter、null＋B07＝own、null＋其他雞頭＝cover", async () => {
    expect(LONGTERM_SCATTER_EFFECTIVE_FROM.toISOString().slice(0, 10)).toBe("2026-09-01");
    const schemes = await loadStaffSchemes();
    const c = (settle: string | null, scheme: string | null, date: Date) => classifyLongtermShift(settle, "B07", { staffScheme: scheme, workDate: date, schemes });
    // 7／8 月（生效前）：即使有 U／MP scheme 都行舊邏輯（非 B07 有結算＝cover）
    expect(c("EXT", "U", D(8, 31))).toBe("cover");
    expect(c("EXT", "MP", D(8, 15))).toBe("cover");
    // 9 月起
    expect(c("EXT", "U", D(9, 1))).toBe("scatter");
    expect(c("EXT", "MP", D(9, 20))).toBe("scatter");
    expect(c("EXT", "MG", D(9, 20))).toBe("own"); // MG 即使結算唔係 B07 都係自己崗位
    expect(c("B07", null, D(9, 20))).toBe("own");
    expect(c(null, null, D(9, 20))).toBe("own_unsettled");
    expect(c("EXT", null, D(9, 20))).toBe("cover"); // 冇 scheme → 照舊
    expect(c("EXT", "MW", D(9, 20))).toBe("cover"); // 非前線非長工體系 → 照舊
    // 冇傳 opts（舊 call site）＝完全舊邏輯
    expect(classifyLongtermShift("EXT", "B07")).toBe("cover");
  });
});

describe("loadCoverShifts：9 月起 U／MP 卡散更唔計頂位津貼；8 月舊邏輯不變", () => {
  it("同一長工：9 月 U／MP／null scheme 外判更 → 只有 null scheme 係頂位；8 月 U scheme 外判更仍係頂位", async () => {
    const b = await p10Base();
    const g = await mkLongterm(b, "測試甲");
    const put = async (date: Date, scheme: string | null) => {
      const r = await shiftAt(b, g.id, "B", date);
      if (scheme) await prisma.shiftRecord.update({ where: { id: r.id }, data: { staffScheme: scheme } });
    };
    await put(D(9, 3), "U");
    await put(D(9, 4), "MP");
    await put(D(9, 5), null);
    await put(D(8, 6), "U"); // 生效前
    const sep = await loadCoverShifts([SEP_MONTH]);
    expect(sep.shifts.map((s) => s.date)).toEqual(["2026-09-05"]);
    const aug = await loadCoverShifts([AUG_MONTH]);
    expect(aug.shifts.map((s) => s.date)).toEqual(["2026-08-06"]);
  });
});

describe("月結診斷：未標工號更次／盤未設 staff_scheme（直達卡）", () => {
  it("shifts_no_staff_number 計未標工號（鎖月側表有歸屬唔計）；site_no_staff_scheme 計有出更而未設 scheme 嘅盤；設咗就消失", async () => {
    const b = await p10Base();
    const g = await mkLongterm(b, "測試乙");
    const card = await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "U", number: "U90951", status: "current" } });
    const r1 = await shiftAt(b, g.id, "B", D(9, 3)); // 未標
    await shiftAt(b, g.id, "B", D(9, 4)); // 未標
    const r3 = await shiftAt(b, g.id, "C", D(9, 5)); // 已標（shift_records）
    await prisma.shiftRecord.update({ where: { id: r3.id }, data: { staffNumberId: card.id, staffScheme: "U" } });
    const r4 = await shiftAt(b, g.id, "C", D(9, 6)); // 只有側表
    await prisma.shiftRecordStaffAttribution.create({ data: { shiftRecordId: r4.id, staffNumberId: card.id, staffScheme: "U", source: "backfill:range" } });
    void r1;
    const session = sys(b.actorUserId);
    const h = await buildMonthHealth(SEP_MONTH, session);
    const f1 = h.findings.find((f) => f.code === "shifts_no_staff_number")!;
    expect(f1).toMatchObject({ count: 2, severity: "warn", fixLink: "/sites" });
    expect(f1.detail).toEqual([{ site_name: b.sites.B.name, shifts: 2 }]);
    const f2 = h.findings.find((f) => f.code === "site_no_staff_scheme")!;
    expect(f2.count).toBe(2); // 盤 B、C 都有出更而未設
    expect(f2.fixLink).toBe("/sites");
    await prisma.site.updateMany({ where: { id: { in: [b.sites.B.id, b.sites.C.id] } }, data: { staffScheme: "U" } });
    const h2 = await buildMonthHealth(SEP_MONTH, session);
    expect(h2.findings.find((f) => f.code === "site_no_staff_scheme")).toBeUndefined();
    expect(h2.findings.find((f) => f.code === "shifts_no_staff_number")!.count).toBe(2); // 設咗 scheme 唔會自動標返舊更（要回填）
  });
});
