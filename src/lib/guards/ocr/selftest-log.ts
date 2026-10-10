// 啟動自檢 fail log 一行（只帶類別／status／API error.type／已消毒嘅 4xx error.message；唔帶圖、辨識內容、key）。
export function selftestFailLine(provider: string, model: string, ms: number, e: unknown): string {
  const x = e as { status?: number | null; reason?: string | null; errorType?: string | null; errorMessage?: string | null };
  return `[guard-ocr-selftest] fail provider=${provider} model=${model} ms=${ms} prompt_tokens=0 completion_tokens=0 hkid_read_ok=false reason=${x.reason ?? (e instanceof Error ? e.name : "error")}${x.status ? ` status=${x.status}` : ""}${x.errorType ? ` error_type=${x.errorType}` : ""}${x.errorMessage ? ` error_message="${x.errorMessage.replace(/"/g, "'")}"` : ""}`;
}
