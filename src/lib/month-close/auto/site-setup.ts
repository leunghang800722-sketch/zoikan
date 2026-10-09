// WP-ONE-CLICK-AUTO（§31.3 A）：更表盤名對盤——exact／auto 加 alias 對上；
// propose 出分診題；其餘當新盤，並且「自動建齊」：更種由該上載嘅
// `roster_upload_rows.raw_code`＋`time_raw` 推出（code／起止時間／鐘數），
// 客戶名同別名由本月 Postorder（如有）推出，令新盤嘅更次同一個 run 內套用到。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { safeErrorSummary } from "@/lib/api/http";
import { assignRosterUploadSite, reparseRosterUpload } from "@/lib/roster-upload/service";
import { normalizeTimeRange } from "@/lib/roster-upload/time-range";
import { otHoursFromCode } from "@/lib/roster-upload/cell-codes";
import type { AutoCollector, ChangeWriter } from "./context";
import { classifySiteName, normalizeSiteKey, stripSiteSuffix, type SiteNameCandidate } from "./site-match";
import { rowsForSite, type PostorderEvidence } from "./postorder-evidence";
import type { McQuestionDraft } from "./types";

export type UploadSiteOutcome =
  | { outcome: "assigned"; siteId: string; via: "exact" | "auto" | "this_run" }
  | { outcome: "created"; siteId: string; shiftTypes: number }
  | { outcome: "proposed" }
  | { outcome: "failed"; message: string };

interface SiteRow {
  id: string;
  canonicalName: string;
  aliases: string[];
  parentSiteId: string | null;
}

async function loadSites(): Promise<SiteRow[]> {
  return prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true, parentSiteId: true } });
}

/** 加 alias 到盤（冪等）：journal `site_alias`＋audit。回傳係咪真係新加。 */
export async function addSiteAlias(ctx: ChangeWriter, siteId: string, alias: string, extra: { uploadId?: string } = {}): Promise<boolean> {
  const alt = alias.trim();
  if (!alt) return false;
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true, canonicalName: true, aliases: true } });
  if (!site) return false;
  const altKey = normalizeSiteKey(alt);
  if (normalizeSiteKey(site.canonicalName) === altKey && site.canonicalName === alt) return false;
  if (site.aliases.includes(alt)) return false;
  const updated = await prisma.site.update({ where: { id: siteId }, data: { aliases: [...site.aliases, alt] } });
  await ctx.audit({ tableName: "sites", rowId: siteId, action: "update", before: { id: siteId, aliases: site.aliases }, after: { ...updated, aliases: updated.aliases } });
  await ctx.journal({
    kind: "site_alias",
    refTable: "sites",
    refId: siteId,
    summary: `盤「${site.canonicalName}」加別名「${alt}」`,
    detail: { siteId, alias: alt, uploadId: extra.uploadId ?? null },
  });
  return true;
}

function hhmmToDate(hhmm: string): Date {
  return new Date(Date.UTC(1970, 0, 1, Number(hhmm.slice(0, 2)), Number(hhmm.slice(2, 4))));
}

function slotHours(slot: string): number | null {
  const [a, b] = slot.split("-");
  if (!a || !b) return null;
  const s = Number(a.slice(0, 2)) * 60 + Number(a.slice(2, 4));
  const e = Number(b.slice(0, 2)) * 60 + Number(b.slice(2, 4));
  const diff = (e - s + 24 * 60) % (24 * 60);
  return diff === 0 ? null : Math.round((diff / 60) * 100) / 100;
}

