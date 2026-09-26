// WP-LTSHIFT（老闆 2026-09-26）：長工更嘅結算單位判斷——見任務書 §2。
//
// 背景（`data/2026-09/aug-e2e-check/報告-2026-09-26.md` B3）：總表將長工
// 做自己崗位嘅更歸內部結算單位 internal_longterm（B07，`payout_rate=0`，
// 人工由月薪覆蓋），但更表上載／對數之前一律照抄更表雞頭欄（K 供應長工，
// 長工行嘅雞頭碼都係 K）——令長工更被當外判更計費，1,295 格差額嘅主因。
//
// 呢個 module 加喺 `resolveSettlementBrokerFallback()`（規則 8：冇雞頭碼
// 欄先用嘅 fallback 鏈）**之前**嘅新第一層——只對 `employment_type` 開頭
// `longterm_` 嘅安員生效，唔理雞頭碼欄有冇值都會覆寫（總表 8 月長工行
// 雞頭碼一律填緊 K，唔可以照抄）：
//
//   1. 簽證形式長工（`guard.visaSponsoredByBrokerId` 有值）→ 永遠當
//      該雞頭散更（settlement=operational=該雞頭），唔理崗位盤。
//   2. 有生效中崗位盤（含母盤摺埋），呢更所在盤喺入面 → 結算單位=B07，
//      operational_broker_id=更表雞頭碼嗰個雞頭（總表成本桶照舊）。
//   3. 冇任何生效中崗位盤（呢個安員完全未有崗位記錄）→ 用該月更表行
//      占比保守推算（`inferGuardMonthlyTopSite()`）：
//        - 佔比 ≥50% 嘅盤 → 當作崗位盤（source=inferred），行為同 2。
//        - 推算唔到（分散多盤 /冇資料）→ 保守：全部當長工更（B07），
//          唔畀雞頭錢。
//   4. 有崗位盤但呢更所在盤唔喺入面（安員有崗位、去咗第二個盤頂更）→
//      跟更表雞頭碼幫雞頭頂散更，warning「長工頂雞頭更」。
//
// 呢一層淨係**決定**（純函數 `resolveLongtermSettlement()` + 兩個 DB
// helper），唔喺呢度寫 `guard_longterm_posts`（inferred 嗰種要喺 caller
// 決定套用先落 DB——跟返呢個 repo「對數只係 preview，apply 先寫入」嘅
// 一貫做法，見 reconcile.ts／reconcile-apply.ts）。
import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

type PrismaLike = PrismaClient | Prisma.TransactionClient;

export type LongtermSettlementReason =
  | "visa_sponsor" // 簽證形式長工，永遠跟贊助雞頭
  | "longterm_post" // 喺生效崗位盤（manual/july_backfill）
  | "longterm_inferred_post" // 喺推算崗位盤（本次先發現，ratio>=50%）
  | "longterm_non_post_broker" // 有崗位但呢更唔喺崗位盤，跟更表雞頭碼頂散更
  | "longterm_dispersed_b07" // 完全冇崗位記錄、推算唔到（分散多盤），保守全部 B07
  | "longterm_no_post_postorder"; // 本月有 Postorder（權威）、總表冇呢個長工任何「(8) 長工」格 → 跟更表雞頭碼頂散更

export interface LongtermSettlementResult {
  settlementBrokerId: string | null;
  operationalBrokerId: string | null;
  reason: LongtermSettlementReason;
  warning: string | null;
  /** reason=longterm_inferred_post 先有值——呢個安員本次推算出嚟嘅崗位
   * 盤，caller（reconcile-apply）套用 apply_roster 嗰陣要順便
   * upsert 一行 `guard_longterm_posts`（source=inferred）。 */
  inferredPostSiteId?: string;
  inferredPostRatio?: number; // 0~1，寫入 note 用
}

