// AI-PII-2.1：到期轉「離職」。工號卡鏡像（syncLegacyGuardEmploymentColumns）只喺「全部卡 former 且離職日 ≤ 今日（HK）」先將 guards.status 轉 left；
// 離職日喺未來嘅（例如已安排下月離職、卡 valid_to 係未來）等今晚排程（nightly_month_health 加咗 `flip_left_guards` 一步）到期先轉。
// 條件同鏡像一致：有長工體系卡、全部工號卡（任何體系）都 former、離職日 ≤ 今日、仍然 active。單向（唔會轉返在職），寫 audit。
import { prisma } from "@/lib/db";
import { writeAuditTx } from "@/lib/audit";
import { hkDateStr } from "@/lib/dates";
import { loadStaffSchemes } from "./staff-schemes";

export async function flipLeftGuards(now: Date = new Date(), byJob: string | null = null): Promise<{ flipped: number }> {
  const today = hkDateStr(now);
  const candidates = await prisma.guard.findMany({ where: { status: "active", leaveDate: { not: null, lte: new Date(`${today}T00:00:00.000Z`) } }, select: { id: true } });
  if (candidates.length === 0) return { flipped: 0 };
  const schemes = await loadStaffSchemes();
  const longterm = new Set([...schemes.values()].filter((s) => s.isLongterm).map((s) => s.code));
  const cards = await prisma.guardStaffNumber.findMany({ where: { guardId: { in: candidates.map((c) => c.id) } }, select: { guardId: true, scheme: true, status: true } });
  const byGuard = new Map<string, Array<{ scheme: string; status: string }>>();
  for (const c of cards) (byGuard.get(c.guardId) ?? byGuard.set(c.guardId, []).get(c.guardId)!).push(c);
  let flipped = 0;
  for (const { id } of candidates) {
    const cs = byGuard.get(id) ?? [];
    if (cs.length === 0 || !cs.some((c) => longterm.has(c.scheme)) || cs.some((c) => c.status === "current")) continue;
    await prisma.$transaction(async (tx) => {
      const before = await tx.guard.findUnique({ where: { id } });
      if (!before || before.status !== "active") return;
      const after = await tx.guard.update({ where: { id }, data: { status: "left" } });
      await writeAuditTx(tx, { actorUserId: null, tableName: "guards", rowId: id, action: "update", before, after: { ...after, auto_source: "flip_left_guards", ...(byJob ? { by_job: byJob } : {}) }, ip: null });
      flipped += 1;
    });
  }
  return { flipped };
}