/** 由 Postorder 推新盤嘅客戶名（客戶群 block）同別名（物業名稱）。別名唔可以撞其他盤嘅名／別名。 */
export function derivePostorderSiteInfo(name: string, ev: PostorderEvidence | null, otherSites: readonly SiteNameCandidate[]): { clientName: string | null; aliases: string[] } {
  if (!ev) return { clientName: null, aliases: [] };
  const rows = rowsForSite(ev.priceRows, [name]);
  if (rows.length === 0) return { clientName: null, aliases: [] };
  const groups = new Map<string, number>();
  for (const r of rows) if (r.clientGroup) groups.set(r.clientGroup, (groups.get(r.clientGroup) ?? 0) + 1);
  const clientName = [...groups.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const taken = new Set(otherSites.flatMap((s) => [s.canonicalName, ...s.aliases]).map((n) => normalizeSiteKey(n)));
  const ownKey = normalizeSiteKey(name);
  const aliases: string[] = [];
  const cands = new Set<string>();
  for (const r of rows) {
    if (r.propertyShort) cands.add(r.propertyShort.trim());
    if (r.labelHead) cands.add(r.labelHead.trim());
  }
  for (const c of cands) {
    const k = normalizeSiteKey(c);
    if (!k || k === ownKey || stripSiteSuffix(k) === stripSiteSuffix(ownKey) || k.length < 2 || taken.has(k)) continue;
    aliases.push(c);
  }
  return { clientName: clientName && normalizeSiteKey(clientName) !== ownKey ? clientName : null, aliases: aliases.slice(0, 3) };
}

// 大上載 reparse 用嘅 interactive transaction timeout（同 one-click 安員修復後 reparse 一致）。
const REPARSE_TX_TIMEOUT_MS = 10 * 60 * 1000;

interface ShiftTypeGroup {
  code: string;
  slot: string | null;
  ot: boolean;
}

/**
 * 由上載嘅 shift／ot 格推更種分組（code＋時段）；同 code 有時段就唔另建冇時段嗰個；時段解析唔到而唔係 OT 嘅 code 放 unparsed。
 * `forSiteId`：只計歸呢個盤嘅格（resolved_site_id = 盤，或者 resolved_site_id 空而上載本身掛呢個盤）——母盤上載、格歸子盤時用。
 * 冇傳（新盤建盤，上載未指定盤）＝全部格。
 */
export async function deriveShiftTypeGroups(uploadId: string, forSiteId?: string): Promise<{ groups: ShiftTypeGroup[]; unparsedCodes: string[] }> {
  const siteFilter = forSiteId ? { OR: [{ resolvedSiteId: forSiteId }, { resolvedSiteId: null, upload: { siteId: forSiteId } }] } : {};
  const rows = await prisma.rosterUploadRow.findMany({ where: { uploadId, codeKind: { in: ["shift", "ot"] }, ...siteFilter }, select: { rawCode: true, timeRaw: true, codeKind: true } });
  const groups = new Map<string, ShiftTypeGroup>();
  for (const r of rows) {
    const code = r.rawCode.trim();
    if (!code) continue;
    const slot = r.codeKind === "ot" ? null : normalizeTimeRange(r.timeRaw);
    groups.set(`${code.toUpperCase()}|${slot ?? ""}`, { code, slot, ot: r.codeKind === "ot" });
  }
  for (const [key, g] of [...groups]) {
    if (!g.slot && !g.ot && [...groups.values()].some((o) => o !== g && o.code.toUpperCase() === g.code.toUpperCase() && o.slot)) groups.delete(key);
  }
  const unparsedCodes: string[] = [];
  const ok: ShiftTypeGroup[] = [];
  for (const g of groups.values()) {
    if (!g.slot && !g.ot) unparsedCodes.push(g.code);
    else ok.push(g);
  }
  return { groups: ok, unparsedCodes };
}

const hmOf = (d: Date | null): string => (d ? d.toISOString().slice(11, 16) : "—");
const sameTime = (a: Date | null, b: Date | null): boolean => (a === null && b === null) || (!!a && !!b && a.getTime() === b.getTime());
const sameHours = (a: unknown, b: number | null): boolean => (a === null || a === undefined ? b === null : b !== null && Number(a) === b);

type GroupAction =
  | { kind: "create" }
  | { kind: "skip" }
  | { kind: "revive"; stId: string; code: string }
  | { kind: "blocked"; reason: string };

/**
 * 決定一個上載推出嘅更種組點處理（ensure 同 plan 共用，plan 唔寫資料）。
 * 同 key（code 大細楷不分＋開工時間）已存在：有效 → skip；已作廢 → 只有「由一鍵 undo 作廢」而且收工時間＋鐘數同上載推出嘅完全一樣先復原；
 * 其餘（人手作廢、或者收工／鐘數唔同）→ blocked（唔復原、唔另建，出題）。
 */
async function classifyGroup(siteId: string, g: ShiftTypeGroup): Promise<{ action: GroupAction; start: Date | null; end: Date | null; hours: number | null }> {
  const start = g.slot ? hhmmToDate(g.slot.split("-")[0]!) : null;
  const end = g.slot ? hhmmToDate(g.slot.split("-")[1]!) : null;
  const hours = g.ot ? otHoursFromCode(g.code) : g.slot ? slotHours(g.slot) : null;
  const exists = await prisma.shiftType.findFirst({ where: { siteId, code: { equals: g.code, mode: "insensitive" }, startTime: start } });
  if (!exists) return { action: { kind: "create" }, start, end, hours };
  if (!exists.voidedAt) return { action: { kind: "skip" }, start, end, hours };
  const undone = await prisma.monthCloseAutoChange.findFirst({ where: { kind: "shift_type_created", refId: exists.id, status: "undone" }, select: { id: true } });
  const identical = sameTime(exists.endTime, end) && sameHours(exists.hours, hours);
  if (undone && identical) return { action: { kind: "revive", stId: exists.id, code: exists.code }, start, end, hours };
  const spec = `更種「${exists.code}」（${hmOf(exists.startTime)}-${hmOf(exists.endTime)}，${exists.hours === null ? "—" : Number(exists.hours)} 小時）`;
  const upl = `上載係 ${hmOf(start)}-${hmOf(end)}（${hours ?? "—"} 小時）`;
  const reason = !undone
    ? `同 code 同開工時間已有人手作廢嘅${spec}，${upl}；人手作廢，唔自動復原亦唔另建`
    : `同 code 同開工時間已有一鍵結算撤銷咗嘅${spec}，${upl}；收工時間或鐘數唔同，唔自動復原亦唔另建`;
  return { action: { kind: "blocked", reason }, start, end, hours };
}

/**
 * 由上載格自動建更種（新盤建盤時、或者一鍵結算對「有效更種 = 0」嘅現有盤自我修復）。
 * 冪等：同盤同 code＋開工時間已存在就 skip。每張更種 journal `shift_type_created`（可撤銷）＋audit。
 * 建完會 reparse 該上載，令格配到新更種。
 */
export async function ensureShiftTypesFromUpload(
  ctx: AutoCollector,
  siteId: string,
  uploadId: string,
  opts: { isNewSite?: boolean; skipReparse?: boolean } = {},
): Promise<{ created: number; unparsedCodes: string[]; blocked: string[] }> {
  const site = await prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { id: true, canonicalName: true } });
  const { groups, unparsedCodes } = await deriveShiftTypeGroups(uploadId, opts.isNewSite ? undefined : siteId);
  const label = opts.isNewSite ? "新盤" : "盤";
  let created = 0;
  const blocked: string[] = [];
  for (const g of groups) {
    const { action, start, end, hours } = await classifyGroup(site.id, g);
    if (action.kind === "skip") continue;
    if (action.kind === "blocked") {
      blocked.push(action.reason);
      continue;
    }
    if (action.kind === "revive") {
      // 復原之前一鍵 undo 作廢、而且規格完全相同嘅更種（unique 約束，唔另建）。audit 用 unvoid（同 shift-types unvoid route 一致）。
      try {
        const before = await prisma.shiftType.findUniqueOrThrow({ where: { id: action.stId } });
        const revived = await prisma.shiftType.update({ where: { id: action.stId }, data: { voidedAt: null, voidedBy: null } });
        await ctx.audit({ tableName: "shift_types", rowId: action.stId, action: "unvoid", before, after: revived });
        await ctx.journal({ kind: "shift_type_created", refTable: "shift_types", refId: action.stId, summary: `盤「${site.canonicalName}」復原之前撤銷嘅更種「${action.code}」${g.slot ? `（${g.slot}）` : ""}`, detail: { shiftTypeId: action.stId, siteId: site.id, revived: true } });
        created++;
      } catch (e) {
        ctx.warnings.push(`盤「${site.canonicalName}」復原更種「${g.code}」失敗：${safeErrorSummary(e)}`);
      }
      continue;
    }
    try {
      const st = await prisma.shiftType.create({
        data: { siteId: site.id, code: g.code, startTime: start, endTime: end, hours: hours !== null ? new Prisma.Decimal(hours) : null, billingGroup: "per_shift", createdBy: ctx.actorUserId },
      });
      await ctx.audit({ tableName: "shift_types", rowId: st.id, action: "create", after: st });
      await ctx.journal({ kind: "shift_type_created", refTable: "shift_types", refId: st.id, summary: `盤「${site.canonicalName}」自動建更種「${g.code}」${g.slot ? `（${g.slot}）` : ""}`, detail: { shiftTypeId: st.id, siteId: site.id } });
      created++;
    } catch (e) {
      ctx.warnings.push(`盤「${site.canonicalName}」建更種「${g.code}」失敗：${safeErrorSummary(e)}`);
    }
  }
  if (blocked.length > 0) {
    ctx.addQuestion({
      kind: "month_close_site_new",
      groupKey: `site_shift_type_voided:${site.id}`,
      sort: 15,
      title: `${label}「${site.canonicalName}」有已作廢更種同更表撞（${blocked.length} 項）`,
      evidence: {
        v: 1,
        mc: true,
        runId: ctx.runId ?? "",
        month: ctx.month.toISOString().slice(0, 10),
        kind: "month_close_site_new",
        summary: `${blocked.join("；")}。相關格未計入——請去「盤」管理確認：復原該更種（並改啱收工時間／鐘數）或者另加不同開工時間嘅更種。處理完再撳一鍵結算，系統會自動重新配對該盤本月更表`,
        suggestion: null,
        confidence: "unknown",
        action: { type: "site_new", siteId: site.id, groups: [] },
        candidates: [],
        prefillCandidateId: null,
      },
    });
  }
  if (unparsedCodes.length > 0) {
    const codesText = [...new Set(unparsedCodes)].join("、");
    if (opts.isNewSite) ctx.warnings.push(`${label}「${site.canonicalName}」更表代號「${codesText}」嘅時段解析唔到（要 0700-1900 呢類寫法），未建更種，呢啲格暫時未計入`);
    ctx.addQuestion({
      kind: "month_close_site_new",
      groupKey: `site_new_times:${site.id}`,
      sort: 15,
      title: `${label}「${site.canonicalName}」更種時段解析唔到（代號 ${codesText}）`,
      evidence: {
        v: 1,
        mc: true,
        runId: ctx.runId ?? "",
        month: ctx.month.toISOString().slice(0, 10),
        kind: "month_close_site_new",
        summary: `${label}「${site.canonicalName}」嘅更表時段寫法解析唔到（代號 ${codesText}），冇自動建更種，相關格未計入——請去「盤」管理手動加更種（開工／收工時間）再重新撳一鍵結算`,
        suggestion: null,
        confidence: "unknown",
        action: { type: "site_new", siteId: site.id, groups: [] },
        candidates: [],
        prefillCandidateId: null,
      },
    });
  }
  ctx.summary.shiftTypesCreated += created;
  if (created > 0) {
    ctx.line("shift_type_created", `${label}「${site.canonicalName}」自動建 ${created} 個更種（由更表代號＋時段推出）`);
    if (!opts.isNewSite && !opts.skipReparse) await reparseRosterUpload(uploadId, { autoResolveSite: false, txTimeoutMs: REPARSE_TX_TIMEOUT_MS });
  }
  return { created, unparsedCodes, blocked };
}

