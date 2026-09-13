import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker／Zeabur 部署：standalone 輸出（見 Dockerfile）
  output: "standalone",
  // 2026-09-13：API JSON 冇壓縮（實測 452KB 原大送出），明確開 gzip
  compress: true,
};

export default nextConfig;
