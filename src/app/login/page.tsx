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
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(body.message ?? "登入失敗");
        return;
      }
      router.push(next);
      router.refresh();
    } catch {
      setError("網絡錯誤，請重試");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">在勤 登入</h1>
        <p className="text-sm text-gray-500">保安排更系統</p>
      </div>
      {error && <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="space-y-1">
        <label className="block text-sm text-gray-700" htmlFor="tel">
          電話
        </label>
        <input
          id="tel"
          value={tel}
          onChange={(e) => setTel(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          autoComplete="username"
          disabled={loading}
          required
        />
      </div>
      <div className="space-y-1">
        <label className="block text-sm text-gray-700" htmlFor="password">
          密碼
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          autoComplete="current-password"
          disabled={loading}
          required
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
      >
        {loading ? "登入中…" : "登入"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
