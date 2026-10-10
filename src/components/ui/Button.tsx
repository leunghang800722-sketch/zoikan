// WP-R1 共用元件：按鈕（README「頁首模式」／「深色」按鈕）。
// variant="dark" 對應 `#0f172a` 白字（重新 Generate、鎖定掣嗰種）。
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "dark" | "danger";

const VARIANT_CLS: Record<ButtonVariant, string> = {
  primary: "border-zk-primary bg-zk-primary text-white font-semibold hover:bg-zk-primary-dark",
  secondary: "border-zk-input-border bg-white text-zk-text-secondary hover:bg-zk-header",
  dark: "border-transparent bg-zk-dark text-white font-semibold hover:bg-zk-dark-hover",
  danger: "border-zk-danger-border bg-white text-zk-danger-dark hover:bg-zk-danger-bg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "secondary", className, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`rounded-md border px-3.5 py-[7px] text-zk-base transition-colors disabled:cursor-not-allowed disabled:opacity-[.45] ${VARIANT_CLS[variant]} ${className ?? ""}`}
      {...rest}
    />
  );
}
