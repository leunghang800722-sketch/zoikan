// WP-STAFF-IMPORT B3：導入配對用嘅小工具（純函數）。同 scripts/staff-import/lib/{compare,text}.ts
// 嘅 normZh／normTel／editDistance 同一個定義（scripts 嗰邊係 Stage A 抽取用，唔入 src）。

export function normZh(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.normalize("NFC").replace(/[\s()（）·．.,，、-]/g, "");
  return /[一-鿿]/.test(t) ? t : null;
}

/** 8 位香港電話；唔係 8 位（去 852 前綴後）就 null。 */
export function normTel8(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, "");
  const t = d.length > 8 && d.startsWith("852") ? d.slice(3) : d;
  return /^\d{8}$/.test(t) ? t : null;
}

export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

/** 地址比對用：NFKC、去空白／標點、大寫。 */
export function normAddress(s: string | null | undefined): string {
  return (s ?? "").normalize("NFKC").toUpperCase().replace(/[\s,，.。、\-()（）]/g, "");
}

/** 遮罩：身份證淨顯示頭 1 尾 2（A*****63）。 */
export function maskHkidImport(canon: string | null | undefined): string | null {
  if (!canon) return null;
  if (canon.length <= 3) return "***";
  return `${canon[0]}${"*".repeat(canon.length - 3)}${canon.slice(-2)}`;
}

/** 遮罩：電話淨顯示尾 3 位。 */
export function maskTelImport(tel: string | null | undefined): string | null {
  if (!tel) return null;
  const d = tel.replace(/\D/g, "");
  if (d.length <= 3) return "***";
  return `${"*".repeat(d.length - 3)}${d.slice(-3)}`;
}

/** 遮罩：地址淨顯示頭 3 個字，餘下以 … 代替。 */
export function maskAddressImport(addr: string | null | undefined): string | null {
  const a = (addr ?? "").trim();
  if (!a) return null;
  return a.length <= 3 ? "***" : `${a.slice(0, 3)}…`;
}

/** 出生日期：YYYY-MM-DD，parse 後 round-trip 對返原字串（1980-02-30 拒絕），年份 1930–(今年−16)。唔合法＝null。 */
export function parseBirthDate(s: string | null | undefined, now: Date = new Date()): Date | null {
  const v = (s ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return null;
  const y = d.getUTCFullYear();
  if (y < 1930 || y > now.getUTCFullYear() - 16) return null;
  return d;
}
