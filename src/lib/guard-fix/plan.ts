// WP-GUARD-FIX-UI：8 月（或指定月份）更表「未配對安員」自動修復——
// 純邏輯模組，`scripts/guard-fix/build-guard-fix-plan.ts`（老闆 Terminal
// 用）同 `POST /api/guard-fix/plan`（老闆手機頁用）共用同一套判斷，
// 唔准複製貼上一份新邏輯（WP-GUARD-FIX-UI 鐵則）。
//
// 呢個檔冇寫入 DB（純讀），輸出 `GuardFixPlan`（PII，caller 自己決定存
// 邊度／印唔印）。
import { readFileSync, existsSync } from "fs";
import type { PrismaClient } from "@prisma/client";
import { matchGuard, buildGuardMatchIndex, matchBroker, type BrokerCandidate, type GuardMatchIndex } from "@/lib/roster-upload/match";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { normalizeTel } from "@/lib/guards/contacts";
import { buildUTeamIndex, buildCrossCheckIndex, canonicalHkid, type UTeamRow, type CrossCheckRow, type UTeamIndex, type CrossCheckIndex } from "@/lib/guard-fix/sources";
import type { GuardFixPlan, GuardFixIdentity, GuardFixAction, LinkAction, CreateAction, CreateMinimalAction, NeedsBossAction, GuardFixCellRef } from "@/lib/guard-fix/types";

export type { GuardFixPlan } from "@/lib/guard-fix/types";

/** DB 冇呢個月 active 上載（`roster_uploads` 一行都冇）——同「有上載但
 * 全部已配對」（0 個身份，唔係錯誤）分開。script 冇 `--allow-jsonl-
 * fallback` 就停；API 一律當錯誤（BadRequest）冇 fallback。 */
export class NoActiveUploadsError extends Error {
  constructor(month: string) {
    super(`目標 DB 冇 ${month} active 上載`);
    this.name = "NoActiveUploadsError";
  }
}

/** 目標 DB 唔同（plan 對住另一個 DB build）——`describeDbTarget()` 一致
 * 做法，script 同 API 都要停。 */
export function describeDbTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "（DATABASE_URL 未設）";
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "（DATABASE_URL 解析唔到）";
  }
}

interface RawUnmatchedCell {
  kind: "unmatched" | "ambiguous";
  staffNoRaw: string | null;
  nameRaw: string;
  telRaw: string | null;
  siteLabel: string;
  brokerCodeRaw: string | null;
  settlementBrokerId: string | null;
}

async function loadFromDbRows(prisma: PrismaClient, month: Date): Promise<RawUnmatchedCell[] | null> {
  const uploads = await prisma.rosterUpload.findMany({
    where: { month, status: { notIn: ["superseded", "voided"] } },
    select: { id: true, siteId: true, siteNameRaw: true },
  });
  if (uploads.length === 0) return null;
  const uploadById = new Map(uploads.map((u) => [u.id, u]));
  const rows = await prisma.rosterUploadRow.findMany({
    where: { uploadId: { in: uploads.map((u) => u.id) }, guardMatch: { in: ["unmatched", "ambiguous"] }, nameRaw: { not: null } },
    select: { uploadId: true, resolvedSiteId: true, staffNoRaw: true, nameRaw: true, telRaw: true, guardMatch: true, brokerCodeRaw: true, settlementBrokerId: true },
  });
  if (rows.length === 0) return []; // 有 active 上載但冇 unmatched/ambiguous＝已經全部配好，0 個身份
  const siteIds = [...new Set(rows.map((r) => r.resolvedSiteId).filter((x): x is string => !!x))];
  const sites = siteIds.length ? await prisma.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, canonicalName: true } }) : [];
  const siteNameById = new Map(sites.map((s) => [s.id, s.canonicalName]));
  return rows.map((r) => {
    const upload = uploadById.get(r.uploadId)!;
    const siteLabel = (r.resolvedSiteId && siteNameById.get(r.resolvedSiteId)) || upload.siteNameRaw || "（盤名未定）";
    return {
      kind: r.guardMatch as "unmatched" | "ambiguous",
      staffNoRaw: r.staffNoRaw,
      nameRaw: r.nameRaw!.trim(),
      telRaw: r.telRaw,
      siteLabel,
      brokerCodeRaw: r.brokerCodeRaw,
      settlementBrokerId: r.settlementBrokerId,
    };
  });
}

