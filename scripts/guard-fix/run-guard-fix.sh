#!/bin/zsh
# WP-GUARD-FIX：8 月更表「未配對安員」自動修復——一句搞掂（老闆唯一要
# 做嘅係貼一次連線字串）。同 scripts/opening/run-round2.sh 一致模式。
# 用法：  zsh ~/zoi-kan/scripts/guard-fix/run-guard-fix.sh
# 流程：貼連線字串（唔顯示）→ build（一次）→ --plan（印數目，冇 PII）→
# --apply（含登記工號／加別名／起新安員＋自動 reparse 全部 2026-08
# active 上載）→ 印修復前後總結。任何一步失敗即停，唔會半途寫入。
set -e
cd "$(dirname "$0")/../.."
read -s "DATABASE_URL?貼上目標 DB 連線字串（postgresql:// 開頭）再撳 Enter: "; echo
export DATABASE_URL
case "$DATABASE_URL" in postgresql://*|postgres://*) ;; *) echo "✗ 唔係 postgresql:// 開頭，停。"; exit 1;; esac
echo "① build（一次）…"; npx tsx scripts/guard-fix/build-guard-fix-plan.ts | tail -6
echo "② --plan（核對數目）…"; npx tsx scripts/guard-fix/apply-guard-fix-plan.ts --plan | grep -E "===|! " || true
echo "③ --apply（含登記／新建＋自動 reparse）…"; npx tsx scripts/guard-fix/apply-guard-fix-plan.ts --apply | grep -E "===|! |reparse|總結|剩低|  -" || true
unset DATABASE_URL
echo "✓ WP-GUARD-FIX 完成。請睇返 data/2026-09/guard-fix/plan-summary.md（needs_hr／needs_boss 清單）。"
echo "   如果係正式站，記得去 Zeabur 關返 PostgreSQL 公開 port。"
