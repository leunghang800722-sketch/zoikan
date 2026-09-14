import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { round2 } from "@/lib/reports/money";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson, brokerDisplayName, feeSplitStatus, FEE_SPLIT_NOTE, LONGTERM_PAYOUT_NOTE } from "./common";

const monthParam = z.string().regex(/^\d{4}-\d{2}$/, "月份格式要係 YYYY-MM");

// 要「更表:view」（規劃裁定：呢個工具本質係逐雞頭嘅更次統計，同
// roster/site_overview 一致）。
export function createBrokerStatsTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "broker_stats",
    description:
      "睇雞頭喺某個月嘅更次統計——幾多更、幾多安員、（有出街價權限先見到）出街價合計。回傳帶 broker_display_name（雞頭顯示名，答用戶一律用呢個，唔准用 broker_code）；有啲盤啲卡源頭冇拆開保安員工資/雞頭費，呢啲雞頭嘅 fee_split=\"combined\"，broker_fee_total 會係 null（唔係 0，唔准話雞頭費係 0，只可以講出街價合計）；公司長工（internal_longterm）桶嘅 payout_total 一律 null＋payout_note（月薪唔計逐更出街價，唔准答出街價 0）。仲帶 latest_month_with_data（呢個盤/全公司最近有記錄嘅月份）——查嗰個月冇數就可以用嚟自動退一步答（唔使再問用戶）。可選 site 篩選淨係睇某個盤。**可選 broker（雞頭名／代號關鍵字）淨係睇一個雞頭，同時回傳 sites（呢個雞頭嗰個月逐盤嘅更數／保安員數，按更數排）＋site_count——用戶問「某個雞頭派咗邊幾個盤」「佢啲更分布喺邊幾個盤」「邊個盤最多」，或者上一輪問完某個雞頭之後跟住問「有邊幾個盤」，一律用呢個帶 broker 嘅查法，唔好用 list_sites（嗰個係全公司盤名單）。要「更表:view」。",
    inputSchema: z
      .object({
        site: z.string().optional().describe("盤名稱（可選，唔填即全公司）"),
        broker: z.string().optional().describe("雞頭名／代號關鍵字（可選）——填咗就淨係回呢個雞頭，並帶 sites 逐盤分佈；用戶講「阿淦」呢類暱稱，填「淦」"),
        month: monthParam,
      })
      .strict(),
    run: async ({ site, broker, month }) => {
      const denied = await requireModuleOrDenied(ctx, "更表");
      if (denied) return deniedResult(denied);

      const monthStart = `${month}-01`;
      const params: unknown[] = [monthStart];
      let siteFilter = "";
      if (site) {
        const siteRows = (await aiQuery(`SELECT id FROM ai.sites WHERE canonical_name ILIKE $1 OR $1 = ANY(aliases) LIMIT 1`, [`%${site}%`])).rows;
        if (siteRows.length === 0) {
          return toolResultJson({ error: "not_found", message: `搵唔到名稱包含「${site}」嘅盤` });
        }
        params.push(siteRows[0].id);
        siteFilter = `AND sr.site_id = $${params.length}`;
      }
      // 雞頭篩選：用戶口語「阿淦」→ 去掉開頭「阿」再對 name／code（ILIKE 包含）
      let brokerFilter = "";
      let brokerKeyword: string | null = null;
      if (broker && broker.trim()) {
        brokerKeyword = broker.trim().replace(/^阿/, "");
        params.push(`%${brokerKeyword}%`);
        brokerFilter = `AND (b.name ILIKE $${params.length} OR b.code ILIKE $${params.length})`;
      }
      const siteIdParam = site ? params[1] : null; // params[1] = 上面搵到嘅 site id（params[0] 係 monthStart）

      const { rows } = await aiQuery(
        `SELECT b.id AS broker_id, b.code AS broker_code, b.name AS broker_name, b.kind,
                COUNT(*) FILTER (WHERE sr.record_type = 'shift') AS shift_count,
                COUNT(DISTINCT sr.guard_id) AS guard_count,
                SUM(COALESCE(sr.guard_wage_snapshot, 0)) AS guard_wage_total,
                SUM(COALESCE(sr.broker_fee_snapshot, 0)) AS broker_fee_total_raw,
                SUM(COALESCE(sr.guard_wage_snapshot, 0) + COALESCE(sr.broker_fee_snapshot, 0)) AS payout_total
         FROM ai.shift_records sr
         JOIN ai.brokers b ON b.id = COALESCE(sr.operational_broker_id, sr.settlement_broker_id)
         WHERE sr.work_date >= $1::date AND sr.work_date < ($1::date + INTERVAL '1 month') ${siteFilter} ${brokerFilter}
         GROUP BY b.id, b.code, b.name, b.kind
         ORDER BY shift_count DESC
         LIMIT 200`,
        params,
      );

      // 老闆 feedback（正式站助手，真數據查證：部分盤啲卡源頭係總表
      // 外判價／糧單合計，冇拆開保安員工資／雞頭費）——逐雞頭判斷
      // fee_split：`broker_fee_total_raw`（呢個月呢個雞頭全部更次嘅
      // 雞頭費 snapshot 加埋）為 0 且 `payout_total`≈`guard_wage_total`
      // 就當「未拆」，`broker_fee_total` 要顯示 `null`（唔准顯示 0，
      // 免得用戶以為雞頭費真係 0）。`broker_display_name`／`broker_code`
      // 之前淨係俾內部代號，模型照抄晒落最終回覆——而家加返業務用語／
      // 真名，`broker_code` 保留做技術參考，但答用戶一律用
      // `broker_display_name`（system prompt 已經明文要求）。
      const shaped = rows.map((r) => {
        // 老闆 feedback：月薪長工（internal_longterm，「公司長工」桶）
        // 唔係逐更出街價——`shift_records` 嘅 guard_wage_snapshot／
        // broker_fee_snapshot 對呢桶通常淨係 0（薪金唔係逐更 snapshot
        // 落嚟，係月薪分攤，喺毛利即時表果邊計），之前呢度將呢個 0
        // 當「未拆」一齊回，模型會答「出街價 0」——而家獨立處理：呢桶
        // 嘅 payout_total／guard_wage_total／broker_fee_total 一律
        // null，用 `payout_note` 講明係月薪唔計逐更出街價，唔再套用
        // fee_split 嗰套「未拆」邏輯（兩種係唔同嘅原因）。
        const isInternalLongterm = r.kind === "internal_longterm";
        const feeSplit = feeSplitStatus({ guardWage: r.guard_wage_total, brokerFee: r.broker_fee_total_raw, payoutRate: r.payout_total });
        const out: Record<string, unknown> = {
          broker_id: r.broker_id,
          broker_code: r.broker_code,
          broker_display_name: brokerDisplayName({ name: r.broker_name, code: r.broker_code, kind: r.kind }),
          shift_count: r.shift_count,
          guard_count: r.guard_count,
          fee_split: isInternalLongterm ? null : feeSplit,
          fee_split_note: !isInternalLongterm && feeSplit === "combined" ? FEE_SPLIT_NOTE : null,
          payout_note: isInternalLongterm ? LONGTERM_PAYOUT_NOTE : null,
        };
        if (ctx.fieldVisibility.settlementVisible) {
          out.payout_total = isInternalLongterm ? null : r.payout_total;
          out.guard_wage_total = isInternalLongterm ? null : r.guard_wage_total;
          out.broker_fee_total = isInternalLongterm ? null : feeSplit === "combined" ? null : r.broker_fee_total_raw;
        }
        return out;
      });

      // 系統計嘅總計——`pg` driver 對 COUNT()/SUM() 呢類 bigint/numeric
      // 欄預設會用字串返（避免大數精度損失），逐個工具自己加總嗰陣要
      // 手動 `Number()` 轉返做數字先可以相加。`guard_count` 唔可以直接
      // 逐 broker 相加（同一個安員同月可能跨兩個雞頭做過嘢會計多），
      // 所以另外用 `COUNT(DISTINCT sr.guard_id)`（冇 GROUP BY broker）
      // 查一次去重總數。
      const totalShiftCount = rows.reduce((sum, r) => sum + Number(r.shift_count), 0);
      // 老闆 feedback：total 嘅 payout_total／broker_fee_total 淨係加
      // 返「真係逐更出街價」嘅雞頭（唔包 internal_longterm 月薪長工果
      // 桶——嗰桶嘅 snapshot 通常係 0，唔應該當一個「已拆開/未拆開」嘅
      // 真實出街價計落個總計度）。
      const payoutRows = rows.filter((r) => r.kind !== "internal_longterm");
      const totalPayout = ctx.fieldVisibility.settlementVisible ? round2(payoutRows.reduce((sum, r) => sum + Number(r.payout_total ?? 0), 0)) : undefined;
      // 全公司總計嘅 broker_fee_total：如果*任何*（會逐更計出街價嘅）
      // 雞頭係 combined，總計都要跟住變 null（唔可以齋加返有拆開嗰幾個
      // 雞頭嘅數，扮晒齊，令用戶以為個總數已經包晒）。
      const anyCombined = payoutRows.some((r) => feeSplitStatus({ guardWage: r.guard_wage_total, brokerFee: r.broker_fee_total_raw, payoutRate: r.payout_total }) === "combined");
      const totalBrokerFee =
        ctx.fieldVisibility.settlementVisible && !anyCombined ? round2(payoutRows.reduce((sum, r) => sum + Number(r.broker_fee_total_raw ?? 0), 0)) : undefined;
      const { rows: guardTotalRows } = await aiQuery(
        `SELECT COUNT(DISTINCT sr.guard_id) AS guard_count
         FROM ai.shift_records sr
         JOIN ai.brokers b ON b.id = COALESCE(sr.operational_broker_id, sr.settlement_broker_id)
         WHERE sr.work_date >= $1::date AND sr.work_date < ($1::date + INTERVAL '1 month') ${siteFilter} ${brokerFilter}`,
        params,
      );
      const totalGuardCount = Number((guardTotalRows[0] as { guard_count?: unknown } | undefined)?.guard_count ?? 0);

      // 老闆 feedback：空月份自動退一步——呢個盤（或者全公司，冇 site
      // 篩選嗰陣）最近一個有 shift_records 嘅月份，等模型喺 `month`
      // 冇數據嗰陣可以自己退一步答（system prompt 已經加咗對應規則），
      // 唔使再多問一輪。
      const latestMonthParams: unknown[] = [];
      let latestMonthSiteFilter = "";
      if (site) {
        latestMonthParams.push(siteIdParam);
        latestMonthSiteFilter = `AND sr.site_id = $${latestMonthParams.length}`;
      }
      if (brokerKeyword !== null) {
        latestMonthParams.push(`%${brokerKeyword}%`);
        latestMonthSiteFilter += ` AND (b.name ILIKE $${latestMonthParams.length} OR b.code ILIKE $${latestMonthParams.length})`;
      }
      const { rows: latestMonthRows } = await aiQuery(
        `SELECT to_char(MAX(sr.work_date), 'YYYY-MM') AS latest_month
         FROM ai.shift_records sr
         JOIN ai.brokers b ON b.id = COALESCE(sr.operational_broker_id, sr.settlement_broker_id)
         WHERE 1=1 ${latestMonthSiteFilter}`,
        latestMonthParams,
      );
      const latestMonthWithData = (latestMonthRows[0] as { latest_month?: string | null } | undefined)?.latest_month ?? null;

      // 雞頭篩選時：逐盤分佈（答「派咗邊幾個盤」「邊個盤最多」用），
      // 按更數排，最多 200 個盤；出街價合計淨係有結算權限先帶。
      let sitesBreakdown: Record<string, unknown>[] | undefined;
      if (brokerKeyword !== null) {
        const siteParams: unknown[] = [monthStart, `%${brokerKeyword}%`];
        let siteScope = "";
        if (siteIdParam) {
          siteParams.push(siteIdParam);
          siteScope = `AND sr.site_id = $${siteParams.length}`;
        }
        const { rows: siteRows } = await aiQuery(
          `SELECT s.canonical_name AS site_name,
                  COUNT(*) FILTER (WHERE sr.record_type = 'shift') AS shift_count,
                  COUNT(DISTINCT sr.guard_id) AS guard_count,
                  SUM(COALESCE(sr.guard_wage_snapshot, 0) + COALESCE(sr.broker_fee_snapshot, 0)) AS payout_total
           FROM ai.shift_records sr
           JOIN ai.brokers b ON b.id = COALESCE(sr.operational_broker_id, sr.settlement_broker_id)
           JOIN ai.sites s ON s.id = sr.site_id
           WHERE sr.work_date >= $1::date AND sr.work_date < ($1::date + INTERVAL '1 month')
             AND (b.name ILIKE $2 OR b.code ILIKE $2) ${siteScope}
           GROUP BY s.id, s.canonical_name
           ORDER BY shift_count DESC, s.canonical_name
           LIMIT 200`,
          siteParams,
        );
        sitesBreakdown = siteRows.map((r) => {
          const row: Record<string, unknown> = { site_name: r.site_name, shift_count: r.shift_count, guard_count: r.guard_count };
          if (ctx.fieldVisibility.settlementVisible) row.payout_total = r.payout_total;
          return row;
        });
      }
      return toolResultJson({
        month,
        site: site ?? null,
        broker: brokerKeyword,
        ...(sitesBreakdown !== undefined
          ? {
              site_count: sitesBreakdown.length,
              sites: sitesBreakdown,
              sites_note: "sites 係呢個雞頭喺呢個月逐盤嘅更數分佈（已按更數排，shift_count 全部加埋＝totals.shift_count），答「派咗邊幾個盤」直接用呢個列表，唔使再查盤名單。",
            }
          : {}),
        brokers: shaped,
        latest_month_with_data: latestMonthWithData,
        totals: {
          shift_count: totalShiftCount,
          guard_count: totalGuardCount,
          payout_total: totalPayout,
          broker_fee_total: ctx.fieldVisibility.settlementVisible ? (anyCombined ? null : totalBrokerFee) : undefined,
        },
        totals_note: anyCombined
          ? "totals 已由系統計（guard_count 已去重，唔包公司長工月薪桶），唔好自己加總；部分雞頭嘅盤未拆開保安員工資/雞頭費，broker_fee_total 顯示 null，唔係 0——只可以答出街價合計（payout_total）。"
          : "totals 已由系統計（guard_count 已去重，唔包公司長工月薪桶），唔好自己加總。",
      });
    },
  });
}
