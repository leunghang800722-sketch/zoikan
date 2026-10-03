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
# 啟動腳本（scripts/db/*）會 import src/lib/rbac/*（相對路徑），runner 要有 src 同 tsconfig
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
# prisma CLI（migrate deploy）要成套依賴（effect／@prisma/config…），部分複製會缺模組；
# 直接用完整 node_modules 疊喺 standalone 嘅最小 node_modules 上面（超集，安全）
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8080
# 每次啟動：套用 migration（幂等）→ 建/更新 AI 助手唯讀角色 zoikan_ai_ro
# （幂等；冇 AI_DB_PASSWORD 就跳過並 warn，唔中止部署，見
# scripts/db/ensure-ai-role.ts）→ 校正 sia_permit_expiry／sia_permit_type
# 衍生欄（S5，見 scripts/db/recompute-permit-derived.ts，同樣幂等、失敗
# 只 warn）→ 起 Next standalone server。
# 必修 5（Opus 驗收第三輪）：`scripts` 上面第 28 行已經 COPY 過一次，呢度
# 曾經重複多 COPY 一模一樣嘅嘢——刪走，唔影響行為（同一份 layer 已經有）。
# migrate deploy 失敗要停（schema 唔對唔可以起）；sync-permissions／ensure-identity-indexes／ensure-ai-role／recompute-permit-derived 失敗只 warn，唔阻止網站起
CMD ["sh","-c","node node_modules/prisma/build/index.js migrate deploy && (node node_modules/.bin/tsx scripts/db/sync-permissions.ts || echo '[warn] sync-permissions 失敗，網站照起') && (node node_modules/.bin/tsx scripts/db/ensure-identity-indexes.ts || echo '[warn] ensure-identity-indexes 失敗，網站照起') && (node node_modules/.bin/tsx scripts/db/ensure-ai-role.ts || echo '[warn] ensure-ai-role 失敗，網站照起') && (node node_modules/.bin/tsx scripts/db/recompute-permit-derived.ts || echo '[warn] recompute-permit-derived 失敗，網站照起') && node server.js"]
