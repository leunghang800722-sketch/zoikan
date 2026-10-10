import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { scrubRowForResource, scrubRowsForResource } from "../field-scrub";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson, withFeeSplit, FEE_SPLIT_NOTE } from "./common";

// 基本存取要「出街價:view」（規劃裁定——rate_cards 呢個資源喺一般 REST
// API 都係掛「出街價」做基本 module，「收客價」淨係做 field-level
// gate，見 docs/api.md 「價目」一行）；`client_rate` 呢粒數另外由
// field-group gate 決定見唔見得到。
export function createRateCardsTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "rate_cards",
    description:
      "查價目卡——收客價（要「收客價」查閱權）／出街價（保安員工資＋雞頭費）＋生效日期。回傳帶 broker_display_name（雞頭顯示名，答用戶嗰陣一律用呢個，唔准用 broker_code）同 fee_split（\"combined\"=呢個盤未拆開工資/雞頭費，只有合計數，唔准話雞頭費係 0）。可以用 site/broker/guard 名稱篩選。要「出街價:view」（基本存取）。",
    inputSchema: z
      .object({
        site: z.string().optional().describe("盤名稱關鍵字"),
        broker_code: z.string().optional().describe("雞頭代號"),
        guard_name: z.string().optional().describe("保安員姓名關鍵字"),
      })
      .strict(),
    run: async ({ site, broker_code, guard_name }) => {
      const denied = await requireModuleOrDenied(ctx, "出街價");
      if (denied) return deniedResult(denied);

      const conditions: string[] = ["rc.voided_at IS NULL"];
      const params: unknown[] = [];
      if (site) {
        params.push(`%${site}%`);
        conditions.push(`s.canonical_name ILIKE $${params.length}`);
      }
      if (broker_code) {
        params.push(broker_code);
        conditions.push(`b.code = $${params.length}`);
      }
      if (guard_name) {
        params.push(`%${guard_name}%`);
        conditions.push(`g.name_zh ILIKE $${params.length}`);
      }

      const { rows } = await aiQuery(
        `SELECT rc.id, s.canonical_name AS site_name, st.code AS shift_type_code,
                b.code AS broker_code, b.name AS broker_name, b.kind AS broker_kind, g.name_zh AS guard_name,
                rc.client_rate, rc.guard_wage, rc.broker_fee, rc.payout_rate, rc.billing_model,
                rc.effective_from, rc.effective_to, rc.note
         FROM ai.rate_cards rc
         LEFT JOIN ai.sites s ON s.id = rc.site_id
         LEFT JOIN ai.shift_types st ON st.id = rc.shift_type_id
         LEFT JOIN ai.brokers b ON b.id = rc.broker_id
         LEFT JOIN ai.guards g ON g.id = rc.guard_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY rc.effective_from DESC
         LIMIT 200`,
        params,
      );

      // 老闆 feedback（正式站助手）：答案唔准出現 broker_code 呢類內部
      // 代號——逐張卡加一個 `broker_display_name`（業務用語／真名，見
      // `brokerDisplayName()`），同 `fee_split`／`fee_split_note`（真數據
      // 查證：部分盤啲卡源頭冇拆開保安員工資／雞頭費，`broker_fee`=0
      // 唔係「真係 0」）。呢兩層要喺 scrub 之前計（`fee_split` 本身唔係
      // 錢銀數值，唔受收客價/出街價 gate 影響；但要用返 raw row 嘅
      // guard_wage/broker_fee/payout_rate 先計得啱）。
      const withDisplay = rows.map((r) =>
        withFeeSplit(r, { name: r.broker_name, code: r.broker_code, kind: r.broker_kind }, { guardWage: r.guard_wage, brokerFee: r.broker_fee, payoutRate: r.payout_rate }),
      );

      const scrubbed = scrubRowsForResource(withDisplay, "rate_cards", ctx.fieldVisibility);
      return toolResultJson({ count: scrubbed.length, rate_cards: scrubbed });
    },
  });
}

export function createExplainRateCardTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "explain_rate_card",
    description:
      "解釋一張價目卡點計出嚟——用卡本身嘅欄位＋呢張卡生效期內嘅實際更次數做例子（例如「保安員工資＋雞頭費」點加埋做出街價）。`explanation` 已經用業務用語砌好，答用戶嗰陣直接用/改寫，唔准自己加返英文欄位名。要「出街價:view」。",
    inputSchema: z.object({ rate_card_id: z.string().describe("rate_cards.id") }).strict(),
    run: async ({ rate_card_id }) => {
      const denied = await requireModuleOrDenied(ctx, "出街價");
      if (denied) return deniedResult(denied);

      const { rows } = await aiQuery(
        `SELECT rc.*, s.canonical_name AS site_name, st.code AS shift_type_code,
                b.code AS broker_code, b.name AS broker_name, b.kind AS broker_kind, g.name_zh AS guard_name
         FROM ai.rate_cards rc
         LEFT JOIN ai.sites s ON s.id = rc.site_id
         LEFT JOIN ai.shift_types st ON st.id = rc.shift_type_id
         LEFT JOIN ai.brokers b ON b.id = rc.broker_id
         LEFT JOIN ai.guards g ON g.id = rc.guard_id
         WHERE rc.id = $1
         LIMIT 1`,
        [rate_card_id],
      );
      if (rows.length === 0) return toolResultJson({ error: "not_found", message: "搵唔到呢張價目卡" });

      const raw = rows[0];
      const withDisplay = withFeeSplit(
        raw,
        { name: raw.broker_name, code: raw.broker_code, kind: raw.broker_kind },
        { guardWage: raw.guard_wage, brokerFee: raw.broker_fee, payoutRate: raw.payout_rate },
      );
      const feeSplit = withDisplay.fee_split;
      const card = scrubRowForResource(withDisplay, "rate_cards", ctx.fieldVisibility);

      // 老闆 feedback（正式站助手）：呢個 `explanation` 之前直接寫死
      // 英文欄位名（`payout_rate`／`guard_wage`／`broker_fee`）落去段文字
      // 度，模型照抄晒落最終回覆——而家全部改用業務用語（收客價/出街價/
      // 保安員工資/雞頭費），數值用 `$` 開頭。
      const explanation: string[] = [];
      if (card.client_rate !== undefined) explanation.push(`收客價：$${card.client_rate}`);
      if (feeSplit === "combined") {
        explanation.push(`出街價（合計）：$${card.payout_rate}——${FEE_SPLIT_NOTE}`);
      } else if (card.guard_wage !== undefined && card.broker_fee !== undefined) {
        explanation.push(`出街價：保安員工資 $${card.guard_wage} + 雞頭費 $${card.broker_fee} = $${card.payout_rate}`);
      } else if (card.payout_rate !== undefined) {
        explanation.push(`出街價：$${card.payout_rate}`);
      }

      const monthSample = (
        await aiQuery(
          `SELECT COUNT(*) AS shifts, MIN(work_date) AS first_date, MAX(work_date) AS last_date
           FROM ai.shift_records
           WHERE shift_type_id = $1 AND work_date >= $2::date AND ($3::date IS NULL OR work_date <= $3::date)`,
          [card.shift_type_id, card.effective_from, card.effective_to ?? null],
        )
      ).rows[0];

      return toolResultJson({ rate_card: card, explanation, shift_sample_in_effect_range: monthSample });
    },
  });
}
