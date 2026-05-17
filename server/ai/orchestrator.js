import { getPipeline } from './pipelines.js'
import { callGeminiGenerateContent } from './model-adapter.js'
import { AI_ROUTE_KEYS, normalizeRouteKey, resolveRouteKey } from './routes.js'
import {
  runStagedGradingEvaluate,
  runStagedGradingPhaseA,
  runStagedGradingPhaseAArbiter,
  runStagedGradingPhaseB
} from './staged-grading.js'

async function executeSinglePipelineCall({
  apiKey,
  model,
  contents,
  payload,
  routeHint,
  timeoutMs,
  routeKey
}) {
  const pipeline = getPipeline(routeKey)
  const prepareStartedAt = Date.now()
  const preparedRequest = await pipeline.prepare({
    model,
    contents,
    payload,
    routeHint
  })
  const prepareLatencyMs = Date.now() - prepareStartedAt

  const modelStartedAt = Date.now()
  const modelResponse = await callGeminiGenerateContent({
    apiKey,
    model: preparedRequest.model,
    contents: preparedRequest.contents,
    payload: preparedRequest.payload,
    timeoutMs
  })
  const modelLatencyMs = Date.now() - modelStartedAt

  let validation = { warnings: [], metrics: {} }
  if (modelResponse.ok && modelResponse.data && typeof modelResponse.data === 'object') {
    validation = await pipeline.validate({
      data: modelResponse.data,
      request: preparedRequest,
      routeHint
    })
  }

  const warnings = Array.isArray(validation?.warnings) ? validation.warnings : []
  const metrics =
    validation?.metrics && typeof validation.metrics === 'object' ? validation.metrics : {}

  return {
    status: Number(modelResponse.status) || 500,
    data: modelResponse.data,
    pipelineName: pipeline.name,
    prepareLatencyMs,
    modelLatencyMs,
    warnings,
    metrics
  }
}

