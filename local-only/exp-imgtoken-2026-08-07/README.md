# 降本第二波沙盒(2026-08-07~08)

結論與數據見 `docs/降本第二波_圖片token_2026-08.md`。

- `exp-imgtoken-2026-08-07/run.mjs` — read 四臂(BASE/IMGF/SHEET/SHEETHI/SHEETIF)、單卷
- `exp-imgtoken-2026-08-07/run-multi.mjs` — 擴大測試:BASE vs SHEET、國語 6 卷跨分數帶
- `exp-judge-imgtoken-2026-08-08/run.mjs` — 判官:國字 HIGH vs MEDIUM(✅已採用)
- `exp-judge-imgtoken-2026-08-08/run2.mjs` — 判官:注音三條省圖路(⛔全否決)

⛔ 費率一律用 `local-only/_rates.mjs`(鏡像 admin modelRates)。
   2026-08-08 之前的沙盒把 3.5-flash 寫成 0.30/2.50(實為 1.50/9.00)導致全盤誤判,已修。
