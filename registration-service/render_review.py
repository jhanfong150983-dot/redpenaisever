# -*- coding: utf-8 -*-
"""把疊合結果畫在學生卷上供人工檢視：綠框＝服務最終格位（投影＋吸附）、紅字＝題號；每頁附守門數字。
用法：python render_review.py <exp-register 資料夾> <輸出資料夾> [每份作業幾位學生]
產出：<out>/index.html ＋ 各張 jpg（本機檔案、不上傳）
"""
import base64, html, json, os, sys
import cv2, numpy as np
sys.stdout.reconfigure(encoding='utf-8'); sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import register_core as rc

ROOT, OUT = sys.argv[1], sys.argv[2]; N = int(sys.argv[3]) if len(sys.argv) > 3 else 3; SNAP = sys.argv[4] if len(sys.argv) > 4 else 'lines'
os.makedirs(OUT, exist_ok=True)
meta = json.load(open(os.path.join(ROOT, 'meta.json'), encoding='utf-8'))
rd = lambda p: open(p, 'rb').read()
cards = []
for key, m in meta.items():
    pages = [rd(os.path.join(ROOT, key, p)) for p in m['tplPages']]
    boxes = [{'id': b['id'], 'page': b['page'], 'bbox': b['bbox'], 'kind': b.get('cat')} for b in m['tplBoxes']]
    for s in m['students'][:N]:
        raw = rd(os.path.join(ROOT, key, s['file']))
        r = rc.register(pages, boxes, raw, s.get('page_breaks'), snap=SNAP)
        g = rc.decode_gray(raw); hs, ws = g.shape
        color = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
        # 退回時仍畫出「純投影」讓人看它為什麼不對（用各頁 H）
        drawn = 0
        if r['decision'] == 'aligned':
            for b in r['boxes']:
                bb = b['bbox']; x0, y0 = int(bb['x'] * ws), int(bb['y'] * hs); x1, y1 = int((bb['x'] + bb['w']) * ws), int((bb['y'] + bb['h']) * hs)
                col = (0, 170, 0) if b['status'] == 'ok' else (0, 140, 255)
                cv2.rectangle(color, (x0, y0), (x1, y1), col, 2)
                cv2.putText(color, b['id'], (x0 + 2, max(12, y0 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 230), 1, cv2.LINE_AA)
                drawn += 1
        else:
            stu = rc.StudentImage.load(raw, page_breaks=s.get('page_breaks'), n_pages_hint=len(pages))
            for p, data in enumerate(pages):
                tpl = rc.TEMPLATES.get(data); H, inl, _ = rc._homography(tpl, stu, prefer=p if len(stu.segments) == len(pages) else None)
                if H is None: continue
                ht, wt = tpl.gray.shape
                for b in boxes:
                    if b['page'] != p: continue
                    bb = b['bbox']; pts = np.float32([[bb['x'] * wt, bb['y'] * ht], [(bb['x'] + bb['w']) * wt, (bb['y'] + bb['h']) * ht]]).reshape(-1, 1, 2)
                    q = cv2.perspectiveTransform(pts, H).reshape(-1, 2)
                    cv2.rectangle(color, tuple(q[0].astype(int)), tuple(q[1].astype(int)), (0, 0, 255), 2); drawn += 1
        fn = f'{key}-{s["id"][:14]}.jpg'
        cv2.imencode('.jpg', color, [cv2.IMWRITE_JPEG_QUALITY, 78])[1].tofile(os.path.join(OUT, fn))
        pg = ' ｜ '.join(f"第{p['page']+1}頁：{'✔ 通過' if p['ok'] else '✘ ' + p['reason']}（特徵點 {p['inliers']}、結構分 {p['structure']}、一致率 {p['consistency']}、中位位移 {p['median_shift_mm']} mm）" for p in r['pages'])
        cards.append((m['title'], s['id'][:14], r['decision'], pg, fn, drawn, r['ms']))
        print(key, s['id'][:14], r['decision'], drawn, 'boxes', r['ms'], 'ms')

items = []
for title, sid, dec, pg, fn, drawn, ms in cards:
    badge = '<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:6px">疊合成功 → 免 classify</span>' if dec == 'aligned' else '<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:6px">退回 classify</span>'
    hint = '綠框＝疊合後的格位（也就是批改要裁的範圍），橘框＝該格內容比對沒過但仍投影' if dec == 'aligned' else '紅框＝純投影結果（沒有採用），看得出模板版面跟學生卷對不上'
    items.append(f'<section><h2>{html.escape(title)} ｜ 學生 {sid} {badge} <small>{ms} ms</small></h2><p class="stat">{html.escape(pg)}</p><p class="hint">{hint}</p><img src="{fn}" loading="lazy"></section>')
page = f'''<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>疊合結果人工檢視</title>
<style>body{{font-family:"Microsoft JhengHei",system-ui,sans-serif;margin:0;background:#f4f4f5;color:#18181b}}header{{padding:16px 24px;background:#fff;border-bottom:1px solid #e4e4e7}}
section{{background:#fff;margin:16px 24px;padding:16px;border-radius:12px;border:1px solid #e4e4e7}}h2{{font-size:16px;margin:0 0 6px}}.stat{{font-size:12px;color:#52525b;margin:4px 0}}.hint{{font-size:12px;color:#3f3f46;margin:4px 0 10px}}img{{width:100%;max-width:1100px;border:1px solid #d4d4d8}}</style></head>
<body><header><h1 style="margin:0;font-size:18px">疊合結果人工檢視（{len(cards)} 份）</h1><p style="margin:6px 0 0;font-size:13px;color:#52525b">老師答案卷當模板 → 疊到學生掃描卷 → 綠框就是免 classify 直接裁格的位置。本機產生、未上傳。</p></header>{''.join(items)}</body></html>'''
open(os.path.join(OUT, 'index.html'), 'w', encoding='utf-8').write(page)
print('saved', os.path.join(OUT, 'index.html'))
