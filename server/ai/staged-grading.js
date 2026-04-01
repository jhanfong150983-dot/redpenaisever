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

// questionCategory → internal type 1/2/3 (backward compat)
const CATEGORY_TO_TYPE = {
  single_choice: 1,
  multi_choice: 2,
  single_check: 1,
  true_false: 1,
  fill_blank: 1,
  fill_variants: 2,
  multi_check: 2,
  calculation: 3,
  word_problem: 3,
  short_answer: 3,
  map_fill: 2,
  map_draw: 3,
  diagram_draw: 3,
  matching: 1,
}

// Resolve effective type from question (prefer questionCategory, fallback to numeric type)
function resolveQuestionType(question) {
  if (question?.questionCategory && CATEGORY_TO_TYPE[question.questionCategory] !== undefined) {
    return CATEGORY_TO_TYPE[question.questionCategory]
  }
  const t = Number(question?.type)
  return t === 1 || t === 2 || t === 3 ? t : 1
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
    answers: answers.map((item) => {
      const entry = {
        questionId: ensureString(item?.questionId, ''),
        status: ensureString(item?.status, ''),
        studentAnswerRaw: ensureString(item?.studentAnswerRaw, '')
      }
      if (item?.formatBReasoning) {
        entry.formatBReasoning = ensureString(item.formatBReasoning, '')
      }
      return entry
    })
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
// bbox 為 normalized [0,1] 座標；失敗時回傳 null
// useActualBbox=false（預設）：以 bbox 中心點為錨，擴展至固定尺寸（確保一致性）
// useActualBbox=true：直接使用 bbox 的實際範圍（map_draw 等大面積區域用）
const FIXED_CROP_W = 0.55  // 佔圖寬的 55%
const FIXED_CROP_H = 0.20  // 佔圖高的 20%
async function cropInlineImageByBbox(imageBase64, mimeType, bbox, useActualBbox = false) {
  if (!bbox || !imageBase64) return null
  try {
    const { default: sharp } = await import('sharp')
    const imageBuffer = Buffer.from(imageBase64, 'base64')
    const metadata = await sharp(imageBuffer).metadata()
    const { width, height } = metadata
    if (!width || !height) return null

    let px, py, px2, py2
    if (useActualBbox) {
      // 直接使用 bbox 實際範圍，加 5% 邊距
      const pad = 0.03
      px = Math.max(0, bbox.x - pad)
      py = Math.max(0, bbox.y - pad)
      px2 = Math.min(1, bbox.x + bbox.w + pad)
      py2 = Math.min(1, bbox.y + bbox.h + pad)
    } else {
      // 以 bbox 中心點為錨，向外擴展至固定尺寸
      const cx = bbox.x + bbox.w / 2
      const cy = bbox.y + bbox.h / 2
      px = Math.max(0, cx - FIXED_CROP_W / 2)
      py = Math.max(0, cy - FIXED_CROP_H / 2)
      px2 = Math.min(1, cx + FIXED_CROP_W / 2)
      py2 = Math.min(1, cy + FIXED_CROP_H / 2)
    }

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

const CHECKBOX_EQUIVALENT_TYPES = new Set(['single_check', 'multi_check', 'multi_choice'])
const CHECKBOX_FOCUSED_READ_TYPES = new Set(['single_check', 'multi_check', 'multi_choice'])

const CHINESE_NUMBER_MAP = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  兩: 2,
  两: 2
}

const CIRCLED_NUMBER_MAP = {
  '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5, '⑥': 6, '⑦': 7, '⑧': 8, '⑨': 9, '⑩': 10,
  '❶': 1, '❷': 2, '❸': 3, '❹': 4, '❺': 5, '❻': 6, '❼': 7, '❽': 8, '❾': 9, '❿': 10
}

const STEM_LABEL_NUMBER_MAP = {
  甲: 1,
  乙: 2,
  丙: 3,
  丁: 4,
  戊: 5,
  己: 6,
  庚: 7,
  辛: 8,
  壬: 9,
  癸: 10
}

// A5 輔助：正規化答案字串用於比對
// - 去除 emoji、勾選符號、結尾方向箭頭、開頭選項前綴、外層括號
// 正規化 true_false 答案（○/✗ 及其異體）
function normalizeTrueFalseAnswer(raw) {
  const s = String(raw ?? '').trim()
  // 各種「正確」形式 → ○
  if (/^[○〇Oo]$/.test(s) || /^(?:對|是|正確|ｏ|O|yes|Yes)$/u.test(s)) return '○'
  // 各種「錯誤」形式 → ✗
  if (/^[✗✘×Xx叉]$/.test(s) || /^(?:錯|否|不對|不是|no|No)$/u.test(s)) return '✗'
  return null  // 無法正規化
}

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
  // 全形數字 → 半形（新增）
  s = s.replace(/[０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF10))
  // 去除所有空白（新增：避免有無空白造成誤判）
  s = s.replace(/\s+/gu, '')
  return s
}

function normalizeFullWidthDigits(value) {
  return ensureString(value, '').replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xFF10))
}

