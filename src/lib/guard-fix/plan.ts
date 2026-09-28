// WP-GUARD-FIX-UI：8 月（或指定月份）更表「未配對安員」自動修復——
// 純邏輯模組，`scripts/guard-fix/build-guard-fix-plan.ts`（老闆 Terminal
// 用）同 `POST /api/guard-fix/plan`（老闆手機頁用）共用同一套判斷，
// 唔准複製貼上一份新邏輯（WP-GUARD-FIX-UI 鐵則）。
//
// 呢個檔冇寫入 DB（純讀），輸出 `GuardFixPlan`（PII，caller 自己決定存
// 邊度／印唔印）。
import { readFileSync, existsSync } from "fs";
import type { PrismaClient } from "@prisma/client";
import { matchGuard, buildGuardMatchIndex, matchBroker, matchSite, type BrokerCandidate, type GuardMatchIndex, type SiteCandidate } from "@/lib/roster-upload/match";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";
import { normalizeTel } from "@/lib/guards/contacts";
import { buildUTeamIndex, canonicalHkid, type UTeamRow, type UTeamIndex } from "@/lib/guard-fix/sources";
import { derivePostorderLongtermPostsFromPostorderCsv, type PostorderLongtermPostCell, type PostorderReferralRow, type PostorderVisaResult } from "@/lib/guard-fix/postorder";
import { inferReferralBrokerFromRosters } from "@/lib/pricing/longterm-settlement";
import type {
  GuardFixPlan,
  GuardFixIdentity,
  GuardFixAction,
  LinkAction,
  CreateAction,
  CreateMinimalAction,
  NeedsBossAction,
  GuardFixCellRef,
  SetLongtermAction,
  SetLongtermPostAction,
  SetReferralAction,
  SetReferralInferredAction,
  SetVisaAction,
} from "@/lib/guard-fix/types";

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
  /** dev fallback：DB 冇呢個月 active 上載就讀 `records.jsonl`（script
   * 專用，要 `--allow-jsonl-fallback`；API 一律唔傳，冇上載直接
   * `NoActiveUploadsError`）。 */
  recordsJsonlFallbackPath?: string;
  /** WP-LTSHIFT §19 交付 B：Postorder 上載解析結果（由 `postorder.ts`
   * 喺 caller 度由 `postorder_uploads.file_bytes` 重新解析，呢度純粹接
   * 埋落去計 4 類新 action）——冇上載就唔傳，四類新 action 一律 0 項。 */
  postorder?: {
    uploadId: string;
    fileName: string;
    longtermPosts: PostorderLongtermPostCell[];
    referralRows: PostorderReferralRow[];
    visa: PostorderVisaResult;
    /** WP-POSTORDER-PO-PAIRS：PostOrder 分頁 CSV 原文（`postorder.ts`
     * `PostorderParseResult.postorderCsvText`，直接 spread 埋落嚟）——
     * 冇（xlsm 路徑／冇上載 PostOrder CSV）就 `null`，`longtermPosts`
     * 唔會補推額外 (盤,人) 組合，行為同之前一樣。 */
    postorderCsvText?: string | null;
  };
}

interface PostorderPlanResult {
  setLongterm: SetLongtermAction[];
  setLongtermPost: SetLongtermPostAction[];
  setReferral: SetReferralAction[];
  setVisa: SetVisaAction[];
  unresolvedSiteLabels: string[];
  unresolvedBrokerLabels: string[];
}

/** WP-POSTORDER-PO-PAIRS：由 DB `guards` 表建兩個 name set，俾
 * `derivePostorderLongtermPostsFromPostorderGrid()` 呢個純函數用——
 * `all`＝`name_zh`＋`name_aliases`（NFKC 正規化，任何安員，用嚟濾走
 * 一般客戶／盤名尾段啱啱好似人名嗰啲行）；`longterm`＝`all` 嘅子集，
 * 淨係 `employment_type` 已經係 `longterm_` 開頭嗰啲（幫罕見「外判價
 * 係數字但已經係長工」個案，見 `postorder.ts` 檔頭註解）。 */
