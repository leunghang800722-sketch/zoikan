// WP-ONE-CLICK-AUTO（§31.2／§31.3 E）：`POST /api/month-close/one-click/:id/undo-auto`——
// 一鍵還原呢個 run 所有 `auto` 改動（按 month_close_auto_changes 流水帳倒序）：
//   price_snapshots   補咗嘅價 → 按 journal 逐更還原舊值（淨係當前值仍然等於 journal 記低嘅自動填入值先還原，之後人手改過嘅唔郁；唔做值相等掃描）
//   rate_card_created 價卡作廢（void）
//   settlement_set    結算雞頭還原（同上，當前值仍然係自動歸屬嗰個先還原）
//   guard_staffno_added／guard_alias_added  自動配對還原（移除登記嘅工號／別名）
//   shift_type_created 更種作廢（冇更次用緊先准）
//   site_alias        盤別名移除
//   site_created      盤保留（有更種／更次／上載掛住，唔會刪盤）
// 已鎖月份唔准還原（0 變）。全部 audit，`auto_source=undo:one-click:<runId>`。冪等：已還原嘅唔再做。
import { prisma } from "@/lib/db";
import { writeAudit } from "@/lib/audit";
import { Conflict, NotFound } from "@/lib/api/errors";
import { sameRepriceValue, numOrNull } from "@/lib/pricing/reprice";
import { syncLegacyStaffNoColumns } from "@/lib/guards/staff-numbers";

export interface UndoAutoResult {
  runId: string;
  undone: Record<string, number>;
  skipped: Array<{ kind: string; summary: string; reason: string }>;
  alreadyUndone: boolean;
  supersededQuestions: number;
  /** N4：undo 之後仍然帶住被作廢 auto 卡價錢嘅更數（journal 完整時應該係 0）。 */
  stillUsingVoidedCardPrices: number;
}

