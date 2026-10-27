// W3：WhatsApp 自動寫入（計劃書 §6.1／§6.2；server-only）。
// 由 process.ts 喺「落 intents」之後、開 Triage 題之前、同一個 transaction 內呼叫：
//   routed=auto_write 嘅 intent，逐條過閘（群組開關→總開關→信心→每日上限→5 分鐘去重→鎖月），
//   全過先經共用 write service（writeShiftCells）寫入；任何一閘唔過 → 改 routed=triage（帶原因碼，由 W2 generator 開題）。
//   群組 auto_write=false＝dry-run（W1 行為不變：保持 routed=auto_write，唔寫、唔開題；resolution.notes 已有 group_auto_write_off）。
// 寫入身份＝系統排程帳號（ensureSystemUser，呼叫者先攞）；source="whatsapp"；provenance {message_id, revision, intent_idx, sender_guard_id}。
import type { Prisma, WhatsappIntent } from "@prisma/client";
import { ApiError } from "@/lib/api/errors";
import { isMonthLockedTx } from "@/lib/month-lock";
import type { AutoCardUse } from "@/lib/pricing/auto-card-journal";
import { writeShiftCells } from "@/lib/shift-records/write";
import { WA_AUTO_MIN_CONFIDENCE, WA_DEDUPE_WINDOW_MS, waAutoWriteEnabled } from "./config";
import { addDays, hkDateOf } from "./dates";
import { leaveRowShiftType } from "./leave-row";
import { normLeave } from "./resolve";

type Tx = Prisma.TransactionClient;

export interface AutoWriteGroup {
  id: string;
  autoWrite: boolean;
  autoConfirm: boolean;
  autoWriteDailyCap: number;
}
export interface AutoWriteMsg {
  messageId: string;
  revision: number;
  chatJid: string;
  senderJid: string;
  senderGuardId: string | null;
  ts: Date;
}

/** 單條 intent 嘅自動寫入結果（寫入 resolution.auto_write）。 */
type AutoWriteResult = "written" | "no_op";

interface AutoWritePatch {
  routed: "auto_write" | "triage" | "ignored";
  resolution: Record<string, unknown>;
  resultRef: string | null;
}

export interface AutoWriteOutcome {
  /** key＝intent.idx；冇 entry＝呢條 intent 唔受影響（唔係 auto_write，或群組未開＝dry-run）。 */
  patches: Map<number, AutoWritePatch>;
  autoCardUses: AutoCardUse[];
  written: number;
}

const asRes = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {});
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function downgrade(base: unknown, code: string): AutoWritePatch {
  const res = asRes(base);
  res.reasons = [...new Set([...strArr(res.reasons), code])];
  return { routed: "triage", resolution: res, resultRef: null };
}

/** 呢個群呢個香港日（按訊息時間）已自動寫入幾多條（包括之後被拒／被取代嘅，上限計「寫過」）。 */
async function countWrittenToday(tx: Tx, chatJid: string, ts: Date): Promise<number> {
  const day = hkDateOf(ts);
  const start = new Date(`${day}T00:00:00+08:00`);
  const end = new Date(`${addDays(day, 1)}T00:00:00+08:00`);
  return tx.whatsappIntent.count({
    where: { routed: "auto_write", resolution: { path: ["auto_write", "result"], equals: "written" }, message: { chatJid, ts: { gte: start, lt: end } } },
  });
}

/** 同一發訊人 5 分鐘內、另一條訊息已自動寫入同一 guard／日子／更別（或請假碼）。 */
async function hasRecentDuplicate(tx: Tx, msg: AutoWriteMsg, row: Pick<WhatsappIntent, "kind" | "guardId" | "workDate" | "shiftTypeId" | "leaveCode">): Promise<boolean> {
  if (!row.guardId || !row.workDate) return false;
  const since = new Date(msg.ts.getTime() - WA_DEDUPE_WINDOW_MS);
  const cands = await tx.whatsappIntent.findMany({
    where: {
      routed: "auto_write",
      resolution: { path: ["auto_write", "result"], equals: "written" },
      guardId: row.guardId,
      workDate: row.workDate,
      kind: row.kind,
      // 已撤回／已被新 revision 取代嘅 intent 唔算重複（撤回後重發要可以再寫）
      revokedAt: null,
      supersededByRevision: null,
      message: { chatJid: msg.chatJid, senderJid: msg.senderJid, revokedAt: null, messageId: { not: msg.messageId }, ts: { gte: since, lte: msg.ts } },
    },
    select: { shiftTypeId: true, leaveCode: true },
  });
  return cands.some((c) => (row.kind === "leave" ? normLeave(c.leaveCode) === normLeave(row.leaveCode) : c.shiftTypeId === row.shiftTypeId));
}

/**
 * 逐條處理 routed=auto_write 嘅 intents（按 idx 次序）。呼叫者須已持有 TRIAGE_LOCK（序列化 cap／去重計數同 Triage 答題寫入）。
 * `rows`＝剛 createManyAndReturn 嘅 intents（resolution 係 resolve.ts 輸出）。
 */
