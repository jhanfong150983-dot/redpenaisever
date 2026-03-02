import { getPipeline } from './pipelines.js'
import { callGeminiGenerateContent } from './model-adapter.js'
import { AI_ROUTE_KEYS } from './routes.js'

const STAGED_PIPELINE_NAME = 'grading-evaluate-5stage-pipeline'

// ReadAnswer must be deterministic: temperature=0 + topK=1 forces greedy decoding.
// This prevents the model from "solving" or "normalizing" student answers across runs.
const READ_ANSWER_GENERATION_CONFIG = {
  generationConfig: {
    temperature: 0.3,
    topK: 20,
    topP: 0.85,
    thinkingConfig: {
      thinking_level: 'MINIMAL'
    }
  }
}

function createPipelineRunId(requestId = '') {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const normalizedRequestId =
    typeof requestId === 'string'
      ? requestId
          .trim()
          .replace(/[^a-zA-Z0-9-_]/g, '')
          .slice(0, 24)
      : ''
  return normalizedRequestId ? `${normalizedRequestId}-${suffix}` : suffix
}

function logStageStart(pipelineRunId, stageName) {
  console.log(`[AI-5STAGE][${pipelineRunId}] start stage=${stageName}`)
}

function logStageEnd(pipelineRunId, stageName, stageResponse) {
  const status = Number(stageResponse?.status) || 0
  const prepareLatencyMs = Number(stageResponse?.prepareLatencyMs) || 0
  const modelLatencyMs = Number(stageResponse?.modelLatencyMs) || 0
  const warningCount = Array.isArray(stageResponse?.warnings) ? stageResponse.warnings.length : 0
  console.log(
    `[AI-5STAGE][${pipelineRunId}] end stage=${stageName} status=${status} prepareMs=${prepareLatencyMs} modelMs=${modelLatencyMs} warnings=${warningCount}`
  )
  if (warningCount > 0) {
    console.warn(
      `[AI-5STAGE][${pipelineRunId}] stage=${stageName} warningList=${stageResponse.warnings.join(', ')}`
    )
  }
}

function toFiniteNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function clampInt(value, min, max, fallback = min) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

function ensureString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function normalizeEvidenceText(value) {
  return ensureString(value, '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[＝﹦]/g, '=')
    .replace(/[／]/g, '/')
}

function extractFinalAnswerCandidate(studentAnswerRaw) {
  const text = ensureString(studentAnswerRaw, '').trim()
  if (!text || text === '未作答' || text === '無法辨識') return ''

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  // Priority 1: explicit final-answer marker, e.g. 答: / A: / Ans:
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    const markerMatched = line.match(/^(?:答|a|ans)\s*[：:]\s*(.+)$/i)
    if (markerMatched && markerMatched[1]) return markerMatched[1].trim()
  }

  // Priority 2: last equation result on the last non-empty line that contains "="
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line.includes('=')) continue
    const segments = line.split('=').map((part) => part.trim()).filter(Boolean)
    if (segments.length > 0) return segments[segments.length - 1]
  }

  // Priority 3: fallback to the last non-empty line
  return lines[lines.length - 1] || ''
}

function chooseStudentFinal(_answer) {
  // ReadAnswer no longer extracts a separate final answer field.
  // The Assessor reads studentAnswerRaw directly.
  return { studentFinal: '', source: 'none' }
}

function buildStudentFinalCandidates(answers) {
  const rows = Array.isArray(answers) ? answers : []
  return rows.map((item) => {
    const picked = chooseStudentFinal(item)
    return {
      questionId: ensureString(item?.questionId, '').trim(),
      status: ensureString(item?.status, '').trim().toLowerCase() || 'unreadable',
      studentFinal: picked.studentFinal,
      source: picked.source
    }
  })
}

function normalizeBboxRef(value) {
  if (!value || typeof value !== 'object') return null
  const x = toFiniteNumber(value.x)
  const y = toFiniteNumber(value.y)
  const w = toFiniteNumber(value.w)
  const h = toFiniteNumber(value.h)
  if ([x, y, w, h].some((item) => item === null)) return null
  if (w <= 0 || h <= 0) return null
  return { x, y, w, h }
}

