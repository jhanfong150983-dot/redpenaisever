import { getPipeline } from './pipelines.js'
import { callGeminiGenerateContent } from './model-adapter.js'
import { AI_ROUTE_KEYS } from './routes.js'
import { STAGE_MODEL, MODEL_PRO, MODEL_FLASH, FALLBACK_CHAIN, resolveStageModel } from './model-config.js'
import { recordTokenUsage, extractModelNameFromResult } from '../ink-usage-tracker.js'
import {
  QG_SEVERITY,
  validateClassifyQuality,
  validateReadAnswerQuality,
  validateArbiterQuality,
  validateAccessorQuality,
  validateExplainQuality,
  validateClassifyReadConsistency,
  validateReadAccessorConsistency,
  buildPipelineFailure
} from './quality-gates.js'
import { extractPhaseALogData, extractPhaseBLogData, saveGradingStageLog, persistPhaseAState, persistFinalAnswers, loadPhaseAState, clearPhaseAState } from './stage-log-writer.js'
import { isOcrAssistEnabled, prepareOcrHintsForClassify, isOcrRowAnchorEnabled } from './ocr-client.js'
import { buildOcrHintsSection } from './bbox-anchor-match.js'
// 2026-05-20: applyOcrBboxOverride (width_floor + x_shift) 已移除
// 原因：實證上把 AI bbox 跟 OCR row candidate union 容易拉爆跨題（fill_blank 多次踩雷）。
// 新原則：bbox 來源只有兩條——OCR (row/sub_cell full replace) 或 AI (raw classify)、不再混用。
import { applyRowAnchorOverride } from './bbox-row-anchor-match.js'
import { applyMathEqBlankOverride } from './bbox-math-eq-blank.js'
import {
  buildStageAPrompt,
  parseStageAResult,
  buildStageBPrompt,
  buildStageBReviewPrompt,
  parseStageBResult,
  gradeMapFillDeterministically
} from './map-fill-grader.js'
import {
  VISUAL_JUDGMENT_TYPES,
  buildVjRubricPrompt,
  parseVjRubricResult,
  buildVjBlankPrompt,
  parseVjBlankResult,
  classifyVjBlank,
  buildVjGradePrompt,
  parseVjGradeResult,
  aggregateVjScore
} from './visual-judgment-grader.js'
import { getSupabaseAdmin } from '../_supabase.js'

const STAGED_PIPELINE_NAME = 'grading-evaluate-5stage-pipeline'

// ReadAnswer must be deterministic: low temperature prevents the model from
// "solving" or "normalizing" student answers across runs.
// thinking_level=MINIMAL: gemini-3-flash-preview defaults to HIGH which is slow;
// fallback models (e.g. gemini-2.5-flash) will have thinkingConfig stripped automatically.
export const READ_ANSWER_GENERATION_CONFIG = {
  generationConfig: {
    temperature: 0.3,
    thinkingConfig: {
      thinking_level: 'MINIMAL'
    }
  }
}

// 2026-05-30: VJ 視覺判斷題 grade 用 temp 0 — 實驗證實 borderline 柱(側稜 vs 底面高/半徑)在 temp 0.3
// 有 ~1/5 變異、會把對的判錯；temp 0 決定性、落在主流(正確)答案。只給 VJ grade、不動其他 stage。
export const VJ_GRADE_GENERATION_CONFIG = {
  generationConfig: {
    temperature: 0,
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

// 2026-05-17: 縮 prefix——pipelineRunId 取後 6 碼、移除冗長 hash、log 變得乾淨可掃
function shortRunId(pipelineRunId) {
  const s = String(pipelineRunId || '')
  return s.length > 6 ? s.slice(-6) : s
}

function logStageStart(pipelineRunId, stageName) {
  console.log(`[階段][${shortRunId(pipelineRunId)}] ${stageName} 開始`)
}

function logStageEnd(pipelineRunId, stageName, stageResponse) {
  const status = Number(stageResponse?.status) || 0
  const prepareLatencyMs = Number(stageResponse?.prepareLatencyMs) || 0
  const modelLatencyMs = Number(stageResponse?.modelLatencyMs) || 0
  const warningCount = Array.isArray(stageResponse?.warnings) ? stageResponse.warnings.length : 0
  console.log(
    `[階段][${shortRunId(pipelineRunId)}] ${stageName} 結束 狀態=${status} 模型=${modelLatencyMs}ms${warningCount > 0 ? ` 警告=${warningCount}` : ''}`
  )
  if (warningCount > 0) {
    console.warn(
      `[階段][${shortRunId(pipelineRunId)}] ${stageName} 警告列表：${stageResponse.warnings.join(', ')}`
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

// table_check（表格勾選題）→ 正規化成 table_cell 內部結構，重用 table_cell 的 classify / read / accessor。
// 每一計分列 → 1 個 cell（col=2 第一個勾選欄當位置錨點、answer = 正確被勾欄標題文字）；
// 保留 _checkTable 旗標讓 read 階段改用「讀勾選欄」語意（而非讀格內手寫值）。
// 範例列（e.g.）由 extract 階段排除、不進 rows，故此處 rows 即計分列。非破壞性：回傳新物件。
function normalizeTableCheckQuestion(question) {
  if (!question || typeof question !== 'object') return question
  if (ensureString(question.questionCategory, '').trim() !== 'table_check') return question
  const rows = Array.isArray(question.rows) ? question.rows : []
  if (rows.length === 0) return question
  const checkColumns = (Array.isArray(question.checkColumns) && question.checkColumns.length
    ? question.checkColumns : ['Yes', 'No'])
    .map((c) => ensureString(c, '').trim()).filter(Boolean)
  if (checkColumns.length === 0) return question
  const rowLabels = rows.map((r) => ensureString(r?.label, '').trim())
  const tableMeta = {
    rowHeaders: ['', ...rowLabels],
    colHeaders: ['', ...checkColumns],
    totalRows: rows.length + 1,
    totalCols: checkColumns.length + 1
  }
  const cells = rows.map((r, i) => ({
    row: i + 2,
    col: 2, // 第一個勾選欄當位置錨點；實際 answer 是被勾欄標題、非格內值
    label: ensureString(r?.label, '').trim(),
    answer: ensureString(r?.answer, '').trim()
  }))
  const maxScore = toFiniteNumber(question.maxScore) ?? rows.length
  return {
    ...question,
    questionCategory: 'table_cell',
    _checkTable: true,
    _checkColumns: checkColumns,
    tableMeta,
    cells,
    maxScore
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
    const tableNormalized = normalizeTableCheckQuestion(question)
    const normalized = normalizeShortAnswerQuestion(tableNormalized, domainHint)
    const isConverted =
      normalized !== tableNormalized &&
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
  // 2026-05-17: 縮 prefix — 拿掉冗長 hash 跟 [basic] 標籤、log 乾淨可掃
  const prefix = `[批改][${shortRunId(pipelineRunId)}]`
  if (payload === undefined) {
    console.log(`${prefix} ${message}`)
    return
  }
  console.log(`${prefix} ${message}`, payload)
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
      // table_cell 群組批改：保留每 cell 結構化讀值
      if (Array.isArray(item?.cellValues)) {
        entry.cellValues = item.cellValues
          .filter((c) => c && Number.isFinite(c.row) && Number.isFinite(c.col))
          .map((c) => ({
            row: Math.floor(Number(c.row)),
            col: Math.floor(Number(c.col)),
            student: ensureString(c.student, '')
          }))
      }
      // fill_blank 合題：保留每空結構化讀值
      if (Array.isArray(item?.partValues)) {
        entry.partValues = item.partValues
          .filter((p) => p && typeof p.subId === 'string' && p.subId.trim())
          .map((p) => ({
            subId: String(p.subId).trim(),
            student: ensureString(p.student, '')
          }))
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-05-26: 後處理層 type-aware padding
// AI 回 tight bbox（無 padding）、code 在 crop 前統一加 deterministic padding
// 原因：AI 加 padding 跨題不一致、累積 overlap、最末題易爆紙外（U5 cohort 驗證）
// 改 prompt 拔 AI padding 後、必要的安全邊距由本表加、可調可關
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_TYPE_PAD = { padX: 0.005, padY: 0.005 }
const TYPE_PAD = {
  // tight_answer 群組：緊框印刷標記、邊距小
  single_choice:  { padX: 0.005, padY: 0.005 },
  multi_choice:   { padX: 0.005, padY: 0.005 },
  true_false:     { padX: 0.005, padY: 0.005 },
  fill_variants:  { padX: 0.005, padY: 0.005 },
  // multi_fill 救援：左不對稱補多（社會期中考 29 份 cohort 驗證、9 個 outlier 救回）
  multi_fill:     { padLeft: 0.03, padRight: 0.01, padY: 0.005 },
  // fill_blank wide bbox：對稱小 padding（已包整題幹、不需太多）
  fill_blank:     { padX: 0.005, padY: 0.005 },
  // table_cell：上下含格線、稍多 y padding（拍照透視補償）
  table_cell:     { padX: 0.005, padY: 0.010 },
  // matching / answer_with_context：整列範圍
  matching:           { padX: 0.01, padY: 0.01 },
  circle_select_one:  { padX: 0.01, padY: 0.005 },
  circle_select_many: { padX: 0.01, padY: 0.005 },
  single_check:       { padX: 0.01, padY: 0.005 },
  multi_check:        { padX: 0.01, padY: 0.005 },
  mark_in_text:       { padX: 0.01, padY: 0.005 },
  // large_visual_area：題幹 + 工作區、學生筆跡可能延伸
  word_problem:       { padX: 0.01, padY: 0.01 },
  calculation:        { padX: 0.01, padY: 0.01 },
  short_answer:       { padX: 0.01, padY: 0.01 },
  ordering:           { padX: 0.01, padY: 0.01 },
  map_symbol:         { padX: 0.01, padY: 0.01 },
  grid_geometry:      { padX: 0.01, padY: 0.01 },
  connect_dots:       { padX: 0.01, padY: 0.01 },
  diagram_draw:       { padX: 0.01, padY: 0.01 },
  diagram_color:      { padX: 0.01, padY: 0.01 },
  // compound：兩段組合 + 學生筆跡
  compound_circle_with_explain:   { padX: 0.01, padY: 0.01 },
  compound_check_with_explain:    { padX: 0.01, padY: 0.01 },
  compound_writein_with_explain:  { padX: 0.01, padY: 0.01 },
  compound_judge_with_correction: { padX: 0.01, padY: 0.01 },
  compound_judge_with_explain:    { padX: 0.01, padY: 0.01 },
  multi_check_other:              { padX: 0.01, padY: 0.01 },
  compound_chain_table:           { padX: 0.01, padY: 0.01 },
  // map_fill：full image、不加 padding
  map_fill: { padX: 0, padY: 0 }
}

function inflateBboxForType(bbox, questionType) {
  if (!bbox) return bbox
  const pad = TYPE_PAD[questionType] || DEFAULT_TYPE_PAD
  // padX 可用對稱 (padX) 或不對稱 (padLeft / padRight)
  const padLeft = (typeof pad.padLeft === 'number') ? pad.padLeft : pad.padX
  const padRight = (typeof pad.padRight === 'number') ? pad.padRight : pad.padX
  // clip 到 [0, 1] 防爆圖
  const newX = Math.max(0, bbox.x - padLeft)
  const newRight = Math.min(1, bbox.x + bbox.w + padRight)
  const newY = Math.max(0, bbox.y - pad.padY)
  const newBottom = Math.min(1, bbox.y + bbox.h + pad.padY)
  return {
    x: newX,
    y: newY,
    w: newRight - newX,
    h: newBottom - newY
  }
}

export async function cropInlineImageByBbox(imageBase64, mimeType, bbox, useActualBbox = false, customPad = null) {
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

/**
 * OCR-assist 專用 split：每頁 top 向前借 `topOverlapRatio` 比例（預設 33%）。
 * 用途：解 group header 跨頁問題 — 「題組X」section header 可能落在前頁底、
 * questions 在後頁、後頁 OCR 看不到 header 導致 matcher 找不到 group。
 * 向前借一塊讓 header 跟 questions 一起出現在後頁 OCR 結果裡。
 *
 * 注意：output bbox y 是 overlap 圖的 local coord、不直接跟 classify bbox 對齊。
 *      matcher 只用 group key 配對、不用 y 跨 stage 比對、所以兩套 coord 不衝突。
 *      classify AI 仍走原本的 splitSubmissionImageByPageBreaks (no overlap)。
 */
async function splitWithTopOverlapForOcr(imageBase64, mimeType, pageBreaks, topOverlapRatio = 0.33) {
  if (!imageBase64 || !Array.isArray(pageBreaks) || pageBreaks.length === 0) return null
  try {
    const { default: sharp } = await import('sharp')
    const imageBuffer = Buffer.from(imageBase64, 'base64')
    const metadata = await sharp(imageBuffer).metadata()
    const { width, height } = metadata
    if (!width || !height) return null

    const boundaries = [0, ...pageBreaks, 1]
    const pageInfos = []
    const extractPromises = []
    for (let i = 0; i < boundaries.length - 1; i++) {
      const startY = boundaries[i]
      const endY = boundaries[i + 1]
      const pageRatio = endY - startY
      // 第一頁不向前借（沒前頁）、其他頁向前借 topOverlapRatio × 該頁高度
      const overlapRatio = i === 0 ? 0 : pageRatio * topOverlapRatio
      const topPx = Math.max(0, Math.round((startY - overlapRatio) * height))
      const bottomPx = Math.round(endY * height)
      const pagePxHeight = bottomPx - topPx
      if (pagePxHeight <= 0) continue
      // 該頁實際 top overlap 像素 / 該頁總高度 = overlap 比例（用於 OCR coord 後處理）
      const inputTopOverlapPx = Math.round(startY * height) - topPx
      pageInfos.push({ inputTopOverlapPx, inputPageHeight: pagePxHeight })
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
      // 後處理 OCR 結果用：input 圖前 N px 是借來的 overlap、OCR 內部 resize 後要等比例扣
      inputTopOverlapPx: pageInfos[i].inputTopOverlapPx,
      inputPageHeight: pageInfos[i].inputPageHeight
    }))
  } catch (err) {
    console.warn('[staged-grading] splitWithTopOverlapForOcr failed:', err?.message)
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
// multi_choice 故意不放進來：multi_choice 是「學生在格子裡寫字母代號（A,C）」，不是 checkbox
// 格式（□ A □ B □ C 學生勾框）。focused checkbox prompt 會要求輸出位置數字，套到
// multi_choice 上 AI 看到 "BC" 會輸出 "2,3"（B=2nd, C=3rd），錯。
// multi_choice 應該走主 read prompt 的 multiChoiceRules 輸出字母。
const CHECKBOX_FOCUSED_READ_TYPES = new Set(['single_check', 'multi_check', 'multi_check_other'])
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
  // 先剝除標點/括號/空白殘跡：「X.」「(○)」「✗。」「x、」→ X / ○ / ✗，
  // 避免單一符號因尾隨句點/括號等而比不出來（同 canonicalOptionIndex 的選項標點問題）。
  // 有效形式皆為單一符號或無內部標點的詞（對/是/yes…），全域剝除不影響它們。
  const s = String(raw ?? '').replace(/[.。．、,，:：;；()（）\s]/gu, '').trim()
  // 各種「正確」形式 → ○（含英文字母 O/o、〇、T/t）
  if (/^[○〇OoTt]$/.test(s) || /^(?:對|是|正確|ｏ|yes|Yes|true|True|TRUE)$/u.test(s)) return '○'
  // 各種「錯誤」形式 → ✗（含英文字母 X/x、×、F/f、叉）
  if (/^[✗✘×XxFf叉]$/.test(s) || /^(?:錯|否|不對|不是|no|No|false|False|FALSE)$/u.test(s)) return '✗'
  return null  // 無法正規化
}

export function normalizeAnswerForComparison(raw) {
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
  // 選項代號後的句點視為等價（學生筆跡常寫「A.」「B.」）：A.→A、A.B.C→ABC
  // 只去除「字母旁」的點（前面是字母、後面是字母或字串結尾）；
  // 數字旁的小數點不動（保護 3.14 / 0.5 / 257.04、No.5 這類答案）
  s = s.replace(/(?<=[A-Za-z])\.(?=[A-Za-z]|$)/gu, '')
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
      // 2026-06-20: 通用字元誤讀修正——圈起來的 a 常被讀成「@」(@＝a 加一圈)。'@' 在本領域從不是合法答案，
      //   一律還原成 'a'(各題型皆適用：圈選/單選/冠詞圈選 fill_blank「a, monkey」)。仍走雙讀一致性把關。
      let a = answer
      const rawSa = ensureString(a.studentAnswerRaw, '')
      if (rawSa.includes('@')) a = { ...a, studentAnswerRaw: rawSa.replace(/@/g, 'a') }
      const qType = typeByQuestionId.get(a.questionId)
      // 單選題 L→C 還原：某些學生的「C」字跡被 read 誤判成 L、而 single_choice 合法選項只到 a-e、L 必為誤讀。
      //   只改 read 值、不改判分；還原後仍走 read1/read2 雙讀一致性，另一讀真不同(如 b)仍走 arbiter/複核、不盲信。
      if (qType === 'single_choice') {
        const core = ensureString(a.studentAnswerRaw, '').replace(/[()（）\[\]【】.,，。、\s]/g, '')
        if (core === 'L') return { ...a, studentAnswerRaw: 'C' }
        if (core === 'l') return { ...a, studentAnswerRaw: 'c' }
        // 2026-06-21 值域驗證:single_choice 合法只有 A-E / 甲乙丙丁戊 / 1-5 / ①-⑤。
        //   非法值(座5 圈讀成「O」、座11 讀成整句選項長文)→ 送人工審查(unreadable)、不靜默吃下當 0 分。
        //   (O 不亂等價成某選項——不知圈哪個、硬猜不安全;一律送審讓老師定。)
        if (core && !/^[A-Ea-e1-5甲乙丙丁戊]$/u.test(core) && !/^[①②③④⑤]$/u.test(core)) {
          return { ...a, status: 'unreadable', studentAnswerRaw: '無法辨識' }
        }
        return a
      }
      // 2026-06-21 Bug D：是非題只該出現 ○/✗(及異體)。非法值(如座6 圈被讀成「Q」)目前靜默放行→被當作答冤判。
      //   合法→不動；圓形誤讀(Q/q/Ø/ø/◯/⊙ 一看就是圈)→等價成 ○(比照 L→C 高信心字形兜底、仍走雙讀把關)；
      //   其餘非法怪值→送人工審查(unreadable)、不靜默吃下。
      if (qType === 'true_false') {
        const core = ensureString(a.studentAnswerRaw, '').replace(/[()（）\[\]【】.,，。、\s]/g, '')
        const tf = normalizeTrueFalseAnswer(core)
        if (tf) return { ...a, studentAnswerRaw: tf }  // 合法(O/T/yes/對/X/F/no/錯…)→ 統一成 ○/✗、前端顯示一致
        if (/^[QqØø◯⊙]$/u.test(core)) return { ...a, studentAnswerRaw: '○' }  // 圓形誤讀(座6 Q)→ ○
        return { ...a, status: 'unreadable', studentAnswerRaw: '無法辨識' }  // 其餘非法 → 送審
      }
      if (!POSITION_SELECTION_TYPES.has(qType)) return a
      return { ...a, studentAnswerRaw: normalizeSelectionAnswerToDisplay(a.studentAnswerRaw, qType) }
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
// 抽出字串中的數值（含小數）轉 number 排序；用於判斷兩讀值的數字是否不同。
// 「27倍」→[27]、「7倍」→[7]、「約518.1cm³」→[518.1]、「5.0」→[5]（值相等視為相同）。
function extractNumericValues(s) {
  return (String(s ?? '').match(/\d+(?:\.\d+)?/g) || []).map(Number).sort((x, y) => x - y)
}
// 兩答案的數值內容是否不同（27倍≠7倍、96280≠6280；518.1=約518.1、5=5.0 視為相同）。
function numericValuesDiffer(a1, a2) {
  const n1 = extractNumericValues(a1)
  const n2 = extractNumericValues(a2)
  if (n1.length !== n2.length) return true
  for (let i = 0; i < n1.length; i++) if (n1[i] !== n2[i]) return true
  return false
}

// 2026-06-20: table_cell（含 table_check 正規化來的）勾選清單比對正規化。
//   read 常出現格式差異：列號前綴「1. bedroom:Yes」vs「bedroom:Yes」、e.g.範例列、Note 註解、順序——
//   值其實一致卻被判不一致進 NR。這裡只取「room→勾選值」集合、忽略上述雜訊。
const TABLE_CHECK_VALUE_MAP = {
  yes: 'y', y: 'y', '是': 'y', v: 'y', '✓': 'y', '○': 'y', '勾': 'y', true: 'y',
  no: 'n', n: 'n', '否': 'n', x: 'n', '✗': 'n', '×': 'n', '空': 'n', false: 'n'
}
function normalizeTableCellForComparison(raw) {
  const text = ensureString(raw, '').trim()
  if (!text || text === '未作答' || text === '無法辨識') return ''
  const norm = text.replace(/：/g, ':').replace(/，/g, ',')
  const map = new Map()
  for (let seg of norm.split(',')) {
    seg = seg.trim().replace(/^\(?\d+\)?[.．、)]*\s*/u, '')  // 去開頭列號 "1. " / "(1)" / "1."
    if (!seg) continue
    const ci = seg.lastIndexOf(':')
    if (ci < 0) continue  // 無冒號＝註解/雜訊（如「They need 4 bedroom」）→跳過
    const key = seg.slice(0, ci).replace(/\s+/g, '').toLowerCase()
    const val = TABLE_CHECK_VALUE_MAP[seg.slice(ci + 1).replace(/\s+/g, '').toLowerCase()]
    if (!val) continue                              // value 非勾選值（Note 之類）→跳過
    if (key.endsWith('note')) continue              // 「bedroom Note:…」→跳過
    if (/^(e\.?g\.?|範例|例)/u.test(key)) continue  // e.g.範例列→跳過
    if (!map.has(key)) map.set(key, val)
  }
  if (map.size === 0) return ''
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join(',')
}

// 2026-06-21 全系統一致性：AI3（LLM 一致性判官）預設停用、改用確定性 computeConsistencyStatus。
//   實證(沙盒 exp-ai3-vs-deterministic、142 卷/4129 題)：det 與 AI3 一致率 98.8%、描述型硬化後硬危險=0、
//   分歧只往「多送審」安全方向錯（永不靜默算錯）。送多了再用確定性 equivalence 規則逐案放行
//   （同 X/O、英語首字母大小寫等價的作法）。回退：設 env AI3_ARBITER_ENABLED=1 即恢復 AI3（免改碼）。
const AI3_ARBITER_ENABLED = process.env.AI3_ARBITER_ENABLED === '1'

export function computeConsistencyStatus(read1, read2, questionType = 'other') {
  const s1 = ensureString(read1?.status, '').toLowerCase()
  const s2 = ensureString(read2?.status, '').toLowerCase()
  // 兩者皆空白 → 一致（都沒作答）
  if (s1 === 'blank' && s2 === 'blank') return 'stable'
  if (s1 !== 'read' || s2 !== 'read') return 'unstable'

  // 2026-05-28 pivot: map_fill 改走 Phase A 3-AI per-position pattern、
  // consistency 在 questionResultsRaw 構造時 per-position 比對、不走這支通用函式。
  // 這函式對 map_fill 不會被呼叫（read1/read2 是 synthesized 結構、走 fast path）。


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

  // table_cell（含 table_check 正規化來的勾選清單）：忽略列號前綴/e.g.範例列/Note/順序，只比 room→勾選值集合
  if (questionType === 'table_cell') {
    const tc1 = normalizeTableCellForComparison(read1?.studentAnswerRaw)
    const tc2 = normalizeTableCellForComparison(read2?.studentAnswerRaw)
    if (tc1 && tc2) return tc1 === tc2 ? 'stable' : 'diff'
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
  // 2026-06-30：兩讀只差「邊緣標點(句末 . ! ? 逗號)或標點周圍空格」→ 視為一致、不送審。
  //   修實證冤枉 NR：「It is Class 512's idea.」vs「It is Class 512's idea」(差句點)、
  //   「No , he doesn't」vs「No, he doesn't」(逗號旁空格) — 兩讀其實同一句、不該送審。
  //   只去「標點周圍空格 + 字串結尾標點」；**內部小數點/數值不動**（"5.5" vs "55" 仍會被下方 numericValuesDiffer 擋）。
  //   標點本身該不該扣分，仍由 accessor 的 englishRules 處理、與此無關。
  const edgePunctNorm = (s) => s
    .replace(/\s*([,.!?，。！？])\s*/g, '$1')  // 去掉標點兩側空格（"a , b"→"a,b"、"x ."→"x."）
    .replace(/[,.!?，。！？]+$/, '')            // 去掉字串結尾的標點（"idea."→"idea"）
    .trim()
  if (edgePunctNorm(a1) === edgePunctNorm(a2)) return 'stable'
  // 2026-05-31: 兩讀值「數字（值）不同」一律 diff（送人工審查）。
  // 修真實 bug：「7倍」是「27倍」的子字串、「96280」與「6280」字元高度相似 → 被下方「包含關係 /
  // Jaccard 相似度」啟發式誤判為 stable、再由 getContainmentPreferredRaw 直接採用其中一個（截斷/多位）
  // 錯誤讀值、不送審（AI3 缺席時 fallback 用到這個 status → 學生被冤枉 0 分）。
  // 數字相同的措辭/單位/前綴差異（約518.1=518.1、5=5.0）才繼續走後面的相似度判定。
  if (numericValuesDiffer(a1, a2)) return 'diff'
  // 2026-06-21 Bug C：fill_blank（逐空格評分）normalize 後仍不相等（逗號/空白/格式已全扣除）
  //   = 某個空格的內容真的不同（如座15「a, polar bear」vs「, polar bear」少了 "a"）→ 一律 diff 送審。
  //   不套用下方「整串相似度 ≥0.75 / 包含關係」啟發式——那是給長描述題的，對 fill_blank 會把「少一個 token」
  //   誤判成 stable、又由 getContainmentPreferredRaw 挑到缺字的那一讀 → 學生被冤枉扣分、且不送審。
  //   （純格式差如「1,000」vs「1000」normalize 後相等、已在上面 a1===a2 放行，不受影響。）
  if (questionType === 'fill_blank') return 'diff'
  // 2026-06-21 全系統(無 AI3)：描述型自由文字（short_answer / compound_*）不走下方模糊相似度/包含關係
  //   「自動採用」啟發式——那會把「真的不同的文字」（如「用耳」vs「用牙」、多/少一詞）靜默判一致→自動採用→
  //   冤枉算錯（沙盒 R→A 危險全在此類）。改：exact-normalized 不等就 diff 送審；多送的再用確定性等價逐案放行。
  if (questionType === 'short_answer' || String(questionType).startsWith('compound_')) return 'diff'
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
    if (containmentDeltaLooksLikeAnswerSlot(longerA, shorterA)) return 'diff'
    return 'stable'
  }
  return 'diff'
}

// 多項答案題防誤判：若長答案比短答案多出的片段含「數字+面積/體積單位」結構
// （如「36cm²」「180公分」），代表多出來的是另一個答案 slot、不是 AI 多讀的雜訊。
// 例：AI1「540cm³」vs AI2「36cm², 540cm³」→ delta「36cm²」→ 是底面積這個 slot → diff
function containmentDeltaLooksLikeAnswerSlot(longerA, shorterA) {
  const idx = longerA.indexOf(shorterA)
  if (idx < 0) return false
  const delta = longerA.slice(0, idx) + longerA.slice(idx + shorterA.length)
  return /\d+\s*(?:cm[²³]|m[²³]|km[²³]|mm[²³]|平方公[分尺里釐]|立方公[分尺里釐]|公[分尺里釐])/u.test(delta)
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
  if (containmentDeltaLooksLikeAnswerSlot(longerA, shorterA)) return null
  // AI1 較短 → 預設用 AI1，無需覆寫
  if (a1IsShorter) return null
  // AI2 較短 → 回傳 AI2 原始答案
  return ensureString(read2?.studentAnswerRaw, '') || null
}

// 將老師確認的 finalAnswers 陣列轉換為 readAnswerResult 格式（供 Accessor 使用）
// 2026-05-20: 保留 source 欄位、Phase B 可區分 'manual'（老師人工編輯）→ 走 deterministic 跳過 Accessor LLM
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
          status,
          source: ensureString(a?.finalAnswerSource, '').trim() || null
        }
      })
    : []
  return { answers }
}

// 2026-05-20: 單位等價標準化（給 manual-edit deterministic match 用）
// 把 latin 單位轉成中文、讓 "144cm³" 跟 "144立方公分" 能 match
// 跟 Accessor prompt 的 UNIT EQUIVALENCE TABLE 對齊
const UNIT_CANONICAL_PAIRS = [
  ['立方公里', '立方公里'], ['立方公尺', '立方公尺'], ['立方公分', '立方公分'], ['立方公釐', '立方公釐'],
  ['平方公里', '平方公里'], ['平方公尺', '平方公尺'], ['平方公分', '平方公分'], ['平方公釐', '平方公釐'],
  ['km³', '立方公里'], ['m³', '立方公尺'], ['cm³', '立方公分'], ['mm³', '立方公釐'],
  ['km²', '平方公里'], ['m²', '平方公尺'], ['㎡', '平方公尺'], ['cm²', '平方公分'], ['mm²', '平方公釐'],
  ['km/h', '公里/小時'], ['m/s', '公尺/秒'], ['m/min', '公尺/分鐘'], ['km/min', '公里/分鐘'],
  ['km', '公里'], ['cm', '公分'], ['mm', '公釐'],
  ['kg', '公斤'], ['mg', '毫克'],
  ['mL', '毫升'], ['ml', '毫升'],
  ['hr', '小時'], ['sec', '秒'], ['min', '分鐘'],
  ['m', '公尺'], ['g', '公克'], ['L', '公升'], ['h', '小時'], ['s', '秒']
].sort((a, b) => b[0].length - a[0].length)  // 長的先 replace、避免 m 吃到 mm/km/cm

function canonicalizeUnits(s) {
  if (!s) return ''
  let r = String(s)
  for (const [from, to] of UNIT_CANONICAL_PAIRS) {
    if (from === to) continue
    r = r.split(from).join(to)
  }
  return r
}

// Deterministic match：老師人工編輯 final 跟 expected 比對、normalize + 單位等價
function manualEditDeterministicMatch(studentText, expectedText) {
  // 2026-06-02: 去掉「緊貼數字的約/大約/約為/≈」等近似詞，避免答案卷寫「約 257.04 立方公分」
  // 而學生（或老師手動改後）寫「257.04cm³」被誤判錯。限定「後面緊跟數字」才去除 →
  // 不誤傷「馬關條約」「凡爾賽條約」這種把『約』當字的社會科答案（約後面不是數字）。
  const stripApprox = (t) => t.replace(/(?:大約為|約為|大約|約|≈)(?=[0-9])/g, '')
  const a = stripApprox(canonicalizeUnits(normalizeAnswerForComparison(studentText || '')))
  const b = stripApprox(canonicalizeUnits(normalizeAnswerForComparison(expectedText || '')))
  if (!a || !b) return false
  if (a === b) return true
  // 移除所有空白後再比一次（學生可能寫 "144 立方公分" expected "144立方公分"）
  const aNoSpace = a.replace(/\s+/g, '')
  const bNoSpace = b.replace(/\s+/g, '')
  return aNoSpace === bNoSpace
}

// 2026-06-02 (stage2)：客觀題型確定性判分——重用既有正規化零件、與 accessor 規則對齊、跳過 AI。
// 回傳 { gradable, isCorrect, score, maxScore, errorType, scoringReason }；gradable=false → 交回 AI/複核。
// 僅覆蓋「純比對、AI 本來也只是做同樣比對」的型；multi-select(部分給分公式) / fill_blank(英文拼寫/dual-form) 等暫不收。
// 選項代號→統一序號（跨記號：A=甲=①=1、B=乙=②=2…）。非單一選項代號(文字/多字/數值)回 null。
function canonicalOptionIndex(raw) {
  let s = ensureString(raw, '').trim()
  const paren = s.match(/^[(（]\s*(.)\s*[)）]$/u)
  if (paren) s = paren[1]
  // 剝除選項代號常見的標點/分隔殘跡：「B.」→B、「A、」→A、「C，」→C、半殘括號「B)」→B、全形句點「Ａ．」
  // （學生常在選項代號後留下印刷的「.」「、」痕跡；不剝掉會讓長度!=1、整題退回 accessor 又誤判錯）
  s = s.replace(/[.。．、,，:：;；)）(（\s]/gu, '')
  if ([...s].length !== 1) return null
  if (/[A-Za-z]/.test(s)) return s.toUpperCase().charCodeAt(0) - 64  // A=1..Z=26
  const ci = '甲乙丙丁戊己庚辛壬癸'.indexOf(s); if (ci >= 0) return ci + 1
  const code = s.charCodeAt(0); if (code >= 0x2460 && code <= 0x2473) return code - 0x2460 + 1  // ①-⑳
  if (/^[0-9]$/.test(s)) return Number(s)
  return null
}

export function gradeObjectiveDeterministic(q, studentAnswerRaw, status) {
  const cat = q?.questionCategory
  const maxScore = Math.max(0, toFiniteNumber(q?.maxScore) ?? 0)
  const raw = ensureString(studentAnswerRaw, '').trim()
  const key = ensureString(q?.answer, '').trim()
  if (status === 'blank') return { gradable: true, isCorrect: false, score: 0, maxScore, errorType: 'blank', scoringReason: '學生未作答' }
  if (status === 'unreadable') return { gradable: false }
  if (!raw || !key) return { gradable: false }

  if (cat === 'true_false') {
    const sv = normalizeTrueFalseAnswer(raw)
    const kv = normalizeTrueFalseAnswer(key)
    if (!sv || !kv) return { gradable: false }
    const ok = sv === kv
    return { gradable: true, isCorrect: ok, score: ok ? maxScore : 0, maxScore, errorType: ok ? 'none' : 'concept', scoringReason: ok ? `學生判斷${sv}，答案正確` : `學生判斷${sv}，正確答案為${kv}，判斷錯誤` }
  }
  if (cat === 'single_choice') {
    // 用選項序號正規化跨記號比對（A–Z / 甲乙丙丁 / ①②③ / 單一數字 / (A) → 統一序號）。
    // 正解或學生答案無法化成單一選項代號（寫成選項文字/數值/多字）→ 交回 AI，避免誤判。
    const ks = canonicalOptionIndex(key)
    if (ks == null) return { gradable: false }
    const ss = canonicalOptionIndex(raw)
    if (ss == null) return { gradable: false }
    const ok = ss === ks
    return { gradable: true, isCorrect: ok, score: ok ? maxScore : 0, maxScore, errorType: ok ? 'none' : 'concept', scoringReason: ok ? `學生選${raw}，答案正確` : `學生選${raw}，正確答案為${key}，選項判斷錯誤` }
  }
  if (cat === 'fill_variants') {
    const accept = Array.isArray(q?.acceptableAnswers) ? q.acceptableAnswers : []
    const candidates = [key, ...accept].map((x) => ensureString(x, '').trim()).filter(Boolean)
    if (candidates.length === 0) return { gradable: false }
    const ok = candidates.some((c) => manualEditDeterministicMatch(raw, c))
    return { gradable: true, isCorrect: ok, score: ok ? maxScore : 0, maxScore, errorType: ok ? 'none' : 'concept', scoringReason: ok ? `學生寫「${raw}」，屬可接受答案` : `學生寫「${raw}」，正確答案為「${key}」，不在可接受答案範圍內` }
  }
  return { gradable: false }
}

// ── 句子克漏字（sentence cloze）確定性批改 ────────────────────────────────
// 情境：英語閱讀／聽力問答題，答句是「整句」（部分單字是印刷的、部分是學生填的計分關鍵詞）。
// 學生寫整句、印刷字一定對 → 跟標準答案逐詞做 LCS 對齊，未對上的「標準答案詞」= 學生填錯/漏的空。
// 分數 = maxScore − 錯詞數（clamp 0..maxScore）。詳見 local-only/eng_final_exam_2026-06-22/cloze-grader.test.mjs。
// 由 env CLOZE_DETERMINISTIC_ENABLED 控制（預設開、='false' 可關），只走 fill_blank 單一整句、不動 parts 合題（仍交 AI）。
function clozeNormToken(t) {
  return String(t || '').toLowerCase().replace(/[’]/g, "'").replace(/^[^a-z0-9'-]+|[^a-z0-9'-]+$/g, '')
}
function clozeTokenize(s) {
  return String(s || '').trim().split(/\s+/).map(clozeNormToken).filter(Boolean)
}
// 回傳「有對上的 model index 集合」（LCS backtrack）。
function clozeLcsMatchedModelIdx(model, stu) {
  const n = model.length, m = stu.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = model[i - 1] === stu[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const matched = new Set()
  let i = n, j = m
  while (i > 0 && j > 0) {
    if (model[i - 1] === stu[j - 1]) { matched.add(i - 1); i--; j-- }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--
    else j--
  }
  return matched
}
// 判斷一個 fill_blank 單一答案是不是「句子克漏字」（英文整句、≥3 詞、配分≥2）。
// 避免誤傷「值+單位」型（如 "5 公分"、中文短答）→ 那些仍走原本嚴格/AI 路徑。
function isSentenceClozeAnswer(answer, maxScore) {
  const toks = clozeTokenize(answer)
  if (toks.length < 3 || !(maxScore >= 2)) return false
  const asciiWords = toks.filter((t) => /^[a-z0-9'-]+$/.test(t)).length
  return asciiWords / toks.length >= 0.8
}
function gradeSentenceClozeDeterministic(q, studentAnswerRaw, status) {
  const maxScore = Math.max(0, toFiniteNumber(q?.maxScore) ?? 0)
  const key = ensureString(q?.answer, '').trim()
  if (status === 'unreadable') return { gradable: false }
  if (status === 'blank') return { gradable: true, isCorrect: false, score: 0, maxScore, errorType: 'blank', scoringReason: '學生未作答' }
  const raw = ensureString(studentAnswerRaw, '').trim()
  if (!raw || !key || maxScore <= 0) return { gradable: false }
  if (!isSentenceClozeAnswer(key, maxScore)) return { gradable: false }
  const model = clozeTokenize(key)
  const stu = clozeTokenize(raw)
  const matched = clozeLcsMatchedModelIdx(model, stu)
  const wrongTokens = model.filter((_, idx) => !matched.has(idx))
  const wrongCount = wrongTokens.length
  const score = Math.max(0, Math.min(maxScore, maxScore - wrongCount))
  return {
    gradable: true,
    isCorrect: wrongCount === 0,
    score,
    maxScore,
    errorType: wrongCount === 0 ? 'none' : 'concept',
    scoringReason: wrongCount === 0
      ? `整句正確（${maxScore} 個關鍵詞全對）`
      : `錯/漏 ${wrongCount} 個關鍵詞：${wrongTokens.join('、')}；正確答案「${key}」`,
  }
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
  'compound_chain_table',
  // 群組批改題型
  'table_cell'
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

  // large_visual_area (10)
  if (
    questionType === 'map_symbol' ||
    questionType === 'grid_geometry' ||
    questionType === 'connect_dots' ||
    questionType === 'diagram_draw' ||
    questionType === 'diagram_color' ||
    questionType === 'short_answer' ||
    questionType === 'ordering' ||
    questionType === 'calculation' ||
    questionType === 'word_problem' ||
    questionType === 'table_cell'  // 群組批改表格題：bbox 框整張表
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

// 純注音答案偵測（國字注音題「考注音」型正解）：至少 1 個注音符號(ㄅ–ㄩ)且整串只由
// 注音符號 + 聲調(ˊˇˋ˙) + 「一」(ㄧ 的異體寫法) + 空白組成。漢字答案/混合文字 → false。
function isZhuyinAnswer(raw) {
  const s = ensureString(raw, '').trim()
  if (!s) return false
  if (!/[ㄅ-ㄩ]/.test(s)) return false
  return /^[ㄅ-ㄩˇˉˊˋ˙一\s]+$/.test(s)
}

export function buildClassifyQuestionSpecs(questionIds, answerKeyQuestions, answerSheetMode = 'with_questions') {
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

  // siblingIds 不在 server 端計算 — 不靠 answer key bbox 推導學生卷同行關係。
  // classify AI 自己從學生卷視覺判斷哪些格在同行。

  const specs = questionIds.map((questionId) => {
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
    // expectedAnswer：給 classify「答案知識」用來輔助找位置（read 階段拿不到此資訊）
    // table_cell 不送（cells 陣列有自己的答案）
    if (expectedType !== 'table_cell') {
      const ans = ensureString(question?.answer ?? question?.referenceAnswer, '').trim()
      if (ans) spec.expectedAnswer = ans
    }
    // answerPos：fill_blank 作答位置（front=題號左側答案欄／inline=句中空格）→ classify 決定框左欄或句中。
    // 由 answer_key extract 階段標記、是版面固定屬性。
    if (expectedType === 'fill_blank' && (question?.answerPos === 'front' || question?.answerPos === 'inline')) {
      spec.answerPos = question.answerPos
    }
    // anchorHint 已完全停用：實證上 multi_fill 收到 anchorHint 後 bbox 中心會被 landmark
    // 文字拉走（同 row 兩個空格的 drift 差到 11x：multi_fill +0.044 vs fill_blank sub-q +0.004）。
    // 既然 single_choice / fill_blank sub-q 早就不送，multi_fill 也一併停掉。
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
    // table_cell 群組批改題型：傳 tableMeta + 整表 refBbox 給 classify AI
    if (expectedType === 'table_cell' && question?.tableMeta) {
      spec.tableMeta = {
        rowHeaders: Array.isArray(question.tableMeta.rowHeaders) ? question.tableMeta.rowHeaders : [],
        colHeaders: Array.isArray(question.tableMeta.colHeaders) ? question.tableMeta.colHeaders : [],
        totalRows: Number(question.tableMeta.totalRows) || 0,
        totalCols: Number(question.tableMeta.totalCols) || 0
      }
      if (Array.isArray(question.cells)) {
        spec.cellPositions = question.cells.map((c) => ({
          row: c.row, col: c.col, label: c.label || ''
        }))
      }
      // 整表 refBbox（從 answer key 來）— classify AI 找學生照片對應整表時的位置 hint
      const akBbox = question?.answerBbox
      if (akBbox && typeof akBbox.x === 'number' && typeof akBbox.y === 'number') {
        spec.tableRefBbox = {
          x: +akBbox.x.toFixed(3),
          y: +akBbox.y.toFixed(3),
          w: +(akBbox.w || akBbox.width || 0).toFixed(3),
          h: +(akBbox.h || akBbox.height || 0).toFixed(3)
        }
      }
    }
    // legacy fill_blank+tablePosition 已停用：表格題改走 table_cell type（整表 1 bbox + cellValues read）
    return spec
  })

  // 國字注音配對格偵測（只在 answer_only）：國字注音題版面是「印刷提示形式 + 手寫作答形式」兩格小單元。
  // 偵測——同 section（去掉最後一段 ID 的共同前綴）內只要有任一純注音正解 → 整 section 即國字注音題組
  // （考國字題正解是漢字、考注音題正解是注音，混在同 section、共用同一種兩格版面）。標記後 classify 改框整個 2 格單元。
  if (answerSheetMode === 'answer_only') {
    const zhuyinSections = new Set()
    for (const qId of questionIds) {
      const parts = qId.split('-')
      if (parts.length < 2) continue
      if (isZhuyinAnswer(byQuestionId.get(qId)?.answer)) zhuyinSections.add(parts.slice(0, -1).join('-'))
    }
    if (zhuyinSections.size > 0) {
      for (const spec of specs) {
        const parts = spec.questionId.split('-')
        if (parts.length < 2 || spec.questionType !== 'fill_blank') continue
        if (zhuyinSections.has(parts.slice(0, -1).join('-'))) spec.gzZhuyinPair = true
      }
    }
  }

  return specs
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
      framingReason: typeof row?.framingReason === 'string' ? row.framingReason.trim() : undefined
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

// 2026-05-28: 偵測 invisible question 是否屬「卷底題」(answer_key bbox y+h > 0.85)
// → 標記 likelyPhotoTruncation，UI 可顯示「學生拍照可能裁到、請學生重拍」
// 用於 Issue 2：某題在多數 submissions 都 invisible、答案卷顯示該題位於頁底
function isAnswerKeyBboxNearBottom(akBbox) {
  if (!akBbox) return false
  const yEnd = (Number(akBbox.y) || 0) + (Number(akBbox.h) || 0)
  return yEnd > 0.85
}

// 2026-05-28: fill_blank with parts(合題) 的 bbox 過小時、擴展 h 確保涵蓋所有 parts
// AI classify 給 fill_blank 的 bbox 有時太 tight、會 cut off 後續 parts
// 規則：每個 part 預期至少佔 0.025 normalized height (~ 1 行)
// 中心點不動、只擴展高度
function ensureFillBlankBboxFitsParts(bbox, partsCount) {
  if (!bbox || !partsCount || partsCount < 2) return bbox
  const minHForParts = 0.025 * partsCount
  const currentH = Number(bbox.h) || 0
  if (currentH >= minHForParts) return bbox
  const cy = (Number(bbox.y) || 0) + currentH / 2
  const newY = Math.max(0, cy - minHForParts / 2)
  const newH = Math.min(1 - newY, minHForParts)
  return { ...bbox, y: newY, h: newH }
}

// 2026-05-28: classify 後處理裝飾——加入 truncation warning + 補 parts bbox
// 1. 卷底 invisible → likelyPhotoTruncation=true
// 2. fill_blank with parts 且 bbox 過小 → 擴展 h 到 parts.length * 0.025
function decorateClassifyWithDiagnostics(classifyResult, akById) {
  if (!classifyResult?.alignedQuestions || !akById) return classifyResult
  let truncationCount = 0
  let bboxExpandedCount = 0
  for (const row of classifyResult.alignedQuestions) {
    const akQ = akById.get(row.questionId)
    if (!akQ) continue
    const akBbox = akQ?.answerBbox
    // Issue 2: 卷底題 + invisible → 標記 truncation
    if (!row.visible && isAnswerKeyBboxNearBottom(akBbox)) {
      row.likelyPhotoTruncation = true
      row.truncationReason = 'bottom_of_page'
      truncationCount += 1
    }
    // Issue 3: fill_blank parts 合題 bbox 不夠高 → 擴展
    if (row.visible && row.questionType === 'fill_blank' && row.answerBbox) {
      const partsCount = Array.isArray(akQ?.parts) ? akQ.parts.length : 0
      if (partsCount >= 2) {
        const original = row.answerBbox
        const expanded = ensureFillBlankBboxFitsParts(original, partsCount)
        if (expanded !== original && Math.abs((expanded.h || 0) - (original.h || 0)) > 1e-6) {
          row.answerBbox = expanded
          row.bboxExpandedForParts = {
            partsCount,
            originalH: Number(original.h.toFixed(4)),
            expandedH: Number(expanded.h.toFixed(4))
          }
          bboxExpandedCount += 1
        }
      }
    }
  }
  if (truncationCount > 0 || bboxExpandedCount > 0) {
    classifyResult.diagnostics = {
      ...(classifyResult.diagnostics || {}),
      bottomTruncationCount: truncationCount,
      fillBlankBboxExpandedCount: bboxExpandedCount
    }
  }
  return classifyResult
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

    if (bboxPolicy === 'full_page') {
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
        (questionType === 'circle_select_one' || questionType === 'circle_select_many') ? normalizeBboxRef(row?.bracketBbox) : undefined
    }
  })

  // legacy fill_blank+tablePosition 的 median 校正路徑已移除：表格題改走 table_cell type
  // （整表 1 bbox + cellValues read），不再需要逐格中位數校正、refBbox 推算。

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

export function normalizeReadAnswerResult(parsed, questionIds, mismatchIds = new Set()) {
  const answersRaw = Array.isArray(parsed?.answers) ? parsed.answers : []
  const byQuestionId = mapByQuestionId(answersRaw, (item) => item?.questionId)
  const answers = []

  for (const questionId of questionIds) {
    const row = byQuestionId.get(questionId)
    let studentAnswerRaw = ensureString(row?.studentAnswerRaw, '').trim()
    let status = ensureString(row?.status, '').trim().toLowerCase()

    // 2026-05-29: 合題（fill_blank parts）後備——AI 偶發正確回了 partValues
    // 但忘了照 prompt 把它們拼進 studentAnswerRaw（~10% 的 read run 整組合題一起漏）。
    // 結果存成空 → 一致性誤判「AI1 空 vs AI2 有」→ 假性 needs_review。
    // partValues 既然在，就 deterministic 拼回（不靠模型）。只在至少一空有內容時回填，
    // 全空維持原本 blank 判定。table_cell 的 cellValues 同理可比照（暫不動，未實證需要）。
    if (!studentAnswerRaw && Array.isArray(row?.partValues)) {
      const joined = row.partValues
        .map((p) => ensureString(p?.student, '').trim())
        .join(', ')
      if (joined.replace(/[,\s]/g, '')) studentAnswerRaw = joined.trim()
    }

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
  // 2026-06-22: 英語領域 → 啟用大小寫等價確定性覆寫(兜底 B)
  const isEnglishForCase = ensureString(domainHint, '').includes('英語')
    || answerKey?.englishRules?.punctuationCheck?.enabled || answerKey?.englishRules?.wordOrderCheck?.enabled

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

    // 2026-06-22: code 兜底——英語 fill_blank/short_answer「大小寫誤扣」逐空格救回(依答案卷專有名詞規則)。
    //   AI 對「只差可赦免大小寫/結尾標點」的 blank 扣分時，code 在此推翻、把那格的分加回(逐格、部分給分也保護)。
    //   只加分不減分；專有名詞(Indonesia)/全大寫(USA)仍由 AI 扣、不救。
    const caseRestoredSubIds = new Set()
    let caseRestoredWhole = false
    if (readStatus === 'read' && maxScore > 0 && isEnglishForCase
        && (question?.questionCategory === 'fill_blank' || question?.questionCategory === 'short_answer')) {
      const rawParts = Array.isArray(row?.partResults) ? row.partResults : null
      const keyParts = Array.isArray(question?.parts) ? question.parts : null
      if (rawParts && keyParts && keyParts.length > 0) {
        const ansBySub = new Map(keyParts.map((p) => [String(p?.subId ?? '').trim(), ensureString(p?.answer, '')]))
        const maxBySub = new Map(keyParts.map((p) => [String(p?.subId ?? '').trim(), Math.max(0, toFiniteNumber(p?.maxScore) ?? 0)]))
        let restored = 0
        for (const pr of rawParts) {
          const sub = String(pr?.subId ?? '').trim()
          if (!sub || pr?.correct === true) continue
          if (caseForgivableEqual(ensureString(pr?.student, ''), ansBySub.get(sub) ?? ensureString(pr?.expected, ''))) {
            caseRestoredSubIds.add(sub)
            restored += (maxBySub.get(sub) ?? 0)
          }
        }
        if (restored > 0) score = Math.min(maxScore, score + restored)
      } else if (!(typeof row?.isCorrect === 'boolean' ? row.isCorrect : score >= maxScore)) {
        // 單一答案(無 parts)：整體比對，只差赦免項 → 滿分
        const correct = ensureString(question?.answer || question?.referenceAnswer, '')
        if (correct && caseForgivableEqual(ensureString(answer?.studentAnswerRaw, ''), correct)) { score = maxScore; caseRestoredWhole = true }
      }
    }
    const caseRestored = caseRestoredSubIds.size > 0 || caseRestoredWhole

    // Hard override: blank/unreadable always score=0 regardless of model output
    if (readStatus === 'blank' || readStatus === 'unreadable') score = 0

    const isCorrect =
      (readStatus === 'blank' || readStatus === 'unreadable')
        ? false
        : caseRestored
          ? maxScore > 0 && score >= maxScore
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
    const errorType = isCorrect ? 'none' : (errorTypeRaw || inferredErrorType)
    const needExplain =
      typeof row?.needExplain === 'boolean'
        ? row.needExplain
        : !isCorrect || readStatus !== 'read'
    const scoreConfidence = clampInt(row?.scoreConfidence, 0, 100, readStatus === 'read' ? 70 : 0)

    // table_cell 群組批改：保留每 cell 對錯細節（accessor AI 對 cellValues vs cells 比對後輸出）
    const cellResults = Array.isArray(row?.cellResults)
      ? row.cellResults
          .filter((c) => c && Number.isFinite(c.row) && Number.isFinite(c.col))
          .map((c) => ({
            row: Math.floor(Number(c.row)),
            col: Math.floor(Number(c.col)),
            label: typeof c.label === 'string' ? c.label : undefined,
            student: ensureString(c.student, ''),
            expected: ensureString(c.expected, ''),
            correct: c.correct === true,
            reason: typeof c.reason === 'string' ? c.reason : undefined
          }))
      : undefined

    // fill_blank 合題：保留每空對錯細節（accessor AI 對 partValues vs parts 比對後輸出）
    const partResults = Array.isArray(row?.partResults)
      ? row.partResults
          .filter((p) => p && typeof p.subId === 'string' && p.subId.trim())
          .map((p) => {
            const sub = String(p.subId).trim()
            const restored = caseRestoredSubIds.has(sub)  // 大小寫救回 → 標記為對
            return {
              subId: sub,
              student: ensureString(p.student, ''),
              expected: ensureString(p.expected, ''),
              correct: p.correct === true || restored,
              reason: restored ? '大小寫等價（普通字首字母／結尾標點），視為正確' : (typeof p.reason === 'string' ? p.reason : undefined)
            }
          })
      : undefined

    // 2026-06-20: 多空格(合題)題 → 用結構化 partResults 組「逐空格清單」當 scoringReason、
    //   取代 AI 自由拼湊的版本（後者常亂編學生作答、重複同一格、張冠李戴）。
    //   每格各一行：對→「學生寫「X」，答案正確」；錯→優先用 AI 的逐格 reason（已含扣分類型）。
    let finalScoringReason = scoringReason
    if (Array.isArray(partResults) && partResults.length >= 2) {
      const lines = partResults.map((p) => {
        const head = `${p.subId}. `
        if (p.correct) return `${head}學生寫「${p.student}」，答案正確`
        const r = (p.reason || '').trim()
        if (r) return `${head}${r}`
        return `${head}學生寫「${p.student}」，正確為「${p.expected}」`
      })
      finalScoringReason = `學生作答內容如下：\n${lines.join('\n')}`
    }
    // 單一答案(無 parts)整體救回 → 用一致理由蓋掉 AI 矛盾的大小寫扣分說明(多空格題已由上方逐格 partResults 處理)
    if (caseRestoredWhole) finalScoringReason = '大小寫等價判定：學生作答與正解僅大小寫／結尾標點差異（專有名詞、全大寫縮寫除外），視為正確。'

    const normalizedBase = {
      questionId,
      score,
      maxScore,
      isCorrect,
      needExplain,
      matchType,
      scoringReason: finalScoringReason,
      feedbackBrief,
      studentFinalAnswer: studentFinalAnswer || undefined,
      errorType,
      scoreConfidence,
      matchingDetails:
        row?.matchingDetails && typeof row.matchingDetails === 'object'
          ? row.matchingDetails
          : undefined,
      rubricScores: Array.isArray(row?.rubricScores) ? row.rubricScores : undefined,
      cellResults,
      partResults
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

// Classify type rules v4.2 (2026-05-26): bbox 緊貼實際邊界、不加 padding
// AI 回 tight bbox（無 ±0.005 / ±0.01 padding）、所有邊距由後處理層 inflateBboxForType 統一加
// 拔 padding 原因：AI 加 padding 跨題不一致、累積 overlap 把最末題擠出紙外（U5 cohort 多案例驗證）
const CLASSIFY_TYPE_RULES = {
  fill_blank: `▸ fill_blank（填空題、單一規則、不分視覺變體）

  🚨 **本區塊規則只適用於 questionType === 'fill_blank'**。
  其他題型（single_choice / multi_choice / true_false / fill_variants / multi_fill 等）一律以 tight_answer 規則為準。

  🆕 **fill_blank 不論視覺長相、bbox 一律包整段題幹 + 全部空格標記**：
  - 括號型「( )」
  - 底線型「___」
  - 方框型「□」
  - 表格格子型
  ⭐ 上述視覺變體**通通用同一條 wide bbox 公式**、不分 sub-case。

  答題區視覺定位（學生會在這裡寫答案）:
    · 印刷括號 / 底線 / 方框 / 格子內含學生手寫答案
    · 同一題可能有 1 個空格（單空）或 N 個空格（合題、parts）
    · 即使學生未填、bbox 仍依「該題印刷題幹範圍」決定

  wide bbox 公式（all fill_blank 共用、緊貼實際邊界、不加 padding）:
    bbox.x      = 該題題號（如「1.」「2.」「(1)」）印刷左緣
    bbox.x + w  = 該題最末字（含單位、句末標點）印刷右緣
    bbox.y      = 題幹第一行頂部
    bbox.y + h  = 題幹最後一行底部
  ⚠️ 不要自己加 ±0.005 padding、後處理層會統一加。AI 跨題加 padding 不一致、會累積 overlap。

  尺寸常識:
    · bbox.w 通常 ~0.4 頁寬（單欄佈局）；雙欄佈局單題寬 ~0.42
    · bbox.h 看題幹行數：1 行題 ≈ 0.025~0.04；2-3 行題 ≈ 0.06~0.10；4+ 行 ≈ 0.10~0.16
    · 學生筆跡大小**完全不影響** bbox（bbox 由印刷題幹範圍決定）

  範例 A（單空、單行）:
    題目：「電扶梯的速率是 0.6 公尺／秒，阿玟行走的速率是 0.5 公尺／秒…5 秒後他移動了( 6.5 )公尺」
    → bbox 包整段題目，從題號「1.」到「公尺」(含答案括弧 + 單位)
    → bbox.w ≈ 0.4、bbox.h ≈ 0.04

  範例 B（合題、多行）:
    題目：「(1) 兩人同時同方向前進，( 2 )分鐘後相距 20 公尺。(2) 兩人同時相向前進，( 12 )分鐘後相遇。」
    → bbox 包整段（兩個子句都包），y 從題號到最末「相遇。」
    → bbox.w ≈ 0.4、bbox.h ≈ 0.08

  範例 C（底線型同行多空）:
    題目：「Mom is _____ in the _____ today.」
    → bbox 包整段、含兩條底線 + "is" / "in the" / "today" 連續文字
    → bbox.w ≈ 0.4、bbox.h ≈ 0.04

  範例 D（方框型算式）:
    題目：「2½ □ (4.73 □ 2.73)」
    → bbox 包整個算式行、含兩個 □ 與括號
    → bbox.w ≈ 0.4、bbox.h ≈ 0.04

  🚨 嚴禁:
    · 只框 tiny ( ) 或單一空格 → 那是舊規則
    · 為避開「元 / 公分」單位字而縮小 bbox → 單位字現在要包進來
    · 把同一題的多個空格拆成多個 bbox → 同一題只有一個 wide bbox 包整段
    · 把本規則推廣到 single_choice / multi_choice / true_false / multi_fill / fill_variants
      → 這些題型仍維持 tight_answer 規則的緊框公式、不受本區塊影響`,

  tight_answer: `▸ tight_answer (single_choice / multi_choice / true_false / fill_variants / multi_fill)
  答題區視覺形式（學生會在這裡寫答案）:
    · 印刷括號「( )」/「（ ）」— 學生在括號內寫代號（A/B/C/甲乙/○✗/數字）
    · 印刷底線「___」/「_____」— 學生在底線上寫字
    · 印刷方框「□」/「☐」— 學生在方框內填值
    · 表格 cell（multi_fill 在表格內各 cell 填值）
    · 🆕 **印刷冒號「：」/「:」後接空白**（注釋題、解釋詞語、簡答常見）—
        無底線、無方框、僅冒號當分隔，學生在冒號右側到行末之間寫字。
        ⚠️ 此格式**沒有印刷邊界**，bbox 必須由「實際手寫墨跡」決定範圍。
        ⚠️ 此格式各題 h 必然不同（學生筆跡有大有小、可能跨行），不可全題複製同一個 h。

  ⚠️ 多答案 case (multi_choice / multi_fill 常見):
    · 印刷只是 1 條短底線「___」或 1 對括號「( )」，
      但學生在上面/裡面寫**多個代號**（如「A,B」「A、C」「2,4」「甲乙」）
    · 學生筆跡常**橫向延伸超出印刷標記**

  bbox 公式（緊貼印刷標記 + 學生筆跡、不加 padding）:
    bbox.x      = min(印刷標記左端, 學生筆跡最左端)
    bbox.x + w  = max(印刷標記右端, 學生筆跡最右端)
    bbox.y      = 該行頂部
    bbox.y + h  = 該行底部
  ⚠️ 多答案在底線/括號時，學生筆跡可能比印刷標記寬 2-3 倍 — bbox 必須完整涵蓋
  ⚠️ 不要自己加 ±0.005 / ±3-5% padding、後處理層會統一加

  🆕 「冒號後接空白」格式專用 bbox 公式（無印刷錨點，必須**逐題**看實際墨跡）:
    bbox.x      = 冒號右緣
    bbox.x + w  = 學生筆跡最右端
    bbox.y      = 學生實際手寫筆劃的**最高點**（可能在印刷字 baseline 之上的撇捺）
    bbox.y + h  = 學生實際手寫筆劃的**最低點**（含 descenders、跨行延伸）
    ⚠️ 此格式 h 通常 0.04-0.06，**不要被印刷字高度（~0.02）誤導**
    ⚠️ 此格式空格沒寫的題目，bbox.x/w 仍依冒號位置給；y/h 取該行的合理估計（不複製鄰題的 y/h）

  🚨 single_choice 結構性陷阱（最常見的框錯模式、必看）:
    題卷常見排版：
        1.( 4 ) 太陽是一個本身能發出光和熱的星球，所以太陽是下列哪一種星體？
                (1)行星 (2)彗星 (3)衛星 (4)恆星。
        2.(   ) 下列哪一個...
                (1)在酸化的土壤上灑上石灰粉 (2)煮...
    **答案 cell** = 行首「1.( )」「2.( )」（緊接題號後、括號內僅 1 個數字或空白）
    **選項標籤** = 行中「(1)行星」「(2)彗星」（括號後跟 ≥2 字選項文字）
    🚨 兩者**長得很像**、classify 注意力容易被選項吸走、必須嚴格區分：
      ✅ 答案 cell 判定條件（全部成立）:
         (a) **行首位置**（x 通常 < 0.10、緊接題號 "N." 之後）
         (b) **括號內只有 1 個數字 / 1 個字母 / 完全空白**
         (c) **括號後緊接題幹文字**（不是另一個 (N)）
      ❌ 選項標籤判定條件（其一成立即排除）:
         (a) x > 0.15（不在行首、離開題號區）
         (b) 括號後緊接非數字的選項文字（中文/英文）
         (c) 同一行有 2+ 個 (N) 形式 — 那是「(1)A (2)B (3)C (4)D」整列、不是答案
    💡 對位驗證：選 bbox 前**先找題號 "N." 印刷字**、bbox 必須緊接其右；
       若你選的位置 x > 0.15 且括號後跟文字 → 99% 框錯到選項列、重抓行首

  🚨 其他嚴禁:
    · 框題幹文字（題目敘述）— 答題區一定在題幹「之後」
    · 框題號標記「1.」「(1)」「①」本身 — 那是題目編號不是答案
    · 框學生畫記的選項列表 — 即使學生在 (A)(B)(C)(D) 選項上做記號，
      那也不是答案 cell。答案 cell 是題號後的「(   )」括號或「___」底線
    · 多答案 case 框只到印刷底線右端就停 — 會切掉延伸的後半個答案
    · 「冒號後接空白」格式各題 h/Δy 完全相同 — 那是 lazy mode 外推，重做`,

  table_cell: `▸ table_cell
  答題區視覺形式: 整張表格（多列 × 多欄、清晰格線）

  bbox 公式（緊貼格線、不加 padding；依 spec.tableMeta 動態解讀、N=totalRows、M=totalCols）:
    bbox.x      = 表格最左外緣格線
    bbox.x + w  = 表格最右外緣格線
    bbox.y      = row 1（最上列）外緣格線   ← 包含表頭
    bbox.y + h  = row N（最下列）外緣格線
  bbox.h ≥ N × 0.025

  🚨🚨🚨 完整覆蓋鐵則:
    · bbox **必須**包含全部 N 列：上自 row 1「rowHeaders[0]」、下至 row N「rowHeaders[N-1]」
    · bbox **必須**包含全部 M 欄：左自 col 1、右至 col M
    · 學生答案通常在 row N「rowHeaders[N-1]」、**最容易被切到** — 特別確認其底邊完全在 bbox 內
  ⚠️ 不要自己加 padding（含拍照透視預留）、後處理層會統一加

  SELF-CHECK（output 前必過）:
    ① bbox 內可數出 N 個完整橫向列?
    ② row 1「rowHeaders[0]」的頂邊在 bbox 內?
    ③ row N「rowHeaders[N-1]」的底邊在 bbox 內?（**最常出錯**）
    ④ 最左欄與最右欄是否都在 bbox 內?
    任一 N → 重新框

  用 spec.tableMeta.rowHeaders/colHeaders 找表頭定位；tableRefBbox 為 layout hint
  🚨 嚴禁: 框單一 cell；輸出 1 question = 1 整表 bbox`,

  matching: `▸ matching
  答題區視覺形式: 連連看（左欄項目 + 右欄選項 + 學生連線）
  bbox 公式（緊貼項目邊界、不加 padding）:
    bbox.x      = 左欄最左項目
    bbox.x + w  = 右欄最右選項
    bbox.y      = 第 1 個項目上邊
    bbox.y + h  = 最後 1 個項目下邊
  同 bboxGroupId 共用一 bbox；echo bboxGroupId from spec
  🚨 嚴禁: 只框單一連線；不可漏掉左欄或右欄
  ⚠️ 不要自己加 ±0.01 padding、後處理層會統一加`,

  answer_with_context: `▸ circle_select_one / circle_select_many / single_check / multi_check / mark_in_text
  答題區視覺形式:
    · circle_select_*: 整列預印選項括號「(同意／不同意)」+ 學生圈選
    · single/multi_check: 整列方框 □ + 對應選項文字 + 學生勾選
    · mark_in_text: 整段印刷文章 + 學生圈詞/標記
  bbox 公式（緊貼選項邊界、不加 padding）:
    bbox.x      = 第 1 個選項/方框/文章左邊
    bbox.x + w  = 最後選項/方框/文章右邊
    bbox.y      = 該列頂部
    bbox.y + h  = 該列底部（含學生筆跡延伸）
  · circle_select_*: 額外輸出 bracketBbox（緊框「(option1／option2…)」）
  🚨 嚴禁: 只框被選中的選項；read 階段需看全列才能判斷學生選了哪個
  ⚠️ 不要自己加 padding、後處理層會統一加`,

  large_visual_area: `▸ calculation / word_problem / short_answer / ordering / map_symbol / grid_geometry / connect_dots / diagram_draw / diagram_color
  答題區視覺形式: 題幹 + 大空白工作區（學生寫算式 / 段落 / 序號 / 圖案）
  bbox 公式（緊貼題幹+工作區+學生筆跡、不加 padding）:
    bbox.x      = 題幹/工作區最左印刷邊
    bbox.x + w  = max(題幹/工作區最右印刷邊, 學生筆跡最右)
    bbox.y      = 題幹上邊
    bbox.y + h  = max(工作區下邊, 最後學生筆跡)
  short_answer 多行: bbox.h 必須涵蓋整個寫字區塊
  🚨 嚴禁: 只框第 1 行；漏掉題幹；漏掉學生補寫的部分
  ⚠️ 不要自己加 padding、後處理層會統一加`,

  compound: `▸ compound_circle/check/writein_with_explain / compound_judge_with_correction/explain / multi_check_other / compound_chain_table
  答題區視覺形式: 兩部分組合 — 答案區（圈選/打勾/代號）+ 說明區（文字理由/改正）
  bbox 公式（緊貼兩段範圍 + 學生筆跡、不加 padding）:
    bbox.x      = min(答案區左邊, 說明區左邊)
    bbox.x + w  = max(答案區右邊, 說明區右邊, 學生筆跡最右)
    bbox.y      = 答案區上邊
    bbox.y + h  = 說明/改正區下邊（含學生筆跡延伸）
  🚨 嚴禁: 只框其中一部分；必須兩部分都涵蓋
  ⚠️ 不要自己加 padding、後處理層會統一加`,

  map_fill: `▸ map_fill
  答題區視覺形式: 整張圖（地圖填圖題答案散布全圖）
  bbox 公式: bbox = {x:0, y:0, w:1, h:1}`,
}

function buildClassifyTypeRulesSection(specs) {
  const typesUsed = new Set((specs || []).map((s) => s?.questionType).filter(Boolean))
  const blocks = []

  // fill_blank 獨立規則：不論視覺變體（括號/底線/方框/格子）一律 wide bbox 包整題幹
  if (typesUsed.has('fill_blank')) {
    blocks.push(CLASSIFY_TYPE_RULES.fill_blank)
  }
  // tight_answer 群組 (5 type 共用 tight 規則，不含 fill_blank)
  const tightTypes = ['single_choice', 'multi_choice', 'true_false', 'fill_variants', 'multi_fill']
  if (tightTypes.some((t) => typesUsed.has(t))) {
    blocks.push(CLASSIFY_TYPE_RULES.tight_answer)
  }
  if (typesUsed.has('table_cell')) {
    blocks.push(CLASSIFY_TYPE_RULES.table_cell)
  }
  if (typesUsed.has('matching')) {
    blocks.push(CLASSIFY_TYPE_RULES.matching)
  }
  const ctxTypes = ['circle_select_one', 'circle_select_many', 'single_check', 'multi_check', 'mark_in_text']
  if (ctxTypes.some((t) => typesUsed.has(t))) {
    blocks.push(CLASSIFY_TYPE_RULES.answer_with_context)
  }
  const largeTypes = ['calculation', 'word_problem', 'short_answer', 'ordering', 'map_symbol', 'grid_geometry', 'connect_dots', 'diagram_draw', 'diagram_color']
  if (largeTypes.some((t) => typesUsed.has(t))) {
    blocks.push(CLASSIFY_TYPE_RULES.large_visual_area)
  }
  const compoundTypes = ['compound_circle_with_explain', 'compound_check_with_explain', 'compound_writein_with_explain', 'compound_judge_with_correction', 'compound_judge_with_explain', 'multi_check_other', 'compound_chain_table']
  if (compoundTypes.some((t) => typesUsed.has(t))) {
    blocks.push(CLASSIFY_TYPE_RULES.compound)
  }
  if (typesUsed.has('map_fill')) {
    blocks.push(CLASSIFY_TYPE_RULES.map_fill)
  }

  return blocks.join('\n\n')
}

export function buildClassifyPrompt(questionIds, questionSpecs, pageBreaks = [], answerKeyPageCount = 0, classifyCorrections = [], answerSheetMode = 'with_questions') {
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

  const isAnswerOnly = answerSheetMode === 'answer_only'

  // ── ANSWER-ONLY 精簡 prompt：跳過 25-type 規則，只用 box 格式 ──
  if (isAnswerOnly) {
    const hasGzPair = Array.isArray(questionSpecs) && questionSpecs.some((s) => s?.gzZhuyinPair)
    const gzZhuyinSection = hasGzPair ? `
═══════════════ 國字注音配對格（特例，覆蓋上面的「單一 □」規則） ═══════════════

specs 中標記 "gzZhuyinPair": true 的題目是【國字注音題】。它的版面是【兩個緊鄰的小格合為一題】：
  · 一格是**印刷的提示形式**（字較大）——考注音題印的是國字、考國字題印的是注音。
  · 另一格是**學生手寫作答格**（字較小、常偏窄）。
  · 兩格通常上下或左右緊貼、合起來才是完整一題。

🚨 bbox 必須**同時框住這兩格**（涵蓋印刷提示格 + 手寫作答格的整個外框），當成「一個 box」：
  · ❌ 嚴禁只框其中一格——只框那個窄窄的手寫格會漏掉印刷提示字、且窄格沒有視覺錨點、最容易定位漂移。
  · ✅ 先用**印刷的大字**當錨點定位（它最顯眼），再把緊貼它的手寫作答格一起包進來。
  · ❌ 只框「同一題」自己的那一對兩格；不要往左右延伸框到**相鄰其他題**的格子。
  · expectedAnswer 已提供（注音或國字），可輔助你確認哪一對屬於本題。
` : ''

    const correctionsSection = Array.isArray(classifyCorrections) && classifyCorrections.length > 0
      ? `\n⚠️ BBOX POSITIONING REMINDER:\n前一輪 Read 結果偵測到下列題目可能有 bbox 定位問題，請特別注意：\n${classifyCorrections.map((c) => {
          if (c.type === 'neighbor_match') {
            return `- 題目 ${c.questionId}：此題學生答案恰好等於相鄰題目 ${c.neighborId} 的正解，bbox 可能飄移到鄰題格。請仔細區分這兩格的邊界。`
          }
          if (c.type === 'consecutive_blank') {
            return `- 題目 ${c.questionId}：此題與其他題目連續被讀為 blank/unreadable。請確認 answerBbox 確實對齊到該格（不是漂移到鄰格或 header）。若 bbox 正確且學生確實留空，blank 是合理結論。`
          }
          return ''
        }).filter(Boolean).join('\n')}\n`
      : ''

    return `
You are stage CLASSIFY (ANSWER-ONLY MODE).
Task: identify which question numbers are visible on this answer card and locate each visible question's answerBbox.

The card contains ONLY question numbers and answer cells (boxes) arranged in section tables — there is NO question stem text printed on this sheet.
Do NOT infer question type. Question type is fixed by specs.${pageBoundarySection}

═══════════════ 核心心智模型 ═══════════════

不論題目實際的 questionType 是什麼（single_choice / multi_choice / fill_blank / short_answer），
**bbox 規則一律照 fill_blank 的「box（方框型）」格式處理**。

▸ box 方框型 bbox 規則（🚨 嚴格遵守）
  - **bbox 邊界由「印刷的 □ 格子邊框」唯一決定**
  - 不論該格學生有沒有寫、寫得多大、寫得多小、寫得多偏，**bbox 永遠是該格 □ 的位置 + 邊距**
  - **嚴禁** 把 bbox 縮成只框手寫字本身 — 手寫筆跡大小**完全不影響** bbox 尺寸
  - 邊距：bbox 比 □ 各邊外推 3-5% 頁寬（避免切到 □ 邊框或筆跡尾巴）
  - 空格題的 bbox 跟有寫的題 bbox **應該完全一樣大小** — 因為兩者都是同一個 □
  - short_answer 多行作答無 □（純橫線/格線）：bbox 框「印刷的作答區範圍」（橫線涵蓋的矩形）、不框手寫

範例 1（單格、有寫）：
  □ 邊界 x=0.40~0.48, y=0.20~0.28、學生在中間寫一個小字「A」
  → bbox.x = 0.36, bbox.y = 0.18, bbox.w = 0.16, bbox.h = 0.12
  （框 □、不是框那個小「A」字）

範例 2（單格、空白）：
  □ 邊界 x=0.40~0.48, y=0.20~0.28、學生沒寫
  → bbox.x = 0.36, bbox.y = 0.18, bbox.w = 0.16, bbox.h = 0.12
  （跟範例 1 完全一樣 — 因為都是同一個 □）
${gzZhuyinSection}
═══════════════ 共通規則 ═══════════════

- visible=true 即使該格學生沒寫（空格）— 仍依格子位置定 bbox
- visible=false 只在該題完全不在這張圖上時（被裁掉、不存在）
- 印刷的題號 header（表格第一列「1, 2, 3, ...」）必須在 bbox **之外**
- 鄰格的內容必須在 bbox **之外**
- 同一 section 同 row 的 bbox 高度應該一致

═══════════════ 空白格防漂移（重要） ═══════════════

目標格內是否有學生手寫**完全不影響** bbox 位置。嚴禁因為目標格空白就把 bbox 漂移到相鄰有內容的格子——空格也是有效作答（學生選擇不寫），bbox 仍然是該格的視覺位置。

═══════════════ Sub-cell 子格寬度推算（極重要） ═══════════════

當題目 ID 有 3 個或更多 segment 且共享前綴，那是 sub-cell（父欄被切成的子格）：

**識別**：
- "3-1-1", "3-1-2", "3-1-3" → 共享 "3-1" → 它們是父欄 3-1 的 3 個子格
- "3-2", "3-3", "3-4" → 2-segment → 是 3-1 的同層 sibling 主欄
- 父欄 "3-1" 的視覺寬度 = "3-2"、"3-3" 等同層 sibling 的視覺寬度

**bbox 寬度計算**：
- 子格寬度 = 父欄寬度 / N（N = 子格數，看卷子數出來）
- 範例：section 3 有 6 個 header 主欄（1, 2, 3, 4, 5, 6），每欄寬 0.15。header「1」下方分 3 個子格 → 每子格寬 = 0.15 / 3 = 0.05

**子格切分方向（看卷子視覺）**：
- 橫切（左→右排列）：3-1-1 左、3-1-2 中、3-1-3 右；y 相同、寬度 = 父欄寬/N
- 直切（上→下排列）：3-1-1 上、3-1-2 中、3-1-3 下；x 相同、寬度 = 父欄寬度

**🚨 嚴禁**：把 sub-cells 當成「跟主欄同寬」的獨立格子。
這會把 3 個 0.15 寬的格子塞進 1 個主欄位置，擠壓後面 3-2、3-3 等的 bbox 集體右移，
所有題目讀到錯位內容。

═══════════════ ❌ 嚴禁錯誤 ═══════════════

- bbox 高度 < 0.02 → 你切到格線本身了，重新框
- bbox 含到題號 header row → 切錯題
- bbox 跨進鄰格 → 切到別人的答案
- 用「一般選擇題 25-35% 頁寬」這種規則 → 完全不對
- 因為某格空白就把 bbox 偏到鄰格找筆跡 → 嚴禁
- sub-cells 用主欄寬度 → 整列右移，read 全錯
- **bbox 縮成只框手寫字、寬高跟同 row 其他格不一致** → 違反「box 由 □ 邊框決定」鐵則、重新框 □ 整格

═══════════════ 輸入資料 ═══════════════

Allowed question IDs:
${JSON.stringify(questionIds)}

Question Specs (source of truth from AnswerKey — 你只需要看 questionType 與 questionId):
${JSON.stringify(specs)}
${correctionsSection}
═══════════════ 輸出格式 ═══════════════

Return strict JSON only:
{
  "alignedQuestions": [
    {
      "questionId": "1-2",
      "visible": true,
      "answerBbox": { "x": 0.1, "y": 0.2, "w": 0.08, "h": 0.05 }
    }
  ]
}

Required:
- questionId: 必須是 Allowed IDs 之一
- visible: true / false
- answerBbox: visible=true 時必填；visible=false 時 omit

Do NOT output:
- questionType: 由 spec 決定，不要自己 classify
- questionBbox: 已不使用，answerBbox 即可
- 任何 single_choice / multi_choice / parens / underline 等 per-type 細分規則的計算（本模式統一用 box）
`.trim()
  }

  // ── 一般模式 v3.5：印刷特徵唯一 anchor + per-type 動態注入 ──
  // 答案卷圖片不再傳給 classify — 完全獨立於老師的答案卷找 bbox
  const typeRulesSection = buildClassifyTypeRulesSection(specs)
  const correctionsSection = Array.isArray(classifyCorrections) && classifyCorrections.length > 0
    ? `\n\n═══════════════ BBOX POSITIONING REMINDER ═══════════════\n前一輪 Read 偵測到下列題目可能有 bbox 定位問題：\n${classifyCorrections.map((c) => {
        if (c.type === 'neighbor_match') {
          return `- 題目 ${c.questionId}：學生答案恰好等於相鄰題目 ${c.neighborId} 的正解，bbox 可能飄移到鄰題格。請仔細區分邊界。`
        }
        if (c.type === 'consecutive_blank') {
          return `- 題目 ${c.questionId}：與其他題連續被讀為 blank。確認 bbox 對齊到該題答案區。若 bbox 正確且學生確實留空，blank 是合理結論。`
        }
        return ''
      }).filter(Boolean).join('\n')}`
    : ''

  return `
You are stage CLASSIFY.

🚨🚨🚨 ═══════════ TOP-PRIORITY 鐵則（讀完整個 prompt 之前先看這條，違反整輪輸出無效）═══════════ 🚨🚨🚨

**禁止機械式等距 / 等高（AI lazy mode 鐵則）**

實拍紙張一定有透視、邊緣彎曲、拍攝角度差。**即使版面看起來規整**，
行間距 normalized 後**不可能完全相等**、各題 h 也**不可能完全相同**。

❌ 禁止行為（你最容易犯的 lazy mode）：
   1. 量好第一題的 y，剩下 N-1 題用「y₁ + (i-1) × Δy」等差級數外推
   2. 量好第一題的 h，剩下全題複製貼上同一個 h
   3. 看 ID 結構（如 1-1-1 ~ 1-1-17）就假設它們是均勻分布的子格 — 這是 ID 編號，不是版面結構
   4. 看版面長得「整齊」就略過逐題量測

✅ 你必須做的：
   - 對每一題**獨立看圖、獨立測量**該題的真實墨跡上下緣與左右緣
   - 各題 h 應有差異（學生筆跡有大有小、有單行有跨行）
   - 各題 Δy 應有差異（紙張有透視，bottom 行間距通常 ≠ top 行間距）
   - x 也應因題而異（學生筆跡左右起點不一）

🔍 完成所有題目後自我檢查：
   - 若全部題目的 Δy 變異 < 5% → **你在做等差級數外推**，重做
   - 若全部題目的 h 完全相同 → **你在 lazy 複製**，重做
   - 若全部題目的 x 完全相同（不是同一欄表格的情況）→ **你在 lazy 複製**，重做

🚨🚨🚨 ═══════════════════════════════════════════════════════════════════ 🚨🚨🚨

Task: 對每個 question，**先讀懂題目，再用「答案知識」找答案區**，框成 bbox。

═══════════════ INPUT ═══════════════

Allowed question IDs:
${JSON.stringify(questionIds)}

Question Specs (source of truth from AnswerKey):
${JSON.stringify(specs)}
${pageBoundarySection}

═══════════════ INPUT 你會拿到的 4 樣東西 ═══════════════

  1. 學生作業原圖（image）
  2. spec.questionId — 知道這是第幾題（ID 結構：Section-Chapter-Question-SubQ）
  3. spec.questionType — 知道題目類型，對應下方 TYPE RULE
  4. spec.expectedAnswer — 知道答案應該長什麼形式（單字母 / 短答 / 圈選 / ...）

═══════════════ 硬性原則（不可違反） ═══════════════

⭐ **必須**結合 4 樣 input 找答題區，不可只靠視覺猜。
⭐ **必須**先看 type → 知道答題區形式（TYPE RULE 描述）→ 再找視覺位置。
⭐ bbox 邊界依「TYPE RULE 的 bbox 公式」算，**禁止自由發揮**。
⭐ expectedAnswer 是**確認你找對位置**，**禁止**用它走捷徑找視覺特徵。
⭐ bbox 對應「印刷答題區」位置，**與學生筆跡無關**：
   · 學生答對 / 答錯 / 留空 → bbox 都該框印刷答題區
⭐ answer key 已驗證每題都存在 — visible=false 僅當頁面被裁掉時用。
⭐ **嚴禁機械式等距 / 等高** — 詳見 prompt 開頭 TOP-PRIORITY 鐵則。

═══════════════ CORE ALGORITHM (5 steps，必須照順序執行) ═══════════════

對每個 questionId，**依 1→2→3→4→5 順序**執行（禁止跳步）：

【Step 1 — 看 questionType → 知道答題區「視覺形式」】
  · 從 spec.questionType 對應下方 TYPE RULE
  · TYPE RULE 告訴你答題區是括號 / 底線 / 方框 / 表格 / 整列選項 / ...
  · 例：questionType=single_choice → 答題區是「印刷括號 (   )」

【Step 2 — 看 expectedAnswer → 知道答案應該長什麼】
  · 例：expectedAnswer="D" → 答案是 1 個字母代號
  · 例：expectedAnswer="A,B" → 答案是 2 個字母代號
  · 例：expectedAnswer="欄牧，地狹人稠" → 答案是中文短句
  · 用此資訊**確認你之後找的位置內含正確答案的格式**（不是用 expectedAnswer 找視覺特徵）

【Step 3 — 看 questionId → 在圖上對映到第幾題】
  · ID "X-Y-Z-N" → 找對應印刷題號 anchor（「X.」「(Y)」「Z.」「①②③」）
  · 確認題目位置（哪一頁、哪一段）
  · 🚨 依「印刷題號」對映，不是「由上往下第幾列」：第 N 個 questionId 對應卷面印刷題號 N（「1.」「2.」…）。沒有正式題號的列（標題列 header、範例列）一律不佔題號、要跳過。
  · 🚨 範例列（範例題）絕不可當成第 1 題：編號清單／表格中，若某列標「e.g.／例／範例／Example／Sample／無需評分」、或該列沒有正式題號而其下才從「1」開始 → 這列是「示範用範例」、不是題目，bbox 不要框它、不要佔用題號。
    · 自我檢查：清單／表格第一個框是否誤蓋到「e.g.／範例」列？若是 → 整體往下移一列、補回最後一個編號列。
    · 例：House for Rent 清單第一列是「e.g. living room」（範例）→ questionId 第 1 題的框要對到「1. bedroom」那一列，不是「e.g. living room」。

【Step 4 — 在圖上找答題區】
  · 結合 Step 1（形式）+ Step 3（位置）找答題區的視覺位置
  · 用 Step 2（expectedAnswer）確認你找對 cell（位置內應有可寫答案的空間）
  · ⚠️ 嚴禁走捷徑：
    · 看到圖上有「答案 pattern」就直接框 → ❌ 錯
    · 看到學生在選項上畫記就框那個選項 → ❌ 錯（答案是「題號後括號」不是「畫記的選項」）
    · 必須先過 Step 1-3，視覺定位後再用 Step 2 確認

【Step 5 — 套 TYPE RULE 算 bbox + 輸出 framingReason】
  · bbox.xywh 完全依 TYPE RULE 的「bbox 公式」算
  · 禁止: 自己估計寬度（如「25-35% 頁寬」這種數字）
  · framingReason 格式（**3 個元素缺一不可**）:
    "questionId={...} 對應 [位置描述]; "
    "type={...} 對應 [視覺形式]; "
    "expectedAnswer={...} 確認 [內容描述]"
  · 範例:
    "questionId=1-3-1-1 第 1 大題第 3 小題第 1 子題（題幹『1.第一級產業是』後）; "
    "type=single_choice 對應印刷括號 (   ); "
    "expectedAnswer=D 確認框內含學生 D 筆跡。"

═══════════════ TYPE RULES (本批 spec 用到的，描述 bbox 框多大) ═══════════════

${typeRulesSection || '（本批無需動態 type rule）'}
${(() => {
  const frontIds = specs.filter((s) => s?.answerPos === 'front').map((s) => s.questionId)
  if (frontIds.length === 0) return ''
  return `
═══════════════ 🚨 左側答案欄題（FRONT-COLUMN ANSWER，覆蓋該題 type rule）═══════════════
下列 questionId 的答案**寫在題號左側、獨立的答案欄**（每列題號前有一條橫線/空格，學生在那寫整個答案），**不是**寫在右邊句子裡的空格：
${JSON.stringify(frontIds)}
→ 這些題的 answerBbox **只框該列最左側的答案欄**（題號左邊那一格手寫處），緊貼答案欄、**絕不要**把右邊的句子題幹框進來。
→ 同一大題的 front 題**共用同一條左側答案欄的 x 左右緣**；各題只差 y（列）。先量最上面那題的左右緣，其餘沿用、只調 y。
→ 自我檢查：若某題 bbox 右緣伸進句子（w 明顯比其他左欄題寬）→ 你框到句子了，縮回左欄。
`
})()}

═══════════════ SELF-CHECK (output 前必過) ═══════════════

對每個 bbox 嚴格驗證:
  ① bbox 邊界**對齊到 TYPE RULE 描述的視覺形式**（括號/底線/方框/...）？
     ❌ 框到題幹文字、學生畫記的選項列表、題號 — 重做
  ② bbox 公式是否照 TYPE RULE 算（不是自己估計寬度）？
  ③ 不同 questionId 的 bbox 是否重疊？（若重疊 → 重抓邊界）
  ④ bbox 高度 < 0.025？→ **你大概 anchor 在印刷字 baseline 上、沒看到實際手寫筆跡範圍**。
     重新看該題位置，找到完整墨跡上下緣（含 ascenders/descenders、跨行延伸的部分）再量 h。
     ❌ 禁止設定固定下限值（如 0.018、0.025）頂著 — 那會讓所有題目坍縮到同一個 h。
  ⑤ framingReason 是否包含 3 個必填元素：
     · questionId 對應的「位置」描述
     · questionType 對應的「視覺形式」描述
     · expectedAnswer 對應的「內容確認」描述
     缺任一 → 重寫
  ⑥ framingReason 是否誠實反映你框的位置（不是事後合理化）？

任一項失敗 → 重新執行 Step 1-5。

═══════════════ OUTPUT FORMAT ═══════════════

Return strict JSON only:
{
  "alignedQuestions": [
    {
      "questionId": "...",
      "visible": true,
      "answerBbox": { "x": 0.x, "y": 0.x, "w": 0.x, "h": 0.x },
      "framingReason": "..."
    }
  ]
}

Required:
- questionId: 必須在 Allowed IDs 之中
- visible: true / false
- answerBbox: visible=true 必填（top-left x/y + w/h，normalized [0,1]）
- framingReason: visible=true 必填，**必須包含 3 元素**:
  · questionId 對應的位置描述
  · questionType 對應的視覺形式描述
  · expectedAnswer 對應的內容確認描述
  範例: "questionId=1-3-1-1 第 1 大題第 1 子題; type=single_choice 對應括號 (   ); expectedAnswer=D 確認框內含學生 D 筆跡"

Conditional:
- bracketBbox: 僅 circle_select_one / circle_select_many 輸出（緊框「(option1／option2…)」括號列）
- bboxGroupId: 僅 matching 輸出（從 spec echo）

Do NOT output: questionType, questionBbox, 答案文字

When visible=false: 省略所有 bbox 欄位${correctionsSection}
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

// ── 密集勾選清單「整段讀」（2026-06-24）─────────────────────────────────────
// 逐列 tight crop 在密集清單（列距≈框高，如 B1）會吃到上下鄰列 → read1 盲讀讀錯列。
// 改成：把同 type＋同欄＋連續＋密集的列群成一個 list、整段裁 1 張圖、1 次讀、逐列回報、map 回各 qid。
// 沙盒實證(local-only/exp-read1-eng-2026-06-24)：B1 整段盲讀 2.5/3.5-flash 皆 14/14、100%、穩定。
// env DENSE_SECTION_READ_ENABLED 控制（預設關）。
// 群組條件：同 questionType + x 重疊(同欄) + y 連續 + 列距 ≤ max(框高)×1.2(margin) + 該串 ≥3 列。
function groupDenseCheckboxLists(candidates) {
  const byType = new Map()
  for (const q of candidates) {
    if (!q?.answerBbox) continue
    if (!byType.has(q.questionType)) byType.set(q.questionType, [])
    byType.get(q.questionType).push(q)
  }
  const groups = []
  for (const [, qs] of byType) {
    const sorted = qs.slice().sort((a, b) => a.answerBbox.y - b.answerBbox.y)
    let cur = []
    const flush = () => { if (cur.length >= 3) groups.push(cur); cur = [] }
    for (const q of sorted) {
      if (cur.length === 0) { cur = [q]; continue }
      const pb = cur[cur.length - 1].answerBbox, qb = q.answerBbox
      const xOverlap = (Math.min(pb.x + pb.w, qb.x + qb.w) - Math.max(pb.x, qb.x)) > 0
      const pitch = Math.abs((qb.y + qb.h / 2) - (pb.y + pb.h / 2))
      const dense = pitch <= Math.max(pb.h, qb.h) * 1.2
      if (xOverlap && dense) cur.push(q)
      else { flush(); cur = [q] }
    }
    flush()
  }
  return groups
}

// 取 questionId 末段數字當「列印刷編號」（如 1-B1-13 → 13）；沒有就用位置序。
function sectionRowNumber(qid, fallbackIdx) {
  const m = String(qid).match(/(\d+)\s*$/)
  return m ? m[1] : String(fallbackIdx + 1)
}

// group: sorted-by-y 的同類列；items: [{ qid, num, answer? }]
function buildSectionCheckboxReadPrompt(items, questionType, withAnswers) {
  const isSingle = questionType === 'single_check'
  const numList = items.map((it) => it.num).join(', ')
  const jsonShape = items.map((it) => `"${it.num}": <box>`).join(', ')
  return `這是一張答案卷某大題「整段勾選清單」的裁切圖（共 ${items.length} 列）。
每一列：左邊有印刷編號，中間可能有文字，右邊有一排方框選項（□1 □2 □3…）。學生在某一格打了記號（✓/✗/塗黑/塗黑）。
本清單由上而下的列印刷編號為：${numList}。

任務：對**每一個編號的列**，判斷學生的記號打在第幾個方框（1-based、由左到右數）。
- ${withAnswers ? '下方附每列正確答案僅供對位參考；你仍只回報「你實際看到學生打記號」的那一格、不要直接抄正解。' : '你不知道正確答案，只讀學生實際打的記號、不要猜。'}
- **用左邊的印刷編號逐列對齊**，不要把上一列或下一列的記號讀到這一列。
- ${isSingle ? '每列只勾一格 → 回報一個數字。' : '每列可勾多格 → 回報逗號分隔（如 1,3）。'}某列完全沒勾 → 該列填 0。
${withAnswers ? '（參考）每列正解：' + items.map((it) => `${it.num}=${ensureString(it.answer, '')}`).join('、') + '\n' : ''}
回傳嚴格 JSON：{ "rows": { ${jsonShape} } }`
}

// ── ordering 排序題「focused read」（2026-06-24）─────────────────────────────
// 主 read（2.5-flash）對「圖片角落小手寫序號」常讀不出 → 未作答；3.5-flash 穩定。
// 且 extract 與 read 必須用同一條掃描順序才對得齊（gemini.ts ordering spec 已加同句）。
// 改：ordering 走專屬 focused read（MODEL_PRO + 明確掃描順序）、覆寫 read1(盲)+read2(知答)。
function buildOrderingReadPrompt(questionId, correctAnswer, withAnswers) {
  return `這是一張答案卷「排序題（如 Listen and Number）」的裁切圖：一組項目（圖片／詞／句）排成單列或多列網格，每項旁或內有印刷括號 ( )／格，學生在裡面手寫一個序號數字表示順序。

🚨 掃描／輸出順序（固定）：**由上而下、每一列由左而右**掃描每個項目（多列網格：先掃完上面一列、再下一列）。
- 對每個項目，讀它格內**學生手寫的數字**（不是印刷的圖案／編號）。
- 依掃描順序，把各項目的數字用「,」串起來。
- 某項目格內沒寫數字 → 該位置寫 "?"。全部都沒寫 → status="blank"。
- 只讀實際手寫的數字、不要推測、不要自己排序。
${withAnswers ? `（參考）此題正解序列為「${ensureString(correctAnswer, '')}」，僅供你對位用；仍只回報你實際看到學生手寫的數字、不要直接抄正解。` : '你不知道正確答案、不要猜。'}

回傳嚴格 JSON：{ "answers": [ { "questionId": "${questionId}", "studentAnswerRaw": "1,5,6,...", "status": "read|blank" } ] }`
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

國字注音 DUAL-FORM 讀法（2026-06-02，只在「作答盒內同時有國字與注音」時適用）：
- 國字注音題的作答盒裡常**同時有一個國字和一個注音**：其中一個是印刷題幹、另一個是學生手寫（考國字→手寫國字大、印刷注音小；考注音→印刷國字大、手寫注音小、易看漏）。你**不需要分辨哪個是手寫**。
- 請把你看到的**國字與注音兩者都寫進 studentAnswerRaw**，**固定格式「國字 注音」（國字在前、注音在後、中間一個半形空格）**，例「紮 ㄓㄚˊ」。兩讀者用同一格式才能一致。
- ⚠️ 注音務必**逐一注音符號讀實際筆跡**；【嚴禁】從盒內印刷國字去推算它的讀音——破音字會害你挑錯（例：印刷是「紮」不可自動寫成 ㄗㄚ，要看手寫注音筆跡是什麼就寫什麼）。
- 若盒內只有一種形式（只有國字或只有注音）→ 照常只寫該形式、不要硬湊。
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
  const tableCellIds = idsOf('table_cell')

  // table_cell 群組批改：建 questionId → tableMeta + cells map（給 read prompt 列每 cell 期望讀的位置）
  const tableCellMetaMap = new Map()
  for (const q of visibleQuestions) {
    if (q.questionType !== 'table_cell') continue
    const akQ = (Array.isArray(options?.answerKeyQuestions) ? options.answerKeyQuestions : [])
      .find((aq) => aq?.id === q.questionId)
    if (akQ?.tableMeta && Array.isArray(akQ?.cells)) {
      tableCellMetaMap.set(q.questionId, {
        tableMeta: akQ.tableMeta,
        cells: akQ.cells,
        checkTable: akQ._checkTable === true,
        checkColumns: Array.isArray(akQ._checkColumns) ? akQ._checkColumns : null
      })
    }
  }

  // fill_blank 合題：建 questionId → parts map（給 read prompt 列每空 subId）
  const fillBlankPartsMap = new Map()
  for (const q of visibleQuestions) {
    if (q.questionType !== 'fill_blank') continue
    const akQ = (Array.isArray(options?.answerKeyQuestions) ? options.answerKeyQuestions : [])
      .find((aq) => aq?.id === q.questionId)
    if (Array.isArray(akQ?.parts) && akQ.parts.length > 0) {
      fillBlankPartsMap.set(q.questionId, { parts: akQ.parts })
    }
  }
  const fillBlankPartsIds = Array.from(fillBlankPartsMap.keys())

  // 2026-06-24: 整句問答題（英語、無 parts、答案是整句）→ read 改「完整抄整句」、不逐空格抓碎片。
  //   實證 local-only/exp-read1-eng-2026-06-24：read1 從碎片(He,can,by,plane)→忠實整句、可逐詞批改。
  //   數學/短空格/parts 不在此列、維持原逐空格規則（保 scratch-ignore + partValues）。
  const _akqById = new Map(
    (Array.isArray(options?.answerKeyQuestions) ? options.answerKeyQuestions : []).map((q) => [q?.id, q])
  )
  const fillBlankSentenceIds = isEnglish
    ? fillBlankIds.filter((id) => !fillBlankPartsMap.has(id)
        && isSentenceClozeAnswer(_akqById.get(id)?.answer, toFiniteNumber(_akqById.get(id)?.maxScore) ?? 0))
    : []

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

  // Table cell column hints 已移除：tablePosition / anchorHint 已停用（新的 table_cell type 整表批改取代逐格定位）

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

  // 2026-06-24: 整句問答題（fillBlankSentenceIds）→ read 改「完整抄整句」；其餘 fill_blank 維持逐空格。
  const fillBlankRules = fillBlankIds.length === 0 ? '' : `${fillBlankSentenceIds.length > 0 ? `
🚨 整句問答題（以下題號）— 「寫一整句英文回答」的閱讀／聽力問答題：${fillBlankSentenceIds.map((id) => `"${id}"`).join(', ')}
  - 對這些題：**逐字、完整抄寫學生手寫的整句答案**（所有單字、依書寫順序），保留原始拼寫／大小寫／標點、不修正錯字。
  - ❌ 不要逐空格抓字、不要輸出逗號分隔字詞清單、不要只抓底線詞。整句空白 → status="blank"。
  - ⚠️ 其餘未列在上面的 fill_blank（短空格／數學／合題 parts）才走下方規則。
  - ⛔【最高優先、凌駕下方所有 FILL-BLANK 規則】上列題號**完全不適用**下方「Output ... comma-separated」規則。
  - ✅ studentAnswerRaw 必須是「**一個完整連續字串**」：從作答線最左掃到最右，含**印刷字與手寫字**、依視覺書寫順序**逐字抄**，詞與詞間用單一半形空格。
  - ❌ 嚴禁輸出逗號分隔的字詞清單（例：禁止 "is, idea" / "are, three, one"）、嚴禁只抓片段、嚴禁中途停。即使只認得部分字，也要把整條作答線**從頭到尾掃完**再輸出。
` : ''}
FILL-BLANK (questions in FILL-BLANK list):
- Output ONLY handwritten content inside each blank, comma-separated left-to-right top-to-bottom.
- Empty blank → "_". Unreadable blank → "?". All blanks empty → status="blank".
- FORBIDDEN: surrounding printed text ("答", underline markers).${mathFillBlankRuleBlock}
- 🚨 MULTIPLE BLANKS IN CROP (裁切圖包含多個括號):
  If the cropped image shows content from MULTIPLE blanks or lines (e.g., you see two different ( ) with different answers), identify which blank is closest to the CENTER of the crop image — that is your target blank.
  - Content near the EDGES (top, bottom, left, right) of the crop that belongs to a DIFFERENT blank — do NOT read it.
  - Once you identify the target blank, read ALL handwriting inside it COMPLETELY — including faint, small, or offset characters. Do NOT skip any visible strokes within the target blank.${englishSpellingRuleBlock}
${fillBlankPartsIds.length > 0 ? `
- 🆕 FILL-BLANK 合題（題目含 parts 陣列，多空一題）：
  These questions have MULTIPLE blanks (parts) in ONE question stem. The crop bbox covers the ENTIRE question stem + all blanks.
  - For each part (subId a, b, c, ...) listed in SPEC below, read what the student wrote in that blank.
  - Output partValues array: [{ subId: "a", student: "..." }, { subId: "b", student: "..." }, ...]
  - subId order matches left-to-right top-to-bottom in the question stem.
  - Empty blank → student = "". Unreadable → student = "?".
  - studentAnswerRaw = partValues 拼接，用「, 」分隔（依 subId 順序）。例如：partValues=[{a:"2"},{b:"12"}] → studentAnswerRaw = "2, 12"
  - 所有 parts 都空白 → status="blank"，partValues 仍要回（每 part student=""）。
  - 至少 1 part 有手寫 → status="read"。
  - 禁止：把不同 part 的內容混讀；依括號位置嚴格對位 subId。

SPEC for fill_blank questions with parts:
${fillBlankPartsIds.map((qid) => {
  const meta = fillBlankPartsMap.get(qid)
  if (!meta) return `- questionId="${qid}": (no parts meta, skip partValues)`
  const partsDesc = meta.parts.map((p) => `(${p.subId})`).join(' ')
  return `- questionId="${qid}": ${meta.parts.length} 空, subIds: ${partsDesc}`
}).join('\n')}
` : ''}
`

  const calculationRules = calculationIds.length > 0 ? `
CALCULATION (questions in CALCULATION list):
- 🚨 OUTPUT FINAL ANSWER ONLY (2026-05-20 update):
  Calculation questions have:
  1. FIRST LINE (printed): formula "...=( )" — student writes FINAL ANSWER in parentheses.
  2. BELOW: handwritten scratch work (calculation process).
  Accessor stage will evaluate the calculation process visually from the crop image.
  Your job is ONLY to extract the student's FINAL ANSWER as a single value.

- READING PRIORITY:
  - FIRST: Read what the student wrote INSIDE the parentheses "( )" on the first line.
  - FALLBACK (only if parentheses empty): take the LAST "=N" or "答:N" line from the calculation process as the final answer.
  - The parentheses answer is ALWAYS the student's intended final answer, even if the process below shows a different result.

- OUTPUT FORMAT:
  - studentAnswerRaw = JUST the final value (with unit if printed/written, e.g. "15", "15公分", "15cm").
  - Do NOT include calculation steps, equation signs, "=" prefix, or process lines.
  - Single token output: a number, a number+unit, a fraction, a decimal.
  - Example: parentheses contain "150" → output "150"
  - Example: parentheses empty, last line "=24" → output "24"
  - Example: written "答: 25公分" → output "25公分"

- BOUNDARY RULE:
  - If you see ANOTHER printed "=( )" pattern below, that's the NEXT question — content inside next question's parentheses belongs to the next question.

- COPYING RULE:
  - Copy the student's written digits EXACTLY. Do NOT recalculate or correct.
  - Wrong arithmetic in process → that's Accessor's job to judge, not yours.
  - Wrong final answer (e.g. student wrote 145 instead of 144) → output "145".

- STATUS:
  - Parentheses empty AND no calculation process → status="blank", studentAnswerRaw="未作答"
  - Process exists but no extractable final → use LAST "=N" line. If unidentifiable → status="unreadable".

- STRIP printed labels (e.g. "東北亞：", "A：") from the answer.
- SELF-CORRECTION: if student crossed out a final value and wrote new, use the NEW one.
` : ''

  // word_problem rules: if (domain, word_problem) has a specialization, use it (replaces generic).
  // 2026-05-20: 改成只輸出 final answer、Accessor 看 crop 評列式
  const wordProblemRules = (() => {
    if (wordProblemIds.length === 0) return ''
    const override = TYPE_DOMAIN_OVERRIDES.word_problem?.[domainHint]
    if (override) return `\n${override}\n`
    return `
WORD-PROBLEM (questions in WORD-PROBLEM list):
- 🚨 OUTPUT FINAL ANSWER ONLY (2026-05-22 update):
  Word problems have calculation work + final answer sentence (e.g. "答: 小明走了120公尺", "答: 36 平方公分，540 立方公分", "A: 144cm³").
  Accessor stage will evaluate the calculation process visually from the crop image.
  Your job is to extract the COMPLETE final answer — which may be ONE value OR MULTIPLE values for problems asking multiple quantities.

- 🚨 MULTI-PART FINAL ANSWERS (critical):
  Some problems ask for MULTIPLE final values (e.g. 求面積與體積、求長與寬).
  The student's 答 line will contain ALL parts, typically separated by comma/space/換行.
  YOU MUST OUTPUT ALL PARTS — never truncate to a single token.
  - Example: 答 line shows "36 平方公分，540 立方公分" → output "36 平方公分，540 立方公分" (BOTH parts).
  - Example: 答 line shows "180cm²、720cm³" → output "180cm²、720cm³" (BOTH parts).
  - Example: 答 line shows just "144cm³" → output "144cm³" (single part is also fine).
  - Counting hint: if the question stem says "求...與...", "求...及...", or "求...，...", expect TWO parts.

- HOW TO FIND THE FINAL ANSWER:
  - FIRST: look for "答:", "答 :", "A:", "Ans:" prefix — read EVERYTHING on that line/after it until visual end of answer.
  - 🚨 Multi-part answers may span ONE line (with separators) or TWO LINES — both count.
  - FALLBACK: if no answer-sentence prefix, take the LAST "=N" or last-line numeric result (single part).
  - Multiple candidates (student wrote then crossed out): use the FINAL non-crossed version.

- OUTPUT FORMAT:
  - studentAnswerRaw = the COMPLETE final answer with units (e.g. "120公尺", "144cm³", "36cm²，540cm³", "3公尺、4公分").
  - Do NOT include "答:" / "A:" prefix in output (extract the values only).
  - Do NOT include calculation steps, equations, or process lines.
  - Multi-part: keep the student's actual separator (、, ，, space, newline → space).

- COPYING RULE:
  - Copy the student's written value EXACTLY. Do NOT recalculate or correct.
  - Wrong final answer (e.g. student wrote 145 instead of 144) → output "145".

- STATUS:
  - No 答:/A: AND no calculation result → status="blank", studentAnswerRaw="未作答"
  - Has work but no extractable final value → status="unreadable"
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

  // ── tableCell：表格題（群組批改） ──
  // crop 是整張表，AI 一次讀整表回多 cell 結構化值
  const tableCellRules = tableCellIds.length > 0 ? `
TABLE-CELL (table_cell 題)：crop 是「整張表格」（含 header 列/欄 + 答案 cells）。1 個 questionId 對應 1 張整表 crop。
- 對每個 questionId，依下方 SPEC 找到該題對應的 tableMeta（rowHeaders / colHeaders / totalRows / totalCols）+ 要讀的 cells 清單。
- 用印刷的列標題（rowHeaders）+ 欄標題（colHeaders）當錨點，視覺定位每個 cell 在 crop 的位置（cell.row × cell.col）。

🚨 CHECK-TABLE（勾選表）特例：若該 questionId 的 SPEC 標記「【勾選表 CHECK-TABLE】」：
- 這是「每列在多個勾選欄(如 Yes/No)中打一個 ✓」的矩陣表。crop 是整張勾選表。
- 對每一列，判斷學生的 ✓ 打在哪一個勾選欄，cellValues 的 student 填**被打勾那一欄的欄標題文字**（如 "Yes" 或 "No"）。
- 🚫 不是讀格內手寫文字、不是讀 Note 等非勾選欄的內容；那些一律忽略。
- 該列完全沒有任何勾 → student=""；看不清楚哪一欄 → student="?"。col 一律填 2。
- studentAnswerRaw 依列順序摘要，如「bedroom:Yes, dining room:Yes, ...」。

🚨 PRINTED-TEMPLATE vs STUDENT-HANDWRITING（2026-05-22 critical rule）:
某些 cell 內含**印刷的算式模板**（教科書印的、學生只填空格）。常見模板：
  - "(  )×(  )×3.14"   ← 印 ×3.14、學生填兩個括號裡的數字
  - "(  )×(  )"        ← 印 ×、學生填兩個括號
  - "(  )+(  )=(  )"   ← 印 + 跟 =、學生填三個括號
  - "(  )÷(  )"        ← 印 ÷、學生填兩個括號
  - "(  )公分"          ← 印「公分」、學生填數字
  - "答:(  )"           ← 印「答:」、學生填括號
判定方法：印刷括號 (  ) **本身就是印的**（永遠在那、所有學生看到一樣的）。
學生筆跡是手寫的字、通常**寫在括號內側**。

🚨 OUTPUT RULE for 模板 cell:
- **只讀印刷括號 (  ) 內側**學生手寫的數字 / 文字。
- **不要**抄括號外的印刷字符（×、3.14、+、=、÷、公分、答:、等等）。
- 一個 cell 內如果有多個括號 (  )，依出現順序把各括號內手寫值用「, 」串起來。
- 範例 1：cell 印 "(  )×(  )×3.14"、學生填 40 跟 40 → cell student="40, 40"
- 範例 2：cell 印 "(  )×(  )"、學生填 10 跟 10 → cell student="10, 10"
- 範例 3：cell 印 "(  )"、學生填 10 → cell student="10"
- 範例 4：cell 印 "(  )×(  )÷(  )"、學生填 12, 10, 2 → cell student="12, 10, 2"
- 反面範例（不要這樣）：cell 印 "(40)×(40)×3.14" → ✗ 不要輸出 "(40)×(40)×3.14" 或 "40×40×3.14"。正確是 "40, 40"。
- 反面範例（不要這樣）：cell 印 "(10)公分" → ✗ 不要輸出 "10公分"。正確是 "10"（公分是印的）。

如果 cell 是**空白格 / 完全沒有印刷模板**（純空盒等學生自由填寫）：
- 學生寫什麼就讀什麼、保留單位（如果學生自己寫單位）、不需挑括號。

- 每個 cell 讀完後輸出 cellValues 陣列（必填欄位）：[{ row: number, col: number, student: string }, ...]
  - student = 該 cell 內學生手寫值（依上述「印刷模板規則」處理）；完全空白 → ""；不可讀 → "?"
- studentAnswerRaw 寫人類可讀摘要，依 cells 順序用「, 」分隔。例如：「甲的底面積:40, 40, 乙的底面積:10, 10, 甲的柱高:10, 乙的柱高:40」
- 所有 cells 都空白 → status="blank"，cellValues 仍要回（每 cell student=""）。
- 至少 1 cell 有手寫 → status="read"。
- 禁止：跨格混讀（B 格寫 24% 不可記到 A 格）。用印刷表頭嚴格對位。
- 禁止：填入沒看到的值。沒寫就是空白，不要從表頭/印刷數值推測。

SPEC for table_cell questions:
${tableCellIds.map((qid) => {
  const meta = tableCellMetaMap.get(qid)
  if (!meta) return `- questionId="${qid}": (no tableMeta available, skip cellValues)`
  const tm = meta.tableMeta
  if (meta.checkTable) {
    const rowsDesc = meta.cells.map((c) => `(r${c.row}${c.label ? `,${c.label}` : ''})`).join(' ')
    return `- questionId="${qid}": 【勾選表 CHECK-TABLE】可勾選欄=${JSON.stringify(meta.checkColumns || [])}，對每列判斷 ✓ 打在哪一欄、student 填該欄標題；列: ${rowsDesc}`
  }
  const cellsDesc = meta.cells.map((c) => `(r${c.row},c${c.col}${c.label ? `,${c.label}` : ''})`).join(' ')
  return `- questionId="${qid}": 表 ${tm.totalRows}×${tm.totalCols}, rowHeaders=${JSON.stringify(tm.rowHeaders || [])}, colHeaders=${JSON.stringify(tm.colHeaders || [])}, 要讀 cells: ${cellsDesc}`
}).join('\n')}
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
- 輸出格式：每列用「 | 」分隔欄（**前後各一個空格**），每列之間用 "\\n" 分隔
  例：「人物 | 事件 | 影響\\n孔子 | 周遊列國 | 教學興盛\\n...」
- **【格式強制】**第一列若是欄標題（印刷字）→ **一律抄錄**作為脈絡（即使整列無學生筆跡也要寫）、不可省略
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
${JSON.stringify(visibleIds)}

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
- 答案區 =「兩線之間的整個區域」（沒有格線時 =整張裁切圖）。
- 在答案區【全範圍】內搜尋學生手寫筆跡——**不限中央位置**。手寫可能在左半、右半、上半、下半、或中央任何位置：
  - 注釋題「N. 題目: 答案」格式：答案常在中央偏右
  - 注音題：答案常在中央或下半
  - 選擇題：答案常在中央
  - 計算題：答案可能寫滿整個答案區
- 整個答案區（全範圍掃過）都沒有任何學生手寫筆跡 → status="blank", studentAnswerRaw="未作答"。
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
  singleChoiceRules, multiChoiceRules, trueFalseRules, fillBlankRules, multiFillRules, tableCellRules,
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
      "rawSpelling": "d-i-n-n-g r-o-o-m（**只在英語 fill_blank** 才輸出，其他 type 與其他領域 omit 此欄位）"` : ''}${tableCellIds.length > 0 ? `,
      "cellValues": [{ "row": 3, "col": 2, "student": "27%" }, ...]  // **只在 table_cell 才輸出**，依 SPEC 列出每 cell 學生值；其他 type omit 此欄位` : ''}${fillBlankPartsIds.length > 0 ? `,
      "partValues": [{ "subId": "a", "student": "2" }, { "subId": "b", "student": "12" }]  // **只在 fill_blank 合題（有 parts）才輸出**，依 SPEC 列出每空學生值；其他 type / 單空 fill_blank omit 此欄位` : ''}
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
export function buildReviewReadPrompt(classifyResult, options = {}) {
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
export function buildDetailReadPrompt(classifyResult, options = {}) {
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

export function buildArbiterPrompt(arbiterItems) {
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
  - 表格題（table_cell）：只比較填入的「值」（數字、文字），忽略表頭/列表標籤的差異。一方包含預印題幹標籤、另一方只有值 → 一致（如「光武國中:2/5, 建功國中:3/10」vs「2/5, 3/10」：學校名稱是題幹預印標籤、不是學生填的）
  - 複合判斷+解釋題（compound_judge_with_explain）：優先比【判斷部分】（如「對/不對」「能/不能」「行/不行」）+【計算式/算式】。判斷一致 + 計算式一致 → 一致。解釋部分的同義表達不算不一致（如「各共有的錢」vs「原有的錢」、「比2:30晚」vs「遲到5分鐘」、「兩人錢不同」vs「兩人錢數量不同」）

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
  // 2026-06-21 Bug H 防呆：「無法辨識」永遠不該被當成「一致的答案」靜默採用、給 0 分不送審。
  //   不論 AI3 是否判一致，最終答案是「無法辨識」一律送人工審查。
  if (ensureString(ai1Answer, '').trim() === '無法辨識' || ensureString(ai2Answer, '').trim() === '無法辨識') {
    return { arbiterStatus: 'needs_review' }
  }
  if (isConsistent) {
    // 一致 → 一律使用 AI1（客觀抄寫員）的答案
    return { arbiterStatus: 'arbitrated_agree', finalAnswer: ai1Answer }
  }
  // 不一致 → 送人工審查
  return { arbiterStatus: 'needs_review' }
}

// 2026-05-31: AI3 回的 questionId 可能帶格式變體（如「1-1（類型：single_check）」「題目1-1」）→
// 用 `===` 對不上、整批 AI3 結果被丟掉、退回程式 fallback（實證 13 收到/0 匹配）。
// 先精確比對；失敗則找「題號是 AI3 回值子字串」的最長題號（避免 1-3 誤匹配到 1-3-2）。回傳對到的 item（含 canonical questionId）。
function matchArbiterItemByQid(rawQid, items) {
  const qId = ensureString(rawQid).trim()
  if (!qId || !Array.isArray(items)) return null
  const exact = items.find((i) => i.questionId === qId)
  if (exact) return exact
  const cands = items.filter((i) => i.questionId && qId.includes(i.questionId))
  if (cands.length === 0) return null
  return cands.sort((a, b) => String(b.questionId).length - String(a.questionId).length)[0]
}

// 2026-06-02: 只送該卷實際有的題型規則（省 token + 各型可獨立微調、不牽動其他型）。
// 設計：模板文字完全不動，組好後在此「移除缺席題型的 category bullet」。零轉錄風險。
// all-types → keep 全集 → 不移除任何 bullet → 與原本位元相同（golden 驗證）。
// 互引依賴：circle_select_many / mark_in_text / multi_check_other 的規則引用 multi_check；
//          table_cell 引用 fill_blank → 這些型出現時強制保留被引用型的 bullet，避免斷引。
const ACCESSOR_KNOWN_CATS = new Set([
  'single_choice', 'multi_choice', 'circle_select_one', 'circle_select_many', 'single_check', 'multi_check',
  'multi_check_other', 'true_false', 'fill_blank', 'multi_fill', 'table_cell', 'matching', 'ordering',
  'mark_in_text', 'calculation', 'word_problem', 'fill_variants', 'map_fill', 'short_answer', 'map_symbol',
  'grid_geometry', 'connect_dots', 'diagram_draw', 'diagram_color', 'compound_circle_with_explain',
  'compound_check_with_explain', 'compound_writein_with_explain', 'compound_judge_with_correction',
  'compound_judge_with_explain', 'compound_chain_table'
])
const ACCESSOR_RULE_DEPS = {
  circle_select_many: ['multi_check'], mark_in_text: ['multi_check'],
  multi_check_other: ['multi_check'], table_cell: ['fill_blank']
}
function gateAccessorCategoryRules(prompt, typesUsed) {
  try {
    const keep = new Set(typesUsed)
    for (const t of typesUsed) (ACCESSOR_RULE_DEPS[t] || []).forEach((d) => keep.add(d))
    const START = 'QUESTION CATEGORY RULES (apply based on questionCategory field in AnswerKey):'
    const END = '- scoringReason MUST follow a UNIFIED STRUCTURE.'
    const lines = prompt.split('\n')
    const startIdx = lines.findIndex((l) => l.includes(START))
    const endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith(END))
    if (startIdx < 0 || endIdx < 0) return prompt  // 安全：找不到界標就不動
    const bulletKeep = (line) => {
      const m = line.match(/^- ([^:：]+)[:：]/)
      const headTxt = (m ? m[1] : line.slice(2)).trim()
      if (/^MULTI-FILL SCORING/.test(headTxt)) return keep.has('multi_fill')
      if (/^MAP-FILL SCORING/.test(headTxt)) return keep.has('map_fill')
      if (/^MAP-DRAW SCORING/.test(headTxt)) return ['map_symbol', 'grid_geometry', 'connect_dots'].some((t) => keep.has(t))
      const toks = headTxt.split('/').map((s) => s.trim())
      if (toks.length > 0 && toks.every((t) => ACCESSOR_KNOWN_CATS.has(t))) return toks.some((t) => keep.has(t))
      return true  // 非題型 bullet（全域 / 合題中文標頭 / fallback）一律保留
    }
    const body = lines.slice(startIdx + 1, endIdx)
    const out = []
    let i = 0
    while (i < body.length) {
      if (/^- /.test(body[i])) {
        let j = i + 1
        while (j < body.length && !/^- /.test(body[j])) j++
        if (bulletKeep(body[i])) out.push(...body.slice(i, j))
        i = j
      } else { out.push(body[i]); i++ }
    }
    const gated = [...lines.slice(0, startIdx + 1), ...out, ...lines.slice(endIdx)]
    // 2026-06-02: scoringReason 收斂 —— 移除「SCORING REASON TEMPLATES PER CATEGORY」整塊（25 條各型範本）。
    // 已實證(scripts/exp-accessor-reason)：強化版「通用結構」一條即涵蓋三要素(學生作答/標準答案/錯誤原因)
    // 與型別細節(漏選/單位/聲調…)、7/7 與含範本版相同。理由格式只剩一處可調、不再各型分散。
    const ts = gated.findIndex((l) => l.includes('SCORING REASON TEMPLATES PER CATEGORY'))
    const te = gated.findIndex((l, i) => i > ts && l.includes('ENGLISH DOMAIN EXTRA'))
    const finalLines = (ts >= 0 && te >= 0) ? [...gated.slice(0, ts), ...gated.slice(te)] : gated
    return finalLines.join('\n')
  } catch { return prompt }
}

// 2026-06-22: 英語大小寫等價（確定性、取代原 prompt 規則——AI 套用會漂，如 "Polar bear" 偶爾誤扣）。
//   非首字母一律小寫（手寫無字中大寫、中間大寫=讀取假象）；首字母若是大小寫同形/易混字母
//   C K M O P S U V W X Z T 也小寫。套在「學生讀值」與「正解」兩邊 → AI 看不到「可原諒的大小寫差異」、
//   無從誤扣；可分辨的首字母大小寫（apple/Apple、Indonesia/indonesia 的 I/A）仍保留給 AI 判。
const CASE_AMBIGUOUS_FIRST = new Set(['c', 'k', 'm', 'o', 'p', 's', 'u', 'v', 'w', 'x', 'z', 't'])
function caseEquivNormalize(text) {
  return String(text ?? '').replace(/[A-Za-z]+/g, (word) => {
    // 2026-06-22: 全大寫單字(2+字母)= 縮寫/專有名詞(USA/OK/TV)→ 大小寫有意義、原樣保留、不參與等價。
    if (word.length >= 2 && word === word.toUpperCase()) return word
    const first = word[0]
    const rest = word.slice(1).toLowerCase()
    return (CASE_AMBIGUOUS_FIRST.has(first.toLowerCase()) ? first.toLowerCase() : first) + rest
  })
}

// 2026-06-22: code 兜底 B——英語 fill_blank/short_answer 大小寫等價「確定性覆寫」。
//   即使 AI 因任何理由(含預防層失效)對「只差大小寫」扣分，code 在此判斷：逐空格嚴格比
//   (只赦免大小寫，字母/空格/標點/順序全須一致)，全部相符 → 回 true → 由呼叫端強制滿分。
//   全大寫縮寫(USA/OK)已由 caseEquivNormalize 原樣保留、不會被誤救。對不齊(空格數不符)→ 不覆寫。
// 兜底比對的單項正規化：赦免「大小寫」＋「結尾雜訊標點」，但保護句子標點。
//   - 結尾逗號/分號 ,; → 永遠去（任何答案結尾逗號都非刻意、多為誤點/分隔殘留）。
//   - 句末 . ! ? → 只在「短答案(≤2字)」赦免；句子(3+字)保留(punctuationCheck 有意義、不可動)。
//   - 字母/空格/內部標點/撇號(don't) 一律不動。
function overrideNormItem(text) {
  let s = caseEquivNormalize(String(text ?? '')).trim()
  s = s.replace(/[,;]+$/u, '').trim()
  if (s.split(/\s+/).filter(Boolean).length <= 2) s = s.replace(/[.!?]+$/u, '').trim()
  return s
}
function englishCaseFullMatch(question, studentAnswer) {
  const parts = Array.isArray(question?.parts) ? question.parts : null
  let correctList, studentList
  if (parts && parts.length > 0) {
    let pv = Array.isArray(studentAnswer?.partValues) ? studentAnswer.partValues.slice() : null
    if (!pv) {
      // partValues 缺 → 從 studentAnswerRaw 拆逗號重建；去掉結尾逗號造成的單一空項
      pv = ensureString(studentAnswer?.studentAnswerRaw, '').split(',').map((x) => x.trim())
      if (pv.length > parts.length && pv[pv.length - 1] === '') pv.pop()
    }
    if (pv.length !== parts.length) return false
    correctList = parts.map((p) => ensureString(p?.answer, ''))
    studentList = pv.map((v) => ensureString(v, ''))
  } else {
    const correct = ensureString(question?.answer || question?.referenceAnswer, '')
    if (!correct) return false
    correctList = [correct]
    studentList = [ensureString(studentAnswer?.studentAnswerRaw, '')]
  }
  for (let i = 0; i < correctList.length; i++) {
    const c = overrideNormItem(correctList[i])
    const s = overrideNormItem(studentList[i])
    if (!c || c !== s) return false
  }
  return true
}

// 2026-06-22: 大小寫等價「依答案卷專有名詞規則」(user 拍板，取代只看同形字母)。
//   答案卷該字「全大寫(USA)」或「大寫開頭且首字母可分辨(Indonesia 的 I/America 的 A)」→ 大小寫有意義、要扣；
//   其餘(普通小寫字 eating、同形首字母專有名詞 Sunday/Muslim/South 的 S/M)→ 首字母大小寫赦免(read 對它們本就會幻覺/讀不準)。
//   中間大寫一律赦免(手寫不可能、必為讀取假象)。
function caseSignificant(word) {
  const s = String(word ?? '').trim()
  if (!s) return false
  if (s.length >= 2 && s === s.toUpperCase() && /[A-Z]/.test(s)) return true   // 全大寫縮寫 USA/TV
  const f = s[0]
  return /[A-Z]/.test(f) && !CASE_AMBIGUOUS_FIRST.has(f.toLowerCase())          // 大寫＋可分辨首字母 = 專有名詞
}
function caseFoldWord(word, significant) {
  const s = String(word ?? '')
  if (!s) return s
  return (significant ? s[0] : s[0].toLowerCase()) + s.slice(1).toLowerCase()   // 中間一律小寫；首字母看 significant
}
// 一個 blank/答案：student 與 correct 是否「只差可赦免的大小寫 + 結尾雜訊標點」(字母/拼字/字數/順序不同 → false，交回正常批改)
function caseForgivableEqual(studentText, correctText) {
  const strip = (x) => String(x ?? '').trim().replace(/[,;]+$/u, '').trim()
  let sp = strip(studentText), cp = strip(correctText)
  if (cp.split(/\s+/).filter(Boolean).length <= 2) { sp = sp.replace(/[.!?]+$/u, '').trim(); cp = cp.replace(/[.!?]+$/u, '').trim() }
  if (!cp) return false
  const sw = sp.split(/\s+/).filter(Boolean), cw = cp.split(/\s+/).filter(Boolean)
  if (sw.length !== cw.length) return false
  for (let i = 0; i < cw.length; i++) {
    const sig = caseSignificant(cw[i])
    if (caseFoldWord(sw[i], sig) !== caseFoldWord(cw[i], sig)) return false
  }
  return true
}

export function buildAccessorPrompt(answerKey, readAnswerResult, domainHint, gradeBand) {
  const strictness = answerKey?.strictness || 'standard'
  // gradeBand: 'high' (10-12) → 多選用大考中心固定扣分；其他 (含 NULL/k9) → 現行 substitution-discount 公式
  const isHighSchool = gradeBand === 'high'
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
  const isEnglishDomain = hasEnglishRules || (domainHint || '').includes('英語')
  let englishRulesSection = ''
  if (isEnglishDomain) {
    const rules = []
    // 大小寫：可原諒的差異（首字母同形字母 C K M O P S U V W X Z T、非首字母中間大寫）已在送 AI 前由
    //   caseEquivNormalize 對「學生讀值＋正解」兩邊確定性正規化掉（2026-06-22 改 code、棄 prompt——AI 套規則會漂、
    //   如 Polar bear 偶爾誤扣）。所以 AI 看到的大小寫差異都是「可分辨的真差異」、照扣即可。
    rules.push('CASE SENSITIVITY (mandatory): For fill_blank and short_answer, capitalization must match the correctAnswer. Each word whose capitalization differs (e.g. "apple" vs "Apple") = deduct 1 point, errorType=\'spelling\'. NOTE: visually-ambiguous letter cases (C K M O P S U V W X Z T as a first letter) and ALL mid-word cases are already normalized upstream deterministically — so any capitalization difference you still see is a genuine, distinguishable one; deduct for it.')
    // 標點符號檢查（老師選擇）
    if (englishRules?.punctuationCheck?.enabled) {
      const d = englishRules.punctuationCheck.deductionPerError || 1
      rules.push(`PUNCTUATION CHECK (enabled): Applies ONLY to SENTENCE-level answers — correctAnswer has 3+ words (e.g. "Dad is cooking in the kitchen."). For such sentence answers, check sentence-ending punctuation (? . !) and apostrophes in contractions (e.g. don't, it's); each missing or wrong punctuation = deduct ${d} point(s) until score reaches 0. errorType='spelling'.
🚫 DO NOT apply punctuation check to single-word / short-phrase answers — correctAnswer has 1-2 words (e.g. "lion", "polar bear", "twenty-four"). A trailing . ! ? on such a short answer (student "lion." vs correct "lion") is NOT an error; ignore it and do NOT deduct.`)
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
- TRAILING PUNCTUATION: a trailing sentence mark (. ! ?) is NOT part of a single-word answer — ignore it, never deduct (e.g. "lion." = "lion", "zebra." = "zebra").

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

  // 2026-05-29: 把 question.answer 反向填到 referenceAnswer (若空)。
  // 為什麼：Accessor prompt 對 word_problem / calculation / fill_blank 規則寫
  //   「比對 studentAnswerRaw 與 referenceAnswer」(line 4802 等)、但 AnswerBank /
  //   AnswerKey schema 老師填的是 question.answer 欄位、referenceAnswer 大多 null。
  //   AI 看到 referenceAnswer=null 就 give up、isCorrect=false + 不給 scoringReason
  //   → fallback 「需人工複核」誤導老師（19 題 word_problem 全中招）
  // 修法：prompt-only fallback、不動 DB schema、不動 AnswerBank 寫入流程
  const rawQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  // 2026-06-22: 英語 fill_blank/short_answer → 大小寫等價確定性正規化（正解＋學生讀值兩邊都套）。
  //   ⚠️ 答案卷 question 的 ID 欄是 `id`（questionId 多為 null），read 的才叫 questionId；用 id||questionId 取。
  //   正解可能在 answer / referenceAnswer，或多空格在 parts[].answer（如 [{subId,answer:"monkey"}]）。
  const qidOf = (q) => q?.id || q?.questionId
  const englishCaseNormIds = isEnglishDomain
    ? new Set(rawQuestions.filter((q) => q?.questionCategory === 'fill_blank' || q?.questionCategory === 'short_answer').map(qidOf))
    : new Set()
  const compactAnswerKey = {
    questions: rawQuestions.map((q) => {
      if (!q || typeof q !== 'object') return q
      const hasRef = typeof q.referenceAnswer === 'string' && q.referenceAnswer.trim().length > 0
      const hasAns = typeof q.answer === 'string' && q.answer.trim().length > 0
      let out = (!hasRef && hasAns) ? { ...q, referenceAnswer: q.answer } : q
      if (englishCaseNormIds.has(qidOf(q))) {
        out = { ...out }
        if (typeof out.referenceAnswer === 'string') out.referenceAnswer = overrideNormItem(out.referenceAnswer)
        if (typeof out.answer === 'string') out.answer = overrideNormItem(out.answer)
        if (Array.isArray(out.parts)) out.parts = out.parts.map((p) => (p && typeof p.answer === 'string') ? { ...p, answer: overrideNormItem(p.answer) } : p)
      }
      return out
    }),
    totalScore: toFiniteNumber(answerKey?.totalScore) ?? null
  }
  // Build a set of questionIds that are multi-choice/multi-check types for separator normalization
  const multiSelectIds = new Set(
    (compactAnswerKey.questions || [])
      .filter((q) => ['multi_check', 'multi_choice', 'multi_check_other'].includes(q.questionCategory))
      .map((q) => q.questionId)
  )
  // calc/word_problem 過程文字常因 OCR 不準誤導 accessor → 砍掉 process 文字、只送 finalAnswer，
  // 強制 accessor 用學生作答圖判斷過程（accessor 收到時這些 questionId 會帶 processOmitted=true 旗標）
  const calcOrWordProblemIds = new Set(
    (compactAnswerKey.questions || [])
      .filter((q) => q.questionCategory === 'calculation' || q.questionCategory === 'word_problem')
      .map((q) => q.questionId)
  )
  const trimmedAnswers = Array.isArray(readAnswerResult?.answers)
    ? readAnswerResult.answers.map((a) => {
        if (calcOrWordProblemIds.has(a.questionId) && a.status === 'read') {
          const finalOnly = extractFinalAnswerCandidate(a.studentAnswerRaw) || a.studentAnswerRaw
          return {
            questionId: a.questionId,
            status: a.status,
            studentAnswerRaw: finalOnly,
            processOmitted: true
          }
        }
        const out = {
          questionId: a.questionId,
          status: a.status,
          studentAnswerRaw: multiSelectIds.has(a.questionId) && typeof a.studentAnswerRaw === 'string'
            ? a.studentAnswerRaw.replace(/[，、；;｜|]/g, ',')
            : a.studentAnswerRaw
        }
        // 2026-06-22: 英語 fill_blank/short_answer → 學生讀值大小寫等價正規化（與正解對稱）
        const normEngCase = englishCaseNormIds.has(a.questionId)
        if (normEngCase && typeof out.studentAnswerRaw === 'string') out.studentAnswerRaw = overrideNormItem(out.studentAnswerRaw)
        // table_cell / fill_blank 合題：保留結構化讀值給 accessor 對齊每 cell/part
        if (Array.isArray(a.cellValues)) out.cellValues = a.cellValues
        if (Array.isArray(a.partValues)) out.partValues = normEngCase ? a.partValues.map((v) => typeof v === 'string' ? overrideNormItem(v) : v) : a.partValues
        return out
      })
    : []

  const accessorTypesUsed = new Set((compactAnswerKey.questions || []).map((q) => q.questionCategory).filter(Boolean))
  const _accPrompt = `
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
  【體積】 km³ = 立方公里   m³ = 立方公尺   cm³ = 立方公分 = cc = c.c.   mm³ = 立方公釐
  【重量】 kg = 公斤   g = 公克   mg = 毫克
  【容積】 L = 公升   mL = ml = 毫升
  【時間】 h = hr = 小時   min = 分 = 分鐘   s = sec = 秒
  【速度】 km/h = 公里/小時 = 時速X公里   m/s = 公尺/秒   m/min = 公尺/分鐘   km/min = 公里/分鐘
  Note: "時速X公里" (e.g. 時速60公里) = "X km/h" = "X 公里/小時" — treat as identical.
  Note: Same-name pairs above (e.g. cm³ ↔ 立方公分, m² ↔ 平方公尺) ARE identical.
  Note: Different units (e.g. 公尺 vs 公分, kg vs g) are still WRONG even if both appear in this table.
  🚨 DIMENSION RULE: 長度(m/公尺/cm) ≠ 面積(m²/平方公尺/cm²) ≠ 體積(m³/立方公尺/cm³) are DIFFERENT dimensions.
     Same number with a wrong dimension is a UNIT ERROR (errorType='unit', score 0), e.g. "408.2 m³" vs answer "408.2 平方公尺" → WRONG (體積 vs 面積).

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
  STUDENT DUAL-FORM RULE (國字注音，與上條互補): 國字注音題的 studentAnswerRaw 可能同時含「國字」與「注音」兩種形式（系統把作答盒內看到的兩者都讀出來、格式「國字 注音」，其中一個是印刷題幹、一個是學生手寫，你不需分辨）。correctAnswer 為單一形式時，只要 studentAnswerRaw 裡的**國字 OR 注音 任一與 correctAnswer 完全相符**（注音須含聲調）即 isCorrect=true、滿分；另一個不吻合的形式是印刷題幹，**忽略、不可當作答錯扣分**。若兩形式都不等於 correctAnswer（含注音聲調不符、破音字錯讀如紮讀成ㄗㄚ、只讀到印刷國字而正解是注音）→ isCorrect=false。
- fill_variants: Match any entry in acceptableAnswers[]. Answers not in the list are wrong.
- table_cell: 群組批改表格題。AnswerKey 提供 cells 陣列（每元素 {row, col, label, answer}）；Read 結果在 cellValues 陣列（每元素 {row, col, student}）。
  - 對每個 answerKey.cells[i]，依 (row, col) 找到對應的 cellValues 元素，比對 student vs answer。
  - 比對規則同 fill_blank（精確比對 + UNIT RULE）；單位、空白、不可讀的處理一致。
  - cellResults 陣列輸出每 cell 對錯細節：[{ row, col, label, student, expected, correct, reason }]
    - reason 簡短說明錯誤原因（如「單位錯」「數值錯」「未作答」），correct 時可省。
  - correctCount = cellResults.filter(c => c.correct).length
  - score = round((correctCount / cells.length) × maxScore)
  - isCorrect = (correctCount === cells.length)（全對才算）
  - errorType: 任 cell 答錯 → 'concept'；全空白 → 'blank'；單位錯為主 → 'unit'。
  - studentAnswer：寫人類可讀摘要（同 read 給的 studentAnswerRaw 即可）。
  - 範例（4 cells、maxScore=4、3 個對 1 個漏單位）：score=3、isCorrect=false、errorType='concept'、cellResults 列每 cell 對錯+理由。
- fill_blank 合題（題目含 parts 陣列）：群組批改多空題。AnswerKey 提供 parts 陣列（每元素 {subId, answer, maxScore}）；Read 結果在 partValues 陣列（每元素 {subId, student}）。
  - 對每個 answerKey.parts[i]，依 subId 找到對應的 partValues 元素，比對 student vs answer。
  - 比對規則同 fill_blank 單空（精確比對 + UNIT RULE + DUAL-ANSWER RULE）；單位、空白、不可讀的處理一致。
  - partResults 陣列輸出每空對錯細節：[{ subId, student, expected, correct, reason }]
    - student 必須照抄該 part 對應 partValues 的「實際學生作答」，**嚴禁杜撰或寫成別格的答案**；每個 subId 只輸出一次、不可重複。
    - reason（錯時必填）寫具體錯誤原因。英語領域用扣分格式（與 ENGLISH DOMAIN EXTRA 一致），例：
      「大小寫錯誤：學生寫 south africa，正確為 South Africa，扣1分」、
      「空格錯誤：學生寫 Twenty four，正確為 twenty-four，不認識該單字，0分」、
      「拼寫錯誤：學生寫 writeing，正確為 writing，扣1分」。correct 時 reason 可省。
    - 注意：scoringReason 最終由系統用 partResults 自動組「逐空格清單」、所以 partResults 必須每格正確、完整、不重複。
  - 配分：每 part 各自有 maxScore；漏填或預設 → 平均分（maxScore / parts.length，向下取整、最後 1 個取餘）。
  - score = sum(partResults.filter(p => p.correct).map(p => part.maxScore))
  - isCorrect = (所有 parts 都對才算)
  - errorType: 任 part 錯 → 'concept'；全空白 → 'blank'；單位錯為主 → 'unit'。
  - studentAnswer：寫人類可讀摘要（同 read 給的 studentAnswerRaw 即可，如「2, 12」）。
  - 範例（2 parts、maxScore=4、第 1 空對 第 2 空錯）：score=2、isCorrect=false、errorType='concept'、partResults 列每空對錯+理由。
- multi_check / multi_choice: The answer field contains comma-separated correct tokens (e.g. "①,③" or "A,C"). SEPARATOR NORMALIZATION: before splitting, replace ALL of these separators in BOTH student answer and correct answer with a regular comma: Chinese comma（，）, Chinese pause mark（、）, semicolon（；）, fullwidth semicolon, vertical bar（｜ or |）, whitespace-only gaps between tokens. Then parse as comma-separated token sets (order-insensitive).
  - OPEN-ENDED OTHER RULE: If referenceAnswer contains "其他選項：#N" (e.g. "其他選項：#4" or "其他選項：#4；參考：XXX"), token #N is an open-ended free-write option. Before computing correct/wrong sets, REMOVE #N from student_tokens. Student selecting or not selecting 其他 does NOT affect score in any way.
  - correct = tokens in student_tokens ∩ answer_tokens
  - wrong = tokens in student_tokens − answer_tokens
  - missing = tokens in answer_tokens − student_tokens
${isHighSchool
  ? `  - 高中模式（大考中心）: 每個選項獨立判定，wrongCount = |wrong| + |missing|（多選 + 漏選都各算 1 錯，無 substitution 折扣）
  - score = max(0, maxScore − 2 × wrongCount)
  - 範例（5 分題、正確 ACE）：學生 ACB（漏 E、多 B）→ wrongCount=2 → 1 分；學生 ABCDE（多 BD）→ wrongCount=2 → 1 分；學生 BD（漏 ACE 多 BD）→ wrongCount=5 → 0 分`
  : `  - extraWrong = max(0, |wrong| − |missing|)   ← only penalize wrong tokens that EXCEED the missing count (substitution = 1 error, not 2)
  - score = max(0, round((|correct| − |extraWrong|) / |answer_tokens| × maxScore))`}
  - isCorrect = (score === maxScore)
  - errorType: if student has wrong extra tokens → 'concept'; if student missed tokens → 'concept'; if blank → 'blank'.
- multi_check_other: Same as multi_check BUT the LAST checkbox option is an open-ended "其他：___" field.
  - STEP 1 — Parse studentAnswerRaw: split into tokens. If the 其他 token has text appended (format "token：text", e.g. "(4)：轉為文風鼎盛的社會"), extract and store the text separately, then strip it from the token.
  - STEP 2 — Identify and REMOVE the 其他 token: the highest-numbered token in student_tokens ∪ answer_tokens. ALWAYS remove it from student_tokens. It is NEVER counted in the correct/wrong formula.
  - STEP 3 — Score the remaining tokens using the same multi_check formula defined above (依 gradeBand 分支：高中用 wrongCount=|wrong|+|missing| 並套 maxScore−2×wrongCount；其他用 extraWrong 比例公式).
    - ⚠️ EMPTY REFERENCE GUARD: If referenceAnswer is empty/null/blank (teacher did not specify correct fixed options), treat ALL fixed-option tokens as neither correct nor wrong → score = maxScore (full marks for fixed-option portion). Do NOT penalize any fixed option when reference is absent.
  - STEP 4 — Evaluate 其他 text (only if student checked 其他 AND text is non-empty):
    - Use the question context visible in the image and the answer key referenceAnswer (if provided) to judge whether the text is a reasonable/valid answer for this question.
    - If REASONABLE: note "其他選項文字合理" in scoringReason. Does NOT add to score.
    - If UNREASONABLE: note "其他選項文字不合理" in scoringReason. Does NOT deduct from score.
    - ⚠️ 其他 text is NEVER penalized regardless of reasonableness — it only affects scoringReason.
  - isCorrect = (score === maxScore).
  - errorType: same as multi_check (based on non-其他 tokens only).
- word_problem: Standard-answer question type with BINARY scoring (all-or-nothing — score 必為 0 或 maxScore，禁止中間值).
  ⚠️ studentAnswerRaw 只含學生寫的「最終答句」(已從 OCR 過程文字中萃取)。**算式過程一律不評**。
  🚨 BINARY SCORING (word_problem — must follow strictly):
  比對 studentAnswerRaw 的最終答句 (含數值與單位) 與 referenceAnswer：
    - 數值正確 + (referenceAnswer 沒單位需求 OR 單位正確/在 UNIT EQUIVALENCE TABLE) → score = maxScore. STOP.
    - 數值錯誤 / 單位錯誤 / 缺單位 (referenceAnswer 有單位但學生沒寫) / 空白 / 無法辨識 → score = 0. STOP.
  🚨 數值比對規則（NUMBER MATCH — 嚴格遵守）：
    - **精確比對、無容忍值**：學生數值需與 referenceAnswer 數值**完全相等**才算對。不可套用任何誤差/容忍範圍。
    - referenceAnswer 帶「約」「大約」「≈」是因為用 π≈3.14 取近似、**不代表有容忍範圍**；學生用同樣 3.14 算應得完全一樣的數。
      例：ref「約518.1 立方公分」→ 學生「518.1」對；學生「515.25」**錯**（數值不同、非容忍範圍）。
    - **格式等價（視為相同數）**：5 = 5.0 = 5.00（結尾零）；1/2 = 0.5；3 又 1/2 = 3.5；1,000 = 1000（去千分位逗號）；²/³ 上標 = ^2/^3。
    - **單位維度（見 UNIT EQUIVALENCE TABLE 的 DIMENSION RULE）**：長度 ≠ 面積 ≠ 體積。維度不符即使數值相同也是單位錯、score 0（如 m³ vs 平方公尺）。
  **完全不檢查算式過程、不看 crop 圖、不分析列式。算式診斷由後續 explain 階段負責，accessor 不碰。**
  禁止給 (maxScore - 1) 這類中間分數。

  🚨 MULTI-PART FINAL ANSWERS (referenceAnswer 含多個數值+單位、用「，」「,」「、」分隔):
    例：referenceAnswer = "50.24 公分，1406.72 平方公分" (兩個 part) 或 "12歲，36歲" (兩個 part)。
    步驟：
      1. 依「，」「,」「、」拆解 referenceAnswer 為 N 個 expected parts。
      2. 同樣切 studentAnswerRaw 為 student parts。
      3. 對齊比對 (順序固定)：
         - 全部 part 對 (數值正確 + 單位正確/equivalent) → score = maxScore, isCorrect=true。
         - 任一 part 數值錯 / 單位錯 / 缺漏 → score = 0, isCorrect=false。
      4. scoringReason 必須具體標出每個 part 對錯。
         範例 (1 對 1 錯)：「第一個答案「50.24cm」正確；第二個答案「1105.28」錯誤，正確應為「1406.72 平方公分」」
         範例 (全錯)：「學生只寫一個答案「4048 cm²」、應有兩個答案「50.24 公分」+「1406.72 平方公分」、缺漏不完整」
    🚨 絕對禁止對 multi-part 題目 fallback 為空 scoringReason — 必須寫出對比。

  🚨 word_problem 強制 scoringReason 規範：
    - score=0 (錯) 必須寫出「學生答案 vs 標準答案」對比 + 錯誤原因。
    - score=maxScore (對) 必須寫「答句「X」正確」之類確認句。
    - 嚴禁回傳空字串 / null / 純標點符號的 scoringReason。
    - 若 referenceAnswer 真的看不懂、給 isCorrect=false + scoringReason="referenceAnswer 格式無法解析（請老師人工確認）"。
- calculation: Standard-answer question type with BINARY scoring (all-or-nothing — score 必為 0 或 maxScore，禁止中間值).
  HARD RULE: NEVER require "答：", "A:", or "Ans:" prefix. NO unit checking — students do NOT need to write units.
  ⚠️ studentAnswerRaw 只含學生寫的「最終答案」(已從 OCR 過程文字中萃取)。**算式過程一律不評**。
  🚨 BINARY SCORING (calculation — must follow strictly):
  比對 studentAnswerRaw 的最終數值 與 referenceAnswer 的最終數值：
    - 數值匹配（含等值分數/小數、commutative 因式順序） → score = maxScore. STOP.
    - 數值錯誤 / 空白 / 無法辨識 → score = 0. STOP.
  **完全不檢查算式過程、不看 crop 圖、不分析列式。算式診斷由後續 explain 階段負責，accessor 不碰。**
  禁止給 (maxScore - 1) 這類中間分數。
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
    🚨 SCOPE: This rule ONLY applies when Domain is "社會" or "自然".
    For other domains (especially 國語注釋題 where referenceAnswer itself is 2-4 chars like "深藍"、"回頭"、"盡情歌唱"),
    this rule MUST be skipped — short reference answers are NORMAL and a literal match deserves full score.
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
    This rule does NOT apply to 國語/English/其他 domains — only 社會 and 自然.
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
- map_fill: 不應該出現在 Accessor 的 question 清單裡（map_fill 走 map-fill-grader、Phase B bypass Accessor）。如果還是看到、給 needs_review。
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

- MAP-FILL SCORING: map_fill 在 2026-05-28 起改走獨立 map-fill-grader、Phase B 完全 bypass Accessor、
  Accessor 不應該看到任何 map_fill question。若還是看到、直接給 needs_review、不要嘗試評分。
- MAP-DRAW SCORING (繪圖/標記題): The student's answer is a description of what was drawn and where (e.g. "颱風符號，位置：23.5°N緯線以南、121°E經線以東的格子（右下格）"). The referenceAnswer in the AnswerKey describes where the symbol SHOULD be placed.
  - Judge whether the drawn symbol is correct (right type of symbol).
  - Judge whether the position is correct by comparing the described location against the referenceAnswer's required coordinates/grid position.
  - A position is correct if the student placed it in the correct grid cell or within reasonable proximity of the required coordinate intersection.
  - scoringReason MUST use format「學生繪製___於___，正確位置為___，（位置/符號是否正確）」. e.g. "學生繪製颱風符號於左下格，正確位置為右下格，符號正確但位置偏移".
- scoringReason MUST follow a UNIFIED STRUCTURE. Write in Traditional Chinese. NEVER just state a score count like "9/11 correct".
  錯題務必含三要素（缺一不可，禁止只給分數或空字串）：①學生實際作答 ②標準答案 ③具體錯誤原因。錯誤原因依題型寫具體：多選指明漏選/多選了哪些；計算/應用指明數值錯或單位錯；填空指明寫成什麼；是非指明判斷錯；配對/圈選/勾選指明選錯哪項；圖表/繪圖指明位置或數值偏差；國字注音指明國字或注音錯（含聲調）。
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
  - calculation:       correct→「最終答案36正確」 wrong→「學生最終答案為38，正確答案為36，答案錯誤」
  - word_problem:      correct→「答句「36公分」正確」 wrong(數值錯)→「學生答句寫「38公分」，正確答案為「36公分」，答案錯誤」 wrong(單位錯)→「學生答句寫「36公尺」，正確答案為「36公分」，單位錯誤、答案不正確」 wrong(缺單位)→「學生答句寫「36」（缺單位），正確答案為「36公分」，答案不完整、答案不正確」
                       multi-part correct→「第一個答案「50.24cm」正確；第二個答案「1406.72cm²」正確」 multi-part partial wrong→「第一個答案「50.24cm」正確；第二個答案「1105.28」錯誤，正確應為「1406.72 平方公分」」 multi-part missing→「學生只寫一個答案「4048 cm²」、應有兩個答案「50.24 公分」+「1406.72 平方公分」、缺漏不完整」
  - short_answer:      correct→「學生回答內容完整，概念正確」 wrong→「學生寫「因為天氣很熱」，正確答案應涵蓋「蒸發作用」概念，學生僅描述現象未說明原理」. When rubricsDimensions exist, describe each dimension's score.
  - matching:          correct→「學生配對「2公尺/秒」，答案正確」 wrong→「學生配對「3公尺/秒」，正確答案為「2公尺/秒」，配對錯誤」
  - map_fill:          走獨立 map-fill-grader、不應該到 Accessor、看到就 needs_review
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
      "scoreConfidence": 79,
      "cellResults": [{ "row": 3, "col": 2, "label": "蘋果", "student": "27%", "expected": "27%", "correct": true }],
      "partResults": [{ "subId": "a", "student": "2", "expected": "2", "correct": true }, { "subId": "b", "student": "13", "expected": "12", "correct": false, "reason": "數值錯" }]
    }
  ],
  "totalScore": 0
}
⚠️ cellResults 只在 questionCategory='table_cell' 時輸出（每 cell 一筆對錯細節）；其他 type omit 此欄位。
⚠️ partResults 只在 questionCategory='fill_blank' 且有 parts 陣列時輸出（每空一筆對錯細節）；其他情境 omit 此欄位。
`.trim()
  return gateAccessorCategoryRules(_accPrompt, accessorTypesUsed)
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
  answerSheetMode = 'with_questions',
  hasBooklet = true
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

  // 答案卷模式 + 無題本：只能產通用引導，不可編造題目內容
  const isAnswerOnlyNoBooklet = answerSheetMode === 'answer_only' && !hasBooklet

  if (isAnswerOnlyNoBooklet) {
    return `
You are stage Explain (ANSWER-ONLY mode WITHOUT question booklet).

⚠️ CRITICAL CONSTRAINT — you DO NOT have access to the actual question text.
The teacher uploaded a pure answer card (no question booklet). You can see only:
- The question's questionCategory (single_choice / multi_choice / fill_blank / short_answer)
- The student's answer
- The correct answer
- The mistake type / scoring reason

You MUST NOT:
- Invent or assume what the question is asking about (e.g., DO NOT say "this question is about magnetic field" or "this question asks for the area of a triangle").
- Reference specific concepts, formulas, or topics from the (unseen) question stem.
- Pretend to read the question text — there is no question text to read.

You MUST:
- Output broad, generic correction prompts based ONLY on questionCategory + mistakeType + answer comparison.
- Stay neutral about the topic. Use phrases like "本題", "這道題", "你寫的答案" without naming the subject matter.

== Generic guidance templates (use these as patterns; customize wording slightly) ==

| questionCategory | mistakeType | studentGuidance template |
|---|---|---|
| any | blank | 此題未作答，請補寫作答。 |
| single_choice | concept / wrong_choice | 答案選擇有誤，請複習相關概念再思考一次。 |
| multi_choice | concept (漏選) | 漏選了部分正確選項，請逐項確認每個選項的對錯。 |
| multi_choice | concept (多選) | 多選了不正確的選項，請對每個選項逐一判斷。 |
| fill_blank | calculation / careless | 計算過程有誤，請重新驗算一次。 |
| fill_blank | concept | 答案不正確，請複習相關概念再思考。 |
| short_answer | concept / partial | 答題未完整或方向不正確，請重新組織答案。 |
| any | unreadable | 老師無法辨識你的字跡，請寫得清楚一些。 |

== Tone ==
Traditional Chinese (繁體中文). Warm but neutral. 1–2 short sentences per guidance.

Domain: ${JSON.stringify(domainHint || null)}
Wrong question IDs to process: ${JSON.stringify(explainQuestionIds)}

AnswerKey (wrong questions only — questionCategory + maxScore + correct answer):
${JSON.stringify(wrongAnswerKey)}

Student answers (wrong questions only):
${JSON.stringify(wrongReadAnswers)}

Scoring analysis (wrong questions only):
${JSON.stringify(wrongScores)}

== weaknesses / suggestions in this mode ==
- weaknesses: 1~2 generic statements (e.g. "對部分題型的概念掌握不夠完整")。禁止指名具體章節或公式。
- suggestions: 1~2 generic actions (e.g. "建議與老師討論本次測驗中錯誤類型集中的題型")。禁止給具體內容。

Return strict JSON only. No markdown.

Output:
{
  "details": [
    {
      "questionId": "string",
      "studentGuidance": "通用引導（1-2 句，不得編造題目內容）",
      "mistakeType": "concept|calculation|condition|blank|unreadable",
      "mistakeTypeCodes": ["concept"]
    }
  ],
  "weaknesses": ["..."],
  "suggestions": ["..."]
}
`.trim()
  }

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

🚨 ABSOLUTELY FORBIDDEN — 不可洩漏答案的「組件」（即使沒寫出完整答案數字）：

1. 禁止直接點名單位 / 詞彙：
   BAD: 「漏掉了題目問的『年前』、記得補上單位」
   BAD: 「答句少了『年後』這兩個字」
   BAD: 「請在數字後面補上『公分』」
   GOOD: 「答句少了單位、再讀一次題目最後一句、看看單位應該怎麼寫」
   GOOD: 「再檢查一下、答案是否完整包含題目要求的所有資訊」

2. 禁止用「算式逐步引導」把學生帶到答案數字：
   BAD: 「你算出妹妹那時候是 9 歲、妹妹現在 4 歲、中間是幾年？」
        （= 列出 9-4=5、學生直接帶入）
   BAD: 「外婆 61 歲、媽媽 31 歲、年齡差 30、所以要算...」
        （= 算式逐步給、剩最後一步學生補）
   GOOD: 「再讀一次題目問什麼、你算到的哪個數字符合題目要的單位？」
   GOOD: 「重新檢查你的算式、想想題目要的『差距』還是『倍數』」

3. 禁止「二選一指向」（疑問句也算）：
   BAD: 「應該寫『後』而不是『前』」
   BAD: 「歲數增加代表時間過了幾年『後』還是『前』呢？」
        （疑問句、但選項已暗示正確答案）
   BAD: 「答案是『大於』還是『小於』呢？」
   GOOD: 「想想題目情境是過去還是未來、要怎麼選擇詞彙？」

4. 禁止「指向學生已算出的某個 candidate」：
   學生計算過程出現多個數字（如算式列出 14、42 兩個數），
   不可說「找看看代表淑芳的是哪一個數字」（暗示在 14、42 中選 14）。
   GOOD: 「再讀題目最後一句、確認題目問的對象是誰、你的算式有沒有對應到」

5. 禁止「告訴學生下一步怎麼做」：
   BAD: 「現在請再看一次題目最後是怎麼問的、把那兩個字補上去吧！」
        （= 告訴學生只要補上某兩個字就對）
   GOOD: 「現在請再看一次題目最後一句、確認你的答案是否完整」

📌 引導語的核心原則 = 讓學生「重讀題目 / 重檢查算式 / 重新思考」、
   不是「告訴學生下一步該做什麼」。任何讓學生「只要照做就對」的提示都禁止。
   若學生算式正確只是少單位或方向反、引導語仍要學生自己回去讀題判斷、不可指認。

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
  model: _legacyModel,  // 2026-05-21: 不再用，由 STAGE_MODEL[routeKey] 統一決定。保留參數簽名相容
  modelOverride,  // 2026-06-02: 有給就用這個 model（例：國語卷 read 改 PRO），否則照 routeKey 決定
  payload,
  timeoutMs,
  routeHint,
  routeKey,
  stageContents
}) {
  // 2026-05-21: model 分流——每個 routeKey 查 STAGE_MODEL 取 PRO/FLASH
  // 視覺類 (classify / read / locate / perspective) → MODEL_PRO
  // 純文字類 (arbiter / accessor / explain / report) → MODEL_FLASH
  const model = modelOverride || resolveStageModel(routeKey)
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
      fallbackModels: FALLBACK_CHAIN
    })
  } catch (err) {
    const modelLatencyMs = Date.now() - modelStartedAt
    const errStatus = Number(err?.status) || 504
    return {
      routeKey,
      pipelineName: pipeline.name,
      stageModel: preparedRequest.model,
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

  // 2026-05-22: 寫 ink_session_usage 1 row per AI call (trackContext 從 ALS 拿)
  if (modelResponse?.ok && modelResponse?.data?.usageMetadata) {
    await recordTokenUsage({
      usageMetadata: modelResponse.data.usageMetadata,
      routeKey,
      modelName: extractModelNameFromResult(modelResponse, preparedRequest.model)
    })
  }

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
    stageModel: preparedRequest.model,
    status: Number(modelResponse.status) || 500,
    ok: Boolean(modelResponse.ok),
    data: modelResponse.data,
    prepareLatencyMs,
    modelLatencyMs,
    warnings: Array.isArray(validation?.warnings) ? validation.warnings : [],
    metrics: validation?.metrics && typeof validation.metrics === 'object' ? validation.metrics : {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-06-30 錯題引導 on-demand（學生在訂正時按鈕觸發、單題生成）
//   設計：引導離開批改管線（Phase B 只剩 accessor），改成學生「卡住才按」。
//   - 防濫用：學生必須填「哪裡不懂」、server 端也擋消極/空白（client 另有一層）。
//   - 答案保密：答案卷一律 server 端 live 抓（loadPhaseAState）、prompt 內部參考但嚴禁吐給學生。
//   - 計費：走 grading.* route → proxy 自動把費用歸老師（resolveBillingUserId）。
// ─────────────────────────────────────────────────────────────────────────────

// 消極/空白說明偵測：擋「不會 / 不知道 / 不懂 / 未填」這類無資訊輸入（防學生亂按燒老師點數）。
export function isMeaningfulConfusion(text) {
  const raw = ensureString(text, '').trim()
  if (!raw) return false
  const stripped = raw.replace(/[\s,，。.!！?？、~～:：;；]/g, '')
  if (stripped.length < 4) return false  // 太短（「不會」「不懂」「不知道」）一律擋
  // 整句僅由消極語構成 → 擋
  if (/^(這題|這個|題目|整題)?(我)?(都|完全|就是|統統|根本)?(不(知道|曉得|懂|會|清楚|明白|瞭解|知)|看不懂|沒(有|概念|想法)|毫無頭緒|忘記了?|忘了|未填|無|不太懂|不太會)$/.test(stripped)) return false
  // 移除消極詞與題目代稱後若無實質內容 → 擋
  const meaningful = stripped.replace(/(不知道|不曉得|不清楚|不明白|看不懂|不懂|不會|沒概念|沒想法|毫無頭緒|忘記了?|忘了|不太懂|不太會|這題|這個|這道|題目|整題|我|都|完全|就是|根本)/g, '')
  if (meaningful.length < 3) return false
  return true
}

function buildSingleGuidancePrompt({ question, studentAnswer, studentConfusion, domainHint, answerSheetMode, hasImage }) {
  const qCat = ensureString(question?.questionCategory || question?.type, '').trim()
  const correct = ensureString(question?.answer || question?.referenceAnswer, '').trim()
  const maxScore = toFiniteNumber(question?.maxScore)
  const isAnswerOnly = answerSheetMode === 'answer_only'
  return `
你是國小老師，正在一對一回覆一位學生對「某一題」的提問。學生卡住了、想要引導（不是要答案）。

學生親口說他「哪裡不懂」：「${studentConfusion}」
你的任務：針對他說的這個困惑，給溫暖、具體、好懂的引導，幫他自己想出來。

題型(questionCategory)：${qCat || '未知'}
學生的作答：「${studentAnswer || '（空白／未作答）'}」
${hasImage ? '附圖是學生的作答影像，可參考字跡與作答。' : ''}
（⚠️ 以下僅供老師內部判斷、絕對不可吐給學生 —— 標準答案：「${correct || '（無）'}」${Number.isFinite(maxScore) ? `、配分 ${maxScore}` : ''}）

== 鐵則 ==
1. ⛔ 絕對不可以直接講出、拼出或暗示標準答案，禁止「答案是…」「正確答案為…」「應該填 X」這類句子。要引導學生「怎麼想」，不是給他答案。
2. 必須直接回應學生說的困惑「${studentConfusion}」，不要答非所問。
3. 用台灣國小生聽得懂的口語、溫暖鼓勵的語氣。2～4 句。
4. 若學生作答空白或字跡無法判讀，先溫和提醒，再給思考方向。
${isAnswerOnly ? '5. 你看不到題目原文，只知道題型與作答，不可以編造題目在問什麼、不可指名具體章節或公式。' : ''}

只回傳嚴格 JSON、不要 markdown：
{
  "studentGuidance": "針對學生困惑的引導語（2-4 句、繁體中文、不得洩漏答案）",
  "mistakeType": "concept|calculation|condition|blank|unreadable|other"
}
`.trim()
}

function errorGuidanceFailure(status, code, message) {
  return {
    status,
    data: { error: message, code },
    pipelineMeta: { pipeline: 'grading-error-guidance', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: { code } }
  }
}

// 單題錯題引導 handler（orchestrator 在 routeKey=grading.error_guidance 時呼叫）。
export async function runErrorGuidance({ apiKey, model, contents, payload = {}, routeHint = {}, internalContext = {} }) {
  const submissionId = internalContext?.submissionId || payload?.submissionId || null
  const questionId = ensureString(payload?.questionId, '').trim()
  const studentConfusion = ensureString(payload?.studentConfusion, '').trim()
  const domainHint = payload?.domain || internalContext?.domainHint || null
  if (!submissionId || !questionId) return errorGuidanceFailure(400, 'MISSING_PARAMS', '缺少必要參數（submissionId / questionId）')
  // server 端二次防濫用（client 已擋一層、這裡不可被繞過）
  if (!isMeaningfulConfusion(studentConfusion)) {
    return errorGuidanceFailure(400, 'INVALID_CONFUSION', '請具體說明你卡在哪裡（例如：這個步驟為什麼這樣算、哪個字看不懂），不要只填「不會 / 不知道」。')
  }
  const cached = await loadPhaseAState(submissionId)
  const answerKey = cached?.live_answer_key
  const q = Array.isArray(answerKey?.questions)
    ? answerKey.questions.find((x) => ensureString(x?.id).trim() === questionId)
    : null
  if (!q) return errorGuidanceFailure(404, 'QUESTION_NOT_FOUND', '找不到該題（可能答案卷已變更）')
  // 學生最終答案：優先 final_answers、fallback phase_a_state read1
  const faArr = Array.isArray(cached?.final_answers) ? cached.final_answers : []
  const fa = faArr.find((f) => ensureString(f?.questionId).trim() === questionId)
  let studentAnswer = ensureString(fa?.finalStudentAnswer, '').trim()
  if (!studentAnswer) {
    const r1Arr = Array.isArray(cached?.phase_a_state?.readAnswer1) ? cached.phase_a_state.readAnswer1 : []
    const r1 = r1Arr.find((r) => ensureString(r?.questionId).trim() === questionId)
    studentAnswer = ensureString(r1?.answer, '').trim()
  }
  const answerSheetMode = payload?.answerSheetMode || internalContext?.answerSheetMode || 'with_questions'
  const imageParts = Array.isArray(contents)
    ? contents.flatMap((c) => (Array.isArray(c?.parts) ? c.parts.filter((p) => p?.inlineData) : []))
    : []
  const prompt = buildSingleGuidancePrompt({
    question: q, studentAnswer, studentConfusion, domainHint, answerSheetMode, hasImage: imageParts.length > 0
  })
  const resp = await executeStage({
    apiKey, model, payload, timeoutMs: 60000, routeHint,
    routeKey: AI_ROUTE_KEYS.GRADING_ERROR_GUIDANCE,
    stageContents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }]
  })
  if (!resp?.ok) return errorGuidanceFailure(Number(resp?.status) || 503, 'AI_FAILED', '🙂 AI 剛剛有點忙、生成引導失敗，請再試一次。')
  const parsed = parseCandidateJson(resp.data)
  const guidance = ensureString(parsed?.studentGuidance, '').trim()
  if (!guidance) return errorGuidanceFailure(502, 'EMPTY_GUIDANCE', 'AI 回覆為空，請再試一次。')
  // 持久化：寫回該題目前 open 的訂正項 hint_text（survive reload、老師端也看得到）。best-effort、失敗不影響回傳。
  try {
    const supabase = getSupabaseAdmin()
    const { data: sub } = await supabase
      .from('submissions')
      .select('student_id, assignment_id')
      .eq('id', submissionId)
      .maybeSingle()
    if (sub?.student_id && sub?.assignment_id) {
      await supabase
        .from('correction_question_items')
        .update({ hint_text: guidance, updated_at: new Date().toISOString() })
        .eq('assignment_id', sub.assignment_id)
        .eq('student_id', sub.student_id)
        .eq('question_id', questionId)
        .eq('status', 'open')
    }
  } catch (err) {
    console.warn('[error_guidance] persist hint_text failed (non-fatal):', err?.message)
  }
  return {
    status: 200,
    data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ questionId, studentGuidance: guidance, mistakeType: ensureString(parsed?.mistakeType, '').trim() || undefined }) }] } }] },
    pipelineMeta: { pipeline: 'grading-error-guidance', prepareLatencyMs: 0, modelLatencyMs: Number(resp.modelLatencyMs) || 0, warnings: [], metrics: {} }
  }
}

// 2026-06-30 末端審查「人工輸入」只重批那一題：給 submissionId + questionId + studentAnswer，
//   server 端 live 抓答案卷、deterministic 可判就免 AI、否則單題 accessor。回 {score,maxScore,isCorrect,...}。
function gradeOneFailure(status, code, message) {
  return { status, data: { error: message, code }, pipelineMeta: { pipeline: 'grading-grade-one', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: { code } } }
}

export async function runGradeOneQuestion({ apiKey, model, payload = {}, routeHint = {}, internalContext = {} }) {
  const submissionId = internalContext?.submissionId || payload?.submissionId || null
  const questionId = ensureString(payload?.questionId, '').trim()
  const studentAnswer = ensureString(payload?.studentAnswer, '')
  const gradeBand = payload?.gradeBand === 'high' ? 'high' : 'k9'
  const domainHint = payload?.domain || internalContext?.domainHint || null
  if (!submissionId || !questionId) return gradeOneFailure(400, 'MISSING_PARAMS', '缺少必要參數（submissionId / questionId）')
  const cached = await loadPhaseAState(submissionId)
  const answerKey = cached?.live_answer_key
  const q = Array.isArray(answerKey?.questions)
    ? answerKey.questions.find((x) => ensureString(x?.id).trim() === questionId)
    : null
  if (!q) return gradeOneFailure(404, 'QUESTION_NOT_FOUND', '找不到該題（可能答案卷已變更）')
  const status = studentAnswer.trim() ? 'read' : 'blank'
  // 1) deterministic（選擇/判斷/可接受答案 + 整句克漏字）→ 免 AI
  let res = gradeObjectiveDeterministic(q, studentAnswer, status)
  if (!res.gradable && process.env.CLOZE_DETERMINISTIC_ENABLED !== 'false') {
    res = gradeSentenceClozeDeterministic(q, studentAnswer, status)
  }
  let scoreObj
  if (res.gradable) {
    scoreObj = { questionId, score: res.score, maxScore: res.maxScore, isCorrect: res.isCorrect, errorType: res.errorType, scoringReason: res.scoringReason, studentAnswer }
  } else {
    // 2) 單題 accessor（短答/應用題等需 AI）
    try {
      const rar = { answers: [{ questionId, studentAnswerRaw: studentAnswer, status }] }
      const prompt = buildAccessorPrompt(answerKey, rar, domainHint, gradeBand)
      const resp = await executeStage({
        apiKey, model, payload, timeoutMs: 60000, routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR,
        stageContents: [{ role: 'user', parts: [{ text: prompt }] }]
      })
      if (!resp?.ok) return gradeOneFailure(Number(resp?.status) || 503, 'AI_FAILED', '🙂 AI 剛剛有點忙、批改失敗，請再試一次。')
      const r = normalizeAccessorResult(parseCandidateJson(resp.data), answerKey, rar.answers, domainHint)
      const sc = (r.scores || []).find((s) => ensureString(s?.questionId).trim() === questionId)
      if (!sc) return gradeOneFailure(502, 'EMPTY_RESULT', 'AI 回覆為空，請再試一次。')
      const maxScore = toFiniteNumber(sc.maxScore) ?? (toFiniteNumber(q?.maxScore) ?? 0)
      scoreObj = { questionId, score: toFiniteNumber(sc.score) ?? 0, maxScore, isCorrect: sc.isCorrect === true, errorType: ensureString(sc.errorType, '').trim() || undefined, scoringReason: ensureString(sc.scoringReason, '').trim() || undefined, studentAnswer }
    } catch (e) {
      return gradeOneFailure(503, 'GRADE_ONE_FAILED', e?.message || 'grade one failed')
    }
  }
  return {
    status: 200,
    data: { candidates: [{ content: { parts: [{ text: JSON.stringify(scoreObj) }] } }] },
    pipelineMeta: { pipeline: 'grading-grade-one', prepareLatencyMs: 0, modelLatencyMs: 0, warnings: [], metrics: {} }
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

  // 國字注音 section 偵測（同 classify gzZhuyinPair）：section（去尾段共同前綴）含任一純注音正解
  // → 該 section 是國字注音題組（考國字 + 考注音 混排、同「印刷提示形式 + 手寫作答形式」版面）。
  const gzZhuyinSections = new Set()
  for (const q of keyQuestions) {
    const qid = ensureString(q?.id).trim()
    const parts = qid.split('-')
    if (parts.length < 2) continue
    if (isZhuyinAnswer(q?.answer)) gzZhuyinSections.add(parts.slice(0, -1).join('-'))
  }

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
    // map_fill 走 map-fill-grader、studentAnswer 用 grader 寫的 studentFinalAnswer
    // （不是 readAnswerResult.answers 因為 map_fill 沒進 Read）
    const isMapFillBypass = score?._mapFillBypass === true
    // VJ 視覺判斷題：不走文字 Read、studentAnswer = blank 判讀摘要（圖上作答/未作答）、並帶逐柱 vjItemResults
    const isVjBypass = score?._vjBypass === true
    // 2026-05-29 Fix A: AI 沒給 scoringReason 時、fallback 不要寫「需人工複核」
    // 改成顯示「學生答案 vs 標準答案」、讓老師一眼判斷
    const studentAnsForReason = isMapFillBypass
      ? ensureString(score?.studentFinalAnswer, '')
      : ensureString(answer?.studentAnswerRaw, '無法辨識')
    const refAnsForReason = ensureString(question?.referenceAnswer || question?.answer, '').trim()
    const fallbackWrongReason = refAnsForReason
      ? `學生答案「${studentAnsForReason}」、標準答案「${refAnsForReason}」（AI 未提供具體理由、請手動確認）`
      : `學生答案「${studentAnsForReason}」（AI 未提供具體理由、請手動確認）`

    const row = {
      questionId,
      // questionType 帶下來：前端對 map_fill 等視覺評分題型要鎖編輯欄
      questionType: classify?.questionType || question?.questionCategory || undefined,
      studentAnswer: (isMapFillBypass || isVjBypass)
        ? ensureString(score?.studentFinalAnswer, '')
        : ensureString(answer?.studentAnswerRaw, '無法辨識'),
      isCorrect: hasMismatch ? false : score?.isCorrect === true,
      score: hasMismatch ? 0 : toFiniteNumber(score?.score) ?? 0,
      maxScore: toFiniteNumber(score?.maxScore) ?? Math.max(0, toFiniteNumber(question?.maxScore) ?? 0),
      reason:
        ensureString(score?.scoringReason, '').trim() ||
        (score?.isCorrect ? '答案正確' : fallbackWrongReason),
      confidence: clampInt(score?.scoreConfidence, 0, 100, 0),
      errorType:
        ensureString(score?.errorType, '').trim() ||
        ensureString(explain?.mistakeType, '').trim() ||
        undefined,
      needExplain: score?.needExplain === true || score?.isCorrect !== true,
      studentFinalAnswer: ensureString(score?.studentFinalAnswer, '').trim() || undefined,
      // map_fill 的 per-position 細節（給前端 detail modal 顯示用）
      mapFillResults: Array.isArray(score?.mapFillResults) ? score.mapFillResults : undefined,
      // VJ 的逐柱結果（給前端 detail 顯示逐柱 + 老師逐柱改有畫/沒畫）
      vjItemResults: Array.isArray(score?.vjItemResults) ? score.vjItemResults : undefined
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
        // 2026-06-02: single_choice 選項代號跨記號等價（甲乙丙丁=①②③=ABC=數字）。
        // 修既有 norm() 漏掉「甲乙→數字 / 字母↔數字」→ 學生「乙」對正解「2」被誤判錯的真實 bug。
        // 純加分：只在 norm 比不出、但兩邊都是單一選項代號且序號相同時補判對；不會把錯的翻成對。
        // 選項是文字/多字者 canonicalOptionIndex 回 null → 不動、維持原 norm 結果。
        if (!programMatch && qCategory === 'single_choice') {
          const kIdx = canonicalOptionIndex(refAnswer)
          const sIdx = canonicalOptionIndex(studentAns)
          if (kIdx != null && sIdx != null && kIdx === sIdx) programMatch = true
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

    // ── 程式化覆核：word_problem / calculation BINARY 二元計分 ──
    // 規則（全有全無、accessor 給的 partial 一律 override）：
    //   最終答案對 + 有步驟 → 滿分
    //   最終答案對 + 空白步驟 → 0分（疑似抄答案）
    //   最終答案錯 → 0分（不論是否有步驟、不論 accessor 怎麼判）
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

        if (finalMatch && hasSteps) {
          // 最終答案對 + 有步驟 → 滿分（強制 override 任何 accessor partial）
          const prevScore = row.score
          if (row.score !== qMaxScore || row.isCorrect !== true) {
            row.isCorrect = true
            row.score = qMaxScore
            row.needExplain = false
            row.reason = `答案正確（程式比對覆核）`
            row.confidence = 100
            console.log(`[programmatic-override] ${questionId} final-answer-match + has-steps → full marks (${prevScore}→${qMaxScore})`)
          }
        } else if (finalMatch && !hasSteps) {
          // 最終答案對 + 空白步驟 → 0分（疑似抄答案）
          row.isCorrect = false
          row.score = 0
          row.needExplain = true
          row.reason = `最終答案正確但未列出計算過程（程式比對覆核）`
          row.confidence = 100
          console.log(`[programmatic-override] ${questionId} final-answer-match + blank-steps → 0`)
        } else if (!finalMatch) {
          // 最終答案錯 → 0分（binary：不論是否有步驟、不論 accessor 給多少 partial）
          const prevScore = row.score
          row.isCorrect = false
          row.score = 0
          row.needExplain = true
          row.reason = hasSteps
            ? `最終答案不符（程式比對覆核：學生 "${stuFinal}" ≠ 標準 "${refFinal}"）`
            : `答案錯誤且未列出計算過程`
          row.confidence = 100
          console.log(`[programmatic-override] ${questionId} final-answer-mismatch → 0 (hasSteps=${hasSteps}, prevScore=${prevScore})`)
        }
      }
    }

    // ── 程式化覆核：國字注音「考國字題不因印刷注音聲調誤扣」（2026-06-03）──
    // 背景：國字注音改「讀兩形式」後 read 回「國字 注音」(注音多半是印刷提示)。考國字題正解只有國字、
    //   注音不該計分；但 accessor 是 LLM、偶發脫稿去挑印刷注音的聲調判錯（畢業考全班 read 相同、
    //   27/28 判對、僅 1 人被挑注音判 0 = 抽樣樂透，prompt 壓不到 0）。
    // 為何用 accessor 的理由而非 read：read1/read2 無法分辨「國字真寫對」(座號25 羹) 與「國字寫錯但被讀寬」
    //   (座號19 窘，read1=read2=窘 但實際寫錯字)，只有看圖的 accessor 能分（25 認得國字、19 回「沒這個字」）。
    // 規則（純加分、只 wrong→correct）：gz section 的考國字題(正解非注音) + accessor 判錯 +
    //   read 的國字部分==正解(國字有讀對) + 理由是「注音/聲調」問題 + 理由無「國字錯/沒這個字」類字樣 → 翻回對。
    {
      const qParts = questionId.split('-')
      const isGzSection = qParts.length >= 2 && gzZhuyinSections.has(qParts.slice(0, -1).join('-'))
      if (isGzSection && row.isCorrect === false && refAnswer && !isZhuyinAnswer(refAnswer)) {
        const reasonText = ensureString(row.reason, '')
        const readHanzi = (ensureString(row.studentAnswer, '').match(/[一-鿿]/g) || []).join('')
        const guoziReadCorrect = readHanzi.includes(refAnswer)             // 國字有讀到正解字
        const blamesZhuyin = /注音|聲調/.test(reasonText)                   // 扣分理由提到注音/聲調
        const guoziProblem = /沒(有)?這個字|不是.{0,4}字|寫錯字|國字.{0,6}(錯|不符|不正確|有誤)|(錯|不符).{0,4}國字|國字與注音|未作答|無法辨識/.test(reasonText)
        if (guoziReadCorrect && blamesZhuyin && !guoziProblem) {
          const prev = row.score
          row.isCorrect = true
          row.score = toFiniteNumber(question?.maxScore) ?? row.maxScore
          row.needExplain = false
          row.reason = `答案正確（考國字題：國字正確即給分、印刷注音不計分；程式覆核）`
          row.confidence = 100
          console.log(`[gz-override] ${questionId} 國字「${refAnswer}」讀對、僅注音被誤扣 → 翻正 (${prev}→${row.score}) accessor理由="${reasonText.slice(0, 40)}"`)
        }
      }
    }

    // Phase A 一致性欄位（若有）
    if (consistency) {
      row.consistencyStatus = consistency.consistencyStatus
      row.readAnswer1 = consistency.readAnswer1
      row.readAnswer2 = consistency.readAnswer2
      if (consistency.finalAnswerSource) row.finalAnswerSource = consistency.finalAnswerSource
      if (consistency.framingReason) row.framingReason = consistency.framingReason
    }
    // Classify 推理摘要（v4.0 新增）— 即使沒走 phaseA 也要保留
    if (!row.framingReason && classify?.framingReason) {
      row.framingReason = classify.framingReason
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
  // 「未作答」(blank) 不再列入 reviewReasons — 學生明確沒寫、不需老師確認
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
// Dewarp（學生照片卷整平）：呼叫獨立 Python/UVDoc 微服務，把彎曲/傾斜照片拉平，
// 讓 classify 的矩形 bbox 跟得上文字行。
// ⚠️ 只對「照片」（submissionSource ≠ teacher_scan）；PDF(teacher_scan) 一律不碰。
// ⚠️ 全程 graceful：未開啟 / 無 URL / 服務失敗 / 逾時 → 回 null（呼叫端用原圖、絕不擋批改）。
// ⚠️ UVDoc 確定性（同圖同輸出）→ 拆成兩個 HTTP call 時兩邊各自整平結果一致、bbox 與 crop 對得齊。
// 回傳 { data, mimeType, pageBreaks }（整平後）或 null。
async function dewarpPhotoSubmission({ inlineData, pageBreaks, submissionSource, answerSheetMode, pipelineRunId, stagedLogLevel }) {
  const enabled = process.env.DEWARP_ENABLED === '1' || process.env.DEWARP_ENABLED === 'true'
  const url = process.env.DEWARP_URL
  if (!enabled || !url) return null
  // 只照片：PDF(teacher_scan) 與來源不明（null）一律跳過（安全預設＝不整平）
  if (!submissionSource || submissionSource === 'teacher_scan') return null
  if (!inlineData?.data) return null
  const timeoutMs = Number(process.env.DEWARP_TIMEOUT_MS) > 0 ? Number(process.env.DEWARP_TIMEOUT_MS) : 30000
  const controller = new AbortController()
  const handle = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url.replace(/\/+$/, '') + '/dewarp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_base64: inlineData.data,
        mime_type: inlineData.mimeType || 'image/webp',
        page_breaks: Array.isArray(pageBreaks) && pageBreaks.length > 0 ? pageBreaks : null
      }),
      signal: controller.signal
    })
    if (!resp.ok) {
      logStaged(pipelineRunId, 'basic', `[dewarp] 服務回 ${resp.status}、改用原圖`, { submissionSource, answerSheetMode })
      return null
    }
    const j = await resp.json()
    if (!j?.image_base64) {
      logStaged(pipelineRunId, 'basic', '[dewarp] 回應無影像、改用原圖')
      return null
    }
    logStaged(pipelineRunId, 'basic', '[dewarp] 整平完成', { ms: j.ms, pages: j.pages, newPageBreaks: j.page_breaks })
    return {
      data: j.image_base64,
      mimeType: j.mime_type || 'image/webp',
      pageBreaks: Array.isArray(j.page_breaks) ? j.page_breaks : (Array.isArray(pageBreaks) ? pageBreaks : [])
    }
  } catch (e) {
    logStaged(pipelineRunId, 'basic', '[dewarp] 失敗、改用原圖（graceful）', { error: e?.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e?.message })
    return null
  } finally {
    clearTimeout(handle)
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
  // 2026-05-17: 拆 phase A 成 3 個 HTTP call、各吃自己的 300s budget：
  //   1. phase_a_classify（payload.stopAfterClassify=true）：OCR + classify + bbox post-process、回 _phaseAClassifyContext
  //   2. phase_a（payload._phaseAClassifyContext 帶入 + phaseAStopBeforeArbiter=true）：跳 classify、做 crop + read + pre-overrides、回 _phaseAReadContext
  //   3. phase_a_arbiter（payload._phaseAReadContext 帶入）：AI3 + 最終 build
  // 拆 read 出來是因為 5 並行 Vertex 變慢、AI1 偶爾飆 197s 撞 290s budget；獨立 300s 後絕對跑得完。
  const stopAfterClassify = payload?.stopAfterClassify === true
  const stopBeforeArbiter = payload?.phaseAStopBeforeArbiter === true
  const precomputedClassifyContext = payload?._phaseAClassifyContext || internalContext?._phaseAClassifyContext || null
  // 2026-06-20 ②: 只重跑指定頁的 classify（partial rerun、省成本）。
  //   用獨立 key rerunClassifyPriorContext（不可用 _phaseAClassifyContext、那會觸發上面的 precomputed-skip）。
  //   非重跑頁沿用 prior 的 alignedQuestions（已全圖座標+後處理）、只 AI 重跑指定頁再併回。
  const rerunPageNums = Array.isArray(payload?.rerunPageNums)
    ? payload.rerunPageNums.map(Number).filter((n) => Number.isFinite(n))
    : null
  const rerunPriorAligned = payload?.rerunClassifyPriorContext?.classifyResult?.alignedQuestions
  const isPartialRerun = !!(rerunPageNums && rerunPageNums.length > 0 && Array.isArray(rerunPriorAligned) && rerunPriorAligned.length > 0)
  const pipelineRunId = precomputedClassifyContext?.pipelineRunId
    || createPipelineRunId(internalContext?.requestId)
  // 2026-05-21: model 分流移到 executeStage 內統一查 STAGE_MODEL[routeKey]
  // 舊 STAGED_READ_MODEL_OVERRIDE env var 已拔除（改用 model-config.js）
  // readModel 變數保留供 applyMathEqBlankOverride 等非 executeStage 路徑用
  const readModel = STAGE_MODEL[AI_ROUTE_KEYS.GRADING_READ_ANSWER]
  // 2026-06-02: 國語卷 read 改走 PRO。FLASH 對手寫複雜國字(國字注音)會幻覺(籌→寺/費、棘→束、窘→牠)、
  // 害 read1≠read2 大量假性 NR(實證 exp-repro-read)；PRO 讀字大幅改善。其他科目維持 FLASH。
  // 單選題已 bypass Accessor、Phase B token 不受影響。MODEL_PRO=3.5-flash(非舊 3.1-pro、無整份判 blank 問題)。
  const readDomainIsMandarin = (ensureString(internalContext?.domainHint, '')).includes('國語')
  const readModelOverride = readDomainIsMandarin ? MODEL_PRO : undefined
  logStaged(pipelineRunId, 'basic', `[A2] read stage model=${readModelOverride || readModel}${readModelOverride ? '（國語卷→PRO）' : '（model-config）'}`)

  // 2026-05-17: 「重新截取」清空模式——僅在 classify call 觸發、清掉 submissions 表上的 phase_a_state /
  // final_answers / grading_result / score 等舊資料（stage_logs 保留 audit）
  if (stopAfterClassify && payload?.clearForRerun === true) {
    const submissionIdToClear = internalContext?.submissionId || payload?.submissionId
    if (submissionIdToClear) {
      console.log(`[PhaseA-classify][${pipelineRunId}] clearForRerun=true、清空 submission=${submissionIdToClear} 舊資料`)
      await clearPhaseAState(submissionIdToClear)
    }
  }
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
  const submissionSource = payload?.submissionSource || internalContext?.submissionSource || null
  logStaged(pipelineRunId, stagedLogLevel, `PhaseA begin model=${model} questionCount=${questionIds.length} answerKeyPages=${answerKeyImageParts.length} answerSheetMode=${answerSheetMode} submissionSource=${submissionSource || 'unset'}`)
  // 2026-05-17: 中文 log——讓人在 Vercel log stream 一眼掃到階段邊界
  const modeLabel = stopAfterClassify
    ? '只跑 classify、跑完早退'
    : precomputedClassifyContext
      ? `跳過 classify（用傳入的 _phaseAClassifyContext）、${stopBeforeArbiter ? '跑完 read 後早退' : '一氣跑到底'}`
      : stopBeforeArbiter
        ? '跑完 read 後早退'
        : '一氣跑到底'
  // 2026-05-21: 印每個 stage 實際用的 model（不是 client placeholder）
  const classifyModel = resolveStageModel(AI_ROUTE_KEYS.GRADING_CLASSIFY)
  const readModelLabel = resolveStageModel(AI_ROUTE_KEYS.GRADING_DETAIL_READ)
  const arbiterModelLabel = resolveStageModel(AI_ROUTE_KEYS.GRADING_ARBITER)
  logStaged(pipelineRunId, 'basic',
    `[A1] 進場 題目數=${questionIds.length} 模式=${answerSheetMode} 拆解模式=${modeLabel}\n` +
    `  classify=${classifyModel} read=${readModelLabel} arbiter=${arbiterModelLabel}`)

  const stageResponses = []
  const stageWarnings = []
  const pipelineStartedAt = Date.now()
  // 2026-05-17: 250→290s。Vercel function maxDuration=300s、留 10s 給 response handling
  // 原 250s 在 Pro 3.1 + math-eq-blank + read parallel 後、AI3-arbiter 跑不到、fallback 純字串比對
  // 拉到 290s 後、AI3 有 ~40s LLM 語意比對空間
  const PIPELINE_BUDGET_MS = 290_000
  const getRemainingBudget = () => Math.max(1000, PIPELINE_BUDGET_MS - (Date.now() - pipelineStartedAt))

  // Build a failure-return payload when retry exhausted at any FAIL gate.
  // Returns shape compatible with normal success return (questionResults=[] so
  // frontend `.filter()` won't crash; pipelineFailure signals to skip Phase B).
  //
  // 🆕 失敗時也寫 stage_logs（含 ocrAssistMeta.classifyBboxes）、讓 admin 之後能
  // 視覺化看「被拒絕的 bbox 長甚麼樣」、debug 哪條 quality gate 觸發。
  const buildFailureReturn = async (stage, qgResults, extra) => {
    const failure = buildPipelineFailure(stage, qgResults)
    logStaged(pipelineRunId, 'basic', `PhaseA FAIL at ${stage} (retry exhausted)`, failure)
    // 失敗時也寫 stage_log、保留 classify bboxes 供事後 debug / 視覺化
    // 2026-05-17: 改 await — fire-and-forget 在 Vercel function 提早 return 時、
    // process 被 terminate、insert promise 來不及落地（學生 3/5 失敗無 row）。
    if (internalContext?.ownerId) {
      try {
        const extractAnswers = (result) => {
          const answers = Array.isArray(result?.answers) ? result.answers : []
          return answers.map((a) => ({
            questionId: a.questionId,
            status: a.status,
            answer: a.studentAnswerRaw || a.studentAnswer || ''
          }))
        }
        // 2026-05-25: classify 失敗時保留 alignedQuestions 摘要、之後 admin / dev 直接從 DB 看
        // 不存完整 bbox（省空間）、只存 questionId + visible + questionType + 來源
        const cr = extra?.classifyResult
        const alignedSummary = cr && Array.isArray(cr.alignedQuestions)
          ? cr.alignedQuestions.map((q) => ({
              questionId: q.questionId,
              visible: !!q.visible,
              questionType: q.questionType,
              framingReason: q.framingReason,
              hasAnswerBbox: !!q.answerBbox
            }))
          : null
        const failureLogData = {
          pipelineFailure: failure,
          failedAtStage: stage,
          classify: {
            ocrAssist: typeof ocrAssistMeta !== 'undefined' && ocrAssistMeta?.perPage?.length > 0 ? ocrAssistMeta : null,
            qualityGate: { severity: 'fail', warnings: failure.technical?.warnings, metrics: failure.technical?.metrics },
            alignedQuestions: alignedSummary
          },
          // 2026-05-17: read FAIL 時保留 AI1 / AI2 答案、之後可撈出來查 disagreement 來源
          read_answer_1: extra?.readAnswerResult ? extractAnswers(extra.readAnswerResult) : null,
          read_answer_2: extra?.reReadAnswerResult ? extractAnswers(extra.reReadAnswerResult) : null
        }
        await saveGradingStageLog({
          ownerId: internalContext.ownerId,
          assignmentId: internalContext.assignmentId || payload?.assignmentId || '',
          submissionId: internalContext.submissionId || payload?.submissionId || '',
          pipelineRunId,
          phase: 'phase_a',
          model,
          logData: failureLogData
        })
      } catch (e) {
        logStaged(pipelineRunId, 'basic', 'failure stage_log write failed (non-fatal)', { error: e?.message })
      }
    }
    return {
      phaseAComplete: false,
      pipelineFailure: failure,
      questionResults: [],
      stableCount: 0,
      diffCount: 0,
      unstableCount: 0,
      needsReviewCount: 0
    }
  }

  // 2026-05-17: HTTP error wrapper — 把模型 HTTP error (400/503/504) 包成 pipelineFailure
  // 解決前端只看到 generic「批改失敗」、看不到具體原因（如 Pro 不支援 thinking_level）
  const buildHttpErrorReturn = async (stage, response) => {
    const status = Number(response?.status) || 500
    const dataPreview = JSON.stringify(response?.data || {}).slice(0, 300)
    // 2026-05-21: 用 stage 實際 model（response.stageModel）、不是外層 phase_a 的 model
    const stageModel = response?.stageModel || model
    // 2026-06-20: 老師看的文案統一友善化（① AI 暫時出錯/忙線）、技術詞(狀態碼)不外露；
    //   reasonCode 仍依狀態保留、連同 httpStatus 進 technical 供除錯（400=config bug、504=timeout…）。
    let reasonCode
    if (status === 400) reasonCode = 'MODEL_400_BAD_REQUEST'
    else if (status === 503) reasonCode = 'MODEL_503_OVERLOAD'
    else if (status === 504 || status === 408) reasonCode = 'MODEL_TIMEOUT'
    else if (status === 429) reasonCode = 'MODEL_RATE_LIMIT'
    else reasonCode = `MODEL_HTTP_${status}`
    const userMessage = '🙂 AI 剛剛有點忙、出了點小差錯。再請它批一次，通常就好了。'
    const userAction = ''
    const failure = {
      stage,
      reasonCode,
      userMessage,
      userAction,
      technical: { httpStatus: status, model: stageModel, dataPreview }
    }
    logStaged(pipelineRunId, 'basic', `PhaseA HTTP ERROR at ${stage}`, failure)
    if (internalContext?.ownerId) {
      try {
        await saveGradingStageLog({
          ownerId: internalContext.ownerId,
          assignmentId: internalContext.assignmentId || payload?.assignmentId || '',
          submissionId: internalContext.submissionId || payload?.submissionId || '',
          pipelineRunId,
          phase: 'phase_a',
          model,
          logData: { pipelineFailure: failure, failedAtStage: stage }
        })
      } catch (e) {
        logStaged(pipelineRunId, 'basic', 'HTTP-error stage_log write failed', { error: e?.message })
      }
    }
    return {
      phaseAComplete: false,
      pipelineFailure: failure,
      questionResults: [],
      stableCount: 0, diffCount: 0, unstableCount: 0, needsReviewCount: 0
    }
  }

  // ── A1: CLASSIFY (含 answerBbox) ─────────────────────────────────────────
  // 2026-05-17: 提升 4 個變數到 if-block 外、讓「跳過 classify (precomputedClassifyContext)」路徑也能設定
  let classifyResult
  let classifyAligned
  let totalPages
  let ocrAssistMeta = { enabled: false, perPage: [] }

  const answerKeyQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  // 2026-05-18: 提前定義 akByIdForLog 到 function-scope；
  // 之前只在 classify 區塊（line ~5929）定義、Phase A 拆 call 後跳過 classify 的路徑
  // 後續 E↔F 模糊偵測 (line 6870) 會 throw ReferenceError 整個 phase-a crash
  const akByIdForLog = mapByQuestionId(answerKeyQuestions, (item) => item?.id)
  let pageBreaks = Array.isArray(payload?.pageBreaks) ? payload.pageBreaks : []
  // Fallback: if pageBreaks is empty but questionIds have multi-page prefixes (1-*, 2-*, 3-*, ...),
  // estimate equal-split pageBreaks so per-page classify can still work.
  //
  // ⚠️ 跳過條件（任一成立都跳過 ID 自動切頁）：
  //   1. answer_only 模式：ID 第一位是 section（不是 page）、整張卷在同一張圖
  //   2. assignment.total_pages === 1：明確說此 assignment 只 1 頁、ID 第一位是 section
  //
  // Bug 紀錄：物理 + U6（單頁 4 section ID 1-x/2-x/3-x/4-x）會被誤切成 4 個 strip、
  //          Section 二/三 跨頁邊界、classify 看到的 image piece 跟 input questions 不對應。
  const assignmentTotalPages = internalContext?.assignmentTotalPages
  const isSinglePagePhysical = answerSheetMode === 'answer_only' || assignmentTotalPages === 1
  if (pageBreaks.length === 0 && !isSinglePagePhysical) {
    // 2026-05-28: 智慧 fallback — 用 answer_key_templates.page_orientations 算真實切點
    // 修法動機：吳老師數練 p51-53 case、page 1 直拍 + page 2 橫拍 → 真實 pageBreaks=[0.665]、
    // 但 sync 把 pageBreaks 從 Dexie 洗掉、client 傳 empty、舊 fallback 用 equal split [0.5]
    // → page 1 sub-image 切到 y=0.5 但實際 page 1 占到 y=0.665 → 1-2-2 被切到 page 2 sub-image → invisible
    let smartPageBreaks = []
    const assignmentIdForLookup = internalContext?.assignmentId || payload?.assignmentId
    if (assignmentIdForLookup) {
      try {
        const supabase = getSupabaseAdmin()
        const { data: assignmentRow } = await supabase
          .from('assignments')
          .select('answer_key_template_id')
          .eq('id', assignmentIdForLookup)
          .single()
        if (assignmentRow?.answer_key_template_id) {
          const { data: tpl } = await supabase
            .from('answer_key_templates')
            .select('page_orientations')
            .eq('id', assignmentRow.answer_key_template_id)
            .single()
          const orientations = tpl?.page_orientations
          if (Array.isArray(orientations) && orientations.length > 1) {
            // A4 標準：portrait aspect (寬:高) ≈ 1:1.41、landscape ≈ 1.41:1
            // 各頁 scale 到 merged 圖 width 後高度比例：portrait≈1.41、landscape≈0.71
            const ratios = orientations.map(o => o === 'portrait' ? 1.41 : 0.71)
            const total = ratios.reduce((a, b) => a + b, 0)
            let cumul = 0
            for (let i = 0; i < ratios.length - 1; i++) {
              cumul += ratios[i]
              smartPageBreaks.push(+(cumul / total).toFixed(4))
            }
            logStaged(pipelineRunId, 'basic',
              `[pageBreaks] smart fallback from page_orientations=${JSON.stringify(orientations)} → ${JSON.stringify(smartPageBreaks)}`)
          }
        }
      } catch (err) {
        console.warn(`[PhaseA][${pipelineRunId}] pageBreaks smart fallback failed:`, err?.message)
      }
    }

    if (smartPageBreaks.length > 0) {
      pageBreaks = smartPageBreaks
    } else {
      // 舊行為（equal split）— 智慧 fallback 拿不到 orientations 時的最後保險
      const pageNums = new Set()
      for (const id of questionIds) {
        const m = id.match(/^(\d+)-/)
        if (m) pageNums.add(parseInt(m[1], 10))
      }
      const maxPage = pageNums.size > 0 ? Math.max(...pageNums) : 1
      if (maxPage >= 2) {
        pageBreaks = Array.from({ length: maxPage - 1 }, (_, i) => +((i + 1) / maxPage).toFixed(4))
        logStaged(pipelineRunId, stagedLogLevel, 'pageBreaks auto-estimated (equal split fallback)', { maxPage, pageBreaks })
      }
    }
  }
  if (isSinglePagePhysical) {
    logStaged(pipelineRunId, stagedLogLevel, 'pageBreaks skipped (single-page assignment)', {
      reason: answerSheetMode === 'answer_only' ? 'answer_only_mode' : 'total_pages_eq_1',
      assignmentTotalPages
    })
  }
  // ── Dewarp 整平（只照片、env-gated、graceful）──────────────────────────────
  // 放在 pageBreaks 解析後、classify / precomputed 分支前 → call1(classify) 與 call2(crop+read)
  // 都會跑到、且 UVDoc 確定性 → 兩 call 得到一致整平圖、classify bbox 與後續 crop 對得齊。
  // 成功則「替換」inlineImages[0] 為整平圖、pageBreaks 改用整平後的新邊界；失敗回 null 用原圖。
  // PDF(teacher_scan) 在 helper 內被擋掉、完全不影響 PDF 流程。
  {
    const _dw = await dewarpPhotoSubmission({
      inlineData: inlineImages[0].inlineData,
      pageBreaks,
      submissionSource,
      answerSheetMode,
      pipelineRunId,
      stagedLogLevel
    })
    if (_dw) {
      inlineImages[0].inlineData = { data: _dw.data, mimeType: _dw.mimeType }
      pageBreaks = _dw.pageBreaks
    }
  }

  const classifyCorrections = Array.isArray(payload?.classifyCorrections) ? payload.classifyCorrections : []
  if (classifyCorrections.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'classify corrections received', classifyCorrections)
  }
  const classifyQuestionSpecs = buildClassifyQuestionSpecs(questionIds, answerKeyQuestions, answerSheetMode)

  // 2026-05-17: 拆 classify 出獨立 HTTP call — 若 client 帶 _phaseAClassifyContext、
  // 直接 reuse 前一階段的 classifyResult、跳過整段 OCR + classify + bbox 後處理 + QG。
  if (precomputedClassifyContext) {
    classifyResult = precomputedClassifyContext.classifyResult
    classifyAligned = classifyResult?.alignedQuestions || []
    totalPages = precomputedClassifyContext.totalPages || 1
    ocrAssistMeta = precomputedClassifyContext.ocrAssistMeta || { enabled: false, perPage: [] }
    logStaged(pipelineRunId, 'basic', `[A1] 跳過 OCR + classify、用前一階段傳入的 _phaseAClassifyContext (題目=${classifyAligned.length} 頁=${totalPages})`)
  } else {
  // 🆕 OCR-assist metadata 收集（用於 stage_logs 寫入）
  // Schema: { enabled: bool, perPage: [{ page, stats, candidates }] }
  // 2026-05-17: 從 const 改 reassign（hoisted at top of A1）
  ocrAssistMeta = { enabled: isOcrAssistEnabled(), perPage: [] }
  logStaged(pipelineRunId, 'basic', 'OCR-assist init', {
    enabled: ocrAssistMeta.enabled,
    answerSheetMode
  })

  // Build per-page question groups
  // ⚠️ 單頁多 section 卷（answer_only 或 total_pages=1）強制歸到 page 1：
  //    ID 第一位是 section 不是 page、整張卷在同一張圖、不能按 ID 切。
  const pageQuestionsMap = new Map()
  if (isSinglePagePhysical) {
    pageQuestionsMap.set(1, [...questionIds])
  } else {
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
  }
  const pageEntries = [...pageQuestionsMap.entries()]
    .filter(([, ids]) => ids.length > 0)
    .sort(([a], [b]) => a - b)

  // classifyResult hoisted to A1 top
  // Per-page classify: one call per page, all dispatched in parallel.

  logStageStart(pipelineRunId, 'classify')
  logStaged(pipelineRunId, stagedLogLevel, 'classify per-page plan', {
    numPages: pageEntries.length,
    answerKeyPages: answerKeyImageParts.length,
    pages: pageEntries.map(([p, ids]) => ({ page: p, count: ids.length }))
  })

  if (isPartialRerun && pageEntries.length > 1) {
    // ── ② PARTIAL_RERUN：只 AI 重跑 rerunPageNums 指定的頁、其餘頁沿用 prior context ──
    // 自成一體、不碰下面 single/multi-page 兩條既有路徑。用於 peer 偵測到「某頁 off-by-one」時只重擲那頁、
    // 省掉重跑其他 3 頁 classify 的成本。座標仍 AI 自產（只重 AI 該頁、非外部覆寫）。
    logStaged(pipelineRunId, 'basic', 'classify path = PARTIAL_RERUN (②)', { rerunPageNums, priorCount: rerunPriorAligned.length })
    const submissionImg = inlineImages[0].inlineData
    const splitPages = await splitSubmissionImageByPageBreaks(submissionImg.data, submissionImg.mimeType, pageBreaks)
    if (!splitPages || splitPages.length !== pageEntries.length) {
      throw new Error(`PARTIAL_RERUN split mismatch: got ${splitPages?.length}, expected ${pageEntries.length}`)
    }
    const freshResponses = await Promise.all(pageEntries.map(([pageNum, ids], i) => {
      if (!rerunPageNums.includes(pageNum)) return null
      const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
      const prompt = buildClassifyPrompt(ids, specs, [], 0, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
      return executeStage({
        apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
        stageContents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: splitPages[i].inlineData }] }]
      })
    }))
    freshResponses.forEach((resp, i) => {
      if (!resp) return
      logStageEnd(pipelineRunId, `classify-rerun-p${pageEntries[i][0]}`, resp)
      stageResponses.push(resp)
    })
    const failedResp = freshResponses.find((r) => r && !r.ok)
    if (failedResp) {
      return {
        status: failedResp.status, data: failedResp.data,
        pipelineMeta: { pipeline: STAGED_PIPELINE_NAME, prepareLatencyMs: failedResp.prepareLatencyMs, modelLatencyMs: failedResp.modelLatencyMs, warnings: failedResp.warnings, metrics: { stage: 'classify' } }
      }
    }
    // 從 prior（全圖座標、已後處理）做底、把重跑頁的題覆蓋上去
    const byId = new Map(rerunPriorAligned.map((q) => [q.questionId, q]))
    freshResponses.forEach((resp, i) => {
      if (!resp) return
      const parsed = parseCandidateJson(resp.data)
      if (!parsed || typeof parsed !== 'object') throw new Error(`PARTIAL_RERUN parse failed p${pageEntries[i][0]}`)
      const ids = pageEntries[i][1]
      const norm = decorateClassifyWithDiagnostics(normalizeClassifyResult(parsed, ids), akByIdForLog)
      const classifyBboxesBefore = norm.alignedQuestions
        .filter((q) => q.answerBbox)
        .map((q) => ({ qid: q.questionId, bbox: { x: +q.answerBbox.x.toFixed(3), y: +q.answerBbox.y.toFixed(3), w: +q.answerBbox.w.toFixed(3), h: +q.answerBbox.h.toFixed(3) } }))
      ocrAssistMeta.perPage.push({ page: pageEntries[i][0], stats: { partialRerun: true }, candidates: {}, classifyBboxes: classifyBboxesBefore })
      const { pageStartY, pageEndY } = splitPages[i]
      for (const q of norm.alignedQuestions) {
        if (q.answerBbox) q.answerBbox = remapBboxToFullImage(q.answerBbox, pageStartY, pageEndY)
        if (q.questionBbox) q.questionBbox = remapBboxToFullImage(q.questionBbox, pageStartY, pageEndY)
        if (q.bracketBbox) q.bracketBbox = remapBboxToFullImage(q.bracketBbox, pageStartY, pageEndY)
        byId.set(q.questionId, q)
      }
    })
    const mergedAligned = questionIds.map((id) => byId.get(id) ?? { questionId: id, visible: false, questionType: 'fill_blank' })
    classifyResult = applyClassifyQuestionSpecs({
      alignedQuestions: mergedAligned,
      coverage: questionIds.length === 0 ? 0 : mergedAligned.filter((q) => q.visible).length / questionIds.length,
      unmappedQuestionIds: [],
      pixelBboxRejected: []
    }, classifyQuestionSpecs)
    // 注意：partial rerun 刻意不跑 math-eq-blank crop override（省成本；prior 已對非重跑頁套過、
    //   罕見的重跑頁 math 題由雙讀/複核兜底）。
  } else if (pageEntries.length <= 1) {
    // Single page (or all questions share one page) — one call
    const ids = pageEntries.length === 0 ? questionIds : pageEntries[0][1]
    const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
    let classifyPrompt = buildClassifyPrompt(ids, specs, pageBreaks, 0, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
    logStaged(pipelineRunId, 'basic', 'classify path = ELSE.SINGLE_PAGE (will check OCR-assist)', { questionCount: ids.length, ocrAssistEnabled: isOcrAssistEnabled() })
    // ── OCR-assisted classify (feature-flagged) ──
    // 對 inline answer types (fill_blank/multi_fill/...) 注入 OCR-matched candidate bbox 當 anchor。
    // 失敗 graceful：OCR 掛 / 超時 / 無 candidate → extraSection 為空、走純視覺 classify。
    if (isOcrAssistEnabled()) {
      try {
        logStaged(pipelineRunId, 'basic', 'OCR-assist single-page: calling prepareOcrHintsForClassify')
        const ocrAssist = await prepareOcrHintsForClassify({
          imageBytes: Buffer.from(inlineImages[0].inlineData.data, 'base64'),
          mimeType: inlineImages[0].inlineData.mimeType,
          answerKeyQuestions: answerKeyQuestions.filter(q => ids.includes(q?.id)),
          answerSheetMode
        })
        if (ocrAssist.extraSection) classifyPrompt = `${classifyPrompt}\n\n${ocrAssist.extraSection}`
        logStaged(pipelineRunId, 'basic', 'OCR-assist single-page: completed', ocrAssist.stats)
        // 🆕 收進 stage_logs metadata（含 imageSize 供 post-classify override 使用）
        ocrAssistMeta.perPage.push({ page: 1, stats: ocrAssist.stats, candidates: ocrAssist.candidatesByQid, rowAnchorBboxes: ocrAssist.rowAnchorBboxes || null, imageSize: ocrAssist.ocrResult?.image_size })
        logStaged(pipelineRunId, 'basic', 'OCR-assist single-page: pushed perPage', { perPageLen: ocrAssistMeta.perPage.length })
      } catch (ocrErr) {
        logStaged(pipelineRunId, 'basic', 'OCR-assist single-page: ERROR → fallback', { error: ocrErr?.message, stack: ocrErr?.stack?.split('\n').slice(0, 3).join(' | ') })
        ocrAssistMeta.perPage.push({ page: 1, stats: { error: ocrErr?.message } })
      }
    } else {
      logStaged(pipelineRunId, 'basic', 'OCR-assist single-page: SKIPPED (isOcrAssistEnabled=false)')
    }
    const classifyResponse = await executeStage({
      apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
      stageContents: [{ role: 'user', parts: [{ text: classifyPrompt }, ...submissionImageParts] }]
    })
    logStageEnd(pipelineRunId, 'classify-p1', classifyResponse)
    stageResponses.push(classifyResponse)
    if (!classifyResponse.ok) {
      return buildHttpErrorReturn('classify', classifyResponse)
    }
    if (classifyResponse.warnings.length > 0) stageWarnings.push(...classifyResponse.warnings.map((w) => `[classify-p1] ${w}`))
    const classifyParsed = parseCandidateJson(classifyResponse.data)
    if (!classifyParsed || typeof classifyParsed !== 'object') throw new Error('PhaseA classify parse failed')
    classifyResult = applyClassifyQuestionSpecs(normalizeClassifyResult(classifyParsed, ids), classifyQuestionSpecs)
    decorateClassifyWithDiagnostics(classifyResult, akByIdForLog)
    // 🆕 無條件保存 classify 原始 bbox（不論 OCR-assist 有沒有跑）
    // 之前只在 OCR-assist 有 match 時才保存、導致 admin dashboard 沒 OCR 就看不到 bbox
    const classifyBboxesBefore = classifyResult.alignedQuestions
      .filter(q => q.answerBbox)
      .map(q => ({ qid: q.questionId, bbox: { x: +q.answerBbox.x.toFixed(3), y: +q.answerBbox.y.toFixed(3), w: +q.answerBbox.w.toFixed(3), h: +q.answerBbox.h.toFixed(3) } }))
    // 確保 perPage[0] 存在（OCR-assist 關掉時也要寫 bbox）
    if (!ocrAssistMeta.perPage[0]) {
      ocrAssistMeta.perPage[0] = { page: 1, stats: { skipped: 'feature_flag_off' }, candidates: {} }
    }
    ocrAssistMeta.perPage[0].classifyBboxes = classifyBboxesBefore

    // 🆕 Row anchor full-replace override（single_choice/multi_choice/true_false）
    // 跟 candidatesByQid 走的 adjust override 不同：row anchor 是「OCR 鎖題號 row、bbox 全替換」、
    // 信任度高、不做 narrow / x-shift 判斷。詳見 bbox-row-anchor-match.js
    const rowAnchorBboxes = ocrAssistMeta.perPage[0]?.rowAnchorBboxes
    if (rowAnchorBboxes && Object.keys(rowAnchorBboxes).length > 0) {
      const { alignedQuestions: rowOverriddenQs, overrides: rowOverrides, rejected: rowRejected } = applyRowAnchorOverride(
        classifyResult.alignedQuestions, rowAnchorBboxes
      )
      if (rowOverrides.length > 0) {
        classifyResult = { ...classifyResult, alignedQuestions: rowOverriddenQs }
        logStaged(pipelineRunId, stagedLogLevel, 'classify row-anchor override (single-page)', { count: rowOverrides.length, samples: rowOverrides.slice(0, 5) })
      }
      if (rowRejected && rowRejected.length > 0) {
        logStaged(pipelineRunId, 'basic', 'classify row-anchor REJECTED (y_diff too large、可能 OCR 誤匹配同 N 不同 section)', { count: rowRejected.length, samples: rowRejected.slice(0, 5) })
      }
      ocrAssistMeta.perPage[0].rowAnchorOverrides = rowOverrides
      ocrAssistMeta.perPage[0].rowAnchorRejected = rowRejected || []
    }

    // 🆕 math 算式 □ AI override v2 (crop-based)：對 hint 含「算式」+「□」的 qids
    // 用 classify bbox.y crop 該題附近（y±0.03）、送 Pro 3.1 找精準 □ 位置
    try {
      const submissionImg = inlineImages[0].inlineData
      const { alignedQuestions: mathOverriddenQs, overrides: mathOverrides } = await applyMathEqBlankOverride(
        classifyResult.alignedQuestions,
        { mimeType: submissionImg.mimeType, data: submissionImg.data },
        answerKey,
        { model, apiKey, logger: (msg) => logStaged(pipelineRunId, stagedLogLevel, msg) }
      )
      if (mathOverrides.length > 0) {
        classifyResult = { ...classifyResult, alignedQuestions: mathOverriddenQs }
        logStaged(pipelineRunId, stagedLogLevel, 'classify math-eq-blank override v2 (single-page)', { count: mathOverrides.length, samples: mathOverrides.slice(0, 3) })
        ocrAssistMeta.perPage[0].mathEqBlankOverrides = mathOverrides
      }
    } catch (e) {
      logStaged(pipelineRunId, stagedLogLevel, 'math-eq-blank v2 single-page failed (non-fatal)', { error: e?.message })
    }
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
      // ── OCR-assisted classify (feature-flagged) — 整張圖 OCR 一次、每 page 獨立 filter candidates ──
      // 注意：split 失敗時整張圖可能超過 4000px，OCR 解析度會降，但仍可作位置 anchor。
      logStaged(pipelineRunId, 'basic', 'classify path = ELSE.MULTI_PAGE_FALLBACK (split failed)', { ocrAssistEnabled: isOcrAssistEnabled() })
      const fallbackOcrAssistFull = isOcrAssistEnabled()
        ? await prepareOcrHintsForClassify({
            imageBytes: Buffer.from(inlineImages[0].inlineData.data, 'base64'),
            mimeType: inlineImages[0].inlineData.mimeType,
            answerKeyQuestions: answerKeyQuestions,
            answerSheetMode
          }).catch(e => {
            logStaged(pipelineRunId, 'basic', 'OCR-assist fallback: ERROR', { error: e?.message, stack: e?.stack?.split('\n').slice(0, 3).join(' | ') })
            return { extraSection: '', stats: { error: e?.message } }
          })
        : null
      if (!isOcrAssistEnabled()) logStaged(pipelineRunId, 'basic', 'OCR-assist fallback: SKIPPED (isOcrAssistEnabled=false)')
      if (fallbackOcrAssistFull) {
        logStaged(pipelineRunId, stagedLogLevel, 'classify OCR-assist (fallback full image)', fallbackOcrAssistFull.stats)
        // 🆕 收進 stage_logs metadata（含 imageSize）
        ocrAssistMeta.perPage.push({
          page: 0, // 0 表示「整張圖」
          stats: fallbackOcrAssistFull.stats || {},
          candidates: fallbackOcrAssistFull.candidatesByQid || {},
          rowAnchorBboxes: fallbackOcrAssistFull.rowAnchorBboxes || null,
          imageSize: fallbackOcrAssistFull.ocrResult?.image_size
        })
      }
      const classifyResponses = await Promise.all(
        pageEntries.map(([, ids]) => {
          const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
          let prompt = buildClassifyPrompt(ids, specs, pageBreaks, 0, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
          // 每頁 filter 自己的 questions、整張圖 OCR 共用、用 buildOcrHintsSection 統一渲染（含 padding）
          if (fallbackOcrAssistFull?.candidatesByQid && fallbackOcrAssistFull?.ocrResult) {
            const pageHints = {}
            for (const qid of ids) if (fallbackOcrAssistFull.candidatesByQid[qid]) pageHints[qid] = fallbackOcrAssistFull.candidatesByQid[qid]
            if (Object.keys(pageHints).length > 0) {
              const hintsSection = buildOcrHintsSection(pageHints, fallbackOcrAssistFull.ocrResult.image_size)
              if (hintsSection) prompt = `${prompt}\n\n${hintsSection}`
            }
          }
          return executeStage({
            apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
            stageContents: [{ role: 'user', parts: [{ text: prompt }, ...submissionImageParts] }]
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
      const normalizedResults = pageEntries.map(([, ids], i) => decorateClassifyWithDiagnostics(normalizeClassifyResult(parsedResults[i], ids), akByIdForLog))
      const byId = new Map(normalizedResults.flatMap((n) => n.alignedQuestions).map((q) => [q.questionId, q]))
      const mergedAligned = questionIds.map((id) => byId.get(id) ?? { questionId: id, visible: false, questionType: 'fill_blank' })
      classifyResult = applyClassifyQuestionSpecs({
        alignedQuestions: mergedAligned,
        coverage: questionIds.length === 0 ? 0 : mergedAligned.filter((q) => q.visible).length / questionIds.length,
        unmappedQuestionIds: normalizedResults.flatMap((n) => n.unmappedQuestionIds),
        pixelBboxRejected: normalizedResults.flatMap((n) => n.pixelBboxRejected ?? [])
      }, classifyQuestionSpecs)
      // 🆕 無條件保存 classify 原始 bbox（multi-page fallback path、整張圖座標）
      const classifyBboxesBefore = classifyResult.alignedQuestions
        .filter(q => q.answerBbox)
        .map(q => ({ qid: q.questionId, bbox: { x: +q.answerBbox.x.toFixed(3), y: +q.answerBbox.y.toFixed(3), w: +q.answerBbox.w.toFixed(3), h: +q.answerBbox.h.toFixed(3) } }))
      let fallbackMeta = ocrAssistMeta.perPage.find(p => p.page === 0)
      if (!fallbackMeta) {
        fallbackMeta = { page: 0, stats: { skipped: 'feature_flag_off' }, candidates: {} }
        ocrAssistMeta.perPage.push(fallbackMeta)
      }
      fallbackMeta.classifyBboxes = classifyBboxesBefore

      // 🆕 Row anchor full-replace override（multi-page fallback path）
      if (fallbackMeta.rowAnchorBboxes && Object.keys(fallbackMeta.rowAnchorBboxes).length > 0) {
        const { alignedQuestions: rowOverriddenQs, overrides: rowOverrides, rejected: rowRejected } = applyRowAnchorOverride(
          classifyResult.alignedQuestions, fallbackMeta.rowAnchorBboxes
        )
        if (rowOverrides.length > 0) {
          classifyResult = { ...classifyResult, alignedQuestions: rowOverriddenQs }
          logStaged(pipelineRunId, stagedLogLevel, 'classify row-anchor override (multi-page fallback)', { count: rowOverrides.length, samples: rowOverrides.slice(0, 5) })
        }
        if (rowRejected && rowRejected.length > 0) {
          logStaged(pipelineRunId, 'basic', 'classify row-anchor REJECTED (multi-page fallback)', { count: rowRejected.length, samples: rowRejected.slice(0, 5) })
        }
        fallbackMeta.rowAnchorOverrides = rowOverrides
        fallbackMeta.rowAnchorRejected = rowRejected || []
      }
    } else {
      // Success: each page gets its own cropped image — no pageBreaks needed in prompt
      logStaged(pipelineRunId, stagedLogLevel, 'classify split success', {
        pages: splitPages.map((p, i) => ({ page: pageEntries[i][0], startY: +p.pageStartY.toFixed(3), endY: +p.pageEndY.toFixed(3) }))
      })
      // ── OCR-assisted classify (feature-flagged) — 每頁獨立 OCR、parallel ──
      // 失敗 graceful：任一頁 OCR 掛都不影響該頁的 classify（fallback 純視覺）
      logStaged(pipelineRunId, 'basic', 'classify path = ELSE.MULTI_PAGE_SPLIT (split success)', { pages: splitPages.length, ocrAssistEnabled: isOcrAssistEnabled() })
      // 🆕 OCR 用 top-overlap split（向前頁底借 33%、解 group header 跨頁問題）。
      // classify AI 仍用 no-overlap splitPages（保留 per-page coord 系統）。
      const ocrSplitPages = isOcrAssistEnabled()
        ? await splitWithTopOverlapForOcr(submissionImg.data, submissionImg.mimeType, pageBreaks)
        : null
      const ocrInputPages = ocrSplitPages && ocrSplitPages.length === splitPages.length ? ocrSplitPages : splitPages
      if (ocrSplitPages) {
        logStaged(pipelineRunId, 'basic', 'OCR-assist using top-overlap split', { pages: ocrSplitPages.length, topOverlapRatio: 0.33 })
      } else if (isOcrAssistEnabled()) {
        logStaged(pipelineRunId, 'basic', 'OCR-assist top-overlap split failed → fallback to no-overlap splitPages')
      }
      const pageOcrAssists = isOcrAssistEnabled()
        ? await Promise.all(ocrInputPages.map(async (p, i) => {
            try {
              const ids = pageEntries[i][1]
              // overlap-split 的圖前 N px 是借來的前頁底、傳給 prepareOcrHints 讓它把
              // OCR 結果 y 扣掉 overlap、轉成 no-overlap 座標、讓 HINT 跟 classify AI 看的圖對齊
              const inputCropTopRatio = p.inputTopOverlapPx && p.inputPageHeight
                ? p.inputTopOverlapPx / p.inputPageHeight
                : 0
              return await prepareOcrHintsForClassify({
                imageBytes: Buffer.from(p.inlineData.data, 'base64'),
                mimeType: p.inlineData.mimeType,
                answerKeyQuestions: answerKeyQuestions.filter(q => ids.includes(q?.id)),
                answerSheetMode,
                inputCropTopRatio
              })
            } catch (e) {
              logStaged(pipelineRunId, 'basic', `OCR-assist multi-page p${pageEntries[i][0]}: ERROR`, { error: e?.message, stack: e?.stack?.split('\n').slice(0, 3).join(' | ') })
              return { extraSection: '', stats: { error: e?.message } }
            }
          }))
        : null
      if (!isOcrAssistEnabled()) logStaged(pipelineRunId, 'basic', 'OCR-assist multi-page: SKIPPED (isOcrAssistEnabled=false)')
      if (pageOcrAssists) {
        logStaged(pipelineRunId, stagedLogLevel, 'classify OCR-assist per-page', {
          pages: pageOcrAssists.map((a, i) => ({ page: pageEntries[i][0], ...a.stats }))
        })
        // 🆕 收進 stage_logs metadata（含 imageSize 供 post-classify override 使用）
        pageOcrAssists.forEach((a, i) => ocrAssistMeta.perPage.push({
          page: pageEntries[i][0],
          stats: a?.stats || {},
          candidates: a?.candidatesByQid || {},
          rowAnchorBboxes: a?.rowAnchorBboxes || null,
          imageSize: a?.ocrResult?.image_size
        }))
      }
      const classifyResponses = await Promise.all(
        pageEntries.map(([, ids], i) => {
          const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
          // No pageBreaks — single-page image, AI outputs bbox in 0~1 relative to this page
          let prompt = buildClassifyPrompt(ids, specs, [], 0, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
          if (pageOcrAssists?.[i]?.extraSection) prompt = `${prompt}\n\n${pageOcrAssists[i].extraSection}`
          const pageImagePart = { inlineData: splitPages[i].inlineData }
          return executeStage({
            apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
            stageContents: [{ role: 'user', parts: [{ text: prompt }, pageImagePart] }]
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

      // 2026-05-25: 每頁 AI 回的 raw questions 摘要、Vercel 搜 [CLASSIFY-PAGE-DIAG]
      // 看 AI 在哪頁漏哪些題、貼 OCR-assist 前的原始結果
      logStaged(pipelineRunId, 'basic', '[CLASSIFY-PAGE-DIAG] per-page AI raw', {
        pages: pageEntries.map(([pageNum, ids], i) => {
          const parsed = parsedResults[i]
          const rawAligned = Array.isArray(parsed?.alignedQuestions) ? parsed.alignedQuestions : []
          const rawIds = rawAligned.map((q) => q?.questionId).filter(Boolean)
          const rawVisibleIds = rawAligned.filter((q) => q?.visible).map((q) => q.questionId)
          const expectedIds = ids
          const missingFromAi = expectedIds.filter((id) => !rawIds.includes(id))
          const aiReturnedExtra = rawIds.filter((id) => !expectedIds.includes(id))
          return {
            page: pageNum,
            expected: expectedIds.length,
            aiReturned: rawIds.length,
            aiVisible: rawVisibleIds.length,
            missingFromAi,
            aiReturnedExtra,
            visibleIds: rawVisibleIds
          }
        })
      })

      // Normalize, apply OCR override (per-page coords), then remap bboxes from per-page coords → full-image coords
      const allOverrides = []
      const normalizedResults = pageEntries.map(([, ids], i) => {
        let norm = decorateClassifyWithDiagnostics(normalizeClassifyResult(parsedResults[i], ids), akByIdForLog)
        // 🆕 無條件保存 classify 原始 bbox（per-page coords、未 remap）
        const classifyBboxesBefore = norm.alignedQuestions
          .filter(q => q.answerBbox)
          .map(q => ({ qid: q.questionId, bbox: { x: +q.answerBbox.x.toFixed(3), y: +q.answerBbox.y.toFixed(3), w: +q.answerBbox.w.toFixed(3), h: +q.answerBbox.h.toFixed(3) } }))
        let pageMeta = ocrAssistMeta.perPage.find(p => p.page === pageEntries[i][0])
        if (!pageMeta) {
          pageMeta = { page: pageEntries[i][0], stats: { skipped: 'feature_flag_off' }, candidates: {} }
          ocrAssistMeta.perPage.push(pageMeta)
        }
        pageMeta.classifyBboxes = classifyBboxesBefore

        // 🆕 Row anchor full-replace override（multi-page split path）
        if (pageMeta.rowAnchorBboxes && Object.keys(pageMeta.rowAnchorBboxes).length > 0) {
          const { alignedQuestions: rowOverriddenQs, overrides: rowOverrides, rejected: rowRejected } = applyRowAnchorOverride(
            norm.alignedQuestions, pageMeta.rowAnchorBboxes
          )
          if (rowOverrides.length > 0) {
            norm = { ...norm, alignedQuestions: rowOverriddenQs }
            allOverrides.push(...rowOverrides.map(o => ({ ...o, page: pageEntries[i][0], type: 'row_anchor' })))
          }
          if (rowRejected && rowRejected.length > 0) {
            logStaged(pipelineRunId, 'basic', `classify row-anchor REJECTED (page ${pageEntries[i][0]})`, { count: rowRejected.length, samples: rowRejected.slice(0, 5) })
          }
          pageMeta.rowAnchorOverrides = rowOverrides
          pageMeta.rowAnchorRejected = rowRejected || []
        }
        const { pageStartY, pageEndY } = splitPages[i]
        for (const q of norm.alignedQuestions) {
          if (q.answerBbox) q.answerBbox = remapBboxToFullImage(q.answerBbox, pageStartY, pageEndY)
          if (q.questionBbox) q.questionBbox = remapBboxToFullImage(q.questionBbox, pageStartY, pageEndY)
          if (q.bracketBbox) q.bracketBbox = remapBboxToFullImage(q.bracketBbox, pageStartY, pageEndY)
        }
        return norm
      })
      if (allOverrides.length > 0) {
        logStaged(pipelineRunId, stagedLogLevel, 'classify OCR bbox override (multi-page split)', { count: allOverrides.length, samples: allOverrides.slice(0, 5) })
      }

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

      // 🆕 math 算式 □ AI override v2 (crop-based) — multi-page split path
      try {
        const submissionImg = inlineImages[0].inlineData
        const { alignedQuestions: mathOverriddenQs, overrides: mathOverrides } = await applyMathEqBlankOverride(
          classifyResult.alignedQuestions,
          { mimeType: submissionImg.mimeType, data: submissionImg.data },
          answerKey,
          { model: MODEL_PRO, apiKey, logger: (msg) => logStaged(pipelineRunId, stagedLogLevel, msg) }
        )
        if (mathOverrides.length > 0) {
          classifyResult = { ...classifyResult, alignedQuestions: mathOverriddenQs }
          logStaged(pipelineRunId, stagedLogLevel, 'classify math-eq-blank override v2 (multi-page)', { count: mathOverrides.length, samples: mathOverrides.slice(0, 3) })
          if (ocrAssistMeta.perPage[0]) ocrAssistMeta.perPage[0].mathEqBlankOverrides = mathOverrides
        }
      } catch (e) {
        logStaged(pipelineRunId, stagedLogLevel, 'math-eq-blank v2 multi-page failed (non-fatal)', { error: e?.message })
      }
    }
  }

  classifyAligned = classifyResult.alignedQuestions
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
  // akByIdForLog 已在 function 開頭定義（line ~5430）、給後續 E↔F 等檢查共用
  totalPages = pageEntries.length || 1
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
  const multiFillBboxDebug = classifyAligned
    .filter((q) => q.visible && q.questionType === 'multi_fill')
    .map((q) => ({ questionId: q.questionId, answerBbox: q.answerBbox }))
  if (multiFillBboxDebug.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'multi_fill answerBbox coords', multiFillBboxDebug)
  }

  // ── Classify Quality Gate + Auto-Retry (max 1) ────────────────────────────
  // Build ref bbox map for drift detection (shift / overlap-drift / jitter).
  // Ref is used for **detection only** — never to mutate student bbox.
  // See memory/feedback_dont_use_answerkey_bbox_for_student.md.
  //
  // ⚠️ GATE：ref bbox 只在 answer_only + teacher_scan 才跟學生 bbox 座標可比。
  //   - answer_only：老師答案卷跟學生答案卷走同一個 template、locate bbox 直接對得齊
  //   - 非 answer_only（含 total_pages=1 的 with_questions）：ref 跟學生圖屬不同上傳路徑、
  //     normalized 座標下不對齊；多頁更是 per-page 跟 full-image 尺度不同
  //   - teacher_scan：同一台掃描器同一次掃，紙張位置一致
  //   - student_upload / teacher_camera：拍照角度差太大、normalized 座標下放大成系統性偏移
  // 不符上述條件就跳過 ref 比對、只跑既有 7 項結構性檢查（既有行為不變）。
  const isRefBboxReliable = answerSheetMode === 'answer_only' && submissionSource === 'teacher_scan'
  const classifyRefBboxByQid = isRefBboxReliable ? new Map() : null
  if (classifyRefBboxByQid) {
    for (const q of answerKeyQuestions) {
      if (q?.id && q?.answerBbox) classifyRefBboxByQid.set(q.id, q.answerBbox)
    }
  }
  logStaged(pipelineRunId, stagedLogLevel, 'classify drift detection', {
    enabled: !!classifyRefBboxByQid,
    submissionSource,
    answerSheetMode
  })
  const classifyQG = validateClassifyQuality(classifyResult, questionIds, classifyRefBboxByQid, { answerSheetMode })
  logStaged(pipelineRunId, 'basic', 'classify quality-gate', {
    severity: classifyQG.severity, warnings: classifyQG.warnings, metrics: classifyQG.metrics
  })
  // 2026-05-17: 中文彙總——bbox 來源統計（讓人秒懂這份卷的 classify 結果）
  {
    const aligned = Array.isArray(classifyResult?.alignedQuestions) ? classifyResult.alignedQuestions : []
    const visibleCount = aligned.filter((q) => q.visible).length
    const ocrAssistedCount = (() => {
      let n = 0
      for (const page of ocrAssistMeta.perPage) n += Object.keys(page.candidates || {}).length
      return n
    })()
    const rowAnchorCount = (() => {
      let n = 0
      for (const page of ocrAssistMeta.perPage) {
        if (page.rowAnchorOverrides) n += page.rowAnchorOverrides.length
      }
      return n
    })()
    const mathEqCount = aligned.filter((q) => q.framingReason === 'math_eq_blank_override_v2').length
    const proClassifyCount = visibleCount - ocrAssistedCount - rowAnchorCount - mathEqCount
    const qgLabel = classifyQG.severity === QG_SEVERITY.PASS ? '通過'
      : classifyQG.severity === QG_SEVERITY.WARN ? '警告' : '失敗'
    logStaged(pipelineRunId, 'basic',
      `[A1] classify 完成 涵蓋=${(classifyQG.metrics?.coverage ?? 0).toFixed(2)} 可見=${visibleCount}/${questionIds.length} 品質=${qgLabel}`,
      {
        bbox來源: {
          Pro_classify: Math.max(0, proClassifyCount),
          OCR_row_anchor: rowAnchorCount,
          math_eq_blank: mathEqCount,
          OCR_assist_覆寫: ocrAssistedCount
        }
      })
  }
  let classifyRetryQG = null
  if (classifyQG.severity === QG_SEVERITY.FAIL) {
    logStaged(pipelineRunId, stagedLogLevel, 'classify quality FAIL → retry (1/1)')
    // Re-run classify: single-page path (simple retry with same prompt)
    if (pageEntries.length <= 1) {
      const ids = pageEntries.length === 0 ? questionIds : pageEntries[0][1]
      const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
      const retryPrompt = buildClassifyPrompt(ids, specs, pageBreaks, 0, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
      const retryResp = await executeStage({
        apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
        stageContents: [{ role: 'user', parts: [{ text: retryPrompt }, ...submissionImageParts] }]
      })
      logStageEnd(pipelineRunId, 'classify-retry', retryResp)
      stageResponses.push(retryResp)
      if (retryResp.ok) {
        const retryParsed = parseCandidateJson(retryResp.data)
        if (retryParsed && typeof retryParsed === 'object') {
          classifyResult = applyClassifyQuestionSpecs(normalizeClassifyResult(retryParsed, ids), classifyQuestionSpecs)
          decorateClassifyWithDiagnostics(classifyResult, akByIdForLog)
          classifyRetryQG = validateClassifyQuality(classifyResult, questionIds, classifyRefBboxByQid, { answerSheetMode })
          logStaged(pipelineRunId, 'basic', 'classify retry quality-gate', {
            severity: classifyRetryQG.severity, warnings: classifyRetryQG.warnings
          })
        }
      }
    } else {
      // Multi-page retry: re-dispatch all pages in parallel
      const submissionImg = inlineImages[0].inlineData
      const splitPages = await splitSubmissionImageByPageBreaks(submissionImg.data, submissionImg.mimeType, pageBreaks)
      const useSplit = splitPages && splitPages.length === pageEntries.length
      const retryResponses = await Promise.all(
        pageEntries.map(([, ids], i) => {
          const specs = classifyQuestionSpecs.filter((s) => ids.includes(s.questionId))
          const prompt = buildClassifyPrompt(ids, specs, useSplit ? [] : pageBreaks, 0, classifyCorrections.filter((c) => ids.includes(c.questionId)), answerSheetMode)
          const imgPart = useSplit ? { inlineData: splitPages[i].inlineData } : submissionImageParts[0]
          return executeStage({
            apiKey, model, payload, timeoutMs: getRemainingBudget(), routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_CLASSIFY,
            stageContents: [{ role: 'user', parts: [{ text: prompt }, imgPart] }]
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
          }, classifyQuestionSpecs)
          classifyRetryQG = validateClassifyQuality(classifyResult, questionIds, classifyRefBboxByQid, { answerSheetMode })
          logStaged(pipelineRunId, 'basic', 'classify retry quality-gate', {
            severity: classifyRetryQG.severity, warnings: classifyRetryQG.warnings
          })
        }
      }
    }
    classifyAligned = classifyResult.alignedQuestions

    // Retry exhausted check: if retry didn't complete OR still FAIL → fail this submission.
    // (No further AI calls; frontend will surface pipelineFailure and skip Phase B.)
    if (!classifyRetryQG || classifyRetryQG.severity === QG_SEVERITY.FAIL) {
      // 2026-05-25: classify 失敗診斷 log — Vercel 搜 [CLASSIFY-FAIL-DIAG] 找
      // 列出漏掉的 questionIds、bbox 來源分布、OCR-assist 是否救援
      const aligned = Array.isArray(classifyResult?.alignedQuestions) ? classifyResult.alignedQuestions : []
      const visibleIds = aligned.filter((q) => q.visible).map((q) => q.questionId)
      const missingIds = aligned.filter((q) => !q.visible).map((q) => q.questionId)
      const visibleByType = {}
      for (const q of aligned.filter((q) => q.visible)) {
        const t = q.questionType || 'unknown'
        visibleByType[t] = (visibleByType[t] || 0) + 1
      }
      const ocrAssistSummary = ocrAssistMeta.perPage.map((p) => ({
        page: p.page,
        ocrCandidates: Object.keys(p.candidates || {}).length,
        rowAnchorOverrides: (p.rowAnchorOverrides || []).length,
        ocrError: p.stats?.error,
        ocrSkipped: p.stats?.skipped
      }))
      logStaged(pipelineRunId, 'basic', '[CLASSIFY-FAIL-DIAG] 失敗詳情', {
        coverage: classifyRetryQG?.metrics?.coverage ?? classifyQG.metrics?.coverage,
        visible: visibleIds.length,
        missing: missingIds.length,
        totalExpected: questionIds.length,
        visibleIds,
        missingIds,
        visibleByType,
        pageBreaksUsed: pageBreaks?.length || 0,
        ocrAssistEnabled: isOcrAssistEnabled(),
        ocrAssistSummary,
        retryAttempted: !!classifyRetryQG,
        retryWarnings: classifyRetryQG?.warnings || []
      })
      return buildFailureReturn('classify', [classifyRetryQG ?? classifyQG], { classifyResult })
    }
  }
  // ── End Classify Quality Gate ─────────────────────────────────────────────
  } // 2026-05-17: 結束「!precomputedClassifyContext」分支（OCR + classify + bbox 後處理 + QG）

  // 2026-05-17: stopAfterClassify early-return（拆 classify 出獨立 HTTP call）
  // 走到這裡：classifyResult / classifyAligned / totalPages / ocrAssistMeta 已就緒、
  // client 帶 _phaseAClassifyContext 打第二個 endpoint (phase_a, 帶 phaseAStopBeforeArbiter=true) 跑 read。
  if (stopAfterClassify) {
    const stageLatencySoFar = stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0)
    logStaged(pipelineRunId, 'basic', `[A1] 早退（stopAfterClassify）→ 等 client 打 phase_a (read)`, {
      pipelineRunId,
      classifyBboxCount: classifyAligned.length,
      totalPages,
      stageLatencyMsSoFar: stageLatencySoFar
    })
    return {
      phaseAClassifyComplete: true,
      _phaseAClassifyContext: {
        pipelineRunId,
        stagedLogLevel,
        classifyResult,
        totalPages,
        ocrAssistMeta: ocrAssistMeta.perPage.length > 0 ? ocrAssistMeta : { enabled: false, perPage: [] },
        stageLatencyMsSoFar: stageLatencySoFar
      }
    }
  }

  // Bbox padding 已拿掉 — classify prompt 已要求 AI 「bbox 比 □ 各邊外推 3-5% 頁寬」、
  // 我們再加 0.02 padding 等於雙重 padding、會把 bbox 推進印刷字 / 鄰格文字範圍。
  // 少數 AI 沒照 prompt 加 padding（緊貼筆跡）的 case 改靠 read 階段檢查抓。

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

  // 2026-06-02: 密集選擇格（single_choice / multi_choice / true_false）用固定 0.03 pad 會把上下左右
  // 鄰格的字一起裁進來，盲讀的 AI1 無法判斷哪個才是本題答案而挑錯（畢業考閱讀題組實證：read1 連錯多題、
  // 而知道正解的 AI2 靠正解救回 → read1≠read2 大量假性待複核）。改成「pad 隨格高縮放、上限仍 0.03」：
  //   小選擇格 h≈0.035 → pad≈0.016（消滅疊字）；大題 h 大 → 維持 0.03（行為不變）。
  // 跨格式 A/B 實證見 scripts/exp-ai1-centering-v2.mjs（縮 pad 修好密集表、且不破壞橫排寬鬆格式）。
  // 注意：刻意「不」搭配置中 prompt——實驗顯示縮 pad 後再加置中反而會把沒完美置中的真答案誤判成空白。
  // 2026-06-02: 刻意只鎖在 answer_only（已實證範圍），不碰 with_questions 等其他模式的選擇題——
  // 這樣未來要按題型微調 pad 都只影響 answer_only，不會動到目前沒問題的部分。
  const CHOICE_TIGHT_TYPES = new Set(['single_choice', 'multi_choice', 'true_false'])
  const choiceAwareCropPad = (q) =>
    (answerSheetMode === 'answer_only' && CHOICE_TIGHT_TYPES.has(q?.questionType))
      ? +Math.min(dynamicPad, (q?.answerBbox?.h || dynamicPad) * 0.45).toFixed(4)
      : dynamicPad

  // 2026-06-23: 量某 single_choice 題到「同欄最近的另一個 single_choice」的中心垂直距(=列距)。
  // 用於一般模式+照片的緊框，把 padY 夾到「不吃進鄰列」。找不到同欄鄰題回 Infinity（夾制不啟動）。
  const nearestChoicePitchY = (q, candidates) => {
    const b = q?.answerBbox; if (!b) return Infinity
    const cy = b.y + b.h / 2, x0 = b.x, x1 = b.x + b.w
    let best = Infinity
    for (const o of candidates) {
      if (o === q || o?.questionType !== 'single_choice' || !o.answerBbox) continue
      const ob = o.answerBbox
      if (Math.min(x1, ob.x + ob.w) - Math.max(x0, ob.x) <= 0) continue  // 水平不重疊=不同欄、跳過
      const d = Math.abs(cy - (ob.y + ob.h / 2))
      if (d > 1e-6 && d < best) best = d
    }
    return best
  }

  // Focused checkbox crops: single_check / multi_check / multi_choice
  // We pre-crop first, then exclude successful IDs from full-image ReadAnswer.
  const _allCheckboxCandidates = classifyAligned.filter(
    (q) => q.visible && CHECKBOX_FOCUSED_READ_TYPES.has(q.questionType) && q.answerBbox
  )
  // 2026-06-24: 密集勾選清單（同 type+同欄+連續+列距≤框高×1.2、≥3列）→ 整段讀（gated DENSE_SECTION_READ_ENABLED）。
  //   逐列 tight crop 在密集清單會吃到鄰列 → read1 盲讀讀錯列；整段讀靠列號對位、實證 14/14。
  //   其餘（寬鬆/落單）維持逐列 focused crop。
  // 2026-06-24: 預設開；要關設環境變數 DENSE_SECTION_READ_ENABLED=false。
  const denseSectionGroups = process.env.DENSE_SECTION_READ_ENABLED !== 'false'
    ? groupDenseCheckboxLists(_allCheckboxCandidates)
    : []
  const denseSectionIds = new Set(denseSectionGroups.flat().map((q) => q.questionId))
  if (denseSectionIds.size > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'dense-checkbox-list detected', {
      groups: denseSectionGroups.length, totalRows: denseSectionIds.size, sizes: denseSectionGroups.map((g) => g.length)
    })
  }
  const focusedCheckboxCandidates = _allCheckboxCandidates.filter((q) => !denseSectionIds.has(q.questionId))
  const focusedCheckboxCropMap = new Map()
  if (focusedCheckboxCandidates.length > 0 && inlineImages.length > 0) {
    const inlineImage = inlineImages[0]
    const cropResults = await Promise.all(
      focusedCheckboxCandidates.map(async (q) => {
        // 2026-06-17：focused checkbox 裁切的「垂直」pad 收緊到列高的一小部分。
        // 密集清單（列距 ≈ 格高，如 House for Rent 的 Yes/No 表）若用固定 dynamicPad，
        // 會把上下鄰列一起裁進來 → 一張圖含多列打勾 → focused read 無法判斷打勾在哪一列
        // （盲讀 AI1 + thinking MINIMAL 最常 unreadable/誤判 → 與 AI2 不一致 → 整段送審）。
        // pad 收緊成「對稱小邊距」(隨格高縮放)。bbox 本身已涵蓋 Yes/No 兩欄，不需額外橫向擴張；
        // 橫向擴張反而會把鄰欄/題幹拉進來、讓「第幾個框」位移誤判。
        // 實驗(student1 I 表)：對稱 pad 0.0075→誤判、0.0035→誤判、≤0.002→穩定讀對。
        // 2026-06-24：列距夾制——量到同欄最近的另一個 focused-checkbox 的中心垂直距(列距)，
        //   把 pad 夾到「不超過到鄰列框邊的空間」。密集列(框高≥列距，如 B1 14列擠 y0.17~0.25、
        //   框高0.006>列距0.0053→框本身就疊)→ pitchCap=0 → pad=0(直接用原始 classify 框，不外擴)；
        //   稀疏列(如 A大題框分散)→ pitchCap 大、維持 h×0.25 小邊距。實證(英語期末 B1 single_check
        //   送審43%，root=pad後crop吃2~3列、read1分不出哪列；overlay 圖 local-only/.../b1-crop-overlay.html)。
        const _b = q.answerBbox
        let _pitch = Infinity
        for (const o of focusedCheckboxCandidates) {
          if (o === q || !o.answerBbox) continue
          const ob = o.answerBbox
          if (Math.min(_b.x + _b.w, ob.x + ob.w) - Math.max(_b.x, ob.x) <= 0) continue // 水平不重疊=不同欄、跳過
          const d = Math.abs((_b.y + _b.h / 2) - (ob.y + ob.h / 2))
          if (d > 1e-6 && d < _pitch) _pitch = d
        }
        const _pitchCap = Number.isFinite(_pitch) ? Math.max(0, (_pitch - (_b?.h || 0)) / 2) : Infinity
        const checkboxPad = Math.min(dynamicPad, (q.answerBbox?.h || dynamicPad) * 0.25, _pitchCap)
        const cropData = await cropInlineImageByBbox(
          inlineImage.inlineData.data,
          inlineImage.inlineData.mimeType,
          q.answerBbox,
          true,
          checkboxPad
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
      // VJ 視覺判斷題走專屬 blank reader（line 6990）、不進主 flash read：
      // 否則塗色題每次 Phase A 都被 AI1/AI2 轉錄成散文 readAnswer1/2（白花 token + 誤導輸出）
      && !VISUAL_JUDGMENT_TYPES.has(q.questionType)
      && !focusedCheckboxCropMap.has(q.questionId)  // exclude already-cropped checkbox questions
  )
  if (ai1CropCandidates.length > 0 && inlineImages.length > 0) {
    const inlineImage = inlineImages[0]
    const cropResults = await Promise.all(
      ai1CropCandidates.map(async (q) => {
        // 2026-06-02：answer_only 選擇題（single_choice/multi_choice）直接用 classify bbox、零 padding。
        //   原因：這類卷選擇格的「上下排距 ≈ bbox 高」，只要有 inflate/pad 就會把上下排答案一起裁進來
        //   → read1/read2 各抓不同排 → 大量假性 NR（8號實證 18 題選擇題 NR、crop 疊 2~3 排）。
        //   bbox 已涵蓋該格、答案字在格中央，零 margin 最乾淨。只鎖 answer_only 選擇題、不碰其他模式/題型。
        const aoChoice = answerSheetMode === 'answer_only' && (q.questionType === 'single_choice' || q.questionType === 'multi_choice')
        // 2026-06-23: 一般模式(with_questions) + 照片(submissionSource≠teacher_scan，即非 PDF) + single_choice → 緊框。
        //   根因：原本 inflate(±0.005)+dynamicPad(0.03) 的 crop 垂直吃進「下一列」答案，盲讀 read1 抓錯列(off-by-one)
        //   → 與知答 read2 不一致 → 大量假性 NR。沙盒實證(座號5/9/21/28/30、gemini-2.5-flash、聚焦 read1/read2)：
        //   NR 35%→4%。做法＝不 inflate、padX 縮到 0.02、padY 夾到「0.35×列距」(min 自我 scope：稀疏版面不啟動)。
        //   嚴格鎖在已實證範圍：answer_only / PDF(teacher_scan) / 其他題型(multi_choice·true_false·fill_blank…) 一律不動。
        const tightChoice = answerSheetMode === 'with_questions'
          && submissionSource !== 'teacher_scan'
          && q.questionType === 'single_choice'
        // 2026-05-26：fill_blank 改 wide bbox 後、子題 bbox 已涵蓋整題幹、不再有「鄰格括號被切」風險
        // 2026-06-02：其餘選擇題類（含 true_false）維持 choiceAwareCropPad（隨格高縮放）、其他維持 dynamicPad
        let bboxToUse, cropPad
        if (aoChoice) {
          bboxToUse = q.answerBbox
          cropPad = 0
        } else if (tightChoice) {
          const pitchY = nearestChoicePitchY(q, ai1CropCandidates)
          bboxToUse = q.answerBbox  // 不 inflate、用原始緊框
          cropPad = { padX: Math.min(0.02, dynamicPad + 0.005), padY: +Math.min(dynamicPad, 0.35 * pitchY).toFixed(4) }
        } else {
          bboxToUse = inflateBboxForType(q.answerBbox, q.questionType)
          cropPad = choiceAwareCropPad(q)
        }
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
  // 2026-05-17: 中文彙總——進入 A2 + crop 完成
  {
    const totalCropBytes = Array.from(allQuestionCropMap.values())
      .reduce((sum, c) => sum + (c?.data?.length || 0), 0)
    const cropMB = (totalCropBytes / 1_000_000).toFixed(2)
    logStaged(pipelineRunId, 'basic',
      `[A2] 進場 切圖完成 共 ${allQuestionCropMap.size} 張 (約 ${cropMB}MB)、準備 AI1 + AI2 並行讀答`)
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
    // AI1: detail read (crop images only) — 2026-05-18 用 readModel
    executeStage({
      apiKey,
      model: readModel,
      modelOverride: readModelOverride,
      payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
      timeoutMs: getRemainingBudget(),
      routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_DETAIL_READ,
      stageContents: [{ role: 'user', parts: ai1Parts }]
    }),
    // AI2: review read (same crops as AI1, but knows correct answers — acts as reviewer)
    executeStage({
      apiKey,
      model: readModel,
      modelOverride: readModelOverride,
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
        model: readModel,
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
        model: readModel,
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

  // ── 2026-05-28: map_fill per-position 並行 read（AI1 + AI2）─────────────
  // 跟 fill_blank/single_choice 用同樣的 3-AI 模式、但對 map_fill 特化：
  // AI1：看整圖 + position descs（不揭露 names）→ 老實讀每位置學生筆跡
  // AI2：看整圖 + position descs + names（作 verification hint）→ 仍只能回實看到的內容
  // AI3：跳過（per-position 純文字比對、deterministic、不需 LLM）
  //
  // 需要 AnswerKey 內 question.positions[] 存在（Stage A 已跑過）；
  // 若 AnswerKey 未升級（無 positions），map_fill 退回舊「Phase B 視覺評分」path。
  const mapFillReadJobs = []  // [{ questionId, positions, ai1Idx, ai2Idx }]
  // 從 answerKeyQuestions 直接過濾 map_fill + 已有 positions[]
  // （mapFillIds 是 buildReadAnswerPrompt 內 scope 變數、這裡不能用）
  const mapFillAkQuestions = (Array.isArray(answerKeyQuestions) ? answerKeyQuestions : [])
    .filter((q) => q?.questionCategory === 'map_fill' && Array.isArray(q.positions) && q.positions.length > 0)
  for (const akQ of mapFillAkQuestions) {
    const positions = akQ.positions
    const descs = positions.map((p) => p.desc)
    const ai1Idx = parallelCalls.length
    parallelCalls.push(
      executeStage({
        apiKey,
        model: readModel,
        payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
        timeoutMs: getRemainingBudget(),
        routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_DETAIL_READ,
        stageContents: [{ role: 'user', parts: [{ text: buildStageBPrompt(descs) }, ...submissionImageParts] }]
      })
    )
    const ai2Idx = parallelCalls.length
    parallelCalls.push(
      executeStage({
        apiKey,
        model: readModel,
        payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
        timeoutMs: getRemainingBudget(),
        routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER,
        stageContents: [{ role: 'user', parts: [{ text: buildStageBReviewPrompt(positions) }, ...submissionImageParts] }]
      })
    )
    mapFillReadJobs.push({ questionId: akQ.id, positions, ai1Idx, ai2Idx })
  }
  if (mapFillReadJobs.length > 0) {
    logStaged(pipelineRunId, 'basic',
      `[A2] map_fill 並行 read ${mapFillReadJobs.length} 題（AI1+AI2 共 ${mapFillReadJobs.length * 2} 個 call）`)
  }

  // ── 2026-05-30: VJ 視覺判斷題（diagram_color / map_symbol / grid_geometry）─────
  // 單一 PRO blank reader（每項有沒有畫）；對錯延到 Phase B 帶權威 blank 參數做。
  // 需 AnswerKey 內 question.vjRubric（A0 已跑）；未升級 → Phase B lazy backfill。
  // PRO blank 實測 100% 穩定，故只跑 1 個 reader（route GRADING_VJ_BLANK=PRO）。
  const vjReadJobs = []  // [{ questionId, itemLabels, vjRubric, blankIdx, crop }]
  const vjAkQuestions = (Array.isArray(answerKeyQuestions) ? answerKeyQuestions : [])
    .filter((q) => VISUAL_JUDGMENT_TYPES.has(q?.questionCategory)
      && q?.vjRubric && Array.isArray(q.vjRubric.itemLabels) && q.vjRubric.itemLabels.length > 0)
  if (vjAkQuestions.length > 0 && inlineImages.length > 0) {
    const inlineImage = inlineImages[0]
    for (const akQ of vjAkQuestions) {
      const classifyRow = classifyAligned.find((r) => r.questionId === akQ.id)
      if (!classifyRow?.answerBbox) continue
      const crop = await cropInlineImageByBbox(
        inlineImage.inlineData.data,
        inlineImage.inlineData.mimeType,
        inflateBboxForType(classifyRow.answerBbox, classifyRow.questionType),
        true,
        dynamicPad
      )
      if (!crop) continue
      const itemLabels = akQ.vjRubric.itemLabels
      const blankIdx = parallelCalls.length
      parallelCalls.push(
        executeStage({
          apiKey,
          model: readModel,
          payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
          timeoutMs: getRemainingBudget(),
          routeHint,
          routeKey: AI_ROUTE_KEYS.GRADING_VJ_BLANK,
          stageContents: [{ role: 'user', parts: [{ text: buildVjBlankPrompt(itemLabels) }, { inlineData: crop }] }]
        })
      )
      vjReadJobs.push({ questionId: akQ.id, itemLabels, vjRubric: akQ.vjRubric, blankIdx, crop })
    }
  }
  if (vjReadJobs.length > 0) {
    logStaged(pipelineRunId, 'basic', `[A2] VJ blank read ${vjReadJobs.length} 題（單一 PRO reader）`)
  }

  logStageStart(pipelineRunId, 'ReadAnswer+reReadAnswer')
  const parallelResults = await Promise.all(parallelCalls)
  const readAnswerResponse = parallelResults[0]
  const reReadAnswerResponse = parallelResults[1]

  const finalAnswerOnlyResponse = finalAnswerOnlyIdx >= 0 ? parallelResults[finalAnswerOnlyIdx] : null
  const calcFinalAnswerResponse = calcFinalAnswerIdx >= 0 ? parallelResults[calcFinalAnswerIdx] : null

  // ── 解析 map_fill AI1/AI2 readings ─────────────────────────────────────
  // mapFillReadingsByQid: Map<questionId, { ai1: [{position_idx, student_text}], ai2: [...] }>
  const mapFillReadingsByQid = new Map()
  for (const job of mapFillReadJobs) {
    const ai1Resp = parallelResults[job.ai1Idx]
    const ai2Resp = parallelResults[job.ai2Idx]
    const expectedCount = job.positions.length
    let ai1Readings = []
    let ai2Readings = []
    if (ai1Resp?.ok) {
      const raw = extractCandidateText(ai1Resp.data) || ''
      ai1Readings = parseStageBResult(raw, expectedCount) || []
    } else {
      logStaged(pipelineRunId, 'basic', `[A2] map_fill ${job.questionId} AI1 失敗 status=${ai1Resp?.status}`)
    }
    if (ai2Resp?.ok) {
      const raw = extractCandidateText(ai2Resp.data) || ''
      ai2Readings = parseStageBResult(raw, expectedCount) || []
    } else {
      logStaged(pipelineRunId, 'basic', `[A2] map_fill ${job.questionId} AI2 失敗 status=${ai2Resp?.status}`)
    }
    mapFillReadingsByQid.set(job.questionId, { ai1: ai1Readings, ai2: ai2Readings, positions: job.positions })
    if (ai1Resp) stageResponses.push(ai1Resp)
    if (ai2Resp) stageResponses.push(ai2Resp)
  }

  // ── 解析 VJ blank readings ─────────────────────────────────────────────
  // vjReadingsByQid: Map<questionId, { blankRead:[{idx,hasMark}], itemLabels, vjRubric, crop }>
  const vjReadingsByQid = new Map()
  for (const job of vjReadJobs) {
    const resp = parallelResults[job.blankIdx]
    let blankRead = []
    if (resp?.ok) {
      blankRead = parseVjBlankResult(extractCandidateText(resp.data) || '', job.itemLabels.length) || []
    } else {
      logStaged(pipelineRunId, 'basic', `[A2] VJ ${job.questionId} blank read 失敗 status=${resp?.status}`)
    }
    vjReadingsByQid.set(job.questionId, {
      blankRead, itemLabels: job.itemLabels, vjRubric: job.vjRubric, crop: job.crop
    })
    if (resp) stageResponses.push(resp)
  }

  logStageEnd(pipelineRunId, 'ReadAnswer', readAnswerResponse)
  logStageEnd(pipelineRunId, 'reReadAnswer', reReadAnswerResponse)
  stageResponses.push(readAnswerResponse, reReadAnswerResponse)
  // 2026-05-17: 中文彙總——AI1 / AI2 並行 read 結果
  {
    const ai1Ms = Math.round(Number(readAnswerResponse?.modelLatencyMs) || 0)
    const ai2Ms = Math.round(Number(reReadAnswerResponse?.modelLatencyMs) || 0)
    const ai1Status = readAnswerResponse?.status || '?'
    const ai2Status = reReadAnswerResponse?.status || '?'
    const wallSeconds = (Math.max(ai1Ms, ai2Ms) / 1000).toFixed(1)
    logStaged(pipelineRunId, 'basic',
      `[A2] AI1+AI2 並行 read 完成 AI1=${ai1Ms}ms(${ai1Status}) AI2=${ai2Ms}ms(${ai2Status}) wall≈${wallSeconds}s`)
  }

  if (!readAnswerResponse.ok) {
    return buildHttpErrorReturn('read_answer', readAnswerResponse)
  }
  if (readAnswerResponse.warnings.length > 0) {
    stageWarnings.push(...readAnswerResponse.warnings.map((w) => `[ReadAnswer] ${w}`))
  }
  let readAnswerParsed = parseCandidateJson(readAnswerResponse.data)
  let reReadAnswerParsed = reReadAnswerResponse?.ok
    ? parseCandidateJson(reReadAnswerResponse.data)
    : null
  // 2026-05-18: AI1 parse 失敗時的診斷 + fallback
  //   原本 AI1 parse 失敗就直接 throw、整個 phase-a crash、fallback 到 single-shot 回 400
  //   改成：先印 raw text 上 Vercel log 給診斷、然後若 AI2 parse 成功就用 AI2 當 AI1（讓 phase-a 還是能跑完）
  //   AI1+AI2 都失敗才 throw
  if (!readAnswerParsed || typeof readAnswerParsed !== 'object') {
    const ai1RawText = String(extractCandidateText(readAnswerResponse?.data) || '').slice(0, 800)
    console.warn(`[PhaseA][${pipelineRunId}] AI1 read_answer parse failed、AI1 raw text preview (前 800 字)：`, ai1RawText)
    if (reReadAnswerParsed && typeof reReadAnswerParsed === 'object') {
      console.warn(`[PhaseA][${pipelineRunId}] AI1 parse 失敗、但 AI2 OK、用 AI2 結果代替 AI1 繼續跑`)
      readAnswerParsed = reReadAnswerParsed
    } else {
      const ai2RawText = String(extractCandidateText(reReadAnswerResponse?.data) || '').slice(0, 800)
      console.warn(`[PhaseA][${pipelineRunId}] AI2 也 parse 失敗、AI2 raw text preview：`, ai2RawText)
      throw new Error('PhaseA read_answer parse failed (AI1 + AI2 都讀不到合法 JSON)')
    }
  }

  // ── 2026-06-30: AI2(校對) 整份/大量判空白偵測 → 重抽 read2 一次 ──────────────
  //   現象：AI1 讀到答案、AI2 卻把整份/大半讀成空白（偶發 Gemini 失敗、非並發造成）→ read1≠read2 → NR 爆量。
  //   偵測「AI1 非空、AI2 卻空白」的比例，過高（系統性失敗）就重抽一次 read2；重抽有改善才採用。
  try {
    const ansArrOf = (p) => (Array.isArray(p?.answers) ? p.answers : [])
    const isBlankAns = (a) => {
      const st = ensureString(a?.status, '').toLowerCase()
      const txt = ensureString(a?.studentAnswer ?? a?.studentAnswerRaw ?? a?.answer, '').trim()
      return st === 'blank' || st === 'unreadable' || !txt || txt === '未作答'
    }
    const ai1ByQid = new Map(ansArrOf(readAnswerParsed).map((a) => [ensureString(a?.questionId).trim(), a]))
    const countAi2BlankWhereAi1Read = (parsed) => {
      const a2ByQid = new Map(ansArrOf(parsed).map((a) => [ensureString(a?.questionId).trim(), a]))
      let ai1NonBlank = 0, ai2Blank = 0
      for (const [qid, a1] of ai1ByQid) {
        if (isBlankAns(a1)) continue
        ai1NonBlank++
        const a2 = a2ByQid.get(qid)
        if (!a2 || isBlankAns(a2)) ai2Blank++
      }
      return { ai1NonBlank, ai2Blank }
    }
    const { ai1NonBlank, ai2Blank } = countAi2BlankWhereAi1Read(reReadAnswerParsed)
    // 系統性失敗門檻：AI1 至少讀到 8 題、且其中過半 AI2 判空白
    if (ai1NonBlank >= 8 && ai2Blank / ai1NonBlank >= 0.5) {
      logStaged(pipelineRunId, 'basic', `[A2] AI2 大量判空白(${ai2Blank}/${ai1NonBlank})→重抽 read2 一次`)
      const retryResp = await executeStage({
        apiKey, model: readModel, modelOverride: readModelOverride,
        payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
        timeoutMs: getRemainingBudget(), routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER,
        stageContents: [{ role: 'user', parts: ai2Parts }]
      })
      if (retryResp?.ok) {
        const retryParsed = parseCandidateJson(retryResp.data)
        if (retryParsed && typeof retryParsed === 'object') {
          const retry = countAi2BlankWhereAi1Read(retryParsed)
          if (retry.ai2Blank < ai2Blank) {
            reReadAnswerParsed = retryParsed
            stageResponses.push(retryResp)
            logStaged(pipelineRunId, 'basic', `[A2] read2 重抽改善 空白 ${ai2Blank}→${retry.ai2Blank}、採用重抽`)
          } else {
            logStaged(pipelineRunId, 'basic', `[A2] read2 重抽未改善(${retry.ai2Blank})、保留原值`)
          }
        }
      } else {
        logStaged(pipelineRunId, 'basic', `[A2] read2 重抽 HTTP ${retryResp?.status}、保留原值`)
      }
    }
  } catch (e) { logStaged(pipelineRunId, 'basic', '[A2] read2 空白偵測/重抽失敗(忽略)', { error: e?.message }) }

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
          model: readModel,
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
          // 2026-06-17：focused checkbox read 改用 MODEL_PRO（3.5-flash）。
          // 「判斷小小的 Yes/No 打勾在哪一欄」是視覺辨識題，MODEL_FLASH（2.5-flash）做不穩——
          // 同一張裁切 2.5-flash 讀錯欄(「2」)或無法辨識、3.5-flash 4/4 全對（student1 I 表實證）。
          // 盲讀 AI1 用弱 model 最常中 → 與知道答案的 AI2 不一致 → 整段送審。
          model: MODEL_PRO,
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
        model: readModel,
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
            model: readModel,
            payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
            timeoutMs: getRemainingBudget(),
            routeHint,
            routeKey: AI_ROUTE_KEYS.GRADING_READ_ANSWER,
            stageContents: [{ role: 'user', parts: [{ text: buildFocusedMultiFillReadPrompt(q.questionId, codeSet) }, { inlineData: cropTight }] }]
          }),
          executeStage({
            apiKey,
            model: readModel,
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

  // ── 密集勾選清單「整段讀」（read1 盲 + read2 知答、各清單 1 次、逐列 map 回 qid）──────
  if (denseSectionGroups.length > 0 && inlineImages.length > 0) {
    const inlineImage = inlineImages[0]
    const akByQidDense = mapByQuestionId(answerKeyQuestions, (q) => q?.id)
    const denseRead1Map = new Map()
    const denseRead2Map = new Map()
    await Promise.all(denseSectionGroups.map(async (group) => {
      const sorted = group.slice().sort((a, b) => a.answerBbox.y - b.answerBbox.y)
      const minY = Math.min(...sorted.map((q) => q.answerBbox.y))
      const maxYB = Math.max(...sorted.map((q) => q.answerBbox.y + q.answerBbox.h))
      const top = Math.max(0, minY - 0.004)
      // 整段裁圖：全寬（含左側列號 + 右側勾選欄）、y 涵蓋整串 + 小邊距
      const sectionBbox = { x: 0, y: top, w: 1, h: Math.min(1, maxYB + 0.004) - top }
      const cropData = await cropInlineImageByBbox(inlineImage.inlineData.data, inlineImage.inlineData.mimeType, sectionBbox, true, 0)
      if (!cropData) return
      const qtype = sorted[0].questionType
      const items = sorted.map((q, i) => ({
        qid: q.questionId, num: sectionRowNumber(q.questionId, i),
        answer: ensureString(akByQidDense.get(q.questionId)?.answer, '')
      }))
      const numToQid = new Map(items.map((it) => [String(it.num), it.qid]))
      const [r1, r2] = await Promise.all([
        executeStage({ apiKey, model: readModel, modelOverride: readModelOverride, payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG }, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_DETAIL_READ,
          stageContents: [{ role: 'user', parts: [{ text: buildSectionCheckboxReadPrompt(items, qtype, false) }, { inlineData: cropData }] }] }),
        executeStage({ apiKey, model: readModel, modelOverride: readModelOverride, payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG }, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER,
          stageContents: [{ role: 'user', parts: [{ text: buildSectionCheckboxReadPrompt(items, qtype, true) }, { inlineData: cropData }] }] })
      ])
      const applyRows = (res, map) => {
        if (!res?.ok) return
        const rows = parseCandidateJson(res.data)?.rows
        if (!rows || typeof rows !== 'object') return
        for (const [num, box] of Object.entries(rows)) {
          const qid = numToQid.get(String(num))
          if (!qid) continue
          const raw = String(box ?? '').trim()
          const isBlank = raw === '' || raw === '0'
          const val = raw.replace(/[^\d,]/g, '').replace(/,+/g, ',').replace(/^,|,$/g, '')
          map.set(qid, { questionId: qid, studentAnswerRaw: isBlank || !val ? '未作答' : val, status: isBlank || !val ? 'blank' : 'read' })
        }
      }
      applyRows(r1, denseRead1Map)
      applyRows(r2, denseRead2Map)
    }))
    if (denseRead1Map.size > 0) {
      readAnswerParsed = applyAnswerOverrides(readAnswerParsed, denseRead1Map)
      logStaged(pipelineRunId, stagedLogLevel, 'dense-section-read read-1 overrides applied → AI1', { count: denseRead1Map.size })
    }
    if (denseRead2Map.size > 0) {
      reReadAnswerParsed = reReadAnswerParsed ?? { answers: [] }
      reReadAnswerParsed = applyAnswerOverrides(reReadAnswerParsed, denseRead2Map)
      logStaged(pipelineRunId, stagedLogLevel, 'dense-section-read read-2 overrides applied → AI2', { count: denseRead2Map.size })
    }
  }

  // ── ordering 排序題「focused read」（MODEL_PRO + 明確掃描順序、覆寫 read1+read2）──────
  // 主 read(2.5-flash) 對圖片角落小手寫序號常 未作答；3.5-flash 穩定。沙盒(B2)：2.5=1/3、3.5=3/3。
  // extract 與 read 用同一條掃描順序(由上而下、每列由左而右)才對得齊。預設開；要關設 ORDERING_FOCUSED_READ_ENABLED=false。
  if (process.env.ORDERING_FOCUSED_READ_ENABLED !== 'false') {
    const orderingCandidates = classifyAligned.filter((q) => q.visible && q.questionType === 'ordering' && q.answerBbox)
    if (orderingCandidates.length > 0 && inlineImages.length > 0) {
      const inlineImage = inlineImages[0]
      const akByQidOrd = mapByQuestionId(answerKeyQuestions, (q) => q?.id)
      const ordRead1Map = new Map()
      const ordRead2Map = new Map()
      await Promise.all(orderingCandidates.map(async (q) => {
        const cropData = await cropInlineImageByBbox(inlineImage.inlineData.data, inlineImage.inlineData.mimeType, q.answerBbox, true, 0.01)
        if (!cropData) return
        const correct = ensureString(akByQidOrd.get(q.questionId)?.answer, '')
        const [r1, r2] = await Promise.all([
          executeStage({ apiKey, model: MODEL_PRO, payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG }, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_DETAIL_READ,
            stageContents: [{ role: 'user', parts: [{ text: buildOrderingReadPrompt(q.questionId, correct, false) }, { inlineData: cropData }] }] }),
          executeStage({ apiKey, model: MODEL_PRO, payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG }, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER,
            stageContents: [{ role: 'user', parts: [{ text: buildOrderingReadPrompt(q.questionId, correct, true) }, { inlineData: cropData }] }] })
        ])
        const pick = (res) => { if (!res?.ok) return null; const a = parseCandidateJson(res.data)?.answers; return Array.isArray(a) ? a[0] : null }
        const a1 = pick(r1), a2 = pick(r2)
        if (a1) ordRead1Map.set(q.questionId, a1)
        if (a2) ordRead2Map.set(q.questionId, a2)
        logStaged(pipelineRunId, stagedLogLevel, `ordering-focused-read qid=${q.questionId}`, { read1: a1?.studentAnswerRaw, read2: a2?.studentAnswerRaw })
      }))
      if (ordRead1Map.size > 0) {
        readAnswerParsed = applyAnswerOverrides(readAnswerParsed, ordRead1Map)
        logStaged(pipelineRunId, stagedLogLevel, 'ordering-focused-read read-1 overrides applied → AI1', { count: ordRead1Map.size })
      }
      if (ordRead2Map.size > 0) {
        reReadAnswerParsed = reReadAnswerParsed ?? { answers: [] }
        reReadAnswerParsed = applyAnswerOverrides(reReadAnswerParsed, ordRead2Map)
        logStaged(pipelineRunId, stagedLogLevel, 'ordering-focused-read read-2 overrides applied → AI2', { count: ordRead2Map.size })
      }
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
      model: readModel,
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
  // 2026-05-20: 改 let、後面 read QG FAIL retry 會重新賦值
  let reReadAnswerResult = reReadAnswerParsed
    ? applySelectionDisplayNormalization(
        normalizeReadAnswerResult(reReadAnswerParsed, questionIds, new Set()),
        answerKey
      )
    : { answers: [] }

  // ── Read Answer Quality Gate ────────────────────────────────────────────
  const visibleQuestionIds = classifyAligned.filter((q) => q.visible).map((q) => q.questionId)
  // 2026-05-20: readQG / classifyReadQG 改 let、retry 會重新賦值
  let readQG = validateReadAnswerQuality(readAnswerResult, reReadAnswerResult, visibleQuestionIds, classifyAligned)
  logStaged(pipelineRunId, 'basic', 'read-answer quality-gate', {
    severity: readQG.severity, warnings: readQG.warnings, metrics: readQG.metrics
  })

  // ── Cross-stage: Classify → Read consistency ──────────────────────────────
  let classifyReadQG = validateClassifyReadConsistency(classifyResult, readAnswerResult)
  logStaged(pipelineRunId, stagedLogLevel, 'cross-stage classify→read quality-gate', {
    severity: classifyReadQG.severity, warnings: classifyReadQG.warnings, metrics: classifyReadQG.metrics
  })
  // 2026-05-17: 中文彙總——AI1 vs AI2 不一致細節（哪幾題、disagreement rate）
  {
    const m = readQG.metrics || {}
    const cmp = Number(m.ai1ai2Comparisons || 0)
    const diff = Number(m.ai1ai2Disagreements || 0)
    const rate = Number(m.ai1ai2DisagreementRate || 0)
    // 找出實際不一致的題號
    const disagreeQids = []
    if (Array.isArray(readAnswerResult?.answers) && Array.isArray(reReadAnswerResult?.answers)) {
      const a2Map = new Map(reReadAnswerResult.answers.map((a) => [a.questionId, a]))
      for (const a1 of readAnswerResult.answers) {
        if (a1.status !== 'read') continue
        const a2 = a2Map.get(a1.questionId)
        if (!a2 || a2.status !== 'read') continue
        const raw1 = (a1.studentAnswerRaw ?? '').trim()
        const raw2 = (a2.studentAnswerRaw ?? '').trim()
        if (raw1 !== raw2) disagreeQids.push(a1.questionId)
      }
    }
    const qgLabel = readQG.severity === QG_SEVERITY.PASS ? '通過'
      : readQG.severity === QG_SEVERITY.WARN ? '警告' : '失敗'
    logStaged(pipelineRunId, 'basic',
      `[A2] read 品質檢查=${qgLabel} 比對=${cmp} 不一致=${diff} 比率=${rate.toFixed(3)}${disagreeQids.length > 0 ? ' 不一致題號=' + disagreeQids.join(',') : ''}`)
  }

  // 2026-05-20: Read QG FAIL → 先 retry 一次再決定失敗。
  // 舊設計（fail-fast、不 retry）對 bbox 系統性問題合理、但對 transient 失敗（AI2 整個 stage 空、
  // JSON parse 偶發壞掉、Gemini timeout）不合理——這些 retry 一次就好。
  // 14 嚴一華 case：AI2 整空 → 沒 retry → 25/25 默默送 review。
  // 新流程：FAIL → 重跑 AI1+AI2 → 再驗 QG → 第二次 FAIL 才整份失敗。
  let readRetryAttempted = false
  if (readQG.severity === QG_SEVERITY.FAIL || classifyReadQG.severity === QG_SEVERITY.FAIL) {
    readRetryAttempted = true
    logStaged(pipelineRunId, 'basic', '[A2] read QG FAIL → 自動重跑 AI1+AI2 一次再驗', {
      readQG: readQG.warnings, classifyReadQG: classifyReadQG.warnings
    })
    const retryResults = await Promise.all([
      executeStage({
        apiKey,
        model: readModel,
        modelOverride: readModelOverride,
        payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
        timeoutMs: getRemainingBudget(),
        routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_DETAIL_READ,
        stageContents: [{ role: 'user', parts: ai1Parts }]
      }),
      executeStage({
        apiKey,
        model: readModel,
        modelOverride: readModelOverride,
        payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
        timeoutMs: getRemainingBudget(),
        routeHint,
        routeKey: AI_ROUTE_KEYS.GRADING_RE_READ_ANSWER,
        stageContents: [{ role: 'user', parts: ai2Parts }]
      })
    ])
    stageResponses.push(...retryResults)
    const retryAi1 = retryResults[0]
    const retryAi2 = retryResults[1]
    logStaged(pipelineRunId, 'basic',
      `[A2-retry] AI1=${retryAi1?.status} AI2=${retryAi2?.status}`)

    if (retryAi1.ok) {
      const retryAi1Parsed = parseCandidateJson(retryAi1.data)
      const retryAi2Parsed = retryAi2?.ok ? parseCandidateJson(retryAi2.data) : null
      if (retryAi1Parsed && typeof retryAi1Parsed === 'object') {
        readAnswerResult = applySelectionDisplayNormalization(
          normalizeReadAnswerResult(retryAi1Parsed, questionIds, new Set()),
          answerKey
        )
      }
      if (retryAi2Parsed && typeof retryAi2Parsed === 'object') {
        reReadAnswerResult = applySelectionDisplayNormalization(
          normalizeReadAnswerResult(retryAi2Parsed, questionIds, new Set()),
          answerKey
        )
      } else if (Array.isArray(retryAi2Parsed?.answers) === false && retryAi2?.ok === false) {
        // retry AI2 也壞掉、保留原本的 reReadAnswerResult（可能還是空、會在下面 QG 再被擋）
      }
      // 注意：retry 不重套 bracket/checkbox/multi_fill overrides——這些是 edge case 補強、
      // 對「整個 stage 失敗」的 transient 案例影響很小、為了簡單先省略
      readQG = validateReadAnswerQuality(readAnswerResult, reReadAnswerResult, visibleQuestionIds, classifyAligned)
      classifyReadQG = validateClassifyReadConsistency(classifyResult, readAnswerResult)
      logStaged(pipelineRunId, 'basic',
        `[A2-retry] read QG=${readQG.severity} crossQG=${classifyReadQG.severity}`,
        { readWarnings: readQG.warnings, crossWarnings: classifyReadQG.warnings })
    }
  }
  // 第二次仍 FAIL（或 retry call 本身 HTTP 失敗）→ 真的失敗、給前端 userMessage + 觸發手動重批 UI
  if (readQG.severity === QG_SEVERITY.FAIL || classifyReadQG.severity === QG_SEVERITY.FAIL) {
    logStaged(pipelineRunId, 'basic',
      `[A2] read QG ${readRetryAttempted ? '重跑後仍 FAIL' : 'FAIL'} → PhaseA 失敗`)
    return buildFailureReturn('read', [readQG, classifyReadQG], { readAnswerResult, reReadAnswerResult })
  }

  // ── A5: CONSISTENCY CHECK (pure logic, no crops yet) ─────────────────────
  const read1ById = mapByQuestionId(readAnswerResult.answers, (item) => item?.questionId)
  const read2ById = mapByQuestionId(reReadAnswerResult.answers, (item) => item?.questionId)

  const questionResultsRaw = questionIds.map((questionId) => {
    const read1 = read1ById.get(questionId)
    const read2 = read2ById.get(questionId)
    const classifyRow = classifyAligned.find((q) => q.questionId === questionId)

    // ── VJ 視覺判斷題：blank 偵測 + 逐項分類（2026-05-30）──
    // 有畫→auto_not_blank（自動送 Phase B grade）；空白→review_blank（送老師確認）。對錯延到 Phase B。
    if (VISUAL_JUDGMENT_TYPES.has(classifyRow?.questionType)) {
      const vjData = vjReadingsByQid.get(questionId)
      if (!vjData || !Array.isArray(vjData.itemLabels) || vjData.itemLabels.length === 0) {
        // 未升級（無 vjRubric）→ Phase B lazy backfill；先標 stable placeholder
        return {
          questionId,
          consistencyStatus: 'stable',
          containmentPreferredRaw: null,
          consistencyReason: undefined,
          questionType: classifyRow?.questionType,
          readAnswer1: { status: 'auto', studentAnswer: '(視覺判斷題 AnswerKey 未升級、由 Phase B 評分)' },
          readAnswer2: { status: 'auto', studentAnswer: '(視覺判斷題 AnswerKey 未升級、由 Phase B 評分)' },
          answerBbox: classifyRow?.answerBbox ?? null,
          bboxCorrected: classifyRow?.bboxCorrected || false,
          calculationAnswerMismatch: false,
          framingReason: classifyRow?.framingReason || undefined
        }
      }
      const { perItem, anyReview } = classifyVjBlank(vjData.itemLabels, vjData.blankRead)
      const consistencyStatus = anyReview ? 'diff' : 'stable'
      const summary = perItem.map((p) => `${p.label}:${p.hasMark === 'yes' ? '有畫' : '空白'}`).join('、')
      return {
        questionId,
        consistencyStatus,
        containmentPreferredRaw: null,
        consistencyReason: anyReview
          ? `${perItem.filter((p) => p.status !== 'auto_not_blank').length} 項需確認是否作答`
          : undefined,
        questionType: classifyRow?.questionType,
        readAnswer1: { status: 'read', studentAnswer: summary },
        readAnswer2: { status: 'read', studentAnswer: summary },
        answerBbox: classifyRow?.answerBbox ?? null,
        bboxCorrected: classifyRow?.bboxCorrected || false,
        calculationAnswerMismatch: false,
        framingReason: classifyRow?.framingReason || undefined,
        // 🆕 per-item 給前端 VJ 審查 card（有/沒有畫）
        visualJudgment: { itemLabels: vjData.itemLabels, perItem }
      }
    }

    // ── map_fill: Phase A 3-AI per-position 流程（2026-05-28 pivot）──
    // AnswerKey 已升級（有 positions[]） → 用平行 AI1/AI2 readings + per-position consistency
    // AnswerKey 未升級（無 positions[]） → 回退到 Phase B 視覺評分 path（auto-stable）
    if (classifyRow?.questionType === 'map_fill') {
      const mfData = mapFillReadingsByQid.get(questionId)
      if (!mfData || mfData.positions.length === 0) {
        // 舊資料 fallback：Phase B map-fill-grader 會走 Stage A lazy backfill + Stage B
        const placeholder = '(填圖題 AnswerKey 未升級、由 Phase B 視覺評分)'
        return {
          questionId,
          consistencyStatus: 'stable',
          containmentPreferredRaw: null,
          consistencyReason: undefined,
          questionType: 'map_fill',
          readAnswer1: { status: 'auto', studentAnswer: placeholder },
          readAnswer2: { status: 'auto', studentAnswer: placeholder },
          answerBbox: classifyRow?.answerBbox ?? null,
          bboxCorrected: classifyRow?.bboxCorrected || false,
          calculationAnswerMismatch: false,
          framingReason: classifyRow?.framingReason || undefined
        }
      }

      // 有 positions[] → 跑 per-position consistency
      const { ai1: mfRead1, ai2: mfRead2, positions } = mfData
      const r1Map = new Map(mfRead1.map((r) => [r.position_idx, String(r.student_text ?? '')]))
      const r2Map = new Map(mfRead2.map((r) => [r.position_idx, String(r.student_text ?? '')]))
      const perPosition = positions.map((p, i) => {
        const idx = i + 1
        const ai1_text = r1Map.get(idx) ?? ''
        const ai2_text = r2Map.get(idx) ?? ''
        return {
          idx,
          name: p.name,
          desc: p.desc,
          ai1_text,
          ai2_text,
          consistent: ai1_text === ai2_text
        }
      })
      const allConsistent = perPosition.every((p) => p.consistent)
      const consistencyStatus = allConsistent ? 'stable' : 'diff'

      // synthesize readAnswer1/2 給既有相容邏輯（join 非空 readings 作 string）
      const joinReadings = (m) => positions
        .map((_, i) => (m.get(i + 1) || '').trim())
        .filter(Boolean)
        .join(', ')
      const r1Str = joinReadings(r1Map)
      const r2Str = joinReadings(r2Map)

      return {
        questionId,
        consistencyStatus,
        containmentPreferredRaw: null,
        consistencyReason: allConsistent ? undefined : `${perPosition.filter((p) => !p.consistent).length} 個位置 AI1/AI2 不一致`,
        questionType: 'map_fill',
        readAnswer1: { status: 'read', studentAnswer: r1Str || '' },
        readAnswer2: { status: 'read', studentAnswer: r2Str || '' },
        answerBbox: classifyRow?.answerBbox ?? null,
        bboxCorrected: classifyRow?.bboxCorrected || false,
        calculationAnswerMismatch: false,
        framingReason: classifyRow?.framingReason || undefined,
        // 🆕 per-position 細節給前端 ConsistencyQuestionCard 顯示
        mapFillReadings: { ai1: mfRead1, ai2: mfRead2, perPosition }
      }
    }

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
      calculationAnswerMismatch: read1?.calculationAnswerMismatch === true,
      framingReason: classifyRow?.framingReason || undefined
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
          apiKey, model: readModel,
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
            // 2026-06-30：拼字驗證只抓「字母(拼字)真的不同」。只差標點/空格/大小寫 ≠ 拼錯 → 不覆蓋、不強制送審。
            //   修實證 bug：原始 read1==read2「No , he doesn't」、拼字 AI 回「No he doesn't」(少逗號) → 被當不一致強制 NR。
            const lettersOnly = (t) => ensureString(t, '').toLowerCase().replace(/[^a-z0-9]/g, '')
            if (lettersOnly(studentText) !== lettersOnly(prevAi2)) {
              qr._dbgOrigRead2 = prevAi2  // 2026-06-30 debug：保留拼字 override 前的原始 read2
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

  // 2026-05-17: stopBeforeArbiter early-return（拆 arbiter 出獨立 HTTP call）
  // 走到這裡：OCR + classify + read1+read2 + E↔F + English spelling/spacing 全跑完
  // 接下來的 AI3-arbiter + 最終 build 改成第二支 endpoint（runStagedGradingPhaseAArbiter）跑
  if (stopBeforeArbiter) {
    // 收集 OCR-assist 過的 qids（A3 ocrBlankOverride 邏輯需要）
    const ocrAssistedQidsList = []
    for (const page of ocrAssistMeta.perPage) {
      for (const qid of Object.keys(page.candidates || {})) ocrAssistedQidsList.push(qid)
    }
    // alignedQuestions 輕量版本（A3 重切 crop 時用 bbox）
    const alignedQuestionsLite = classifyAligned.map((q) => ({
      questionId: q.questionId,
      questionType: q.questionType,
      visible: q.visible,
      answerBbox: q.answerBbox ? { x: +q.answerBbox.x, y: +q.answerBbox.y, w: +q.answerBbox.w, h: +q.answerBbox.h } : null,
      bboxCorrected: !!q.bboxCorrected,
      framingReason: q.framingReason || undefined
    }))
    // stage_log 寫入用、純文字
    const classifySummary = {
      coverage: classifyResult?.coverage,
      visibleCount: classifyAligned.filter((q) => q.visible).length
    }
    const extractMin = (result) => {
      const answers = Array.isArray(result?.answers) ? result.answers : []
      return answers.map((a) => ({
        questionId: a.questionId,
        status: a.status,
        answer: a.studentAnswerRaw || a.studentAnswer || ''
      }))
    }
    const readAnswer1Mini = extractMin(readAnswerResult)
    const readAnswer2Mini = extractMin(reReadAnswerResult)
    const stageLatencySoFar = stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0)

    logStaged(pipelineRunId, 'basic', `PhaseA 早退（stopBeforeArbiter）→ 等 client 打 phase_a_arbiter`, {
      pipelineRunId,
      contextBytes: '~50KB',
      questionCount: questionResultsRaw.length,
      ocrAssistedCount: ocrAssistedQidsList.length,
      stageLatencyMsSoFar: stageLatencySoFar
    })

    return {
      phaseAReadyForArbiter: true,
      _phaseAReadContext: {
        pipelineRunId,
        stagedLogLevel,
        questionResultsRaw,
        alignedQuestionsLite,
        ocrAssistedQids: ocrAssistedQidsList,
        isEnglishDomainForSpelling,
        // stage_log 重建用（A3 寫最終 phase_a row）
        classifySummary,
        readAnswer1Mini,
        readAnswer2Mini,
        ocrAssistMeta: ocrAssistMeta.perPage.length > 0 ? ocrAssistMeta : null,
        stageLatencyMsSoFar: stageLatencySoFar,
        // backward compat：A3 完跑完才合成完整 _internal（含 cropByQuestionId、由 A3 重切）
        answerKey,
        questionIds
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
      // 2026-06-21 Bug H：雙方都 unreadable → 自動 needs_review（不送 AI3）。
      //   否則 AI3 會把「無法辨識」=「無法辨識」判成一致 → arbitrated_agree、finalAnswer=「無法辨識」
      //   → 靜默 0 分、不進人工審查、Bug A 閘門也漏接(因 arbiterStatus 非 needs_review、finalAnswer 非空)。
      //   排除後掉進下方「both unreadable → needs_review」fallback(原註解本意)。
      if (s1 === 'unreadable' && s2 === 'unreadable') return false
      // status='auto' → map_fill 舊資料 fallback、Phase B 視覺評分、不需 AI3
      if (s1 === 'auto' || s2 === 'auto') return false
      // map_fill 走 per-position consistency、不用 AI3 整題比對
      if (qr.questionType === 'map_fill') return false
      // VJ 視覺判斷題走 blank 分類 + Phase B grade、不用 AI3
      if (VISUAL_JUDGMENT_TYPES.has(qr.questionType)) return false
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
  if (!AI3_ARBITER_ENABLED) {
    logStaged(pipelineRunId, 'basic', `[A3] AI3 停用 → 全系統確定性一致性（${arbiterItemsForAI3.length} 題走 computeConsistencyStatus fallback）`)
  } else if (arbiterItemsForAI3.length > 0) {
    try {
      // Build AI3 parts: text prompt + full image + interleaved (label + crop) per question
      const arbiterPromptText = buildArbiterPrompt(arbiterItemsForAI3)
      // AI3 一致性判官：只看文字，不看圖片
      const arbiterParts = [{ text: arbiterPromptText }]
      logStageStart(pipelineRunId, 'AI3-arbiter')
      const arbiterResponse = await executeStage({
        apiKey,
        model: readModel,
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
          const item = matchArbiterItemByQid(r?.questionId, arbiterItems)
          if (!item) continue
          const decision = applyForensicDecision(r, item.ai1Answer, item.ai2Answer)
          arbiterByQuestionId.set(item.questionId, {
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

  // ── Arbiter Quality Gate + Auto-Retry (max 1) ──
  const ai3ResultCount = arbiterByQuestionId.size
  if (ai3ResultCount > 0 && arbiterItemsForAI3.length > 0) {
    const arbiterExpectedIds = arbiterItemsForAI3.map((item) => item.questionId)
    let arbiterQG = validateArbiterQuality(Array.from(arbiterByQuestionId.values()), arbiterExpectedIds)
    logStaged(pipelineRunId, 'basic', 'arbiter quality-gate', {
      severity: arbiterQG.severity, warnings: arbiterQG.warnings, metrics: arbiterQG.metrics
    })

    if (arbiterQG.severity === QG_SEVERITY.FAIL) {
      logStaged(pipelineRunId, stagedLogLevel, 'arbiter quality FAIL → retry (1/1)')
      try {
        const retryPrompt = buildArbiterPrompt(arbiterItemsForAI3)
        const retryResp = await executeStage({
          apiKey,
          model: readModel,
          payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
          timeoutMs: getRemainingBudget(),
          routeHint,
          routeKey: AI_ROUTE_KEYS.GRADING_ARBITER,
          stageContents: [{ role: 'user', parts: [{ text: retryPrompt }] }]
        })
        logStageEnd(pipelineRunId, 'AI3-arbiter-retry', retryResp)
        stageResponses.push(retryResp)
        if (retryResp.ok) {
          const retryParsed = parseCandidateJson(retryResp.data)
          const retryResults = Array.isArray(retryParsed?.consistencyResults) ? retryParsed.consistencyResults : []
          // Replace prior decisions with retry results (retry is the authoritative re-run)
          arbiterByQuestionId.clear()
          for (const r of retryResults) {
            const item = matchArbiterItemByQid(r?.questionId, arbiterItemsForAI3)
            if (!item) continue
            const decision = applyForensicDecision(r, item.ai1Answer, item.ai2Answer)
            arbiterByQuestionId.set(item.questionId, {
              arbiterStatus: decision.arbiterStatus,
              finalAnswer: decision.finalAnswer,
              consistent: r.consistent,
              reason: r.reason || undefined
            })
          }
          arbiterQG = validateArbiterQuality(Array.from(arbiterByQuestionId.values()), arbiterExpectedIds)
          logStaged(pipelineRunId, 'basic', 'arbiter retry quality-gate', {
            severity: arbiterQG.severity, warnings: arbiterQG.warnings
          })
        }
      } catch (retryErr) {
        logStaged(pipelineRunId, stagedLogLevel, 'arbiter retry threw', { error: retryErr?.message })
      }

      if (arbiterQG.severity === QG_SEVERITY.FAIL) {
        return buildFailureReturn('arbiter', [arbiterQG], { readAnswerResult, reReadAnswerResult })
      }
    }
  }

  // 🆕 Build set of OCR-assisted question IDs（用於下方 blank-override 邏輯）
  const ocrAssistedQids = new Set()
  for (const page of ocrAssistMeta.perPage) {
    for (const qid of Object.keys(page.candidates || {})) ocrAssistedQids.add(qid)
  }

  // Build final questionResults with arbiterResult attached
  const ocrBlankOverrides = []
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

    // 🆕 未作答（blank）vs 未讀取（unreadable）區分：
    // 當 OCR-assist 已確認 bbox 對齊到答題行（high confidence position）+
    // 任一 AI 判讀為 blank（status='blank'）→
    // 視為「學生未作答」、改成 stable 不送老師審查（finalAnswer='' → frontend 顯示「未作答」）
    //
    // 與「未讀取」的差別：
    //   - blank（未作答）：AI 看到完全空白 / 「未作答」字樣 → 學生明確沒寫
    //   - unreadable（未讀取）：AI 看到字但讀不出來 → 仍需老師審查
    //
    // OCR-assist 用過 → bbox 位置可信、blank 判讀也跟著可信 → 不再因為另一 AI hallucinate
    // 短亂碼就觸發 needs_review。
    if (arbiterResult.arbiterStatus === 'needs_review' && ocrAssistedQids.has(qr.questionId)) {
      const r1Status = qr.readAnswer1?.status
      const r2Status = qr.readAnswer2?.status
      if (r1Status === 'blank' || r2Status === 'blank') {
        ocrBlankOverrides.push({
          questionId: qr.questionId,
          r1: r1Status === 'blank' ? '(blank)' : ensureString(qr.readAnswer1?.studentAnswer, ''),
          r2: r2Status === 'blank' ? '(blank)' : ensureString(qr.readAnswer2?.studentAnswer, ''),
        })
        arbiterResult = { arbiterStatus: 'arbitrated_agree', finalAnswer: '', ocrBlankOverride: true }
      }
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

  // ── Table edge leak detection 已移除：依賴 legacy tablePosition.col/row 元數據，
  //    新 table_cell type 走整表批改（cellValues 在 read 階段已能對齊每 cell），不需此檢查。

  // 🆕 Log OCR-anchored blank overrides
  if (ocrBlankOverrides.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, 'OCR-anchored blank override', ocrBlankOverrides)
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

  // ── Excessive blanks safety net: 未作答 > 3 整批翻 needs_review、可能 classify 飄掉 ──
  const EXCESSIVE_BLANKS_THRESHOLD = 3
  const blankCount = questionResults.filter((qr) =>
    qr.arbiterResult?.arbiterStatus === 'arbitrated_agree' &&
    !ensureString(qr.arbiterResult?.finalAnswer, '').trim()
  ).length
  if (blankCount > EXCESSIVE_BLANKS_THRESHOLD) {
    const excessiveBlankFlipped = []
    for (const qr of questionResults) {
      const ar = qr.arbiterResult
      if (ar?.arbiterStatus === 'arbitrated_agree' && !ensureString(ar?.finalAnswer, '').trim()) {
        qr.arbiterResult = {
          ...ar,
          arbiterStatus: 'needs_review',
          excessiveBlanksFlag: true,
          excessiveBlanksReason: `本份共 ${blankCount} 題未作答、可能 AI 題目定位漂掉、請確認`
        }
        const cropData = allQuestionCropMap.get(qr.questionId)
        if (cropData) {
          qr.answerCropImageUrl = `data:${cropData.mimeType};base64,${cropData.data}`
        } else if (fullImageDataUrl) {
          qr.answerCropImageUrl = fullImageDataUrl
        }
        excessiveBlankFlipped.push(qr.questionId)
      }
    }
    if (excessiveBlankFlipped.length > 0) {
      logStaged(pipelineRunId, stagedLogLevel,
        `excessive blanks (${blankCount}>${EXCESSIVE_BLANKS_THRESHOLD}) → ${excessiveBlankFlipped.length} 題翻 needs_review`,
        excessiveBlankFlipped)
    }
  }

  const stableCount = questionResults.filter((q) => q.arbiterResult?.arbiterStatus !== 'needs_review').length
  const diffCount = 0  // no longer used (legacy compat: kept at 0)
  const unstableCount = questionResults.filter((q) => q.arbiterResult?.arbiterStatus === 'needs_review').length
  logStaged(pipelineRunId, stagedLogLevel, 'PhaseA 3-AI summary', {
    arbitratedCount: stableCount,
    needsReviewCount: unstableCount
  })

  // 寫入 Phase A stage log 到 Supabase（await 確保 serverless 環境下不漏存）
  logStaged(pipelineRunId, 'basic', 'OCR-assist final summary (before save)', {
    enabled: ocrAssistMeta.enabled,
    perPageLen: ocrAssistMeta.perPage.length,
    willSaveToLog: ocrAssistMeta.perPage.length > 0,
    perPageStatuses: ocrAssistMeta.perPage.map(p => ({
      page: p.page,
      hasError: !!p.stats?.error,
      skipped: p.stats?.skipped,
      ocrElapsedMs: p.stats?.ocrElapsedMs,
      ocrDetections: p.stats?.ocrDetections
    }))
  })
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
      unstableCount,
      ocrAssistMeta: ocrAssistMeta.perPage.length > 0 ? ocrAssistMeta : null  // 🆕 寫進 stage_logs.classify.ocrAssist
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

  // 2026-05-26: 補上 unsplit (legacy) path 的 phase_a_state 持久化
  // 原本只有 runStagedGradingPhaseAArbiter (split path 第 3 endpoint) 寫、
  // legacy unsplit path 沒寫 → 後續「重新批改」(fromCache) 找不到 phase_a_state
  // 案例：1778869831881-ybuzhswr0 graded=true 但 phase_a_state=null、re-grade 報錯
  const submissionIdForPersist = internalContext?.submissionId || payload?.submissionId
  if (submissionIdForPersist) {
    const extractMin = (result) => {
      const answers = Array.isArray(result?.answers) ? result.answers : []
      return answers.map((a) => ({
        questionId: a.questionId,
        status: a.status,
        answer: a.studentAnswerRaw || a.studentAnswer || ''
      }))
    }
    const readAnswer1MiniLegacy = extractMin(readAnswerParsed || readAnswerResult)
    const readAnswer2MiniLegacy = extractMin(reReadAnswerParsed)
    const reconstructedClassifyResult = {
      coverage: classifyResult?.coverage,
      alignedQuestions: (classifyResult?.alignedQuestions || []).map((q) => ({
        questionId: q.questionId,
        questionType: q.questionType,
        visible: q.visible,
        answerBbox: q.answerBbox ? { x: +q.answerBbox.x, y: +q.answerBbox.y, w: +q.answerBbox.w, h: +q.answerBbox.h } : null,
        bboxCorrected: !!q.bboxCorrected,
        framingReason: q.framingReason || undefined
      }))
    }
    const phaseAStateToPersist = {
      version: 1,
      pipelineRunId,
      stagedLogLevel,
      model,
      answerKey,
      questionIds,
      classifyResult: reconstructedClassifyResult,
      readAnswer1: readAnswer1MiniLegacy || [],
      readAnswer2: readAnswer2MiniLegacy || [],
      arbiterDecisions: questionResults.map((qr) => ({
        questionId: qr.questionId,
        arbiterStatus: qr.arbiterResult?.arbiterStatus,
        finalAnswer: qr.arbiterResult?.finalAnswer,
        consistent: qr.arbiterResult?.consistent,
        // 2026-06-30 debug：查「兩讀相同卻 NR」真因（AI3 off 時走確定性判定）。確認後可移除。
        _dbgConsistencyStatus: qr.consistencyStatus,
        _dbgConsistencyReason: qr.consistencyReason,
        _dbgSpellingOverride: qr.spellingOverride || undefined,
        _dbgSpacingReview: qr.spacingReviewFlag || undefined,
        _dbgOrigRead2: qr._dbgOrigRead2
      })),
      savedAt: new Date().toISOString()
    }
    await persistPhaseAState(submissionIdForPersist, phaseAStateToPersist)
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
// Phase A Arbiter: 獨立 HTTP call 跑 AI3 + 最終 build
//
// 2026-05-17：拆 arbiter 出獨立 endpoint、解決 290s budget 把 AI3 擠死的痛點。
// 流程：client 先打 grading.phase_a (with phaseAStopBeforeArbiter=true)、拿 _phaseAReadContext、
//      再打 grading.phase_a_arbiter (帶原圖 + _phaseAReadContext) 跑完剩下的。
// 各 call 各吃自己的 300s budget、AI3 永遠跑得完。
// ─────────────────────────────────────────────────────────────────────────────
export async function runStagedGradingPhaseAArbiter({
  apiKey,
  model,
  contents,
  payload = {},
  routeHint = {},
  internalContext = {}
}) {
  // 2026-05-21: model 分流移到 executeStage 內查 STAGE_MODEL[routeKey]
  // arbiter 純文字 LLM call → FLASH；舊 STAGED_READ_MODEL_OVERRIDE 已拔
  const readModel = STAGE_MODEL[AI_ROUTE_KEYS.GRADING_ARBITER]

  const phaseAReadContext = payload?._phaseAReadContext || internalContext?._phaseAReadContext
  if (!phaseAReadContext || typeof phaseAReadContext !== 'object') {
    throw new Error('runStagedGradingPhaseAArbiter: _phaseAReadContext is required')
  }
  const {
    pipelineRunId,
    stagedLogLevel: ctxLogLevel,
    questionResultsRaw,
    alignedQuestionsLite,
    ocrAssistedQids,
    isEnglishDomainForSpelling,
    classifySummary,
    readAnswer1Mini,
    readAnswer2Mini,
    ocrAssistMeta,
    stageLatencyMsSoFar,
    answerKey,
    questionIds
  } = phaseAReadContext
  const stagedLogLevel = ctxLogLevel || getStagedLogLevel()

  logStaged(pipelineRunId, 'basic', `[A3] 進場 questionCount=${questionResultsRaw?.length || 0} ocrAssistedCount=${(ocrAssistedQids || []).length} model=${model}`)

  const pipelineStartedAt = Date.now()
  // A3 自己的 budget — 純文字 LLM + 重切 needs_review crop、夠用
  const ARBITER_BUDGET_MS = 290_000
  const getRemainingBudget = () => Math.max(1000, ARBITER_BUDGET_MS - (Date.now() - pipelineStartedAt))

  const stageResponses = []
  const ocrAssistedQidSet = new Set(Array.isArray(ocrAssistedQids) ? ocrAssistedQids : [])
  const alignedById = new Map((alignedQuestionsLite || []).map((q) => [q.questionId, q]))

  // ── AI3 Arbiter call ──
  const arbiterItems = (questionResultsRaw || [])
    .filter((qr) => {
      const s1 = qr.readAnswer1?.status
      const s2 = qr.readAnswer2?.status
      if (s1 === 'blank' && s2 === 'blank') return false
      // status='auto' → map_fill 跳過 Read、Phase B Accessor 直接視覺評分、不需 AI3
      // 跟 runStagedGradingPhaseA 內部的 arbiter filter 對齊（兩個 endpoint 都要擋）
      if (s1 === 'auto' || s2 === 'auto') return false
      // 2026-05-30 修：split 路徑漏了這兩個排除（full 路徑 8013-8015 有）→ VJ/map_fill 被
      // 送進 AI3 文字仲裁、AI3 的文字一致性判定蓋過 blank/per-position 路由（空白該送審卻自動過）。
      if (qr.questionType === 'map_fill') return false
      if (VISUAL_JUDGMENT_TYPES.has(qr.questionType)) return false
      return true
    })
    .map((qr) => ({
      questionId: qr.questionId,
      questionType: qr.questionType,
      ai1Answer: qr.readAnswer1?.studentAnswer,
      ai1Status: qr.readAnswer1?.status,
      ai2Answer: qr.readAnswer2?.studentAnswer,
      ai2Status: qr.readAnswer2?.status
    }))

  logStaged(pipelineRunId, 'basic', `[A3] arbiter 候選 ${arbiterItems.length} 題（已扣掉雙 blank）`)

  const arbiterByQuestionId = new Map()
  if (!AI3_ARBITER_ENABLED) {
    logStaged(pipelineRunId, 'basic', `[A3] AI3 停用 → 全系統確定性一致性（${arbiterItems.length} 題走 computeConsistencyStatus fallback）`)
  } else if (arbiterItems.length > 0) {
    try {
      const arbiterPromptText = buildArbiterPrompt(arbiterItems)
      const arbiterParts = [{ text: arbiterPromptText }]
      logStageStart(pipelineRunId, 'AI3-arbiter')
      const arbiterResponse = await executeStage({
        apiKey,
        model: readModel,
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
        const unmatchedQids = []
        for (const r of results) {
          const item = matchArbiterItemByQid(r?.questionId, arbiterItems)
          if (!item) { unmatchedQids.push(ensureString(r?.questionId).trim() || '(empty)'); continue }
          const decision = applyForensicDecision(r, item.ai1Answer, item.ai2Answer)
          arbiterByQuestionId.set(item.questionId, {  // 用 canonical 題號當 key、下游 get(questionId) 才對得上
            arbiterStatus: decision.arbiterStatus,
            finalAnswer: decision.finalAnswer,
            consistent: r.consistent,
            reason: r.reason || undefined
          })
        }
        const consistentCount = Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus === 'arbitrated_agree').length
        const inconsistentCount = Array.from(arbiterByQuestionId.values()).filter((v) => v.arbiterStatus === 'needs_review').length
        logStaged(pipelineRunId, 'basic', `[A3] AI3 判定完成 一致=${consistentCount} 不一致=${inconsistentCount} 收到=${results.length}/${arbiterItems.length} 匹配=${arbiterByQuestionId.size}`)
        if (unmatchedQids.length > 0) {
          logStaged(pipelineRunId, 'basic', `[A3] ⚠️ ${unmatchedQids.length} 筆 AI3 結果對不上題號（會退 fallback）`, { aiReturned: unmatchedQids.slice(0, 8), expected: arbiterItems.map((i) => i.questionId).slice(0, 8) })
        }
      } else {
        logStaged(pipelineRunId, 'basic', `[A3] AI3 失敗 status=${arbiterResponse.status} → fallback 純字串比對`)
      }
    } catch (arbiterErr) {
      logStaged(pipelineRunId, stagedLogLevel, '[A3] AI3 例外 → fallback', { error: arbiterErr?.message })
    }
  }

  // ── Arbiter Quality Gate + Auto-Retry ──
  let arbiterQGFinal = null
  const ai3ResultCount = arbiterByQuestionId.size
  if (ai3ResultCount > 0 && arbiterItems.length > 0) {
    const arbiterExpectedIds = arbiterItems.map((item) => item.questionId)
    let arbiterQG = validateArbiterQuality(Array.from(arbiterByQuestionId.values()), arbiterExpectedIds)
    logStaged(pipelineRunId, 'basic', `[A3] 品質檢查 嚴重度=${arbiterQG.severity}`, { warnings: arbiterQG.warnings, metrics: arbiterQG.metrics })

    if (arbiterQG.severity === QG_SEVERITY.FAIL) {
      logStaged(pipelineRunId, stagedLogLevel, '[A3] arbiter QG FAIL → retry (1/1)')
      try {
        const retryPrompt = buildArbiterPrompt(arbiterItems)
        const retryResp = await executeStage({
          apiKey,
          model: readModel,
          payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
          timeoutMs: getRemainingBudget(),
          routeHint,
          routeKey: AI_ROUTE_KEYS.GRADING_ARBITER,
          stageContents: [{ role: 'user', parts: [{ text: retryPrompt }] }]
        })
        logStageEnd(pipelineRunId, 'AI3-arbiter-retry', retryResp)
        stageResponses.push(retryResp)
        if (retryResp.ok) {
          const retryParsed = parseCandidateJson(retryResp.data)
          const retryResults = Array.isArray(retryParsed?.consistencyResults) ? retryParsed.consistencyResults : []
          arbiterByQuestionId.clear()
          for (const r of retryResults) {
            const item = matchArbiterItemByQid(r?.questionId, arbiterItems)
            if (!item) continue
            const decision = applyForensicDecision(r, item.ai1Answer, item.ai2Answer)
            arbiterByQuestionId.set(item.questionId, {
              arbiterStatus: decision.arbiterStatus,
              finalAnswer: decision.finalAnswer,
              consistent: r.consistent,
              reason: r.reason || undefined
            })
          }
          arbiterQG = validateArbiterQuality(Array.from(arbiterByQuestionId.values()), arbiterExpectedIds)
          logStaged(pipelineRunId, 'basic', `[A3] retry QG 嚴重度=${arbiterQG.severity}`)
        }
      } catch (retryErr) {
        logStaged(pipelineRunId, stagedLogLevel, '[A3] retry 例外', { error: retryErr?.message })
      }
    }
    arbiterQGFinal = arbiterQG
  }

  // ── Build final questionResults (含 needs_review crop URL) ──
  const ocrBlankOverrides = []
  const inlineImages = extractInlineImages(contents)
  const inlineImage = inlineImages[0]
  const fullImageDataUrl = inlineImage
    ? `data:${inlineImage.inlineData.mimeType};base64,${inlineImage.inlineData.data}`
    : undefined

  // 先建構 questionResults（不含 crop URL）、判斷 needs_review 後再補 crop
  const questionResultsPreCrop = (questionResultsRaw || []).map((qr) => {
    let arbiterResult = arbiterByQuestionId.get(qr.questionId) ?? (() => {
      const s1 = qr.readAnswer1?.status
      const s2 = qr.readAnswer2?.status
      if (s1 === 'blank' && s2 === 'blank') {
        return { arbiterStatus: 'arbitrated_agree', finalAnswer: '' }
      }
      if (s1 === 'unreadable' && s2 === 'unreadable') {
        return { arbiterStatus: 'needs_review' }
      }
      return qr.consistencyStatus === 'stable'
        ? { arbiterStatus: 'arbitrated_agree', finalAnswer: qr.readAnswer1?.studentAnswer }
        : { arbiterStatus: 'needs_review' }
    })()
    if (arbiterResult.arbiterStatus === 'arbitrated_agree' && qr.containmentPreferredRaw) {
      arbiterResult = { ...arbiterResult, finalAnswer: qr.containmentPreferredRaw }
    }
    // OCR-assisted + blank → 視為未作答（與 runStagedGradingPhaseA 邏輯一致）
    if (arbiterResult.arbiterStatus === 'needs_review' && ocrAssistedQidSet.has(qr.questionId)) {
      const r1Status = qr.readAnswer1?.status
      const r2Status = qr.readAnswer2?.status
      if (r1Status === 'blank' || r2Status === 'blank') {
        ocrBlankOverrides.push({
          questionId: qr.questionId,
          r1: r1Status === 'blank' ? '(blank)' : ensureString(qr.readAnswer1?.studentAnswer, ''),
          r2: r2Status === 'blank' ? '(blank)' : ensureString(qr.readAnswer2?.studentAnswer, '')
        })
        arbiterResult = { arbiterStatus: 'arbitrated_agree', finalAnswer: '', ocrBlankOverride: true }
      }
    }
    return { ...qr, arbiterResult }
  })

  // ── Excessive blanks safety net: 未作答 > 3 整批翻 needs_review、可能 classify 飄掉 ──
  // 放在 crop 之前、讓翻過去的 blank 自然進 needsReviewQids 拿到 crop
  const EXCESSIVE_BLANKS_THRESHOLD = 3
  const blankCountPreCrop = questionResultsPreCrop.filter((qr) =>
    qr.arbiterResult?.arbiterStatus === 'arbitrated_agree' &&
    !ensureString(qr.arbiterResult?.finalAnswer, '').trim()
  ).length
  if (blankCountPreCrop > EXCESSIVE_BLANKS_THRESHOLD) {
    const excessiveBlankFlipped = []
    for (const qr of questionResultsPreCrop) {
      const ar = qr.arbiterResult
      if (ar?.arbiterStatus === 'arbitrated_agree' && !ensureString(ar?.finalAnswer, '').trim()) {
        qr.arbiterResult = {
          ...ar,
          arbiterStatus: 'needs_review',
          excessiveBlanksFlag: true,
          excessiveBlanksReason: `本份共 ${blankCountPreCrop} 題未作答、可能 AI 題目定位漂掉、請確認`
        }
        excessiveBlankFlipped.push(qr.questionId)
      }
    }
    if (excessiveBlankFlipped.length > 0) {
      logStaged(pipelineRunId, stagedLogLevel,
        `[A3] excessive blanks (${blankCountPreCrop}>${EXCESSIVE_BLANKS_THRESHOLD}) → ${excessiveBlankFlipped.length} 題翻 needs_review`,
        excessiveBlankFlipped)
    }
  }

  // Re-crop needs_review 題 + 空白題（省 wall time + 頻寬，只切會被審查的）
  // 2026-05-31: 空白題（兩次皆 blank → arbitrated_agree + 空 finalAnswer）前端會拉進「待複核」、
  //   讓老師確認「真空白 vs AI 漏讀」→ 也要 crop，否則審查時沒圖可看。排除 map_fill/VJ（走各自路徑）。
  const cropQids = questionResultsPreCrop
    .filter((qr) => {
      const st = qr.arbiterResult?.arbiterStatus
      if (st === 'needs_review') return true
      const isBlankAgree = st === 'arbitrated_agree'
        && !ensureString(qr.arbiterResult?.finalAnswer, '').trim()
        && qr.questionType !== 'map_fill'
        && !VISUAL_JUDGMENT_TYPES.has(qr.questionType)
      return isBlankAgree
    })
    .map((qr) => qr.questionId)

  const cropByQuestionId = new Map()
  if (cropQids.length > 0 && inlineImage) {
    const cropResults = await Promise.all(
      cropQids.map(async (qid) => {
        const aq = alignedById.get(qid)
        if (!aq?.answerBbox) return { qid, cropData: null }
        // 2026-05-26：fill_blank 改 wide bbox 後、子題 bbox 已涵蓋整題幹、不再給小 cropPad 防鄰格
        const cropPad = 0.005
        const cropData = await cropInlineImageByBbox(
          inlineImage.inlineData.data,
          inlineImage.inlineData.mimeType,
          inflateBboxForType(aq.answerBbox, aq.questionType),
          true,
          cropPad
        )
        return { qid, cropData }
      })
    )
    for (const { qid, cropData } of cropResults) {
      if (cropData) cropByQuestionId.set(qid, cropData)
    }
    logStaged(pipelineRunId, 'basic', `[A3] 重切 crop（needs_review + 空白）${cropQids.length} 題、成功 ${cropByQuestionId.size}`)
  }

  const questionResults = questionResultsPreCrop.map((qr) => {
    const isNeedsReview = qr.arbiterResult?.arbiterStatus === 'needs_review'
    const cropData = cropByQuestionId.get(qr.questionId)
    let answerCropImageUrl
    // 有切到 crop（needs_review 或 空白題）→ 一律附上；needs_review 切失敗才退全圖
    // （空白題切失敗不退全圖、避免每張空白卷都塞整張大圖膨脹 payload）
    if (cropData) {
      answerCropImageUrl = `data:${cropData.mimeType};base64,${cropData.data}`
    } else if (isNeedsReview && fullImageDataUrl) {
      answerCropImageUrl = fullImageDataUrl
    }
    return { ...qr, answerCropImageUrl, hasCropImage: !!cropData }
  })

  // ── English spacing review flag（pre-arbiter 階段加上 spacingReviewFlag、這邊轉成 needs_review）──
  const spacingReviewFlagged = []
  for (const qr of questionResults) {
    const rawQr = (questionResultsRaw || []).find((r) => r.questionId === qr.questionId)
    if (rawQr?.spacingReviewFlag && qr.arbiterResult?.arbiterStatus !== 'needs_review') {
      qr.arbiterResult = {
        ...qr.arbiterResult,
        arbiterStatus: 'needs_review',
        spacingReviewFlag: true,
        spacingReviewReason: '學生書寫可能有多餘空格，請老師確認'
      }
      const cropData = cropByQuestionId.get(qr.questionId)
      if (cropData) {
        qr.answerCropImageUrl = `data:${cropData.mimeType};base64,${cropData.data}`
      }
      spacingReviewFlagged.push(qr.questionId)
    }
  }
  if (spacingReviewFlagged.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, '[A3] english spacing flagged', spacingReviewFlagged)
  }

  // ── Per-question summary log ──
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
  logStaged(pipelineRunId, 'basic', '[A3] per-question summary', '\n' + perQuestionLog.join('\n'))

  if (ocrBlankOverrides.length > 0) {
    logStaged(pipelineRunId, stagedLogLevel, '[A3] OCR-anchored blank override', ocrBlankOverrides)
  }

  const stableCount = questionResults.filter((q) => q.arbiterResult?.arbiterStatus !== 'needs_review').length
  const diffCount = 0
  const unstableCount = questionResults.filter((q) => q.arbiterResult?.arbiterStatus === 'needs_review').length
  logStaged(pipelineRunId, 'basic', `[A3] 最終統計 stable=${stableCount} needs_review=${unstableCount}`)

  // ── stage_log 寫入（完整 phase_a row、合併 pre-arbiter 跟 arbiter 的 metrics） ──
  if (internalContext?.ownerId) {
    const ownStageLatency = stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0)
    const totalStageLatency = (Number(stageLatencyMsSoFar) || 0) + ownStageLatency
    const phaseALogData = {
      classify: {
        coverage: classifySummary?.coverage,
        visibleCount: classifySummary?.visibleCount,
        ...(ocrAssistMeta ? { ocrAssist: ocrAssistMeta } : {})
      },
      read_answer_1: readAnswer1Mini || [],
      read_answer_2: readAnswer2Mini || [],
      arbiter: Array.from(arbiterByQuestionId.entries()).map(([qId, r]) => ({
        questionId: qId,
        status: r.arbiterStatus,
        finalAnswer: r.finalAnswer,
        consistent: r.consistent,
        reason: r.reason
      })),
      quality_gates: arbiterQGFinal
        ? { arbiter: { severity: arbiterQGFinal.severity, warnings: arbiterQGFinal.warnings, metrics: arbiterQGFinal.metrics } }
        : {},
      stage_latencies: { total_ms: totalStageLatency },
      needs_review_count: unstableCount
    }
    try {
      await saveGradingStageLog({
        ownerId: internalContext.ownerId,
        assignmentId: internalContext.assignmentId || payload?.assignmentId || '',
        submissionId: internalContext.submissionId || payload?.submissionId || '',
        pipelineRunId,
        phase: 'phase_a',
        model,
        logData: phaseALogData
      })
    } catch (e) {
      logStaged(pipelineRunId, 'basic', '[A3] stage_log 寫入失敗 (non-fatal)', { error: e?.message })
    }
  }

  // 重建 classifyResult-like 物件給 _internal（Phase B 需要 alignedQuestions）
  const reconstructedClassifyResult = {
    coverage: classifySummary?.coverage,
    alignedQuestions: alignedQuestionsLite || []
  }

  // 2026-05-17: Phase A 完成、寫 phase_a_state 進 submissions、讓 Phase B「重新批改」(fromCache) 可以從這裡讀
  // 不用 client round-trip 整份 _phaseContext
  const submissionIdForPersist = internalContext?.submissionId || payload?.submissionId
  if (submissionIdForPersist) {
    const phaseAStateToPersist = {
      version: 1,
      pipelineRunId,
      stagedLogLevel,
      model,
      answerKey,
      questionIds,
      classifyResult: reconstructedClassifyResult,
      // 額外帶 read1 / read2 答案、給「重新批改」時老師複查需要
      readAnswer1: readAnswer1Mini || [],
      readAnswer2: readAnswer2Mini || [],
      // 帶 arbiter 決策、給「重新批改」時 default finalAnswers 用
      arbiterDecisions: questionResults.map((qr) => ({
        questionId: qr.questionId,
        arbiterStatus: qr.arbiterResult?.arbiterStatus,
        finalAnswer: qr.arbiterResult?.finalAnswer,
        consistent: qr.arbiterResult?.consistent,
        // 2026-06-30 debug：查「兩讀相同卻 NR」真因（AI3 off 時走確定性判定）。確認後可移除。
        _dbgConsistencyStatus: qr.consistencyStatus,
        _dbgConsistencyReason: qr.consistencyReason,
        _dbgSpellingOverride: qr.spellingOverride || undefined,
        _dbgSpacingReview: qr.spacingReviewFlag || undefined,
        _dbgOrigRead2: qr._dbgOrigRead2
      })),
      savedAt: new Date().toISOString()
    }
    await persistPhaseAState(submissionIdForPersist, phaseAStateToPersist)
  }

  logStaged(pipelineRunId, 'basic', `[A3] 離場 整段耗時=${Math.round((Date.now() - pipelineStartedAt) / 1000)}s`)

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
      classifyResult: reconstructedClassifyResult,
      readAnswerResult: { answers: readAnswer1Mini || [] },
      stageResponses,
      stageWarnings: [],
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
  // 2026-05-17: fromCache 模式——當 payload.fromCache=true 且有 submissionId、
  // 從 submissions.phase_a_state + final_answers 讀、不從 client round-trip 取。
  // 用途：「重新批改」（XX 分 → Phase B 重跑、用快取的 Phase A 結果）
  const fromCache = payload?.fromCache === true
  const submissionIdForCache = internalContext?.submissionId || payload?.submissionId || null
  if (fromCache && submissionIdForCache && !phaseAResult) {
    const cached = await loadPhaseAState(submissionIdForCache)
    if (!cached?.phase_a_state) {
      throw new Error(`runStagedGradingPhaseB fromCache: 找不到 submission=${submissionIdForCache} 的 phase_a_state`)
    }
    const cachedState = cached.phase_a_state
    // 2026-05-18: 從 cached state 重建 questionResults（Phase B 後續 line 8232 mapByQuestionId 需要）
    // 用 read1 / read2 / arbiterDecisions / alignedQuestions 拼回 PhaseAQuestionResult[]
    const r1ByQid = new Map((Array.isArray(cachedState.readAnswer1) ? cachedState.readAnswer1 : [])
      .map((r) => [r.questionId, r]))
    const r2ByQid = new Map((Array.isArray(cachedState.readAnswer2) ? cachedState.readAnswer2 : [])
      .map((r) => [r.questionId, r]))
    const arbByQid = new Map((Array.isArray(cachedState.arbiterDecisions) ? cachedState.arbiterDecisions : [])
      .map((d) => [d.questionId, d]))
    const alignedQs = Array.isArray(cachedState.classifyResult?.alignedQuestions)
      ? cachedState.classifyResult.alignedQuestions : []
    const reconstructedQuestionResults = alignedQs.map((aq) => {
      const r1 = r1ByQid.get(aq.questionId)
      const r2 = r2ByQid.get(aq.questionId)
      const arb = arbByQid.get(aq.questionId)
      return {
        questionId: aq.questionId,
        questionType: aq.questionType,
        readAnswer1: r1 ? { status: r1.status, studentAnswer: r1.answer } : { status: 'unreadable', studentAnswer: '' },
        readAnswer2: r2 ? { status: r2.status, studentAnswer: r2.answer } : { status: 'unreadable', studentAnswer: '' },
        arbiterResult: arb ? {
          arbiterStatus: arb.arbiterStatus,
          finalAnswer: arb.finalAnswer,
          consistent: arb.consistent
        } : undefined,
        consistencyStatus: arb?.consistent === true ? 'stable' : arb?.consistent === false ? 'diff' : 'unstable',
        answerBbox: aq.answerBbox,
        bboxCorrected: !!aq.bboxCorrected,
        framingReason: aq.framingReason
      }
    })

    // 2026-05-18: answerKey 用 assignments 的 live 版、不用 phase_a_state.answerKey 快取
    //   原 bug：老師改 assignment.answer_key 後按重新批改、accessor 仍用快取舊答案、分數不變
    //   修法：fromCache path 永遠抓 live；phase_a_state 只該快取 classify/read 結果（bbox/學生筆跡）、不該快取標準答案
    const liveAnswerKeyRaw = cached.live_answer_key || cachedState.answerKey
    // table_check → table_cell 正規化（fromCache/重新批改路徑不經 PhaseA funnel，需在此補做、否則 accessor 看到 table_check 會斷判分）
    const liveAnswerKey = liveAnswerKeyRaw && Array.isArray(liveAnswerKeyRaw.questions)
      ? { ...liveAnswerKeyRaw, questions: liveAnswerKeyRaw.questions.map(normalizeTableCheckQuestion) }
      : liveAnswerKeyRaw
    if (cached.live_answer_key && cachedState.answerKey) {
      const cachedAnsJson = JSON.stringify(cachedState.answerKey?.questions || [])
      const liveAnsJson = JSON.stringify(cached.live_answer_key?.questions || [])
      if (cachedAnsJson !== liveAnsJson) {
        console.log(`[PhaseB fromCache] answerKey drift detected (cached vs live) submission=${submissionIdForCache}、用 live 版`)
      }
    }
    phaseAResult = {
      questionResults: reconstructedQuestionResults,
      _phaseContext: {
        answerKey: liveAnswerKey,
        questionIds: cachedState.questionIds,
        classifyResult: cachedState.classifyResult,
        pipelineRunId: cachedState.pipelineRunId,
        stagedLogLevel: cachedState.stagedLogLevel
      }
    }
    // 優先用 payload 帶來的 finalAnswers（老師可能剛改）、否則用 DB 快取的
    if (!Array.isArray(finalAnswers) || finalAnswers.length === 0) {
      if (Array.isArray(cached.final_answers) && cached.final_answers.length > 0) {
        finalAnswers = cached.final_answers
        console.log(`[PhaseB fromCache] 用 DB 快取的 final_answers count=${finalAnswers.length}`)
      } else if (Array.isArray(cachedState.arbiterDecisions)) {
        // 連 final_answers 都沒有？用 arbiter 決策當預設（適用於剛跑完 Phase A、老師沒改過的 case）
        finalAnswers = cachedState.arbiterDecisions
          .filter((d) => d.arbiterStatus === 'arbitrated_agree' || d.finalAnswer)
          .map((d) => ({
            questionId: d.questionId,
            finalStudentAnswer: d.finalAnswer || '',
            finalAnswerSource: 'ai_read1'
          }))
        console.log(`[PhaseB fromCache] 用 arbiterDecisions 推估 final_answers count=${finalAnswers.length}`)
      }
    }
    // 2026-06-01 安全網：finalAnswers（payload 或 DB 快取）可能只含老師手改的少數題——其餘乾淨題被
    //   「重跑 Phase A 只留 manual」清掉、client rebuild 又遇 local phaseAState stale 沒補回 →
    //   漏題在 Phase B 被當「無法辨識」0 分（實測 數習P66-69 5/12 號全 0）。
    //   這裡一律用 arbiterDecisions 補「finalAnswers 沒有、但有 AI 讀取結果」的題（只補、不覆蓋老師已確認的）。
    if (!Array.isArray(finalAnswers)) finalAnswers = []
    if (Array.isArray(cachedState.arbiterDecisions) && cachedState.arbiterDecisions.length > 0) {
      const faQids = new Set(finalAnswers.map((fa) => fa?.questionId).filter(Boolean))
      let filledFromArbiter = 0
      // 2026-06-30 [REVIEW_AFTER_B 重構步驟1/server]：NR 題（arbiter 無 finalAnswer）改用 read2 補
      //   provisional 答案，讓 Phase B 先批一個暫定分數（末端審查再讓老師確認/二選一）。
      //   2026-06-30 改為**預設開**（kill-switch：REVIEW_AFTER_B='false' 才回舊流程；須與 client VITE_REVIEW_AFTER_B 對齊）。
      const reviewAfterB = process.env.REVIEW_AFTER_B !== 'false'
      const r2Prov = reviewAfterB
        ? new Map((Array.isArray(cachedState.readAnswer2) ? cachedState.readAnswer2 : []).map((r) => [r.questionId, r]))
        : null
      for (const d of cachedState.arbiterDecisions) {
        if (!d?.questionId || faQids.has(d.questionId)) continue
        if (typeof d.finalAnswer !== 'string') {
          // needs_review 無 finalAnswer：現行不補（保持缺、留審查）；REVIEW_AFTER_B 開時用 read2 補 provisional。
          if (r2Prov) {
            const r2 = r2Prov.get(d.questionId)
            if (r2 && r2.status === 'read' && typeof r2.answer === 'string' && r2.answer.trim()) {
              finalAnswers.push({
                questionId: d.questionId,
                finalStudentAnswer: r2.answer,
                finalAnswerSource: 'ai_read2_provisional'
              })
              filledFromArbiter++
            }
          }
          continue
        }
        finalAnswers.push({
          questionId: d.questionId,
          finalStudentAnswer: d.finalAnswer,
          finalAnswerSource: 'ai_read1'
        })
        filledFromArbiter++
      }
      if (filledFromArbiter > 0) {
        console.log(`[PhaseB fromCache] 安全網：finalAnswers 缺 ${filledFromArbiter} 題、用 arbiterDecisions 補回（避免漏題被當無法辨識）`)
      }
    }
  }

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

  // gradeBand: 'high' (年級 10-12) → 多選用大考中心扣分公式；其他（含 NULL/k9）→ 現行公式
  // 由 client 從 assignment.classroomId → classroom.grade 推算後傳入；server 不主動查 DB
  const gradeBand = payload?.gradeBand === 'high' ? 'high' : 'k9'
  // 2026-05-18: Phase B 拆 2 個獨立 HTTP call、各自吃 300s budget、client 端 loading UI 可精準切換 stage
  //   call 1 — grading.phase_b_accessor (payload.stopAfterAccessor=true): 跑 accessor、回 _phaseBAccessorContext
  //   call 2 — grading.phase_b (existing) 帶 _phaseBAccessorContext: 跳過 accessor、跑 explain + 最終 build
  const stopAfterAccessor = payload?.stopAfterAccessor === true
  // 2026-06-30 錯題引導改 on-demand：skipExplain=true 時，Phase B 只跑 accessor + 組最終結果、不跑 explain AI call。
  //   client 一律帶 skipExplain（accessor call 直接回最終 GradingResult、不再打第二支 explain）。可由 client 停送來回退。
  const skipExplain = payload?.skipExplain === true
  const precomputedAccessorContext = payload?._phaseBAccessorContext || internalContext?._phaseBAccessorContext || null
  // 2026-05-21: model 分流移到 executeStage 內查 STAGE_MODEL[routeKey]
  // accessor / explain 都是純文字 → MODEL_FLASH；舊 STAGED_PHASE_B_MODEL_OVERRIDE 已拔
  const phaseBModel = STAGE_MODEL[AI_ROUTE_KEYS.GRADING_ACCESSOR]
  logStaged(pipelineRunId, 'basic', `[B] Phase B model=${phaseBModel}（由 model-config.js 決定）`)
  logStaged(pipelineRunId, stagedLogLevel, `PhaseB begin gradeBand=${gradeBand} (multi_choice 公式: ${gradeBand === 'high' ? '大考中心 -2/錯' : 'K-9 比例'})`)

  const inlineImages = extractInlineImages(contents)
  const submissionImageParts = inlineImages.length > 0 ? [inlineImages[0]] : []

  // 答案卷模式 + 題本圖（answer_only 模式下 Explain 用題本圖而非學生答案卷）
  const answerSheetMode = internalContext?.answerSheetMode || 'with_questions'
  const rawBookletImages = Array.isArray(internalContext?.questionBookletImages) ? internalContext.questionBookletImages : []
  const questionBookletImageParts = rawBookletImages.map(img => ({
    inlineData: { mimeType: img.mimeType || 'image/webp', data: img.data }
  }))
  const hasBooklet = answerSheetMode === 'answer_only' && questionBookletImageParts.length > 0
  // answer_only + 無題本：不附任何圖（buildExplainPrompt 走通用引導分支，禁止 AI 編造題目）
  // answer_only + 有題本：附題本圖
  // with_questions：附學生卷（既有行為）
  const explainImageParts = answerSheetMode === 'answer_only'
    ? (hasBooklet ? questionBookletImageParts : [])
    : submissionImageParts

  const phaseBStartedAt = Date.now()
  const PHASE_B_BUDGET_MS = 180_000
  const getRemainingBudget = () => Math.max(1000, PHASE_B_BUDGET_MS - (Date.now() - phaseBStartedAt))

  // 將老師確認的 finalAnswers 轉為 readAnswerResult 格式
  const finalReadAnswerResult = finalAnswersToReadAnswerResult(finalAnswers)

  // ── 2026-05-20: Phase 0 + Phase 2 — calc/word_problem 特殊處理 ─────────────
  // Phase 0：manual-edit 過的 word_problem/calculation → 跳過 Accessor LLM、走 deterministic
  //   理由：老師既然手動編輯 final answer、就代表他親眼確認過原圖、信任他、不讓 AI 再用同一張可能爛的 crop 反咬。
  // Phase 2：final answer 跟 expected 不一致的題 → Accessor 收 prompt 但不收 crop
  //   理由：final 已錯、不需 crop 評列式品質、直接 0 分；也省 token。
  const calcTypes = new Set(['calculation', 'word_problem'])
  // 2026-05-28: map_fill 已 pivot 到 Direction Y、走 map-fill-grader、不再經 Accessor。
  // cropTypesForAccessor 只剩 calc/word_problem、不再含 map_fill。
  const cropTypesForAccessor = new Set([...calcTypes])
  const akQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  const akQById = new Map(akQuestions.map((q) => [ensureString(q?.id).trim(), q]))

  // Phase 0：找出 manual-edited word_problem/calculation 題
  const manualBypassIds = new Set()
  const deterministicScores = []  // 等等要 merge 進 accessorResult.scores
  for (const ans of finalReadAnswerResult.answers) {
    if (ans?.source !== 'manual') continue
    const q = akQById.get(ans.questionId)
    if (!q || !calcTypes.has(q?.questionCategory)) continue
    manualBypassIds.add(ans.questionId)
    const studentText = ans.studentAnswerRaw
    const expectedText = ensureString(q?.answer, '')
    const isBlank = ans.status === 'blank'
    const isUnreadable = ans.status === 'unreadable'
    let isMatch = false
    if (!isBlank && !isUnreadable) {
      isMatch = manualEditDeterministicMatch(studentText, expectedText)
    }
    const maxScore = Math.max(0, toFiniteNumber(q?.maxScore) ?? 0)
    deterministicScores.push({
      questionId: ans.questionId,
      isCorrect: isMatch,
      score: isMatch ? maxScore : 0,
      maxScore,
      errorType: isMatch ? 'none' : (isBlank ? 'blank' : isUnreadable ? 'unreadable' : 'calculation'),
      reason: isMatch
        ? '老師人工確認最終答案、與標準相符'
        : (isBlank ? '老師人工確認、未作答'
          : isUnreadable ? '老師人工確認、無法辨識'
          : '老師人工確認最終答案、與標準不符'),
      confidence: 100,
      studentFinalAnswer: studentText,
      needExplain: !isMatch && !isBlank && !isUnreadable,
      _manualBypass: true
    })
  }
  if (manualBypassIds.size > 0) {
    logStaged(pipelineRunId, 'basic', `[B-Phase0] manual-bypass word_problem/calculation`, {
      count: manualBypassIds.size,
      questionIds: [...manualBypassIds]
    })
  }

  // Phase 0b (2026-06-02 stage2)：客觀選擇題用 code 直接判、不送 Accessor LLM（省 token）。
  // 安全：single_choice 最終分數本來就由「程式化覆核」(buildFinalGradingResult) 確定性決定、
  //   accessor 的判分一律被覆寫；故跳過 accessor 對最終成績中性、只省掉白做的 AI token。
  //   只 bypass gradeObjectiveDeterministic 可判的（選項代號型，canonical 跨記號 99.5% 對 AI 且更準）；
  //   選項是文字/多字者回 gradable=false → 不 bypass、仍交 Accessor。
  const objectiveBypassIds = new Set()
  for (const ans of finalReadAnswerResult.answers) {
    const qid = ensureString(ans?.questionId).trim()
    if (!qid || manualBypassIds.has(qid)) continue
    const q = akQById.get(qid)
    if (!q || q.questionCategory !== 'single_choice') continue
    const res = gradeObjectiveDeterministic(q, ans.studentAnswerRaw, ans.status)
    if (!res.gradable) continue
    objectiveBypassIds.add(qid)
    deterministicScores.push({
      questionId: qid,
      isCorrect: res.isCorrect,
      score: res.score,
      maxScore: res.maxScore,
      errorType: res.errorType,
      reason: res.scoringReason,
      scoringReason: res.scoringReason,
      confidence: 100,
      scoreConfidence: 100,
      studentFinalAnswer: ensureString(ans.studentAnswerRaw, ''),
      needExplain: !res.isCorrect && res.errorType !== 'blank',
      _objectiveBypass: true
    })
  }
  if (objectiveBypassIds.size > 0) {
    logStaged(pipelineRunId, 'basic', `[B-Phase0b] single_choice code-bypass（不送 Accessor）`, {
      count: objectiveBypassIds.size
    })
  }

  // ── Phase 0c：句子克漏字（fill_blank 單一整句）確定性批改、不送 Accessor ─────────
  // 英語閱讀／聽力問答題答句整句、印刷字一定對 → 逐詞 LCS、分數=配分−錯詞數。詳見 gradeSentenceClozeDeterministic。
  // 2026-06-28 預設開（kill switch CLOZE_DETERMINISTIC_ENABLED='false' 可關）。沙盒驗證(N=6生×3題、含空白/拼錯/數字錯)：
  //   分數忠實、印刷框字不誤扣、read2 不幻覺；read1≠read2 仍走 Phase A 待複核（本區只動 Phase B 算分、不碰 arbiterStatus）。
  // 只收 fill_blank 「單一整句」（無 parts、英文≥3詞、配分≥2）；parts 合題仍交 Accessor（不變）。
  const clozeBypassIds = new Set()
  if (process.env.CLOZE_DETERMINISTIC_ENABLED !== 'false') {
    for (const ans of finalReadAnswerResult.answers) {
      const qid = ensureString(ans?.questionId).trim()
      if (!qid || manualBypassIds.has(qid) || objectiveBypassIds.has(qid)) continue
      const q = akQById.get(qid)
      if (!q || q.questionCategory !== 'fill_blank') continue
      if (Array.isArray(q?.parts) && q.parts.length >= 2) continue  // 文章克漏字 parts → 交 AI
      const res = gradeSentenceClozeDeterministic(q, ans.studentAnswerRaw, ans.status)
      if (!res.gradable) continue
      clozeBypassIds.add(qid)
      deterministicScores.push({
        questionId: qid,
        isCorrect: res.isCorrect,
        score: res.score,
        maxScore: res.maxScore,
        errorType: res.errorType,
        reason: res.scoringReason,
        scoringReason: res.scoringReason,
        confidence: 100,
        scoreConfidence: 100,
        studentFinalAnswer: ensureString(ans.studentAnswerRaw, ''),
        needExplain: !res.isCorrect && res.errorType !== 'blank',
        _clozeBypass: true
      })
    }
    if (clozeBypassIds.size > 0) {
      logStaged(pipelineRunId, 'basic', `[B-Phase0c] 句子克漏字 code-bypass（不送 Accessor）`, {
        count: clozeBypassIds.size, questionIds: [...clozeBypassIds]
      })
    }
  }

  // ── Phase 1: map_fill 評分 ─────────────────────────────────────────────
  // 2026-05-28 pivot: 優先用 Phase A confirmed readings + deterministic match（不跑 AI）
  // 如果 finalAnswer 沒帶 per-position readings（舊資料）→ fallback 跑 Stage A+B（map-fill-grader）
  const mapFillBypassIds = new Set()
  const mapFillQuestions = akQuestions.filter((q) => q?.questionCategory === 'map_fill' && q?.id)
  // 用 finalAnswers 取得每個 questionId 的 per-position confirmed readings（client 帶上來）
  const finalAnswerByQid = new Map(
    (Array.isArray(finalAnswers) ? finalAnswers : []).map((a) => [ensureString(a?.questionId, '').trim(), a])
  )
  if (mapFillQuestions.length > 0 && inlineImages.length > 0) {
    const studentImg = inlineImages[0]?.inlineData
    if (studentImg?.data && studentImg?.mimeType) {
      logStaged(pipelineRunId, 'basic', `[B-MapFill] ${mapFillQuestions.length} 題評分中`)
      for (const q of mapFillQuestions) {
        const qId = String(q.id).trim()
        if (manualBypassIds.has(qId)) continue
        const acceptableAnswers = Array.isArray(q.acceptableAnswers) ? q.acceptableAnswers : []
        let mapFillFailed = null

        try {
          // 取 positions: 優先用 question.positions、fallback Stage A 即時偵測
          let positions = Array.isArray(q.positions) ? q.positions.filter((p) => p?.name && p?.desc) : null

          // ── Fast path: 用 finalAnswer.mapFillFinalReadings (Phase A confirmed) ──
          const fa = finalAnswerByQid.get(qId)
          const confirmedReadings = Array.isArray(fa?.mapFillFinalReadings) ? fa.mapFillFinalReadings : null

          if (confirmedReadings && positions && positions.length > 0 && confirmedReadings.length === positions.length) {
            // 直接 deterministic match、不跑 AI
            const result = gradeMapFillDeterministically(positions, confirmedReadings, acceptableAnswers)
            logStaged(pipelineRunId, 'basic',
              `[B-MapFill] ${qId} 用 Phase A confirmed readings 評分 score=${result.score}/${result.maxScore} ` +
              `correct=${result.summary.correct} wrong=${result.summary.wrong} ` +
              `blank=${result.summary.blank} unclear=${result.summary.unclear}`)
            deterministicScores.push({
              questionId: qId,
              isCorrect: result.isCorrect,
              score: result.score,
              maxScore: result.maxScore,
              errorType: result.isCorrect ? 'none'
                : result.summary.blank === result.maxScore ? 'blank'
                : 'concept',
              scoringReason: result.scoringReason,
              scoreConfidence: 100,
              studentFinalAnswer: result.studentFinalAnswer,
              needExplain: false,
              _mapFillBypass: true,
              mapFillResults: result.perPosResults
            })
            mapFillBypassIds.add(qId)
            continue
          }

          // ── Slow path fallback: positions[] 缺 / Phase A 沒帶 confirmed readings → 跑 Stage A+B ──
          if (!positions || positions.length === 0) {
            // Lazy backfill: 跑 Stage A
            if (!q.cropImagePath) {
              mapFillFailed = '無 positions[] 且無 cropImagePath、無法跑 Stage A'
            } else {
              // 下載 AnswerKey crop
              const supabase = getSupabaseAdmin()
              const { data: blob, error: dlErr } = await supabase.storage
                .from('homework-images')
                .download(q.cropImagePath)
              if (dlErr || !blob) {
                mapFillFailed = `AnswerKey crop 下載失敗：${dlErr?.message || 'no blob'}`
              } else {
                const cropBytes = Buffer.from(await blob.arrayBuffer())
                const cropMime = q.cropImagePath.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
                const stageAResp = await executeStage({
                  apiKey,
                  model: phaseBModel,
                  payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
                  timeoutMs: getRemainingBudget(),
                  routeHint,
                  routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR,
                  stageContents: [{
                    role: 'user',
                    parts: [
                      { text: buildStageAPrompt(acceptableAnswers) },
                      { inlineData: { mimeType: cropMime, data: cropBytes.toString('base64') } }
                    ]
                  }]
                })
                if (!stageAResp.ok) {
                  mapFillFailed = `Stage A HTTP ${stageAResp.status}`
                } else {
                  const stageARaw = extractCandidateText(stageAResp.data) || ''
                  positions = parseStageAResult(stageARaw)
                  if (!positions || positions.length === 0) {
                    mapFillFailed = 'Stage A parse 失敗或回空、無 positions'
                  } else {
                    logStaged(pipelineRunId, 'basic', `[B-MapFill] ${qId} Stage A lazy backfill ${positions.length} positions, ${stageAResp.modelLatencyMs}ms`)
                  }
                }
                stageResponses.push(stageAResp)
              }
            }
          }

          if (!mapFillFailed && positions && positions.length > 0) {
            // Stage B fallback: 跑 AI 讀學生卷（舊路徑、Phase A 沒 confirmed 時）
            const descs = positions.map((p) => p.desc)
            const stageBResp = await executeStage({
              apiKey,
              model: phaseBModel,
              payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
              timeoutMs: getRemainingBudget(),
              routeHint,
              routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR,
              stageContents: [{
                role: 'user',
                parts: [
                  { text: buildStageBPrompt(descs) },
                  { inlineData: { mimeType: studentImg.mimeType, data: studentImg.data } }
                ]
              }]
            })
            stageResponses.push(stageBResp)

            if (!stageBResp.ok) {
              mapFillFailed = `Stage B HTTP ${stageBResp.status}`
            } else {
              const stageBRaw = extractCandidateText(stageBResp.data) || ''
              const readings = parseStageBResult(stageBRaw, positions.length)
              if (!readings) {
                mapFillFailed = 'Stage B parse 失敗'
              } else {
                const result = gradeMapFillDeterministically(positions, readings, acceptableAnswers)
                logStaged(pipelineRunId, 'basic',
                  `[B-MapFill] ${qId} 完成 (Stage B fallback) score=${result.score}/${result.maxScore} ` +
                  `correct=${result.summary.correct} wrong=${result.summary.wrong} ` +
                  `blank=${result.summary.blank} unclear=${result.summary.unclear} ` +
                  `${stageBResp.modelLatencyMs}ms`)
                deterministicScores.push({
                  questionId: qId,
                  isCorrect: result.isCorrect,
                  score: result.score,
                  maxScore: result.maxScore,
                  errorType: result.isCorrect ? 'none'
                    : result.summary.blank === result.maxScore ? 'blank'
                    : 'concept',
                  scoringReason: result.scoringReason,
                  scoreConfidence: 100,
                  studentFinalAnswer: result.studentFinalAnswer,
                  needExplain: false,
                  _mapFillBypass: true,
                  mapFillResults: result.perPosResults
                })
                mapFillBypassIds.add(qId)
              }
            }
          }
        } catch (e) {
          mapFillFailed = `map_fill grading 例外：${e?.message || e}`
        }

        if (mapFillFailed) {
          logStaged(pipelineRunId, 'basic', `[B-MapFill] ${qId} 失敗、回退 needs_review`, { error: mapFillFailed })
          deterministicScores.push({
            questionId: qId,
            isCorrect: false,
            score: 0,
            maxScore: Math.max(0, toFiniteNumber(q?.maxScore) ?? 0),
            errorType: 'unreadable',
            scoringReason: `map_fill 評分失敗（${mapFillFailed}）、需老師人工複核`,
            scoreConfidence: 0,
            studentFinalAnswer: '',
            needExplain: false,
            _mapFillBypass: true,
            _mapFillFailed: true
          })
          mapFillBypassIds.add(qId)
        }
      }
    } else {
      logStaged(pipelineRunId, 'basic', `[B-MapFill] 無學生卷圖片、跳過 ${mapFillQuestions.length} 題`)
    }
  }

  // ── Phase 1b: VJ 視覺判斷題評分（PRO grade + 權威 blank 參數）─────────────
  // 2026-05-30: 用 finalAnswer.vjBlankConfirmed 決定哪些項非空白 → 只對非空白項跑 PRO grade。
  // 整題全空白 → deterministic 0、不發 grade call。vjRubric/blank 缺 → lazy backfill。
  const vjBypassIds = new Set()
  const vjQuestions = akQuestions.filter((q) => VISUAL_JUDGMENT_TYPES.has(q?.questionCategory) && q?.id)
  if (vjQuestions.length > 0) {
    const vjClassifyArr = Array.isArray(classifyResult)
      ? classifyResult
      : (classifyResult?.alignedQuestions || classifyResult?.questions || [])
    const studentImg = inlineImages[0]?.inlineData
    for (const q of vjQuestions) {
      const qId = String(q.id).trim()
      if (manualBypassIds.has(qId)) continue
      const maxScore = Number(q.maxScore) || 0
      try {
        // 1) 取 vjRubric（缺 → lazy A0 從 cropImagePath）
        let vjRubric = q.vjRubric && Array.isArray(q.vjRubric.itemLabels) && q.vjRubric.itemLabels.length > 0
          ? q.vjRubric : null
        if (!vjRubric && q.cropImagePath) {
          try {
            const supabase = getSupabaseAdmin()
            const { data: blob } = await supabase.storage.from('homework-images').download(q.cropImagePath)
            if (blob) {
              const cropMime = q.cropImagePath.endsWith('.jpg') ? 'image/jpeg' : 'image/webp'
              const refB64 = Buffer.from(await blob.arrayBuffer()).toString('base64')
              const resp = await executeStage({
                apiKey, model: phaseBModel, payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
                timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_VJ_RUBRIC,
                stageContents: [{ role: 'user', parts: [{ text: buildVjRubricPrompt(q.questionCategory, q.referenceAnswer || q.answer) }, { inlineData: { mimeType: cropMime, data: refB64 } }] }]
              })
              if (resp?.ok) vjRubric = parseVjRubricResult(extractCandidateText(resp.data) || '')
              if (resp) stageResponses.push(resp)
            }
          } catch (e) { logStaged(pipelineRunId, 'basic', `[B-VJ] ${qId} lazy A0 失敗：${e?.message}`) }
        }
        if (!vjRubric) {
          // 無法取得 rubric → 整題送審
          deterministicScores.push({
            questionId: qId, isCorrect: false, score: 0, maxScore, errorType: 'unreadable',
            scoringReason: '視覺判斷題：無法取得評判條件（answer key 未升級且無參考圖），請老師複核',
            scoreConfidence: 0, studentFinalAnswer: '', needExplain: false, _vjBypass: true, _vjFailed: true
          })
          vjBypassIds.add(qId)
          continue
        }
        const itemLabels = vjRubric.itemLabels
        const n = itemLabels.length

        // 2) 取 blank 確認（client finalAnswer.vjBlankConfirmed）
        const fa = finalAnswerByQid.get(qId)
        let blankConfirmed = Array.isArray(fa?.vjBlankConfirmed) ? fa.vjBlankConfirmed : null
        // 缺 → lazy 跑一次 PRO blank reader（auto-stable 流程客戶端通常會帶；此為保險）
        if (!blankConfirmed && studentImg?.data) {
          const classifyRow = vjClassifyArr.find((r) => (r.questionId || r.id) === qId)
          if (classifyRow?.answerBbox) {
            const crop = await cropInlineImageByBbox(studentImg.data, studentImg.mimeType, inflateBboxForType(classifyRow.answerBbox, classifyRow.questionType || q.questionCategory), true, 0.01)
            if (crop) {
              const resp = await executeStage({
                apiKey, model: phaseBModel, payload: { ...payload, ...READ_ANSWER_GENERATION_CONFIG },
                timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_VJ_BLANK,
                stageContents: [{ role: 'user', parts: [{ text: buildVjBlankPrompt(itemLabels) }, { inlineData: crop }] }]
              })
              if (resp?.ok) {
                const br = parseVjBlankResult(extractCandidateText(resp.data) || '', n) || []
                blankConfirmed = br.map((x) => ({ idx: x.idx, isBlank: x.hasMark !== 'yes' }))
              }
              if (resp) stageResponses.push(resp)
            }
          }
        }
        if (!blankConfirmed) blankConfirmed = itemLabels.map((_, i) => ({ idx: i + 1, isBlank: false }))
        const notBlank = blankConfirmed.filter((b) => !b.isBlank).map((b) => b.idx)

        // 3) 對非空白項跑 PRO grade（整題全空白 → 不發 call、直接 0）
        let grades = []
        if (notBlank.length > 0 && studentImg?.data) {
          const classifyRow = vjClassifyArr.find((r) => (r.questionId || r.id) === qId)
          const bbox = classifyRow?.answerBbox
          const crop = bbox ? await cropInlineImageByBbox(studentImg.data, studentImg.mimeType, inflateBboxForType(bbox, classifyRow.questionType || q.questionCategory), true, 0.01) : null
          if (crop) {
            const resp = await executeStage({
              apiKey, model: phaseBModel, payload: { ...payload, ...VJ_GRADE_GENERATION_CONFIG },
              timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_VJ_GRADE,
              stageContents: [{ role: 'user', parts: [{ text: buildVjGradePrompt(itemLabels, vjRubric.gradingDefinition, notBlank) }, { inlineData: crop }] }]
            })
            if (resp?.ok) grades = parseVjGradeResult(extractCandidateText(resp.data) || '', n) || []
            if (resp) stageResponses.push(resp)
          }
        }

        const agg = aggregateVjScore(itemLabels, blankConfirmed, grades, maxScore)
        logStaged(pipelineRunId, 'basic', `[B-VJ] ${qId} score=${agg.score}/${agg.maxScore} 非空白${notBlank.length}項`)
        // 學生答案＝blank 判讀的摘要文案（非文字、非對錯）：全空白→未作答、有任一柱作答→圖上作答
        const vjAllBlank = agg.vjItemResults.length > 0 && agg.vjItemResults.every((r) => r.verdict === 'blank')
        deterministicScores.push({
          questionId: qId, isCorrect: agg.isCorrect, score: agg.score, maxScore: agg.maxScore,
          errorType: agg.isCorrect ? 'none' : (notBlank.length === 0 ? 'blank' : 'concept'),
          scoringReason: agg.scoringReason, scoreConfidence: 100,
          studentFinalAnswer: vjAllBlank ? '未作答' : '圖上作答',
          needExplain: false, _vjBypass: true, vjItemResults: agg.vjItemResults
        })
        vjBypassIds.add(qId)
      } catch (e) {
        logStaged(pipelineRunId, 'basic', `[B-VJ] ${qId} 評分失敗：${e?.message} → 送審`)
        deterministicScores.push({
          questionId: qId, isCorrect: false, score: 0, maxScore, errorType: 'unreadable',
          scoringReason: `視覺判斷題評分失敗：${e?.message || ''}，請老師複核`,
          scoreConfidence: 0, studentFinalAnswer: '', needExplain: false, _vjBypass: true, _vjFailed: true
        })
        vjBypassIds.add(qId)
      }
    }
  }

  // Phase 2：找出 final ≠ expected 的 word_problem/calculation 題 (不含 manualBypass)
  const finalMismatchIds = new Set()
  for (const ans of finalReadAnswerResult.answers) {
    if (manualBypassIds.has(ans.questionId)) continue
    if (ans.status !== 'read') continue
    const q = akQById.get(ans.questionId)
    if (!q || !calcTypes.has(q?.questionCategory)) continue
    const studentText = ans.studentAnswerRaw
    const expectedText = ensureString(q?.answer, '')
    if (!manualEditDeterministicMatch(studentText, expectedText)) {
      finalMismatchIds.add(ans.questionId)
    }
  }
  if (finalMismatchIds.size > 0) {
    logStaged(pipelineRunId, 'basic', `[B-Phase2] final mismatch → skip crop for Accessor`, {
      count: finalMismatchIds.size
    })
  }

  // ── Crop calculation/word_problem questions for Accessor visual grading ──
  // Accessor needs to see the student's handwritten work (not just AI-transcribed text)
  // to accurately judge calculation process, fraction notation, etc.
  // 2026-05-20: skip crop for manualBypassIds (Accessor 不跑) + finalMismatchIds (final 已錯、不需評列式)
  const calcCropMap = new Map() // questionId → { data, mimeType }
  if (inlineImages.length > 0 && classifyResult) {
    // 2026-05-27: 修長期 bug — classifyResult 結構是 { alignedQuestions, coverage }、
    // 不是 { questions }。之前讀 classifyResult?.questions 永遠拿到 undefined、
    // calcCropMap 永遠空。對 calc/word_problem 沒事（用 text studentAnswer 評分）、
    // 但對 map_fill 致命（沒圖 + placeholder text → Accessor 認定學生未作答）。
    const classifyQuestionsArr = Array.isArray(classifyResult)
      ? classifyResult
      : (classifyResult?.alignedQuestions || classifyResult?.questions || [])
    const calcQuestions = classifyQuestionsArr
      .filter((q) => q.visible && q.answerBbox && cropTypesForAccessor.has(q.questionType))
      .filter((q) => !manualBypassIds.has(q.questionId) && !finalMismatchIds.has(q.questionId))
    if (calcQuestions.length > 0) {
      const img = inlineImages[0]?.inlineData
      if (img?.data && img?.mimeType) {
        const MAX_CALC_CROPS = 16 // 安全上限，避免 payload 過大
        const phaseBPages = new Set(questionIds.map((id) => { const m = id.match(/^(\d+)-/); return m ? parseInt(m[1], 10) : 1 })).size || 1
        const phaseBPad = +(0.01 / Math.max(1, phaseBPages)).toFixed(4)
        const cropTargets = calcQuestions.slice(0, MAX_CALC_CROPS)
        const cropResults = await Promise.all(
          cropTargets.map(async (q) => {
            const cropData = await cropInlineImageByBbox(img.data, img.mimeType, inflateBboxForType(q.answerBbox, q.questionType), true, phaseBPad)
            return { questionId: q.questionId, cropData }
          })
        )
        for (const { questionId, cropData } of cropResults) {
          if (cropData) calcCropMap.set(questionId, cropData)
        }
        logStaged(pipelineRunId, stagedLogLevel, 'PhaseB calc crop for Accessor', {
          candidates: cropTargets.length,
          succeeded: calcCropMap.size,
          skippedManual: manualBypassIds.size,
          skippedMismatch: finalMismatchIds.size
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

  // 2026-05-20: manualBypassIds 由下方 Accessor input filter 處理
  // 不動 finalReadAnswerResult.answers 本身、保持完整、給 downstream（mergeResults / cross-stage QG）用

  // ── B1: ACCESSOR (per-page parallel when multi-page) ─────────────────────
  // 2026-05-20: 排除 manualBypassIds（已有 deterministic score、不送 LLM）
  // 2026-05-28: 也排除 mapFillBypassIds（map_fill 走 Direction Y、Accessor 不看）
  const isBypassed = (id) => manualBypassIds.has(id) || mapFillBypassIds.has(id) || vjBypassIds.has(id) || objectiveBypassIds.has(id) || clozeBypassIds.has(id)
  const allAnswerIds = finalReadAnswerResult.answers
    .map((a) => ensureString(a?.questionId).trim())
    .filter((id) => id && !isBypassed(id))
  const page1AnswerIds = allAnswerIds.filter((id) => id.startsWith('1-'))
  const page2AnswerIds = allAnswerIds.filter((id) => id.startsWith('2-'))
  const otherAnswerIds = allAnswerIds.filter((id) => !id.startsWith('1-') && !id.startsWith('2-'))
  const canSplitAccessor = page1AnswerIds.length > 0 && page2AnswerIds.length > 0
  // 給 Accessor 的 readAnswerResult / answerKey 都要剔除所有 bypass 的題（manual + map_fill + VJ）
  const hasBypass = manualBypassIds.size > 0 || mapFillBypassIds.size > 0 || vjBypassIds.size > 0 || objectiveBypassIds.size > 0 || clozeBypassIds.size > 0
  const accessorReadAnswerResult = hasBypass
    ? { answers: finalReadAnswerResult.answers.filter((a) => !isBypassed(a.questionId)) }
    : finalReadAnswerResult
  const accessorAnswerKey = hasBypass
    ? { ...answerKey, questions: akQuestions.filter((q) => !isBypassed(ensureString(q?.id).trim())) }
    : answerKey

  let accessorResult
  // 2026-05-18: precomputedAccessorContext 路徑——拆 phase_b_explain 出獨立 call、跳過 accessor
  if (precomputedAccessorContext) {
    accessorResult = precomputedAccessorContext.accessorResult
    logStaged(pipelineRunId, 'basic', `[B] 跳過 accessor、用前一階段傳入的 _phaseBAccessorContext (scores=${accessorResult?.scores?.length || 0})`)
  } else if (allAnswerIds.length === 0) {
    // 2026-05-20: 所有題都被 manualBypassIds 拿掉 → 不跑 Accessor、deterministic scores 完整覆蓋
    accessorResult = { scores: [] }
    logStaged(pipelineRunId, 'basic', `[B] 所有題目都是 manual-bypass、跳過 Accessor LLM`)
  } else if (canSplitAccessor) {
    const p1Ids = new Set([...otherAnswerIds, ...page1AnswerIds])
    const p2Ids = new Set(page2AnswerIds)
    const filterAk = (ids) => ({ ...answerKey, questions: (answerKey?.questions || []).filter((q) => ids.has(ensureString(q?.id).trim())) })
    const filterRar = (ids) => ({ answers: finalReadAnswerResult.answers.filter((a) => ids.has(ensureString(a?.questionId).trim())) })
    const ak1 = filterAk(p1Ids); const ak2 = filterAk(p2Ids)
    const rar1 = filterRar(p1Ids); const rar2 = filterRar(p2Ids)

    logStageStart(pipelineRunId, 'Accessor-p1')
    logStageStart(pipelineRunId, 'Accessor-p2')
    const [accessorResp1, accessorResp2] = await Promise.all([
      executeStage({ apiKey, model: phaseBModel, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(buildAccessorPrompt(ak1, rar1, internalContext?.domainHint, gradeBand), [...p1Ids], calcCropMap) }] }),
      executeStage({ apiKey, model: phaseBModel, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(buildAccessorPrompt(ak2, rar2, internalContext?.domainHint, gradeBand), [...p2Ids], calcCropMap) }] })
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
      const retryResp1 = await executeStage({ apiKey, model: phaseBModel, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(buildAccessorPrompt(ak1, rar1, internalContext?.domainHint, gradeBand), [...p1Ids], calcCropMap) }] })
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
      const retryResp2 = await executeStage({ apiKey, model: phaseBModel, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(buildAccessorPrompt(ak2, rar2, internalContext?.domainHint, gradeBand), [...p2Ids], calcCropMap) }] })
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
    const accessorPrompt = buildAccessorPrompt(accessorAnswerKey, accessorReadAnswerResult, internalContext?.domainHint, gradeBand)
    logStageStart(pipelineRunId, 'Accessor')
    const accessorResponse = await executeStage({
      apiKey, model: phaseBModel, payload, timeoutMs: getRemainingBudget(), routeHint,
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
      const retryResp = await executeStage({ apiKey, model: phaseBModel, payload, timeoutMs: getRemainingBudget(), routeHint, routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR, stageContents: [{ role: 'user', parts: buildAccessorParts(accessorPrompt, allAnswerIds, calcCropMap) }] })
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
    accessorResult = normalizeAccessorResult(accessorParsed, accessorAnswerKey, accessorReadAnswerResult.answers, internalContext?.domainHint)
  }
  // 2026-05-20: 合併 deterministic scores (manual-bypass) 進 accessorResult
  if (deterministicScores.length > 0) {
    const existing = Array.isArray(accessorResult?.scores) ? accessorResult.scores : []
    const existingIds = new Set(existing.map((s) => ensureString(s?.questionId).trim()))
    const toAdd = deterministicScores.filter((s) => !existingIds.has(s.questionId))
    accessorResult = { ...accessorResult, scores: [...existing, ...toAdd] }
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
    // 2026-05-20: 用 accessorAnswerKey / accessorReadAnswerResult、跟主流程一致排除 manualBypassIds
    const retryPrompt = buildAccessorPrompt(accessorAnswerKey, accessorReadAnswerResult, internalContext?.domainHint, gradeBand)
    const retryContents = [{ role: 'user', parts: buildAccessorParts(retryPrompt, allAnswerIds, calcCropMap) }]
    logStageStart(pipelineRunId, 'Accessor-qg-retry')
    const retryAccessorResp = await executeStage({
      apiKey, model: phaseBModel, payload, timeoutMs: getRemainingBudget(), routeHint,
      routeKey: AI_ROUTE_KEYS.GRADING_ACCESSOR,
      stageContents: retryContents
    })
    logStageEnd(pipelineRunId, 'Accessor-qg-retry', retryAccessorResp)
    stageResponses.push(retryAccessorResp)
    if (retryAccessorResp.ok) {
      const retryParsed = parseCandidateJson(retryAccessorResp.data)
      if (retryParsed && typeof retryParsed === 'object') {
        let retryResult = normalizeAccessorResult(retryParsed, accessorAnswerKey, accessorReadAnswerResult.answers, internalContext?.domainHint)
        // 重新合併 deterministic scores (manual-bypass) 進 retry 結果
        if (deterministicScores.length > 0) {
          const existingIds = new Set((retryResult.scores || []).map((s) => ensureString(s?.questionId).trim()))
          const toAdd = deterministicScores.filter((s) => !existingIds.has(s.questionId))
          retryResult = { ...retryResult, scores: [...(retryResult.scores || []), ...toAdd] }
        }
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
    // 2026-05-30: VJ 視覺判斷題不進 explain（explain 是文字解釋、對 VJ 無用、白花一次 call；
    // VJ 的逐柱理由已由 grade 的 seen 提供）
    .filter((s) => !vjBypassIds.has(ensureString(s?.questionId).trim()))
    .map((s) => ensureString(s?.questionId).trim())
    .filter(Boolean)

  // 2026-05-18: stopAfterAccessor early-return（拆 explain 出獨立 HTTP call）
  // 走到這裡：accessor 跑完、explainQuestionIds 算好。
  // explain 改成第二支 endpoint（grading.phase_b_explain）跑、client loading UI 才能精準切換 stage。
  // 2026-06-30 skipExplain：accessor call 不早退、繼續往下跳過 explain 直接組最終結果（單一 call 完成 Phase B）。
  if (stopAfterAccessor && !skipExplain) {
    const stageLatencyMsSoFar = stageResponses.reduce((s, r) => s + (Number(r.modelLatencyMs) || 0), 0)
    logStaged(pipelineRunId, 'basic', `[B] 早退（stopAfterAccessor）→ 等 client 打 phase_b_explain`, {
      pipelineRunId,
      accessorScoreCount: accessorScores.length,
      explainQuestionCount: explainQuestionIds.length,
      stageLatencyMsSoFar
    })
    return {
      phaseBAccessorComplete: true,
      _phaseBAccessorContext: {
        pipelineRunId,
        stagedLogLevel,
        accessorResult,
        finalReadAnswerResult,
        explainQuestionIds,
        gradeBand,
        domainHint: internalContext?.domainHint,
        answerSheetMode,
        hasBooklet,
        stageLatencyMsSoFar
      }
    }
  }

  // ── B2: EXPLAIN (僅限 isFullScore=false) ─────────────────────────────────
  // 2026-06-30 錯題引導改 on-demand：skipExplain 時不跑 explain AI call、explainResult 留空
  //   （buildFinalGradingResult 對空 explain 已可正常運作；mistakes 仍有 details fallback）。
  let explainResult = { details: [], mistakes: [], weaknesses: [], suggestions: [] }
  if (!skipExplain && explainQuestionIds.length > 0) {
    const explainPrompt = buildExplainPrompt(
      answerKey,
      finalReadAnswerResult,
      accessorResult,
      explainQuestionIds,
      internalContext?.domainHint,
      answerSheetMode,
      hasBooklet
    )
    if (answerSheetMode === 'answer_only' && !hasBooklet) {
      logStaged(pipelineRunId, stagedLogLevel, 'explain mode=answer_only_no_booklet → 通用引導，不附圖')
    }
    logStageStart(pipelineRunId, 'explain')
    const explainResponse = await executeStage({
      apiKey,
      model: phaseBModel,
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
        apiKey, model: phaseBModel, payload, timeoutMs: getRemainingBudget(), routeHint,
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

  // 2026-05-28: Phase B 完成 = 老師已在 ConsistencyReviewPanel 處理過漏題 / 無法辨識
  // buildFinalGradingResult 的 reviewReasons 來自 Phase A classify.coverage 跟 unreadable、
  // 那些都是 Phase A 該處理的事、Phase B 完成後不該再吐「需複核」徽章誤導老師
  finalResult.needsReview = false
  finalResult.reviewReasons = []

  // 2026-06-30 [批兩候選]：reviewAfterB provisional 趟（client 帶 withReviewCandidates）對每個待複核(NR)題
  //   算 read1、read2 兩候選分數、附到 detail.reviewCandidates。末端審查老師點哪個就用哪個分數、
  //   finalize 純前端加總、不跑第二趟 Phase B。read2＝主批改(provisional 用 read2)已在 detail；
  //   read1：確定性題用 grader(免費)、非確定性題一次 focused accessor 補批（量少）。
  if (payload?.withReviewCandidates === true && Array.isArray(phaseAResult?.questionResults)) {
    try {
      const akById = new Map((Array.isArray(answerKey?.questions) ? answerKey.questions : [])
        .map((q) => [ensureString(q?.id).trim(), q]))
      const detById = new Map((Array.isArray(finalResult.details) ? finalResult.details : [])
        .map((d) => [ensureString(d?.questionId).trim(), d]))
      const nrQRs = phaseAResult.questionResults.filter((qr) => qr?.arbiterResult?.arbiterStatus === 'needs_review')
      if (nrQRs.length > 0) {
        const clozeOn = process.env.CLOZE_DETERMINISTIC_ENABLED !== 'false'
        const normTxt = (t) => ensureString(t, '').trim().toLowerCase().replace(/\s+/g, ' ')
        // read1 候選分數：① 與 read2 文字相同 → 直接沿用 read2(detail)分數（同字必同分、修「同答案不同分」）
        //   ② 確定性可判(選擇/判斷/可接受答案/整句克漏字) → 用 grader ③ 其餘 → 留 null
        //   （null 時末端審查若老師點 read1，finalize 會用 grading.grade_one 單題重批那一題、不會誤給 0）
        const read1ByQid = new Map()
        let detCount = 0, copyCount = 0, nullCount = 0
        for (const qr of nrQRs) {
          const qid = ensureString(qr?.questionId).trim()
          const q = akById.get(qid)
          if (!q) continue
          const detail = detById.get(qid)
          const r1text = ensureString(qr.readAnswer1?.studentAnswer, '')
          const r1status = ensureString(qr.readAnswer1?.status, 'read') || 'read'
          const r2text = ensureString(qr.readAnswer2?.studentAnswer, '')
          // ① 同字 → 沿用 read2 分數
          if (detail && normTxt(r1text) === normTxt(r2text)) {
            read1ByQid.set(qid, { score: toFiniteNumber(detail.score) ?? 0, maxScore: toFiniteNumber(detail.maxScore) ?? 0, isCorrect: detail.isCorrect === true, studentAnswer: r1text })
            copyCount++
            continue
          }
          // ② 確定性可判
          let r1res = gradeObjectiveDeterministic(q, r1text, r1status)
          if (!r1res.gradable && clozeOn) r1res = gradeSentenceClozeDeterministic(q, r1text, r1status)
          if (r1res.gradable) {
            read1ByQid.set(qid, { score: r1res.score, maxScore: r1res.maxScore, isCorrect: r1res.isCorrect, studentAnswer: r1text })
            detCount++
          } else {
            nullCount++  // 留 null：老師點 read1 時由 finalize 走 grade_one 單題重批
          }
        }
        let attached = 0
        for (const qr of nrQRs) {
          const qid = ensureString(qr?.questionId).trim()
          const detail = detById.get(qid)
          if (!detail) continue
          const read2 = {
            score: toFiniteNumber(detail.score) ?? 0,
            maxScore: toFiniteNumber(detail.maxScore) ?? 0,
            isCorrect: detail.isCorrect === true,
            studentAnswer: ensureString(qr.readAnswer2?.studentAnswer, '')
          }
          detail.reviewCandidates = { ai_read1: read1ByQid.get(qid) || null, ai_read2: read2 }
          attached++
        }
        logStaged(pipelineRunId, 'basic', `[批兩候選] 附 ${attached} 題（read1：同字沿用 ${copyCount}、確定性 ${detCount}、留 null 待點選重批 ${nullCount}）`)
      }
    } catch (e) { logStaged(pipelineRunId, 'basic', '[批兩候選] 計算失敗(忽略)', { error: e?.message }) }
  }

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

  // 2026-05-17: Phase B 完成、寫 final_answers 進 submissions
  // 「重新批改」(fromCache) 可以從這裡讀、或從這裡讀來預設 finalAnswers
  const submissionIdForFA = internalContext?.submissionId || payload?.submissionId
  if (submissionIdForFA && Array.isArray(finalAnswers) && finalAnswers.length > 0) {
    await persistFinalAnswers(submissionIdForFA, finalAnswers)
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
  【體積】 km³ = 立方公里   m³ = 立方公尺   cm³ = 立方公分 = cc = c.c.   mm³ = 立方公釐
  【重量】 kg = 公斤   g = 公克   mg = 毫克
  【容積】 L = 公升   mL = ml = 毫升
  【時間】 h = hr = 小時   min = 分 = 分鐘   s = sec = 秒
  【速度】 km/h = 公里/小時 = 時速X公里   m/s = 公尺/秒   m/min = 公尺/分鐘   km/min = 公里/分鐘
  Note: "時速X公里" (e.g. 時速60公里) = "X km/h" = "X 公里/小時" — treat as identical.
  Note: Same-name pairs above (e.g. cm³ ↔ 立方公分) ARE identical.
  Note: Different units (e.g. 公尺 vs 公分, kg vs g) are still WRONG even if both appear in this table.
  🚨 DIMENSION RULE: 長度 ≠ 面積 ≠ 體積 (m ≠ m² ≠ m³). Same number with wrong dimension = unit error.
  🚨 NUMBER MATCH: 精確比對、無容忍值。ref 帶「約/大約」是 π≈3.14 取近似、非容忍範圍 → 學生數值需完全相等。格式等價：5=5.0、1/2=0.5、1,000=1000。

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
- diagram_color / map_symbol / grid_geometry（視覺判斷題：學生在預印圖形上畫線／塗色／畫記／標符號，如「描柱高」「畫對稱軸」「標位置」）: This is a correction submission. **Judge VISUALLY from the correction photo.**
    * 看訂正照片，判斷學生**重畫**的內容現在是否正確滿足 referenceAnswer 描述的概念。
    * 🚨 接受「等價的合法答案」（最重要）：這類題常有**多個同樣正確的位置/畫法**（例：柱高＝任一條連接兩底面的側稜；對稱軸＝任一條合法對稱軸）。**不可要求和 referenceAnswer 舉的那一個例子完全重合**——只要學生畫在**任一個幾何上/概念上正確的位置**就 pass。
    * 畫在「底面內的邊／半徑／對角線」或其他非答案位置 → not passed。完全沒重畫或仍錯 → not passed。
    * 不要做文字比對；以「圖上畫的對不對」為準。
- short_answer / connect_dots: This is a correction submission.
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
