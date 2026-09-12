"use client";
import { useState } from "react";
import { apiPost } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Field, inputCls, btnPrimary } from "@/components/ui/Field";

export default function ChangePasswordPage() {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setMessage(null);
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
  }

  return (
    <div className="max-w-md space-y-4">
      <h1 className="text-lg font-semibold text-gray-900">改密碼</h1>
      <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <Banner kind={message?.kind ?? "info"} message={message?.text ?? null} />
        <Field label="舊密碼">
          <input
            type="password"
            className={inputCls}
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Field label="新密碼" hint="管理角色（老闆/主管/會計）要求至少 8 字符，含字母同數字">
          <input
            type="password"
            className={inputCls}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <button type="submit" disabled={loading} className={btnPrimary}>
          {loading ? "更新中…" : "更新密碼"}
        </button>
      </form>
    </div>
  );
}
