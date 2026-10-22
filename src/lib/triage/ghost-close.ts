// TE-13：production 舊題收題——已存在嘅 open `staffno_shared_by_persons` 題之中，如果其中一個人係 ghost（由銀行戶口等文件產生嘅空記錄，
// 而且只同一個身份已確認嘅真人共用工號；規則見 findGhostPersons），就將 ghost 嗰條題同「淨係因為 ghost 而共用」嘅真人嗰條題標 superseded（同重新 apply 包時一樣）。
// 保守：只睇 session 內仍 open 嘅共用題；真人另有其他衝突（電話共用／重複身份證…）就唔郁佢嗰條。
import { prisma } from "@/lib/db";
import { findGhostPersons } from "@/lib/guards/import/package";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import type { QuestionEvidence } from "./types";

const OTHER_CONFLICTS = new Set(["dup_tel_across_persons", "duplicate_hkid_in_package", "duplicate_key_in_package", "bank_acct_shared_by_persons", "group_name_differs"]);

export async function closeGhostStaffnoQuestions(sessionId: string, dryRun: boolean): Promise<number> {
  const qs = await prisma.triageQuestion.findMany({ where: { sessionId, status: "open", kind: "staffno_shared_by_persons" }, select: { id: true, evidenceJson: true } });
  if (qs.length < 2) return 0;
  const evs = qs.map((q) => ({ id: q.id, ev: q.evidenceJson as unknown as QuestionEvidence }));
  const persons = evs.map((x) => x.ev.person).filter(Boolean);
  const ghosts = findGhostPersons(persons);
  if (ghosts.size === 0) return 0;
  const owners = new Map<string, Set<string>>();
  for (const p of persons) for (const n of p.staffNumbers) {
    const k = normalizeStaffNumber(n.number);
    owners.set(k, (owners.get(k) ?? new Set()).add(p.key));
  }
  const ids = new Set<string>();
  for (const x of evs) {
    const key = x.ev.person?.key;
    if (!key) continue;
    if (ghosts.has(key)) {
      ids.add(x.id);
      continue;
    }
    // 真人：佢所有共用工號嘅「其他人」都係併入自己嘅 ghost，而且冇其他衝突
    const mine = new Set([...ghosts].filter(([, g]) => g.mergedInto === key).map(([k]) => k));
    if (mine.size === 0 || x.ev.reasons.some((r) => OTHER_CONFLICTS.has(r))) continue;
    const others = new Set(x.ev.person.staffNumbers.flatMap((n) => [...(owners.get(normalizeStaffNumber(n.number)) ?? [])]).filter((k) => k !== key));
    if ([...others].every((k) => mine.has(k))) ids.add(x.id);
  }
  if (ids.size === 0) return 0;
  if (!dryRun) {
    await prisma.triageQuestion.updateMany({ where: { id: { in: [...ids] }, status: "open" }, data: { status: "superseded" } });
    const open = await prisma.triageQuestion.count({ where: { sessionId, status: "open" } });
    if (open === 0) await prisma.triageSession.updateMany({ where: { id: sessionId, status: { not: "done" } }, data: { status: "done", completedAt: new Date() } });
  }
  return ids.size;
}
