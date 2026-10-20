// SITE-SCHEME-1.1：未設工號體系嘅盤分三類——
//   proposals      ：有 shift／ot 更次而且至少一更係非 external 結算單位 → 出建議（proposeStaffScheme）；
//   not_applicable ：有更次但全部結算單位係 external（客戶自己人）→「唔適用」區，唔出建議、唔可套用；
//   no_shifts      ：完全冇 shift／ot 更次嘅盤 → 唔列（count 另報）。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { proposeStaffScheme } from "./staff-scheme-prefill";

export interface SiteProposal {
  site_id: string;
  site_name: string;
  client_name: string;
  guards_paid_by_client: boolean;
  proposed_scheme: "U" | "MP";
  reason: string;
  shifts: number;
}
export interface SiteNotApplicable {
  site_id: string;
  site_name: string;
  client_name: string;
  shifts: number;
  reason: string;
}

export async function loadSchemeCandidates(): Promise<{ proposals: SiteProposal[]; not_applicable: SiteNotApplicable[]; no_shifts: number }> {
  const sites = await prisma.site.findMany({
    where: { staffScheme: null, status: { not: "ended" } },
    select: { id: true, canonicalName: true, clientName: true, clientGroup: true, aliases: true, guardsPaidByClient: true, staffScheme: true },
    orderBy: [{ canonicalName: "asc" }, { id: "asc" }],
  });
  if (sites.length === 0) return { proposals: [], not_applicable: [], no_shifts: 0 };
  const stats = await prisma.$queryRaw<Array<{ site_id: string; total: bigint | number; ext: bigint | number }>>(Prisma.sql`
    SELECT sr.site_id AS site_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE sb.kind = 'external') AS ext
      FROM shift_records sr
      LEFT JOIN brokers sb ON sb.id = sr.settlement_broker_id
     WHERE sr.site_id IN (${Prisma.join(sites.map((s) => s.id))}) AND sr.record_type IN ('shift', 'ot') AND sr.status <> 'cancelled'
     GROUP BY sr.site_id`);
  const byId = new Map(stats.map((r) => [r.site_id, { total: Number(r.total), ext: Number(r.ext) }]));
  const proposals: SiteProposal[] = [];
  const notApplicable: SiteNotApplicable[] = [];
  let noShifts = 0;
  for (const s of sites) {
    const st = byId.get(s.id);
    if (!st || st.total === 0) {
      noShifts += 1;
      continue;
    }
    if (st.ext === st.total) {
      notApplicable.push({ site_id: s.id, site_name: s.canonicalName, client_name: s.clientName, shifts: st.total, reason: "結算單位全部係客戶自己人（external），唔適用工號體系" });
      continue;
    }
    const p = proposeStaffScheme(s)!;
    proposals.push({ site_id: s.id, site_name: s.canonicalName, client_name: s.clientName, guards_paid_by_client: s.guardsPaidByClient, proposed_scheme: p.scheme, reason: p.reason, shifts: st.total });
  }
  return { proposals, not_applicable: notApplicable, no_shifts: noShifts };
}
