import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker／Zeabur 部署：standalone 輸出（見 Dockerfile）
  output: "standalone",
  // 2026-09-13：API JSON 冇壓縮（實測 452KB 原大送出），明確開 gzip
  compress: true,
  // P6.4：低成本安全 header（CSP 風險大，唔做）。
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
