#!/bin/zsh
# 8 月開盤第二輪：一句搞掂（老闆唯一要做嘅係貼一次連線字串）。
# 用法：  zsh ~/zoi-kan/scripts/opening/run-round2.sh
# 流程：貼連線字串（唔顯示）→ 測試連線 → build（一次）→ --plan（核對：
# 價目卡新建必須 ≤1、盤／更種／散工新建必須 0，否則停）→ --apply →
# verify（唯讀）→ 清走變數。任何一步失敗即停，唔會半途寫入。
set -e
cd "$(dirname "$0")/../.."
read -s "DATABASE_URL?貼上正式站連線字串（postgresql:// 開頭）再撳 Enter: "; echo
export DATABASE_URL
case "$DATABASE_URL" in postgresql://*|postgres://*) ;; *) echo "✗ 唔係 postgresql:// 開頭，停。"; exit 1;; esac
echo "① 測試連線…"; npx tsx scripts/opening/check-aug-state.ts
echo "② build（一次）…"; npx tsx scripts/opening/build-aug-plan.ts | tail -5
echo "③ --plan…"; PLAN_OUT=$(npx tsx scripts/opening/apply-aug-plan.ts --plan); echo "$PLAN_OUT" | grep -E "===|! skip" || true
cards=$(echo "$PLAN_OUT" | grep -E "^=== 價目卡 ===" | sed -E 's/.*新建 ([0-9]+).*/\1/')
others=$(echo "$PLAN_OUT" | grep -E "^=== (盤（新建）|更種|散工) ===" | sed -E 's/.*新建 ([0-9]+).*/\1/' | paste -sd+ - | bc)
echo "   價目卡新建=${cards:-?}，盤／更種／散工新建合計=${others:-?}"
if [ "${cards:-99}" -gt 1 ] || [ "${others:-99}" -ne 0 ]; then echo "✗ 數目同預期唔同（價目卡 ≤1、其餘 0），停，唔套用。將上面輸出交返規劃。"; unset DATABASE_URL; exit 1; fi
echo "④ --apply…"; npx tsx scripts/opening/apply-aug-plan.ts --apply | tail -3
echo "⑤ verify（唯讀）…"; npx tsx scripts/opening/verify-aug.ts | grep -E "總計|逐人卡|控制室|CTB|誤中|guard 級|✗|7 月 31 日" || true
unset DATABASE_URL
echo "✓ 第二輪完成。請去 Zeabur 關返 PostgreSQL 公開 port。"
