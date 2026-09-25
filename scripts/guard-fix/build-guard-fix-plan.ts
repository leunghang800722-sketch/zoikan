// WP-GUARD-FIX（老闆 2026-09-25 要求，緊急，直接影響出糧）：8 月更表
// 「未配對安員」自動修復——build-guard-fix-plan.ts。
//
// 讀目標 DB（`DATABASE_URL`）**實際嘅 2026-08 active 上載**（
// `roster_uploads.month=2026-08-01`、`status not in (superseded,
// voided)`）嘅 `roster_upload_rows`（`guard_match in (unmatched,
// ambiguous)`）——正式站同 dev 唔同，所以對住目標 DB 而唔係
// `records.jsonl`；dev 冇上載時 fallback 用
// `data/2026-09/aug-payroll-trial/out-rosters/records.jsonl`（逐行用
// 目標 DB 現狀行 `matchGuard()` 重新判斷邊啲仲係 unmatched/ambiguous）。
//
// 逐個身份（staff_no_raw／name_raw／tel_raw 組合）決定：
//   link          —— DB 已有同一人，登記工號／加別名。
//   create        —— U Team 名單搵到（U 號或姓名），起新安員。
//   create_minimal —— 名單都冇，起最簡安員，標 needs_hr。
//   needs_boss    —— ambiguous 決定唔到（多個判斷方法唔一致，或者 DB
//                     同名多人、U Team 名單都幫唔到手）。
//
// 輸出 `data/2026-09/guard-fix/plan.json`（帶真實姓名/電話/身份證，
// gitignored，唔准入 git）＋`plan-summary.md`（淨係數目／盤名／格數，
// needs_hr／needs_boss 用「盤＋格數＋原因」，唔列名）。
//
// 鐵則：呢個檔案／`apply-guard-fix-plan.ts` 一律唔准喺 log／console 印
// 姓名/電話/身份證/工號原文——PII 淨係寫落 gitignored 嘅 plan.json。
import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { matchGuard, buildGuardMatchIndex, matchBroker, type BrokerCandidate, type GuardMatchIndex } from "@/lib/roster-upload/match";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { normalizeTel } from "@/lib/guards/contacts";
import { loadUTeamList, buildUTeamIndex, loadCrossCheckMainSheet, buildCrossCheckIndex, type UTeamIndex, type CrossCheckIndex } from "./lib/sources";
import type { GuardFixPlan, GuardFixIdentity, GuardFixAction, LinkAction, CreateAction, CreateMinimalAction, NeedsBossAction, GuardFixCellRef } from "./lib/types";

const prisma = new PrismaClient();

const AUG_MONTH = new Date("2026-08-01T00:00:00.000Z");
const RECORDS_JSONL_PATH = "data/2026-09/aug-payroll-trial/out-rosters/records.jsonl";
const PLAN_DIR = "data/2026-09/guard-fix";
const PLAN_JSON_PATH = path.join(PLAN_DIR, "plan.json");
const PLAN_SUMMARY_PATH = path.join(PLAN_DIR, "plan-summary.md");

/** 同 apply-aug-plan.ts 一致做法：印目標 DB host:port/db，唔印帳號密碼。 */
function describeDbTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) return "（DATABASE_URL 未設）";
  try {
    const u = new URL(raw);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "（DATABASE_URL 解析唔到）";
  }
}

// ---------------------------------------------------------------------------
// 一個「原始格記錄」（唔理嚟自 DB rows 定 records.jsonl fallback）——build
// 出嚟之後兩個嚟源共用同一套分組／決定邏輯。
// ---------------------------------------------------------------------------
interface RawUnmatchedCell {
  kind: "unmatched" | "ambiguous";
  staffNoRaw: string | null;
  nameRaw: string;
  telRaw: string | null;
  siteLabel: string;
  brokerCodeRaw: string | null;
  settlementBrokerId: string | null;
}

