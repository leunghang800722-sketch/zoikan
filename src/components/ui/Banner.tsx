export function Banner({ kind, message }: { kind: "error" | "success" | "info"; message: string | null }) {
  if (!message) return null;
  const cls =
    kind === "error"
      ? "border-zk-danger-border bg-zk-danger-bg text-zk-danger-dark"
      : kind === "success"
        ? "border-zk-success/30 bg-zk-success-bg text-zk-success-dark"
        : "border-zk-primary/30 bg-zk-primary-tint-soft text-zk-primary-dark";
  return <div className={`rounded border px-3 py-2 text-sm ${cls}`}>{message}</div>;
}