export interface ResolveLongtermSettlementInput {
  employmentType: string;
  visaSponsoredByBrokerId: string | null;
  /** 呢更所在盤（`resolved_site_id ?? upload.site_id`）。 */
  effectiveSiteId: string;
  /** 呢個盤嘅母盤 id（冇母盤就 null）。 */
  parentSiteId: string | null;
  /** 更表本行雞頭碼解析出嚟嘅 broker（呢張上載有雞頭碼欄先有值；冇
   * 雞頭碼欄嘅盤呢度傳 null，由舊 fallback 鏈（規則 8）補）。 */
  rosterBrokerId: string | null;
  /** 呢個安員生效中嘅崗位盤 id 集合（母盤已經摺埋——即係話一個安員如果
   * 崗位登記喺母盤，呢個 set 入面母盤同全部子盤都應該有）。空集合＝
   * 完全冇崗位記錄，要行推算。 */
  activePostSiteIds: Set<string>;
  /** 呢個安員本月各（已摺母盤）盤嘅更表行占比推算結果——`activePostSiteIds`
   * 空集合先會用到。 */
  monthlyTopSite: { siteId: string; ratio: number } | null;
  /** 驗收（Opus 5.5，2026-09-26）：呢個月已經上載咗 Postorder 總表（權威
   * 來源）——長工崗位盤一律由 Postorder「(8) 長工」格（guard-fix
   * `set_longterm_post`）決定，**唔再**用 ≥50% 占比推算，亦唔睇
   * `source=inferred`／`july_backfill` 嘅崗位（caller 用 `loadActiveLongtermPosts(...,
   * { excludeInferred: true })` 攞 `activePostSiteIds`，淨係 manual）。冇崗位＝總表
   * 冇佢嘅長工格＝佢呢個月喺呢啲盤做嘅更全部係幫雞頭頂散更（同總表
   * `s05_price.py` `is_lt = (盤,人) in po_lt_posts` 一致）。8 月實測：
   * 推算令 39 格（簽證形式長工 26＋非 8 月在職長工 13）錯歸 B07、少畀
   * K 33,540。 */
  postorderAuthoritative?: boolean;
}

/** 是咪長工（`employment_type` 開頭 `longterm_`）。 */
export function isLongtermEmploymentType(employmentType: string | null | undefined): boolean {
  return !!employmentType && employmentType.startsWith("longterm_");
}

/**
 * 純函數：逐格判斷長工結算單位。唔適用（唔係長工）就回 null，caller 行
 * 返舊嘅 `resolveSettlementBrokerFallback()` 鏈。
 */
export function resolveLongtermSettlement(input: ResolveLongtermSettlementInput): LongtermSettlementResult | null {
  if (!isLongtermEmploymentType(input.employmentType)) return null;

  // 1：簽證形式長工——永遠當贊助雞頭散更，唔理崗位盤。
  if (input.visaSponsoredByBrokerId) {
    return {
      settlementBrokerId: input.visaSponsoredByBrokerId,
      operationalBrokerId: input.visaSponsoredByBrokerId,
      reason: "visa_sponsor",
      warning: null,
    };
  }

  const inPost = input.activePostSiteIds.has(input.effectiveSiteId) || (input.parentSiteId !== null && input.activePostSiteIds.has(input.parentSiteId));

  if (input.activePostSiteIds.size === 0 && input.postorderAuthoritative) {
    // 3'：本月 Postorder 係權威，總表冇呢個長工任何長工格 → 跟更表雞頭
    // 碼（規則 2：長工用假期幫雞頭做散更，照付雞頭外判價）。更表冇雞頭
    // 碼欄（rosterBrokerId=null）嗰陣 caller 會跌返舊 fallback 鏈。
    return {
      settlementBrokerId: input.rosterBrokerId,
      operationalBrokerId: input.rosterBrokerId,
      reason: "longterm_no_post_postorder",
      warning: input.rosterBrokerId ? "本月 Postorder 總表冇呢個長工嘅「(8) 長工」格，呢更跟更表雞頭碼幫雞頭頂散更" : null,
    };
  }

  if (input.activePostSiteIds.size === 0) {
    // 3：完全冇崗位記錄——用本月占比推算（保守預設，老闆指令）。
    const top = input.monthlyTopSite;
    if (top && top.ratio >= 0.5) {
      const atThisSite = top.siteId === input.effectiveSiteId || top.siteId === input.parentSiteId;
      return {
        settlementBrokerId: null, // caller 補（B07 broker id，呢層唔查 DB）
        operationalBrokerId: input.rosterBrokerId,
        reason: "longterm_inferred_post",
        warning: atThisSite
          ? `崗位盤由本月更表推算（占比 ${(top.ratio * 100).toFixed(0)}%），已自動建立崗位記錄，請覆核`
          : `崗位盤由本月更表推算為另一個盤（占比 ${(top.ratio * 100).toFixed(0)}%），呢更跟更表雞頭碼幫雞頭頂散更`,
        inferredPostSiteId: top.siteId,
        inferredPostRatio: top.ratio,
      };
    }
    // 推算唔到（分散多盤／冇資料）——保守：全部當長工更（B07），唔會
    // 多畀雞頭錢。
    return {
      settlementBrokerId: null, // caller 補 B07
      operationalBrokerId: input.rosterBrokerId,
      reason: "longterm_dispersed_b07",
      warning: "長工更分散多盤，推算唔到單一崗位盤（占比未過半），保守全部當長工更（B07），冇多畀雞頭錢，請人手覆核崗位盤",
    };
  }

  if (inPost) {
    // 2：喺生效崗位盤。
    return {
      settlementBrokerId: null, // caller 補 B07
      operationalBrokerId: input.rosterBrokerId,
      reason: "longterm_post",
      warning: null,
    };
  }

  // 4：有崗位但唔喺呢個盤——跟更表雞頭碼頂散更。
  return {
    settlementBrokerId: input.rosterBrokerId,
    operationalBrokerId: input.rosterBrokerId,
    reason: "longterm_non_post_broker",
    warning: input.rosterBrokerId ? "長工頂雞頭更：安員有登記崗位盤，但呢更唔喺崗位盤，跟更表雞頭碼幫雞頭頂散更" : null,
  };
}

