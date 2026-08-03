-- 2026-08-03 家長報告抬頭改學校級雲端設定(user 提:行政帳號可能共用,localStorage per-device 不適用)
--
-- 校名沿用既有的 schools.name(1Campus 同步來的正式校名);
-- 只有「想印在報告上的名稱不同於正式校名」時才需要 report_school_name 覆寫,平常留 NULL。
--
-- 校徽存 data URI 而不是 Storage 路徑:家長報告 PDF 是 headless Chrome 渲染,
-- 那支端點的 request interception 只放行 data: 與 Google Fonts(防 SSRF),
-- 外部圖片 URL 會被 abort → 校徽必須在 HTML 裡就是 data URI。

alter table schools add column if not exists report_school_name    text;
alter table schools add column if not exists report_crest_data_url text;

-- 驗證
-- select id, name, report_school_name, length(report_crest_data_url) as crest_bytes from schools;
