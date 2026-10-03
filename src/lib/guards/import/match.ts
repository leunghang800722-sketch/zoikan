// WP-STAFF-IMPORT B3 / §26.2.4：導入人 ↔ 本系統安員對齊決策（純函數；伺服器對自己個 DB 做）。
// 次序：hkid → 工號（任何 scheme）→ 電話 → （姓名相同且唯一＋第二鍵佐證）。
// 結果 link／create／conflict／needs_review，理由碼同 Stage A `04-match-plan.ts` 一致
// （script 改 import 呢份，唔再有第二套）。
import { normZh, normTel8, editDistance } from "./text";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";

export type Action = "link" | "create" | "conflict" | "needs_review";

export interface DbGuard {
  id: string;
  nameZh: string | null;
  hkid: string | null; // canonical
  tels: string[];
  staffNos: string[];
}

export interface MatchInput {
  staffNos: string[]; // 一個人可以有幾個工號（MP 舊號＋U 新號）
  hkid: string | null; // canonical
  hkidValid: boolean; // check digit 通過
  nameZh: string | null;
  phone: string | null;
  grade: "auto_ok" | "review" | "fail";
  gradeReasons: string[];
}

export interface MatchDecision {
  action: Action;
  guardId: string | null;
  candidates: string[];
  basis: string[];
  reasons: string[];
}

export interface DbIndex {
  byHkid: Map<string, DbGuard[]>;
  byNo: Map<string, DbGuard[]>;
  byTel: Map<string, DbGuard[]>;
  byZh: Map<string, DbGuard[]>;
}

export function buildDbIndex(gs: DbGuard[]): DbIndex {
  const idx: DbIndex = { byHkid: new Map(), byNo: new Map(), byTel: new Map(), byZh: new Map() };
  const add = (m: Map<string, DbGuard[]>, k: string | null, g: DbGuard) => {
    if (!k) return;
    const a = m.get(k) ?? [];
    if (!a.includes(g)) a.push(g);
    m.set(k, a);
  };
  for (const g of gs) {
    add(idx.byHkid, g.hkid, g);
    g.staffNos.forEach((n) => add(idx.byNo, normalizeStaffNumber(n), g));
    g.tels.forEach((t) => add(idx.byTel, normTel8(t), g));
    add(idx.byZh, normZh(g.nameZh), g);
  }
  return idx;
}

/** 群組層面（同 hkid 多檔／跨人）衝突理由 → 一律 conflict。 */
export function decideMatch(i: MatchInput, db: DbIndex, groupReasons: readonly string[] = []): MatchDecision {
  const reasons: string[] = [];
  const basis: string[] = [];
  const candidates = new Set<string>();
  const out = (action: Action, guardId: string | null): MatchDecision => ({ action, guardId, candidates: [...candidates], basis, reasons: [...new Set(reasons)] });

  const staffNos = i.staffNos.map(normalizeStaffNumber);
  const tel = normTel8(i.phone);
  if (groupReasons.length) {
    reasons.push(...groupReasons);
    return out("conflict", null);
  }

  if (i.grade === "fail" || !i.hkid || !i.hkidValid) {
    reasons.push("extract_fail", ...i.gradeReasons.slice(0, 5));
    // 即使 fail，工號對到嘅 guard 都列為候選方便人手處理
    staffNos.forEach((n) => db.byNo.get(n)?.forEach((g) => candidates.add(g.id)));
    return out("needs_review", null);
  }

  const gHkid = db.byHkid.get(i.hkid) ?? [];
  const gNo = [...new Map(staffNos.flatMap((n) => db.byNo.get(n) ?? []).map((g) => [g.id, g])).values()];
  const gTel = tel ? db.byTel.get(tel) ?? [] : [];
  [...gHkid, ...gNo, ...gTel].forEach((g) => candidates.add(g.id));

  if (gHkid.length > 1) {
    reasons.push("hkid_multi_guard");
    return out("conflict", null);
  }
  if (gNo.length > 1) {
    reasons.push("staffno_multi_guard");
    return out("conflict", null);
  }
  if (gHkid[0] && gNo[0] && gHkid[0].id !== gNo[0].id) {
    reasons.push("hkid_vs_staffno_differ");
    return out("conflict", null);
  }
  const g = gHkid[0] ?? gNo[0] ?? null;
  if (g) {
    if (g.hkid && g.hkid !== i.hkid) {
      reasons.push("guard_hkid_differs");
      return out("conflict", g.id);
    }
    if (gTel.length && !gTel.some((t) => t.id === g.id)) {
      reasons.push("tel_belongs_to_other_guard");
      return out("conflict", g.id);
    }
    if (gHkid[0]) basis.push("hkid");
    if (gNo[0]) basis.push("staff_no");
    if (gTel.some((t) => t.id === g.id)) basis.push("tel");
    if (i.nameZh && g.nameZh && normZh(i.nameZh) !== normZh(g.nameZh)) reasons.push("name_differs_from_guard");
    return out("link", g.id);
  }
  // 冇 hkid／工號對應——試電話
  if (gTel.length === 1) {
    const t = gTel[0]!;
    if (t.hkid && t.hkid !== i.hkid) {
      reasons.push("tel_guard_has_other_hkid");
      return out("conflict", t.id);
    }
    const nameSame = !!i.nameZh && !!t.nameZh && normZh(i.nameZh) === normZh(t.nameZh);
    if (nameSame) {
      basis.push("tel", "name");
      return out("link", t.id);
    }
    reasons.push("tel_only_candidate");
    return out("needs_review", null);
  }
  if (gTel.length > 1) {
    reasons.push("tel_multi_guard");
    return out("conflict", null);
  }
  // 淨姓名（冇第二鍵佐證）→ 候選，要人手
  const gName = i.nameZh ? db.byZh.get(normZh(i.nameZh) ?? "") ?? [] : [];
  gName.forEach((x) => candidates.add(x.id));
  if (gName.length) {
    reasons.push(gName.length === 1 ? "name_only_candidate" : "name_multi_candidate");
    return out("needs_review", null);
  }
  basis.push("no_existing_guard");
  return out("create", null);
}

export interface NameGroupInput {
  key: string;
  nameZh: string | null;
}

/** 同 hkid 多檔嘅中文名差異 → group_name_differs（Stage A 04 用）。 */
export function nameGroupDiffers(names: readonly (string | null)[]): boolean {
  const ns = names.map(normZh).filter((x): x is string => !!x);
  return ns.some((n) => ns.some((m) => editDistance(n, m) > 1 && Math.min(n.length, m.length) >= 2));
}
