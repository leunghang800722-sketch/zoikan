// P3 階段 4 單元測：audit 欄名 diff、斷點常數、derive 鎖定日期、UnpricedNotice 兩種版面、ConfirmDialog 序列化。
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React, { createElement } from "react";

// 元件檔用 automatic JSX runtime（Next），vitest 預設 classic transform → 提供全域 React。
(globalThis as unknown as { React: typeof React }).React = React;
import { auditFieldLabel, diffAuditFields } from "@/lib/ui/audit-field-labels";
import { SM_PX, LG_PX, MQ_BELOW_SM, MQ_BELOW_LG } from "@/lib/ui/breakpoints";
import { deriveStages, type UploadRow } from "@/components/month-close/derive";
import { UnpricedNotice } from "@/components/UnpricedNotice";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { choiceBtn } from "@/components/ui/button-classes";

describe("audit-field-labels", () => {
  it("camel／snake 都識，冇對照嘅 key 照原樣", () => {
    expect(auditFieldLabel("clientRate")).toBe("收客價");
    expect(auditFieldLabel("client_rate")).toBe("收客價");
    expect(auditFieldLabel("some_unknown_key")).toBe("some_unknown_key");
  });
  it("只顯示有改嘅欄", () => {
    const rows = diffAuditFields({ name: "甲", status: "active", note: null }, { name: "乙", status: "active", note: null });
    expect(rows).toEqual([{ key: "name", label: "名稱", before: "甲", after: "乙" }]);
  });
  it("新增／刪除欄、null 同非物件", () => {
    expect(diffAuditFields(null, { status: "x" })).toEqual([{ key: "status", label: "狀態", before: "（冇）", after: "x" }]);
    expect(diffAuditFields({ a: 1 }, null)[0]).toMatchObject({ before: "1", after: "（冇）" });
    expect(diffAuditFields({ inScope: true }, { inScope: false })[0]).toMatchObject({ label: "納入範圍", before: "是", after: "否" });
    expect(diffAuditFields({ x: { a: 1 } }, { x: { a: 1 } })).toEqual([]);
  });
});

describe("breakpoints", () => {
  it("只有 sm／lg 兩個，MQ 字串同常數一致", () => {
    expect(SM_PX).toBe(640);
    expect(LG_PX).toBe(1024);
    expect(MQ_BELOW_SM).toBe("(max-width: 639px)");
    expect(MQ_BELOW_LG).toBe("(max-width: 1023px)");
  });
});

describe("deriveStages 鎖定（P3-4.0）", () => {
  const uploads: UploadRow[] = [
    { key: "roster", name: "更表", hint: "", have: false, status: "" },
    { key: "staff_list", name: "名單", hint: "", have: false, status: "" },
    { key: "postorder", name: "總表", hint: "", have: false, status: "" },
  ] as unknown as UploadRow[];
  it("冇 run 但已鎖定：⑤ 已鎖定（日期）", () => {
    const st = deriveStages({ run: null, report: null, uploads, locked: true, lockedAt: "2099-04-02T03:00:00.000Z" });
    expect(st[4]).toMatchObject({ key: "lock", state: "ok" });
    expect(st[4]!.sub).toMatch(/^已鎖定（4\/2）$/);
  });
  it("未鎖又冇 run：未到", () => {
    const st = deriveStages({ run: null, report: null, uploads, locked: false });
    expect(st[4]).toMatchObject({ state: "todo", sub: "未到" });
  });
});

describe("共用元件 render", () => {
  const g = { site_id: "s", site_name: "測試盤", shift_type_code: "D", broker_code: "W", broker_display: "W", count: 2 };
  it("UnpricedNotice compact：一行＋去處理 ›（帶 ?month=）", () => {
    const html = renderToStaticMarkup(createElement(UnpricedNotice, { variant: "compact", month: "2026-09", unpricedCount: 3, noSettlementCount: 0, groups: [g], scope: "毛利表" }));
    expect(html).toContain("3 更未定價");
    expect(html).toContain("毛利表");
    expect(html).toContain('href="/rate-cards?month=2026-09"');
    expect(html).not.toContain("測試盤"); // 報表頁唔列逐組清單
  });
  it("UnpricedNotice full：逐組清單、冇結算單位獨立出", () => {
    const html = renderToStaticMarkup(createElement(UnpricedNotice, { variant: "full", month: "2026-09", unpricedCount: 3, noSettlementCount: 1, groups: [g, { ...g, category: "no_settlement" as const }], canReprice: true, onReprice: () => {} }));
    expect(html).toContain("測試盤");
    expect(html).toContain("重新計價（2026-09）");
    expect(html).toContain("no-settlement-notice");
  });
  it("UnpricedNotice 兩樣都 0 → 唔出", () => {
    expect(renderToStaticMarkup(createElement(UnpricedNotice, { variant: "compact", month: "2026-09", unpricedCount: 0, noSettlementCount: 0, groups: [] }))).toBe("");
  });
  it("Banner：message／children／compact／空值", () => {
    expect(renderToStaticMarkup(createElement(Banner, { kind: "error", message: null }))).toBe("");
    expect(renderToStaticMarkup(createElement(Banner, { kind: "info", message: "hi" }))).toContain("hi");
    expect(renderToStaticMarkup(createElement(Banner, { kind: "warning", compact: true, action: "A" }, "body"))).toContain("rounded-full");
  });
  it("Button：variant／size class", () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: "primary", size: "sm" }, "x"));
    expect(html).toContain("bg-zk-primary");
    expect(html).toContain("text-zk-sm");
    expect(html).toContain('type="button"');
  });
  it("choiceBtn", () => {
    expect(choiceBtn(true)).toContain("border-zk-primary");
    expect(choiceBtn(false)).not.toContain("border-zk-primary");
  });
});
