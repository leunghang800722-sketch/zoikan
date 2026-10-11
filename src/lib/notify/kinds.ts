// P7.1：通知類別（users.notify_prefs 開關按呢啲 key；冇該 key＝開）。client-safe（冇 DB）。
export const NOTIFY_KINDS = [
  { kind: "month_opened", label: "新月已開好" },
  { kind: "rate_cards_pending", label: "價卡待確認" },
  { kind: "month_health_red", label: "體檢有新紅項" },
  { kind: "month_ready_to_lock", label: "可以鎖月" },
  { kind: "triage_reminder", label: "待答題催辦" },
  { kind: "job_failed", label: "排程出錯" },
] as const;

export type NotifyKind = (typeof NOTIFY_KINDS)[number]["kind"];

export const NOTIFY_KIND_SET: ReadonlySet<string> = new Set(NOTIFY_KINDS.map((k) => k.kind));

export function kindLabel(kind: string): string {
  return NOTIFY_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}
