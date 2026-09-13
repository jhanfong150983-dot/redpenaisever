# -*- coding: utf-8 -*-
# 起本機服務、用實驗資料打一次 /register（數學 1 位學生、國語 1 位、英語 1 位）
import base64, json, os, subprocess, sys, time, urllib.request
sys.stdout.reconfigure(encoding='utf-8')
ROOT = sys.argv[1]; meta = json.load(open(os.path.join(ROOT, 'meta.json'), encoding='utf-8'))
proc = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app:app', '--port', '8010'], cwd=os.path.dirname(os.path.abspath(__file__)), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(40):
        try: urllib.request.urlopen('http://127.0.0.1:8010/health', timeout=1); break
        except Exception: time.sleep(0.5)
    b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode()
    for key in ['math_ao', 'guoyu_ao', 'eng_wq']:
        m = meta[key]; s = m['students'][0]
        body = {'template_id': m['templateId'], 'template_pages': [b64(os.path.join(ROOT, key, p)) for p in m['tplPages']],
                'boxes': [{'id': b['id'], 'page': b['page'], 'bbox': b['bbox']} for b in m['tplBoxes']],
                'student_image': b64(os.path.join(ROOT, key, s['file'])), 'page_breaks': s.get('page_breaks')}
        req = urllib.request.Request('http://127.0.0.1:8010/register', data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        t0 = time.time(); r = json.load(urllib.request.urlopen(req, timeout=120)); dt = int((time.time() - t0) * 1000)
        print(key, r['decision'], r.get('reason') or '', 'boxes', len(r['boxes']), 'ms', r['ms'], 'http', dt, '| pages', [(p['page'], p['ok'], p['consistency']) for p in r['pages']])
        if r['boxes']: print('   sample box', r['boxes'][0])
    # 第二次同模板（快取命中）
    t0 = time.time(); json.load(urllib.request.urlopen(req, timeout=120)); print('cached 2nd call ms', int((time.time() - t0) * 1000))
finally:
    proc.terminate()
