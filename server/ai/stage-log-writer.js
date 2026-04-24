/**
 * stage-log-writer.js
 *
 * Fire-and-forget 寫入批改 pipeline 各階段的結構化輸出到 Supabase。
 * 絕對不會 throw — 任何錯誤只 log 到 console，不影響 pipeline 執行。
 */

import { getSupabaseAdmin } from '../_supabase.js'

/**
 * 從 Phase A 結果提取要存的結構化數據
 */
export function extractPhaseALogData({
  pipelineRunId,
  classifyResult,
  readAnswerResult,
  reReadAnswerResult,
  arbiterResult,
  qualityGates,
  stageResponses,
  needsReviewCount,
  stableCount,
  diffCount,
  unstableCount
}) {
  // classify summary (不存完整 bbox，只存關鍵資訊)
  const classifyAligned = Array.isArray(classifyResult?.alignedQuestions) ? classifyResult.alignedQuestions : []
  const classify = {
    coverage: classifyResult?.coverage,
    visibleCount: classifyAligned.filter(q => q.visible).length,
    tablePositionReasoning: classifyAligned.filter(q => q.tablePositionReasoning).map(q => ({
      id: q.questionId, reasoning: q.tablePositionReasoning
    }))
  }

  // read answers (只存 questionId + status + answer)
  const extractAnswers = (result) => {
    const answers = Array.isArray(result?.answers) ? result.answers : []
    return answers.map(a => ({
      questionId: a.questionId,
      status: a.status,
      answer: a.studentAnswerRaw || a.studentAnswer || ''
    }))
  }

  const readAnswer1 = extractAnswers(readAnswerResult)
  const readAnswer2 = extractAnswers(reReadAnswerResult)

  // arbiter (只存關鍵欄位)
  const arbiterForensics = Array.isArray(arbiterResult) ? arbiterResult : []
  const arbiter = arbiterForensics.map(a => ({
    questionId: a.questionId,
    status: a.arbiterStatus,
    finalAnswer: a.finalAnswer,
    support: a.agreementSupport || a.ai1Support || a.ai2Support
  }))

  // stage latencies
  const responses = Array.isArray(stageResponses) ? stageResponses : []
  const stageLatencies = {
    total_ms: responses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0)
  }

  return {
    classify,
    read_answer_1: readAnswer1,
    read_answer_2: readAnswer2,
    arbiter,
    quality_gates: qualityGates || {},
    stage_latencies: stageLatencies,
    needs_review_count: needsReviewCount ?? unstableCount ?? 0
  }
}

/**
 * 從 Phase B 結果提取要存的結構化數據
 */
export function extractPhaseBLogData({
  pipelineRunId,
  accessorResult,
  explainResult,
  finalResult,
  qualityGates,
  stageResponses
}) {
  // accessor scores
  const scores = Array.isArray(accessorResult?.scores) ? accessorResult.scores : []
  const accessor = scores.map(s => ({
    questionId: s.questionId,
    score: s.score,
    maxScore: s.maxScore,
    isCorrect: s.isCorrect,
    reason: s.scoringReason || ''
  }))

  // explain
  const details = Array.isArray(explainResult?.details) ? explainResult.details : []
  const explainStage = details.map(d => ({
    questionId: d.questionId,
    explanation: d.explanation || ''
  }))

  // stage latencies
  const responses = Array.isArray(stageResponses) ? stageResponses : []
  const stageLatencies = {
    total_ms: responses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0)
  }

  return {
    accessor,
    explain_stage: explainStage,
    total_score: finalResult?.totalScore ?? null,
    quality_gates: qualityGates || {},
    stage_latencies: stageLatencies
  }
}

/**
 * 比對同一 submission 的前一次 run，計算一致性
 */
