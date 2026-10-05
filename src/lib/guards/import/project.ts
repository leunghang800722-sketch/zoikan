// WP-AI-OPS 驗收（第三輪）：冇「安員個人資料:view」讀者嘅**唯一**投影函數。
// 原則：先遮罩逐行結果，再由遮罩後嘅 rows／results 重新彙總——唔准直接回由未遮罩資料計出嚟嘅數，
// 否則頂層計數（field_conflicts 等）會反映「估啱／估錯現有出生日期、地址、電話、英文名」。
// preview、apply（包括帶 decisions）都經呢度；分診 impact 用同一套規則（src/lib/triage/view.ts）。
import type { ApplyResult, PersonResult, PreviewResult, PreviewRow } from "./apply";
import type { PersonField } from "./package";
import { sameNameStrict } from "./text";
import { aggregateExt, isBankKey, isEmergencyKey, maskExtChecks, type ExtItem } from "./ext";
import { summarizeExt } from "./apply";

/** 讀者權限：pii＝「安員個人資料:view」；bank＝「安員銀行資料:view」。 */
export interface ProjectionViewer {
  pii: boolean;
  bank: boolean;
}

/** 「現值 vs 新值」比較會洩露現有資料嘅欄（hkid／出生日期／電話／地址／英文名／中文名）。 */
const COMPARED: PersonField[] = ["hkid", "dateOfBirth", "phone", "address", "nameEn", "nameZh"];
/** 呢幾個 check 值代表「現有欄位非空」——要遮；`fill`（現有係空）同 `new` 唔洩露比較結果，保留。 */
const HIDDEN_CHECKS = new Set(["same", "differs", "conflict"]);
/** 淨洩露「姓名同現有安員唔同」嘅 reason code（已有 current_name_hidden 旗，唔再重複）。 */
export const NAME_REASONS = new Set(["name_differs_from_guard"]);

function basisCategory(b: string): string {
  return b === "hkid" || b === "staff_no" || b === "tel" ? "identity_key" : b.startsWith("name") ? "name" : b;
}

function maskCurrentNames(r: PreviewRow): Pick<PreviewRow, "current_name_zh" | "current_name_en" | "current_name_hidden"> {
  if (!r.current_name_zh) return { current_name_zh: null, current_name_en: null, current_name_hidden: false };
  if (sameNameStrict(r.current_name_zh, r.name_zh)) return { current_name_zh: r.current_name_zh, current_name_en: r.current_name_en, current_name_hidden: false };
  return { current_name_zh: null, current_name_en: null, current_name_hidden: true };
}

function maskRow(r: PreviewRow, v: ProjectionViewer): PreviewRow {
  const extItems: ExtItem[] | null = r.ext ? r.ext.map((x) => ({ key: x.key, status: x.status as ExtItem["status"], check: x.check as ExtItem["check"] })) : null;
  const maskedExt = extItems ? maskExtChecks(extItems, { pii: v.pii, bank: v.bank }) : null;
  return {
    ...r,
    ...(maskedExt ? { ext: maskedExt.map((i) => ({ key: i.key, status: i.status, check: i.check })) } : {}),
    // 冇「安員銀行資料:view」：銀行戶口連尾 4 位都唔回（淨係話「有銀行資料」）
    ...(r.bank_masked && !v.bank ? { bank_masked: { present: true as const } } : {}),
    ...maskCurrentNames(r),
    basis: r.basis.map(basisCategory).filter((x, i, a) => a.indexOf(x) === i),
    reasons: r.reasons.filter((x) => !NAME_REASONS.has(x)),
    fields: Object.fromEntries(
      Object.entries(r.fields).map(([f, v]) => [f, COMPARED.includes(f as PersonField) && HIDDEN_CHECKS.has(v.check) ? { ...v, check: "hidden" } : v]),
    ) as PreviewRow["fields"],
  };
}

