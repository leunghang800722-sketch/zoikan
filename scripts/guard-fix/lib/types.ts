// WP-GUARD-FIX（老闆 2026-09-25 要求）：8 月更表「未配對安員」自動修復
// ——plan.json 嘅型別定義。呢個檔冇 DB 依賴，純粹型別，build-guard-fix-
// plan.ts／apply-guard-fix-plan.ts 共用，保證兩邊讀寫同一份契約。同
// scripts/opening/lib/types.ts 一致模式。
//
// 鐵則：呢個型別入面嘅 `nameZh`／`aliases`／`tel`／`hkid` 等 PII 只可以
// 出現喺 gitignored 嘅 `data/2026-09/guard-fix/plan.json`——`build-guard-
// fix-plan.ts` 印落 console／`plan-summary.md` 嘅嘢一律唔准帶呢啲值。

/** 一個「身份」（unmatched/ambiguous 嘅更表 staff_no_raw／name_raw／
 * tel_raw 組合）覆核之後嘅決定。`identityLabel` 純粹俾 plan.json 內部
 * 對照用（唔係識別碼意義上嘅敏感值，但都係姓名，一樣淨係存喺呢個
 * gitignored 檔案）。 */
export type GuardFixActionKind = "link" | "create" | "create_minimal" | "needs_boss";

export interface GuardFixCellRef {
  /** 盤名（`sites.canonical_name`，搵唔到就用檔內盤名原文）——plan-
   * summary 用嚟印「盤＋格數」，唔係 PII。 */
  siteLabel: string;
  /** 呢個身份喺呢個盤撞中幾多格 unmatched/ambiguous。 */
  cellCount: number;
}

export interface GuardFixIdentity {
  /** 內部序號（`I001` 咁樣），plan-summary／needs_hr／needs_boss 清單
   * 印呢個，唔印名——「盤＋格數＋原因」格式入面用嚟對得返 plan.json
   * 邊一項。 */
  seq: string;
  kind: "unmatched" | "ambiguous";
  staffNoRaw: string | null;
  nameRaw: string;
  telRaw: string | null;
  cells: GuardFixCellRef[];
  totalCellCount: number;
}

export interface LinkAction {
  type: "link";
  seq: string;
  guardId: string;
  /** 點解斷定係同一個人——plan-summary 唔印，plan.json 存底俾人覆核。 */
  reason: string;
  /** 冇 current 呢個號先加（冪等：apply 之前再查一次）。 */
  addStaffNumber: { scheme: string; number: string } | null;
  /** 冇喺 `name_aliases` 先加（唔可以等於本名）。 */
  addAlias: string | null;
}

export interface CreateAction {
  type: "create";
  seq: string;
  nameZh: string;
  /** 更表寫嘅姓名（同 `nameZh` 唔同先有值，起 guard 嗰陣一齊寫落
   * `name_aliases`）。 */
  alias: string | null;
  /** 名單電話做 primary；更表電話（如果唔同）做第二個。 */
  primaryTel: string | null;
  secondaryTel: string | null;
  hkid: string | null;
  hireDate: string | null; // YYYY-MM-DD
  uNumber: string | null; // scheme=U 嘅 number（可能冇——12 個冇 U 號用名單搵到嗰批）
  defaultBrokerCode: string;
  reason: string;
}

export interface CreateMinimalAction {
  type: "create_minimal";
  seq: string;
  nameZh: string;
  tel: string | null;
  defaultBrokerCode: string;
  reason: string;
}

export interface NeedsBossAction {
  type: "needs_boss";
  seq: string;
  reason: string;
  /** ambiguous 嗰陣嘅候選 guardId 清單（決定唔到，交老闆睇）。 */
  candidateGuardIds: string[];
}

export type GuardFixAction = LinkAction | CreateAction | CreateMinimalAction | NeedsBossAction;

export interface GuardFixPlan {
  generatedAt: string;
  /** 目標 DB（host:port/db，唔帶帳號密碼）——同 apply-aug-plan.ts
   * `describeDbTarget()` 一致做法。 */
  dbTarget: string;
  /** 呢次 build 嘅資料嚟源：`roster_upload_rows`（DB 實際 8 月上載）定
   * `records.jsonl` fallback（dev 冇上載嗰陣）。 */
  sourceMode: "db_rows" | "records_jsonl_fallback";
  identities: GuardFixIdentity[];
  actions: {
    link: LinkAction[];
    create: CreateAction[];
    createMinimal: CreateMinimalAction[];
    needsBoss: NeedsBossAction[];
  };
}
