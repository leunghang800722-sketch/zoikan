# 正式站（Zeabur 新加坡）前端基準 — 2026-10-10 20:10–20:30 HKT

量度方法：老闆已登入嘅 Chrome（香港 → 新加坡，桌面），每頁完整載入一次，用 `performance.getEntriesByType('navigation'|'resource')` 讀 TTFB／DOMContentLoaded／load／JS、CSS 傳輸量／頁內 API 請求（duration＝瀏覽器量到嘅完整請求時間，含排隊）。API 單獨量度：同一分頁 `fetch` 3 次取 p50（cache no-store），bytes 係解壓後 body。單次量度，當作數量級參考，之後 after 用同一 script（`perf/measure.js`）再量。

## 頁面（單位 ms；KB＝傳輸量 gz 後）

| 頁 | TTFB | DCL | load | HTML KB | JS KB | CSS KB | 請求數 | DOM 節點 | 頁內 API（ms／KB） |
|---|---|---|---|---|---|---|---|---|---|
| / 首頁（尚欠 dashboard） | 1815（冷） | 1844 | 2128 | 5.7 | 246 | 193 | 49 | 389 | shortfall 781／0.5；**pending-summary 1587**／3.2；ai/conversation 672／7.5 |
| /roster | 578 | 622 | 1049 | 5.7 | 244 | 193 | 52 | 387 | sites 700／45；roster/overview 705；ai/conversation 727；latest-with-data 371 |
| /guards | 492 | 533 | 595 | 6.1 | 256 | 193 | 78 | **17,934** | **guards 2221／47**；brokers 609；sites 892／45；latest 464 |
| /month-close | 537 | 581 | 683 | 7.0 | 274 | 193 | 79 | 890 | **one-click 698／191**；month-health 662／14；ai/conversation 682 |
| /triage | 545 | 574 | 1079 | 5.4 | 267 | 193 | 78 | 354 | triage/sessions 388／2.3；ai/conversation 561 |
| /guard-fix | 479 | 525 | 980 | 7.1 | 249 | 193 | 79 | 432 | staff-list 378；postorder 648＋1086（**打咗兩次**）；runs 615／44；brokers 674 |
| /roster-uploads | 472 | 515 | 1027 | 6.3 | 249 | 193 | 76 | 1551 | sites 499／45；roster-uploads 545／10 |
| /reports/gross-margin | 493 | 521 | 879 | 6.0 | 245 | 193 | 76 | 412 | gross-margin 523／3.5 |
| /reports/monthly-close | 659 | 684 | 1049 | 5.8 | 256 | 193 | 79 | 313 | month-closes 363；latest 381 |
| /reports/payroll | 481 | 512 | 600 | 5.9 | 245 | 193 | 78 | 333 | payroll 375 |
| /reports/longterm-payroll | 470 | 512 | 917 | 7.9 | 248 | 193 | 79 | 434 | 5 個 longterm API 各 ~580（序列？） |
| /sites | 448 | 478 | **2629** | 5.6 | 248 | 193 | 77 | 2464 | sites 595／45；**shift-types 447／56** |
| /rate-cards | 576 | 623 | 982 | 6.0 | 248 | 193 | 81 | 1651 | rate-cards 482／39；unpriced 575；sites 839／45；brokers 581；shift-types 636／56；**guards 2409／47** |
| /brokers | 482 | 549 | 1084 | 5.9 | 247 | — | 79 | 639 | brokers 383；broker-site-assignments 591／52；sites 791／45；**guards 2006／47** |
| /audit-log | 448 | 478 | 861 | 5.9 | 243 | — | 77 | 1061 | audit-log 465／36；users 562；tables 581 |
| /quotas | 445 | 476 | 907 | 5.9 | 246 | — | 81 | 389 | quotas 366；sites 680／45；shift-types 599／56；brokers 602 |
| /approvals | 496 | 548 | 922 | 5.8 | 244 | — | 79 | 300 | shift-records 373；sites 615／45；**guards 2036／47**；shift-types 453／56；brokers 484 |
| /reports/shortfall | 460 | 506 | 1037 | 5.4 | 245 | — | 78 | 390 | shortfall 596；**pending-summary 1457** |
| /reports/ops-digest | 478 | 506 | 584 | 5.6 | 245 | — | 75 | 525 | ops-digest 854／6.4 |
| /roster/:site/2026-09（更表編輯器） | 674 | 735 | 1096 | 5.2 | 257 | — | 85 | 759 | **11 個 API**：unpriced、sites/:id、shift-types、shift-records 808、**guards 2325／47**、daily-requirements 593／12、quotas、month-closes、brokers 832、guards(第二次) 486 |