function extractCandidateText(data) {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : []
  return candidates
    .flatMap((candidate) => candidate?.content?.parts ?? [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim()
}

function parseCandidateJson(data) {
  const text = extractCandidateText(data)
  if (!text) return null
  const cleaned = text.replace(/```json|```/g, '').trim()

  try {
    return JSON.parse(cleaned)
  } catch {
    // continue
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

function getReadAnswerLogMode() {
  const raw = String(process.env.READ_ANSWER_LOG_MODE || '').trim().toLowerCase()
  if (raw === 'off' || raw === 'schema' || raw === 'full') return raw
  return process.env.NODE_ENV === 'production' ? 'off' : 'schema'
}

function getStagedLogLevel() {
  const raw = String(process.env.STAGED_GRADING_LOG_LEVEL || '').trim().toLowerCase()
  if (raw === 'off' || raw === 'basic' || raw === 'detail') return raw
  return process.env.NODE_ENV === 'production' ? 'basic' : 'detail'
}

function isReadAnswerHardFailCloseEnabled() {
  const raw = String(process.env.READ_ANSWER_HARD_FAIL_CLOSE || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on'
}

function isExplicitFinalMarkerLine(line) {
  return /^(?:答|a|ans)\s*[：:]\s*/i.test(ensureString(line, '').trim())
}

function stripExplicitFinalMarkerLines(text) {
  const value = ensureString(text, '').trim()
  if (!value) return ''
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isExplicitFinalMarkerLine(line))
    .join('\n')
}

function shouldLogStaged(configuredLevel, requiredLevel = 'basic') {
  if (configuredLevel === 'off') return false
  if (requiredLevel === 'detail') return configuredLevel === 'detail'
  return configuredLevel === 'basic' || configuredLevel === 'detail'
}

function logStaged(pipelineRunId, configuredLevel, message, payload, requiredLevel = 'basic') {
  if (!shouldLogStaged(configuredLevel, requiredLevel)) return
  if (payload === undefined) {
    console.log(`[AI-5STAGE][${pipelineRunId}][${requiredLevel}] ${message}`)
    return
  }
  console.log(`[AI-5STAGE][${pipelineRunId}][${requiredLevel}] ${message}`, payload)
}

function truncateLogText(value, maxLength = 2000) {
  const text = ensureString(value, '')
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}... (truncated ${text.length - maxLength} chars)`
}

function toReadAnswerSchemaPreview(parsed) {
  const answers = Array.isArray(parsed?.answers) ? parsed.answers : []
  return {
    answerCount: answers.length,
    answers: answers.map((item) => ({
      questionId: ensureString(item?.questionId, ''),
      status: ensureString(item?.status, ''),
      studentAnswerRaw: ensureString(item?.studentAnswerRaw, '')
    }))
  }
}

function serializeCandidateJson(payload) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(payload) }]
        }
      }
    ]
  }
}

function extractInlineImages(contents) {
  if (!Array.isArray(contents)) return []
  for (const content of contents) {
    if (content?.role !== 'user' || !Array.isArray(content?.parts)) continue
    const images = content.parts
      .map((part) => (part?.inlineData ? { inlineData: part.inlineData } : null))
      .filter((part) => part && part.inlineData?.data && part.inlineData?.mimeType)
    if (images.length > 0) return images
  }
  return []
}

function mapByQuestionId(items, itemToQuestionId) {
  const map = new Map()
  for (const item of items) {
    const questionId = ensureString(itemToQuestionId(item)).trim()
    if (!questionId) continue
    if (!map.has(questionId)) {
      map.set(questionId, item)
    }
  }
  return map
}

function aggregateUsageMetadata(stageResponses) {
  const totals = {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    totalTokenCount: 0
  }

  let hasAny = false
  for (const response of stageResponses) {
    const usage = response?.data?.usageMetadata
    if (!usage || typeof usage !== 'object') continue
    hasAny = true
    totals.promptTokenCount += Number(usage.promptTokenCount) || 0
    totals.candidatesTokenCount += Number(usage.candidatesTokenCount) || 0
    totals.totalTokenCount += Number(usage.totalTokenCount) || 0
  }

  return hasAny ? totals : undefined
}

function normalizeQuestionIdList(answerKey) {
  const questions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  const list = []
  const seen = new Set()
  for (const question of questions) {
    const questionId = ensureString(question?.id).trim()
    if (!questionId || seen.has(questionId)) continue
    list.push(questionId)
    seen.add(questionId)
  }
  return list
}

function normalizeUnorderedMode(value) {
  return ensureString(value, '').trim().toLowerCase() === 'unordered' ? 'unordered' : 'strict'
}

function guessUnorderedGroupId(question) {
  const explicit = ensureString(question?.unorderedGroupId, '').trim()
  if (explicit) return explicit

  if (Array.isArray(question?.idPath) && question.idPath.length > 0) {
    const first = ensureString(question.idPath[0], '').trim()
    if (first) return first
  }

  const questionId = ensureString(question?.id, '').trim()
  if (!questionId) return ''
  const dashIndex = questionId.indexOf('-')
  if (dashIndex > 0) return questionId.slice(0, dashIndex).trim()
  return questionId
}

function normalizeBagMatchingText(value) {
  const base = ensureString(value, '').trim()
  if (!base || base === '未作答' || base === '無法辨識' || base === '未作答/無法辨識') {
    return ''
  }

  return base
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，、；;]/g, '')
}

function buildQuestionExpectedVariants(question) {
  const variants = []
  const pushVariant = (value) => {
    const normalized = normalizeBagMatchingText(value)
    if (!normalized) return
    variants.push(normalized)
  }

  if (toFiniteNumber(question?.type) === 1) {
    pushVariant(question?.answer)
  } else if (toFiniteNumber(question?.type) === 2) {
    pushVariant(question?.referenceAnswer)
    if (Array.isArray(question?.acceptableAnswers)) {
      for (const value of question.acceptableAnswers) pushVariant(value)
    }
  } else {
    pushVariant(question?.answer)
    pushVariant(question?.referenceAnswer)
  }

  if (variants.length === 0) {
    pushVariant(question?.answer)
    pushVariant(question?.referenceAnswer)
  }

  return [...new Set(variants)]
}

function canUseBagMatchingAnswer(answerRow) {
  if (!answerRow || typeof answerRow !== 'object') return false
  const status = ensureString(answerRow.status, '').trim().toLowerCase()
  if (status !== 'read') return false
  return Boolean(normalizeBagMatchingText(answerRow.studentAnswerRaw))
}

function isBagMatch(question, answerRow) {
  if (!canUseBagMatchingAnswer(answerRow)) return false
  const student = normalizeBagMatchingText(answerRow.studentAnswerRaw)
  if (!student) return false
  const expectedVariants = buildQuestionExpectedVariants(question)
  if (expectedVariants.length === 0) return false
  return expectedVariants.includes(student)
}

function maximumBipartiteMatch(adjacency, leftSize, rightSize) {
  const matchedLeftByRight = new Array(rightSize).fill(-1)

  function dfs(leftIndex, seen) {
    const neighbors = adjacency[leftIndex] || []
    for (const rightIndex of neighbors) {
      if (seen[rightIndex]) continue
      seen[rightIndex] = true
      if (matchedLeftByRight[rightIndex] === -1 || dfs(matchedLeftByRight[rightIndex], seen)) {
        matchedLeftByRight[rightIndex] = leftIndex
        return true
      }
    }
    return false
  }

  for (let leftIndex = 0; leftIndex < leftSize; leftIndex += 1) {
    dfs(leftIndex, new Array(rightSize).fill(false))
  }

  const matchedRightByLeft = new Array(leftSize).fill(-1)
  for (let rightIndex = 0; rightIndex < rightSize; rightIndex += 1) {
    const leftIndex = matchedLeftByRight[rightIndex]
    if (leftIndex >= 0) matchedRightByLeft[leftIndex] = rightIndex
  }
  return matchedRightByLeft
}

function remapReadAnswersForUnorderedGroups(answerKey, readAnswerResult) {
  const questions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  const answers = Array.isArray(readAnswerResult?.answers) ? readAnswerResult.answers : []
  if (questions.length === 0 || answers.length === 0) {
    return { answers, stats: [] }
  }

  const groups = new Map()
  for (const question of questions) {
    const questionId = ensureString(question?.id, '').trim()
    if (!questionId) continue
    if (normalizeUnorderedMode(question?.orderMode) !== 'unordered') continue

    const groupId = guessUnorderedGroupId(question)
    if (!groupId) continue

    const list = groups.get(groupId) ?? []
    list.push(question)
    groups.set(groupId, list)
  }

  if (groups.size === 0) {
    return { answers, stats: [] }
  }

  const byQuestionId = mapByQuestionId(answers, (item) => item?.questionId)
  const remappedByQuestionId = new Map()
  const stats = []

  for (const [groupId, groupQuestionsRaw] of groups.entries()) {
    const groupQuestions = groupQuestionsRaw.filter(
      (item) => ensureString(item?.id, '').trim().length > 0
    )
    if (groupQuestions.length < 2) continue

    const groupAnswers = groupQuestions.map((question) => {
      const questionId = ensureString(question?.id, '').trim()
      const existing = byQuestionId.get(questionId)
      if (existing) return existing
      return { questionId, studentAnswerRaw: '未作答', status: 'blank' }
    })

    const adjacency = groupQuestions.map((question) =>
      groupAnswers
        .map((answerRow, index) => (isBagMatch(question, answerRow) ? index : -1))
        .filter((index) => index >= 0)
    )

    const matchedRightByLeft = maximumBipartiteMatch(
      adjacency,
      groupQuestions.length,
      groupAnswers.length
    )

    let movedCount = 0
    let matchedCount = 0
    const candidateMappings = []

    for (let leftIndex = 0; leftIndex < groupQuestions.length; leftIndex += 1) {
      const questionId = ensureString(groupQuestions[leftIndex]?.id, '').trim()
      if (!questionId) continue
      const rightIndex = matchedRightByLeft[leftIndex]
      if (rightIndex < 0) continue
      const source = groupAnswers[rightIndex]
      if (!source) continue
      matchedCount += 1
      if (ensureString(source.questionId, '').trim() !== questionId) {
        movedCount += 1
      }
      candidateMappings.push({
        ...source,
        questionId
      })
    }

    // 安全保護：只在整組「完全匹配」時才允許重排，避免部分匹配把原始 OCR 改壞。
    const applied = matchedCount === groupQuestions.length
    if (applied) {
      for (const mapped of candidateMappings) {
        remappedByQuestionId.set(mapped.questionId, mapped)
      }
    }

    stats.push({
      groupId,
      questionCount: groupQuestions.length,
      matchedCount,
      movedCount,
      applied
    })
  }

  if (remappedByQuestionId.size === 0) {
    return { answers, stats }
  }

  const remappedAnswers = answers.map((item) => {
    const questionId = ensureString(item?.questionId, '').trim()
    if (!questionId) return item
    return remappedByQuestionId.get(questionId) ?? item
  })

  return {
    answers: remappedAnswers,
    stats
  }
}

function normalizeClassifyResult(parsed, questionIds) {
  const alignedRaw = Array.isArray(parsed?.alignedQuestions) ? parsed.alignedQuestions : []
  const byQuestionId = mapByQuestionId(alignedRaw, (item) => item?.questionId)
  const alignedQuestions = []
  const unmappedQuestionIds = []

  for (const questionId of questionIds) {
    const row = byQuestionId.get(questionId)
    const visible = row?.visible === true
    const questionType = row?.questionType === 'word_problem' ? 'word_problem' : 'other'
    alignedQuestions.push({
      questionId,
      visible,
      questionType,
      questionBbox: normalizeBboxRef(row?.questionBbox ?? row?.question_bbox),
      answerBbox: normalizeBboxRef(row?.answerBbox ?? row?.answer_bbox)
    })
    if (!visible) unmappedQuestionIds.push(questionId)
  }

  const visibleCount = alignedQuestions.filter((item) => item.visible).length
  const coverage = questionIds.length === 0 ? 0 : visibleCount / questionIds.length

  return { alignedQuestions, coverage, unmappedQuestionIds }
}

// Extract the text of the final answer line (A:, 答:, Ans:) from full studentAnswerRaw
function extractFinalAnswerLine(text) {
  if (typeof text !== 'string') return ''
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (/^(A\s*:|答\s*:|Ans\s*:)/i.test(line)) return line
  }
  return ''
}

// Extract the last "= X" equation result that appears BEFORE the A:/答:/Ans: line
function extractLastEquationResult(text) {
  if (typeof text !== 'string') return null
  const lines = text.split('\n')
  let lastResult = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^(A\s*:|答\s*:|Ans\s*:)/i.test(trimmed)) break
    const match = trimmed.match(/^=\s*([\d.,]+)/)
    if (match) lastResult = match[1].replace(/,/g, '')
  }
  return lastResult
}

// Extract the first numeric token from a final answer line (e.g. "A: 6.12 cm²" → "6.12")
function extractAnswerNumber(text) {
  if (typeof text !== 'string') return null
  const stripped = text.replace(/^(A\s*:|答\s*:|Ans\s*:)\s*/i, '').trim()
  const match = stripped.match(/\d[\d.,]*/)
  return match ? match[0].replace(/,/g, '') : null
}

function buildWordProblemFinalAnswerPrompt(wordProblemIds) {
  return `
You are a final answer reader. Your ONLY job is to locate and copy the final answer line for each listed question.

Question IDs:
${JSON.stringify(wordProblemIds)}

For each question, find the line starting with "A:", "答:", or "Ans:" in that question's answer area.
Copy ONLY the characters physically written on that line.

Rules:
1. Ignore ALL lines above the final answer line (calculation steps, intermediate results).
2. Do NOT calculate or verify — copy exactly what you see character by character.
3. If no A:/答:/Ans: line → status="blank", studentAnswerRaw="未作答".
4. If the line is unclear → status="unreadable", studentAnswerRaw="無法辨識".
5. Return strict JSON only.

Return:
{
  "answers": [
    {
      "questionId": "string",
      "studentAnswerRaw": "exact text of the A:/答:/Ans: line",
      "status": "read|blank|unreadable"
    }
  ]
}
`.trim()
}

function normalizeReadAnswerResult(parsed, questionIds, mismatchIds = new Set()) {
  const answersRaw = Array.isArray(parsed?.answers) ? parsed.answers : []
  const byQuestionId = mapByQuestionId(answersRaw, (item) => item?.questionId)
  const answers = []

  for (const questionId of questionIds) {
    const row = byQuestionId.get(questionId)
    let studentAnswerRaw = ensureString(row?.studentAnswerRaw, '').trim()
    let status = ensureString(row?.status, '').trim().toLowerCase()

    if (!['read', 'blank', 'unreadable'].includes(status)) {
      if (!studentAnswerRaw || studentAnswerRaw === '未作答') status = 'blank'
      else if (studentAnswerRaw === '無法辨識') status = 'unreadable'
      else status = 'read'
    }

    if (status === 'blank') studentAnswerRaw = '未作答'
    else if (status === 'unreadable') studentAnswerRaw = '無法辨識'

    const entry = { questionId, studentAnswerRaw, status }
    if (mismatchIds.has(questionId)) entry.calculationAnswerMismatch = true
    answers.push(entry)
  }

  return { answers }
}

function normalizeAccessorResult(parsed, answerKey, answers) {
  const answersById = mapByQuestionId(answers, (item) => item?.questionId)
  const scoresRaw = Array.isArray(parsed?.scores) ? parsed.scores : []
  const byQuestionId = mapByQuestionId(scoresRaw, (item) => item?.questionId)
  const keyQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []

  const scores = []
  let totalScore = 0
  for (const question of keyQuestions) {
    const questionId = ensureString(question?.id).trim()
    if (!questionId) continue
    const row = byQuestionId.get(questionId)
    const answer = answersById.get(questionId)
    const pickedFinal = chooseStudentFinal(answer)
    const maxScore = Math.max(0, toFiniteNumber(question?.maxScore) ?? 0)
    const readStatus = answer?.status

    let score = toFiniteNumber(row?.score)
    if (score === null) score = 0
    if (score < 0) score = 0
    if (score > maxScore) score = maxScore

    const isCorrect =
      typeof row?.isCorrect === 'boolean'
        ? row.isCorrect
        : maxScore > 0 && score >= maxScore

    const matchType = ensureString(row?.matchType, '').trim() || (readStatus || 'unreadable')
    const scoringReason = ensureString(row?.scoringReason, '').trim()
    const feedbackBrief = ensureString(row?.feedbackBrief, '').trim()
    const studentFinalAnswerFromModel = ensureString(row?.studentFinalAnswer, '').trim()
    const studentFinalAnswer = studentFinalAnswerFromModel || pickedFinal.studentFinal
    const errorTypeRaw = ensureString(row?.errorType, '').trim().toLowerCase()
    const inferredErrorType =
      readStatus === 'blank'
        ? 'blank'
        : readStatus === 'unreadable'
          ? 'unreadable'
          : isCorrect
            ? 'none'
            : 'concept'
    const errorType = errorTypeRaw || inferredErrorType
    const needExplain =
      typeof row?.needExplain === 'boolean'
        ? row.needExplain
        : !isCorrect || readStatus !== 'read'
    const scoreConfidence = clampInt(row?.scoreConfidence, 0, 100, readStatus === 'read' ? 70 : 0)

    const normalized = {
      questionId,
      score,
      maxScore,
      isCorrect,
      needExplain,
      matchType,
      scoringReason,
      feedbackBrief,
      studentFinalAnswer: studentFinalAnswer || undefined,
      errorType,
      scoreConfidence,
      matchingDetails:
        row?.matchingDetails && typeof row.matchingDetails === 'object'
          ? row.matchingDetails
          : undefined,
      rubricScores: Array.isArray(row?.rubricScores) ? row.rubricScores : undefined
    }

    scores.push(normalized)
    totalScore += score
  }

  return {
    scores,
    totalScore
  }
}

function normalizeExplainResult(parsed, questionIds) {
  const detailsRaw = Array.isArray(parsed?.details) ? parsed.details : []
  const detailByQuestionId = mapByQuestionId(detailsRaw, (item) => item?.questionId)
  const details = []

  for (const questionId of questionIds) {
    const row = detailByQuestionId.get(questionId)
    if (!row) continue
    const reason = ensureString(row?.reason, '').trim()
    details.push({
      questionId,
      reason,
      mistakeType: ensureString(row?.mistakeType, '').trim() || undefined
    })
  }

  const mistakes = Array.isArray(parsed?.mistakes)
    ? parsed.mistakes.filter((item) => item && typeof item === 'object')
    : []
  const weaknesses = Array.isArray(parsed?.weaknesses)
    ? parsed.weaknesses.filter((item) => typeof item === 'string' && item.trim())
    : []
  const suggestions = Array.isArray(parsed?.suggestions)
    ? parsed.suggestions.filter((item) => typeof item === 'string' && item.trim())
    : []

  return {
    details,
    mistakes,
    weaknesses,
    suggestions
  }
}

function normalizeLocateResult(parsed, questionIds) {
  const ids = Array.isArray(questionIds) ? questionIds : []
  const locatedRaw = Array.isArray(parsed?.locatedQuestions) ? parsed.locatedQuestions : []
  const byQuestionId = mapByQuestionId(locatedRaw, (item) => item?.questionId)
  const locatedQuestions = []

  for (const questionId of ids) {
    const row = byQuestionId.get(questionId)
    if (!row) continue
    const questionBbox = normalizeBboxRef(row?.questionBbox ?? row?.question_bbox)
    const answerBbox = normalizeBboxRef(row?.answerBbox ?? row?.answer_bbox)
    const confidence = clampInt(row?.confidence, 0, 100, 0)
    if (!questionBbox && !answerBbox) continue
    locatedQuestions.push({
      questionId,
      questionBbox: questionBbox || undefined,
      answerBbox: answerBbox || undefined,
      confidence
    })
  }

  return { locatedQuestions }
}

function buildClassifyPrompt(questionIds) {
  return `
You are stage CLASSIFY.
Task: identify which question IDs are visible on this student submission image, and classify each visible question's type.

Allowed question IDs:
${JSON.stringify(questionIds)}

Rules:
- Use only the allowed question IDs above.
- visible=true if you can see the question and its answer area on this image.
- visible=false if the question is absent, cut off, or not on this image.
- questionType="word_problem" if the question stem contains a narrative or real-world scenario (應用題, e.g. "小明有X個蘋果..." or "一塊三角形土地..."). Otherwise questionType="other".
- Return strict JSON only.

Output:
{
  "alignedQuestions": [
    { "questionId": "string", "visible": true, "questionType": "word_problem" }
  ]
}
`.trim()
}

function buildLocatePrompt(questionIds) {
  return `
You are stage Locate.
Task: locate question/answer regions for the provided question IDs on this submission image.

Target question IDs:
${JSON.stringify(questionIds)}

Rules:
- Only return question IDs in the target list.
- If you can find a question stem region, return questionBbox.
- If you can find the student answer region, return answerBbox.
- Bboxes must be normalized to [0,1] using:
  { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 }
- If uncertain, still give the best approximate box and lower confidence.
- Return strict JSON only.

Output:
{
  "locatedQuestions": [
    {
      "questionId": "string",
      "questionBbox": { "x": 0.1, "y": 0.1, "w": 0.2, "h": 0.08 },
      "answerBbox": { "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.1 },
      "confidence": 85
    }
  ]
}
`.trim()
}


function buildReadAnswerPrompt(classifyResult) {
  const visibleIds = Array.isArray(classifyResult?.alignedQuestions)
    ? classifyResult.alignedQuestions.filter((q) => q.visible).map((q) => q.questionId)
    : []
  return `
You are a dumb OCR scanner with NO mathematical knowledge. You cannot add, subtract, multiply, or divide. You only see shapes of characters on paper and copy them exactly.

Visible question IDs on this image:
${JSON.stringify(visibleIds)}

ABSOLUTE RULES (never break these):
1. DO NOT solve, calculate, verify, or correct anything. You are mathematically blind.
2. DO NOT normalize symbols (× vs x, ÷ vs /, − vs -).
3. DO NOT add or remove digits, units, decimals, or parentheses.
4. Copy wrong calculations exactly as written. If the student wrote "6+3=8", output "6+3=8".
5. Include ALL lines the student wrote, including lines starting with "A:", "答:", "Ans:" — these contain the final answer and must NOT be dropped.
6. The final answer line (A:, 答:, Ans:, or the last line with a number) MUST be copied digit-by-digit exactly as the student wrote it. Even if you believe the number is mathematically wrong, copy it exactly. You are NOT allowed to verify or correct it.

FINAL ANSWER LINE PROTOCOL:
When you reach the line starting with "A:", "答:", or "Ans:":
1. STOP reading the calculation lines above. They do not exist.
2. Read ONLY the characters physically written in this line, one by one.
3. If you see: A  :  (space)  6  .  1  2  (space)  c  m  ²  → output exactly: "A: 6.12 cm²"
4. The final answer line is INDEPENDENT of the calculation. Never compare them.

7. If any part of the answer is unclear or ambiguous → status="unreadable", studentAnswerRaw="無法辨識".
8. If nothing is written → status="blank", studentAnswerRaw="未作答".
9. Return strict JSON only. No markdown, no commentary.

FORBIDDEN (examples of what you must NEVER do):
- Student wrote "A: 6.12 cm²" → you output "A: 6.24 cm²"  ← FORBIDDEN (you corrected the answer)
- Student wrote "6+3=8" → you output "6+3=9"               ← FORBIDDEN (you corrected the answer)
- Student wrote "÷2=6.12" → you output "÷2=6.24"           ← FORBIDDEN (you corrected the answer)

REQUIRED (examples of correct behavior):
- Student wrote "A: 6.12 cm²" → you output "A: 6.12 cm²"  ← CORRECT
- Student wrote "6+3=8" → you output "6+3=8"               ← CORRECT

Return:
{
  "answers": [
    {
      "questionId": "string",
      "studentAnswerRaw": "exact text as written",
      "status": "read|blank|unreadable"
    }
  ]
}
`.trim()
}

function buildAccessorPrompt(answerKey, readAnswerResult) {
  const compactAnswerKey = {
    questions: Array.isArray(answerKey?.questions) ? answerKey.questions : [],
    totalScore: toFiniteNumber(answerKey?.totalScore) ?? null
  }
  const trimmedAnswers = Array.isArray(readAnswerResult?.answers)
    ? readAnswerResult.answers.map((a) => ({
        questionId: a.questionId,
        status: a.status,
        studentAnswerRaw: a.studentAnswerRaw
      }))
    : []

  return `
You are stage Assessor. Score each question by comparing student answers to the answer key.

AnswerKey:
${JSON.stringify(compactAnswerKey)}

Student answers:
${JSON.stringify(trimmedAnswers)}

Rules:
- score must be 0..maxScore.
- If status is "blank" or "unreadable": score=0, isCorrect=false.
- studentFinalAnswer: extract the student's final answer from studentAnswerRaw if identifiable.
- errorType: calculation|copying|unit|concept|blank|unreadable|none.
- If question has orderMode="unordered" and shares unorderedGroupId with sibling questions:
  - evaluate as a bag (order-insensitive matching) within that group.
- scoringReason and feedbackBrief must NOT reveal the correct answer text, option, or number.
- Never write phrases like "correct answer is ...", "應為 ...", "答案是 ...".
- Return strict JSON only.

Output:
{
  "scores": [
    {
      "questionId": "string",
      "score": 0,
      "maxScore": 5,
      "isCorrect": false,
      "matchType": "exact|semantic|rubric|blank|unreadable",
      "scoringReason": "short reason",
      "feedbackBrief": "one-line teaching hint",
      "studentFinalAnswer": "extracted final answer",
      "errorType": "concept",
      "needExplain": true,
      "scoreConfidence": 79
    }
  ],
  "totalScore": 0
}
`.trim()
}

function buildExplainPrompt(
  answerKey,
  readAnswerResult,
  accessorResult,
  explainQuestionIds,
  domainHint
) {
  const explainSet = new Set(explainQuestionIds)
  const keyQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  const wrongAnswerKey = keyQuestions.filter((q) => explainSet.has(ensureString(q?.id).trim()))
  const wrongReadAnswers = Array.isArray(readAnswerResult?.answers)
    ? readAnswerResult.answers.filter((a) => explainSet.has(ensureString(a?.questionId).trim()))
    : []
  const wrongScores = Array.isArray(accessorResult?.scores)
    ? accessorResult.scores.filter((s) => explainSet.has(ensureString(s?.questionId).trim()))
    : []

  return `
You are stage Explain. Produce teaching feedback for wrong answers only.

Domain: ${JSON.stringify(domainHint || null)}
Wrong question IDs: ${JSON.stringify(explainQuestionIds)}

AnswerKey (wrong questions only):
${JSON.stringify(wrongAnswerKey)}

Student answers (wrong questions only):
${JSON.stringify(wrongReadAnswers)}

Scores (wrong questions only):
${JSON.stringify(wrongScores)}

Rules:
- details[] must only include IDs from wrong question IDs list.
- Focus on why the student got it wrong and how to improve.
- reason must NOT reveal the correct answer text, option, or number.
- Never write phrases like "correct answer is ...", "應為 ...", "答案是 ...".
- Return strict JSON only.

Output:
{
  "details": [
    {
      "questionId": "string",
      "reason": "explanation of the mistake",
      "mistakeType": "concept|calculation|condition|blank|unreadable"
    }
  ],
  "mistakes": [],
  "weaknesses": [],
  "suggestions": []
}
`.trim()
}

async function executeStage({
  apiKey,
  model,
  payload,
  timeoutMs,
  routeHint,
  routeKey,
  stageContents
}) {
  const pipeline = getPipeline(routeKey)

  const prepareStartedAt = Date.now()
  const preparedRequest = await pipeline.prepare({
    model,
    contents: stageContents,
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

  return {
    routeKey,
    pipelineName: pipeline.name,
    status: Number(modelResponse.status) || 500,
    ok: Boolean(modelResponse.ok),
    data: modelResponse.data,
    prepareLatencyMs,
    modelLatencyMs,
    warnings: Array.isArray(validation?.warnings) ? validation.warnings : [],
    metrics: validation?.metrics && typeof validation.metrics === 'object' ? validation.metrics : {}
  }
}

function buildFinalGradingResult({
  answerKey,
  readAnswerResult,
  accessorResult,
  explainResult,
  stageWarnings,
  stageMeta
}) {
  const keyQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  const answerById = mapByQuestionId(readAnswerResult.answers, (item) => item?.questionId)
  const scoreById = mapByQuestionId(accessorResult.scores, (item) => item?.questionId)
  const explainById = mapByQuestionId(explainResult.details, (item) => item?.questionId)
  const classifyAligned = Array.isArray(stageMeta?.classify?.alignedQuestions)
    ? stageMeta.classify.alignedQuestions
    : []
  const classifyById = mapByQuestionId(classifyAligned, (item) => item?.questionId)
  const locateRows = Array.isArray(stageMeta?.locate?.locatedQuestions)
    ? stageMeta.locate.locatedQuestions
    : []
  const locateById = mapByQuestionId(locateRows, (item) => item?.questionId)

  const details = []
  let totalScore = 0
  let unreadableCount = 0

  for (const question of keyQuestions) {
    const questionId = ensureString(question?.id).trim()
    if (!questionId) continue

    const answer = answerById.get(questionId)
    const score = scoreById.get(questionId)
    const explain = explainById.get(questionId)
    const classify = classifyById.get(questionId)
    const locate = locateById.get(questionId)

    if (answer?.status === 'unreadable') unreadableCount += 1

    const hasMismatch = answer?.calculationAnswerMismatch === true
    const row = {
      questionId,
      detectedType: toFiniteNumber(question?.type) ?? undefined,
      studentAnswer: ensureString(answer?.studentAnswerRaw, '無法辨識'),
      isCorrect: hasMismatch ? false : score?.isCorrect === true,
      score: hasMismatch ? 0 : toFiniteNumber(score?.score) ?? 0,
      maxScore: toFiniteNumber(score?.maxScore) ?? Math.max(0, toFiniteNumber(question?.maxScore) ?? 0),
      reason:
        (hasMismatch ? '學生計算過程與最終答案不一致，請特別注意' : '') ||
        ensureString(explain?.reason, '').trim() ||
        ensureString(score?.feedbackBrief, '').trim() ||
        ensureString(score?.scoringReason, '').trim() ||
        (score?.isCorrect ? '答案正確' : '需人工複核'),
      confidence: clampInt(score?.scoreConfidence, 0, 100, 0),
      errorType:
        ensureString(score?.errorType, '').trim() ||
        ensureString(explain?.mistakeType, '').trim() ||
        undefined,
      needExplain: score?.needExplain === true || score?.isCorrect !== true,
      studentFinalAnswer: ensureString(score?.studentFinalAnswer, '').trim() || undefined
    }

    const questionBbox =
      normalizeBboxRef(locate?.questionBbox) ||
      normalizeBboxRef(classify?.questionBbox)
    const answerBbox =
      normalizeBboxRef(locate?.answerBbox) ||
      normalizeBboxRef(classify?.answerBbox)
    if (questionBbox) row.questionBbox = questionBbox
    if (answerBbox) row.answerBbox = answerBbox

    if (score?.matchingDetails && typeof score.matchingDetails === 'object') {
      row.matchingDetails = score.matchingDetails
    }
    if (Array.isArray(score?.rubricScores)) {
      row.rubricScores = score.rubricScores
    }

    details.push(row)
    totalScore += row.score
  }

  const mistakes =
    explainResult.mistakes.length > 0
      ? explainResult.mistakes
      : details
          .filter((item) => !item.isCorrect && item.studentAnswer !== '未作答')
          .map((item) => ({
            id: item.questionId,
            question: `題目 ${item.questionId}`,
            reason: item.reason,
            errorType: item.errorType || 'unknown'
          }))

  const reviewReasons = []
  if (stageMeta.classify.coverage < 1) {
    const percent = Math.round(stageMeta.classify.coverage * 100)
    reviewReasons.push(`Question alignment coverage ${percent}%`)
  }
  if (unreadableCount > 0) {
    reviewReasons.push(`Unreadable answers: ${unreadableCount}`)
  }
  for (const warning of stageWarnings) {
    reviewReasons.push(warning)
  }

  return {
    totalScore,
    details,
    mistakes,
    weaknesses: explainResult.weaknesses,
    suggestions: explainResult.suggestions,
    needsReview: reviewReasons.length > 0,
    reviewReasons
  }
}

export async function runStagedGradingEvaluate({
  apiKey,
  model,
  contents,
  payload = {},
  routeHint = {},
  internalContext = {}
}) {
  const pipelineRunId = createPipelineRunId(internalContext?.requestId)
  const stagedLogLevel = getStagedLogLevel()
  const answerKey = internalContext?.resolvedAnswerKey
  if (!answerKey || typeof answerKey !== 'object') {
    logStaged(pipelineRunId, stagedLogLevel, 'skip reason=missing_answer_key')
    return null
  }

  const questionIds = normalizeQuestionIdList(answerKey)
  if (questionIds.length === 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'skip reason=empty_question_ids')
    return null
  }

  const inlineImages = extractInlineImages(contents)
  if (inlineImages.length === 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'skip reason=missing_submission_image')
    return null
  }
  const submissionImageParts = [inlineImages[0]]

  logStaged(
    pipelineRunId,
    stagedLogLevel,
    `begin model=${model} questionCount=${questionIds.length}`,
    {
      routeHint,
      hasDomainHint: Boolean(internalContext?.domainHint)
    }
  )

  const stageResponses = []
  const stageWarnings = []

  const pipelineStartedAt = Date.now()
  const PIPELINE_BUDGET_MS = 250_000
  const getRemainingBudget = () =>
    Math.max(1000, PIPELINE_BUDGET_MS - (Date.now() - pipelineStartedAt))

  const classifyPrompt = buildClassifyPrompt(questionIds)
  logStageStart(pipelineRunId, 'classify')
  const classifyResponse = await executeStage({
    apiKey,
    model,
    payload,
    timeoutMs: getRemainingBudget(),
    routeHint,
    routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
    stageContents: [{ role: 'user', parts: [{ text: classifyPrompt }, ...submissionImageParts] }]
  })
  logStageEnd(pipelineRunId, 'classify', classifyResponse)
  stageResponses.push(classifyResponse)
  if (!classifyResponse.ok) {
    console.warn(
      `[AI-5STAGE][${pipelineRunId}] abort stage=classify status=${classifyResponse.status}`
    )
    return {
      status: classifyResponse.status,
      data: classifyResponse.data,
      pipelineMeta: {
        pipeline: STAGED_PIPELINE_NAME,
        prepareLatencyMs: classifyResponse.prepareLatencyMs,
        modelLatencyMs: classifyResponse.modelLatencyMs,
        warnings: classifyResponse.warnings,
        metrics: { stage: 'classify' }
      }
    }
  }
  if (classifyResponse.warnings.length > 0) {
    stageWarnings.push(...classifyResponse.warnings.map((item) => `[classify] ${item}`))
  }
  const classifyParsed = parseCandidateJson(classifyResponse.data)
  if (!classifyParsed || typeof classifyParsed !== 'object') {
    throw new Error('staged classify parse failed')
  }
  const classifyResult = normalizeClassifyResult(classifyParsed, questionIds)
  const classifyAligned = Array.isArray(classifyResult.alignedQuestions)
    ? classifyResult.alignedQuestions
    : []
  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'classify normalized-summary',
    {
      coverage: classifyResult.coverage,
      alignedCount: classifyAligned.length,
      visibleCount: classifyAligned.filter((item) => item.visible === true).length,
      unmappedCount: Array.isArray(classifyResult.unmappedQuestionIds)
        ? classifyResult.unmappedQuestionIds.length
        : 0
    }
  )
  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'classify normalized-details',
    classifyAligned,
    'detail'
  )

  // Identify word_problem questions for mismatch detection
  const wordProblemIds = classifyAligned
    .filter((item) => item.visible && item.questionType === 'word_problem')
    .map((item) => item.questionId)

  const readAnswerLogMode = getReadAnswerLogMode()
  let readAnswerResult = { answers: [] }

  // Run main ReadAnswer AND FinalAnswerOnly (for word problems) in parallel
  const readAnswerPrompt = buildReadAnswerPrompt(classifyResult)
  const parallelCalls = [
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
      stageContents: [{ role: 'user', parts: [{ text: readAnswerPrompt }, ...submissionImageParts] }]
    })
  ]
  if (wordProblemIds.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'ReadAnswer mode=with_final_answer_check', {
      wordProblemCount: wordProblemIds.length
    })
    parallelCalls.push(
      executeStage({
        apiKey,
        model,
        payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
        timeoutMs: getRemainingBudget(),
        routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
        stageContents: [
          {
            role: 'user',
            parts: [{ text: buildWordProblemFinalAnswerPrompt(wordProblemIds) }, ...submissionImageParts]
          }
        ]
      })
    )
  } else {
    logStaged(pipelineRunId, stagedLogLevel, 'ReadAnswer mode=standard')
  }

  logStageStart(pipelineRunId, 'ReadAnswer')
  const [readAnswerResponse, finalAnswerOnlyResponse] = await Promise.all(parallelCalls)
  logStageEnd(pipelineRunId, 'ReadAnswer', readAnswerResponse)
  stageResponses.push(readAnswerResponse)
  if (!readAnswerResponse.ok) {
    console.warn(
      `[AI-5STAGE][${pipelineRunId}] abort stage=ReadAnswer status=${readAnswerResponse.status}`
    )
    return {
      status: readAnswerResponse.status,
      data: readAnswerResponse.data,
      pipelineMeta: {
        pipeline: STAGED_PIPELINE_NAME,
        prepareLatencyMs: classifyResponse.prepareLatencyMs + readAnswerResponse.prepareLatencyMs,
        modelLatencyMs: classifyResponse.modelLatencyMs + readAnswerResponse.modelLatencyMs,
        warnings: [...classifyResponse.warnings, ...readAnswerResponse.warnings],
        metrics: { stage: 'read_answer' }
      }
    }
  }
  if (readAnswerResponse.warnings.length > 0) {
    stageWarnings.push(...readAnswerResponse.warnings.map((item) => `[ReadAnswer] ${item}`))
  }
  const readAnswerParsed = parseCandidateJson(readAnswerResponse.data)
  if (!readAnswerParsed || typeof readAnswerParsed !== 'object') {
    throw new Error('staged read_answer parse failed')
  }
  if (readAnswerLogMode !== 'off') {
    const schemaPreview = toReadAnswerSchemaPreview(readAnswerParsed)
    console.log(
      `[AI-5STAGE][${pipelineRunId}] ReadAnswer schema output=${JSON.stringify(schemaPreview)}`
    )
    if (readAnswerLogMode === 'full') {
      const rawText = extractCandidateText(readAnswerResponse.data)
      console.log(
        `[AI-5STAGE][${pipelineRunId}] ReadAnswer raw text=${truncateLogText(rawText, 6000)}`
      )
      console.log(
        `[AI-5STAGE][${pipelineRunId}] ReadAnswer parsed json=${truncateLogText(
          JSON.stringify(readAnswerParsed),
          6000
        )}`
      )
    }
  }

  // Mismatch detection: compare calculation conclusion vs separately-read final answer line
  const mismatchIds = new Set()
  if (wordProblemIds.length > 0 && finalAnswerOnlyResponse?.ok) {
    const finalOnlyParsed = parseCandidateJson(finalAnswerOnlyResponse.data)
    if (finalOnlyParsed && typeof finalOnlyParsed === 'object') {
      const finalOnlyById = mapByQuestionId(
        Array.isArray(finalOnlyParsed.answers) ? finalOnlyParsed.answers : [],
        (item) => item?.questionId
      )
      const mainAnswersRaw = Array.isArray(readAnswerParsed?.answers) ? readAnswerParsed.answers : []
      const mainById = mapByQuestionId(mainAnswersRaw, (item) => item?.questionId)

      for (const questionId of wordProblemIds) {
        const mainRow = mainById.get(questionId)
        const finalOnlyRow = finalOnlyById.get(questionId)
        if (!mainRow || !finalOnlyRow) continue
        if (finalOnlyRow.status === 'blank' || finalOnlyRow.status === 'unreadable') continue

        const calcResult = extractLastEquationResult(ensureString(mainRow.studentAnswerRaw, ''))
        const finalNum = extractAnswerNumber(ensureString(finalOnlyRow.studentAnswerRaw, ''))
        if (calcResult && finalNum && calcResult !== finalNum) {
          // Mismatch detected: retry FinalAnswerOnly once for this question
          console.log(
            `[AI-5STAGE][${pipelineRunId}] mismatch detected questionId=${questionId} calc=${calcResult} finalAnswer=${finalNum} — retrying`
          )
          const retryResponse = await executeStage({
            apiKey,
            model,
            payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
            timeoutMs: getRemainingBudget(),
            routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
            stageContents: [
              {
                role: 'user',
                parts: [
                  { text: buildWordProblemFinalAnswerPrompt([questionId]) },
                  ...submissionImageParts
                ]
              }
            ]
          })
          stageResponses.push(retryResponse)
          if (retryResponse.ok) {
            const retryParsed = parseCandidateJson(retryResponse.data)
            const retryRow = Array.isArray(retryParsed?.answers)
              ? retryParsed.answers.find((a) => ensureString(a?.questionId).trim() === questionId)
              : null
            const retryNum = retryRow
              ? extractAnswerNumber(ensureString(retryRow.studentAnswerRaw, ''))
              : null
            if (retryNum && calcResult !== retryNum) {
              mismatchIds.add(questionId)
              stageWarnings.push(
                `[ReadAnswer] CALC_ANSWER_MISMATCH questionId=${questionId} calc=${calcResult} stated=${retryNum}`
              )
              console.warn(
                `[AI-5STAGE][${pipelineRunId}] mismatch confirmed questionId=${questionId} calc=${calcResult} stated=${retryNum}`
              )
            }
          } else {
            // Retry call failed — flag conservatively
            mismatchIds.add(questionId)
            stageWarnings.push(
              `[ReadAnswer] CALC_ANSWER_MISMATCH questionId=${questionId} calc=${calcResult} stated=${finalNum}`
            )
          }
        }
      }
    }
  }

  readAnswerResult = normalizeReadAnswerResult(readAnswerParsed, questionIds, mismatchIds)
  const unorderedRemap = remapReadAnswersForUnorderedGroups(answerKey, readAnswerResult)
  readAnswerResult = {
    ...readAnswerResult,
    answers: unorderedRemap.answers
  }
  if (unorderedRemap.stats.length > 0) {
    logStaged(
      pipelineRunId,
      stagedLogLevel,
      'unordered-group remap',
      unorderedRemap.stats
    )
  }

  if (readAnswerLogMode !== 'off') {
    console.log(`[AI-5STAGE][${pipelineRunId}] ReadAnswer normalized=${JSON.stringify(readAnswerResult)}`)
  }
  const readAnswers = Array.isArray(readAnswerResult.answers) ? readAnswerResult.answers : []
  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'ReadAnswer normalized-summary',
    {
      answerCount: readAnswers.length,
      readCount: readAnswers.filter((item) => item.status === 'read').length,
      blankCount: readAnswers.filter((item) => item.status === 'blank').length,
      unreadableCount: readAnswers.filter((item) => item.status === 'unreadable').length
    }
  )
  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'ReadAnswer normalized-details',
    readAnswers,
    'detail'
  )

  // ReadAnswer is transcription-only: no equation-vs-final consistency checks here.

  const accessorPrompt = buildAccessorPrompt(answerKey, readAnswerResult)
  logStageStart(pipelineRunId, 'Accessor')
  const accessorResponse = await executeStage({
    apiKey,
    model,
    payload,
    timeoutMs: getRemainingBudget(),
    routeHint,
    routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR,
    stageContents: [{ role: 'user', parts: [{ text: accessorPrompt }] }]
  })
  logStageEnd(pipelineRunId, 'Accessor', accessorResponse)
  stageResponses.push(accessorResponse)
  if (!accessorResponse.ok) {
    console.warn(
      `[AI-5STAGE][${pipelineRunId}] abort stage=Accessor status=${accessorResponse.status}`
    )
    return {
      status: accessorResponse.status,
      data: accessorResponse.data,
      pipelineMeta: {
        pipeline: STAGED_PIPELINE_NAME,
        prepareLatencyMs:
          stageResponses.reduce((sum, stage) => sum + (Number(stage.prepareLatencyMs) || 0), 0),
        modelLatencyMs:
          stageResponses.reduce((sum, stage) => sum + (Number(stage.modelLatencyMs) || 0), 0),
        warnings: stageResponses.flatMap((stage) => stage.warnings || []),
        metrics: { stage: 'accessor' }
      }
    }
  }
  if (accessorResponse.warnings.length > 0) {
    stageWarnings.push(...accessorResponse.warnings.map((item) => `[Accessor] ${item}`))
  }
  const accessorParsed = parseCandidateJson(accessorResponse.data)
  if (!accessorParsed || typeof accessorParsed !== 'object') {
    throw new Error('staged accessor parse failed')
  }
  const accessorResult = normalizeAccessorResult(accessorParsed, answerKey, readAnswerResult.answers)
  const accessorScores = Array.isArray(accessorResult.scores) ? accessorResult.scores : []
  const explainQuestionIds = accessorScores
    .filter((item) => item?.isCorrect !== true || item?.needExplain === true)
    .map((item) => ensureString(item?.questionId).trim())
    .filter((item) => item.length > 0)

  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'Assessor normalized-summary',
    {
      scoreCount: accessorScores.length,
      totalScore: accessorResult.totalScore,
      correctCount: accessorScores.filter((item) => item.isCorrect === true).length,
      wrongCount: accessorScores.filter((item) => item.isCorrect !== true).length,
      needExplainCount: explainQuestionIds.length
    }
  )
  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'Assessor normalized-details',
    accessorScores.map((item) => ({
      questionId: item.questionId,
      isCorrect: item.isCorrect,
      score: item.score,
      maxScore: item.maxScore,
      errorType: item.errorType,
      needExplain: item.needExplain,
      studentFinalAnswer: item.studentFinalAnswer,
      scoringReason: item.scoringReason,
      feedbackBrief: item.feedbackBrief
    })),
    'detail'
  )

  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'Explain targets',
    {
      explainQuestionIds
    }
  )

  const locateQuestionIds = [...new Set(explainQuestionIds)]
  let locateResult = { locatedQuestions: [] }
  if (locateQuestionIds.length > 0) {
    const locatePrompt = buildLocatePrompt(locateQuestionIds)
    logStageStart(pipelineRunId, 'locate')
    const locateResponse = await executeStage({
      apiKey,
      model,
      payload,
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_LOCATE,
      stageContents: [{ role: 'user', parts: [{ text: locatePrompt }, ...submissionImageParts] }]
    })
    logStageEnd(pipelineRunId, 'locate', locateResponse)
    stageResponses.push(locateResponse)

    if (!locateResponse.ok) {
      stageWarnings.push(`[locate] status=${locateResponse.status}`)
      logStaged(
        pipelineRunId,
        stagedLogLevel,
        `skip stage=locate reason=response_status_${locateResponse.status}`
      )
    } else {
      if (locateResponse.warnings.length > 0) {
        stageWarnings.push(...locateResponse.warnings.map((item) => `[locate] ${item}`))
      }
      const locateParsed = parseCandidateJson(locateResponse.data)
      if (locateParsed && typeof locateParsed === 'object') {
        locateResult = normalizeLocateResult(locateParsed, locateQuestionIds)
      } else {
        stageWarnings.push('[locate] JSON_PARSE_FAILED')
      }
    }
  } else {
    logStaged(
      pipelineRunId,
      stagedLogLevel,
      'skip stage=locate reason=no_target_questions'
    )
  }

  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'Locate normalized-summary',
    {
      targetCount: locateQuestionIds.length,
      locatedCount: Array.isArray(locateResult.locatedQuestions)
        ? locateResult.locatedQuestions.length
        : 0
    }
  )
  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'Locate normalized-details',
    Array.isArray(locateResult.locatedQuestions) ? locateResult.locatedQuestions : [],
    'detail'
  )

  let explainResult = {
    details: [],
    mistakes: [],
    weaknesses: [],
    suggestions: []
  }

  if (explainQuestionIds.length > 0) {
    const explainPrompt = buildExplainPrompt(
      answerKey,
      readAnswerResult,
      accessorResult,
      explainQuestionIds,
      internalContext?.domainHint
    )
    logStageStart(pipelineRunId, 'explain')
    const explainResponse = await executeStage({
      apiKey,
      model,
      payload,
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_EXPLAIN,
      stageContents: [{ role: 'user', parts: [{ text: explainPrompt }] }]
    })
    logStageEnd(pipelineRunId, 'explain', explainResponse)
    stageResponses.push(explainResponse)
    if (!explainResponse.ok) {
      console.warn(
        `[AI-5STAGE][${pipelineRunId}] abort stage=explain status=${explainResponse.status}`
      )
      return {
        status: explainResponse.status,
        data: explainResponse.data,
        pipelineMeta: {
          pipeline: STAGED_PIPELINE_NAME,
          prepareLatencyMs:
            stageResponses.reduce((sum, stage) => sum + (Number(stage.prepareLatencyMs) || 0), 0),
          modelLatencyMs:
            stageResponses.reduce((sum, stage) => sum + (Number(stage.modelLatencyMs) || 0), 0),
          warnings: stageResponses.flatMap((stage) => stage.warnings || []),
          metrics: { stage: 'explain' }
        }
      }
    }
    if (explainResponse.warnings.length > 0) {
      stageWarnings.push(...explainResponse.warnings.map((item) => `[explain] ${item}`))
    }
    const explainParsed = parseCandidateJson(explainResponse.data)
    if (!explainParsed || typeof explainParsed !== 'object') {
      throw new Error('staged explain parse failed')
    }
    explainResult = normalizeExplainResult(explainParsed, explainQuestionIds)
  } else {
    logStaged(
      pipelineRunId,
      stagedLogLevel,
      'skip stage=explain reason=no_wrong_questions'
    )
  }

  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'Explain normalized-summary',
    {
      detailCount: explainResult.details.length,
      mistakeCount: explainResult.mistakes.length,
      weaknessCount: explainResult.weaknesses.length,
      suggestionCount: explainResult.suggestions.length
    }
  )
  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'Explain normalized-details',
    explainResult.details,
    'detail'
  )

  const finalResult = buildFinalGradingResult({
    answerKey,
    readAnswerResult,
    accessorResult,
    explainResult,
    stageWarnings,
    stageMeta: {
      classify: classifyResult,
      locate: locateResult
    }
  })
  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'final merged-summary',
    {
      totalScore: finalResult.totalScore,
      detailCount: Array.isArray(finalResult.details) ? finalResult.details.length : 0,
      mistakesCount: Array.isArray(finalResult.mistakes) ? finalResult.mistakes.length : 0,
      needsReview: finalResult.needsReview === true,
      reviewReasonsCount: Array.isArray(finalResult.reviewReasons)
        ? finalResult.reviewReasons.length
        : 0
    }
  )
  logStaged(
    pipelineRunId,
    stagedLogLevel,
    'final merged-details',
    Array.isArray(finalResult.details)
      ? finalResult.details.map((item) => ({
          questionId: item.questionId,
          studentAnswer: item.studentAnswer,
          isCorrect: item.isCorrect,
          score: item.score,
          maxScore: item.maxScore,
          reason: item.reason,
          errorType: item.errorType,
          needExplain: item.needExplain,
          studentFinalAnswer: item.studentFinalAnswer
        }))
      : [],
    'detail'
  )

  const usageMetadata = aggregateUsageMetadata(stageResponses)
  const stagedResponse = serializeCandidateJson(finalResult)
  if (usageMetadata) stagedResponse.usageMetadata = usageMetadata
  stagedResponse.stagedPipeline = {
    version: 'v1',
    stages: stageResponses.map((stage) => ({
      routeKey: stage.routeKey,
      pipeline: stage.pipelineName,
      status: stage.status,
      warnings: stage.warnings,
      metrics: stage.metrics
    }))
  }

  const prepareLatencyMs = stageResponses.reduce(
    (sum, stage) => sum + (Number(stage.prepareLatencyMs) || 0),
    0
  )
  const modelLatencyMs = stageResponses.reduce(
    (sum, stage) => sum + (Number(stage.modelLatencyMs) || 0),
    0
  )
  const stageNameMap = {
    [AI_ROUTE_KEYS.GRADING_CLASSIFY]: 'classify',
    [AI_ROUTE_KEYS.GRADING_READ_ANSWER]: 'ReadAnswer',
    [AI_ROUTE_KEYS.GRADING_ACCESSOR]: 'Accessor',
    [AI_ROUTE_KEYS.GRADING_LOCATE]: 'locate',
    [AI_ROUTE_KEYS.GRADING_EXPLAIN]: 'explain'
  }
  const stageSummary = stageResponses
    .map((s) => `${stageNameMap[s.routeKey] ?? s.routeKey}=${s.modelLatencyMs}ms`)
    .join(' ')
  const totalElapsed = Date.now() - pipelineStartedAt
  console.log(`[AI-5STAGE][${pipelineRunId}] stage-timing ${stageSummary} totalElapsed=${totalElapsed}ms`)
  console.log(
    `[AI-5STAGE][${pipelineRunId}] complete totalPrepareMs=${prepareLatencyMs} totalModelMs=${modelLatencyMs} totalScore=${finalResult.totalScore} needsReview=${finalResult.needsReview}`
  )

  return {
    status: 200,
    data: stagedResponse,
    pipelineMeta: {
      pipeline: STAGED_PIPELINE_NAME,
      prepareLatencyMs,
      modelLatencyMs,
      warnings: stageWarnings,
      metrics: {
        stageCount: stageResponses.length,
        classifyCoverage: classifyResult.coverage,
        unansweredCount: readAnswerResult.answers.filter((item) => item.status !== 'read').length
      }
    }
  }
}

