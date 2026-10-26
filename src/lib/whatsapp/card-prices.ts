// WA-8：工卡辨識單價（env，唔寫死）。metrics 同 bench 共用。零依賴。
/** WA-8：每百萬 token 單價（USD），env `WA_CARD_PRICE_USD_PER_MTOK`＝JSON `{"deepseek":{"in":0.3,"out":0.5},"haiku":{"in":0.1,"out":0.5},"qwen":{…},"claude":{…}}`；冇設／壞 JSON＝空（成本顯示 —）。 */
export function waCardPrices(): Record<string, { in: number; out: number }> {
  try {
    const raw = process.env.WA_CARD_PRICE_USD_PER_MTOK;
    if (!raw) return {};
    const j = JSON.parse(raw) as Record<string, { in?: unknown; out?: unknown }>;
    const out: Record<string, { in: number; out: number }> = {};
    for (const [k, v] of Object.entries(j)) if (v && typeof v.in === "number" && typeof v.out === "number" && v.in >= 0 && v.out >= 0) out[k] = { in: v.in, out: v.out };
    return out;
  } catch {
    return {};
  }
}

