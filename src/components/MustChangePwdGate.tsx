"use client";
// D-P1-1：users.must_change_pwd=true（seed 隨機初始密碼／管理員重設）嘅用戶，
// 除咗改密碼頁之外任何頁面都即刻轉去 /change-password。Server layout 冇
// pathname，所以用 client component 做 redirect；API 層本身唔受影響
//（權限照矩陣），呢個係 UI 強制流程。
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

export function MustChangePwdGate({ mustChange }: { mustChange: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (mustChange && pathname !== "/change-password") router.replace("/change-password");
  }, [mustChange, pathname, router]);
  if (mustChange && pathname !== "/change-password") {
    return <div className="p-6 text-sm text-gray-600">首次登入，請先設定新密碼……</div>;
  }
  return null;
}
