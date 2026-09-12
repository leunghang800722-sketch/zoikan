"""⑤ rates 尾段：將 rate_cards.csv 逐條 apply 落 shift_records.csv，寫
shift_records_priced.csv（+ client_rate_snapshot/guard_wage_snapshot/
broker_fee_snapshot/rate_id 四個新欄）同 unpriced.csv（完全配唔到任何價、
逐條列原因）。

配對優先序（由細至粗）：
  guard_id 專屬 > (site,shift_type,broker) > (site,broker) > (site,shift_type) > (site,)
"""
from collections import defaultdict
from decimal import Decimal
from typing import Dict, List, Optional

from .normalize import BrokerIndex


def _rc_key_candidates(rc: dict):
    """由最specific到最粗嘅 key，用嚟做 lookup dict 嘅 index。

    留意「guard」層嘅 key 特登唔帶 shift_type_id：Section A（出街價由
    payroll-rows.csv 逐行讀）生成嘅 guard 專屬 rate_card 本身就冇填
    shift_type_id（糧明細一個安員一個月一個價，唔分邊個更別），如果 guard
    key 帶埋 shift_type_id 就會同 shift_record 實際嘅 shift_type_id
    對唔上，跌落去粗嘅 (site,broker) 層先搵到，喺嗰層又同其他安員嘅唔同
    rate 撞埋一齊變 ambiguous——呢個係真實出現過嘅bug（G0039/G0105 呢類
    autopay/broker-only guard 錯誤襲用咗第二個安員嘅guard_wage；PDPO：呢度
    只記 guard_id，唔記真名，具體人可查 out/wp2b/guards.csv）。"""
    site = rc["site_id"]
    st = rc["shift_type_id"] or None
    br = rc["broker_id"] or None
    gu = rc["guard_id"] or None
    keys = []
    if gu:
        keys.append(("guard", site, br, gu))
    if st and br:
        keys.append(("site_st_br", site, st, br))
    if br:
        keys.append(("site_br", site, br))
    if st:
        keys.append(("site_st", site, st))
    # ★ 修正 A3（special 卡 site 層洩漏）★：一條 rate_card 一旦帶
    # shift_type_id（例如啟航1331 Event 卡 RC0153 鎖定 ST0026），就唔可以
    # 再喺最粗嘅 ("site", site) 層現身——如果照樣加呢層 key，pricing.py
    # 揀 client_rate 嗰陣（無 shift_type_id 篩選、直接搵 site 層）會將
    # 呢張本身淨係俾 ST0026 用嘅卡，錯誤襲用落成個 site 冇獨立卡嘅其他
    # shift_type（真實出現過嘅bug：RC0153 client_rate=11,700 洩漏俾
    # ST0027/ST0029 共 248 條非 Event 記錄）。冇 shift_type_id 嘅卡（例如
    # RC0155 呢種真係「成個site」層級嘅卡）唔受影響，繼續加呢層 key。
    if not st:
        keys.append(("site", site))
    return keys


def build_rate_lookup(rate_cards: List[dict]) -> Dict[tuple, List[dict]]:
    lookup = defaultdict(list)
    for rc in rate_cards:
        for k in _rc_key_candidates(rc):
            lookup[k].append(rc)
    return lookup


def _pick_card(lookup, site_id, shift_type_id, broker_id, guard_id, want_field,
                exclude_billing_models=None):
    """揀單一一條最specific嘅 rate_card，讀佢個 `want_field`。

    ★ 關鍵設計（修正一個真實bug）★：一旦搵到「呢個guard自己專屬」嘅
    rate_card（例如autopay長工，guard_wage專登係空、淨係得broker_fee），
    就淨係用嗰條卡，唔可以因為佢個guard_wage係空就re-fall-back去粗嘅
    (site,broker) 層攞第二個唔相干嘅安員（例如同site同broker嘅現金
    安員）嘅guard_wage嚟溝住用——嗰個先係真正嘅bug（G0039 autopay應該
    guard_wage=空，之前錯誤襲用咗G0052/G0127嘅680；PDPO：呢度只記
    guard_id，具體人可查 out/wp2b/guards.csv）。所以呢個function
    嘅cascade係「揀到有candidate嘅第一層就停」，唔係「揀到有非空值嘅第
    一層先停」。

    `exclude_billing_models`：`special`（個別雞頭月薪/Event佣金、啟航1331
    Event呢類一次性/特定範圍收入項）唔可以透過粗嘅 site-level fallback
    漏俾成個site其他普通更次（真實出現過嘅bug：啟航1331 Event嘅
    client_rate=11,700 因為係S017喺"site"層唯一嘅solved卡，錯誤襲用咗喺
    S017 client_rate仍然pending嘅普通1331更次度）。"""
    tries = []
    if guard_id and broker_id:
        tries.append(("guard", site_id, broker_id, guard_id))
    if shift_type_id and broker_id:
        tries.append(("site_st_br", site_id, shift_type_id, broker_id))
    if broker_id:
        tries.append(("site_br", site_id, broker_id))
    if shift_type_id:
        tries.append(("site_st", site_id, shift_type_id))
    tries.append(("site", site_id))

    def _allowed(c):
        return not exclude_billing_models or c["billing_model"] not in exclude_billing_models

    for key in tries:
        cands = [c for c in lookup.get(key, []) if _allowed(c)]
        if not cands:
            continue
        solved = [c for c in cands if c["status"] == "solved"]
        with_value = [c for c in solved if c[want_field]]
        if len(with_value) == 1:
            return with_value[0]
        # 呢層有 candidate（就算冇非空值、或者ambiguous）就唔再落粗一層搵——
        # 停喺呢層先係尊重「呢個guard/site/broker已經有明確嘅rate資訊」。
        return None
    return None


