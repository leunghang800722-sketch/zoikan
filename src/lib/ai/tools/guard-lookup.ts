import { z } from "zod";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { aiQuery } from "../db";
import { scrubRowsForResource } from "../field-scrub";
import type { AiToolContext } from "./common";
import { requireModuleOrDenied, deniedResult, toolResultJson } from "./common";

// 要「保安員:view」（規劃裁定）。
export function createGuardLookupTool(ctx: AiToolContext) {
  return betaZodTool({
    name: "guard_lookup",
    description:
      "用姓名或工號搵保安員資料：姓名、工號、人卡 id、僱傭類型、月薪、入職日／離職日、牌照／平安卡到期、緊急聯絡人姓名、別名、黑名單查核日期，以及工號卡（體系／號碼／狀態／有效期／結束原因）同長工合約段（有「長工糧:view」先有）。唔會回身份證、出生日期、住址、銀行資料同任何電話（呢個系統嘅 AI 助手一律唔接觸）。要「保安員:view」。",
    inputSchema: z.object({ query: z.string().describe("姓名（中/英）、別名或工號關鍵字") }).strict(),
    run: async ({ query }) => {
      const denied = await requireModuleOrDenied(ctx, "安員");
      if (denied) return deniedResult(denied);

      const { rows } = await aiQuery(
        `SELECT g.id, g.staff_no, g.staff_no_mw, g.name_zh, g.name_en, g.name_aliases, g.employment_type, g.monthly_salary,
                g.hire_date, g.leave_date, g.probation_months, g.status,
                g.sia_permit_expiry, g.sia_permit_a_expiry, g.sia_permit_b_expiry, g.safety_card_expiry, g.qas_expiry_date,
                g.emergency_contact_name, g.blacklist_check_date,
                b.code AS default_broker_code, b.name AS default_broker_name
         FROM ai.guards g
         LEFT JOIN ai.brokers b ON b.id = g.default_broker_id
         WHERE g.name_zh ILIKE $1 OR g.name_en ILIKE $1 OR g.staff_no ILIKE $1 OR g.staff_no_mw ILIKE $1
            ${ctx.fieldVisibility.guardPiiVisible ? "OR EXISTS (SELECT 1 FROM unnest(g.name_aliases) a WHERE a ILIKE $1)" : ""}
            OR EXISTS (SELECT 1 FROM ai.guard_staff_numbers n WHERE n.guard_id = g.id AND n.number ILIKE $1)
         ORDER BY g.name_zh
         LIMIT 50`,
        [`%${query}%`],
      );

      const scrubbed = scrubRowsForResource(rows, "guards", ctx.fieldVisibility);
      const ids = scrubbed.map((r) => String((r as { id: unknown }).id));
      let cardsBy = new Map<string, unknown[]>();
      let contractsBy = new Map<string, unknown[]>();
      if (ids.length) {
        const cards = await aiQuery(
          `SELECT guard_id, id, scheme, number, status, valid_from, valid_to, end_reason, predecessor_id
           FROM ai.guard_staff_numbers WHERE guard_id = ANY($1::text[]) ORDER BY guard_id, scheme, valid_from NULLS FIRST, number`,
          [ids],
        );
        cardsBy = groupBy(cards.rows as Array<Record<string, unknown>>);
        // 長工合約段（月薪）要「長工糧:view」；冇權就唔回（人卡 monthly_salary 照舊跟 guards view）
        const ltDenied = await requireModuleOrDenied(ctx, "長工糧");
        if (!ltDenied) {
          const contracts = await aiQuery(
            `SELECT guard_id, id, effective_from, effective_to, monthly_salary, pay_basis, daily_rate, probation_months, annual_leave_days
             FROM ai.guard_longterm_contracts WHERE guard_id = ANY($1::text[]) AND voided_at IS NULL ORDER BY guard_id, effective_from`,
            [ids],
          );
          // 月薪／日薪屬「出街價（settlement）」組：冇權就剝（同 guards.monthly_salary 一致）
          contractsBy = groupBy(contracts.rows as Array<Record<string, unknown>>, ctx.fieldVisibility.settlementVisible ? [] : SETTLEMENT_CONTRACT_FIELDS);
        }
      }
      const guards = scrubbed.map((r) => {
        const id = String((r as { id: unknown }).id);
        return { ...r, staff_number_cards: cardsBy.get(id) ?? [], longterm_contracts: contractsBy.get(id) ?? [] };
      });
      return toolResultJson({ count: guards.length, guards });
    },
  });
}

const SETTLEMENT_CONTRACT_FIELDS = ["monthly_salary", "daily_rate"];

function groupBy(rows: Array<Record<string, unknown>>, drop: readonly string[] = []): Map<string, unknown[]> {
  const m = new Map<string, unknown[]>();
  for (const r of rows) {
    const { guard_id, ...rest0 } = r;
    const rest: Record<string, unknown> = { ...rest0 };
    for (const k of drop) delete rest[k];
    const k = String(guard_id);
    (m.get(k) ?? m.set(k, []).get(k)!).push(rest);
  }
  return m;
}
