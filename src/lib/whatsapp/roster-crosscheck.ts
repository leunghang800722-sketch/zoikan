// WA-9：相片同「當日文字名單」交叉核實（數碼港盤：簽到表／打卡紙／app 截圖只做核對，唔係寫入必要條件）。
// 同群同日有名單記錄：相入面配到嘅人
//   - 喺名單 → 補 provenance.reported_time_on/off 到名單嗰條記錄（唔改更、唔另寫記錄）；
//   - 唔喺名單 / 配唔到人 → 計入差異。
// 差異＝一個群一日一條合併題 wa_roster_mismatch（姓名只存 DB 題卡，API 層按權限遮罩）。冇差異＝唔出題。
// 名單有而相冇嘅人由 rosterOnlyForDay 提供（日終 job 用）；呢度逐張相唔報「名單有而相冇」，避免未收齊就洗版。
import { prisma } from "@/lib/db";
import { patchProvenanceUnlocked } from "./provenance-patch";
import { isoToDbDate } from "./dates";
import type { ResolvedIntent } from "./resolve";

export interface RosterDay {
  /** 名單覆蓋嘅 guard → 來源名單訊息 id */
  guards: Map<string, string>;
}

export interface CrossCheckDeps {
  rosterOfDay(chatJid: string, day: string): Promise<RosterDay | null>;
  /** 補 reported_time；鎖月記錄唔改（locked 計數，note locked_month_skip） */
  setReported(args: { messageId: string; guardId: string; day: string; timeOn: string | null; timeOff: string | null }): Promise<{ updated: number; locked: number }>;
  nameOf?(guardId: string): string | null;
}

export function prismaCrossCheckDeps(): CrossCheckDeps {
  return {
    async rosterOfDay(chatJid, day) {
      const start = new Date(`${day}T00:00:00+08:00`);
      const end = new Date(start.getTime() + 24 * 3600 * 1000);
      const rows = await prisma.whatsappIntent.findMany({
        where: { kind: "shift", guardId: { not: null }, revokedAt: null, supersededByRevision: null, workDate: isoToDbDate(day), message: { chatJid, llmProvider: "roster", revokedAt: null, ts: { gte: start, lt: end } } },
        select: { guardId: true, messageId: true },
      });
      if (rows.length === 0) return null;
      return { guards: new Map(rows.flatMap((r) => (r.guardId ? [[r.guardId, r.messageId] as [string, string]] : []))) };
    },
    async setReported({ messageId, guardId, day, timeOn, timeOff }) {
      const r = await patchProvenanceUnlocked({ messageId, guardId, day }, { ...(timeOn ? { reported_time_on: timeOn } : {}), ...(timeOff ? { reported_time_off: timeOff } : {}) });
      return { updated: r.updated, locked: r.locked };
    },
  };
}

export interface CrossCheckResult {
  /** 剩低要照舊處理嘅 intents（冇名單 → 原樣；有名單 → 只有一條差異題或空） */
  resolved: ResolvedIntent[];
  hadRoster: boolean;
  matched: number;
  /** 鎖月記錄唔改（note locked_month_skip）嘅條數 */
  lockedSkipped: number;
  photoOnly: number;
}

/** 有名單先交叉核實；回傳改寫後嘅 resolved。 */
export async function crossCheckWithRoster(args: { chatJid: string; day: string; groupId: string; resolved: ResolvedIntent[]; deps?: CrossCheckDeps; nameOfGuard?: (g: string) => string | null }): Promise<CrossCheckResult> {
  const deps = args.deps ?? prismaCrossCheckDeps();
  const roster = await deps.rosterOfDay(args.chatJid, args.day);
  if (!roster) return { resolved: args.resolved, hadRoster: false, matched: 0, lockedSkipped: 0, photoOnly: 0 };
  let matched = 0;
  let lockedSkipped = 0;
  const photoOnly: string[] = [];
  let unresolved = 0;
  for (const r of args.resolved) {
    if (r.kind !== "shift") continue;
    const card = r.src?.card;
    if (r.guardId && roster.guards.has(r.guardId)) {
      const n = await deps.setReported({ messageId: roster.guards.get(r.guardId)!, guardId: r.guardId, day: args.day, timeOn: card?.time_on ?? null, timeOff: card?.time_off ?? null });
      matched++;
      lockedSkipped += n.locked;
    } else if (r.guardId) {
      photoOnly.push(args.nameOfGuard?.(r.guardId) ?? r.src?.person_raw ?? "（未知）");
    } else {
      unresolved++;
      photoOnly.push(r.src?.person_raw ?? r.src?.card?.name_zh_read ?? "（讀唔到姓名）");
    }
  }
  if (photoOnly.length === 0) return { resolved: [], hadRoster: true, matched, lockedSkipped, photoOnly: 0 };
  const first = args.resolved.find((r) => r.kind === "shift") ?? args.resolved[0]!;
  const mismatch: ResolvedIntent = {
    kind: "unclear",
    workDate: args.day,
    siteId: first?.siteId ?? null,
    guardId: null,
    shiftTypeId: null,
    leaveCode: null,
    hours: null,
    confidence: 0,
    resolution: { type: "unclear", reasons: ["roster_mismatch"], notes: ["roster_crosscheck", ...(unresolved > 0 ? ["photo_unresolved"] : [])], basis: {}, candidates: {}, group_id: args.groupId, group_auto_write: false },
    routed: "triage",
    src: { person_raw: null, site_raw: null, date_raw: null, shift_raw: null, leave_raw: null, replaced_raw: null, mismatch: { day: args.day, roster_only: [], photo_only: [...new Set(photoOnly)] } },
  };
  return { resolved: [mismatch], hadRoster: true, matched, lockedSkipped, photoOnly: photoOnly.length };
}

/** 日終：名單有而當日冇任何相對到嘅人（只數／列 guard id；呼叫者決定點通知）。 */
export function rosterOnly(roster: RosterDay, seenGuardIds: ReadonlySet<string>): string[] {
  return [...roster.guards.keys()].filter((g) => !seenGuardIds.has(g)).sort();
}
