# 將 read-tasks.json 按 spec 分組，疊成批次聯絡表（標籤＝裁圖 id，內部 id）→ data/2026-10/staff-fields/bsheets/<spec>-NNN.png ＋ bsheets/index.json
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
F = ROOT / 'data/2026-10/staff-fields'
(F / 'bsheets').mkdir(exist_ok=True)
tasks = json.load(open(F / 'read-tasks.json'))
W = 1000
MAXH = {'permit_card': 2300, 'bank_page': 2300}
idx = []
import re
BANK_RE = re.compile(r'SAVINGS|儲蓄|存款|ATM|UnionPay|銀聯|\bCARD\b|STATEMENT|結單|月結|A/C|ACCOUNT|戶口|户口|VISA|MASTER|PASSBOOK|存摺|DEPOSIT|CURRENT|EPS|PLUS', re.I)
OCR = ROOT / 'data/2026-10/staff-import/ocr'
def has_bank_evidence(tid):
    doc, pg = tid.split('-')[0], int(tid.split('-')[1][1:])
    for l in open(OCR / f'{doc}.jsonl'):
        o = json.loads(l)
        if o['page'] == pg and not o.get('alt'):
            return bool(BANK_RE.search(' '.join(z['t'] for z in o['lines'])))
    return False
tasks = [t for t in tasks if t['spec'] != 'bank_page' or has_bank_evidence(t['id'])]
# --only <ids.json> --prefix r1：只為指定 id（例如補裁後新增、未讀嘅）出 sheet；index／assign 另存 index-<prefix>.json
ARGS = dict(zip(sys.argv[1::2], sys.argv[2::2]))
PREFIX = ARGS.get('--prefix', '')
if '--only' in ARGS:
    only = set(json.load(open(ARGS['--only'])))
    tasks = [t for t in tasks if t['id'] in only]

for spec in sorted({t['spec'] for t in tasks}):
    ts = sorted([t for t in tasks if t['spec'] == spec], key=lambda t: t['id'])
    maxh = MAXH.get(spec, 2200)
    cur, h, n = [], 0, 0
    def flush():
        global cur, h, n
        if not cur: return
        sheet = Image.new('RGB', (W, h + 4), 'white'); d = ImageDraw.Draw(sheet); y = 2
        for tid, im in cur:
            d.text((6, y + 4), tid, fill='red'); sheet.paste(im, (10, y + 18)); y += im.height + 22; d.line([(0, y - 2), (W, y - 2)], fill='gray')
        name = f'{PREFIX}{spec}-{n:03d}.png'; sheet.save(F / 'bsheets' / name)
        idx.append({'sheet': name, 'spec': spec, 'ids': [i for i, _ in cur]}); n += 1; cur, h = [], 0
    for t in ts:
        im = Image.open(F / t['file']).convert('RGB')
        big = spec in MAXH
        r = min((W - 20) / im.width, 0.95 if big else 1.2)
        im = im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))))
        if im.height > maxh - 30: im = im.resize((int(im.width * (maxh - 30) / im.height), maxh - 30))
        if cur and h + im.height + 22 > maxh: flush()
        cur.append((t['id'], im)); h += im.height + 22
    flush()
json.dump(idx, open(F / ('bsheets/index-%s.json' % PREFIX if PREFIX else 'bsheets/index.json'), 'w'))
import collections
print(dict(collections.Counter(i['spec'] for i in idx)))