/**
 * 本月、呢個盤有效更種 = 0 時，可由上載格自動推出幾多個更種（唔寫任何資料）。
 * 盤嘅格 = resolved_site_id 指住佢，或者上載掛佢而格未指定子盤；母盤（有子盤）本身刻意冇更種，一律跳過，
 * 但格歸咗 0 更種子盤，子盤照計（母盤上載、格歸子盤）。
 * 已知限制（§31.8）：reparse `confirmed` 上載會重建 rows，令 `reconcile_decisions` 嘅 `row:<id>` 決定孤兒、人手加嘅 row 備註 warning 被洗走。
 */
export interface ShiftTypePlan {
  eligible: boolean;
  uploadIds: string[];
  /** 會新建嘅更種數。 */
  creatable: number;
  /** 會復原（之前由一鍵 undo 作廢、規格完全相同）嘅更種數。 */
  revivable: number;
  unparsedCodes: string[];
  /** 唔復原亦唔另建嘅原因（人手作廢、或者收工時間／鐘數唔同）。 */
  blocked: string[];
}

export async function planShiftTypesForSite(siteId: string, month: Date): Promise<ShiftTypePlan> {
  const none: ShiftTypePlan = { eligible: false, uploadIds: [], creatable: 0, revivable: 0, unparsedCodes: [], blocked: [] };
  if ((await prisma.shiftType.count({ where: { siteId, voidedAt: null } })) > 0) return none;
  if ((await prisma.site.count({ where: { parentSiteId: siteId } })) > 0) return none;
  const uploads = await prisma.rosterUpload.findMany({
    where: { month, status: { in: ["parsed", "confirmed"] }, OR: [{ siteId }, { rows: { some: { resolvedSiteId: siteId } } }] },
    select: { id: true },
    orderBy: { uploadedAt: "asc" },
  });
  if (uploads.length === 0) return none;
  const create = new Set<string>();
  const revive = new Set<string>();
  const blocked = new Set<string>();
  const unparsed = new Set<string>();
  for (const u of uploads) {
    const d = await deriveShiftTypeGroups(u.id, siteId);
    for (const g of d.groups) {
      const { action } = await classifyGroup(siteId, g);
      const k = `${g.code.toUpperCase()}|${g.slot ?? ""}`;
      if (action.kind === "create") create.add(k);
      else if (action.kind === "revive") revive.add(k);
      else if (action.kind === "blocked") blocked.add(action.reason);
    }
    d.unparsedCodes.forEach((c) => unparsed.add(c));
  }
  return { eligible: true, uploadIds: uploads.map((u) => u.id), creatable: create.size, revivable: revive.size, unparsedCodes: [...unparsed], blocked: [...blocked] };
}