每頁固定成本：`/api/ai/conversation`（7.5 KB、~550 ms）每頁都載（側欄收埋都載）；CSS 193 KB gz（一份 472 KB 原始，含 437 段 Noto Sans HK @font-face）；JS 243–274 KB gz；請求數 75–85 條（大部分係字型切片）。

## API 單獨量度（p50／min／max ms；KB＝解壓後）

| API | p50 | min | max | KB |
|---|---|---|---|---|
| /api/sites | 490 | 477 | 557 | 44.8 |
| /api/guards | 643 | 640 | 651 | 102.8 |
| /api/brokers | 368 | 367 | 369 | 3.7 |
| /api/shift-types | 387 | 384 | 389 | 45 |
| /api/rate-cards | 565 | 564 | 597 | 74.1 |
| /api/roster/overview (09) | 403 | 398 | 544 | 1.1 |
| /api/roster-uploads/pending-summary | **1151** | 1130 | 1184 | 2.9 |
| /api/month-close/one-click (09) | 463 | 463 | 487 | **190.9** |
| /api/reports/month-health (09) | 771 | 658 | 772 | 13.4 |
| /api/reports/gross-margin (09) | 730 | 711 | 801 | 40.9 |
| /api/reports/gross-margin (08 鎖月) | 803 | 802 | 861 | 39.8 |
| /api/reports/monthly-close (09) | 537 | 516 | 541 | 20.5 |
| /api/reports/monthly-close (08) | 602 | 601 | — | — |
| /api/reports/payroll (09) | 494 | 470 | 569 | 4 |
| /api/reports/shortfall | 538 | 537 | 551 | 0.2 |
| /api/reports/ops-digest (09) | 640 | 594 | 646 | 6.1 |
| /api/triage/sessions | 380 | 377 | 384 | 2 |
| /api/guard-fix/runs (09) | 391 | 385 | 395 | 43.3 |
| /api/audit-log | 654 | 630 | 778 | **97.3** |
| /api/months/latest-with-data | 363 | 363 | 364 | 0 |
| /api/ai/conversation | 367 | 360 | 406 | 7.2 |
| /api/diagnostics/month (09) | 746 | 689 | 755 | 33 |

網絡底價：最輕 API（latest-with-data、brokers）約 360–370 ms ＝ 香港→新加坡 TLS＋Next.js route 開銷＋session／權限查詢嘅地板；即任何 API 嘅「可優化部分」＝ p50 − ~360。

## 觀察（前端）
1. **全站字型 CSS 193 KB gz／472 KB 原始，每頁必載**，係最大固定成本（JS 只係 ~250 KB）。
2. **`/api/guards` 全表（540 人、103 KB）被 5 個頁面載**（保安員、價目卡、雞頭、審批、更表編輯器），每次 2.0–2.4 秒（同其他請求並行時），係最慢嘅頁內請求；更表編輯器仲載兩次。
3. **`/api/sites`（45 KB）7 頁載、`/api/shift-types`（56 KB）4 頁載**——主檔冇 client cache／唔分頁。
4. **pending-summary 1.1–1.6 秒**，首頁同尚欠頁都要等佢。
5. **`/api/month-close/one-click` 回 191 KB**（一個 run 嘅全部 step 細節）——月結頁每次開都拖晒。
6. `/guards` DOM 17,934 節點（全部 540 人一次 render）；`/sites` load 2.6 秒。
7. `/guard-fix` 嘅 `postorder` 打兩次；長工糧頁 5 個 API 序列各 ~580 ms。
8. 側欄 AI 對話 7.5 KB 每頁載，就算未開側欄。
