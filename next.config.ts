import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker／Zeabur 部署：standalone 輸出（見 Dockerfile）
  output: "standalone",
};

export default nextConfig;
