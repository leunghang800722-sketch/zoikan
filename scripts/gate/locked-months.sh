#!/bin/zsh
# `npm run gate:locked-months [-- <out-dir>]`——老闆 2026-09-28 效能優化指令：
# 7／8 月已鎖定，任何改動都要證明兩個月數字唔變。呢個 script 一條命令跑完
# 成套「鎖月核對鏈」，每步 log 同耗時寫入 out-dir（預設 out/locked-months/
# <timestamp>/，gitignored），最後寫一份數字快照（perf:snapshot，唔含 PII）
# 同效能 profile（perf:profile）。兩次跑（例如改 code 前後）用
# `diff -r` 對 snapshot.json／gate log 就知有冇變。
#   1. db:reset + db:seed（7 月 seed）
#   2. 7 月四個 gate：gate:reports／gate:export／report:regen／gate:pricing
#   3. gate:roster-parse（36 檔更表解析 fixture）
#   4. gate:ltpay-aug（自己 reset→開 8 月→36 檔上載→guard-fix→對數→長工糧
#      →一鍵結算）
#   5. gate:postorder-export-aug（Postorder 格式總表 vs 老闆總表）
#   6. gate:aug-e2e（8 月端到端 vs 總表）
#   7. perf:snapshot（7／8 月報表／對數／診斷數字）＋ perf:profile
#
# 鐵則（WP-BOSS5 驗收項 6）：呢個 script 開頭 db-reset／db-seed 兩步會
# 重新種開發庫（`zoikan`）——**唔可以同 `npx vitest run
# tests/seed-regen-gate.test.ts`（或者任何一齊跑嘅 `vitest run`，見嗰個
# test 檔頂註解）同時執行**，兩者都會 seed／讀緊同一個開發庫，撞埋一齊
# 跑會互相干擾，結果唔可靠。要分開、先後執行，唔可以並行。
set -o pipefail
cd "$(dirname "$0")/../.."
OUT="${1:-out/locked-months/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
TIMES="$OUT/times.txt"; : > "$TIMES"
FAILED=0
run() {
  local name="$1"; shift
  local s=$(date +%s)
  echo "[gate:locked-months] === $name ($(date +%T)) ==="
  "$@" > "$OUT/$name.log" 2>&1
  local rc=$?
  local e=$(date +%s)
  echo "$name rc=$rc secs=$((e-s))" | tee -a "$TIMES"
  if [ $rc -ne 0 ]; then FAILED=1; echo "[gate:locked-months]   ↑ FAIL，見 $OUT/$name.log"; fi
}
run db-reset npm run db:reset
run db-seed npm run db:seed
run gate-reports npm run gate:reports
run gate-export npm run gate:export
run report-regen npm run report:regen
run gate-pricing npm run gate:pricing
run gate-roster-parse npm run gate:roster-parse
run gate-ltpay-aug npm run gate:ltpay-aug
run gate-postorder-export-aug npm run gate:postorder-export-aug
run gate-aug-e2e npm run gate:aug-e2e
run perf-snapshot npx tsx scripts/perf/snapshot.ts --out "$OUT/snapshot.json"
run perf-profile npx tsx scripts/perf/profile.ts --out "$OUT/profile.json"
echo "[gate:locked-months] 完成，輸出：$OUT"
cat "$TIMES"
exit $FAILED
