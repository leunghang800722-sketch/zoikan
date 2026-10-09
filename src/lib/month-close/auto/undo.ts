// WP-ONE-CLICK-AUTO（§31.2／§31.3 E）：`POST /api/month-close/one-click/:id/undo-auto`——
// 一鍵還原呢個 run 所有 `auto` 改動（按 month_close_auto_changes 流水帳倒序）：
//   price_snapshots   補咗嘅價 → 還原（淨係當前值仍然係自動補嗰個值先還原，之後人手改過嘅唔郁）
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
}

async function sweepCardPrices(card: { id: string; siteId: string; shiftTypeId: string | null; brokerId: string | null; clientRate: unknown; guardWage: unknown; brokerFee: unknown; payoutRate: unknown; effectiveFrom: Date; effectiveTo: Date | null; createdAt: Date }): Promise<number> {
  if (!card.shiftTypeId) return 0;
  const client = numOrNull(card.clientRate);
  const wage = numOrNull(card.guardWage) ?? numOrNull(card.payoutRate);
  const fee = numOrNull(card.brokerFee) ?? (numOrNull(card.guardWage) === null && numOrNull(card.payoutRate) !== null ? 0 : null);
  const recs = await prisma.shiftRecord.findMany({
    where: { siteId: card.siteId, shiftTypeId: card.shiftTypeId, status: { not: "cancelled" }, workDate: { gte: card.effectiveFrom, ...(card.effectiveTo ? { lte: card.effectiveTo } : {}) }, updatedAt: { gte: card.createdAt } },
    select: { id: true, settlementBrokerId: true, clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true },
  });
  let n = 0;
  for (const r of recs) {
    const c0 = numOrNull(r.clientRateSnapshot);
    const w0 = numOrNull(r.guardWageSnapshot);
    const f0 = numOrNull(r.brokerFeeSnapshot);
    const clearClient = client !== null && c0 !== null && sameRepriceValue(c0, client);
    const payoutFromCard = wage !== null;
    // 客價 resolver 會跨雞頭 fallback，所以客價唔限雞頭；出街價淨係該卡嘅雞頭。
    const clearPayout = payoutFromCard && (!card.brokerId || r.settlementBrokerId === card.brokerId) && w0 !== null && sameRepriceValue(w0, wage) && (f0 === null || fee === null || sameRepriceValue(f0, fee));
    if (!clearClient && !clearPayout) continue;
    await prisma.shiftRecord.update({ where: { id: r.id }, data: { ...(clearClient ? { clientRateSnapshot: null } : {}), ...(clearPayout ? { guardWageSnapshot: null, brokerFeeSnapshot: null } : {}) } });
    n++;
  }
  return n;
}

export async function undoAutoChanges(runId: string, actorUserId: string, ip: string | null): Promise<UndoAutoResult> {
  const run = await prisma.monthCloseRun.findUnique({ where: { id: runId } });
  if (!run) throw NotFound("搵唔到呢個一鍵結算 run");
  if (run.status === "running") throw Conflict("呢個 run 仍然執行緊，等佢完成先可以還原", { status: "running" });
  const locked = await prisma.monthClose.findUnique({ where: { month: run.month } });
  if (locked?.lockedAt) throw Conflict("本月已鎖定，唔可以還原自動改動（要改先由老闆解鎖）", { status: "locked" });

  const changes = await prisma.monthCloseAutoChange.findMany({ where: { runId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const pending = changes.filter((c) => c.status === "applied" && c.undoable);
  const result: UndoAutoResult = { runId, undone: {}, skipped: [], alreadyUndone: pending.length === 0 && changes.some((c) => c.status === "undone"), supersededQuestions: 0 };
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
    const d = c.detailJson as Record<string, unknown>;
    switch (c.kind) {
      case "price_snapshots": {
        const rows = (d.rows as Array<{ id: string; before: [number | null, number | null, number | null]; after: [number | null, number | null, number | null] }>) ?? [];
        let restored = 0;
        for (const r of rows) {
          const cur = await prisma.shiftRecord.findUnique({ where: { id: r.id }, select: { clientRateSnapshot: true, guardWageSnapshot: true, brokerFeeSnapshot: true } });
          if (!cur) continue;
          const same = sameRepriceValue(numOrNull(cur.clientRateSnapshot), r.after[0]) && sameRepriceValue(numOrNull(cur.guardWageSnapshot), r.after[1]) && sameRepriceValue(numOrNull(cur.brokerFeeSnapshot), r.after[2]);
          if (!same) continue; // 之後被人手改過，唔郁
          await prisma.shiftRecord.update({ where: { id: r.id }, data: { clientRateSnapshot: r.before[0], guardWageSnapshot: r.before[1], brokerFeeSnapshot: r.before[2] } });
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
        // 掃走因呢張 auto 卡而補上、但冇入 journal 嘅價（例如之後 reconcile 開頭 reprice／新套用嘅更按卡定價）：
        // 同盤同更種（卡有雞頭就同雞頭）、卡建立之後先更新、而且 snapshot 等如卡價嘅欄位 → 清走（只清等於卡價嗰啲欄）。
        const swept = await sweepCardPrices(card);
        if (swept > 0) {
          bump("price_snapshots_swept", swept);
          await audit("shift_records", `undo_price_sweep:${card.id}`, "update", { card_id: card.id }, { swept, card_id: card.id });
        }
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

  // 呢個 run 嘅 open 分診題一律作廢（改動已還原，建議唔再成立）。
  const sessions = await prisma.triageSession.findMany({ where: { sourceType: "month_close", sourceRef: runId }, select: { id: true } });
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
