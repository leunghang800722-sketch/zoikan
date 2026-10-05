// WP-STAFF-FIELDS 第二階段：新欄寫入（由 apply.ts 嘅 applyPerson 呼叫——同一條已驗收路徑，唔另開）。
// 規則：只寫 confirmed（或人手決定 confirm／replace）；只補空欄；現有值唔同 → conflict（唔覆蓋），除非人手揀 replace
// 而且有權限（覆蓋權檢查喺比較現值之前做，只取決於「現值係咪非空」，避免變成探測現值嘅 oracle）。
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api/errors";
import { HKICL_BANK_OPTIONS } from "@/lib/longterm-payroll/hkicl-bank-codes";
import { fieldValue, type PackagePerson } from "./package";
import { createGuardEmergencyContact, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { canOverrideDerivedSiaPermit, deriveSiaPermitExpiry } from "@/lib/guards/staff-numbers";
import {
  BANK_OVERWRITE_DENIED_MSG,
  EMPTY_BANK,
  OPEN_GATE,
  PII_OVERWRITE_DENIED_MSG,
  LONGTERM_HIRE_VIA_TRIAGE_MSG,
  bypassesHold,
  isGoDecision,
  digits,
  heldAll,
  type ExtGate,
  SCALARS,
  bankCompare,
  bankLeaves,
  contactsOf,
  scalarEqual,
  sameContact,
  partialContact,
  staffHiresOf,
  type ExtDecisions,
  type ExtOutcome,
  type GuardExtSnap,
} from "./ext";

type Tx = Prisma.TransactionClient;

export interface ExtCaps {
  /** false＝冇「安員:update」：唔准覆蓋現有牌照／平安咭／QAS／入職日期（undefined 當 true） */
  canEditGuard?: boolean;
  /** false＝冇「安員個人資料:update」：唔准喺已有聯絡人嘅安員加聯絡人 */
  canOverwritePii?: boolean;
  /** true＝冇「安員個人資料:view」：已有聯絡人嘅安員唔自動加（令寫入結果唔反映「估啱聯絡人」） */
  fillOnlyPii?: boolean;
  /** true＝批量導入 decisions（唔係分診題）：長工人層面入職日期只准 skip */
  batch?: boolean;
  /** false＝冇「安員銀行資料:update」：銀行欄一律唔寫（outcome not_written）；要覆蓋現有戶口會 403 */
  canEditBank?: boolean;
}
export type AuditFn = (input: { tableName: string; rowId: string; action: "create" | "update"; before?: unknown; after?: unknown }, holdOverride?: boolean) => Promise<void>;

const isoToDate = (v: string): Date => new Date(`${v}T00:00:00.000Z`);
const deny = (msg: string): never => {
  throw new ApiError(403, "forbidden", msg);
};

const wants = (d: string | undefined, status: string): "skip" | "go" | "not_confirmed" => (d === "skip" ? "skip" : isGoDecision(d) || status === "confirmed" ? "go" : "not_confirmed");

export interface ExtColumnPlan {
  data: Prisma.GuardUncheckedUpdateInput;
  outcomes: Record<string, ExtOutcome>;
  reasons: string[];
  /** 人手 decision 繞過 hold 嘅欄數（audit 留標記，冇值） */
  overrides: number;
}

/**
 * 同一個戶口（銀行編號＋戶口數字）唔可以屬於兩個安員：喺 transaction 內先鎖戶口 key（advisory lock），
 * 再查有冇其他安員已用。所有寫銀行嘅路徑（自動、bank_review、assign_bank、ext_identity_check、decisions）都經 applyPerson → 呢度。
 */
export async function acctTakenByOther(tx: Tx, guardId: string | null, code: string | null, acct: string): Promise<boolean> {
  const d = digits(acct);
  if (!d) return false;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bankacct:${d}`}))`;
  const c = code ? code.padStart(3, "0") : "";
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM guards
    WHERE regexp_replace(coalesce(bank_account_no, ''), '[^0-9]', '', 'g') = ${d}
      AND (${c} = '' OR bank_code IS NULL OR lpad(bank_code, 3, '0') = ${c})
      AND (${guardId}::text IS NULL OR id <> ${guardId})
    LIMIT 1`;
  return rows.length > 0;
}

/** 純量欄＋銀行 unit → guards 欄位（無 DB 存取；可能丟 403）。snap=null＝新建（全部係空）。 */
export function planExtColumns(p: PackagePerson, snap: GuardExtSnap | null, dec: ExtDecisions | undefined, caps: ExtCaps, gate: ExtGate = OPEN_GATE, bankTaken = false): ExtColumnPlan {
  const data: Record<string, unknown> = {};
  const outcomes: Record<string, ExtOutcome> = {};
  const reasons: string[] = [];
  let overrides = 0;
  for (const s of SCALARS) {
    const leaf = s.get(p);
    const v = leaf ? fieldValue(leaf) : null;
    if (!leaf || !v) continue;
    if (!s.col) {
      outcomes[s.key] = "not_stored";
      continue;
    }
    const d = dec?.[s.key];
    const w = wants(d, leaf.status);
    if (w === "skip") {
      outcomes[s.key] = "skipped";
      continue;
    }
    if (w === "not_confirmed") {
      outcomes[s.key] = "not_confirmed";
      continue;
    }
    const sh = heldAll(gate, s.key);
    if (caps.batch && s.key === "hireDate" && gate.longtermHire && isGoDecision(d)) deny(LONGTERM_HIRE_VIA_TRIAGE_MSG);
    if (!bypassesHold(d, sh)) {
      outcomes[s.key] = "held"; // 身份未夠證據／長工入職日期：等人手確認
      continue;
    }
    if (sh.length) overrides += 1;
    const cur = snap ? s.cur(snap) : null;
    if (d === "replace" && cur && caps.canEditGuard === false) deny(PII_OVERWRITE_DENIED_MSG);
    if (!cur) {
      data[s.col] = s.kind === "date" ? isoToDate(v) : v;
      outcomes[s.key] = "written";
    } else if (scalarEqual(s.kind, cur, v)) outcomes[s.key] = "same";
    else if (d === "replace") {
      data[s.col] = s.kind === "date" ? isoToDate(v) : v;
      outcomes[s.key] = "written";
    } else outcomes[s.key] = "conflict";
  }

  const bank = bankLeaves(p);
  if (bank) {
    const d = dec?.bank;
    const w = wants(d, bank.status);
    const cur = snap?.bank ?? EMPTY_BANK;
    const cmp = bankCompare(bank, cur);
    if (w === "skip") outcomes.bank = "skipped";
    else if (w === "not_confirmed") outcomes.bank = "not_confirmed";
    else if (caps.canEditBank === false) {
      if (d === "replace" && cmp.anyCurrent) deny(BANK_OVERWRITE_DENIED_MSG);
      outcomes.bank = "not_written";
    } else if (!bypassesHold(d, heldAll(gate, "bank"))) {
      outcomes.bank = "held"; // 銀行：身份證未相同／身份未夠證據 → 要人明確確認（bank_review）
    } else {
      if (heldAll(gate, "bank").length) overrides += 1;
      // 全有或全無：現有四欄全空先補空；現有有任何資料 → same／conflict（replace 先覆蓋，要銀行資料 update 權——上面已檢查）
      const overwrite = d === "replace";
      const wouldWrite = cmp.state === "fill" || (overwrite && cmp.state !== "same");
      // 寫入一律四欄一齊（銀行名稱可由 HKICL 編號推出）；包內唔齊 → 自動路徑唔寫，人手決定路徑拒絕（唔砌半套戶口）
      const nameDerived = bank.name ?? (bank.code ? (HKICL_BANK_OPTIONS.find((b) => b.code === bank.code!.padStart(3, "0"))?.nameZhShort ?? null) : null);
      const complete = !!bank.code && !!bank.accountNo && !!bank.payee && !!nameDerived;
      if (wouldWrite && bankTaken) {
        outcomes.bank = "conflict";
        reasons.push("bank_acct_belongs_to_other");
      } else if (wouldWrite && !complete) {
        // 人手揀「用導入值」唔齊 → 422；「身份確認」(confirm_id) 當 skip（其他欄照寫，銀行留 bank_review＋bank_incomplete）
        if (d === "confirm" || d === "replace") throw new ApiError(422, "unprocessable", "包內銀行資料四欄唔齊，唔可以寫入（唔准砌半套戶口）");
        outcomes.bank = "not_confirmed";
      } else if (wouldWrite) {
        data.bankCode = bank.code!.padStart(3, "0");
        data.bankName = nameDerived;
        data.bankAccountNo = bank.accountNo;
        data.bankPayeeName = bank.payee;
        outcomes.bank = "written";
      } else outcomes.bank = cmp.state === "same" ? "same" : "conflict";
    }
  }
  return { data: data as Prisma.GuardUncheckedUpdateInput, outcomes, reasons, overrides };
}

/**
 * 同 PATCH /api/guards/:id 一致：甲／乙到期日或出生日期有變，就重算 sia_permit_expiry／sia_permit_type
 * （用 merged 值；兩個到期日都空而之前亦空 → 唔寫，保留現有衍生值）。before=null＝新建。
 */
export function applyDerivedPermit(data: Prisma.GuardUncheckedUpdateInput, before: { a: Date | null; b: Date | null; dob: Date | null } | null): void {
  const d = data as Record<string, unknown>;
  if (!["siaPermitAExpiry", "siaPermitBExpiry", "dateOfBirth"].some((k) => k in d)) return;
  const merged = {
    siaPermitAExpiry: "siaPermitAExpiry" in d ? (d.siaPermitAExpiry as Date | null) : before?.a ?? null,
    siaPermitBExpiry: "siaPermitBExpiry" in d ? (d.siaPermitBExpiry as Date | null) : before?.b ?? null,
    dateOfBirth: "dateOfBirth" in d ? (d.dateOfBirth as Date | null) : before?.dob ?? null,
  };
  const hadValueBefore = before != null && (before.a != null || before.b != null);
  if (canOverrideDerivedSiaPermit({ siaPermitAExpiry: merged.siaPermitAExpiry, siaPermitBExpiry: merged.siaPermitBExpiry, hadValueBefore })) {
    const derived = deriveSiaPermitExpiry(merged);
    d.siaPermitExpiry = derived.siaPermitExpiry;
    d.siaPermitType = derived.siaPermitType;
  }
}

export interface ExtRelationResult {
  outcomes: Record<string, ExtOutcome>;
  contactsAdded: number;
  hiresWritten: number;
  overrides: number;
}

/** 緊急聯絡人（guard_emergency_contacts）＋逐工號入職日期（guard_staff_numbers.valid_from）。 */
export async function applyExtRelations(
  tx: Tx,
  args: { guardId: string; p: PackagePerson; snap: GuardExtSnap | null; dec: ExtDecisions | undefined; caps: ExtCaps; actorUserId: string; audit: AuditFn; gate?: ExtGate },
): Promise<ExtRelationResult> {
  const { guardId, p, snap, dec, caps, actorUserId, audit } = args;
  const gate = args.gate ?? OPEN_GATE;
  const outcomes: Record<string, ExtOutcome> = {};
  let contactsAdded = 0;
  let hiresWritten = 0;
  let overrides = 0;

  // --- 緊急聯絡人 ---
  const existing = snap?.contacts ?? [];
  const added: { name: string | null; tel: string | null }[] = [];
  for (const c of contactsOf(p)) {
    const key = `emergency.${c.slot}`;
    const d = dec?.[key];
    const w = wants(d, c.status);
    if (w === "skip") {
      outcomes[key] = "skipped";
      continue;
    }
    if (w === "not_confirmed") {
      outcomes[key] = "not_confirmed";
      continue;
    }
    // 人手決定（confirm／replace）寫完整值；自動寫入只寫 confirmed 嘅欄
    const useFull = isGoDecision(d);
    if (!gate.scalars) {
      if (!useFull) {
        outcomes[key] = "held";
        continue;
      }
      overrides += 1;
    }
    // 覆蓋權：已有聯絡人嘅安員再加一位＝加 PII，deny 與否喺比較「之前」決定（只睇現有聯絡人係咪非空）
    if (useFull && existing.length > 0 && caps.canOverwritePii === false) deny(PII_OVERWRITE_DENIED_MSG);
    const wName = useFull ? c.full.name : c.name;
    const wTel = useFull ? c.full.tel : c.tel;
    const wRel = useFull ? c.full.relationship : c.relationship;
    const row = { name: wName, tel: wTel };
    // 同一個聯絡人欄位值衝突（同電話唔同名／同名唔同電話）：人手揀 confirm／replace＝加為另一位（要個人資料 update 權；先查權限，唔理新值同現值）
    const partial = existing.some((x) => partialContact(x, row));
    if (existing.some((x) => sameContact(x, row)) || added.some((x) => sameContact(x, row))) {
      outcomes[key] = "same";
      continue;
    }
    if (partial && !useFull) {
      outcomes[key] = "conflict";
      continue;
    }
    if (caps.fillOnlyPii && existing.length > 0) {
      outcomes[key] = "conflict"; // 冇 PII view：已有聯絡人就唔加（projection 之後同 same 睇落一樣）
      continue;
    }
    const created = await createGuardEmergencyContact(tx, { guardId, name: wName, tel: wTel, relationship: wRel, source: "staff_fields_import", createdBy: actorUserId });
    await audit({ tableName: "guard_emergency_contacts", rowId: created.id, action: "create", after: created }, !gate.scalars && useFull);
    added.push(row);
    contactsAdded += 1;
    outcomes[key] = "written";
  }
  if (contactsAdded > 0) await syncLegacyGuardContactColumns(tx, guardId, ["emergency"]);

  // --- 逐工號入職日期：只補 valid_from 空嘅行 ---
  for (const h of staffHiresOf(p)) {
    const key = `staffHire.${h.number}`;
    const d = dec?.[key];
    const w = wants(d, h.status);
    if (w === "skip") {
      outcomes[key] = "skipped";
      continue;
    }
    if (w === "not_confirmed") {
      outcomes[key] = "not_confirmed";
      continue;
    }
    if (!gate.scalars) {
      if (!isGoDecision(d)) {
        outcomes[key] = "held";
        continue;
      }
      overrides += 1;
    }
    const row = await tx.guardStaffNumber.findUnique({ where: { number: h.number } });
    if (!row || row.guardId !== guardId) {
      outcomes[key] = "not_written"; // 工號冇加到（屬另一人／格式唔合法）→ 入職日期唔寫
      continue;
    }
    const cur = row.validFrom ? row.validFrom.toISOString().slice(0, 10) : null;
    if (d === "replace" && cur && caps.canEditGuard === false) deny(PII_OVERWRITE_DENIED_MSG);
    if (cur === h.value) outcomes[key] = "same";
    else if (!cur || d === "replace") {
      const after = await tx.guardStaffNumber.update({ where: { id: row.id }, data: { validFrom: isoToDate(h.value) } });
      await audit({ tableName: "guard_staff_numbers", rowId: row.id, action: "update", before: row, after }, !gate.scalars && isGoDecision(d));
      hiresWritten += 1;
      outcomes[key] = "written";
    } else outcomes[key] = "conflict";
  }
  return { outcomes, contactsAdded, hiresWritten, overrides };
}
