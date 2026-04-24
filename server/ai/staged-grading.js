import { getPipeline } from './pipelines.js'
import { callGeminiGenerateContent } from './model-adapter.js'
import { AI_ROUTE_KEYS } from './routes.js'
import {
  QG_SEVERITY,
  validateClassifyQuality,
  validateReadAnswerQuality,
  validateArbiterQuality,
  validateAccessorQuality,
  validateExplainQuality,
  validateClassifyReadConsistency,
  validateReadAccessorConsistency
} from './quality-gates.js'

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
  multi_check_other: 2,
  calculation: 3,
  word_problem: 3,
  short_answer: 3,
  map_fill: 2,
  multi_fill: 1,
  map_draw: 3,
  diagram_draw: 3,
  diagram_color: 3,
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

function roundToTenth(value) {
  return Math.round(Number(value) * 10) / 10
}

function splitScoreIntoTwo(totalScore) {
  const safeTotal = Number.isFinite(Number(totalScore)) && Number(totalScore) > 0 ? Number(totalScore) : 0
  if (safeTotal <= 0) return [0, 0]
  const first = roundToTenth(safeTotal / 2)
  const second = roundToTenth(safeTotal - first)
  return [first, second]
}

function normalizeShortAnswerQuestion(question, domainHint) {
  if (!question || typeof question !== 'object') return question
  const category = ensureString(question.questionCategory, '').trim()
  if (category !== 'short_answer') return question

  const maxScore = Number.isFinite(Number(question.maxScore)) ? Number(question.maxScore) : 0
  const criteriaHint = ensureString(question.referenceAnswer, '').trim()
  const safeDimensions = Array.isArray(question.rubricsDimensions)
    ? question.rubricsDimensions
        .map((dim) => ({
          name: ensureString(dim?.name, '').trim(),
          maxScore: Number.isFinite(Number(dim?.maxScore)) ? Number(dim.maxScore) : 0,
          criteria: ensureString(dim?.criteria, '').trim()
        }))
        .filter((dim) => dim.name && dim.criteria)
    : []

  const [firstScore, secondScore] = splitScoreIntoTwo(maxScore)
  let normalizedDimensions = safeDimensions
  if (safeDimensions.length === 0) {
    normalizedDimensions = [
      {
        name: '作答依據',
        maxScore: firstScore,
        criteria: '有根據題目提供的資料或文本作答，指出關鍵依據。'
      },
      {
        name: '結論表達',
        maxScore: secondScore,
        criteria: criteriaHint
          ? `結論與重點相符（參考要點：${criteriaHint}），表達完整清楚。`
          : '結論與重點相符，表達完整清楚。'
      }
    ]
  } else if (safeDimensions.length === 1) {
    normalizedDimensions = [
      { ...safeDimensions[0], maxScore: firstScore },
      {
        name: '結論表達',
        maxScore: secondScore,
        criteria: criteriaHint
          ? `結論與重點相符（參考要點：${criteriaHint}），表達完整清楚。`
          : '結論與重點相符，表達完整清楚。'
      }
    ]
  }

  return {
    ...question,
    type: 3,
    rubricsDimensions: normalizedDimensions,
    rubric: undefined
  }
}

function normalizeAnswerKeyForRubricScoring(answerKey, domainHint) {
  if (!answerKey || typeof answerKey !== 'object') {
    return { answerKey, convertedShortAnswerIds: [] }
  }
  const questions = Array.isArray(answerKey.questions) ? answerKey.questions : []
  if (questions.length === 0) return { answerKey, convertedShortAnswerIds: [] }

  const convertedShortAnswerIds = []
  const normalizedQuestions = questions.map((question) => {
    const normalized = normalizeShortAnswerQuestion(question, domainHint)
    const isConverted =
      normalized !== question &&
      ensureString(question?.questionCategory, '').trim() === 'short_answer'
    if (isConverted) {
      const questionId = ensureString(question?.id, '').trim()
      if (questionId) convertedShortAnswerIds.push(questionId)
    }
    return normalized
  })

  return {
    answerKey: { ...answerKey, questions: normalizedQuestions },
    convertedShortAnswerIds
  }
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
  // Reject absolute-pixel coordinates (classify occasionally outputs px instead of normalized 0-1)
  if (x > 2 || y > 2 || w > 2 || h > 2) return null
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
      let studentAnswerRaw = ensureString(item?.studentAnswerRaw, '')
      const rawSpelling = ensureString(item?.rawSpelling, '').trim()

      // rawSpelling 覆蓋：如果有逐字母拼寫，還原為正常文字並比對
      // rawSpelling="d-i-n-n-g r-o-o-m" → reconstructed="dinng room"
      if (rawSpelling && studentAnswerRaw) {
        const reconstructed = rawSpelling
          .split(' ')
          .map((word) => word.split('-').join(''))
          .join(' ')
        if (reconstructed && reconstructed.toLowerCase() !== studentAnswerRaw.toLowerCase()) {
          console.log(`[rawSpelling-override] questionId=${item?.questionId} original="${studentAnswerRaw}" rawSpelling="${rawSpelling}" reconstructed="${reconstructed}"`)
          studentAnswerRaw = reconstructed
        }
      }

      const entry = {
        questionId: ensureString(item?.questionId, ''),
        status: ensureString(item?.status, ''),
        studentAnswerRaw
      }
      if (item?.formatBReasoning) {
        entry.formatBReasoning = ensureString(item.formatBReasoning, '')
      }
      if (rawSpelling) {
        entry.rawSpelling = rawSpelling
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
async function cropInlineImageByBbox(imageBase64, mimeType, bbox, useActualBbox = false, customPad = null) {
  if (!bbox || !imageBase64) return null
  try {
    const { default: sharp } = await import('sharp')
    const imageBuffer = Buffer.from(imageBase64, 'base64')
    const metadata = await sharp(imageBuffer).metadata()
    const { width, height } = metadata
    if (!width || !height) return null

    let px, py, px2, py2
    if (useActualBbox) {
      // 直接使用 bbox 實際範圍，加 pad 邊距（預設 0.03，可透過 customPad 覆蓋）
      const pad = customPad !== null ? customPad : 0.03
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

// Split a merged submission image into N pages using pageBreaks.
// pageBreaks: normalized y ratios (e.g. [0.25, 0.5, 0.75] → 4 pages).
// Returns array of { inlineData: { data, mimeType }, pageStartY, pageEndY } or null on failure.
async function splitSubmissionImageByPageBreaks(imageBase64, mimeType, pageBreaks) {
  if (!imageBase64 || !Array.isArray(pageBreaks) || pageBreaks.length === 0) return null
  try {
    const { default: sharp } = await import('sharp')
    const imageBuffer = Buffer.from(imageBase64, 'base64')
    const metadata = await sharp(imageBuffer).metadata()
    const { width, height } = metadata
    if (!width || !height) return null

    // Build page boundaries: [0, pb1, pb2, ..., 1]
    const boundaries = [0, ...pageBreaks, 1]
    const pages = []
    const extractPromises = []
    for (let i = 0; i < boundaries.length - 1; i++) {
      const startY = boundaries[i]
      const endY = boundaries[i + 1]
      const topPx = Math.round(startY * height)
      const bottomPx = Math.round(endY * height)
      const pagePxHeight = bottomPx - topPx
      if (pagePxHeight <= 0) continue
      pages.push({ pageStartY: startY, pageEndY: endY })
      extractPromises.push(
        sharp(imageBuffer)
          .extract({ left: 0, top: topPx, width, height: pagePxHeight })
          .jpeg({ quality: 90 })
          .toBuffer()
      )
    }
    const buffers = await Promise.all(extractPromises)
    return buffers.map((buf, i) => ({
      inlineData: { data: buf.toString('base64'), mimeType: 'image/jpeg' },
      pageStartY: pages[i].pageStartY,
      pageEndY: pages[i].pageEndY
    }))
  } catch (err) {
    console.warn('[staged-grading] splitSubmissionImageByPageBreaks failed:', err?.message)
    return null
  }
}

// Remap a bbox from per-page normalized coordinates (0~1) to full-image normalized coordinates.
// pageStartY/pageEndY: the page's vertical range within the full image (0~1).
function remapBboxToFullImage(bbox, pageStartY, pageEndY) {
  if (!bbox) return bbox
  const pageHeight = pageEndY - pageStartY
  return {
    x: bbox.x,
    y: pageStartY + bbox.y * pageHeight,
    w: bbox.w,
    h: bbox.h * pageHeight
  }
}

const CHECKBOX_EQUIVALENT_TYPES = new Set(['single_check', 'multi_check', 'multi_choice', 'multi_check_other'])
const CHECKBOX_FOCUSED_READ_TYPES = new Set(['single_check', 'multi_check', 'multi_choice', 'multi_check_other'])
// 位置型勾選題：答案是順序數字（①③ / 第一個 / (1)），統一顯示為純數字（1,3）
const POSITION_SELECTION_TYPES = new Set(['single_check', 'multi_check', 'multi_check_other'])

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
  if (/^[○〇OoTt]$/.test(s) || /^(?:對|是|正確|ｏ|O|yes|Yes|true|True|TRUE)$/u.test(s)) return '○'
  // 各種「錯誤」形式 → ✗
  if (/^[✗✘×XxFf叉]$/.test(s) || /^(?:錯|否|不對|不是|no|No|false|False|FALSE)$/u.test(s)) return '✗'
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
  // 去除 unchecked checkbox option text: "☐生活品質" "□城市發展" (整個未勾選選項名稱移除)
  // Must run BEFORE stripping checkbox symbols, otherwise option names remain orphaned
  s = s.replace(/[☐□][^\s☐□☑✓✔✗✘\n,，、]+/gu, '').trim()
  // 去除勾選/打叉符號（☑ ✓ ✔ ☒ ✗ ✘ □ ☐ 等）
  s = s.replace(/[☑✓✔☒✗✘□☐☎✅❎]/gu, '').trim()
  // 去除 Unicode Emoji（Presentation 形式）
  s = s.replace(/\p{Emoji_Presentation}/gu, '').trim()
  // 去除結尾方向箭頭
  s = s.replace(/[↗↘↙↖→←↑↓⬆⬇⬅➡]+$/u, '').trim()
  // 數學推導箭號正規化（→ ⇒ → =>，用於計算題中段的推導符號，如 0.55 → 0.56）
  s = s.replace(/[→⇒]/gu, '=>')
  // 去除開頭「(A) 文字」中的選項前綴（後面有空白+其他內容才移除）
  s = s.replace(/^\([A-Za-z]\)\s+/u, '').trim()
  // 整個字串是「(D)」→「D」
  s = s.replace(/^\(([A-Za-z])\)$/u, '$1').trim()
  // 減號/破折號異體字統一（− – — → -）
  s = s.replace(/[−–—]/gu, '-')
  // 乘號異體字統一（× ✕ ✖ → ×）— 保留 × 作為標準形式
  s = s.replace(/[✕✖]/gu, '×')
  // 圈圈數字 → 半形數字（①②③④⑤⑥⑦⑧⑨⑩ → 1~10）
  s = s.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/gu, (ch) => {
    const idx = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'.indexOf(ch)
    return idx >= 0 ? String(idx + 1) : ch
  })
  // 全形數字 → 半形
  s = s.replace(/[０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF10))
  // 全形逗號 → 半形（比對用，不分語言領域）
  s = s.replace(/，/gu, ',')
  // 去除 AI 加的欄位標籤前綴（每行開頭的「人物：」「具體事件：」「你的理由：」等）
  // AI2 常會加這類結構化標籤，AI1 不加，導致同內容被判為不同
  // 也處理含括號的標籤如「你的理由(需包含因果關係)：」
  // lookbehind 也匹配空格，因為 AI2 的分隔符可能是 ", " (逗號+空格)
  s = s.replace(/(?:^|(?<=[\n,、\s]))[\p{Unified_Ideograph}\p{Letter}]+(?:\([^)]*\))?[：:]\s*/gmu, '')
  // 去除「第N項：」「第一項：」等序號前綴
  s = s.replace(/(?:^|(?<=[\n,、\s]))第[一二三四五六七八九十\d]+項[：:]\s*/gmu, '')
  // 去除格式提示標籤（如「你的理由（因為……，所以……）：」）
  // 這種複合標籤含括號+省略號+逗號，上面的 label regex 處理不了
  s = s.replace(/你的理由[^：:]*[：:]\s*/gu, '')
  // 圈選選項格式統一（AFTER label removal）：
  // AI1: ( 械鬥 / 民變 ) → 械鬥民變, AI2: （ 械鬥 ） → 械鬥
  // 去括號 + 斜線讓兩者一致
  s = s.replace(/[（(]\s*([^）)]*?)\s*[）)]/gu, '$1')  // 去括號，保留內容
  s = s.replace(/\s*[/／]\s*/gu, '')  // 去斜線分隔符
  // 省略號去除（……、...）— AI 讀到的格式提示文字
  s = s.replace(/[…]+/gu, '')
  s = s.replace(/\.{2,}/gu, '')
  // 去除分隔符號（逗號、頓號、換行）— 比對內容本身，不比對格式
  s = s.replace(/[,、\n\r]/gu, '')
  // 去除所有空白（避免有無空白造成誤判）
  s = s.replace(/\s+/gu, '')
  // 選項字母大小寫統一（A/a、B/b、C/c 等視為相同）
  s = s.toLowerCase()
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

// 位置型勾選題顯示正規化：①,③ / 第一個,第三個 / (1),(3) → 1,3
function normalizeSelectionAnswerToDisplay(raw, questionType) {
  const normalized = normalizeSelectionAnswerForComparison(raw, questionType)
  if (!normalized) return raw
  return normalized.split(',').map(t => {
    const m = t.match(/^#(\d+)$/)
    if (m) return m[1]
    const atM = t.match(/^@([A-Z]+)$/)
    if (atM) return atM[1]
    return t
  }).join(',')
}

// 對 readAnswerResult 中的位置型勾選題套用顯示正規化
function applySelectionDisplayNormalization(readResult, answerKey) {
  const typeByQuestionId = new Map(
    (answerKey?.questions ?? []).map(q => [
      ensureString(q?.id, '').trim(),
      ensureString(q?.questionCategory, '').trim()
    ])
  )
  return {
    ...readResult,
    answers: readResult.answers.map(answer => {
      if (answer.status !== 'read') return answer
      const qType = typeByQuestionId.get(answer.questionId)
      if (!POSITION_SELECTION_TYPES.has(qType)) return answer
      return { ...answer, studentAnswerRaw: normalizeSelectionAnswerToDisplay(answer.studentAnswerRaw, qType) }
    })
  }
}

// diagram_draw 專用比對：提取所有數值（整數、分數、帶單位）排序後比對
// 設計：只比較數值集合，忽略描述語序與措辭差異
// 例：AI1「80° tomato juice, 60° Carrot」vs AI2「60° Carrot, 80° tomato」→ 同樣 "60|80" → stable
// 分數轉 permille（×1000）避免浮點問題：1/6 → 167, 2/9 → 222
function normalizeDiagramDrawForComparison(raw) {
  const s = ensureString(raw, '')
  const nums = new Set()
  // Step 1: 分數（如 1/6、2/9）→ permille 整數，同時從字串中移除避免後續重複擷取
  const noFrac = s.replace(/(\d+)\/(\d+)/g, (_, n, d) => {
    const dInt = parseInt(d, 10)
    if (dInt > 0) nums.add(Math.round(parseInt(n, 10) / dInt * 1000))
    return ''
  })
  // Step 2: 帶單位整數（° % 份 票 人 度）
  const reUnit = /(\d+)\s*[°%份票人度]/gu
  let m
  while ((m = reUnit.exec(noFrac)) !== null) nums.add(parseInt(m[1], 10))
  // Step 3: 2 位以上獨立整數（涵蓋 mL、km 等未列舉單位）
  const reInt = /(?<!\d)(\d{2,})(?!\d)/gu
  while ((m = reInt.exec(noFrac)) !== null) nums.add(parseInt(m[1], 10))
  if (nums.size < 2) return null
  return [...nums].sort((a, b) => a - b).join('|')
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

/**
 * 從計算題/應用題文字中提取最終答案（僅用於一致性比對）。
 * 優先順序：
 *   1. 「答：xxx」/「答:xxx」/「A:xxx」前綴（跨行）
 *   2. 第一段（逗號或換行前）的 「=(xxx)」括號內答案
 *   3. 整段文字中最後一個「=」之後的值
 */
function extractFinalAnswerFromCalc(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null

  // 1. 答：xxx / 答:xxx / A:xxx / Ans:xxx / Ans xxx（允許答案本身外面有括號，如「答：(1/4 m)」）
  const answerPrefixMatch = s.match(/(?:答[：:：]|[Aa](?:ns)?[：:\s])\s*[（(]?\s*(.+?)\s*[）)]?[\s。，,]*$/u)
  if (answerPrefixMatch) {
    const val = normalizeMathAnswer(answerPrefixMatch[1])
    if (val) return val
  }

  // 2. 第一段含括號答案：「equation=(answer), 步驟...」或「equation=(answer)\n步驟...」
  const firstSegment = s.split(/[,，\n]/)[0]
  const bracketMatch = firstSegment.match(/=\s*[（(]\s*([^）)，,\n]+?)\s*[）)]/u)
  if (bracketMatch) {
    const val = normalizeMathAnswer(bracketMatch[1])
    if (val) return val
  }

  // 3. 整段文字最後一個「=」之後的值（最後一步計算結果）
  const lastEqIdx = s.lastIndexOf('=')
  if (lastEqIdx >= 0) {
    const val = normalizeMathAnswer(s.slice(lastEqIdx + 1))
    if (val) return val
  }

  return null
}

/**
 * 數值等值比對：支援分數（3/10 vs 108/360）、小數（0.5 vs 1/2）、百分比（50% vs 0.5）。
 * 去除尾部非數字單位（cm², cc, min 等）後比較數值。
 * 只在兩邊都能解析為數值時回傳 true/false，否則 false。
 */
function isNumericEqual(a, b) {
  if (!a || !b) return false
  // 去除尾部單位文字（保留數字、分數、小數、百分比、負號）
  const stripUnit = (s) => s.replace(/[a-zA-Z²³°]+$/u, '').replace(/[^\d./%\-]/g, '')
  const sa = stripUnit(a)
  const sb = stripUnit(b)
  if (!sa || !sb) return false

  const toNumber = (s) => {
    // 百分比：50% → 0.5
    if (s.endsWith('%')) {
      const v = parseFloat(s)
      return isFinite(v) ? v / 100 : null
    }
    // 分數：3/10, 108/360
    const fracMatch = s.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
    if (fracMatch) {
      const d = parseFloat(fracMatch[2])
      return d !== 0 ? parseFloat(fracMatch[1]) / d : null
    }
    // 純數字 / 小數
    const v = parseFloat(s)
    return isFinite(v) ? v : null
  }

  const na = toNumber(sa)
  const nb = toNumber(sb)
  if (na === null || nb === null) return false
  // 容差比對（避免浮點精度問題）
  return Math.abs(na - nb) < 1e-9
}

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b)
  while (b) { [a, b] = [b, a % b] }
  return a
}

/**
 * 判斷字串是否為「未化簡分數」。
 * 規則：分數必須最簡，但結果為整數時例外（如 2/2=1、6/3=2 可接受）。
 * 分數與小數間的等值轉換仍然接受（由 isNumericEqual 處理）。
 */
function isUnsimplifiedFraction(s) {
  if (!s) return false
  const fracMatch = s.match(/^-?(\d+)\/(\d+)$/)
  if (!fracMatch) return false
  const num = parseInt(fracMatch[1], 10)
  const den = parseInt(fracMatch[2], 10)
  if (den === 0) return false
  // 結果為整數（如 2/2, 6/3）→ 不強制化簡
  if (num % den === 0) return false
  // GCD > 1 → 未化簡
  return gcd(num, den) > 1
}

/**
 * 最終答案正規化（消除排版差異，僅用於比對）：
 * - 統一減號/破折號變體
 * - 去除空白、括號包裝、結尾標點
 */
function normalizeMathAnswer(s) {
  if (!s) return ''
  return s
    .replace(/[−–—]/gu, '-')         // 減號異體字統一
    .replace(/，/gu, ',')             // 全形逗號→半形
    .replace(/：/gu, ':')             // 全形冒號→半形
    .replace(/\s+/gu, '')             // 去除空白
    .replace(/^[（(](.*)[）)]$/u, '$1') // 剝除外層括號：(3/4) → 3/4
    .replace(/[。.，,]+$/u, '')        // 去除結尾標點
    .toLowerCase()
}

// A5: 純邏輯一致性比對（不耗 token）
// read1/read2: { status: 'read'|'blank'|'unreadable', studentAnswerRaw: string }
function computeConsistencyStatus(read1, read2, questionType = 'other') {
  const s1 = ensureString(read1?.status, '').toLowerCase()
  const s2 = ensureString(read2?.status, '').toLowerCase()
  // 兩者皆空白 → 一致（都沒作答）
  if (s1 === 'blank' && s2 === 'blank') return 'stable'
  if (s1 !== 'read' || s2 !== 'read') return 'unstable'

  // calculation / word_problem：只比最終答案，忽略步驟排版差異
  if (questionType === 'calculation' || questionType === 'word_problem') {
    const fa1 = extractFinalAnswerFromCalc(read1?.studentAnswerRaw)
    const fa2 = extractFinalAnswerFromCalc(read2?.studentAnswerRaw)
    if (fa1 && fa2 && fa1 === fa2) return 'stable'
    // 提取失敗或答案不完全相等 → 繼續走既有邏輯（Jaccard 相似度等）
  }

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

  // diagram_draw（圖表題：長條圖/圓餅圖）：提取標籤-數值對比對，忽略描述用字差異
  // 例：AI1「分為四個區域，標記為香蕉23%...」vs AI2「分為四個區塊，標註香蕉23%...」→ stable
  if (questionType === 'diagram_draw') {
    const p1 = normalizeDiagramDrawForComparison(read1?.studentAnswerRaw)
    const p2 = normalizeDiagramDrawForComparison(read2?.studentAnswerRaw)
    if (p1 !== null && p2 !== null) {
      return p1 === p2 ? 'stable' : 'diff'
    }
  }
  // diagram_color（塗色題）：位置與比例都重要，不做特殊提取
  // 直接走後段 generic 文字比對 + Jaccard 相似度，讓 AI3 看圖最終裁決

  const a1 = normalizeAnswerForComparison(ensureString(read1?.studentAnswerRaw, ''))
  const a2 = normalizeAnswerForComparison(ensureString(read2?.studentAnswerRaw, ''))
  if (a1 === a2) return 'stable'
  // 計算題：不使用字元集相似度（不同算式可能共享相同數字/符號，Jaccard 會誤判）
  // 只做精確比對和後段的包含關係檢查
  if (questionType !== 'calculation') {
    // 長答案：字元相似度 ≥ 0.75 視為一致（應對語意相近但措辭不同的描述）
    const longer = Math.max(a1.length, a2.length)
    if (longer >= 6 && computeStringSimilarity(a1, a2) >= 0.75) return 'stable'
  }
  // 包含關係檢查：短答案是長答案的 substring，且長度差距明顯
  // → 長答案很可能多讀了鄰近題目或標籤文字，短答案才是真正的作答內容
  // 無最短長度限制，涵蓋如「英國人」(3字) 或「360」等短答案
  const [shorterA, longerA] = a1.length <= a2.length ? [a1, a2] : [a2, a1]
  if (shorterA.length > 0 && longerA.includes(shorterA) && longerA.length >= shorterA.length * 1.3) {
    return 'stable'
  }
  return 'diff'
}

// 包含關係成立時，回傳應優先使用的原始答案（較短、較精確的那個）。
// 若 AI1 已是較短的一方（預設即使用 AI1），回傳 null 不需覆寫。
// 若 AI2 較短，回傳 AI2 的原始答案，供 Phase A 結果建構時覆寫 finalAnswer。
function getContainmentPreferredRaw(read1, read2, questionType) {
  if (CHECKBOX_EQUIVALENT_TYPES.has(questionType) || questionType === 'true_false') return null
  const a1 = normalizeAnswerForComparison(ensureString(read1?.studentAnswerRaw, ''))
  const a2 = normalizeAnswerForComparison(ensureString(read2?.studentAnswerRaw, ''))
  if (!a1 || !a2 || a1 === a2) return null
  const a1IsShorter = a1.length <= a2.length
  const [shorterA, longerA] = a1IsShorter ? [a1, a2] : [a2, a1]
  if (shorterA.length === 0) return null
  if (!longerA.includes(shorterA)) return null
  if (longerA.length < shorterA.length * 1.3) return null
  // AI1 較短 → 預設用 AI1，無需覆寫
  if (a1IsShorter) return null
  // AI2 較短 → 回傳 AI2 原始答案
  return ensureString(read2?.studentAnswerRaw, '') || null
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
  'multi_fill',
  'map_draw',
  'diagram_draw',
  'diagram_color',
  'multi_check',
  'multi_check_other',
  'fill_blank',
  'true_false',
  'matching',
  'multi_choice',
  'single_check'
])

