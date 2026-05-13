# OCR 伺服器 — 關機 / 重啟 SOP

Cloudflare tunnel 暴露的 PaddleOCR server、用於 classify 階段的 OCR-assist。
**關鍵特性**：Cloudflare tunnel URL <b>每次重啟都會變</b>、不是固定的、所以重啟要記得更新 production env vars。

---

## 🔥 關機前必做（不要跳過）

### 1. 去 Vercel 把 OCR 旗標關掉

`Settings → Environment Variables → Production`

```
OCR_ASSIST_CLASSIFY_ENABLED = false
```

### 2. 為什麼這條重要

如果不關、production server 還是會試著呼叫 OCR、撞到 cloudflared 已關 → 每份卷子每頁<b>等 45 秒 timeout</b>（[`DEFAULT_TIMEOUT_MS`](../server/ai/ocr-client.js#L22)）才 fallback、會發生：

- 學生 / 老師批改卡 45 秒以上、體感極差
- Gemini API 還是會被呼叫（fallback 之後仍要 classify）、ink / 費用照扣
- Vercel function 可能撞 maxDuration (300s) 被砍掉、造成 grading_failed 累積

設成 `false` 後、server 跳過 OCR call、立刻走純視覺 classify、沒 timeout penalty。

### 3. 等 env 生效

- 通常 1-2 分鐘 propagate 到 production runtime
- 或在 Vercel 手動 redeploy（如果你怕 cached env）

### 4. 確認沒有正在批改的請求

- Vercel logs 看 `/api/proxy` 流量降到 0
- 或老師批改頁面看「批改中」狀態為 0

---

## 🛑 關機步驟

```
1. （前提：OCR_ASSIST_CLASSIFY_ENABLED 已設為 false 並生效）
2. Ctrl+C 停 cloudflared tunnel（terminal）
3. Ctrl+C 停 PaddleOCR server（另一個 terminal）
```

---

## ⚠️ 關機期間影響

| 功能 | 狀態 |
|---|---|
| 批改主流程 | ✅ 仍可用（純視覺 classify + read AI） |
| fill_blank 線段圖填空 anchor | ⚠️ 退化（blank_paren matcher 沒用） |
| single_choice 結構 anchor | ⚠️ 退化（純視覺判斷括號位置） |
| answer_only 模式（譬如物理畢業考） | ⚠️ 大幅退化（cell_anchor 失效） |
| word_problem / calculation | ✅ 不影響 |
| 老師訂正派發 / 學生上傳 / 重批 | ✅ 不影響 |
| Admin dashboard「OCR-assist 命中」 | 顯示 0% 或 - |

簡單說：**word_problem 為主的卷子幾乎無感、fill_blank/選擇題為主的卷子精準度會降**。

---

## 🚀 重啟流程

### Step 1：啟動 PaddleOCR server

```powershell
# 1. cd 到 OCR server 目錄
cd C:\paddleocr-server

# 2. 啟動 venv
.\venv\Scripts\Activate.ps1

# 3. 啟動 FastAPI server（entry point = main.py、port 8000）
uvicorn main:app --host 0.0.0.0 --port 8000
```

⚠️ 注意：
- **`(venv)` 必須出現在 prompt 前面**才代表 venv 啟動成功
- 如果 `Activate.ps1` 跑不了、先執行：
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
  ```
- 如果 uvicorn 報 `Could not import module "main"`、表示在錯的目錄。先 `Get-ChildItem *.py` 確認當前目錄有 `main.py`

### Step 2：確認 OCR 本地能用

開另一個 terminal、直接 curl 本機：

```powershell
curl -X POST http://localhost:8000/ocr -H "X-API-Key: dev-secret-please-change" -F "file=@test.jpg"
```

回 200 + `{ "detections": [...] }` 才算 OK。

### Step 3：啟動 cloudflared tunnel

cloudflared.exe 放在 `C:\cloudflared\cloudflared.exe`、不在系統 PATH 上、所以**要用相對路徑跑、不是直接打 `cloudflared`**：

```powershell
cd C:\cloudflared
.\cloudflared.exe tunnel --url http://localhost:8000
```

⚠️ 注意：
- **必須加 `.\` 前綴**（PowerShell 安全機制、不會自動從當前目錄找 exe）
- 直接打 `cloudflared tunnel ...` 會報 `not recognized as a cmdlet`、不要被嚇到
- 如果想以後直接打 `cloudflared`、要把 `C:\cloudflared` 加進系統 PATH

會印出新 URL、譬如：
```
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://abcdef-12345-xyz.trycloudflare.com
```

**⚠️ 複製這個 URL、每次重啟都不一樣。**
**⚠️ 不要關這個 PowerShell 視窗、cloudflared 是 foreground process、關掉 tunnel 就斷。**

### Step 4：確認 tunnel 通

```powershell
curl -X POST https://<新 URL>/ocr -H "X-API-Key: dev-secret-please-change" -F "file=@test.jpg"
```

回 200 才算 tunnel 通。

### Step 5：更新 Vercel env vars

`Settings → Environment Variables → Production`

```
OCR_SERVER_URL = https://<新 URL>          # 覆蓋舊的
OCR_ASSIST_CLASSIFY_ENABLED = true         # 從 false 改回 true
```

（其他子 flag 不用動：`OCR_ASSIST_BRACKET_GAP_ENABLED`、`OCR_ASSIST_BLANK_PAREN_ENABLED`、`OCR_ASSIST_SINGLE_CHOICE_ENABLED`、`OCR_ASSIST_SUB_CELL_ENABLED`、`OCR_ASSIST_ANSWER_ONLY_ENABLED` 預設都 on）

### Step 6：等 env 生效 + 驗證

- 等 1-2 分鐘、或手動 redeploy
- 找一份已知 fill_blank 多的 assignment（譬如數練 u5 p41-42 那種線段圖題）重新批改一份
- 查 stage_log 確認：
  ```sql
  SELECT 
    classify->'ocrAssist'->'perPage'->0->'stats'->'matchedCount' as p1_matched,
    classify->'ocrAssist'->'perPage'->0->'stats'->'blankParen' as bp
  FROM grading_stage_logs
  WHERE submission_id = 'sub_xxx'
  ORDER BY created_at DESC LIMIT 1;
  ```
- `matchedCount > 0` 或 `blankParen.matchedCount > 0` 即代表 OCR-assist 重新生效

---

## 🔧 Troubleshooting

### 重啟後批改仍是純視覺、沒 OCR-assist

**檢查順序：**

1. **OCR_ASSIST_CLASSIFY_ENABLED 是不是還是 false？**
   ```
   Vercel Dashboard → Settings → Environment Variables
   確認 production 值為 true、不是 false 或 空白
   ```

2. **OCR_SERVER_URL 有沒有更新到新 URL？**
   ```
   舊 URL 已失效、要換成 cloudflared 印出的最新 URL
   ```

3. **Vercel function logs 有沒有顯示連線錯誤？**
   - 看 `/api/proxy` 的 console output
   - 找 `[ocr-client]` 開頭的 log line
   - 看到 `missing OCR_SERVER_URL or OCR_SERVER_API_KEY` → env 沒設好
   - 看到 `runOcrOnImage returned null` + 連線錯誤 → tunnel URL 不對 / cloudflared 沒啟動

4. **本機 OCR server 還活著嗎？**
   ```powershell
   curl http://localhost:8000/ocr -X POST ...
   ```

5. **Cloudflared tunnel 還活著嗎？**
   ```powershell
   curl https://<URL>/ocr -X POST ...
   ```
   失敗 → tunnel 斷了、重啟 cloudflared、拿新 URL、再更新 env

### Admin dashboard 「OCR-assist 命中」突然掉 0

通常代表 OCR call 全失敗（tunnel 不通 / env 不對）、跑去純視覺 fallback。
照 troubleshooting 順序檢查。

### 學生上傳卡 45 秒、最後失敗

代表 `OCR_ASSIST_CLASSIFY_ENABLED=true` 但 OCR server 不可達、撞 timeout。

**緊急處理：** 立即把 `OCR_ASSIST_CLASSIFY_ENABLED` 設回 false、redeploy、批改流程立刻恢復（純視覺）。再慢慢修 OCR / tunnel。

---

## 📍 環境變數速查

| Var | 值 | 用途 |
|---|---|---|
| `OCR_SERVER_URL` | https://xxx.trycloudflare.com | Tunnel URL、重啟時要換 |
| `OCR_SERVER_API_KEY` | dev-secret-please-change（或你的設定）| Tunnel auth key |
| `OCR_ASSIST_CLASSIFY_ENABLED` | true / false | 主開關、緊急時關掉跳 OCR |
| `OCR_ASSIST_BRACKET_GAP_ENABLED` | true (預設) | 子 matcher、通常不動 |
| `OCR_ASSIST_BLANK_PAREN_ENABLED` | true (預設) | 子 matcher、通常不動 |
| `OCR_ASSIST_SINGLE_CHOICE_ENABLED` | true (預設) | 子 matcher、通常不動 |
| `OCR_ASSIST_SUB_CELL_ENABLED` | true (預設) | 子 matcher、通常不動 |
| `OCR_ASSIST_ANSWER_ONLY_ENABLED` | true (預設) | answer_only 模式專用、通常不動 |

---

## 📎 相關文件

- [PaddleOCR 安裝指南（Windows）](../../local-only/paddleocr_install_windows.md) — 第一次裝 server 看這個
- [`ocr-client.js`](../server/ai/ocr-client.js) — OCR HTTP wrapper 程式碼
- [`staged-grading.js`](../server/ai/staged-grading.js) — Phase A pipeline、OCR-assist 整合處
- Admin dashboard → 批改品質 → 系統健康 / BBox 品質 — 重啟後驗證命中率
