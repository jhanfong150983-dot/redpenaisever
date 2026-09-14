# -*- coding: utf-8 -*-
"""把「老師答案卷模板」疊到「學生作答卷 PDF」上做互動檢視（透明度滑桿／差異模式／格位）。
用法：python overlay_from_pdfs.py <template.json 所在資料夾> <學生 PDF 資料夾> <輸出資料夾>
  template.json：{ id, title, pages:[相對檔名], boxes:[{id,page,bbox,kind}] }（_dl-test-template.mjs 產生）
  學生 PDF：每個檔案一位學生；多頁 PDF 依 app 慣例直向堆疊成合併圖並算 page_breaks。
"""
import html, io, json, os, sys
import cv2, numpy as np, pymupdf
sys.stdout.reconfigure(encoding='utf-8'); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import register_core as rc

TDIR, PDIR, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
tpl = json.load(open(os.path.join(TDIR, 'template.json'), encoding='utf-8'))
pages = [open(os.path.join(TDIR, p), 'rb').read() for p in tpl['pages']]
boxes = tpl['boxes']

def pdf_to_merged(path, dpi=150):
    doc = pymupdf.open(path); imgs = []
    for pg in doc:
        pix = pg.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
        imgs.append(np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width))
    w = max(i.shape[1] for i in imgs)
    imgs = [cv2.resize(i, (w, int(round(i.shape[0] * w / i.shape[1])))) for i in imgs]
    merged = np.vstack(imgs); H = merged.shape[0]
    breaks = []; acc = 0
    for i in imgs[:-1]: acc += i.shape[0]; breaks.append(acc / H)
    ok, buf = cv2.imencode('.png', merged); return buf.tobytes(), breaks, len(imgs)

cards = []
pdfs = sorted(f for f in os.listdir(PDIR) if f.lower().endswith('.pdf'))
for fn in pdfs:
    raw, breaks, n = pdf_to_merged(os.path.join(PDIR, fn))
    r = rc.register(pages, boxes, raw, breaks or None)
    g = rc.decode_gray(raw); hs, ws = g.shape
    canvas = np.full((hs, ws), 255, np.uint8)
    for p, pg in enumerate(r['pages']):
        if not pg.get('H'): continue
        t = rc.TEMPLATES.get(pages[p])
        canvas = np.minimum(canvas, cv2.warpPerspective(t.gray, np.array(pg['H'], dtype=np.float64), (ws, hs), borderValue=255))
    ink = np.where(canvas > 185, 255, np.clip(canvas.astype(np.int16) * 255 // 185, 0, 255)).astype(np.uint8)
    tpl_rgb = cv2.merge([ink, ink, np.full_like(ink, 255)])
    base = os.path.splitext(fn)[0]
    cv2.imencode('.jpg', g, [cv2.IMWRITE_JPEG_QUALITY, 82])[1].tofile(os.path.join(OUT, base + '-student.jpg'))
    cv2.imencode('.jpg', tpl_rgb, [cv2.IMWRITE_JPEG_QUALITY, 82])[1].tofile(os.path.join(OUT, base + '-template.jpg'))
    rects = ''.join(f'<rect x="{b["bbox"]["x"]*100:.3f}%" y="{b["bbox"]["y"]*100:.3f}%" width="{b["bbox"]["w"]*100:.3f}%" height="{b["bbox"]["h"]*100:.3f}%" fill="none" stroke="{"#16a34a" if b["status"]=="ok" else "#f97316"}" stroke-width="0.25%" vector-effect="non-scaling-stroke"/>' for b in r['boxes'])
    stat = ' ｜ '.join(f"第{p['page']+1}頁 {'✔' if p['ok'] else '✘ ' + p['reason']}（特徵點 {p['inliers']}、結構分 {p['structure']}、一致率 {p['consistency']}、中位位移 {p['median_shift_mm']} mm）" for p in r['pages'])
    cards.append((base, n, r['decision'], stat, rects, ws, hs, r['ms']))
    print(fn, n, '頁', r['decision'], r.get('reason') or '', r['ms'], 'ms')

secs = []
for base, n, dec, stat, rects, ws, hs, ms in cards:
    badge = '疊合成功 → 免 classify' if dec == 'aligned' else '退回 classify（顯示純投影）'
    secs.append(f'''<section><h2>{html.escape(base)}（{n} 頁）<span class="badge {'ok' if dec=='aligned' else 'no'}">{badge}</span> <small>{ms} ms</small></h2>
<p class="stat">{html.escape(stat)}</p>
<div class="ctl"><label>答案卷透明度 <input type="range" min="0" max="100" value="55" oninput="setOp(this)"> <span class="v">55%</span></label>
<label><input type="checkbox" onchange="setDiff(this)"> 差異模式</label><label><input type="checkbox" checked onchange="setBox(this)"> 顯示格位</label></div>
<div class="stage" style="aspect-ratio:{ws}/{hs}"><img class="stu" src="{html.escape(base)}-student.jpg" loading="lazy"><img class="tpl" src="{html.escape(base)}-template.jpg" loading="lazy" style="opacity:.55"><svg class="box" viewBox="0 0 100 100" preserveAspectRatio="none">{rects}</svg></div></section>''')
page = f'''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>{html.escape(tpl['title'])} 疊圖檢視</title>
<style>body{{font-family:"Microsoft JhengHei",system-ui,sans-serif;margin:0;background:#f4f4f5;color:#18181b}}header{{padding:14px 24px;background:#fff;border-bottom:1px solid #e4e4e7;position:sticky;top:0;z-index:5}}
section{{background:#fff;margin:16px 24px;padding:14px 16px;border-radius:12px;border:1px solid #e4e4e7}}h2{{font-size:15px;margin:0 0 4px}}.badge{{font-size:12px;padding:2px 8px;border-radius:6px;margin-left:8px}}.badge.ok{{background:#dcfce7;color:#166534}}.badge.no{{background:#fee2e2;color:#991b1b}}
.stat{{font-size:12px;color:#52525b;margin:2px 0 8px}}.ctl{{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;margin-bottom:8px;align-items:center}}.ctl input[type=range]{{width:220px;vertical-align:middle}}
.stage{{position:relative;width:100%;max-width:1100px;border:1px solid #d4d4d8;background:#fff}}.stage img,.stage svg{{position:absolute;inset:0;width:100%;height:100%}}.stage img{{object-fit:fill}}.stage.diff .tpl{{mix-blend-mode:difference;filter:grayscale(1)}}.stage.nobox .box{{display:none}}</style></head>
<body><header><h1 style="margin:0;font-size:17px">{html.escape(tpl['title'])}：老師答案卷 × 學生作答卷（{len(cards)} 份）</h1><p style="margin:4px 0 0;font-size:12.5px;color:#52525b">紅＝老師答案卷 warp 到學生座標；灰黑＝學生 PDF。本機產生、未上傳。</p></header>{''.join(secs)}
<script>function stage(el){{return el.closest('section').querySelector('.stage')}}function setOp(el){{stage(el).querySelector('.tpl').style.opacity=el.value/100;el.parentElement.querySelector('.v').textContent=el.value+'%'}}function setDiff(el){{stage(el).classList.toggle('diff',el.checked)}}function setBox(el){{stage(el).classList.toggle('nobox',!el.checked)}}</script></body></html>'''
open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(page)
print('saved', os.path.join(OUT, 'index.html'))
