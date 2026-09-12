import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { scrubRowForResource, scrubRowsForResource } from "../field-scrub";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

// 基本存取要「出街價:view」（規劃裁定——rate_cards 呢個資源喺一般 REST
// API 都係掛「出街價」做基本 module，「收客價」淨係做 field-level
// gate，見 docs/api.md 「價目」一行）；`client_rate` 呢粒數另外由
// field-group gate 決定見唔見得到。
export function createRateCardsTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "rate_cards",
    description:
      "查價目卡（rate_cards）——收客價（client_rate，要「收客價」查閱權）／出街價（guard_wage/broker_fee/payout_rate）＋生效日期。可以用 site/broker/guard 名稱篩選。要「出街價:view」（基本存取）。",
    inputSchema: z
      .object({
        site: z.string().optional().describe("盤名稱關鍵字"),
        broker_code: z.string().optional().describe("雞頭代號"),
        guard_name: z.string().optional().describe("安員姓名關鍵字"),
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
        `SELECT rc.id, s.canonical_name AS site_name, st.code AS shift_type_code, b.code AS broker_code, g.name_zh AS guard_name,
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

      const scrubbed = scrubRowsForResource(rows, "rate_cards", ctx.fieldVisibility);
      return toolResultJson({ count: scrubbed.length, rate_cards: scrubbed });
    },
  });
}

export function createExplainRateCardTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "explain_rate_card",
    description: "解釋一張價目卡點計出嚟——用卡本身嘅欄位＋呢張卡生效期內嘅實際更次數做例子（例如「工資＋雞頭費」點加埋做出街價）。要「出街價:view」。",
    inputSchema: z.object({ rate_card_id: z.string().describe("rate_cards.id") }).strict(),
    run: async ({ rate_card_id }) => {
      const denied = await requireModuleOrDenied(ctx, "出街價");
      if (denied) return deniedResult(denied);

      const { rows } = await aiQuery(
        `SELECT rc.*, s.canonical_name AS site_name, st.code AS shift_type_code, b.code AS broker_code, g.name_zh AS guard_name
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

      const card = scrubRowForResource(rows[0], "rate_cards", ctx.fieldVisibility);

      const explanation: string[] = [];
      if (card.client_rate !== undefined) explanation.push(`收客價 client_rate = ${card.client_rate}`);
      if (card.guard_wage !== undefined && card.broker_fee !== undefined) {
        explanation.push(`出街價 payout_rate = 工資 guard_wage(${card.guard_wage}) + 雞頭費 broker_fee(${card.broker_fee}) = ${card.payout_rate}`);
      } else if (card.payout_rate !== undefined) {
        explanation.push(`出街價 payout_rate = ${card.payout_rate}（呢張卡冇拆開 guard_wage/broker_fee 兩截）`);
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
