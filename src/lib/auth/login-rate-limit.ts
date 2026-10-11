// P6.3（H8）：登入限速——process 內 token bucket。
//   - 每個 IP：容量 10、每分鐘補 10 個 token；只有「失敗」嘅登入先扣 token
//     （成功登入唔扣，免得同一 IP 後面好多同事／e2e 連續登入被誤擋）。token
//     用晒（<1）之後嗰個 IP 嘅登入請求一律 429＋Retry-After，唔會再驗密碼。
//   - 全局：容量 300、每分鐘補 300 個 token，每個登入請求（唔論成敗）扣 1，
//     防止分散 IP 嘅 bcrypt 耗 CPU。
//   - 冇 IP（getClientIp 回 null——本機直連／測試）→ 跳過每 IP 限速，淨係
//     計全局；帳號層面嘅鎖定（原子計數，見 login route）照樣有效。
// 限制（寫明）：(1) 狀態喺 process 記憶體，多 instance／重啟會各自計、重啟清零；
// 要跨 instance 要搬去 DB／Redis。(2) IP 取自 X-Forwarded-For 第一段
// （getClientIp，同 audit 一致）——未有可信 proxy 嘅環境可被偽造；部署喺
// Zeabur 由平台 proxy 加 header 嘅情況下先可靠。
interface Bucket {
  tokens: number;
  updatedAt: number;
}

const IP_CAPACITY = 10;
const IP_REFILL_PER_MS = 10 / 60_000;
const GLOBAL_CAPACITY = 300;
const GLOBAL_REFILL_PER_MS = 300 / 60_000;
const MAX_TRACKED_IPS = 10_000;

const ipBuckets = new Map<string, Bucket>();
let globalBucket: Bucket = { tokens: GLOBAL_CAPACITY, updatedAt: Date.now() };

function refill(b: Bucket, capacity: number, perMs: number, now: number): void {
  b.tokens = Math.min(capacity, b.tokens + (now - b.updatedAt) * perMs);
  b.updatedAt = now;
}

function ipBucket(ip: string, now: number): Bucket {
  let b = ipBuckets.get(ip);
  if (!b) {
    if (ipBuckets.size >= MAX_TRACKED_IPS) {
      // 清走已補滿嘅（冇封鎖作用嘅）舊記錄
      for (const [k, v] of ipBuckets) {
        refill(v, IP_CAPACITY, IP_REFILL_PER_MS, now);
        if (v.tokens >= IP_CAPACITY) ipBuckets.delete(k);
      }
      if (ipBuckets.size >= MAX_TRACKED_IPS) ipBuckets.clear();
    }
    b = { tokens: IP_CAPACITY, updatedAt: now };
    ipBuckets.set(ip, b);
  }
  return b;
}

export type LoginGate = { ok: true } | { ok: false; retryAfterSeconds: number };

/** 每個登入請求開頭 call：扣全局 token，並檢查呢個 IP 嘅失敗 token 夠唔夠。 */
export function checkLoginAllowed(ip: string | null, now = Date.now()): LoginGate {
  refill(globalBucket, GLOBAL_CAPACITY, GLOBAL_REFILL_PER_MS, now);
  if (globalBucket.tokens < 1) {
    return { ok: false, retryAfterSeconds: Math.ceil((1 - globalBucket.tokens) / GLOBAL_REFILL_PER_MS / 1000) };
  }
  if (ip) {
    const b = ipBucket(ip, now);
    refill(b, IP_CAPACITY, IP_REFILL_PER_MS, now);
    if (b.tokens < 1) return { ok: false, retryAfterSeconds: Math.ceil((1 - b.tokens) / IP_REFILL_PER_MS / 1000) };
  }
  globalBucket.tokens -= 1;
  return { ok: true };
}

/** 登入失敗（密碼錯／未註冊／鎖定中）時 call：扣呢個 IP 一個 token。 */
export function recordLoginFailure(ip: string | null, now = Date.now()): void {
  if (!ip) return;
  const b = ipBucket(ip, now);
  refill(b, IP_CAPACITY, IP_REFILL_PER_MS, now);
  b.tokens = Math.max(0, b.tokens - 1);
}

/** 測試用：清晒狀態。 */
export function resetLoginRateLimit(): void {
  ipBuckets.clear();
  globalBucket = { tokens: GLOBAL_CAPACITY, updatedAt: Date.now() };
}
