# -*- coding: utf-8 -*-
"""對已部署的服務打 /health 與 /register（用 exp-register 實驗資料）。
用法：python smoke_remote.py https://<host> <exp-register 資料夾>
"""
import base64, json, os, sys, time, urllib.request
sys.stdout.reconfigure(encoding='utf-8')
URL, ROOT = sys.argv[1].rstrip('/'), sys.argv[2]
meta = json.load(open(os.path.join(ROOT, 'meta.json'), encoding='utf-8'))
print('health:', json.load(urllib.request.urlopen(URL + '/health', timeout=30)))
b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()
for key in ['math_ao', 'guoyu_ao', 'eng_wq']:
    m = meta[key]
    for s in m['students'][:2]:
        body = {'template_id': m['templateId'], 'template_pages': [b64(os.path.join(ROOT, key, p)) for p in m['tplPages']],
                'boxes': [{'id': b['id'], 'page': b['page'], 'bbox': b['bbox']} for b in m['tplBoxes']],
                'student_image': b64(os.path.join(ROOT, key, s['file'])), 'page_breaks': s.get('page_breaks')}
        req = urllib.request.Request(URL + '/register', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        t0 = time.time(); r = json.load(urllib.request.urlopen(req, timeout=120)); dt = int((time.time() - t0) * 1000)
        print(f"{key:<9}{s['id'][:14]:<15} {r['decision']:<9} boxes={len(r['boxes']):>3} svc={r['ms']:>5}ms http={dt:>5}ms  {r.get('reason') or ''}")
