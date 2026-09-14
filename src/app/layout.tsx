import type { Metadata } from "next";
import { Noto_Sans_HK } from "next/font/google";
import "./globals.css";

// WP-R1：設計 handoff 指定字體 `"Noto Sans HK", system-ui, sans-serif`
// （data/design-handoff/README.md「全域外殼 · 字體」）。用 next/font/
// google 令 build 時自載字型檔案（self-host），runtime 唔靠 Google
// Fonts CDN；`display: "swap"` 避免首次載入白屏太耐；Google 攞唔到／
// build offline 時 next/font 會自動 fallback 落 `system-ui, sans-serif`
// （見 Fable 規劃判斷，P2-版面重設計計劃.md §2）。
const notoSansHK = Noto_Sans_HK({
  variable: "--font-noto-sans-hk",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: "在勤",
  description: "在勤保安排更系統",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant" className={`${notoSansHK.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
