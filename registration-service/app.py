"""RedPen 疊合（配準）微服務：答案卷模板 → 學生掃描卷，免 classify 定位。

POST /register
  { "template_id": "tpl-xxx",
    "template_pages": ["<base64 webp/jpg/png>", ...],          // 依頁序
    "boxes": [{ "id": "1-1-1", "page": 0, "bbox": {"x":..,"y":..,"w":..,"h":..} }],  // 模板頁 normalized
    "student_image": "<base64>",                                // 學生合併圖（多頁直向堆疊）
    "page_breaks": [0.33, 0.66] | null,
    "min_consistency": 0.75, "snap": "lines" }
  → { "decision": "aligned"|"fallback", "reason", "pages": [...], "boxes": [{id,page,bbox(學生圖 normalized),status,snapped_edges}], "ms" }
GET /health
"""
import base64
import os
import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import register_core

app = FastAPI(title='RedPen Registration Service', version='1.0')


class Box(BaseModel):
    id: str
    page: int = 0
    bbox: dict
    kind: Optional[str] = None  # questionCategory（作圖類不做包圍格吸附）


class RegisterReq(BaseModel):
    template_id: Optional[str] = None
    template_pages: List[str]
    boxes: List[Box]
    student_image: str
    page_breaks: Optional[List[float]] = None
    min_consistency: float = register_core.DEFAULT_MIN_CONSISTENCY
    snap: str = 'cell'  # 'cell' | 'lines' | 'ncc' | 'none'


@app.get('/health')
def health():
    return {'status': 'ok', 'version': app.version, 'cached_templates': len(register_core.TEMPLATES._d)}


@app.post('/register')
def register(req: RegisterReq):
    t0 = time.time()
    try:
        pages = [base64.b64decode(p) for p in req.template_pages]
        student = base64.b64decode(req.student_image)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail='invalid base64')
    if not pages:
        raise HTTPException(status_code=400, detail='template_pages empty')
    try:
        result = register_core.register(
            pages, [b.model_dump() for b in req.boxes], student,
            page_breaks=req.page_breaks, min_consistency=req.min_consistency, snap=req.snap,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    result['template_id'] = req.template_id
    result['ms'] = int((time.time() - t0) * 1000)
    return result


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', '8010')))