/**
 * kind=internal_longterm 嘅結算單位（B07）——唔寫死 id／code，用 kind
 * 搵（同 settlement-broker-fallback.ts 一致做法）。全局淨係一個值，
 * caller 自己 memoize（reconcile.ts 逐次上載淨係查一次）。
 */
export async function findInternalLongtermBrokerId(client: PrismaLike = prisma): Promise<string | null> {
  const broker = await client.broker.findFirst({
    where: { kind: "internal_longterm", status: "active" },
    orderBy: { code: "asc" },
    select: { id: true },
  });
  return broker?.id ?? null;
}

/**
 * 攞一批安員生效中嘅崗位盤（`effectiveFrom<=asOf`、`effectiveTo` null 或
 * `>=asOf`、`voidedAt` null），摺埋母盤——回 guardId -> Set(siteId)
 * （子盤登記嘅唔會自動加母盤，母盤登記嘅唔會自動加子盤，摺埋嘅工作由
 * `resolveLongtermSettlement()` 呼叫方傳 `parentSiteId` 自己夾）。
 */
export async function loadActiveLongtermPosts(
  guardIds: string[],
  asOf: Date,
  client: PrismaLike = prisma,
  /** `excludeInferred`（名保留向下相容）：true＝淨係 `manual` 崗位（Postorder 生效月份用）。 */
  opts: { excludeInferred?: boolean } = {},
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  if (guardIds.length === 0) return result;
  const posts = await client.guardLongtermPost.findMany({
    where: {
      guardId: { in: guardIds },
      voidedAt: null,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: asOf } }],
      // 驗收（Opus 5.5）：本月 Postorder 生效（權威）就淨係睇 `manual` 崗位
      // （guard-fix `set_longterm_post` 由總表「(8) 長工」格寫、或者老闆人手
      // 加）——`inferred`（冇總表嗰陣嘅占比推算）同 `july_backfill`（7 月
      // 反推，正式站 migration 先有）都唔可以蓋過總表：dev 模擬「舊版先套用、
      // 後部署」實測，一位 7 月喺啟航1331 做長工、8 月總表冇佢長工格嘅安員，
      // 因為 july_backfill 崗位令 13 格錯歸 B07（少畀 K 11,440）。
      ...(opts.excludeInferred ? { source: "manual" as const } : {}),
    },
    select: { guardId: true, siteId: true, site: { select: { activityProxySiteId: true } } },
  });
  for (const p of posts) {
    const set = result.get(p.guardId) ?? new Set<string>();
    set.add(p.siteId);
    // 驗收（Opus 5.5）：崗位登記喺「構造盤」（例：數碼港 CP5 IC，純月費盤，
    // 自己冇 shift_records，`activity_proxy_site_id` 指住實際記更嘅
    // 數碼港 CP5）——佢喺 proxy 盤嘅更都係做緊自己崗位。8 月實測 13 格
    // 因為咁被當「唔喺崗位盤」跟咗更表雞頭碼（Y）。
    if (p.site.activityProxySiteId) set.add(p.site.activityProxySiteId);
    result.set(p.guardId, set);
  }
  return result;
}

