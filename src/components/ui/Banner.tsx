export function Banner({ kind, message }: { kind: "error" | "success" | "info"; message: string | null }) {
  if (!message) return null;
  const cls =
    kind === "error"
      ? "border-red-300 bg-red-50 text-red-700"
      : kind === "success"
        ? "border-green-300 bg-green-50 text-green-700"
        : "border-blue-300 bg-blue-50 text-blue-700";
  return <div className={`rounded border px-3 py-2 text-sm ${cls}`}>{message}</div>;
}
