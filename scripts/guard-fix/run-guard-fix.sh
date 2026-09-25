#!/bin/zsh
# WP-GUARD-FIX：8 月更表「未配對安員」自動修復——一句搞掂（老闆唯一要
# 做嘅係貼一次連線字串）。同 scripts/opening/run-round2.sh 一致模式。
# 用法：  zsh ~/zoi-kan/scripts/guard-fix/run-guard-fix.sh
# 流程：貼連線字串（唔顯示）→ build → --plan（印數目，冇 PII）→
# --apply（含登記工號／加別名／起新安員＋自動 reparse 全部 2026-08
# active 上載）→ 印修復前後總結。任何一步失敗即停，唔會半途寫入。
#
# WP-GUARD-FIX 第二輪 dev 驗證揭發（見 P2-版面重設計計劃.md §18.7）：
# 起新安員之後，之前「唔知邊個啱」嘅同名 ambiguous 行可能先至判斷得到
# （例如兩位散工原本都未入系統、同名，其中一位起咗之後另一位先分辨到
# 唔係佢）——一輪 build+apply 唔一定完全收斂，所以呢度**循環最多 3
# 輪**，見到 needs_boss 以外冇新動作（link=create=create_minimal=0）就
# 停。3 輪之後仲有新動作就停低印警告，唔會靜靜跑落去。
set -e
cd "$(dirname "$0")/../.."
read -s "DATABASE_URL?貼上目標 DB 連線字串（postgresql:// 開頭）再撳 Enter: "; echo
export DATABASE_URL
case "$DATABASE_URL" in postgresql://*|postgres://*) ;; *) echo "✗ 唔係 postgresql:// 開頭，停。"; exit 1;; esac

for round in 1 2 3; do
  echo "===== 第 ${round} 輪 ====="
  echo "① build…"; npx tsx scripts/guard-fix/build-guard-fix-plan.ts | tail -6
  echo "② --plan（核對數目）…"
  PLAN_OUT=$(npx tsx scripts/guard-fix/apply-guard-fix-plan.ts --plan)
  echo "$PLAN_OUT" | grep -E "===|! " || true
  action_total=$(echo "$PLAN_OUT" | grep -E "^\[apply-guard-fix-plan\] link=" | sed -E 's/.*link=([0-9]+) create=([0-9]+) create_minimal=([0-9]+).*/\1+\2+\3/' | bc)
  if [ "${action_total:-99}" -eq 0 ]; then
    echo "✓ 冇新動作（淨係 needs_boss，如果有）——已經收斂，唔使再 apply。"
    break
  fi
  echo "③ --apply（含登記／新建＋自動 reparse）…"
  npx tsx scripts/guard-fix/apply-guard-fix-plan.ts --apply | grep -E "===|! |reparse|總結|剩低|  -" || true
  if [ "$round" -eq 3 ]; then
    echo "⚠ 跑咗 3 輪都仲有新動作——停低，請人手覆核（可能真係要老闆決定嘅 case 特別多），唔會自動再跑第 4 輪。"
  fi
done

unset DATABASE_URL
echo "✓ WP-GUARD-FIX 完成。請睇返 data/2026-09/guard-fix/plan-summary.md（needs_hr／needs_boss 清單）。"
echo "   如果係正式站，記得去 Zeabur 關返 PostgreSQL 公開 port。"