export async function undoAutoChanges(runId: string, actorUserId: string, ip: string | null): Promise<UndoAutoResult> {
  const run = await prisma.monthCloseRun.findUnique({ where: { id: runId } });
  if (!run) throw NotFound("搵唔到呢個一鍵結算 run");
  if (run.status === "running") throw Conflict("呢個 run 仍然執行緊，等佢完成先可以還原", { status: "running" });
  const locked = await prisma.monthClose.findUnique({ where: { month: run.month } });
  if (locked?.lockedAt) throw Conflict("本月已鎖定，唔可以還原自動改動（要改先由老闆解鎖）", { status: "locked" });

  const changes = await prisma.monthCloseAutoChange.findMany({ where: { runId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const pending = changes.filter((c) => c.status === "applied" && c.undoable);
  const result: UndoAutoResult = { runId, undone: {}, skipped: [], alreadyUndone: pending.length === 0 && changes.some((c) => c.status === "undone"), supersededQuestions: 0, stillUsingVoidedCardPrices: 0 };
  const source = `undo:one-click:${runId}`;
  const audit = (tableName: string, rowId: string, action: "update" | "void" | "delete", before: unknown, after: unknown) =>
    writeAudit({ actorUserId, tableName, rowId, action, before, after: after && typeof after === "object" ? { ...(after as Record<string, unknown>), auto_source: source } : { auto_source: source }, ip });
  const mark = async (id: string, status: "undone" | "undo_skipped", note: string | null) => {
    await prisma.monthCloseAutoChange.update({ where: { id }, data: { status, undoNote: note, undoneAt: new Date(), undoneBy: actorUserId } });
  };
  const bump = (k: string, n = 1) => {
    result.undone[k] = (result.undone[k] ?? 0) + n;
  };
  const skip = async (c: (typeof changes)[number], reason: string) => {
    result.skipped.push({ kind: c.kind, summary: c.summary, reason });
    await mark(c.id, "undo_skipped", reason);
  };

  // 倒序（最後做嘅最先還原）：createdAt desc
  for (const c of pending) {
    // 並發 undo：逐項 claim（undoNote null → 'undoing'），兩個請求唔會還原同一項兩次；失敗退回。
    const claim = await prisma.monthCloseAutoChange.updateMany({ where: { id: c.id, status: "applied", undoNote: null }, data: { undoNote: "undoing" } });
    if (claim.count !== 1) continue;
    try {
    await undoOne(c);
    } catch (e) {
      await prisma.monthCloseAutoChange.updateMany({ where: { id: c.id, status: "applied", undoNote: "undoing" }, data: { undoNote: null } });
      throw e;
    }
  }
  async function undoOne(c: (typeof changes)[number]): Promise<void> {
    const d = c.detailJson as Record<string, unknown>;
    switch (c.kind) {
      case "price_snapshots": {
        const rows = (d.rows as Array<{ id: string; fields?: string[]; before: [number | null, number | null, number | null]; after: [number | null, number | null, number | null] }>) ?? [];
        let restored = 0;
        for (const r of rows) {
          const cur = await prisma.shiftRecord.findUnique({ where: { id: r.id }, select: { clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true } });
          if (!cur) continue;
          // 逐欄還原（N2）：淨係 journal `fields` 列出嘅欄，而且現值仍然等於當時填入值先還原。
          const fields = r.fields && r.fields.length > 0 ? r.fields : ["client", "payout"];
          const data: { clientRateSnapshot?: number | null; guardWageSnapshot?: number | null; brokerFeeSnapshot?: number | null } = {};
          if (fields.includes("client") && sameRepriceValue(numOrNull(cur.clientRateSnapshot), r.after[0])) data.clientRateSnapshot = r.before[0];
          if (fields.includes("payout") && sameRepriceValue(numOrNull(cur.guardWageSnapshot), r.after[1]) && sameRepriceValue(numOrNull(cur.brokerFeeSnapshot), r.after[2])) {
            data.guardWageSnapshot = r.before[1];
            data.brokerFeeSnapshot = r.before[2];
          }
          if (Object.keys(data).length === 0) continue; // 之後被人手改過，唔郁
          await prisma.shiftRecord.update({ where: { id: r.id }, data });
          restored++;
        }
        if (restored > 0) await audit("shift_records", `undo_price:${c.refId ?? c.id}`, "update", { rows: rows.length }, { restored, card_id: c.refId });
        bump("price_snapshots", restored);
        await mark(c.id, "undone", rows.length !== restored ? `${rows.length - restored} 更之後被改過，保留` : null);
        break;
      }
      case "rate_card_created": {
        const card = await prisma.rateCard.findUnique({ where: { id: c.refId ?? "" } });
        if (!card || card.voidedAt) {
          await mark(c.id, "undone", "價卡已作廢或者唔存在");
          break;
        }
        const after = await prisma.rateCard.update({ where: { id: card.id }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
        await audit("rate_cards", card.id, "void", card, { ...after, void_reason: source });
        bump("rate_cards");
        await mark(c.id, "undone", null);
        break;
      }
      case "settlement_set": {
        const rows = (d.rows as Array<{ id: string; beforeSettlement: string | null; beforeOperational: string | null; afterOperational: string | null }>) ?? [];
        const brokerId = d.brokerId as string;
        let restored = 0;
        for (const r of rows) {
          const cur = await prisma.shiftRecord.findUnique({ where: { id: r.id }, select: { settlementBrokerId: true, operationalBrokerId: true } });
          if (!cur || cur.settlementBrokerId !== brokerId) continue;
          await prisma.shiftRecord.update({ where: { id: r.id }, data: { settlementBrokerId: r.beforeSettlement, operationalBrokerId: cur.operationalBrokerId === r.afterOperational ? r.beforeOperational : cur.operationalBrokerId } });
          restored++;
        }
        if (restored > 0) await audit("shift_records", `undo_settlement:${c.id}`, "update", { rows: rows.length }, { restored });
        bump("settlement", restored);
        await mark(c.id, "undone", rows.length !== restored ? `${rows.length - restored} 更之後被改過，保留` : null);
        break;
      }
      case "guard_staffno_added": {
        const sn = await prisma.guardStaffNumber.findUnique({ where: { id: (d.staffNumberId as string) ?? "" } });
        if (!sn) {
          await mark(c.id, "undone", "工號登記已唔存在");
          break;
        }
        await prisma.$transaction(async (tx) => {
          await tx.guardStaffNumber.delete({ where: { id: sn.id } });
          await syncLegacyStaffNoColumns(tx, sn.guardId);
        });
        await audit("guard_staff_numbers", sn.id, "delete", { id: sn.id }, null);
        bump("guard_staff_numbers");
        await mark(c.id, "undone", null);
        break;
      }
      case "guard_alias_added": {
        const guardId = d.guardId as string;
        const alias = d.alias as string;
        const g = await prisma.guard.findUnique({ where: { id: guardId }, select: { nameAliases: true } });
        if (g?.nameAliases.includes(alias)) {
          await prisma.guard.update({ where: { id: guardId }, data: { nameAliases: g.nameAliases.filter((a) => a !== alias) } });
          await audit("guards", guardId, "update", { id: guardId }, { id: guardId });
          bump("guard_aliases");
        }
        await mark(c.id, "undone", null);
        break;
      }
      case "shift_type_created": {
        const stId = c.refId ?? "";
        const used = await prisma.shiftRecord.count({ where: { shiftTypeId: stId, status: { not: "cancelled" } } });
        if (used > 0) {
          await skip(c, `更種仍然有 ${used} 更用緊，唔作廢（要先處理嗰啲更次）`);
          break;
        }
        const st = await prisma.shiftType.findUnique({ where: { id: stId } });
        if (!st || st.voidedAt) {
          await mark(c.id, "undone", "更種已作廢或者唔存在");
          break;
        }
        const after = await prisma.shiftType.update({ where: { id: st.id }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
        await audit("shift_types", st.id, "void", st, { ...after, void_reason: source });
        bump("shift_types");
        await mark(c.id, "undone", null);
        break;
      }
      case "site_alias": {
        const siteId = d.siteId as string;
        const alias = d.alias as string;
        const s = await prisma.site.findUnique({ where: { id: siteId }, select: { aliases: true } });
        if (s?.aliases.includes(alias)) {
          await prisma.site.update({ where: { id: siteId }, data: { aliases: s.aliases.filter((a) => a !== alias) } });
          await audit("sites", siteId, "update", { id: siteId, aliases: s.aliases }, { id: siteId, aliases: s.aliases.filter((a) => a !== alias) });
          bump("site_aliases");
        }
        await mark(c.id, "undone", null);
        break;
      }
      default:
        await skip(c, "呢類改動唔支援自動還原");
    }
  }

  // N4：核對——journal 入面記過嘅更，現值仍然等於 auto 卡填入值（即未還原到）嘅數目。
  if (pending.length > 0) {
    const stillUsing = new Set<string>();
    for (const c of changes) {
      if (c.kind !== "price_snapshots") continue;
      const rows = ((c.detailJson as { rows?: Array<{ id: string; fields?: string[]; before: Array<number | null>; after: Array<number | null> }> }).rows ?? []);
      for (const r of rows) {
        const cur = await prisma.shiftRecord.findUnique({ where: { id: r.id }, select: { clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true } });
        if (!cur) continue;
        const fields = r.fields && r.fields.length > 0 ? r.fields : ["client", "payout"];
        const clientStill = fields.includes("client") && r.after[0] !== null && !sameRepriceValue(r.before[0] ?? null, r.after[0]) && sameRepriceValue(numOrNull(cur.clientRateSnapshot), r.after[0]);
        const payoutStill = fields.includes("payout") && r.after[1] !== null && !(sameRepriceValue(r.before[1] ?? null, r.after[1]) && sameRepriceValue(r.before[2] ?? null, r.after[2])) && sameRepriceValue(numOrNull(cur.guardWageSnapshot), r.after[1]) && sameRepriceValue(numOrNull(cur.brokerFeeSnapshot), r.after[2] ?? null);
        if (clientStill || payoutStill) stillUsing.add(r.id);
      }
    }
    result.stillUsingVoidedCardPrices = stillUsing.size;
  }

  // 呢個 run 嘅 open 分診題一律作廢（改動已還原，建議唔再成立）。
  // 淨係真係還原咗嘢（pending>0）先作廢題；0 改動嘅 undo 唔掂分診題。
  const sessions = pending.length > 0 ? await prisma.triageSession.findMany({ where: { sourceType: "month_close", sourceRef: runId }, select: { id: true } }) : [];
  if (sessions.length > 0) {
    const res = await prisma.triageQuestion.updateMany({ where: { sessionId: { in: sessions.map((s) => s.id) }, status: "open" }, data: { status: "superseded" } });
    result.supersededQuestions = res.count;
    await prisma.triageSession.updateMany({ where: { id: { in: sessions.map((s) => s.id) } }, data: { status: "done", completedAt: new Date() } });
  }

  // 報告標記已還原。
  const report = (run.reportJson as Record<string, unknown> | null) ?? null;
  if (report && pending.length > 0) {
    const auto = (report.auto as Record<string, unknown> | undefined) ?? {};
    await prisma.monthCloseRun.update({ where: { id: runId }, data: { reportJson: JSON.parse(JSON.stringify({ ...report, auto: { ...auto, undone: true, undoneAt: new Date().toISOString() } })) } });
  }
  if (pending.length > 0) {
    await writeAudit({ actorUserId, tableName: "month_close_runs", rowId: runId, action: "update", after: { id: runId, undo_auto: result.undone, skipped: result.skipped.length, auto_source: source }, ip });
  }
  return result;
}
