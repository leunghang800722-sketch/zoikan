# 將每人嘅裁圖疊成一張聯絡表（標籤＝裁圖 id，內部 id，無 PII）→ data/2026-10/staff-fields/sheets/p<idx>.png
# 用法：fields-sheets.py [--kinds form_join,form_personal,form_emergency,form_permits,permit_card] [--idx 0,1,2] 
import json, sys, os
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
F = ROOT / 'data/2026-10/staff-fields'
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
kinds = set((args.get('--kinds') or 'form_join,form_personal,form_emergency,form_permits,permit_card').split(','))
only = set(int(x) for x in args['--idx'].split(',')) if '--idx' in args else None
man = []
for mf in sorted(F.glob('crops-manifest*.json')):
    man += json.load(open(mf))
(F / 'sheets').mkdir(exist_ok=True)
W = 1100
n = 0
for p in man:
    if only is not None and p['idx'] not in only:
        continue
    cs = [c for c in p['crops'] if c['kind'] in kinds]
    if not cs:
        continue
    ims = []
    for c in cs:
        im = Image.open(F / c['file']).convert('RGB')
        r = min((W - 20) / im.width, 0.9 if c['kind'] == 'permit_card' else 1.2)
        im = im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))))
        ims.append((c['id'], im))
    chunks, cur, h = [], [], 0
    for item in ims:
        if cur and h + item[1].height + 22 > 2200:
            chunks.append(cur); cur, h = [], 0
        cur.append(item); h += item[1].height + 22
    if cur:
        chunks.append(cur)
    for ci, ch in enumerate(chunks):
        H = sum(im.height + 22 for _, im in ch) + 4
        sheet = Image.new('RGB', (W, H), 'white')
        d = ImageDraw.Draw(sheet)
        y = 2
        for cid, im in ch:
            d.text((6, y + 4), cid, fill='red')
            sheet.paste(im, (10, y + 18))
            y += im.height + 22
            d.line([(0, y - 2), (W, y - 2)], fill='gray')
        sheet.save(F / 'sheets' / (f'p{p["idx"]:03d}' + (chr(97 + ci) if len(chunks) > 1 else '') + '.png'))
        n += 1
print('sheets', n)