async function loadFromDbRows(): Promise<RawUnmatchedCell[] | null> {
  const uploads = await prisma.rosterUpload.findMany({
    where: { month: AUG_MONTH, status: { notIn: ["superseded", "voided"] } },
    select: { id: true, siteId: true, siteNameRaw: true },
  });
  if (uploads.length === 0) return null;
  const uploadById = new Map(uploads.map((u) => [u.id, u]));
  const rows = await prisma.rosterUploadRow.findMany({
    where: { uploadId: { in: uploads.map((u) => u.id) }, guardMatch: { in: ["unmatched", "ambiguous"] }, nameRaw: { not: null } },
    select: { uploadId: true, resolvedSiteId: true, staffNoRaw: true, nameRaw: true, telRaw: true, guardMatch: true, brokerCodeRaw: true, settlementBrokerId: true },
  });
  if (rows.length === 0) return null; // 有 active 上載但冇 unmatched/ambiguous row——已經全部配到，唔使 fallback，直接當 0 個身份。
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

/** dev fallback：`records.jsonl` 冇「配對結果」（純解析輸出），要用目標
 * DB 現狀嘅 `matchGuard()` 逐行重新判斷邊啲仲係 unmatched/ambiguous。
 * `kind==='pointer'` 唔係真實更（數碼港指標行），跳過；`leave`／`ot`／
 * `work` 三種都可能帶安員身份，一齊判斷。 */
async function loadFromRecordsJsonl(guardIndex: GuardMatchIndex): Promise<RawUnmatchedCell[]> {
  if (!existsSync(RECORDS_JSONL_PATH)) {
    throw new Error(`目標 DB 冇 2026-08 active 上載，fallback 檔案都搵唔到：${RECORDS_JSONL_PATH}`);
  }
  const lines = readFileSync(RECORDS_JSONL_PATH, "utf8").split("\n").filter(Boolean);
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

// ---------------------------------------------------------------------------
// 分組做「身份」——staff_no_raw 正規化之後有值就用嚟分組（同一個號一定係
// 同一個人）；冇就用姓名（trim）分組（新散工大部分冇工號，姓名係主要
// 識別）。
// ---------------------------------------------------------------------------
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
    if (c.kind === "ambiguous") g.kind = "ambiguous"; // 呢個身份入面隨便一格 ambiguous 就當成個身份 ambiguous（唔准估）
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

// ---------------------------------------------------------------------------
// link 判斷——三種獨立方法，攞返 guardId（搵唔到就 undefined）；三種都
// 用就要一致先可以用，唔一致就 needs_boss（唔准估邊個啱）。
// ---------------------------------------------------------------------------
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

function findByHkid(
  staffNoRaw: string | null,
  nameRaw: string,
  uTeam: UTeamIndex,
  hkidIndex: Map<string, Set<string>>,
): LinkMethodResult | null {
  const uNumber = staffNoRaw ? normalizeStaffNumber(staffNoRaw) : null;
  const uRow = (uNumber && uTeam.byUNumber.get(uNumber)) || (uTeam.byName.get(nameRaw)?.length === 1 ? uTeam.byName.get(nameRaw)![0] : null);
  if (!uRow?.hkid) return null;
  const ids = hkidIndex.get(uRow.hkid);
  if (!ids || ids.size !== 1) return null;
  return { method: "U Team 名單身份證＝DB hkid", guardId: [...ids][0]! };
}

// ---------------------------------------------------------------------------
async function resolveDefaultBrokerCode(
  cell: { brokerCodeRaw: string | null; settlementBrokerId: string | null },
  brokerCandidates: BrokerCandidate[],
  brokerCodeById: Map<string, string>,
  siteAssignmentBrokerCodeBySite: Map<string, string[]>,
  siteLabel: string,
): Promise<string> {
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

async function main() {
  console.log(`[build-guard-fix-plan] 目標 DB：${describeDbTarget()}`);
  mkdirSync(PLAN_DIR, { recursive: true });

  const [guardsRaw, staffNumbersRaw, phonesRaw, brokersRaw, siteAssignments] = await Promise.all([
    prisma.guard.findMany({ select: { id: true, nameZh: true, tel: true, hkid: true, staffNo: true, staffNoMw: true, nameAliases: true } }),
    prisma.guardStaffNumber.findMany({ select: { number: true, guardId: true, status: true, scheme: true } }),
    prisma.guardPhone.findMany({ select: { guardId: true, tel: true } }),
    prisma.broker.findMany({ select: { id: true, code: true, aliases: true } }),
    prisma.brokerSiteAssignment.findMany({ where: { month: AUG_MONTH }, select: { siteId: true, broker: { select: { code: true } } } }),
  ]);
  const siteRows = await prisma.site.findMany({ select: { id: true, canonicalName: true } });
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

  // 電話→guardId 索引（`link` 判斷 (a) 電話正規化後相同）。
  const telIndex = new Map<string, Set<string>>();
  const addTel = (tel: string | null, guardId: string) => {
    if (!tel) return;
    const norm = normalizeTel(tel);
    if (!telIndex.has(norm)) telIndex.set(norm, new Set());
    telIndex.get(norm)!.add(guardId);
  };
  for (const g of guardsRaw) addTel(g.tel, g.id);
  for (const p of phonesRaw) addTel(p.tel, p.guardId);

  // 身份證→guardId 索引（`link` 判斷 (b) U Team 名單身份證＝DB hkid）。
  const hkidIndex = new Map<string, Set<string>>();
  for (const g of guardsRaw) {
    if (!g.hkid) continue;
    const norm = g.hkid.toUpperCase().replace(/\s+/g, "");
    if (!hkidIndex.has(norm)) hkidIndex.set(norm, new Set());
    hkidIndex.get(norm)!.add(g.id);
  }

  const guardById = new Map(guardsRaw.map((g) => [g.id, g]));
  const staffNumbersByGuard = new Map<string, typeof staffNumbersRaw>();
  for (const sn of staffNumbersRaw) {
    if (!staffNumbersByGuard.has(sn.guardId)) staffNumbersByGuard.set(sn.guardId, []);
    staffNumbersByGuard.get(sn.guardId)!.push(sn);
  }

  const [uTeamRows, crossCheckRows] = await Promise.all([loadUTeamList(), loadCrossCheckMainSheet()]);
  const uTeam = buildUTeamIndex(uTeamRows);
  const crossCheck = buildCrossCheckIndex(crossCheckRows);

  let sourceMode: GuardFixPlan["sourceMode"];
  let cells = await loadFromDbRows();
  if (cells === null) {
    sourceMode = "records_jsonl_fallback";
    cells = await loadFromRecordsJsonl(guardIndex);
  } else {
    sourceMode = "db_rows";
  }

  const identities = groupIntoIdentities(cells);

  const link: LinkAction[] = [];
  const create: CreateAction[] = [];
  const createMinimal: CreateMinimalAction[] = [];
  const needsBoss: NeedsBossAction[] = [];

  // 逐個身份代表嘅雞頭碼／盤——攞第一格用嚟決定 default_broker（一個身份
  // 通常淨係喺一個盤出現；極少數跨盤要人手覆核嗰批留返俾 needs_hr/needs_boss
  // 嘅原因文字提一句）。
  const cellsByIdentitySeq = new Map<string, RawUnmatchedCell[]>();
  for (const c of cells) {
    const staffNoNorm = c.staffNoRaw ? normalizeStaffNumber(c.staffNoRaw) : null;
    const key = staffNoNorm ? `sn:${staffNoNorm}` : `name:${c.nameRaw}`;
    // groupIntoIdentities 用返一樣個 key 邏輯分組，呢度重新行一次攞返
    // seq——簡單起見直接搵返嗰個 identity（`identities` 同 `cells` 順序
    // 一致，用 map 對返）。
    const identity = identities.find((i) => (i.staffNoRaw ? `sn:${normalizeStaffNumber(i.staffNoRaw)}` : `name:${i.nameRaw}`) === key);
    if (!identity) continue;
    if (!cellsByIdentitySeq.has(identity.seq)) cellsByIdentitySeq.set(identity.seq, []);
    cellsByIdentitySeq.get(identity.seq)!.push(c);
  }

  for (const identity of identities) {
    const representativeCell = cellsByIdentitySeq.get(identity.seq)?.[0] ?? { brokerCodeRaw: null, settlementBrokerId: null };
    const siteLabel = identity.cells[0]?.siteLabel ?? "（盤名未定）";
    const defaultBrokerCode = await resolveDefaultBrokerCode(representativeCell, brokerCandidates, brokerCodeById, siteAssignmentBrokerCodeBySite, siteLabel);

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

    // 三種方法都搵唔到——ambiguous 嘅身份（DB 已經同名多人，但判斷唔到
    // 邊個）交老闆；unmatched 嘅身份先試 U Team 名單。
    if (identity.kind === "ambiguous") {
      needsBoss.push({
        type: "needs_boss",
        seq: identity.seq,
        reason: "DB 同名多人，工號／電話／身份證都判斷唔到邊一個，交老闆睇",
        candidateGuardIds: [...(guardIndex.byName.get(identity.nameRaw) ?? [])],
      });
      continue;
    }

    const uNumber = identity.staffNoRaw ? normalizeStaffNumber(identity.staffNoRaw) : null;
    const uRowByNumber = uNumber ? uTeam.byUNumber.get(uNumber) : undefined;
    const uRowsByName = uTeam.byName.get(identity.nameRaw) ?? [];
    const uRow = uRowByNumber ?? (uRowsByName.length === 1 ? uRowsByName[0] : undefined);

    if (uRowByNumber === undefined && uNumber && uRowsByName.length === 0) {
      // 有 U 號但名單搵唔到呢個號——都試埋姓名，姓名都冇就真係名單完全
      // 冇（落 create_minimal）。上面 `uRow` 已經涵蓋咗呢個 fallback。
    }

    if (!uRow && uRowsByName.length > 1) {
      needsBoss.push({
        type: "needs_boss",
        seq: identity.seq,
        reason: "U Team 名單同名多過一個，決定唔到用邊一行，交老闆睇",
        candidateGuardIds: [],
      });
      continue;
    }

    if (uRow) {
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

  const plan: GuardFixPlan = {
    generatedAt: new Date().toISOString(),
    dbTarget: describeDbTarget(),
    sourceMode,
    identities,
    actions: { link, create, createMinimal, needsBoss },
  };
  writeFileSync(PLAN_JSON_PATH, JSON.stringify(plan, null, 2), "utf8");

  // plan-summary.md——淨係數目／盤名／格數，唔列名（鐵則）。
  const cellsBySiteFor = (actions: GuardFixAction[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const a of actions) {
      const identity = identities.find((i) => i.seq === a.seq)!;
      for (const c of identity.cells) m.set(c.siteLabel, (m.get(c.siteLabel) ?? 0) + c.cellCount);
    }
    return m;
  };
  const fmtSiteBreakdown = (m: Map<string, number>) => [...m.entries()].map(([site, n]) => `  - ${site}：${n} 格`).join("\n") || "  （冇）";

  const totalCells = identities.reduce((s, i) => s + i.totalCellCount, 0);
  const summary = `# WP-GUARD-FIX plan-summary（${plan.generatedAt}）

目標 DB：${plan.dbTarget}
資料嚟源：${sourceMode === "db_rows" ? "DB roster_upload_rows（2026-08 active 上載）" : "records.jsonl fallback（dev 冇上載）"}

## 總數
- 身份總數：${identities.length}（格總數：${totalCells}）
- link：${link.length}
- create：${create.length}
- create_minimal：${createMinimal.length}（＝ needs_hr）
- needs_hr：${createMinimal.length}
- needs_boss：${needsBoss.length}

## needs_hr（盤＋格數，U Team 名單／核對表都搵唔到，要 HR 補資料）
${fmtSiteBreakdown(cellsBySiteFor(createMinimal))}

## needs_boss（盤＋格數，決定唔到，要老闆睇）
${fmtSiteBreakdown(cellsBySiteFor(needsBoss))}
`;
  writeFileSync(PLAN_SUMMARY_PATH, summary, "utf8");

  console.log(`[build-guard-fix-plan] 身份總數 ${identities.length}（格總數 ${totalCells}）`);
  console.log(`[build-guard-fix-plan] link=${link.length} create=${create.length} create_minimal(needs_hr)=${createMinimal.length} needs_boss=${needsBoss.length}`);
  console.log(`[build-guard-fix-plan] plan.json → ${PLAN_JSON_PATH}`);
  console.log(`[build-guard-fix-plan] plan-summary.md → ${PLAN_SUMMARY_PATH}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
