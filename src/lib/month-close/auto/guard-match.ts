// WP-ONE-CLICK-AUTO（§31.3 D 尾段）：安員配對修復「要老闆核實」（needs_boss）自動化。
//
//   auto     單一候選安員，而且：
//            (a) 上月同盤、同一更表姓名（工號有就要相同）嘅格全部已配對到呢位候選（≥3 格），或者
//            (b) 電話硬鍵——更表電話等於候選安員嘅電話，而且更表姓名同候選本名／別名完全一致。
//   propose  單一候選但冇硬證據（淨姓名／淨一種弱證據）→ 分診題預填候選。
//   unknown  冇候選／多個候選 → 分診題冇預填（列候選）。
// 「配對」嘅做法同 guard-fix link 一致：加更表姓名做安員別名、加（未被佔用嘅）工號——
// 之後 reparse 先會配到。每個動作 journal（undo 時移除）＋audit 帶 run id。
import { prisma } from "@/lib/db";
import { normalizeTelHk } from "@/lib/guards/identity";
import { normalizeStaffNumber, upsertCurrentStaffNumber, syncLegacyStaffNoColumns } from "@/lib/guards/staff-numbers";
import type { AutoCollector, ChangeWriter } from "./context";
import type { McCandidate } from "./types";

export interface NeedsBossIdentity {
  seq: string;
  staffNoRaw: string | null;
  nameRaw: string;
  telRaw: string | null;
  siteLabels: string[];
  cellCount: number;
  candidateGuardIds: string[];
  reason: string;
}

const nameKey = (s: string): string => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

async function previousMonthPaired(month: Date, id: NeedsBossIdentity, candidateId: string): Promise<{ ok: boolean; rows: number }> {
  const prevMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1));
  const rows = await prisma.rosterUploadRow.findMany({
    where: { upload: { month: prevMonth, status: { notIn: ["superseded", "voided"] } }, nameRaw: id.nameRaw.trim(), codeKind: { in: ["shift", "ot"] }, guardId: { not: null } },
    select: { guardId: true, staffNoRaw: true, resolvedSite: { select: { canonicalName: true } }, upload: { select: { siteNameRaw: true } } },
  });
  const sn = id.staffNoRaw ? normalizeStaffNumber(id.staffNoRaw) : null;
  const labels = new Set(id.siteLabels.map((l) => nameKey(l)));
  const relevant = rows.filter((r) => {
    const siteOk = (r.resolvedSite && labels.has(nameKey(r.resolvedSite.canonicalName))) || labels.has(nameKey(r.upload.siteNameRaw));
    if (!siteOk) return false;
    // 有工號就要求上月嗰啲格工號都一樣（淨姓名一樣唔夠）。
    if (sn && (!r.staffNoRaw || normalizeStaffNumber(r.staffNoRaw) !== sn)) return false;
    return true;
  });
  return { ok: relevant.length >= 3 && relevant.every((r) => r.guardId === candidateId), rows: relevant.length };
}

async function telHardKey(id: NeedsBossIdentity, candidateId: string): Promise<boolean> {
  const tel = normalizeTelHk(id.telRaw);
  if (!tel) return false;
  const g = await prisma.guard.findUnique({ where: { id: candidateId }, select: { nameZh: true, nameAliases: true, tel: true, phones: { select: { tel: true } } } });
  if (!g) return false;
  const tels = new Set([g.tel, ...g.phones.map((p) => p.tel)].map((t) => normalizeTelHk(t)).filter((t): t is string => !!t));
  if (!tels.has(tel)) return false;
  const names = new Set([g.nameZh, ...g.nameAliases].map(nameKey));
  return names.has(nameKey(id.nameRaw));
}

