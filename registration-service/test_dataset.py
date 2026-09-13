# -*- coding: utf-8 -*-
"""用 local-only/exp-register-2026-09-14 的實驗資料（scratchpad meta.json）驗證 register_core 的守門：
正例（同版面）應 aligned、英語第 1/2 頁（另版）與反例（別科模板）應 fallback。
用法：python test_dataset.py <exp-register 資料夾>
"""
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import register_core as rc  # noqa: E402

ROOT = sys.argv[1]
meta = json.load(open(os.path.join(ROOT, 'meta.json'), encoding='utf-8'))
rd = lambda p: open(p, 'rb').read()

print('【正例：同作業】')
for key, m in meta.items():
    pages = [rd(os.path.join(ROOT, key, p)) for p in m['tplPages']]
    boxes = [{'id': b['id'], 'page': b['page'], 'bbox': b['bbox']} for b in m['tplBoxes']]
    n_al = 0
    for s in m['students']:
        t0 = time.time()
        r = rc.register(pages, boxes, rd(os.path.join(ROOT, key, s['file'])), s.get('page_breaks'))
        n_al += r['decision'] == 'aligned'
        pg = ' | '.join(f"p{p['page']} inl={p['inliers']} st={p['structure']:.2f} cons={p['consistency']} ({p['decidable']}/{p['total']}) {'OK' if p['ok'] else 'X:' + p['reason']}" for p in r['pages'])
        print(f"  {key:<9}{s['id'][:14]:<15} {r['decision']:<9} {int((time.time() - t0) * 1000):>5}ms  {pg}")
    print(f"  → {key}: aligned {n_al}/{len(m['students'])}")

print('\n【反例：別科模板套】')
for tkey, skey in [('math_ao', 'guoyu_ao'), ('guoyu_ao', 'math_ao'), ('eng_wq', 'math_ao'), ('math_ao', 'eng_wq'), ('eng_wq', 'guoyu_ao')]:
    m = meta[tkey]
    pages = [rd(os.path.join(ROOT, tkey, p)) for p in m['tplPages']]
    boxes = [{'id': b['id'], 'page': b['page'], 'bbox': b['bbox']} for b in m['tplBoxes']]
    n_fb = 0
    for s in meta[skey]['students'][:5]:
        r = rc.register(pages, boxes, rd(os.path.join(ROOT, skey, s['file'])))
        n_fb += r['decision'] == 'fallback'
    print(f"  {tkey}→{skey}: fallback {n_fb}/5")
