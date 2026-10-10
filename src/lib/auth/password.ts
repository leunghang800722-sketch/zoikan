// 密碼 hashing——用 bcryptjs（純 JS，冇 native binding，喺呢部冇 Postgres/
// Docker、只用 embedded-postgres 嘅開發機同 CI sandbox 都保證裝得到；
// argon2 要編譯 native addon，喺呢類受限環境有裝唔到嘅風險，所以揀 bcryptjs
// ——呢個係 WP2 規劃要求嘅「揀一個簡單穩陣」嘅執行裁定，見 WP2 回報）。
import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// 強密碼要求：管理角色（老闆／主管／會計——即有機會掂到價目/糧務嘅角色）
// 強制；雞頭／保安員（P1 冇保安員登入）用較寬鬆規則。
// 規則：≥8 字符、至少一個字母、至少一個數字（唔強制符號，遷就老闆/主管
// 用手機打字嘅現實，但長度同「唔可以淨數字/淨字母」已經排走最弱嘅密碼）。
export function isStrongPassword(plain: string): boolean {
  if (plain.length < 8) return false;
  if (!/[a-zA-Z]/.test(plain)) return false;
  if (!/[0-9]/.test(plain)) return false;
  return true;
}

const ADMIN_ROLE_NAMES = new Set(["老闆", "主管", "會計"]);

export function requiresStrongPassword(roleName: string): boolean {
  return ADMIN_ROLE_NAMES.has(roleName);
}
