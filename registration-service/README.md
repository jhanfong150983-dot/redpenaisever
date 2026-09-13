# RedPen Registration Service（疊合免 classify）

把老師上傳的答案卷 PDF 當「版面模板」，學生掃描 PDF 用特徵配準疊上去，模板格位直接投影到學生卷，
批改 Phase A 不再呼叫 AI classify。純 CPU（OpenCV SIFT + RANSAC），零 AI，每份 0.4〜2 秒。

實驗與門檻依據：`local-only/exp-register-2026-09-14/`、memory `project_registration_skip_classify_feasibility_2026-09-14`。

## 介面

### `POST /register`
```json
{
  "template_id": "1789313892065-64umbevov",
  "template_pages": ["<base64 webp/jpg/png>", "..."],
  "boxes": [{ "id": "1-1-1", "page": 0, "bbox": { "x": 0.07, "y": 0.18, "w": 0.17, "h": 0.06 } }],
  "student_image": "<base64 學生合併圖（多頁直向堆疊）>",
  "page_breaks": [0.33, 0.66],
  "min_consistency": 0.75,
  "snap": "lines"
}
```
回：
```json
{ "decision": "aligned" | "fallback", "reason": "p1: consistency 0.31 < 0.75",
  "pages": [{ "page": 0, "ok": true, "inliers": 1088, "structure": 0.91, "consistency": 1.0, "median_shift_mm": 0.2, "decidable": 48, "total": 48 }],
  "boxes": [{ "id": "1-1-1", "page": 0, "bbox": { "x": .., "y": .., "w": .., "h": .. }, "status": "ok", "snapped_edges": ["top","bottom"], "shift_mm": 0.3 }],
  "ms": 612 }
```
- `boxes[].bbox` 是**學生合併圖** normalized 座標，可直接當 classify 的 `answerBbox`。
- `decision: fallback` 時 `boxes` 為空，呼叫端走原本 classify。整份不逐格混用。

### 守門（register_core.py 頂部常數）
1. 頁級：inlier ≥ 60、結構分 ≥ 0.25（別科模板 inlier ≤ 47、結構分 ≤ 0.13）。
2. 逐格：格外擴 25%（含題號）、遮格內手寫，±5mm 找 NCC 峰；最佳位移 ≤ 2.5mm ＝ 一致。
   一致率 ≥ 0.75 且頁中位位移 ≤ 2.5mm 才用（同版面 ≥ 0.83；另一版答案卷 ≤ 0.69；實測 12/12、12/12、另版 0/12 全退）。
3. 吸附：投影邊 2.5mm 內有學生印刷線就吸上去（掃描進紙漸進歪斜由此吸收）。

## 本機
```bash
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8010
python test_dataset.py <exp-register 資料夾>   # 用實驗資料驗證守門
```

## 部署
Docker：`docker build -t redpen-registration . && docker run -p 8010:8010 redpen-registration`
（Cloud Run / Fly.io / Render 任一 CPU 小機即可；記憶體 512MB 夠）

Vercel 環境變數（redpenaisever）：
- `REGISTRATION_URL=https://<host>`（設了才啟用）
- `REGISTRATION_ENABLED=0` 關閉（kill switch）
- `REGISTRATION_MODES=answer_only,with_questions`（預設兩種都開）
- `REGISTRATION_TIMEOUT_MS=30000`
