// W2：答題後重跑一個 intent 嘅「阻擋原因」評估（唔再叫 LLM）：
// 用 intent 解析結果＋人手答案（guard／盤／日子／force），重做 盤→更碼→日期窗口→鎖月→衝突→額滿 檢查。
// 規則同 W1 resolve.ts 一致；人手揀過日子（或「仍然入更」）就唔再擋日期窗口（人已確認）。
// 純讀（唔寫任何資料）；repo 抽象令單元測試可以用記憶體實作。
import { dateInWindow } from "./dates";
import { normLeave, resolveShift, type ExistingRecord, type ResolveRepo } from "./resolve";
import type { WaEvidence } from "./triage-types";

export interface WaEffective {
  kind: WaEvidence["intent"]["kind"];
  siteId: string | null;
  guardId: string | null;
  workDate: string | null;
  shiftTypeId: string | null;
  leaveCode: string | null;
}

export interface WaEval {
  effective: WaEffective;
  reasons: string[];
  /** 「以 WhatsApp 為準」時要取消嘅舊記錄 id */
  conflictRecordIds: string[];
  /** 同更／同請假碼已存在（唔使再入） */
  alreadyExistsIds: string[];
  /** 仍然需要問嘅候選（日子／更種） */
  candidates: { shift_type_ids: string[] };
  existing: ExistingRecord[];
}

export interface WaEvalOptions {
  ts: Date;
  repo: ResolveRepo;
  wordMap: Record<string, string>;
  /** 「以 WhatsApp 為準（取消舊）」：撞更／撞請假唔再當阻擋（改為列出要取消嘅記錄） */
  useWhatsapp?: boolean;
}

const push = (arr: string[], ...v: string[]) => {
  for (const x of v) if (!arr.includes(x)) arr.push(x);
};

