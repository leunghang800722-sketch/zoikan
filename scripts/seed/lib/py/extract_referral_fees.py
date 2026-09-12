#!/usr/bin/env python3
"""P1-WP4（規劃裁定）：長工雞頭費（referral fee）嘅真正權威數字。

P0 嘅「長工雞頭費」金額唔係一條可以由 shift_records 逐更計返嚟嘅公式
——係老闆自己喺「在勤總表」（master roster）手打嘅費用行（`amount`），
`implied_shifts = amount / rate` 先至係嗰行嘅「更數」（見
`master_roster.validate_referral_fee_rates()` 嘅 docstring）。呢個
wrapper（新寫，唔改 P0 code）淨係攞 P0 已經驗證過嘅呢批 `amount`，逐
(broker_id, block/site) 加埋，dump 做 JSON 俾 TS seed 用嚟起
`special_items`（kind=referral_fee）。

PDPO：呢度冇任何安員/雞頭真名——`broker_id` 已經係代號（B01/B02/…），
`block` 係盤層面嘅字面（同 sites.canonical_name 呢類非 PDPO 識別資料一致，
唔係人名）。
"""
import json
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "tools" / "importer"))

from importer.master_roster import validate_referral_fee_rates  # noqa: E402 (P0 code，唔改)


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: extract_referral_fees.py <out_json_path>", file=sys.stderr)
        sys.exit(1)
    out_path = Path(sys.argv[1])
    out_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        rows = validate_referral_fee_rates()
    except Exception as exc:  # noqa: BLE001
        json.dump({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, out_path.open("w", encoding="utf-8"))
        sys.exit(0)

    if not rows:
        json.dump({"ok": False, "error": "no_rows (master roster xlsx missing or empty)"}, out_path.open("w", encoding="utf-8"))
        sys.exit(0)

    by_broker_total: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    by_broker_block: dict[tuple[str, str], Decimal] = defaultdict(lambda: Decimal("0"))
    detail = []
    for r in rows:
        broker_id = r["broker_id"]
        if not broker_id:
            continue
        amount = Decimal(r["amount"])
        by_broker_total[broker_id] += amount
        by_broker_block[(broker_id, r["block"])] += amount
        detail.append({
            "broker_id": broker_id,
            "block": r["block"],
            "sub_block": r["sub_block"],
            "shift": r["shift"],
            "amount": str(amount),
            "rate_per_shift": r["rate_per_shift"],
            "implied_shifts": r["implied_shifts"],
            "status": r["status"],
        })

    payload = {
        "ok": True,
        "by_broker_total": {k: str(v) for k, v in by_broker_total.items()},
        "by_broker_block": [
            {"broker_id": k[0], "block": k[1], "amount": str(v)} for k, v in by_broker_block.items()
        ],
        "detail": detail,
    }
    with out_path.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    print(f"wrote {len(rows)} rows, {len(by_broker_total)} brokers -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
