"""載入 `data/mappings-private/brokers.csv`（雞頭／結算單位真名，PDPO：
gitignore `data/`，唔入 git）。

背景：`mappings/brokers.csv`（會入 git）淨係留代號（K／W／G／D／T／Y）同結構
欄（kind／settlement_type／唔涉真名嘅 aliases，例如 Y＝公司兵、B10＝Wilson
Guard／Wilson Supervisor 呢類公司/客戶名唔算個人 PDPO 資料）。真名（例如 K
嘅真名）同糧明細頁實際出現嘅別名寫法（大階、簡稱等），淨係本機
`data/mappings-private/brokers.csv` 有，呢個模組係邏輯上需要真名嘅 call
site（settlement_unit 標籤、糧明細頁名比對、alias 索引……）嘅唯一讀入口。

冇 private 檔（例如新 clone 未攞到 `data/`）：所有 `broker_*` function
一律 fallback 用代號本身，唔會 raise、唔會靜默——第一次撞到就經
`logging` 開一個 warning（同一 code／reason 淨係警告一次，唔洗癲晒 log）。
Call site（尤其 tests）如果邏輯上一定要有真名先做得到比對，就應該揀
skip（見 `tests/helpers.py` 嘅 `require_private_brokers`），唔應該吞咗
warning 當冇事發生。
"""
from __future__ import annotations

import csv
import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set

from .paths import PRIVATE_BROKERS_CSV, PRIVATE_CLIENT_NAMES_JSON

logger = logging.getLogger(__name__)

_WARNED: Set[tuple] = set()


def _warn_once(code: str, reason: str) -> None:
    key = (code, reason)
    if key in _WARNED:
        return
    _WARNED.add(key)
    logger.warning(
        "private broker mapping 冇資料 (code=%r, %s)——fallback 用代號本身。"
        "如果需要真名先做得到嘅比對／報表會受影響，見 "
        "data/mappings-private/brokers.csv（PDPO：唔入 git，本機專用）。",
        code, reason,
    )


@lru_cache(maxsize=None)
def load_private_brokers(path: Path = PRIVATE_BROKERS_CSV) -> Dict[str, dict]:
    """Return {code: {"canonical_name": str, "aliases": [str,...],
    "master_roster_aliases": [str,...]}}。

    `aliases` 係糧明細頁實際出現嘅寫法（大階、簡稱呢類變體，餵
    `mappings_io.load_brokers()` 埋去 BrokerIndex）；`master_roster_aliases`
    係額外嘅稱呼（例如 T 喺「在勤總表」入面老闆/總表用姓氏稱呼，唔係
    糧明細頁格式），淨係 `master_roster.py` 自己嘅對照表用，唔會混入
    BrokerIndex 嘅 aliases（避免改變 `out/wp2b/brokers.csv` 輸出）。

    冇檔就回傳 {}（log warning 一次），唔 raise——所有 caller 經
    `broker_canonical_name`／`broker_aliases` 自動 fallback 用代號。
    """
    if not path.exists():
        logger.warning(
            "private brokers mapping 唔存在：%s（PDPO 真名檔案，本機專用，"
            "唔會入 git）；雞頭真名相關功能會 fallback 用代號 K/W/G/D/T。",
            path,
        )
        return {}
    out: Dict[str, dict] = {}
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            code = (row.get("code") or "").strip()
            if not code:
                continue
            name = (row.get("canonical_name") or "").strip()
            aliases_raw = (row.get("aliases") or "").strip()
            aliases = [a.strip() for a in aliases_raw.split(";") if a.strip()]
            mr_aliases_raw = (row.get("master_roster_aliases") or "").strip()
            mr_aliases = [a.strip() for a in mr_aliases_raw.split(";") if a.strip()]
            out[code] = {
                "canonical_name": name,
                "aliases": aliases,
                "master_roster_aliases": mr_aliases,
            }
    return out


def broker_canonical_name(code: str, brokers: Optional[Dict[str, dict]] = None) -> str:
    """代號 -> 真名。冇 private 資料就 fallback 返代號本身（log warning）。"""
    if not code:
        return code
    brokers = brokers if brokers is not None else load_private_brokers()
    entry = brokers.get(code)
    if entry and entry.get("canonical_name"):
        return entry["canonical_name"]
    _warn_fallback = _warn_once
    _warn_fallback(code, "canonical_name")
    return code


def broker_aliases(code: str, brokers: Optional[Dict[str, dict]] = None) -> List[str]:
    """代號 -> 糧明細頁實際出現嘅別名寫法列表（唔含 canonical_name 本身）。
    冇 private 資料就回傳 []（log warning）。"""
    if not code:
        return []
    brokers = brokers if brokers is not None else load_private_brokers()
    entry = brokers.get(code)
    if entry is not None:
        return list(entry.get("aliases", []))
    _warn_once(code, "aliases")
    return []


