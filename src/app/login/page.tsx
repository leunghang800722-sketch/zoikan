"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [tel, setTel] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tel, password }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string; user?: { must_change_pwd?: boolean } };
      if (!res.ok) {
        setError(body.message ?? "登入失敗");
        return;
      }
      router.push(body.user?.must_change_pwd ? "/change-password" : next);
      router.refresh();
    } catch {
      setError("網絡錯誤，請重試");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex w-full max-w-[380px] flex-col gap-5">
      <div className="flex items-center gap-2.5">
        <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-zk-primary text-base font-bold text-white">在</div>
        <div>
          <div className="text-lg font-bold text-zk-text">在勤</div>
          <div className="text-xs text-zk-muted">排更 · 對數 · 出糧</div>
        </div>
      </div>

      <form
        onSubmit={onSubmit}
        className="flex flex-col gap-3.5 rounded-xl border border-zk-border bg-white p-6 shadow-[0_1px_3px_rgba(0,0,0,.04)]"
      >
        <div className="text-base font-semibold text-zk-text">登入</div>

        {error && (
          <div className="flex items-center gap-2 text-[12.5px] text-[#b91c1c]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#dc2626]" />
            {error}
          </div>
        )}

        <label className="flex flex-col gap-1.5 text-[12.5px] text-zk-text-secondary" htmlFor="tel">
          電話
          <input
            id="tel"
            value={tel}
            onChange={(e) => setTel(e.target.value)}
            className={`rounded-lg border px-3 py-2.5 text-sm text-zk-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/30 ${
              error ? "border-[#dc2626] shadow-[0_0_0_3px_rgba(220,38,38,.08)]" : "border-zk-input-border focus:border-zk-primary"
            }`}
            autoComplete="username"
            disabled={loading}
            required
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] text-zk-text-secondary" htmlFor="password">
          密碼
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={`rounded-lg border px-3 py-2.5 text-sm text-zk-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563eb]/30 ${
              error ? "border-[#dc2626] shadow-[0_0_0_3px_rgba(220,38,38,.08)]" : "border-zk-input-border focus:border-zk-primary"
            }`}
            autoComplete="current-password"
            disabled={loading}
            required
          />
        </label>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-zk-primary py-[11px] text-sm font-semibold text-white hover:bg-zk-primary-dark disabled:opacity-[.45]"
        >
          {loading ? "登入中…" : "登入"}
        </button>
        <div className="text-center text-[11.5px] leading-relaxed text-zk-faint">
          帳號由老闆開立；首次登入會要求改密碼。
          <br />
          忘記密碼請聯絡老闆重設。
        </div>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zk-bg p-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