function extAggregateOf(rows: readonly PreviewRow[]): { ext_stats: ReturnType<typeof aggregateExt> } | Record<string, never> {
  if (!rows.some((r) => r.ext)) return {};
  return {
    ext_stats: aggregateExt(
      rows.filter((r) => r.auto_apply && r.ext).map((r) => r.ext!.map((x) => ({ key: x.key, status: x.status as ExtItem["status"], check: x.check as ExtItem["check"] }))),
    ),
  };
}

export function projectPreviewForViewer(p: PreviewResult, viewer: ProjectionViewer): PreviewResult {
  if (viewer.pii && viewer.bank) return p;
  const pii = viewer.pii;
  const rows = p.rows.map((r) => maskRow(r, viewer));
  if (pii) {
    // 有 PII view、冇銀行 view：只重算新欄彙總（PII 彙總照原樣）
    const { ext_stats: _drop, ...rest } = p;
    void _drop;
    return { ...rest, rows, ...extAggregateOf(rows) };
  }
  const applicable = rows.filter((r) => r.auto_apply);
  const create = applicable.filter((r) => r.action === "create");
  const confirmed = (r: PreviewRow, f: PersonField) => r.fields[f]?.status === "confirmed";
  const check = (r: PreviewRow, f: PersonField) => r.fields[f]?.check;
  const reason_counts: Record<string, number> = {};
  for (const r of rows) for (const x of r.reasons) reason_counts[x] = (reason_counts[x] ?? 0) + 1;
  return {
    ...p,
    counts_hidden: true,
    rows,
    reason_counts,
    auto_apply: {
      persons: applicable.length,
      guards_to_create: create.length,
      // 只計唔依賴「新值 vs 現值」比較嘅：新建人嘅欄、同現有欄位係空（fill）
      guard_fields_to_fill:
        create.reduce((n, r) => n + (["nameEn", "dateOfBirth"] as const).filter((f) => confirmed(r, f) && check(r, f) === "new").length, 0) +
        applicable.filter((r) => r.action === "link").reduce((n, r) => n + (["hkid", "nameEn", "dateOfBirth"] as const).filter((f) => confirmed(r, f) && check(r, f) === "fill").length, 0),
      phones_to_add: applicable.filter((r) => confirmed(r, "phone") && (check(r, "phone") === "new" || check(r, "phone") === "fill")).length,
      addresses_to_add: applicable.filter((r) => confirmed(r, "address") && (check(r, "address") === "new" || check(r, "address") === "fill")).length,
      staff_numbers_to_add: p.auto_apply.staff_numbers_to_add,
      field_conflicts: 0,
    },
    ...extAggregateOf(rows),
  };
}

function maskResult(r: PersonResult, v: ProjectionViewer): PersonResult {
  return {
    ...r,
    ...(r.ext
      ? {
          ext: r.ext.map(({ key: k, outcome: o }) => ({ key: k, outcome: ((isBankKey(k) && !v.bank) || (isEmergencyKey(k) && !v.pii)) && (o === "same" || o === "conflict") ? ("not_written" as const) : o })),
        }
      : {}),
    reasons: r.reasons.filter((x) => !NAME_REASONS.has(x)),
    fields: Object.fromEntries(
      Object.entries(r.fields).map(([f, v]) => [f, COMPARED.includes(f as PersonField) && (v === "same" || v === "conflict") ? "not_written" : v]),
    ) as PersonResult["fields"],
  };
}

export function projectApplyForViewer(a: ApplyResult, viewer: ProjectionViewer): ApplyResult {
  if (viewer.pii && viewer.bank) return a;
  const results = a.results.map((r) => maskResult(r, viewer));
  const { ext_written: _w, ext_conflicts: _c, contacts_added: _n, ...rest } = a;
  void _w; void _c; void _n;
  const extSum = summarizeExt(results);
  if (viewer.pii) return { ...rest, ...extSum, results };
  const fields_written: Record<string, number> = {};
  for (const r of results) for (const [f, v] of Object.entries(r.fields)) if (v === "written") fields_written[f] = (fields_written[f] ?? 0) + 1;
  return { ...rest, ...extSum, counts_hidden: true, results, fields_written, field_conflicts: 0 };
}

export const maskPreviewForViewer = projectPreviewForViewer;
export const maskApplyForViewer = projectApplyForViewer;
