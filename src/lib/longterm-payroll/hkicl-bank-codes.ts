// WP-BOSS5 §25.4（老闆 2026-09-28 決定 6）：BOCHK Payroll Editor 要
// 「員工賬戶銀行編號 Employee A/C Bank Code」呢欄——3 位 HKICL（Hong Kong
// Interbank Clearing Limited）清算銀行編號。呢個檔**淨係俾安員抽屜銀行
// 區起一個「建議下拉」**（常見銀行名 → 編號），**唔會自動填** `bank_
// code`——會計揀完先由前端寫入 `guards.bank_code`，`bank_name`（自由
// 文字）唔可以反推呢個對照（見 §25.4 任務書：「唔准憑 bank_name 自動填」）。
//
// 逐個核實：本表全部抄自 HKICL 官方清算銀行編號清單（透過香港特區政府
// 社會福利署 wfsfaa.gov.hk 轉載嘅 PDF《Bank Code List (sorted by bank
// code)》，頁尾註明 "Source of Data : Hong Kong Interbank Clearing Ltd.
// (data as at 20.5.2026) (Website: http://www.hkicl.com.hk)"，
// https://www.wfsfaa.gov.hk/sfo/pdf/common/Form/tsfs/bank_code.pdf）—
// —2026-09-28 逐個銀行名／編號對住嗰份 PDF 核實過。清單淨係收錄香港
// 保安員日常會用嚟出糧嘅主流零售／商業銀行（含幾間虛擬銀行），**唔係
// 齊全嘅 HKICL 全部參與者**（PDF 仲有幾百間，包括投行／結算所／HKMA
// 各類特殊編號，同「幫會計揀員工銀行」呢個用途無關，冇抄入嚟）。**核實
// 唔到嘅（PDF 冇出現、或者名同編號對唔上）一律唔寫，唔准估**——如果
// 之後要加銀行，一定要重新對住官方清單核實先可以加呢個陣列。
export interface HkiclBankOption {
  /** 3 位 HKICL 清算銀行編號（`guards.bank_code` 要存嘅值）。 */
  code: string;
  /** 官方英文全名（同 PDF 逐字一致，方便會計核對）。 */
  nameEn: string;
  /** 常見中文簡稱（方便下拉搜尋／顯示，呢個唔係 HKICL 官方欄位，純粹
   * UI 用，冇喺 PDF 出現，係坊間通用叫法）。 */
  nameZhShort: string;
}

export const HKICL_BANK_OPTIONS: readonly HkiclBankOption[] = [
  { code: "003", nameEn: "Standard Chartered Bank (Hong Kong) Limited", nameZhShort: "渣打銀行" },
  { code: "004", nameEn: "The Hongkong and Shanghai Banking Corporation Limited", nameZhShort: "匯豐銀行" },
  { code: "006", nameEn: "Citibank, N.A.", nameZhShort: "花旗銀行" },
  { code: "009", nameEn: "China Construction Bank (Asia) Corporation Limited", nameZhShort: "中國建設銀行（亞洲）" },
  { code: "012", nameEn: "Bank of China (Hong Kong) Limited", nameZhShort: "中國銀行（香港）" },
  { code: "015", nameEn: "The Bank of East Asia, Ltd.", nameZhShort: "東亞銀行" },
  { code: "016", nameEn: "DBS Bank (Hong Kong) Limited", nameZhShort: "星展銀行" },
  { code: "018", nameEn: "China CITIC Bank International Limited", nameZhShort: "中信銀行國際" },
  { code: "020", nameEn: "CMB Wing Lung Bank Limited", nameZhShort: "招商永隆銀行" },
  { code: "024", nameEn: "Hang Seng Bank Limited", nameZhShort: "恒生銀行" },
  { code: "025", nameEn: "Shanghai Commercial Bank Limited", nameZhShort: "上海商業銀行" },
  { code: "027", nameEn: "Bank of Communications Co., Ltd.", nameZhShort: "交通銀行" },
  { code: "028", nameEn: "Public Bank (Hong Kong) Limited", nameZhShort: "大眾銀行（香港）" },
  { code: "035", nameEn: "OCBC Bank (Hong Kong) Limited", nameZhShort: "華僑永亨銀行" },
  { code: "039", nameEn: "Chiyu Banking Corporation Limited", nameZhShort: "集友銀行" },
  { code: "040", nameEn: "Dah Sing Bank, Ltd.", nameZhShort: "大新銀行" },
  { code: "041", nameEn: "Chong Hing Bank Limited", nameZhShort: "創興銀行" },
  { code: "043", nameEn: "Nanyang Commercial Bank Limited", nameZhShort: "南洋商業銀行" },
  { code: "072", nameEn: "Industrial and Commercial Bank of China (Asia) Limited", nameZhShort: "中國工商銀行（亞洲）" },
  { code: "128", nameEn: "Fubon Bank (Hong Kong) Limited", nameZhShort: "富邦銀行（香港）" },
  { code: "382", nameEn: "Bank of Communications (Hong Kong) Limited", nameZhShort: "交通銀行（香港）" },
  { code: "387", nameEn: "ZA Bank Limited", nameZhShort: "眾安銀行" },
  { code: "388", nameEn: "Livi Bank Limited", nameZhShort: "livi 銀行" },
  { code: "389", nameEn: "Mox Bank Limited", nameZhShort: "Mox 銀行" },
  { code: "390", nameEn: "Welab Bank Limited", nameZhShort: "匯立銀行" },
  { code: "391", nameEn: "Fusion Bank Limited", nameZhShort: "富融銀行" },
  { code: "393", nameEn: "Ant Bank (Hong Kong) Limited", nameZhShort: "螞蟻銀行（香港）" },
];

/** 逐個 HKICL 編號 Set，俾寫入／匯出嗰陣做「呢個 3 位碼係咪已核實過嘅
 * 已知銀行」防呆檢查用（唔係話冇喺呢個表就唔准填——`bank_code` 冇綁死
 * 呢個列表，會計都可以直接打呢個表冇收錄但仍然啱嘅 HKICL 編號；呢個
 * 表純粹係「建議下拉」，唔係白名單）。 */
export const HKICL_BANK_CODE_SET: ReadonlySet<string> = new Set(HKICL_BANK_OPTIONS.map((b) => b.code));
