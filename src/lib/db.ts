// App runtime 用嘅 Prisma client（Next.js dev 熱重載環境下用 globalThis
// 存單例，避免每次 HMR 開新 connection pool——官方建議寫法）。
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