async function computeConsistency(supabase, { ownerId, submissionId, currentRunId, currentAccessor }) {
  try {
    if (!currentAccessor || currentAccessor.length === 0) return null

    const { data: prevRuns } = await supabase
      .from('grading_stage_logs')
      .select('pipeline_run_id, accessor, total_score')
      .eq('owner_id', ownerId)
      .eq('submission_id', submissionId)
      .eq('phase', 'phase_b')
      .neq('pipeline_run_id', currentRunId)
      .order('created_at', { ascending: false })
      .limit(1)

    if (!prevRuns || prevRuns.length === 0) return null

    const prev = prevRuns[0]
    const prevAccessor = Array.isArray(prev.accessor) ? prev.accessor : []
    if (prevAccessor.length === 0) return null

    const prevByQ = new Map(prevAccessor.map(a => [a.questionId, a]))
    let matchCount = 0
    let totalCount = 0
    const diffQuestions = []

    for (const curr of currentAccessor) {
      totalCount++
      const p = prevByQ.get(curr.questionId)
      if (p && p.score === curr.score) {
        matchCount++
      } else if (p) {
        diffQuestions.push({
          questionId: curr.questionId,
          prevScore: p.score,
          currScore: curr.score,
          prevCorrect: p.isCorrect,
          currCorrect: curr.isCorrect
        })
      }
    }

    return {
      prevRunId: prev.pipeline_run_id,
      prevTotalScore: prev.total_score,
      matchRate: totalCount > 0 ? +(matchCount / totalCount).toFixed(3) : 1,
      matchCount,
      totalCount,
      diffQuestions
    }
  } catch (err) {
    console.warn('[stage-log-writer] computeConsistency error:', err.message)
    return null
  }
}

/**
 * 寫入一筆 grading stage log（fire-and-forget）
 */
export async function saveGradingStageLog({
  ownerId,
  assignmentId,
  submissionId,
  pipelineRunId,
  phase,
  model,
  logData
}) {
  try {
    const supabase = getSupabaseAdmin()

    // Phase B: 自動比對一致性
    let consistency = null
    if (phase === 'phase_b' && logData.accessor) {
      consistency = await computeConsistency(supabase, {
        ownerId,
        submissionId,
        currentRunId: pipelineRunId,
        currentAccessor: logData.accessor
      })
      if (consistency) {
        const { matchRate, diffQuestions, prevTotalScore } = consistency
        const currTotal = logData.total_score
        console.log(`[stage-log] consistency: ${(matchRate * 100).toFixed(1)}% match (${consistency.matchCount}/${consistency.totalCount}), score ${prevTotalScore}→${currTotal}, diffs=${diffQuestions.length}`)
        if (diffQuestions.length > 0) {
          console.log(`[stage-log] diff questions:`, diffQuestions.map(d => `${d.questionId}: ${d.prevScore}→${d.currScore}`).join(', '))
        }
      }
    }

    const row = {
      owner_id: ownerId,
      assignment_id: assignmentId,
      submission_id: submissionId,
      pipeline_run_id: pipelineRunId,
      phase,
      model: model || null,
      total_score: logData.total_score ?? null,
      needs_review_count: logData.needs_review_count ?? null,
      classify: logData.classify || null,
      read_answer_1: logData.read_answer_1 || null,
      read_answer_2: logData.read_answer_2 || null,
      arbiter: logData.arbiter || null,
      accessor: logData.accessor || null,
      explain_stage: logData.explain_stage || null,
      quality_gates: logData.quality_gates || null,
      stage_latencies: logData.stage_latencies || null,
      consistency
    }

    const { error } = await supabase.from('grading_stage_logs').insert(row)
    if (error) {
      console.warn(`[stage-log-writer] insert error (${phase}):`, error.message, error.details || '')
    } else {
      console.log(`[stage-log] saved ${phase} run=${pipelineRunId} submission=${submissionId || '(empty)'}`)
    }
  } catch (err) {
    console.warn(`[stage-log-writer] saveGradingStageLog error (${phase}):`, err.message)
  }
}
