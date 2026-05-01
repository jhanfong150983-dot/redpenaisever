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

/**
 * 解析 contents parts 中 "--- 第 N 張照片 ---" 標籤，建立：
 *   globalPageNum (1-based) → batchLocalImageIndex (0-based)
 *
 * 當 4 張照片被拆成多批送出時，第 2 批的 inlineImages[0] 不一定對應全域第 1 頁，
 * 這個對應表讓裁切函式能正確選到批次內的圖片，而不是用 pageIdx-1 直接當索引。
 */
function buildPageLabelToImageIndexMap(contents) {
  const map = new Map()
  let imageIndex = 0
  let pendingPageNum = null
  for (const content of (contents || [])) {
    if (!Array.isArray(content?.parts)) continue
    for (const part of content.parts) {
      if (typeof part?.text === 'string') {
        const m = part.text.match(/第\s*(\d+)\s*張/)
        if (m) pendingPageNum = parseInt(m[1], 10)
      } else if (part?.inlineData?.data && part?.inlineData?.mimeType) {
        if (pendingPageNum !== null) {
          map.set(pendingPageNum, imageIndex)
          pendingPageNum = null
        }
        imageIndex++
      }
    }
  }
  return map
}

async function cropAnswerKeyBbox(imageBase64, mimeType, bbox, pad = 0.02) {
  if (!bbox || !imageBase64) return null
  // 缺欄位 / 非數字會讓下面算式產生 NaN，直接擋掉
  if (!Number.isFinite(bbox.x) || !Number.isFinite(bbox.y) ||
      !Number.isFinite(bbox.w) || !Number.isFinite(bbox.h) ||
      bbox.w <= 0 || bbox.h <= 0) {
    console.warn('[orchestrator] crop skipped: malformed bbox', JSON.stringify(bbox))
    return null
  }
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
    // Bucket A
    'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many',
    'single_check', 'multi_check', 'true_false', 'fill_blank', 'multi_fill',
    'matching', 'ordering', 'mark_in_text',
    'calculation', 'word_problem',
    // Bucket B
    'fill_variants', 'map_fill',
    // Bucket C
    'short_answer',
    'map_symbol', 'grid_geometry', 'connect_dots',
    'diagram_draw', 'diagram_color',
    // Bucket D
    'compound_circle_with_explain', 'compound_check_with_explain',
    'compound_writein_with_explain', 'multi_check_other',
    'compound_judge_with_correction', 'compound_judge_with_explain',
    'compound_chain_table'
  ])
  // Legacy compat: old map_draw → map_symbol
  if (category === 'map_draw') return 'map_symbol'
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
任務：在這張答案卷圖片上，為每一題標出 answerBbox — 印刷答案文字／作答區的視覺位置。
🚨 你只做視覺定位，不抽答案、不推論答案。看不到 → omit。

Search key：用 specs 裡的 answerText 當視覺搜尋錨點，找出該段文字印在這張圖上的哪裡。

Question Specs:
${JSON.stringify(specs)}

═══════════════ 座標格式（強制）═══════════════
- bbox = { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 }
  - (x,y) = 左上角；w = 寬；h = 高
  - 全部為 0-1 之間的歸一化座標（相對於本張圖片的寬高）
- ⚠️ 絕對禁止輸出像素座標（如 x: 376, y: 313）。x/y/w/h 必須在 0-1 範圍內。
- bbox 必須 TIGHT 且 ACCURATE — 不可給 placeholder 或估計大小
- 視覺定位失敗 → 直接 omit answerBbox（不要硬給空框或預設框）
- 每題 bbox 獨立，禁止為避免與其他題重疊而偏移座標
- 只用 specs 列出的 questionId

═══════════════ bboxPolicy 三種政策 ═══════════════
- full_image：answerBbox 強制為 {x:0, y:0, w:1, h:1}
- group_context：同一 bboxGroupId 的所有題目共用同一個 answerBbox
- question_context：定位該題自己的答案區（per-type 規則見下）

═══════════════ Per-Type 涵蓋範圍規則 ═══════════════

▸ Bucket A — 精確比對

