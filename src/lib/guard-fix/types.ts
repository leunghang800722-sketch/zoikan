// WP-GUARD-FIX（老闆 2026-09-25 要求）：8 月更表「未配對安員」自動修復
// ——plan.json 嘅型別定義。呢個檔冇 DB 依賴，純粹型別，build-guard-fix-
// plan.ts／apply.ts（舊 apply-guard-fix-plan.ts script 已刪）共用，保證兩邊讀寫同一份契約。同
// scripts/opening/lib/types.ts 一致模式。
//
// 鐵則：呢個型別入面嘅 `nameZh`／`aliases`／`tel`／`hkid` 等 PII 只可以
// 出現喺 gitignored 嘅 `data/2026-09/guard-fix/plan.json`——`build-guard-
// fix-plan.ts` 印落 console／`plan-summary.md` 嘅嘢一律唔准帶呢啲值。

/** 一個「身份」（unmatched/ambiguous 嘅更表 staff_no_raw／name_raw／
 * tel_raw 組合）覆核之後嘅決定。`identityLabel` 純粹俾 plan.json 內部
 * 對照用（唔係識別碼意義上嘅敏感值，但都係姓名，一樣淨係存喺呢個
 * gitignored 檔案）。 */
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
  /** 驗收（Opus 5.5，2026-09-26）：老闆指令「唔准留要老闆決定」——以前
   * needs_boss 嘅兩類改做保守預設（按更表姓名建獨立安員、cash_casual、
   * 無工號）：`conservative` 標明呢個係保守預設（待核），唔係名單／DB
   * 搵唔到嘅普通 needs_hr。`matchOverrideStaffNo`：更表工號屬 DB 另一位
   * 安員嘅情況，套用時順手寫 `guard_match_overrides`（呢個工號＋更表
   * 姓名 → 新安員），reparse 先配得返。optional：舊 plan.json 冇呢兩欄。 */
  conservative?: "staff_no_conflict" | "name_only_unverified";
  matchOverrideStaffNo?: string | null;
}

export interface NeedsBossAction {
  type: "needs_boss";
  seq: string;
  reason: string;
  /** 結構化原因碼（一鍵結算自動化用，唔靠 reason 字串）：staff_no_conflict＝工號衝突（工號屬另一人／同現有工號唔同）。 */
  code?: "staff_no_conflict" | "conflicting_methods" | "weak_evidence" | "ambiguous" | "other";
  /** ambiguous 嗰陣嘅候選 guardId 清單（決定唔到，交老闆睇）。 */
  candidateGuardIds: string[];
}

// -----------------------------------------------------------------------
// WP-LTSHIFT §19 交付 B：由 Postorder 上載解析嚟嘅四類計劃。同上面
// link/create 一樣「唔准估」——對唔到 guard／site／broker 就唔會出呢類
// action，留低 ≥50% 推算／保守 B07 fallback（見
// `src/lib/pricing/longterm-settlement.ts`）處理，唔喺呢度屈估。
// -----------------------------------------------------------------------

export interface SetLongtermAction {
  type: "set_longterm";
  seq: string;
  guardId: string;
  /** 呢個安員喺 Postorder 撞中幾多個「(8) 長工」格（跨盤合計）——
   * plan-summary 可以印（唔係 PII）。 */
  cellCount: number;
  /** 套用前嘅 employment_type（`cash_casual`先會被改；已經係
   * longterm_* 嘅唔使改，唔會出現喺呢個 action）。 */
  fromEmploymentType: string;
  reason: string;
}

export interface SetLongtermPostAction {
  type: "set_longterm_post";
  seq: string;
  guardId: string;
  siteId: string;
  /** plan-summary 用嘅盤名（唔係 PII）。 */
  siteLabel: string;
  cellCount: number;
  reason: string;
}

export interface SetReferralAction {
  type: "set_referral";
  seq: string;
  guardId: string;
  brokerId: string;
  /** plan-summary 用嘅雞頭代號（K/W/T/G…，唔係 PII）。 */
  brokerCode: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// WP-REFERRAL-FALLBACK（老闆 2026-09-26 緊急）：正式站從未上載過 Postorder
// .xlsm（淨係得 CSV，冇公式，`set_referral` 計唔到邊個長工），加一條唔靠
// Postorder 嘅自動規則——長工自己喺崗位盤嘅更表雞頭碼推返邊個雞頭供應
// （＝介紹）呢個長工，見 `src/lib/pricing/longterm-settlement.ts`
// `inferReferralBrokerFromRosters()`。**只對 `referral_broker_id IS NULL`
// 嘅長工**（Postorder xlsm 有明確資料就以 `set_referral` 為準，呢個
// action 唔會重複再出一次）。
// ---------------------------------------------------------------------------

export interface SetReferralInferredAction {
  type: "set_referral_inferred";
  seq: string;
  guardId: string;
  brokerId: string;
  /** plan-summary 用嘅雞頭代號（K/W/T/G…，唔係 PII）。 */
  brokerCode: string;
  /** 推算依據（自己崗位盤更表雞頭碼唯一／最多／broker_site_assignments／
   * 該盤其他行唯一）——plan-summary 唔印（有少少推算細節），plan.json
   * 存底俾人覆核。 */
  reason: string;
}

export interface SetVisaAction {
  type: "set_visa";
  seq: string;
  guardId: string;
  brokerId: string;
  brokerCode: string;
  reason: string;
}

export type GuardFixAction =
  | LinkAction
  | CreateAction
  | CreateMinimalAction
  | NeedsBossAction
  | SetLongtermAction
  | SetLongtermPostAction
  | SetReferralAction
  | SetReferralInferredAction
  | SetVisaAction;

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
    /** WP-LTSHIFT §19：冇 Postorder 上載就係空 array（唔影響 link/
     * create 嗰四類原有行為）。 */
    setLongterm: SetLongtermAction[];
    setLongtermPost: SetLongtermPostAction[];
    setReferral: SetReferralAction[];
    /** WP-REFERRAL-FALLBACK：唔靠 Postorder 嘅推算介紹雞頭（見
     * `SetReferralInferredAction`）——冇 Postorder 上載都會計。 */
    setReferralInferred: SetReferralInferredAction[];
    setVisa: SetVisaAction[];
  };
  /** `create` 入面幾多個 U Team 名單身份證欄唔係身份證格式、冇寫入
   * （要 HR 補）——唔係 PII 本身（淨係數目），plan-summary／頁面摘要卡
   * 都可以印。 */
  hkidDroppedCount: number;
  /** WP-LTSHIFT §19：呢次計劃有冇用到 Postorder 上載（同埋，如果有，
   * 佢自己嗰份 parse summary／警告——冇上載就 null）。 */
  postorder: {
    uploadId: string;
    fileName: string;
    longtermPostCellCount: number;
    referralRowCount: number;
    unresolvedSiteLabels: string[];
    unresolvedBrokerLabels: string[];
    visaSupported: boolean;
    visaNote: string;
    /** WP-POSTORDER-PO-PAIRS：單靠 PostOrder 分頁 CSV（`postorder.ts`
     * `derivePostorderLongtermPostsFromPostorderGrid()`）補推到幾多個
     * (盤,人) 組合——冇上載 PostOrder CSV，或者 xlsm 路徑（冇獨立 CSV
     * 原文）就係 0。呢個數已經計入 `longtermPostCellCount`／
     * `set_longterm_post`（見 `plan.ts` `mergeLongtermPostCells()`），
     * 淨係俾操作員睇透明度用。 */
    longtermPairsFromPostorderCount: number;
  } | null;
}
