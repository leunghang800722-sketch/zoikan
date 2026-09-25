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
# 驗收（Opus 5.5）：之前冇 pipefail，`build | tail`、`apply --apply | grep … || true`
# 會食咗 build／apply 嘅失敗（exit code 係 tail／grep 嘅），script 照行落去
# 印「✓ 完成」。而家每步輸出先寫落 temp file，檢查 exit code，失敗即停。
setopt pipefail
cd "$(dirname "$0")/../.."
read -s "DATABASE_URL?貼上目標 DB 連線字串（postgresql:// 開頭）再撳 Enter: "; echo
export DATABASE_URL
case "$DATABASE_URL" in postgresql://*|postgres://*) ;; *) echo "✗ 唔係 postgresql:// 開頭，停。"; exit 1;; esac
OUT=$(mktemp -t guard-fix)
trap 'rm -f "$OUT"; unset DATABASE_URL' EXIT

fail() { echo "✗ $1——停。"; exit 1; }
# 失敗時淨係印我哋自己嘅 log 行同錯誤碼——Prisma「Invalid invocation」錯誤
# 會連 create 參數（姓名／電話／身份證）一齊印，唔可以成段 cat 出嚟。
show_err() { grep -E "^\[(build|apply)-guard-fix-plan\]|===|  ! " "$OUT" || true; grep -oE "\bP[0-9]{4}\b|Transaction [a-z ]*timeout|目標 DB 冇[^—]*|plan\.json 係對住[^—]*" "$OUT" | sort -u || true; }

converged=0
for round in 1 2 3 4; do
  echo "===== 第 ${round} 輪 ====="
  echo "① build（讀目標 DB 嘅 2026-08 roster_upload_rows）…"
  npx tsx scripts/guard-fix/build-guard-fix-plan.ts > "$OUT" 2>&1 || { show_err; fail "build 失敗"; }
  grep -E "^\[build-guard-fix-plan\] (目標 DB|身份總數|link=|!|needs_boss)" "$OUT" || true
  echo "② --plan（核對數目）…"
  npx tsx scripts/guard-fix/apply-guard-fix-plan.ts --plan > "$OUT" 2>&1 || { show_err; fail "--plan 失敗"; }
  grep -E "===|! |資料嚟源" "$OUT" || true
  grep -q "資料嚟源 db_rows" "$OUT" || fail "plan 唔係由目標 DB 上載 rows build 出嚟"
  counts=$(grep -E "^\[apply-guard-fix-plan\] link=" "$OUT" | sed -E 's/.*link=([0-9]+) create=([0-9]+) create_minimal=([0-9]+).*/\1+\2+\3/')
  [ -n "$counts" ] || fail "讀唔到 --plan 數目（輸出格式唔啱）"
  action_total=$(echo "$counts" | bc)
  if [ "$action_total" -eq 0 ]; then
    echo "✓ 冇新動作（淨係 needs_boss，如果有）——已經收斂。"
    converged=1
    break
  fi
  if [ "$round" -eq 4 ]; then break; fi # 已經 apply 咗 3 輪仲有新動作——唔再 apply
  echo "③ --apply（登記／新建＋自動 reparse 全部 2026-08 未確認上載）…"
  npx tsx scripts/guard-fix/apply-guard-fix-plan.ts --apply > "$OUT" 2>&1 || { show_err; fail "--apply 失敗（link／建人係一個 transaction，失敗即全部冇寫；reparse 中途失敗可以直接重跑呢個 script，冪等）"; }
  grep -E "===|! |reparse|總結|剩低|  -|unmatched" "$OUT" || true
done

if [ "$converged" -ne 1 ]; then
  echo "⚠ apply 咗 3 輪都仲有新動作——停低，請人手覆核，唔會自動再跑第 4 輪。"
  exit 2
fi
echo "✓ WP-GUARD-FIX 完成。needs_boss 清單（盤＋格數＋原因，唔列名）喺 data/2026-09/guard-fix/plan-summary.md；個別身份資料喺 plan.json（有 PII，唔好傳出去）。"
echo "   如果係正式站，記得去 Zeabur 關返 PostgreSQL 公開 port。"
