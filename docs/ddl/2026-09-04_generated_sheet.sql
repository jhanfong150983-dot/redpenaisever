-- 2026-09-04 生成作答卷（RPGEN1）：定版版面資料存 template。
-- 內容：{version,pageSize,pageMm,anchorsMm,uvBasis,header,boxes[],densityLevel,sectionOverrides}
-- 是回讀裁格（免 classify）與重印 PDF 的 SSoT；⚠ 手動在 Supabase SQL editor 跑。
ALTER TABLE answer_key_templates
  ADD COLUMN IF NOT EXISTS generated_sheet jsonb;
