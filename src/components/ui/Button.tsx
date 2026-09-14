// WP-R1 共用元件：按鈕（README「頁首模式」／「深色」按鈕）。
// variant="dark" 對應 `#0f172a` 白字（重新 Generate、鎖定掣嗰種）。
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "dark" | "danger";

const VARIANT_CLS: Record<ButtonVariant, string> = {
  primary: "border-[#2563eb] bg-[#2563eb] text-white font-semibold hover:bg-[#1d4ed8]",
  secondary: "border-[#d1d5db] bg-white text-[#334155] hover:bg-zk-header",
  dark: "border-transparent bg-[#0f172a] text-white font-semibold hover:bg-[#1e293b]",
  danger: "border-[#fecaca] bg-white text-[#b91c1c] hover:bg-[#fef2f2]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "secondary", className, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`rounded-md border px-3.5 py-[7px] text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-[.45] ${VARIANT_CLS[variant]} ${className ?? ""}`}
      {...rest}
    />
  );
}