function resolveExpectedQuestionType(question) {
  let category = ensureString(question?.questionCategory, '').trim()
  if (!category) {
    const dimNames = Array.isArray(question?.rubricsDimensions)
      ? question.rubricsDimensions.map((dim) => ensureString(dim?.name, '')).join('|')
      : ''
    if (/算式過程|最終答案/.test(dimNames)) category = 'calculation'
    else if (resolveQuestionType(question) === 3) category = 'short_answer'
  }
  const answerFormat = ensureString(question?.answerFormat, '').trim().toLowerCase()

  // Priority rules (explicit > structural hints > category/type fallback)
  // 1) Explicit answerFormat: matching or matching_on_map => matching
  if (answerFormat === 'matching' || answerFormat === 'matching_on_map') return 'matching'

  // 2) Structural hints: presence of choices + matchingGroupId/unorderedGroupId/bboxGroupId
  const hasChoices = Array.isArray(question?.choices) && question.choices.length > 0
  const hasMatchingGroup = Boolean(
    ensureString(question?.matchingGroupId, '').trim() ||
      ensureString(question?.unorderedGroupId, '').trim() ||
      ensureString(question?.bboxGroupId, '').trim()
  )
  // If there are explicit choices and a matching group or targets, treat as matching
  if (hasChoices && (hasMatchingGroup || Array.isArray(question?.targets) || Array.isArray(question?.answerTargets))) {
    return 'matching'
  }

  // 3) Map-specific categories should remain map_draw / map_fill when explicitly set
  if (category === 'map_draw' || category === 'map_fill') return category

  // 4) Some legacy category mappings
  if (category === 'fill_variants') return 'fill_blank'
  if (category === 'short_answer') return 'word_problem'
  if (CLASSIFY_ALLOWED_TYPES.has(category)) return category

  // 5) Fallback to numeric resolveQuestionType (legacy behavior)
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
    // answerBboxHint: pass answer key's bbox as a Y-coordinate reference for classify.
    // Only the Y position is reliable (same exam layout), X may differ due to scan alignment.
    // For single_choice: helps classify locate the bracket row (prevents reading option row instead).
    // For other types: provides a spatial anchor to improve bbox accuracy.
    const akAnswerBbox = normalizeBboxRef(question?.answerBbox)
    if (akAnswerBbox) {
      spec.answerBboxHint = {
        x: +akAnswerBbox.x.toFixed(4),
        y: +akAnswerBbox.y.toFixed(4),
        w: +akAnswerBbox.w.toFixed(4),
        h: +akAnswerBbox.h.toFixed(4)
      }
    }
    // anchorHint only helps for multi_fill and fill_blank sub-questions (3+ ID segments, e.g. "1-2-1").
    // For single_choice / single_check / etc., the hint describes the answer key's circled option, which
    // causes classify to narrow the bbox onto just that option text — shifting it upward.
    const anchorHintUsefulTypes = new Set(['multi_fill', 'fill_blank'])
    const isSubQuestion = questionId.split('-').length >= 3
    const akAnchorHint = ensureString(question?.anchorHint, '').trim()
    if (akAnchorHint && anchorHintUsefulTypes.has(expectedType) && (expectedType !== 'fill_blank' || isSubQuestion)) {
      spec.anchorHint = akAnchorHint
    }
    // 表格座標定位（優先於 anchorHint）
    if (question?.tablePosition && typeof question.tablePosition.col === 'number' && typeof question.tablePosition.row === 'number') {
      spec.tablePosition = {
        col: question.tablePosition.col,
        row: question.tablePosition.row,
        totalCols: question.tablePosition.totalCols,
        totalRows: question.tablePosition.totalRows
      }
      if (question.tablePosition.colspan > 1) spec.tablePosition.colspan = question.tablePosition.colspan
      if (question.tablePosition.rowspan > 1) spec.tablePosition.rowspan = question.tablePosition.rowspan
      // 附帶答案卷的 answerBbox 作為定位參考（答案卷圖片清晰，座標較精確）
      const akBbox = question?.answerBbox
      if (akBbox && typeof akBbox.x === 'number' && typeof akBbox.y === 'number') {
        spec.tablePosition.refBbox = {
          x: +akBbox.x.toFixed(3),
          y: +akBbox.y.toFixed(3),
          w: +(akBbox.w || akBbox.width || 0).toFixed(3),
          h: +(akBbox.h || akBbox.height || 0).toFixed(3)
        }
      }
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
      'word_problem', 'calculation', 'single_choice', 'map_fill', 'multi_fill', 'map_draw',
      'diagram_draw', 'diagram_color', 'multi_check', 'multi_check_other', 'fill_blank', 'true_false', 'matching',
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
      bracketBbox: (questionType === 'single_choice') ? normalizeBboxRef(row?.bracketBbox) : undefined,
      tablePositionReasoning: typeof row?.tablePositionReasoning === 'string' ? row.tablePositionReasoning : undefined
    })
    if (!visible) unmappedQuestionIds.push(questionId)
  }

  const visibleCount = alignedQuestions.filter((item) => item.visible).length
  const coverage = questionIds.length === 0 ? 0 : visibleCount / questionIds.length

  // Detect questions whose bbox was rejected due to absolute-pixel coordinates
  const pixelBboxRejected = alignedQuestions
    .filter((q) => q.visible && !q.answerBbox)
    .map((q) => {
      const raw = byQuestionId.get(q.questionId)
      const ab = raw?.answerBbox ?? raw?.answer_bbox
      return ab && (ab.x > 2 || ab.y > 2 || ab.w > 2 || ab.h > 2) ? q.questionId : null
    })
    .filter(Boolean)
  if (pixelBboxRejected.length > 0) {
    console.warn('[classify] absolute-pixel bbox rejected (non-normalized), questions will be unread:', pixelBboxRejected)
  }

  return { alignedQuestions, coverage, unmappedQuestionIds, pixelBboxRejected }
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
    // readBbox: tight answer-only crop for fill_blank single-blank questions
    // Sub-question fill_blank (3+ segments, e.g. "1-2-1") uses answerBbox directly — no readBbox needed
    const isSubQuestionFillBlank = questionType === 'fill_blank' &&
      questionId.split('-').length >= 3
    const readBbox = (questionType === 'fill_blank' && !isSubQuestionFillBlank)
      ? normalizeBboxRef(row?.readBbox ?? row?.read_bbox) ?? null
      : null

    if (bboxPolicy === 'full_image') {
      questionBbox = fullImageBbox
      answerBbox = fullImageBbox
    } else {
      if (!questionBbox && answerBbox) questionBbox = answerBbox
      if (!answerBbox && questionBbox) answerBbox = questionBbox
    }

    // 表格題：不在第一輪強制 x，保留 classify 原始偵測值，第二輪統一修正

    return {
      ...row,
      questionType,
      bboxPolicyApplied: bboxPolicy || undefined,
      bboxGroupId: bboxGroupId || undefined,
      questionBbox,
      answerBbox,
      readBbox: readBbox || undefined,
      bracketBbox:
        questionType === 'single_choice' ? normalizeBboxRef(row?.bracketBbox) : undefined
    }
  })

  // 表格題第二輪：混合定位 — refBbox 提供相對間距，classify 提供絕對位置校準
  // 1. 收集每格的 classify.x 和 refBbox.x
  // 2. 計算中位數 offset（掃描水平偏移量）
  // 3. 所有格子 x = refBbox.x + offset（保持精確相對間距，修正掃描偏移）
  // 4. w = 欄間距 - padding（避免看到鄰格）
  const TABLE_CELL_PADDING = 0.008
  const tableGroups = new Map() // key = "row-totalCols-totalRows" → [{index, col, classifyX, refX, refW}]
  for (let i = 0; i < alignedQuestions.length; i += 1) {
    const q = alignedQuestions[i]
    const spec = specByQuestionId.get(q.questionId)
    const tp = spec?.tablePosition
    if (!tp || !tp.refBbox || typeof tp.refBbox.x !== 'number') continue
    const groupKey = `${tp.row}-${tp.totalCols}-${tp.totalRows}`
    if (!tableGroups.has(groupKey)) tableGroups.set(groupKey, [])
    tableGroups.get(groupKey).push({
      index: i,
      col: tp.col,
      classifyX: q.answerBbox?.x ?? tp.refBbox.x,
      refX: tp.refBbox.x,
      refW: tp.refBbox.w || 0
    })
  }
  for (const members of tableGroups.values()) {
    // 計算掃描偏移量：classify.x 與 refBbox.x 的中位數差距
    const offsets = members.map((m) => m.classifyX - m.refX)
    offsets.sort((a, b) => a - b)
    const medianOffset = offsets.length % 2 === 1
      ? offsets[Math.floor(offsets.length / 2)]
      : (offsets[offsets.length / 2 - 1] + offsets[offsets.length / 2]) / 2

    if (members.length < 2) {
      // 單格：用 refBbox.x + offset，用 refBbox.w
      const m = members[0]
      const q = alignedQuestions[m.index]
      if (q.answerBbox) {
        alignedQuestions[m.index] = { ...q, answerBbox: { ...q.answerBbox, x: +(m.refX + medianOffset).toFixed(4), w: m.refW } }
      }
      continue
    }
    members.sort((a, b) => a.col - b.col)
    for (let j = 0; j < members.length; j += 1) {
      const m = members[j]
      // x = refBbox.x + 掃描偏移量（保持 refBbox 的精確相對間距）
      const correctedX = m.refX + medianOffset
      // 計算實際欄寬：refBbox 的欄間距（比 classify 更準確）
      const colWidth = j < members.length - 1
        ? members[j + 1].refX - m.refX
        : (j > 0 ? m.refX - members[j - 1].refX : m.refW)
      // 內縮 padding，居中
      const safeW = Math.max(colWidth - TABLE_CELL_PADDING, m.refW, 0.02)
      const xShift = (colWidth - safeW) / 2
      const safeX = correctedX + xShift
      const q = alignedQuestions[m.index]
      if (q.answerBbox) {
        alignedQuestions[m.index] = { ...q, answerBbox: { ...q.answerBbox, x: +safeX.toFixed(4), w: +safeW.toFixed(4) } }
      }
    }
  }

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
      // 保護：如果原始 AI 有讀到答案（status=read），但 bracket-read 回報 blank，不覆蓋
      // bracket-read 可能切到錯誤位置導致讀不到，保留原始的有效答案
      const originalStatus = ensureString(answers[index]?.status, '').toLowerCase()
      if (originalStatus === 'read' && normalizedStatus === 'blank') {
        console.log(`[bracket-read-skip] ${questionId}: original=read, bracket=blank → keeping original`)
        continue
      }
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

function normalizeRubricDimensionName(value) {
  return ensureString(value, '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function isRubricDimensionFullyCorrect(dimension) {
  if (!dimension || typeof dimension !== 'object') return false
  const score = toFiniteNumber(dimension.score)
  const maxScore = toFiniteNumber(dimension.maxScore)
  if (score === null || maxScore === null || maxScore <= 0) return false
  return score >= maxScore - 0.0001
}

function findRubricDimension(rubricScores, predicates) {
  if (!Array.isArray(rubricScores)) return null
  for (const dimension of rubricScores) {
    const name = normalizeRubricDimensionName(dimension?.dimension ?? dimension?.name)
    if (!name) continue
    if (predicates.some((fn) => fn(name))) return dimension
  }
  return null
}

function applyLenientFocusOverride(normalized, question, answerKey, domainHint) {
  const strictness = ensureString(answerKey?.strictness, 'standard').trim().toLowerCase()
  if (strictness !== 'lenient') return normalized
  if (!normalized || typeof normalized !== 'object') return normalized
  if (normalized.errorType === 'blank' || normalized.errorType === 'unreadable') return normalized

  const category = ensureString(question?.questionCategory, '').trim()
  const domain = ensureString(domainHint, '').trim()
  const rubricScores = Array.isArray(normalized.rubricScores) ? normalized.rubricScores : []

  const toFullScore = (reason) => ({
    ...normalized,
    score: normalized.maxScore,
    isCorrect: true,
    needExplain: false,
    errorType: 'none',
    scoringReason: reason || normalized.scoringReason
  })

  if (category === 'calculation') {
    const finalAnswerDimension = findRubricDimension(rubricScores, [
      (name) => name.includes('最終答案'),
      (name) => name.includes('finalanswer')
    ])
    if (isRubricDimensionFullyCorrect(finalAnswerDimension)) {
      return toFullScore('寬鬆模式：最終答案正確，整題判定通過。')
    }
    return normalized
  }

  if (category === 'short_answer' && (domain === '社會' || domain === '自然')) {
    // Find the "core content" dimension — covers both traditional 核心結論 and newer 理由說明 patterns
    const coreConclusionDimension = findRubricDimension(rubricScores, [
      (name) => name.includes('核心'),
      (name) => name.includes('結論'),
      (name) => name.includes('主旨'),
      (name) => name.includes('重點'),
      (name) => name.includes('觀點'),
      (name) => name.includes('判斷'),
      (name) => name.includes('理由'),
      (name) => name.includes('說明')
    ])
    if (isRubricDimensionFullyCorrect(coreConclusionDimension)) {
      return toFullScore('寬鬆模式：核心結論/理由說明正確，整題判定通過。')
    }
    return normalized
  }

  return normalized
}

function normalizeAccessorResult(parsed, answerKey, answers, domainHint) {
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

    // Hard override: blank/unreadable always score=0 regardless of model output
    if (readStatus === 'blank' || readStatus === 'unreadable') score = 0

    const isCorrect =
      (readStatus === 'blank' || readStatus === 'unreadable')
        ? false
        : typeof row?.isCorrect === 'boolean'
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

    const normalizedBase = {
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

    const normalized = applyLenientFocusOverride(normalizedBase, question, answerKey, domainHint)
    scores.push(normalized)
    totalScore += toFiniteNumber(normalized.score) ?? 0
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

function buildClassifyPrompt(questionIds, questionSpecs, pageBreaks = [], answerKeyPageCount = 0, classifyCorrections = [], answerSheetMode = 'with_questions') {
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

  const imageReferenceSection = answerKeyPageCount > 0
    ? (() => {
        if (answerKeyPageCount === 1) {
          return `\nIMAGE ORDER:\n- Image 1: ANSWER_KEY_REFERENCE — the teacher's correct answers are marked in red ink. Use ONLY as spatial reference to find answer area positions (do NOT read answers from this image).\n- Image 2: STUDENT_SUBMISSION — the student's paper. Locate the same answer areas as shown in the reference.\n`
        }
        const refLines = Array.from({ length: answerKeyPageCount }, (_, i) =>
          `- Image ${i + 1}: ANSWER_KEY_REFERENCE page ${i + 1} — question IDs with prefix "${i + 1}-" are located on this page. Use ONLY as spatial reference to find answer area positions (do NOT read answers from this image).`
        ).join('\n')
        const submissionNote = `- Image ${answerKeyPageCount + 1}: STUDENT_SUBMISSION — all student pages merged into one image vertically. Use PAGE BOUNDARIES below to determine which part of this image corresponds to each page prefix.`
        return `\nIMAGE ORDER:\n${refLines}\n${submissionNote}\n`
      })()
    : ''

  const isAnswerOnly = answerSheetMode === 'answer_only'

  const answerOnlySection = isAnswerOnly
    ? `\nANSWER-ONLY SHEET MODE:
This student submission is a PURE ANSWER SHEET — it contains ONLY question numbers and answer blanks/boxes. There is NO question stem text printed on this sheet.
- Locate questions by their printed question NUMBERS only (e.g. "1", "2", "3" or "一", "二", "三").
- The answer area is the blank space/box/line next to or below each question number.
- Do NOT expect to see question stem text on the student sheet.
- answerBbox should frame "question number + answer blank area" only.
- For fill_blank sub-questions: each blank box is a separate sub-question. Use the same ordering rules (TOP-TO-BOTTOM, LEFT-TO-RIGHT).
`
    : ''

  return `
You are stage CLASSIFY.
Task: ${isAnswerOnly
    ? 'identify which question numbers are visible on this answer sheet, and locate each visible question\'s answer blank bbox. The sheet contains ONLY question numbers and answer blanks — there is NO question stem text.'
    : 'identify which question IDs are visible on this student submission image, and locate each visible question\'s bbox.'}
Do NOT infer question type. Question type is fixed by specs.
${imageReferenceSection}${answerOnlySection}
Allowed question IDs:
${JSON.stringify(questionIds)}

Question Specs (source of truth from AnswerKey):
${JSON.stringify(specs)}
${pageBoundarySection}

Rules:
- Use only the allowed question IDs above.
- For each questionId, questionType MUST exactly match Question Specs.
- Never re-classify question type based on visual guess.
- If ANSWER_KEY_REFERENCE image(s) are provided, follow this two-step process for each question:
  STEP 1 — Find the answer area on ANSWER_KEY_REFERENCE: The teacher's correct answers are written in red ink directly inside each answer area. Locate the red handwritten text for this question. That red text region is the answer area. Ignore any pre-printed example content (範例/例) — only red handwritten ink marks the real answer area.
  STEP 2 — Map to STUDENT_SUBMISSION: The student paper has the same printed layout. Use the position found in Step 1 to locate the corresponding area on STUDENT_SUBMISSION. Output that region as answerBbox. The student will have written their answer in that same area.
- visible=true if you can see the question and its answer area on this image.
- visible=false if the question is absent, cut off, or not on this image.
- bboxPolicy MUST follow Question Specs:
  - full_image: questionBbox and answerBbox must both be {x:0,y:0,w:1,h:1}.
  - group_context: questions in the same bboxGroupId MUST share the same questionBbox/answerBbox.
  - question_context: ${isAnswerOnly ? 'minimum bbox must include question number + student answer blank area (no stem text on answer-only sheets).' : 'minimum bbox must include question number + stem + student answer area.'}
- TABLE POSITION RULE (HIGHEST PRIORITY — when tablePosition is present in the spec, this rule OVERRIDES ALL other bbox rules including ANCHOR RULE, TABLE COLUMN RULE, and ORDERING RULE. Skip them entirely.):
    When a question spec includes tablePosition (e.g. {"col": 3, "row": 3, "totalCols": 7, "totalRows": 3}), the answer is in a TABLE GRID.

    【參考座標定位法】（最優先）
    當 tablePosition 包含 refBbox（答案卷上該格的精確座標）時，直接以 refBbox.x 作為 answerBbox 的 x 起點，refBbox.w 作為寬度。
    答案卷和學生卷是同一份試卷，表格的水平位置相同，因此 refBbox 的 x 座標可直接套用。
    步驟：
    1. answerBbox.x = refBbox.x
    2. answerBbox.w = refBbox.w
    3. answerBbox.y 和 answerBbox.h：找到學生卷上表格的目標列（row），用該列的上下格線決定 y 和 h
    4. 不需要自己數垂直格線 — refBbox 已經提供精確的 x 定位

    【格線計數法】（僅當 refBbox 不存在時使用的備援方案）
    步驟：
    1. 找到表格的外框邊界（最外圍的格線）
    2. 數垂直格線（含左右外框）：從左到右依序編號 V1, V2, V3, ..., V(N+1)。N+1 條垂直線 = N 欄
    3. 數水平格線（含上下外框）：從上到下依序編號 H1, H2, H3, ..., H(M+1)。M+1 條水平線 = M 列
    4. 第 C 欄 = V(C) 與 V(C+1) 之間的空間。第 R 列 = H(R) 與 H(R+1) 之間的空間
    5. 驗證：totalCols（spec 給的）應等於你數的垂直線數 - 1。若不符，重新計數
    6. 目標格 bbox: x = V(col) 的 x 座標, y = H(row) 的 y 座標, w = V(col+1) - V(col), h = H(row+1) - H(row)

    🚨 空白格防漂移規則（最高優先）：
    當目標格內沒有任何學生手寫內容（空白格）時，你仍然必須將 answerBbox 放在該空白格的正確位置上。
    嚴禁因為目標格是空白的，就把 bbox 漂移到相鄰的有內容的格子。
    bbox 的位置由座標決定，與格內是否有內容完全無關。

    ⚠️ 自我驗證：輸出 bbox 後，確認 bbox.x 與 refBbox.x 的差距不超過 0.02。若差距過大，代表定位錯誤，應優先採用 refBbox.x。

    8. Output tablePositionReasoning (MANDATORY): format: "refBbox.x=X, applied x=Y. Target col=N → [header]. bbox=[x,y,w,h]"
- For visible=true questions with question_context/group_context, output answerBbox that frames the FULL QUESTION CONTEXT so a teacher can see the entire question at a glance:
  - ${isAnswerOnly ? 'Include the question number and the student\'s answer blank area within the bbox. There is no question stem text on answer-only sheets.' : 'Include the question number, question stem text, AND the student\'s answer area all within the bbox.'}
  - For map_draw, diagram_draw, and diagram_color: frame the entire diagram/map/grid area plus any visible question stem above it.
  - For word_problem and calculation: frame from the question stem down through all formula lines and the final answer. If the calculation question has a table cell (student fills a value in a table) AND a work/formula area elsewhere on the page, the answerBbox must cover BOTH the table cell AND the work area — do NOT crop just the table cell alone.
  - For fill_blank sub-questions (questionId has 3+ segments, e.g. "1-2-1", "1-2-2", "1-2-3"): each sub-question maps to ONE specific blank box. answerBbox must be a TIGHT crop of ONLY that single blank box — do NOT include neighboring boxes. Sub-question bboxes MUST NOT overlap each other. If boxes are small and close together, make the bbox smaller rather than let it overlap an adjacent box. ANCHOR RULE (MANDATORY — takes priority): if the spec includes anchorHint, it is the AUTHORITATIVE locator for this question's cell. You MUST locate the exact cell described by the anchorHint and place the bbox precisely on that cell. TABLE COLUMN RULE: when the anchorHint references a column header (e.g. "標題『建功國中』正下方"), find that column header's horizontal position, then trace STRAIGHT DOWN to the target row. The answerBbox left and right edges MUST NOT extend beyond that column's boundaries — content from adjacent columns is FORBIDDEN. Each anchorHint uniquely identifies one cell; if your bbox could plausibly contain content from a neighboring column, it is WRONG — shrink it. Only fall back to ORDERING RULE when no anchorHint is provided. ORDERING RULE (fallback only): assign sub-question IDs in strict TOP-TO-BOTTOM order (primary), LEFT-TO-RIGHT within the same row (secondary). Do NOT re-order based on content — position is the only criterion. readBbox is NOT needed for sub-question fill_blank (answerBbox is already tight).
  - For fill_blank with a single blank (questionId has 1–2 segments, e.g. "3", "1-2"): frame the blank and surrounding question text for answerBbox. Additionally output readBbox: a TIGHT crop of ONLY the blank writing area, excluding the question stem text.
  - For single_choice / true_false: answerBbox must frame the student's answer area — the parentheses ( ) or bracket where the student writes their answer, plus a small margin on each side for tolerance. The bbox should be wide enough to fully capture the parentheses even if slightly misaligned, but should NOT extend to include the full question stem text or option content rows. Aim for roughly 25-35% of page width centered on the answer area.
  - For multi_choice / single_check / multi_check / multi_check_other: include the option rows where the student marks their selection (checkboxes, circles). Do NOT include the question stem text above the options.
  - For multi_fill: each sub-question maps to ONE specific blank box in the diagram. answerBbox must be a TIGHT crop of ONLY that single box — do NOT include neighboring boxes. Sub-question bboxes MUST NOT overlap each other. If boxes are small and close together, make the bbox smaller rather than let it overlap an adjacent box.
    ANCHOR RULE (MANDATORY — takes priority): if the spec includes anchorHint, it is the AUTHORITATIVE locator for this question's cell. You MUST locate the exact cell described by the anchorHint and place the bbox precisely on that cell. Do NOT place the bbox ON the landmark text itself; the landmark is a reference point to navigate to the correct answer cell. TABLE COLUMN RULE: when the anchorHint references a column header (e.g. "標題『建功國中』正下方"), find that column header's horizontal position, then trace STRAIGHT DOWN to the target row. The answerBbox left and right edges MUST NOT extend beyond that column's boundaries — content from adjacent columns is FORBIDDEN. Each anchorHint uniquely identifies one cell; if your bbox could plausibly contain content from a neighboring column, it is WRONG — shrink it. Only fall back to ORDERING RULE when no anchorHint is provided.
    ORDERING RULE (fallback only): When multi_fill boxes have no printed question numbers, assign sub-question IDs in strict TOP-TO-BOTTOM order (primary), LEFT-TO-RIGHT within the same row (secondary). The sub-question with the smallest id suffix (e.g. "2-1-1") MUST map to the topmost box; the next id ("2-1-2") to the next box below; and so on. Do NOT re-order based on visual importance or content — position is the only criterion.
  - For matching(group_context): include the entire left column + right column + connecting lines of the whole group.
  - The bbox must be ACCURATE and TIGHT (top-left corner = (x,y), width = w, height = h) using actual pixel proportions — do NOT output placeholder sizes.
  Format: { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 } where (x,y)=top-left corner, w=width, h=height, all normalized to [0,1].
  If the question region cannot be determined, omit answerBbox.
- answerBboxHint (Y-coordinate reference from answer key): When a question spec includes answerBboxHint { y, h }, it tells you the approximate Y position and height of this question's answer area on the answer key (same exam layout). Use this as a vertical anchor: your answerBbox.y should be CLOSE to the hint's y value. If your bbox is more than 0.02 away from the hint's y, double-check your positioning. This is especially important for single_choice FORMAT A (empty parentheses) — the hint's y points to the bracket row, not the option rows below it.
- For single_choice questions ONLY: also output bracketBbox that frames ONLY the printed bracket row "（option1，option2）" and the student's mark inside it — do NOT include the question stem text. This should be a very tight crop of just that one bracket line. Omit bracketBbox if this is FORMAT A (empty parentheses where student writes a symbol) or if the bracket row cannot be located precisely.
- Return strict JSON only.
${Array.isArray(classifyCorrections) && classifyCorrections.length > 0 ? `
⚠️ BBOX POSITIONING REMINDER:
The following questions need extra attention on answerBbox positioning:
${classifyCorrections.map((c) => {
  if (c.type === 'neighbor_match') {
    return `- 題目 ${c.questionId}：此題的 answerBbox 可能偏移到了相鄰題目 ${c.neighborId} 的空格。請仔細區分這兩題的空格位置，確保各題框選到各自正確的空格。`
  } else if (c.type === 'consecutive_blank') {
    return `- 題目 ${c.questionId}：此題需特別注意 answerBbox 定位，請確保框選到學生的書寫區域，不要遺漏細小或淺色的筆跡。`
  } else if (c.type === 'type_mismatch') {
    return `- 題目 ${c.questionId}：此題需特別注意 answerBbox 定位，確保框選的是正確的空格位置，不要框到相鄰的空格或題目區域。`
  }
  return `- 題目 ${c.questionId}：請特別注意此題的 answerBbox 定位準確性。`
}).join('\n')}
` : ''}
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
      "readBbox": { "x": 0.35, "y": 0.22, "w": 0.25, "h": 0.05 },
      "bracketBbox": { "x": 0.1, "y": 0.26, "w": 0.25, "h": 0.025 },
      "tablePositionReasoning": "table found at x=0.04-0.49. col1=比率(row label), col2=光武國中, col3=建功國中, col4=實驗中學... Target col=3 → 建功國中. bbox=[0.18,0.07,0.06,0.01]"
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
  - For single_check / multi_check / multi_check_other: include all checkbox options and the student's marks (including any text written next to the last 其他 option).
  - For map_draw / diagram_draw / diagram_color: include the entire drawn/colored area plus the question stem.
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

// 判斷 multi_fill 的符號集類型
function detectMultiFillCodeSet(correctAnswer) {
  const answer = ensureString(correctAnswer, '').trim()
  if (!answer) return 'bopomofo' // 預設注音
  // 英文字母（A、B、C 或 A,B,C）
  if (/^[A-Za-z]([、，,\s]+[A-Za-z])*$/.test(answer)) return 'letter'
  // 數字（1、2、3 或 ①②③）
  if (/^[\d①②③④⑤⑥⑦⑧⑨⑩]([、，,\s]+[\d①②③④⑤⑥⑦⑧⑨⑩])*$/.test(answer)) return 'number'
  // 注音符號
  if (/[ㄅ-ㄩ]/.test(answer)) return 'bopomofo'
  return 'general'
}

function buildFocusedMultiFillReadPrompt(questionId, codeSet = 'bopomofo') {
  let codeSetSection = ''
  let exampleAnswer = ''

  if (codeSet === 'bopomofo') {
    codeSetSection = `IMPORTANT — expected code set: codes in this type of question are almost always Bopomofo symbols from ㄅ to ㄎ only:
ㄅ ㄆ ㄇ ㄈ ㄉ ㄊ ㄋ ㄌ ㄍ ㄎ
If you see a symbol that resembles something outside this set, match it to the closest symbol within this set.

⚠️ CRITICAL LOOK-ALIKE PAIRS (check these before finalizing):
- ㄉ vs ㄌ: look at the TOP first — ㄉ has NOTHING at the top (completely clean); ㄌ has a small protrusion/bump sticking out at the top-left. This is the primary test; hook direction is secondary.
- ㄅ vs ㄋ: ㄅ is TWO SEPARATE strokes (short upper stroke + lower stroke hooking LEFT); ㄋ is ONE CONTINUOUS flow (horizontal top → straight down → curves RIGHT). If you see a clear break between upper and lower → ㄅ.`
    exampleAnswer = 'ㄅ、ㄇ、ㄉ'
  } else if (codeSet === 'letter') {
    codeSetSection = `IMPORTANT — expected code set: the student writes uppercase or lowercase English letters (A, B, C, D, E, F, G, H, ...).
Read each letter exactly as written. Do NOT interpret English letters as Bopomofo symbols (e.g. do NOT read "A" as "ㄅ").`
    exampleAnswer = 'A、C、E'
  } else if (codeSet === 'number') {
    codeSetSection = `IMPORTANT — expected code set: the student writes numbers (1, 2, 3, ...) or circled numbers (①, ②, ③, ...).
Read each number exactly as written. Output as regular digits (1, 2, 3), not circled numbers.`
    exampleAnswer = '1、3、5'
  } else {
    codeSetSection = `Read exactly what the student wrote — letters, numbers, or symbols.`
    exampleAnswer = 'A、3、ㄅ'
  }

  return `You are reading a CROPPED IMAGE of ONE MULTI-FILL question. The crop belongs to questionId "${questionId}" only.

Your task: read ALL codes/symbols the student wrote inside this box.
You do NOT know the correct answer and must NOT guess.

${codeSetSection}

Rules:
1) Transcribe EVERY code/symbol you see (e.g. "${exampleAnswer}").
2) Preserve the student's separators (、or ，). If codes are written with no separator, join them with 、.
3) Read ONLY what is inside this specific box. Do NOT read from neighboring boxes.
4) status="read" if any codes/text found inside the box.
5) status="blank" if the box is completely empty (no student writing).
6) status="unreadable" if too blurry/unclear to identify any symbol.

