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
import { extractPhaseALogData, extractPhaseBLogData, saveGradingStageLog } from './stage-log-writer.js'

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

// questionCategory → bucket 'A'|'B'|'C'|'D' (single source of truth, mirrors db.ts QUESTION_CATEGORY_TO_BUCKET)
// Server cannot import from client, so this is a parallel definition. Must stay in sync with db.ts.
const QUESTION_CATEGORY_TO_BUCKET = {
  // Bucket A — 標準答案 + 精確比對
  single_choice: 'A',
  multi_choice: 'A',
  circle_select_one: 'A',
  circle_select_many: 'A',
  single_check: 'A',
  multi_check: 'A',
  true_false: 'A',
  fill_blank: 'A',
  multi_fill: 'A',
  matching: 'A',
  ordering: 'A',
  mark_in_text: 'A',
  calculation: 'A',     // 數學計算題：只看最終答案
  word_problem: 'A',    // 數學應用題：只看最終答案（含單位）
  // Bucket B — 標準答案 + 容多元
  fill_variants: 'B',
  map_fill: 'B',
  // Bucket C — Rubric 給分（純文字 or 繪圖評鑑）
  short_answer: 'C',
  map_symbol: 'C',
  grid_geometry: 'C',
  connect_dots: 'C',
  diagram_draw: 'C',
  diagram_color: 'C',
  // Bucket D — 複合題（多部分有依存關係，必須一起評分）
  compound_circle_with_explain: 'D',
  compound_check_with_explain: 'D',
  compound_writein_with_explain: 'D',
  multi_check_other: 'D',
  compound_judge_with_correction: 'D',
  compound_judge_with_explain: 'D',
  compound_chain_table: 'D',
}

/**
 * Resolve bucket from question. Reads from question.bucket first, then derives from questionCategory.
 * Legacy `type` 1|2|3 fallback removed — old data must have questionCategory or bucket.
 */
