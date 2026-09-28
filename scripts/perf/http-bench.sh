#!/bin/zsh
# `npm run perf:http -- <out.md>`——老闆 2026-09-28 效能優化指令：HTTP 層基線。
# 對住本機 `next start`（預設 port 3400，`.claude/launch.json` 嘅 zoikan-start，
# 或者 PORT=3000 對 dev server）用 dev seed 嘅測試老闆帳號（tel 90000001，
# 密碼係 scripts/seed/index.ts 嘅 dev fixture，唔係真帳號）登入，逐個 URL 打
# N 次（預設 5），印中位數／最小／最大耗時（ms）、status、bytes。淨係本機用。
PORT=${PORT:-3400}; N=${N:-5}; OUT="$1"; BASE="http://localhost:$PORT"
JAR=$(mktemp)
curl -s -c $JAR -H 'content-type: application/json' -d '{"tel":"90000001","password":"Passw0rd1"}' $BASE/api/auth/login -o /dev/null -w "login %{http_code}\n"
UPLOAD_ID=$(curl -s -b $JAR "$BASE/api/roster-uploads?month=2026-08" | python3 -c '
import sys,json
d=json.load(sys.stdin); found=[]
def walk(x):
    if isinstance(x,dict):
        if "id" in x and "status" in x and ("file_size" in x or "file_name" in x): found.append(x)
        for v in x.values(): walk(v)
    elif isinstance(x,list):
        for v in x: walk(v)
walk(d); found=[r for r in found if r.get("status") in ("parsed","confirmed")]; found.sort(key=lambda r:-(r.get("file_size") or 0)); print(found[0]["id"] if found else "")')
SITE_ID=$(curl -s -b $JAR "$BASE/api/sites" | python3 -c 'import sys,json;d=json.load(sys.stdin);rows=d.get("data",d);rows=rows.get("rows",rows) if isinstance(rows,dict) else rows;print(rows[0]["id"] if rows else "")')
URLS=(
  "/api/reports/monthly-close?month=2026-08"
  "/api/reports/monthly-close?month=2026-07"
  "/api/reports/gross-margin?month=2026-08"
  "/api/reports/payroll?month=2026-08"
  "/api/reports/payroll?month=2026-08&export=xlsx"
  "/api/reports/monthly-close?month=2026-08&export=xlsx"
  "/api/reports/postorder/2026-08"
  "/api/diagnostics/month?month=2026-08"
  "/api/month-closes?month=2026-08"
  "/api/month-closes/roster-coverage?month=2026-08"
  "/api/month-close/one-click?month=2026-08"
  "/api/longterm/payroll/2026-08"
  "/api/roster-uploads?month=2026-08"
  "/api/roster-uploads/pending-summary"
  "/api/roster-uploads/$UPLOAD_ID"
  "/api/roster-uploads/$UPLOAD_ID/reconcile"
  "/api/roster/overview?month=2026-08"
  "/api/guards"
  "/api/guards?with_month_shifts=2026-08"
  "/api/shift-records?work_date_from=2026-08-01&work_date_to=2026-08-31"
  "/api/shift-records/unpriced?month=2026-08"
  "/api/rate-cards"
  "/api/sites"
  "/api/brokers"
  "/api/special-items?month=2026-08"
  "/api/audit-log"
  "/api/sites/$SITE_ID/roster-export?month=2026-08"
  "/api/guard-fix/runs"
  "/"
  "/roster-uploads"
  "/roster-uploads/$UPLOAD_ID/reconcile"
  "/guards"
  "/month-close"
  "/reports/monthly-close"
  "/reports/gross-margin"
  "/reports/payroll"
  "/reports/longterm-payroll"
  "/rate-cards"
  "/guard-fix"
  "/sites"
)
echo "| URL | median ms | min ms | max ms | status | bytes |" | tee "$OUT"
echo "|---|---:|---:|---:|---|---:|" | tee -a "$OUT"
for u in $URLS; do
  times=(); code=""; size=""
  for i in $(seq 1 $N); do
    r=$(curl -s -b $JAR -o /dev/null -w "%{time_total} %{http_code} %{size_download}" "$BASE$u")
    t=$(echo $r | awk '{printf "%d", $1*1000}'); code=$(echo $r | awk '{print $2}'); size=$(echo $r | awk '{print $3}')
    times+=($t)
  done
  sorted=($(printf "%s\n" $times | sort -n)); med=${sorted[$(( (N+1)/2 ))]}
  echo "| $u | $med | ${sorted[1]} | ${sorted[$N]} | $code | $size |" | tee -a "$OUT"
done
rm -f $JAR
