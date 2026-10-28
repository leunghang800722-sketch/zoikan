// HIST-4：電話字串清理（純函數，冇 import）。更表／Excel／WhatsApp 複製貼上嘅電話常帶隱形 Unicode
// 字元（U+202C POP DIRECTIONAL FORMATTING、U+200B 零寬空格、U+FEFF BOM、NBSP U+00A0 等），
// 肉眼睇唔到但令格式驗證失敗。

/** NFKC（全形數字→半形、全形連字符→`-`）後剝走所有 Unicode Cc／Cf／Zs 同空白字元（`\s`）。
 * 唔剝連字符——由各 caller 自己決定（`normalizeTel` 另外剝 `-`）。 */
export function stripInvisibleChars(raw: string): string {
  return raw.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zs}\s]+/gu, "");
}
