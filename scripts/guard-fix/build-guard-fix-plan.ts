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
import { loadUTeamList, buildUTeamIndex, loadCrossCheckMainSheet, buildCrossCheckIndex, canonicalHkid, type UTeamIndex, type CrossCheckIndex } from "./lib/sources";
import type { GuardFixPlan, GuardFixIdentity, GuardFixAction, LinkAction, CreateAction, CreateMinimalAction, NeedsBossAction, GuardFixCellRef } from "./lib/types";

const prisma = new PrismaClient();
// 驗收（Opus 5.5）：records.jsonl fallback 淨係 dev 明文要先用——之前「目標
// DB 冇 8 月上載」／「有上載但全部已配對」兩種情況都會靜靜跌去讀本機
// records.jsonl，對正式站（例如貼錯 DB、或者第二輪已經全部配好）就會用
// 本機檔案嘅姓名起安員。而家冇 flag 就停。
const ALLOW_JSONL_FALLBACK = process.argv.includes("--allow-jsonl-fallback");

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
  if (uploads.length === 0) return null; // caller 決定：有 --allow-jsonl-fallback 先 fallback，冇就停
  const uploadById = new Map(uploads.map((u) => [u.id, u]));
  const rows = await prisma.rosterUploadRow.findMany({
    where: { uploadId: { in: uploads.map((u) => u.id) }, guardMatch: { in: ["unmatched", "ambiguous"] }, nameRaw: { not: null } },
    select: { uploadId: true, resolvedSiteId: true, staffNoRaw: true, nameRaw: true, telRaw: true, guardMatch: true, brokerCodeRaw: true, settlementBrokerId: true },
  });
  // 驗收（Opus 5.5）：之前呢度 `return null`，同註解講嘅相反——會跌去
  // records.jsonl fallback。有 active 上載但冇 unmatched/ambiguous＝已經
  // 全部配好，0 個身份。
  if (rows.length === 0) return [];
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
  const canon = canonicalHkid(uRow?.hkid);
  if (!canon) return null;
  const ids = hkidIndex.get(canon);
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
    const norm = canonicalHkid(g.hkid);
    if (!norm) continue;
    if (!hkidIndex.has(norm)) hkidIndex.set(norm, new Set());
    hkidIndex.get(norm)!.add(g.id);
  }
  // 驗收（Opus 5.5）：工號（任何 status，含已取消）→ 擁有者——link／create
  // 都要避開「呢個號已經係 DB 另一個人嘅」（規則 8：已取消號唔復用）。
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

  const [uTeamRows, crossCheckRows] = await Promise.all([loadUTeamList(), loadCrossCheckMainSheet()]);
  const uTeam = buildUTeamIndex(uTeamRows);
  const crossCheck = buildCrossCheckIndex(crossCheckRows);

  let sourceMode: GuardFixPlan["sourceMode"];
  let cells = await loadFromDbRows();
  if (cells === null) {
    if (!ALLOW_JSONL_FALLBACK) {
      throw new Error("目標 DB 冇 2026-08 active 上載（貼啱 DB 未？）——停。dev 要用 records.jsonl 就加 --allow-jsonl-fallback。");
    }
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
  let hkidDroppedCount = 0; // 驗收（Opus 5.5）：名單身份證欄唔係身份證格式、冇寫入嘅 create 數

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
      // 驗收（Opus 5.5）——「建錯人」防線：
      //  (a) 更表工號已經係 DB **另一個人**嘅（任何 status）→ 唔准 link。
      //  (b) 更表工號 DB 冇，但目標人已經有同 scheme 嘅 current 號 → 加
      //      新號會將佢現有號轉做已取消（`upsertCurrentStaffNumber()`），
      //      兩個唔同號好大機會係兩個唔同人 → 唔准 link。
      //  (c) 淨係一種「弱」證據（電話相同——家人／雞頭電話；或者核對表
      //      按姓名搵到——同名唔同人）→ 唔准 link；要多一種獨立證據
      //      （身份證、另一種方法、或者更表工號本身已經屬呢個人）。
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

    // 三種方法都搵唔到——ambiguous 嘅身份（DB 已經同名多人，但判斷唔到
    // 邊個）交老闆；unmatched 嘅身份先試 U Team 名單。
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

    // 驗收（Opus 5.5）——建新人之前嘅防重複／防錯人：
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
- create 入面名單身份證欄唔係身份證格式、冇寫入（要 HR 補）：${hkidDroppedCount}

## needs_hr（盤＋格數，U Team 名單／核對表都搵唔到，要 HR 補資料）
${fmtSiteBreakdown(cellsBySiteFor(createMinimal))}

## needs_boss（盤＋格數，決定唔到，要老闆睇）
${fmtSiteBreakdown(cellsBySiteFor(needsBoss))}

## needs_boss 逐項（序號＋盤＋格數＋原因，唔列名；序號對返 plan.json）
${needsBoss.map((a) => `  - ${a.seq} ${identities.find((i) => i.seq === a.seq)!.cells.map((c) => `${c.siteLabel} ${c.cellCount} 格`).join("、")}——${a.reason}`).join("\n") || "  （冇）"}
`;
  writeFileSync(PLAN_SUMMARY_PATH, summary, "utf8");

  console.log(`[build-guard-fix-plan] 身份總數 ${identities.length}（格總數 ${totalCells}）`);
  console.log(`[build-guard-fix-plan] link=${link.length} create=${create.length} create_minimal(needs_hr)=${createMinimal.length} needs_boss=${needsBoss.length}`);
  if (hkidDroppedCount) console.log(`[build-guard-fix-plan] ! create 入面 ${hkidDroppedCount} 個名單身份證欄唔係身份證格式，冇寫入（要 HR 補）`);
  for (const a of needsBoss) console.log(`[build-guard-fix-plan] needs_boss ${a.seq}：${identities.find((i) => i.seq === a.seq)!.cells.map((c) => `${c.siteLabel} ${c.cellCount} 格`).join("、")}——${a.reason}`);
  console.log(`[build-guard-fix-plan] plan.json → ${PLAN_JSON_PATH}`);
  console.log(`[build-guard-fix-plan] plan-summary.md → ${PLAN_SUMMARY_PATH}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
