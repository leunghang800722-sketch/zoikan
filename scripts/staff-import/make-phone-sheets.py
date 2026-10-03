# 將電話裁圖疊成聯絡表（每張 8 個，標 docId-頁），方便逐張視覺讀取。輸出 data/2026-10/staff-import/sheets/。
import json, os
from PIL import Image, ImageDraw
OUT = 'data/2026-10/staff-import'
crops = json.load(open(f'{OUT}/out/phone-crops.json'))
os.makedirs(f'{OUT}/sheets', exist_ok=True)
for f in os.listdir(f'{OUT}/sheets'):
    os.remove(f'{OUT}/sheets/{f}')
PER = 8
W = 1100
for s in range(0, len(crops), PER):
    batch = crops[s:s + PER]
    ims = []
    for c in batch:
        im = Image.open(f"{OUT}/{c['file']}").convert('RGB')
        r = (W - 20) / im.width
        im = im.resize((W - 20, max(40, int(im.height * r))))
        ims.append((c, im))
    H = sum(im.height + 26 for _, im in ims) + 10
    sheet = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(sheet)
    y = 5
    for c, im in ims:
        d.text((10, y + 4), f"[{c['docId']}-p{c['page']}]", fill='red')
        sheet.paste(im, (10, y + 20))
        y += im.height + 26
        d.line([(0, y - 3), (W, y - 3)], fill='gray')
    sheet.save(f"{OUT}/sheets/phone-{s // PER:03d}.png")
print(len(crops), 'crops ->', (len(crops) + PER - 1) // PER, 'sheets')
