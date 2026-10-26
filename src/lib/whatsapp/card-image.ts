// WA-8 B：工卡相前處理（sharp 可選：冇 sharp 就原圖照用，只係唔縮圖／唔轉 PNG）。圖只喺記憶體。
//  - 模型用：自動旋轉＋長邊 ≤ maxEdge（預設 1000，token 同成本直接相關）→ JPEG data URL。
//  - tesseract 用：自動旋轉、放大到長邊 1600、灰階＋正規化＋二值化 → PNG。
type SharpFn = (input: Buffer) => {
  rotate(): ReturnType<SharpFn>;
  resize(o: Record<string, unknown>): ReturnType<SharpFn>;
  grayscale(): ReturnType<SharpFn>;
  normalise(): ReturnType<SharpFn>;
  sharpen(): ReturnType<SharpFn>;
  threshold(n: number): ReturnType<SharpFn>;
  jpeg(o: Record<string, unknown>): ReturnType<SharpFn>;
  png(): ReturnType<SharpFn>;
  extract(r: { left: number; top: number; width: number; height: number }): ReturnType<SharpFn>;
  metadata(): Promise<{ width?: number; height?: number }>;
  toBuffer(): Promise<Buffer>;
};

let cached: SharpFn | null | undefined;
async function sharp(): Promise<SharpFn | null> {
  if (cached !== undefined) return cached;
  try {
    const name = "sharp"; // 變數 import：sharp 係 next 嘅可選 peer，唔入 package.json；冇就降級
    const m = (await import(/* webpackIgnore: true */ name)) as { default?: SharpFn };
    cached = (m.default ?? (m as unknown as SharpFn)) as SharpFn;
  } catch {
    cached = null;
  }
  return cached;
}

export const isJpeg = (b: Uint8Array): boolean => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/** 模型用 JPEG data URL（長邊 ≤ maxEdge）；冇 sharp 且原圖唔係 JPEG → null。 */
export async function modelImageDataUrl(bytes: Buffer, maxEdge = 1000): Promise<string | null> {
  const s = await sharp();
  if (s) {
    try {
      const out = await s(bytes).rotate().resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
      return `data:image/jpeg;base64,${out.toString("base64")}`;
    } catch {
      return isJpeg(bytes) ? `data:image/jpeg;base64,${bytes.toString("base64")}` : null;
    }
  }
  return isJpeg(bytes) ? `data:image/jpeg;base64,${bytes.toString("base64")}` : null;
}

/** tesseract 用前處理圖（PNG）；冇 sharp → 原圖。 */
export async function ocrPreprocessed(bytes: Buffer, mode: "gray" | "binary" = "gray"): Promise<Buffer> {
  const s = await sharp();
  if (!s) return bytes;
  try {
    let p = s(bytes).rotate().resize({ width: 1600, height: 1600, fit: "inside" }).grayscale().normalise().sharpen();
    if (mode === "binary") p = p.threshold(140);
    return await p.png().toBuffer();
  } catch {
    return bytes;
  }
}

export async function imageSize(bytes: Buffer): Promise<{ width: number; height: number } | null> {
  const s = await sharp();
  if (!s) return null;
  try {
    const m = await s(bytes).metadata();
    return m.width && m.height ? { width: m.width, height: m.height } : null;
  } catch {
    return null;
  }
}
