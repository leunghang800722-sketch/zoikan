// 保安員 Drawer（新增／編輯）：容器＋tab 組合。
// P3-5.2：由 GuardsClient.tsx 原樣搬出，行為零改變。
// 各區塊 DOM 次序同搬出前完全一致（e2e 有靠 `.first()` 揀欄），只係按 tab 分檔。
"use client";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Pill } from "@/components/ui/Pill";
import { Tabs } from "@/components/ui/Tabs";
import type { BrokerRow, GuardRow, SiteRow } from "./guards-types";
import { tabClsFor } from "./guards-utils";
import type { GuardForm } from "./useGuardForm";
import { BankTab } from "./drawer/BankTab";
import { BasicMain, BasicMisc, PiiSection } from "./drawer/BasicTab";
import { AddressContactSection, PhonesSection } from "./drawer/ContactsTab";
import { BlacklistSection, LicenceSection, StaffNumbersSection } from "./drawer/DocsTab";
import { LongtermTab } from "./drawer/LongtermTab";

export function GuardDrawer({
  g,
  rows,
  brokers,
  sites,
  isBroker,
  hasMoneyField,
  hasPiiField,
  hasBankField,
  hasLicenceExtraField,
}: {
  g: GuardForm;
  rows: GuardRow[];
  brokers: BrokerRow[];
  sites: SiteRow[];
  isBroker: boolean;
  hasMoneyField: boolean;
  hasPiiField: boolean;
  hasBankField: boolean;
  hasLicenceExtraField: boolean;
}) {
  const { drawerOpen, setDrawerOpen, editingId, onSubmit, drawerTab, setDrawerTab, formError, saving, detailLoaded } = g;
  // P3-4.3（H18）：Drawer 分 tab（基本／證件／聯絡／長工／銀行）；只係分組顯示，各區塊（連權限遮罩）一律照舊 mount。
  const tabCls = tabClsFor(drawerTab);
  return (
      <Drawer open={drawerOpen} title={editingId ? "編輯保安員" : "新增保安員"} onClose={() => setDrawerOpen(false)}>
        <form
          onSubmit={onSubmit}
          // 隱藏 tab 入面有 invalid／required 欄：瀏覽器會靜靜擋住 submit——自動跳去嗰個 tab 再顯示原生提示。
          onInvalidCapture={(e) => {
            const el = e.target as HTMLInputElement;
            // 多個欄同時 invalid：瀏覽器逐個欄觸發 invalid 事件，唔限制就會跳去最後一個——只處理 DOM 次序最前嗰個。
            const first = e.currentTarget.querySelector("input:invalid, select:invalid, textarea:invalid");
            if (first && first !== el) return;
            const m = el.closest('[data-testid^="guard-tab-panel-"]')?.getAttribute("data-testid")?.match(/guard-tab-panel-([a-z]+)/);
            const tab = m?.[1] as typeof drawerTab | undefined;
            if (tab && tab !== drawerTab) {
              setDrawerTab(tab);
              setTimeout(() => el.reportValidity?.(), 0);
            }
          }}
          className="space-y-3"
        >
          <Banner kind="error" message={formError} />
          {editingId && (() => {
            const st = rows.find((r) => r.id === editingId)?.identity_status;
            if (!st) return null;
            const reviewFields = rows.find((r) => r.id === editingId)?.identity_review_fields ?? [];
            return (
              <div className="flex items-center gap-2 text-xs text-zk-faint">
                {reviewFields.includes("name_zh") ? <Pill variant="warning">姓名待核對</Pill> : null}
                識別狀態（身份證＋電話）：
                {st === "complete" ? <Pill variant="success">齊</Pill> : <Pill variant="warning">{st === "missing_hkid" ? "缺身份證" : st === "missing_tel" ? "缺電話" : "缺身份證及電話"}</Pill>}
              </div>
            );
          })()}
          {editingId && (
            <Tabs
              testId="guard-drawer-tabs"
              value={drawerTab}
              onChange={setDrawerTab}
              tabs={[
                { key: "basic", label: "基本", testId: "guard-tab-basic" },
                { key: "docs", label: "證件", testId: "guard-tab-docs" },
                { key: "contact", label: "聯絡", testId: "guard-tab-contact" },
                { key: "longterm", label: "長工", show: !isBroker, testId: "guard-tab-longterm" },
                { key: "bank", label: "銀行", show: hasBankField, testId: "guard-tab-bank" },
              ]}
            />
          )}
          <BasicMain g={g} tabCls={tabCls} />

          <PhonesSection g={g} tabCls={tabCls} isBroker={isBroker} />

          <BasicMisc g={g} tabCls={tabCls} brokers={brokers} hasMoneyField={hasMoneyField} />

          <LongtermTab g={g} tabCls={tabCls} isBroker={isBroker} brokers={brokers} sites={sites} />

          <LicenceSection g={g} tabCls={tabCls} hasLicenceExtraField={hasLicenceExtraField} />

          <StaffNumbersSection g={g} tabCls={tabCls} isBroker={isBroker} />

          {editingId && hasPiiField && (
            <>
              <PiiSection g={g} tabCls={tabCls} />
              <AddressContactSection g={g} tabCls={tabCls} isBroker={isBroker} />
              <BlacklistSection g={g} tabCls={tabCls} />
            </>
          )}

          <BankTab g={g} tabCls={tabCls} hasBankField={hasBankField} />

          <div className="flex gap-2 pt-2">
            {/* Fable5.1（防資料被抹）：detail GET（PII/銀行嗰批 detail-only
                欄嘅真正來源）未完成之前 Save 一律 disabled——防止用戶用
                列表 row 起草嗰陣嘅空值（唔係真係「未填」，淨係列表 DTO
                冇呢批欄）撳「儲存」送 `|| null` 清走已有資料，見 openEdit()
                頂註解。 */}
            <Button variant="primary" size="sm" type="submit" disabled={saving || !detailLoaded}>
              {!detailLoaded ? "載入中…" : saving ? "儲存緊…" : "儲存"}
            </Button>
            <Button variant="secondary" size="sm" type="button" onClick={() => setDrawerOpen(false)}>
              取消
            </Button>
          </div>
        </form>
      </Drawer>
  );
}