- single_choice 「選擇題」：緊框題號前的空括號 + 小邊距（25-35% 頁寬），不框題幹
- multi_choice 「多選選擇題」：同 single_choice
- circle_select_one 「圈選題」：括號內含預印多個選項（如「同意／不同意」）。bbox 必須含**全部印刷選項文字** + 圈選筆跡，不能只框筆跡
- circle_select_many 「多選圈選題」：同 circle_select_one
- single_check 「勾選題」：一列方框 □ + 對應選項文字。bbox 涵蓋整列方框 + 對應選項文字
- multi_check 「多選勾選題」：同 single_check
- true_false 「是非題」：緊框接在敘述句後的單一括號 (   )
- fill_blank 「填空題」：____ / □ / 表格儲存格 + 紅色文字。緊框該空格 + 紅色文字
  - 直式分數格特例：上下格各自有紅色 → 兩格都要框入
- multi_fill 「多項填空題」：每子題獨立一個 bbox，TIGHT crop ONLY 該格的單一值，不含鄰格
  ⚠️ 子題 bbox 絕對禁止重疊
  ORDERING：子題 ID 依 TOP-TO-BOTTOM 為主、LEFT-TO-RIGHT 為輔
- matching 「連連看」(group_context)：整個連連看區為單一 bbox — 左欄所有項目 + 右欄所有選項 + 中間所有連線
  ⚠️ 不可只框右欄文字 — 連線本身就是答案，必須完整包含
- ordering 「排序題」：整體一個 bbox，涵蓋所有排序格
- mark_in_text 「圈詞題」：涵蓋整個文章區域，可框大一點以含上下文
- calculation 「計算題」：從第一行算式 → 框到最終答案，**所有算式行（橫式 + 直式 + 結果）整個範圍**
  ⚠️ 不可只框最終數值 — 計算步驟必須在框內
- word_problem 「應用題」：從第一行算式 → 框到最末「答：」或「A：」行整個範圍
  ⚠️ 不可只框「答：」那一行 — 計算步驟也必須在框內

▸ Bucket B — 容多元

- fill_variants 「多元填空題」：同 fill_blank（緊框該空格 + 紅色文字）
- map_fill 「填圖題」(full_image)：強制 {x:0, y:0, w:1, h:1}

▸ Bucket C — Rubric

- short_answer 「簡答題」：框住題幹下方的參考答案文字或 rubric 區
- map_symbol 「地圖符號標記題」：整張地圖 + 題幹
- grid_geometry 「格線幾何繪製題」：整個格線區 + 題幹
- connect_dots 「連點繪圖題」：整個點陣區 + 題幹
- diagram_draw 「圖表繪製題」：整個圖表繪製區 + 題幹
- diagram_color 「塗色題」：整個塗色區 + 題幹

▸ Bucket D — 複合題（兩個部分必須同時在框內！）

🚨 共通要求：bbox 必須**同時涵蓋作答的兩個部分**（圈選/勾選/判斷 + 理由/改正/說明）
🚨 自我檢查：框完後，框內應該能同時看到兩個部分。看不到任何一個 → bbox 飄了，重新標

- compound_circle_with_explain 「圈選說明題」：從圈選括號 ( ) 的左上角 → 框到理由說明文字最末一字（含標點）
  框內必須同時看到「(選項/選項)」+「因為...」整段
- compound_check_with_explain 「勾選說明題」：從第一個方框 □ → 框到理由說明文字最末一字
  框內必須同時看到「□ 選項 □ 選項...」+「因為...」整段
- compound_writein_with_explain 「寫入說明題」：從空括號 ( ) → 框到理由說明文字最末一字
  框內必須同時看到括號 + 寫的代號 + 整段理由
- multi_check_other 「複選含其他題」：從第一個方框 □ → 框到「其他：___」開放欄末端
  框內必須包含全部方框 + 其他開放欄
- compound_judge_with_correction 「判斷改正題」：從判斷括號（○/✗）→ 框到改正寫字區末端
  框內必須同時看到括號 ○/✗ + 改正文字
- compound_judge_with_explain 「判斷說明題」：從第一個括號（對不對？）→ 框到理由說明文字最末一字
  框內必須同時看到「(對/不對)」+「為什麼？(理由...)」整段
- compound_chain_table 「表格連動題」：整 row 框起來（涵蓋該行所有 cell），從第一格到最後一格框成一個 bbox