function parseOrdinalNumber(raw) {
  const token = normalizeFullWidthDigits(raw).trim()
  if (!token) return null

  if (/^\d+$/.test(token)) {
    const n = Number.parseInt(token, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  if (CHINESE_NUMBER_MAP[token]) return CHINESE_NUMBER_MAP[token]

  const tenPrefix = token.match(/^十([一二三四五六七八九])$/u)
  if (tenPrefix) {
    const tail = CHINESE_NUMBER_MAP[tenPrefix[1]]
    return tail ? 10 + tail : null
  }

  const tenSuffix = token.match(/^([一二三四五六七八九])十$/u)
  if (tenSuffix) {
    const head = CHINESE_NUMBER_MAP[tenSuffix[1]]
    return head ? head * 10 : null
  }

  const tenMiddle = token.match(/^([一二三四五六七八九])十([一二三四五六七八九])$/u)
  if (tenMiddle) {
    const head = CHINESE_NUMBER_MAP[tenMiddle[1]]
    const tail = CHINESE_NUMBER_MAP[tenMiddle[2]]
    return head && tail ? head * 10 + tail : null
  }

  return null
}

function normalizeSelectionToken(rawToken) {
  let token = ensureString(rawToken, '').trim()
  if (!token) return ''
  token = token.replace(/[()（）\[\]【】]/g, '').trim()
  if (!token) return ''

  if (CIRCLED_NUMBER_MAP[token]) return `#${CIRCLED_NUMBER_MAP[token]}`
  if (STEM_LABEL_NUMBER_MAP[token]) return `#${STEM_LABEL_NUMBER_MAP[token]}`

  const ordinalMatch = token.match(/^第?\s*([0-9０-９一二三四五六七八九十兩两]+)\s*(?:個|格|項|列|欄)?$/u)
  if (ordinalMatch) {
    const n = parseOrdinalNumber(ordinalMatch[1])
    if (n) return `#${n}`
  }

  const letterMatch = token.match(/^[A-Za-z]$/)
  if (letterMatch) {
    const upper = token.toUpperCase()
    const idx = upper.charCodeAt(0) - 64
    if (idx >= 1 && idx <= 26) return `#${idx}`
    return `@${upper}`
  }

  const number = parseOrdinalNumber(token)
  if (number) return `#${number}`

  return token.replace(/\s+/g, '')
}

function sortSelectionTokens(tokens) {
  const list = Array.isArray(tokens) ? [...tokens] : []
  return list.sort((a, b) => {
    const na = ensureString(a, '').match(/^#(\d+)$/)
    const nb = ensureString(b, '').match(/^#(\d+)$/)
    if (na && nb) return Number.parseInt(na[1], 10) - Number.parseInt(nb[1], 10)
    if (na) return -1
    if (nb) return 1
    return ensureString(a, '').localeCompare(ensureString(b, ''), 'zh-Hant')
  })
}

function normalizeSelectionAnswerForComparison(raw, questionType) {
  const text = ensureString(raw, '').trim()
  if (!text || text === '未作答' || text === '無法辨識') return ''

  const compact = text.replace(/\s+/g, '')
  const ordinalTokens = []
  const ordinalRegex = /第\s*([0-9０-９一二三四五六七八九十兩两]+)\s*個/gu
  let ordinalMatch = ordinalRegex.exec(compact)
  while (ordinalMatch) {
    const number = parseOrdinalNumber(ordinalMatch[1])
    if (number) ordinalTokens.push(`#${number}`)
    ordinalMatch = ordinalRegex.exec(compact)
  }

  let tokens = []
  if (ordinalTokens.length > 0) {
    tokens = ordinalTokens
  } else {
    const normalizedSeparators = compact.replace(/[，、；;｜|\n\r]+/g, ',')
    tokens = normalizedSeparators
      .split(',')
      .map((part) => normalizeSelectionToken(part))
      .filter(Boolean)

    if (tokens.length <= 1) {
      const charTokens = [...normalizedSeparators]
        .map((ch) => normalizeSelectionToken(ch))
        .filter(Boolean)
      if (charTokens.length > 1) tokens = charTokens
    }
  }

  if (tokens.length === 0) {
    return normalizeAnswerForComparison(text)
  }

  if (questionType === 'single_check') {
    return sortSelectionTokens(tokens).join(',')
  }

  const uniqueTokens = Array.from(new Set(tokens))
  return sortSelectionTokens(uniqueTokens).join(',')
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
function computeConsistencyStatus(read1, read2, questionType = 'other') {
  const s1 = ensureString(read1?.status, '').toLowerCase()
  const s2 = ensureString(read2?.status, '').toLowerCase()
  // 兩者皆空白 → 一致（都沒作答）
  if (s1 === 'blank' && s2 === 'blank') return 'stable'
  if (s1 !== 'read' || s2 !== 'read') return 'unstable'

  if (CHECKBOX_EQUIVALENT_TYPES.has(questionType)) {
    const c1 = normalizeSelectionAnswerForComparison(read1?.studentAnswerRaw, questionType)
    const c2 = normalizeSelectionAnswerForComparison(read2?.studentAnswerRaw, questionType)
    if (c1 && c2) {
      return c1 === c2 ? 'stable' : 'diff'
    }
  }

  // true_false：○/✗ 異體字正規化
  if (questionType === 'true_false') {
    const t1 = normalizeTrueFalseAnswer(ensureString(read1?.studentAnswerRaw, ''))
    const t2 = normalizeTrueFalseAnswer(ensureString(read2?.studentAnswerRaw, ''))
    if (t1 && t2) return t1 === t2 ? 'stable' : 'diff'
  }

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

const CLASSIFY_ALLOWED_TYPES = new Set([
  'word_problem',
  'calculation',
  'single_choice',
  'map_fill',
  'map_draw',
  'diagram_draw',
  'multi_check',
  'fill_blank',
  'true_false',
  'matching',
  'multi_choice',
  'single_check'
])

function resolveExpectedQuestionType(question) {
  const category = ensureString(question?.questionCategory, '').trim()
  const answerFormat = ensureString(question?.answerFormat, '').trim().toLowerCase()
  if (answerFormat === 'matching') return 'matching'
  if (category === 'fill_variants') return 'fill_blank'
  if (category === 'short_answer') return 'word_problem'
  if (CLASSIFY_ALLOWED_TYPES.has(category)) return category

  const resolvedType = resolveQuestionType(question)
  if (resolvedType === 3) return 'word_problem'
  if (resolvedType === 2) return 'fill_blank'
  return 'fill_blank'
}

function resolveMatchingGroupId(question) {
  const explicit = ensureString(
    question?.bboxGroupId ?? question?.matchingGroupId ?? question?.unorderedGroupId,
    ''
  ).trim()
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

function resolveBboxPolicyByQuestionType(questionType) {
  if (questionType === 'map_fill') return 'full_image'
  if (questionType === 'matching') return 'group_context'
  return 'question_context'
}

function buildClassifyQuestionSpecs(questionIds, answerKeyQuestions) {
  const questions = Array.isArray(answerKeyQuestions) ? answerKeyQuestions : []
  const byQuestionId = mapByQuestionId(questions, (item) => item?.id)

  return questionIds.map((questionId) => {
    const question = byQuestionId.get(questionId)
    const expectedType = question ? resolveExpectedQuestionType(question) : 'fill_blank'
    const bboxPolicy = resolveBboxPolicyByQuestionType(expectedType)
    const spec = {
      questionId,
      questionType: expectedType,
      bboxPolicy
    }
    if (bboxPolicy === 'group_context') {
      const groupId = resolveMatchingGroupId(question)
      if (groupId) spec.bboxGroupId = groupId
    }
    return spec
  })
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

  const resolvedType = resolveQuestionType(question)
  if (resolvedType === 1) {
    pushVariant(question?.answer)
  } else if (resolvedType === 2) {
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
    const VALID_QUESTION_TYPES = new Set([
      'word_problem', 'calculation', 'single_choice', 'map_fill', 'map_draw',
      'diagram_draw', 'multi_check', 'fill_blank', 'true_false', 'matching',
      'multi_choice', 'single_check'
    ])
    const questionType = VALID_QUESTION_TYPES.has(qt) ? qt : 'other'
    const VALID_DRAW_TYPES = new Set(['map_symbol', 'grid_geometry', 'connect_dots'])
    const drawType = (questionType === 'map_draw' && VALID_DRAW_TYPES.has(row?.drawType))
      ? row.drawType
      : (questionType === 'map_draw' ? 'map_symbol' : undefined)
    alignedQuestions.push({
      questionId,
      visible,
      questionType,
      drawType,
      questionBbox: normalizeBboxRef(row?.questionBbox ?? row?.question_bbox),
      answerBbox: normalizeBboxRef(row?.answerBbox ?? row?.answer_bbox),
      bracketBbox: (questionType === 'single_choice') ? normalizeBboxRef(row?.bracketBbox) : undefined
    })
    if (!visible) unmappedQuestionIds.push(questionId)
  }

  const visibleCount = alignedQuestions.filter((item) => item.visible).length
  const coverage = questionIds.length === 0 ? 0 : visibleCount / questionIds.length

  return { alignedQuestions, coverage, unmappedQuestionIds }
}

function buildBboxUnion(bboxes) {
  const list = Array.isArray(bboxes)
    ? bboxes.map((bbox) => normalizeBboxRef(bbox)).filter(Boolean)
    : []
  if (list.length === 0) return null

  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const bbox of list) {
    minX = Math.min(minX, bbox.x)
    minY = Math.min(minY, bbox.y)
    maxX = Math.max(maxX, bbox.x + bbox.w)
    maxY = Math.max(maxY, bbox.y + bbox.h)
  }

  const width = maxX - minX
  const height = maxY - minY
  if (width <= 0 || height <= 0) return null

  return {
    x: Number(minX.toFixed(4)),
    y: Number(minY.toFixed(4)),
    w: Number(width.toFixed(4)),
    h: Number(height.toFixed(4))
  }
}

function applyClassifyQuestionSpecs(classifyResult, questionSpecs) {
  const alignedRaw = Array.isArray(classifyResult?.alignedQuestions) ? classifyResult.alignedQuestions : []
  if (alignedRaw.length === 0) return classifyResult

  const specs = Array.isArray(questionSpecs) ? questionSpecs : []
  const specByQuestionId = mapByQuestionId(specs, (item) => item?.questionId)
  const fullImageBbox = { x: 0, y: 0, w: 1, h: 1 }

  const alignedQuestions = alignedRaw.map((row) => {
    const questionId = ensureString(row?.questionId, '').trim()
    const spec = specByQuestionId.get(questionId)
    const expectedType = ensureString(spec?.questionType, '').trim()
    const bboxPolicy = ensureString(spec?.bboxPolicy, '').trim()
    const bboxGroupId = ensureString(spec?.bboxGroupId, '').trim()
    const questionType = CLASSIFY_ALLOWED_TYPES.has(expectedType)
      ? expectedType
      : ensureString(row?.questionType, '').trim().toLowerCase() || 'other'
    let questionBbox = normalizeBboxRef(row?.questionBbox ?? row?.question_bbox)
    let answerBbox = normalizeBboxRef(row?.answerBbox ?? row?.answer_bbox)

    if (bboxPolicy === 'full_image') {
      questionBbox = fullImageBbox
      answerBbox = fullImageBbox
    } else {
      if (!questionBbox && answerBbox) questionBbox = answerBbox
      if (!answerBbox && questionBbox) answerBbox = questionBbox
    }

    return {
      ...row,
      questionType,
      bboxPolicyApplied: bboxPolicy || undefined,
      bboxGroupId: bboxGroupId || undefined,
      questionBbox,
      answerBbox,
      bracketBbox:
        questionType === 'single_choice' ? normalizeBboxRef(row?.bracketBbox) : undefined
    }
  })

  // matching group_context: same group shares one union bbox.
  const groupMeta = new Map()
  for (let index = 0; index < alignedQuestions.length; index += 1) {
    const row = alignedQuestions[index]
    if (row?.visible !== true) continue
    const spec = specByQuestionId.get(row.questionId)
    if (!spec || spec.bboxPolicy !== 'group_context') continue
    const groupId = ensureString(spec?.bboxGroupId, '').trim()
    if (!groupId) continue

    const current = groupMeta.get(groupId) || { indexes: [], bboxes: [] }
    current.indexes.push(index)
    if (row?.questionBbox) current.bboxes.push(row.questionBbox)
    if (row?.answerBbox) current.bboxes.push(row.answerBbox)
    groupMeta.set(groupId, current)
  }

  for (const group of groupMeta.values()) {
    if (!Array.isArray(group?.indexes) || group.indexes.length < 2) continue
    const union = buildBboxUnion(group.bboxes)
    if (!union) continue
    for (const index of group.indexes) {
      alignedQuestions[index] = {
        ...alignedQuestions[index],
        questionBbox: union,
        answerBbox: union
      }
    }
  }

  return {
    ...classifyResult,
    alignedQuestions
  }
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

function buildCalculationFinalAnswerPrompt(calculationIds) {
  return `
You are a final answer reader. Your ONLY job is to find the last computed result for each listed calculation question.

Question IDs:
${JSON.stringify(calculationIds)}

For each question, scan the student's work area and find the LAST standalone equation result.
This is the rightmost/bottommost occurrence of "= [number]" in their work (e.g. "25×6=150" → "150").

Rules:
1. Do NOT read "答:" or "A:" lines — calculation questions may not have them.
2. Find the final "= X" where X is a pure number. If multiple lines end with "= X", take the last one.
3. Output ONLY the number after the last "=". Do not include units, formulas, or text.
4. If no "= X" found → status="blank", studentAnswerRaw="未作答".
5. If the work area is unreadable → status="unreadable", studentAnswerRaw="無法辨識".
6. Return strict JSON only.

Return:
{
  "answers": [
    {
      "questionId": "string",
      "studentAnswerRaw": "the last = X number only (e.g. '150')",
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

function applyAnswerOverrides(parsed, overrideMap) {
  const sourceAnswers = Array.isArray(parsed?.answers) ? parsed.answers : []
  const answers = [...sourceAnswers]
  const indexByQuestionId = new Map()
  for (let i = 0; i < answers.length; i += 1) {
    const questionId = ensureString(answers[i]?.questionId, '').trim()
    if (questionId && !indexByQuestionId.has(questionId)) {
      indexByQuestionId.set(questionId, i)
    }
  }

  for (const [questionIdRaw, overrideRaw] of overrideMap.entries()) {
    const questionId = ensureString(questionIdRaw, '').trim()
    if (!questionId || !overrideRaw || typeof overrideRaw !== 'object') continue

    const override = { ...overrideRaw, questionId }
    const status = ensureString(override.status, '').trim().toLowerCase()
    const normalizedStatus = ['read', 'blank', 'unreadable'].includes(status)
      ? status
      : ensureString(override.studentAnswerRaw, '').trim()
        ? 'read'
        : 'blank'
    const normalizedAnswer =
      normalizedStatus === 'blank'
        ? '未作答'
        : normalizedStatus === 'unreadable'
          ? '無法辨識'
          : ensureString(override.studentAnswerRaw, '').trim()

    const nextRow = {
      ...override,
      questionId,
      status: normalizedStatus,
      studentAnswerRaw: normalizedAnswer
    }

    if (indexByQuestionId.has(questionId)) {
      const index = indexByQuestionId.get(questionId)
      answers[index] = { ...answers[index], ...nextRow }
    } else {
      indexByQuestionId.set(questionId, answers.length)
      answers.push(nextRow)
    }
  }

  return {
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    answers
  }
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
    totalScore: parseFloat(totalScore.toFixed(1))
  }
}

function normalizeExplainResult(parsed, questionIds) {
  const detailsRaw = Array.isArray(parsed?.details) ? parsed.details : []
  const detailByQuestionId = mapByQuestionId(detailsRaw, (item) => item?.questionId)
  const details = []

  for (const questionId of questionIds) {
    const row = detailByQuestionId.get(questionId)
    if (!row) continue
    const studentGuidance = ensureString(row?.studentGuidance, '').trim()
    const mistakeTypeCodes = Array.isArray(row?.mistakeTypeCodes)
      ? row.mistakeTypeCodes.filter((code) => typeof code === 'string' && code.trim())
      : undefined
    details.push({
      questionId,
      studentGuidance: studentGuidance || undefined,
      mistakeType: ensureString(row?.mistakeType, '').trim() || undefined,
      mistakeTypeCodes: mistakeTypeCodes && mistakeTypeCodes.length > 0 ? mistakeTypeCodes : undefined
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

function buildClassifyPrompt(questionIds, questionSpecs, pageBreaks = []) {
  const specs = Array.isArray(questionSpecs) ? questionSpecs : []

  // Page boundary section: injected when the submission image is composed of multiple merged photos
  const pageBoundarySection = Array.isArray(pageBreaks) && pageBreaks.length > 0
    ? (() => {
        const totalPages = pageBreaks.length + 1
        const boundaries = []
        let prev = 0
        for (let i = 0; i < pageBreaks.length; i++) {
          boundaries.push(`- Photo ${i + 1} (page ${i + 1}): y=${prev.toFixed(2)} ~ y=${pageBreaks[i].toFixed(2)} → question ID prefix "${i + 1}-"`)
          prev = pageBreaks[i]
        }
        boundaries.push(`- Photo ${totalPages} (page ${totalPages}): y=${prev.toFixed(2)} ~ y=1.00 → question ID prefix "${totalPages}-"`)
        return `\n\nPAGE BOUNDARIES:\nThis image is composed of ${totalPages} original photos merged vertically. Use each question's bbox y-coordinate to determine which page it belongs to, then verify the prefix matches the AnswerKey question ID.\n${boundaries.join('\n')}\nIMPORTANT: AnswerKey IDs already include the page prefix (e.g. "1-3", "2-1"). Match each visible question to its AnswerKey ID by combining the page number derived from its y-position with the question number printed on the paper.`
      })()
    : ''

  return `
You are stage CLASSIFY.
Task: identify which question IDs are visible on this student submission image, and locate each visible question's bbox.
Do NOT infer question type. Question type is fixed by specs.

Allowed question IDs:
${JSON.stringify(questionIds)}

Question Specs (source of truth from AnswerKey):
${JSON.stringify(specs)}
${pageBoundarySection}

Rules:
- Use only the allowed question IDs above.
- For each questionId, questionType MUST exactly match Question Specs.
- Never re-classify question type based on visual guess.
- visible=true if you can see the question and its answer area on this image.
- visible=false if the question is absent, cut off, or not on this image.
- bboxPolicy MUST follow Question Specs:
  - full_image: questionBbox and answerBbox must both be {x:0,y:0,w:1,h:1}.
  - group_context: questions in the same bboxGroupId MUST share the same questionBbox/answerBbox.
  - question_context: minimum bbox must include question number + stem + student answer area.
- For visible=true questions with question_context/group_context, output answerBbox that frames the FULL QUESTION CONTEXT so a teacher can see the entire question at a glance:
  - Include the question number, question stem text, AND the student's answer area all within the bbox.
  - For map_draw and diagram_draw: frame the entire diagram/map/grid area plus any visible question stem above it.
  - For word_problem and calculation: frame from the question stem down through all formula lines and the final answer.
  - For fill_blank with multiple blanks: frame all blanks and the surrounding question text together.
  - For single_choice / multi_choice / single_check / multi_check / true_false: still include question stem + answer area (no answer-only crop).
  - For matching(group_context): include the entire left column + right column + connecting lines of the whole group.
  - The bbox must be ACCURATE and TIGHT (top-left corner = (x,y), width = w, height = h) using actual pixel proportions — do NOT output placeholder sizes.
  Format: { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 } where (x,y)=top-left corner, w=width, h=height, all normalized to [0,1].
  If the question region cannot be determined, omit answerBbox.
- For single_choice questions ONLY: also output bracketBbox that frames ONLY the printed bracket row "（option1，option2）" and the student's mark inside it — do NOT include the question stem text. This should be a very tight crop of just that one bracket line. Omit bracketBbox if this is FORMAT A (empty parentheses where student writes a symbol) or if the bracket row cannot be located precisely.
- Return strict JSON only.

Output:
{
  "alignedQuestions": [
    {
      "questionId": "string",
      "visible": true,
      "questionType": "single_choice",
      "bboxPolicyApplied": "question_context",
      "bboxGroupId": "optional",
      "drawType": "map_symbol",
      "questionBbox": { "x": 0.08, "y": 0.16, "w": 0.62, "h": 0.18 },
      "answerBbox": { "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.08 },
      "bracketBbox": { "x": 0.1, "y": 0.26, "w": 0.25, "h": 0.025 }
    }
  ]
}
`.trim()
}

function buildLocatePrompt(questionIds) {
  return `
You are stage Locate.
Task: for each wrong question ID listed below, locate the region on the student's submission image that a student needs to see when reviewing their mistake.

Target question IDs (these are wrong answers that need correction):
${JSON.stringify(questionIds)}

Rules:
- Only return question IDs in the target list.
- For each question, output questionBbox that captures the FULL CORRECTION CONTEXT the student needs:
  - Frame from the question number/stem down through the student's complete answer.
  - Include enough surrounding text so the student can identify which question this is.
  - For calculation / word_problem: include all formula lines, intermediate steps, and the final answer line.
  - For fill_blank with multiple blanks: include all blanks and the question text together.
  - For single_choice / multi_choice: include the option rows and the parentheses where the student wrote.
  - For single_check / multi_check: include all checkbox options and the student's marks.
  - For map_draw / diagram_draw: include the entire drawn/colored area plus the question stem.
- Also output answerBbox for the precise region where the student actually wrote their answer (tighter than questionBbox). This helps highlight the specific wrong content.
- All bboxes normalized to [0,1]: { "x": top-left x, "y": top-left y, "w": width, "h": height }.
- Be ACCURATE and output actual dimensions — do not use placeholder sizes.
- If uncertain about exact edges, expand slightly to ensure nothing is cut off (err on the side of including more).
- confidence: 0–100, lower if image quality or handwriting makes it hard to locate precisely.
- Return strict JSON only.

Output:
{
  "locatedQuestions": [
    {
      "questionId": "string",
      "questionBbox": { "x": 0.05, "y": 0.12, "w": 0.90, "h": 0.15 },
      "answerBbox": { "x": 0.60, "y": 0.14, "w": 0.35, "h": 0.10 },
      "confidence": 85
    }
  ]
}
`.trim()
}


function buildFocusedBracketReadPrompt(questionId) {
  return `You are looking at a CROPPED IMAGE that shows ONLY a single bracket row "(option1，option2)" with the student's handwritten mark inside it. There is NO question stem visible. You have NO knowledge of the correct answer and must NOT guess based on logic or context.

Your task: identify which pre-printed option word the student circled/underlined/marked.

Question ID: "${questionId}"

Steps (write each step into formatBReasoning):
1. Read the two pre-printed option words: OPTION_LEFT = the word before the comma, OPTION_RIGHT = the word after the comma.
2. Locate the student's handwritten circle, underline, or mark.
3. Determine whether the CENTER of that mark is to the LEFT or RIGHT of the comma character.
4. Output the text of the option on that side.
5. If no mark is visible → blank. If mark center position is truly ambiguous → unreadable.

Return strict JSON:
{
  "answers": [
    {
      "questionId": "${questionId}",
      "studentAnswerRaw": "exact option text the student marked",
      "status": "read|blank|unreadable",
      "formatBReasoning": "OPTION_LEFT=[word], OPTION_RIGHT=[word]. I see a [circle/underline]. Its center is to the [LEFT/RIGHT] of the comma. Therefore I output [word]."
    }
  ]
}`.trim()
}

function buildFocusedCheckboxReadPrompt(questionId, questionType) {
  const normalizedType = ensureString(questionType, '').trim().toLowerCase()
  const isSingle = normalizedType === 'single_check'
  const typeLabel = isSingle ? 'SINGLE-CHECK' : normalizedType === 'multi_choice' ? 'MULTI-CHOICE' : 'MULTI-CHECK'

  return `You are reading a CROPPED IMAGE of ONE ${typeLabel} question. The crop belongs to questionId "${questionId}" only.

Your task: detect which option(s) the student marked in this cropped question.
You do NOT know the correct answer and must NOT guess.

Output token rule (strict):
1) If options have printed labels (e.g. ①②③, A B C, 甲乙丙, 1 2 3), output ONLY those label tokens.
2) If options are unlabeled checkboxes, output "第X個" (e.g. 第一個, 第二個) by reading order.
3) ${isSingle ? 'Output ONE token only.' : 'Output comma-separated tokens with NO spaces, preserving reading order.'}
4) If no visible mark for this question -> status="blank", studentAnswerRaw="未作答".
5) If marks are too unclear to determine -> status="unreadable", studentAnswerRaw="無法辨識".

Return strict JSON:
{
  "answers": [
    {
      "questionId": "${questionId}",
      "studentAnswerRaw": "${isSingle ? '第二個' : '第一個,第三個'}",
      "status": "read|blank|unreadable"
    }
  ]
}`.trim()
}

function buildReadAnswerPrompt(classifyResult, options = {}) {
  const includedIds = new Set(
    Array.isArray(options?.includeQuestionIds)
      ? options.includeQuestionIds.map((id) => ensureString(id, '').trim()).filter(Boolean)
      : []
  )
  const hasIncludeFilter = includedIds.size > 0
  const excludedIds = new Set(
    Array.isArray(options?.excludeQuestionIds)
      ? options.excludeQuestionIds.map((id) => ensureString(id, '').trim()).filter(Boolean)
      : []
  )
  const visibleQuestions = Array.isArray(classifyResult?.alignedQuestions)
    ? classifyResult.alignedQuestions.filter((q) => {
      const questionId = ensureString(q?.questionId, '').trim()
      if (!q.visible || !questionId) return false
      if (hasIncludeFilter && !includedIds.has(questionId)) return false
      return !excludedIds.has(questionId)
    })
    : []
  const visibleIds = visibleQuestions.map((q) => q.questionId)
  const singleChoiceIds = visibleQuestions
    .filter((q) => q.questionType === 'single_choice')
    .map((q) => q.questionId)
  const trueFalseIds = visibleQuestions
    .filter((q) => q.questionType === 'true_false')
    .map((q) => q.questionId)
  const mapFillIds = visibleQuestions
    .filter((q) => q.questionType === 'map_fill')
    .map((q) => q.questionId)
  const multiCheckIds = visibleQuestions
    .filter((q) => q.questionType === 'multi_check')
    .map((q) => q.questionId)
  const multiChoiceIds = visibleQuestions
    .filter((q) => q.questionType === 'multi_choice')
    .map((q) => q.questionId)
  const singleCheckIds = visibleQuestions
    .filter((q) => q.questionType === 'single_check')
    .map((q) => q.questionId)
  const fillBlankIds = visibleQuestions
    .filter((q) => q.questionType === 'fill_blank')
    .map((q) => q.questionId)
  const calculationIds = visibleQuestions
    .filter((q) => q.questionType === 'calculation')
    .map((q) => q.questionId)
  const wordProblemIds = visibleQuestions
    .filter((q) => q.questionType === 'word_problem')
    .map((q) => q.questionId)
  const diagramDrawIds = visibleQuestions
    .filter((q) => q.questionType === 'diagram_draw')
    .map((q) => q.questionId)
  const matchingIds = visibleQuestions
    .filter((q) => q.questionType === 'matching')
    .map((q) => q.questionId)
  // map_draw split by drawType
  const mapDrawSymbolIds = visibleQuestions
    .filter((q) => q.questionType === 'map_draw' && q.drawType !== 'grid_geometry' && q.drawType !== 'connect_dots')
    .map((q) => q.questionId)
  const mapDrawGridIds = visibleQuestions
    .filter((q) => q.questionType === 'map_draw' && q.drawType === 'grid_geometry')
    .map((q) => q.questionId)
  const mapDrawConnectIds = visibleQuestions
    .filter((q) => q.questionType === 'map_draw' && q.drawType === 'connect_dots')
    .map((q) => q.questionId)
  const mapDrawIds = visibleQuestions
    .filter((q) => q.questionType === 'map_draw')
    .map((q) => q.questionId)

  const singleChoiceNote = singleChoiceIds.length > 0
    ? `\nSINGLE-CHOICE questions (output ONE option only): ${JSON.stringify(singleChoiceIds)}`
    : ''
  const trueFalseNote = trueFalseIds.length > 0
    ? `\nTRUE-FALSE questions (output ○ or ✗ only): ${JSON.stringify(trueFalseIds)}`
    : ''
  const mapFillNote = mapFillIds.length > 0
    ? `\nMAP-FILL questions (地圖填圖題): ${JSON.stringify(mapFillIds)}`
    : ''
  const mapDrawSymbolNote = mapDrawSymbolIds.length > 0
    ? `\nMAP-DRAW (map_symbol) questions: ${JSON.stringify(mapDrawSymbolIds)}`
    : ''
  const mapDrawGridNote = mapDrawGridIds.length > 0
    ? `\nMAP-DRAW (grid_geometry) questions: ${JSON.stringify(mapDrawGridIds)}`
    : ''
  const mapDrawConnectNote = mapDrawConnectIds.length > 0
    ? `\nMAP-DRAW (connect_dots) questions: ${JSON.stringify(mapDrawConnectIds)}`
    : ''
  const multiCheckNote = multiCheckIds.length > 0
    ? `\nMULTI-CHECK questions (多選勾選, output comma-separated tokens; use printed labels if any, else 第X個 in reading order): ${JSON.stringify(multiCheckIds)}`
    : ''
  const multiChoiceNote = multiChoiceIds.length > 0
    ? `\nMULTI-CHOICE questions (多選選擇, output comma-separated option symbols written inside parentheses; e.g. "A,C" or "①,③"): ${JSON.stringify(multiChoiceIds)}`
    : ''
  const singleCheckNote = singleCheckIds.length > 0
    ? `\nSINGLE-CHECK questions (單選勾選, output ONE token for the single marked checkbox; use printed label if any, else 第X個 in reading order): ${JSON.stringify(singleCheckIds)}`
    : ''
  const fillBlankNote = fillBlankIds.length > 0
    ? `\nFILL-BLANK questions (填空題, output comma-separated blank contents): ${JSON.stringify(fillBlankIds)}`
    : ''
  const calculationNote = calculationIds.length > 0
    ? `\nCALCULATION questions (計算題, read entire work area): ${JSON.stringify(calculationIds)}`
    : ''
  const wordProblemNote = wordProblemIds.length > 0
    ? `\nWORD-PROBLEM questions (應用題, read entire work area including proportion tables): ${JSON.stringify(wordProblemIds)}`
    : ''
  const diagramDrawNote = diagramDrawIds.length > 0
    ? `\nDIAGRAM-DRAW questions (塗色題, describe coloring): ${JSON.stringify(diagramDrawIds)}`
    : ''
  const matchingNote = matchingIds.length > 0
    ? `\nMATCHING questions (連連看, read ALL pairs as a group): ${JSON.stringify(matchingIds)}`
    : ''
  return `
You are an answer reader. Your only job is to report what the student physically wrote or drew in each question's designated answer space. You have NO mathematical knowledge and must NOT solve, infer, or guess.

Visible question IDs on this image:
${JSON.stringify(visibleIds)}
${singleChoiceNote}${trueFalseNote}${multiCheckNote}${multiChoiceNote}${singleCheckNote}${fillBlankNote}${calculationNote}${wordProblemNote}${diagramDrawNote}${matchingNote}${mapDrawSymbolNote}${mapDrawGridNote}${mapDrawConnectNote}

== ANTI-HALLUCINATION (absolute rule, cannot be overridden) ==
You do NOT know what the correct answer is. You do NOT know what the student intended to write.
NEVER output an answer based on:
- what you think the correct answer should be
- the question stem or context clues
- answers you see in neighboring questions
- printed option labels (A B C D 甲乙丙丁) that the student did NOT mark
You may ONLY output what is physically, visibly written by the student's own hand.
If the answer space is empty → blank. There are NO exceptions.

== BLANK FIRST RULE ==
Before reading each question, ask yourself: "Is there fresh handwriting in this question's answer space?"
- Answer space = the designated writing area: ( ), ___, □, or the answer line after "答:" "A:" "Ans:", or the entire work area for calculation/drawing questions.
- If no fresh handwriting is present → status="blank", studentAnswerRaw="未作答". STOP. Do not read further.
- Pre-printed content (labels, underlines, boxes, option letters A/B/C/D, artwork) does NOT count.
- Only FRESH student pen/pencil marks count.

== COPY RULES (only when non-blank) ==
You are an OCR scanner. Your ONLY job is to copy exactly what the student wrote. You have NO language ability, NO grammar knowledge, and NO understanding of meaning.

1. Copy every character the student wrote, in the exact order written. Do NOT rearrange, reorder, or restructure.
2. Copy wrong calculations exactly: "6+3=8" → output "6+3=8". Never correct.
3. Do NOT normalize symbols: × stays ×, ÷ stays ÷, − stays −.
4. Copy grammatically wrong or nonsensical sentences exactly as written:
   - Student wrote "你那麼高興，既然多吃一點" → output "你那麼高興，既然多吃一點" (do NOT reorder to fix grammar)
   - Student wrote "既然你 ? 麼高" → output "既然你 ? 麼高" (copy the ? as written)
5. Single unreadable character → replace with "?" and continue copying the rest. Do NOT mark the whole answer as unreadable just because one character is unclear.
   - Example: student wrote "既然你[unclear]麼高興" → output "既然你?麼高興"
6. Entire answer completely unreadable (cannot make out any characters) → status="unreadable", studentAnswerRaw="無法辨識".
7. LANGUAGE: Always output in Traditional Chinese (繁體中文).
8. INSERTION MARK (插入符號 ∧ or 入-shape):
   If the student uses a handwritten ∧ or 入-shaped symbol to indicate a text insertion:
   - The tip of the symbol points to the insertion position in the original text.
   - The inserted text is written above the symbol (between the symbol and the line above).
   - Merge the inserted text into the original sentence at exactly that position.
   - Output the COMPLETE merged result as if the insertion was always there. Do NOT mention the symbol.
   - Follow the student's intent faithfully even if the merged result sounds grammatically odd.
   - Example: student wrote "小明走路∧上學" with "快速" written above the ∧ → output "小明走路快速上學"
   - Example: student wrote "答：速率為60∧" with "公尺" above the ∧ → output "答：速率為60公尺"

== QUESTION TYPE RULES ==
SINGLE-CHOICE (questions in SINGLE-CHOICE list):
TWO formats exist — identify which format this question uses, then apply ONLY that format's rule:

FORMAT A — WRITE-IN (student writes a symbol in an empty blank):
- The parentheses ( ) are empty; the student writes ONE option identifier inside: A/B/C/D or 甲/乙/丙/丁 or ①/②/③/④.
- Output exactly that written identifier. Example: student wrote "B" → output "B".

FORMAT B — CIRCLE-IN-PARENS 圈圈看 (both options pre-printed inside parens):
- Both options are pre-printed inside the same parentheses, e.g. "（可以，不可以）" or "（會，不會）" or "（大於，小於，等於）".
- The student circles, underlines, or otherwise marks ONE of the pre-printed words.
- ❌ FORBIDDEN: using the question stem, subject knowledge, or logic to guess which word is correct — you have NO knowledge of correct answers.
- ❌ FORBIDDEN: outputting an answer just because one option "sounds right" or "makes sense" given the question context.
- REQUIRED: For every FORMAT B question, you MUST fill in the "formatBReasoning" field before deciding the answer. Follow these steps IN ORDER and write each step into formatBReasoning:
  Step 1 — Identify options: "OPTION_LEFT=[first word before the comma], OPTION_RIGHT=[second word after the comma]"
  Step 2 — Describe the mark: "I see a [circle/underline/cross-out] drawn by the student."
  Step 3 — Locate relative to comma: "The center of the mark is to the [LEFT/RIGHT] of the comma separator."
  Step 4 — Conclude: "Therefore I output [OPTION_LEFT value / OPTION_RIGHT value]."
- The comma (，or ,) printed between the two options is your ANCHOR POINT. Use it as the dividing line — not the bracket edges, not the midpoint of the text.
- After completing formatBReasoning, set studentAnswerRaw to the concluded option text.
- If Step 3 cannot be determined → status="unreadable", studentAnswerRaw="無法辨識", formatBReasoning must still explain why.
- If no mark at all → blank.

BOTH formats:
- A mark beside option rows or next to a neighboring question does NOT count for this question.
- SELF-CHECK: "Did the student mark in THIS question's answer blank?" If no → blank.

MULTI-CHOICE (questions in MULTI-CHOICE list):
- Answer space is PARENTHESES ( ) — output comma-separated option identifiers for ALL marked options (e.g. "A,C" or "①,③").
- No spaces around commas. If only one option is marked, output just that one (e.g. "B").
- Valid only if the student wrote symbols inside the parentheses ( ) for this question.
- SELF-CHECK: "Did the student mark in THIS question's answer blank?" If no → blank.

TRUE-FALSE (questions in TRUE-FALSE list):
- Output ONLY the symbol or word the student wrote in the answer space.
- Valid outputs: "○", "✗", "對", "錯", "是", "否", or the exact character written.
- Do NOT append any explanatory text (e.g. output "○" NOT "○ 正確").

SINGLE-CHECK (questions in SINGLE-CHECK list):
- Answer space is CHECKBOX □ — output ONE token for the single marked box.
- STRICT FORMAT PRIORITY — apply the FIRST matching rule:
  1. Printed labels exist (①②③ / A B C / 甲乙丙): use ONLY the label character. Template: "<label>". Example: "①" or "A"
  2. Unlabeled boxes: use "第X個" where X is 一/二/三/四/五/六/七/八/九/十, counting in reading order.
- ABSOLUTELY FORBIDDEN: outputting the text/sentence content of the option box.
- If no box is marked → blank.

MULTI-CHECK (questions in MULTI-CHECK list):
- Answer space is CHECKBOXES □ — output comma-separated selected options with NO spaces.
- STRICT FORMAT PRIORITY — apply the FIRST matching rule, never mix rules across options:
  1. Printed labels exist (①②③ / A B C / 1 2 3 / 甲乙丙): use ONLY the label character(s). Template: "<label>". Example: "①,③" or "A,C"
  2. Unlabeled boxes (no printed label next to any box): use ONLY "第X個" where X is 一/二/三/四/五/六/七/八/九/十.
     Count in READING ORDER:
     - Vertical Chinese text with boxes in a HORIZONTAL ROW (each box above a vertical-text column): count RIGHT-to-LEFT. Rightmost box = 第一個.
     - Horizontal text with boxes in a HORIZONTAL ROW: count LEFT-to-RIGHT. Leftmost box = 第一個.
     - Boxes in a VERTICAL COLUMN: count TOP-to-BOTTOM. Topmost box = 第一個.
     Template: "第X個". Example: "第一個,第三個"
- LOCK THE RULE: identify the rule (1 or 2) from the FIRST option you see. Apply that SAME rule to ALL selected options in this question. Never switch rules mid-answer.
- ABSOLUTELY FORBIDDEN: outputting the text/sentence content of the option box. FORBIDDEN: mixing label tokens with 第X個 tokens. FORBIDDEN: plain digits (1,2,3) for unlabeled boxes — always use 第X個.

FILL-BLANK (questions in FILL-BLANK list):
- Output ONLY handwritten content inside each blank, comma-separated left-to-right top-to-bottom.
- Empty blank → "_". Unreadable blank → "?". All blanks empty → status="blank".
- FORBIDDEN: surrounding printed text ("答", underline markers).

CALCULATION (questions in CALCULATION list):
- Read the ENTIRE answer work area: formula steps (橫式/直式) AND the final result.
- Copy ALL calculation content written by the student, including intermediate steps.
- Copy exactly as written: "25×6=150" → output "25×6=150"; wrong calc "6+3=8" → output "6+3=8".
- Include the final answer line if present (e.g. "答: 150" or just "= 150").
- If the work area is blank (no fresh marks) → status="blank".

WORD-PROBLEM (questions in WORD-PROBLEM list):
- Read the ENTIRE answer work area: ALL formula lines, intermediate steps, AND the final answer sentence (答:/A:/Ans:).
- Copy ALL student-written content in reading order (top to bottom, left to right).
- Include the final answer sentence if present (e.g. "答: 小明走了120公尺").
- If the work area is blank (no fresh marks) → status="blank".

PROPORTION TABLE FORMAT (比例式格式) — applies to WORD-PROBLEM and CALCULATION questions:
Students in Taiwan write ratio-scaling in several visual layouts. ALL of the following count as valid 列式:

FORMAT A — Arrow style (×N↙↘×N):
  Example:
       0.048 : 0.2
  ×1000↙         ↘×1000
       48    : ( )
  Output as: "0.048:0.2 ×1000 → 48:200"

FORMAT B — Divisor annotated between rows (÷N written on both sides or center):
  Example:
       210 : 60
    ÷60        ÷60
     =3.5 :  1
  Output as: "210:60 ÷60 → 3.5:1"

FORMAT C — Bracket with divisor outside (ratio in parentheses, ÷N after closing bracket):
  Example:
       260( 210 : 60 )÷60
            =3.5 : 1
  Output as: "210:60 ÷60 → 3.5:1"

Rules for all formats:
- Read BOTH rows completely, including the operator annotation (×N or ÷N) wherever it appears.
- The ÷N or ×N annotation IS part of the calculation — do NOT skip it even if small or at the edge.
- This two-row structure counts as valid 列式. Treat it the same as writing an explicit equation.
- The operator may appear as: "×1000", "÷60", "÷10", "×5", etc.

FORBIDDEN:
- Guessing or inferring what the student meant to write
- Outputting any answer for a question with an empty answer space
- Correcting student errors
- English descriptions

REQUIRED:
- Empty answer space → status="blank", studentAnswerRaw="未作答"
- Student wrote "A: 6.12 cm²" → output "A: 6.12 cm²", status="read"
- Single-choice: student marked "②" in answer blank → output "②", status="read"
${mapFillNote ? `
MAP-FILL RULE (地圖填圖題):
- For question IDs in MAP-FILL list, scan the ENTIRE image.
- Find ALL handwritten labels/text the student wrote on the map/diagram.
- For each label, describe its approximate position on the map AND the text written.
- Output format: "位置A: 泰國, 位置B: 越南, 位置C: 緬甸, ..." (use the position markers or spatial descriptions from the image).
- If the image has printed position markers (A, B, C, ①, ②, etc.), use those as position identifiers.
- If no printed markers, use spatial descriptions like "左上方", "中間偏右", "右下角".
- Include ALL student-written text, even if misspelled.
- status="read" if any handwritten text found, status="blank" if none.
` : ''}
${mapDrawIds.length > 0 ? `
MAP-DRAW RULES (繪圖/標記題):
Apply the rule that matches the question's sub-type listed above.

${mapDrawSymbolIds.length > 0 ? `MAP-DRAW (map_symbol) — for IDs ${JSON.stringify(mapDrawSymbolIds)}:
Describe the student's drawing with THREE parts:
  1. SYMBOL/SHAPE: What did the student draw? Name the symbol exactly (e.g., 颱風符號、箭頭向右、圓點、叉號).
  2. REFERENCE LINES: Read ALL printed reference lines and labels visible (e.g., 23.5°N、121°E、赤道). List them.
  3. POSITION: Describe where the drawing is relative to the printed reference lines:
     - If coordinate grid: "在[A]緯線以[南/北]、[B]經線以[東/西]" + grid cell (e.g., 右下格)
     - If numbered/labeled grid cells: "在第[N]格" or "在[標籤]格"
     - If near a specific intersection: "在[A]與[B]交點附近"
Output format: "[符號名稱]，位置：[精確位置描述含參考線]"
Example: "颱風符號，位置：23.5°N緯線以南、121°E經線以東的格子（右下格）"
If no student drawing found → status="blank"
` : ''}
${mapDrawGridIds.length > 0 ? `MAP-DRAW (grid_geometry) — for IDs ${JSON.stringify(mapDrawGridIds)}:
Describe the geometric shape the student drew on the grid paper:
  1. SHAPE: What shape did the student draw? (e.g., 正方形、三角形、長方形)
  2. SIZE: How many grid squares wide/tall? (e.g., 邊長3格、底3格高2格)
  3. POSITION: Where on the grid is the shape's top-left corner or reference point? (e.g., 從第2列第3格開始)
Output format: "圖形：[形狀]，大小：[尺寸描述]，位置：[起始位置]"
Example: "圖形：正方形，大小：邊長3格，位置：從第1列第2格開始"
If no student drawing found → status="blank"
` : ''}
${mapDrawConnectIds.length > 0 ? `MAP-DRAW (connect_dots) — for IDs ${JSON.stringify(mapDrawConnectIds)}:
Describe how the student connected the numbered dots:
  1. CONNECTION ORDER: List the order in which dots are connected (e.g., 1→2→3→4→1).
  2. RESULTING SHAPE: What shape is formed? (e.g., 三角形、Z字形、正方形)
Output format: "連線：[點的連接順序]，形成圖形：[形狀名稱]"
Example: "連線：1→2→3→4→5，形成圖形：Z字形"
If no student connection marks found → status="blank"
` : ''}
` : ''}
${diagramDrawNote ? `
DIAGRAM-DRAW RULE (塗色題):
For question IDs in DIAGRAM-DRAW list, describe ONLY fresh student coloring/shading marks on pre-printed figures.
- Report only what the student colored — do NOT describe uncolored regions unless needed for context.
- FIXED TEMPLATE: "塗色：[描述塗色範圍]"
  - For circles/fraction diagrams: describe which circles are fully/partially colored and what fraction.
    Example: "塗色：第1個圓完整，第2個圓左側2/3，第3個圓未塗"
  - For fraction bars/grids: describe how many cells are colored.
    Example: "塗色：10格中的7格（左側連續7格）"
  - For other shapes: describe the colored region using spatial words.
- If no fresh coloring marks → status="blank", studentAnswerRaw="未作答".
- FORBIDDEN: describing pre-printed outlines, grid lines, or labels as student marks.
` : ''}
${matchingIds.length > 0 ? `
MATCHING RULE (連連看):
For question IDs in MATCHING list, scan the ENTIRE matching section as ONE group.
- The section has a LEFT column (numbered items like (1)(2)(3)(4)) and a RIGHT column (text options).
- The student draws lines connecting left items to right items.
- For EACH left item, follow the drawn line and identify which right item it connects to.
- Output format per question ID: the text of the right-side item it connects to.
  Example: if (1) connects to "2公尺/秒", output for question "3-1" → studentAnswerRaw: "2公尺/秒"
- The question IDs in MATCHING list correspond to left items in order: first ID = (1), second ID = (2), etc.
- If a line is ambiguous or missing for an item → studentAnswerRaw: "未連線", status: "read"
- If NO lines drawn at all → status: "blank", studentAnswerRaw: "未作答"
- FORBIDDEN: outputting the left-side item text as the answer — only output the right-side item it connects to.
` : ''}

Return:
{
  "answers": [
    {
      "questionId": "string",
      "studentAnswerRaw": "exact text as written",
      "status": "read|blank|unreadable",
      "formatBReasoning": "only for FORMAT B questions: step-by-step spatial reasoning (omit for all other question types)"
    }
  ]
}
`.trim()
}

// ── AI2（全局派）：舊 ReRead，看全圖，同 Read1 prompt ──────────────────────
// Two independent calls, natural variance catches random errors.
function buildGlobalReadPrompt(classifyResult, options = {}) {
  return buildReadAnswerPrompt(classifyResult, options)
}

// Keep alias for backward compat
function buildReReadAnswerPrompt(classifyResult, options = {}) {
  return buildGlobalReadPrompt(classifyResult, options)
}

// ── AI1（細節派）：只看 answerBbox 裁切圖，不看全圖 ─────────────────────────
// The same question-type rules apply, but:
// - Images sent = one crop per question (NO full submission image)
// - AI1 CANNOT see question stems or surrounding context
// - Must apply blank-first strictly (crop may be the answer space only)
function buildDetailReadPrompt(classifyResult, options = {}) {
  const basePrompt = buildReadAnswerPrompt(classifyResult, options)
  return `IMPORTANT — DETAIL READ MODE (AI1):
You will see a series of CROPPED answer regions, one image per question.
Each crop is preceded by a label: "--- 題目 [ID]（類型：[type]）---"
You CANNOT see the full submission. You CANNOT see question stems or neighboring questions.

STRICT RULES FOR CROP-ONLY MODE:
- blank-first: If no fresh handwriting is visible in the crop → status='blank', studentAnswerRaw=''
- unreadable: If handwriting exists but is illegible → status='unreadable', studentAnswerRaw=''
- NEVER infer the answer from the question type or any context. Only read what is physically written.
- NEVER output an answer you did not physically see in the crop.

${basePrompt}`
}

// ── AI3（裁判）：比對 AI1/AI2，有依據地裁決 ─────────────────────────────────
// AI3 does NOT extract student answers. It only reviews AI1/AI2 readings and picks the better one,
// or declares needs_review if no evidence is found.
// finalAnswer in output must always be AI1's or AI2's value — never a new reading.
function buildArbiterPrompt(arbiterItems) {
  // arbiterItems: [{ questionId, questionType, ai1Answer, ai1Status, ai2Answer, ai2Status, agreementStatus }]
  const questionBlocks = arbiterItems.map((item) => {
    const ai1Str = item.ai1Status === 'blank' ? '（空白）' : item.ai1Status === 'unreadable' ? '（無法辨識）' : `「${item.ai1Answer}」`
    const ai2Str = item.ai2Status === 'blank' ? '（空白）' : item.ai2Status === 'unreadable' ? '（無法辨識）' : `「${item.ai2Answer}」`
    return `題目 ${item.questionId}（類型：${item.questionType}）
  AI1（細節）讀到：${ai1Str}（status: ${item.ai1Status}）
  AI2（全局）讀到：${ai2Str}（status: ${item.ai2Status}）
  初步比對：${item.agreementStatus === 'agree' ? 'agree（等價後相同）' : 'disagree（等價後不同）'}
  [此題裁切圖緊接在下方]`
  }).join('\n\n---\n\n')

  return `你是學生答案讀取的裁判 AI（AI3）。
你將看到：(1) 完整作業圖（第一張圖），(2) 每道題的 answerBbox 裁切圖（每題一張，附標籤），
以及 AI1（細節派，只看裁切圖）和 AI2（全局派，只看全圖）各自的讀取結果。

你的任務是【裁決】，不是重新讀取：
- 你不需要自行擷取學生答案。finalAnswer 只能從 AI1 或 AI2 的讀取值中擇一。
- 你的工作是：從全圖與裁切圖中找到具體筆跡特徵，作為裁決的依據（evidence）。

裁決規則：
若 agree（AI1 = AI2）：
  → 找出可見的具體筆跡特徵，確認兩者讀取有圖像依據
  → 若找到 → arbiterStatus="arbitrated_agree"，finalAnswer=任一共識值
  → 若找不到任何依據 → arbiterStatus="needs_review"

若 disagree（AI1 ≠ AI2）：
  → 找出圖像證據，判斷哪一方更接近實際筆跡
  → 若支持 AI1 → arbiterStatus="arbitrated_pick_1"，finalAnswer=AI1的值
  → 若支持 AI2 → arbiterStatus="arbitrated_pick_2"，finalAnswer=AI2的值
  → 若無法判斷 → arbiterStatus="needs_review"

⚠️ 必須在 evidence 中引用可見的具體筆跡特徵（位置、形狀、筆畫）。
⚠️ evidence 為空字串 → 必須輸出 arbiterStatus="needs_review"。
⚠️ finalAnswer 只能是 AI1 或 AI2 的原始讀取值，禁止自行填入新答案。
⚠️ agree 時：找到模糊特徵即可；disagree 時需嚴格舉證。

需裁決的題目如下（全圖在最前，各題裁切圖依序附在題目說明之後）：

${questionBlocks}

輸出 JSON，格式如下：
{
  "arbitrations": [
    {
      "questionId": "...",
      "arbiterStatus": "arbitrated_agree | arbitrated_pick_1 | arbitrated_pick_2 | needs_review",
      "finalAnswer": "...",
      "evidence": "（具體筆跡描述，agree 時找到依據即可，disagree 時需嚴格說明）",
      "confidence": "high | medium | low"
    }
  ]
}`.trim()
}

function buildAccessorPrompt(answerKey, readAnswerResult) {
  const strictness = answerKey?.strictness || 'standard'
  const strictnessRule =
    strictness === 'strict'
      ? 'GRADING STRICTNESS: STRICT — For objective categories (single_choice, true_false, fill_blank, fill_variants, single_check, multi_check, multi_choice), enforce exact correctness per category rules. For rubric categories (calculation, word_problem, short_answer, map_draw, diagram_draw), judge by rubric dimensions and mathematical/concept correctness; do NOT require literal format matching unless the category rule explicitly requires it.'
      : strictness === 'lenient'
        ? 'GRADING STRICTNESS: LENIENT — Accept the answer if the core meaning is correct, even if phrasing, word order, or minor formatting differ. However, unit substitution (e.g. 公尺 for 公分) is still wrong even in lenient mode for fill_blank and word_problem questions. Exception: unit pairs listed in the UNIT EQUIVALENCE TABLE below are always treated as identical.'
        : 'GRADING STRICTNESS: STANDARD — Accept minor variations (synonyms, commutative factor order, equivalent units per the UNIT EQUIVALENCE TABLE below) but reject wrong meaning, wrong numbers, wrong key terms, or different units.'

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

${strictnessRule}

AnswerKey:
${JSON.stringify(compactAnswerKey)}

Student answers:
${JSON.stringify(trimmedAnswers)}

UNIT EQUIVALENCE TABLE — these pairs are ALWAYS treated as identical regardless of strictness:
  【長度】 km = 公里   m = 公尺   cm = 公分   mm = 公釐
  【面積】 km² = 平方公里   m² = 平方公尺 = ㎡   cm² = 平方公分   mm² = 平方公釐
  【重量】 kg = 公斤   g = 公克   mg = 毫克
  【容積】 L = 公升   mL = ml = 毫升
  【時間】 h = hr = 小時   min = 分 = 分鐘   s = sec = 秒
  【速度】 km/h = 公里/小時 = 時速X公里   m/s = 公尺/秒   m/min = 公尺/分鐘   km/min = 公里/分鐘
  Note: "時速X公里" (e.g. 時速60公里) = "X km/h" = "X 公里/小時" — treat as identical.
  Note: Different units (e.g. 公尺 vs 公分, kg vs g) are still WRONG even if both appear in this table.

Rules:
- score must be 0..maxScore.
- If status is "blank" or "unreadable": score=0, isCorrect=false.
- studentFinalAnswer: extract the student's final answer from studentAnswerRaw if identifiable.
- errorType: calculation|copying|unit|concept|blank|unreadable|none.
- If question has orderMode="unordered" and shares unorderedGroupId with sibling questions:
  - evaluate as a bag (order-insensitive matching) within that group.

QUESTION CATEGORY RULES (apply based on questionCategory field in AnswerKey):
- single_choice / true_false / single_check: Compare student's selected option letter/symbol only. Ignore surrounding text. Case-insensitive. Binary right/wrong.
- fill_blank: Exact match required. UNIT RULE: if the correctAnswer contains a unit (e.g. "15 公分"), the student's unit must be identical OR an equivalent pair per the UNIT EQUIVALENCE TABLE above (e.g. "15 km" = "15 公里" ✓). Units NOT in the same equivalence pair are WRONG (errorType='unit'): 公尺 ≠ 公分, 公克 ≠ 公斤, m ≠ cm. Do NOT accept other unit substitutions regardless of strictness setting.
  DUAL-ANSWER RULE: if correctAnswer contains "/" (e.g. "彰/ㄓㄤ"), this is a 國字注音 question — student writes EITHER the character OR the phonetic. Accept if student answer matches EITHER side of the "/". Do NOT require both.
- fill_variants: Match any entry in acceptableAnswers[]. Answers not in the list are wrong.
- multi_check / multi_choice: The answer field contains comma-separated correct tokens (e.g. "①,③" or "A,C"). Parse BOTH student answer and correct answer as comma-separated token sets (order-insensitive).
  - correct = tokens in student ∩ answer_tokens
  - wrong = tokens in student − answer_tokens
  - score = max(0, round((|correct| − |wrong|) / |answer_tokens| × maxScore))
  - isCorrect = (score === maxScore)
  - errorType: if student has wrong extra tokens → 'concept'; if student missed tokens → 'concept'; if blank → 'blank'.
- word_problem: Grade using rubricsDimensions (列式計算 + 答句). SPLIT RULE: The line starting with "答：", "A:", or "Ans:" is the 答句 dimension; everything above that line is the 列式計算 dimension. If no such line exists, treat the entire answer as 列式計算 only (答句 = blank → 0 for that dimension). UNIT RULE: In the 答句 dimension, if the expected answer contains a unit, the student's unit must be identical OR an equivalent pair per the UNIT EQUIVALENCE TABLE above (e.g. "60 km/h" = "60 公里/小時" ✓). Wrong unit that is not an equivalent pair = that dimension loses points (errorType='unit').
- calculation: Grade using rubricsDimensions (算式過程 + 最終答案). SPLIT RULE: The last standalone "= X" result is the 最終答案; everything else (formula steps, intermediate results) is the 算式過程. HARD RULE: NEVER require an answer sentence prefix like "答：", "A:", or "Ans:" for calculation questions. NO unit checking for calculation questions — the student does NOT need to write units. For 算式過程: check if the formula/steps are mathematically valid. For 最終答案: check if the final numeric value matches referenceAnswer.
- short_answer: Grade by key concept presence using rubricsDimensions or rubric. No unit checking required.
- diagram_draw: studentAnswerRaw is a description of the student's coloring/drawing (e.g. "塗色：第1個圓完整，第2個圓的2/3（左側2格），第3個圓未塗"). referenceAnswer describes what should be colored. Grade using rubricsDimensions:
  - 塗色比例: compare the student's described colored proportion to the required fraction. Allow ±5% tolerance (e.g. 2/3 ≈ 0.667 ± 0.033). If proportion is correct → full marks for that dimension.
  - 塗色完整性: check if coloring is continuous and covers the correct regions without major gaps.
  - errorType: 'concept' if wrong proportion; 'blank' if no fresh marks described.
- matching: studentAnswerRaw is the right-side text the student connected to this left-side item (e.g. "2公尺/秒"). The AnswerKey answer field is the correct right-side text.
  - Compare case-insensitively, ignoring leading/trailing whitespace.
  - Allow equivalent unit representations (e.g. "km/h" = "公里/小時").
  - isCorrect = true if the student's text matches the answer (or an equivalent form).
  - score = maxScore if isCorrect, else 0 (binary scoring per pair).
  - errorType: 'concept' if wrong connection; 'blank' if "未連線" or "未作答".
- map_fill: See MAP-FILL SCORING below.
- map_draw: See MAP-DRAW SCORING below.
- (If questionCategory is absent, fall back to type-based rules: type=1 → exact match, type=2 → acceptableAnswers match, type=3 → rubric.)

- MAP-FILL SCORING (地圖填圖題): If the AnswerKey question has acceptableAnswers (list of correct names) AND a long referenceAnswer describing positions:
  - The student's answer contains position:name pairs (e.g. "位置A: 泰國, 位置B: 越南").
  - Compare each student-labeled position+name against the referenceAnswer's position→name mapping.
  - correctCount = number of positions where the student wrote the correct name.
  - score = Math.round(correctCount / totalPositions * maxScore).
  - isCorrect = (score === maxScore).
  - scoringReason MUST explain which positions the student answered incorrectly by describing the error pattern (e.g. "學生將位置C和位置D填反，其他位置正確"). Do NOT just say "X/Y correct". Describe WHAT went wrong so the teacher understands.
- MAP-DRAW SCORING (繪圖/標記題): The student's answer is a description of what was drawn and where (e.g. "颱風符號，位置：23.5°N緯線以南、121°E經線以東的格子（右下格）"). The referenceAnswer in the AnswerKey describes where the symbol SHOULD be placed.
  - Judge whether the drawn symbol is correct (right type of symbol).
  - Judge whether the position is correct by comparing the described location against the referenceAnswer's required coordinates/grid position.
  - A position is correct if the student placed it in the correct grid cell or within reasonable proximity of the required coordinate intersection.
  - scoringReason should clearly explain: what symbol was drawn, where it was placed, and whether the position matches the requirement.
- scoringReason must clearly explain WHY the answer is correct or incorrect. Write in Traditional Chinese.
  - For correct answers: briefly confirm (e.g. "答案完全正確").
  - For incorrect answers: describe the specific error pattern (e.g. "學生將九州寫成九洲，同音異字", "學生填寫的國名與實際位置不符").
  - NEVER just state a score count like "9/11 correct".
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

function buildConsistencyJudgePrompt(diffItems) {
  const items = diffItems.map((q) => ({
    questionId: q.questionId,
    read1: q.readAnswer1.studentAnswer,
    read2: q.readAnswer2.studentAnswer
  }))

  return `
You are a consistency judge. Two independent OCR readings of the same student handwritten answer are given.
Determine if they represent MEANINGFULLY DIFFERENT content, or just minor OCR/formatting variations.

IMPORTANT:
- "Truly different" means the MEANING or CONTENT differs (different words, numbers, names, or answers).
- "NOT truly different" means the differences are only in formatting, spacing, punctuation, character width (full/half), or trivial OCR noise.
- For map/diagram answers with multiple labels: compare the SET of position-to-name mappings. Minor formatting differences in positions or separators are NOT truly different.
- For checkbox/multi-choice answers: both reads now use fixed template tokens (第X個 / 左上格 / ① / A etc.). If one read uses a fixed token and the other uses option text content (a formula, phrase) that appears to describe the same box, mark as NOT truly different. If both use fixed tokens but they are different tokens (e.g. 第一個 vs 第三個), that IS truly different.
- For map-draw answers: both reads now use the fixed template "符號：[type]，位置：[token]". Compare symbol type AND position token. Minor wording differences in symbol name (e.g. 閃電 vs 閃電符號) are NOT truly different. Different position tokens (e.g. 左上格 vs 右下格) ARE truly different. One read blank and one read non-blank IS truly different.
- Examples of NOT truly different:
  - "\u6cf0\u570b" vs "\u6cf0\u570b " (trailing space)
  - "A:\u6cf0\u570b" vs "A: \u6cf0\u570b" (space after colon)
  - "\u7b54:15" vs "\u7b54: 15" (space)
  - "\u4f4d\u7f6eA:\u6cf0\u570b,\u4f4d\u7f6eB:\u8d8a\u5357" vs "\u4f4d\u7f6eA: \u6cf0\u570b, \u4f4d\u7f6eB: \u8d8a\u5357" (formatting)
- Examples of truly different:
  - "\u6cf0\u570b" vs "\u79e6\u570b" (different content)
  - "15" vs "16" (different number)
  - "\u8d8a\u5357" vs "\u8d8a\u96e3" (different character)
  - "\u4f4d\u7f6eA:\u6cf0\u570b" vs "\u4f4d\u7f6eA:\u8d8a\u5357" (different answer)

Questions to judge:
${JSON.stringify(items, null, 1)}

Return strict JSON only:
{
  "judgments": [
    { "questionId": "string", "trulyDifferent": true, "reason": "\u77ed\u539f\u56e0\uff08\u7e41\u9ad4\u4e2d\u6587\uff09" }
  ]
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
You are stage Explain. Your job is to write STUDENT-FACING correction guidance for each wrong question.
The student's homework image is attached. Use it actively.

AUDIENCE: Taiwan elementary school students (小學生). Use simple, everyday spoken Chinese — the kind a caring teacher would say face-to-face. Middle schoolers can read this too, so clarity matters more than difficulty level.

Domain: ${JSON.stringify(domainHint || null)}
Wrong question IDs to process: ${JSON.stringify(explainQuestionIds)}

AnswerKey (wrong questions only):
${JSON.stringify(wrongAnswerKey)}

Student answers (wrong questions only):
${JSON.stringify(wrongReadAnswers)}

Scoring analysis (wrong questions only) — use scoringReason as your primary basis:
${JSON.stringify(wrongScores)}

== STEP-BY-STEP for each wrong question ==
1. Find the question in the attached image by its ID or position number.
2. Read the ACTUAL question text from the image carefully.
3. Read the student's answer and the scoringReason to understand exactly what went wrong.
4. Write studentGuidance following the THREE-PART structure below.

== studentGuidance: THREE-PART STRUCTURE (follow this order every time) ==

Part 1 — 你錯在哪裡（What went wrong）
  - Name the question topic briefly using words from the actual question.
  - State the specific mistake in plain language a child can understand.
  - BAD: "三角形公式使用錯誤" ✗
  - GOOD: "這題要算三角形的面積，你用了底×高，但忘了最後要除以2。" ✓

Part 2 — 提醒一下（Key concept reminder）
  - Give a short, concrete reminder of the concept, rule, or formula the student needs — without revealing the answer.
  - BAD: "請複習梯形面積公式。" ✗
  - GOOD: "記得梯形面積的公式是：(上底＋下底)×高÷2，三個數字都要用到喔。" ✓

Part 3 — 再試試看（Thinking direction）
  - Give ONE specific question or action that points the student toward the correct approach.
  - Must be concrete, not vague.
  - BAD: "請再想想。" ✗
  - GOOD: "再看一次題目，『高』是哪條線段？把它找出來再算算看。" ✓

== STRICTLY ENFORCED RULES ==
- Write entirely in Traditional Chinese (繁體中文).
- ABSOLUTELY FORBIDDEN: "正確答案是", "應為", "答案是", "正確的是", or any phrase that directly states the correct answer.
- Total length: 3–5 sentences. Warm and encouraging in tone.
- SPECIAL RULE — unreadable answer: If studentAnswer has status "unreadable", studentGuidance MUST start with "老師無法辨識你的字跡，" and kindly ask the student to write more clearly. Do NOT mention the correct answer. Set mistakeType to "unreadable".

== OTHER FIELDS ==
- mistakeType / mistakeTypeCodes: classify the mistake type.
- weaknesses: weak areas identified (for teacher analytics only, not shown to student).
- suggestions: remediation suggestions (for teacher analytics only, not shown to student).

Return strict JSON only. No markdown.

Output:
{
  "details": [
    {
      "questionId": "string",
      "studentGuidance": "引導語（三段式：指出具體錯誤→概念提醒→思考方向）",
      "mistakeType": "concept|calculation|condition|blank|unreadable",
      "mistakeTypeCodes": ["calculation", "unit"]
    }
  ],
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

  for (const question of keyQuestions) {
    const questionId = ensureString(question?.id).trim()
    if (!questionId) continue

    const answer = answerById.get(questionId)
    const score = scoreById.get(questionId)
    const explain = explainById.get(questionId)
    const classify = classifyById.get(questionId)
    const locate = locateById.get(questionId)
    const consistency = consistencyById?.get(questionId)

    const hasMismatch = answer?.calculationAnswerMismatch === true
    const row = {
      questionId,
      detectedType: toFiniteNumber(question?.type) ?? undefined,
      studentAnswer: ensureString(answer?.studentAnswerRaw, '無法辨識'),
      isCorrect: hasMismatch ? false : score?.isCorrect === true,
      score: hasMismatch ? 0 : toFiniteNumber(score?.score) ?? 0,
      maxScore: toFiniteNumber(score?.maxScore) ?? Math.max(0, toFiniteNumber(question?.maxScore) ?? 0),
      reason:
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
    if (explain?.studentGuidance) row.studentGuidance = explain.studentGuidance

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
  totalScore = parseFloat(totalScore.toFixed(1))

  const gradedMistakes =
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

  const unansweredMistakes = details
    .filter((item) => item.studentAnswer === '未作答')
    .map((item) => ({
      id: item.questionId,
      question: `題目 ${item.questionId}`,
      reason: '此題未作答，請補寫作答',
      errorType: 'unanswered'
    }))

  const mistakes = [...gradedMistakes, ...unansweredMistakes]

  const reviewReasons = []
  if (stageMeta.classify.coverage < 1) {
    const missing = keyQuestions.length - Math.round(stageMeta.classify.coverage * keyQuestions.length)
    reviewReasons.push(`有 ${missing} 題未被辨識到，可能漏批`)
  }
  // stageWarnings 僅記錄於 log，不推送給老師

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
  const pageBreaks = Array.isArray(payload?.pageBreaks) ? payload.pageBreaks : []
  const classifyQuestionSpecs = buildClassifyQuestionSpecs(questionIds, answerKeyQuestions)
  const classifyPrompt = buildClassifyPrompt(questionIds, classifyQuestionSpecs, pageBreaks)
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
  const classifyResult = applyClassifyQuestionSpecs(
    normalizeClassifyResult(classifyParsed, questionIds),
    classifyQuestionSpecs
  )
  const classifyAligned = classifyResult.alignedQuestions
  logStaged(pipelineRunId, stagedLogLevel, 'classify normalized-summary', {
    coverage: classifyResult.coverage,
    visibleCount: classifyAligned.filter((q) => q.visible).length,
    bboxCount: classifyAligned.filter((q) => q.answerBbox).length
  })

  const wordProblemIds = classifyAligned
    .filter((q) => q.visible && q.questionType === 'word_problem')
    .map((q) => q.questionId)

  const calculationIds = classifyAligned
    .filter((q) => q.visible && q.questionType === 'calculation')
    .map((q) => q.questionId)

  // Focused checkbox crops: single_check / multi_check / multi_choice
  // We pre-crop first, then exclude successful IDs from full-image ReadAnswer.
  const focusedCheckboxCandidates = classifyAligned.filter(
    (q) => q.visible && CHECKBOX_FOCUSED_READ_TYPES.has(q.questionType) && q.answerBbox
  )
  const focusedCheckboxCropMap = new Map()
  if (focusedCheckboxCandidates.length > 0 && inlineImages.length > 0) {
    const inlineImage = inlineImages[0]
    const cropResults = await Promise.all(
      focusedCheckboxCandidates.map(async (q) => {
        const cropData = await cropInlineImageByBbox(
          inlineImage.inlineData.data,
          inlineImage.inlineData.mimeType,
          q.answerBbox,
          true
        )
        return { questionId: q.questionId, cropData }
      })
    )
    for (const { questionId, cropData } of cropResults) {
      if (cropData) focusedCheckboxCropMap.set(questionId, cropData)
    }
    logStaged(pipelineRunId, stagedLogLevel, 'focused-checkbox crop prepare', {
      candidateCount: focusedCheckboxCandidates.length,
      preparedCount: focusedCheckboxCropMap.size
    })
  }
  const focusedCheckboxQuestionIds = Array.from(focusedCheckboxCropMap.keys())

  // ── Pre-AI1: Crop ALL visible non-checkbox questions with answerBbox ─────────
  // These crops are used by AI1 (detail read) and later for teacher review.
  const allQuestionCropMap = new Map()  // questionId → { data, mimeType }
  const ai1CropCandidates = classifyAligned.filter(
    (q) => q.visible && q.answerBbox && q.questionType !== 'map_fill'
      && !focusedCheckboxCropMap.has(q.questionId)  // exclude already-cropped checkbox questions
  )
  if (ai1CropCandidates.length > 0 && inlineImages.length > 0) {
    const inlineImage = inlineImages[0]
    const cropResults = await Promise.all(
      ai1CropCandidates.map(async (q) => {
        const cropData = await cropInlineImageByBbox(
          inlineImage.inlineData.data,
          inlineImage.inlineData.mimeType,
          q.answerBbox,
          true
        )
        return { questionId: q.questionId, cropData }
      })
    )
    for (const { questionId, cropData } of cropResults) {
      if (cropData) allQuestionCropMap.set(questionId, cropData)
    }
    logStaged(pipelineRunId, stagedLogLevel, 'AI1 crop-all-questions', {
      candidates: ai1CropCandidates.length,
      succeeded: allQuestionCropMap.size
    })
  }
  // Merge: checkbox crops also available for AI3 evidence
  for (const [qId, cropData] of focusedCheckboxCropMap) {
    allQuestionCropMap.set(qId, cropData)
  }

  // Build AI1 parts: text prompt + interleaved (label + crop) per question
  const ai1IncludeIds = Array.from(allQuestionCropMap.keys())
  const ai1TextPrompt = buildDetailReadPrompt(classifyResult, {
    includeQuestionIds: ai1IncludeIds.length > 0 ? ai1IncludeIds : undefined
  })
  const ai1Parts = [{ text: ai1TextPrompt }]
  for (const q of classifyAligned) {
    if (!q.visible) continue
    const crop = allQuestionCropMap.get(q.questionId)
    if (!crop) continue
    ai1Parts.push({ text: `--- 題目 ${q.questionId}（類型：${q.questionType}）---` })
    ai1Parts.push({ inlineData: crop })
  }

  // ── A3(AI1) + A4(AI2): Detail read (crop-only) + Global read (full image) IN PARALLEL ──
  const globalReadPrompt = buildGlobalReadPrompt(classifyResult, {
    excludeQuestionIds: focusedCheckboxQuestionIds
  })
  logStaged(pipelineRunId, stagedLogLevel, '3-AI read mode', {
    ai1CropCount: ai1IncludeIds.length,
    ai2excludedCheckboxCount: focusedCheckboxQuestionIds.length
  })
  const parallelCalls = [
    // AI1: detail read (crop images only, no full submission image)
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_DETAIL_READ,
      stageContents: [{ role: 'user', parts: ai1Parts }]
    }),
    // AI2: global read (full image, same role as original ReRead)
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER,
      stageContents: [{ role: 'user', parts: [{ text: globalReadPrompt }, ...submissionImageParts] }]
    })
  ]
  let finalAnswerOnlyIdx = -1
  let calcFinalAnswerIdx = -1
  if (wordProblemIds.length > 0) {
    finalAnswerOnlyIdx = parallelCalls.length
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
  if (calculationIds.length > 0) {
    calcFinalAnswerIdx = parallelCalls.length
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
            parts: [{ text: buildCalculationFinalAnswerPrompt(calculationIds) }, ...submissionImageParts]
          }
        ]
      })
    )
  }
  logStageStart(pipelineRunId, 'ReadAnswer+reReadAnswer')
  const parallelResults = await Promise.all(parallelCalls)
  const readAnswerResponse = parallelResults[0]
  const reReadAnswerResponse = parallelResults[1]
  const finalAnswerOnlyResponse = finalAnswerOnlyIdx >= 0 ? parallelResults[finalAnswerOnlyIdx] : null
  const calcFinalAnswerResponse = calcFinalAnswerIdx >= 0 ? parallelResults[calcFinalAnswerIdx] : null
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
  let readAnswerParsed = parseCandidateJson(readAnswerResponse.data)
  if (!readAnswerParsed || typeof readAnswerParsed !== 'object') {
    throw new Error('PhaseA read_answer parse failed')
  }
  let reReadAnswerParsed = reReadAnswerResponse?.ok
    ? parseCandidateJson(reReadAnswerResponse.data)
    : null

  // Log per-question read results for debugging
  const readAnswerLogMode = getReadAnswerLogMode()
  if (readAnswerLogMode !== 'off') {
    logStaged(pipelineRunId, 'basic', 'ReadAnswer per-question', toReadAnswerSchemaPreview(readAnswerParsed))
    logStaged(pipelineRunId, 'basic', 'reReadAnswer per-question', toReadAnswerSchemaPreview(reReadAnswerParsed))
  }

  // ── A3b: Focused bracket read for single_choice questions (crop-based, context-free) ──
  const bracketQuestions = classifyAligned.filter(
    (q) => q.visible && q.questionType === 'single_choice' && q.bracketBbox
  )
  if (bracketQuestions.length > 0) {
    const inlineImage = inlineImages[0]
    logStaged(pipelineRunId, 'basic', 'bracket-read begin', { count: bracketQuestions.length })
    const bracketReadResults = await Promise.all(
      bracketQuestions.map(async (q) => {
        const croppedData = await cropInlineImageByBbox(
          inlineImage.inlineData.data,
          inlineImage.inlineData.mimeType,
          q.bracketBbox,
          true // useActualBbox: tight crop
        )
        if (!croppedData) {
          logStaged(pipelineRunId, 'basic', `bracket-read crop-failed qid=${q.questionId}`)
          return null
        }
        const focusedPrompt = buildFocusedBracketReadPrompt(q.questionId)
        const bracketResponse = await executeStage({
          apiKey,
          model,
          payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
          timeoutMs: getRemainingBudget(),
          routeHint,
          routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
          stageContents: [{ role: 'user', parts: [{ text: focusedPrompt }, { inlineData: croppedData }] }]
        })
        if (!bracketResponse.ok) {
          logStaged(pipelineRunId, 'basic', `bracket-read failed qid=${q.questionId}`)
          return null
        }
        const parsed = parseCandidateJson(bracketResponse.data)
        const answer = Array.isArray(parsed?.answers) ? parsed.answers[0] : null
        if (answer) {
          logStaged(pipelineRunId, 'basic', `bracket-read result qid=${q.questionId}`, {
            studentAnswerRaw: answer.studentAnswerRaw,
            status: answer.status,
            formatBReasoning: answer.formatBReasoning
          })
        }
        return answer ? { questionId: q.questionId, answer } : null
      })
    )

    // Override full-image ReadAnswer results with bracket-crop results
    const overrideMap = new Map()
    for (const result of bracketReadResults) {
      if (result) overrideMap.set(result.questionId, result.answer)
    }
    if (overrideMap.size > 0) {
      readAnswerParsed = applyAnswerOverrides(readAnswerParsed, overrideMap)
      if (reReadAnswerParsed && typeof reReadAnswerParsed === 'object') {
        reReadAnswerParsed = applyAnswerOverrides(reReadAnswerParsed, overrideMap)
      }
      logStaged(pipelineRunId, 'basic', 'bracket-read overrides applied', { count: overrideMap.size })
    }
  }

  // ── A3c: Focused checkbox read (crop-based, context-reduced) ───────────────
  if (focusedCheckboxCropMap.size > 0) {
    logStaged(pipelineRunId, 'basic', 'focused-checkbox-read begin', {
      count: focusedCheckboxCropMap.size
    })
    const classifyByQuestionId = mapByQuestionId(classifyAligned, (item) => item?.questionId)
    const focusedReadResults = await Promise.all(
      Array.from(focusedCheckboxCropMap.entries()).map(async ([questionId, cropData]) => {
        const classifyRow = classifyByQuestionId.get(questionId)
        const questionType = ensureString(classifyRow?.questionType, '').trim().toLowerCase()
        const focusedPrompt = buildFocusedCheckboxReadPrompt(questionId, questionType)
        const focusedResponse = await executeStage({
          apiKey,
          model,
          payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
          timeoutMs: getRemainingBudget(),
          routeHint,
          routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
          stageContents: [{ role: 'user', parts: [{ text: focusedPrompt }, { inlineData: cropData }] }]
        })
        if (!focusedResponse.ok) {
          logStaged(pipelineRunId, 'basic', `focused-checkbox-read failed qid=${questionId}`)
          return null
        }

        const parsed = parseCandidateJson(focusedResponse.data)
        const answer = Array.isArray(parsed?.answers) ? parsed.answers[0] : null
        if (answer) {
          logStaged(pipelineRunId, 'basic', `focused-checkbox-read result qid=${questionId}`, {
            questionType,
            studentAnswerRaw: answer.studentAnswerRaw,
            status: answer.status
          })
        }
        return answer ? { questionId, answer } : null
      })
    )

    const overrideMap = new Map()
    for (const result of focusedReadResults) {
      if (result) overrideMap.set(result.questionId, result.answer)
    }

    if (overrideMap.size > 0) {
      readAnswerParsed = applyAnswerOverrides(readAnswerParsed, overrideMap)
      if (reReadAnswerParsed && typeof reReadAnswerParsed === 'object') {
        reReadAnswerParsed = applyAnswerOverrides(reReadAnswerParsed, overrideMap)
      }
      logStaged(pipelineRunId, 'basic', 'focused-checkbox-read overrides applied', {
        count: overrideMap.size
      })
    }

    const missingFocusedIds = focusedCheckboxQuestionIds.filter((questionId) => !overrideMap.has(questionId))
    if (missingFocusedIds.length > 0) {
      logStaged(pipelineRunId, stagedLogLevel, 'focused-checkbox-read fallback to full-image', {
        missingCount: missingFocusedIds.length,
        questionIds: missingFocusedIds
      })
      const fallbackPrompt = buildReadAnswerPrompt(classifyResult, {
        includeQuestionIds: missingFocusedIds
      })
      const fallbackResponse = await executeStage({
        apiKey,
        model,
        payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
        timeoutMs: getRemainingBudget(),
        routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
        stageContents: [{ role: 'user', parts: [{ text: fallbackPrompt }, ...submissionImageParts] }]
      })
      if (fallbackResponse.ok) {
        const fallbackParsed = parseCandidateJson(fallbackResponse.data)
        const fallbackAnswers = Array.isArray(fallbackParsed?.answers) ? fallbackParsed.answers : []
        const fallbackOverrideMap = new Map()
        for (const row of fallbackAnswers) {
          const qId = ensureString(row?.questionId, '').trim()
          if (qId && missingFocusedIds.includes(qId)) {
            fallbackOverrideMap.set(qId, row)
          }
        }
        if (fallbackOverrideMap.size > 0) {
          readAnswerParsed = applyAnswerOverrides(readAnswerParsed, fallbackOverrideMap)
          if (reReadAnswerParsed && typeof reReadAnswerParsed === 'object') {
            reReadAnswerParsed = applyAnswerOverrides(reReadAnswerParsed, fallbackOverrideMap)
          }
          for (const qId of fallbackOverrideMap.keys()) {
            overrideMap.set(qId, fallbackOverrideMap.get(qId))
          }
          logStaged(pipelineRunId, stagedLogLevel, 'focused-checkbox-read fallback overrides applied', {
            count: fallbackOverrideMap.size
          })
        }
      }

      // If still unresolved after focused + fallback, force unreadable to avoid false stable.
      const unresolvedIds = focusedCheckboxQuestionIds.filter((questionId) => !overrideMap.has(questionId))
      if (unresolvedIds.length > 0) {
        const unresolvedOverrideMap = new Map(
          unresolvedIds.map((questionId) => [
            questionId,
            { questionId, status: 'unreadable', studentAnswerRaw: '無法辨識' }
          ])
        )
        readAnswerParsed = applyAnswerOverrides(readAnswerParsed, unresolvedOverrideMap)
        if (reReadAnswerParsed && typeof reReadAnswerParsed === 'object') {
          reReadAnswerParsed = applyAnswerOverrides(reReadAnswerParsed, unresolvedOverrideMap)
        }
        logStaged(pipelineRunId, stagedLogLevel, 'focused-checkbox-read unresolved forced-unreadable', {
          count: unresolvedIds.length,
          questionIds: unresolvedIds
        })
      }
    }
  }

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

  // Mismatch detection for calculation questions (A3 last-= result vs calcFinalAnswer)
  if (calculationIds.length > 0 && calcFinalAnswerResponse?.ok) {
    const calcFinalParsed = parseCandidateJson(calcFinalAnswerResponse.data)
    if (calcFinalParsed && typeof calcFinalParsed === 'object') {
      const calcFinalById = mapByQuestionId(
        Array.isArray(calcFinalParsed.answers) ? calcFinalParsed.answers : [],
        (item) => item?.questionId
      )
      const mainById = mapByQuestionId(
        Array.isArray(readAnswerParsed?.answers) ? readAnswerParsed.answers : [],
        (item) => item?.questionId
      )
      for (const questionId of calculationIds) {
        const mainRow = mainById.get(questionId)
        const calcFinalRow = calcFinalById.get(questionId)
        if (!mainRow || !calcFinalRow) continue
        if (calcFinalRow.status === 'blank' || calcFinalRow.status === 'unreadable') continue
        const calcResult = extractLastEquationResult(ensureString(mainRow.studentAnswerRaw, ''))
        const finalNum = ensureString(calcFinalRow.studentAnswerRaw, '').replace(/,/g, '').trim()
        if (calcResult && finalNum && calcResult !== finalNum) {
          // Retry once with a fresh calculation final-answer read to confirm mismatch
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
                  { text: buildCalculationFinalAnswerPrompt([questionId]) },
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
              ? ensureString(retryRow.studentAnswerRaw, '').replace(/,/g, '').trim()
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

  // ── A5: CONSISTENCY CHECK (pure logic, no crops yet) ─────────────────────
  const read1ById = mapByQuestionId(readAnswerResult.answers, (item) => item?.questionId)
  const read2ById = mapByQuestionId(reReadAnswerResult.answers, (item) => item?.questionId)

  const questionResultsRaw = questionIds.map((questionId) => {
    const read1 = read1ById.get(questionId)
    const read2 = read2ById.get(questionId)
    const classifyRow = classifyAligned.find((q) => q.questionId === questionId)
    const consistencyStatus =
      read1 && read2
        ? computeConsistencyStatus(read1, read2, classifyRow?.questionType ?? 'other')
        : 'unstable'
    return {
      questionId,
      consistencyStatus,
      consistencyReason: undefined,
      questionType: classifyRow?.questionType ?? 'other',
      readAnswer1: {
        status: read1?.status ?? 'unreadable',
        studentAnswer: read1?.studentAnswerRaw ?? '無法辨識'
      },
      readAnswer2: {
        status: read2?.status ?? 'unreadable',
        studentAnswer: read2?.studentAnswerRaw ?? '無法辨識'
      },
      answerBbox: classifyRow?.answerBbox ?? null,
      calculationAnswerMismatch: read1?.calculationAnswerMismatch === true
    }
  })

  // ── Attach crop image URLs for teacher review (uses allQuestionCropMap from pre-AI1 step) ──
  // Priority: per-question crop (allQuestionCropMap) → full image fallback (map_fill, no bbox, etc.)
  const cropByQuestionId = allQuestionCropMap  // alias for internal _internal reference
  const fullImageDataUrl = inlineImages.length > 0
    ? `data:${inlineImages[0].inlineData.mimeType};base64,${inlineImages[0].inlineData.data}`
    : undefined

  // ── AI3 Arbiter (serial): compare AI1/AI2 results and make evidence-based decision ──
  // Filter: skip questions where both AI1 and AI2 are blank (auto agree) or both unreadable (auto needs_review)
  const arbiterItems = questionResultsRaw
    .filter((qr) => {
      const s1 = qr.readAnswer1.status
      const s2 = qr.readAnswer2.status
      if (s1 === 'blank' && s2 === 'blank') return false
      if (s1 === 'unreadable' && s2 === 'unreadable') return false
      return true
    })
    .map((qr) => ({
      questionId: qr.questionId,
      questionType: qr.questionType,
      ai1Answer: qr.readAnswer1.studentAnswer,
      ai1Status: qr.readAnswer1.status,
      ai2Answer: qr.readAnswer2.studentAnswer,
      ai2Status: qr.readAnswer2.status,
      agreementStatus: qr.consistencyStatus === 'stable' ? 'agree' : 'disagree'
    }))

  const arbiterByQuestionId = new Map()
  if (arbiterItems.length > 0) {
    try {
      // Build AI3 parts: text prompt + full image + interleaved (label + crop) per question
      const arbiterPromptText = buildArbiterPrompt(arbiterItems)
      const arbiterParts = [{ text: arbiterPromptText }, ...submissionImageParts]
      for (const item of arbiterItems) {
        const crop = allQuestionCropMap.get(item.questionId)
        if (crop) {
          arbiterParts.push({ text: `--- 題目 ${item.questionId} 裁切圖 ---` })
          arbiterParts.push({ inlineData: crop })
        }
      }
      logStageStart(pipelineRunId, 'AI3-arbiter')
      const arbiterResponse = await executeStage({
        apiKey,
        model,
        payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
        timeoutMs: getRemainingBudget(),
        routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_ARBITER,
        stageContents: [{ role: 'user', parts: arbiterParts }]
      })
      logStageEnd(pipelineRunId, 'AI3-arbiter', arbiterResponse)
      stageResponses.push(arbiterResponse)
      if (arbiterResponse.ok) {
        const arbiterParsed = parseCandidateJson(arbiterResponse.data)
        const arbitrations = Array.isArray(arbiterParsed?.arbitrations) ? arbiterParsed.arbitrations : []
        for (const a of arbitrations) {
          const qId = ensureString(a?.questionId).trim()
          if (!qId) continue
          let arbStatus = ensureString(a?.arbiterStatus, 'needs_review')
          const evidence = ensureString(a?.evidence, '').trim()
          // Enforce: empty evidence → needs_review
          if (!evidence && arbStatus !== 'needs_review') arbStatus = 'needs_review'
          // Enforce: finalAnswer must be AI1 or AI2 value
          const item = arbiterItems.find((i) => i.questionId === qId)
          let finalAnswer = ensureString(a?.finalAnswer, '')
          if (item && arbStatus !== 'needs_review') {
            if (finalAnswer !== item.ai1Answer && finalAnswer !== item.ai2Answer) {
              // AI3 produced a new reading — correct to the side it claimed to support
              if (arbStatus === 'arbitrated_pick_1') finalAnswer = item.ai1Answer
              else if (arbStatus === 'arbitrated_pick_2') finalAnswer = item.ai2Answer
              else finalAnswer = item.ai1Answer  // agree → use AI1
              stageWarnings.push(`[AI3] qId=${qId} finalAnswer was not AI1/AI2 value, corrected to ${finalAnswer}`)
            }
          }
          arbiterByQuestionId.set(qId, {
            arbiterStatus: arbStatus,
            finalAnswer: arbStatus === 'needs_review' ? undefined : finalAnswer,
            evidence: evidence.slice(0, 500),
            confidence: ensureString(a?.confidence, 'low')
          })
        }
        logStaged(pipelineRunId, stagedLogLevel, 'AI3 arbiter summary', {
          sent: arbiterItems.length,
          received: arbitrations.length,
          arbitrated_agree: Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus === 'arbitrated_agree').length,
          arbitrated_pick: Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus?.startsWith('arbitrated_pick')).length,
          needs_review: Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus === 'needs_review').length
        })
      }
    } catch (arbiterErr) {
      logStaged(pipelineRunId, stagedLogLevel, 'AI3 arbiter failed (fallback to consistency status)', {
        error: arbiterErr?.message
      })
    }
  }

  // Build final questionResults with arbiterResult attached
  const questionResults = questionResultsRaw.map((qr) => {
    const arbiterResult = arbiterByQuestionId.get(qr.questionId) ?? (() => {
      // Auto-determine for questions not processed by AI3
      const s1 = qr.readAnswer1.status
      const s2 = qr.readAnswer2.status
      if (s1 === 'blank' && s2 === 'blank') {
        return { arbiterStatus: 'arbitrated_agree', finalAnswer: '', evidence: '兩者皆空白', confidence: 'high' }
      }
      if (s1 === 'unreadable' && s2 === 'unreadable') {
        return { arbiterStatus: 'needs_review', finalAnswer: undefined, evidence: '兩者皆無法辨識', confidence: 'low' }
      }
      // AI3 didn't return this question (failed or missing) → fall back to consistency status
      return qr.consistencyStatus === 'stable'
        ? { arbiterStatus: 'arbitrated_agree', finalAnswer: qr.readAnswer1.studentAnswer, evidence: 'AI3 未回傳，沿用一致性判斷', confidence: 'low' }
        : { arbiterStatus: 'needs_review', finalAnswer: undefined, evidence: 'AI3 未回傳，需人工審查', confidence: 'low' }
    })()

    // Attach crop image URL only for needs_review questions (for teacher review UI)
    const isNeedsReview = arbiterResult.arbiterStatus === 'needs_review'
    const cropData = allQuestionCropMap.get(qr.questionId)
    let answerCropImageUrl
    if (isNeedsReview) {
      if (cropData) {
        answerCropImageUrl = `data:${cropData.mimeType};base64,${cropData.data}`
      } else if (fullImageDataUrl) {
        answerCropImageUrl = fullImageDataUrl  // fallback for map_fill, no-bbox questions
      }
    }
    return { ...qr, arbiterResult, answerCropImageUrl, hasCropImage: !!cropData }
  })

  const stableCount = questionResults.filter((q) => q.arbiterResult?.arbiterStatus !== 'needs_review').length
  const diffCount = 0  // no longer used (legacy compat: kept at 0)
  const unstableCount = questionResults.filter((q) => q.arbiterResult?.arbiterStatus === 'needs_review').length
  logStaged(pipelineRunId, stagedLogLevel, 'PhaseA 3-AI summary', {
    arbitratedCount: stableCount,
    needsReviewCount: unstableCount
  })

  return {
    phaseAComplete: true,
    questionResults,
    stableCount,
    diffCount,
    unstableCount,
    needsReviewCount: unstableCount,
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

  // ── B3: LOCATE (only wrong questions — for student correction preview) ──────
  const wrongQuestionIds = accessorScores
    .filter((s) => s?.isCorrect !== true)
    .map((s) => ensureString(s?.questionId).trim())
    .filter(Boolean)

  let locateResult = { locatedQuestions: [] }
  if (wrongQuestionIds.length > 0) {
    const locatePrompt = buildLocatePrompt(wrongQuestionIds)
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
    if (locateResponse.ok) {
      if (locateResponse.warnings.length > 0) {
        stageWarnings.push(...locateResponse.warnings.map((w) => `[locate] ${w}`))
      }
      const locateParsed = parseCandidateJson(locateResponse.data)
      if (locateParsed && typeof locateParsed === 'object') {
        locateResult = normalizeLocateResult(locateParsed, wrongQuestionIds)
      }
    } else {
      stageWarnings.push(`[locate] status=${locateResponse.status}`)
    }
  } else {
    logStaged(pipelineRunId, stagedLogLevel, 'skip stage=locate reason=no_wrong_questions')
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
      locate: locateResult
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

// ─────────────────────────────────────────────────────────────────────────────
// Recheck Agent: 逐題訂正檢查（一題一張照片，單次 AI call）
// ─────────────────────────────────────────────────────────────────────────────

function buildRecheckPrompt(itemsWithAnswers, imageMapping) {
  return `You are the Recheck Agent. The student submitted one correction photo per wrong question.
Check each answer and decide if it is now correct.

Image mapping (in order, match by index):
${imageMapping}

Wrong questions context (JSON):
${JSON.stringify(itemsWithAnswers, null, 2)}

UNIT EQUIVALENCE TABLE — these pairs are ALWAYS treated as identical:
  【長度】 km = 公里   m = 公尺   cm = 公分   mm = 公釐
  【面積】 km² = 平方公里   m² = 平方公尺 = ㎡   cm² = 平方公分   mm² = 平方公釐
  【重量】 kg = 公斤   g = 公克   mg = 毫克
  【容積】 L = 公升   mL = ml = 毫升
  【時間】 h = hr = 小時   min = 分 = 分鐘   s = sec = 秒
  【速度】 km/h = 公里/小時 = 時速X公里   m/s = 公尺/秒   m/min = 公尺/分鐘   km/min = 公里/分鐘
  Note: "時速X公里" (e.g. 時速60公里) = "X km/h" = "X 公里/小時" — treat as identical.
  Note: Different units (e.g. 公尺 vs 公分, kg vs g) are still WRONG even if both appear in this table.

GRADING RULES per questionCategory ("questionCategory" is authoritative. Only fall back to "type" when questionCategory is empty):
- single_choice / true_false / fill_blank: student answer must match correctAnswer. Minor spacing/punctuation differences are OK.
  - fill_blank UNIT RULE: if correctAnswer contains a unit (e.g. "15 公分"), the student's unit must match exactly OR be an equivalent pair per the UNIT EQUIVALENCE TABLE above (e.g. "15 km" = "15 公里" ✓). Units not in the same equivalence pair (e.g. 公尺 ≠ 公分) → not passed.
  - fill_blank DUAL-ANSWER RULE: if correctAnswer contains "/" (e.g. "彰/ㄓㄤ"), this is a 國字注音 question — student writes EITHER the character OR the phonetic. Accept if student answer matches EITHER side of the "/". Do NOT require both.
- fill_variants / map_fill: student answer must match ANY entry in acceptableAnswers[]. If acceptableAnswers is empty, fall back to correctAnswer.
- word_problem: This is a correction submission.
    * Check BOTH: (1) a calculation formula/process is present, AND (2) an answer sentence starts with "答：" or "A：" and contains a number+unit (or full text answer).
    * UNIT RULE: if the expected answer has a unit, the student's unit must match OR be an equivalent pair per the UNIT EQUIVALENCE TABLE above (e.g. "60 km/h" = "60 公里/小時" ✓). Wrong unit that is not an equivalent pair → not passed.
    * Must show the student understood the mistake and corrected it meaningfully.
- calculation: This is a correction submission.
    * Check BOTH: (1) the student shows corrected formula/process or meaningful recalculation, AND (2) final numeric result is correct.
    * HARD RULE: NEVER require "答：" / "A：" / "Ans:" format for calculation.
    * If the student writes extra intermediate steps, do not fail only because of extra steps; focus on correctness.
- short_answer / map_draw: This is a correction submission.
    * Judge based on referenceAnswer and whether the student demonstrates genuine understanding of the concept.
    * The answer does not need to be perfect, but must show the student understood their mistake and addressed it meaningfully.
    * Do NOT pass if the answer is essentially unchanged from the mistake described in mistakeReason.

TYPE FALLBACK (only when questionCategory is missing/empty):
- type=1 → treat as single_choice/true_false/fill_blank exact-answer mode.
- type=2 → treat as fill_variants/map_fill acceptableAnswers mode.
- type=3:
    * if rubricsDimensions contains a dimension named "答句" → treat as word_problem.
    * else if rubricsDimensions contains "算式過程" or "最終答案" → treat as calculation.
    * else → treat as short_answer.

INSERTION MARK (插入符號 ∧ or 入-shape):
If the student uses a handwritten ∧ or 入-shaped symbol to indicate a text insertion:
- The tip of the symbol points to the insertion position in the original text.
- The inserted text is written above the symbol.
- Merge the inserted text into the original sentence at exactly that position.
- Output the COMPLETE merged result as if the insertion was always there. Do NOT mention the symbol.
- Follow the student's intent faithfully even if the merged result sounds grammatically odd.
- Example: student wrote "速率為60∧" with "公尺" above → read as "速率為60公尺"

Instructions for each question:
1. Find the corresponding image using the mapping above.
2. Carefully read the student's new answer from that image (apply INSERTION MARK rule if present).
3. Apply the grading rule for that question's type.
4. If passed=false, write both reason and newGuidance:
   - reason: short why the correction is still not acceptable.
   - newGuidance: a NEW hint different from hintGiven. Approach from a different angle.

STRICT RULES for newGuidance:
- Traditional Chinese (繁體中文) only.
- ABSOLUTELY FORBIDDEN to reveal the correct answer in any form (no "正確答案是", "應為", "答案是", "正確的是" or similar).
- Must be a DIFFERENT hint from hintGiven — try a new explanation angle or ask a guiding question.
- 1–3 sentences. Specific, warm, and encouraging.

STRICT RULES for reason:
- Traditional Chinese (繁體中文) only.
- 1 sentence, concrete, and cannot reveal the exact correct answer.
- Focus on what is still missing/wrong (e.g., 單位、步驟、條件、關鍵詞、題意誤解).

Return strict JSON only. No markdown.

Output:
{
  "results": [
    {
      "questionId": "string",
      "passed": true,
      "studentAnswer": "what student wrote"
    },
    {
      "questionId": "string",
      "passed": false,
      "studentAnswer": "what student wrote",
      "reason": "為何仍錯（不給正解）",
      "newGuidance": "新引導（不給答案）"
    }
  ]
}`.trim()
}

function normalizeRecheckQuestionId(value) {
  const raw = ensureString(value, '').trim().toLowerCase()
  if (!raw) return ''
  const compact = raw.replace(/\s+/g, '')
  const directNumeric = compact.match(/^第?(\d+)題$/)
  if (directNumeric?.[1]) return directNumeric[1]
  const prefixedNumeric = compact.match(/^(?:q|question|題目|題號)[#:_-]?(\d+)$/)
  if (prefixedNumeric?.[1]) return prefixedNumeric[1]
  return compact
}

function buildRecheckFallbackResult(questionId, reason) {
  const fallbackReason = ensureString(reason, '').trim() || 'AI 未能正確判讀此題，請重新拍攝並保留題號。'
  return {
    questionId,
    passed: false,
    studentAnswer: '',
    reason: fallbackReason,
    newGuidance: fallbackReason
  }
}

function parseRecheckResponse(data, correctionItems, options = {}) {
  const requestTag = ensureString(options.requestId, '').trim() || 'recheck'
  const parsed =
    data && typeof data === 'object' && Array.isArray(data.results)
      ? data
      : parseCandidateJson(data)
  const rawResults = Array.isArray(parsed?.results) ? parsed.results : []

  const questionOrder = correctionItems
    .map((item) => ensureString(item?.questionId, '').trim())
    .filter(Boolean)
  if (!questionOrder.length) return []

  if (rawResults.length === 0) {
    console.warn(
      `[AI-5STAGE][${requestTag}] recheck response has no usable results; fallback to all-fail`
    )
    return questionOrder.map((questionId) =>
      buildRecheckFallbackResult(questionId, 'AI 本次未回傳可判定結果，請重新拍攝後再試。')
    )
  }

  const knownIdSet = new Set(questionOrder)
  const normalizedToKnown = new Map()
  for (const knownId of questionOrder) {
    const normalized = normalizeRecheckQuestionId(knownId)
    if (normalized && !normalizedToKnown.has(normalized)) {
      normalizedToKnown.set(normalized, knownId)
    }
  }

  const assigned = new Map()
  const consumed = new Set()

  const takeNextUnassigned = () => questionOrder.find((id) => !consumed.has(id)) || ''

  for (const row of rawResults) {
    if (!row || typeof row !== 'object') continue

    const rawQuestionId = ensureString(row.questionId, '').trim()
    const normalizedRawId = normalizeRecheckQuestionId(rawQuestionId)
    let resolvedQuestionId = ''

    if (rawQuestionId && knownIdSet.has(rawQuestionId)) {
      resolvedQuestionId = rawQuestionId
    } else if (normalizedRawId && normalizedToKnown.has(normalizedRawId)) {
      resolvedQuestionId = normalizedToKnown.get(normalizedRawId) || ''
    } else if (normalizedRawId && /^\d+$/.test(normalizedRawId)) {
      const oneBased = Number.parseInt(normalizedRawId, 10)
      if (Number.isFinite(oneBased) && oneBased >= 1 && oneBased <= questionOrder.length) {
        resolvedQuestionId = questionOrder[oneBased - 1] || ''
      }
    }

    if (!resolvedQuestionId) {
      resolvedQuestionId = takeNextUnassigned()
    }
    if (!resolvedQuestionId || consumed.has(resolvedQuestionId)) continue

    consumed.add(resolvedQuestionId)
    const passed = row.passed === true
    const studentAnswer = ensureString(row.studentAnswer, '').trim()
    const reasonText =
      ensureString(row.reason, '').trim() ||
      ensureString(row.newGuidance, '').trim() ||
      '此題仍需訂正，請檢查題號與答案是否清楚入鏡。'

    assigned.set(resolvedQuestionId, {
      questionId: resolvedQuestionId,
      passed,
      studentAnswer,
      reason: passed ? undefined : reasonText,
      newGuidance: passed ? undefined : reasonText
    })
  }

  const missingQuestionIds = questionOrder.filter((id) => !assigned.has(id))
  if (missingQuestionIds.length > 0) {
    console.warn(
      `[AI-5STAGE][${requestTag}] recheck missing question results: ${missingQuestionIds.join(', ')}`
    )
    for (const missingId of missingQuestionIds) {
      assigned.set(
        missingId,
        buildRecheckFallbackResult(missingId, '此題尚未成功判定，請重新拍攝答案區域後再試。')
      )
    }
  }

  return questionOrder.map((questionId) => assigned.get(questionId))
}

export async function runRecheckPipeline({
  apiKey,
  model,
  correctionImages,
  correctionItems,
  requestId
}) {
  if (!correctionImages?.length || !correctionItems?.length) {
    return { results: [] }
  }

  const imageMapping = correctionImages
    .map((img, i) => `- 圖片 ${i + 1}：題目 ${img.questionId} 的訂正照片`)
    .join('\n')

  const prompt = buildRecheckPrompt(correctionItems, imageMapping)

  const imageParts = correctionImages.map((img) => ({
    inlineData: { data: img.base64, mimeType: img.contentType || 'image/webp' }
  }))

  const pipelineRunId = requestId || `recheck_${Date.now()}`
  logStageStart(pipelineRunId, 'recheck')

  const response = await executeStage({
    apiKey,
    model,
    routeKey: AI_ROUTE_KEYS.GRADING_RECHECK,
    stageContents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }]
  })

  logStageEnd(pipelineRunId, 'recheck', response)

  if (!response.ok || !response.data) {
    throw new Error(`Recheck stage failed with status ${response.status}`)
  }

  return { results: parseRecheckResponse(response.data, correctionItems, { requestId: pipelineRunId }) }
}
