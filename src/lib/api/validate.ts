// Opus 驗收殘留4：每個 route 經 zod schema 驗證 body，非法 enum／日期
// 一律 400（見 schemas.ts）。
import type { ZodType } from "zod";
import { BadRequest } from "./errors";

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw BadRequest(`輸入驗證失敗：${issues}`);
  }
  return result.data;
}