/** 驗收（Opus 5.5）：呢個月嘅 Postorder 總表係咪已經「生效」——最新一份
 * 已解析嘅 Postorder 上載，而且已經有一個引用佢嘅安員配對修復計劃**套用
 * 咗**（`guard_fix_runs.status='applied'`，即係 `set_longterm_post` 等
 * 已經落 DB）。生效先以總表為準（見 `ResolveLongtermSettlementInput.
 * postorderAuthoritative`）；淨係上載咗未套用就唔當權威——否則長工崗位
 * 未寫入、推算又停咗，長工格會暫時全部跟更表雞頭碼（多畀雞頭錢）。 */
export async function hasParsedPostorderForMonth(month: Date, client: PrismaLike = prisma): Promise<boolean> {
  const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const latest = await client.postorderUpload.findFirst({ where: { month: monthStart, status: "parsed" }, orderBy: { uploadedAt: "desc" }, select: { id: true } });
  if (!latest) return false;
  const applied = await client.guardFixRun.findFirst({ where: { postorderUploadId: latest.id, status: "applied" }, select: { id: true } });
  return applied !== null;
}

/**
 * 保守預設嘅「本月占比」推算——攞呢批安員喺呢個月**全部**已上載更表行
 * （唔止單一張上載，因為長工可能同月喺唔同盤嘅上載都有出現），逐行摺埋
 * 母盤，計每個安員邊個（已摺母盤嘅）盤占佢當月總行數最高比例。
 *
 * 只計 `code_kind in (shift, ot)`（leave 唔算「喺邊度返工」，唔計入占比
 * 分母／分子——同 reconcile.ts 對數本身淨計 shift/ot/leave 三類唔同，
 * 呢度純粹係「邊個盤」嘅訊號，OFF/AL 呢類唔提供呢個訊號）。
 */
export async function inferGuardMonthlyTopSite(guardIds: string[], month: Date, client: PrismaLike = prisma): Promise<Map<string, { siteId: string; ratio: number }>> {
  const result = new Map<string, { siteId: string; ratio: number }>();
  if (guardIds.length === 0) return result;

  const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));

  const rows = await client.rosterUploadRow.findMany({
    where: {
      guardId: { in: guardIds },
      codeKind: { in: ["shift", "ot"] },
      workDate: { gte: monthStart, lte: monthEnd },
      upload: { voidedAt: null },
    },
    select: { guardId: true, resolvedSiteId: true, upload: { select: { siteId: true } } },
  });
  if (rows.length === 0) return result;

  const rawSiteIds = new Set<string>();
  for (const r of rows) {
    const sid = r.resolvedSiteId ?? r.upload.siteId;
    if (sid) rawSiteIds.add(sid);
  }
  const sites = rawSiteIds.size ? await client.site.findMany({ where: { id: { in: [...rawSiteIds] } }, select: { id: true, parentSiteId: true } }) : [];
  const parentBySite = new Map(sites.map((s) => [s.id, s.parentSiteId]));
  const foldToTop = (siteId: string): string => parentBySite.get(siteId) ?? siteId;

  const countsByGuard = new Map<string, Map<string, number>>();
  const totalByGuard = new Map<string, number>();
  for (const r of rows) {
    const sid = r.resolvedSiteId ?? r.upload.siteId;
    if (!sid || !r.guardId) continue;
    const folded = foldToTop(sid);
    const perSite = countsByGuard.get(r.guardId) ?? new Map<string, number>();
    perSite.set(folded, (perSite.get(folded) ?? 0) + 1);
    countsByGuard.set(r.guardId, perSite);
    totalByGuard.set(r.guardId, (totalByGuard.get(r.guardId) ?? 0) + 1);
  }

  for (const [guardId, perSite] of countsByGuard) {
    const total = totalByGuard.get(guardId) ?? 0;
    if (total === 0) continue;
    let topSiteId: string | null = null;
    let topCount = -1;
    // 穩定 tie-break：count 一樣就揀 siteId 字典序最細嗰個，唔留俾
    // Map 遍歷次序隨機決定。
    for (const [siteId, count] of [...perSite.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (count > topCount) {
        topCount = count;
        topSiteId = siteId;
      }
    }
    if (topSiteId) result.set(guardId, { siteId: topSiteId, ratio: topCount / total });
  }

  return result;
}
