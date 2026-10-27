// 測試用假電話：9001xxxx（8 位）遞增序號——避開真實 6 字頭手機段，亦唔撞 90000001–90000006 固定帳號。
// 取代 `6${Math.floor(Math.random() * 1e7)}`：隨機數撞 users.tel / guards.tel unique 會偶發 fail。
// vitest 設定 fileParallelism=false（全部 test file 共用同一個 DB、逐個跑），但每個 file 係獨立 module context／process，
// 記憶體計數器每個 file 重新由 1 起，會撞上個 file 留低嘅 row——所以序號存喺 os.tmpdir 一個檔（讀、加一、寫），跨 file 單調遞增。
// 範圍：90010000–90019999（一個 run 內用量遠少於 1 萬；序號每 9,999 次輪回）。
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FILE = path.join(tmpdir(), `zoikan-fake-tel-${path.basename(process.cwd())}.seq`);

let mem = 0;

export function fakeTel(): string {
  let n = 0;
  try {
    n = Number(readFileSync(FILE, "utf8")) || 0;
  } catch {
    n = 0;
  }
  n = (Math.max(n, mem) % 9_999) + 1;
  mem = n;
  try {
    writeFileSync(FILE, String(n));
  } catch {
    /* 寫唔到就退而求其次（同一 file 內由記憶體計數器保證遞增）*/
  }
  return `9001${String(n).padStart(4, "0")}`;
}