export interface EmptySiteResult {
  siteId: string;
  siteName: string;
  created: number;
  unparsedCodes: string[];
  blocked: string[];
  /** 全部 reparse 都成功（冇建更種時恆為 true）。 */
  reparsedOk: boolean;
  /** 只係補 reparse（盤已有更種，但更種比上載最後解析新）。 */
  repairOnly: boolean;
  /** reparse 之後仍然有代號對得到生效更種、但冇配到嘅格數（歧義）。 */
  ambiguousCells: number;
}

/**
 * 盤嘅生效更種比上載最後一次解析新（更種喺上載解析之後建／復原／被 PATCH／unvoid）→ 該上載要 reparse 一次，格先配到更種。
 * 以時間比較：上載解析時間＝rows 最後 created_at（reparse 會重建 rows）；更種時間＝生效更種最大 updated_at。
 * reparse 之後 rows 就新過更種，下個 run 唔會再 reparse（永遠配唔到嘅格唔會令每個 run 重複 reparse）。
 */
async function uploadsStaleAgainstShiftTypes(siteId: string, month: Date): Promise<string[]> {
  const stMax = (await prisma.shiftType.aggregate({ where: { siteId, voidedAt: null }, _max: { updatedAt: true } }))._max.updatedAt;
  if (!stMax) return [];
  const uploads = await prisma.rosterUpload.findMany({
    where: { month, status: { in: ["parsed", "confirmed"] }, OR: [{ siteId }, { rows: { some: { resolvedSiteId: siteId } } }] },
    select: { id: true },
  });
  const stale: string[] = [];
  for (const u of uploads) {
    const parsedAt = (await prisma.rosterUploadRow.aggregate({ where: { uploadId: u.id }, _max: { createdAt: true } }))._max.createdAt;
    if (parsedAt && parsedAt < stMax) stale.push(u.id);
  }
  return stale;
}

