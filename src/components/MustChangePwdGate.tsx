"use client";
// D-P1-1：users.must_change_pwd=true（seed 隨機初始密碼／管理員重設）嘅用戶，
// 除咗改密碼頁之外任何頁面都即刻轉去 /change-password。Server layout 冇
// pathname，所以用 client component 做 redirect；P6.4 起 API 層亦強制
//（requireSession：must_change_pwd 只准 change-password／logout／refresh，其餘 403），
// 呢個 component 負責 UI 轉頁。
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

export function MustChangePwdGate({ mustChange }: { mustChange: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (mustChange && pathname !== "/change-password") router.replace("/change-password");
  }, [mustChange, pathname, router]);
  if (mustChange && pathname !== "/change-password") {
    return <div className="p-6 text-sm text-zk-text-secondary">首次登入，請先設定新密碼……</div>;
  }
  return null;
}
