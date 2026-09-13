# -*- coding: utf-8 -*-
"""RedPen 疊合（配準）核心：答案卷模板頁 → 學生掃描卷（合併圖）。

流程（純 CPU、零 AI，來源＝local-only/exp-register-2026-09-14 實驗）：
  1. 模板頁與學生圖統一寬 W=1200（A4 ≈ 0.175 mm/px），SIFT 特徵 + 比值測試 + RANSAC 單應矩陣 H。
  2. 頁級守門：inlier 數 ≥ MIN_INLIERS 且結構分（warp 後印刷邊緣 NCC）≥ MIN_STRUCTURE。
     （反例：別科模板 inlier ≤ 47、結構分 ≤ 0.13；正例 inlier ≥ 78、結構分 ≥ 0.33）
  3. 逐格版面一致：每格取「投影格外擴 25%（含題號/標籤）、格內手寫區遮掉」的印刷邊緣 patch，
     在學生圖 ±5mm 內找 NCC 峰；最佳位移 ≤ 2.5mm ＝ 該格版面一致。一致率 = OK/可判定格，
     另加頁級「各格最佳位移中位 ≤ 2.5mm」。（實測：同版面 ≥0.83、另版答案卷 ≤0.23、別科 ≤0.62 且頁級守門先擋）
     線性漂移（掃描進紙歪斜、數學卷下半頁 ~1.4mm）由吸附修正：投影邊 2.5mm 內有學生印刷線就吸上去
     （錨點來自學生那張圖本身）；沒線的格用該格 NCC 最佳位移。
  4. 任一模板頁不過 → 整份退回 classify（不逐格混用）。
"""
from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import cv2
import numpy as np

W = 1200                 # 統一處理寬度
MM = 210.0 / W           # mm/px（以 A4 寬換算；B4 會略偏，容差相對值仍適用）
MIN_INLIERS = 60
MIN_STRUCTURE = 0.25
LINE_TOL_MM = 2.5        # 吸附：投影邊附近找學生印刷線的搜尋半徑
CELL_SEARCH_MM = 5.0     # 逐格 NCC 搜尋半徑
CELL_SHIFT_TOL_MM = 2.5  # 逐格最佳位移 ≤ 此值＝該格版面一致（同版面掃描漂移 ≤1.5mm；另版 5~7mm）
PAGE_SHIFT_TOL_MM = 2.5  # 頁級：各格最佳位移中位數 ≤ 此值
MIN_DECIDABLE_RATIO = 0.3  # 可判定格佔比低於此 → 不敢下結論
DEFAULT_MIN_CONSISTENCY = 0.75  # 實測：同版面 ≥0.83（數學稀疏格最低）、另版 ≤0.23

_sift = cv2.SIFT_create(nfeatures=6000)
_bf = cv2.BFMatcher(cv2.NORM_L2)


# ── 影像工具 ──────────────────────────────────────────────────────────────
def decode_gray(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError('image decode failed')
    h, w = img.shape[:2]
    return cv2.resize(img, (W, int(round(h * W / w))), interpolation=cv2.INTER_AREA)


def _binarize(g: np.ndarray) -> np.ndarray:
    return cv2.adaptiveThreshold(g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 12)


def _cluster(idx: np.ndarray) -> np.ndarray:
    rows: List[List[int]] = []
    for v in idx:
        if rows and v - rows[-1][-1] <= 2:
            rows[-1].append(int(v))
        else:
            rows.append([int(v)])
    return np.array([float(np.mean(r)) for r in rows]) if rows else np.zeros(0)


def hlines(g: np.ndarray) -> np.ndarray:
    """印刷橫線的 y 座標（px）。長橫核開運算 → 逐列投影峰。核與門檻用絕對 px（合併圖高度是模板的 N 倍）。"""
    bw = _binarize(g)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (int(W * 0.05), 1))
    op = cv2.morphologyEx(bw, cv2.MORPH_OPEN, k)
    prof = (op > 0).sum(1)
    return _cluster(np.where(prof > W * 0.04)[0])


def vlines(g: np.ndarray) -> np.ndarray:
    """印刷直線的 x 座標（px）。"""
    bw = _binarize(g)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, int(W * 0.03)))
    op = cv2.morphologyEx(bw, cv2.MORPH_OPEN, k)
    prof = (op > 0).sum(0)
    return _cluster(np.where(prof > W * 0.02)[0])


def _edge(g: np.ndarray) -> np.ndarray:
    return cv2.GaussianBlur(cv2.Canny(g, 60, 160).astype(np.float32), (0, 0), 2.0)


