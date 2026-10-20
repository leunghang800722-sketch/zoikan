// AI-PII-2.2：離職生效（status inactive）後，更表編輯器對佢當月較早更次仍要顯示人名；揀人選單（新增更次）只出在職。
import { describe, it, expect, beforeEach } from "vitest";
import { clearAll, prisma } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { GET as guardsGet } from "@/app/api/guards/route";
import { buildRowsAndCells, selectableGuards } from "@/app/(app)/roster/[site]/[month]/editor/roster-utils";
import { flipLeftGuards } from "@/lib/guards/flip-left";
import type { GuardDto, ShiftRecordDto, ShiftTypeDto } from "@/app/(app)/roster/[site]/[month]/editor/roster-types";

const D = (m: number, d: number) => new Date(Date.UTC(2026, m - 1, d));

describe("AI-PII-2.2 離職者當月較早更次人名", () => {
  let fx: Wp2Fixture;
  beforeEach(async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    await prisma.staffScheme.upsert({ where: { code: "MG" }, update: { isLongterm: true }, create: { code: "MG", labelZh: "MG", isLongterm: true, isFrontline: false, sort: 3 } });
  });

  it("10/25 離職（離職生效後 inactive）、10/26 開 10 月更表：fields=lite 預設唔出佢（舊 bug：名空），include_inactive=1 出；編輯器 10/1–25 行有名；揀人選單冇佢", async () => {
    const g = await prisma.guard.create({ data: { nameZh: "測試離職甲", employmentType: "longterm_autopay", hireDate: D(1, 1), leaveDate: D(10, 25), createdBy: "t" } });
    await prisma.guardStaffNumber.create({ data: { guardId: g.id, scheme: "MG", number: "MG99971", status: "former", validFrom: D(1, 1), validTo: D(10, 25), endReason: "resigned" } });
    expect((await flipLeftGuards(new Date("2026-10-26T04:00:00Z"))).flipped).toBe(1); // 10/26 離職生效
    expect((await prisma.guard.findUniqueOrThrow({ where: { id: g.id } })).status).toBe("inactive");

    const cookie = await sessionCookieForUser(fx.userIds["老闆"]);
    const lite = async (qs: string) => ((await (await guardsGet(new Request(`http://test.local/api/guards?fields=lite${qs}`, { headers: { cookie } }))).json()) as { rows: GuardDto[] }).rows;
    expect((await lite("")).some((r) => r.id === g.id)).toBe(false); // 預設只出 active（舊行為）
    const withInactive = await lite("&include_inactive=1");
    expect(withInactive.find((r) => r.id === g.id)).toMatchObject({ name_zh: "測試離職甲", status: "inactive" });

    const st = { id: "st1", code: "N" } as unknown as ShiftTypeDto;
    const rec = (day: number) => ({ id: `r${day}`, work_date: `2026-10-${String(day).padStart(2, "0")}`, site_id: "s", shift_type_id: "st1", guard_id: g.id, settlement_broker_id: null, record_type: "shift", leave_code: null, status: "confirmed", source: null, staff_number_id: null }) as unknown as ShiftRecordDto;
    const records = [rec(1), rec(25)];
    const oldMap = new Map((await lite("")).map((r) => [r.id, r]));
    expect(buildRowsAndCells(records, new Map([["st1", st]]), oldMap).rows[0]!.guardName).toBe(""); // 舊 bug：名空
    const newMap = new Map(withInactive.map((r) => [r.id, r]));
    const built = buildRowsAndCells(records, new Map([["st1", st]]), newMap);
    expect(built.rows[0]!.guardName).toBe("測試離職甲");
    expect(built.cells.size).toBe(2);
    // 揀人選單：只出在職
    const options = selectableGuards(newMap.values());
    expect(options.some((o) => o.id === g.id)).toBe(false);
    expect(options.length).toBe(withInactive.filter((r) => r.status !== "inactive").length);
  });
});
