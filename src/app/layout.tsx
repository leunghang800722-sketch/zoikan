import type { Metadata } from "next";
import { Noto_Sans_HK } from "next/font/google";
import "./globals.css";

// WP-R1：設計 handoff 指定字體 `"Noto Sans HK", system-ui, sans-serif`
// （data/design-handoff/README.md「全域外殼 · 字體」）。用 next/font/
// google 令 build 時自載字型檔案（self-host），runtime 唔靠 Google
// Fonts CDN；`display: "swap"` 避免首次載入白屏太耐。
//
// R1 驗收修正（原註解講錯咗）：production build 期間如果連唔到 Google
// Fonts（例如 offline CI／防火牆），next/font 會直接 **throw**、build
// 失敗——唔會靜靜哋 fallback 落 `system-ui, sans-serif`（`fallback`
// option 淨係 runtime 用嚟喺字型檔未載完之前墊底嘅字體堆疊，唔係
// build-time 攞唔到字體嘅退路）。真係要應付連唔到 Google Fonts 嘅環境，
// 退路係轉用 `next/font/local` 自帶字型檔案（`.woff2` 放喺 repo），
// 唔再靠 build 時去攞。
//
// `subsets: ["latin"]` 係因為 Noto Sans HK 喺 Google Fonts 冇提供
// 「中文」呢個可聲明嘅 subset（CJK 字型檔太大，Google 唔開放
// `subsets: ["chinese-hongkong"]` 呢類選項俾 next/font），所以
// `preload` 埋落 `<head>` 嘅其實淨係 latin 檔——但呢個頁面成日都要顯示
// 廣東話（CJK）字，個 latin 檔對首屏冇乜用，preload 白白多一個 request，
// 所以關咗。
const notoSansHK = Noto_Sans_HK({
  variable: "--font-noto-sans-hk",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  preload: false,
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