def _nearest(lines: np.ndarray, v: float, lim: float) -> Optional[float]:
    if lines.size == 0:
        return None
    d = lines - v
    i = int(np.argmin(np.abs(d)))
    return float(lines[i]) if abs(d[i]) <= lim else None


# ── 模板快取 ──────────────────────────────────────────────────────────────
@dataclass
class TemplatePage:
    gray: np.ndarray
    kp: list
    des: Optional[np.ndarray]
    hl: np.ndarray
    vl: np.ndarray


class TemplateCache:
    def __init__(self, capacity: int = 64):
        self._d: 'OrderedDict[str, TemplatePage]' = OrderedDict()
        self._cap = capacity
        self._lock = threading.Lock()

    @staticmethod
    def key(data: bytes) -> str:
        return hashlib.sha1(data).hexdigest()

    def get(self, data: bytes) -> TemplatePage:
        k = self.key(data)
        with self._lock:
            if k in self._d:
                self._d.move_to_end(k)
                return self._d[k]
        g = decode_gray(data)
        kp, des = _sift.detectAndCompute(g, None)
        page = TemplatePage(gray=g, kp=kp, des=des, hl=hlines(g), vl=vlines(g))
        with self._lock:
            self._d[k] = page
            if len(self._d) > self._cap:
                self._d.popitem(last=False)
        return page


TEMPLATES = TemplateCache()


# ── 學生圖（每次請求一份）────────────────────────────────────────────────
@dataclass
class StudentImage:
    gray: np.ndarray
    kp: list
    des: Optional[np.ndarray]
    hl: np.ndarray
    vl: np.ndarray

    @classmethod
    def load(cls, data: bytes) -> 'StudentImage':
        g = decode_gray(data)
        kp, des = _sift.detectAndCompute(g, None)
        return cls(gray=g, kp=kp, des=des, hl=hlines(g), vl=vlines(g))


# ── 配準 ──────────────────────────────────────────────────────────────────
@dataclass
class PageResult:
    page: int
    ok: bool
    reason: str = ''
    inliers: int = 0
    structure: float = 0.0
    consistency: Optional[float] = None
    median_shift_mm: Optional[float] = None
    decidable: int = 0
    total: int = 0
    residual_px: Optional[float] = None
    H: Optional[np.ndarray] = field(default=None, repr=False)


