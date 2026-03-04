import { getPipeline } from './pipelines.js'
import { callGeminiGenerateContent } from './model-adapter.js'
import { AI_ROUTE_KEYS } from './routes.js'

const STAGED_PIPELINE_NAME = 'grading-evaluate-5stage-pipeline'

// ReadAnswer must be deterministic: low temperature prevents the model from
// "solving" or "normalizing" student answers across runs.
// thinking_level=MINIMAL: gemini-3-flash-preview defaults to HIGH which is slow;
// fallback models (e.g. gemini-2.5-flash) will have thinkingConfig stripped automatically.
const READ_ANSWER_GENERATION_CONFIG = {
  generationConfig: {
    temperature: 0.3,
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
  return 'schema' // 預設開啟 schema 模式，讓 Vercel log 看到每題學生答案
}

function getStagedLogLevel() {
  const raw = String(process.env.STAGED_GRADING_LOG_LEVEL || '').trim().toLowerCase()
  if (raw === 'off' || raw === 'basic' || raw === 'detail') return raw
  return 'detail' // 預設開啟 detail 模式，讓 Vercel log 看到逐題批改過程與結果
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

// A2: 用 Sharp 裁切 base64 inline image，回傳裁切後的 inlineData
// bbox 為 normalized [0,1] 座標；失敗時回傳 null（fallback 全圖）
// BBOX_PAD: 向外擴張比例（相對於圖寬/高），補償 Classify bbox 偏小的情況
const BBOX_PAD = 0.03
async function cropInlineImageByBbox(imageBase64, mimeType, bbox) {
  if (!bbox || !imageBase64) return null
  try {
    const { default: sharp } = await import('sharp')
    const imageBuffer = Buffer.from(imageBase64, 'base64')
    const metadata = await sharp(imageBuffer).metadata()
    const { width, height } = metadata
    if (!width || !height) return null

    // 向外擴張 BBOX_PAD，並 clamp 在 [0,1]
    const px = Math.max(0, bbox.x - BBOX_PAD)
    const py = Math.max(0, bbox.y - BBOX_PAD)
    const px2 = Math.min(1, bbox.x + bbox.w + BBOX_PAD)
    const py2 = Math.min(1, bbox.y + bbox.h + BBOX_PAD)

    const x = Math.round(px * width)
    const y = Math.round(py * height)
    const w = Math.min(width - x, Math.max(1, Math.round((px2 - px) * width)))
    const h = Math.min(height - y, Math.max(1, Math.round((py2 - py) * height)))
    if (w <= 0 || h <= 0) return null

    const cropBuffer = await sharp(imageBuffer)
      .extract({ left: x, top: y, width: w, height: h })
      .jpeg({ quality: 90 })
      .toBuffer()

    return { data: cropBuffer.toString('base64'), mimeType: 'image/jpeg' }
  } catch (err) {
    console.warn('[staged-grading] cropInlineImageByBbox failed:', err?.message)
    return null
  }
}

// A5 輔助：正規化答案字串用於比對
// - 去除 emoji、勾選符號、結尾方向箭頭、開頭選項前綴、外層括號
function normalizeAnswerForComparison(raw) {
  let s = String(raw ?? '').trim()
  // 勾選文字描述 → 只取選項字母
  // "勾選(A)" / "選擇(B)" / "已選(C)" → "A"/"B"/"C"
  const prefixCheckMatch = s.match(/^(?:勾選|選擇|已選|選了?|打勾選?)\s*\(([A-D甲乙丙丁])\)/u)
  if (prefixCheckMatch) return prefixCheckMatch[1]
  // "(A)有打勾符號" / "(A)已選" / "(A)勾" → "A"
  const suffixCheckMatch = s.match(/^\(([A-D甲乙丙丁])\)\s*(?:有打勾符號|已選|有勾|勾選|打勾|勾)/u)
  if (suffixCheckMatch) return suffixCheckMatch[1]
  // 去除勾選/打叉符號（☑ ✓ ✔ ☒ ✗ ✘ □ ☐ 等）
  s = s.replace(/[☑✓✔☒✗✘□☐☎✅❎]/gu, '').trim()
  // 去除 Unicode Emoji（Presentation 形式）
  s = s.replace(/\p{Emoji_Presentation}/gu, '').trim()
  // 去除結尾方向箭頭
  s = s.replace(/[↗↘↙↖→←↑↓⬆⬇⬅➡]+$/u, '').trim()
  // 去除開頭「(A) 文字」中的選項前綴（後面有空白+其他內容才移除）
  s = s.replace(/^\([A-Za-z]\)\s+/u, '').trim()
  // 整個字串是「(D)」→「D」
  s = s.replace(/^\(([A-Za-z])\)$/u, '$1').trim()
  // 正規化多餘空白
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

// A5 輔助：字元集 Jaccard 相似度（0..1）
function computeStringSimilarity(a, b) {
  if (a === b) return 1
  const setA = new Set([...a])
  const setB = new Set([...b])
  const intersection = [...setA].filter((c) => setB.has(c)).length
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 1 : intersection / union
}

// A5: 純邏輯一致性比對（不耗 token）
// read1/read2: { status: 'read'|'blank'|'unreadable', studentAnswerRaw: string }
function computeConsistencyStatus(read1, read2) {
  const s1 = ensureString(read1?.status, '').toLowerCase()
  const s2 = ensureString(read2?.status, '').toLowerCase()
  // 兩者皆空白 → 一致（都沒作答）
  if (s1 === 'blank' && s2 === 'blank') return 'stable'
  if (s1 !== 'read' || s2 !== 'read') return 'unstable'
  const a1 = normalizeAnswerForComparison(ensureString(read1?.studentAnswerRaw, ''))
  const a2 = normalizeAnswerForComparison(ensureString(read2?.studentAnswerRaw, ''))
  if (a1 === a2) return 'stable'
  // 長答案：字元相似度 ≥ 0.75 視為一致（應對語意相近但措辭不同的描述）
  const longer = Math.max(a1.length, a2.length)
  if (longer >= 6 && computeStringSimilarity(a1, a2) >= 0.75) return 'stable'
  return 'diff'
}

// 將老師確認的 finalAnswers 陣列轉換為 readAnswerResult 格式（供 Accessor 使用）
function finalAnswersToReadAnswerResult(finalAnswers) {
  const answers = Array.isArray(finalAnswers)
    ? finalAnswers.map((a) => {
        const raw = ensureString(a?.finalStudentAnswer, '').trim()
        let status
        if (!raw || raw === '未作答') status = 'blank'
        else if (raw === '無法辨識') status = 'unreadable'
        else status = 'read'
        return {
          questionId: ensureString(a?.questionId, '').trim(),
          studentAnswerRaw: raw || (status === 'blank' ? '未作答' : '無法辨識'),
          status
        }
      })
    : []
  return { answers }
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
    const qt = row?.questionType
    const questionType = qt === 'word_problem' ? 'word_problem' : qt === 'single_choice' ? 'single_choice' : 'other'
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
    const mistakeTypeCodes = Array.isArray(row?.mistakeTypeCodes)
      ? row.mistakeTypeCodes.filter((code) => typeof code === 'string' && code.trim())
      : undefined
    details.push({
      questionId,
      reason,
      mistakeType: ensureString(row?.mistakeType, '').trim() || undefined,
      mistakeTypeCodes: mistakeTypeCodes && mistakeTypeCodes.length > 0 ? mistakeTypeCodes : undefined,
      advise: ensureString(row?.advise, '').trim() || undefined
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

function buildClassifyPrompt(questionIds, answerKeyQuestions) {
  // 從 answerKey 萃取 referenceBbox 提示
  const questions = Array.isArray(answerKeyQuestions) ? answerKeyQuestions : []
  const hasAnyReferenceBbox = questions.some((q) => q?.referenceBbox)
  const referenceHints = hasAnyReferenceBbox
    ? questions
        .filter((q) => q?.referenceBbox && questionIds.includes(ensureString(q?.id).trim()))
        .map((q) => ({
          questionId: ensureString(q.id).trim(),
          expectedAnswer: ensureString(q.answer ?? q.referenceAnswer, '').slice(0, 30),
          referenceBbox: q.referenceBbox
        }))
    : []

  const referenceSection = referenceHints.length > 0
    ? `\n\nREFERENCE POSITIONS from the answer key image (approximate — the student's photo may differ in angle/scale/rotation):\n${JSON.stringify(referenceHints, null, 1)}\n\nIMPORTANT: These are HINTS only. You MUST look at the actual student image to find the real answer locations.\n- If the student wrote their answer near a reference position, use the ACTUAL position you see (adjust/fine-tune the bbox).\n- If the student wrote their answer in a completely different location, use the position where they actually wrote it.\n- If there is no printed question number on the image, use the reference positions to identify which questionId corresponds to which spatial location.\n- referenceBbox is a SUGGESTION, not a command. You have full authority to override it based on what you see.`
    : ''

  return `
You are stage CLASSIFY.
Task: identify which question IDs are visible on this student submission image, classify each visible question's type, and locate each visible question's answer region.

Allowed question IDs:
${JSON.stringify(questionIds)}
${referenceSection}

Rules:
- Use only the allowed question IDs above.
- visible=true if you can see the question and its answer area on this image.
- visible=false if the question is absent, cut off, or not on this image.
- questionType="single_choice" if the question has labeled options (A/B/C/D or 甲/乙/丙/丁) and the student selects exactly one option (circle, tick, or fill-in).
- questionType="word_problem" if the question stem contains a narrative or real-world scenario (應用題, e.g. "小明有X個蘋果..." or "一塊三角形土地...").
- Otherwise questionType="other".
- For visible=true questions, output answerBbox: the normalized [0,1] bounding box of the student's ANSWER AREA ONLY (exclude the question stem).
  Format: { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 } where (x,y)=top-left corner, w=width, h=height.
  If the answer area cannot be determined, omit answerBbox.
- Return strict JSON only.

Output:
{
  "alignedQuestions": [
    {
      "questionId": "string",
      "visible": true,
      "questionType": "word_problem",
      "answerBbox": { "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.08 }
    }
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


function buildReadAnswerPrompt(classifyResult, hasSpatialHints) {
  const visibleQuestions = Array.isArray(classifyResult?.alignedQuestions)
    ? classifyResult.alignedQuestions.filter((q) => q.visible)
    : []
  const visibleIds = visibleQuestions.map((q) => q.questionId)
  const singleChoiceIds = visibleQuestions
    .filter((q) => q.questionType === 'single_choice')
    .map((q) => q.questionId)
  const singleChoiceNote = singleChoiceIds.length > 0
    ? `\nSINGLE-CHOICE questions (output ONE letter only): ${JSON.stringify(singleChoiceIds)}`
    : ''
  const spatialNote = hasSpatialHints
    ? `\n\nSPATIAL WORKSHEET NOTE: This is a map/diagram worksheet where questions correspond to spatial positions (e.g. country names on a map, organ labels on a diagram). Each question's crop shows the area where the student should have written a label or name. Read the handwritten text exactly as the student wrote it.`
    : ''
  return `
You are a dumb OCR scanner with NO mathematical knowledge. You cannot add, subtract, multiply, or divide. You only see shapes of characters on paper and copy them exactly.

Visible question IDs on this image:
${JSON.stringify(visibleIds)}
${singleChoiceNote}

RULES:
1. DO NOT solve, calculate, verify, or correct anything.
2. DO NOT normalize symbols (× vs x, ÷ vs /, − vs -). Copy exactly.
3. Copy wrong calculations exactly as written. "6+3=8" → output "6+3=8".
4. BLANK: If the student wrote nothing → status="blank", studentAnswerRaw="未作答". This includes: empty area, only pre-printed label ("A:", "答:", underlines, boxes, grids), or only pre-printed background art. ONLY handwritten/drawn student marks count as non-blank.
5. UNREADABLE: If text exists but is too unclear to read → status="unreadable", studentAnswerRaw="無法辨識".
6. TEXT ANSWER: Copy the student's written text character-by-character. Include the final answer line (A:, 答:, Ans:) exactly as written.
7. SINGLE-CHOICE: For questions listed in SINGLE-CHOICE above, studentAnswerRaw must be exactly ONE letter (A/B/C/D or 甲/乙/丙/丁). If the student circled/ticked/filled option B → output "B". Do NOT include the full option text.
8. DRAWING ANSWER (map/diagram marks): If the student drew or marked something on a map/diagram (a new pen mark not part of the pre-printed image), describe in Traditional Chinese what was drawn and where → status="read". Example: "在23.5°N與121°E交點處畫出颱風符號". If only pre-printed content is visible with no student mark → status="blank".
9. LANGUAGE: Always output in Traditional Chinese (繁體中文). NEVER output English descriptions.
10. Return strict JSON only. No markdown, no commentary.

FORBIDDEN:
- "A: 6.12 cm²" → output "A: 6.24 cm²"  ← FORBIDDEN (corrected)
- Empty answer area → output any text  ← FORBIDDEN (should be blank)
- Drawing answer → output English description  ← FORBIDDEN
- Single-choice question → output "(B) 太平洋" instead of just "B"  ← FORBIDDEN

REQUIRED:
- "A: 6.12 cm²" → output "A: 6.12 cm²", status="read"  ← CORRECT
- Empty answer area → status="blank", studentAnswerRaw="未作答"  ← CORRECT
- Student drew typhoon at 23.5°N 121°E → "在23.5°N與121°E交點處畫出颱風符號", status="read"  ← CORRECT
- Single-choice: student circled B → output "B", status="read"  ← CORRECT
${spatialNote}

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
      "mistakeType": "concept|calculation|condition|blank|unreadable",
      "mistakeTypeCodes": ["calculation", "unit"],
      "advise": "one-line teaching hint for this student"
    }
  ],
  "mistakes": [],
  "weaknesses": [],
  "suggestions": []
}
`.trim()
}

// Gemini generateContent API 合法欄位白名單（其他欄位送出會導致 INVALID_ARGUMENT）
const GEMINI_PAYLOAD_KEYS = new Set([
  'generationConfig', 'systemInstruction', 'safetySettings',
  'tools', 'toolConfig', 'cachedContent', 'thinkingConfig'
])
function filterPayloadForGemini(payload) {
  if (!payload || typeof payload !== 'object') return {}
  const filtered = {}
  for (const key of GEMINI_PAYLOAD_KEYS) {
    if (payload[key] !== undefined) filtered[key] = payload[key]
  }
  return filtered
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
    payload: filterPayloadForGemini(preparedRequest.payload),
    timeoutMs,
    fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
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
  stageMeta,
  consistencyById
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
    const consistency = consistencyById?.get(questionId)

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

    // Phase A 一致性欄位（若有）
    if (consistency) {
      row.consistencyStatus = consistency.consistencyStatus
      row.readAnswer1 = consistency.readAnswer1
      row.readAnswer2 = consistency.readAnswer2
      if (consistency.finalAnswerSource) row.finalAnswerSource = consistency.finalAnswerSource
    }
    // Explain 新增欄位
    if (explain?.mistakeTypeCodes) row.mistakeTypeCodes = explain.mistakeTypeCodes

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase A: 一致性預處理 (A1 Classify → A2 Crop → A3/A4 ReadAnswer×2 → A5 Consistency)
// ─────────────────────────────────────────────────────────────────────────────
export async function runStagedGradingPhaseA({
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
    logStaged(pipelineRunId, stagedLogLevel, 'PhaseA skip reason=missing_answer_key')
    return null
  }
  const questionIds = normalizeQuestionIdList(answerKey)
  if (questionIds.length === 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'PhaseA skip reason=empty_question_ids')
    return null
  }
  const inlineImages = extractInlineImages(contents)
  if (inlineImages.length === 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'PhaseA skip reason=missing_submission_image')
    return null
  }
  const submissionImageParts = [inlineImages[0]]
  logStaged(pipelineRunId, stagedLogLevel, `PhaseA begin model=${model} questionCount=${questionIds.length}`)

  const stageResponses = []
  const stageWarnings = []
  const pipelineStartedAt = Date.now()
  const PIPELINE_BUDGET_MS = 250_000
  const getRemainingBudget = () => Math.max(1000, PIPELINE_BUDGET_MS - (Date.now() - pipelineStartedAt))

  // ── A1: CLASSIFY (含 answerBbox) ─────────────────────────────────────────
  const answerKeyQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  const classifyPrompt = buildClassifyPrompt(questionIds, answerKeyQuestions)
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
    stageWarnings.push(...classifyResponse.warnings.map((w) => `[classify] ${w}`))
  }
  const classifyParsed = parseCandidateJson(classifyResponse.data)
  if (!classifyParsed || typeof classifyParsed !== 'object') {
    throw new Error('PhaseA classify parse failed')
  }
  const classifyResult = normalizeClassifyResult(classifyParsed, questionIds)
  const classifyAligned = classifyResult.alignedQuestions
  logStaged(pipelineRunId, stagedLogLevel, 'classify normalized-summary', {
    coverage: classifyResult.coverage,
    visibleCount: classifyAligned.filter((q) => q.visible).length,
    bboxCount: classifyAligned.filter((q) => q.answerBbox).length
  })

  const wordProblemIds = classifyAligned
    .filter((q) => q.visible && q.questionType === 'word_problem')
    .map((q) => q.questionId)

  // ── A2: CROP (server-side, per question, optional) ────────────────────────
  const cropByQuestionId = new Map()
  const visibleWithBbox = classifyAligned.filter((q) => q.visible && q.answerBbox)
  if (visibleWithBbox.length > 0) {
    const mainInlineData = inlineImages[0].inlineData
    const cropResults = await Promise.all(
      visibleWithBbox.map(async (q) => {
        const cropData = await cropInlineImageByBbox(
          mainInlineData.data,
          mainInlineData.mimeType,
          q.answerBbox
        )
        return { questionId: q.questionId, cropData }
      })
    )
    for (const { questionId, cropData } of cropResults) {
      if (cropData) cropByQuestionId.set(questionId, cropData)
    }
    logStaged(pipelineRunId, stagedLogLevel, 'crop summary', {
      attempted: visibleWithBbox.length,
      succeeded: cropByQuestionId.size
    })
  }

  // ── A3 + A4: ReadAnswer + reReadAnswer IN PARALLEL ────────────────────────
  // Build crop-aware image parts: send per-question crop images when available,
  // so the AI sees only each question's answer area instead of the full page.
  const visibleWithCrop = classifyAligned.filter((q) => q.visible && cropByQuestionId.has(q.questionId))
  const visibleWithoutCrop = classifyAligned.filter((q) => q.visible && !cropByQuestionId.has(q.questionId))

  function buildReadAnswerStageContents(prompt) {
    if (visibleWithCrop.length === 0) {
      // No crops available — fall back to full image
      return [{ role: 'user', parts: [{ text: prompt }, ...submissionImageParts] }]
    }
    // Explain the image layout to the model
    const structureNote = [
      '',
      'IMAGE STRUCTURE: Each question is followed by a CROP IMAGE showing only that question\'s answer area.',
      '- "[QuestionId]" tag → the immediately following image is that question\'s cropped answer region.',
      '- Read ONLY from the crop image for that question. Ignore any text outside the crop.',
      visibleWithoutCrop.length > 0
        ? `- Questions without a crop (read from [FULL PAGE] image at the end): ${visibleWithoutCrop.map((q) => q.questionId).join(', ')}`
        : '- All visible questions have a crop image.'
    ].join('\n')

    const parts = [{ text: prompt + structureNote }]
    for (const q of visibleWithCrop) {
      const cropData = cropByQuestionId.get(q.questionId)
      parts.push({ text: `[${q.questionId}]` })
      parts.push({ inlineData: { mimeType: cropData.mimeType, data: cropData.data } })
    }
    if (visibleWithoutCrop.length > 0) {
      parts.push({ text: '[FULL PAGE]' })
      parts.push(submissionImageParts[0])
    }
    return [{ role: 'user', parts }]
  }

  const hasSpatialHints = answerKeyQuestions.some((q) => q?.referenceBbox)
  const readAnswerPrompt = buildReadAnswerPrompt(classifyResult, hasSpatialHints)
  logStaged(pipelineRunId, stagedLogLevel, 'ReadAnswer image mode', {
    croppedQuestions: visibleWithCrop.length,
    fullImageQuestions: visibleWithoutCrop.length
  })
  const parallelCalls = [
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
      stageContents: buildReadAnswerStageContents(readAnswerPrompt)
    }),
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER,
      stageContents: buildReadAnswerStageContents(readAnswerPrompt)
    })
  ]
  if (wordProblemIds.length > 0) {
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
  }
  logStageStart(pipelineRunId, 'ReadAnswer+reReadAnswer')
  const [readAnswerResponse, reReadAnswerResponse, finalAnswerOnlyResponse] =
    await Promise.all(parallelCalls)
  logStageEnd(pipelineRunId, 'ReadAnswer', readAnswerResponse)
  logStageEnd(pipelineRunId, 'reReadAnswer', reReadAnswerResponse)
  stageResponses.push(readAnswerResponse, reReadAnswerResponse)

  if (!readAnswerResponse.ok) {
    return {
      status: readAnswerResponse.status,
      data: readAnswerResponse.data,
      pipelineMeta: {
        pipeline: STAGED_PIPELINE_NAME,
        prepareLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.prepareLatencyMs) || 0), 0),
        modelLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0),
        warnings: stageResponses.flatMap((r) => r.warnings || []),
        metrics: { stage: 'read_answer' }
      }
    }
  }
  if (readAnswerResponse.warnings.length > 0) {
    stageWarnings.push(...readAnswerResponse.warnings.map((w) => `[ReadAnswer] ${w}`))
  }
  const readAnswerParsed = parseCandidateJson(readAnswerResponse.data)
  if (!readAnswerParsed || typeof readAnswerParsed !== 'object') {
    throw new Error('PhaseA read_answer parse failed')
  }
  const reReadAnswerParsed = reReadAnswerResponse?.ok
    ? parseCandidateJson(reReadAnswerResponse.data)
    : null

  // Mismatch detection for word problems (A3 calc result vs FinalAnswerOnly)
  const mismatchIds = new Set()
  if (wordProblemIds.length > 0 && finalAnswerOnlyResponse?.ok) {
    const finalOnlyParsed = parseCandidateJson(finalAnswerOnlyResponse.data)
    if (finalOnlyParsed && typeof finalOnlyParsed === 'object') {
      const finalOnlyById = mapByQuestionId(
        Array.isArray(finalOnlyParsed.answers) ? finalOnlyParsed.answers : [],
        (item) => item?.questionId
      )
      const mainById = mapByQuestionId(
        Array.isArray(readAnswerParsed?.answers) ? readAnswerParsed.answers : [],
        (item) => item?.questionId
      )
      for (const questionId of wordProblemIds) {
        const mainRow = mainById.get(questionId)
        const finalOnlyRow = finalOnlyById.get(questionId)
        if (!mainRow || !finalOnlyRow) continue
        if (finalOnlyRow.status === 'blank' || finalOnlyRow.status === 'unreadable') continue
        const calcResult = extractLastEquationResult(ensureString(mainRow.studentAnswerRaw, ''))
        const finalNum = extractAnswerNumber(ensureString(finalOnlyRow.studentAnswerRaw, ''))
        if (calcResult && finalNum && calcResult !== finalNum) {
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
            }
          } else {
            mismatchIds.add(questionId)
            stageWarnings.push(
              `[ReadAnswer] CALC_ANSWER_MISMATCH questionId=${questionId} calc=${calcResult} stated=${finalNum}`
            )
          }
        }
      }
    }
  }

  // Normalize read1 with mismatch flags & unordered remap
  let readAnswerResult = normalizeReadAnswerResult(readAnswerParsed, questionIds, mismatchIds)
  const unorderedRemap = remapReadAnswersForUnorderedGroups(answerKey, readAnswerResult)
  readAnswerResult = { ...readAnswerResult, answers: unorderedRemap.answers }

  // Normalize read2 (independent — no mismatch flags)
  const reReadAnswerResult = reReadAnswerParsed
    ? normalizeReadAnswerResult(reReadAnswerParsed, questionIds, new Set())
    : { answers: [] }

  // ── A5: CONSISTENCY CHECK (pure logic) ───────────────────────────────────
  const read1ById = mapByQuestionId(readAnswerResult.answers, (item) => item?.questionId)
  const read2ById = mapByQuestionId(reReadAnswerResult.answers, (item) => item?.questionId)

  const questionResults = questionIds.map((questionId) => {
    const read1 = read1ById.get(questionId)
    const read2 = read2ById.get(questionId)
    const classifyRow = classifyAligned.find((q) => q.questionId === questionId)
    const consistencyStatus =
      read1 && read2 ? computeConsistencyStatus(read1, read2) : 'unstable'
    // 非 stable 題目附上 crop 圖供老師審查
    const cropData = consistencyStatus !== 'stable' ? cropByQuestionId.get(questionId) : undefined
    const answerCropImageUrl = cropData
      ? `data:${cropData.mimeType};base64,${cropData.data}`
      : undefined
    return {
      questionId,
      consistencyStatus,
      readAnswer1: {
        status: read1?.status ?? 'unreadable',
        studentAnswer: read1?.studentAnswerRaw ?? '無法辨識'
      },
      readAnswer2: {
        status: read2?.status ?? 'unreadable',
        studentAnswer: read2?.studentAnswerRaw ?? '無法辨識'
      },
      answerCropImageUrl,
      answerBbox: classifyRow?.answerBbox ?? null,
      hasCropImage: cropByQuestionId.has(questionId),
      calculationAnswerMismatch: read1?.calculationAnswerMismatch === true
    }
  })

  const stableCount = questionResults.filter((q) => q.consistencyStatus === 'stable').length
  const diffCount = questionResults.filter((q) => q.consistencyStatus === 'diff').length
  const unstableCount = questionResults.filter((q) => q.consistencyStatus === 'unstable').length
  logStaged(pipelineRunId, stagedLogLevel, 'PhaseA consistency summary', {
    stableCount,
    diffCount,
    unstableCount
  })

  return {
    phaseAComplete: true,
    questionResults,
    stableCount,
    diffCount,
    unstableCount,
    _internal: {
      answerKey,
      questionIds,
      classifyResult,
      readAnswerResult,
      stageResponses,
      stageWarnings,
      pipelineRunId,
      stagedLogLevel,
      cropByQuestionId
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase B: 正式批改 (B1 Accessor → B2 Explain)
// finalAnswers: [{ questionId, finalStudentAnswer, finalAnswerSource }]
// ─────────────────────────────────────────────────────────────────────────────
export async function runStagedGradingPhaseB({
  apiKey,
  model,
  contents,
  payload = {},
  routeHint = {},
  internalContext = {},
  phaseAResult,
  finalAnswers
}) {
  // Accept _internal (server-internal path) or _phaseContext (client round-trip path)
  const internalState = phaseAResult?._internal || phaseAResult?._phaseContext
  if (!internalState) {
    throw new Error('runStagedGradingPhaseB: phaseAResult._internal or _phaseContext is required')
  }
  const {
    answerKey,
    questionIds,
    classifyResult,
    stageResponses: _inheritedStageResponses,
    stageWarnings: _inheritedStageWarnings,
    pipelineRunId,
    stagedLogLevel
  } = internalState
  // _phaseContext (client round-trip path) does not carry Phase A stageResponses/Warnings;
  // initialise fresh arrays so Phase B latency/warnings are tracked independently.
  const stageResponses = Array.isArray(_inheritedStageResponses) ? [..._inheritedStageResponses] : []
  const stageWarnings = Array.isArray(_inheritedStageWarnings) ? [..._inheritedStageWarnings] : []

  const inlineImages = extractInlineImages(contents)
  const submissionImageParts = inlineImages.length > 0 ? [inlineImages[0]] : []

  const phaseBStartedAt = Date.now()
  const PHASE_B_BUDGET_MS = 180_000
  const getRemainingBudget = () => Math.max(1000, PHASE_B_BUDGET_MS - (Date.now() - phaseBStartedAt))

  // 將老師確認的 finalAnswers 轉為 readAnswerResult 格式
  const finalReadAnswerResult = finalAnswersToReadAnswerResult(finalAnswers)

  // ── B1: ACCESSOR ─────────────────────────────────────────────────────────
  const accessorPrompt = buildAccessorPrompt(answerKey, finalReadAnswerResult)
  logStageStart(pipelineRunId, 'Accessor')
  const accessorResponse = await executeStage({
    apiKey,
    model,
    payload,
    timeoutMs: getRemainingBudget(),
    routeHint,
    routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR,
    stageContents: [{ role: 'user', parts: [{ text: accessorPrompt }, ...submissionImageParts] }]
  })
  logStageEnd(pipelineRunId, 'Accessor', accessorResponse)
  stageResponses.push(accessorResponse)
  if (!accessorResponse.ok) {
    return {
      status: accessorResponse.status,
      data: accessorResponse.data,
      pipelineMeta: {
        pipeline: STAGED_PIPELINE_NAME,
        prepareLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.prepareLatencyMs) || 0), 0),
        modelLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0),
        warnings: stageResponses.flatMap((r) => r.warnings || []),
        metrics: { stage: 'accessor' }
      }
    }
  }
  if (accessorResponse.warnings.length > 0) {
    stageWarnings.push(...accessorResponse.warnings.map((w) => `[Accessor] ${w}`))
  }
  const accessorParsed = parseCandidateJson(accessorResponse.data)
  if (!accessorParsed || typeof accessorParsed !== 'object') {
    throw new Error('PhaseB accessor parse failed')
  }
  const accessorResult = normalizeAccessorResult(accessorParsed, answerKey, finalReadAnswerResult.answers)
  const accessorScores = Array.isArray(accessorResult.scores) ? accessorResult.scores : []
  const explainQuestionIds = accessorScores
    .filter((s) => s?.isCorrect !== true || s?.needExplain === true)
    .map((s) => ensureString(s?.questionId).trim())
    .filter(Boolean)

  // ── B2: EXPLAIN (僅限 isFullScore=false) ─────────────────────────────────
  let explainResult = { details: [], mistakes: [], weaknesses: [], suggestions: [] }
  if (explainQuestionIds.length > 0) {
    const explainPrompt = buildExplainPrompt(
      answerKey,
      finalReadAnswerResult,
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
      stageContents: [{ role: 'user', parts: [{ text: explainPrompt }, ...submissionImageParts] }]
    })
    logStageEnd(pipelineRunId, 'explain', explainResponse)
    stageResponses.push(explainResponse)
    if (explainResponse.ok) {
      if (explainResponse.warnings.length > 0) {
        stageWarnings.push(...explainResponse.warnings.map((w) => `[explain] ${w}`))
      }
      const explainParsed = parseCandidateJson(explainResponse.data)
      if (explainParsed && typeof explainParsed === 'object') {
        explainResult = normalizeExplainResult(explainParsed, explainQuestionIds)
      }
    } else {
      stageWarnings.push(`[explain] status=${explainResponse.status}`)
    }
  } else {
    logStaged(pipelineRunId, stagedLogLevel, 'skip stage=explain reason=no_wrong_questions')
  }

  // 建立 consistencyById（從 phaseAResult，並注入 finalAnswerSource）
  const consistencyById = mapByQuestionId(phaseAResult.questionResults, (item) => item?.questionId)
  if (Array.isArray(finalAnswers)) {
    for (const fa of finalAnswers) {
      const qId = ensureString(fa?.questionId, '').trim()
      if (!qId) continue
      const existing = consistencyById.get(qId)
      if (existing && fa.finalAnswerSource) {
        consistencyById.set(qId, { ...existing, finalAnswerSource: fa.finalAnswerSource })
      }
    }
  }

  // 組裝最終結果（含 consistency 欄位）
  const finalResult = buildFinalGradingResult({
    answerKey,
    readAnswerResult: finalReadAnswerResult,
    accessorResult,
    explainResult,
    stageWarnings,
    stageMeta: {
      classify: classifyResult,
      locate: { locatedQuestions: [] }
    },
    consistencyById
  })

  logStaged(pipelineRunId, stagedLogLevel, 'PhaseB final summary', {
    totalScore: finalResult.totalScore,
    detailCount: Array.isArray(finalResult.details) ? finalResult.details.length : 0,
    needsReview: finalResult.needsReview
  })

  const usageMetadata = aggregateUsageMetadata(stageResponses)
  const stagedResponse = serializeCandidateJson(finalResult)
  if (usageMetadata) stagedResponse.usageMetadata = usageMetadata
  stagedResponse.stagedPipeline = {
    version: 'v2-phase-b',
    stages: stageResponses.map((stage) => ({
      routeKey: stage.routeKey,
      pipeline: stage.pipelineName,
      status: stage.status,
      warnings: stage.warnings,
      metrics: stage.metrics
    }))
  }

  const prepareLatencyMs = stageResponses.reduce((s, r) => s + (Number(r.prepareLatencyMs) || 0), 0)
  const modelLatencyMs = stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0)
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
        unansweredCount: finalReadAnswerResult.answers.filter((a) => a.status !== 'read').length
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 完整流程 (向後兼容)：Phase A 後自動採用 read1 作為 finalStudentAnswer，再執行 Phase B
// ─────────────────────────────────────────────────────────────────────────────
export async function runStagedGradingEvaluate({
  apiKey,
  model,
  contents,
  payload = {},
  routeHint = {},
  internalContext = {}
}) {
  // Phase A: Classify + Crop + ReadAnswer×2 + Consistency
  const phaseAResult = await runStagedGradingPhaseA({
    apiKey, model, contents, payload, routeHint, internalContext
  })
  if (!phaseAResult) return null
  // Phase A 若回傳 HTTP 錯誤（非正常 phaseAComplete 結果）直接回傳
  if (phaseAResult.status && !phaseAResult.phaseAComplete) return phaseAResult

  // Auto-confirm: 全自動模式下以 read1 作為 finalStudentAnswer（無老師決策關卡）
  const finalAnswers = phaseAResult.questionResults.map((qr) => ({
    questionId: qr.questionId,
    finalStudentAnswer: qr.readAnswer1.studentAnswer,
    finalAnswerSource: 'ai_read1'
  }))

  // Phase B: Accessor + Explain
  return runStagedGradingPhaseB({
    apiKey, model, contents, payload, routeHint, internalContext,
    phaseAResult,
    finalAnswers
  })
}


