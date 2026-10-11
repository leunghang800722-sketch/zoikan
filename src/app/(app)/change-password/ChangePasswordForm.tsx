"use client";
// P2-C：改密碼表單本體（README §20）——卡 max-width 420px；頂資訊橫幅
// （藍，只喺首次登入強制改密碼時顯示）；舊密碼／新密碼（3 段強度條）／
// 確認新密碼；右對齊「取消」「更新密碼」。提交 API（POST
// /api/auth/change-password，body { old_password, new_password }）完全
// 不變。
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { apiPost } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Field, inputCls } from "@/components/ui/Field";
import { NotifySettings } from "@/components/NotifySettings";

// README「至少 8 位，建議加數字同英文」——3 段強度條，純顯示層提示，
// 唔係伺服器驗證（伺服器仍然用 `isStrongPassword()`/`requiresStrongPassword()`
// 把關，呢度只係俾用戶即時反饋）。
function passwordStrength(pw: string): 0 | 1 | 2 | 3 {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[0-9]/.test(pw) && /[a-zA-Z]/.test(pw)) score++;
  if (pw.length >= 12 || /[^a-zA-Z0-9]/.test(pw) || (/[a-z]/.test(pw) && /[A-Z]/.test(pw))) score++;
  return score as 0 | 1 | 2 | 3;
}

export function ChangePasswordForm({ mustChangePwd, notifyUserId }: { mustChangePwd: boolean; /** 有值＝顯示「通知電郵」設定（內部角色、非首次改密碼）。 */ notifyUserId?: string }) {
  const router = useRouter();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const strength = useMemo(() => passwordStrength(newPassword), [newPassword]);
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setMessage(null);
    if (newPassword !== confirmPassword) {
      setMessage({ kind: "error", text: "兩次輸入嘅新密碼唔一致" });
      return;
    }
    setLoading(true);
    const res = await apiPost("/api/auth/change-password", { old_password: oldPassword, new_password: newPassword });
    setLoading(false);
    if (!res.ok) {
      setMessage({ kind: "error", text: res.message });
      return;
    }
    setMessage({ kind: "success", text: "密碼已更新" });
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader kicker="帳號" title="改密碼" />
      <div className="flex w-full max-w-[420px] flex-col gap-3.5 rounded-[10px] border border-zk-border bg-white p-[22px]">
        {mustChangePwd && <Banner compact kind="info">首次登入請先設定新密碼。</Banner>}
        {message && <Banner compact kind={message.kind === "error" ? "error" : "info"}>{message.text}</Banner>}

        <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
          <Field label="舊密碼">
            <input
              type="password"
              className={inputCls}
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              autoComplete="current-password"
              data-testid="change-password-old"
              required
            />
          </Field>
          <label className="flex flex-col gap-1.5 text-zk-sm text-zk-text-secondary">
            新密碼
            <input
              type="password"
              className={inputCls}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              data-testid="change-password-new"
              required
            />
            <div className="mt-0.5 flex gap-1" data-testid="change-password-strength" data-strength={strength}>
              {[0, 1, 2].map((i) => (
                <span key={i} className="h-[3px] flex-1 rounded-sm" style={{ background: i < strength ? "var(--zk-success)" : "var(--zk-border)" }} />
              ))}
            </div>
            <span className="text-zk-xs text-zk-muted">至少 8 位，建議加數字同英文</span>
          </label>
          <Field label="確認新密碼">
            <input
              type="password"
              className={inputCls}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              data-testid="change-password-confirm"
              required
            />
            {mismatch && <span className="mt-1 block text-zk-xs text-zk-danger">兩次輸入嘅新密碼唔一致</span>}
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => router.push("/")}>
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={loading} data-testid="change-password-submit">
              {loading ? "更新中…" : "更新密碼"}
            </Button>
          </div>
        </form>
      </div>
      {notifyUserId && (
        <div className="flex w-full max-w-[420px] flex-col gap-3 rounded-[10px] border border-zk-border bg-white p-[22px]">
          <h2 className="text-zk-md font-semibold text-zk-text">通知電郵</h2>
          <NotifySettings userId={notifyUserId} />
        </div>
      )}
    </div>
  );
}
