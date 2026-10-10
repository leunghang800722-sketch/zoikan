// WP-POSTORDER-FREE（§34 B）：盤預設結算雞頭「建議」——由該月 Postorder 嘅 Roster 分頁逐日雞頭推出。
// 規則：呢個盤（canonical＋aliases）喺 Postorder 對應嘅崗位（物業名稱）全月所有更份、所有日子嘅雞頭名（排除「長工」），
// 全部都對得上系統雞頭、而且得一個唯一雞頭，先建議；否則冇建議（reason 講原因）。純唯讀，唔寫任何資料。
import { prisma } from "@/lib/db";
import { monthRange } from "@/lib/reports/money";
import { AutoCollector } from "./context";
import { matchBrokerLabel, rowsForSite } from "./postorder-evidence";
import { normalizeSiteKey } from "./site-match";

export type SuggestionReason = "unique" | "no_postorder" | "no_roster" | "no_site_rows" | "no_broker_cells" | "not_unique" | "unmatched_label" | "broker_inactive";

export interface DefaultBrokerSuggestion {
  month: string | null;
  reason: SuggestionReason;
  suggestion: { brokerId: string; brokerCode: string; brokerName: string; days: number; source: string } | null;
}

export async function suggestSiteDefaultBroker(siteId: string, monthParam: Date | null, actorUserId: string): Promise<DefaultBrokerSuggestion> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { canonicalName: true, aliases: true } });
  let month = monthParam;
  if (!month) {
    const latest = await prisma.postorderUpload.findFirst({ where: { status: "parsed" }, orderBy: { uploadedAt: "desc" }, select: { month: true } });
    month = latest?.month ?? null;
  }
  if (!month) return { month: null, reason: "no_postorder", suggestion: null };
  const start = monthRange(month).start;
  const monthIso = start.toISOString().slice(0, 10);
  const ctx = new AutoCollector(null, start, actorUserId, null);
  const ev = await ctx.postorder();
  if (!ev) return { month: monthIso, reason: "no_postorder", suggestion: null };
  if (!ev.hasRoster || ev.dayBrokers.size === 0) return { month: monthIso, reason: "no_roster", suggestion: null };
  const rows = rowsForSite(ev.priceRows, [site.canonicalName, ...site.aliases]);
  const propKeys = new Set(rows.filter((r) => r.propertyShort).map((r) => normalizeSiteKey(r.propertyShort!)));
  if (propKeys.size === 0) return { month: monthIso, reason: "no_site_rows", suggestion: null };
  const labels = new Map<string, number>(); // 雞頭名 → 日數
  for (const [key, set] of ev.dayBrokers) {
    if (!propKeys.has(key.slice(0, key.indexOf("|")))) continue;
    for (const l of set) if (!l.includes("長工")) labels.set(l, (labels.get(l) ?? 0) + 1);
  }
  if (labels.size === 0) return { month: monthIso, reason: "no_broker_cells", suggestion: null };
  const brokers = await ctx.brokers();
  const matched = [...labels.keys()].map((l) => matchBrokerLabel(l, brokers));
  if (matched.some((m) => !m)) return { month: monthIso, reason: "unmatched_label", suggestion: null };
  const ids = new Set(matched.map((m) => m!.id));
  if (ids.size !== 1) return { month: monthIso, reason: "not_unique", suggestion: null };
  const b = matched[0]!;
  const live = await prisma.broker.findUnique({ where: { id: b.id }, select: { status: true } });
  if (live?.status !== "active") return { month: monthIso, reason: "broker_inactive", suggestion: null };
  const days = [...labels.values()].reduce((a, x) => a + x, 0);
  return { month: monthIso, reason: "unique", suggestion: { brokerId: b.id, brokerCode: b.code, brokerName: b.name, days, source: `Postorder「${ev.fileName}」Roster 分頁` } };
}