def broker_master_roster_aliases(code: str, brokers: Optional[Dict[str, dict]] = None) -> List[str]:
    """代號 -> 「在勤總表」用嘅額外稱呼（例如 T 嘅姓氏稱呼）。冇 private 資料
    就回傳 []（log warning）——master_roster.py 用嚟 keyed 嘅字典會少一個
    key，唔會 raise。"""
    if not code:
        return []
    brokers = brokers if brokers is not None else load_private_brokers()
    entry = brokers.get(code)
    if entry is not None:
        return list(entry.get("master_roster_aliases", []))
    _warn_once(code, "master_roster_aliases")
    return []


def broker_names_for(codes: Iterable[str], extra: Iterable[str] = (),
                      brokers: Optional[Dict[str, dict]] = None) -> Set[str]:
    """代號清單 -> 真名（或 fallback 代號）set。`extra` 畀本身已經係代號／
    安全字眼嘅類別一齊加入（例如 Y 嘅 "公司兵"——呢個唔係要保密嘅真名，
    係內部直聘嘅固定稱呼，一直都可以喺 git-tracked 檔出現）。"""
    brokers = brokers if brokers is not None else load_private_brokers()
    out = {broker_canonical_name(c, brokers) for c in codes}
    out |= set(extra)
    return out


def resolve_settlement_unit_template(template: str, roster_broker_code: str,
                                      brokers: Optional[Dict[str, dict]] = None) -> str:
    """`mappings/page_level_settlements.csv` 嘅 `settlement_unit` 欄用代號
    前綴 template（例如 `K-1331`，對應真名 template `<真名>-1331`）存喺
    git-tracked 檔，執行時先用呢個 function 換返真名。前綴同
    `roster_broker_code` 對唔上就原句返回（唔識嘅格式，唔亂改）。"""
    if roster_broker_code and template.startswith(roster_broker_code):
        real = broker_canonical_name(roster_broker_code, brokers)
        return real + template[len(roster_broker_code):]
    return template


def has_private_brokers(path: Path = PRIVATE_BROKERS_CSV) -> bool:
    """畀 tests 用嚟判斷有冇 private 檔，冇就 skip 嗰啲一定要querying真名
    先做得到嘅測試（並印出原因），唔應該用 fallback 代號扮測試通過。"""
    return bool(load_private_brokers(path))


# ---------------------------------------------------------------------------
# B2（Opus 對抗式驗收第四輪）：客戶公司真名（例如恆星樓/葵發大廈嗰邊業主、
# SOGO CWB/Garden East 嗰邊承辦商，見 client-names.json 嘅 key 名）
# 一樣唔可以硬編碼喺 git-tracked 嘅 importer 程式碼／mappings/*.csv——搬去
# gitignored 嘅 data/mappings-private/client-names.json，呢兩個 function
# 係唯一讀入口。key 用短代號（`excellent_property`／`dusservice`…），
# value 可以係短稱又可以係發票全稱（`_legal` 後綴），冇私隱檔就 fallback
# 用 key 本身（log warning），唔 raise。
# ---------------------------------------------------------------------------
@lru_cache(maxsize=None)
def load_private_client_names(path: Path = PRIVATE_CLIENT_NAMES_JSON) -> Dict[str, str]:
    if not path.exists():
        logger.warning(
            "private client-names mapping 唔存在：%s（PDPO 真名檔案，本機專用，"
            "唔會入 git）；客戶公司名相關功能會 fallback 用代號本身。",
            path,
        )
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def client_name(key: str, names: Optional[Dict[str, str]] = None) -> str:
    """代號 -> 真名／發票全稱。冇 private 資料就 fallback 返代號本身
    （log warning），唔 raise。"""
    if not key:
        return key
    names = names if names is not None else load_private_client_names()
    if key in names:
        return names[key]
    _warn_once(key, "client_name")
    return key


def site_client_name(site_id: str) -> str:
    """site_id -> 真實客戶公司名（`mappings/sites.csv` 嘅 `client_name`
    欄淨係留返 S036/S037/S045/S046 呢幾個 site_id 空白，執行時經呢個
    function 補返）。site_id 唔喺對照表就回傳 ''（`load_sites()` 當冇
    client_name，同冇填一樣）——唔 raise。"""
    names = load_private_client_names()
    keys = names.get("site_client_name_keys", {})
    key = keys.get(site_id)
    if not key:
        return ""
    return client_name(key, names)