/** reparse 之後，盤仍有 shift／ot 格代號對得到某個生效更種、但冇配到（例如多過一個候選、時段對唔到）嘅格數。 */
async function ambiguousUnmatchedCells(siteId: string, month: Date): Promise<number> {
  const types = await prisma.shiftType.findMany({ where: { siteId, voidedAt: null }, select: { code: true } });
  const codes = new Set(types.map((t) => t.code.toUpperCase()));
  if (codes.size === 0) return 0;
  const rows = await prisma.rosterUploadRow.findMany({
    where: { codeKind: { in: ["shift", "ot"] }, shiftTypeId: null, upload: { month, status: { in: ["parsed", "confirmed"] } }, OR: [{ resolvedSiteId: siteId }, { resolvedSiteId: null, upload: { siteId } }] },
    select: { rawCode: true },
  });
  return rows.filter((r) => codes.has(r.rawCode.trim().toUpperCase())).length;
}

/**
 * 一鍵結算：本月有已解析上載、而盤有效更種係 0 嘅盤，自動由上載格補更種。回傳每盤結果。
 * 一個盤合計建咗更種，就對佢**所有**本月 active 上載 reparse（唔係淨係建更種嗰個上載）。
 * reparse 失敗唔會令 run 失敗：回報 `reparsedOk=false`，下次一鍵（盤有未配格）會再補 reparse。
 */
