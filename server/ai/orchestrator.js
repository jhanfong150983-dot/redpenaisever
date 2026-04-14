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

// ── answer key locate: spec builders (mirrors classify logic) ─────────────────

function resolveQuestionTypeForLocate(q) {
  const category = String(q?.questionCategory ?? '').trim()
  const answerFormat = String(q?.answerFormat ?? '').trim().toLowerCase()
  if (answerFormat === 'matching' || answerFormat === 'matching_on_map') return 'matching'
  const valid = new Set([
    'word_problem', 'calculation', 'single_choice', 'map_fill', 'multi_fill',
    'map_draw', 'diagram_draw', 'multi_check', 'multi_check_other',
    'fill_blank', 'true_false', 'matching', 'multi_choice', 'single_check', 'short_answer'
  ])
  if (category === 'fill_variants') return 'fill_blank'
  if (valid.has(category)) return category
  return 'fill_blank'
}

function resolveBboxPolicyForLocate(questionType) {
  if (questionType === 'map_fill') return 'full_image'
  if (questionType === 'matching') return 'group_context'
  return 'question_context'
}

function resolveGroupIdForLocate(q) {
  const explicit = String(q?.bboxGroupId ?? q?.matchingGroupId ?? q?.unorderedGroupId ?? '').trim()
  if (explicit) return explicit
  if (Array.isArray(q?.idPath) && q.idPath.length > 0) return String(q.idPath[0]).trim()
  const id = String(q?.id ?? '').trim()
  const dash = id.indexOf('-')
  return dash > 0 ? id.slice(0, dash) : id
}

function buildAnswerKeyLocateSpecs(questions) {
  return questions.map((q) => {
    const questionType = resolveQuestionTypeForLocate(q)
    const bboxPolicy = resolveBboxPolicyForLocate(questionType)
    const spec = { questionId: q.id, questionType, bboxPolicy }
    if (bboxPolicy === 'group_context') {
      const groupId = resolveGroupIdForLocate(q)
      if (groupId) spec.bboxGroupId = groupId
    }
    const answerText = (typeof q.answer === 'string' && q.answer)
      || (typeof q.referenceAnswer === 'string' && q.referenceAnswer)
      || ''
    if (answerText) spec.answerText = answerText
    return spec
  })
}

function buildAnswerKeyLocatePrompt(questions) {
  const specs = buildAnswerKeyLocateSpecs(questions)
  return `You are stage ANSWER_KEY_LOCATE.
Task: on this answer key image, locate where each question's printed answer text appears and output answerBbox.
Use the provided answerText as a visual search key. Do NOT guess or infer answers.

Question Specs:
${JSON.stringify(specs)}

Rules:
- Use only the questionIds listed in specs.
- bboxPolicy MUST be followed:
  - full_image: answerBbox must be {x:0,y:0,w:1,h:1}.
  - group_context: ALL questions with the same bboxGroupId MUST share the exact same answerBbox.
  - question_context: locate the specific printed answer for this question.
- For question_context, output answerBbox that frames the printed answer area:
  - For fill_blank: frame the printed answer text and its surrounding line/blank space.
  - For single_choice / true_false: frame the printed answer symbol (e.g. "A", "○") within its bracket or space — include the bracket/parenthesis row.
  - For multi_choice / multi_check / multi_check_other / single_check: frame all printed answer tokens and their option rows.
  - For multi_fill: each sub-question maps to ONE specific printed value in the diagram. answerBbox must be a TIGHT crop of ONLY that single value — do NOT include neighboring sub-question values. Sub-question bboxes MUST NOT overlap each other.
    ORDERING RULE: assign sub-question IDs in strict TOP-TO-BOTTOM order (primary), LEFT-TO-RIGHT within the same row (secondary).
  - For word_problem / calculation / short_answer: frame the reference answer or scoring rubric text below the question stem.
  - For matching (group_context): frame the entire left column + right column + connecting lines of the whole group.
  - The bbox must be ACCURATE and TIGHT (top-left corner = (x,y), width = w, height = h) using actual pixel proportions — do NOT output placeholder sizes.
  Format: { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 } where (x,y)=top-left corner, w=width, h=height, all normalized to [0,1].
  If the answer text cannot be located visually, omit answerBbox for that question.
- Each question is INDEPENDENT — do NOT shift bbox to avoid overlap with other questions.
- Return strict JSON only.

Output:
{
  "locations": [
    { "questionId": "1", "answerBbox": { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 } }
  ]
}`.trim()
}