═══════════════ Output ═══════════════
回傳純 JSON，不要 Markdown：
{
  "locations": [
    { "questionId": "1", "answerBbox": { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 } }
  ]
}`.trim()
}

async function locateAnswerKeyBboxes(questions, inlineImages, apiKey, model, pageToImageIndex = new Map()) {
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
    const globalPageNum = pageIdx + 1
    const batchLocalIdx = pageToImageIndex.has(globalPageNum)
      ? pageToImageIndex.get(globalPageNum)
      : Math.min(pageIdx, inlineImages.length - 1)
    const img = inlineImages[batchLocalIdx]
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
        // 必須四個欄位都是有限數字、且 w/h > 0；缺欄位的 bbox 寧可丟掉走 extract fallback
        // 必須四個欄位都是有限數字、w/h > 0、且全部在 [0, 2] 範圍內（>2 視為像素座標誤回）
        const inRange = (v) => Number.isFinite(v) && v >= 0 && v <= 2
        const valid = bbox
          && inRange(bbox.x) && inRange(bbox.y)
          && inRange(bbox.w) && inRange(bbox.h)
          && bbox.w > 0 && bbox.h > 0
        if (qId && valid) {
          bboxMap.set(qId, bbox)
        } else if (qId && bbox) {
          console.warn(`[orchestrator] locate dropped invalid bbox for ${qId}:`, JSON.stringify(bbox))
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

  // 建立全域頁碼 → 批次內圖片索引的對應表（修正多批次時索引錯位的問題）
  const pageToImageIndex = buildPageLabelToImageIndexMap(contents)
  if (pageToImageIndex.size > 0) {
    console.log(`[orchestrator] pageToImageIndex: ${JSON.stringify(Object.fromEntries(pageToImageIndex))}`)
  }

  // Step 2: locate AI 是 bbox 唯一來源（extract 階段不再產 bbox）
  const locatedBboxMap = await locateAnswerKeyBboxes(questions, inlineImages, apiKey, model, pageToImageIndex)
  const locateMissing = questions.filter((q) => !locatedBboxMap.has(q.id))
  const locateMissingSummary = locateMissing.map((q) => ({
    id: q.id,
    category: q.questionCategory ?? ''
  }))
  console.log(`[orchestrator] answer_key.locate: ${locatedBboxMap.size}/${questions.length} questions located` +
    (locateMissing.length > 0 ? ` | missing: ${JSON.stringify(locateMissingSummary)}` : ''))

  const croppedQuestions = await Promise.all(questions.map(async (q) => {
    const bbox = locatedBboxMap.get(q.id) ?? null
    if (!bbox) return q
    // pageIndex 未設時，從 ID 首段（1-based）推算（例：2-2-1 → pageIdx=1）
    const pageIdx = typeof q.pageIndex === 'number'
      ? q.pageIndex
      : Math.max(0, (parseInt(String(q.id ?? '').split('-')[0], 10) || 1) - 1)
    const globalPageNum = pageIdx + 1
    const batchLocalIdx = pageToImageIndex.has(globalPageNum)
      ? pageToImageIndex.get(globalPageNum)
      : Math.min(pageIdx, inlineImages.length - 1)
    const img = inlineImages[batchLocalIdx]
    if (!img) return q
    const cropUrl = await cropAnswerKeyBbox(img.data, img.mimeType, bbox)
    const updatedQ = { ...q, answerBbox: bbox }  // 寫入 locate 取得的 bbox
    return cropUrl ? { ...updatedQ, cropImageUrl: cropUrl } : updatedQ
  }))

  const cropOkCount = croppedQuestions.filter(q => q.cropImageUrl).length
  console.log(`[orchestrator] answer_key.extract crops: ${cropOkCount}/${croppedQuestions.length} succeeded`)

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
      // classifyOnly mode: return bbox results directly
      if (pipelineResult?.classifyOnly) {
        pipelineResult = {
          status: 200,
          data: { candidates: [{ content: { parts: [{ text: JSON.stringify(pipelineResult) }] } }] },
          pipelineMeta: { pipeline: 'grading-classify-only', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: {} }
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
    if (shouldRunStagedGrading || isPhaseA || isPhaseB) {
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
        const hasBboxCount = questions.filter(q => q.answerBbox).length
        const hasAnswerCount = questions.filter(q => (q.answer || q.referenceAnswer || '').trim()).length
        const dimMismatch = questions.filter(q => {
          if (!Array.isArray(q.rubricsDimensions) || q.rubricsDimensions.length === 0) return false
          const dimSum = q.rubricsDimensions.reduce((s, d) => s + (d?.maxScore || 0), 0)
          return typeof q.maxScore === 'number' && Math.abs(dimSum - q.maxScore) > 0.5
        }).length
        console.log(`${logPrefix} [answer_key.extract] result: ${questions.length} questions, totalScore=${parsed.totalScore}, categories=${JSON.stringify(catCounts)}, withBbox=${hasBboxCount}, withAnswer=${hasAnswerCount}${dimMismatch > 0 ? `, dimScoreMismatch=${dimMismatch}` : ''}`)
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