export async function ensureShiftTypesForEmptySites(ctx: AutoCollector, month: Date): Promise<EmptySiteResult[]> {
  const uploads = await prisma.rosterUpload.findMany({ where: { month, status: { in: ["parsed", "confirmed"] } }, select: { id: true, siteId: true } });
  const candidate = new Set<string>();
  for (const u of uploads) if (u.siteId) candidate.add(u.siteId);
  if (uploads.length > 0) {
    const rs = await prisma.rosterUploadRow.groupBy({ by: ["resolvedSiteId"], where: { uploadId: { in: uploads.map((u) => u.id) }, codeKind: { in: ["shift", "ot"] }, resolvedSiteId: { not: null } } });
    for (const r of rs) candidate.add(r.resolvedSiteId!);
  }
  const rematch = async (uploadIds: string[]): Promise<boolean> => {
    let ok = true;
    for (const uid of uploadIds) {
      try {
        await reparseRosterUpload(uid, { autoResolveSite: false, txTimeoutMs: REPARSE_TX_TIMEOUT_MS });
      } catch {
        ok = false;
      }
    }
    return ok;
  };
  const out: EmptySiteResult[] = [];
  for (const siteId of candidate) {
    if (ctx.newSiteIds.has(siteId)) continue;
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { canonicalName: true } });
    const siteName = site?.canonicalName ?? siteId.slice(0, 8);
    const plan = await planShiftTypesForSite(siteId, month);
    if (!plan.eligible) {
      if ((await prisma.site.count({ where: { parentSiteId: siteId } })) > 0) continue;
      const pending = await uploadsStaleAgainstShiftTypes(siteId, month);
      if (pending.length === 0) continue;
      const ok = await rematch(pending);
      out.push({ siteId, siteName, created: 0, unparsedCodes: [], blocked: [], reparsedOk: ok, repairOnly: true, ambiguousCells: await ambiguousUnmatchedCells(siteId, month) });
      continue;
    }
    let created = 0;
    const unparsed = new Set<string>();
    const blocked = new Set<string>();
    for (const uid of plan.uploadIds) {
      const r = await ensureShiftTypesFromUpload(ctx, siteId, uid, { skipReparse: true });
      created += r.created;
      r.unparsedCodes.forEach((c) => unparsed.add(c));
      r.blocked.forEach((c) => blocked.add(c));
    }
    let ok = true;
    if (created > 0) {
      ok = await rematch(plan.uploadIds);
    }
    out.push({ siteId, siteName, created, unparsedCodes: [...unparsed], blocked: [...blocked], reparsedOk: ok, repairOnly: false, ambiguousCells: created > 0 ? await ambiguousUnmatchedCells(siteId, month) : 0 });
  }
  return out;
}

