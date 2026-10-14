// P17.4：合約編輯表單——清空結束日要送 effective_to:null；API 真係存 null；409 contract_overlap 訊息；ISO 日期截斷。
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma, clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser } from "./fixtures/wp2-fixture";
import { contractErrorMessage, contractPatchBody, dateInputValue } from "@/lib/longterm-payroll/contract-form";
import { apiPatch } from "@/lib/ui/api-client";
import { PATCH as patchContract } from "@/app/api/longterm/contracts/[id]/route";

afterAll(async () => {
  await clearAll();
  await prisma.$disconnect();
});

describe("P17.4 純函數", () => {
  it("dateInputValue：ISO 日期時間截成 YYYY-MM-DD；null／空 → 空字串", () => {
    expect(dateInputValue("2026-08-31T00:00:00.000Z")).toBe("2026-08-31");
    expect(dateInputValue("2026-08-31")).toBe("2026-08-31");
    expect(dateInputValue(null)).toBe("");
    expect(dateInputValue(undefined)).toBe("");
  });

  it("contractPatchBody：結束日清空 → effective_to: null（key 存在，唔係 undefined）", () => {
    const b = contractPatchBody("15500", "");
    expect(b).toEqual({ monthly_salary: 15500, effective_to: null });
    expect("effective_to" in b).toBe(true);
    expect(JSON.parse(JSON.stringify(b))).toEqual({ monthly_salary: 15500, effective_to: null });
    expect(contractPatchBody("15500", "2027-12-31").effective_to).toBe("2027-12-31");
    expect(contractPatchBody("15500", "  ").effective_to).toBeNull();
  });

  it("contractErrorMessage：409 contract_overlap 補提示；其他 4xx 原文", () => {
    const m = contractErrorMessage({ status: 409, error: "contract_overlap", message: "同一保安員已有日期重疊嘅生效合約（2027-01-01～無結束日）。請先調整或作廢重疊嘅合約" });
    expect(m).toContain("2027-01-01～無結束日");
    expect(m).toContain("先結束或作廢另一段");
    expect(contractErrorMessage({ status: 400, error: "bad_request", message: "月薪要大過 0" })).toBe("月薪要大過 0");
  });

  it("apiPatch 真係將 effective_to:null 放入 request body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    try {
      await apiPatch("/api/longterm/contracts/x", contractPatchBody("15500", ""));
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ monthly_salary: 15500, effective_to: null });
  });
});

describe("P17.4 API：PATCH effective_to null／重疊 409", () => {
  let ownerCookie: string;
  let guardId: string;
  beforeEach(async () => {
    await clearAll();
    const fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);
    guardId = (await prisma.guard.create({ data: { nameZh: "測試甲", employmentType: "longterm_autopay", hireDate: new Date("2020-01-01"), createdBy: "test" } })).id;
  });
  const patch = (id: string, body: unknown) => patchContract(new Request("http://t/x", { method: "PATCH", headers: { "content-type": "application/json", cookie: ownerCookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

  it("effective_to:null 清空結束日（DB 真係 null，DTO 回 null）", async () => {
    const c = await prisma.guardLongtermContract.create({ data: { guardId, monthlySalary: 15500, effectiveFrom: new Date("2027-01-01"), effectiveTo: new Date("2027-12-31"), source: "manual", createdBy: "test" } });
    const res = await patch(c.id, contractPatchBody("15500", ""));
    expect(res.status).toBe(200);
    expect((await res.json()).effective_to).toBeNull();
    expect((await prisma.guardLongtermContract.findUniqueOrThrow({ where: { id: c.id } })).effectiveTo).toBeNull();
  });

  it("清空結束日但後面仲有另一段合約 → 409 contract_overlap，message 列出重疊日期；DB 不變", async () => {
    const a = await prisma.guardLongtermContract.create({ data: { guardId, monthlySalary: 15500, effectiveFrom: new Date("2027-01-01"), effectiveTo: new Date("2027-06-30"), source: "manual", createdBy: "test" } });
    await prisma.guardLongtermContract.create({ data: { guardId, monthlySalary: 16000, effectiveFrom: new Date("2027-07-01"), effectiveTo: null, source: "manual", createdBy: "test" } });
    const res = await patch(a.id, contractPatchBody("15500", ""));
    expect(res.status).toBe(409);
    const j = await res.json();
    expect(j.error).toBe("contract_overlap");
    expect(j.message).toContain("2027-07-01");
    expect((await prisma.guardLongtermContract.findUniqueOrThrow({ where: { id: a.id } })).effectiveTo).not.toBeNull();
  });
});
