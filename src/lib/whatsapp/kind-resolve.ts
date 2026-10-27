// WA-9 (7)：純 code 短訊（代班／多日假期／相 caption 收工）嘅 intent 建構同收工補時間。零 LLM。
import { prisma } from "@/lib/db";
import { patchProvenanceUnlocked } from "./provenance-patch";
import { hkParts } from "@/lib/dates";
import { addDays, hkDateOf } from "./dates";
import type { ParsedIntent } from "./parse";
import type { TextKind } from "./report-kinds";
import type { ResolveContext } from "./resolve";
import { personForName, rosterScope, type RosterDeps } from "./roster-resolve";

const base = (over: Partial<ParsedIntent>): ParsedIntent => ({
  type: "shift",
  date: null,
  site_raw: null,
  persons: [],
  self_reference: false,
  shift_raw: null,
  shift_code_guess: null,
  hours: null,
  leave_raw: null,
  leave_code_guess: null,
  confidence: 0.9,
  evidence: null,
  ...over,
});

/** 「A代B」→ 一個 cover intent（今日；A 做 B 嘅更）。走現有 wa_cover 確認題，唔自動寫。 */
export function substitutionIntents(k: Extract<TextKind, { kind: "substitution" }>): ParsedIntent[] {
  return [base({ type: "cover", date: { raw: "今日", kind: "relative" }, persons: [{ raw: k.worker, role: "worker" }, { raw: k.replaced, role: "replaced" }], confidence: 0.8 })];
}

/** 「X11月份假期3,12,18,26」→ 每個日子一個 leave intent（假期碼由群組 leave_word_map 對照；對唔到就出題）。 */
export function leaveNoticeIntents(k: Extract<TextKind, { kind: "leave_notice" }>): ParsedIntent[] {
  return k.days.map((d) => base({ type: "leave", date: { raw: `${k.month}月${d}日`, kind: "absolute" }, persons: [{ raw: k.name, role: "worker" }], leave_raw: "假期", confidence: 0.85 }));
}

export interface CheckoutResult {
  matched: boolean;
  updated: boolean;
  note: string | null;
}

/**
 * 收工 caption：補返當日同一條 shift 記錄嘅結束時間（provenance.reported_time_off），**永不建第二條 shift**。
 * 日期：HKT 00:00–12:00 優先搵前一晚嘅**跨夜更**記錄（夜更收工），搵唔到再搵今日；12:00 後只搵今日。冇對應記錄 → note checkout_without_checkin（唔出題）。
 */
export async function applyCheckout(args: { ctx: ResolveContext; chatJid: string; name: string; deps: RosterDeps }): Promise<CheckoutResult> {
  const { ctx } = args;
  const today = hkDateOf(ctx.ts);
  const scope = await rosterScope(ctx, args.chatJid, args.deps, addDays(today, -60));
  const person = personForName(ctx.index, args.name, scope);
  if (!person.guardId) return { matched: false, updated: false, note: "checkout_person_unmatched" };
  const p = hkParts(ctx.ts);
  const dates = p.hour < 12 ? [addDays(today, -1), today] : [today];
  for (const d of dates) {
    const recs = (await ctx.repo.existing(person.guardId, d)).filter((r) => r.recordType === "shift" && r.status !== "cancelled");
    const mine = recs.filter((r) => !ctx.group.siteId || r.siteId === ctx.group.siteId);
    const rec = (mine.length > 0 ? mine : recs)[0];
    if (!rec) continue;
    // 12:00 前收工：前一晚嗰條記錄只有係跨夜更（結束時間 ≤ 開始時間）先算；日更人中午前提早收工要補返當日嗰條
    if (d !== today) {
      const st = await prisma.shiftType.findUnique({ where: { id: rec.shiftTypeId }, select: { startTime: true, endTime: true } });
      const crosses = !!st?.startTime && !!st?.endTime && st.endTime.getUTCHours() * 60 + st.endTime.getUTCMinutes() <= st.startTime.getUTCHours() * 60 + st.startTime.getUTCMinutes();
      if (!crosses) continue;
    }
    const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
    const r = await patchProvenanceUnlocked({ recordId: rec.id }, { reported_time_off: hhmm });
    return { matched: true, updated: r.updated > 0, note: r.locked > 0 ? "locked_month_skip" : null };
  }
  return { matched: true, updated: false, note: "checkout_without_checkin" };
}
