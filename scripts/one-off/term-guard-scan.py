#!/usr/bin/env python3
"""WP-TERM-GUARD：「安員」→「保安員」一次性掃描／替換（唔依賴 data/）。

用法：
  python3 scripts/one-off/term-guard-scan.py scan     # 分類列表（stdout 摘要）
  python3 scripts/one-off/term-guard-scan.py apply    # 替換字面值／註解／文件
  python3 scripts/one-off/term-guard-scan.py left     # 列出剩低
分類：skip-key（permission key／角色名精確字串）、skip-ident（識別字、物件 key）、
skip-file（整個檔案豁免：permission key 定義檔）、literal（字串字面值）、comment（註解）、doc。
"""
import re, subprocess, sys, collections

KEYS = ["自己安員", "安員個人資料", "安員銀行資料", "安員批量導入", "安員配對修復", "安員"]
KEYSET = set(KEYS)
SKIP_FILES = {"src/lib/rbac/matrix.ts"}  # permission module key 定義檔
CODE_EXT = (".ts", ".tsx", ".mjs", ".js", ".sh")
DOC_EXT = (".md",)
M = re.compile(r"(?<!保)安員")
STR = re.compile(r"""("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)""")
KEY_LIT = re.compile(r"""(?<![\w\p{Han}])""") if False else None

def files():
    out = subprocess.check_output(
        "git ls-files src tests docs scripts README.md", shell=True, text=True).split("\n")
    for f in out:
        if not f or f == "scripts/one-off/term-guard-scan.py": continue
        if f.endswith(CODE_EXT + DOC_EXT): yield f

def classify_line(f, line):
    """回傳 [(start,end,cls)]，cls in skip-key/skip-ident/literal/comment"""
    res = []
    if f in SKIP_FILES:
        return [(m.start(), m.end(), "skip-file") for m in M.finditer(line)]
    if f.endswith(DOC_EXT):
        return [(m.start(), m.end(), "doc") for m in M.finditer(line)]
    # 切註解起點（行內 // 但要喺字串外）
    ranges = []  # (s,e,kind) string ranges
    for sm in STR.finditer(line):
        ranges.append((sm.start(), sm.end()))
    def in_string(pos):
        for s, e in ranges:
            if s <= pos < e: return (s, e)
        return None
    # 找註解開始 //（唔喺字串入面）
    cstart = None
    for m in re.finditer(r"//", line):
        if not in_string(m.start()) and (m.start() == 0 or line[m.start()-1] != ":"):
            cstart = m.start(); break
    stripped = line.lstrip()
    block = stripped.startswith(("/*", "*", "/**"))
    for m in M.finditer(line):
        p = m.start()
        sr = in_string(p)
        if cstart is not None and p >= cstart and not sr:
            res.append((p, m.end(), "comment")); continue
        if cstart is not None and p >= cstart and sr and sr[0] >= cstart:
            res.append((p, m.end(), "comment")); continue
        if sr:
            s, e = sr
            content = line[s+1:e-1]
            if content in KEYSET:
                before = line[:s].rstrip()
                if re.search(r"(label|title|placeholder|aria-label)\s*[=:]\s*\{?$", before):
                    res.append((p, m.end(), "literal"))
                else:
                    res.append((p, m.end(), "skip-key"))
            else:
                res.append((p, m.end(), "literal"))
            continue
        if block and not sr:
            res.append((p, m.end(), "comment")); continue
        # 字串外、非註解：JSX 文字 or 識別字
        before = line[:p]; after = line[m.end():]
        if re.search(r"[A-Za-z0-9_$]$", before) or re.match(r"[A-Za-z0-9_$]", after):
            res.append((p, m.end(), "skip-ident")); continue
        if re.match(r"[\p{Han}\w]*\s*:" if False else r"\w*\s*:(?!:)", after) and re.search(r"[\s{,]$|^$", before) and not re.search(r">", before[-1:]):
            # 物件 key（安員: row(...)）
            res.append((p, m.end(), "skip-ident")); continue
        res.append((p, m.end(), "literal"))  # JSX 文字
    return res

def run(mode):
    stat = collections.Counter()
    leftover = []
    changed = 0
    for f in files():
        try: txt = open(f, encoding="utf8").read()
        except Exception: continue
        lines = txt.split("\n")
        newlines = []
        dirty = False
        in_block = False
        for i, line in enumerate(lines, 1):
            if not M.search(line):
                newlines.append(line); continue
            cls = classify_line(f, line)
            out = line
            for s, e, c in reversed(cls):
                stat[(f.split("/")[0], c)] += 1
                if c in ("literal", "comment", "doc"):
                    if mode == "apply":
                        out = out[:s] + "保安員" + out[e:]
                else:
                    leftover.append((f, i, c, line.strip()[:120]))
            if out != line: dirty = True
            newlines.append(out)
        if dirty and mode == "apply":
            open(f, "w", encoding="utf8").write("\n".join(newlines)); changed += 1
    if mode == "scan" or mode == "apply":
        for k, v in sorted(stat.items()): print(v, k)
        print("files changed:", changed)
    if mode in ("scan", "left"):
        for l in leftover: print("%s:%d [%s] %s" % l)

if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else "scan")
