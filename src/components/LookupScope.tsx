"use client";
// 驗收修正：(app)/layout 傳落當前用戶 id，令前端 lookup cache 綁用戶（見 src/lib/ui/lookup-cache.ts）。
import { setLookupScope } from "@/lib/ui/lookup-cache";

export function LookupScope({ userId }: { userId: string }) {
  setLookupScope(userId); // render 時同步設定，早過所有子頁 effect
  return null;
}