def _has_pending(lookup, site_id, shift_type_id, broker_id, guard_id) -> bool:
    for key in [k for k in [
        ("guard", site_id, broker_id, guard_id) if (guard_id and broker_id) else None,
        ("site_st_br", site_id, shift_type_id, broker_id) if (shift_type_id and broker_id) else None,
        ("site_br", site_id, broker_id) if broker_id else None,
        ("site_st", site_id, shift_type_id) if shift_type_id else None,
        ("site", site_id),
    ] if k]:
        if any(c["status"] == "pending" for c in lookup.get(key, [])):
            return True
    return False


# ---------------------------------------------------------------------------
# WP5g：master_roster_payout（A4，見 wp3_rates.py）出街價最後 fallback。
#
# 呢批卡刻意唔入主 `lookup`（`_rc_key_candidates` 嘅 site_st／site_br／site
# 三個闊 key 冚晒全部冇 shift_type/broker 篩選嘅 tries，包括 client_rate
# 嗰條——如果混埋主 lookup，一張淨係得 guard_wage、client_rate 留空嘅卡都
# 會喺 site_st 層佔咗個「有 candidate」位，令 `_pick_card` 嘅 client_rate
# 查詢喺嗰層「見到 candidate 但冇值」就停咗（唔會再落去粗嘅 site 層搵真正
# 嘅 client_rate 卡）——WP5g 開發期間實測過嘅真實 bug：加完呢個 fallback
# 之後 S006/S007/S011 等成班以前得返 site 層 client_rate 卡嘅 site，
# unpriced 由 1 條炸到 1,240 條。所以呢度用一個完全獨立、淨係做 exact-match
# 嘅 lookup，唔會摻落主 cascade，亦唔會俾 client_rate 查詢見到。
# ---------------------------------------------------------------------------

MASTER_ROSTER_PAYOUT_SOURCE = "master_roster_payout"


def _build_master_roster_payout_lookup(rate_cards: List[dict]):
    """Return (guard_lookup, post_lookup)，兩個都係 exact-match dict（key 一定
    唯一——wp3_rates.build_master_roster_payout_rate_cards 生成呢批卡嗰陣
    已經逐 key 去重／有衝突就唔生成，呢度唔使再做 ambiguous 判斷）。"""
    guard_lookup: Dict[tuple, dict] = {}
    post_lookup: Dict[tuple, dict] = {}
    for rc in rate_cards:
        if rc.get("source") != MASTER_ROSTER_PAYOUT_SOURCE or rc.get("status") != "solved":
            continue
        if rc.get("guard_id"):
            guard_lookup[(rc["site_id"], rc["broker_id"], rc["guard_id"])] = rc
        elif rc.get("shift_type_id"):
            post_lookup[(rc["site_id"], rc["shift_type_id"], rc["broker_id"])] = rc
    return guard_lookup, post_lookup


def _pick_master_roster_payout_card(guard_lookup, post_lookup, site_id, shift_type_id,
                                     broker_id, guard_id):
    """★總表長工卡 > 總表崗位卡★（guard 專屬釘死一個人，比日日輪換嘅崗位
    卡更明確，同 `_pick_card` 全個 cascade 一致嘅「guard 先過 site/broker
    層」做法）。"""
    if guard_id and broker_id:
        rc = guard_lookup.get((site_id, broker_id, guard_id))
        if rc:
            return rc
    if shift_type_id and broker_id:
        return post_lookup.get((site_id, shift_type_id, broker_id))
    return None


