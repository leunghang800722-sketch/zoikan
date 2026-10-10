"use client";
import { Button } from "@/components/ui/Button";
import { invalidateLookups } from "@/lib/ui/lookup-cache";
import { useState } from "react";
import { useRouter } from "next/navigation";

// WP-R1：新殼將呢個掣喺左欄／抽屜底部用文字連結樣式（README「底部用戶
// 區」），唔再係成粒 bordered button——但 `tests/e2e/helpers.ts` 嘅
// `logout()` 靠 `getByRole("button", { name: "登出" })` 揾佢，所以元素本身
// 同文字「登出」／「登出中…」唔可以變，淨係俾呼叫方傳 `className`
// 換皮。冇傳就用返原本 bordered button 樣（例如俾其他將來用途 fallback）。
export function LogoutButton({ className }: { className?: string } = {}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function onLogout() {
    if (loading) return;
    setLoading(true);
    try {
      invalidateLookups(); // 登出前後都清（驗收修正：cache 唔跨用戶殘留）
      await fetch("/api/auth/logout", { method: "POST" });
      invalidateLookups();
      try {
        window.sessionStorage.removeItem("zoikan-ai-conversation-cache"); // P3-2.8：登出清走側欄對話快取
      } catch {
        // 忽略
      }
      router.push("/login");
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={onLogout} disabled={loading} className={className ?? "w-full"}>
      {loading ? "登出中…" : "登出"}
    </Button>
  );
}