async function loadFromRecordsJsonl(recordsJsonlPath: string, guardIndex: GuardMatchIndex): Promise<RawUnmatchedCell[]> {
  if (!existsSync(recordsJsonlPath)) {
    throw new Error(`目標 DB 冇 active 上載，fallback 檔案都搵唔到：${recordsJsonlPath}`);
  }
  const lines = readFileSync(recordsJsonlPath, "utf8").split("\n").filter(Boolean);
  const out: RawUnmatchedCell[] = [];
  for (const line of lines) {
    const rec = JSON.parse(line) as {
      kind: string;
      name_raw?: string | null;
      name?: string | null;
      staff_no?: string | null;
      tel?: string | null;
      site_raw?: string | null;
      broker_code?: string | null;
    };
    if (rec.kind === "pointer") continue;
    const nameRaw = (rec.name_raw ?? rec.name ?? "").trim();
    if (!nameRaw) continue;
    const result = matchGuard({ staffNoRaw: rec.staff_no ?? null, nameRaw, telRaw: rec.tel ?? null }, guardIndex);
    if (result.guardMatch !== "unmatched" && result.guardMatch !== "ambiguous") continue;
    out.push({
      kind: result.guardMatch,
      staffNoRaw: rec.staff_no ?? null,
      nameRaw,
      telRaw: rec.tel ?? null,
      siteLabel: rec.site_raw?.trim() || "（盤名未定）",
      brokerCodeRaw: rec.broker_code ?? null,
      settlementBrokerId: null,
    });
  }
  return out;
}

function groupIntoIdentities(cells: RawUnmatchedCell[]): GuardFixIdentity[] {
  const groups = new Map<string, { kind: "unmatched" | "ambiguous"; staffNoRaw: string | null; nameRaw: string; telRaw: string | null; bySite: Map<string, number> }>();
  for (const c of cells) {
    const staffNoNorm = c.staffNoRaw ? normalizeStaffNumber(c.staffNoRaw) : null;
    const key = staffNoNorm ? `sn:${staffNoNorm}` : `name:${c.nameRaw}`;
    let g = groups.get(key);
    if (!g) {
      g = { kind: c.kind, staffNoRaw: c.staffNoRaw, nameRaw: c.nameRaw, telRaw: c.telRaw, bySite: new Map() };
      groups.set(key, g);
    }
    if (c.kind === "ambiguous") g.kind = "ambiguous";
    if (!g.telRaw && c.telRaw) g.telRaw = c.telRaw;
    g.bySite.set(c.siteLabel, (g.bySite.get(c.siteLabel) ?? 0) + 1);
  }
  let n = 0;
  return [...groups.values()].map((g) => {
    n += 1;
    const cellsArr: GuardFixCellRef[] = [...g.bySite.entries()].map(([siteLabel, cellCount]) => ({ siteLabel, cellCount }));
    return {
      seq: `I${String(n).padStart(3, "0")}`,
      kind: g.kind,
      staffNoRaw: g.staffNoRaw,
      nameRaw: g.nameRaw,
      telRaw: g.telRaw,
      cells: cellsArr,
      totalCellCount: cellsArr.reduce((s, c) => s + c.cellCount, 0),
    };
  });
}

interface LinkMethodResult {
  method: string;
  guardId: string;
}