export function buildKnownGuardNames(guardsRaw: Array<{ nameZh: string; nameAliases: string[]; employmentType: string }>): { all: Set<string>; longterm: Set<string> } {
  const all = new Set<string>();
  const longterm = new Set<string>();
  for (const g of guardsRaw) {
    for (const raw of [g.nameZh, ...g.nameAliases]) {
      const norm = raw.normalize("NFKC").trim();
      if (!norm) continue;
      all.add(norm);
      if (g.employmentType.startsWith("longterm_")) longterm.add(norm);
    }
  }
  return { all, longterm };
}

/** WP-POSTORDER-PO-PAIRS 合併策略：「Roster／pairs 路徑（`primary`）有
 * 嘅 pairs 優先用；再 union PostOrder 推出嘅 pairs（`secondary`），同一
 * (盤,人) 組合只計一次，`cellCount` 取兩邊嘅較大值（唔加埋——兩個
 * 來源數緊同一批日曆格，唔係互補嘅另一批格）」。用 `matchGuard()`／
 * `matchSite()` 判斷「係咪同一個真實 (盤,人)」（唔淨係比較 raw 文字，
 * 因為 Roster／PostOrder 兩個分頁嘅「客戶名稱」措辭可以有出入）；
 * guard／site 都撞唔中嘅 cell 就跌返用 raw 文字做 key（保證唔會屈估
 * 併埋兩個未必係同一個人／盤嘅組合）——呢啲 cell 之後入
 * `buildPostorderActions()` 會各自再試一次 match，對唔到照樣落
 * unresolved 清單，唔會因為呢度 key 撞唔中而漏咗。 */
export function mergeLongtermPostCells(
  primary: PostorderLongtermPostCell[],
  secondary: PostorderLongtermPostCell[],
  guardIndex: GuardMatchIndex,
  siteCandidates: SiteCandidate[],
): PostorderLongtermPostCell[] {
  const keyFor = (cell: PostorderLongtermPostCell): string => {
    const guardResult = matchGuard({ staffNoRaw: null, nameRaw: cell.guardNameRaw, telRaw: null }, guardIndex);
    const siteId = matchSite(cell.siteLabelRaw, siteCandidates) ?? (cell.siteLabelFallbackRaw ? matchSite(cell.siteLabelFallbackRaw, siteCandidates) : null);
    const guardKey = guardResult.guardId ?? `raw-name:${cell.guardNameRaw}`;
    const siteKey = siteId ?? `raw-site:${cell.siteLabelRaw}`;
    return `${guardKey}\u0000${siteKey}`;
  };
  const merged = new Map<string, PostorderLongtermPostCell>();
  for (const cell of [...primary, ...secondary]) {
    const key = keyFor(cell);
    const cur = merged.get(key);
    if (!cur) {
      merged.set(key, { ...cell });
      continue;
    }
    cur.cellCount = Math.max(cur.cellCount, cell.cellCount);
    if (!cur.siteLabelFallbackRaw && cell.siteLabelFallbackRaw) cur.siteLabelFallbackRaw = cell.siteLabelFallbackRaw;
  }
  return [...merged.values()];
}

/** WP-LTSHIFT §19 交付 B：由 Postorder 解析結果計 4 類計劃——同 link/
 * create 一樣「對唔到就唔出呢個 action，唔准估」；對唔到嘅 site／
 * guard／broker 淨係計落 unresolved 清單（plan-summary／頁面摘要卡用，
 * 唔係 PII）。 */
