-- 判官判定冷凍表（通用版，2026-09-04 user 拍板「系統統一」）
-- 涵蓋：字形判官(glyph)、注音三判官(zhuyin)、級分制(level)、rubric 判官(rubric)。
-- （VJ 作圖已有自己的 vj_verdict_cache，維持不動。）
--
-- 目的：這四個判官原本「每次重批都重跑」——LLM 服務端不保證可重現（VJ 實測
--   input_tokens 跨批次完全相同、output 每輪都變），重批分數會翻盤，錢也重付。
--   冷凍＝判過就存，同指紋重批直接沿用。
--
-- 鍵的設計（同 VJ）：cache_key = sha1(圖 hash(s) + 設定簽章 + prompt 版本)
--   ・圖 hash    ：hash 的是**實際送進模型的 bytes**（放大/裁圖參數改了 → bytes 變 → 重判）
--                  注音含兩張（學生圖＋答案卷標準圖），任一換掉都重判
--   ・設定簽章  ：標準答案／levelRubric／rubricsDimensions 變了 → 重判
--   ・prompt 版本：判官邏輯改版 → 舊判定不綁死新版本（改邏輯必改版本號，見
--                  judge-verdict-cache.js 的 JUDGE_PROMPT_VERSIONS）
--
-- source：'ai'＝判官判的；'teacher'＝老師裁決回寫（優先權最高、AI 不覆蓋）。
--
-- fail-open：此表不存在時程式照舊跑判官（部署先後順序無所謂，只是沒凍結效果）。

create table if not exists public.judge_verdict_cache (
  id            bigserial primary key,
  cache_key     text        not null,
  kind          text        not null,               -- 'glyph' | 'zhuyin' | 'level' | 'rubric'
  assignment_id text,
  submission_id text,
  question_id   text        not null,
  payload       jsonb       not null,               -- 判官完整輸出（各 kind 自己的形狀）
  score         numeric,                            -- 冗餘欄位：聚合/稽核不用拆 payload
  max_score     numeric,
  confidence    numeric,
  source        text        not null default 'ai',  -- 'ai' | 'teacher'
  model         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint judge_verdict_cache_key_uniq unique (cache_key),
  constraint judge_verdict_cache_kind_chk check (kind in ('glyph', 'zhuyin', 'level', 'rubric')),
  constraint judge_verdict_cache_source_chk check (source in ('ai', 'teacher'))
);

create index if not exists judge_verdict_cache_sub_q_idx
  on public.judge_verdict_cache (submission_id, question_id);

create index if not exists judge_verdict_cache_assignment_idx
  on public.judge_verdict_cache (assignment_id);