export async function runAiPipeline({
  apiKey,
  model,
  contents,
  payload = {},
  requestedRouteKey = null,
  routeHint = {},
  timeoutMs,
  internalContext = {}
}) {
  const normalizedRequestedRouteKey = normalizeRouteKey(requestedRouteKey)
  const resolvedRouteKey = resolveRouteKey({
    requestedRouteKey: normalizedRequestedRouteKey,
    contents,
    routeHint
  })
  const requestId =
    typeof internalContext?.requestId === 'string' && internalContext.requestId.trim()
      ? internalContext.requestId.trim()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const logPrefix = `[ai-pipeline][${requestId}]`

  let pipelineResult = null
  const shouldRunStagedGrading =
    resolvedRouteKey === AI_ROUTE_KEYS.GRADING_EVALUATE &&
    internalContext?.enableStagedGrading !== false
  const isPhaseA = resolvedRouteKey === AI_ROUTE_KEYS.GRADING_PHASE_A
  const isPhaseAArbiter = resolvedRouteKey === AI_ROUTE_KEYS.GRADING_PHASE_A_ARBITER
  const isPhaseB = resolvedRouteKey === AI_ROUTE_KEYS.GRADING_PHASE_B

  // answer_sheet_mode 對 extract / classify / explain pipeline 的分支都重要，log 到 orchestrator 入口便於追蹤
  const dispatchedAnswerSheetMode = internalContext?.answerSheetMode || 'with_questions'
  console.log(
    `${logPrefix} 啟動 路由=${resolvedRouteKey} 模型=${model}${shouldRunStagedGrading ? ' 階段化' : ''} 模式=${dispatchedAnswerSheetMode}`
  )
  if (dispatchedAnswerSheetMode === 'answer_only') {
    console.log(`${logPrefix} [純答案卡] 派發路由=${resolvedRouteKey}`)
  }

  if (isPhaseA) {
    console.log(`${logPrefix} 進入 Phase A`)
    try {
      pipelineResult = await runStagedGradingPhaseA({
        apiKey, model, contents, payload, routeHint, internalContext
      })
      // classifyOnly mode: return bbox results directly
      if (pipelineResult?.classifyOnly) {
        pipelineResult = {
          status: 200,
          data: { candidates: [{ content: { parts: [{ text: JSON.stringify(pipelineResult) }] } }] },
          pipelineMeta: { pipeline: 'grading-classify-only', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: {} }
        }
      }
      // 2026-05-17: stopBeforeArbiter early-return — 包進 standard pipeline response、
      // client 收到後帶 _phaseAReadContext 打第二個 endpoint (phase_a_arbiter)
      else if (pipelineResult?.phaseAReadyForArbiter) {
        pipelineResult = {
          status: 200,
          data: { candidates: [{ content: { parts: [{ text: JSON.stringify(pipelineResult) }] } }] },
          pipelineMeta: { pipeline: 'grading-phase-a-pre-arbiter', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: {} }
        }
      }
      // Wrap phaseA result so it travels through the standard pipeline response shape
      else if (pipelineResult?.phaseAComplete) {
        const phaseAData = { phaseAComplete: true, ...pipelineResult }
        // Strip _internal (has raw crop images), but preserve essential fields for Phase B as _phaseContext
        const _internal = phaseAData._internal || {}
        delete phaseAData._internal
        phaseAData._phaseContext = {
          answerKey: _internal.answerKey,
          questionIds: _internal.questionIds,
          classifyResult: _internal.classifyResult,
          pipelineRunId: _internal.pipelineRunId,
          stagedLogLevel: _internal.stagedLogLevel
          // readAnswerResult excluded: Phase B uses finalAnswers (teacher-confirmed), not AI1 raw reads
          // cropByQuestionId excluded: base64 images are too large for round-trip
        }
        pipelineResult = {
          status: 200,
          data: { candidates: [{ content: { parts: [{ text: JSON.stringify(phaseAData) }] } }] },
          pipelineMeta: { pipeline: 'grading-phase-a', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: {} }
        }
      }
      // 🆕 pipelineFailure 路徑：phaseAComplete=false + pipelineFailure 物件
      // 之前沒 wrap、proxy.js 拿 pipelineResult.data = undefined、response body 空、
      // 前端拿到 500 卻沒 body 解 pipelineFailure → spinner 永遠 hang
      else if (pipelineResult?.pipelineFailure) {
        const failureData = { phaseAComplete: false, pipelineFailure: pipelineResult.pipelineFailure }
        pipelineResult = {
          status: 500,
          data: { candidates: [{ content: { parts: [{ text: JSON.stringify(failureData) }] } }] },
          pipelineMeta: { pipeline: 'grading-phase-a-failure', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: { reasonCode: pipelineResult.pipelineFailure?.reasonCode } }
        }
      }
    } catch (error) {
      console.warn(`${logPrefix} phase-a crashed`, error)
      pipelineResult = null
    }
  } else if (isPhaseAArbiter) {
    console.log(`${logPrefix} 進入 Phase A Arbiter（AI3 獨立 call）`)
    try {
      pipelineResult = await runStagedGradingPhaseAArbiter({
        apiKey, model, contents, payload, routeHint, internalContext
      })
      if (pipelineResult?.phaseAComplete) {
        const phaseAData = { phaseAComplete: true, ...pipelineResult }
        const _internal = phaseAData._internal || {}
        delete phaseAData._internal
        phaseAData._phaseContext = {
          answerKey: _internal.answerKey,
          questionIds: _internal.questionIds,
          classifyResult: _internal.classifyResult,
          pipelineRunId: _internal.pipelineRunId,
          stagedLogLevel: _internal.stagedLogLevel
          // readAnswerResult excluded: Phase B uses finalAnswers
          // cropByQuestionId excluded: base64 images are too large
        }
        pipelineResult = {
          status: 200,
          data: { candidates: [{ content: { parts: [{ text: JSON.stringify(phaseAData) }] } }] },
          pipelineMeta: { pipeline: 'grading-phase-a-arbiter', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: {} }
        }
      } else if (pipelineResult?.pipelineFailure) {
        const failureData = { phaseAComplete: false, pipelineFailure: pipelineResult.pipelineFailure }
        pipelineResult = {
          status: 500,
          data: { candidates: [{ content: { parts: [{ text: JSON.stringify(failureData) }] } }] },
          pipelineMeta: { pipeline: 'grading-phase-a-arbiter-failure', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: { reasonCode: pipelineResult.pipelineFailure?.reasonCode } }
        }
      }
    } catch (error) {
      console.warn(`${logPrefix} phase-a-arbiter crashed`, error)
      const failureData = {
        phaseAComplete: false,
        pipelineFailure: {
          stage: 'arbiter',
          reasonCode: 'PHASE_A_ARBITER_CRASHED',
          userMessage: '批改失敗：AI3 一致性判斷階段發生錯誤',
          userAction: '請重新批改',
          technical: { error: error?.message }
        }
      }
      pipelineResult = {
        status: 500,
        data: { candidates: [{ content: { parts: [{ text: JSON.stringify(failureData) }] } }] },
        pipelineMeta: { pipeline: 'grading-phase-a-arbiter-failure', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: {} }
      }
    }
  } else if (isPhaseB) {
    console.log(`${logPrefix} 進入 Phase B`)
    try {
      // phaseAResult can come from internalContext (server-internal) or from payload (client-submitted)
      const phaseAResult = internalContext?.phaseAResult ?? payload?.phaseAResult
      const finalAnswers = payload?.finalAnswers ?? internalContext?.finalAnswers ?? []
      if (!phaseAResult) {
        throw new Error('phase-b requires phaseAResult (in payload or internalContext)')
      }
      pipelineResult = await runStagedGradingPhaseB({
        apiKey, model, contents, payload, routeHint, internalContext,
        phaseAResult,
        finalAnswers
      })
    } catch (error) {
      console.warn(`${logPrefix} phase-b crashed`, error)
      // Phase B cannot fall back to single-shot — the generic pipeline has no Phase B
      // prompt or schema, so single-shot always returns 400. Return a structured error
      // instead so the client can surface a meaningful "timeout, please retry" message.
      const errStatus = Number(error?.status) || 503
      pipelineResult = {
        status: errStatus,
        data: { error: error?.message || 'Phase B failed', code: 'PHASE_B_FAILED' },
        pipelineMeta: { pipeline: 'grading-phase-b', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: {} }
      }
    }
  } else if (shouldRunStagedGrading) {
    console.log(`${logPrefix} staged-enabled route=${resolvedRouteKey} model=${model}`)
    try {
      pipelineResult = await runStagedGradingEvaluate({
        apiKey,
        model,
        contents,
        payload,
        routeHint,
        timeoutMs,
        internalContext
      })
    } catch (error) {
      console.warn(`${logPrefix} staged-crashed fallback=single-shot`, error)
      pipelineResult = null
    }
  }

  if (!pipelineResult) {
    if (shouldRunStagedGrading || isPhaseA || isPhaseAArbiter || isPhaseB) {
      console.warn(`${logPrefix} staged-unavailable fallback=single-shot`)
    }
    console.log(`${logPrefix} single-shot route=${resolvedRouteKey}`)

    // Concise log for answer_key.extract / answer_key.tag_concepts (no full prompt/response dump)
    if (resolvedRouteKey === AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT) {
      const imageCount = contents?.flatMap(c => c?.parts ?? []).filter(p => p?.inlineData).length ?? 0
      console.log(`${logPrefix} [answer_key.extract] sending ${imageCount} image(s) to AI`)
    }

    pipelineResult = await executeSinglePipelineCall({
      apiKey,
      model,
      contents,
      payload,
      routeHint,
      timeoutMs,
      routeKey: resolvedRouteKey
    })

    // Log perspective.detect_corners response
    if (resolvedRouteKey === AI_ROUTE_KEYS.PERSPECTIVE_DETECT_CORNERS) {
      const rawText = pipelineResult?.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null
      console.log(`${logPrefix} [perspective.detect_corners] response: ${rawText}`)
    }

    // Structured summary for answer_key.extract (replaces raw JSON dump)
    if (resolvedRouteKey === AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT) {
      const rawText = pipelineResult?.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null
      let parsed = null
      try { parsed = JSON.parse((rawText || '').replace(/```json|```/g, '').trim()) } catch { /* ignore */ }
      if (parsed && Array.isArray(parsed.questions)) {
        const questions = parsed.questions
        const catCounts = {}
        for (const q of questions) {
          const cat = q.questionCategory || 'unknown'
          catCounts[cat] = (catCounts[cat] || 0) + 1
        }
        const hasAnswerCount = questions.filter(q => (q.answer || q.referenceAnswer || '').trim()).length
        const dimMismatch = questions.filter(q => {
          if (!Array.isArray(q.rubricsDimensions) || q.rubricsDimensions.length === 0) return false
          const dimSum = q.rubricsDimensions.reduce((s, d) => s + (d?.maxScore || 0), 0)
          return typeof q.maxScore === 'number' && Math.abs(dimSum - q.maxScore) > 0.5
        }).length
        console.log(`${logPrefix} [answer_key.extract] result: ${questions.length} questions, totalScore=${parsed.totalScore}, categories=${JSON.stringify(catCounts)}, withAnswer=${hasAnswerCount}${dimMismatch > 0 ? `, dimScoreMismatch=${dimMismatch}` : ''}`)
        const layoutSummary = Array.isArray(parsed._layoutDetected)
          ? parsed._layoutDetected.map(p => `photo${p?.photo ?? '?'}=${p?.layout ?? '?'}`).join(', ')
          : (parsed._layoutDetected ?? '(missing)')
        console.log(`${logPrefix} [answer_key.extract] _layoutDetected: ${layoutSummary}`)
        // Log questions with potential issues
        const issues = questions.filter(q => !(q.id || '').trim() || (q.maxScore == null) || q.maxScore <= 0)
        if (issues.length > 0) {
          console.warn(`${logPrefix} [answer_key.extract] issues: ${issues.map(q => `${q.id || '(no-id)'}:maxScore=${q.maxScore}`).join(', ')}`)
        }
      } else {
        console.warn(`${logPrefix} [answer_key.extract] response parse failed`)
      }
    }
    if (resolvedRouteKey === AI_ROUTE_KEYS.ANSWER_KEY_TAG_CONCEPTS) {
      const rawText = pipelineResult?.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null
      let parsed = null
      try { parsed = JSON.parse((rawText || '').replace(/```json|```/g, '').trim()) } catch { /* ignore */ }
      if (parsed && Array.isArray(parsed.tags)) {
        const tagged = parsed.tags.filter(t => t?.concept_code).length
        console.log(`${logPrefix} [answer_key.tag_concepts] result: ${parsed.tags.length} tags, ${tagged} with concept_code`)
      }
    }

    // Locate + crop 已搬到 client 端：client 接到 extract questions 後自行並行打 answer_key.locate，
    // 再用 canvas 在 client 端裁切。server 不再做 post-processing（避免 60s timeout 與 4.5MB response 風險）。
  }
  const responseStatus = Number(pipelineResult.status) || 500

  const pipelineMeta = {
    requestId,
    requestedRouteKey: normalizedRequestedRouteKey || null,
    resolvedRouteKey,
    pipeline: pipelineResult.pipelineMeta?.pipeline || pipelineResult.pipelineName,
    prepareLatencyMs:
      Number(pipelineResult.pipelineMeta?.prepareLatencyMs) || Number(pipelineResult.prepareLatencyMs) || 0,
    modelLatencyMs:
      Number(pipelineResult.pipelineMeta?.modelLatencyMs) || Number(pipelineResult.modelLatencyMs) || 0,
    warnings: Array.isArray(pipelineResult.pipelineMeta?.warnings)
      ? pipelineResult.pipelineMeta.warnings
      : pipelineResult.warnings || [],
    metrics:
      pipelineResult.pipelineMeta?.metrics && typeof pipelineResult.pipelineMeta.metrics === 'object'
        ? pipelineResult.pipelineMeta.metrics
        : pipelineResult.metrics || {}
  }
  console.log(
    `${logPrefix} 完成 路由=${resolvedRouteKey} pipeline=${pipelineMeta.pipeline} status=${responseStatus} 準備=${pipelineMeta.prepareLatencyMs}ms 模型=${pipelineMeta.modelLatencyMs}ms 警告=${pipelineMeta.warnings.length}`
  )

  if (pipelineResult.data && typeof pipelineResult.data === 'object') {
    pipelineResult.data._pipeline = pipelineMeta
    pipelineResult.data.routeKey = resolvedRouteKey
  }

  return {
    status: responseStatus,
    data: pipelineResult.data,
    resolvedRouteKey,
    pipelineMeta
  }
}
