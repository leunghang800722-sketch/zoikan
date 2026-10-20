// SITE-SCHEME-1：盤工號體系（sites.staff_scheme）預設建議——老闆唔想逐個盤揀。
// 規則（純函數）：客戶名／客戶組／盤名／別名任何一個（大小寫、全半形唔分）含 "wilson" 或 "威信" → U；否則 MP。
// LINK 盤（guards_paid_by_client）照樣按客戶判（LINK 係 Wilson 旗下 → 客戶含 Wilson 就係 U）。已設 staff_scheme 嘅盤唔動（回 null）。
export interface PrefillSiteLike {
  canonicalName: string;
  clientName?: string | null;
  clientGroup?: string | null;
  aliases?: readonly string[] | null;
  staffScheme?: string | null;
  guardsPaidByClient?: boolean | null;
}

export interface SchemeProposal {
  scheme: "U" | "MP";
  /** 命中咗邊個欄（client_name／client_group／canonical_name／aliases）；MP＝null */
  matchedField: "client_name" | "client_group" | "canonical_name" | "aliases" | null;
  reason: string;
}

const WILSON_RE = /wilson|威信/;
const norm = (s: string | null | undefined): string => (s ?? "").normalize("NFKC").toLowerCase();

export function proposeStaffScheme(site: PrefillSiteLike): SchemeProposal | null {
  if (site.staffScheme) return null; // 已設定：唔動
  const fields: Array<[SchemeProposal["matchedField"], string]> = [
    ["client_name", norm(site.clientName)],
    ["client_group", norm(site.clientGroup)],
    ["canonical_name", norm(site.canonicalName)],
    ["aliases", (site.aliases ?? []).map(norm).join("\n")],
  ];
  for (const [field, text] of fields) {
    if (WILSON_RE.test(text)) {
      const link = site.guardsPaidByClient ? "（LINK 盤，Wilson 旗下）" : "";
      return { scheme: "U", matchedField: field, reason: `${FIELD_LABEL[field!]}含 Wilson／威信${link} → U` };
    }
  }
  return { scheme: "MP", matchedField: null, reason: "客戶／盤名／別名冇 Wilson／威信 → MP" };
}

const FIELD_LABEL: Record<NonNullable<SchemeProposal["matchedField"]>, string> = {
  client_name: "客戶名",
  client_group: "客戶組",
  canonical_name: "盤名",
  aliases: "別名",
};
