# 升學考試評量架構 原文擷取(2026-08-07)

供建立 `saa-dimensions.js` / `cap-standards.js` / `gsat-objectives.js` 常數檔用。
分析與對齊設計見 `docs/升學考試評量架構對齊_2026-08.md`。

- `gsat_*.txt` — 大考中心「111 學年度起適用之學測考試說明」五考科 PDF 逐字擷取
  (國文/英文/數學/社會/自然;含測驗目標代碼、測驗內容、題型配分、試題舉例)
  來源 ceec.edu.tw
- `saa_115_dimensions.txt` — 縣市學生學習能力檢測 115 年度評量向度說明
  (五年級國語文/數學/英語文、八年級數學)來源 saaassessment.ntcu.edu.tw

擷取方式:pypdf + latin-1→big5 還原(該批 PDF 內嵌 Big5 編碼、直接 extract 會亂碼)。
