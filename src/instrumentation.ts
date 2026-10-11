// P7.1：Next.js instrumentation——server 起身時啟動排程器（只喺 Node runtime；edge bundle 唔會引入 pg）。
// 必須用 `if (NEXT_RUNTIME === "nodejs") { await import(…) }` 呢個形狀，Next 先會喺 edge 編譯時剔走個 import。
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
