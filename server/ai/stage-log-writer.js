/**
 * stage-log-writer.js
 *
 * Fire-and-forget 寫入批改 pipeline 各階段的結構化輸出到 Supabase。
 * 絕對不會 throw — 任何錯誤只 log 到 console，不影響 pipeline 執行。
 */

import { getSupabaseAdmin } from '../_supabase.js'

/**
 * 2026-05-17: Phase A 完成後寫 phase_a_state 進 submissions。
 * Phase B「重新批改」(fromCache) 從這裡讀、不用整份重跑 Phase A。
 *
 * @param {string} submissionId
 * @param {object} state - 序列化的 Phase A 狀態（answerKey / questionIds / classifyResult / ...）
 * @returns {Promise<boolean>} 寫入成功與否（fire-and-forget、失敗只 log）
 */
export async function persistPhaseAState(submissionId, state) {
  if (!submissionId || !state) return false
  try {
    const supabase = getSupabaseAdmin()
    const { error } = await supabase
      .from('submissions')
      .update({ phase_a_state: state })
      .eq('id', submissionId)
    if (error) {
      console.warn(`[persistPhaseAState] update error submission=${submissionId}:`, error.message)
      return false
    }
    console.log(`[persistPhaseAState] saved submission=${submissionId}`)
    return true
  } catch (err) {
    console.warn(`[persistPhaseAState] error:`, err?.message)
    return false
  }
}

/**
 * 2026-05-17: Phase B 完成後 / 老師確認時寫 final_answers 進 submissions。
 *
 * @param {string} submissionId
 * @param {Array} finalAnswers - [{ questionId, finalStudentAnswer, finalAnswerSource }]
 * @returns {Promise<boolean>}
 */
export async function persistFinalAnswers(submissionId, finalAnswers) {
  if (!submissionId || !Array.isArray(finalAnswers)) return false
  try {
    const supabase = getSupabaseAdmin()
    const { error } = await supabase
      .from('submissions')
      .update({ final_answers: finalAnswers })
      .eq('id', submissionId)
    if (error) {
      console.warn(`[persistFinalAnswers] update error submission=${submissionId}:`, error.message)
      return false
    }
    console.log(`[persistFinalAnswers] saved submission=${submissionId} count=${finalAnswers.length}`)
    return true
  } catch (err) {
    console.warn(`[persistFinalAnswers] error:`, err?.message)
    return false
  }
}

/**
 * 2026-05-17: 「重新截取」前清空 phase_a_state、final_answers、grading_result、score。
 * stage_logs 保留（audit 用）。
 */
export async function clearPhaseAState(submissionId) {
  if (!submissionId) return false
  try {
    const supabase = getSupabaseAdmin()
    const { error } = await supabase
      .from('submissions')
      .update({
        phase_a_state: null,
        final_answers: null,
        grading_result: null,
        score: null,
        ai_score: null,
        score_source: null,
        graded_at: null
      })
      .eq('id', submissionId)
    if (error) {
      console.warn(`[clearPhaseAState] update error submission=${submissionId}:`, error.message)
      return false
    }
    console.log(`[clearPhaseAState] cleared submission=${submissionId}`)
    return true
  } catch (err) {
    console.warn(`[clearPhaseAState] error:`, err?.message)
    return false
  }
}

/**
 * 2026-05-28: Phase A 重跑時清訂正狀態
 *
 * Why: 老師對已派發訂正的學生重跑 Phase A、舊 grading_result.mistakes 不再有效、
 *   訂正清單也跟著失效。需把 assignment_student_state 退回 'graded'、
 *   把 correction_question_items 標 'skipped'、讓新 Phase B 跑完能重 build。
 *
 * Status policy:
 *   - 'correction_passed' (訂正完成 = 終點) → return { blocked: true } 讓 caller 擋下重跑
 *   - 'correction_required' / 'correction_in_progress' / 'correction_pending_review' /
 *     'correction_failed' → 清資料
 *   - 其他狀態（'graded' / 'uploaded' 等）→ no-op、回 { cleared: false }
 *
 * @returns {Promise<{ blocked?: boolean; cleared: boolean; reason?: string }>}
 */
