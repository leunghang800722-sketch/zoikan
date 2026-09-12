// Opus 驗收殘留1：session 作廢。單靠清 cookie 唔夠——攻擊者如果偷咗一份
// 已簽署嘅 cookie（sealed data 本身冇存喺 DB，clear cookie 淨係叫瀏覽器
// 唔再帶佢，個 seal 本身仍然係「有效」直到 TTL 過期），舊 cookie 照樣用
// 得。加 users.token_version：每次 issue 一個新 session 就寫入當時嘅
// version 落 cookie；requireSession() 每個請求都同 DB 現值核對一次
// （一次 DB 查），唔啱就當 session 已失效（401）。
//
// 邊啲操作要 bump：logout、改密碼、改角色（role_id）、改 broker（broker_id）、
// void user（status→inactive）——全部係「呢個 session 唔應該再有效」嘅
// 時刻。
import { prisma } from "../db";

export async function bumpTokenVersion(userId: string): Promise<number> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { tokenVersion: { increment: 1 } },
    select: { tokenVersion: true },
  });
  return updated.tokenVersion;
}
