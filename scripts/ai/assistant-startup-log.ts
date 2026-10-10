// WP-AI-DIAG（§37.2）：容器啟動時印一行 `[ai-assistant] provider=<x> model=<y>`——淨係 provider／型號名稱，
// 冇 key、冇值、冇連線字串。同 guard-ocr-selftest 同一個啟動位置（Dockerfile CMD）。永遠 exit 0。
import { describeAiProvider } from "../../src/lib/ai/config";

try {
  const { provider, model } = describeAiProvider();
  console.log(`[ai-assistant] provider=${provider} model=${model}`);
} catch {
  console.log("[ai-assistant] provider=unknown model=unknown");
}
process.exit(0);
