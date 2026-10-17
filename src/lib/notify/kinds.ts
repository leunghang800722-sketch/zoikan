// P7.1：通知類別（users.notify_prefs 開關按呢啲 key；冇該 key＝開）。client-safe（冇 DB）。
export const NOTIFY_KINDS = [
  { kind: "month_opened", label: "新月已開好" },
  { kind: "rate_cards_pending", label: "價卡待確認" },
  { kind: "month_health_red", label: "體檢有新紅項" },
  { kind: "month_ready_to_lock", label: "可以鎖月" },
  { kind: "triage_reminder", label: "待答題催辦" },
  { kind: "one_click_auto", label: "自動一鍵結算結果" },
  { kind: "month_files_ready", label: "鎖月後檔案已備妥" },
  { kind: "permit_expiry_weekly", label: "證件到期週報" },
  { kind: "sl_drafts_pending", label: "病假要確認醫生紙" },
  { kind: "ops_digest_ready", label: "每月修正摘要" },
  { kind: "job_failed", label: "排程出錯" },
  { kind: "whatsapp_triage", label: "WhatsApp 報更有新分流題" },
] as const;

export const NOTIFY_KIND_SET: ReadonlySet<string> = new Set(NOTIFY_KINDS.map((k) => k.kind));

export function kindLabel(kind: string): string {
  return NOTIFY_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}
