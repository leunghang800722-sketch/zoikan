"use client";
// P3-3.4：「更多 ▾」／「新增 ▾」下拉選單——主掣之外嘅次要動作收埋一個掣。
// 項目可以係連結（`href`，內部用 next/link，`download` 為 true 或 `/api/` 開頭用原生 <a> 下載）或者 `onSelect`。
// 撳項目／撳外面／Esc 關閉。
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  href?: string;
  /** 下載檔案（用原生 <a>，唔經 client router）。 */
  download?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
  testId?: string;
}

export function MenuButton({ label, items, variant = "secondary", testId }: { label: string; items: MenuItem[]; variant?: "primary" | "secondary"; testId?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const btnCls =
    variant === "primary"
      ? "border-zk-primary bg-zk-primary text-white font-semibold hover:bg-zk-primary-dark"
      : "border-zk-input-border bg-white text-zk-text-secondary hover:bg-zk-header";
  const itemCls = "block w-full px-3.5 py-2 text-left text-zk-base text-zk-text-secondary hover:bg-zk-header disabled:cursor-not-allowed disabled:opacity-[.45]";

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`rounded-md border px-3.5 py-[7px] text-zk-base transition-colors ${btnCls}`}
      >
        {label} ▾
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 min-w-[200px] overflow-hidden rounded-md border border-zk-border bg-white py-1 shadow-[0_8px_24px_rgba(15,23,42,.14)]">
          {items.map((it) => {
            if (it.href && !it.disabled) {
              const native = it.download || it.href.startsWith("/api/");
              return native ? (
                <a key={it.label} role="menuitem" href={it.href} data-testid={it.testId} className={itemCls} onClick={() => setOpen(false)}>
                  {it.label}
                </a>
              ) : (
                <Link key={it.label} role="menuitem" href={it.href} data-testid={it.testId} className={itemCls} onClick={() => setOpen(false)}>
                  {it.label}
                </Link>
              );
            }
            return (
              <button
                key={it.label}
                type="button"
                role="menuitem"
                data-testid={it.testId}
                disabled={it.disabled}
                className={itemCls}
                onClick={() => {
                  setOpen(false);
                  it.onSelect?.();
                }}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