function buildPostorderActions(params: {
  postorder: NonNullable<BuildGuardFixPlanOptions["postorder"]>;
  guardIndex: GuardMatchIndex;
  guardById: Map<string, { id: string; nameZh: string; employmentType: string; referralBrokerId: string | null }>;
  siteCandidates: SiteCandidate[];
  brokerCandidates: BrokerCandidate[];
  brokerCodeById: Map<string, string>;
  existingLongtermPosts: Set<string>; // `${guardId}\u0000${siteId}`
  startSeq: number;
}): PostorderPlanResult {
  const { postorder, guardIndex, guardById, siteCandidates, brokerCandidates, brokerCodeById, existingLongtermPosts } = params;
  let seqN = params.startSeq;
  const nextSeq = () => {
    seqN += 1;
    return `P${String(seqN).padStart(3, "0")}`;
  };

  const unresolvedSiteLabels = new Set<string>();
  const unresolvedBrokerLabels = new Set<string>();

  // ---- set_longterm / set_longterm_post：逐 (盤,人) 組合 ----
  const cellCountByGuard = new Map<string, number>();
  const setLongtermPost: SetLongtermPostAction[] = [];
  const seenLongtermPostKeys = new Set<string>();
  for (const post of postorder.longtermPosts) {
    const guardResult = matchGuard({ staffNoRaw: null, nameRaw: post.guardNameRaw, telRaw: null }, guardIndex);
    if (!guardResult.guardId) continue; // 對唔到就唔計（唔准估），留低 ≥50% 推算處理
    const guardId = guardResult.guardId;
    cellCountByGuard.set(guardId, (cellCountByGuard.get(guardId) ?? 0) + post.cellCount);

    // 先試「客戶名稱」去人名字句（例：「數碼港 CP5」），撞唔中就跌返
    // 「物業名稱」短代號（例：「CP5」）——長字句有時夾埋 zone/更份代號
    // （「啟航1331 IC」嘅「IC」），短代號冇呢個問題，配合 sites.aliases
    // 補齊短代號（見 P2 §19 第二部分「短代號」migration）令命中率高好多。
    const siteId = matchSite(post.siteLabelRaw, siteCandidates) ?? (post.siteLabelFallbackRaw ? matchSite(post.siteLabelFallbackRaw, siteCandidates) : null);
    if (!siteId) {
      unresolvedSiteLabels.add(post.siteLabelRaw);
      continue; // 保守：對唔到盤就唔建 set_longterm_post，留 ≥50% 推算＋標記
    }
    const pairKey = `${guardId}\u0000${siteId}`;
    if (existingLongtermPosts.has(pairKey) || seenLongtermPostKeys.has(pairKey)) continue; // 冪等：已經有生效崗位就唔重複計劃
    seenLongtermPostKeys.add(pairKey);
    const siteLabel = siteCandidates.find((s) => s.id === siteId)?.canonicalName ?? post.siteLabelRaw;
    setLongtermPost.push({
      type: "set_longterm_post",
      seq: nextSeq(),
      guardId,
      siteId,
      siteLabel,
      cellCount: post.cellCount,
      reason: `Postorder「(8) 長工」格：呢個 (盤,人) 組合喺 Roster 表撞中 ${post.cellCount} 格`,
    });
  }

  const setLongterm: SetLongtermAction[] = [];
  for (const [guardId, cellCount] of cellCountByGuard) {
    const guard = guardById.get(guardId);
    if (!guard) continue;
    if (guard.employmentType.startsWith("longterm_")) continue; // 已經係長工，唔使改
    setLongterm.push({
      type: "set_longterm",
      seq: nextSeq(),
      guardId,
      cellCount,
      fromEmploymentType: guard.employmentType,
      reason: `Postorder「(8) 長工」格出現過（合共 ${cellCount} 格）——由 ${guard.employmentType} 改做 longterm_autopay`,
    });
  }

  // ---- set_referral：逐條「長工雞頭費」行 ----
  const setReferral: SetReferralAction[] = [];
  const seenReferralGuardIds = new Set<string>();
  // 「行冇人名就由該盤該雞頭嘅長工 B07 格推」——盤名(raw) → 呢個盤有邊
  // 啲長工 B07 格人名（跨全部雞頭，用嚟做冇人名行嘅 fallback）。
  const guardNamesBySiteLabel = new Map<string, Set<string>>();
  const addGuardNameForSiteLabel = (label: string, name: string) => {
    if (!guardNamesBySiteLabel.has(label)) guardNamesBySiteLabel.set(label, new Set());
    guardNamesBySiteLabel.get(label)!.add(name);
  };
  for (const post of postorder.longtermPosts) {
    addGuardNameForSiteLabel(post.siteLabelRaw, post.guardNameRaw);
    if (post.siteLabelFallbackRaw) addGuardNameForSiteLabel(post.siteLabelFallbackRaw, post.guardNameRaw);
  }
  for (const row of postorder.referralRows) {
    const brokerId = matchBroker(row.brokerLabelRaw, brokerCandidates);
    if (!brokerId) {
      unresolvedBrokerLabels.add(row.brokerLabelRaw);
      continue; // 對唔到雞頭就唔計（唔准估）
    }
    const brokerCode = brokerCodeById.get(brokerId) ?? row.brokerLabelRaw;
    let names = row.guardNamesRaw;
    if (names.length === 0) {
      const fallback = new Set<string>();
      for (const siteLabel of [...row.siteLabelsRaw, ...row.siteLabelsFallbackRaw]) {
        for (const n of guardNamesBySiteLabel.get(siteLabel) ?? []) fallback.add(n);
      }
      names = [...fallback];
    }
    for (const nameRaw of names) {
      const guardResult = matchGuard({ staffNoRaw: null, nameRaw, telRaw: null }, guardIndex);
      if (!guardResult.guardId) continue;
      const guardId = guardResult.guardId;
      if (seenReferralGuardIds.has(guardId)) continue; // 一個長工淨係一個介紹雞頭，同一個跑重複行唔使再計劃
      const guard = guardById.get(guardId);
      if (guard?.referralBrokerId === brokerId) continue; // 已經係呢個雞頭，唔使改（冪等）
      seenReferralGuardIds.add(guardId);
      setReferral.push({
        type: "set_referral",
        seq: nextSeq(),
        guardId,
        brokerId,
        brokerCode,
        reason: `Postorder「長工雞頭費 (${row.brokerLabelRaw})」行（row ${row.rowIndex}）指住呢個長工`,
      });
    }
  }

  // ---- set_visa：Postorder 冇顯式標記，一律 0 項（見 postorder.ts） ----
  const setVisa: SetVisaAction[] = [];

  return {
    setLongterm,
    setLongtermPost,
    setReferral,
    setVisa,
    unresolvedSiteLabels: [...unresolvedSiteLabels],
    unresolvedBrokerLabels: [...unresolvedBrokerLabels],
  };
}

