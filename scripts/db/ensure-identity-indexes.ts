// 容器啟動步驟（同 db:sync-permissions 一樣）：冪等補建身份證／電話唯一 index。
// 冇重複就 CREATE UNIQUE INDEX IF NOT EXISTS；有重複只印組數（唔印值）並保持現狀。
import { PrismaClient } from "@prisma/client";
import { ensureIdentityIndexes } from "../../src/lib/guards/identity-indexes";

const prisma = new PrismaClient();
ensureIdentityIndexes(prisma)
  .then((r) => {
    console.log(`[db:ensure-identity-indexes] dupHkidGroups=${r.dupHkidGroups} dupTelGroups=${r.dupTelGroups} hkidIndex=${r.hkidIndexPresent} telIndex=${r.telIndexPresent} created=[${r.created.join(",")}] dupTelSameGuardNormalized=${r.dupTelSameGuardNormalizedGroups} dupTelCrossGuardNormalized=${r.dupTelCrossGuardNormalizedGroups}`);
    if (r.dupTelSameGuardNormalizedGroups > 0 || r.dupTelCrossGuardNormalizedGroups > 0) console.warn("[db:ensure-identity-indexes] 有正規化後同號（寫法唔同，例如 +852／8 位）：raw unique index 唔會擋，要人手整理；app 層照擋新增");
    if (r.dupHkidGroups > 0 || r.dupTelGroups > 0) console.warn("[db:ensure-identity-indexes] 仍有重複，未建對應 index（見 guard_identity_conflicts／診斷 identity 區塊）");
    return prisma.$disconnect();
  })
  .catch(async (e) => {
    // 只印 error code／類別，唔印 message（Postgres DETAIL 可能帶值）
    const code = (e as { code?: string; meta?: { code?: string } })?.code ?? (e as { meta?: { code?: string } })?.meta?.code ?? "unknown";
    console.error(`[db:ensure-identity-indexes] 失敗 code=${code} type=${e instanceof Error ? e.constructor.name : typeof e}`);
    await prisma.$disconnect();
    process.exit(1);
  });