export async function evaluateWaState(ev: WaEvidence, opts: WaEvalOptions): Promise<WaEval> {
  const i = ev.intent;
  const h = ev.human;
  const siteId = h.site_id ?? i.site_id;
  const guardId = h.guard_id ?? i.guard_id;
  const workDate = h.work_date ?? i.work_date;
  const reasons: string[] = [];
  const out: WaEval = { effective: { kind: i.kind, siteId, guardId, workDate, shiftTypeId: null, leaveCode: i.leave_code }, reasons, conflictRecordIds: [], alreadyExistsIds: [], candidates: { shift_type_ids: [] }, existing: [] };

  if (i.kind !== "shift" && i.kind !== "leave") {
    push(reasons, i.kind === "unclear" || i.kind === "question_only" ? "unclear" : "type_not_auto");
    return out;
  }
  if (!siteId) push(reasons, "site_ambiguous");
  if (!guardId) push(reasons, "person_unknown");
  if (!workDate) push(reasons, "date_missing");

  // 更碼／請假碼
  if (i.kind === "shift") {
    if (siteId) {
      if (i.shift_type_id && (!h.site_id || h.site_id === i.site_id)) {
        out.effective.shiftTypeId = i.shift_type_id;
      } else {
        const types = await opts.repo.shiftTypes(siteId);
        const r = resolveShift(ev.src.shift_raw, null, types, opts.wordMap);
        out.effective.shiftTypeId = r.shiftTypeId;
        out.candidates.shift_type_ids = r.candidates;
        push(reasons, ...r.reasons);
      }
    }
  } else if (!i.leave_code) {
    push(reasons, "leave_unmapped");
  }

  const humanSure = !!h.work_date || !!h.force;
  if (workDate) {
    if (!humanSure && !dateInWindow(workDate, opts.ts)) push(reasons, "date_out_of_range");
    if (await opts.repo.monthLocked(workDate)) push(reasons, "month_locked");
  }

  const ready = guardId && workDate && ((i.kind === "shift" && out.effective.shiftTypeId && siteId) || (i.kind === "leave" && i.leave_code));
  if (ready && !reasons.includes("month_locked")) {
    const ex = (await opts.repo.existing(guardId!, workDate!)).filter((r) => r.status !== "cancelled");
    out.existing = ex;
    const real = ex.filter((r) => r.recordType !== "ot");
    let hardConflict = false;
    if (i.kind === "shift") {
      const same = real.filter((r) => r.recordType === "shift" && r.shiftTypeId === out.effective.shiftTypeId);
      if (same.length > 0) {
        out.alreadyExistsIds = same.map((r) => r.id);
        return out;
      }
      if (real.length > 0) {
        hardConflict = true;
        if (!opts.useWhatsapp) push(reasons, real.some((r) => r.recordType === "leave") ? "conflict_leave" : "conflict_other_shift");
      }
    } else {
      const lv = normLeave(i.leave_code);
      const sameLeave = real.filter((r) => r.recordType === "leave" && normLeave(r.leaveCode) === lv);
      if (sameLeave.length > 0) {
        out.alreadyExistsIds = sameLeave.map((r) => r.id);
        return out;
      }
      if (real.length > 0) {
        hardConflict = true;
        if (!opts.useWhatsapp) push(reasons, real.some((r) => r.recordType === "leave") ? "conflict_leave" : "conflict_shift_vs_leave");
      }
    }
    if (hardConflict && opts.useWhatsapp) out.conflictRecordIds = real.map((r) => r.id);
    // 額滿／超配額：只喺冇（未處理嘅）硬衝突、而且人手未揀「仍然入更」時先擋
    if (i.kind === "shift" && !h.force && (!hardConflict || opts.useWhatsapp)) {
      const hc = await opts.repo.headcount(siteId!, out.effective.shiftTypeId!, workDate!);
      if (hc.required !== null && hc.current >= hc.required) push(reasons, "slot_full");
      const q = await opts.repo.quota(guardId!, siteId!, out.effective.shiftTypeId!, workDate!);
      if (q && q.actual >= q.target) push(reasons, "quota_full");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// W4：替更（cover）／取消（cancel）評估——純讀。
// ---------------------------------------------------------------------------
export interface CoverEval {
  effective: { siteId: string | null; workDate: string | null; shiftTypeId: string | null; workerId: string | null; replacedId: string | null };
  /** 阻擋原因：盤／日子／更種／鎖月／替更者撞更（useWhatsapp 時唔計撞更）／替更者未定（person_unknown） */
  reasons: string[];
  candidates: { shift_type_ids: string[] };
  /** 替更者同日已有同一更（唔使再入） */
  workerHasShift: boolean;
  /** 替更者同日其他更／請假（撞更） */
  conflictIds: string[];
  /** 被替者當日（同盤、同更別）嘅現有更記錄 */
  replacedRecordIds: string[];
  existing: ExistingRecord[];
}

export async function evaluateCoverState(ev: WaEvidence, opts: WaEvalOptions): Promise<CoverEval> {
  const i = ev.intent;
  const h = ev.human;
  const siteId = h.site_id ?? i.site_id;
  const workDate = h.work_date ?? i.work_date;
  const workerId = h.guard_id ?? i.guard_id;
  const replacedId = h.replaced_guard_id ?? ev.cover?.replaced_guard_id ?? null;
  const reasons: string[] = [];
  const out: CoverEval = { effective: { siteId, workDate, shiftTypeId: null, workerId, replacedId }, reasons, candidates: { shift_type_ids: [] }, workerHasShift: false, conflictIds: [], replacedRecordIds: [], existing: [] };

  if (!siteId) push(reasons, "site_ambiguous");
  if (!workDate) push(reasons, "date_missing");
  if (siteId) {
    if (i.shift_type_id && (!h.site_id || h.site_id === i.site_id)) {
      out.effective.shiftTypeId = i.shift_type_id;
    } else {
      const r = resolveShift(ev.src.shift_raw, null, await opts.repo.shiftTypes(siteId), opts.wordMap);
      out.effective.shiftTypeId = r.shiftTypeId;
      out.candidates.shift_type_ids = r.candidates;
      push(reasons, ...r.reasons);
    }
  }
  if (workDate) {
    if (!h.work_date && !dateInWindow(workDate, opts.ts)) push(reasons, "date_out_of_range");
    if (await opts.repo.monthLocked(workDate)) push(reasons, "month_locked");
  }
  if (!workerId) push(reasons, "person_unknown");
  if (workDate && !reasons.includes("month_locked")) {
    if (workerId) {
      const ex = (await opts.repo.existing(workerId, workDate)).filter((r) => r.status !== "cancelled" && r.recordType !== "ot");
      out.existing = ex;
      const stId = out.effective.shiftTypeId;
      const same = ex.filter((r) => r.recordType === "shift" && !!stId && r.shiftTypeId === stId);
      out.workerHasShift = same.length > 0;
      const clash = ex.filter((r) => !same.includes(r));
      out.conflictIds = clash.map((r) => r.id);
      if (clash.length > 0 && !opts.useWhatsapp) push(reasons, clash.some((r) => r.recordType === "leave") ? "conflict_leave" : "conflict_other_shift");
    }
    if (replacedId) {
      const rr = (await opts.repo.existing(replacedId, workDate)).filter((r) => r.status !== "cancelled" && r.recordType === "shift");
      out.replacedRecordIds = rr.filter((r) => (!siteId || r.siteId === siteId) && (!out.effective.shiftTypeId || r.shiftTypeId === out.effective.shiftTypeId)).map((r) => r.id);
    }
  }
  return out;
}

export interface CancelEval {
  effective: { guardId: string | null; workDate: string | null; siteId: string | null };
  reasons: string[];
  /** 將會被取消嘅記錄（當日自己嘅更／請假；有盤口就只限該盤） */
  targets: ExistingRecord[];
}

export async function evaluateCancelState(ev: WaEvidence, opts: Pick<WaEvalOptions, "ts" | "repo">): Promise<CancelEval> {
  const i = ev.intent;
  const h = ev.human;
  const guardId = h.guard_id ?? i.guard_id;
  const workDate = h.work_date ?? i.work_date;
  const siteId = h.site_id ?? i.site_id;
  const reasons: string[] = [];
  const out: CancelEval = { effective: { guardId, workDate, siteId }, reasons, targets: [] };
  if (!guardId) push(reasons, "person_unknown");
  if (!workDate) push(reasons, "date_missing");
  if (workDate) {
    if (!h.work_date && !dateInWindow(workDate, opts.ts)) push(reasons, "date_out_of_range");
    if (await opts.repo.monthLocked(workDate)) push(reasons, "month_locked");
  }
  if (guardId && workDate && !reasons.includes("month_locked")) {
    out.targets = (await opts.repo.existing(guardId, workDate)).filter((r) => r.status !== "cancelled" && r.recordType !== "ot" && (!siteId || r.siteId === siteId));
    if (out.targets.length === 0) push(reasons, "no_cancel_target");
  }
  return out;
}