function findByTel(telRaw: string | null, telIndex: Map<string, Set<string>>): LinkMethodResult | null {
  if (!telRaw) return null;
  const norm = normalizeTel(telRaw);
  const ids = telIndex.get(norm);
  if (!ids || ids.size !== 1) return null;
  return { method: "電話正規化後相同", guardId: [...ids][0]! };
}

function findByCrossCheck(nameRaw: string, crossCheck: CrossCheckIndex, validGuardIds: Set<string>): LinkMethodResult | null {
  const candidates = (crossCheck.byName.get(nameRaw) ?? []).filter((r) => r.systemId && validGuardIds.has(r.systemId));
  const ids = new Set(candidates.map((r) => r.systemId!));
  if (ids.size !== 1) return null;
  return { method: "核對表主檔同一系統 id", guardId: [...ids][0]! };
}

function findByHkid(staffNoRaw: string | null, nameRaw: string, uTeam: UTeamIndex, hkidIndex: Map<string, Set<string>>): LinkMethodResult | null {
  const uNumber = staffNoRaw ? normalizeStaffNumber(staffNoRaw) : null;
  const uRow = (uNumber && uTeam.byUNumber.get(uNumber)) || (uTeam.byName.get(nameRaw)?.length === 1 ? uTeam.byName.get(nameRaw)![0] : null);
  const canon = canonicalHkid(uRow?.hkid);
  if (!canon) return null;
  const ids = hkidIndex.get(canon);
  if (!ids || ids.size !== 1) return null;
  return { method: "U Team 名單身份證＝DB hkid", guardId: [...ids][0]! };
}

function resolveDefaultBrokerCode(
  cell: { brokerCodeRaw: string | null; settlementBrokerId: string | null },
  brokerCandidates: BrokerCandidate[],
  brokerCodeById: Map<string, string>,
  siteAssignmentBrokerCodeBySite: Map<string, string[]>,
  siteLabel: string,
): string {
  if (cell.settlementBrokerId) {
    const code = brokerCodeById.get(cell.settlementBrokerId);
    if (code) return code;
  }
  if (cell.brokerCodeRaw) {
    const id = matchBroker(cell.brokerCodeRaw, brokerCandidates);
    if (id) {
      const code = brokerCodeById.get(id);
      if (code) return code;
    }
  }
  const assigned = siteAssignmentBrokerCodeBySite.get(siteLabel);
  if (assigned && assigned.length === 1) return assigned[0]!;
  return "Y";
}

export interface BuildGuardFixPlanOptions {
  prisma: PrismaClient;
  /** 目標月份（第一日，UTC）。 */
  month: Date;
  /** U Team 名單 rows（由 xlsx 解析、記憶體，caller 負責攞——script 讀
   * 本機檔案路徑，API 讀現用 `staff_list_uploads` 嘅 bytes 重新解析）。 */
  uTeamRows: UTeamRow[];
  /** 核對表「主檔（每人一行）」rows（可選——API 暫時冇呢個上載流程，
   * 淨係 script 帶）。 */
  crossCheckRows?: CrossCheckRow[];
  /** dev fallback：DB 冇呢個月 active 上載就讀 `records.jsonl`（script
   * 專用，要 `--allow-jsonl-fallback`；API 一律唔傳，冇上載直接
   * `NoActiveUploadsError`）。 */
  recordsJsonlFallbackPath?: string;
}