async function locateAnswerKeyBboxes(questions, inlineImages, apiKey, model) {
  // Group questions by page; only locate questions that have a text answer to search for
  const locatableQ = questions.filter((q) => {
    const text = (typeof q.answer === 'string' && q.answer) || (typeof q.referenceAnswer === 'string' && q.referenceAnswer)
    return Boolean(text)
  })
  if (locatableQ.length === 0) return new Map()

  const byPage = new Map()
  for (const q of locatableQ) {
    // pageIndex 未設時，從 ID 首段（1-based）推算（例：2-2-1 → pageIdx=1）
    const pageIdx = typeof q.pageIndex === 'number'
      ? q.pageIndex
      : Math.max(0, (parseInt(String(q.id ?? '').split('-')[0], 10) || 1) - 1)
    if (!byPage.has(pageIdx)) byPage.set(pageIdx, [])
    byPage.get(pageIdx).push(q)
  }

  const bboxMap = new Map()
  for (const [pageIdx, pageQuestions] of byPage) {
    const img = inlineImages[Math.min(pageIdx, inlineImages.length - 1)]
    if (!img) continue
    const prompt = buildAnswerKeyLocatePrompt(pageQuestions)
    try {
      const locateResp = await callGeminiGenerateContent({
        apiKey,
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: img }] }]
      })
      if (!locateResp.ok) continue
      const rawText = locateResp.data?.candidates?.[0]?.content?.parts?.[0]?.text
      if (!rawText) continue
      let parsed
      try { parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim()) } catch { continue }
      for (const loc of (Array.isArray(parsed?.locations) ? parsed.locations : [])) {
        const qId = String(loc?.questionId ?? '').trim()
        const bbox = loc?.answerBbox
        if (qId && bbox && typeof bbox.x === 'number' && typeof bbox.y === 'number') {
          bboxMap.set(qId, bbox)
        }
      }
    } catch (err) {
      console.warn('[orchestrator] locate page', pageIdx, 'failed:', err?.message)
    }
  }
  return bboxMap
}

async function postProcessAnswerKeyWithCrops(pipelineResult, contents, apiKey, model) {
  const rawText = pipelineResult?.data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!rawText) return pipelineResult
  let parsed
  try { parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim()) } catch { return pipelineResult }
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
  if (questions.length === 0) return pipelineResult
  const inlineImages = extractInlineImagesFromContents(contents)
  if (inlineImages.length === 0) return pipelineResult

  // Step 2: dedicated locate AI for accurate bboxes
  const locatedBboxMap = await locateAnswerKeyBboxes(questions, inlineImages, apiKey, model)
  console.log(`[orchestrator] answer_key.locate: ${locatedBboxMap.size}/${questions.length} questions located`)

  const croppedQuestions = await Promise.all(questions.map(async (q) => {
    // Prefer locate bbox (more accurate), fall back to extract bbox
    const bbox = locatedBboxMap.get(q.id) ?? q.answerBbox ?? null
    if (!bbox) return q
    // pageIndex 未設時，從 ID 首段（1-based）推算（例：2-2-1 → pageIdx=1）
    const pageIdx = typeof q.pageIndex === 'number'
      ? q.pageIndex
      : Math.max(0, (parseInt(String(q.id ?? '').split('-')[0], 10) || 1) - 1)
    const img = inlineImages[Math.min(pageIdx, inlineImages.length - 1)]
    if (!img) return q
    const cropUrl = await cropAnswerKeyBbox(img.data, img.mimeType, bbox)
    const updatedQ = { ...q, answerBbox: bbox }  // update answerBbox with more accurate locate result
    return cropUrl ? { ...updatedQ, cropImageUrl: cropUrl } : updatedQ
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

    // Post-process: dedicated locate AI + Sharp crops
    if (resolvedRouteKey === AI_ROUTE_KEYS.ANSWER_KEY_EXTRACT) {
      try {
        pipelineResult = await postProcessAnswerKeyWithCrops(pipelineResult, contents, apiKey, model)
        console.log(`${logPrefix} [answer_key.extract] locate+crop post-processing done`)
      } catch (err) {
        console.warn(`${logPrefix} [answer_key.extract] locate+crop post-processing failed:`, err?.message)
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
