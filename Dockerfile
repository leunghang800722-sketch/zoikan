# 在勤 P1 — Zeabur／任何 Docker 平台用嘅正式映像
# 多階段：deps → build（next build standalone）→ runner（細、冇 devDependencies）
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
# Zeabur 會將服務環境變數（含 NODE_ENV=production）帶入 build，npm ci 會跳過 devDependencies（prisma CLI 喺入面）；強制連 dev 一齊裝
RUN npm ci --include=dev

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build

FROM base AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080 HOSTNAME=0.0.0.0
# runtime 只需要 standalone 輸出＋prisma CLI 做 migrate deploy
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
# prisma CLI（migrate deploy）要成套依賴（effect／@prisma/config…），部分複製會缺模組；
# 直接用完整 node_modules 疊喺 standalone 嘅最小 node_modules 上面（超集，安全）
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8080
# 每次啟動先套用 migration（幂等），再起 Next standalone server
CMD ["sh","-c","node node_modules/prisma/build/index.js migrate deploy && node server.js"]