export async function buildGuardFixPlan(opts: BuildGuardFixPlanOptions): Promise<GuardFixPlan> {
  const { prisma, month } = opts;
  const [guardsRaw, staffNumbersRaw, phonesRaw, brokersRaw, siteAssignments, siteRows, existingLongtermPostRows] = await Promise.all([
    prisma.guard.findMany({
      select: { id: true, nameZh: true, tel: true, hkid: true, staffNo: true, staffNoMw: true, nameAliases: true, employmentType: true, referralBrokerId: true },
    }),
    prisma.guardStaffNumber.findMany({ select: { number: true, guardId: true, status: true, scheme: true } }),
    prisma.guardPhone.findMany({ select: { guardId: true, tel: true } }),
    prisma.broker.findMany({ select: { id: true, code: true, aliases: true } }),
    prisma.brokerSiteAssignment.findMany({ where: { month }, select: { siteId: true, broker: { select: { code: true } } } }),
    prisma.site.findMany({ select: { id: true, canonicalName: true, aliases: true } }),
    // 驗收（Opus 5.5）：淨係 `source=manual` 先當「已經有崗位」——`inferred`
    // （占比推算）／`july_backfill`（7 月反推）喺 Postorder 生效之後結算判斷
    // 度會被忽略（見 longterm-settlement.ts），所以總表
    // 有「(8) 長工」格嘅組合一定要出 set_longterm_post（apply 嗰陣順手作廢
    // 同組合嘅 inferred 記錄）。之前正式站「先逐盤套用、後上載 Postorder」
    // 嘅次序會令呢啲組合被當成已有崗位跳過（dev 重演：setPost 由 56 跌到 17）。
    prisma.guardLongtermPost.findMany({ where: { voidedAt: null, source: "manual" }, select: { guardId: true, siteId: true } }),
  ]);
  const matchOverridesRaw = await prisma.guardMatchOverride.findMany({ where: { voidedAt: null }, select: { staffNo: true, nameRaw: true, guardId: true } });
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

  const guardIndex = buildGuardMatchIndex({ guards: guardsRaw, staffNumbers: staffNumbersRaw, phones: phonesRaw, matchOverrides: matchOverridesRaw });

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
    const byHkid = findByHkid(identity.staffNoRaw, identity.nameRaw, uTeam, hkidIndex);
    const methodsFound = [byTel, byHkid].filter((x): x is LinkMethodResult => x !== null);
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
      const sameNameInDb = (guardIndex.byName.get(identity.nameRaw)?.length ?? 0) + (guardIndex.byAlias.get(identity.nameRaw)?.length ?? 0);
      if (snOwnedByOther && snNormForReason && sameNameInDb === 0) {
        // 驗收（Opus 5.5，2026-09-26）：老闆指令唔准留「要老闆決定」——保守
        // 預設：工號屬另一人、DB 冇同名安員 → 按更表姓名（＋更表電話）建
        // 獨立安員（cash_casual、無工號），寫 guard_match_overrides 令呢個
        // 「工號＋姓名」組合 reparse 配返新安員；唔會搶走工號主人嘅記錄
        // （B1-8 原則不變），audit＋override.reason 留「工號衝突待核」。
        createMinimal.push({
          type: "create_minimal",
          seq: identity.seq,
          nameZh: identity.nameRaw,
          tel: identity.telRaw ? normalizeTel(identity.telRaw) : null,
          defaultBrokerCode,
          reason: "更表工號屬 DB 另一位安員（姓名對唔上）——保守預設：按更表姓名建獨立安員（無工號），工號衝突待核",
          conservative: "staff_no_conflict",
          matchOverrideStaffNo: snNormForReason,
        });
        continue;
      }
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
      // 驗收（Opus 5.5，2026-09-26）：「淨係靠姓名喺名單搵到」嘅兩種（名單／
      // 更表冇電話核對、或者電話對唔上）唔再留 needs_boss——保守預設：唔用
      // 名單嗰行資料（可能係同名另一人），按更表姓名＋更表電話建獨立安員
      // （cash_casual、無工號、無身份證），待核。其餘拒絕原因（身份證／
      // 工號已喺 DB）照舊交老闆（嗰啲係「DB 可能已經有呢個人」，唔可以
      // 再起一個）。
      const nameOnlyUnverified = !uRowByNumber && !(uRow.hkidNote === "mentions_other_number") && !(uRowHkidCanon && hkidIndex.has(uRowHkidCanon)) && !(uNumberForCreate && staffNoOwner.has(uNumberForCreate));
      if (refuse && nameOnlyUnverified && (guardIndex.byName.get(identity.nameRaw)?.length ?? 0) + (guardIndex.byAlias.get(identity.nameRaw)?.length ?? 0) === 0) {
        createMinimal.push({
          type: "create_minimal",
          seq: identity.seq,
          nameZh: identity.nameRaw,
          tel: rowTel,
          defaultBrokerCode,
          reason: `${refuse}——保守預設：唔用名單資料，按更表姓名建獨立安員（無工號），待核`,
          conservative: "name_only_unverified",
          matchOverrideStaffNo: null,
        });
        continue;
      }
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

  let setLongterm: SetLongtermAction[] = [];
  let setLongtermPost: SetLongtermPostAction[] = [];
  let setReferral: SetReferralAction[] = [];
  let setVisa: SetVisaAction[] = [];
  let postorderSummary: GuardFixPlan["postorder"] = null;
  if (opts.postorder) {
    const guardByIdForPostorder = new Map(guardsRaw.map((g) => [g.id, { id: g.id, nameZh: g.nameZh, employmentType: g.employmentType, referralBrokerId: g.referralBrokerId }]));
    const siteCandidates: SiteCandidate[] = siteRows.map((s) => ({ id: s.id, canonicalName: s.canonicalName, aliases: s.aliases }));
    const existingLongtermPosts = new Set(existingLongtermPostRows.map((p) => `${p.guardId}\u0000${p.siteId}`));

    // WP-POSTORDER-PO-PAIRS：正式站操作員傳唔到 Roster CSV／
    // longterm-pairs.csv（上載瓶頸），但已經有完整嘅 PostOrder.csv——
    // 單靠佢都補推到 (盤,人) 組合（見 postorder.ts 檔頭規則），同
    // Roster/pairs 路徑現有嘅組合 union（cell_count 取大）先入
    // buildPostorderActions()，令「淨係得截短 Roster／冇 Roster」嘅
    // 上載重新計劃都可以得返齊全嘅 set_longterm_post。
    const knownGuardNames = buildKnownGuardNames(guardsRaw);
    const postorderDerivedPosts = opts.postorder.postorderCsvText
      ? derivePostorderLongtermPostsFromPostorderCsv(opts.postorder.postorderCsvText, knownGuardNames.all, knownGuardNames.longterm)
      : [];
    const mergedLongtermPosts = mergeLongtermPostCells(opts.postorder.longtermPosts, postorderDerivedPosts, guardIndex, siteCandidates);

    const result = buildPostorderActions({
      postorder: { ...opts.postorder, longtermPosts: mergedLongtermPosts },
      guardIndex,
      guardById: guardByIdForPostorder,
      siteCandidates,
      brokerCandidates,
      brokerCodeById,
      existingLongtermPosts,
      startSeq: identities.length,
    });
    setLongterm = result.setLongterm;
    setLongtermPost = result.setLongtermPost;
    setReferral = result.setReferral;
    setVisa = result.setVisa;
    postorderSummary = {
      uploadId: opts.postorder.uploadId,
      fileName: opts.postorder.fileName,
      longtermPostCellCount: mergedLongtermPosts.reduce((s, p) => s + p.cellCount, 0),
      referralRowCount: opts.postorder.referralRows.length,
      unresolvedSiteLabels: result.unresolvedSiteLabels,
      unresolvedBrokerLabels: result.unresolvedBrokerLabels,
      visaSupported: opts.postorder.visa.supported,
      visaNote: opts.postorder.visa.reason,
      longtermPairsFromPostorderCount: postorderDerivedPosts.length,
    };
  }

  // -------------------------------------------------------------------
  // WP-REFERRAL-FALLBACK（老闆 2026-09-26 緊急）：set_referral_inferred
  // ——唔靠 Postorder，淨係睇更表本身嘅雞頭碼推算供應（＝介紹）雞頭（見
  // `inferReferralBrokerFromRosters()`）。範圍：**已經係長工**（先有
  // 「自己崗位盤」呢個概念）、`referral_broker_id IS NULL`、而且呢次冇
  // 被 Postorder xlsm 嘅 `set_referral` 蓋到（xlsm 有明確資料就以 xlsm
  // 為準，唔重複再出一次）——冇上載 Postorder（或者上載嘅係 CSV，冇公式
  // 計唔到 `set_referral`）都一樣會計，正正解決「正式站淨係得 CSV，
  // 8 月介紹費計 0」呢個問題。
  // -------------------------------------------------------------------
  const referralCoveredThisRun = new Set(setReferral.map((a) => a.guardId));
  const referralInferredCandidates = guardsRaw.filter((g) => g.employmentType.startsWith("longterm_") && g.referralBrokerId === null && !referralCoveredThisRun.has(g.id));
  const setReferralInferred: SetReferralInferredAction[] = [];
  let seqReferralInferredN = 0;
  for (const guard of referralInferredCandidates) {
    const inferred = await inferReferralBrokerFromRosters(guard.id, month, prisma);
    if (!inferred.brokerId) continue; // 對唔到就唔出呢個 action（唔准估，留俾人手覆核）
    seqReferralInferredN += 1;
    setReferralInferred.push({
      type: "set_referral_inferred",
      seq: `R${String(seqReferralInferredN).padStart(3, "0")}`,
      guardId: guard.id,
      brokerId: inferred.brokerId,
      brokerCode: brokerCodeById.get(inferred.brokerId) ?? inferred.brokerId,
      reason: inferred.reason,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    dbTarget: describeDbTarget(),
    sourceMode,
    identities,
    actions: { link, create, createMinimal, needsBoss, setLongterm, setLongtermPost, setReferral, setReferralInferred, setVisa },
    hkidDroppedCount,
    postorder: postorderSummary,
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
  setLongterm: number;
  setLongtermPost: number;
  setReferral: number;
  setReferralInferred: number;
  setVisa: number;
} {
  const totalCells = plan.identities.reduce((s, i) => s + i.totalCellCount, 0);
  return {
    totalIdentities: plan.identities.length,
    totalCells,
    link: plan.actions.link.length,
    create: plan.actions.create.length,
    createMinimal: plan.actions.createMinimal.length,
    needsBoss: plan.actions.needsBoss.length,
    setLongterm: plan.actions.setLongterm.length,
    setLongtermPost: plan.actions.setLongtermPost.length,
    setReferral: plan.actions.setReferral.length,
    setReferralInferred: plan.actions.setReferralInferred.length,
    setVisa: plan.actions.setVisa.length,
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
- set_longterm：${s.setLongterm}
- set_longterm_post：${s.setLongtermPost}
- set_referral：${s.setReferral}
- set_referral_inferred（WP-REFERRAL-FALLBACK，唔靠 Postorder，睇更表雞頭碼推算）：${s.setReferralInferred}
- set_visa：${s.setVisa}（Postorder 冇顯式簽證標記，暫時一律 0——${plan.postorder?.visaNote ?? "冇上載 Postorder"}）

## Postorder 上載（WP-LTSHIFT §19）
${plan.postorder ? `- 檔案：${plan.postorder.fileName}（upload ${plan.postorder.uploadId}）\n- 長工格總數：${plan.postorder.longtermPostCellCount}\n- 介紹費行數：${plan.postorder.referralRowCount}\n- 單靠 PostOrder CSV 補推嘅 (盤,人) 組合數（WP-POSTORDER-PO-PAIRS）：${plan.postorder.longtermPairsFromPostorderCount}\n- 對唔到嘅盤名：${plan.postorder.unresolvedSiteLabels.join("、") || "（冇）"}\n- 對唔到嘅雞頭稱呼：${plan.postorder.unresolvedBrokerLabels.join("、") || "（冇）"}` : "（呢次冇上載 Postorder，set_longterm/set_longterm_post/set_referral/set_visa 一律 0 項）"}

## needs_hr（盤＋格數，U Team 名單／核對表都搵唔到，要 HR 補資料）
${fmtSiteBreakdown(cellsBySiteFor(plan.actions.createMinimal))}

## needs_boss（盤＋格數，決定唔到，要老闆睇）
${fmtSiteBreakdown(cellsBySiteFor(plan.actions.needsBoss))}

## needs_boss 逐項（序號＋盤＋格數＋原因，唔列名；序號對返 plan.json）
${plan.actions.needsBoss.map((a) => `  - ${a.seq} ${plan.identities.find((i) => i.seq === a.seq)!.cells.map((c) => `${c.siteLabel} ${c.cellCount} 格`).join("、")}——${a.reason}`).join("\n") || "  （冇）"}
`;
}
