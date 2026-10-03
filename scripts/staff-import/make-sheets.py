# 將視覺裁圖疊成聯絡表方便逐張讀取：python3 make-sheets.py name|address <每張數量>
# 輸入 out/<kind>-crops.json；輸出 sheets/<kind>-NNN.png。標籤只有序號（唔含任何個人資料）。
import json, os, sys
from PIL import Image, ImageDraw
kind, per = sys.argv[1], int(sys.argv[2])
listfile = sys.argv[3] if len(sys.argv) > 3 else f'{kind}-crops.json'
OUT = 'data/2026-10/staff-import'
crops = json.load(open(f'{OUT}/out/{listfile}'))
os.makedirs(f'{OUT}/sheets', exist_ok=True)
for f in os.listdir(f'{OUT}/sheets'):
    if f.startswith(kind + '-'):
        os.remove(f'{OUT}/sheets/{f}')
W = 1000
for s in range(0, len(crops), per):
    ims = []
    for i, c in enumerate(crops[s:s + per]):
        im = Image.open(f"{OUT}/{c['file']}").convert('RGB')
        r = min(W - 20, max(im.width, 700)) / im.width if kind == 'name' else (W - 20) / im.width
        r = min(r, 2.2)
        im = im.resize((max(1, int(im.width * r)), max(1, int(im.height * r))))
        if im.width > W - 20:
            im = im.resize((W - 20, int(im.height * (W - 20) / im.width)))
        ims.append((s + i, im))
    H = sum(im.height + 24 for _, im in ims) + 6
    sheet = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(sheet)
    y = 3
    for idx, im in ims:
        d.text((8, y + 3), f"#{idx % per + 1}", fill='red')
        sheet.paste(im, (10, y + 18))
        y += im.height + 24
        d.line([(0, y - 3), (W, y - 3)], fill='gray')
    sheet.save(f"{OUT}/sheets/{kind}-{s // per:03d}.png")
print(len(crops), 'crops ->', (len(crops) + per - 1) // per, 'sheets')