Return strict JSON only. No markdown.
{
  "answers": [
    {
      "questionId": "${questionId}",
      "studentAnswerRaw": "${exampleAnswer}",
      "status": "read|blank|unreadable"
    }
  ]
}`.trim()
}

function buildFocusedMultiFillReReadPrompt(questionId, codeSet = 'bopomofo') {
  // 非注音模式用簡化版 prompt（不需要筆劃分析）
  if (codeSet !== 'bopomofo') {
    const codeDesc = codeSet === 'letter'
      ? 'English letters (A, B, C, D, ...).\nRead each letter exactly. Do NOT interpret as Bopomofo.'
      : codeSet === 'number'
        ? 'numbers (1, 2, 3, ...) or circled numbers (①②③...). Output as regular digits.'
        : 'letters, numbers, or symbols. Read exactly what you see.'
    const example = codeSet === 'letter' ? 'A、C、E' : codeSet === 'number' ? '1、3、5' : 'A、3'
    return `You are reading a WIDE CROPPED IMAGE centered on ONE MULTI-FILL answer box. The crop belongs to questionId "${questionId}" only.

⚠️ WIDE CROP NOTICE: This image is intentionally wider than the answer box to provide context.
The target answer box is located in the CENTER of this image. Focus ONLY on the central region.

This box contains handwritten codes — ${codeDesc}

STEP 1 — Count how many distinct symbols you see in this box.
STEP 2 — For each symbol, read it exactly as written.

Rules:
- Transcribe EVERY code you see, joined by 、.
- Read ONLY what is inside the center box. Ignore neighboring boxes.
- status="read" if any codes found, "blank" if empty, "unreadable" if unclear.

Return strict JSON only. No markdown.
{
  "answers": [
    {
      "questionId": "${questionId}",
      "studentAnswerRaw": "${example}",
      "status": "read|blank|unreadable"
    }
  ]
}`.trim()
  }

  return `You are reading a WIDE CROPPED IMAGE centered on ONE MULTI-FILL answer box. The crop belongs to questionId "${questionId}" only.

⚠️ WIDE CROP NOTICE: This image is intentionally wider than the answer box to provide context.
The target answer box is located in the CENTER of this image. Focus ONLY on the central region.
Neighboring boxes or printed text near the edges are NOT part of this question — ignore them.

This box contains handwritten codes — Bopomofo (注音符號) phonetic symbols.

IMPORTANT — allowed symbol set: codes here are almost always from ㄅ to ㄎ only:
ㄅ ㄆ ㄇ ㄈ ㄉ ㄊ ㄋ ㄌ ㄍ ㄎ
Symbols outside this range (e.g. ㄘ, ㄣ, ㄙ, ㄒ …) should NOT appear.
If your stroke analysis leads you toward a symbol outside this set, re-examine — you have likely misidentified it. Find the closest match within ㄅ~ㄎ.

Your task: carefully identify each symbol using stroke-by-stroke analysis.

STEP 1 — Count how many distinct symbols you see in this box.
STEP 2 — For each symbol, briefly describe its key strokes.
STEP 3 — Match to the correct symbol within ㄅ~ㄎ using this confusion table:

ALLOWED SYMBOL DICTIONARY (ㄅ~ㄎ, 10 symbols total):
- ㄅ: straight vertical segment at top + leftward hook at bottom (two distinct parts)
- ㄆ: TWO parallel horizontal bars stacked + downward stroke on right
- ㄇ: three-sided box, OPEN AT BOTTOM (like a roof ∩)
- ㄈ: three-sided box, OPEN AT RIGHT
- ㄉ: top is completely CLEAN (nothing sticking out) + main stroke hooks to the LEFT at bottom
- ㄊ: like 十 (cross) — horizontal bar BISECTS the vertical in the MIDDLE, bottom curves right
- ㄋ: horizontal stroke at top + vertical going straight down, ends FLAT (like 丁, no hook)
- ㄌ: small PROTRUDING bump at top + goes down + hooks to the RIGHT at bottom
- ㄍ: two bent strokes
- ㄎ: like ㄅ (straight top + leftward hook) but with an EXTRA horizontal bar at the very top

You MUST output only symbols from this list. If your analysis leads to a symbol not in this list, re-examine and pick the closest match from the 10 above.

⚠️ HIGH-CONFUSION PAIRS — pay extra attention:

1) ㄅ vs ㄎ: both have vertical + leftward hook. ONLY difference: ㄎ has an extra horizontal bar at the very TOP.
2) ㄅ vs ㄉ: ㄅ has a clear straight segment before the hook; ㄉ top is clean but the whole stroke feels more like one flowing curve hooking LEFT.
3) ㄉ vs ㄌ: PRIMARY TEST — look at the TOP ONLY first:
  - Top is completely CLEAN, nothing sticking out → ㄉ (then confirm: hook at bottom goes LEFT)
  - Top has ANY small protrusion or bump at top-left, even tiny → ㄌ (then confirm: hook at bottom goes RIGHT)
  ⚠️ Trust the top over the hook. If the hook direction is ambiguous, the top is the final answer.
4) ㄋ vs ㄌ: ㄋ → horizontal bar at top + flat/straight bottom (NO hook). ㄌ → small bump at top + rightward hook at bottom.
7) ㄅ vs ㄋ:
  - ㄅ: TWO SEPARATE parts — a short upper segment (diagonal or short vertical), then a SECOND stroke that hooks LEFT at the bottom. Look for the break/angle between the two parts.
  - ㄋ: ONE CONTINUOUS stroke — horizontal top → straight down → curves RIGHT at the bottom. No break, flows continuously.
  - Primary test: two-stroke structure → ㄅ; single continuous flow → ㄋ. Secondary: LEFT hook → ㄅ; RIGHT curve → ㄋ.
5) ㄆ vs ㄊ: ㄆ → two PARALLEL bars (no crossing). ㄊ → one bar CROSSING through the vertical. Also: if it looks like ㄘ (bar only at top, no crossing) → re-examine, it is likely ㄊ.
6) ㄇ vs ㄈ: check which side is open — bottom open → ㄇ, right side open → ㄈ.

STEP 4 — List all identified symbols separated by 、.
STEP 5 — For each symbol, rate your confidence: HIGH (clearly identifiable) or LOW (ambiguous/unclear strokes). List any LOW-confidence symbols in uncertainChars.

Rules:
- Read ONLY what is inside the central box. Do NOT read neighboring boxes.
- status="read" if any symbols found.
- status="blank" if completely empty.
- status="unreadable" if too blurry to identify.
- uncertainChars: array of symbols you are NOT fully confident about (e.g. ["ㄌ"]). Empty array if all confident.

Return strict JSON only. No markdown.
{
  "answers": [
    {
      "questionId": "${questionId}",
      "studentAnswerRaw": "ㄅ、ㄇ、ㄉ",
      "status": "read|blank|unreadable",
      "uncertainChars": []
    }
  ]
}`.trim()
}

function buildFocusedCheckboxReadPrompt(questionId, questionType) {
  const normalizedType = ensureString(questionType, '').trim().toLowerCase()
  const isSingle = normalizedType === 'single_check'
  const isMultiOther = normalizedType === 'multi_check_other'
  const typeLabel = isSingle ? 'SINGLE-CHECK' : normalizedType === 'multi_choice' ? 'MULTI-CHOICE' : 'MULTI-CHECK'

  return `You are reading a CROPPED IMAGE of ONE ${typeLabel} question. The crop belongs to questionId "${questionId}" only.

Your task: detect which option(s) the student marked in this cropped question.
You do NOT know the correct answer and must NOT guess.

Output token rule (strict):
1) Output the 1-based position number of each checked box (count in reading order: left-to-right, top-to-bottom). Output "1" for 1st box, "2" for 2nd, etc.
2) NEVER output label text, printed symbols, or option content — only position numbers.
3) ${isSingle ? 'Output ONE number only.' : 'Output comma-separated numbers with NO spaces, preserving reading order.'}
4) If no visible mark for this question -> status="blank", studentAnswerRaw="未作答".
5) If marks are too unclear to determine -> status="unreadable", studentAnswerRaw="無法辨識".
${isMultiOther ? `6) OPEN-ENDED LAST OPTION: The LAST checkbox option is an open-ended "其他：___" field.
   - If the student checked the last option AND wrote text next to it, append the text after the number using "：" separator.
   - Example: if last option is the 4th box and student wrote "轉為文風鼎盛的社會", output as "4：轉為文風鼎盛的社會".
   - If checked but no text written, output the number normally (e.g. "4").
   - If not checked, omit it entirely (same as other options).` : ''}

