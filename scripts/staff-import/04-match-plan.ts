// Stage A step 4：對齊計劃（§26.2.4）→ out/plan.json、out/report.md（report 淨係統計＋docId）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { DocExtract } from './lib/aggregate';
import type { DocCheck } from './lib/crosscheck';
import { canonicalHkid } from './lib/hkid';
import { buildDbIndex, planAll, type DbGuard, type PlanEntry, type PlanInput } from './lib/match-plan';

const OUT = path.join(process.cwd(), 'data/2026-10/staff-import');

async function loadGuards(): Promise<DbGuard[]> {
  const prisma = new PrismaClient();
  try {
    const gs = await prisma.guard.findMany({
      select: { id: true, nameZh: true, hkid: true, tel: true, staffNumbers: { select: { number: true } }, phones: { select: { tel: true } } },
    });
    return gs.map((g) => ({
      id: g.id,
      nameZh: g.nameZh,
      hkid: canonicalHkid(g.hkid),
      tels: [g.tel, ...g.phones.map((p) => p.tel)].filter((x): x is string => !!x),
      staffNos: g.staffNumbers.map((s) => s.number),
    }));
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const ex = JSON.parse(await fs.readFile(path.join(OUT, 'out/extract.json'), 'utf8')) as (DocExtract & { staffNo: string | null })[];
  const cc = new Map((JSON.parse(await fs.readFile(path.join(OUT, 'out/crosscheck.json'), 'utf8')) as DocCheck[]).map((c) => [c.docId, c]));
  const db = buildDbIndex(await loadGuards());
  const inputs: PlanInput[] = ex.map((e) => {
    const c = cc.get(e.docId)!;
    return {
      docId: e.docId,
      staffNos: e.staffNo ? [e.staffNo] : [],
      hkid: e.hkid ? canonicalHkid(e.hkid.value) : null,
      hkidValid: e.hkidValid,
      nameZh: e.nameZh?.value ?? null,
      phone: e.phone?.value ?? null,
      grade: c.grade,
      gradeReasons: c.reasons,
    };
  });
  const plan: PlanEntry[] = planAll(inputs, db);
  await fs.writeFile(path.join(OUT, 'out/plan.json'), JSON.stringify(plan, null, 1));

  const byAction: Record<string, number> = {};
  const reasonCnt: Record<string, number> = {};
  const gradeAct: Record<string, number> = {};
  const ids: Record<string, string[]> = {};
  for (const p of plan) {
    byAction[p.action] = (byAction[p.action] ?? 0) + 1;
    p.reasons.forEach((r) => (reasonCnt[r] = (reasonCnt[r] ?? 0) + 1));
    gradeAct[`${p.grade}/${p.action}`] = (gradeAct[`${p.grade}/${p.action}`] ?? 0) + 1;
    if (p.action === 'conflict') (ids.conflict ??= []).push(p.docId);
  }
  const autoApply = plan.filter((p) => p.autoApply).length;
  const lines: string[] = [];
  lines.push('# WP-STAFF-IMPORT Stage A 報告（只含統計同 docId）', '');
  lines.push(`檔數：${inputs.length}`, `人數（以 hkid 合併後）：${plan.length}`, `多檔合併嘅人：${plan.filter((p) => p.docIds.length > 1).length}`, `對齊結果：${JSON.stringify(byAction)}`, `評級×對齊：${JSON.stringify(gradeAct)}`, `可自動套用（auto_ok 且 link/create）：${autoApply}`, '');
  lines.push('## 理由碼', ...Object.entries(reasonCnt).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`), '');
  lines.push('## conflict docId', (ids.conflict ?? []).join(', ') || '（無）', '');
  const stats = JSON.parse(await fs.readFile(path.join(OUT, 'out/crosscheck-stats.json'), 'utf8')) as { grades: Record<string, number>; reason: Record<string, number> };
  lines.push('## 評級', JSON.stringify(stats.grades), '', '## 例外類別 top', ...Object.entries(stats.reason).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `- ${k}: ${v}`));
  await fs.writeFile(path.join(OUT, 'out/report.md'), lines.join('\n') + '\n');

  console.log(`docs=${inputs.length} persons=${plan.length} multiDocPersons=${plan.filter((p) => p.docIds.length > 1).length}`);
  console.log(`plan: ${JSON.stringify(byAction)} autoApply=${autoApply}`);
  console.log(`grade/action: ${JSON.stringify(gradeAct)}`);
  console.log('plan reasons:', Object.entries(reasonCnt).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}=${v}`).join(', '));
}

main();
