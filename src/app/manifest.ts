// PWA manifest（老闆 2026-09-15 要求：手機「加到主畫面」個 icon 要係 MSG
// Security 盾牌 logo，唔係瀏覽器預設嘅灰底「Z」字）。
//
// Icon 來源：公司報價單 PDF 內嵌嘅 header banner（704×179）裁出盾牌
// （約 146×161），去白底後放大——原始檔解像度有限，512px 會略軟；老闆
// 交返原始 logo 檔（向量／高清 PNG）後只需替換 public/icons/*.png。
// `purpose: "any"` 係透明底原形；`purpose: "maskable"` 係深色底＋安全區
// 留白，俾 Android 自適應圖示裁圓角／圓形用。
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "在勤",
    short_name: "在勤",
    description: "在勤保安排更系統",
    lang: "zh-Hant",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6f7f9",
    theme_color: "#1c1917",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