export async function clearCorrectionForRerun(submissionId) {
  if (!submissionId) return { cleared: false }
  try {
    const supabase = getSupabaseAdmin()
    const { data: sub, error: subErr } = await supabase
      .from('submissions')
      .select('id, owner_id, assignment_id, student_id')
      .eq('id', submissionId)
      .maybeSingle()
    if (subErr || !sub) {
      console.warn(`[clearCorrectionForRerun] submission lookup failed=${submissionId}:`, subErr?.message)
      return { cleared: false }
    }
    const { owner_id: ownerId, assignment_id: assignmentId, student_id: studentId } = sub
    if (!ownerId || !assignmentId || !studentId) return { cleared: false }

    const { data: state } = await supabase
      .from('assignment_student_state')
      .select('status')
      .eq('owner_id', ownerId)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .maybeSingle()
    const status = String(state?.status || '').toLowerCase()
    if (status === 'correction_passed') {
      return { blocked: true, cleared: false, reason: '學生已完成訂正、不可重跑批改' }
    }
    const nonTerminalCorrection = [
      'correction_required', 'correction_in_progress',
      'correction_pending_review', 'correction_failed'
    ]
    if (!nonTerminalCorrection.includes(status)) {
      return { cleared: false }
    }

    const nowIso = new Date().toISOString()
    const { error: stateErr } = await supabase
      .from('assignment_student_state')
      .update({
        status: 'graded',
        last_status_reason: '老師重新批改、訂正狀態已清除',
        updated_at: nowIso
      })
      .eq('owner_id', ownerId)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
    if (stateErr) {
      console.warn(`[clearCorrectionForRerun] state update failed=${submissionId}:`, stateErr.message)
    }
    const { error: itemsErr } = await supabase
      .from('correction_question_items')
      .update({ status: 'skipped', updated_at: nowIso })
      .eq('owner_id', ownerId)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .in('status', ['open', 'disputed'])
    if (itemsErr) {
      console.warn(`[clearCorrectionForRerun] items close failed=${submissionId}:`, itemsErr.message)
    }
    console.log(`[clearCorrectionForRerun] cleared submission=${submissionId} prevStatus=${status}`)
    return { cleared: true }
  } catch (err) {
    console.warn(`[clearCorrectionForRerun] error:`, err?.message)
    return { cleared: false }
  }
}

/**
 * 2026-05-17: 從 DB 讀 phase_a_state（給 Phase B fromCache 用）
 * 2026-05-18: 同步抓 assignments.answer_key（live），給 fromCache path 蓋掉快取版、避免老師改答案後重批不生效
 *   注意：submissions.assignment_id 沒 FK 到 assignments.id、PostgREST embed 不可用、拆兩個 query
 */
export async function loadPhaseAState(submissionId) {
  if (!submissionId) return null
  try {
    const supabase = getSupabaseAdmin()
    const { data, error } = await supabase
      .from('submissions')
      .select('phase_a_state, final_answers, assignment_id')
      .eq('id', submissionId)
      .maybeSingle()
    if (error) {
      console.warn(`[loadPhaseAState] error submission=${submissionId}:`, error.message)
      return null
    }
    if (!data) return null
    let liveAnswerKey = null
    if (data.assignment_id) {
      const { data: asgn, error: asgnErr } = await supabase
        .from('assignments')
        .select('answer_key')
        .eq('id', data.assignment_id)
        .maybeSingle()
      if (asgnErr) {
        console.warn(`[loadPhaseAState] assignment fetch error submission=${submissionId} assignment=${data.assignment_id}:`, asgnErr.message)
      } else {
        liveAnswerKey = asgn?.answer_key || null
      }
    }
    return {
      phase_a_state: data.phase_a_state,
      final_answers: data.final_answers,
      live_answer_key: liveAnswerKey
    }
  } catch (err) {
    console.warn(`[loadPhaseAState] error:`, err?.message)
    return null
  }
}

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
  unstableCount,
  ocrAssistMeta  // 🆕 OCR-assist metadata (per-page array)
}) {
  // classify summary (不存完整 bbox，只存關鍵資訊)
  const classifyAligned = Array.isArray(classifyResult?.alignedQuestions) ? classifyResult.alignedQuestions : []
  const classify = {
    coverage: classifyResult?.coverage,
    visibleCount: classifyAligned.filter(q => q.visible).length
  }
  // 🆕 OCR-assist metadata：用於 shadow mode 分析
  if (ocrAssistMeta) {
    classify.ocrAssist = ocrAssistMeta
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
    consistent: a.consistent,
    reason: a.reason || undefined
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
  // accessor scores — 使用 finalResult.details（程式化覆核後）而非 accessorResult.scores（原始）
  // 程式化覆核可能修改 score/isCorrect（如 fill_blank 數字比對），確保 log 與 totalScore 一致
  const details = Array.isArray(finalResult?.details) ? finalResult.details : []
  const accessorRaw = Array.isArray(accessorResult?.scores) ? accessorResult.scores : []
  const accessorRawById = new Map(accessorRaw.map(s => [s.questionId, s]))
  const accessor = details.map(d => {
    const raw = accessorRawById.get(d.questionId)
    return {
      questionId: d.questionId,
      score: d.score ?? raw?.score ?? 0,
      maxScore: d.maxScore ?? raw?.maxScore ?? 0,
      isCorrect: d.isCorrect ?? raw?.isCorrect ?? false,
      reason: d.reason || raw?.scoringReason || ''
    }
  })

  // explain
  const explainDetails = Array.isArray(explainResult?.details) ? explainResult.details : []
  const explainStage = explainDetails.map(d => ({
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
