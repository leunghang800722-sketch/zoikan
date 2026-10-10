// WP-R1 共用元件：按鈕（README「頁首模式」／「深色」按鈕）。
// P3-4.2：全站按鈕唯一元件。variant＝primary（藍）／secondary（白）／dark（近黑，鎖定類）／danger（紅邊）／dangerSolid（紅底，確認作廢）／ghost（無邊）／link／linkDanger（連結樣）；
// size＝md（頁首／表單主要動作）／sm（Drawer、表格內、行內動作）。
// 只有格仔表／鍵盤／icon 專用按鈕先用 `button-classes.ts` 嘅 3 個命名 class。
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "dark" | "danger" | "dangerSolid" | "ghost" | "link" | "linkMuted" | "linkDanger";
export type ButtonSize = "sm" | "md";

const VARIANT_CLS: Record<ButtonVariant, string> = {
  primary: "border-zk-primary bg-zk-primary text-white font-semibold hover:bg-zk-primary-dark",
  secondary: "border-zk-input-border bg-white text-zk-text-secondary hover:bg-zk-header",
  dark: "border-transparent bg-zk-dark text-white font-semibold hover:bg-zk-dark-hover",
  danger: "border-zk-danger-border bg-white text-zk-danger-dark hover:bg-zk-danger-bg",
  dangerSolid: "border-transparent bg-zk-danger text-white font-semibold hover:bg-zk-danger-dark",
  ghost: "border-transparent bg-transparent text-zk-text-secondary hover:bg-zk-surface",
  link: "border-transparent bg-transparent !p-0 text-zk-primary underline hover:text-zk-primary-dark",
  linkMuted: "border-transparent bg-transparent !p-0 text-zk-faint underline hover:text-zk-muted",
  linkDanger: "border-transparent bg-transparent !p-0 text-zk-danger underline hover:text-zk-danger-dark",
};

const SIZE_CLS: Record<ButtonSize, string> = {
  md: "px-3.5 py-[7px] text-zk-base",
  sm: "px-2.5 py-1 text-zk-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant = "secondary", size = "md", className, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-[.45] ${SIZE_CLS[size]} ${VARIANT_CLS[variant]} ${className ?? ""}`}
      {...rest}
    />
  );
}
