"use client";
// P3-4.3：頁內 tab 列（保安員 Drawer、長工糧頁）。只管 tab 列；內容由呼叫方用 `hidden` 切換（保持 mount，唔丟 state）。
export interface TabDef<K extends string> {
  key: K;
  label: string;
  /** false＝隱藏（例如冇權）。 */
  show?: boolean;
  testId?: string;
}

export function Tabs<K extends string>({ value, onChange, tabs, testId }: { value: K; onChange: (k: K) => void; tabs: TabDef<K>[]; testId?: string }) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-zk-border" data-testid={testId}>
      {tabs
        .filter((t) => t.show !== false)
        .map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={value === t.key}
            data-testid={t.testId}
            onClick={() => onChange(t.key)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-zk-base ${value === t.key ? "border-zk-primary font-semibold text-zk-primary" : "border-transparent text-zk-muted hover:text-zk-text"}`}
          >
            {t.label}
          </button>
        ))}
    </div>
  );
}