Return strict JSON:
{
  "answers": [
    {
      "questionId": "${questionId}",
      "studentAnswerRaw": "${isSingle ? '2' : isMultiOther ? '1,3,4：學生手寫的其他內容' : '1,3'}",
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
  const multiFillIds = visibleQuestions
    .filter((q) => q.questionType === 'multi_fill')
    .map((q) => q.questionId)
  const multiCheckIds = visibleQuestions
    .filter((q) => q.questionType === 'multi_check')
    .map((q) => q.questionId)
  const multiCheckOtherIds = visibleQuestions
    .filter((q) => q.questionType === 'multi_check_other')
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
  const diagramColorIds = visibleQuestions
    .filter((q) => q.questionType === 'diagram_color')
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
  // 數字選項提示：正確答案是數字的選擇題，提示 AI 不要把數字讀成注音
  const akMap = options?.answerKeyQuestions
    ? mapByQuestionId(options.answerKeyQuestions, (item) => item?.id)
    : new Map()
  const numericChoiceIds = singleChoiceIds.filter((qId) => {
    const akQ = akMap.get(qId)
    const answer = ensureString(akQ?.answer || akQ?.referenceAnswer, '').trim()
    return /^\d+$/.test(answer)
  })
  const numericChoiceNote = numericChoiceIds.length > 0
    ? `\n⚠️ NUMERIC OPTION HINT: The following single-choice questions use NUMERIC options (1, 2, 3, 4...), NOT Bopomofo symbols. If you see handwriting that could be either a digit or a Bopomofo symbol (e.g. "3" vs "ㄋ", "1" vs "ㄌ"), always interpret it as a DIGIT: ${JSON.stringify(numericChoiceIds)}
⚠️ DIGIT STROKE VERIFICATION (for numeric single-choice ONLY):
When reading a handwritten digit inside parentheses ( ), FIRST describe the stroke features you see, THEN decide which digit it is. Do NOT guess based on what answer would be "correct".
Commonly confused digit pairs:
- 1: single vertical stroke | 7: horizontal top stroke + diagonal down-stroke
- 2: top curve bending RIGHT, flat horizontal bottom stroke | 3: TWO right-facing bumps (upper + lower), NO flat bottom stroke
- 5: top horizontal + vertical drop + bottom curve | 6: top curve descending left, closed loop at bottom
- 9: closed loop at top + descending stroke | 0: closed oval
Report your stroke observation in the "digitStrokeNote" field (1 sentence). Example: { "studentAnswerRaw": "3", "digitStrokeNote": "I see two right-facing curves stacked vertically, consistent with digit 3" }`
    : ''
  const trueFalseNote = trueFalseIds.length > 0
    ? `\nTRUE-FALSE questions (output ○ or ✗ only): ${JSON.stringify(trueFalseIds)}`
    : ''
  const mapFillNote = mapFillIds.length > 0
    ? `\nMAP-FILL questions (地圖填圖題): ${JSON.stringify(mapFillIds)}`
    : ''
  const multiFillNote = multiFillIds.length > 0
    ? `\nMULTI-FILL questions (多項填入題): ${JSON.stringify(multiFillIds)}`
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
    ? `\nMULTI-CHECK questions (多選勾選, output comma-separated 1-based position numbers of checked boxes — NEVER output label text or option content): ${JSON.stringify(multiCheckIds)}`
    : ''
  const multiCheckOtherNote = multiCheckOtherIds.length > 0
    ? `\nMULTI-CHECK-OTHER questions (多選勾選含其他, same as MULTI-CHECK but LAST option is open-ended "其他：___"; output 1-based position numbers; if 其他 is checked AND has written text, append "：[text]" to that number, e.g. "1,3,4：轉為文風鼎盛的社會"): ${JSON.stringify(multiCheckOtherIds)}`
    : ''
  const multiChoiceNote = multiChoiceIds.length > 0
    ? `\nMULTI-CHOICE questions (多選選擇, output comma-separated option symbols written inside parentheses; e.g. "A,C" or "①,③"): ${JSON.stringify(multiChoiceIds)}`
    : ''
  const singleCheckNote = singleCheckIds.length > 0
    ? `\nSINGLE-CHECK questions (單選勾選, output the 1-based position number of the checked box: "1" for the 1st box, "2" for the 2nd, etc. — NEVER output label text or option content): ${JSON.stringify(singleCheckIds)}`
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
    ? `\nDIAGRAM-DRAW questions (圖表繪製題, describe drawn chart with label-value pairs): ${JSON.stringify(diagramDrawIds)}`
    : ''
  const diagramColorNote = diagramColorIds.length > 0
    ? `\nDIAGRAM-COLOR questions (塗色題, describe coloring regions and proportions): ${JSON.stringify(diagramColorIds)}`
    : ''
  const matchingNote = matchingIds.length > 0
    ? `\nMATCHING questions (連連看, read ALL pairs as a group): ${JSON.stringify(matchingIds)}`
    : ''

  // Per-question answer bbox hints (from classify + answer key): help AI locate each answer area
  const questionsWithBbox = visibleQuestions.filter((q) => q.answerBbox)
  const bboxHintNote = questionsWithBbox.length > 0
    ? `\n\n== ANSWER AREA LOCATION HINTS ==\nFor the following questions, the answer area is approximately at these normalized coordinates (x/y=top-left, w/h=width/height, all 0-1):\n${questionsWithBbox.map((q) => `- "${q.questionId}": x=${q.answerBbox.x.toFixed(3)}, y=${q.answerBbox.y.toFixed(3)}, w=${q.answerBbox.w.toFixed(3)}, h=${q.answerBbox.h.toFixed(3)}`).join('\n')}\nUse these as a guide to locate the student's answer space, but always verify by looking at the image.`
    : ''

  // Table cell column hints: tell ReadAnswer which column header each table question belongs to
  const akQuestionMap = options?.answerKeyQuestions
    ? mapByQuestionId(options.answerKeyQuestions, (item) => item?.id)
    : new Map()
  const tableCellHints = visibleQuestions
    .filter((q) => {
      const akQ = akQuestionMap.get(q.questionId)
      return akQ?.tablePosition && akQ?.anchorHint
    })
    .map((q) => {
      const akQ = akQuestionMap.get(q.questionId)
      return `- "${q.questionId}": 此格位於表格 col=${akQ.tablePosition.col}。${akQ.anchorHint}。若裁切圖頂部可見欄標題文字，請確認標題與此描述一致。若看到的標題是其他欄位名稱，代表裁切圖偏移，格線內側若無手寫內容則回報 blank。`
    })
  const tableCellHintNote = tableCellHints.length > 0
    ? `\n\n== TABLE CELL COLUMN HINTS ==\n以下題目是表格中的格子，裁切圖可能包含欄標題和格線。請用欄標題確認你讀的是正確的格子：\n${tableCellHints.join('\n')}`
    : ''

  return `
You are an answer reader. Your only job is to report what the student physically wrote or drew in each question's designated answer space. You have NO mathematical knowledge and must NOT solve, infer, or guess.

Visible question IDs on this image:
${JSON.stringify(visibleIds)}
${singleChoiceNote}${numericChoiceNote}${trueFalseNote}${multiCheckNote}${multiCheckOtherNote}${multiChoiceNote}${singleCheckNote}${fillBlankNote}${calculationNote}${wordProblemNote}${diagramDrawNote}${diagramColorNote}${matchingNote}${mapDrawSymbolNote}${mapDrawGridNote}${mapDrawConnectNote}${bboxHintNote}${tableCellHintNote}

== ANTI-HALLUCINATION (absolute rule, cannot be overridden) ==
You do NOT know what the correct answer is. You do NOT know what the student intended to write.
NEVER output an answer based on:
- what you think the correct answer should be
- the question stem or context clues
- answers you see in neighboring questions
- printed option labels (A B C D 甲乙丙丁) that the student did NOT mark
You may ONLY output what is physically, visibly written by the student's own hand.
If the answer space is empty → blank. There are NO exceptions.

== INK COLOR RULE (critical) ==
The student writes in BLUE or BLACK ink (pencil). The teacher corrects in RED ink.
- ONLY read the student's BLUE/BLACK ink marks. This is the student's original answer.
- IGNORE all RED ink marks — these are the teacher's corrections/marks added AFTER the student submitted.
- If you see both red and blue/black writing in the same area, ONLY report the blue/black writing.
- Common red ink marks to ignore: circled correct answers, check marks (✓/✗), score numbers, correction notes.
- If the student's blue/black answer is crossed out by the student (self-correction with blue/black ink), read the final version the student intended.

== BLANK FIRST RULE ==
Before reading each question, ask yourself: "Is there fresh handwriting in this question's answer space?"
- Answer space = the designated writing area: ( ), ___, □, or the answer line after "答:" "A:" "Ans:", or the entire work area for calculation/drawing questions.
- If no fresh handwriting is present → status="blank", studentAnswerRaw="未作答". STOP. Do not read further.
- Pre-printed content (labels, underlines, boxes, option letters A/B/C/D, artwork) does NOT count.
- Only FRESH student BLUE/BLACK pen/pencil marks count. RED ink is the teacher's, not the student's.

🚨 TABLE CELL EDGE RULE (applies to fill_blank questions in tables):
When reading a tightly-cropped table cell, look for VERTICAL GRID LINES (直線) inside the crop image.
- If you see a vertical grid line: that line is the cell boundary. Content on the OTHER SIDE of that line belongs to an adjacent cell — do NOT read it.
  - Vertical line near the LEFT edge: only read content to the RIGHT of that line.
  - Vertical line near the RIGHT edge: only read content to the LEFT of that line.
  - Vertical lines on BOTH sides: only read content BETWEEN the two lines.
- If the area between the grid lines (or in the center of the crop if no lines are visible) is empty → status="blank", studentAnswerRaw="未作答".
- Numbers or text visible beyond a grid line are the NEIGHBOR's answer, not this question's. Reading them would cause cascading errors across all table questions.

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
8. ABSOLUTELY FORBIDDEN — Character substitution:
   Do NOT replace a written character with one that looks similar, sounds similar, or "makes more sense" in context.
   Output exactly what is physically written, even if:
   - It appears to be a typo (e.g. student wrote 它們 → output 它們, do NOT change to 他們)
   - It seems grammatically wrong (e.g. student wrote 心裡 → output 心裡, do NOT change to 心理)
   - A different character would be more "correct" (e.g. student wrote 仇恨 → output 仇恨, do NOT change to 仇視)
   Your job is to report what the student physically wrote, not what they should have written.
9. INSERTION MARK (插入符號 ∧ or 入-shape):
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
- Answer space is CHECKBOX □ — output the 1-based position number of the single checked box.
- Count boxes in reading order (left-to-right, top-to-bottom). Output "1" for the 1st box, "2" for the 2nd, etc.
- ABSOLUTELY FORBIDDEN: outputting any label text, printed symbols, or option content. Output ONLY the number.
- If no box is marked → blank.

MULTI-CHECK (questions in MULTI-CHECK list):
- Answer space is CHECKBOXES □ — output comma-separated 1-based position numbers of the checked boxes, in reading order (left-to-right, top-to-bottom).
- Output "1" for the 1st box, "2" for the 2nd, etc. Example: "1,3" if 1st and 3rd are checked.
- ABSOLUTELY FORBIDDEN: outputting any label text, printed symbols, or option content. Output ONLY numbers.

MULTI-CHECK-OTHER (questions in MULTI-CHECK-OTHER list):
- Same as MULTI-CHECK but the LAST checkbox option is an open-ended "其他：___" field.
- For regular options: output their 1-based position number normally.
- For the 其他 (last) option:
  - If checked AND student wrote text next to it: output "N：[text]" (e.g. "4：轉為文風鼎盛的社會").
  - If checked but no text written: output just the number (e.g. "4").
  - If not checked: omit it.
- Example: "1,3,4：轉為文風鼎盛的社會" (1st and 3rd regular options + 其他 with text).

FILL-BLANK (questions in FILL-BLANK list):
- Output ONLY handwritten content inside each blank, comma-separated left-to-right top-to-bottom.
- Empty blank → "_". Unreadable blank → "?". All blanks empty → status="blank".
- FORBIDDEN: surrounding printed text ("答", underline markers).
- 🚨 MATH FILL-BLANK RULE (數學填充題):
  For math fill-in-the-blank questions, students often write auxiliary calculations (輔助計算/草稿) next to or near the blank — such as vertical arithmetic (直式), scratch formulas, or intermediate steps.
  IGNORE all auxiliary calculations. Read ONLY the final answer written INSIDE the parentheses ( ) or blank line ___.
  The auxiliary work is the student's scratch process and is NOT part of the answer.
  Example: student wrote "25×4=100" as scratch work nearby, and filled "100" inside the ( ) → output "100" only.
- 🚨 ENGLISH SPELLING RULE (for English domain fill_blank):
  DO NOT auto-correct spelling. Copy each letter EXACTLY as the student wrote it.
  "dinng" stays "dinng" (NOT "dining"). "kitchan" stays "kitchan" (NOT "kitchen").
  You are an OCR scanner with ZERO language knowledge — you cannot recognize English words.
  Additionally, output a "rawSpelling" field: spell out every letter separated by dashes.
  Example: student wrote "dinng room" → studentAnswerRaw="dinng room", rawSpelling="d-i-n-n-g r-o-o-m".
  This forces you to examine each letter individually. If rawSpelling disagrees with studentAnswerRaw, rawSpelling is authoritative.

CALCULATION (questions in CALCULATION list):
- 🚨 LINE-BY-LINE TRANSCRIPTION (absolute rule):
  Scan the student's work area from TOP to BOTTOM. For each PHYSICAL LINE of handwriting, output exactly what that line contains. Separate lines with "\\n" (newline) in studentAnswerRaw.
  - Each physical line of handwriting = one output line. Do NOT merge multiple lines into one. Do NOT split one line into multiple.
  - The number of output lines MUST MATCH the number of physical handwritten lines visible in the image.
  - FORBIDDEN: inserting steps the student did not write. If the student jumped from step A directly to step C, output A and C only — do NOT insert step B.
  - FORBIDDEN: rewriting or reorganizing the student's work in a "cleaner" or "more logical" order.
  - You are a line-by-line photocopier. You have ZERO math knowledge. You cannot tell if a step is "missing" because you do not understand math.
- Copy exactly as written: "25×6=150" → output "25×6=150"; wrong calc "6+3=8" → output "6+3=8".
- Include the final answer line if present (e.g. "答: 150" or just "= 150").
- STRIP printed question labels: do NOT include any printed label that appears before the student's formula (e.g. "東北亞：", "A：", "B：", "①：", "(1)"). Output only from the first digit, operator, or bracket of the student's written content.
- If the work area is blank (no fresh marks) → status="blank".
- SELF-CORRECTION (student crossed out with blue/black ink): If a line is crossed out by the student, SKIP that line entirely. Read only the final version the student intended.
- VERTICAL FORMAT (直式): If the student uses a vertical layout (直式加/減/乘/除), convert it to a horizontal equation for output. This counts as ONE output line. Copy the student's written numbers exactly — do NOT recalculate or correct errors.
  - 直式除法: identify dividend (被除數), divisor (除數), quotient (商), remainder (餘數 if any). Output as "[dividend]÷[divisor]=[quotient]" or "[dividend]÷[divisor]=[quotient]…[remainder]" if remainder > 0.
  - 直式乘法: identify multiplicand, multiplier, product. Output as "[multiplicand]×[multiplier]=[product]".
  - 直式加法/減法: output as "[top]±[bottom]=[result]".
  - CRITICAL: Copy the student's written numbers as-is. If the student wrote a wrong quotient (e.g. 25 instead of 26), output 25. NEVER verify or correct the arithmetic.
- Example (3-line student work):
  Student wrote three lines:
    1/2×2/3+2/3
    =3/3
    =1
  Output: studentAnswerRaw = "1/2×2/3+2/3\\n=3/3\\n=1" (3 lines, matching 3 physical lines)
  WRONG output: "1/2×2/3+2/3 = 1/3+2/3 = 1" (merged into 1 line, inserted a step "1/3+2/3" that student never wrote)

WORD-PROBLEM (questions in WORD-PROBLEM list):
- 🚨 LINE-BY-LINE TRANSCRIPTION: Same rule as CALCULATION — scan top to bottom, one output line per physical handwritten line, separated by "\\n". Output line count must match physical line count.
- FORBIDDEN: inserting steps, merging lines, or reorganizing the student's work.
- Include the final answer sentence if present (e.g. "答: 小明走了120公尺").
- If the work area is blank (no fresh marks) → status="blank".
- VERTICAL FORMAT (直式): Same conversion rule as CALCULATION above — convert 直式 to horizontal equation (counts as one line), copy student's numbers faithfully without correction.

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
${multiFillNote ? `
MULTI-FILL RULE (多項填入題):
- For question IDs in MULTI-FILL list, each question is ONE specific blank box in a diagram/map.
- The answer bbox for each question points to that specific box — read ONLY what is written inside that box.
- Transcribe ALL codes/symbols the student wrote in the box (e.g., "ㄅ、ㄇ、ㄉ"), faithfully and completely.
- Output format: exactly what the student wrote, preserving the separator (、or ，).
- Do NOT infer or guess missing codes. Do NOT read from neighboring boxes.
- status="read" if any handwritten codes found, status="blank" if box is empty.
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
DIAGRAM-DRAW RULE (圖表繪製題):
For question IDs in DIAGRAM-DRAW list, the student drew a chart (bar chart, pie chart, etc.) with labels and values.
- Read ALL label-value pairs the student drew or wrote on the chart.
- For pie charts: output each sector as "標籤 角度/百分比" (e.g. "番茄汁 80°, 紅蘿蔔汁 60°, 蘋果汁 40°").
- For bar charts: output each bar as "標籤 高度/數值" (e.g. "一月 50, 二月 30, 三月 45").
- List ALL sectors/bars the student drew, in reading order.
- If no fresh drawn marks → status="blank", studentAnswerRaw="未作答".
- FORBIDDEN: inferring labels or values not physically written by the student.
` : ''}
${diagramColorNote ? `
DIAGRAM-COLOR RULE (塗色題):
For question IDs in DIAGRAM-COLOR list, describe ONLY fresh student coloring/shading marks on pre-printed figures.
- Report only what the student colored — do NOT describe uncolored regions unless needed for context.
- FIXED TEMPLATE: "塗色：[描述塗色範圍]"
  - For circles/fraction diagrams: describe which circles are fully/partially colored, what fraction, AND which side/region.
    Example: "塗色：第1個圓完整，第2個圓左側2/3，第3個圓未塗"
  - For fraction bars/grids: describe how many cells are colored AND their position (left/right/which cells).
    Example: "塗色：10格中的7格（左側連續7格）"
  - For other shapes: describe the colored region using spatial words (左側/右側/上方/下方/中間).
- Position matters: always describe WHICH region was colored, not just how much.
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
      "formatBReasoning": "only for FORMAT B questions: step-by-step spatial reasoning (omit for all other question types)",
      "rawSpelling": "d-i-n-n-g r-o-o-m (English fill_blank only: spell out every letter with dashes, spaces between words)"
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
const BOPOMOFO_ARBITER_GUIDE = `
⚠️ MULTI-FILL 注音裁決指引（適用於 questionType=multi_fill 的題目）：
這類題目的答案是注音符號代號（ㄅ~ㄎ），手寫時容易辨識錯誤。裁決時請依據以下字典判斷：

允許的符號（ㄅ~ㄎ，共10個）：
- ㄅ: 上方直線段＋底端向左勾（兩段式）
- ㄆ: 兩條平行橫畫疊加＋右側向下筆畫
- ㄇ: 三邊框，底部開口（像屋頂∩）
- ㄈ: 三邊框，右側開口
- ㄉ: 頂端完全乾淨（無突出）＋底端向左勾
- ㄊ: 像「十」字，橫畫貫穿垂直線中間，底端向右彎
- ㄋ: 頂端橫畫＋垂直往下平收（像丁，底端無勾）
- ㄌ: 頂端有突出小撇＋底端向右勾
- ㄍ: 兩個彎折筆畫
- ㄎ: 像ㄅ但頂端多一條橫畫

高混淆對（裁決時特別注意）：
1. ㄅ vs ㄎ：都是直線＋左勾，差別只在 ㄎ 頂端多一橫
2. ㄉ vs ㄌ：【主要判斷：看頂端】ㄉ 頂端完全乾淨（什麼都沒有）→ ㄉ；頂端有任何突出小撇（再小也算）→ ㄌ。鉤的方向是次要確認（ㄉ左勾、ㄌ右勾）。
3. ㄅ vs ㄋ：ㄅ 是兩段式（上方短撇＋下方左鉤），兩段之間有明顯斷點或折角；ㄋ 是一筆連續（頂端橫畫→直下→右彎），無斷點。主要測試：看到明顯斷點→ㄅ；一筆流暢→ㄋ。
4. ㄆ vs ㄊ：ㄆ 是兩條平行橫畫；ㄊ 是橫畫貫穿垂直線
5. ㄋ vs ㄌ：ㄋ 底端平收無勾；ㄌ 底端向右勾
6. ㄇ vs ㄈ：看哪一側開口
`.trim()

function buildArbiterPrompt(arbiterItems) {
  // arbiterItems: [{ questionId, questionType, ai1Answer, ai1Status, ai2Answer, ai2Status, agreementStatus, disagreementReason, correctAnswer? }]
  const hasMultiFill = arbiterItems.some((item) => item.questionType === 'multi_fill')
  const hasEnglishSpelling = arbiterItems.some((item) => item.correctAnswer)
  const questionBlocks = arbiterItems.map((item) => {
    const ai1Str = item.ai1Status === 'blank' ? '（空白）' : item.ai1Status === 'unreadable' ? '（無法辨識）' : `「${item.ai1Answer}」`
    const ai2Str = item.ai2Status === 'blank' ? '（空白）' : item.ai2Status === 'unreadable' ? '（無法辨識）' : `「${item.ai2Answer}」`
    const isAgree = item.agreementStatus === 'agree'
    const modeNote = isAgree
      ? 'mode: agree_review（兩者等價後相同）→ 請評估 agreementSupport'
      : 'mode: disagree_review（兩者等價後不同）→ 請分別評估 ai1Support 與 ai2Support'
    const uncertainNote = item.disagreementReason === 'uncertain_chars'
      ? '\n  ⚠️ 注意：AI2 對部分字符信心不足（uncertain_chars），即使表面相同也請仔細確認筆跡'
      : ''
    const spellingNote = item.correctAnswer
      ? `\n  📝 英語拼寫舉證：正確答案＝「${item.correctAnswer}」→ 請執行逐字母比對（見下方英語拼寫鑑識規則）`
      : ''
    return `題目 ${item.questionId}（類型：${item.questionType}）
  AI1（細節）讀到：${ai1Str}（status: ${item.ai1Status}）
  AI2（全局派）讀到：${ai2Str}（status: ${item.ai2Status}）
  ${modeNote}${uncertainNote}${spellingNote}
  [此題裁切圖緊接在下方]`
  }).join('\n\n---\n\n')

  return `你是學生答案讀取的鑑識人員（AI3）。
你將看到：完整作業圖（第一張圖）以及每道題的 answerBbox 裁切圖（每題一張，附標籤），
以及 AI1（細節派）和 AI2（全局派）各自以裁切圖讀取的結果。

你的任務是【鑑識】，不是裁決、不是重新讀取：
- 針對每道題，評估圖像對 AI1 和 AI2 各自讀取值的支持程度。
- 最終決定由系統根據你的評估自動執行，你只需如實回報圖像支持強度。

支持程度（support）定義：
  "strong"     ：有明確、清晰的圖像特徵支持此讀取值（可指出具體筆跡位置或形狀）
  "weak"       ：有部分支持，但圖像模糊、字跡不清，或有疑慮，無法完全放心
  "unsupported"：缺乏關鍵圖像依據，或圖像與讀取值明顯矛盾

鑑識規則：
情境 A — agree_review（AI1 與 AI2 讀取相同）：
  → 評估這個共識是否有圖像支持
  → 輸出：{ "mode": "agree_review", "agreementSupport": "strong | weak | unsupported" }
  → ⚠️ 不得因「兩者相同」就草率給 strong，必須確實觀察到筆跡依據
  → ⚠️ 特例：若兩者讀出的答案為【單一字元】（如 ×、−、○、C、A 等英文字母或符號），
       只要圖片中能見到任何手寫痕跡，必須給 weak 或以上，不得給 unsupported。
       單字元筆跡面積本就小，難以找到「明確筆跡依據」是正常現象，不應因此降為 unsupported。

情境 B — disagree_review（AI1 與 AI2 讀取不同）：
  → 分別獨立評估 AI1 和 AI2 各自的圖像支持程度，兩者互不影響
  → 輸出：{ "mode": "disagree_review", "ai1Support": "strong | weak | unsupported", "ai2Support": "strong | weak | unsupported" }
  → ⚠️ 即使你傾向支持一方，另一方也要誠實評估，不得為了強化結論而壓低另一方

⚠️ 若圖像不清晰、筆跡無法確認 → 降評為 weak 或 unsupported，不得勉強給 strong。
⚠️ 你不需要也不應該自行產生答案或做最終選擇。

${hasMultiFill ? BOPOMOFO_ARBITER_GUIDE + '\n' : ''}${hasEnglishSpelling ? `英語拼寫鑑識規則（適用於標有「📝 英語拼寫舉證」的題目）：
當題目附有正確答案時，你必須額外執行以下逐字母比對程序：

1. 逐字母拆解：觀察裁切圖中學生的手寫，從左到右逐一辨識每個字母，記為 studentLetters（用 dash 分隔，如 d-i-n-n-g）。
   ⚠️ 嚴禁自動修正：看到什麼寫什麼。學生寫 "dinng" 就記 "d-i-n-n-g"，不可記成 "d-i-n-i-n-g"。
2. 正確答案拆解：將正確答案同樣逐字母拆解，記為 correctLetters（如 d-i-n-i-n-g）。
3. 差異比對：逐位置比較 studentLetters 與 correctLetters，找出：
   - 多餘字母（student 有但 correct 沒有）
   - 缺少字母（correct 有但 student 沒有）
   - 替換字母（同位置但不同字母）
   - 順序錯誤（字母相同但位置不對）
4. 判定：
   - 若發現任何拼寫差異 → 在 spellingEvidence 中列出差異，並將 support 降為 "weak"（agree 模式下降 agreementSupport，disagree 模式下降對應方的 support）。
   - 若 AI1 和 AI2 讀出的拼寫與圖片不符（例如都讀成正確拼寫但圖片明顯拼錯）→ support 降為 "unsupported"。
   - 若逐字母比對確認無差異 → 正常評估 support。

⚠️ 常見陷阱：AI 語言模型傾向自動修正拼字（如把 "dinng" 讀成 "dining"）。你必須抵抗這個傾向，仔細看每一個字母的實際筆跡。
⚠️ 大小寫也要注意：如正確答案首字母大寫 "Kitchen"，但學生寫 "kitchen"（小寫 k），視為差異。
` : ''}需鑑識的題目如下（全圖在最前，各題裁切圖依序附在題目說明之後）：

${questionBlocks}

輸出 JSON，格式如下（每道題擇一情境）：
{
  "forensics": [
    { "questionId": "...", "mode": "agree_review", "agreementSupport": "strong | weak | unsupported" },
    { "questionId": "...", "mode": "disagree_review", "ai1Support": "strong | weak | unsupported", "ai2Support": "strong | weak | unsupported" }
  ]
}
${hasEnglishSpelling ? `若題目有英語拼寫舉證，請在該題的 forensic 物件中額外加入 spellingEvidence：
{ "questionId": "...", "mode": "agree_review", "agreementSupport": "weak",
  "spellingEvidence": { "studentLetters": "d-i-n-n-g", "correctLetters": "d-i-n-i-n-g", "differences": ["position 4: student='n', correct='i'", "student has 5 letters, correct has 6"] } }
spellingEvidence 僅在發現差異時必填，無差異時可省略。` : ''}`.trim()
}

// Apply forensic decision table to produce arbiterStatus + finalAnswer
function applyForensicDecision(forensic, ai1Answer, ai2Answer) {
  const mode = ensureString(forensic?.mode, '')
  if (mode === 'agree_review') {
    if (forensic.agreementSupport === 'strong' || forensic.agreementSupport === 'weak') {
      // strong: AI3 明確確認圖片支持此讀取結果
      // weak: AI3 認為圖片稍微模糊，但兩個獨立 AI 讀出相同答案本身就是強證據，放行
      return { arbiterStatus: 'arbitrated_agree', finalAnswer: ai1Answer }
    }
    // unsupported: AI3 認為圖片不支持此讀取
    // 豁免：單字元答案（×、−、C、A 等）→ 兩個獨立 AI 讀出相同本身就是強證據，不送審
    if (ai1Answer.trim().length <= 1) {
      return { arbiterStatus: 'arbitrated_agree', finalAnswer: ai1Answer }
    }
    return { arbiterStatus: 'needs_review' }
  }
  if (mode === 'disagree_review') {
    const ai1Support = ensureString(forensic.ai1Support, '')
    const ai2Support = ensureString(forensic.ai2Support, '')
    if (ai1Support === 'strong' && ai2Support === 'unsupported') {
      return { arbiterStatus: 'arbitrated_pick_1', finalAnswer: ai1Answer }
    }
    if (ai2Support === 'strong' && ai1Support === 'unsupported') {
      return { arbiterStatus: 'arbitrated_pick_2', finalAnswer: ai2Answer }
    }
    return { arbiterStatus: 'needs_review' }
  }
  return { arbiterStatus: 'needs_review' }
}

function buildAccessorPrompt(answerKey, readAnswerResult, domainHint) {
  const strictness = answerKey?.strictness || 'standard'
  const strictnessRule =
    strictness === 'strict'
      ? 'GRADING STRICTNESS: STRICT — For objective categories (single_choice, true_false, fill_blank, fill_variants, single_check, multi_check, multi_choice), enforce exact correctness per category rules. For rubric categories (calculation, word_problem, short_answer, map_draw, diagram_draw, diagram_color), judge by rubric dimensions and mathematical/concept correctness; do NOT require literal format matching unless the category rule explicitly requires it.'
      : strictness === 'lenient'
        ? 'GRADING STRICTNESS: LENIENT — Accept the answer if the core meaning is correct, even if phrasing, word order, or minor formatting differ. However, unit substitution (e.g. 公尺 for 公分) is still wrong even in lenient mode for fill_blank and word_problem questions. Exception: unit pairs listed in the UNIT EQUIVALENCE TABLE below are always treated as identical.'
        : 'GRADING STRICTNESS: STANDARD — Accept minor variations (synonyms, commutative factor order, equivalent units per the UNIT EQUIVALENCE TABLE below) but reject wrong meaning, wrong numbers, wrong key terms, or different units.'
  const lenientFocusPolicy =
    strictness === 'lenient'
      ? `LENIENT FOCUS POLICY (only when strictness = lenient):
- calculation: prioritize 最終答案. If final numeric result is correct, allow full score even when process writing is incomplete/non-standard.
- short_answer when Domain is "社會" or "自然": prioritize 核心結論. If core conclusion is semantically correct, allow full score even when supporting evidence is brief.
- This policy must NOT be applied when strictness is strict/standard.`
      : ''

  // 英語領域專屬規則（直接從 answerKey 讀，不依賴 domainHint）
  const englishRules = answerKey?.englishRules
  const hasEnglishRules = englishRules?.punctuationCheck?.enabled || englishRules?.wordOrderCheck?.enabled
  let englishRulesSection = ''
  if (hasEnglishRules || (domainHint || '').includes('英語')) {
    const rules = []
    // 大小寫一致（強制）
    rules.push('CASE SENSITIVITY (mandatory): For fill_blank and short_answer, the student\'s answer must match the correctAnswer\'s capitalization exactly. Each word with wrong capitalization (e.g. "apple" instead of "Apple") = deduct 1 point. errorType=\'spelling\'.')
    // 標點符號檢查（老師選擇）
    if (englishRules?.punctuationCheck?.enabled) {
      const d = englishRules.punctuationCheck.deductionPerError || 1
      rules.push(`PUNCTUATION CHECK (enabled): For fill_blank and short_answer, check sentence-ending punctuation (? . !) and apostrophes in contractions (e.g. don't, it's). Each missing or wrong punctuation = deduct ${d} point(s). Deduct until score reaches 0. errorType='spelling'.`)
    }
    // 單字順序/缺漏檢查（老師選擇）
    if (englishRules?.wordOrderCheck?.enabled) {
      const d = englishRules.wordOrderCheck.deductionPerError || 1
      rules.push(`WORD ORDER CHECK (enabled): For fill_blank and short_answer, if the student's words are in the wrong order or a word is missing compared to the correctAnswer, each word-order error or missing word = deduct ${d} point(s). Deduct until score reaches 0. Example: "Where your brother?" (missing "is") = -${d}; "Where your brother is?" (wrong order) = -${d}. errorType='concept'.`)
    }
    // 拼寫評分規則（強制）— 依正確答案字數區分短單詞 vs 句子
    rules.push(`SPELLING SCORING (mandatory): For fill_blank, first count the number of words in correctAnswer to determine the scoring mode:

【SHORT WORD MODE】(correctAnswer has 1-2 words, e.g. "kitchen", "dining room"):
Focus: does the student know the word?
- SPACING ERROR — WRONG SPACE IN SINGLE WORD (correct letters but student inserted a space inside one word, e.g. "bath room" → "bathroom", "din ing" → "dining"): student does not know the word boundary → score = 0. This is NOT a minor error.
- SPACING ERROR — MISSING SPACE IN TWO-WORD ANSWER (correct letters but student omitted the space between two words, e.g. "diningroom" → "dining room"): minor → deduct 1 point.
- MISSPELLING (wrong/extra/missing letters, e.g. "writeing" → "writing", "kitchan" → "kitchen"): student cannot spell → score = 0.

【SENTENCE MODE】(correctAnswer has 3+ words, e.g. "Dad is cooking in the kitchen."):
Focus: can the student construct the sentence?

STEP 1 — CHECK WORDS FIRST: Compare the SET of words (ignoring order and punctuation) between student and correctAnswer.
  - If the student used ALL the same words, just in different order → this is PURELY a word order issue. Do NOT report missing/extra words.
  - Only report MISSING WORD if a word in correctAnswer does not appear anywhere in the student's answer.
  - Only report EXTRA WORD if a word in the student's answer does not appear anywhere in correctAnswer.

STEP 2 — APPLY DEDUCTIONS:
- SPELLING ERROR (e.g. "cookking" → "cooking"): deduct 1 point per misspelled word.
- WORD ORDER ERROR: count the number of STRUCTURAL SWAPS, not individual displaced words. Each swap/reordering is 1 error = deduct 1 point. Example: "Dad is cooking in the kitchen" → "Dad is in the kitchen cooking" = ONE swap (cooking moved to end) = deduct 1 point, NOT 4 points. "Where is your brother" → "Where your brother is" = ONE swap (is moved to end) = deduct 1 point.
- MISSING WORD (only if Step 1 confirms a word is truly absent): deduct 1 point per missing word.
- EXTRA WORD (only if Step 1 confirms a word is truly added): deduct 1 point per extra word.
- PUNCTUATION ERROR (missing period, question mark, etc.): deduct per punctuation check rule.
- SPACING ERROR within a word: deduct 1 point (same as short word mode).
All deductions are cumulative. Score cannot go below 0.

Determine the mode by counting words in correctAnswer, then apply the corresponding rules.`)
    englishRulesSection = `\nENGLISH DOMAIN RULES:\n${rules.join('\n')}\nThese deductions are cumulative and stack with each other. The final score cannot go below 0.`
  }

  const compactAnswerKey = {
    questions: Array.isArray(answerKey?.questions) ? answerKey.questions : [],
    totalScore: toFiniteNumber(answerKey?.totalScore) ?? null
  }
  // Build a set of questionIds that are multi-choice/multi-check types for separator normalization
  const multiSelectIds = new Set(
    (compactAnswerKey.questions || [])
      .filter((q) => ['multi_check', 'multi_choice', 'multi_check_other'].includes(q.questionCategory))
      .map((q) => q.questionId)
  )
  const trimmedAnswers = Array.isArray(readAnswerResult?.answers)
    ? readAnswerResult.answers.map((a) => ({
        questionId: a.questionId,
        status: a.status,
        studentAnswerRaw: multiSelectIds.has(a.questionId) && typeof a.studentAnswerRaw === 'string'
          ? a.studentAnswerRaw.replace(/[，、；;｜|]/g, ',')
          : a.studentAnswerRaw
      }))
    : []

  return `
You are stage Assessor. Score each question by comparing student answers to the answer key.

${strictnessRule}
${lenientFocusPolicy}
${englishRulesSection}

Domain: ${JSON.stringify(domainHint || null)}

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
- multi_check / multi_choice: The answer field contains comma-separated correct tokens (e.g. "①,③" or "A,C"). SEPARATOR NORMALIZATION: before splitting, replace ALL of these separators in BOTH student answer and correct answer with a regular comma: Chinese comma（，）, Chinese pause mark（、）, semicolon（；）, fullwidth semicolon, vertical bar（｜ or |）, whitespace-only gaps between tokens. Then parse as comma-separated token sets (order-insensitive).
  - OPEN-ENDED OTHER RULE: If referenceAnswer contains "其他選項：#N" (e.g. "其他選項：#4" or "其他選項：#4；參考：XXX"), token #N is an open-ended free-write option. Before computing correct/wrong sets, REMOVE #N from student_tokens. Student selecting or not selecting 其他 does NOT affect score in any way.
  - correct = tokens in student_tokens ∩ answer_tokens
  - wrong = tokens in student_tokens − answer_tokens
  - missing = tokens in answer_tokens − student_tokens
  - extraWrong = max(0, |wrong| − |missing|)   ← only penalize wrong tokens that EXCEED the missing count (substitution = 1 error, not 2)
  - score = max(0, round((|correct| − |extraWrong|) / |answer_tokens| × maxScore))
  - isCorrect = (score === maxScore)
  - errorType: if student has wrong extra tokens → 'concept'; if student missed tokens → 'concept'; if blank → 'blank'.
- multi_check_other: Same as multi_check BUT the LAST checkbox option is an open-ended "其他：___" field.
  - STEP 1 — Parse studentAnswerRaw: split into tokens. If the 其他 token has text appended (format "token：text", e.g. "(4)：轉為文風鼎盛的社會"), extract and store the text separately, then strip it from the token.
  - STEP 2 — Identify and REMOVE the 其他 token: the highest-numbered token in student_tokens ∪ answer_tokens. ALWAYS remove it from student_tokens. It is NEVER counted in the correct/wrong formula.
  - STEP 3 — Score the remaining tokens using the standard multi_check formula (correct − extraWrong).
    - ⚠️ EMPTY REFERENCE GUARD: If referenceAnswer is empty/null/blank (teacher did not specify correct fixed options), treat ALL fixed-option tokens as neither correct nor wrong → score = maxScore (full marks for fixed-option portion). Do NOT penalize any fixed option when reference is absent.
  - STEP 4 — Evaluate 其他 text (only if student checked 其他 AND text is non-empty):
    - Use the question context visible in the image and the answer key referenceAnswer (if provided) to judge whether the text is a reasonable/valid answer for this question.
    - If REASONABLE: note "其他選項文字合理" in scoringReason. Does NOT add to score.
    - If UNREASONABLE: note "其他選項文字不合理" in scoringReason. Does NOT deduct from score.
    - ⚠️ 其他 text is NEVER penalized regardless of reasonableness — it only affects scoringReason.
  - isCorrect = (score === maxScore).
  - errorType: same as multi_check (based on non-其他 tokens only).
- word_problem: Grade using rubricsDimensions (列式計算 + 答句). SPLIT RULE: The line starting with "答：", "A:", or "Ans:" is the 答句 dimension; everything above that line is the 列式計算 dimension. If no such line exists, treat the entire answer as 列式計算 only (答句 = blank → 0 for that dimension). UNIT RULE: In the 答句 dimension, if the expected answer contains a unit, the student's unit must be identical OR an equivalent pair per the UNIT EQUIVALENCE TABLE above (e.g. "60 km/h" = "60 公里/小時" ✓). Wrong unit that is not an equivalent pair = that dimension loses points (errorType='unit').
  - VISUAL PROCESS CHECK: If an image of the student's handwritten work is attached for this question (labelled "學生作答圖"), use the IMAGE as the primary source for judging 列式計算. The text transcription may be inaccurate for fractions, subscripts, and multi-line calculations. Look at the image to verify the student's actual written work.
- calculation: Grade using rubricsDimensions (算式過程 + 最終答案). SPLIT RULE: The last standalone "= X" result is the 最終答案; everything else (formula steps, intermediate results) is the 算式過程. HARD RULE: NEVER require an answer sentence prefix like "答：", "A:", or "Ans:" for calculation questions. NO unit checking for calculation questions — the student does NOT need to write units. For 算式過程: check if the formula/steps are mathematically valid. For 最終答案: check if the final numeric value matches referenceAnswer.
  - VISUAL PROCESS CHECK: If an image of the student's handwritten work is attached for this question (labelled "學生作答圖"), use the IMAGE as the primary source for judging 算式過程. The text transcription (studentAnswerRaw) may be inaccurate for fractions, subscripts, and multi-line calculations. Look at the image to verify: fraction notation (分子/分母), reduction/simplification marks, decimal alignment, and step-by-step flow.
  - LENIENT FOCUS: when strictness = lenient, if 最終答案 is correct, allow full score even if 算式過程 is weak/incomplete.
- short_answer: Grade by key concept presence using rubricsDimensions only. Do NOT use rubric 4-level fallback. No unit checking required.
  - ⚠️ OPEN-CHOICE DIMENSION RULE: When a dimension's criteria says "完成選擇即可，無對錯" (or similar), award full marks for that dimension as long as the student made any choice — regardless of WHICH option they chose. This applies to "承上題" follow-up questions where students choose one aspect from the previous question and explain it. Do NOT deduct points for choosing 休閒娛樂 vs 文化傳承 vs 教育 etc. — all valid options from the preceding question are equally acceptable.
    - IMPLICIT CHOICE COUNTS: The student does NOT need to name the layer explicitly. If their explanation clearly describes one layer (e.g. "娛樂身心" → 休閒娛樂 layer), treat that as a valid choice. Do NOT compare their explanation to other unchosen layers.
    - FORBIDDEN: Once a layer is identified (explicit or implicit), do NOT penalize the student for not addressing other layers (e.g. 教化人心, 文化傳承). Doing so is a violation of this rule.
    - This rule applies BEFORE any strictness-based evaluation — it cannot be overridden by strictness settings.
  - ⚠️ RUBRIC CRITERIA LANGUAGE WARNING: Dimension criteria often use phrases like "準確提及「X」、「Y」或「Z」" or "說出 [keyword]". These describe the TARGET CONCEPT, NOT a literal text requirement. Do NOT do keyword matching. Judge whether the student's answer conveys the SAME MEANING as the listed concept(s), regardless of specific wording used.
  - LENIENT FOCUS: when strictness = lenient and Domain is "社會" or "自然", apply the following generalizable rules:
    1. CORE FIRST: Identify the dimension marked as 核心/結論/主旨. If the student's answer semantically covers this core — even in different words — award full score for the entire question. Do NOT deduct for missing supporting evidence or methods.
    2. SEMANTIC EQUIVALENCE: Accept answers that express the same idea from a different angle. Common patterns:
       - Positive framing ≈ negative framing of the same outcome (e.g. "增進感情" ≈ "化解衝突"; "促進合作" ≈ "減少紛爭")
       - General statement ≈ specific instance (e.g. "促進群體和諧" ≈ "消除漳泉隔閡"; "改善關係" ≈ "消除敵對")
       - Cause ≈ stated effect when clearly implied (e.g. "增進了解" implies conflict reduction)
    3. PURPOSE vs. METHOD: If the question asks WHY (purpose/reason), a correct statement of purpose earns full credit even if the student omits the specific method or mechanism described in the model answer.
    4. WRONG CONCEPT GUARD: Do NOT award full credit if the student's core idea refers to a different concept entirely (e.g. answering with an economic reason when the question is about social harmony). Semantic equivalence applies only within the same conceptual domain.
    5. RUBRIC KEYWORD INTERPRETATION: When a dimension criteria says "準確提及「X」、「Y」或「Z」" or "說出 [keywords]" etc., treat X/Y/Z as CONCEPT ANCHORS describing the required idea — NOT as literal text that must appear verbatim in the student's answer. Accept any phrasing that captures the same underlying meaning.
       - e.g. criteria "準確提及「消除隔閡」、「增進感情」或「化解衝突」" → "讓漳泉子弟感情變好" ✓, "使雙方減少敵對" ✓, "希望大家和睦" ✓ (all capture the same concept)
       - This rule applies even if criteria uses strong language like "準確" or "明確" — those words describe concept clarity, not verbatim matching.
  - Do NOT require fixed answer-sentence format (e.g. "答：" / "A:") for short_answer.
  - ⚠️ MINIMUM EXPRESSION STANDARD (HIGHEST PRIORITY — overrides ALL other rules including LENIENT FOCUS and CORE FIRST):
    Even if the core concept is correct, the student must express it as a reasonably complete thought — not a bare fragment.
    CHECK THIS RULE FIRST before applying any strictness-based evaluation.
    FAIL standard (HARD CAP: score MUST NOT exceed 50% of maxScore — do NOT give full marks even if concept matches):
      - Answer is ≤4 characters AND lacks any verb context or connector
      - e.g. "加感情"（3字, no connector）→ HARD CAP at 50% ✗, "增進感情"（4字, bare noun phrase）→ HARD CAP ✗, "文化傳承"（4字）→ HARD CAP ✗
      - IMPORTANT: "語意一致" or "核心意思正確" does NOT exempt a FAIL answer from this cap. The cap is unconditional.
    PASS standard (concept check applies normally):
      - Contains a verb context, connector, or subject that shows understanding
      - e.g. "為了增進感情" ✓, "讓人增進感情" ✓, "可以加強彼此感情" ✓, "增進彼此的感情" ✓ (>4字 with 的)
    This rule does NOT apply to fill_blank, multi_fill, or calculation questions.
- diagram_color: studentAnswerRaw is a description of the student's coloring (e.g. "塗色：第1個圓完整，第2個圓左側2/3，第3個圓未塗"). referenceAnswer describes what should be colored. Grade using rubricsDimensions:
  - 塗色比例: compare the student's described colored proportion to the required fraction. Allow ±5% tolerance (e.g. 2/3 ≈ 0.667 ± 0.033). If proportion is correct → full marks for that dimension.
  - 塗色位置: check if the colored region is the correct side/area (e.g. left vs right, which cells). Position must match referenceAnswer.
  - 塗色完整性: check if coloring is continuous and covers the correct regions without major gaps.
  - errorType: 'concept' if wrong proportion or wrong region; 'blank' if no fresh marks described.
- diagram_draw: studentAnswerRaw is a description of label-value pairs the student drew on a chart (e.g. "番茄汁 80°, 紅蘿蔔汁 60°, 蘋果汁 40°"). referenceAnswer describes the correct data. Grade using rubricsDimensions:
  - 數值正確性: compare each label's value against the correct value. Allow ±2 units tolerance for bar heights; ±3° for pie chart angles.
  - 標籤完整性: check if all required labels are present and correctly placed.
  - errorType: 'concept' if wrong values or missing labels; 'blank' if no chart drawn.
- matching: studentAnswerRaw is the right-side text the student connected to this left-side item (e.g. "2公尺/秒"). The AnswerKey answer field is the correct right-side text.
  - Compare case-insensitively, ignoring leading/trailing whitespace.
  - Allow equivalent unit representations (e.g. "km/h" = "公里/小時").
  - isCorrect = true if the student's text matches the answer (or an equivalent form).
  - score = maxScore if isCorrect, else 0 (binary scoring per pair).
  - errorType: 'concept' if wrong connection; 'blank' if "未連線" or "未作答".
- map_fill: See MAP-FILL SCORING below.
- multi_fill: See MULTI-FILL SCORING below.
- map_draw: See MAP-DRAW SCORING below.
- (If questionCategory is absent, fall back to type-based rules: type=1 → exact match, type=2 → acceptableAnswers match, type=3 → use rubricsDimensions-style concept grading; do NOT use rubric 4-level fallback.)

- MULTI-FILL SCORING (多項填入題): Each question is one blank box; the student writes multiple codes (e.g. "ㄅ、ㄇ、ㄉ").
  - Parse student codes: split studentAnswerRaw by 、，, and whitespace → normalize each token (strip spaces, full-width→half-width).
  - Parse correct codes: split the AnswerKey answer field the same way.
  - Compare as SETS (order-insensitive): correctSet = set of correct codes; studentSet = set of student codes.
  - correctCount = |studentSet ∩ correctSet|; totalCount = |correctSet|.
  - score = Math.round(correctCount / totalCount * maxScore).
  - isCorrect = (correctCount === totalCount && studentSet.size === totalCount) [no extra codes AND all correct].
  - errorType: 'concept' if wrong/missing codes; 'blank' if studentAnswerRaw is blank/未作答.
  - scoringReason: use format「學生填入___，正確答案為___，（列出正確/缺少/多餘的代碼）」. e.g. "學生填入ㄅ、ㄇ，正確答案為ㄅ、ㄇ、ㄉ，漏填ㄉ".

- MAP-FILL SCORING (地圖填圖題): If the AnswerKey question has acceptableAnswers (list of correct names) AND a long referenceAnswer describing positions:
  - The student's answer contains position:name pairs (e.g. "位置A: 泰國, 位置B: 越南").
  - Compare each student-labeled position+name against the referenceAnswer's position→name mapping.
  - correctCount = number of positions where the student wrote the correct name.
  - score = Math.round(correctCount / totalPositions * maxScore).
  - isCorrect = (score === maxScore).
  - scoringReason MUST use format「學生將位置X填為「___」，正確答案為___，（錯誤描述）」. e.g. "學生將位置C填為「越南」、位置D填為「泰國」，正確答案為C=泰國、D=越南，兩者填反". Do NOT just say "X/Y correct".
- MAP-DRAW SCORING (繪圖/標記題): The student's answer is a description of what was drawn and where (e.g. "颱風符號，位置：23.5°N緯線以南、121°E經線以東的格子（右下格）"). The referenceAnswer in the AnswerKey describes where the symbol SHOULD be placed.
  - Judge whether the drawn symbol is correct (right type of symbol).
  - Judge whether the position is correct by comparing the described location against the referenceAnswer's required coordinates/grid position.
  - A position is correct if the student placed it in the correct grid cell or within reasonable proximity of the required coordinate intersection.
  - scoringReason MUST use format「學生繪製___於___，正確位置為___，（位置/符號是否正確）」. e.g. "學生繪製颱風符號於左下格，正確位置為右下格，符號正確但位置偏移".
- scoringReason MUST follow a UNIFIED STRUCTURE. Write in Traditional Chinese. NEVER just state a score count like "9/11 correct".
  STRUCTURE:
  - Correct: 「學生寫/選「___」，答案正確」
  - Wrong:   「學生寫/選「___」，正確答案為「___」，（具體錯誤原因）」
  - Blank:   「學生未作答」
  - Unreadable: 「學生作答內容無法辨識」

  SCORING REASON TEMPLATES PER CATEGORY:
  - single_choice:     correct→「學生選A，答案正確」 wrong→「學生選B，正確答案為A，選項判斷錯誤」
  - true_false:        correct→「學生判斷○，答案正確」 wrong→「學生判斷○，正確答案為✕，此敘述不正確」
  - single_check:      correct→「學生勾選第2項，答案正確」 wrong→「學生勾選第3項，正確答案為第2項，勾選錯誤」
  - fill_blank:        correct→「學生寫「15公分」，答案正確」 wrong→「學生寫「15公尺」，正確答案為「15公分」，單位錯誤，公尺與公分不可互換」
  - fill_variants:     correct→「學生寫「台灣」，答案正確，屬可接受答案」 wrong→「學生寫「台北」，正確答案為「台灣/臺灣」，不在可接受答案範圍內」
  - multi_check/multi_choice: correct→「學生選①③④，答案正確」 wrong→「學生選①②③，正確答案為①③④，多選了②、漏選了④」
  - multi_check_other: same as multi_check + append 其他 evaluation. e.g. 「學生選①②，正確答案為①③，多選了②、漏選了③；其他選項文字合理」
  - multi_fill:        correct→「學生填入ㄅ、ㄇ、ㄉ，全部正確」 wrong→「學生填入ㄅ、ㄇ，正確答案為ㄅ、ㄇ、ㄉ，漏填ㄉ」
  - calculation:       correct→「算式過程正確，最終答案36正確」 wrong→「學生最終答案為38，正確答案為36，第二步乘法運算錯誤」. When rubricsDimensions exist, describe each dimension: 「算式過程(2/3分)：第二步運算錯誤；最終答案(0/2分)：學生寫38，正確答案為36」
  - word_problem:      correct→「列式正確，答句「36公分」正確」 wrong→「學生答句寫「36公尺」，正確答案為「36公分」，列式正確但答句單位錯誤」. When rubricsDimensions exist, describe each dimension: 「列式計算(2/3分)：算式正確但漏寫單位；答句(0/2分)：學生寫「36公尺」，正確答案為「36公分」，單位錯誤」
  - short_answer:      correct→「學生回答內容完整，概念正確」 wrong→「學生寫「因為天氣很熱」，正確答案應涵蓋「蒸發作用」概念，學生僅描述現象未說明原理」. When rubricsDimensions exist, describe each dimension's score.
  - matching:          correct→「學生配對「2公尺/秒」，答案正確」 wrong→「學生配對「3公尺/秒」，正確答案為「2公尺/秒」，配對錯誤」
  - map_fill:          correct→「所有位置填寫正確」 wrong→「學生將位置C填為「越南」、位置D填為「泰國」，正確答案為C=泰國、D=越南，兩者填反」
  - map_draw:          correct→「學生繪製颱風符號於右下格，位置與符號皆正確」 wrong→「學生繪製颱風符號於左下格，正確位置為右下格，符號正確但位置偏移」
  - diagram_color:     correct→「塗色比例2/3與位置皆正確」 wrong→「學生塗色比例約1/2，正確比例為2/3，塗色面積不足」
  - diagram_draw:      correct→「圖表數值與標籤皆正確」 wrong→「學生標示番茄汁為60°，正確值為80°，數值偏差過大」

  ENGLISH DOMAIN EXTRA (fill_blank / short_answer): When wrong, list each deduction item separately with format「扣分類型：學生寫___，正確為___，扣N分」:
  - 「拼寫錯誤：學生寫 cookking，正確為 cooking，扣1分」
  - 「大小寫錯誤：學生寫 apple，正確為 Apple，扣1分」
  - 「標點錯誤：學生句尾缺少問號，扣1分」
  - 「空格錯誤：學生寫 bath room，正確為 bathroom，不認識該單字，0分」
  - 「字序錯誤：學生寫 Where your brother is?，正確為 Where is your brother?，is 位置不正確，扣1分」
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
  domainHint,
  answerSheetMode = 'with_questions'
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
${answerSheetMode === 'answer_only'
    ? 'The QUESTION BOOKLET image is attached (the student\'s answer sheet has no question text). Use the question booklet to read the actual question text for each wrong question.'
    : 'The student\'s homework image is attached. Use it actively.'}

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
${answerSheetMode === 'answer_only'
    ? '1. Find the question in the attached QUESTION BOOKLET image by its ID or position number.\n2. Read the ACTUAL question text from the question booklet carefully.'
    : '1. Find the question in the attached image by its ID or position number.\n2. Read the ACTUAL question text from the image carefully.'}
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
  let modelResponse
  try {
    modelResponse = await callGeminiGenerateContent({
      apiKey,
      model: preparedRequest.model,
      contents: preparedRequest.contents,
      payload: filterPayloadForGemini(preparedRequest.payload),
      timeoutMs,
      fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
    })
  } catch (err) {
    const modelLatencyMs = Date.now() - modelStartedAt
    const errStatus = Number(err?.status) || 504
    return {
      routeKey,
      pipelineName: pipeline.name,
      status: errStatus,
      ok: false,
      data: { error: err?.message || 'model call failed', code: 'STAGE_CALL_FAILED' },
      prepareLatencyMs,
      modelLatencyMs,
      warnings: [],
      metrics: {}
    }
  }
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

    // ── 程式化覆核：數字/符號答案的 fill_blank 不信任 accessor ──
    // 只覆核有明確標準答案且答案是數字或簡單符號的題目
    const requireSimplifiedFraction = answerKey?.fractionRule === 'require_simplified'
    const qCategory = ensureString(question?.questionCategory, '')
    const refAnswer = ensureString(question?.answer, '').trim()
    const studentAns = row.studentAnswer
    // 英語規則啟用時，fill_blank 和 short_answer 不走程式化覆核
    // 讓 accessor 判斷標點、大小寫、拼寫等細節扣分
    const hasEnglishRules = answerKey?.englishRules?.punctuationCheck?.enabled || answerKey?.englishRules?.wordOrderCheck?.enabled
    const skipProgrammaticForEnglish = hasEnglishRules && (qCategory === 'fill_blank' || qCategory === 'short_answer')
    // fill_blank 學生答案包含計算步驟（比標準答案長 3 倍以上或含換行）時，信任 accessor
    // 避免程式化覆核拿整段計算文字跟簡單答案比對導致誤判
    const studentHasCalcSteps = qCategory === 'fill_blank' && refAnswer && studentAns &&
      (studentAns.length > refAnswer.length * 3 || studentAns.includes('\n') || /[=÷×+\-]/.test(studentAns))
    if (
      !skipProgrammaticForEnglish &&
      !studentHasCalcSteps &&
      (qCategory === 'fill_blank' || qCategory === 'true_false' || qCategory === 'single_choice') &&
      refAnswer &&
      studentAns &&
      studentAns !== '未作答' &&
      studentAns !== '無法辨識'
    ) {
      // 判斷標準答案是否為「簡單答案」（數字、分數、百分比、單一字母/符號）
      const isSimpleAnswer = /^[\d./×÷+\-−%°○✗✓A-Za-z\s，,]+$/u.test(refAnswer) && refAnswer.length <= 20
      if (isSimpleAnswer) {
        const norm = (s) => {
          let t = s.replace(/\s+/g, '').replace(/[，]/g, ',').replace(/[−–—]/g, '-')
          // 圈圈數字 → 半形數字（①②③...⑳ → 1~20）
          t = t.replace(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/gu, (ch) => {
            const idx = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'.indexOf(ch)
            return idx >= 0 ? String(idx + 1) : ch
          })
          // 全形數字 → 半形
          t = t.replace(/[０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF10))
          // 剝除外層括號：(C) → C、（甲）→ 甲、(2) → 2
          t = t.replace(/^[（(]\s*(.+?)\s*[）)]$/, '$1')
          return t.toLowerCase()
        }
        // 是非題：用 normalizeTrueFalseAnswer 正規化（O→○、X→✗ 等），處理完直接跳過通用比對
        if (qCategory === 'true_false') {
          const tfRef = normalizeTrueFalseAnswer(refAnswer)
          const tfStu = normalizeTrueFalseAnswer(studentAns)
          if (tfRef && tfStu) {
            const tfMatch = tfRef === tfStu
            if (tfMatch !== row.isCorrect) {
              row.isCorrect = tfMatch
              row.score = tfMatch ? (toFiniteNumber(question?.maxScore) ?? row.maxScore) : 0
              row.reason = tfMatch ? '答案正確（程式比對覆核）' : `答案錯誤（程式比對覆核：學生 "${studentAns}" ≠ 標準 "${refAnswer}"）`
              row.confidence = 100
              console.log(`[programmatic-override] ${questionId} true_false tf="${tfRef}" stu="${tfStu}" ${!tfMatch}→${tfMatch}`)
            }
          }
          // 是非題不走通用比對，避免 norm() 把 ○/O 轉成不同的 lowercase 又覆蓋回去
        } else {
        const normRef = norm(refAnswer)
        const normStu = norm(studentAns)
        // 1. 直接比對 → 2. 數值等值 → 3. 從學生答案提取最終答案再比（處理 bbox 多讀計算草稿的情況）
        let programMatch = normRef === normStu || isNumericEqual(normRef, normStu)
        // 分數必須最簡（整數除外，如 2/2=1 可接受）— 僅當 fractionRule=require_simplified
        if (requireSimplifiedFraction && programMatch && isUnsimplifiedFraction(normStu)) programMatch = false
        if (!programMatch) {
          const extracted = extractFinalAnswerFromCalc(studentAns)
          if (extracted) {
            const extractedNorm = norm(extracted)
            programMatch = extractedNorm === normRef || isNumericEqual(extractedNorm, normRef)
            if (requireSimplifiedFraction && programMatch && isUnsimplifiedFraction(extractedNorm)) programMatch = false
          }
        }
        if (programMatch !== row.isCorrect) {
          const prevCorrect = row.isCorrect
          row.isCorrect = programMatch
          row.score = programMatch ? (toFiniteNumber(question?.maxScore) ?? row.maxScore) : 0
          row.reason = programMatch
            ? `答案正確（程式比對覆核）`
            : `答案錯誤（程式比對覆核：學生 "${studentAns}" ≠ 標準 "${refAnswer}"）`
          row.confidence = 100
          console.log(`[programmatic-override] ${questionId} category=${qCategory} ref="${refAnswer}" student="${studentAns}" ${prevCorrect}→${programMatch}`)
        }
      } // end else (non-true_false generic comparison)
      }
    }

    // ── 程式化覆核：word_problem / calculation 最終答案決定制 ──
    // 規則：
    //   最終答案對 + 有步驟 → 滿分（不看 accessor 怎麼評計算過程）
    //   最終答案對 + 空白步驟 → 0分（疑似抄答案）
    //   最終答案錯 + 有步驟 → 保留 accessor 分數（讓 accessor 判部分分）
    //   最終答案錯 + 空白步驟 → 0分
    if (qCategory === 'word_problem' || qCategory === 'calculation') {
      const refText = ensureString(question?.referenceAnswer || question?.answer, '')
      const refFinal = extractFinalAnswerFromCalc(refText)
      const stuFinal = extractFinalAnswerFromCalc(studentAns)
      const qMaxScore = toFiniteNumber(question?.maxScore) ?? row.maxScore

      // 判斷計算過程是否空白：去掉最終答案行後，剩餘內容 < 3 字 → 空白
      const stepsText = studentAns
        .replace(/(?:答[：:：]|[Aa](?:ns)?[：:\s]).+$/u, '')  // 去掉「答：xxx」行
        .replace(/\s+/g, '')
        .trim()
      const hasSteps = stepsText.length >= 3

      if (refFinal && stuFinal) {
        // 分數必須最簡（整數除外，如 2/2=1 可接受）— 僅當 fractionRule=require_simplified；分數⇔小數等值仍接受
        const finalMatch = (refFinal === stuFinal || isNumericEqual(refFinal, stuFinal)) && (!requireSimplifiedFraction || !isUnsimplifiedFraction(stuFinal))

        if (finalMatch && hasSteps && row.score < qMaxScore) {
          // 最終答案對 + 有步驟 → 滿分
          const prevScore = row.score
          row.isCorrect = true
          row.score = qMaxScore
          row.needExplain = false
          row.reason = `答案正確（程式比對覆核）`
          row.confidence = 100
          console.log(`[programmatic-override] ${questionId} final-answer-match + has-steps → full marks (${prevScore}→${qMaxScore})`)
        } else if (finalMatch && !hasSteps) {
          // 最終答案對 + 空白步驟 → 0分（疑似抄答案）
          row.isCorrect = false
          row.score = 0
          row.needExplain = true
          row.reason = `最終答案正確但未列出計算過程（程式比對覆核）`
          row.confidence = 100
          console.log(`[programmatic-override] ${questionId} final-answer-match + blank-steps → 0`)
        } else if (!finalMatch && row.isCorrect === true) {
          // 最終答案錯但 accessor 說對 → 強制錯誤
          row.isCorrect = false
          row.score = 0
          row.needExplain = true
          row.reason = `最終答案不符（程式比對覆核：學生 "${stuFinal}" ≠ 標準 "${refFinal}"）`
          row.confidence = 100
          console.log(`[programmatic-override] ${questionId} final-answer-mismatch + accessor-correct → force wrong`)
        } else if (!finalMatch && !hasSteps) {
          // 最終答案錯 + 空白步驟 → 0分
          row.isCorrect = false
          row.score = 0
          row.needExplain = true
          row.reason = `答案錯誤且未列出計算過程`
          row.confidence = 100
          console.log(`[programmatic-override] ${questionId} final-answer-mismatch + blank-steps → 0`)
        }
        // 最終答案錯 + 有步驟 → 不動，保留 accessor 的部分分數
      }
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
  const unansweredIds = details.filter((d) => d.studentAnswer === '未作答').map((d) => d.questionId)
  if (unansweredIds.length > 0) {
    reviewReasons.push(`${unansweredIds.join(', ')} 辨識為未作答，請確認`)
  }
  const unreadableIds = details.filter((d) => d.studentAnswer === '無法辨識').map((d) => d.questionId)
  if (unreadableIds.length > 0) {
    reviewReasons.push(`${unreadableIds.join(', ')} 無法辨識，請確認`)
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
  const resolvedAnswerKey = internalContext?.resolvedAnswerKey
  const { answerKey, convertedShortAnswerIds } =
    normalizeAnswerKeyForRubricScoring(resolvedAnswerKey, internalContext?.domainHint)
  if (!answerKey || typeof answerKey !== 'object') {
    logStaged(pipelineRunId, stagedLogLevel, 'PhaseA skip reason=missing_answer_key')
    return null
  }
  if (convertedShortAnswerIds.length > 0) {
    logStaged(
      pipelineRunId,
      stagedLogLevel,
      'normalized short_answer to rubricsDimensions',
      { count: convertedShortAnswerIds.length, questionIds: convertedShortAnswerIds }
    )
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
  // 答案卷參考圖（用於 classify 定位）
  const rawAnswerKeyImages = Array.isArray(internalContext?.answerKeyImages) ? internalContext.answerKeyImages : []
  const answerKeyImageParts = rawAnswerKeyImages.map(img => ({
    inlineData: { mimeType: img.mimeType || 'image/webp', data: img.data }
  }))
  const answerSheetMode = internalContext?.answerSheetMode || 'with_questions'
  logStaged(pipelineRunId, stagedLogLevel, `PhaseA begin model=${model} questionCount=${questionIds.length} answerKeyPages=${answerKeyImageParts.length} answerSheetMode=${answerSheetMode}`)

  const stageResponses = []
  const stageWarnings = []
  const pipelineStartedAt = Date.now()
  const PIPELINE_BUDGET_MS = 250_000
  const getRemainingBudget = () => Math.max(1000, PIPELINE_BUDGET_MS - (Date.now() - pipelineStartedAt))

  // ── A1: CLASSIFY (含 answerBbox) ─────────────────────────────────────────
  const answerKeyQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  let pageBreaks = Array.isArray(payload?.pageBreaks) ? payload.pageBreaks : []
  // Fallback: if pageBreaks is empty but questionIds have multi-page prefixes (1-*, 2-*, 3-*, ...),
  // estimate equal-split pageBreaks so per-page classify can still work.
  if (pageBreaks.length === 0) {
    const pageNums = new Set()
    for (const id of questionIds) {
      const m = id.match(/^(\d+)-/)
      if (m) pageNums.add(parseInt(m[1], 10))
    }
    const maxPage = pageNums.size > 0 ? Math.max(...pageNums) : 1
    if (maxPage >= 2) {
      pageBreaks = Array.from({ length: maxPage - 1 }, (_, i) => +((i + 1) / maxPage).toFixed(4))
      logStaged(pipelineRunId, stagedLogLevel, 'pageBreaks auto-estimated (equal split)', { maxPage, pageBreaks })
    }
  }
  const classifyCorrections = Array.isArray(payload?.classifyCorrections) ? payload.classifyCorrections : []
  if (classifyCorrections.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'classify corrections received', classifyCorrections)
  }
  const classifyQuestionSpecs = buildClassifyQuestionSpecs(questionIds, answerKeyQuestions)
  // Log anchorHint specs so we can verify hints are correct before trusting them
  const specsWithAnchor = classifyQuestionSpecs.filter((s) => s.anchorHint)
  if (specsWithAnchor.length > 0) {
    logStaged(pipelineRunId, 'basic', 'classify anchorHint specs', specsWithAnchor.map((s) => ({ id: s.questionId, anchorHint: s.anchorHint })))
  }
  // Log tablePosition specs for debugging table cell targeting
  const specsWithTable = classifyQuestionSpecs.filter((s) => s.tablePosition)
  if (specsWithTable.length > 0) {
    logStaged(pipelineRunId, 'basic', 'classify tablePosition specs', specsWithTable.map((s) => ({ id: s.questionId, tablePosition: s.tablePosition })))
  }

  // Per-page classify: one call per page, all dispatched in parallel.
  // Each call receives the FULL merged student image but only its own page's questions,
  // reducing per-call token load and improving bbox accuracy.
  // Questions without a numeric page prefix (e.g. "Q1") are grouped into page 1.

  // Build per-page question groups
  const pageQuestionsMap = new Map() // pageNum (1-indexed) -> questionId[]
  const otherIds = []
  for (const id of questionIds) {
    const m = id.match(/^(\d+)-/)
    if (m) {
      const pageNum = parseInt(m[1], 10)
      if (!pageQuestionsMap.has(pageNum)) pageQuestionsMap.set(pageNum, [])
      pageQuestionsMap.get(pageNum).push(id)
    } else {
      otherIds.push(id)
    }
  }
  // Assign non-prefixed IDs to page 1
  if (!pageQuestionsMap.has(1)) pageQuestionsMap.set(1, [])
  pageQuestionsMap.get(1).push(...otherIds)

  // Only dispatch calls for pages that actually have questions, sorted by page number
  const pageEntries = [...pageQuestionsMap.entries()]
    .filter(([, ids]) => ids.length > 0)
    .sort(([a], [b]) => a - b)

  logStageStart(pipelineRunId, 'classify')
  logStaged(pipelineRunId, stagedLogLevel, 'classify per-page plan', {
    numPages: pageEntries.length,
    answerKeyPages: answerKeyImageParts.length,
    pages: pageEntries.map(([p, ids]) => ({ page: p, count: ids.length }))
  })

  let classifyResult

  if (pageEntries.length <= 1) {
    // Single page (or all questions share one page) — one call
    const ids = pageEntries.length === 0 ? questionIds : pageEntries[0][1]
    const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
    const akPageCount = answerKeyImageParts.length > 0 ? answerKeyImageParts.length : 0
    const classifyPrompt = buildClassifyPrompt(ids, specs, pageBreaks, akPageCount, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
    const classifyResponse = await executeStage({
      apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
      stageContents: [{ role: 'user', parts: [{ text: classifyPrompt }, ...answerKeyImageParts, ...submissionImageParts] }]
    })
    logStageEnd(pipelineRunId, 'classify-p1', classifyResponse)
    stageResponses.push(classifyResponse)
    if (!classifyResponse.ok) {
      return {
        status: classifyResponse.status, data: classifyResponse.data,
        pipelineMeta: { pipeline: STAGED_PIPELINE_NAME, prepareLatencyMs: classifyResponse.prepareLatencyMs, modelLatencyMs: classifyResponse.modelLatencyMs, warnings: classifyResponse.warnings, metrics: { stage: 'classify' } }
      }
    }
    if (classifyResponse.warnings.length > 0) stageWarnings.push(...classifyResponse.warnings.map((w) => `[classify-p1] ${w}`))
    const classifyParsed = parseCandidateJson(classifyResponse.data)
    if (!classifyParsed || typeof classifyParsed !== 'object') throw new Error('PhaseA classify parse failed')
    classifyResult = applyClassifyQuestionSpecs(normalizeClassifyResult(classifyParsed, ids), classifyQuestionSpecs)
  } else {
    // Multi-page: split merged image into individual pages, one classify call per page (parallel).
    // Each call gets ONLY its page's image → AI outputs bbox in single-page coords (0~1)
    // → remap back to full-image coords after parsing.
    const submissionImg = inlineImages[0].inlineData
    logStaged(pipelineRunId, stagedLogLevel, 'classify split attempt', {
      hasImageData: !!submissionImg.data,
      imageDataLength: submissionImg.data?.length ?? 0,
      mimeType: submissionImg.mimeType,
      pageBreaks,
      pageBreaksLength: pageBreaks.length
    })
    const splitPages = await splitSubmissionImageByPageBreaks(submissionImg.data, submissionImg.mimeType, pageBreaks)

    if (!splitPages || splitPages.length !== pageEntries.length) {
      // Fallback: split failed or page count mismatch → send full image with pageBreaks (old behavior)
      logStaged(pipelineRunId, stagedLogLevel, 'classify split failed, fallback to full image', {
        splitPages: splitPages?.length, pageEntries: pageEntries.length, pageBreaksLength: pageBreaks.length
      })
      const classifyResponses = await Promise.all(
        pageEntries.map(([pageNum, ids]) => {
          const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
          // Per-page: pass matching answer key page image (pageNum is 1-indexed, array is 0-indexed)
          const akPage = answerKeyImageParts[pageNum - 1]
          const akParts = akPage ? [akPage] : []
          const akCount = akPage ? 1 : 0
          const prompt = buildClassifyPrompt(ids, specs, pageBreaks, akCount, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
          return executeStage({
            apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
            stageContents: [{ role: 'user', parts: [{ text: prompt }, ...akParts, ...submissionImageParts] }]
          })
        })
      )
      classifyResponses.forEach((resp, i) => {
        logStageEnd(pipelineRunId, `classify-p${pageEntries[i][0]}`, resp)
        stageResponses.push(resp)
        if (resp.warnings.length > 0) stageWarnings.push(...resp.warnings.map((w) => `[classify-p${pageEntries[i][0]}] ${w}`))
      })
      const failedResp = classifyResponses.find((r) => !r.ok)
      if (failedResp) {
        return {
          status: failedResp.status, data: failedResp.data,
          pipelineMeta: { pipeline: STAGED_PIPELINE_NAME, prepareLatencyMs: failedResp.prepareLatencyMs, modelLatencyMs: failedResp.modelLatencyMs, warnings: failedResp.warnings, metrics: { stage: 'classify' } }
        }
      }
      const parsedResults = classifyResponses.map((r) => parseCandidateJson(r.data))
      if (parsedResults.some((p) => !p || typeof p !== 'object')) throw new Error('PhaseA classify parse failed (per-page fallback)')
      const normalizedResults = pageEntries.map(([, ids], i) => normalizeClassifyResult(parsedResults[i], ids))
      const byId = new Map(normalizedResults.flatMap((n) => n.alignedQuestions).map((q) => [q.questionId, q]))
      const mergedAligned = questionIds.map((id) => byId.get(id) ?? { questionId: id, visible: false, questionType: 'fill_blank' })
      classifyResult = applyClassifyQuestionSpecs({
        alignedQuestions: mergedAligned,
        coverage: questionIds.length === 0 ? 0 : mergedAligned.filter((q) => q.visible).length / questionIds.length,
        unmappedQuestionIds: normalizedResults.flatMap((n) => n.unmappedQuestionIds),
        pixelBboxRejected: normalizedResults.flatMap((n) => n.pixelBboxRejected ?? [])
      }, classifyQuestionSpecs)
    } else {
      // Success: each page gets its own cropped image — no pageBreaks needed in prompt
      logStaged(pipelineRunId, stagedLogLevel, 'classify split success', {
        pages: splitPages.map((p, i) => ({ page: pageEntries[i][0], startY: +p.pageStartY.toFixed(3), endY: +p.pageEndY.toFixed(3) }))
      })
      const classifyResponses = await Promise.all(
        pageEntries.map(([pageNum, ids], i) => {
          const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
          // Per-page: pass matching answer key page image (1 answer key page + 1 student page)
          const akPage = answerKeyImageParts[pageNum - 1]
          const akParts = akPage ? [akPage] : []
          const akCount = akPage ? 1 : 0
          // No pageBreaks — single-page image, AI outputs bbox in 0~1 relative to this page
          const prompt = buildClassifyPrompt(ids, specs, [], akCount, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
          const pageImagePart = { inlineData: splitPages[i].inlineData }
          return executeStage({
            apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
            stageContents: [{ role: 'user', parts: [{ text: prompt }, ...akParts, pageImagePart] }]
          })
        })
      )

      classifyResponses.forEach((resp, i) => {
        const pageNum = pageEntries[i][0]
        logStageEnd(pipelineRunId, `classify-p${pageNum}`, resp)
        stageResponses.push(resp)
        if (resp.warnings.length > 0) stageWarnings.push(...resp.warnings.map((w) => `[classify-p${pageNum}] ${w}`))
      })

      const failedResp = classifyResponses.find((r) => !r.ok)
      if (failedResp) {
        return {
          status: failedResp.status, data: failedResp.data,
          pipelineMeta: { pipeline: STAGED_PIPELINE_NAME, prepareLatencyMs: failedResp.prepareLatencyMs, modelLatencyMs: failedResp.modelLatencyMs, warnings: failedResp.warnings, metrics: { stage: 'classify' } }
        }
      }

      const parsedResults = classifyResponses.map((r) => parseCandidateJson(r.data))
      if (parsedResults.some((p) => !p || typeof p !== 'object')) {
        throw new Error('PhaseA classify parse failed (per-page split)')
      }

      // Normalize then remap bboxes from per-page coords → full-image coords
      const normalizedResults = pageEntries.map(([, ids], i) => {
        const norm = normalizeClassifyResult(parsedResults[i], ids)
        const { pageStartY, pageEndY } = splitPages[i]
        for (const q of norm.alignedQuestions) {
          if (q.answerBbox) q.answerBbox = remapBboxToFullImage(q.answerBbox, pageStartY, pageEndY)
          if (q.questionBbox) q.questionBbox = remapBboxToFullImage(q.questionBbox, pageStartY, pageEndY)
          if (q.readBbox) q.readBbox = remapBboxToFullImage(q.readBbox, pageStartY, pageEndY)
          if (q.bracketBbox) q.bracketBbox = remapBboxToFullImage(q.bracketBbox, pageStartY, pageEndY)
        }
        return norm
      })

      const byId = new Map(
        normalizedResults.flatMap((n) => n.alignedQuestions).map((q) => [q.questionId, q])
      )
      const mergedAligned = questionIds.map(
        (id) => byId.get(id) ?? { questionId: id, visible: false, questionType: 'fill_blank' }
      )
      classifyResult = applyClassifyQuestionSpecs({
        alignedQuestions: mergedAligned,
        coverage: questionIds.length === 0 ? 0 : mergedAligned.filter((q) => q.visible).length / questionIds.length,
        unmappedQuestionIds: normalizedResults.flatMap((n) => n.unmappedQuestionIds),
        pixelBboxRejected: normalizedResults.flatMap((n) => n.pixelBboxRejected ?? [])
      }, classifyQuestionSpecs)
    }
  }

  let classifyAligned = classifyResult.alignedQuestions
  logStaged(pipelineRunId, stagedLogLevel, 'classify normalized-summary', {
    coverage: classifyResult.coverage,
    visibleCount: classifyAligned.filter((q) => q.visible).length,
    bboxCount: classifyAligned.filter((q) => q.answerBbox).length,
    perPage: pageEntries.length > 1,
    ...(classifyResult.pixelBboxRejected?.length > 0 && { pixelBboxRejected: classifyResult.pixelBboxRejected })
  })
  // Detailed bbox log: classify bbox vs answer key bbox comparison
  // Answer key bbox is in per-page coordinates (0~1 within that page).
  // Classify bbox is in full-image coordinates (0~1 across all merged pages).
  // Convert akHint.y to full-image space for meaningful comparison.
  const akByIdForLog = mapByQuestionId(answerKeyQuestions, (item) => item?.id)
  const totalPages = pageEntries.length || 1
  logStaged(pipelineRunId, 'basic', 'classify bbox detail', classifyAligned
    .filter((q) => q.visible)
    .map((q) => {
      const akQ = akByIdForLog.get(q.questionId)
      const akBbox = akQ?.answerBbox
      const cBbox = q.answerBbox
      // Convert akHint y from per-page to full-image coordinates
      let akHintFullImage = null
      if (akBbox && totalPages > 1) {
        const pageNum = parseInt(String(q.questionId).split('-')[0], 10) || 1
        const pageStartY = (pageNum - 1) / totalPages
        const pageHeight = 1 / totalPages
        akHintFullImage = {
          y: +(pageStartY + akBbox.y * pageHeight).toFixed(4),
          h: +(akBbox.h * pageHeight).toFixed(4)
        }
      } else if (akBbox) {
        akHintFullImage = { y: +akBbox.y.toFixed(4), h: +akBbox.h.toFixed(4) }
      }
      const yDiff = (cBbox && akHintFullImage) ? +(cBbox.y - akHintFullImage.y).toFixed(4) : null
      return {
        id: q.questionId,
        type: q.questionType,
        classify: cBbox ? { y: +cBbox.y.toFixed(3), h: +cBbox.h.toFixed(3), x: +cBbox.x.toFixed(3), w: +cBbox.w.toFixed(3) } : null,
        akHint: akHintFullImage,
        yDiff,
        ...(yDiff !== null && Math.abs(yDiff) > 0.02 ? { warn: 'Y_DRIFT' } : {})
      }
    })
  )
  // Log tablePosition reasoning for debugging table cell targeting
  const tableReasoningDebug = classifyAligned
    .filter((q) => q.tablePositionReasoning)
    .map((q) => ({ id: q.questionId, reasoning: q.tablePositionReasoning }))
  if (tableReasoningDebug.length > 0) {
    logStaged(pipelineRunId, 'basic', 'classify tablePosition reasoning', tableReasoningDebug)
  }
  const multiFillBboxDebug = classifyAligned
    .filter((q) => q.visible && q.questionType === 'multi_fill')
    .map((q) => ({ questionId: q.questionId, answerBbox: q.answerBbox }))
  if (multiFillBboxDebug.length > 0) {
    logStaged(pipelineRunId, 'basic', 'multi_fill answerBbox coords', multiFillBboxDebug)
  }

  // ── Classify Quality Gate + Auto-Retry (max 1) ────────────────────────────
  const classifyQG = validateClassifyQuality(classifyResult, questionIds)
  logStaged(pipelineRunId, 'basic', 'classify quality-gate', {
    severity: classifyQG.severity, warnings: classifyQG.warnings, metrics: classifyQG.metrics
  })
  if (classifyQG.severity === QG_SEVERITY.FAIL) {
    logStaged(pipelineRunId, stagedLogLevel, 'classify quality FAIL → retry (1/1)')
    // Re-run classify: single-page path (simple retry with same prompt)
    if (pageEntries.length <= 1) {
      const ids = pageEntries.length === 0 ? questionIds : pageEntries[0][1]
      const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
      const akPageCount = answerKeyImageParts.length > 0 ? answerKeyImageParts.length : 0
      const retryPrompt = buildClassifyPrompt(ids, specs, pageBreaks, akPageCount, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
      const retryResp = await executeStage({
        apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
        stageContents: [{ role: 'user', parts: [{ text: retryPrompt }, ...answerKeyImageParts, ...submissionImageParts] }]
      })
      logStageEnd(pipelineRunId, 'classify-retry', retryResp)
      stageResponses.push(retryResp)
      if (retryResp.ok) {
        const retryParsed = parseCandidateJson(retryResp.data)
        if (retryParsed && typeof retryParsed === 'object') {
          classifyResult = applyClassifyQuestionSpecs(normalizeClassifyResult(retryParsed, ids), classifyQuestionSpecs)
          const retryQG = validateClassifyQuality(classifyResult, questionIds)
          logStaged(pipelineRunId, 'basic', 'classify retry quality-gate', {
            severity: retryQG.severity, warnings: retryQG.warnings
          })
        }
      }
    } else {
      // Multi-page retry: re-dispatch all pages in parallel
      const submissionImg = inlineImages[0].inlineData
      const splitPages = await splitSubmissionImageByPageBreaks(submissionImg.data, submissionImg.mimeType, pageBreaks)
      const useSplit = splitPages && splitPages.length === pageEntries.length
      const retryResponses = await Promise.all(
        pageEntries.map(([pageNum, ids], i) => {
          const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
          const akPage = answerKeyImageParts[pageNum - 1]
          const akParts = akPage ? [akPage] : []
          const akCount = akPage ? 1 : 0
          const prompt = buildClassifyPrompt(ids, specs, useSplit ? [] : pageBreaks, akCount, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
          const imgPart = useSplit ? { inlineData: splitPages[i].inlineData } : submissionImageParts[0]
          return executeStage({
            apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
            stageContents: [{ role: 'user', parts: [{ text: prompt }, ...akParts, imgPart] }]
          })
        })
      )
      retryResponses.forEach((resp, i) => {
        logStageEnd(pipelineRunId, `classify-retry-p${pageEntries[i][0]}`, resp)
        stageResponses.push(resp)
      })
      if (retryResponses.every((r) => r.ok)) {
        const parsedResults = retryResponses.map((r) => parseCandidateJson(r.data))
        if (parsedResults.every((p) => p && typeof p === 'object')) {
          const normalizedResults = pageEntries.map(([, ids], i) => {
            const norm = normalizeClassifyResult(parsedResults[i], ids)
            if (useSplit) {
              const { pageStartY, pageEndY } = splitPages[i]
              for (const q of norm.alignedQuestions) {
                if (q.answerBbox) q.answerBbox = remapBboxToFullImage(q.answerBbox, pageStartY, pageEndY)
                if (q.questionBbox) q.questionBbox = remapBboxToFullImage(q.questionBbox, pageStartY, pageEndY)
                if (q.readBbox) q.readBbox = remapBboxToFullImage(q.readBbox, pageStartY, pageEndY)
                if (q.bracketBbox) q.bracketBbox = remapBboxToFullImage(q.bracketBbox, pageStartY, pageEndY)
              }
            }
            return norm
          })
          const byId = new Map(normalizedResults.flatMap((n) => n.alignedQuestions).map((q) => [q.questionId, q]))
          const mergedAligned = questionIds.map((id) => byId.get(id) ?? { questionId: id, visible: false, questionType: 'fill_blank' })
          classifyResult = applyClassifyQuestionSpecs({
            alignedQuestions: mergedAligned,
            coverage: questionIds.length === 0 ? 0 : mergedAligned.filter((q) => q.visible).length / questionIds.length,
            unmappedQuestionIds: normalizedResults.flatMap((n) => n.unmappedQuestionIds),
            pixelBboxRejected: normalizedResults.flatMap((n) => n.pixelBboxRejected ?? [])
          }, classifyQuestionSpecs)
          const retryQG = validateClassifyQuality(classifyResult, questionIds)
          logStaged(pipelineRunId, 'basic', 'classify retry quality-gate', {
            severity: retryQG.severity, warnings: retryQG.warnings
          })
        }
      }
    }
    classifyAligned = classifyResult.alignedQuestions
  }
  // ── End Classify Quality Gate ─────────────────────────────────────────────

  const wordProblemIds = classifyAligned
    .filter((q) => q.visible && q.questionType === 'word_problem')
    .map((q) => q.questionId)

  const calculationIds = classifyAligned
    .filter((q) => q.visible && q.questionType === 'calculation')
    .map((q) => q.questionId)

  // Dynamic padding: adjust for multi-page merged images.
  // basePad 0.03 was designed for single-page images (3% of page height).
  // For multi-page, divide by page count so each page still gets ~3% padding.
  const dynamicPad = +(0.03 / totalPages).toFixed(4)
  const dynamicPadWide = +(0.08 / totalPages).toFixed(4)
  logStaged(pipelineRunId, 'basic', 'dynamic crop padding', { totalPages, pad: dynamicPad, padWide: dynamicPadWide })

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
          true,
          dynamicPad
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
  // For fill_blank: use readBbox (tight, answer-area-only) if available, else fall back to answerBbox.
  // readBbox excludes the question stem text so AI1/AI2 cannot read adjacent questions.
  const allQuestionCropMap = new Map()  // questionId → { data, mimeType }
  const ai1CropCandidates = classifyAligned.filter(
    (q) => q.visible && q.answerBbox && q.questionType !== 'map_fill'
      && !focusedCheckboxCropMap.has(q.questionId)  // exclude already-cropped checkbox questions
  )
  if (ai1CropCandidates.length > 0 && inlineImages.length > 0) {
    const inlineImage = inlineImages[0]
    const cropResults = await Promise.all(
      ai1CropCandidates.map(async (q) => {
        const bboxToUse = (q.questionType === 'fill_blank' && q.readBbox) ? q.readBbox : q.answerBbox
        // No width narrowing — dynamic padding (adjusted by page count) ensures
        // crops don't include too many adjacent questions.
        const cropData = await cropInlineImageByBbox(
          inlineImage.inlineData.data,
          inlineImage.inlineData.mimeType,
          bboxToUse,
          true,
          dynamicPad
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
    includeQuestionIds: ai1IncludeIds.length > 0 ? ai1IncludeIds : undefined,
    answerKeyQuestions: answerKeyQuestions
  })
  const ai1Parts = [{ text: ai1TextPrompt }]
  for (const q of classifyAligned) {
    if (!q.visible) continue
    const crop = allQuestionCropMap.get(q.questionId)
    if (!crop) continue
    ai1Parts.push({ text: `--- 題目 ${q.questionId}（類型：${q.questionType}）---` })
    ai1Parts.push({ inlineData: crop })
  }

  // ── A3(AI1) + A4(AI2): Detail read + Global read IN PARALLEL ──
  // AI2 now uses the same per-question crops as AI1 (instead of the full image).
  // Reason: full-image reading caused AI2 to read the wrong row in table-style
  // calculation questions (positional confusion in dense answer grids), and also
  // caused single_check to output option text characters instead of symbol labels.
  // Per-question crops anchor AI2 to the correct answer cell; using buildDetailReadPrompt
  // ensures the prompt correctly describes the crop-based format.
  const globalReadPrompt = buildDetailReadPrompt(classifyResult, { answerKeyQuestions })
  const ai2Parts = [{ text: globalReadPrompt }]
  for (const q of classifyAligned) {
    if (!q.visible) continue
    const crop = allQuestionCropMap.get(q.questionId)
    if (!crop) continue
    ai2Parts.push({ text: `--- 題目 ${q.questionId}（類型：${q.questionType}）---` })
    ai2Parts.push({ inlineData: crop })
  }
  logStaged(pipelineRunId, stagedLogLevel, '3-AI read mode', {
    ai1CropCount: ai1IncludeIds.length,
    ai2CropCount: ai2Parts.filter((p) => p.inlineData).length
  })
  const parallelCalls = [
    // AI1: detail read (crop images only)
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_DETAIL_READ,
      stageContents: [{ role: 'user', parts: ai1Parts }]
    }),
    // AI2: global read (same per-question crops as AI1, different prompt/reading style)
    executeStage({
      apiKey,
      model,
      payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER,
      stageContents: [{ role: 'user', parts: ai2Parts }]
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
          true,
          dynamicPad
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
      // Override AI1 (detail read) only — AI2 keeps its independent crop reading so AI3 can arbitrate
      readAnswerParsed = applyAnswerOverrides(readAnswerParsed, overrideMap)
      logStaged(pipelineRunId, 'basic', 'bracket-read overrides applied (AI1 only)', { count: overrideMap.size })
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
      // Override AI1 (detail read) only — AI2 keeps its independent crop reading so AI3 can arbitrate
      readAnswerParsed = applyAnswerOverrides(readAnswerParsed, overrideMap)
      logStaged(pipelineRunId, 'basic', 'focused-checkbox-read overrides applied (AI1 only)', {
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
          // Override AI1 only — AI2 keeps its independent crop reading for AI3 arbitration
          readAnswerParsed = applyAnswerOverrides(readAnswerParsed, fallbackOverrideMap)
          for (const qId of fallbackOverrideMap.keys()) {
            overrideMap.set(qId, fallbackOverrideMap.get(qId))
          }
          logStaged(pipelineRunId, stagedLogLevel, 'focused-checkbox-read fallback overrides applied (AI1 only)', {
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
        // Force unreadable on AI1 only — AI2 may still have a valid crop read for AI3 to use
        readAnswerParsed = applyAnswerOverrides(readAnswerParsed, unresolvedOverrideMap)
        logStaged(pipelineRunId, stagedLogLevel, 'focused-checkbox-read unresolved forced-unreadable (AI1 only)', {
          count: unresolvedIds.length,
          questionIds: unresolvedIds
        })
      }
    }
  }

  // ── A3d: Focused multi_fill dual-read (two focused calls per question, replacing AI1 + AI2) ────
  // AI2's full-image read is unreliable for small diagram boxes (reads garbage).
  // Instead: run two focused crop reads with different prompt strategies, then let AI3 arbitrate.
  //   read-1 (direct): "transcribe what you see" → overrides AI1 (readAnswerParsed)
  //   read-2 (analytic): "stroke-by-stroke bopomofo analysis" → overrides AI2 (reReadAnswerParsed)
  const multiFillUncertainIds = new Set()  // hoisted: tracks questions with uncertain letter recognition (E/F etc.)
  const multiFillCropCandidates = classifyAligned.filter(
    (q) => q.visible && q.questionType === 'multi_fill' && allQuestionCropMap.has(q.questionId)
  )
  // 建立 multi_fill 題目的符號集對照表（根據答案卷的正確答案判斷）
  const multiFillCodeSetMap = new Map()
  const akByQidForMultiFill = mapByQuestionId(answerKeyQuestions, (q) => q?.id)
  for (const q of multiFillCropCandidates) {
    const akQ = akByQidForMultiFill.get(q.questionId)
    const correctAnswer = ensureString(akQ?.answer || akQ?.referenceAnswer, '').trim()
    const codeSet = detectMultiFillCodeSet(correctAnswer)
    multiFillCodeSetMap.set(q.questionId, codeSet)
  }
  if (multiFillCropCandidates.length > 0) {
    const codeSetSummary = {}
    multiFillCodeSetMap.forEach((v) => { codeSetSummary[v] = (codeSetSummary[v] || 0) + 1 })
    logStaged(pipelineRunId, 'basic', 'focused-multifill-read begin (dual: direct + analytic)', {
      count: multiFillCropCandidates.length,
      codeSetSummary
    })
    const inlineImage = inlineImages[0]
    const multiFillDualResults = await Promise.all(
      multiFillCropCandidates.map(async (q) => {
        const codeSet = multiFillCodeSetMap.get(q.questionId) || 'bopomofo'
        // read1: tight crop (pad=0.03) — same as allQuestionCropMap
        const cropTight = allQuestionCropMap.get(q.questionId)
        // read2: wide crop — more context, different view to catch bbox misalignment
        const cropWide = inlineImage
          ? await cropInlineImageByBbox(inlineImage.inlineData.data, inlineImage.inlineData.mimeType, q.answerBbox, true, dynamicPadWide)
          : cropTight
        const [res1, res2] = await Promise.all([
          executeStage({
            apiKey,
            model,
            payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
            timeoutMs: getRemainingBudget(),
            routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
            stageContents: [{ role: 'user', parts: [{ text: buildFocusedMultiFillReadPrompt(q.questionId, codeSet) }, { inlineData: cropTight }] }]
          }),
          executeStage({
            apiKey,
            model,
            payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
            timeoutMs: getRemainingBudget(),
            routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
            stageContents: [{ role: 'user', parts: [{ text: buildFocusedMultiFillReReadPrompt(q.questionId, codeSet) }, { inlineData: cropWide ?? cropTight }] }]
          })
        ])
        const answer1 = res1.ok ? (Array.isArray(parseCandidateJson(res1.data)?.answers) ? parseCandidateJson(res1.data).answers[0] : null) : null
        const answer2 = res2.ok ? (Array.isArray(parseCandidateJson(res2.data)?.answers) ? parseCandidateJson(res2.data).answers[0] : null) : null
        logStaged(pipelineRunId, 'basic', `focused-multifill-read dual qid=${q.questionId}`, {
          read1: answer1 ? { raw: answer1.studentAnswerRaw, status: answer1.status } : null,
          read2: answer2 ? { raw: answer2.studentAnswerRaw, status: answer2.status, uncertain: answer2.uncertainChars } : null
        })
        return { questionId: q.questionId, answer1, answer2 }
      })
    )
    const multiFillRead1Map = new Map()
    const multiFillRead2Map = new Map()
    // Populate multiFillUncertainIds (hoisted above) with questions flagged uncertain
    for (const { questionId, answer1, answer2 } of multiFillDualResults) {
      if (answer1) multiFillRead1Map.set(questionId, answer1)
      if (answer2) multiFillRead2Map.set(questionId, answer2)
      // read-2 uncertainChars (analytic mode)
      if (answer2 && Array.isArray(answer2.uncertainChars) && answer2.uncertainChars.length > 0) {
        multiFillUncertainIds.add(questionId)
      }
      // E/F detection is handled post-consistency by comparing student answer vs correct answer
      // (efFlaggedIds logic below). No AI-side detection needed — it was too aggressive.
    }
    if (multiFillUncertainIds.size > 0) {
      logStaged(pipelineRunId, 'basic', 'focused-multifill uncertain chars detected', {
        questionIds: [...multiFillUncertainIds]
      })
    }
    // Override AI1 (readAnswerParsed) with read-1 results
    if (multiFillRead1Map.size > 0) {
      readAnswerParsed = applyAnswerOverrides(readAnswerParsed, multiFillRead1Map)
      logStaged(pipelineRunId, 'basic', 'focused-multifill read-1 overrides applied → AI1', { count: multiFillRead1Map.size })
    }
    // Override AI2 (reReadAnswerParsed) with read-2 results — replacing unreliable full-image reads
    if (multiFillRead2Map.size > 0) {
      reReadAnswerParsed = reReadAnswerParsed ?? { answers: [] }
      reReadAnswerParsed = applyAnswerOverrides(reReadAnswerParsed, multiFillRead2Map)
      logStaged(pipelineRunId, 'basic', 'focused-multifill read-2 overrides applied → AI2', { count: multiFillRead2Map.size })
    }
  }

  // ── Mismatch detection: collect candidates from word_problem + calculation, then batch retry ──
  // A "candidate" = first-pass read shows calc-process result ≠ stated final answer.
  // Batch retry sends all candidates in one AI call to confirm (avoid serial per-question calls).
  const mismatchIds = new Set()

  // Candidates: { questionId, calcResult, firstPassNum, type: 'word_problem'|'calculation' }
  const mismatchCandidates = []
  const mainById = mapByQuestionId(
    Array.isArray(readAnswerParsed?.answers) ? readAnswerParsed.answers : [],
    (item) => item?.questionId
  )

  if (wordProblemIds.length > 0 && finalAnswerOnlyResponse?.ok) {
    const finalOnlyParsed = parseCandidateJson(finalAnswerOnlyResponse.data)
    if (finalOnlyParsed && typeof finalOnlyParsed === 'object') {
      const finalOnlyById = mapByQuestionId(
        Array.isArray(finalOnlyParsed.answers) ? finalOnlyParsed.answers : [],
        (item) => item?.questionId
      )
      for (const questionId of wordProblemIds) {
        const mainRow = mainById.get(questionId)
        const finalOnlyRow = finalOnlyById.get(questionId)
        if (!mainRow || !finalOnlyRow) continue
        if (finalOnlyRow.status === 'blank' || finalOnlyRow.status === 'unreadable') continue
        const calcResult = extractLastEquationResult(ensureString(mainRow.studentAnswerRaw, ''))
        const firstPassNum = extractAnswerNumber(ensureString(finalOnlyRow.studentAnswerRaw, ''))
        if (calcResult && firstPassNum && calcResult !== firstPassNum) {
          mismatchCandidates.push({ questionId, calcResult, firstPassNum, type: 'word_problem' })
        }
      }
    }
  }

  if (calculationIds.length > 0 && calcFinalAnswerResponse?.ok) {
    const calcFinalParsed = parseCandidateJson(calcFinalAnswerResponse.data)
    if (calcFinalParsed && typeof calcFinalParsed === 'object') {
      const calcFinalById = mapByQuestionId(
        Array.isArray(calcFinalParsed.answers) ? calcFinalParsed.answers : [],
        (item) => item?.questionId
      )
      for (const questionId of calculationIds) {
        const mainRow = mainById.get(questionId)
        const calcFinalRow = calcFinalById.get(questionId)
        if (!mainRow || !calcFinalRow) continue
        if (calcFinalRow.status === 'blank' || calcFinalRow.status === 'unreadable') continue
        const calcResult = extractLastEquationResult(ensureString(mainRow.studentAnswerRaw, ''))
        const firstPassNum = ensureString(calcFinalRow.studentAnswerRaw, '').replace(/,/g, '').trim()
        if (calcResult && firstPassNum && calcResult !== firstPassNum) {
          mismatchCandidates.push({ questionId, calcResult, firstPassNum, type: 'calculation' })
        }
      }
    }
  }

  // Batch retry: send all mismatch candidates in one AI call
  if (mismatchCandidates.length > 0) {
    const wordCandidateIds = mismatchCandidates.filter((c) => c.type === 'word_problem').map((c) => c.questionId)
    const calcCandidateIds = mismatchCandidates.filter((c) => c.type === 'calculation').map((c) => c.questionId)

    // Build a combined prompt covering both types in one call
    const retryParts = []
    if (wordCandidateIds.length > 0) retryParts.push({ text: buildWordProblemFinalAnswerPrompt(wordCandidateIds) })
    if (calcCandidateIds.length > 0) retryParts.push({ text: buildCalculationFinalAnswerPrompt(calcCandidateIds) })
    retryParts.push(...submissionImageParts)

    const retryResponse = await executeStage({
      apiKey,
      model,
      payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
      stageContents: [{ role: 'user', parts: retryParts }]
    })
    stageResponses.push(retryResponse)

    if (retryResponse.ok) {
      const retryParsed = parseCandidateJson(retryResponse.data)
      const retryAnswers = Array.isArray(retryParsed?.answers) ? retryParsed.answers : []
      const retryById = mapByQuestionId(retryAnswers, (a) => a?.questionId)

      for (const { questionId, calcResult, firstPassNum, type } of mismatchCandidates) {
        const retryRow = retryById.get(questionId)
        const retryNum = retryRow
          ? type === 'word_problem'
            ? extractAnswerNumber(ensureString(retryRow.studentAnswerRaw, ''))
            : ensureString(retryRow.studentAnswerRaw, '').replace(/,/g, '').trim()
          : null
        if (retryNum && calcResult !== retryNum) {
          mismatchIds.add(questionId)
          stageWarnings.push(
            `[ReadAnswer] CALC_ANSWER_MISMATCH questionId=${questionId} type=${type} calc=${calcResult} stated=${retryNum}`
          )
        }
      }
    } else {
      // Retry failed — conservatively flag all candidates as mismatch
      for (const { questionId, calcResult, firstPassNum, type } of mismatchCandidates) {
        mismatchIds.add(questionId)
        stageWarnings.push(
          `[ReadAnswer] CALC_ANSWER_MISMATCH questionId=${questionId} type=${type} calc=${calcResult} stated=${firstPassNum} (retry-failed)`
        )
      }
    }
    logStaged(pipelineRunId, stagedLogLevel, 'mismatch batch-retry', {
      candidates: mismatchCandidates.length,
      confirmed: mismatchIds.size
    })
  }

  // Normalize read1 with mismatch flags & unordered remap
  let readAnswerResult = applySelectionDisplayNormalization(
    normalizeReadAnswerResult(readAnswerParsed, questionIds, mismatchIds),
    answerKey
  )
  const unorderedRemap = remapReadAnswersForUnorderedGroups(answerKey, readAnswerResult)
  readAnswerResult = { ...readAnswerResult, answers: unorderedRemap.answers }

  // Normalize read2 (independent — no mismatch flags)
  const reReadAnswerResult = reReadAnswerParsed
    ? applySelectionDisplayNormalization(
        normalizeReadAnswerResult(reReadAnswerParsed, questionIds, new Set()),
        answerKey
      )
    : { answers: [] }

  // ── Read Answer Quality Gate ────────────────────────────────────────────
  const visibleQuestionIds = classifyAligned.filter((q) => q.visible).map((q) => q.questionId)
  const readQG = validateReadAnswerQuality(readAnswerResult, reReadAnswerResult, visibleQuestionIds, classifyAligned)
  logStaged(pipelineRunId, 'basic', 'read-answer quality-gate', {
    severity: readQG.severity, warnings: readQG.warnings, metrics: readQG.metrics
  })

  // ── Cross-stage: Classify → Read consistency ──────────────────────────────
  const classifyReadQG = validateClassifyReadConsistency(classifyResult, readAnswerResult)
  logStaged(pipelineRunId, 'basic', 'cross-stage classify→read quality-gate', {
    severity: classifyReadQG.severity, warnings: classifyReadQG.warnings, metrics: classifyReadQG.metrics
  })

  // If both read quality AND cross-stage fail → likely a systematic bbox issue.
  // Re-run classify once, then re-crop and re-read (costly but necessary).
  if (readQG.severity === QG_SEVERITY.FAIL && classifyReadQG.severity === QG_SEVERITY.FAIL) {
    logStaged(pipelineRunId, stagedLogLevel, 'read+classify cross-stage FAIL → flagging for batch-level retry')
    stageWarnings.push('[QualityGate] read+classify cross-stage FAIL (bbox systematic issue likely)')
  } else if (readQG.severity === QG_SEVERITY.FAIL) {
    stageWarnings.push(`[QualityGate] read quality FAIL: ${readQG.warnings.join(', ')}`)
  }

  // ── A5: CONSISTENCY CHECK (pure logic, no crops yet) ─────────────────────
  const read1ById = mapByQuestionId(readAnswerResult.answers, (item) => item?.questionId)
  const read2ById = mapByQuestionId(reReadAnswerResult.answers, (item) => item?.questionId)

  const questionResultsRaw = questionIds.map((questionId) => {
    const read1 = read1ById.get(questionId)
    const read2 = read2ById.get(questionId)
    const classifyRow = classifyAligned.find((q) => q.questionId === questionId)
    // Force unstable for multi_fill questions flagged as uncertain (E/F underline ambiguity, etc.)
    const isUncertain = multiFillUncertainIds?.has(questionId)
    const efMergeReason = isUncertain ? 'E/F 底線重疊：字母底部與底線黏合，無法確認是 E 還是 F' : undefined
    const consistencyStatus = isUncertain
      ? 'unstable'
      : read1 && read2
        ? computeConsistencyStatus(read1, read2, classifyRow?.questionType ?? 'other')
        : 'unstable'
    // 包含關係時，若 AI2 較短，記錄應覆寫的答案（在最終結果建構時套用）
    const containmentPreferredRaw = consistencyStatus === 'stable' && read1 && read2
      ? getContainmentPreferredRaw(read1, read2, classifyRow?.questionType ?? 'other')
      : null
    return {
      questionId,
      consistencyStatus,
      containmentPreferredRaw,
      consistencyReason: efMergeReason,
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


  // ── E↔F underline ambiguity detection ─────────────────────────────────────
  // When student answer differs from correct answer ONLY by E↔F substitution,
  // force needs_review because F on an underline looks identical to E.
  // This check runs after consistency (both AIs may agree on the wrong letter).
  const efFlaggedIds = new Set()
  for (const qr of questionResultsRaw) {
    if (qr.questionType !== 'multi_fill') continue
    const akQ = akByIdForLog.get(qr.questionId)
    const correctAnswer = ensureString(akQ?.answer, '').toUpperCase().trim()
    if (!correctAnswer) continue
    const studentAnswer = ensureString(qr.readAnswer1.studentAnswer, '').toUpperCase().trim()
    if (!studentAnswer || studentAnswer === correctAnswer) continue
    // Check if the ONLY difference is E↔F substitution
    const correctTokens = correctAnswer.split(/[,、，\s]+/).map((t) => t.trim()).filter(Boolean)
    const studentTokens = studentAnswer.split(/[,、，\s]+/).map((t) => t.trim()).filter(Boolean)
    if (correctTokens.length !== studentTokens.length) continue
    let hasEFSwap = false
    let hasOtherDiff = false
    for (let i = 0; i < correctTokens.length; i++) {
      if (correctTokens[i] === studentTokens[i]) continue
      const pair = [correctTokens[i], studentTokens[i]].sort().join('')
      if (pair === 'EF') {
        hasEFSwap = true
      } else {
        hasOtherDiff = true
      }
    }
    if (hasEFSwap && !hasOtherDiff) {
      qr.consistencyStatus = 'unstable'
      qr.consistencyReason = 'E/F 底線模糊：學生答案與正確答案僅差 E↔F，可能是底線導致辨識錯誤'
      efFlaggedIds.add(qr.questionId)
    }
  }
  if (efFlaggedIds.size > 0) {
    logStaged(pipelineRunId, 'basic', 'E↔F underline ambiguity flagged', Array.from(efFlaggedIds))
  }

  // ── Attach crop image URLs for teacher review (uses allQuestionCropMap from pre-AI1 step) ──
  // Priority: per-question crop (allQuestionCropMap) → full image fallback (map_fill, no bbox, etc.)
  const cropByQuestionId = allQuestionCropMap  // alias for internal _internal reference
  const fullImageDataUrl = inlineImages.length > 0
    ? `data:${inlineImages[0].inlineData.mimeType};base64,${inlineImages[0].inlineData.data}`
    : undefined

  // ── English spelling verification: override AI2 for English fill_blank/short_answer ──
  // AI's language model auto-corrects spelling (e.g. "dinng" → "dining").
  // This step uses a comparison-based approach: give the correct answer as reference
  // and ask AI to find character-level differences in the student's handwriting.
  const isEnglishDomainForSpelling = (internalContext?.domainHint || '').includes('英語') ||
    answerKey?.englishRules?.punctuationCheck?.enabled || answerKey?.englishRules?.wordOrderCheck?.enabled
  const englishSpellingCandidates = isEnglishDomainForSpelling
    ? questionResultsRaw.filter((qr) => {
        const qt = qr.questionType
        return (qt === 'fill_blank' || qt === 'short_answer') &&
          qr.readAnswer1.status === 'read' &&
          qr.readAnswer1.studentAnswer &&
          qr.readAnswer1.studentAnswer !== '未作答'
      })
    : []

  if (englishSpellingCandidates.length > 0) {
    const akByQid = mapByQuestionId(answerKeyQuestions, (q) => q?.id)
    const spellingItems = englishSpellingCandidates
      .map((qr) => {
        const akQ = akByQid.get(qr.questionId)
        const correctAnswer = ensureString(akQ?.answer || akQ?.referenceAnswer, '').trim()
        if (!correctAnswer) return null
        return { questionId: qr.questionId, correctAnswer }
      })
      .filter(Boolean)

    if (spellingItems.length > 0) {
      const spellingPrompt = `You are a SPELLING CHECKER for English handwriting. You are given cropped images of student handwriting and the correct answer for each question.

Your job: compare what the student ACTUALLY WROTE (letter by letter) to the correct answer. Find ANY spelling differences.

CRITICAL: DO NOT auto-correct. If the student wrote "dinng", report "dinng" NOT "dining". If the student wrote "kitchan", report "kitchan" NOT "kitchen".

For each question:
1. Spell out each letter the student wrote, separated by dashes (e.g. "d-i-n-n-g")
2. Compare to the correct answer letter by letter
3. Report the student's ACTUAL text (with any misspellings preserved)

Questions to verify:
${spellingItems.map((item) => `- "${item.questionId}": correct answer = "${item.correctAnswer}"`).join('\n')}

Return JSON:
{
  "spellingResults": [
    {
      "questionId": "string",
      "studentSpelling": "d-i-n-n-g r-o-o-m",
      "studentText": "dinng room",
      "matchesCorrect": false,
      "differences": "letter 4: student wrote 'n', expected 'i'"
    }
  ]
}
`
      const spellingParts = [{ text: spellingPrompt }]
      for (const item of spellingItems) {
        const qr = questionResultsRaw.find((q) => q.questionId === item.questionId)
        const crop = allQuestionCropMap.get(item.questionId)
        if (crop && qr) {
          spellingParts.push({ text: `--- 題目 ${item.questionId}（正確答案：${item.correctAnswer}）---` })
          spellingParts.push({ inlineData: crop })
        }
      }

      try {
        logStaged(pipelineRunId, 'basic', 'english-spelling-verify begin', { count: spellingItems.length })
        const spellingResponse = await executeStage({
          apiKey, model,
          payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
          timeoutMs: getRemainingBudget(),
          routeHint,
          routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
          stageContents: [{ role: 'user', parts: spellingParts }]
        })
        if (spellingResponse.ok) {
          const spellingParsed = parseCandidateJson(spellingResponse.data)
          const results = Array.isArray(spellingParsed?.spellingResults) ? spellingParsed.spellingResults : []
          const overrideCount = { applied: 0, skipped: 0 }
          for (const result of results) {
            const qId = ensureString(result?.questionId, '')
            const studentText = ensureString(result?.studentText, '').trim()
            if (!qId || !studentText) continue
            const qr = questionResultsRaw.find((q) => q.questionId === qId)
            if (!qr) continue
            // Override AI2 with spelling verification result
            const prevAi2 = qr.readAnswer2.studentAnswer
            if (studentText.toLowerCase() !== prevAi2.toLowerCase()) {
              qr.readAnswer2 = { status: 'read', studentAnswer: studentText }
              // 拼寫驗證覆蓋後，強制 diff — 不讓 Jaccard 相似度判回 stable
              // （Jaccard 只看字元集，"dining" 和 "dinng" 有相同字元集但拼寫不同）
              qr.consistencyStatus = 'diff'
              qr.spellingOverride = true
              overrideCount.applied++
              console.log(`[english-spelling-override] ${qId} AI2 "${prevAi2}" → "${studentText}" (forced diff)`)
            } else {
              overrideCount.skipped++
            }
          }
          logStaged(pipelineRunId, 'basic', 'english-spelling-verify result', overrideCount)
        }
      } catch (err) {
        console.warn('[english-spelling-verify] failed, continuing without override:', err?.message)
      }
    }
  }

  // ── English spacing review: flag questions where any AI reads extra/missing spaces ──
  if (isEnglishDomainForSpelling) {
    const akByQid2 = mapByQuestionId(answerKeyQuestions, (q) => q?.id)
    for (const qr of questionResultsRaw) {
      if (qr.questionType !== 'fill_blank') continue
      const akQ = akByQid2.get(qr.questionId)
      const correctAnswer = ensureString(akQ?.answer || akQ?.referenceAnswer, '').trim()
      if (!correctAnswer) continue

      const ai1 = ensureString(qr.readAnswer1?.studentAnswer, '').trim()
      const ai2 = ensureString(qr.readAnswer2?.studentAnswer, '').trim()
      if (!ai1 && !ai2) continue

      // 去掉空格後比較：如果字母相同但空格不同，代表可能有空格問題
      const stripSpaces = (s) => s.replace(/\s+/g, '').toLowerCase()
      const correctStripped = stripSpaces(correctAnswer)
      const ai1HasSpacingDiff = ai1 && stripSpaces(ai1) === correctStripped && ai1.toLowerCase() !== correctAnswer.toLowerCase()
      const ai2HasSpacingDiff = ai2 && stripSpaces(ai2) === correctStripped && ai2.toLowerCase() !== correctAnswer.toLowerCase()

      if (ai1HasSpacingDiff || ai2HasSpacingDiff) {
        qr.consistencyStatus = 'diff'
        qr.spacingReviewFlag = true
        console.log(`[english-spacing-review] ${qr.questionId} flagged: ai1="${ai1}" ai2="${ai2}" correct="${correctAnswer}"`)
      }
    }
  }

  // ── AI3 Arbiter (serial): compare AI1/AI2 results and make evidence-based decision ──
  // Filter: skip questions where both AI1 and AI2 are blank (auto agree) or both unreadable (auto needs_review)
  const akByQidForArbiter = isEnglishDomainForSpelling ? mapByQuestionId(answerKeyQuestions, (q) => q?.id) : null
  const arbiterItems = questionResultsRaw
    .filter((qr) => {
      const s1 = qr.readAnswer1.status
      const s2 = qr.readAnswer2.status
      if (s1 === 'blank' && s2 === 'blank') return false
      if (s1 === 'unreadable' && s2 === 'unreadable') return false
      return true
    })
    .map((qr) => {
      const isCalcType = qr.questionType === 'calculation' || qr.questionType === 'word_problem'
      const useFinalAnswerOnly = isCalcType && qr.consistencyStatus === 'stable'
      // calculation/word_problem stable：傳提取後的最終答案給 AI3，避免步驟格式差異
      // 導致 AI3 看到兩段不同文字卻被標為 agree 而混淆；完整文字仍保留給 accessor
      const ai1Answer = useFinalAnswerOnly
        ? (extractFinalAnswerFromCalc(qr.readAnswer1.studentAnswer) ?? qr.readAnswer1.studentAnswer)
        : qr.readAnswer1.studentAnswer
      const ai2Answer = useFinalAnswerOnly
        ? (extractFinalAnswerFromCalc(qr.readAnswer2.studentAnswer) ?? qr.readAnswer2.studentAnswer)
        : qr.readAnswer2.studentAnswer
      // English fill_blank/short_answer: attach correctAnswer for spelling evidence
      const isEnglishSpellingType = isEnglishDomainForSpelling &&
        (qr.questionType === 'fill_blank' || qr.questionType === 'short_answer')
      const correctAnswer = isEnglishSpellingType && akByQidForArbiter
        ? ensureString(akByQidForArbiter.get(qr.questionId)?.answer || akByQidForArbiter.get(qr.questionId)?.referenceAnswer, '').trim()
        : undefined
      return {
        questionId: qr.questionId,
        questionType: qr.questionType,
        ai1Answer,
        ai1Status: qr.readAnswer1.status,
        ai2Answer,
        ai2Status: qr.readAnswer2.status,
        agreementStatus: qr.consistencyStatus === 'stable' ? 'agree' : 'disagree',
        disagreementReason: qr.consistencyReason === 'uncertain_chars' ? 'uncertain_chars' : undefined,
        correctAnswer: correctAnswer || undefined
      }
    })

  // ── Pre-arbiter: single_choice/true_false with different numeric answers → directly needs_review ──
  // AI3 can't reliably resolve "2 vs 3" — both are clear readings, it's a coin flip.
  // Skip AI3 and let the teacher decide.
  const SIMPLE_ANSWER_TYPES = new Set([
    'single_choice', 'true_false', 'single_check',
    'multi_choice', 'multi_check', 'multi_check_other',
    'fill_blank', 'fill_variants'
  ])
  const directReviewIds = new Set()
  for (const item of arbiterItems) {
    if (!SIMPLE_ANSWER_TYPES.has(item.questionType)) continue
    if (item.agreementStatus === 'agree') continue
    // Both are read status with different short answers → genuine ambiguity
    const a1 = ensureString(item.ai1Answer, '').trim()
    const a2 = ensureString(item.ai2Answer, '').trim()
    if (a1 && a2 && a1 !== a2 && item.ai1Status === 'read' && item.ai2Status === 'read') {
      directReviewIds.add(item.questionId)
    }
  }
  if (directReviewIds.size > 0) {
    logStaged(pipelineRunId, 'basic', 'single_choice direct needs_review (skip AI3)', Array.from(directReviewIds))
  }

  const arbiterByQuestionId = new Map()
  // Pre-populate direct review decisions (bypass AI3)
  for (const qId of directReviewIds) {
    arbiterByQuestionId.set(qId, { arbiterStatus: 'needs_review', directReview: true })
  }
  // Filter out direct-review items from AI3 input
  const arbiterItemsForAI3 = arbiterItems.filter((item) => !directReviewIds.has(item.questionId))
  if (arbiterItemsForAI3.length > 0) {
    try {
      // Build AI3 parts: text prompt + full image + interleaved (label + crop) per question
      const arbiterPromptText = buildArbiterPrompt(arbiterItemsForAI3)
      const arbiterParts = [{ text: arbiterPromptText }, ...submissionImageParts]
      for (const item of arbiterItemsForAI3) {
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
        const forensics = Array.isArray(arbiterParsed?.forensics) ? arbiterParsed.forensics : []
        for (const f of forensics) {
          const qId = ensureString(f?.questionId).trim()
          if (!qId) continue
          const item = arbiterItems.find((i) => i.questionId === qId)
          if (!item) continue
          // multi_fill disagree → always needs_review regardless of AI3 rating
          // (注音符號視覺相似度高，AI3 鑑識同樣容易誤判，只有 agree 才信任自動通過)
          if (item.questionType === 'multi_fill' && item.agreementStatus === 'disagree') {
            arbiterByQuestionId.set(qId, {
              arbiterStatus: 'needs_review',
              forensicMode: ensureString(f.mode, ''),
              ai1Support: f.ai1Support,
              ai2Support: f.ai2Support
            })
            continue
          }
          const decision = applyForensicDecision(f, item.ai1Answer, item.ai2Answer)
          // English spelling evidence: if AI3 found spelling differences, force needs_review
          const hasSpellingDiff = f.spellingEvidence?.differences?.length > 0
          if (hasSpellingDiff && item.correctAnswer) {
            console.log(`[english-spelling-arbiter] ${qId} AI3 found spelling differences:`, JSON.stringify(f.spellingEvidence))
          }
          arbiterByQuestionId.set(qId, {
            arbiterStatus: hasSpellingDiff && item.correctAnswer ? 'needs_review' : decision.arbiterStatus,
            finalAnswer: hasSpellingDiff && item.correctAnswer ? undefined : decision.finalAnswer,
            forensicMode: ensureString(f.mode, ''),
            agreementSupport: f.agreementSupport,
            ai1Support: f.ai1Support,
            ai2Support: f.ai2Support,
            spellingEvidence: f.spellingEvidence || undefined
          })
        }
        logStaged(pipelineRunId, stagedLogLevel, 'AI3 forensic summary', {
          sent: arbiterItems.length,
          received: forensics.length,
          arbitrated_agree: Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus === 'arbitrated_agree').length,
          arbitrated_pick: Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus?.startsWith('arbitrated_pick')).length,
          needs_review: Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus === 'needs_review').length
        })
        logStaged(pipelineRunId, stagedLogLevel, 'AI3 forensic per-question', Array.from(arbiterByQuestionId.entries()).map(([qId, r]) => ({
          questionId: qId,
          arbiterStatus: r.arbiterStatus,
          finalAnswer: r.finalAnswer,
          forensicMode: r.forensicMode,
          agreementSupport: r.agreementSupport,
          ai1Support: r.ai1Support,
          ai2Support: r.ai2Support,
          spellingEvidence: r.spellingEvidence || undefined
        })))
      }
    } catch (arbiterErr) {
      logStaged(pipelineRunId, stagedLogLevel, 'AI3 arbiter failed (fallback to consistency status)', {
        error: arbiterErr?.message
      })
    }
  }

  // ── Arbiter Quality Gate (only check AI3 results, not direct-review items) ──
  const ai3ResultCount = arbiterByQuestionId.size - directReviewIds.size
  if (ai3ResultCount > 0) {
    const arbiterResults = Array.from(arbiterByQuestionId.entries())
      .filter(([qId]) => !directReviewIds.has(qId))
      .map(([, v]) => v)
    const arbiterExpectedIds = arbiterItemsForAI3.map((item) => item.questionId)
    const arbiterQG = validateArbiterQuality(arbiterResults, arbiterExpectedIds)
    logStaged(pipelineRunId, 'basic', 'arbiter quality-gate', {
      severity: arbiterQG.severity, warnings: arbiterQG.warnings, metrics: arbiterQG.metrics
    })
    if (arbiterQG.severity === QG_SEVERITY.FAIL) {
      stageWarnings.push(`[QualityGate] arbiter FAIL: ${arbiterQG.warnings.join(', ')}`)
    }
  }

  // Build final questionResults with arbiterResult attached
  const questionResults = questionResultsRaw.map((qr) => {
    let arbiterResult = arbiterByQuestionId.get(qr.questionId) ?? (() => {
      // Auto-determine for questions not processed by AI3
      const s1 = qr.readAnswer1.status
      const s2 = qr.readAnswer2.status
      if (s1 === 'blank' && s2 === 'blank') {
        return { arbiterStatus: 'arbitrated_agree', finalAnswer: '' }
      }
      if (s1 === 'unreadable' && s2 === 'unreadable') {
        return { arbiterStatus: 'needs_review' }
      }
      // AI3 didn't return this question (failed or missing) → fall back to consistency status
      return qr.consistencyStatus === 'stable'
        ? { arbiterStatus: 'arbitrated_agree', finalAnswer: qr.readAnswer1.studentAnswer }
        : { arbiterStatus: 'needs_review' }
    })()
    // 包含關係覆寫：AI2 較短時，用 AI2 答案取代 AI1（更精確，避免多讀鄰近內容）
    if (arbiterResult.arbiterStatus === 'arbitrated_agree' && qr.containmentPreferredRaw) {
      arbiterResult = { ...arbiterResult, finalAnswer: qr.containmentPreferredRaw }
    }

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

  // ── Table edge leak detection: flag suspicious table cell readings for teacher review ──
  // If a table cell's final answer matches the adjacent left cell's known value,
  // it's likely reading leaked content from the neighbor. Flag as needs_review.
  const akQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  const akByQuestionId = mapByQuestionId(akQuestions, (item) => item?.id)
  const tableLeakFlagged = []
  for (const qr of questionResults) {
    const akQ = akByQuestionId.get(qr.questionId)
    if (!akQ?.tablePosition || !qr.arbiterResult?.finalAnswer) continue
    if (qr.arbiterResult.arbiterStatus === 'needs_review') continue // already flagged
    // true_false 跳過：○/✗ 答案天然重複率高，相鄰格相同不代表讀錯
    if (qr.questionType === 'true_false') continue

    const col = akQ.tablePosition.col
    if (col <= 1) continue // no left neighbor

    // Find the answer key question at col-1 in the same table (same row, same totalCols)
    const leftNeighborAk = akQuestions.find((q) =>
      q.tablePosition &&
      q.tablePosition.col === col - 1 &&
      q.tablePosition.row === akQ.tablePosition.row &&
      q.tablePosition.totalCols === akQ.tablePosition.totalCols
    )
    // Check against left neighbor's answer key value OR left neighbor's read value
    const leftAkAnswer = leftNeighborAk?.answer ?? ''
    const leftReadQr = leftNeighborAk ? questionResults.find((r) => r.questionId === leftNeighborAk.id) : null
    const leftReadAnswer = leftReadQr?.arbiterResult?.finalAnswer ?? ''

    const finalAnswer = ensureString(qr.arbiterResult.finalAnswer, '').trim()
    const normFinal = finalAnswer.replace(/\s+/g, '')
    const normLeftAk = leftAkAnswer.replace(/\s+/g, '')
    const normLeftRead = leftReadAnswer.replace(/\s+/g, '')

    if (normFinal && (normFinal === normLeftAk || normFinal === normLeftRead)) {
      // Suspicious: this cell's reading matches its left neighbor → likely edge leak
      qr.arbiterResult = {
        ...qr.arbiterResult,
        arbiterStatus: 'needs_review',
        tableLeakSuspected: true,
        tableLeakReason: `讀到的「${finalAnswer}」與左方相鄰格（col=${col - 1}）的值相同，可能是裁切邊緣洩漏`
      }
      // Ensure crop image is attached for teacher review
      const cropData = allQuestionCropMap.get(qr.questionId)
      if (cropData) {
        qr.answerCropImageUrl = `data:${cropData.mimeType};base64,${cropData.data}`
      }
      tableLeakFlagged.push(qr.questionId)
    }
  }
  if (tableLeakFlagged.length > 0) {
    logStaged(pipelineRunId, 'basic', 'table edge leak flagged for review', tableLeakFlagged)
  }

  // ── English spacing review: force needs_review for questions flagged with spacing differences ──
  const spacingReviewFlagged = []
  for (const qr of questionResults) {
    const rawQr = questionResultsRaw.find((r) => r.questionId === qr.questionId)
    if (rawQr?.spacingReviewFlag && qr.arbiterResult?.arbiterStatus !== 'needs_review') {
      qr.arbiterResult = {
        ...qr.arbiterResult,
        arbiterStatus: 'needs_review',
        spacingReviewFlag: true,
        spacingReviewReason: '學生書寫可能有多餘空格，請老師確認'
      }
      const cropData = allQuestionCropMap.get(qr.questionId)
      if (cropData) {
        qr.answerCropImageUrl = `data:${cropData.mimeType};base64,${cropData.data}`
      }
      spacingReviewFlagged.push(qr.questionId)
    }
  }
  if (spacingReviewFlagged.length > 0) {
    logStaged(pipelineRunId, 'basic', 'english spacing flagged for review', spacingReviewFlagged)
  }

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

  // 答案卷模式 + 題本圖（answer_only 模式下 Explain 用題本圖而非學生答案卷）
  const answerSheetMode = internalContext?.answerSheetMode || 'with_questions'
  const rawBookletImages = Array.isArray(internalContext?.questionBookletImages) ? internalContext.questionBookletImages : []
  const questionBookletImageParts = rawBookletImages.map(img => ({
    inlineData: { mimeType: img.mimeType || 'image/webp', data: img.data }
  }))
  const explainImageParts = answerSheetMode === 'answer_only' && questionBookletImageParts.length > 0
    ? questionBookletImageParts
    : submissionImageParts

  const phaseBStartedAt = Date.now()
  const PHASE_B_BUDGET_MS = 180_000
  const getRemainingBudget = () => Math.max(1000, PHASE_B_BUDGET_MS - (Date.now() - phaseBStartedAt))

  // 將老師確認的 finalAnswers 轉為 readAnswerResult 格式
  const finalReadAnswerResult = finalAnswersToReadAnswerResult(finalAnswers)

  // ── Crop calculation/word_problem questions for Accessor visual grading ──
  // Accessor needs to see the student's handwritten work (not just AI-transcribed text)
  // to accurately judge calculation process, fraction notation, etc.
  const calcCropMap = new Map() // questionId → { data, mimeType }
  const calcTypes = new Set(['calculation', 'word_problem'])
  if (inlineImages.length > 0 && classifyResult) {
    const calcQuestions = (Array.isArray(classifyResult) ? classifyResult : classifyResult?.questions || [])
      .filter((q) => q.visible && q.answerBbox && calcTypes.has(q.questionType))
    if (calcQuestions.length > 0) {
      const img = inlineImages[0]?.inlineData
      if (img?.data && img?.mimeType) {
        const MAX_CALC_CROPS = 16 // 安全上限，避免 payload 過大
        const phaseBPages = new Set(questionIds.map((id) => { const m = id.match(/^(\d+)-/); return m ? parseInt(m[1], 10) : 1 })).size || 1
        const phaseBPad = +(0.01 / Math.max(1, phaseBPages)).toFixed(4)
        const cropTargets = calcQuestions.slice(0, MAX_CALC_CROPS)
        const cropResults = await Promise.all(
          cropTargets.map(async (q) => {
            const cropData = await cropInlineImageByBbox(img.data, img.mimeType, q.answerBbox, true, phaseBPad)
            return { questionId: q.questionId, cropData }
          })
        )
        for (const { questionId, cropData } of cropResults) {
          if (cropData) calcCropMap.set(questionId, cropData)
        }
        logStaged(pipelineRunId, stagedLogLevel, 'PhaseB calc crop for Accessor', {
          candidates: cropTargets.length,
          succeeded: calcCropMap.size
        })
      }
    }
  }

  // Helper: build accessor parts with optional calc/word_problem crop images
  function buildAccessorParts(promptText, questionIds, cropMap) {
    const parts = [{ text: promptText }]
    if (cropMap.size > 0) {
      for (const qId of questionIds) {
        const crop = cropMap.get(qId)
        if (crop) {
          parts.push({ text: `--- 題目 ${qId} 學生作答圖 ---` })
          parts.push({ inlineData: crop })
        }
      }
    }
    return parts
  }

  // ── B1: ACCESSOR (per-page parallel when multi-page) ─────────────────────
  const allAnswerIds = finalReadAnswerResult.answers.map((a) => ensureString(a?.questionId).trim())
  const page1AnswerIds = allAnswerIds.filter((id) => id.startsWith('1-'))
  const page2AnswerIds = allAnswerIds.filter((id) => id.startsWith('2-'))
  const otherAnswerIds = allAnswerIds.filter((id) => !id.startsWith('1-') && !id.startsWith('2-'))
  const canSplitAccessor = page1AnswerIds.length > 0 && page2AnswerIds.length > 0

  let accessorResult
  if (canSplitAccessor) {
    const p1Ids = new Set([...otherAnswerIds, ...page1AnswerIds])
    const p2Ids = new Set(page2AnswerIds)
    const filterAk = (ids) => ({ ...answerKey, questions: (answerKey?.questions || []).filter((q) => ids.has(ensureString(q?.id).trim())) })
    const filterRar = (ids) => ({ answers: finalReadAnswerResult.answers.filter((a) => ids.has(ensureString(a?.questionId).trim())) })
    const ak1 = filterAk(p1Ids); const ak2 = filterAk(p2Ids)
    const rar1 = filterRar(p1Ids); const rar2 = filterRar(p2Ids)

    logStageStart(pipelineRunId, 'Accessor-p1')
    logStageStart(pipelineRunId, 'Accessor-p2')
    const [accessorResp1, accessorResp2] = await Promise.all([
      executeStage({ apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(buildAccessorPrompt(ak1, rar1, internalContext?.domainHint), [...p1Ids], calcCropMap) }] }),
      executeStage({ apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(buildAccessorPrompt(ak2, rar2, internalContext?.domainHint), [...p2Ids], calcCropMap) }] })
    ])
    logStageEnd(pipelineRunId, 'Accessor-p1', accessorResp1)
    logStageEnd(pipelineRunId, 'Accessor-p2', accessorResp2)
    stageResponses.push(accessorResp1, accessorResp2)
    if (!accessorResp1.ok || !accessorResp2.ok) {
      const failed = !accessorResp1.ok ? accessorResp1 : accessorResp2
      return {
        status: failed.status,
        data: failed.data,
        pipelineMeta: {
          pipeline: STAGED_PIPELINE_NAME,
          prepareLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.prepareLatencyMs) || 0), 0),
          modelLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0),
          warnings: stageResponses.flatMap((r) => r.warnings || []),
          metrics: { stage: 'accessor' }
        }
      }
    }
    if (accessorResp1.warnings.length > 0) stageWarnings.push(...accessorResp1.warnings.map((w) => `[Accessor-p1] ${w}`))
    if (accessorResp2.warnings.length > 0) stageWarnings.push(...accessorResp2.warnings.map((w) => `[Accessor-p2] ${w}`))
    let parsed1 = parseCandidateJson(accessorResp1.data)
    let parsed2 = parseCandidateJson(accessorResp2.data)
    // Retry pages that failed to parse (model returned malformed JSON)
    if (!parsed1 || typeof parsed1 !== 'object') {
      console.warn(`[AI-5STAGE][${pipelineRunId}] Accessor-p1 JSON parse failed, retrying...`)
      logStageStart(pipelineRunId, 'Accessor-p1-retry')
      const retryResp1 = await executeStage({ apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(buildAccessorPrompt(ak1, rar1, internalContext?.domainHint), [...p1Ids], calcCropMap) }] })
      logStageEnd(pipelineRunId, 'Accessor-p1-retry', retryResp1)
      stageResponses.push(retryResp1)
      parsed1 = retryResp1.ok ? parseCandidateJson(retryResp1.data) : null
      if (!parsed1 || typeof parsed1 !== 'object') {
        console.warn(`[AI-5STAGE][${pipelineRunId}] Accessor-p1 retry also failed, returning error`)
        return {
          status: 503,
          data: JSON.stringify({ error: 'PhaseB accessor parse failed after retry (p1)', code: 'ACCESSOR_PARSE_FAILED' }),
          pipelineMeta: {
            pipeline: STAGED_PIPELINE_NAME,
            prepareLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.prepareLatencyMs) || 0), 0),
            modelLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0),
            warnings: [...stageWarnings, 'GRADING_ACCESSOR_P1_PARSE_FAILED'],
            metrics: { stage: 'accessor-p1-retry' }
          }
        }
      }
    }
    if (!parsed2 || typeof parsed2 !== 'object') {
      console.warn(`[AI-5STAGE][${pipelineRunId}] Accessor-p2 JSON parse failed, retrying...`)
      logStageStart(pipelineRunId, 'Accessor-p2-retry')
      const retryResp2 = await executeStage({ apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(buildAccessorPrompt(ak2, rar2, internalContext?.domainHint), [...p2Ids], calcCropMap) }] })
      logStageEnd(pipelineRunId, 'Accessor-p2-retry', retryResp2)
      stageResponses.push(retryResp2)
      parsed2 = retryResp2.ok ? parseCandidateJson(retryResp2.data) : null
      if (!parsed2 || typeof parsed2 !== 'object') {
        console.warn(`[AI-5STAGE][${pipelineRunId}] Accessor-p2 retry also failed, returning error`)
        return {
          status: 503,
          data: JSON.stringify({ error: 'PhaseB accessor parse failed after retry (p2)', code: 'ACCESSOR_PARSE_FAILED' }),
          pipelineMeta: {
            pipeline: STAGED_PIPELINE_NAME,
            prepareLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.prepareLatencyMs) || 0), 0),
            modelLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0),
            warnings: [...stageWarnings, 'GRADING_ACCESSOR_P2_PARSE_FAILED'],
            metrics: { stage: 'accessor-p2-retry' }
          }
        }
      }
    }
    const result1 = normalizeAccessorResult(parsed1, ak1, rar1.answers, internalContext?.domainHint)
    const result2 = normalizeAccessorResult(parsed2, ak2, rar2.answers, internalContext?.domainHint)
    accessorResult = { scores: [...(result1.scores || []), ...(result2.scores || [])] }
  } else {
    const accessorPrompt = buildAccessorPrompt(answerKey, finalReadAnswerResult, internalContext?.domainHint)
    logStageStart(pipelineRunId, 'Accessor')
    const accessorResponse = await executeStage({
      apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR,
      stageContents: [{ role: 'user', parts: buildAccessorParts(accessorPrompt, allAnswerIds, calcCropMap) }]
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
    if (accessorResponse.warnings.length > 0) stageWarnings.push(...accessorResponse.warnings.map((w) => `[Accessor] ${w}`))
    let accessorParsed = parseCandidateJson(accessorResponse.data)
    if (!accessorParsed || typeof accessorParsed !== 'object') {
      console.warn(`[AI-5STAGE][${pipelineRunId}] Accessor JSON parse failed, retrying...`)
      logStageStart(pipelineRunId, 'Accessor-retry')
      const retryResp = await executeStage({ apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(accessorPrompt, allAnswerIds, calcCropMap) }] })
      logStageEnd(pipelineRunId, 'Accessor-retry', retryResp)
      stageResponses.push(retryResp)
      accessorParsed = retryResp.ok ? parseCandidateJson(retryResp.data) : null
      if (!accessorParsed || typeof accessorParsed !== 'object') {
        console.warn(`[AI-5STAGE][${pipelineRunId}] Accessor retry also failed, returning error`)
        return {
          status: 503,
          data: JSON.stringify({ error: 'PhaseB accessor parse failed after retry', code: 'ACCESSOR_PARSE_FAILED' }),
          pipelineMeta: {
            pipeline: STAGED_PIPELINE_NAME,
            prepareLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.prepareLatencyMs) || 0), 0),
            modelLatencyMs: stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0),
            warnings: [...stageWarnings, 'GRADING_ACCESSOR_PARSE_FAILED'],
            metrics: { stage: 'accessor-retry' }
          }
        }
      }
    }
    accessorResult = normalizeAccessorResult(accessorParsed, answerKey, finalReadAnswerResult.answers, internalContext?.domainHint)
  }
  // ── Accessor Quality Gate ─────────────────────────────────────────────────
  const accessorExpectedIds = Array.isArray(finalReadAnswerResult?.answers)
    ? finalReadAnswerResult.answers.filter((a) => a.status === 'read').map((a) => a.questionId)
    : questionIds
  const accessorQG = validateAccessorQuality(accessorResult, accessorExpectedIds)
  logStaged(pipelineRunId, 'basic', 'accessor quality-gate', {
    severity: accessorQG.severity, warnings: accessorQG.warnings, metrics: accessorQG.metrics
  })
  if (accessorQG.severity === QG_SEVERITY.FAIL && !accessorResult._retried) {
    logStaged(pipelineRunId, stagedLogLevel, 'accessor quality FAIL → retry (1/1)')
    // Re-run accessor using single-page prompt (full question set)
    const retryPrompt = buildAccessorPrompt(answerKey, finalReadAnswerResult, internalContext?.domainHint)
    const retryContents = [{ role: 'user', parts: buildAccessorParts(retryPrompt, allAnswerIds, calcCropMap) }]
    logStageStart(pipelineRunId, 'Accessor-qg-retry')
    const retryAccessorResp = await executeStage({
      apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR,
      stageContents: retryContents
    })
    logStageEnd(pipelineRunId, 'Accessor-qg-retry', retryAccessorResp)
    stageResponses.push(retryAccessorResp)
    if (retryAccessorResp.ok) {
      const retryParsed = parseCandidateJson(retryAccessorResp.data)
      if (retryParsed && typeof retryParsed === 'object') {
        const retryResult = normalizeAccessorResult(retryParsed, answerKey, finalReadAnswerResult.answers, internalContext?.domainHint)
        const retryQG = validateAccessorQuality(retryResult, accessorExpectedIds)
        logStaged(pipelineRunId, 'basic', 'accessor retry quality-gate', {
          severity: retryQG.severity, warnings: retryQG.warnings
        })
        // Use retry result if it's better (fewer FAIL warnings)
        if (retryQG.severity !== QG_SEVERITY.FAIL || retryQG.warnings.length < accessorQG.warnings.length) {
          accessorResult = retryResult
          accessorResult._retried = true
        }
      }
    }
  }

  // ── Cross-stage: Read → Accessor consistency ────────────────────────────
  const readAccessorQG = validateReadAccessorConsistency(finalReadAnswerResult, accessorResult)
  logStaged(pipelineRunId, 'basic', 'cross-stage read→accessor quality-gate', {
    severity: readAccessorQG.severity, warnings: readAccessorQG.warnings, metrics: readAccessorQG.metrics
  })
  if (readAccessorQG.severity !== QG_SEVERITY.PASS) {
    stageWarnings.push(`[QualityGate] read→accessor: ${readAccessorQG.warnings.join(', ')}`)
  }

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
      internalContext?.domainHint,
      answerSheetMode
    )
    logStageStart(pipelineRunId, 'explain')
    const explainResponse = await executeStage({
      apiKey,
      model,
      payload,
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_EXPLAIN,
      stageContents: [{ role: 'user', parts: [{ text: explainPrompt }, ...explainImageParts] }]
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
    // ── Explain Quality Gate + Retry ──────────────────────────────────────
    const explainQG = validateExplainQuality(explainResult, explainQuestionIds)
    logStaged(pipelineRunId, 'basic', 'explain quality-gate', {
      severity: explainQG.severity, warnings: explainQG.warnings, metrics: explainQG.metrics
    })
    if (explainQG.severity === QG_SEVERITY.FAIL) {
      logStaged(pipelineRunId, stagedLogLevel, 'explain quality FAIL → retry (1/1)')
      logStageStart(pipelineRunId, 'explain-qg-retry')
      const retryExplainResp = await executeStage({
        apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_EXPLAIN,
        stageContents: [{ role: 'user', parts: [{ text: explainPrompt }, ...explainImageParts] }]
      })
      logStageEnd(pipelineRunId, 'explain-qg-retry', retryExplainResp)
      stageResponses.push(retryExplainResp)
      if (retryExplainResp.ok) {
        const retryParsed = parseCandidateJson(retryExplainResp.data)
        if (retryParsed && typeof retryParsed === 'object') {
          const retryResult = normalizeExplainResult(retryParsed, explainQuestionIds)
          const retryQG = validateExplainQuality(retryResult, explainQuestionIds)
          logStaged(pipelineRunId, 'basic', 'explain retry quality-gate', {
            severity: retryQG.severity, warnings: retryQG.warnings
          })
          if (retryQG.severity !== QG_SEVERITY.FAIL || retryQG.warnings.length < explainQG.warnings.length) {
            explainResult = retryResult
          }
        }
      }
    }
  } else {
    logStaged(pipelineRunId, stagedLogLevel, 'skip stage=explain reason=no_wrong_questions')
  }

  // B3: Locate removed — bbox from Phase A Classify is accurate enough
  const locateResult = { locatedQuestions: [] }

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
- multi_fill: See MULTI-FILL SCORING above.
- word_problem: This is a correction submission.
    * Check BOTH: (1) a calculation formula/process is present, AND (2) an answer sentence starts with "答：" or "A：" and contains a number+unit (or full text answer).
    * UNIT RULE: if the expected answer has a unit, the student's unit must match OR be an equivalent pair per the UNIT EQUIVALENCE TABLE above (e.g. "60 km/h" = "60 公里/小時" ✓). Wrong unit that is not an equivalent pair → not passed.
    * Must show the student understood the mistake and corrected it meaningfully.
- calculation: This is a correction submission.
    * Check BOTH: (1) the student shows corrected formula/process or meaningful recalculation, AND (2) final numeric result is correct.
    * HARD RULE: NEVER require "答：" / "A：" / "Ans:" format for calculation.
    * If the student writes extra intermediate steps, do not fail only because of extra steps; focus on correctness.
    * LENIENT FOCUS RULE: when item.strictness = "lenient", prioritize 最終答案. If final numeric answer is correct, allow pass even if process is brief.
- short_answer / map_draw: This is a correction submission.
    * Judge based on referenceAnswer and whether the student demonstrates genuine understanding of the concept.
    * The answer does not need to be perfect, but must show the student understood their mistake and addressed it meaningfully.
    * LENIENT FOCUS RULE: when item.strictness = "lenient":
      - if questionCategory=short_answer and item.domain is "社會" or "自然": treat core conclusion as decisive. If core conclusion is semantically correct, pass even if supporting evidence is brief.
    * Do NOT require fixed answer sentence format such as "答：" / "A：" for short_answer.
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