export async function buildGuardFixPlan(opts: BuildGuardFixPlanOptions): Promise<GuardFixPlan> {
  const { prisma, month } = opts;
  const [guardsRaw, staffNumbersRaw, phonesRaw, brokersRaw, siteAssignments, siteRows] = await Promise.all([
    prisma.guard.findMany({ select: { id: true, nameZh: true, tel: true, hkid: true, staffNo: true, staffNoMw: true, nameAliases: true } }),
    prisma.guardStaffNumber.findMany({ select: { number: true, guardId: true, status: true, scheme: true } }),
    prisma.guardPhone.findMany({ select: { guardId: true, tel: true } }),
    prisma.broker.findMany({ select: { id: true, code: true, aliases: true } }),
    prisma.brokerSiteAssignment.findMany({ where: { month }, select: { siteId: true, broker: { select: { code: true } } } }),
    prisma.site.findMany({ select: { id: true, canonicalName: true } }),
  ]);
  const siteNameById = new Map(siteRows.map((s) => [s.id, s.canonicalName]));
  const siteAssignmentBrokerCodeBySite = new Map<string, string[]>();
  for (const a of siteAssignments) {
    const label = siteNameById.get(a.siteId) ?? a.siteId;
    if (!siteAssignmentBrokerCodeBySite.has(label)) siteAssignmentBrokerCodeBySite.set(label, []);
    const arr = siteAssignmentBrokerCodeBySite.get(label)!;
    if (!arr.includes(a.broker.code)) arr.push(a.broker.code);
  }
  const brokerCandidates: BrokerCandidate[] = brokersRaw.map((b) => ({ id: b.id, code: b.code, aliases: b.aliases }));
  const brokerCodeById = new Map(brokersRaw.map((b) => [b.id, b.code]));

  const guardIndex = buildGuardMatchIndex({ guards: guardsRaw, staffNumbers: staffNumbersRaw, phones: phonesRaw });
  const validGuardIds = new Set(guardsRaw.map((g) => g.id));

  const telIndex = new Map<string, Set<string>>();
  const addTel = (tel: string | null, guardId: string) => {
    if (!tel) return;
    const norm = normalizeTel(tel);
    if (!telIndex.has(norm)) telIndex.set(norm, new Set());
    telIndex.get(norm)!.add(guardId);
  };
  for (const g of guardsRaw) addTel(g.tel, g.id);
  for (const p of phonesRaw) addTel(p.tel, p.guardId);

  const hkidIndex = new Map<string, Set<string>>();
  for (const g of guardsRaw) {
    const norm = canonicalHkid(g.hkid);
    if (!norm) continue;
    if (!hkidIndex.has(norm)) hkidIndex.set(norm, new Set());
    hkidIndex.get(norm)!.add(g.id);
  }
  const staffNoOwner = new Map(staffNumbersRaw.map((sn) => [sn.number, sn.guardId]));
  for (const g of guardsRaw) {
    for (const legacy of [g.staffNo, g.staffNoMw]) {
      if (!legacy) continue;
      const n = normalizeStaffNumber(legacy);
      if (!staffNoOwner.has(n)) staffNoOwner.set(n, g.id);
    }
  }

  const guardById = new Map(guardsRaw.map((g) => [g.id, g]));
  const staffNumbersByGuard = new Map<string, typeof staffNumbersRaw>();
  for (const sn of staffNumbersRaw) {
    if (!staffNumbersByGuard.has(sn.guardId)) staffNumbersByGuard.set(sn.guardId, []);
    staffNumbersByGuard.get(sn.guardId)!.push(sn);
  }

  const uTeam = buildUTeamIndex(opts.uTeamRows);
  const crossCheck = buildCrossCheckIndex(opts.crossCheckRows ?? []);

  let sourceMode: GuardFixPlan["sourceMode"];
  let cells = await loadFromDbRows(prisma, month);
  if (cells === null) {
    if (!opts.recordsJsonlFallbackPath) {
      throw new NoActiveUploadsError(month.toISOString().slice(0, 10));
    }
    sourceMode = "records_jsonl_fallback";
    cells = await loadFromRecordsJsonl(opts.recordsJsonlFallbackPath, guardIndex);
  } else {
    sourceMode = "db_rows";
  }

  const identities = groupIntoIdentities(cells);

  const link: LinkAction[] = [];
  const create: CreateAction[] = [];
  const createMinimal: CreateMinimalAction[] = [];
  const needsBoss: NeedsBossAction[] = [];
  let hkidDroppedCount = 0;

  const cellsByIdentitySeq = new Map<string, RawUnmatchedCell[]>();
  for (const c of cells) {
    const staffNoNorm = c.staffNoRaw ? normalizeStaffNumber(c.staffNoRaw) : null;
    const key = staffNoNorm ? `sn:${staffNoNorm}` : `name:${c.nameRaw}`;
    const identity = identities.find((i) => (i.staffNoRaw ? `sn:${normalizeStaffNumber(i.staffNoRaw)}` : `name:${i.nameRaw}`) === key);
    if (!identity) continue;
    if (!cellsByIdentitySeq.has(identity.seq)) cellsByIdentitySeq.set(identity.seq, []);
    cellsByIdentitySeq.get(identity.seq)!.push(c);
  }

  for (const identity of identities) {
    const representativeCell = cellsByIdentitySeq.get(identity.seq)?.[0] ?? { brokerCodeRaw: null, settlementBrokerId: null };
    const siteLabel = identity.cells[0]?.siteLabel ?? "（盤名未定）";
    const defaultBrokerCode = resolveDefaultBrokerCode(representativeCell, brokerCandidates, brokerCodeById, siteAssignmentBrokerCodeBySite, siteLabel);

    const byTel = findByTel(identity.telRaw, telIndex);
    const byCrossCheck = findByCrossCheck(identity.nameRaw, crossCheck, validGuardIds);
    const byHkid = findByHkid(identity.staffNoRaw, identity.nameRaw, uTeam, hkidIndex);
    const methodsFound = [byTel, byCrossCheck, byHkid].filter((x): x is LinkMethodResult => x !== null);
    const distinctGuardIds = new Set(methodsFound.map((m) => m.guardId));

    if (distinctGuardIds.size > 1) {
      needsBoss.push({
        type: "needs_boss",
        seq: identity.seq,
        reason: `多種判斷方法搵到唔同人（${methodsFound.map((m) => m.method).join("／")}），決定唔到，交老闆睇`,
        candidateGuardIds: [...distinctGuardIds],
      });
      continue;
    }

    if (distinctGuardIds.size === 1) {
      const guardId = [...distinctGuardIds][0]!;
      const guard = guardById.get(guardId)!;
      const staffNoNorm = identity.staffNoRaw ? normalizeStaffNumber(identity.staffNoRaw) : null;
      const existingNumbers = staffNumbersByGuard.get(guardId) ?? [];
      const alreadyHasNumber = staffNoNorm ? existingNumbers.some((n) => n.number === staffNoNorm) : true;
      const scheme = staffNoNorm ? (staffNoNorm.match(/^[A-Z]+/)?.[0] ?? "U") : null;
      const snOwner = staffNoNorm ? staffNoOwner.get(staffNoNorm) : undefined;
      const snCorroborates = !!snOwner && snOwner === guardId;
      const hasOtherCurrentSameScheme =
        !!staffNoNorm && !snOwner && existingNumbers.some((n) => n.status === "current" && n.scheme === scheme && n.number !== staffNoNorm);
      const strongEvidence = methodsFound.some((m) => m === byHkid) || methodsFound.length >= 2 || snCorroborates;
      const refuse =
        snOwner && snOwner !== guardId
          ? "更表工號已經屬 DB 另一位安員，同電話／名單判斷到嘅人唔一致"
          : hasOtherCurrentSameScheme
            ? "更表工號同目標安員現有工號唔同（加咗會令佢現有號變已取消），可能係兩個人"
            : !strongEvidence
              ? `淨係一種弱證據（${methodsFound.map((m) => m.method).join("／")}），可能係家人／雞頭共用電話或同名唔同人`
              : null;
      if (refuse) {
        needsBoss.push({ type: "needs_boss", seq: identity.seq, reason: `${refuse}，唔自動 link，交老闆睇`, candidateGuardIds: [guardId] });
        continue;
      }
      const nameMatches = identity.nameRaw === guard.nameZh.trim();
      const alreadyHasAlias = guard.nameAliases.includes(identity.nameRaw);
      link.push({
        type: "link",
        seq: identity.seq,
        guardId,
        reason: methodsFound.map((m) => m.method).join("／"),
        addStaffNumber: !alreadyHasNumber && staffNoNorm && scheme ? { scheme, number: staffNoNorm } : null,
        addAlias: !nameMatches && !alreadyHasAlias ? identity.nameRaw : null,
      });
      continue;
    }

    if (identity.kind === "ambiguous") {
      const snNormForReason = identity.staffNoRaw ? normalizeStaffNumber(identity.staffNoRaw) : null;
      const snOwnedByOther = !!snNormForReason && staffNoOwner.has(snNormForReason);
      needsBoss.push({
        type: "needs_boss",
        seq: identity.seq,
        reason: snOwnedByOther
          ? "更表工號屬 DB 另一位安員（姓名對唔上，唔准配），電話／身份證都判斷唔到係邊個，交老闆睇"
          : "DB 同名多人，工號／電話／身份證都判斷唔到邊一個，交老闆睇",
        candidateGuardIds: [...(guardIndex.byName.get(identity.nameRaw) ?? [])],
      });
      continue;
    }

    const uNumber = identity.staffNoRaw ? normalizeStaffNumber(identity.staffNoRaw) : null;
    const uRowByNumber = uNumber ? uTeam.byUNumber.get(uNumber) : undefined;
    const uRowsByName = uTeam.byName.get(identity.nameRaw) ?? [];
    const uRow = uRowByNumber ?? (uRowsByName.length === 1 ? uRowsByName[0] : undefined);

    if (!uRow && uRowsByName.length > 1) {
      needsBoss.push({ type: "needs_boss", seq: identity.seq, reason: "U Team 名單同名多過一個，決定唔到用邊一行，交老闆睇", candidateGuardIds: [] });
      continue;
    }

    if (uRow) {
      const uRowHkidCanon = canonicalHkid(uRow.hkid);
      const uNumberForCreate = uRow.uNumber ?? uNumber;
      const rowTel = identity.telRaw ? normalizeTel(identity.telRaw) : null;
      const refuse =
        uRow.hkidNote === "mentions_other_number"
          ? "名單身份證欄備註話呢個人用緊另一個工號（DB 可能已經有呢個人）"
          : uRowHkidCanon && hkidIndex.has(uRowHkidCanon)
            ? "名單身份證已經喺 DB（同身份證已有安員），唔可以再起一個"
            : uNumberForCreate && staffNoOwner.has(uNumberForCreate)
              ? "名單工號已經屬 DB 另一位安員（任何狀態，含已取消——規則 8 唔復用）"
              : !uRowByNumber && (!rowTel || !uRow.tel || rowTel !== uRow.tel)
                ? !rowTel || !uRow.tel
                  ? "淨係靠姓名喺名單搵到，更表／名單冇電話可以核對（可能同名唔同人）"
                  : "淨係靠姓名喺名單搵到，而更表電話同名單電話對唔上（可能同名唔同人）"
                : null;
      if (refuse) {
        needsBoss.push({ type: "needs_boss", seq: identity.seq, reason: `${refuse}，唔自動建人，交老闆睇`, candidateGuardIds: [] });
        continue;
      }
    }

    if (uRow) {
      if (uRow.hkidNote === "invalid") hkidDroppedCount += 1;
      const nameZh = uRow.nameZh ?? uRow.displayName ?? identity.nameRaw;
      const alias = nameZh !== identity.nameRaw ? identity.nameRaw : null;
      const primaryTel = uRow.tel ?? identity.telRaw ?? null;
      const secondaryTel = identity.telRaw && primaryTel && normalizeTel(identity.telRaw) !== normalizeTel(primaryTel) ? identity.telRaw : null;
      create.push({
        type: "create",
        seq: identity.seq,
        nameZh,
        alias,
        primaryTel: primaryTel ? normalizeTel(primaryTel) : null,
        secondaryTel: secondaryTel ? normalizeTel(secondaryTel) : null,
        hkid: uRow.hkid,
        hireDate: uRow.hireDate,
        uNumber: uRow.uNumber ?? uNumber,
        defaultBrokerCode,
        reason: uRowByNumber ? "U Team 名單 U 號搵到" : "U Team 名單姓名搵到（冇 U 號）",
      });
      continue;
    }

    createMinimal.push({
      type: "create_minimal",
      seq: identity.seq,
      nameZh: identity.nameRaw,
      tel: identity.telRaw ? normalizeTel(identity.telRaw) : null,
      defaultBrokerCode,
      reason: "U Team 名單、核對表、DB 都搵唔到，需要 HR 補資料",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    dbTarget: describeDbTarget(),
    sourceMode,
    identities,
    actions: { link, create, createMinimal, needsBoss },
    hkidDroppedCount,
  };
}

/** plan-summary.md——淨係數目／盤名／格數，唔列名（鐵則），script 同
 * API（`guard_fix_runs.summary_json`／頁面摘要卡）共用。 */
export function summarizePlan(plan: GuardFixPlan): {
  totalIdentities: number;
  totalCells: number;
  link: number;
  create: number;
  createMinimal: number;
  needsBoss: number;
} {
  const totalCells = plan.identities.reduce((s, i) => s + i.totalCellCount, 0);
  return {
    totalIdentities: plan.identities.length,
    totalCells,
    link: plan.actions.link.length,
    create: plan.actions.create.length,
    createMinimal: plan.actions.createMinimal.length,
    needsBoss: plan.actions.needsBoss.length,
  };
}

export function formatPlanSummaryMd(plan: GuardFixPlan): string {
  const cellsBySiteFor = (actions: GuardFixAction[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const a of actions) {
      const identity = plan.identities.find((i) => i.seq === a.seq)!;
      for (const c of identity.cells) m.set(c.siteLabel, (m.get(c.siteLabel) ?? 0) + c.cellCount);
    }
    return m;
  };
  const fmtSiteBreakdown = (m: Map<string, number>) => [...m.entries()].map(([site, n]) => `  - ${site}：${n} 格`).join("\n") || "  （冇）";
  const s = summarizePlan(plan);
  return `# WP-GUARD-FIX plan-summary（${plan.generatedAt}）

目標 DB：${plan.dbTarget}
資料嚟源：${plan.sourceMode === "db_rows" ? "DB roster_upload_rows（active 上載）" : "records.jsonl fallback（dev 冇上載）"}

## 總數
- 身份總數：${s.totalIdentities}（格總數：${s.totalCells}）
- link：${s.link}
- create：${s.create}
- create_minimal：${s.createMinimal}（＝ needs_hr）
- needs_hr：${s.createMinimal}
- needs_boss：${s.needsBoss}
- create 入面名單身份證欄唔係身份證格式、冇寫入（要 HR 補）：${plan.hkidDroppedCount}

## needs_hr（盤＋格數，U Team 名單／核對表都搵唔到，要 HR 補資料）
${fmtSiteBreakdown(cellsBySiteFor(plan.actions.createMinimal))}

## needs_boss（盤＋格數，決定唔到，要老闆睇）
${fmtSiteBreakdown(cellsBySiteFor(plan.actions.needsBoss))}

## needs_boss 逐項（序號＋盤＋格數＋原因，唔列名；序號對返 plan.json）
${plan.actions.needsBoss.map((a) => `  - ${a.seq} ${plan.identities.find((i) => i.seq === a.seq)!.cells.map((c) => `${c.siteLabel} ${c.cellCount} 格`).join("、")}——${a.reason}`).join("\n") || "  （冇）"}
`;
}
