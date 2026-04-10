import { getPipeline } from './pipelines.js'
import { callGeminiGenerateContent } from './model-adapter.js'
import { AI_ROUTE_KEYS, normalizeRouteKey, resolveRouteKey } from './routes.js'
import {
  runStagedGradingEvaluate,
  runStagedGradingPhaseA,
  runStagedGradingPhaseB
} from './staged-grading.js'

// ── answer key crop helpers ───────────────────────────────────────────────────

function extractInlineImagesFromContents(contents) {
  const images = []
  for (const content of (contents || [])) {
    if (!Array.isArray(content?.parts)) continue
    for (const part of content.parts) {
      if (part?.inlineData?.data && part?.inlineData?.mimeType) {
        images.push(part.inlineData)
      }
    }
  }
  return images
}

async function cropAnswerKeyBbox(imageBase64, mimeType, bbox, pad = 0.02) {
  if (!bbox || !imageBase64) return null
  try {
    const { default: sharp } = await import('sharp')
    const buffer = Buffer.from(imageBase64, 'base64')
    const { width, height } = await sharp(buffer).metadata()
    if (!width || !height) return null
    const px = Math.max(0, bbox.x - pad)
    const py = Math.max(0, bbox.y - pad)
    const px2 = Math.min(1, bbox.x + bbox.w + pad)
    const py2 = Math.min(1, bbox.y + bbox.h + pad)
    const x = Math.round(px * width)
    const y = Math.round(py * height)
    const w = Math.min(width - x, Math.max(1, Math.round((px2 - px) * width)))
    const h = Math.min(height - y, Math.max(1, Math.round((py2 - py) * height)))
    if (w <= 0 || h <= 0) return null
    const cropBuffer = await sharp(buffer)
      .extract({ left: x, top: y, width: w, height: h })
      .jpeg({ quality: 90 })
      .toBuffer()
    return `data:image/jpeg;base64,${cropBuffer.toString('base64')}`
  } catch (err) {
    console.warn('[orchestrator] crop failed:', err?.message)
    return null
  }
}

async function postProcessAnswerKeyWithCrops(pipelineResult, contents) {
  const rawText = pipelineResult?.data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!rawText) return pipelineResult
  let parsed
  try { parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim()) } catch { return pipelineResult }
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
  if (questions.length === 0) return pipelineResult
  const inlineImages = extractInlineImagesFromContents(contents)
  if (inlineImages.length === 0) return pipelineResult

  const croppedQuestions = await Promise.all(questions.map(async (q) => {
    if (!q.answerBbox) return q
    const pageIdx = typeof q.pageIndex === 'number' ? q.pageIndex : 0
    const img = inlineImages[Math.min(pageIdx, inlineImages.length - 1)]
    if (!img) return q
    const cropUrl = await cropAnswerKeyBbox(img.data, img.mimeType, q.answerBbox)
    return cropUrl ? { ...q, cropImageUrl: cropUrl } : q
  }))

  const newText = JSON.stringify({ ...parsed, questions: croppedQuestions })
  const candidates = pipelineResult.data?.candidates ?? []
  const newCandidates = [
    { ...candidates[0], content: { ...candidates[0]?.content, parts: [{ text: newText }] } },
    ...candidates.slice(1)
  ]
  return { ...pipelineResult, data: { ...pipelineResult.data, candidates: newCandidates } }
}

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
  const isPhaseB = resolvedRouteKey === AI_ROUTE_KEYS.GRADING_PHASE_B

  console.log(
    `${logPrefix} start requestedRoute=${
      normalizedRequestedRouteKey || 'none'
    } resolvedRoute=${resolvedRouteKey} model=${model} staged=${shouldRunStagedGrading}`
  )

  if (isPhaseA) {
    console.log(`${logPrefix} phase-a route=${resolvedRouteKey}`)
    try {
      pipelineResult = await runStagedGradingPhaseA({
        apiKey, model, contents, payload, routeHint, internalContext
      })
      // Wrap phaseA result so it travels through the standard pipeline response shape
      if (pipelineResult?.phaseAComplete) {
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
    } catch (error) {
      console.warn(`${logPrefix} phase-a crashed`, error)
      pipelineResult = null
    }
  } else if (isPhaseB) {
    console.log(`${logPrefix} phase-b route=${resolvedRouteKey}`)
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
      pipelineResult = null
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
    if (shouldRunStagedGrading || isPhaseA || isPhaseB) {
      console.warn(`${logPrefix} staged-unavailable fallback=single-shot`)
    }
    console.log(`${logPrefix} single-shot route=${resolvedRouteKey}`)

    // Debug log for answer_key.extract / answer_key.tag_concepts
    if (resolvedRouteKey === AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT || resolvedRouteKey === AI_ROUTE_KEYS.ANSWER_KEY_TAG_CONCEPTS) {
      const promptText = contents?.[0]?.parts?.[0]?.text ?? contents?.[0]?.parts?.find?.(p => typeof p?.text === 'string')?.text ?? null
      if (promptText) {
        console.log(`${logPrefix} [DEBUG] ${resolvedRouteKey} prompt:\n${promptText}`)
      }
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

    if (resolvedRouteKey === AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT || resolvedRouteKey === AI_ROUTE_KEYS.ANSWER_KEY_TAG_CONCEPTS) {
      const rawText = pipelineResult?.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null
      console.log(`${logPrefix} [DEBUG] ${resolvedRouteKey} response:\n${rawText}`)
    }

    // Post-process: add Sharp crops for each question's answerBbox
    if (resolvedRouteKey === AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT) {
      try {
        pipelineResult = await postProcessAnswerKeyWithCrops(pipelineResult, contents)
        console.log(`${logPrefix} [answer_key.extract] crop post-processing done`)
      } catch (err) {
        console.warn(`${logPrefix} [answer_key.extract] crop post-processing failed:`, err?.message)
      }
    }
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
    `${logPrefix} completed route=${resolvedRouteKey} pipeline=${pipelineMeta.pipeline} status=${responseStatus} prepareMs=${pipelineMeta.prepareLatencyMs} modelMs=${pipelineMeta.modelLatencyMs} warnings=${pipelineMeta.warnings.length}`
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