/** 新盤：建 site＋更種（由上載行推）＋客戶名／別名（Postorder）。 */
async function createSiteFromUpload(ctx: AutoCollector, upload: { id: string; siteNameRaw: string }, otherSites: readonly SiteRow[]): Promise<{ siteId: string; shiftTypes: number; fromPostorder: boolean }> {
  const name = upload.siteNameRaw.trim();
  const ev = await ctx.postorder();
  const info = derivePostorderSiteInfo(name, ev, otherSites);
  const site = await prisma.site.create({
    data: { canonicalName: name, clientName: info.clientName ?? name, aliases: info.aliases, billingModel: "per_shift", status: "active", createdBy: ctx.actorUserId },
  });
  await ctx.audit({ tableName: "sites", rowId: site.id, action: "create", after: site });
  await ctx.journal({ kind: "site_created", refTable: "sites", refId: site.id, summary: `自動建新盤「${site.canonicalName}」`, detail: { siteId: site.id, uploadId: upload.id }, undoable: false });
  ctx.summary.sitesCreated++;
  ctx.newSiteIds.add(site.id);
  ctx.summary.aliasesFromPostorder += info.aliases.length;
  ctx.line("site_created", `新盤「${site.canonicalName}」已自動建立${info.clientName ? `（客戶「${info.clientName}」，來自 Postorder）` : ""}`);

  // 更種：由該上載嘅格推出。
  const ens = await ensureShiftTypesFromUpload(ctx, site.id, upload.id, { isNewSite: true });
  const created = ens.created;
  return { siteId: site.id, shiftTypes: created, fromPostorder: !!info.clientName || info.aliases.length > 0 };
}

async function finishAssign(ctx: ChangeWriter, upload: { id: string }, siteId: string): Promise<void> {
  await assignRosterUploadSite(upload.id, siteId);
  await reparseRosterUpload(upload.id, { autoResolveSite: false });
  await ctx.audit({ tableName: "roster_uploads", rowId: upload.id, action: "update", after: { id: upload.id, site_id: siteId } });
}