def price_shift_records(shift_records: List[dict], rate_cards: List[dict],
                         broker_index: BrokerIndex, sites_by_id: Dict[str, dict],
                         shift_type_billing_group: Optional[Dict[str, str]] = None):
    primary_rate_cards = [rc for rc in rate_cards
                           if rc.get("source") != MASTER_ROSTER_PAYOUT_SOURCE]
    lookup = build_rate_lookup(primary_rate_cards)
    mrp_guard_lookup, mrp_post_lookup = _build_master_roster_payout_lookup(rate_cards)
    priced_rows = []
    unpriced_rows = []
    shift_type_billing_group = shift_type_billing_group or {}

    for r in shift_records:
        if r["record_type"] != "shift":
            continue  # leave/ot/pointer 唔使 price（OT 另有 ot_hours 按鐘計，見 ot-landing.csv）

        site_id = r["site_id"]
        shift_type_id = r["shift_type_id"]
        settlement_unit = r["settlement_unit"]
        is_external = r["is_external"] == "True"
        out_of_scope = r["out_of_scope"] == "True"

        row = dict(r)
        row["client_rate_snapshot"] = ""
        row["guard_wage_snapshot"] = ""
        row["broker_fee_snapshot"] = ""
        row["client_rate_id"] = ""
        row["payout_rate_id"] = ""
        row["pricing_note"] = ""

        if is_external:
            row["pricing_note"] = "customer own staff（external），唔開單唔出糧"
            priced_rows.append(row)
            continue
        if out_of_scope:
            row["pricing_note"] = "LINK C7 / P0 out_of_scope，唔定價"
            priced_rows.append(row)
            continue
        if shift_type_billing_group.get(shift_type_id) == "monthly_ic":
            # WP3v2 條件1第1點：monthly_ic（例如數碼港CP5「早更IC」ST0016）
            # 唔入per_shift分母，對應噉呢度都唔可以逐更stamp site級嘅
            # per_shift client_rate——如果照stamp，site級rate_card（例如CP5
            # 930）冇shift_type_id篩選，會經 _pick_card 嘅"site"層fallback
            # 撞落嚟，令CP5嘅Σclient_rate_snapshot多咗25更×930=23,250（真實
            # 出現過嘅bug，喺Gate度揭發）。月費部分已經有獨立嘅monthly_fixed
            # rate_card（例如S012數碼港CP5 IC）覆蓋，呢度淨係跳過。
            row["pricing_note"] = "monthly_ic billing_group（例如CP5早更IC），月費制已有獨立rate_card覆蓋，per_shift client_rate唔逐更stamp"
            priced_rows.append(row)
            continue

        # --- client_rate (收客價) ---
        # monthly_fixed/admin_fee/special 嘅 client_rate 係「成個site/月一個
        # 總數」，唔係per-shift金額——如果照咁stamp落每條shift_record.
        # client_rate_snapshot，聚合報表（月結總表）逐更加埋會將總數乘咗
        # 幾十倍（真實出現過嘅bug：IFC monthly_fixed=35,000，40條shift_record
        # 逐條stamp再加埋變1,400,000）。呢類billing_model唔逐更定價，淨係
        # 喺rate_cards.csv/rates-report.md記靜態嘅月費值，shift_records_priced
        # 淨係留個rate_id方便追溯。
        # 修正 A3（special 卡 site 層洩漏）：主防線係 `_rc_key_candidates`
        # 唔畀帶 shift_type_id 嘅卡（包括 special）喺粗嘅 ("site", site) 層
        # 現身，所以呢度揀 client_rate 唔再會經 site fallback 撞到唔相干嘅
        # special 卡（例如啟航1331 Event RC0153 唔會再洩漏俾 ST0027/ST0029）。
        # 呢句係第二重防護：就算真係揾到一張 special 卡，都要佢自己嘅
        # shift_type_id 同呢條 shift_record 一致（例如 RC0153 嘅
        # shift_type_id=ST0026 要撞正呢條記錄自己都係 ST0026）先當數，
        # 否則當搵唔到——唔可以不分青紅皂白 exclude 晒所有 special（會連
        # 正主 4 條真 Event 記錄自己都變 unpriced，見
        # test_special_card_price_only_applies_to_its_own_shift_type）。
        client_rc = _pick_card(lookup, site_id, shift_type_id, None, None, "client_rate")
        if client_rc and client_rc["billing_model"] == "special" and client_rc["shift_type_id"] and client_rc["shift_type_id"] != shift_type_id:
            client_rc = None
        if client_rc:
            if client_rc["billing_model"] in ("monthly_fixed", "admin_fee", "special"):
                row["client_rate_id"] = client_rc["rate_id"]
                row["pricing_note"] = (row["pricing_note"] + "; " if row["pricing_note"] else "") + \
                    f"{client_rc['billing_model']}制，月費/總額唔逐更計，見rate_id={client_rc['rate_id']}"
            else:
                row["client_rate_snapshot"] = client_rc["client_rate"]
                row["client_rate_id"] = client_rc["rate_id"]

        # --- payout (guard_wage + broker_fee) ---
        payout_broker_id = None
        if settlement_unit == "autopay_longterm":
            referral = r.get("referral_broker") or ""
            if referral:
                payout_broker_id = broker_index.resolve_settlement_unit(referral)
        else:
            payout_broker_id = broker_index.resolve_settlement_unit(settlement_unit)

        guard_id = r["guard_id"]
        wage_rc = None
        fee_rc = None
        if payout_broker_id:
            wage_rc = _pick_card(lookup, site_id, shift_type_id, payout_broker_id, guard_id, "guard_wage")
            fee_rc = _pick_card(lookup, site_id, shift_type_id, payout_broker_id, guard_id, "broker_fee")
            # WP5g：糧明細/master_roster_rate/master_roster_only_rate（主
            # cascade）都搵唔到先至用總表逐崗位外判價做最後 fallback（總表
            # 崗位卡/總表長工卡，見 wp3_rates.build_master_roster_payout_
            # rate_cards）。★一定要 wage_rc 同 fee_rc 兩個都係 None 先至
            # fallback★——唔可以淨睇單一個field：`_pick_card` 嘅 wage/fee
            # 兩次查詢係行緊一模一樣嘅cascade（邊層有candidate就停喺邊層，
            # 唔理個field有冇值），如果其中一個field已經解到值（例如長工
            # autopay、T度淨收介紹費嗰種卡：guard_wage特登留空但
            # broker_fee有值），就代表主cascade喺呢層已經搵到一張屬於呢個
            # guard/broker嘅真卡，淨係嗰個field特登唔畀你——呢種情況唔可以
            # 用total_roster fallback打橫嚟補第二個field（WP5g開發期間實測
            # 過嘅真實bug：某安員T頁淨收780介紹費，guard_wage特登空，
            # 錯誤fallback補咗成月19,760）。
            if not wage_rc and not fee_rc:
                mrp_rc = _pick_master_roster_payout_card(
                    mrp_guard_lookup, mrp_post_lookup, site_id, shift_type_id,
                    payout_broker_id, guard_id)
                if mrp_rc:
                    wage_rc = mrp_rc
                    fee_rc = mrp_rc
        if wage_rc:
            row["guard_wage_snapshot"] = wage_rc["guard_wage"]
            if wage_rc["rate_id"] not in (row["payout_rate_id"] or ""):
                row["payout_rate_id"] = (row["payout_rate_id"] + ";" if row["payout_rate_id"] else "") + wage_rc["rate_id"]
        if fee_rc:
            row["broker_fee_snapshot"] = fee_rc["broker_fee"]
            if fee_rc["rate_id"] not in (row["payout_rate_id"] or ""):
                row["payout_rate_id"] = (row["payout_rate_id"] + ";" if row["payout_rate_id"] else "") + fee_rc["rate_id"]

        is_pure_autopay = settlement_unit == "autopay_longterm" and not (r.get("referral_broker") or "")
        if is_pure_autopay and not wage_rc and not fee_rc:
            row["pricing_note"] = (row["pricing_note"] + "; " if row["pricing_note"] else "") + \
                "長工autopay月薪，非逐更工資，見D2 BOCHK發薪檔（唔屬於WP3 per-shift payout rate範圍，冇referral_broker=唔收雞頭介紹費）"

        has_any_price_info = (row["client_rate_snapshot"] or row["guard_wage_snapshot"]
                               or row["broker_fee_snapshot"] or row["client_rate_id"])
        if not has_any_price_info:
            reason_parts = []
            if not client_rc:
                pend = " (有pending rate_card未解到)" if _has_pending(lookup, site_id, shift_type_id, None, None) else ""
                reason_parts.append(f"搵唔到client_rate{pend}")
            if is_pure_autopay:
                reason_parts.append("長工autopay，冇referral_broker，payout側N/A（非缺失）")
            elif settlement_unit != "autopay_longterm" and not payout_broker_id:
                reason_parts.append(f"settlement_unit={settlement_unit}冇對應broker_id")
            elif not wage_rc and not fee_rc:
                pend = " (有pending rate_card未解到)" if _has_pending(lookup, site_id, shift_type_id, payout_broker_id, guard_id) else ""
                reason_parts.append(f"搵唔到guard_wage/broker_fee rate_card{pend}")
            unpriced_rows.append({
                "shift_id": r["shift_id"], "guard_id": r["guard_id"], "site_id": site_id,
                "shift_type_id": shift_type_id, "settlement_unit": settlement_unit,
                "work_date": r["work_date"], "reason": "; ".join(reason_parts),
            })
        else:
            priced_rows.append(row)

    return priced_rows, unpriced_rows