function resolveQuestionBucket(question) {
  if (question?.bucket) return question.bucket
  if (question?.questionCategory && QUESTION_CATEGORY_TO_BUCKET[question.questionCategory]) {
    return QUESTION_CATEGORY_TO_BUCKET[question.questionCategory]
  }
  return 'A' // default
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
  return 'off' // 預設關閉細節 log，只保留 'basic' 標記的（quality-gate + per-question summary）
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
      // readingReasoning: AI's reasoning trace (理解 → 抄錄 → 輸出); accepts legacy formatBReasoning as fallback.
      const reasoning = item?.readingReasoning || item?.formatBReasoning
      if (reasoning) {
        entry.readingReasoning = ensureString(reasoning, '')
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
// useActualBbox=true：直接使用 bbox 的實際範圍（map_symbol / grid_geometry / connect_dots 等大面積區域用）
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
      // customPad 可以是數值（四邊等距）或 { padX, padY }（水平/垂直分開）
      const padX = customPad !== null ? (typeof customPad === 'object' ? customPad.padX : customPad) : 0.03
      const padY = customPad !== null ? (typeof customPad === 'object' ? customPad.padY : customPad) : 0.03
      px = Math.max(0, bbox.x - padX)
      py = Math.max(0, bbox.y - padY)
      px2 = Math.min(1, bbox.x + bbox.w + padX)
      py2 = Math.min(1, bbox.y + bbox.h + padY)
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

function resolveExpectedQuestionType(question) {
  let category = ensureString(question?.questionCategory, '').trim()
  if (!category) {
    const dimNames = Array.isArray(question?.rubricsDimensions)
      ? question.rubricsDimensions.map((dim) => ensureString(dim?.name, '')).join('|')
      : ''
    if (/算式過程|最終答案/.test(dimNames)) category = 'calculation'
    else if (resolveQuestionBucket(question) === 'C') category = 'short_answer'
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

  // 3) Map-specific categories should remain as-is when explicitly set
  if (category === 'map_fill') return category
  if (category === 'map_symbol' || category === 'grid_geometry' || category === 'connect_dots') return category
  // Legacy compat: old data with map_draw maps to map_symbol (most common drawType)
  if (category === 'map_draw') return 'map_symbol'

  // 4) Some legacy category mappings
  // fill_variants 行為跟 fill_blank 對 OCR 來說相同（容多元差異在 grading 階段才用），所以 collapse
  if (category === 'fill_variants') return 'fill_blank'
  // short_answer 是獨立 type（自由文字段落），不再 collapse 到 word_problem
  if (CLASSIFY_ALLOWED_TYPES.has(category)) return category

  // 5) Fallback by bucket (no questionCategory matched any allowed type)
  const bucket = resolveQuestionBucket(question)
  if (bucket === 'C') return 'word_problem' // Rubric → 預設 word_problem
  if (bucket === 'B') return 'fill_blank'   // 容多元 → 預設 fill_blank
  return 'fill_blank' // default
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

/**
 * 27 type 對應 6 種 bboxPolicy（行為導向）。
 *
 * - full_page          : 整張圖（map_fill）
 * - group_shared      : 同 group 子題共享 bbox（matching）
 * - large_visual_area : 大範圍視覺區（圖/長文/工作區）
 * - compound_linked   : 多部分連動，必須整題框（含理由/改正/其他欄/連動 cell）
 * - answer_with_context: 答案區 + 鄰近印刷元素（選項/方框/文章上下文）
 * - tight_answer      : 緊框答案空格（含 multi_fill 每子題各自一個 tight bbox）
 */
function resolveBboxPolicyByQuestionType(questionType) {
  // full_page (1)
  if (questionType === 'map_fill') return 'full_page'

  // group_shared (1)
  if (questionType === 'matching') return 'group_shared'

  // large_visual_area (9)
  if (
    questionType === 'map_symbol' ||
    questionType === 'grid_geometry' ||
    questionType === 'connect_dots' ||
    questionType === 'diagram_draw' ||
    questionType === 'diagram_color' ||
    questionType === 'short_answer' ||
    questionType === 'ordering' ||
    questionType === 'calculation' ||
    questionType === 'word_problem'
  ) return 'large_visual_area'

  // compound_linked (7) — 全部 D bucket，包含表格連動題
  if (
    questionType === 'compound_circle_with_explain' ||
    questionType === 'compound_check_with_explain' ||
    questionType === 'compound_writein_with_explain' ||
    questionType === 'compound_judge_with_correction' ||
    questionType === 'compound_judge_with_explain' ||
    questionType === 'multi_check_other' ||
    questionType === 'compound_chain_table'
  ) return 'compound_linked'

  // answer_with_context (6)
  if (
    questionType === 'circle_select_one' ||
    questionType === 'circle_select_many' ||
    questionType === 'single_check' ||
    questionType === 'multi_check' ||
    questionType === 'multi_choice' ||
    questionType === 'mark_in_text'
  ) return 'answer_with_context'

  // tight_answer (5) — single_choice / true_false / fill_blank / fill_variants / multi_fill
  return 'tight_answer'
}

function buildClassifyQuestionSpecs(questionIds, answerKeyQuestions) {
  const questions = Array.isArray(answerKeyQuestions) ? answerKeyQuestions : []
  const byQuestionId = mapByQuestionId(questions, (item) => item?.id)

  // 計算 fill_blank 子題的 ordinal（同行第幾個）和 blankRow（第幾行）
  // e.g. 1-3-1-1 和 1-3-1-2 → parentId=1-3-1, ordinal=1/2, total=2
  // e.g. 1-3-1-x, 1-3-2-x, 1-3-3-x → grandParentId=1-3, blankRow=1/2/3, totalRows=3
  const fillBlankOrdinalMap = new Map()
  const parentGroups = new Map()  // parentId → [qId, ...]（同行的子題）
  const grandParentGroups = new Map()  // grandParentId → Set<parentId>（同題組的行）
  for (const qId of questionIds) {
    const parts = qId.split('-')
    if (parts.length < 3) continue
    const q = byQuestionId.get(qId)
    const expectedType = q ? resolveExpectedQuestionType(q) : 'fill_blank'
    if (expectedType !== 'fill_blank') continue
    if (q?.tablePosition) continue
    const parentId = parts.slice(0, -1).join('-')
    if (!parentGroups.has(parentId)) parentGroups.set(parentId, [])
    parentGroups.get(parentId).push(qId)
    // 4+ segment IDs: 計算 blankRow（grandParent 層級的行數）
    if (parts.length >= 4) {
      const grandParentId = parts.slice(0, -2).join('-')
      if (!grandParentGroups.has(grandParentId)) grandParentGroups.set(grandParentId, [])
      const rows = grandParentGroups.get(grandParentId)
      if (!rows.includes(parentId)) rows.push(parentId)
    }
  }
  // 計算 ordinal（同行第幾個）
  for (const [, children] of parentGroups) {
    if (children.length < 2) continue
    for (let i = 0; i < children.length; i++) {
      fillBlankOrdinalMap.set(children[i], { ordinal: i + 1, totalBlanks: children.length })
    }
  }
  // 計算 blankRow（同題組第幾行）
  for (const [, rows] of grandParentGroups) {
    if (rows.length < 2) continue
    for (let r = 0; r < rows.length; r++) {
      const parentId = rows[r]
      const children = parentGroups.get(parentId) || []
      for (const qId of children) {
        const existing = fillBlankOrdinalMap.get(qId) || {}
        fillBlankOrdinalMap.set(qId, { ...existing, blankRow: r + 1, totalRows: rows.length })
      }
    }
  }

  return questionIds.map((questionId) => {
    const question = byQuestionId.get(questionId)
    const expectedType = question ? resolveExpectedQuestionType(question) : 'fill_blank'
    const bboxPolicy = resolveBboxPolicyByQuestionType(expectedType)
    const spec = {
      questionId,
      questionType: expectedType,
      bboxPolicy
    }
    if (bboxPolicy === 'group_shared') {
      const groupId = resolveMatchingGroupId(question)
      if (groupId) spec.bboxGroupId = groupId
    }
    // anchorHint only helps for multi_fill and fill_blank sub-questions (3+ ID segments, e.g. "1-2-1").
    // For single_choice / single_check / etc., the hint describes the answer key's circled option, which
    // causes classify to narrow the bbox onto just that option text — shifting it upward.
    const isFillBlankSubQ = questionId.split('-').length >= 3 && expectedType === 'fill_blank'
    const anchorHintUsefulTypes = new Set(['multi_fill', 'fill_blank'])
    const isSubQuestion = questionId.split('-').length >= 3
    const akAnchorHint = ensureString(question?.anchorHint, '').trim()
    const skipAnchorForFillBlankSubQ = isFillBlankSubQ
    if (akAnchorHint && anchorHintUsefulTypes.has(expectedType) && (expectedType !== 'fill_blank' || isSubQuestion) && !skipAnchorForFillBlankSubQ) {
      spec.anchorHint = akAnchorHint
    }
    // fill_blank 子題加上 ordinal（同一行第幾個填空）
    const ordinalInfo = fillBlankOrdinalMap.get(questionId)
    if (ordinalInfo) {
      spec.blankOrdinal = ordinalInfo.ordinal
      spec.blankTotal = ordinalInfo.totalBlanks
      if (ordinalInfo.blankRow) {
        spec.blankRow = ordinalInfo.blankRow
        spec.blankRowTotal = ordinalInfo.totalRows
      }
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

  const bucket = resolveQuestionBucket(question)
  if (bucket === 'A' || bucket === 'D') {
    pushVariant(question?.answer)
  } else if (bucket === 'B') {
    pushVariant(question?.referenceAnswer)
    if (Array.isArray(question?.acceptableAnswers)) {
      for (const value of question.acceptableAnswers) pushVariant(value)
    }
  } else {
    // bucket === 'C'
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
    const questionType = CLASSIFY_ALLOWED_TYPES.has(qt) ? qt : 'other'
    alignedQuestions.push({
      questionId,
      visible,
      questionType,
      questionBbox: normalizeBboxRef(row?.questionBbox ?? row?.question_bbox),
      answerBbox: normalizeBboxRef(row?.answerBbox ?? row?.answer_bbox),
      bracketBbox: (questionType === 'circle_select_one' || questionType === 'circle_select_many') ? normalizeBboxRef(row?.bracketBbox) : undefined,
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

function applyClassifyQuestionSpecs(classifyResult, questionSpecs, totalPages = 1) {
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

    if (bboxPolicy === 'full_page') {
      questionBbox = fullImageBbox
      answerBbox = fullImageBbox
    } else {
      if (!questionBbox && answerBbox) questionBbox = answerBbox
      if (!answerBbox && questionBbox) answerBbox = questionBbox
    }

    // 表格題：不在第一輪強制 x，保留 classify 原始偵測值，第二輪統一修正

    // 括號型 fill_blank 子題：第一輪只標記，第三輪統一修正 y
    // 表格型填空有 tablePosition → 跳過
    const isSubQ = questionType === 'fill_blank' && questionId.split('-').length >= 3
    const isParenSubQ = isSubQ && !spec?.tablePosition

    return {
      ...row,
      questionType,
      bboxPolicyApplied: bboxPolicy || undefined,
      bboxGroupId: bboxGroupId || undefined,
      questionBbox,
      answerBbox,
      bracketBbox:
        (questionType === 'circle_select_one' || questionType === 'circle_select_many') ? normalizeBboxRef(row?.bracketBbox) : undefined
    }
  })

  // 表格題第二輪：混合定位 — refBbox 提供相對間距，classify 提供絕對位置校準
  // 1. 收集每格的 classify.x 和 refBbox.x
  // 2. 計算中位數 offset（掃描水平偏移量）
  // 3. 所有格子 x = refBbox.x + offset（保持精確相對間距，修正掃描偏移）
  // 4. w = 欄間距 - padding（避免看到鄰格）
  const TABLE_CELL_PADDING = 0.008
  const pageScale = 1 / (totalPages || 1) // per-page coords → full-image coords 的比例
  const tableGroups = new Map() // key = "row-totalCols-totalRows" → [{index, col, classifyX, refX, refW, refH}]
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
      refW: tp.refBbox.w || 0,
      refH: tp.refBbox.h || 0
    })
  }
  for (const members of tableGroups.values()) {
    // 計算掃描偏移量：classify.x 與 refBbox.x 的中位數差距
    const offsets = members.map((m) => m.classifyX - m.refX)
    offsets.sort((a, b) => a - b)
    const medianOffset = offsets.length % 2 === 1
      ? offsets[Math.floor(offsets.length / 2)]
      : (offsets[offsets.length / 2 - 1] + offsets[offsets.length / 2]) / 2

    // 計算目標列的最大高度：refBbox.h（per-page）轉 full-image，給 1.5 倍餘量
    const refHFullImage = (members[0].refH || 0.02) * pageScale
    const maxH = Math.max(refHFullImage * 1.5, 0.005)

    if (members.length < 2) {
      // 單格：用 refBbox.x + offset，用 refBbox.w，限制 h
      const m = members[0]
      const q = alignedQuestions[m.index]
      if (q.answerBbox) {
        const cappedH = Math.min(q.answerBbox.h, maxH)
        alignedQuestions[m.index] = { ...q, answerBbox: { ...q.answerBbox, x: +(m.refX + medianOffset).toFixed(4), w: m.refW, h: +cappedH.toFixed(4) } }
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
        // 限制 h：只裁切目標列，不包含表頭和人數列
        const cappedH = Math.min(q.answerBbox.h, maxH)
        alignedQuestions[m.index] = { ...q, answerBbox: { ...q.answerBbox, x: +safeX.toFixed(4), w: +safeW.toFixed(4), h: +cappedH.toFixed(4) } }
      }
    }
  }

  // 註：括號型 fill_blank 子題的「中心對稱擴寬 + 固定 h」後處理已移除。
  // 原本是為了避免中文數學「12 → 只框到 2」場景，但會把英文同行多空的 bbox
  // 往左推（手寫從底線左對齊往右溢出，中心對稱擴寬反而切到右側）。
  // 改由 classify prompt 的 UNDERLINE ANCHOR RULE 處理：bbox 右邊 = 底線最右端
  // OR 學生手寫右端，取較右者，自然涵蓋兩種場景。

  // matching group_context: same group shares one union bbox.
  const groupMeta = new Map()
  for (let index = 0; index < alignedQuestions.length; index += 1) {
    const row = alignedQuestions[index]
    if (row?.visible !== true) continue
    const spec = specByQuestionId.get(row.questionId)
    if (!spec || spec.bboxPolicy !== 'group_shared') continue
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
- bboxPolicy MUST follow Question Specs（6 種策略，依 type 行為決定 bbox 範圍）:
  - full_page: questionBbox and answerBbox must both be {x:0,y:0,w:1,h:1}（map_fill 用，整張圖）.
  - group_shared: questions in the same bboxGroupId MUST share the same questionBbox/answerBbox（matching 用）.
  - large_visual_area: bbox 涵蓋整個視覺/工作區域（map_symbol / grid_geometry / connect_dots / diagram_draw / diagram_color / short_answer / ordering / calculation / word_problem 用，含題幹+大範圍答題區）.
  - compound_linked: bbox 必須涵蓋整題所有部分（含理由/改正/開放欄/連動 cell）。**禁止只框其一**（compound_circle/check/writein_with_explain / compound_judge_with_correction/explain / multi_check_other / compound_chain_table 用）.
  - answer_with_context: bbox 涵蓋答案區 + 鄰近印刷元素（如預印選項、方框列、文章上下文）（circle_select_one/many / single_check / multi_check / multi_choice / mark_in_text 用）.
  - tight_answer: bbox 緊框答案空格本身，**不框題幹**（${isAnswerOnly ? 'single_choice / true_false / fill_blank / fill_variants / multi_fill 用，每子題各自一個 tight bbox' : 'single_choice / true_false / fill_blank / fill_variants / multi_fill 用，single_choice 約 25-35% 頁寬'}）.
- TABLE POSITION RULE (HIGHEST PRIORITY — when tablePosition is in spec, this overrides ANCHOR / TABLE_COLUMN / ORDERING rules):
    觸發：spec 帶 tablePosition (e.g. { col, row, totalCols, totalRows, colspan?, rowspan?, refBbox? })

    【規則優先順序】

    ① 空白格防漂移（最高優先 — bbox 位置由座標決定）：
       目標格內是否有學生手寫**完全不影響** bbox 位置。
       嚴禁因為目標格空白就把 bbox 漂移到相鄰有內容的格子。

    ② 格線偵測法（首選定位方法 — 必須在 STUDENT_SUBMISSION 上實際數格線）：
       1. 找到表格的外框邊界（最外圍的格線）
       2. 數垂直格線（含左右外框）：從左到右依序 V1, V2, V3, ..., V(N+1)。N+1 條 = N 欄
       3. 數水平格線（含上下外框）：從上到下依序 H1, H2, H3, ..., H(M+1)。M+1 條 = M 列
       4. 第 C 欄 = V(C) 與 V(C+1) 之間；第 R 列 = H(R) 與 H(R+1) 之間
       5. 驗證 totalCols：spec 給的 totalCols 應 = 你數的垂直線數 − 1。若不符，重新計數
       6. 目標格 bbox：x = V(col)，y = H(row)，w = V(col+1) − V(col)，h = H(row+1) − H(row)

    ③ 合併格處理（spec 帶 colspan / rowspan 時）：
       - colspan = K：bbox 寬度改為 V(col+K) − V(col)（橫跨 K 欄）
       - rowspan = K：bbox 高度改為 H(row+K) − H(row)（縱跨 K 列）

    ④ Fallback（格線不清時，例如被學生筆跡覆蓋、掃描品質差、表格無完整外框）：
       若無法清晰偵測格線，使用 spec.tablePosition.refBbox 作為座標起點。
       refBbox 是答案卷對應格座標，但水平可有最多 0.08（8% 頁寬）的掃描偏移。
       Fallback 時應以 refBbox 為基準，再用目視確認該格的水平範圍做小幅修正。

    ⑤ refBbox 一致性驗證（②路徑完成後執行）：
       將你算出的 bbox.x 與 refBbox.x 比對。
       差距 > 0.08（8% 頁寬）→ 強烈暗示格線計數有誤，請重新計數（回 ②.5）。
       y 值可信度高（同份試卷垂直 layout 一致），可作為 row 定位的初步驗證。

    ⑥ tablePositionReasoning（MANDATORY 輸出）：
       純文字格式：detected V-lines=[x1,x2,...]. Target col=N → V(N)=x, V(N+1)=x2. refBbox.x=X (verify). bbox=[x,y,w,h]
       若走 Fallback 路徑：fallback: refBbox-based, V-lines unclear due to [reason]. bbox=[x,y,w,h]
- For visible=true questions, output answerBbox per the type-specific rules below. Each rule specifies what to include (視覺+動作), what to frame, what to exclude (禁止), and any sub-rules.
  - ${isAnswerOnly ? 'ANSWER-ONLY MODE: bbox includes question number + answer area only; no question stem text exists on this sheet.' : 'Default principle: bbox should include question number + relevant printed elements + student\'s answer area, per the per-type rule.'}

  ── tight_answer 群組（緊框答案空格，不含題幹）──
  - For fill_blank 子題（questionId 含 3+ segments，如 "1-2-1"）：每個子題對應題幹中的一個空白標記（( )、□、___），學生在標記內寫值（含單位則一併寫）。answerBbox 緊框該空白標記區（含學生手寫），不含題幹。不可漂移到相鄰子題的空白、不可跨行。

    ⚠️ 兩階段框架（識別 → 定位 — 兩階段不衝突）：

    【階段 A：識別 WHICH — 先確定「目標空白是這行的第幾個」】
    依下列子規則優先級走：
    1. ANCHOR RULE（spec 帶 anchorHint）：以 anchorHint 描述為權威識別目標空白。anchorHint 是用來**找到目標空白**，不是 bbox 的起點座標。
    2. TABLE COLUMN RULE（anchorHint 指欄標題時）：bbox 左右邊**不可超出該欄邊界**；若可能含到鄰欄內容，必須縮小。
    3. ROW RULE（spec 帶 blankRow + blankRowTotal）：先由上至下數，找到第 blankRow 行，再進入該行。
    4. ORDINAL RULE（spec 帶 blankOrdinal + blankTotal）：在對的行內，從左到右數，目標 = 第 blankOrdinal 個空白。
    5. ORDERING RULE（無任何 hint）：依子題 ID 順序，TOP→BOTTOM、LEFT→RIGHT 對應。

    【階段 B：定位 WHERE — bbox 邊界**直接觀察底線/括號像素**】
    🚨 UNDERLINE ANCHOR RULE（最高優先）：
    階段 A 識別到目標空白後，bbox 邊界**必須直接觀察該底線/括號本身的像素位置**，
    **不可**用「鄰近印刷單字」當 bbox 起點的代理。
    - bbox 左邊 = 該底線/括號最左端的像素
    - bbox 右邊 = 該底線/括號最右端的像素 OR 學生手寫的右端，取較右者（容忍 overflow）
    - 上下 = 含學生手寫筆跡的高度，含一點上下邊距
    - 兩空格之間的印刷字（in / the / is / 是 / 的）必須在 bbox 之外

    ❌ 同行多空最常見的 bug（必須避免）：
    - ❌ 看 anchorHint 說「Mom is 後的底線」，就把 bbox 起點放在 "is" 字後面
      → 用印刷字位置「推算」底線位置 → bbox 偏左 → 切到學生手寫「cookin」尾巴
    - ❌ 看到「___ in the ___」，把 "the" 當第二底線的 anchor → bbox 起點落在 "the"
      → 還沒到第二底線就開始畫 → 切錯位置

    🔍 視覺自我檢查：
    bbox 左邊**第一眼看到的應該是底線/括號的起點**，不該是任何印刷字母。
    若你的 bbox 左邊有印刷字母（i / t / n / 是 / 的）→ anchor 選錯了，重畫。

    範例：
    - 括號型：「答案是(　　　)元」→ 框 (　　　) 這個括號內部
    - 方框型：「2½ □ (4.73 □ 2.73)」→ 框該 □ 格本身
    - 底線型：「___公尺」→ 框 ___ 這個底線區
    - 同行多空（英文常見）：「Mom is _____ in the _____.」blankTotal=2
       ✅ ordinal=1 → bbox 緊框第 1 個 _____ 像素，含手寫 cooking
       ✅ ordinal=2 → bbox 緊框第 2 個 _____ 像素，含手寫 kitchen
       ❌ 從 "is" 推位置 → bbox 偏左 → 切到 "cookin" 尾
       ❌ 從 "the" 推位置 → bbox 偏左 → 切到 "kitche" 尾
  - For fill_blank 單一空格（questionId 1-2 segments，如 "3"、"1-2"）：題目可能含 1 個或多個空白標記，整題只有一個 questionId（不分子題）。answerBbox 緊框該題所有空白標記（含學生手寫），不含題幹。不可漂移到鄰題的空白。
  - For fill_variants：規則同 fill_blank（容多元說法是 Read 階段的判斷，classify 階段處理方式相同）。
  - For single_choice / multi_choice / true_false：學生在空括號 (   ) 內寫代號或符號（A/B/C/甲/乙/①/②、○/✗ 等）。single_choice / true_false 寫 1 個；multi_choice 寫多個（如 "A,C"）。answerBbox 緊框該空括號，左右各加少許邊距以容忍對齊誤差。不可含題幹文字、不可延伸到下方選項清單行。寬度約占頁寬 25-35%，以括號為中心。
  - For multi_fill：圖中有多個固定位置的空白格（地圖標記、表格儲存格、圖片標籤等），每個子題對應一格。answerBbox 緊框該子題對應的單一空白格（含學生手寫），不含題幹。不可含到鄰格、不可跨格、不可重疊到其他子題的 bbox；若格子很小且擁擠，bbox 寧可縮小也不要重疊。
    子規則（依優先級）：
    1. ANCHOR RULE（spec 帶 anchorHint）：以 anchorHint 描述為權威定位，最高優先。anchorHint 描述的是答案格本身，不要把 bbox 放在 landmark 文字上。
    2. TABLE COLUMN RULE（anchorHint 指欄標題時）：bbox 左右邊不可超出該欄邊界。
    3. ORDERING RULE（無任何 hint）：依子題 ID 順序，TOP→BOTTOM、LEFT→RIGHT 對應；最小 ID 對應最上方的格。

  ── answer_with_context 群組（答案區 + 鄰近印刷脈絡）──
  - For circle_select_one / circle_select_many：括號內預印多個選項（如「(同意／不同意)」），學生用筆跡圈/劃選其中一個或多個。answerBbox 必須完整框住該括號列（含全部預印選項文字 + 學生筆跡），左右各加少許邊距。不可只框圈圈本身、不可遺漏任何預印選項。
  - For single_check / multi_check：題目給一列選項，每個選項前面有 □（方形勾選框），學生在某個（些）□ 內打勾。answerBbox 涵蓋整列方框（含所有 □ + 對應選項文字 + 學生勾選筆跡）。不可只框被勾的那個 □、不可漏掉未勾的選項（Read 階段需看全列才能判斷學生選了哪個）。不可含題幹文字。
  - For mark_in_text（圈詞題）：題目是一段印刷文章，學生在文章內某些字詞上圈、底線、或標記。answerBbox 涵蓋題幹指示語（如「圈出文中表示時間的詞」）+ 整段文章區（含全部印刷文字 + 學生圈選筆跡），可框稍大以保留上下文。不可只框被圈的字詞（Read 階段需看全文才能判斷哪些被圈，所以 bbox 必須含未被圈的字）。

  ── group_shared 群組（同組共用同一 bbox）──
  - For matching：policy=group_shared。同一 bboxGroupId 的所有子題必須回傳**完全相同**的 questionBbox/answerBbox。answerBbox 涵蓋整組連連看（左欄全部項目 + 右欄全部選項 + 學生連線），讓老師能完整檢視該組配對狀況。不可只框單一連線、單一項目、或漏掉其中一欄。

  ── full_page 群組（整張圖）──
  - For map_fill：policy=full_page。answerBbox 與 questionBbox 都必須是 {x:0, y:0, w:1, h:1}（整張圖）。地圖填圖題的答案散布全圖各處，無法精確切割，整頁即一題。

  ── large_visual_area 群組（題幹 + 大答題區）──
  - For calculation / word_problem：題幹下方有大工作區，學生寫算式 + 最終答案。calculation 的最終答案在題幹「(    ) =」括號內；word_problem 的最終答案在工作區末尾的「答：」行。answerBbox 從題幹起，向下涵蓋所有算式行、直式、最終答案/答句。若 calculation 同時有「表格內最終答案格」+「另處工作區」，bbox 必須**同時涵蓋兩者**。不可只框最終答案格、不可漏掉學生在邊緣補寫的計算。
  - For short_answer（簡答題）：題目給一個大空白區，學生寫文字段落自由說明。answerBbox 涵蓋題幹 + 整個答題區（含學生所有手寫文字段落）。不可只框第一行；學生若補寫到旁白或邊緣，bbox 應略放寬以涵蓋。
  - For ordering（排序題）：題目給一列待排序項目，學生在每項旁邊或內部寫上 1, 2, 3, 4… 序號。answerBbox 涵蓋題幹 + 所有待排序項目區（含全部項目印刷文字 + 學生寫的所有序號）。不可只框單一序號、不可漏掉部分項目。
  - For map_symbol（地圖符號標記題）：題目給一張預印地圖，學生在某位置畫符號（▲/★/●）。answerBbox 涵蓋題幹 + 整張地圖 + 學生符號筆跡，bbox 略放寬以容忍符號落點。不可只框符號本身、不可漏掉地圖其他區（老師需看全圖判斷位置正確性）。
  - For grid_geometry（格線幾何繪製題）：題目給一張格線紙，學生依條件繪製幾何圖形（三角形、平行四邊形等）。answerBbox 涵蓋題幹 + 整個格線區 + 學生繪製的線條/弧線。學生線條可能延伸到格線邊緣，bbox 應略放寬。不可只框已繪製部分、不可漏掉空白格線區（老師需看完整格網判斷邊長/角度）。
  - For connect_dots（連點繪圖題）：題目給一個點陣，學生把指定點連起來形成圖形。answerBbox 涵蓋題幹 + 整個點陣區 + 學生連線。不可只框連線部分、不可漏掉未連的點（老師需看全部點才能判斷連線正確性）。
  - For diagram_draw / diagram_color：題目給一張預印的長條圖/圓餅圖/塗色區，學生繪製或塗色。answerBbox 涵蓋題幹 + 整個視覺區 + 學生筆跡，學生筆跡可能延伸到圖外，bbox 應略放寬以涵蓋；不可只框已繪製/塗色的區段、不可漏掉題幹。

  ── compound_linked 群組（複合題，必須完整框住所有部分）──
  - For compound_circle_with_explain / compound_check_with_explain / compound_writein_with_explain / compound_judge_with_correction / compound_judge_with_explain（5 個複合說明題）：policy=compound_linked。整題分**兩部分**：
    - 答案部分：依 type 不同
      · compound_circle_with_explain：括號內預印選項 + 學生圈選
      · compound_check_with_explain：□ 列 + 學生打勾
      · compound_writein_with_explain：空括號 + 學生寫代號
      · compound_judge_with_correction：括號內 ○/✗ + 下方改正空白
      · compound_judge_with_explain：括號內 ○/✗ + 下方說明區
    - 說明/改正部分：學生寫文字理由、正確改寫、或開放式說明
    answerBbox 必須**同時涵蓋兩部分**（含題幹、答案區、說明/改正區、以及兩部分之間的空白）。**禁止只框其一** — 只框答案 → 老師看不到說明；只框說明 → 老師看不到答案。
  - For multi_check_other（複選含其他題）：policy=compound_linked。一列方框中最後一個 □ 是「其他：___」開放欄。answerBbox 涵蓋題幹 + 整列方框 + 最後的「其他」開放欄（含學生在該欄手寫的文字）。不可只框前面方框、不可漏掉「其他」欄的學生手寫。
  - For compound_chain_table（表格連動題）：policy=compound_linked。題目是一個表格，學生在多個格內填值，前後格有依賴關係（前格答案影響後格判斷）。answerBbox 涵蓋題幹 + 整個表格區（含所有填寫格 + 表格欄/列標題）。不可只框單一格、不可只框學生填寫的格而漏掉表格標題（老師需看到欄位脈絡才能判斷對錯）。

  ── 通用要求 ──
  - The bbox must be ACCURATE and TIGHT to the rule (top-left corner = (x,y), width = w, height = h) using actual pixel proportions — do NOT output placeholder sizes.
  Format: { "x": 0.12, "y": 0.34, "w": 0.20, "h": 0.08 } where (x,y)=top-left corner, w=width, h=height, all normalized to [0,1].
  If the question region cannot be determined, omit answerBbox.
- For circle_select_one / circle_select_many questions: also output bracketBbox that frames ONLY the printed bracket row "（option1／option2…）" and the student's circle/mark inside it — do NOT include the question stem text. This should be a very tight crop of just that one bracket line, used by the focused bracket re-read stage. Omit bracketBbox if the bracket row cannot be located precisely.
- Return strict JSON only.
${Array.isArray(classifyCorrections) && classifyCorrections.length > 0 ? `
⚠️ BBOX POSITIONING REMINDER:
前一輪 Read 結果偵測到下列題目可能有 bbox 定位問題，請特別注意：
${classifyCorrections.map((c) => {
  if (c.type === 'neighbor_match') {
    return `- 題目 ${c.questionId}：此題學生答案恰好等於相鄰題目 ${c.neighborId} 的正解，bbox 可能飄移到鄰題空格。請仔細區分這兩題的空格邊界，確保各題框選到各自正確的空格。`
  }
  if (c.type === 'consecutive_blank') {
    return `- 題目 ${c.questionId}：此題與其他題目連續被讀為 blank/unreadable。請確認 answerBbox 確實對齊到該題的書寫區（不是漂移到題幹/空白區）。若 bbox 正確且學生確實留空，blank 是合理結論——不要為了「找筆跡」而誤把雜訊讀成內容。`
  }
  return ''
}).filter(Boolean).join('\n')}
` : ''}
Output schema:
{
  "alignedQuestions": [
    {
      "questionId": "1-2",
      "visible": true,
      "answerBbox": { "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.08 }
    }
  ]
}

Required fields:
- questionId: must match an Allowed question ID.
- visible: true/false.
- answerBbox: required when visible=true; omit if region cannot be determined.

Conditional fields (output ONLY when applicable; omit otherwise):
- bracketBbox: only for circle_select_one / circle_select_many.
  Format: { "x": ..., "y": ..., "w": ..., "h": ... }
- tablePositionReasoning: MANDATORY when spec includes tablePosition; otherwise omit.
  Format: "detected V-lines=[x1,x2,...]. Target col=N → V(N)=x. bbox=[x,y,w,h]"
- bboxGroupId: only for matching (echo from spec).

Do NOT output:
- questionType: fixed by spec, do not infer or echo.
- questionBbox: deprecated; answerBbox already covers the per-type framing.

When visible=false, omit all bbox fields.
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
  - For map_symbol / grid_geometry / connect_dots / diagram_draw / diagram_color: include the entire drawn/colored area plus the question stem.
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

Steps (write each step into readingReasoning):
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
      "readingReasoning": "理解：括號內預印兩選項 [LEFT] / [RIGHT]，學生用 [圈/底線/劃掉] 標記。抄錄：以「，」為錨點，標記中心在 [LEFT/RIGHT] 側。輸出：[word]。"
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

// ─────────────────────────────────────────────────────────────────────────────
// Layered prompt components (used by buildReadAnswerPrompt / buildReviewReadPrompt)
// Layer 1 = global, Layer 2 = domain, Layer 2-1 = type×domain,
// Layer 3 = reusable cross-type components, Layer 0 = role wrapper
// ─────────────────────────────────────────────────────────────────────────────

// Layer 1: 印刷物 vs 手寫筆跡 — universal rule preventing template contamination
const MARKUP_VS_HANDWRITING_RULE = `
== MARKUP-VS-HANDWRITING RULE（印刷物 vs 手寫筆跡）==
A test paper has TWO kinds of marks. You MUST distinguish them.

1. PRINTED CONTENT (印刷物 — NEVER the student's answer):
   - Question stem, instructions, option labels (A/B/C/D, ①②③④, 甲乙丙丁)
   - Pre-printed options inside parentheses, e.g. (同意／不同意), (大於／小於／等於)
   - Underlines ___ , empty parentheses ( ), checkboxes □, table grids
   - Question numbers, page numbers, watermarks
   - Visual cues (⚠️ COLOR is UNRELIABLE — focus on these instead):
     • UNIFORM stroke thickness (machine-typeset, no ink-pressure variation)
     • PERFECT alignment with baseline (no drift, no tilt)
     • GEOMETRIC regularity (perfect circles, straight lines, even spacing)
     • REPEATED identical glyphs across the page (same character looks pixel-identical)

2. HANDWRITING (手寫筆跡 — IS the student's answer):
   - See INK COLOR RULE above for ink color identification.
   - Visual cues (these matter MORE than color):
     • IRREGULAR stroke thickness (hand pressure varies along the stroke)
     • DRIFTS from baseline, slight tilt or curl
     • ORGANIC, non-geometric shapes (no two strokes look pixel-identical)
     • Marks may overlap, cross, or sit beside printed content
   - Includes the student's circles, underlines, cross-outs, and written words/numbers.

🚨 ABSOLUTE RULE: studentAnswerRaw reflects ONLY what the student physically did,
NEVER what is pre-printed. The "／" or "/" symbol between option words is a telltale
sign of PRINTED template — students very rarely draw "／" by hand.

Generic example:
  Page shows printed: 我（同意／不同意），因為
  Student's mark:    a circle drawn around 同意
  ✅ Correct output: 我（同意），因為...
  ❌ Wrong output:   我（同意／不同意），因為...   ← copied the printed template
`.trim()

// Layer 2: 社會領域共通段
const SOCIAL_DOMAIN_SECTION = `
== DOMAIN: 社會（Social Studies）==
Output language: 繁體中文.

Content type patterns (descriptive only — DO NOT enumerate examples, DO NOT prime
specific answers. The actual answers vary by exam and grade level):
- 專有名詞 (proper nouns): names of people, places, dynasties, historical events.
  These are typically the ANSWERS — never assume, never guess.
- 抽象概念 (abstract concepts): social, political, institutional phenomena.

Common question structures (structural patterns, not content):
- 結論+理由：「我認為（X），因為...」 — student picks stance from printed options + reason
- 史實簡答 — specific names, dates, events as answers
- 圖表閱讀 — handled in diagram_* types

Reading discipline (社會 specific):
- ⚠️ NEVER substitute synonyms or "more correct"-sounding alternatives.
  In 社會, similar-looking terms often refer to DIFFERENT concepts, periods, or regions.
  One character difference can completely change the meaning.
- The exact characters the student wrote ARE the answer of record — preserve faithfully,
  even if a more famous-looking variant exists with similar shape.
- For unclear handwriting, prefer "?" over guessing based on "what would make sense historically".
- ⚠️ Do NOT use general historical knowledge to bias your reading. The student's grade level,
  textbook, and curriculum determine the correct vocabulary — and you don't know any of these.
`.trim()

// Layer 2-1: word_problem × 社會 — SELF-CONTAINED replacement for generic WORD-PROBLEM rules.
// When this specialization is active, the generic rules are NOT also sent.
const SOCIAL_WORD_PROBLEM_FULL = `
WORD-PROBLEM × 社會 (questions in WORD-PROBLEM list — 社會 specialization, replaces generic):

Common pattern: the question stem typically has PRE-PRINTED options inside parentheses
(separated by "／", "/", or "，") followed by a free-form reason area:
   "我認為（X／Y），因為..."   or   "我（X／Y），因為..."

Students pick ONE option (by mark) AND write a reason after.

READING PROCEDURE:

A. PARENTHESES (printed options + student mark):
   Apply FORMAT_B_CIRCLE_IN_PARENS (component defined separately above).
   Output: parens containing ONLY the chosen option.
   🚫 NEVER output the full template "(X／Y)" verbatim — the "／" indicates printed text.

B. REASON TEXT (the free-form text after the parentheses):
   - LINE-BY-LINE: scan top to bottom. Each PHYSICAL LINE of handwriting → ONE output line.
     Separate output lines with "\\n".
   - The number of output lines MUST MATCH the number of physical handwritten lines visible.
   - DO NOT merge lines. DO NOT split lines. DO NOT reorder.
   - DO NOT insert content the student did not write.
   - SELF-CORRECTION (student crossed out with blue/black ink): SKIP the crossed-out line,
     keep the final intended version.

C. COMBINE: "[whatever prefix the student wrote](chosen option)[reason text]"
   Whatever the student physically wrote at the start — copy it as-is.

D. BLANK / UNREADABLE handling:
   - Both parens unmarked AND reason area empty → status="blank", studentAnswerRaw="未作答".
   - Parens marked but reason area empty → output "(chosen)" only, status="read".
   - Parens unclear but reason clear → "(?)，[reason]" with status="unreadable",
     readingReasoning explains why parens are unclear.
   - Reason has scattered illegible characters → use "?" for individual unclear chars
     within otherwise-readable text. Do NOT mark the whole answer unreadable.
`.trim()

// Layer 2-1 registry: lookup table for (type, domain) → specialization.
// When a (type, domain) pair has an entry here, the specialization REPLACES the generic
// type rule entirely (mode B). Add new specializations by adding entries below.
const TYPE_DOMAIN_OVERRIDES = {
  word_problem: {
    '社會': SOCIAL_WORD_PROBLEM_FULL
  }
  // Future: e.g. fill_blank: { '英語': ENGLISH_FILL_BLANK_FULL }
}

// Layer 3: FORMAT_B_CIRCLE_IN_PARENS reusable component
const FORMAT_B_CIRCLE_IN_PARENS_COMPONENT = `
== COMPONENT: FORMAT_B_CIRCLE_IN_PARENS ==
[Reusable — used by single_choice (FORMAT B), word_problem×社會, fill_blank×國語/社會, etc.]

DETECTION:
Activates when you see PRE-PRINTED parentheses containing 2+ option words separated
by "／", "/", or "，".

Pattern examples (structural, not answer content):
- (X／Y)             ← binary, slash separator
- (X，Y，Z)          ← ternary, comma separator
- ( yes / no )       ← English binary

The separator between options is your TELL — students rarely write "／" by hand.

STUDENT MARK TYPES (any one of):
  A. CIRCLE (圈起來) around one option
  B. CROSS-OUT (劃掉) on the unwanted option(s) — un-crossed = chosen
  C. UNDERLINE (底線) below one option
  D. CHECK (✓) next to or above one option
  E. WRITE-IN (寫字) beside the parens — overrides any mark inside

MANDATORY REASONING (fill readingReasoning field, follow 理解 → 抄錄 → 輸出 format):
  理解: identify printed options "OPTION_LEFT=[word], OPTION_RIGHT=[word]" and student mark type
  抄錄: spatial location of mark center relative to "／" / "，" separator
  輸出: which option the student chose

OUTPUT:
- studentAnswerRaw = original parens shape with ONLY the chosen option inside.
  - "(X／Y)" + circle on Y → "(Y)"
- If no mark anywhere on the parens → "(?)", status="unreadable".
- Multi-mark (multi-select context) → comma-join chosen options inside the parens.

🚫 ABSOLUTELY FORBIDDEN:
- Outputting the full template "(X／Y)" verbatim.
- Choosing by logic/meaning ("which option sounds right historically").
- (AI2) Using the correct answer hint to decide which option was marked.

✅ Choice is determined ONLY by the student's physical mark, not by meaning.
`.trim()

// Layer 0 (AI2 only): Anti-Bias Framework — replaces older DIGIT-1 SPECIAL CASE
const AI2_ANTI_BIAS_FRAMEWORK = `
== ANTI-BIAS FRAMEWORK (ABF) — AI2 ONLY ==
You see the correct answer in each question label. This creates COGNITIVE BIAS RISK.
You MUST recognize and resist the following four biases.

BIAS 1 — CONFIRMATION（確認偏誤）:
  Symptom: Correct answer is "150" → you "see" digits in a blank that aren't really there.
  Defense: Output ONLY physically visible handwriting. Empty → blank, even when answer is known.

BIAS 2 — OVER-CORRECTION（過度矯正）:
  Symptom: Knowing about Bias 1, you over-compensate by rejecting legitimate but minimal
           handwriting (e.g. dismissing a clear single vertical stroke as "noise" instead of "1").
  Defense: Minimal-but-clear strokes ARE real handwriting.
  Confirmed exceptions (always read as handwriting, never as noise):
    • DIGIT-1: a single vertical stroke in an answer space IS the digit "1".
      "1" 本來就只是一豎，這就是它的正常樣貌。

BIAS 3 — TEMPLATE CONTAMINATION（模板汙染）⭐:
  Symptom: Correct answer template includes "(同意／不同意)" and you see printed
           "(同意／不同意)" on the page. You output the template verbatim, thinking
           it matches.
  Defense: Printed template ≠ student answer. Apply MARKUP-VS-HANDWRITING.
           Only the student's circle/cross-out/written addition counts.
           "／" between options = printed; rarely handwritten.

BIAS 4 — COMPLETION（補完偏誤）:
  Symptom: Student wrote half a sentence; you mentally complete it to match the
           correct answer's full version.
  Defense: Student wrote what they wrote. Halfway → halfway.

MANDATORY WORKFLOW:
  1. Read the crop FIRST without looking at the correct answer.
  2. Form your initial reading.
  3. THEN consult the correct answer:
     - Matches → confirm and output.
     - Differs → re-examine carefully for missed strokes (Bias 2 defense),
       BUT only adjust if you genuinely see them.
  4. After re-examination, your reading still differs → report what you actually see.
     The student may genuinely have written something different.
`.trim()

// Layer 3: FORMAT_A_WRITE_IN — single-choice empty parens, student writes one symbol
const FORMAT_A_WRITE_IN_COMPONENT = `
== COMPONENT: FORMAT_A_WRITE_IN ==
[Reusable — used when student writes a SINGLE option identifier inside empty parentheses.]

Pattern: The parens "( )" are EMPTY in print; the student writes ONE symbol inside.
Valid symbols: A/B/C/D, 甲/乙/丙/丁, ①/②/③/④, or numeric digits (1/2/3/4) when the question uses numeric options.
Output exactly the written identifier. Example: student wrote "B" → output "B".
If parens are empty → blank. If symbol is unrecognizable → unreadable.
`.trim()

// Layer 3: INSERTION_MARK_HANDLING — student uses ∧ to insert text into a sentence
const INSERTION_MARK_HANDLING_COMPONENT = `
== COMPONENT: INSERTION_MARK_HANDLING ==
[Reusable — applies anywhere student wrote free-form text.]

If the student uses a handwritten ∧ or 入-shape symbol to indicate a text insertion:
- The tip of the symbol points to the insertion position in the original text.
- The inserted text is written above the symbol (between the symbol and the line above).
- Merge the inserted text into the original sentence at exactly that position.
- Output the COMPLETE merged result as if the insertion was always there. Do NOT mention the symbol.
- Follow the student's intent faithfully even if the merged result sounds grammatically odd.
- Example: student wrote "小明走路∧上學" with "快速" written above the ∧ → output "小明走路快速上學"
- Example: student wrote "答：速率為60∧" with "公尺" above the ∧ → output "答：速率為60公尺"
`.trim()

// Layer 3: VERTICAL_TO_HORIZONTAL — convert vertical (直式) arithmetic to horizontal equation
const VERTICAL_TO_HORIZONTAL_COMPONENT = `
== COMPONENT: VERTICAL_TO_HORIZONTAL ==
[Reusable — used by calculation and math word_problem when student writes 直式.]

If the student uses a vertical layout (直式加/減/乘/除), convert to a horizontal equation for output.
This counts as ONE output line. Copy the student's written numbers EXACTLY — do NOT recalculate or correct.
- 直式除法: identify dividend (被除數), divisor (除數), quotient (商), remainder (餘數 if any).
  Output as "[dividend]÷[divisor]=[quotient]" or "[dividend]÷[divisor]=[quotient]…[remainder]".
- 直式乘法: identify multiplicand, multiplier, product. Output as "[multiplicand]×[multiplier]=[product]".
- 直式加法/減法: output as "[top]±[bottom]=[result]".
- CRITICAL: Copy the student's written numbers as-is. If the student wrote a wrong quotient
  (e.g. 25 instead of 26), output 25. NEVER verify or correct the arithmetic.
`.trim()

// Layer 3: PROPORTION_TABLE_FORMATS — Taiwan-style ratio-scaling layouts
const PROPORTION_TABLE_FORMATS_COMPONENT = `
== COMPONENT: PROPORTION_TABLE_FORMATS ==
[Reusable — used by math word_problem and calculation.]

Students in Taiwan write ratio-scaling in several visual layouts. ALL count as valid 列式:

FORMAT A — Arrow style (×N↙↘×N):
       0.048 : 0.2
  ×1000↙         ↘×1000
       48    : ( )
  Output as: "0.048:0.2 ×1000 → 48:200"

FORMAT B — Divisor annotated between rows (÷N written on both sides or center):
       210 : 60
    ÷60        ÷60
     =3.5 :  1
  Output as: "210:60 ÷60 → 3.5:1"

FORMAT C — Bracket with divisor outside:
       260( 210 : 60 )÷60
            =3.5 : 1
  Output as: "210:60 ÷60 → 3.5:1"

Rules for all formats:
- Read BOTH rows completely, including the operator annotation (×N or ÷N) wherever it appears.
- The ÷N or ×N annotation IS part of the calculation — do NOT skip it even if small or at the edge.
- This two-row structure counts as valid 列式. Treat it the same as writing an explicit equation.
`.trim()

// Layer 2: 國語領域共通段
const MANDARIN_DOMAIN_SECTION = `
== DOMAIN: 國語（Mandarin Chinese）==
Output language: 繁體中文.

Content type patterns (descriptive only):
- 字詞 (vocabulary): characters, idioms, ci-yu (詞語), measure words.
- 句型 (sentence patterns): grammar, particle usage.
- 短文/閱讀理解 (short reading comprehension): student answers in their own words.

Reading discipline (國語 specific):
- ⚠️ NEVER substitute homophones or look-alike characters even if the swap "makes more sense".
  - 它/他/她, 在/再, 心裡/心理, 的/得/地 — each carries different meaning. Preserve the student's exact choice.
- 注音符號 (Bopomofo) may appear in young students' answers. Read each symbol exactly.
- Punctuation marks (。、，：；！？) are part of the answer when explicitly written.
- For 國語 fill_blank, the answer is usually 1–4 Chinese characters; longer continuous text suggests short_answer.
`.trim()

// Layer 2: 數學領域共通段
const MATH_DOMAIN_SECTION = `
== DOMAIN: 數學（Mathematics）==
Output language: 繁體中文 for narrative; preserve original symbols (×÷−=) verbatim.

Content type patterns (descriptive only):
- 數字運算 (arithmetic): integers, decimals, fractions.
- 比例/比 (ratios), 單位換算 (unit conversion).
- 幾何/圖形 (geometry).
- 應用題 (word problems with calculation).

Reading discipline (數學 specific):
- ⚠️ NEVER normalize symbols: × stays ×, ÷ stays ÷, − stays − (do NOT convert to *, /, -).
- Copy wrong calculations exactly. "6+3=8" stays "6+3=8". Never correct arithmetic.
- Copy the student's written digits exactly, even if a calculation was performed wrong.
- Numbers matter: every digit position is significant. Watch for missed digits at edges (e.g. "1" at start of "150").
- Auxiliary scratch work (輔助計算) near a fill-blank answer is NOT part of the answer — only what is INSIDE the blank counts.
`.trim()

// Layer 2: 自然領域共通段
const SCIENCE_DOMAIN_SECTION = `
== DOMAIN: 自然（Natural Sciences）==
Output language: 繁體中文.

Content type patterns (descriptive only):
- 科學名詞: 物理/化學/生物/地科 terminology.
- 化學式/單位: H₂O, CO₂, ml, kg, J/s — preserve subscripts/superscripts and units exactly.
- 數值 + 單位 (value + unit): always paired.

Reading discipline (自然 specific):
- ⚠️ NEVER substitute units: 公分 ≠ 公尺, ml ≠ L, g ≠ kg. Each unit changes the magnitude.
- Numbers AND units must both be transcribed. Missing the unit changes the meaning.
- Preserve subscripts and superscripts as written (H₂O, m²). If you cannot tell if a digit is subscript, output it inline.
- For experimental observations, copy the student's wording faithfully even if scientifically imprecise.
`.trim()

// Layer 2: 英語領域共通段
const ENGLISH_DOMAIN_SECTION = `
== DOMAIN: 英語（English）==
Output language: ENGLISH (do NOT translate to Chinese; do NOT output 繁體中文 for the answer body).

Content type patterns (descriptive only):
- 單字 (vocabulary): individual English words.
- 句子 (sentences): full English sentences.
- 文法填空 (grammar fill-in): student picks a word form.

Reading discipline (英語 specific):
- ⚠️ DO NOT auto-correct spelling. Copy each letter EXACTLY as the student wrote it.
  - "dinng" stays "dinng" (NOT "dining"). "kitchan" stays "kitchan" (NOT "kitchen").
- ⚠️ DO NOT interpret unfamiliar shapes as Bopomofo. English handwriting can resemble 注音 — always interpret as English letters.
- Preserve case exactly as written: capital letters stay capital, lowercase stays lowercase.
- Output a "rawSpelling" field on EVERY English answer: spell out every letter separated by dashes,
  with spaces between words. Example: "dinng room" → rawSpelling: "d-i-n-n-g r-o-o-m".
  This forces letter-by-letter examination. If rawSpelling disagrees with studentAnswerRaw, rawSpelling is authoritative.
- Punctuation (. , ? !) is part of the answer when written.
`.trim()

function buildReadAnswerPrompt(classifyResult, options = {}) {
  const domainHint = ensureString(options?.domainHint, '').trim()
  const isMandarin = domainHint === '國語'
  const isMath = domainHint === '數學'
  const isSocial = domainHint === '社會'
  const isScience = domainHint === '自然'
  const isEnglish = domainHint === '英語'
  const hasAnyDomain = Boolean(domainHint)
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
  // ── Per-type ID extraction（每 type 獨立列表，no more merged effective lists）──
  // 設計原則：每種 type 有自己的規則段，AI 不再做「3-form 辨識」。
  // 標籤已在裁切圖前面標明 type，AI 直接套對應 rule 即可。
  const idsOf = (type) => visibleQuestions.filter((q) => q.questionType === type).map((q) => q.questionId)
  const visibleIds = visibleQuestions.map((q) => q.questionId)

  // Bucket A: tight_answer
  const singleChoiceIds = idsOf('single_choice')
  const multiChoiceIds = idsOf('multi_choice')
  const trueFalseIds = idsOf('true_false')
  const fillBlankIds = idsOf('fill_blank')
  const multiFillIds = idsOf('multi_fill')

  // Bucket A: answer_with_context
  const circleSelectOneIds = idsOf('circle_select_one')
  const circleSelectManyIds = idsOf('circle_select_many')
  const singleCheckIds = idsOf('single_check')
  const multiCheckIds = idsOf('multi_check')
  const markInTextIds = idsOf('mark_in_text')

  // Bucket A: group_shared / large_visual_area
  const matchingIds = idsOf('matching')
  const orderingIds = idsOf('ordering')
  const calculationIds = idsOf('calculation')
  const wordProblemIds = idsOf('word_problem')

  // Bucket B
  const mapFillIds = idsOf('map_fill')
  // fill_variants 已被 resolveExpectedQuestionType 收編成 fill_blank（OCR 行為相同）

  // Bucket C: large_visual_area
  const shortAnswerIds = idsOf('short_answer')
  const mapSymbolIds = idsOf('map_symbol')
  const gridGeometryIds = idsOf('grid_geometry')
  const connectDotsIds = idsOf('connect_dots')
  const diagramDrawIds = idsOf('diagram_draw')
  const diagramColorIds = idsOf('diagram_color')

  // Bucket D: compound_linked
  const compoundCircleIds = idsOf('compound_circle_with_explain')
  const compoundCheckIds = idsOf('compound_check_with_explain')
  const compoundWriteinIds = idsOf('compound_writein_with_explain')
  const compoundJudgeCorrectionIds = idsOf('compound_judge_with_correction')
  const compoundJudgeExplainIds = idsOf('compound_judge_with_explain')
  const multiCheckOtherIds = idsOf('multi_check_other')
  const compoundChainTableIds = idsOf('compound_chain_table')

  // Aggregate: all map-draw subtypes (kept for backward-compat conditional logic if any)
  const mapDrawIds = [...mapSymbolIds, ...gridGeometryIds, ...connectDotsIds]

  // ── Per-type questionIds 清單已移除（每張裁切圖標籤已標註 type，清單純冗餘）──
  // ── bboxHintNote 已移除（裁切圖無關全圖座標，AI 看不到全圖無法用 normalized 座標）──

  // Table cell column hints: 條件式 fallback — 若 bbox 意外含到欄標題，可作為驗證
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
      return `- "${q.questionId}"（表格 col=${akQ.tablePosition.col}）：${akQ.anchorHint}`
    })
  const tableCellHintNote = tableCellHints.length > 0
    ? `\n\n== TABLE CELL FALLBACK HINTS ==\n以下題目是表格內的格子。裁切圖通常只含該格本身，但若意外含到欄標題或鄰格內容，可用以下描述驗證讀取的是正確的格子（若標題不符可能 bbox 偏移，回報 blank 較安全）：\n${tableCellHints.join('\n')}`
    : ''

  // ── Layered prompt assembly: Layer 2 (domain) + Layer 3 (components) ──
  // Layer 2-1 (type×domain specializations) are NOT injected as separate blocks here —
  // they REPLACE the corresponding generic type rule via TYPE_DOMAIN_OVERRIDES lookup
  // when the per-type rule variables (e.g. wordProblemRules) are computed below.
  let domainSectionBlock = ''
  if (isMandarin) domainSectionBlock = `\n\n${MANDARIN_DOMAIN_SECTION}`
  else if (isMath) domainSectionBlock = `\n\n${MATH_DOMAIN_SECTION}`
  else if (isSocial) domainSectionBlock = `\n\n${SOCIAL_DOMAIN_SECTION}`
  else if (isScience) domainSectionBlock = `\n\n${SCIENCE_DOMAIN_SECTION}`
  else if (isEnglish) domainSectionBlock = `\n\n${ENGLISH_DOMAIN_SECTION}`

  // Layer 3 component emission: include when an active rule references it.
  // FORMAT_B_CIRCLE_IN_PARENS is referenced by SOCIAL_WORD_PROBLEM_FULL.
  const referencesFormatB = (isSocial && wordProblemIds.length > 0)
  const formatBComponentBlock = referencesFormatB
    ? `\n\n${FORMAT_B_CIRCLE_IN_PARENS_COMPONENT}`
    : ''

  // Pseudo-global rule gating (fix for previously leaked rules)
  // DIGIT-ONE: relevant for math/science answers and for unknown-domain (backward compat).
  // Skip for 國語/社會/英語 where digit "1" handwriting is rarely the issue.
  const digitOneRuleBlock = (isMath || isScience || !hasAnyDomain) ? `
== DIGIT-ONE RULE ==
When reading a number, if you see a single vertical stroke (一豎) BETWEEN two clearly written digits, it is the digit "1". Do NOT skip it.
Example: if you see 4|0 (a "4", then a vertical stroke, then a "0"), read it as "410" — the vertical stroke between the two digits is the handwritten "1".
This rule ONLY applies when the stroke is between two digits. A vertical stroke at the edge (before the first digit or after the last digit) is NOT "1".
` : ''

  // COPY 7 (output language): default 繁中, except 英語 keeps English.
  const outputLanguageRule = isEnglish
    ? '7. LANGUAGE: Output English answer body in English; do NOT translate to Chinese.'
    : '7. LANGUAGE: Always output in Traditional Chinese (繁體中文).'

  // Math-specific COPY rules (calc accuracy, symbol preservation)
  const mathSymbolPreserveRules = (isMath || !hasAnyDomain) ? `
2. Copy wrong calculations exactly: "6+3=8" → output "6+3=8". Never correct.
3. Do NOT normalize symbols: × stays ×, ÷ stays ÷, − stays −.` : ''

  // ENGLISH SPELLING rule for fill_blank (gated to 英語)
  const englishSpellingRuleBlock = (isEnglish && fillBlankIds.length > 0) ? `
- 🚨 ENGLISH SPELLING RULE (for English fill_blank):
  DO NOT auto-correct spelling. Copy each letter EXACTLY as the student wrote it.
  "dinng" stays "dinng" (NOT "dining"). "kitchan" stays "kitchan" (NOT "kitchen").
  You are an OCR scanner with ZERO language knowledge — you cannot recognize English words.
  Additionally, output a "rawSpelling" field: spell out every letter separated by dashes.
  Example: student wrote "dinng room" → studentAnswerRaw="dinng room", rawSpelling="d-i-n-n-g r-o-o-m".
  This forces you to examine each letter individually. If rawSpelling disagrees with studentAnswerRaw, rawSpelling is authoritative.` : ''

  // MATH FILL-BLANK rule (gated to 數學 or unknown domain)
  const mathFillBlankRuleBlock = ((isMath || !hasAnyDomain) && fillBlankIds.length > 0) ? `
- 🚨 MATH FILL-BLANK RULE (數學填充題):
  For math fill-in-the-blank questions, students often write auxiliary calculations (輔助計算/草稿) next to or near the blank — such as vertical arithmetic (直式), scratch formulas, or intermediate steps.
  IGNORE all auxiliary calculations. Read ONLY the final answer written INSIDE the parentheses ( ) or blank line ___.
  The auxiliary work is the student's scratch process and is NOT part of the answer.
  Example: student wrote "25×4=100" as scratch work nearby, and filled "100" inside the ( ) → output "100" only.` : ''

  // ── Per-type rule blocks: only emit when the test paper actually has that type ──
  // 每 type 獨立規則。標籤已標明 type，AI 直接套規則，不再辨識 form。
  // 共用「理解 → 抄錄 → 輸出」三段架構 + readingReasoning 必填。

  // ── single_choice：空括號 + 寫代號 1 個 ──
  const singleChoiceRules = singleChoiceIds.length > 0 ? `
SINGLE-CHOICE (single_choice 題)：學生在空括號 (    ) 內寫一個代號。

① 理解：括號內手寫一個代號
② 抄錄：抄寫括號內筆跡
③ 輸出：僅輸出單一代號
       允許：A/B/C/D | 甲/乙/丙/丁 | 1/2/3/4 | ①/②/③/④
       不可輸出選項內容文字

readingReasoning 範例：「理解：括號內手寫一個英文字母 B。抄錄：直接抄寫。輸出：B。」

邊界：
- 括號完全空白 → blank
- 字跡無法辨識為任何代號 → unreadable
- 看到多個代號（不該出現於單選）→ unreadable

統一禁止：不可從題目語意推測；不可從相鄰題推斷；AI2 不可用正解 hint 反推。
` : ''

  // ── multi_choice：空括號 + 寫代號多個 ──
  const multiChoiceRules = multiChoiceIds.length > 0 ? `
MULTI-CHOICE (multi_choice 題)：學生在空括號 (    ) 內寫多個代號。

① 理解：括號內手寫多個代號
② 抄錄：抄寫括號內所有代號（依寫的順序）
③ 輸出：用「,」連接多個代號（無空格）
       例：A,C 或 ①,③；單個代號則只輸出該代號

readingReasoning 範例：「理解：括號內手寫 A 和 C。抄錄：兩個代號。輸出：A,C。」

邊界：
- 括號完全空白 → blank
- 所有代號都無法辨識 → unreadable
- 部分代號可辨、部分不可辨 → 用 "?" 取代不可辨的，例：A,?

統一禁止：同 single_choice。
注意：多選若所有代號都被寫入仍照樣輸出（非 unreadable，與單選不同）。
` : ''

  // ── circle_select_one：括號內預印多個選項 + 圈選 1 個 ──
  const circleSelectOneRules = circleSelectOneIds.length > 0 ? `
CIRCLE-SELECT-ONE (circle_select_one 題)：括號內預印 2+ 個選項（以 ／、/、，分隔），學生用筆跡圈選 1 個。
範例：(同意／不同意)、(大於／等於／小於)、(小熊, 大熊, 中熊)

① 理解：學生用筆跡（圈/底線/劃掉）標記其中一個選項
② 抄錄：
   Step 1：識別括號內所有預印選項
   Step 2：找出學生筆跡覆蓋的選項位置
   Step 3：用分隔符（／、,）當錨點，確認標記中心在哪一側
③ 輸出：僅輸出被標記的選項文字（不含括號、分隔符、其他選項）

readingReasoning 範例：「理解：括號內預印「同意／不同意」，學生圈住右側。抄錄：以「／」為錨點，圓圈中心在右。輸出：不同意。」

邊界：
- 沒有任何標記 → blank
- 多個選項都被標記 → unreadable（單選不能多選）
- 標記中心模糊（卡在分隔符上）→ unreadable
- 劃掉式：所有選項都沒劃掉 → blank；剩唯一一個沒劃掉 → 輸出那個

統一禁止：同 single_choice。
` : ''

  // ── circle_select_many：括號內預印多個選項 + 圈選多個 ──
  const circleSelectManyRules = circleSelectManyIds.length > 0 ? `
CIRCLE-SELECT-MANY (circle_select_many 題)：括號內預印多個選項，學生圈選多個。

① 理解：學生用筆跡標記了一個或多個選項
② 抄錄：
   Step 1：識別括號內所有預印選項
   Step 2：找出所有有筆跡覆蓋的選項
③ 輸出：用「,」連接被標記的選項文字。例：同意,中立

readingReasoning 範例：「理解：括號內「同意,不同意,中立」三個選項，學生圈了同意與中立。抄錄：兩個被圈。輸出：同意,中立。」

邊界：
- 沒有任何標記 → blank
- 全部都被標記也照樣輸出（多選允許）

統一禁止：同 single_choice。
` : ''

  // ── single_check：□ 列 + 打勾 1 個 ──
  const singleCheckRules = singleCheckIds.length > 0 ? `
SINGLE-CHECK (single_check 題)：每個選項前面有 □（方框），學生在 1 個 □ 內畫 ✓/✗/●/X。
範例：□ 父親  □ 母親  □ 祖父  □ 祖母

① 理解：學生在某個 □ 內畫上標記
② 抄錄：
   Step 1：識別所有 □ 與其對應選項文字（依閱讀順序：左→右、上→下編號）
   Step 2：找出有標記的 □
   Step 3：判定該 □ 是第幾個（1-based）
③ 輸出：被打勾 □ 的 1-based 位置編號
       純數字。不含 □、勾號 ✓、選項文字

readingReasoning 範例：「理解：四個 □ 對應「父親、母親、祖父、祖母」，第二個被打勾。抄錄：標記在第 2 個位置。輸出：2。」

邊界：
- 沒有 □ 被標記 → blank
- 多個 □ 被標記（單選不能多選）→ unreadable
- 標記跨越兩個 □（位置模糊）→ unreadable

統一禁止：同 single_choice。
` : ''

  // ── multi_check：□ 列 + 打勾多個 ──
  const multiCheckRules = multiCheckIds.length > 0 ? `
MULTI-CHECK (multi_check 題)：□ 列 + 學生在多個 □ 內畫標記。

① 理解：學生在多個 □ 內畫上標記
② 抄錄：
   Step 1：識別所有 □ 與其對應選項文字（依閱讀順序：左→右、上→下編號）
   Step 2：找出所有有標記的 □
   Step 3：紀錄各被標記 □ 的 1-based 位置
③ 輸出：用「,」連接所有位置編號。例：1,3

readingReasoning 範例：「理解：四個 □ 中，第 1 與第 3 個被打勾。抄錄：兩個被標記。輸出：1,3。」

統一禁止：同 single_choice。
注意：多選若所有 □ 都被打勾仍照樣輸出。
` : ''

  // ── multi_check_other：□ 列 + 打勾，最後 □ 是「其他：___」開放欄 ──
  const multiCheckOtherRules = multiCheckOtherIds.length > 0 ? `
MULTI-CHECK-OTHER (multi_check_other 題)：□ 列 + 最後 1 個 □ 是「其他：___」開放欄位。

① 理解：同 multi_check，但最後一個 □ 配「其他：___」開放欄位
② 抄錄：
   - 一般 □：紀錄 1-based 位置
   - 最後「其他」□：判斷有無打勾 + 開放欄是否寫文字
③ 輸出規則：
   - 一般 □ 被打勾 → 該位置編號
   - 「其他」□ 被打勾且寫文字 → 輸出 "N：[文字]"（N 為位置編號）
   - 「其他」□ 被打勾但沒寫文字 → 只輸出位置編號
   - 多個用「,」連接，例：1,3,4：轉為文風鼎盛的社會

readingReasoning 範例：「理解：四個 □ 中，第 1、3 普通 + 第 4「其他」被打勾並寫了文字。輸出：1,3,4：轉為文風鼎盛的社會。」

統一禁止：同 single_choice。
` : ''

  const trueFalseRules = trueFalseIds.length > 0 ? `
TRUE-FALSE (true_false 題)：學生在空括號 (    ) 內寫 ○ 或 ✗。
- Output ONLY the symbol or word the student wrote in the answer space.
- Valid outputs: "○", "✗", "對", "錯", "是", "否", or the exact character written.
- Do NOT append any explanatory text (e.g. output "○" NOT "○ 正確").
- 括號空白 → blank。字跡無法辨識為任一符號 → unreadable。
` : ''

  const fillBlankRules = fillBlankIds.length > 0 ? `
FILL-BLANK (questions in FILL-BLANK list):
- Output ONLY handwritten content inside each blank, comma-separated left-to-right top-to-bottom.
- Empty blank → "_". Unreadable blank → "?". All blanks empty → status="blank".
- FORBIDDEN: surrounding printed text ("答", underline markers).${mathFillBlankRuleBlock}
- 🚨 MULTIPLE BLANKS IN CROP (裁切圖包含多個括號):
  If the cropped image shows content from MULTIPLE blanks or lines (e.g., you see two different ( ) with different answers), identify which blank is closest to the CENTER of the crop image — that is your target blank.
  - Content near the EDGES (top, bottom, left, right) of the crop that belongs to a DIFFERENT blank — do NOT read it.
  - Once you identify the target blank, read ALL handwriting inside it COMPLETELY — including faint, small, or offset characters. Do NOT skip any visible strokes within the target blank.${englishSpellingRuleBlock}
` : ''

  const calculationRules = calculationIds.length > 0 ? `
CALCULATION (questions in CALCULATION list):
- 🚨 CALCULATION QUESTION STRUCTURE:
  A calculation question has TWO parts:
  1. FIRST LINE (printed question): a formula ending with "=( )" or "=(   )" — the student writes their FINAL ANSWER inside the parentheses. This is THE answer.
  2. BELOW THE FIRST LINE: the student's handwritten calculation process (scratch work).

  🚨 READING PRIORITY:
  - FIRST: Read what the student wrote INSIDE the parentheses "( )" on the first line. This is the studentFinalAnswer.
  - THEN: Read the calculation process below (line by line).
  - The parentheses answer is ALWAYS the student's intended final answer, even if the calculation process below shows a different result.
  - If the parentheses are empty → the student did not write a final answer → use the last line of calculation process as fallback.

  🚨 BOUNDARY RULE:
  - If you see ANOTHER printed formula line with "=( )" pattern below the calculation process, that is the NEXT question — STOP reading. Do NOT read across question boundaries.
  - Content inside the NEXT question's parentheses belongs to the NEXT question, not this one.

- LINE-BY-LINE TRANSCRIPTION (for the calculation process below the first line):
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
` : ''

  // word_problem rules: if (domain, word_problem) has a specialization, use it (replaces generic).
  // Otherwise emit the generic rule. Generic includes math-flavored bits (答: prefix, 直式)
  // that apply when domain is 數學 or unspecified.
  const wordProblemRules = (() => {
    if (wordProblemIds.length === 0) return ''
    const override = TYPE_DOMAIN_OVERRIDES.word_problem?.[domainHint]
    if (override) return `\n${override}\n`
    return `
WORD-PROBLEM (questions in WORD-PROBLEM list):
- 🚨 LINE-BY-LINE TRANSCRIPTION: Same rule as CALCULATION — scan top to bottom, one output line per physical handwritten line, separated by "\\n". Output line count must match physical line count.
- FORBIDDEN: inserting steps, merging lines, or reorganizing the student's work.
- Include the final answer sentence if present (e.g. "答: 小明走了120公尺").
- If the work area is blank (no fresh marks) → status="blank".
- VERTICAL FORMAT (直式): Same conversion rule as CALCULATION above — convert 直式 to horizontal equation (counts as one line), copy student's numbers faithfully without correction.
`
  })()

  // PROPORTION TABLE: only emit when has math word_problem/calculation
  const hasMathProcedural = (calculationIds.length > 0 || wordProblemIds.length > 0)
  const proportionTableRules = (hasMathProcedural && (isMath || !hasAnyDomain)) ? `
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
` : ''

  // ── matching：連連看（同組共用 bbox）──
  const matchingRules = matchingIds.length > 0 ? `
MATCHING (matching 題)：連連看，左欄編號項目 (1)(2)(3)(4)，右欄選項，學生畫線連接。
- 同一組 matching 的所有 questionId 共用同一張裁切圖（整組左欄+右欄+連線）。
- 對左欄每個項目，跟隨學生畫的線找到右欄對應的選項。
- 輸出格式：每個 questionId 輸出該左欄項目連到的右欄選項文字。
  例：(1) 連到「2公尺/秒」→ 該題的 questionId 輸出「2公尺/秒」
- questionId 在 MATCHING list 對應左欄順序：第一個 ID = (1)、第二個 = (2)、依此類推。
- 沒連線或連線不明確 → studentAnswerRaw="未連線", status="read"
- 整組沒任何連線 → status="blank", studentAnswerRaw="未作答"
- 禁止：輸出左欄項目文字（必須輸出右欄選項文字）。
` : ''

  // ── mapFill：整圖填地名（多位置-名稱配對）──
  const mapFillRules = mapFillIds.length > 0 ? `
MAP-FILL (map_fill 題)：整張圖即一題，學生在地圖多位置寫地名/標籤。
- 掃描整張裁切圖。
- 找出所有學生手寫的標籤/文字。
- 每個標籤描述大致位置 + 寫的文字。
- 輸出格式：「位置A: 泰國, 位置B: 越南, 位置C: 緬甸, ...」
  - 若印有位置標記（A, B, C, ①, ②）→ 用印刷標記為位置識別
  - 若無印刷標記 → 用空間描述：「左上方」「中間偏右」「右下角」等
- 包含所有手寫文字（即使拼字錯誤）。
- 有任何手寫 → status="read"。完全空白 → status="blank"。
` : ''

  // ── multiFill：多格填值（每子題對應一格）──
  const multiFillRules = multiFillIds.length > 0 ? `
MULTI-FILL (multi_fill 題)：圖中多個固定位置空白格，每子題對應一格。
- 裁切圖框該子題對應的單一格（含學生手寫）。
- 抄寫該格內所有手寫代號/符號（例如「ㄅ、ㄇ、ㄉ」），保留分隔符（、 或 ，）。
- 不可推測缺漏代號、不可從鄰格讀取。
- 有手寫 → status="read"。空格 → status="blank"。
` : ''

  // ── ordering：排序題 ──
  const orderingRules = orderingIds.length > 0 ? `
ORDERING (ordering 題)：題目給一列待排序項目，學生在每項旁/內寫上 1, 2, 3, 4… 序號。
- 掃描整個答題區，找出每個項目對應的學生寫的序號。
- 依項目原本印刷順序輸出序號，用「,」分隔。
  例：項目 A,B,C,D 印刷順序固定，學生寫 3,1,4,2 → 輸出「3,1,4,2」
- 漏寫某項 → 該位置寫 "?"。例：「3,1,?,2」
- 完全沒寫 → status="blank", studentAnswerRaw="未作答"
- 禁止：依「合理排序」推測漏寫；只看實際寫的數字。
` : ''

  // ── markInText：圈詞題 ──
  const markInTextRules = markInTextIds.length > 0 ? `
MARK-IN-TEXT (mark_in_text 題)：題目是一段印刷文章，學生在某些字詞上圈/底線/標記。
- 掃描整段文章，找出所有被圈/底線/標記的字詞（藍/黑筆跡 = 學生）。
- 列出全部被圈詞語，用「,」分隔。
  例：「春天,夏天,秋天」
- 圈選範圍模糊（半圈、線到半路）→ 仍列入但加註，例：「春天,夏(半圈)」
- 完全沒筆跡 → status="blank"
- 禁止：列出未被圈的詞；不可依語意推測「應該圈哪些」。
` : ''

  // ── shortAnswer：簡答題（自由文字段落）──
  const shortAnswerRules = shortAnswerIds.length > 0 ? `
SHORT-ANSWER (short_answer 題)：學生在大空白區寫文字段落自由說明。
- 抄寫整段學生手寫文字（藍/黑筆跡）。
- 保留學生原始換行（用 "\\n" 分隔）。
- 即使語法錯誤、用字不當、邏輯不通 — **照原樣抄寫**，不修正。
- 無法辨識的字 → 用 "?" 取代該字並繼續抄。
- 完全空白 → status="blank"。整段都無法辨識 → status="unreadable"。
- 禁止：摘要、改寫、補完；不可以「應該寫的內容」取代學生實際寫的內容。
` : ''

  // ── map_symbol / grid_geometry / connect_dots：3 個 map-draw 子型 ──
  const mapSymbolRules = mapSymbolIds.length > 0 ? `
MAP-SYMBOL (map_symbol 題)：學生在地圖某位置畫符號（▲/★/●/箭頭等）。
描述學生繪圖，三部分組成：
  1. 符號 / 形狀：學生畫了什麼？精確命名（例：颱風符號、箭頭向右、圓點、叉號）
  2. 參考線：列出所有印刷可見的參考線/標籤（例：23.5°N、121°E、赤道）
  3. 位置：相對參考線的位置描述
     - 座標格：「在[A]緯線以[南/北]、[B]經線以[東/西]」+ 格子位置
     - 編號格：「在第 N 格」或「在[標籤]格」
     - 交點附近：「在[A]與[B]交點附近」
輸出格式：「[符號名稱]，位置：[精確描述]」
範例：「颱風符號，位置：23.5°N 緯線以南、121°E 經線以東的格子（右下格）」
無筆跡 → status="blank"
` : ''

  const gridGeometryRules = gridGeometryIds.length > 0 ? `
GRID-GEOMETRY (grid_geometry 題)：學生在格線紙上依條件繪製幾何圖形。
描述學生繪製的圖形，三部分組成：
  1. 形狀：什麼圖形？（例：正方形、三角形、長方形、平行四邊形）
  2. 大小：以格數計（例：邊長 3 格、底 3 格高 2 格、邊長 4×3）
  3. 位置：圖形左上角或參考點起始位置（例：從第 2 列第 3 格開始）
輸出格式：「圖形：[形狀]，大小：[尺寸]，位置：[起始位置]」
範例：「圖形：正方形，大小：邊長 3 格，位置：從第 1 列第 2 格開始」
無筆跡 → status="blank"
` : ''

  const connectDotsRules = connectDotsIds.length > 0 ? `
CONNECT-DOTS (connect_dots 題)：學生把指定的點連起來形成圖形。
描述學生連線：
  1. 連線順序：依學生畫線順序列出連接的點（例：1→2→3→4→1）
  2. 形成圖形：連起來形成什麼形狀？（例：三角形、Z 字形、正方形）
輸出格式：「連線：[點的連接順序]，形成圖形：[形狀名稱]」
範例：「連線：1→2→3→4→5，形成圖形：Z 字形」
無筆跡 → status="blank"
` : ''

  // ── diagramDraw / diagramColor ──
  const diagramDrawRules = diagramDrawIds.length > 0 ? `
DIAGRAM-DRAW (diagram_draw 題)：學生在預印圖表（長條圖/圓餅圖等）上繪製數據。
- 讀取所有學生繪製或寫上的標籤-數值配對。
- 圓餅圖：每個扇形以「標籤 比率」格式（例：「番茄汁 2/5, 紅蘿蔔汁 1/10, 蘋果汁 3/20」）
- 長條圖：每個長條以「標籤 高度/數值」格式（例：「一月 50, 二月 30, 三月 45」）
- 依閱讀順序列出所有扇形/長條。
- 無筆跡 → status="blank", studentAnswerRaw="未作答"。
- 禁止：推測未實際寫出的標籤或數值。

🚨 圓餅圖讀取範圍限制：
- 只讀餅圖內或圓周附近的文字數字（指向扇形的標籤）。
- 圖外文字數字（例：旁邊的草稿計算、上下方資料表）**不屬於**此題答案，不抄。
` : ''

  const diagramColorRules = diagramColorIds.length > 0 ? `
DIAGRAM-COLOR (diagram_color 題)：學生在預印圖形上塗色。
- 只描述學生塗色的部分，不描述未塗區域。
- 固定模板：「塗色：[描述塗色範圍]」
  - 圓/分數圖：哪幾個圓全/部分塗色、什麼比例、哪一側
    例：「塗色：第 1 個圓完整，第 2 個圓左側 2/3，第 3 個圓未塗」
  - 分數條/格：塗了幾格 + 位置
    例：「塗色：10 格中的 7 格（左側連續 7 格）」
  - 其他形狀：用空間詞（左/右/上/下/中）描述
- 位置很重要：永遠描述「哪個區域」被塗，不只是「塗了多少」。
- 無塗色 → status="blank"。
- 禁止：把預印輪廓、格線、標籤當成學生的塗色。
` : ''

  // ── compound_*_with_explain (5 個複合說明題) ──
  const compoundCircleRules = compoundCircleIds.length > 0 ? `
COMPOUND-CIRCLE-WITH-EXPLAIN (compound_circle_with_explain 題)：圈印刷選項 + 寫理由。
整題分兩部分，**兩部分都要讀**：
- 答案部分：括號內預印選項，學生圈選 1 個（同 circle_select_one 邏輯）
- 說明部分：下方理由區，學生寫文字理由
輸出格式（兩段用 ⧉ 分隔）：「[圈選的選項] ⧉ [理由文字]」
範例：「同意 ⧉ 因為這是促進和平的方法」
- 圈選空白 → 該段輸出 "未圈"
- 理由空白 → 該段輸出 "未說明"
- 兩段都空 → status="blank"
` : ''

  const compoundCheckRules = compoundCheckIds.length > 0 ? `
COMPOUND-CHECK-WITH-EXPLAIN (compound_check_with_explain 題)：□ 打勾 + 寫理由。
- 答案部分：□ 列，學生打勾（同 single_check 邏輯，輸出位置編號）
- 說明部分：下方理由區
輸出格式：「[勾選位置編號] ⧉ [理由文字]」
範例：「2 ⧉ 因為這個方法最能保護環境」
邊界同 compound_circle_with_explain。
` : ''

  const compoundWriteinRules = compoundWriteinIds.length > 0 ? `
COMPOUND-WRITEIN-WITH-EXPLAIN (compound_writein_with_explain 題)：空括號寫代號 + 寫理由。
- 答案部分：括號內手寫代號（同 single_choice 邏輯，輸出代號）
- 說明部分：下方理由區
輸出格式：「[代號] ⧉ [理由文字]」
範例：「B ⧉ 因為它符合題目所給的條件」
邊界同 compound_circle_with_explain。
` : ''

  const compoundJudgeCorrectionRules = compoundJudgeCorrectionIds.length > 0 ? `
COMPOUND-JUDGE-WITH-CORRECTION (compound_judge_with_correction 題)：判斷對錯 + 改正錯的部分。
- 答案部分：括號內 ○ 或 ✗（同 true_false 邏輯）
- 改正部分：下方空白，若判 ✗ 學生需寫正確改寫
輸出格式：「[○/✗] ⧉ [改正文字或「無需改正」]」
範例：「✗ ⧉ 太陽從東方升起」「○ ⧉ 無需改正」
- 判 ○ 但學生寫了東西 → 仍輸出該文字（讓 grading 自行判定）
- 判 ✗ 但沒寫改正 → 輸出 "✗ ⧉ 未改正"
` : ''

  const compoundJudgeExplainRules = compoundJudgeExplainIds.length > 0 ? `
COMPOUND-JUDGE-WITH-EXPLAIN (compound_judge_with_explain 題)：判斷對錯 + 解釋為什麼。
- 答案部分：括號內 ○ 或 ✗（同 true_false 邏輯）
- 說明部分：下方說明區，學生寫文字解釋
輸出格式：「[○/✗] ⧉ [說明文字]」
範例：「○ ⧉ 因為地球自轉，所以看起來太陽從東方升起」
邊界同 compound_judge_with_correction。
` : ''

  const compoundChainTableRules = compoundChainTableIds.length > 0 ? `
COMPOUND-CHAIN-TABLE (compound_chain_table 題)：表格內多 cell 有依賴關係（前格答案影響後格判斷）。
- 整個表格區為一題，依列順序逐 cell 抄寫。
- 輸出格式：每列用「|」分隔欄，每列之間用 "\\n" 分隔
  例：「人物 | 事件 | 影響\\n孔子 | 周遊列國 | 教學興盛\\n...」
- 第一列若是欄標題（印刷字）→ 仍抄錄作為脈絡（但若標題列無學生筆跡，可省略）
- 空格 → 該位置寫 "_"
- 不可從學科知識推測缺漏 cell；只抄學生實際寫的。
- 整表沒筆跡 → status="blank"
` : ''

  // 是否需要 readingReasoning（選擇/勾選/圈選類必填）
  const needsReadingReasoning = (
    singleChoiceIds.length + multiChoiceIds.length +
    circleSelectOneIds.length + circleSelectManyIds.length +
    singleCheckIds.length + multiCheckIds.length + multiCheckOtherIds.length +
    compoundCircleIds.length + compoundCheckIds.length + compoundWriteinIds.length +
    compoundJudgeCorrectionIds.length + compoundJudgeExplainIds.length
  ) > 0

  return `
Your job is to report what the student physically wrote or drew in each question's designated answer space.

Visible question IDs on this image:
${JSON.stringify(visibleIds)}${tableCellHintNote}

== ANTI-HALLUCINATION (absolute rule, cannot be overridden) ==
You may ONLY output what is physically, visibly written by the student's own hand.
NEVER output content that does not exist as physical handwriting in the image.
NEVER output an answer based on:
- answers you see in neighboring questions
- printed option labels (A B C D 甲乙丙丁) that the student did NOT mark
- data from charts, graphs, pie charts, tables, or diagrams visible in the image
- mathematical calculation or inference from other visible information
If the answer space is empty → blank. There are NO exceptions.
🚨 CRITICAL: Even if you can SEE data (e.g. angles on a pie chart, values in a table header) that would let you CALCULATE what the answer should be, you MUST NOT do so. You are an OCR reader, not a calculator. If the student did not physically write an answer in the designated space, output blank — regardless of what you could infer from surrounding visual information.

== INK COLOR RULE (critical) ==
The student writes in BLUE or BLACK ink (pencil). The teacher corrects in RED ink.
- ONLY read the student's BLUE/BLACK ink marks. This is the student's original answer.
- IGNORE all RED ink marks — these are the teacher's corrections/marks added AFTER the student submitted.
- If you see both red and blue/black writing in the same area, ONLY report the blue/black writing.
- Common red ink marks to ignore: circled correct answers, check marks (✓/✗), score numbers, correction notes.
- If the student's blue/black answer is crossed out by the student (self-correction with blue/black ink), read the final version the student intended.

${MARKUP_VS_HANDWRITING_RULE}

== BLANK FIRST RULE ==
Before reading each question, ask yourself: "Is there fresh handwriting in this question's answer space?"
- Answer space = the designated writing area: ( ), ___, □, or the answer line after "答:" "A:" "Ans:", or the entire work area for calculation/drawing questions.
- If no fresh handwriting is present → status="blank", studentAnswerRaw="未作答". STOP. Do not read further.
- Pre-printed content (labels, underlines, boxes, option letters A/B/C/D, artwork) does NOT count.
- Only FRESH student BLUE/BLACK pen/pencil marks count. RED ink is the teacher's, not the student's.

🚨 TABLE CELL EDGE RULE (適用於表格內格子的所有題型 — fill_blank / multi_fill / calculation / compound_chain_table)：
凡是裁切圖框的是表格內的格子，請依下列規則：
- 在裁切圖內找垂直格線（直線）。垂直格線即格子邊界。
- 線的另一邊內容屬於相鄰格，**不可讀**。
  - 線靠左 → 只讀線右側內容
  - 線靠右 → 只讀線左側內容
  - 兩側都有線 → 只讀兩線之間的內容
- 兩線之間（或裁切圖中央區）若空白 → status="blank", studentAnswerRaw="未作答"。
- 越過格線可見的數字/文字屬於鄰格答案，**不是這題**。誤讀會造成相鄰題目連鎖錯誤。

${digitOneRuleBlock}
== COPY RULES (only when non-blank) ==
You are an OCR scanner. Your ONLY job is to copy exactly what the student wrote. You have NO language ability, NO grammar knowledge, and NO understanding of meaning.

1. Copy every character the student wrote, in the exact order written. Do NOT rearrange, reorder, or restructure.
2. Copy grammatically wrong or nonsensical sentences exactly as written:
   - Student wrote "你那麼高興，既然多吃一點" → output "你那麼高興，既然多吃一點"（不可重組以修文法）
   - Student wrote "既然你 ? 麼高" → output "既然你 ? 麼高"（? 照抄）
3. Single unreadable character → "?" 取代並繼續抄寫其他字。**不可**因單一字看不清就把整答案標 unreadable。
   - 範例：「既然你[unclear]麼高興」→ 輸出「既然你?麼高興」
4. Entire answer completely unreadable → status="unreadable", studentAnswerRaw="無法辨識"。
5. ${outputLanguageRule.replace(/^7\. /, '')}
6. ABSOLUTELY FORBIDDEN — Character substitution:
   不可用相似字、同音字、或「文意更通順的字」取代學生實際寫的字。即使：
   - 學生寫「它們」→ 輸出「它們」，**不可**改「他們」
   - 學生寫「心裡」→ 輸出「心裡」，**不可**改「心理」
   - 學生寫「仇恨」→ 輸出「仇恨」，**不可**改「仇視」
   你的工作是回報學生實際寫了什麼，不是「該寫什麼」。
7. INSERTION MARK (插入符號 ∧ 或 入-shape):
   學生用 ∧ / 入 形手寫符號表示文字插入：
   - 符號尖端指向原文中的插入位置
   - 插入文字寫在符號上方（介於符號與上一行之間）
   - 把插入文字合併到該位置的原句內
   - 輸出**完整合併結果**（如同插入本來就存在），不提符號
   - 即使合併結果文意怪也照舊
   - 範例：「小明走路∧上學」+ 上方寫「快速」→ 輸出「小明走路快速上學」
${mathSymbolPreserveRules ? `
== MATH-SPECIFIC COPY RULES ==${mathSymbolPreserveRules.replace(/^\n2\. /, '\n- ').replace(/\n3\. /, '\n- ')}
` : ''}${domainSectionBlock}${formatBComponentBlock}

== QUESTION TYPE RULES ==
${[
  // tight_answer
  singleChoiceRules, multiChoiceRules, trueFalseRules, fillBlankRules, multiFillRules,
  // answer_with_context
  circleSelectOneRules, circleSelectManyRules, singleCheckRules, multiCheckRules, markInTextRules,
  // group_shared
  matchingRules,
  // full_page
  mapFillRules,
  // large_visual_area
  shortAnswerRules, calculationRules, wordProblemRules, proportionTableRules, orderingRules,
  mapSymbolRules, gridGeometryRules, connectDotsRules, diagramDrawRules, diagramColorRules,
  // compound_linked
  compoundCircleRules, compoundCheckRules, compoundWriteinRules,
  compoundJudgeCorrectionRules, compoundJudgeExplainRules,
  multiCheckOtherRules, compoundChainTableRules
].filter(Boolean).join('')}

Return:
{
  "answers": [
    {
      "questionId": "string",
      "studentAnswerRaw": "exact text as written",
      "status": "read|blank|unreadable"${needsReadingReasoning ? `,
      "readingReasoning": "理解 → 抄錄 → 輸出 三段推理（必填於：single_choice / multi_choice / circle_select_one|many / single_check / multi_check / multi_check_other / compound_*_with_explain / compound_judge_*）。其他 type 可省略此欄位。"` : ''}${(isEnglish && fillBlankIds.length > 0) ? `,
      "rawSpelling": "d-i-n-n-g r-o-o-m（**只在英語 fill_blank** 才輸出，其他 type 與其他領域 omit 此欄位）"` : ''}
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

// ── AI2（校對審查員）：看裁切圖 + 知道正確答案 ─────────────────────────────────
// AI2 receives the same crops as AI1, but also knows the correct answer for each question.
// This creates cognitive diversity: AI1 is pure OCR, AI2 is reference-aware review.
function buildReviewReadPrompt(classifyResult, options = {}) {
  const basePrompt = buildReadAnswerPrompt(classifyResult, options)
  return `== ROLE: 校對審查員 (Review Reader) ==
You are a review reader. You see the same cropped answer regions as the transcriber, but you ALSO know the correct answer for each question (shown in the label).

Your job is still to report what the student ACTUALLY wrote — NOT the correct answer.

HOW TO USE THE CORRECT ANSWER:
- Use it as a VERIFICATION HINT: after your initial reading, compare with the correct answer.
- If your reading DIFFERS from the correct answer, look again MORE CAREFULLY for any faint, small, or partially hidden strokes you might have missed.
- If after careful re-examination you still see the same thing → report what you see. The student may genuinely have written something different from the correct answer.
- NEVER output the correct answer unless you can physically see it in the student's handwriting.

You will see a series of CROPPED answer regions, one image per question.
Each crop is preceded by a label: "--- 題目 [ID]（類型：[type]，正確答案：[answer]）---"

STRICT RULES:
- Your output must be what the student PHYSICALLY WROTE, not the correct answer.
- If the student wrote something different from the correct answer, report what the student wrote.
- If the answer space is empty → status='blank', even if you know the correct answer.
- The correct answer only helps you LOOK MORE CAREFULLY — it does NOT change what you report.

${AI2_ANTI_BIAS_FRAMEWORK}

${basePrompt}`
}

// ── AI1（客觀抄寫員）：只看裁切圖，不知道正確答案 ─────────────────────────
// The same question-type rules apply, but:
// - Images sent = one crop per question (NO full submission image)
// - AI1 CANNOT see question stems or surrounding context
// - Must apply blank-first strictly (crop may be the answer space only)
function buildDetailReadPrompt(classifyResult, options = {}) {
  const basePrompt = buildReadAnswerPrompt(classifyResult, options)
  return `== ROLE: 客觀抄寫員 (Objective Transcriber) ==
You are a pure OCR transcriber. You do NOT know the correct answer. You have NO mathematical knowledge and must NOT solve, infer, or guess.
Your only job is to faithfully copy what the student physically wrote — nothing more, nothing less.

You will see a series of CROPPED answer regions, one image per question.
Each crop is preceded by a label: "--- 題目 [ID]（類型：[type]）---"
You CANNOT see the full submission. You CANNOT see question stems or neighboring questions.

STRICT RULES:
- You do NOT know what the correct answer is. You do NOT know what the student intended to write.
- NEVER output an answer based on what you think the correct answer should be, or based on the question stem or context clues.
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
  // arbiterItems: [{ questionId, questionType, ai1Answer, ai1Status, ai2Answer, ai2Status }]
  const questionBlocks = arbiterItems.map((item) => {
    const ai1Str = item.ai1Status === 'blank' ? '（空白）' : item.ai1Status === 'unreadable' ? '（無法辨識）' : `「${item.ai1Answer}」`
    const ai2Str = item.ai2Status === 'blank' ? '（空白）' : item.ai2Status === 'unreadable' ? '（無法辨識）' : `「${item.ai2Answer}」`
    return `題目 ${item.questionId}（類型：${item.questionType}）
  AI1（客觀抄寫）讀到：${ai1Str}（status: ${item.ai1Status}）
  AI2（校對審查）讀到：${ai2Str}（status: ${item.ai2Status}）`
  }).join('\n\n---\n\n')

  return `你是一致性判官（AI3）。

你的唯一任務：判斷 AI1 和 AI2 對同一題的讀取結果是否【語意一致】。
你不需要看圖、不需要重新讀取、不需要判斷誰對誰錯。

== 判斷規則 ==

「一致」(consistent) 的條件 — 以下任一成立即為一致：
  - 兩者答案完全相同（含空白對空白）
  - 兩者答案僅有格式差異，語意相同（如 "−" vs "－"、"×" vs "✕"、"0.75" vs ".75"）
  - 計算題/應用題（calculation / word_problem）：只比較最終答案（最後一行的數值或結論）。步驟文字、中間過程、標題前綴（如 "東南亞："）的差異一律忽略。只要最終數值或結論相同 → 一致
  - 順序不同但內容相同（如 "A, B" vs "B, A"）
  - 圖表題（diagram_draw / diagram_color）：一方的內容是另一方的子集（如 AI1 列出 5 項，AI2 列出其中 4 項，缺少的項目沒有矛盾）→ 視為一致，因為可能是預印內容的取捨差異

「不一致」(inconsistent) 的條件 — 以下任一成立即為不一致：
  - 數字不同（"7" vs "70"、"8" vs "18"、"3/10" vs "1/10"）
  - 文字內容不同（"麥塊教案" vs "麥塊教育版"）
  - 一方是 blank/unreadable，另一方有答案
  - 答案長度差異大且不是純格式差異

⚠️ 寧可誤判為「不一致」，也不要把真正不同的答案判為「一致」。
⚠️ 不要猜測誰對誰錯，不要考慮正確答案，只做一致性比較。

== 需判斷的題目 ==

${questionBlocks}

== 輸出 JSON ==
{
  "consistencyResults": [
    { "questionId": "...", "consistent": true },
    { "questionId": "...", "consistent": false, "reason": "簡短說明不一致的原因" }
  ]
}`.trim()
}

// Apply consistency decision: consistent → use AI1 answer, inconsistent → needs_review
function applyForensicDecision(forensic, ai1Answer, ai2Answer) {
  const isConsistent = forensic?.consistent === true
  if (isConsistent) {
    // 一致 → 一律使用 AI1（客觀抄寫員）的答案
    return { arbiterStatus: 'arbitrated_agree', finalAnswer: ai1Answer }
  }
  // 不一致 → 送人工審查
  return { arbiterStatus: 'needs_review' }
}

function buildAccessorPrompt(answerKey, readAnswerResult, domainHint) {
  const strictness = answerKey?.strictness || 'standard'
  const strictnessRule =
    strictness === 'strict'
      ? 'GRADING STRICTNESS: STRICT — For objective categories (single_choice, true_false, fill_blank, fill_variants, single_check, multi_check, multi_choice), enforce exact correctness per category rules. For rubric categories (short_answer, map_symbol, grid_geometry, connect_dots, diagram_draw, diagram_color), judge by rubric dimensions and visual/concept correctness; do NOT require literal format matching unless the category rule explicitly requires it.'
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
  🚨 MISSPELLING vs MISSING+EXTRA: If a student's word looks like a partial or misspelled version of a correct word (e.g. "kit" → "kitchen", "broth" → "brother", "cook" → "cooking"), treat it as ONE SPELLING ERROR — NOT as "missing word + extra word". A word is a misspelling if it shares 3+ leading characters with the correct word OR has edit distance ≤ 2. Only count as separate missing+extra when the two words are completely unrelated.

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
- word_problem: Standard-answer question type with FIXED DEDUCTION scoring (not multi-dimension rubric).
  SPLIT RULE: The line starting with "答：", "A:", or "Ans:" is the 答句; everything above is the 列式計算 (process). If no such line exists, treat the entire answer as process only (答句 = blank).
  VISUAL PROCESS CHECK: If an image of the student's handwritten work is attached (labelled "學生作答圖"), use the IMAGE as the primary source. The text transcription may be inaccurate for fractions, subscripts, and multi-line calculations.
  🚨 FIXED DEDUCTION SCORING (word_problem — must follow strictly):
  Start with score = maxScore, then apply deductions in order:
  STEP 1 — 答句數值: If the numeric value is WRONG → score = 0. STOP.
  STEP 2 — 答句單位: If referenceAnswer has a unit but student OMITTED it → deduct 1. If student wrote a WRONG unit (not in UNIT EQUIVALENCE TABLE) → score = 0. STOP.
  STEP 3 — 列式計算: If process contains a clear mathematical ERROR (wrong formula, wrong operation) → deduct 1. If process is missing entirely (only 答句, no steps) → deduct 1. Abbreviated or skipped trivial steps = NO deduction.
  Final score = max(0, score after deductions). Each deficiency deducts exactly 1 point, never more.
  When in doubt on STEP 3, do NOT deduct. Stability > strictness.
- calculation: Standard-answer question type with FIXED DEDUCTION scoring (not multi-dimension rubric).
  SPLIT RULE: If studentAnswerRaw starts with the parentheses answer (the value the student wrote inside "=( )"), that is the 最終答案. The remaining lines are the 算式過程 (process). If no parentheses answer is present, use the last standalone "= X" result as the 最終答案.
  HARD RULE: NEVER require "答：", "A:", or "Ans:" prefix. NO unit checking — students do NOT need to write units.
  VISUAL PROCESS CHECK: If an image of the student's handwritten work is attached (labelled "學生作答圖"), use the IMAGE as the primary source for judging 算式過程.
  🚨 FIXED DEDUCTION SCORING (calculation — must follow strictly):
  Start with score = maxScore, then apply deductions in order:
  STEP 1 — 最終答案: If the final numeric value is WRONG → score = 0. STOP.
  STEP 2 — 算式過程: If process contains a clear mathematical ERROR (wrong formula, wrong operation) → deduct 1. If process is missing entirely (only final answer, no steps) → deduct 1. Abbreviated or skipped trivial steps = NO deduction.
  Final score = max(0, score after deductions). Each deficiency deducts exactly 1 point, never more.
  When in doubt, do NOT deduct. Stability > strictness.
  LENIENT FOCUS: when strictness = lenient, if 最終答案 is correct, allow full score regardless of process.
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
- diagram_draw: studentAnswerRaw is a description of label-value pairs the student drew on a chart (e.g. "番茄汁 2/5, 紅蘿蔔汁 1/10, 蘋果汁 3/20"). referenceAnswer describes the correct data.
  FOR BAR CHARTS: Grade using rubricsDimensions (數值正確性 + 標籤完整性). Allow ±2 units tolerance for bar heights.
  🚨 FOR PIE CHARTS: Use FIXED DEDUCTION scoring (not rubricsDimensions):
  Start with score = maxScore. Check EACH expected sector/item from referenceAnswer:
  Each item must meet ALL 3 conditions to count as correct:
    1. Has item name (項目名, e.g. "光武國中")
    2. Has proportion value (比率: fraction, decimal, or percentage — any one format is acceptable)
    3. Sector size is reasonable (the drawn sector's visual proportion roughly matches the stated value)
  If ANY of the 3 conditions is NOT met for an item → deduct 1 point (per item, not per condition).
  Final score = max(0, score after deductions).
  errorType: 'concept' if wrong values or missing labels; 'blank' if no chart drawn.
- matching: studentAnswerRaw is the right-side text the student connected to this left-side item (e.g. "2公尺/秒"). The AnswerKey answer field is the correct right-side text.
  - Compare case-insensitively, ignoring leading/trailing whitespace.
  - Allow equivalent unit representations (e.g. "km/h" = "公里/小時").
  - isCorrect = true if the student's text matches the answer (or an equivalent form).
  - score = maxScore if isCorrect, else 0 (binary scoring per pair).
  - errorType: 'concept' if wrong connection; 'blank' if "未連線" or "未作答".
- map_fill: See MAP-FILL SCORING below.
- multi_fill: See MULTI-FILL SCORING below.
- map_symbol / grid_geometry / connect_dots: See MAP-DRAW SCORING below.
- circle_select_one: Student wrote the selected option **text** (not letter), e.g. "同意". Compare to answer field (correct option text) — exact text match after whitespace trim and full-width/half-width normalize. score = maxScore if match, else 0. errorType: 'concept' if wrong; 'blank' if empty/未圈.
- circle_select_many: Student answer is comma-separated option **texts** (e.g. "同意,中立"). answer field is correct set as comma-separated texts. Apply SEPARATOR NORMALIZATION + set comparison logic identical to multi_check (correct ∩, extraWrong = max(0, |wrong|−|missing|), partial credit formula). errorType: 'concept' if wrong; 'blank' if empty.
- mark_in_text: Student answer is comma-separated marked words (e.g. "春天,夏天"). answer field is correct set as comma-separated. Use the same set comparison + partial credit formula as multi_check. errorType: 'concept' if wrong words marked; 'blank' if empty.
- compound_circle_with_explain / compound_check_with_explain / compound_writein_with_explain: Compound D-bucket question. studentAnswerRaw uses "⧉" as separator: "[partA] ⧉ [partB]" where partA = 圈選/勾選位置編號/寫入代號, partB = 理由文字.
  REQUIRED: rubricsDimensions present (typically 2 dims: 圈選/勾選/代號 + 理由).
  Apply per-dimension scoring:
  - 圈選/勾選/代號 dimension: judge partA against criteria. 自選情境（criteria 含「有圈選任一即可」）→ 任何選擇即 full. 必選情境（criteria 含「必須圈選正確選項」）→ partA 須符合 answer field 才 full.
  - 理由 dimension: judge partB content against criteria — 理由是否能 support partA 所選選項、是否符合 criteria 描述的概念.
  score = sum of dimension scores. isCorrect = (score === maxScore).
  errorType: 'concept' if any dimension fails; 'blank' if both parts empty (partA="未圈" / "未勾" / 等空白標記 AND partB="未說明").
- compound_judge_with_correction: studentAnswerRaw "[judgment] ⧉ [correction]" where judgment = ○ 或 ✗, correction = 改正文字（學生判 ✗ 才需要寫）or "無需改正" or "未改正".
  Use rubricsDimensions if present (2 dims: 判斷 + 改正); otherwise FIXED DEDUCTION:
  Start with score = maxScore.
  STEP 1 — 判斷正確性: judgment 與 answer field（○ 或 ✗）一致 → 通過；不一致 → score = 0, STOP.
  STEP 2 — 改正合理性: if answer = ✗ (敘述應改正) AND student also judged ✗ → 比對 correction 與 referenceAnswer 的改正內容. correction 正確 → 通過；correction = "未改正" → deduct 1; correction 內容錯誤 → deduct 1.
  STEP 3 — 不需改正: if answer = ○ AND student judged ○ → correction = "無需改正" or 空白皆可，full marks.
  Final score = max(0, score after deductions).
  errorType: 'concept' if 判斷 wrong; 'blank' if both empty.
- compound_judge_with_explain: studentAnswerRaw "[judgment] ⧉ [explanation]". 判斷 + 解釋為什麼.
  REQUIRED: rubricsDimensions (typically 2 dims: 判斷 + 說明).
  - 判斷 dimension: judgment 與 answer field 一致 → full; 否則 0.
  - 說明 dimension: judge explanation against criteria — 是否符合 criteria 的概念描述.
  score = sum. errorType: 'concept' if any wrong; 'blank' if both empty.
- compound_chain_table: studentAnswerRaw is multi-line table content, each line uses "|" to separate columns (e.g. "孔子 | 周遊列國 | 教學興盛\\n孟子 | ...").
  Parse rows by "\\n", parse cells by "|". Compare to referenceAnswer's row structure.
  Use rubricsDimensions if present (typically per-row or per-aspect rubric); otherwise per-row scoring:
  - Each row's cells must all match referenceAnswer's corresponding row to count as correct.
  - 🚨 CHAIN DEPENDENCY: cells in a row are linked — if cell N is wrong, cells N+1..end of that row are auto-wrong (依存錯誤). Award 0 for that row.
  - score = round(correctRows / totalRows × maxScore).
  - errorType: 'concept' if cells wrong; 'blank' if no rows or all "_".
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
  - calculation:       correct→「算式過程正確，最終答案36正確」 wrong→「學生最終答案為38，正確答案為36，答案錯誤」 process_error→「最終答案36正確，算式過程有誤（第二步乘法錯誤），扣1分」
  - word_problem:      correct→「列式正確，答句「36公分」正確」 wrong→「學生答句寫「38公分」，正確答案為「36公分」，答案錯誤」 missing_unit→「答句數值36正確，但缺少單位「公分」，扣1分」 process_error→「答句「36公分」正確，列式過程有誤（第二步乘法錯誤），扣1分」
  - short_answer:      correct→「學生回答內容完整，概念正確」 wrong→「學生寫「因為天氣很熱」，正確答案應涵蓋「蒸發作用」概念，學生僅描述現象未說明原理」. When rubricsDimensions exist, describe each dimension's score.
  - matching:          correct→「學生配對「2公尺/秒」，答案正確」 wrong→「學生配對「3公尺/秒」，正確答案為「2公尺/秒」，配對錯誤」
  - map_fill:          correct→「所有位置填寫正確」 wrong→「學生將位置C填為「越南」、位置D填為「泰國」，正確答案為C=泰國、D=越南，兩者填反」
  - map_symbol/grid_geometry/connect_dots: correct→「學生繪製颱風符號於右下格，位置與符號皆正確」 wrong→「學生繪製颱風符號於左下格，正確位置為右下格，符號正確但位置偏移」
  - circle_select_one: correct→「學生圈選「同意」，答案正確」 wrong→「學生圈選「不同意」，正確答案為「同意」，圈選錯誤」
  - circle_select_many: correct→「學生圈選「同意、中立」，答案正確」 wrong→「學生圈選「同意、不同意」，正確答案為「同意、中立」，多圈了不同意、漏圈中立」
  - mark_in_text: correct→「學生圈出「春天、夏天、秋天、冬天」，全部正確」 wrong→「學生圈出「春天、夏天」，正確答案為「春天、夏天、秋天、冬天」，漏圈秋天、冬天」
  - compound_circle_with_explain / compound_check_with_explain / compound_writein_with_explain: 兩段分開描述，例：「圈選「同意」（自選 OK）；理由說明「促進和平」與所選選項一致，理由維度滿分」 或 wrong→「圈選「同意」（自選 OK）；理由僅一句「我覺得好」，未具體支持選項，理由維度扣 N 分」
  - compound_judge_with_correction: correct(○)→「學生判斷○，答案正確，無需改正」 correct(✗)→「學生判斷✗，答案正確；改正內容「太陽從東方升起」正確」 wrong→「學生判斷○，正確答案為✗，敘述需改正卻判為正確」 wrong_correction→「學生判斷✗ 正確；但改正內容「太陽往天空跑」未明確指出正確事實，扣1分」
  - compound_judge_with_explain: correct→「學生判斷○ 正確；說明「地球自轉造成晝夜變化」概念正確」 wrong→「學生判斷✗，正確答案為○，判斷錯誤；說明維度依據判斷錯誤，整體 0 分」
  - compound_chain_table: correct→「3 列全部正確」 wrong→「第 1 列「孔子-周遊列國-教學興盛」全對；第 2 列「孟子」後續欄位錯，依序判 0 分；第 3 列空白」
  - diagram_color:     correct→「塗色比例2/3與位置皆正確」 wrong→「學生塗色比例約1/2，正確比例為2/3，塗色面積不足」
  - diagram_draw:      correct→「圖表數值與標籤皆正確」 wrong(pie)→「光武國中 2/5 正確；康乃薾 缺少比率，扣1分；實驗中學 缺少項目名與比率，扣1分」 wrong(bar)→「學生標示番茄汁為60°，正確值為80°，數值偏差過大」

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
  const bboxOverrides = Array.isArray(payload?.bboxOverrides) ? payload.bboxOverrides : null
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
    logStaged(pipelineRunId, stagedLogLevel, 'classify anchorHint specs', specsWithAnchor.map((s) => ({ id: s.questionId, anchorHint: s.anchorHint })))
  }
  // Log tablePosition specs for debugging table cell targeting
  const specsWithTable = classifyQuestionSpecs.filter((s) => s.tablePosition)
  if (specsWithTable.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'classify tablePosition specs', specsWithTable.map((s) => ({ id: s.questionId, tablePosition: s.tablePosition })))
  }

  // Build per-page question groups（classify 和 bboxOverrides 都需要）
  const pageQuestionsMap = new Map()
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
  if (!pageQuestionsMap.has(1)) pageQuestionsMap.set(1, [])
  pageQuestionsMap.get(1).push(...otherIds)
  const pageEntries = [...pageQuestionsMap.entries()]
    .filter(([, ids]) => ids.length > 0)
    .sort(([a], [b]) => a - b)

  // ── bboxOverrides → 跳過 classify AI，用前端 bbox ──
  let classifyResult
  if (bboxOverrides && bboxOverrides.length > 0) {
    const overrideMap = new Map(bboxOverrides.map((o) => [o.questionId, o]))
    classifyResult = { alignedQuestions: questionIds.map((qId) => {
      const override = overrideMap.get(qId)
      const akQ = answerKeyQuestions.find((q) => q?.id === qId)
      return {
        questionId: qId,
        questionType: akQ ? resolveExpectedQuestionType(akQ) : 'fill_blank',
        visible: true,
        answerBbox: override?.answerBbox || null,
        bboxCorrected: override?.corrected || false
      }
    }), coverage: 1 }
    logStaged(pipelineRunId, 'basic', 'bboxOverrides → skip classify AI', { questions: questionIds.length })
  } else {
  // Per-page classify: one call per page, all dispatched in parallel.

  logStageStart(pipelineRunId, 'classify')
  logStaged(pipelineRunId, stagedLogLevel, 'classify per-page plan', {
    numPages: pageEntries.length,
    answerKeyPages: answerKeyImageParts.length,
    pages: pageEntries.map(([p, ids]) => ({ page: p, count: ids.length }))
  })

  // classifyResult 已在外層 if/else 之前宣告（let classifyResult）

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
    classifyResult = applyClassifyQuestionSpecs(normalizeClassifyResult(classifyParsed, ids), classifyQuestionSpecs, pageEntries.length || 1)
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
      }, classifyQuestionSpecs, pageEntries.length || 1)
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
      }, classifyQuestionSpecs, pageEntries.length || 1)
    }
  }
  } // end else (skip classify when bboxOverrides)

  // classifyAligned: bboxOverrides 時已在上方構造好，不需要再覆蓋
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
  logStaged(pipelineRunId, stagedLogLevel, 'classify bbox detail', classifyAligned
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
          x: +akBbox.x.toFixed(4),
          y: +(pageStartY + akBbox.y * pageHeight).toFixed(4),
          w: +akBbox.w.toFixed(4),
          h: +(akBbox.h * pageHeight).toFixed(4)
        }
      } else if (akBbox) {
        akHintFullImage = { x: +akBbox.x.toFixed(4), y: +akBbox.y.toFixed(4), w: +akBbox.w.toFixed(4), h: +akBbox.h.toFixed(4) }
      }
      const yDiff = (cBbox && akHintFullImage) ? +(cBbox.y - akHintFullImage.y).toFixed(4) : null
      const xDiff = (cBbox && akHintFullImage) ? +(cBbox.x - akHintFullImage.x).toFixed(4) : null
      return {
        id: q.questionId,
        type: q.questionType,
        classify: cBbox ? { y: +cBbox.y.toFixed(3), h: +cBbox.h.toFixed(3), x: +cBbox.x.toFixed(3), w: +cBbox.w.toFixed(3) } : null,
        akHint: akHintFullImage,
        yDiff,
        xDiff,
        ...(yDiff !== null && Math.abs(yDiff) > 0.02 ? { warn: 'Y_DRIFT' } : {})
      }
    })
  )
  // Log tablePosition reasoning for debugging table cell targeting
  const tableReasoningDebug = classifyAligned
    .filter((q) => q.tablePositionReasoning)
    .map((q) => ({ id: q.questionId, reasoning: q.tablePositionReasoning }))
  if (tableReasoningDebug.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'classify tablePosition reasoning', tableReasoningDebug)
  }
  const multiFillBboxDebug = classifyAligned
    .filter((q) => q.visible && q.questionType === 'multi_fill')
    .map((q) => ({ questionId: q.questionId, answerBbox: q.answerBbox }))
  if (multiFillBboxDebug.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'multi_fill answerBbox coords', multiFillBboxDebug)
  }

  // ── Classify Quality Gate + Auto-Retry (max 1) ────────────────────────────
  const classifyQG = validateClassifyQuality(classifyResult, questionIds)
  logStaged(pipelineRunId, 'basic', 'classify quality-gate', {
    severity: classifyQG.severity, warnings: classifyQG.warnings, metrics: classifyQG.metrics
  })
  if (classifyQG.severity === QG_SEVERITY.FAIL && !payload?.classifyOnly && !bboxOverrides) {
    // classifyOnly / bboxOverrides 不 retry — 中位數校正會修復 bbox 問題
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
          classifyResult = applyClassifyQuestionSpecs(normalizeClassifyResult(retryParsed, ids), classifyQuestionSpecs, pageEntries.length || 1)
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
          }, classifyQuestionSpecs, pageEntries.length || 1)
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
  logStaged(pipelineRunId, stagedLogLevel, 'dynamic crop padding', { totalPages, pad: dynamicPad, padWide: dynamicPadWide })

  // ── classifyOnly mode: 回傳 bbox 就結束，不做 crop/read/AI3 ─────────────
  if (payload?.classifyOnly) {
    const bboxResults = classifyAligned
      .filter((q) => q.visible)
      .map((q) => ({
        questionId: q.questionId,
        questionType: q.questionType,
        answerBbox: q.answerBbox || null
      }))
    logStaged(pipelineRunId, 'basic', 'classifyOnly → return bbox', { count: bboxResults.length })
    return { classifyOnly: true, bboxResults, stageResponses }
  }

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
  // answerBbox is now tight for all fill_blank (single + sub-question) — no separate readBbox.
  const allQuestionCropMap = new Map()  // questionId → { data, mimeType }
  const ai1CropCandidates = classifyAligned.filter(
    (q) => q.visible && q.answerBbox && q.questionType !== 'map_fill'
      && !focusedCheckboxCropMap.has(q.questionId)  // exclude already-cropped checkbox questions
  )
  if (ai1CropCandidates.length > 0 && inlineImages.length > 0) {
    const inlineImage = inlineImages[0]
    const cropResults = await Promise.all(
      ai1CropCandidates.map(async (q) => {
        const bboxToUse = q.answerBbox
        // fill_blank 子題（括號型）用小 padding，避免裁切到上下相鄰的括號
        const isParenSubQ = q.questionType === 'fill_blank' && q.questionId.split('-').length >= 3
          && !classifyAligned.find(cq => cq.questionId === q.questionId && cq.tablePositionReasoning)
        const cropPad = isParenSubQ ? +(0.01 / totalPages).toFixed(4)
          : dynamicPad
        const cropData = await cropInlineImageByBbox(
          inlineImage.inlineData.data,
          inlineImage.inlineData.mimeType,
          bboxToUse,
          true,
          cropPad
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
    answerKeyQuestions: answerKeyQuestions,
    domainHint: internalContext?.domainHint
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
  // AI2 uses buildReviewReadPrompt: same rules as AI1, but knows correct answers (review role).
  // Labels include correct answer so AI2 can use it as a verification hint.
  const akMapForAi2 = mapByQuestionId(answerKeyQuestions, (item) => item?.id)
  const globalReadPrompt = buildReviewReadPrompt(classifyResult, {
    answerKeyQuestions,
    domainHint: internalContext?.domainHint
  })
  const ai2Parts = [{ text: globalReadPrompt }]
  for (const q of classifyAligned) {
    if (!q.visible) continue
    const crop = allQuestionCropMap.get(q.questionId)
    if (!crop) continue
    const akQ = akMapForAi2.get(q.questionId)
    const correctAnswer = ensureString(akQ?.answer || akQ?.referenceAnswer, '').trim()
    const answerLabel = correctAnswer ? `，正確答案：${correctAnswer}` : ''
    ai2Parts.push({ text: `--- 題目 ${q.questionId}（類型：${q.questionType}${answerLabel}）---` })
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
    // AI2: review read (same crops as AI1, but knows correct answers — acts as reviewer)
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
    logStaged(pipelineRunId, stagedLogLevel, 'ReadAnswer per-question', toReadAnswerSchemaPreview(readAnswerParsed))
    logStaged(pipelineRunId, stagedLogLevel, 'reReadAnswer per-question', toReadAnswerSchemaPreview(reReadAnswerParsed))
  }

  // ── A3b: Focused bracket read for circle_select_one/many questions (crop-based, context-free) ──
  const bracketQuestions = classifyAligned.filter(
    (q) => q.visible && (q.questionType === 'circle_select_one' || q.questionType === 'circle_select_many') && q.bracketBbox
  )
  if (bracketQuestions.length > 0) {
    const inlineImage = inlineImages[0]
    logStaged(pipelineRunId, stagedLogLevel, 'bracket-read begin', { count: bracketQuestions.length })
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
          logStaged(pipelineRunId, stagedLogLevel, `bracket-read crop-failed qid=${q.questionId}`)
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
          logStaged(pipelineRunId, stagedLogLevel, `bracket-read failed qid=${q.questionId}`)
          return null
        }
        const parsed = parseCandidateJson(bracketResponse.data)
        const answer = Array.isArray(parsed?.answers) ? parsed.answers[0] : null
        if (answer) {
          logStaged(pipelineRunId, stagedLogLevel, `bracket-read result qid=${q.questionId}`, {
            studentAnswerRaw: answer.studentAnswerRaw,
            status: answer.status,
            readingReasoning: answer.readingReasoning || answer.formatBReasoning
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
      logStaged(pipelineRunId, stagedLogLevel, 'bracket-read overrides applied (AI1 only)', { count: overrideMap.size })
    }
  }

  // ── A3c: Focused checkbox read (crop-based, context-reduced) ───────────────
  if (focusedCheckboxCropMap.size > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'focused-checkbox-read begin', {
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
          logStaged(pipelineRunId, stagedLogLevel, `focused-checkbox-read failed qid=${questionId}`)
          return null
        }

        const parsed = parseCandidateJson(focusedResponse.data)
        const answer = Array.isArray(parsed?.answers) ? parsed.answers[0] : null
        if (answer) {
          logStaged(pipelineRunId, stagedLogLevel, `focused-checkbox-read result qid=${questionId}`, {
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
      logStaged(pipelineRunId, stagedLogLevel, 'focused-checkbox-read overrides applied (AI1 only)', {
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
        includeQuestionIds: missingFocusedIds,
        domainHint: internalContext?.domainHint
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
    logStaged(pipelineRunId, stagedLogLevel, 'focused-multifill-read begin (dual: direct + analytic)', {
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
        logStaged(pipelineRunId, stagedLogLevel, `focused-multifill-read dual qid=${q.questionId}`, {
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
      logStaged(pipelineRunId, stagedLogLevel, 'focused-multifill uncertain chars detected', {
        questionIds: [...multiFillUncertainIds]
      })
    }
    // Override AI1 (readAnswerParsed) with read-1 results
    if (multiFillRead1Map.size > 0) {
      readAnswerParsed = applyAnswerOverrides(readAnswerParsed, multiFillRead1Map)
      logStaged(pipelineRunId, stagedLogLevel, 'focused-multifill read-1 overrides applied → AI1', { count: multiFillRead1Map.size })
    }
    // Override AI2 (reReadAnswerParsed) with read-2 results — replacing unreliable full-image reads
    if (multiFillRead2Map.size > 0) {
      reReadAnswerParsed = reReadAnswerParsed ?? { answers: [] }
      reReadAnswerParsed = applyAnswerOverrides(reReadAnswerParsed, multiFillRead2Map)
      logStaged(pipelineRunId, stagedLogLevel, 'focused-multifill read-2 overrides applied → AI2', { count: multiFillRead2Map.size })
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
  logStaged(pipelineRunId, stagedLogLevel, 'cross-stage classify→read quality-gate', {
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
      bboxCorrected: classifyRow?.bboxCorrected || false,
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
    logStaged(pipelineRunId, stagedLogLevel, 'E↔F underline ambiguity flagged', Array.from(efFlaggedIds))
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
        logStaged(pipelineRunId, stagedLogLevel, 'english-spelling-verify begin', { count: spellingItems.length })
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
          logStaged(pipelineRunId, stagedLogLevel, 'english-spelling-verify result', overrideCount)
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
  // AI3 一致性判官：所有題目都送 AI3 做語意一致性比較，不做程式碼預判
  const arbiterItems = questionResultsRaw
    .filter((qr) => {
      const s1 = qr.readAnswer1.status
      const s2 = qr.readAnswer2.status
      // 雙方都 blank → 自動一致，不需送 AI3
      if (s1 === 'blank' && s2 === 'blank') return false
      return true
    })
    .map((qr) => ({
      questionId: qr.questionId,
      questionType: qr.questionType,
      ai1Answer: qr.readAnswer1.studentAnswer,
      ai1Status: qr.readAnswer1.status,
      ai2Answer: qr.readAnswer2.studentAnswer,
      ai2Status: qr.readAnswer2.status
    }))

  const arbiterByQuestionId = new Map()
  const arbiterItemsForAI3 = arbiterItems
  if (arbiterItemsForAI3.length > 0) {
    try {
      // Build AI3 parts: text prompt + full image + interleaved (label + crop) per question
      const arbiterPromptText = buildArbiterPrompt(arbiterItemsForAI3)
      // AI3 一致性判官：只看文字，不看圖片
      const arbiterParts = [{ text: arbiterPromptText }]
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
        const results = Array.isArray(arbiterParsed?.consistencyResults) ? arbiterParsed.consistencyResults : []
        for (const r of results) {
          const qId = ensureString(r?.questionId).trim()
          if (!qId) continue
          const item = arbiterItems.find((i) => i.questionId === qId)
          if (!item) continue
          const decision = applyForensicDecision(r, item.ai1Answer, item.ai2Answer)
          arbiterByQuestionId.set(qId, {
            arbiterStatus: decision.arbiterStatus,
            finalAnswer: decision.finalAnswer,
            consistent: r.consistent,
            reason: r.reason || undefined
          })
        }
        logStaged(pipelineRunId, stagedLogLevel, 'AI3 consistency summary', {
          sent: arbiterItems.length,
          received: results.length,
          consistent: Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus === 'arbitrated_agree').length,
          inconsistent: Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus === 'needs_review').length
        })
        logStaged(pipelineRunId, stagedLogLevel, 'AI3 consistency per-question', Array.from(arbiterByQuestionId.entries()).map(([qId, v]) => ({
          questionId: qId,
          arbiterStatus: v.arbiterStatus,
          finalAnswer: v.finalAnswer,
          consistent: v.consistent,
          reason: v.reason
        })))
      }
    } catch (arbiterErr) {
      logStaged(pipelineRunId, stagedLogLevel, 'AI3 arbiter failed (fallback to consistency status)', {
        error: arbiterErr?.message
      })
    }
  }

  // ── Arbiter Quality Gate ──
  const ai3ResultCount = arbiterByQuestionId.size
  if (ai3ResultCount > 0) {
    const arbiterResults = Array.from(arbiterByQuestionId.values())
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

  // ── Per-question consolidated log ──
  const perQuestionLog = questionResults
    .filter((qr) => qr.visible !== false)
    .map((qr) => {
      const bbox = qr.answerBbox
      const correctedTag = qr.bboxCorrected ? ' ⚡corrected' : ''
      const bboxStr = bbox ? `x=${(+bbox.x).toFixed(3)} y=${(+bbox.y).toFixed(3)} w=${(+bbox.w).toFixed(3)}${correctedTag}` : 'no-bbox'
      const ai1 = qr.readAnswer1?.status === 'blank' ? '(blank)' : qr.readAnswer1?.studentAnswer || '?'
      const ai2 = qr.readAnswer2?.status === 'blank' ? '(blank)' : qr.readAnswer2?.studentAnswer || '?'
      const ar = qr.arbiterResult || {}
      const ai3 = ar.arbiterStatus === 'arbitrated_agree'
        ? `✓ consistent → ${ar.finalAnswer || '(blank)'}`
        : `✗ inconsistent${ar.reason ? ` (${ar.reason})` : ''} → needs_review`
      return `${qr.questionId} [${qr.questionType}] | bbox: ${bboxStr} | AI1: ${ai1} | AI2: ${ai2} | AI3: ${ai3}`
    })
  logStaged(pipelineRunId, 'basic', 'per-question summary', '\n' + perQuestionLog.join('\n'))

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
    logStaged(pipelineRunId, stagedLogLevel, 'table edge leak flagged for review', tableLeakFlagged)
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
    logStaged(pipelineRunId, stagedLogLevel, 'english spacing flagged for review', spacingReviewFlagged)
  }

  const stableCount = questionResults.filter((q) => q.arbiterResult?.arbiterStatus !== 'needs_review').length
  const diffCount = 0  // no longer used (legacy compat: kept at 0)
  const unstableCount = questionResults.filter((q) => q.arbiterResult?.arbiterStatus === 'needs_review').length
  logStaged(pipelineRunId, stagedLogLevel, 'PhaseA 3-AI summary', {
    arbitratedCount: stableCount,
    needsReviewCount: unstableCount
  })

  // 寫入 Phase A stage log 到 Supabase（await 確保 serverless 環境下不漏存）
  if (internalContext?.ownerId) {
    const phaseALogData = extractPhaseALogData({
      pipelineRunId,
      classifyResult,
      readAnswerResult: readAnswerParsed,
      reReadAnswerResult: reReadAnswerParsed,
      arbiterResult: Array.from(arbiterByQuestionId.entries()).map(([qId, r]) => ({ questionId: qId, ...r })),
      stageResponses,
      needsReviewCount: unstableCount,
      stableCount,
      diffCount: 0,
      unstableCount
    })
    await saveGradingStageLog({
      ownerId: internalContext.ownerId,
      assignmentId: internalContext.assignmentId || payload?.assignmentId || '',
      submissionId: internalContext.submissionId || payload?.submissionId || '',
      pipelineRunId,
      phase: 'phase_a',
      model,
      logData: phaseALogData
    }).catch(() => {})
  }

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
  logStaged(pipelineRunId, stagedLogLevel, 'cross-stage read→accessor quality-gate', {
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

  // 寫入 Phase B stage log 到 Supabase（含自動一致性比對，await 確保不漏存）
  if (internalContext?.ownerId) {
    const phaseBLogData = extractPhaseBLogData({
      pipelineRunId,
      accessorResult,
      explainResult,
      finalResult,
      stageResponses
    })
    await saveGradingStageLog({
      ownerId: internalContext.ownerId,
      assignmentId: internalContext.assignmentId || payload?.assignmentId || '',
      submissionId: internalContext.submissionId || payload?.submissionId || '',
      pipelineRunId,
      phase: 'phase_b',
      model,
      logData: phaseBLogData
    }).catch(() => {})
  }

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
- short_answer / map_symbol / grid_geometry / connect_dots: This is a correction submission.
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