export async function autoWriteIntentsTx(tx: Tx, args: { msg: AutoWriteMsg; group: AutoWriteGroup; rows: readonly WhatsappIntent[]; actorUserId: string }): Promise<AutoWriteOutcome> {
  const { msg, group, actorUserId } = args;
  const patches = new Map<number, AutoWritePatch>();
  const autoCardUses: AutoCardUse[] = [];
  let written = 0;
  if (!group.autoWrite) return { patches, autoCardUses, written }; // dry-run：W1 行為不變

  const enabled = waAutoWriteEnabled();
  for (const row of [...args.rows].sort((a, b) => a.idx - b.idx)) {
    if (row.routed !== "auto_write") continue;
    const base = row.resolution;
    const conf = row.confidence === null ? 0 : Number(row.confidence);
    const complete = (row.kind === "shift" && !!row.shiftTypeId && !!row.siteId) || (row.kind === "leave" && !!row.leaveCode && !!row.siteId);
    if (!complete || !row.guardId || !row.workDate) {
      patches.set(row.idx, downgrade(base, "unclear"));
      continue;
    }
    if (!enabled) {
      patches.set(row.idx, downgrade(base, "auto_disabled"));
      continue;
    }
    if (conf < WA_AUTO_MIN_CONFIDENCE) {
      patches.set(row.idx, downgrade(base, "low_confidence"));
      continue;
    }
    if ((await countWrittenToday(tx, msg.chatJid, msg.ts)) >= group.autoWriteDailyCap) {
      patches.set(row.idx, downgrade(base, "daily_cap"));
      continue;
    }
    if (await hasRecentDuplicate(tx, msg, row)) {
      const res = asRes(base);
      res.reasons = ["duplicate_recent"];
      patches.set(row.idx, { routed: "ignored", resolution: res, resultRef: null });
      continue;
    }
    // 鎖月：tx 內 FOR SHARE 檢查（writeShiftCells 開頭仍會再擋一次＋audit；呢度先擋以便改 Triage 而唔係拋錯）
    if (await isMonthLockedTx(tx, row.workDate)) {
      patches.set(row.idx, downgrade(base, "month_locked"));
      continue;
    }

    let shiftTypeId = row.shiftTypeId;
    let code: string;
    if (row.kind === "shift") {
      const st = await tx.shiftType.findUnique({ where: { id: row.shiftTypeId! }, select: { code: true, siteId: true, voidedAt: true } });
      if (!st || st.siteId !== row.siteId || st.voidedAt) {
        patches.set(row.idx, downgrade(base, "shift_unmapped"));
        continue;
      }
      code = st.code;
    } else {
      shiftTypeId = await leaveRowShiftType(tx, row.siteId!, row.guardId);
      if (!shiftTypeId) {
        patches.set(row.idx, downgrade(base, "shift_unmapped"));
        continue;
      }
      code = normLeave(row.leaveCode)!;
    }

    // N2：寫入前喺 tx 內再查一次同人同日嘅記錄（FOR SHARE 鎖住，防 resolve 之後先出現嘅撞更／請假），
    // writeShiftCells 本身只會對「同一格」撞唔同類型先報 409，同日其他更種唔會擋。
    const sameDay = await tx.$queryRaw<{ shift_type_id: string; record_type: string; leave_code: string | null }[]>`
      SELECT shift_type_id, record_type::text AS record_type, leave_code::text AS leave_code FROM shift_records
      WHERE guard_id = ${row.guardId} AND work_date = ${row.workDate.toISOString().slice(0, 10)}::date AND status <> 'cancelled' AND record_type::text <> 'ot' ORDER BY id FOR SHARE`;
    if (sameDay.length > 0) {
      const same = row.kind === "leave" ? sameDay.some((r) => r.record_type === "leave" && normLeave(r.leave_code) === normLeave(row.leaveCode)) : sameDay.some((r) => r.record_type === "shift" && r.shift_type_id === shiftTypeId);
      if (!same) {
        const hasLeave = sameDay.some((r) => r.record_type === "leave");
        patches.set(row.idx, downgrade(base, row.kind === "shift" ? (hasLeave ? "conflict_leave" : "conflict_other_shift") : hasLeave ? "conflict_leave" : "conflict_shift_vs_leave"));
        continue;
      }
    }

    try {
      const w = await writeShiftCells(tx, {
        siteId: row.siteId!,
        month: row.workDate,
        cells: [{ guard_id: row.guardId, shift_type_id: shiftTypeId!, work_date: row.workDate, code }],
        actor: { userId: actorUserId },
        source: "whatsapp",
        provenance: { message_id: msg.messageId, revision: msg.revision, intent_idx: row.idx, sender_guard_id: msg.senderGuardId },
        statusPolicy: group.autoConfirm ? "confirmed" : "pending_approval",
        overwriteActive: false,
      });
      autoCardUses.push(...w.autoCardUses);
      const hit = w.results[0];
      const res = asRes(base);
      if (!hit || hit.action === "exists") {
        // 同更已存在（併發／resolve 之後先出現）：no-op，唔寫
        res.notes = [...new Set([...strArr(res.notes), "already_exists"])];
        res.auto_write = { result: "no_op" satisfies AutoWriteResult, record_id: hit?.id ?? null };
        patches.set(row.idx, { routed: "auto_write", resolution: res, resultRef: hit?.id ?? null });
      } else {
        res.auto_write = { result: "written" satisfies AutoWriteResult, record_id: hit.id, status: group.autoConfirm ? "confirmed" : "pending_approval" };
        patches.set(row.idx, { routed: "auto_write", resolution: res, resultRef: hit.id });
        written++;
      }
    } catch (e) {
      // 只接住「寫入前驗證」類（衝突 409／驗證 400／鎖月 403）：未寫任何嘢，改 Triage。DB 錯誤照拋（整個訊息 rollback 重試）。
      if (e instanceof ApiError && (e.status === 409 || e.status === 400 || e.code === "month_locked")) {
        patches.set(row.idx, downgrade(base, e.code === "month_locked" ? "month_locked" : e.status === 409 ? "conflict_other_shift" : "shift_unmapped"));
        continue;
      }
      throw e;
    }
  }
  return { patches, autoCardUses, written };
}
