# -*- coding: utf-8 -*-
"""疊圖互動檢視：老師答案卷（模板，warp 到學生座標）疊在學生掃描卷上，滑桿調透明度、可切差異模式、可顯示格位。
用法：python render_overlay.py <exp-register 資料夾> <輸出資料夾> [每份作業幾位學生]
產出：<out>/index.html ＋ 每位學生兩張 jpg（學生卷、warp 後模板）。本機檔案、不上傳。
"""
import html, json, os, sys
import cv2, numpy as np
sys.stdout.reconfigure(encoding='utf-8'); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import register_core as rc

ROOT, OUT = sys.argv[1], sys.argv[2]; N = int(sys.argv[3]) if len(sys.argv) > 3 else 3
os.makedirs(OUT, exist_ok=True)
meta = json.load(open(os.path.join(ROOT, 'meta.json'), encoding='utf-8'))
rd = lambda p: open(p, 'rb').read()
cards = []
for key, m in meta.items():
    pages = [rd(os.path.join(ROOT, key, p)) for p in m['tplPages']]
    boxes = [{'id': b['id'], 'page': b['page'], 'bbox': b['bbox'], 'kind': b.get('cat')} for b in m['tplBoxes']]
    for s in m['students'][:N]:
        raw = rd(os.path.join(ROOT, key, s['file']))
        r = rc.register(pages, boxes, raw, s.get('page_breaks'))
        g = rc.decode_gray(raw); hs, ws = g.shape
        canvas = np.full((hs, ws), 255, np.uint8)
        for p, pg in enumerate(r['pages']):
            if not pg.get('H'):
                continue
            tpl = rc.TEMPLATES.get(pages[p])
            w = cv2.warpPerspective(tpl.gray, np.array(pg['H'], dtype=np.float64), (ws, hs), borderValue=255)
            canvas = np.minimum(canvas, w)
        # 模板層染成紅色調（灰階→白底紅字），學生層維持灰階；疊起來對齊處變深、錯位處看得到紅/黑分離
        # 掃描底色 ~230 灰會變成整片粉紅 → 先把紙底拉成純白（>185 視為紙），只留墨跡；再染紅（B=灰,G=灰,R=255）
        ink = np.where(canvas > 185, 255, np.clip(canvas.astype(np.int16) * 255 // 185, 0, 255)).astype(np.uint8)
        tpl_rgb = cv2.merge([ink, ink, np.full_like(ink, 255)])
        base = f'{key}-{s["id"][:14]}'
        cv2.imencode('.jpg', g, [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tofile(os.path.join(OUT, base + '-student.jpg'))
        cv2.imencode('.jpg', tpl_rgb, [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tofile(os.path.join(OUT, base + '-template.jpg'))
        rects = ''.join(
            f'<rect x="{b["bbox"]["x"]*100:.3f}%" y="{b["bbox"]["y"]*100:.3f}%" width="{b["bbox"]["w"]*100:.3f}%" height="{b["bbox"]["h"]*100:.3f}%" '
            f'fill="none" stroke="{"#16a34a" if b["status"]=="ok" else "#f97316"}" stroke-width="0.25%" vector-effect="non-scaling-stroke"/>'
            for b in r['boxes'])
        stat = ' ｜ '.join(f"第{p['page']+1}頁 {'✔' if p['ok'] else '✘ ' + p['reason']}（特徵點 {p['inliers']}、一致率 {p['consistency']}、中位位移 {p['median_shift_mm']} mm）" for p in r['pages'])
        cards.append((m['title'], s['id'][:14], r['decision'], stat, base, rects, ws, hs))
        print(key, s['id'][:14], r['decision'])

sections = []
for i, (title, sid, dec, stat, base, rects, ws, hs) in enumerate(cards):
    badge = '疊合成功' if dec == 'aligned' else '退回 classify（下面仍顯示純投影，看得出哪裡對不上）'
    sections.append(f'''
<section data-i="{i}">
  <h2>{html.escape(title)} ｜ 學生 {sid} <span class="badge {'ok' if dec=='aligned' else 'no'}">{badge}</span></h2>
  <p class="stat">{html.escape(stat)}</p>
  <div class="ctl">
    <label>答案卷透明度 <input type="range" min="0" max="100" value="55" oninput="setOp(this)"> <span class="v">55%</span></label>
    <label><input type="checkbox" onchange="setDiff(this)"> 差異模式（對齊處變黑、錯位處發亮）</label>
    <label><input type="checkbox" checked onchange="setBox(this)"> 顯示格位</label>
  </div>
  <div class="stage" style="aspect-ratio:{ws}/{hs}">
    <img class="stu" src="{base}-student.jpg" loading="lazy">
    <img class="tpl" src="{base}-template.jpg" loading="lazy" style="opacity:.55">
    <svg class="box" viewBox="0 0 100 100" preserveAspectRatio="none">{rects}</svg>
  </div>
</section>''')
page = f'''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>答案卷 × 學生卷 疊圖檢視</title>
<style>
body{{font-family:"Microsoft JhengHei",system-ui,sans-serif;margin:0;background:#f4f4f5;color:#18181b}}
header{{padding:14px 24px;background:#fff;border-bottom:1px solid #e4e4e7;position:sticky;top:0;z-index:5}}
section{{background:#fff;margin:16px 24px;padding:14px 16px;border-radius:12px;border:1px solid #e4e4e7}}
h2{{font-size:15px;margin:0 0 4px}} .badge{{font-size:12px;padding:2px 8px;border-radius:6px;margin-left:8px}} .badge.ok{{background:#dcfce7;color:#166534}} .badge.no{{background:#fee2e2;color:#991b1b}}
.stat{{font-size:12px;color:#52525b;margin:2px 0 8px}} .ctl{{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;margin-bottom:8px;align-items:center}} .ctl input[type=range]{{width:220px;vertical-align:middle}}
.stage{{position:relative;width:100%;max-width:1100px;border:1px solid #d4d4d8;background:#fff}}
.stage img,.stage svg{{position:absolute;inset:0;width:100%;height:100%}} .stage img{{object-fit:fill}}
.stage.diff .tpl{{mix-blend-mode:difference;filter:grayscale(1)}}
.stage.nobox .box{{display:none}}
</style></head><body>
<header><h1 style="margin:0;font-size:17px">答案卷 × 學生卷 疊圖檢視（{len(cards)} 份）</h1>
<p style="margin:4px 0 0;font-size:12.5px;color:#52525b">紅色＝老師答案卷（模板）依配準結果 warp 到學生座標；灰黑＝學生掃描卷。對齊時印刷字會重疊成一體、只剩兩人筆跡不同。本機產生、未上傳。</p></header>
{''.join(sections)}
<script>
function stage(el){{return el.closest('section').querySelector('.stage')}}
function setOp(el){{stage(el).querySelector('.tpl').style.opacity=el.value/100; el.parentElement.querySelector('.v').textContent=el.value+'%'}}
function setDiff(el){{stage(el).classList.toggle('diff',el.checked)}}
function setBox(el){{stage(el).classList.toggle('nobox',!el.checked)}}
</script></body></html>'''
open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(page)
print('saved', os.path.join(OUT, 'index.html'))
