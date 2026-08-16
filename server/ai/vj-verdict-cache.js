// ═══ VJ 判定冷凍（2026-08-16 user 拍板）═════════════════════════════════════
// 為什麼要冷凍：作圖題判官在 temperature 0 下仍不可重現——實測同一張卷跨批次的
//   input_tokens 完全相同、模型相同，output 每輪都變（LLM 服務端本來就不保證可重現），
//   而作圖題的判定又落在決策邊界上 → 同一份卷每次重批分數不一樣，最傷老師的信任。
//   prompt／規準／題本／解析度／裁圖幾何／逐項提問全部驗過都不是原因（local-only/vj-rubric-lab）。
//
// 鍵＝sha1(學生圖 hash + 規準 hash + prompt 版本)。任一改變 → 重判，
//   所以「重批不變」與「不被舊版本綁死」同時成立（設計說明見 docs/ddl 的 SQL 註解）。
//
// ⚠ fail-open：資料表不存在／查詢失敗 → 一律當作沒有快取，照舊跑判官。
//   （DDL 未跑就部署也不會壞，只是沒有冷凍效果。）

import crypto from 'node:crypto'

// 動判官邏輯時**必須**改這個版本號，否則舊判定會被沿用、新修法對既有卷無效。
export const VJ_PROMPT_VERSION = 'vj-2026-08-16-3votes-weighted'

const sha1 = (s) => crypto.createHash('sha1').update(String(s ?? '')).digest('hex')

export function buildVjCacheKey({ cropBase64, vjRubric, promptVersion = VJ_PROMPT_VERSION }) {
  if (!cropBase64) return null
  const rubricSig = JSON.stringify({
    l: vjRubric?.itemLabels ?? [],
    s: vjRubric?.itemScores ?? null,
    g: vjRubric?.gradingDefinition ?? '',
    c: vjRubric?.condition ?? '',
  })
  return sha1(`${sha1(cropBase64)}|${sha1(rubricSig)}|${promptVersion}`)
}

/** @returns null（沒有快取／查不到／表不存在）| { verdicts, score, maxScore, voteSplit, source } */
export async function loadVjVerdict(supabase, cacheKey) {
  if (!supabase || !cacheKey) return null
  try {
    const { data, error } = await supabase
      .from('vj_verdict_cache')
      .select('verdicts, score, max_score, vote_split, source')
      .eq('cache_key', cacheKey)
      .maybeSingle()
    if (error || !data) return null
    return {
      verdicts: Array.isArray(data.verdicts) ? data.verdicts : [],
      score: Number(data.score),
      maxScore: Number(data.max_score),
      voteSplit: !!data.vote_split,
      source: String(data.source ?? 'ai'),
    }
  } catch { return null }
}

export async function saveVjVerdict(supabase, cacheKey, row) {
  if (!supabase || !cacheKey) return false
  try {
    // ⚠ 不可覆蓋老師的裁決：ignoreDuplicates 讓既有列（含 source='teacher'）保持不動。
    const { error } = await supabase.from('vj_verdict_cache').upsert({
      cache_key: cacheKey,
      assignment_id: row.assignmentId ?? null,
      submission_id: row.submissionId ?? null,
      question_id: row.questionId,
      verdicts: row.verdicts ?? [],
      score: row.score ?? null,
      max_score: row.maxScore ?? null,
      vote_split: !!row.voteSplit,
      source: 'ai',
      model: row.model ?? null,
    }, { onConflict: 'cache_key', ignoreDuplicates: true })
    return !error
  } catch { return false }
}