/** 一個冇指定盤嘅上載：決定歸邊個盤／建新盤／出分診題。caller 已經試過 `reparse autoResolve`。 */
export async function resolveUploadSite(
  ctx: AutoCollector,
  upload: { id: string; siteNameRaw: string },
  builtThisRun: Map<string, string>,
): Promise<UploadSiteOutcome> {
  try {
    const looseKey = normalizeSiteKey(upload.siteNameRaw);
    const done = builtThisRun.get(looseKey);
    if (done) {
      await finishAssign(ctx, upload, done);
      return { outcome: "assigned", siteId: done, via: "this_run" };
    }
    const sites = await loadSites();
    // 子盤（parent_site_id）都參與比對：對到子盤就歸子盤，唔另建重複頂層盤。
    const cls = classifySiteName(upload.siteNameRaw, sites);
    // 多子盤母盤安全網（同上載時 `resolveRosterUploadSite()` 一致）：對中一個有 >1 個子盤嘅母盤，
    // 唔肯定係邊個子盤 → 降做 propose（候選＝母盤同佢嘅子盤）。
    let level = cls.level;
    let proposeCandidates = cls.candidates;
    if ((level === "exact" || level === "auto") && cls.siteId) {
      const kids = sites.filter((x) => x.parentSiteId === cls.siteId);
      if (kids.length > 1) {
        level = "propose";
        proposeCandidates = [{ siteId: cls.siteId, score: cls.score }, ...kids.slice(0, 2).map((k) => ({ siteId: k.id, score: cls.score }))];
        cls.reason = `對中嘅盤有 ${kids.length} 個子盤，唔肯定歸邊個子盤`;
      }
    }
    if ((level === "exact" || level === "auto") && cls.siteId) {
      const siteName = sites.find((s) => s.id === cls.siteId)?.canonicalName ?? "";
      const added = await addSiteAlias(ctx, cls.siteId, upload.siteNameRaw.trim(), { uploadId: upload.id });
      await finishAssign(ctx, upload, cls.siteId);
      ctx.summary.sitesAliased++;
      ctx.line("site_alias", `更表盤名「${upload.siteNameRaw.trim()}」自動對上盤「${siteName}」（${level === "exact" ? "正規化後相同" : cls.reason}）${added ? "，已加別名" : ""}`);
      builtThisRun.set(looseKey, cls.siteId);
      return { outcome: "assigned", siteId: cls.siteId, via: level as "exact" | "auto" };
    }
    if (level === "propose" && proposeCandidates.length > 0) {
      const byId = new Map(sites.map((s) => [s.id, s.canonicalName]));
      const cands = proposeCandidates.map((c) => ({ id: c.siteId, label: byId.get(c.siteId) ?? c.siteId, refId: c.siteId, evidence: `相似度 ${c.score.toFixed(2)}` }));
      const draft: McQuestionDraft = {
        kind: "month_close_site_alias",
        groupKey: `site_alias:${upload.id}`,
        sort: 10,
        title: `更表盤名「${upload.siteNameRaw.trim()}」係咪現有盤「${cands[0]!.label}」？`,
        evidence: {
          v: 1,
          mc: true,
          runId: ctx.runId ?? "",
          month: ctx.month.toISOString().slice(0, 10),
          kind: "month_close_site_alias",
          summary: `更表盤名「${upload.siteNameRaw.trim()}」同現有盤似但唔夠硬（${cls.reason}），未歸盤，呢個盤本月更次暫時未計入`,
          suggestion: `當作現有盤「${cands[0]!.label}」嘅別名並歸盤`,
          confidence: "propose",
          action: { type: "site_alias", uploadId: upload.id, siteNameRaw: upload.siteNameRaw.trim() },
          candidates: cands,
          prefillCandidateId: cands[0]!.id,
        },
      };
      ctx.addQuestion(draft);
      return { outcome: "proposed" };
    }

    // 新盤
    if (cls.lookalikeSiteIds.length > 0) {
      const byId = new Map(sites.map((s) => [s.id, s.canonicalName]));
      ctx.warnings.push(`更表盤名「${upload.siteNameRaw.trim()}」似「${cls.lookalikeSiteIds.map((i) => byId.get(i) ?? "").filter(Boolean).join("」「")}」但數字／字母唔同，當新盤（唔會自動合併）`);
    }
    const made = await createSiteFromUpload(ctx, upload, sites);
    builtThisRun.set(looseKey, made.siteId);
    await finishAssign(ctx, upload, made.siteId);
    return { outcome: "created", siteId: made.siteId, shiftTypes: made.shiftTypes };
  } catch (e) {
    return { outcome: "failed", message: safeErrorSummary(e) };
  }
}

/** 分診「當新盤」：同一鍵結算自動建新盤一樣（建盤＋更種＋Postorder 客戶名／別名），audit 來源由 collector 標記。 */
export async function createSiteFromUploadForTriage(ctx: AutoCollector, upload: { id: string; siteNameRaw: string }): Promise<{ siteId: string; shiftTypes: number }> {
  const made = await createSiteFromUpload(ctx, upload, await loadSites());
  return { siteId: made.siteId, shiftTypes: made.shiftTypes };
}