def _homography(t: TemplatePage, s: StudentImage) -> Tuple[Optional[np.ndarray], int, Optional[float]]:
    if t.des is None or s.des is None or len(t.kp) < 20 or len(s.kp) < 20:
        return None, 0, None
    m = _bf.knnMatch(t.des, s.des, k=2)
    good = [a for a, b in (p for p in m if len(p) == 2) if a.distance < 0.75 * b.distance]
    if len(good) < 12:
        return None, 0, None
    src = np.float32([t.kp[a.queryIdx].pt for a in good]).reshape(-1, 1, 2)
    dst = np.float32([s.kp[a.trainIdx].pt for a in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    if H is None or mask is None:
        return None, 0, None
    inl = int(mask.sum())
    proj = cv2.perspectiveTransform(src, H).reshape(-1, 2)
    err = np.linalg.norm(proj - dst.reshape(-1, 2), axis=1)[mask.ravel() == 1]
    return H, inl, float(np.median(err)) if err.size else None


def _structure_score(t: TemplatePage, s: StudentImage, H: np.ndarray) -> float:
    hs, ws = s.gray.shape
    ht, wt = t.gray.shape
    warped = cv2.warpPerspective(t.gray, H, (ws, hs), borderValue=255)
    c = cv2.perspectiveTransform(np.float32([[[0, 0], [wt, 0], [wt, ht], [0, ht]]]), H).reshape(-1, 2)
    x0, y0 = np.clip(c.min(0), 0, [ws, hs]).astype(int)
    x1, y1 = np.clip(c.max(0), 0, [ws, hs]).astype(int)
    if x1 - x0 < 100 or y1 - y0 < 100:
        return 0.0
    a = _edge(warped[y0:y1, x0:x1]); b = _edge(s.gray[y0:y1, x0:x1])
    a = a - a.mean(); b = b - b.mean()
    d = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / d) if d > 0 else 0.0


def _warp_pt(H: np.ndarray, x: float, y: float) -> Tuple[float, float]:
    p = cv2.perspectiveTransform(np.float32([[[x, y]]]), H).reshape(2)
    return float(p[0]), float(p[1])


def _cell_probe(warped_edge: np.ndarray, stu_edge: np.ndarray, x0: float, y0: float, x1: float, y1: float,
                search_px: int) -> Optional[Tuple[float, float, float, float]]:
    """回 (dx, dy, ncc_best, ncc_zero)：外擴 25%＋遮格內；None＝不可判定（出界/無印刷內容）"""
    hs, ws = stu_edge.shape
    mw, mh = (x1 - x0) * 0.25 + 6, (y1 - y0) * 0.25 + 6
    # 外擴後貼到影像邊界就裁掉（頁邊的寬格不能因此變成不可判定）；格本身出界才放棄
    px0, py0 = int(max(0, x0 - mw)), int(max(0, y0 - mh))
    px1, py1 = int(min(ws, x1 + mw)), int(min(hs, y1 + mh))
    if x0 < 0 or y0 < 0 or x1 > ws or y1 > hs or px1 - px0 < 8 or py1 - py0 < 8:
        return None
    patch = warped_edge[py0:py1, px0:px1]
    ph, pw = patch.shape
    mask = np.ones((ph, pw), np.float32)
    iy0, iy1 = int(y0 - py0 + (y1 - y0) * 0.15), int(y1 - py0 - (y1 - y0) * 0.15)
    ix0, ix1 = int(x0 - px0 + (x1 - x0) * 0.15), int(x1 - px0 - (x1 - x0) * 0.15)
    if iy1 > iy0 and ix1 > ix0:
        mask[iy0:iy1, ix0:ix1] = 0
    if float((patch * mask).std()) < 1e-3:
        return None
    sx0, sy0 = max(0, px0 - search_px), max(0, py0 - search_px)
    sx1, sy1 = min(ws, px1 + search_px), min(hs, py1 + search_px)
    win = stu_edge[sy0:sy1, sx0:sx1]
    if win.shape[0] <= ph or win.shape[1] <= pw:
        return None
    res = cv2.matchTemplate(win, patch, cv2.TM_CCORR_NORMED, mask=mask)
    _, best, _, loc = cv2.minMaxLoc(res)
    zy, zx = py0 - sy0, px0 - sx0
    zero = float(res[zy, zx]) if 0 <= zy < res.shape[0] and 0 <= zx < res.shape[1] else float('nan')
    return float((sx0 + loc[0]) - px0), float((sy0 + loc[1]) - py0), float(best), zero


def register(template_pages: List[bytes], boxes: List[dict], student: bytes,
             page_breaks: Optional[List[float]] = None,
             min_consistency: float = DEFAULT_MIN_CONSISTENCY,
             snap: str = 'lines') -> dict:
    """
    boxes: [{id, page, bbox:{x,y,w,h}}]（模板頁 normalized）
    snap: 'lines'（投影邊吸附學生印刷線、沒線用該格 NCC 位移）| 'ncc'（只用該格 NCC 位移）| 'none'
    回：{decision, reason, pages:[...], boxes:[{id, page, bbox(學生合併圖 normalized), status, snapped_edges, shift_mm}], ms}
    """
    t0 = time.time()
    stu = StudentImage.load(student)
    hs, ws = stu.gray.shape
    stu_edge = _edge(stu.gray)
    lim = LINE_TOL_MM / MM
    search_px = int(CELL_SEARCH_MM / MM)
    page_results: List[PageResult] = []
    out_boxes: List[dict] = []
    for p, data in enumerate(template_pages):
        tpl = TEMPLATES.get(data)
        ht, wt = tpl.gray.shape
        pr = PageResult(page=p, ok=False)
        H, inl, resid = _homography(tpl, stu)
        pr.inliers = inl; pr.residual_px = resid; pr.H = H
        if H is None or inl < MIN_INLIERS:
            pr.reason = f'inliers {inl} < {MIN_INLIERS}'
            page_results.append(pr); continue
        pr.structure = _structure_score(tpl, stu, H)
        if pr.structure < MIN_STRUCTURE:
            pr.reason = f'structure {pr.structure:.2f} < {MIN_STRUCTURE}'
            page_results.append(pr); continue
        warped_edge = _edge(cv2.warpPerspective(tpl.gray, H, (ws, hs), borderValue=255))
        ok = fail = 0
        shifts: List[float] = []
        page_boxes: List[dict] = []
        for b in boxes:
            if int(b.get('page', 0)) != p:
                continue
            bb = b['bbox']
            pts = np.float32([[bb['x'] * wt, bb['y'] * ht], [(bb['x'] + bb['w']) * wt, (bb['y'] + bb['h']) * ht]]).reshape(-1, 1, 2)
            q = cv2.perspectiveTransform(pts, H).reshape(-1, 2)
            x0, y0 = float(q[0][0]), float(q[0][1]); x1, y1 = float(q[1][0]), float(q[1][1])
            probe = _cell_probe(warped_edge, stu_edge, x0, y0, x1, y1, search_px)
            status = 'na'; dx = dy = 0.0
            if probe is not None:
                dx, dy, _best, _zero = probe
                shift_mm = float(np.hypot(dx, dy)) * MM
                shifts.append(shift_mm)
                if shift_mm <= CELL_SHIFT_TOL_MM:
                    status = 'ok'; ok += 1
                else:
                    status = 'fail'; fail += 1
            # 吸附
            new = {'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1}
            snapped: List[str] = []
            if snap == 'lines':
                cx_t, cy_t = (bb['x'] + bb['w'] / 2) * wt, (bb['y'] + bb['h'] / 2) * ht
                for name, tv, tl, sl, axis in (
                    ('top', bb['y'] * ht, tpl.hl, stu.hl, 'h'),
                    ('bottom', (bb['y'] + bb['h']) * ht, tpl.hl, stu.hl, 'h'),
                    ('left', bb['x'] * wt, tpl.vl, stu.vl, 'v'),
                    ('right', (bb['x'] + bb['w']) * wt, tpl.vl, stu.vl, 'v'),
                ):
                    tline = _nearest(tl, tv, lim)
                    if tline is None:
                        continue  # 模板該邊沒印刷線 → 不吸
                    tline_w = _warp_pt(H, cx_t, tline)[1] if axis == 'h' else _warp_pt(H, tline, cy_t)[0]
                    sline = _nearest(sl, tline_w, lim)
                    if sline is None:
                        continue
                    delta = sline - tline_w  # 投影邊跟著「模板線→學生線」的偏移走
                    if name == 'top': new['y0'] += delta
                    elif name == 'bottom': new['y1'] += delta
                    elif name == 'left': new['x0'] += delta
                    else: new['x1'] += delta
                    snapped.append(name)
                if not snapped and status == 'ok':
                    new = {'x0': x0 + dx, 'y0': y0 + dy, 'x1': x1 + dx, 'y1': y1 + dy}; snapped = ['ncc']
            elif snap == 'ncc' and status == 'ok':
                new = {'x0': x0 + dx, 'y0': y0 + dy, 'x1': x1 + dx, 'y1': y1 + dy}; snapped = ['ncc']
            nx0, ny0 = max(0.0, min(new['x0'], new['x1'])), max(0.0, min(new['y0'], new['y1']))
            nx1, ny1 = min(float(ws), max(new['x0'], new['x1'])), min(float(hs), max(new['y0'], new['y1']))
            page_boxes.append({
                'id': b['id'], 'page': p, 'status': status,
                'bbox': {'x': nx0 / ws, 'y': ny0 / hs, 'w': (nx1 - nx0) / ws, 'h': (ny1 - ny0) / hs},
                'snapped_edges': snapped,
                'shift_mm': round(float(np.hypot(dx, dy)) * MM, 2) if probe is not None else None,
            })
        n = len(page_boxes)
        pr.total = n; pr.decidable = ok + fail
        if n == 0:
            pr.ok = True; pr.reason = 'no boxes on page'
        elif pr.decidable < max(3, MIN_DECIDABLE_RATIO * n):
            pr.reason = f'decidable {pr.decidable}/{n} too few'
        else:
            pr.consistency = ok / pr.decidable
            pr.median_shift_mm = float(np.median(shifts))
            if pr.consistency < min_consistency:
                pr.reason = f'consistency {pr.consistency:.2f} < {min_consistency}'
            elif pr.median_shift_mm > PAGE_SHIFT_TOL_MM:
                pr.reason = f'median shift {pr.median_shift_mm:.1f}mm > {PAGE_SHIFT_TOL_MM}'
            else:
                pr.ok = True
        page_results.append(pr)
        out_boxes.extend(page_boxes)

    all_ok = all(pr.ok for pr in page_results) and len(page_results) > 0
    reason = '' if all_ok else '; '.join(f'p{pr.page}: {pr.reason}' for pr in page_results if not pr.ok)
    return {
        'decision': 'aligned' if all_ok else 'fallback',
        'reason': reason,
        'pages': [{
            'page': pr.page, 'ok': pr.ok, 'reason': pr.reason, 'inliers': pr.inliers,
            'structure': round(pr.structure, 3),
            'consistency': None if pr.consistency is None else round(pr.consistency, 3),
            'median_shift_mm': None if pr.median_shift_mm is None else round(pr.median_shift_mm, 2),
            'decidable': pr.decidable, 'total': pr.total,
            'residual_px': None if pr.residual_px is None else round(pr.residual_px, 2),
        } for pr in page_results],
        'boxes': out_boxes if all_ok else [],
        'student_size': {'w': ws, 'h': hs},
        'ms': int((time.time() - t0) * 1000),
    }