/** 將更表身份配落指定安員：加別名＋（無衝突時）加工號。回傳實際寫咗乜。 */
export async function linkIdentityToGuard(writer: ChangeWriter, identity: { staffNoRaw: string | null; nameRaw: string }, guardId: string): Promise<{ aliasAdded: boolean; staffNoAdded: boolean }> {
  const guard = await prisma.guard.findUnique({ where: { id: guardId }, select: { id: true, nameZh: true, nameAliases: true } });
  if (!guard) return { aliasAdded: false, staffNoAdded: false };
  const alias = identity.nameRaw.trim();
  const needsAlias = !!alias && alias !== guard.nameZh.trim() && !guard.nameAliases.includes(alias);
  const sn = identity.staffNoRaw ? normalizeStaffNumber(identity.staffNoRaw) : null;
  let staffNoAdded = false;
  let aliasAdded = false;
  let staffId: string | null = null;
  let staffNumber: string | null = null;
  await prisma.$transaction(async (tx) => {
    if (needsAlias) {
      await tx.guard.update({ where: { id: guardId }, data: { nameAliases: [...new Set([...guard.nameAliases, alias])] } });
      aliasAdded = true;
    }
    if (sn) {
      const scheme = sn.match(/^[A-Z]+/)?.[0] ?? null;
      const owner = await tx.guardStaffNumber.findUnique({ where: { number: sn } });
      const otherCurrent = scheme ? await tx.guardStaffNumber.findFirst({ where: { guardId, scheme, status: "current", number: { not: sn } } }) : null;
      if (!owner && !otherCurrent && scheme) {
        const res = await upsertCurrentStaffNumber(tx, { guardId, scheme, number: sn, source: "system:one-click-auto", createdBy: writer.actorUserId });
        await syncLegacyStaffNoColumns(tx, guardId);
        staffNoAdded = true;
        staffId = res.created.id;
        staffNumber = sn;
      }
    }
  });
  if (aliasAdded) {
    await writer.audit({ tableName: "guards", rowId: guardId, action: "update", after: { id: guardId } });
    await writer.journal({ kind: "guard_alias_added", refTable: "guards", refId: guardId, summary: "安員配對：加更表用名做別名", detail: { guardId, alias } });
  }
  if (staffNoAdded && staffId) {
    await writer.audit({ tableName: "guard_staff_numbers", rowId: staffId, action: "create", after: { id: staffId } });
    await writer.journal({ kind: "guard_staffno_added", refTable: "guard_staff_numbers", refId: staffId, summary: "安員配對：登記更表工號", detail: { staffNumberId: staffId, guardId, number: staffNumber } });
  }
  return { aliasAdded, staffNoAdded };
}

export interface AutoGuardMatchResult {
  autoLinked: number;
  cellsLinked: number;
  remaining: number;
  remainingItems: NeedsBossIdentity[];
}

/** 剩低嘅 needs_boss：能夠 auto 嘅配落去，其餘出分診題。回傳係咪有嘢要 reparse。 */
export async function autoResolveNeedsBoss(ctx: AutoCollector, month: Date, items: readonly NeedsBossIdentity[]): Promise<AutoGuardMatchResult> {
  const out: AutoGuardMatchResult = { autoLinked: 0, cellsLinked: 0, remaining: 0, remainingItems: [] };
  for (const it of items) {
    const only = it.candidateGuardIds.length === 1 ? it.candidateGuardIds[0]! : null;
    let evidence: string | null = null;
    // plan 已判「工號衝突」嘅一律唔 auto（交分診）。
    const staffNoConflict = it.reason.includes("工號");
    if (only && !staffNoConflict) {
      // auto 只喺有硬鍵（工號／電話）而且上月同盤已配對同一 guard_id：淨姓名一樣唔夠。
      const hasStaffNo = !!it.staffNoRaw;
      const prev = await previousMonthPaired(month, it, only);
      const telKey = await telHardKey(it, only);
      if (prev.ok && (hasStaffNo || telKey)) evidence = `上月同盤同一更表${hasStaffNo ? "工號" : "電話＋姓名"}已配對到呢位安員（${prev.rows} 格）`;
    }
    if (only && evidence) {
      const res = await linkIdentityToGuard(ctx, it, only);
      if (res.aliasAdded || res.staffNoAdded) {
        out.autoLinked++;
        out.cellsLinked += it.cellCount;
        ctx.summary.guardMatchesAuto++;
        ctx.line("guard_match", `安員配對 ${it.seq}（${it.siteLabels.join("、")}，${it.cellCount} 格）自動配對：${evidence}`);
        continue;
      }
      // 加唔到任何登記（別名／工號都已經存在或者被佔用）＝reparse 後都未必配到 → 唔計 auto，出分診題。
    }
    out.remaining++;
    out.remainingItems.push(it);
    const cands: McCandidate[] = it.candidateGuardIds.slice(0, 3).map((id, i) => ({ id: `g${i}`, label: `候選安員 ${i + 1}`, refId: id, evidence: only ? "只有一個候選，但冇硬證據（淨姓名／弱證據）" : "多個候選" }));
    ctx.addQuestion({
      kind: "month_close_guard_match",
      groupKey: `guard_match:${it.seq}:${nameKey(it.nameRaw)}`,
      sort: 55,
      title: `安員配對要核實（${it.siteLabels.join("、")}，${it.cellCount} 格）`,
      evidence: {
        v: 1,
        mc: true,
        runId: ctx.runId ?? "",
        month: month.toISOString().slice(0, 10),
        kind: "month_close_guard_match",
        summary: `${it.siteLabels.join("、")} 共 ${it.cellCount} 格嘅安員未配對：${it.reason}`,
        suggestion: only ? "配對到唯一候選安員" : null,
        confidence: only ? "propose" : "unknown",
        action: { type: "guard_match", identity: { staffNoNorm: it.staffNoRaw ? normalizeStaffNumber(it.staffNoRaw) : null, nameRaw: it.nameRaw.trim(), telRaw: it.telRaw }, siteLabel: it.siteLabels.join("、"), cellCount: it.cellCount },
        candidates: cands,
        prefillCandidateId: only ? "g0" : null,
      },
    });
  }
  return out;
}
