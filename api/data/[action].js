// Increase bodyParser limit close to Vercel hard cap (4.5mb) to leave room for
// correction payload metadata while frontend keeps images aggressively compressed.
export const config = {
  runtime: 'nodejs',
  api: { bodyParser: { sizeLimit: '4.5mb' } }
}

import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'
import { getEnvValue } from '../../server/_env.js'
import { runAiPipeline } from '../../server/ai/orchestrator.js'
import { AI_ROUTE_KEYS } from '../../server/ai/routes.js'
import { runRecheckPipeline } from '../../server/ai/staged-grading.js'
import { MODEL_PRO } from '../../server/ai/model-config.js'
import { computeInkPointsFromTokens } from '../../server/ink-session.js'
import { trackingContext } from '../../server/ink-usage-tracker.js'
import {
  isValidDsns,
  getJasmineAccessToken,
  fetchCampus1Courses,
  fetchCampus1CourseStudents
} from '../../server/_1campus.js'

const TAG_QUIET_MINUTES = 5
const DEFAULT_CORRECTION_ATTEMPT_LIMIT = 3
const CORRECTION_UNLOCK_INCREMENT = 3
const MAX_CORRECTION_ATTEMPT_LIMIT = 10

// 允許的 submission source 白名單（保護 sync upsert 不被 client 寫入意外值）
// teacher_student_upload 為 legacy（UnifiedImportPage 舊行為），保留供既有資料 upsert 時通過
const ALLOWED_SUBMISSION_SOURCES = new Set([
  'teacher_scan',
  'teacher_camera',
  'teacher_student_upload',
  'student_upload',
  'student_correction'
])
const HOMEWORK_IMAGES_BUCKET = 'homework-images'
// 2026-05-21: model 由 model-config.js 統一管理（學生訂正含 OCR、用 PRO）
// orchestrator 內 executeSinglePipelineCall 會依 routeKey=grading.recheck 再查一次、這裡只是 label
const STUDENT_CORRECTION_MODEL = MODEL_PRO

const DEFAULT_TEACHER_PREFERENCES = {
  student_portal_enabled: true,
  show_score_to_students: false,
  max_correction_attempts: DEFAULT_CORRECTION_ATTEMPT_LIMIT,
  lock_upload_after_graded: true,
  require_full_page_count: true,
  correction_dispatch_mode: 'manual',
  correction_due_at: null,
  student_feedback_visibility: 'score_reason'
}

const TEACHER_PREFERENCES_BASE_SELECT =
  'owner_id, student_portal_enabled, show_score_to_students, max_correction_attempts, lock_upload_after_graded, require_full_page_count'

const TEACHER_PREFERENCES_EXTENDED_SELECT =
  `${TEACHER_PREFERENCES_BASE_SELECT}, correction_dispatch_mode, correction_due_at, student_feedback_visibility`

function resolveAction(req) {
  const actionParam = req.query?.action
  if (Array.isArray(actionParam)) {
    return actionParam[0] || ''
  }
  if (typeof actionParam === 'string') return actionParam
  const pathname = req.url ? req.url.split('?')[0] : ''
  const segments = pathname.split('/').filter(Boolean)
  return segments[segments.length - 1] || ''
}

function parseJsonBody(req) {
  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return null
    }
  }
  return body || null
}

function toIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return null
}

function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function normalizeScoringMode(value) {
  if (value === 'unscored') return 'unscored'
  if (value === 'scored') return 'scored'
  return null
}

function normalizeAnswerSheetMode(value) {
  if (value === 'with_questions') return 'with_questions'
  if (value === 'answer_only') return 'answer_only'
  return null
}

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  )
}

function summarizeLogValue(value, depth = 0) {
  if (depth > 2) return '[MaxDepth]'
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}...<truncated>` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => summarizeLogValue(item, depth + 1))
  }
  if (value instanceof Error) {
    return getErrorDiagnostics(value, depth + 1)
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, item]) => [key, summarizeLogValue(item, depth + 1)])
    )
  }
  return String(value)
}

function getErrorDiagnostics(error, depth = 0) {
  if (!error || typeof error !== 'object') {
    return { value: String(error) }
  }

  const diagnostics = compactObject({
    type: Object.prototype.toString.call(error),
    name: typeof error.name === 'string' ? error.name : undefined,
    message: typeof error.message === 'string' ? error.message : undefined,
    code: typeof error.code === 'string' ? error.code : undefined,
    status:
      typeof error.status === 'number' || typeof error.status === 'string'
        ? error.status
        : undefined,
    details: typeof error.details === 'string' ? error.details : undefined,
    hint: typeof error.hint === 'string' ? error.hint : undefined,
    stack: typeof error.stack === 'string' ? error.stack : undefined
  })

  if (error.cause && depth < 3) {
    diagnostics.cause = getErrorDiagnostics(error.cause, depth + 1)
  }

  diagnostics.raw = summarizeLogValue(error, depth + 1)
  return diagnostics
}

function wrapError(message, cause) {
  const err = new Error(message)
  if (cause !== undefined) {
    try {
      err.cause = cause
    } catch {
      // ignore
    }
  }
  return err
}

function clampInteger(value, min, max, fallback) {
  const parsed = toNumber(value)
  if (!Number.isFinite(parsed)) return fallback
  const normalized = Math.round(parsed)
  if (normalized < min) return min
  if (normalized > max) return max
  return normalized
}

function isLegacyCorrectionQuestionItemsConstraintError(error) {
  const message =
    typeof error?.message === 'string' ? error.message : String(error || '')
  return message.includes(
    'correction_question_items_owner_id_assignment_id_student_id_key'
  )
}

function parseBooleanParam(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true') return true
    if (normalized === '0' || normalized === 'false') return false
  }
  return false
}

function applyNoStoreHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

/**
 * 用 .range() 分頁把整張表全撈下來、繞過 PostgREST 預設 cap (1000 筆)。
 *
 * 用法：傳入一個 builder thunk、每次呼叫都回傳一個全新的 query（已套好 .from / .select /
 * .eq 等 filter、但「不要」自己 call .range / .limit）。helper 會 clone-and-range 跑分頁。
 *
 * 為什麼回傳跟 supabase-js 一致的 { data, error } 格式：讓現有 caller 不用改 (Result.error /
 * Result.data 的解構照舊)。
 *
 * 2026-05-19: 佳軒老師 1040 submissions 被 cap 切掉 40 筆、學生上傳卻顯示「尚未繳交」就是
 * 這個 cap 沒處理。
 */
async function fetchAllPaginated(queryBuilder, pageSize = 1000) {
  const all = []
  for (let offset = 0; ; offset += pageSize) {
    const query = queryBuilder()
    const { data, error } = await query.range(offset, offset + pageSize - 1)
    if (error) return { data: null, error }
    if (!Array.isArray(data)) return { data: all, error: null }
    all.push(...data)
    if (data.length < pageSize) break
  }
  return { data: all, error: null }
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

function normalizeJsonLike(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function normalizeBbox(value) {
  if (!value || typeof value !== 'object') return null
  let x = toNumber(value.x)
  let y = toNumber(value.y)
  let w = toNumber(value.w)
  let h = toNumber(value.h)
  if (![x, y, w, h].every((v) => Number.isFinite(v))) return null
  if (w <= 0 || h <= 0) return null

  const looksLikePercent =
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 100.5 &&
    y + h <= 100.5 &&
    Math.max(x, y, w, h) <= 100.5
  const hasOutOfRangeNormalized = x > 1 || y > 1 || w > 1 || h > 1
  if (hasOutOfRangeNormalized && looksLikePercent) {
    x /= 100
    y /= 100
    w /= 100
    h /= 100
  }

  return { x, y, w, h }
}


function extractSubmissionIdFromImagePath(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const match = text.match(/(?:^|\/)submissions\/([^/?#]+)\.webp(?:[?#]|$)/i)
  if (!match || typeof match[1] !== 'string') return ''
  const submissionId = match[1].trim()
  return submissionId || ''
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function toSafePathSegment(value, fallback = 'x') {
  const text = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return text || fallback
}

function normalizeStoragePath(value) {
  const text = String(value || '').trim()
  if (!text) return ''

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      const pathname = String(url.pathname || '')
      const markers = [
        '/storage/v1/object/public/homework-images/',
        '/storage/v1/object/sign/homework-images/',
        '/object/public/homework-images/',
        '/object/sign/homework-images/'
      ]
      for (const marker of markers) {
        const index = pathname.indexOf(marker)
        if (index >= 0) {
          return decodeURIComponent(pathname.slice(index + marker.length)).replace(/^\/+/, '')
        }
      }
      const bucketIndex = pathname.indexOf('/homework-images/')
      if (bucketIndex >= 0) {
        return decodeURIComponent(pathname.slice(bucketIndex + '/homework-images/'.length)).replace(
          /^\/+/,
          ''
        )
      }
      return ''
    } catch {
      return ''
    }
  }

  const noQuery = text.split('?')[0].split('#')[0]
  return noQuery.replace(/^\/+/, '')
}

function normalizeBboxForImage(value, imageWidth, imageHeight) {
  const raw = normalizeBbox(value)
  if (!raw) return null
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return null
  }

  let { x, y, w, h } = raw
  const looksLikePercent =
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 100.5 &&
    y + h <= 100.5 &&
    Math.max(x, y, w, h) <= 100.5
  const hasOutOfRangeNormalized = x > 1 || y > 1 || w > 1 || h > 1

  if (hasOutOfRangeNormalized && looksLikePercent) {
    x /= 100
    y /= 100
    w /= 100
    h /= 100
  } else if (hasOutOfRangeNormalized) {
    const looksLikePixels =
      x >= 0 &&
      y >= 0 &&
      w > 0 &&
      h > 0 &&
      x + w <= imageWidth + 2 &&
      y + h <= imageHeight + 2
    if (!looksLikePixels) return null
    x /= imageWidth
    w /= imageWidth
    y /= imageHeight
    h /= imageHeight
  }

  if (x >= 1 || y >= 1) return null
  const nx = clamp01(x)
  const ny = clamp01(y)
  const nw = Math.max(0, Math.min(1 - nx, clamp01(w)))
  const nh = Math.max(0, Math.min(1 - ny, clamp01(h)))
  if (nw <= 0 || nh <= 0) return null
  return { x: nx, y: ny, w: nw, h: nh }
}

function normalizedBboxToPixelRect(bbox, imageWidth, imageHeight) {
  const padX = Math.max(2, Math.round(imageWidth * 0.01))
  const padY = Math.max(2, Math.round(imageHeight * 0.01))
  const left = Math.max(0, Math.floor(bbox.x * imageWidth) - padX)
  const top = Math.max(0, Math.floor(bbox.y * imageHeight) - padY)
  const right = Math.min(imageWidth, Math.ceil((bbox.x + bbox.w) * imageWidth) + padX)
  const bottom = Math.min(imageHeight, Math.ceil((bbox.y + bbox.h) * imageHeight) + padY)
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  return { left, top, width, height }
}

let sharpFactoryPromise = null

async function getSharpFactory() {
  if (!sharpFactoryPromise) {
    sharpFactoryPromise = import('sharp')
      .then((module) => module.default || module)
      .catch((error) => {
        console.warn('⚠️ [Correction Crop] sharp 載入失敗，略過後端裁切:', error?.message || error)
        return null
      })
  }
  return sharpFactoryPromise
}

function resolveSourceImagePath(sourceSubmissionId, sourceImageUrl) {
  const directPath = normalizeStoragePath(sourceImageUrl)
  if (directPath && !directPath.startsWith('api/')) return directPath
  const normalizedSubmissionId =
    typeof sourceSubmissionId === 'string' ? sourceSubmissionId.trim() : ''
  if (normalizedSubmissionId) return `submissions/${normalizedSubmissionId}.webp`
  const parsedSubmissionId = extractSubmissionIdFromImagePath(sourceImageUrl)
  if (parsedSubmissionId) return `submissions/${parsedSubmissionId}.webp`
  return ''
}

async function buildCorrectionCropGenerator(
  supabaseDb,
  {
    sourceSubmissionId,
    sourceImageUrl,
    ownerId,
    assignmentId,
    studentId,
    attemptNo
  }
) {
  const sharpFactory = await getSharpFactory()
  if (!sharpFactory) return null

  const sourcePath = resolveSourceImagePath(sourceSubmissionId, sourceImageUrl)
  if (!sourcePath) return null

  const { data, error } = await supabaseDb.storage
    .from(HOMEWORK_IMAGES_BUCKET)
    .download(sourcePath)
  if (error || !data) {
    console.warn('⚠️ [Correction Crop] 下載來源圖失敗:', error?.message || sourcePath)
    return null
  }

  const arrayBuffer = await data.arrayBuffer()
  const sourceBuffer = Buffer.from(arrayBuffer)
  if (sourceBuffer.length === 0) return null

  const metadata = await sharpFactory(sourceBuffer, { failOn: 'none' }).metadata()
  const imageWidth = Number(metadata?.width) || 0
  const imageHeight = Number(metadata?.height) || 0
  if (imageWidth <= 0 || imageHeight <= 0) return null

  const sourceKey = toSafePathSegment(
    sourceSubmissionId || extractSubmissionIdFromImagePath(sourcePath) || 'submission'
  )
  const prefix = `corrections/crops/${sourceKey}`

  return async ({ questionId, questionBbox, answerBbox }) => {
    // Prefer questionBbox (full question context: stem + answer) for student correction preview.
    // Fall back to answerBbox if questionBbox is absent.
    const normalizedBbox =
      normalizeBboxForImage(questionBbox, imageWidth, imageHeight) ||
      normalizeBboxForImage(answerBbox, imageWidth, imageHeight)
    if (!normalizedBbox) return null

    const rect = normalizedBboxToPixelRect(normalizedBbox, imageWidth, imageHeight)
    if (rect.width <= 0 || rect.height <= 0) return null

    const fileName = [
      toSafePathSegment(ownerId),
      toSafePathSegment(assignmentId),
      toSafePathSegment(studentId),
      toSafePathSegment(String(attemptNo), '0'),
      toSafePathSegment(questionId || 'Q')
    ].join('_')
    const cropPath = `${prefix}/${fileName}.webp`

    try {
      const cropBuffer = await sharpFactory(sourceBuffer, { failOn: 'none' })
        .extract(rect)
        .webp({ quality: 90 })
        .toBuffer()
      const { error: uploadError } = await supabaseDb.storage
        .from(HOMEWORK_IMAGES_BUCKET)
        .upload(cropPath, cropBuffer, {
          contentType: 'image/webp',
          upsert: true,
          cacheControl: '3600'
        })
      if (uploadError) {
        console.warn('⚠️ [Correction Crop] 上傳裁切圖失敗:', uploadError.message)
        return null
      }
      return cropPath
    } catch (error) {
      console.warn('⚠️ [Correction Crop] 裁切失敗:', error?.message || error)
      return null
    }
  }
}

function resolveOwnerIdParam(req) {
  const raw = req.query?.ownerId ?? req.query?.owner_id
  if (Array.isArray(raw)) {
    return typeof raw[0] === 'string' ? raw[0].trim() : null
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed || null
  }
  return null
}

async function requireAdminOverride(userId) {
  const supabaseAdmin = getSupabaseAdmin()
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    throw new Error('讀取使用者權限失敗')
  }

  if (data?.role?.toLowerCase?.() !== 'admin') {
    return null
  }

  return supabaseAdmin
}

function addMinutesIso(date, minutes) {
  const base = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(base.getTime())) return null
  return new Date(base.getTime() + minutes * 60 * 1000).toISOString()
}

function normalizeDeletedList(items) {
  if (!Array.isArray(items)) return []
  return items
    .map((item) => {
      if (typeof item === 'string') {
        return { id: item, deletedAt: null }
      }
      if (item && typeof item === 'object') {
        const id = item.id || item.recordId
        const deletedAt = toMillis(item.deletedAt) ?? null
        if (typeof id === 'string' && id.length > 0) {
          return { id, deletedAt }
        }
      }
      return null
    })
    .filter(Boolean)
}

// PostgREST sends `.in()` as a URL query string. Large ID lists overflow the
// gateway URL length limit (~8KB) and come back as 400 Bad Request before
// reaching Postgres. Chunk the IN clause to stay under that limit.
const IN_CLAUSE_CHUNK_SIZE = 200

function chunkArray(arr, size) {
  if (arr.length <= size) return [arr]
  const chunks = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

async function fetchExistingUpdatedMap(supabaseDb, tableName, ids, ownerId) {
  if (ids.length === 0) return new Map()
  const map = new Map()
  for (const chunk of chunkArray(ids, IN_CLAUSE_CHUNK_SIZE)) {
    const result = await supabaseDb
      .from(tableName)
      .select('id, updated_at')
      .eq('owner_id', ownerId)
      .in('id', chunk)
    if (result.error) {
      throw new Error(result.error.message)
    }
    for (const row of result.data || []) {
      map.set(row.id, toMillis(row.updated_at))
    }
  }
  return map
}

async function fetchDeletedSet(supabaseDb, tableName, ids, ownerId) {
  if (ids.length === 0) return new Set()
  const set = new Set()
  for (const chunk of chunkArray(ids, IN_CLAUSE_CHUNK_SIZE)) {
    const result = await supabaseDb
      .from('deleted_records')
      .select('record_id')
      .eq('owner_id', ownerId)
      .eq('table_name', tableName)
      .in('record_id', chunk)
    if (result.error) {
      throw new Error(result.error.message)
    }
    for (const row of result.data || []) {
      set.add(row.record_id)
    }
  }
  return set
}

async function touchAssignmentTagStates(supabaseDb, ownerId, assignmentIds) {
  if (!assignmentIds.length) return
  const now = new Date()
  const nowIso = now.toISOString()
  const nextRunAtIso = addMinutesIso(now, TAG_QUIET_MINUTES)

  const { data, error } = await supabaseDb
    .from('assignment_tag_state')
    .select('assignment_id, status, window_started_at, dirty, manual_locked')
    .eq('owner_id', ownerId)
    .in('assignment_id', assignmentIds)

  if (error) {
    throw new Error(error.message)
  }

  const stateMap = new Map(
    (data || []).map((row) => [row.assignment_id, row])
  )

  const rows = assignmentIds.map((assignmentId) => {
    const existing = stateMap.get(assignmentId)
    const isManualLocked = Boolean(existing?.manual_locked)
    const status = isManualLocked ? 'ready' : existing?.status ?? 'idle'
    const isRunning = status === 'running'
    const resetWindow =
      !existing ||
      !existing.window_started_at ||
      status === 'idle' ||
      status === 'failed' ||
      status === 'ready' ||
      status === 'insufficient_samples'
    const windowStartedAt = resetWindow ? nowIso : existing.window_started_at

    return compactObject({
      owner_id: ownerId,
      assignment_id: assignmentId,
      status: isManualLocked ? 'ready' : isRunning ? 'running' : 'pending',
      window_started_at: windowStartedAt,
      last_event_at: nowIso,
      next_run_at: isManualLocked ? undefined : nextRunAtIso ?? undefined,
      dirty: isManualLocked ? false : isRunning ? true : existing?.dirty ?? false,
      manual_locked: isManualLocked ? true : existing?.manual_locked ?? false,
      updated_at: nowIso
    })
  })

  if (!rows.length) return

  const result = await supabaseDb
    .from('assignment_tag_state')
    .upsert(rows, { onConflict: 'owner_id,assignment_id' })

  if (result.error) {
    throw new Error(result.error.message)
  }
}

function normalizeEnum(value, allowedValues, fallback) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return allowedValues.includes(raw) ? raw : fallback
}

function normalizeTimeString(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return fallback
  const matched = raw.match(/^([01]\d|2[0-3]):([0-5]\d)/)
  if (!matched) return fallback
  return `${matched[1]}:${matched[2]}`
}

function normalizeDueAt(value) {
  const iso = toIsoTimestamp(value)
  return iso || null
}

function isTeacherPreferencesLegacySchemaError(error) {
  const message = typeof error?.message === 'string' ? error.message : ''
  return /teacher_preferences/i.test(message) && /column/i.test(message) && /does not exist/i.test(message)
}

function normalizeTeacherPreferences(ownerId, data = {}) {
  return {
    owner_id: ownerId,
    student_portal_enabled:
      typeof data.student_portal_enabled === 'boolean'
        ? data.student_portal_enabled
        : DEFAULT_TEACHER_PREFERENCES.student_portal_enabled,
    show_score_to_students:
      typeof data.show_score_to_students === 'boolean'
        ? data.show_score_to_students
        : DEFAULT_TEACHER_PREFERENCES.show_score_to_students,
    max_correction_attempts: clampInteger(
      data.max_correction_attempts,
      1,
      10,
      DEFAULT_TEACHER_PREFERENCES.max_correction_attempts
    ),
    // 系統硬規則：批改後一律鎖定重交、頁數不符一律阻擋
    lock_upload_after_graded: true,
    require_full_page_count: true,
    correction_dispatch_mode: normalizeEnum(
      data.correction_dispatch_mode,
      ['manual', 'auto'],
      DEFAULT_TEACHER_PREFERENCES.correction_dispatch_mode
    ),
    correction_due_at: normalizeDueAt(data.correction_due_at),
    student_feedback_visibility: normalizeEnum(
      data.student_feedback_visibility,
      ['status_only', 'score_only', 'score_reason', 'full'],
      DEFAULT_TEACHER_PREFERENCES.student_feedback_visibility
    )
  }
}

async function fetchTeacherPreferencesRow(supabaseDb, ownerId) {
  let result = await supabaseDb
    .from('teacher_preferences')
    .select(TEACHER_PREFERENCES_EXTENDED_SELECT)
    .eq('owner_id', ownerId)
    .maybeSingle()

  if (result.error && isTeacherPreferencesLegacySchemaError(result.error)) {
    result = await supabaseDb
      .from('teacher_preferences')
      .select(TEACHER_PREFERENCES_BASE_SELECT)
      .eq('owner_id', ownerId)
      .maybeSingle()
  }

  return result
}

async function getTeacherPreferences(supabaseDb, ownerId) {
  const { data, error } = await fetchTeacherPreferencesRow(supabaseDb, ownerId)
  if (error) {
    throw new Error(error.message)
  }

  if (!data) {
    const seedRow = normalizeTeacherPreferences(ownerId, DEFAULT_TEACHER_PREFERENCES)
    let insertError = null
    const insertResult = await supabaseDb
      .from('teacher_preferences')
      .insert(seedRow)
    insertError = insertResult.error
    if (insertError && isTeacherPreferencesLegacySchemaError(insertError)) {
      const legacySeedRow = {
        owner_id: ownerId,
        student_portal_enabled: seedRow.student_portal_enabled,
        show_score_to_students: seedRow.show_score_to_students,
        max_correction_attempts: seedRow.max_correction_attempts,
        lock_upload_after_graded: true,
        require_full_page_count: true
      }
      const legacyInsertResult = await supabaseDb
        .from('teacher_preferences')
        .insert(legacySeedRow)
      insertError = legacyInsertResult.error
    }
    if (insertError) {
      throw new Error(insertError.message)
    }
    return seedRow
  }

  return normalizeTeacherPreferences(ownerId, data)
}

function buildStudentClassroomKey(context) {
  return `${context.ownerId}::${context.classroomId}::${context.id}`
}

async function resolveStudentContextsByAuthUser(supabaseDb, authUserId, authEmail = '') {
  const normalizedEmail =
    typeof authEmail === 'string' ? authEmail.trim().toLowerCase() : ''
  if (!authUserId && !normalizedEmail) return []

  const hasValidStudentEmail = (row) => {
    const studentEmail =
      typeof row?.email === 'string' ? row.email.trim().toLowerCase() : ''
    return Boolean(normalizedEmail) && Boolean(studentEmail) && studentEmail === normalizedEmail
  }

  // 查詢 1: 透過 auth_user_id 直接比對（包含 1Campus SSO 綁定的學生）
  // 查詢 2: 透過 email 比對（一般系統登入的學生）
  const queries = [
    supabaseDb
      .from('students')
      .select('id, classroom_id, seat_number, name, owner_id, email, auth_user_id, updated_at')
      .eq('auth_user_id', authUserId)
      .order('updated_at', { ascending: false })
  ]
  if (normalizedEmail) {
    queries.push(
      supabaseDb
        .from('students')
        .select('id, classroom_id, seat_number, name, owner_id, email, auth_user_id, updated_at')
        .eq('email', normalizedEmail)
        .order('updated_at', { ascending: false })
    )
  }

  const results = await Promise.all(queries)
  const linkedByAuthIdResult = results[0]
  const linkedByEmailResult = results[1] || { data: [], error: null }

  if (linkedByAuthIdResult.error) {
    throw new Error(linkedByAuthIdResult.error.message)
  }
  if (linkedByEmailResult.error) {
    throw new Error(linkedByEmailResult.error.message)
  }

  const mergedRows = new Map()
  // auth_user_id 比對的結果：不需要 email 驗證（1Campus SSO 綁定的學生可能沒有匹配的 email）
  for (const row of linkedByAuthIdResult.data || []) {
    mergedRows.set(`${row.owner_id}::${row.id}`, row)
  }
  // email 比對的結果：需要 email 驗證
  for (const row of linkedByEmailResult.data || []) {
    if (!hasValidStudentEmail(row)) continue
    mergedRows.set(`${row.owner_id}::${row.id}`, row)
  }

  const linkedStudents = Array.from(mergedRows.values())
    .sort((a, b) => (toMillis(b.updated_at) ?? 0) - (toMillis(a.updated_at) ?? 0))

  if (!linkedStudents.length) return []

  const bindTargets = linkedStudents.filter((row) => row.auth_user_id !== authUserId)
  if (bindTargets.length) {
    const nowIso = new Date().toISOString()
    const bindResults = await Promise.all(
      bindTargets.map((row) =>
        supabaseDb
          .from('students')
          .update({
            auth_user_id: authUserId,
            updated_at: nowIso
          })
          .eq('id', row.id)
          .eq('owner_id', row.owner_id)
      )
    )
    const bindError = bindResults.find((result) => result.error)
    if (bindError?.error) {
      throw new Error(bindError.error.message)
    }
  }

  return linkedStudents.map((linkedStudent) => ({
    id: linkedStudent.id,
    classroomId: linkedStudent.classroom_id,
    seatNumber: linkedStudent.seat_number,
    name: linkedStudent.name,
    ownerId: linkedStudent.owner_id,
    email: linkedStudent.email ?? null
  }))
}

async function resolveStudentContextByAuthUser(supabaseDb, authUserId, authEmail = '') {
  const contexts = await resolveStudentContextsByAuthUser(
    supabaseDb,
    authUserId,
    authEmail
  )
  return contexts[0] || null
}

function parseMistakesFromGradingResult(gradingResult) {
  if (!gradingResult || typeof gradingResult !== 'object') return []

  const mistakes = []
  const details = Array.isArray(gradingResult.details) ? gradingResult.details : []
  const detailsByQuestionId = new Map()
  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue
    const questionId =
      (typeof detail.questionId === 'string' && detail.questionId.trim()) || ''
    if (!questionId) continue
    detailsByQuestionId.set(questionId, detail)
  }
  const directMistakes = Array.isArray(gradingResult.mistakes)
    ? gradingResult.mistakes
    : []

  for (const mistake of directMistakes) {
    if (!mistake || typeof mistake !== 'object') continue
    const questionId =
      (typeof mistake.id === 'string' && mistake.id.trim()) ||
      (typeof mistake.questionId === 'string' && mistake.questionId.trim()) ||
      ''
    const questionText =
      (typeof mistake.question === 'string' && mistake.question.trim()) || ''
    const reason =
      (typeof mistake.reason === 'string' && mistake.reason.trim()) || ''
    if (!questionId && !questionText && !reason) continue
    const linkedDetail = detailsByQuestionId.get(questionId) || null
    // 學生看的訂正引導：優先用 explain stage 產的 studentGuidance（已避免洩漏答案的三段式引導）、
    // 沒有才 fallback 到 reason（reason 是給老師審計的批改理由、可能直接含答案/單位）。
    const guidance = (typeof linkedDetail?.studentGuidance === 'string' && linkedDetail.studentGuidance.trim()) || ''
    mistakes.push({
      questionId: questionId || questionText || `Q${mistakes.length + 1}`,
      questionText: questionText || questionId || '',
      reason: reason || '需要再次確認作答內容',
      hintText: String(guidance || reason || ''),
      studentAnswerRaw: (typeof linkedDetail?.studentAnswer === 'string' && linkedDetail.studentAnswer.trim()) || undefined,
      questionBbox: normalizeBbox(linkedDetail?.questionBbox),
      answerBbox: normalizeBbox(linkedDetail?.answerBbox)
    })
  }

  if (mistakes.length > 0) return mistakes

  for (const detail of details) {
    if (!detail || typeof detail !== 'object') continue
    const isWrong =
      detail.isCorrect === false ||
      detail.needsReview === true ||
      detail.studentAnswer === '未作答'
    if (!isWrong) continue
    const questionId =
      (typeof detail.questionId === 'string' && detail.questionId.trim()) ||
      `Q${mistakes.length + 1}`
    const reason =
      (typeof detail.reason === 'string' && detail.reason.trim()) ||
      (typeof detail.comment === 'string' && detail.comment.trim()) ||
      '需要再次確認作答內容'
    // 學生看的訂正引導：優先用 studentGuidance（explain stage 產、禁洩漏）、否則 fallback reason
    const guidance = (typeof detail.studentGuidance === 'string' && detail.studentGuidance.trim()) || ''
    mistakes.push({
      questionId,
      questionText: questionId,
      reason,
      hintText: String(guidance || reason || ''),
      studentAnswerRaw: (typeof detail.studentAnswer === 'string' && detail.studentAnswer.trim()) || undefined,
      questionBbox: normalizeBbox(detail.questionBbox),
      answerBbox: normalizeBbox(detail.answerBbox)
    })
  }

  return mistakes
}

async function upsertAssignmentStudentState(
  supabaseDb,
  ownerId,
  assignmentId,
  studentId,
  patch
) {
  const { data: existing, error: fetchError } = await supabaseDb
    .from('assignment_student_state')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('assignment_id', assignmentId)
    .eq('student_id', studentId)
    .maybeSingle()

  if (fetchError) {
    throw new Error(fetchError.message)
  }

  const base = existing ?? {
    owner_id: ownerId,
    assignment_id: assignmentId,
    student_id: studentId,
    status: 'not_uploaded',
    graded_once: false,
    upload_locked: false,
    correction_attempt_count: 0,
    correction_attempt_limit: DEFAULT_CORRECTION_ATTEMPT_LIMIT
  }

  const row = {
    owner_id: ownerId,
    assignment_id: assignmentId,
    student_id: studentId,
    ...base,
    ...patch,
    correction_attempt_count: clampInteger(
      patch.correction_attempt_count ?? base.correction_attempt_count,
      0,
      99,
      0
    ),
    correction_attempt_limit: clampInteger(
      patch.correction_attempt_limit ?? base.correction_attempt_limit,
      1,
      10,
      DEFAULT_CORRECTION_ATTEMPT_LIMIT
    ),
    last_activity_at: patch.last_activity_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString()
  }

  const { error: upsertError } = await supabaseDb
    .from('assignment_student_state')
    .upsert(row, { onConflict: 'owner_id,assignment_id,student_id' })

  if (upsertError) {
    throw new Error(upsertError.message)
  }

  return row
}

async function writeCorrectionQuestionItems(
  supabaseDb,
  ownerId,
  assignmentId,
  studentId,
  attemptNo,
  mistakes,
  options = {}
) {
  if (!Number.isFinite(attemptNo) || attemptNo < 0) return

  const uniqueMistakes = []
  const seenQuestionIds = new Set()
  for (let index = 0; index < (Array.isArray(mistakes) ? mistakes.length : 0); index += 1) {
    const mistake = mistakes[index]
    const questionIdRaw =
      typeof mistake?.questionId === 'string' ? mistake.questionId.trim() : ''
    const questionId = questionIdRaw || `Q${index + 1}`
    if (seenQuestionIds.has(questionId)) continue
    seenQuestionIds.add(questionId)
    uniqueMistakes.push({
      mistake,
      questionId
    })
  }

  const preferPreviousAccessor = options.preferPreviousAccessor === true
  const previousAccessorByQuestionId = new Map()
  if (preferPreviousAccessor && uniqueMistakes.length > 0) {
    const targetQuestionIds = uniqueMistakes.map(({ questionId }) => questionId)
    const { data: previousRows, error: previousRowsError } = await supabaseDb
      .from('correction_question_items')
      .select('question_id, accessor_result, attempt_no, updated_at')
      .eq('owner_id', ownerId)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .in('question_id', targetQuestionIds)
      .order('attempt_no', { ascending: true })
      .order('updated_at', { ascending: true })

    if (previousRowsError) {
      console.warn('[correction_question_items] load previous accessor failed:', previousRowsError.message)
    } else {
      for (const row of previousRows || []) {
        const questionId = typeof row?.question_id === 'string' ? row.question_id.trim() : ''
        if (!questionId || previousAccessorByQuestionId.has(questionId)) continue
        const accessor =
          row?.accessor_result && typeof row.accessor_result === 'object'
            ? row.accessor_result
            : null
        if (!accessor) continue
        previousAccessorByQuestionId.set(questionId, accessor)
      }
    }
  }

  // Only resolve 'open' items — leave 'disputed' items in place for teacher review
  await supabaseDb
    .from('correction_question_items')
    .update({
      status: 'resolved',
      updated_at: new Date().toISOString()
    })
    .eq('owner_id', ownerId)
    .eq('assignment_id', assignmentId)
    .eq('student_id', studentId)
    .eq('status', 'open')

  if (!mistakes.length) return

  if (!uniqueMistakes.length) return

  const sourceSubmissionId =
    typeof options.sourceSubmissionId === 'string' && options.sourceSubmissionId.trim()
      ? options.sourceSubmissionId.trim()
      : undefined
  const sourceImageUrl =
    typeof options.sourceImageUrl === 'string' && options.sourceImageUrl.trim()
      ? options.sourceImageUrl.trim()
      : undefined

  const cropImageForQuestion = await buildCorrectionCropGenerator(supabaseDb, {
    sourceSubmissionId,
    sourceImageUrl,
    ownerId,
    assignmentId,
    studentId,
    attemptNo
  })

  const preparedMistakes = await Promise.all(
    uniqueMistakes.map(async ({ mistake, questionId }) => {
      const previousAccessor =
        preferPreviousAccessor && previousAccessorByQuestionId.has(questionId)
          ? previousAccessorByQuestionId.get(questionId)
          : null
      const previousSourceSubmissionId =
        typeof previousAccessor?.source_submission_id === 'string' &&
        previousAccessor.source_submission_id.trim()
          ? previousAccessor.source_submission_id.trim()
          : undefined
      const previousSourceImageUrl =
        typeof previousAccessor?.source_image_url === 'string' &&
        previousAccessor.source_image_url.trim()
          ? previousAccessor.source_image_url.trim()
          : undefined
      const previousCropImageUrl =
        typeof previousAccessor?.crop_image_url === 'string' &&
        previousAccessor.crop_image_url.trim()
          ? previousAccessor.crop_image_url.trim()
          : undefined
      const fallbackQuestionBbox = normalizeBbox(previousAccessor?.question_bbox)
      const fallbackAnswerBbox = normalizeBbox(previousAccessor?.answer_bbox)
      const questionBbox = normalizeBbox(mistake.questionBbox) || fallbackQuestionBbox
      const answerBbox = normalizeBbox(mistake.answerBbox) || fallbackAnswerBbox
      const carryPreviousImage = Boolean(previousAccessor)
      let cropImageUrl = carryPreviousImage ? previousCropImageUrl : null
      if (!cropImageUrl && !carryPreviousImage && cropImageForQuestion) {
        cropImageUrl = await cropImageForQuestion({
          questionId,
          questionBbox,
          answerBbox
        })
      }
      // 學生訂正：client 強制每題拍照上傳到 corrections/{sub}/{qid}.webp、accessor 沒裁到時 fallback 至此
      if (!cropImageUrl && options.isStudentCorrection && sourceSubmissionId) {
        cropImageUrl = `corrections/${sourceSubmissionId}/${questionId}.webp`
      }
      return {
        mistake,
        questionId,
        sourceSubmissionId: carryPreviousImage ? previousSourceSubmissionId : sourceSubmissionId,
        sourceImageUrl: carryPreviousImage ? previousSourceImageUrl : sourceImageUrl,
        questionBbox,
        answerBbox,
        cropImageUrl: cropImageUrl || undefined
      }
    })
  )

  const rows = preparedMistakes.map(
    (
      {
        mistake,
        questionId,
        sourceSubmissionId: resolvedSourceSubmissionId,
        sourceImageUrl: resolvedSourceImageUrl,
        questionBbox,
        answerBbox,
        cropImageUrl
      },
      index
    ) =>
      compactObject({
        owner_id: ownerId,
        assignment_id: assignmentId,
        student_id: studentId,
        attempt_no: attemptNo,
        question_id: questionId || `Q${index + 1}`,
        question_text: mistake.questionText || undefined,
        mistake_reason: mistake.reason || undefined,
        hint_text: mistake.hintText || undefined,
        accessor_result: compactObject({
          source_submission_id: resolvedSourceSubmissionId,
          source_image_url: resolvedSourceImageUrl,
          crop_image_url: cropImageUrl,
          question_bbox: questionBbox,
          answer_bbox: answerBbox,
          student_answer_raw: mistake.studentAnswerRaw || undefined
        }),
        status: 'open'
      })
  )

  const { error } = await supabaseDb
    .from('correction_question_items')
    .upsert(rows, {
      onConflict: 'owner_id,assignment_id,student_id,attempt_no,question_id'
    })

  if (!error) return

  if (!isLegacyCorrectionQuestionItemsConstraintError(error)) {
    throw new Error(error.message)
  }

  // 舊版資料表可能仍存在 (owner_id, assignment_id, student_id) 唯一鍵，
  // 會阻擋同一學生多題錯誤列。先降級為單筆摘要，避免 sync 直接 500。
  const fallbackReason = preparedMistakes
    .map(({ mistake }) => (typeof mistake?.reason === 'string' ? mistake.reason.trim() : ''))
    .filter(Boolean)
    .slice(0, 3)
    .join('；')

  const fallbackRow = compactObject({
    owner_id: ownerId,
    assignment_id: assignmentId,
    student_id: studentId,
    attempt_no: attemptNo,
    question_id: 'Q_SUMMARY',
    question_text: `共 ${uniqueMistakes.length} 題待複核`,
    mistake_reason: fallbackReason || undefined,
    hint_text: '偵測到舊版資料表唯一鍵，已改用摘要模式儲存',
    accessor_result: compactObject({
      source_submission_id: sourceSubmissionId,
      source_image_url: sourceImageUrl,
      legacy_schema_fallback: true,
      mistakes: preparedMistakes.map(
        ({ questionId, mistake, questionBbox, answerBbox, cropImageUrl }) =>
        compactObject({
          question_id: questionId,
          question_text: mistake?.questionText || undefined,
          reason: mistake?.reason || undefined,
          hint_text: mistake?.hintText || undefined,
          crop_image_url: cropImageUrl,
          question_bbox: questionBbox,
          answer_bbox: answerBbox
        })
      )
    }),
    status: 'open'
  })

  const { error: fallbackError } = await supabaseDb
    .from('correction_question_items')
    .upsert(fallbackRow, {
      onConflict: 'owner_id,assignment_id,student_id'
    })

  if (fallbackError) {
    throw new Error(fallbackError.message)
  }

  console.warn(
    '[correction_question_items] 使用舊版唯一鍵摘要回寫，建議執行資料庫修復 SQL'
  )
}

async function logCorrectionAttempt(
  supabaseDb,
  ownerId,
  assignmentId,
  studentId,
  attemptNo,
  submissionId,
  resultStatus,
  gradingResult,
  wrongQuestionCount
) {
  if (!Number.isFinite(attemptNo) || attemptNo <= 0) return

  const { error } = await supabaseDb
    .from('correction_attempt_logs')
    .upsert(
      {
        owner_id: ownerId,
        assignment_id: assignmentId,
        student_id: studentId,
        attempt_no: attemptNo,
        submission_id: submissionId,
        result_status: resultStatus,
        wrong_question_count: wrongQuestionCount,
        snapshot: gradingResult ?? undefined
      },
      { onConflict: 'owner_id,assignment_id,student_id,attempt_no' }
    )

  if (error) {
    throw new Error(error.message)
  }
}

async function getDispatchActiveAssignments(supabaseDb, ownerId, assignmentIds) {
  if (!Array.isArray(assignmentIds) || assignmentIds.length === 0) return new Set()
  const { data, error } = await supabaseDb
    .from('assignment_student_state')
    .select('assignment_id, status')
    .eq('owner_id', ownerId)
    .in('assignment_id', assignmentIds)
    .in('status', ['correction_required', 'correction_in_progress'])

  if (error) {
    throw new Error(error.message)
  }

  return new Set((data || []).map((row) => row.assignment_id).filter(Boolean))
}

async function fetchLatestGradedSubmissionsByStudent(
  supabaseDb,
  ownerId,
  assignmentId
) {
  const { data, error } = await supabaseDb
    .from('submissions')
    .select('id, assignment_id, student_id, grading_result, source, status, graded_at, updated_at, image_url')
    .eq('owner_id', ownerId)
    .eq('assignment_id', assignmentId)
    .or('graded_at.not.is.null,status.eq.graded')

  if (error) {
    throw new Error(error.message)
  }

  const latestByStudent = new Map()
  for (const row of data || []) {
    const studentId = row.student_id
    if (!studentId) continue
    const rankedAt =
      toNumber(row.graded_at) ??
      toMillis(row.updated_at) ??
      0
    const existing = latestByStudent.get(studentId)
    const existingRank =
      existing
        ? toNumber(existing.graded_at) ?? toMillis(existing.updated_at) ?? 0
        : -1
    if (!existing || rankedAt >= existingRank) {
      latestByStudent.set(studentId, row)
    }
  }

  return latestByStudent
}

async function applySubmissionStateTransitions(supabaseDb, ownerId, submissionRows, options = {}) {
  if (!Array.isArray(submissionRows) || submissionRows.length === 0) return
  // 2026-05-28: forceRebuildCorrection — 手動改分數時跳過「已在訂正流程則 skip」的守門、
  // 強制以新 gradingResult.mistakes 重建 correction_question_items
  const forceRebuildCorrection = options?.forceRebuildCorrection === true

  const preferences = await getTeacherPreferences(supabaseDb, ownerId)
  const assignmentIds = [
    ...new Set(
      submissionRows.map((row) => row.assignment_id).filter((value) => typeof value === 'string')
    )
  ]
  const studentIds = [
    ...new Set(
      submissionRows.map((row) => row.student_id).filter((value) => typeof value === 'string')
    )
  ]

  if (!assignmentIds.length || !studentIds.length) return

  const { data: existingRows, error: existingError } = await supabaseDb
    .from('assignment_student_state')
    .select('*')
    .eq('owner_id', ownerId)
    .in('assignment_id', assignmentIds)
    .in('student_id', studentIds)

  if (existingError) {
    throw new Error(existingError.message)
  }

  const stateMap = new Map()
  for (const row of existingRows || []) {
    stateMap.set(`${row.assignment_id}::${row.student_id}`, row)
  }
  const dispatchActiveAssignments = await getDispatchActiveAssignments(
    supabaseDb,
    ownerId,
    assignmentIds
  )

  // Track processed correction submission IDs within this sync cycle to prevent double-counting
  const processedCorrectionSubIds = new Set()

  for (const row of submissionRows) {
    const assignmentId = row.assignment_id
    const studentId = row.student_id
    if (!assignmentId || !studentId) continue
    const key = `${assignmentId}::${studentId}`
    const existingState = stateMap.get(key) || null
    const source = String(row.source || 'teacher_camera')
    const submissionStatus = String(row.status || '').toLowerCase()
    const existingStatus = String(existingState?.status || '').toLowerCase()
    const isGraded = row.graded_at !== undefined && row.graded_at !== null
      ? true
      : submissionStatus === 'graded'

    // Layer 2: If teacher re-grades a student who is already in correction workflow,
    // skip the state transition to avoid overwriting correction progress.
    // Only skip for non-correction sources — student recheck must always proceed.
    const CORRECTION_ACTIVE_STATUSES = [
      'correction_required', 'correction_in_progress',
      'correction_pending_review', 'correction_passed', 'correction_failed'
    ]
    if (source !== 'student_correction' && CORRECTION_ACTIVE_STATUSES.includes(existingStatus)) {
      // 2026-05-28: 手動改分數時、forceRebuildCorrection=true、跳過此 skip 守門、
      // 讓 correction_question_items 依新 gradingResult.mistakes 重 build
      if (!forceRebuildCorrection) continue
    }
    // Guard: once teacher/manual flow reaches correction_passed, treat it as terminal.
    // Ignore stale correction submissions synced later (graded or non-graded).
    if (source === 'student_correction' && existingStatus === 'correction_passed') {
      continue
    }

    // Guard: if teacher has already recalled this student's correction (status='graded')
    // and this is the same correction submission that was already processed, do NOT
    // revert the state back to correction_required. This prevents the sync push/pull
    // loop from overwriting the teacher's recall action.
    if (
      source === 'student_correction' &&
      existingStatus === 'graded' &&
      existingState?.current_submission_id === row.id
    ) {
      continue
    }

    if (!isGraded) {
      let nextStatus = source === 'student_correction' ? 'correction_in_progress' : 'uploaded'
      let nextReason = undefined
      if (source === 'student_correction' && submissionStatus === 'grading_failed') {
        nextStatus = 'correction_required'
        nextReason = 'AI 批改失敗，請重新送出訂正'
      }
      const nextState = await upsertAssignmentStudentState(
        supabaseDb,
        ownerId,
        assignmentId,
        studentId,
        compactObject({
          status: nextStatus,
          current_submission_id: row.id,
          correction_attempt_limit:
            existingState?.correction_attempt_limit ??
            preferences.max_correction_attempts,
          last_status_reason: nextReason
        })
      )
      stateMap.set(key, nextState)
      continue
    }

    const mistakes = parseMistakesFromGradingResult(row.grading_result)
    const hasMistakes = mistakes.length > 0
    const correctionAttemptLimit = clampInteger(
      existingState?.correction_attempt_limit ?? preferences.max_correction_attempts,
      1,
      10,
      preferences.max_correction_attempts
    )

    let correctionAttemptCount = clampInteger(
      existingState?.correction_attempt_count ?? 0,
      0,
      99,
      0
    )
    const dispatchActive = dispatchActiveAssignments.has(assignmentId)
    const autoDispatch = preferences.correction_dispatch_mode === 'auto' && source !== 'student_correction'
    let status = hasMistakes ? ((dispatchActive || autoDispatch) ? 'correction_required' : 'graded') : 'graded'
    let lastStatusReason = undefined

    if (source === 'student_correction') {
      // Guard: skip if this correction submission was already processed or is being processed
      // Prevents double-counting when sync re-sends the same submission during grading
      const alreadyProcessedOrInProgress =
        existingState?.current_submission_id === row.id &&
        existingStatus !== 'correction_in_progress' &&
        (isGraded || existingStatus === 'pending_grading' || existingStatus === 'grading_in_progress')
      if (alreadyProcessedOrInProgress) {
        continue
      }

      // Additional guard: check correction_attempt_logs to see if this submission was already counted
      const { count: existingLogCount } = await supabaseDb
        .from('correction_attempt_logs')
        .select('id', { count: 'exact', head: true })
        .eq('owner_id', ownerId)
        .eq('assignment_id', assignmentId)
        .eq('student_id', studentId)
        .eq('submission_id', row.id)
      if ((existingLogCount ?? 0) > 0) {
        // This submission was already logged — skip to prevent double-counting
        console.log(`[correction-dedup] skip ${row.id}: already logged in correction_attempt_logs`)
        continue
      }

      // Same-cycle dedup: prevent counting the same submission twice within one sync batch
      if (processedCorrectionSubIds.has(row.id)) {
        console.log(`[correction-dedup] skip ${row.id}: already processed in this sync cycle`)
        continue
      }
      processedCorrectionSubIds.add(row.id)

      correctionAttemptCount += 1

      await writeCorrectionQuestionItems(
        supabaseDb,
        ownerId,
        assignmentId,
        studentId,
        correctionAttemptCount,
        mistakes,
        {
          sourceSubmissionId: row.id,
          sourceImageUrl: row.image_url,
          preferPreviousAccessor: true,
          isStudentCorrection: true
        }
      )

      // Check if any disputed items remain (not resolved by teacher yet)
      const { count: disputedCount } = await supabaseDb
        .from('correction_question_items')
        .select('id', { count: 'exact', head: true })
        .eq('owner_id', ownerId)
        .eq('assignment_id', assignmentId)
        .eq('student_id', studentId)
        .eq('status', 'disputed')

      if (!hasMistakes) {
        // All recheck questions passed — but disputed ones may still be pending teacher review
        status = (disputedCount ?? 0) > 0 ? 'correction_pending_review' : 'correction_passed'
        if (status === 'correction_pending_review') {
          lastStatusReason = '訂正照片已全部通過，有申訴題目待老師審閱'
        }
      } else if (correctionAttemptCount >= correctionAttemptLimit) {
        status = 'correction_failed'
        lastStatusReason = '學生自主訂正超過次數限制，需教師協助'
      } else {
        status = 'correction_required'
      }

      await logCorrectionAttempt(
        supabaseDb,
        ownerId,
        assignmentId,
        studentId,
        correctionAttemptCount,
        row.id,
        status === 'correction_passed' || status === 'correction_pending_review'
          ? 'pass'
          : status === 'correction_failed'
            ? 'failed'
            : 'retry',
        row.grading_result,
        mistakes.length
      )
    } else {
      if (hasMistakes) {
        await writeCorrectionQuestionItems(
          supabaseDb,
          ownerId,
          assignmentId,
          studentId,
          correctionAttemptCount,
          mistakes,
          {
            sourceSubmissionId: row.id,
            sourceImageUrl: row.image_url
          }
        )
        if (!dispatchActive && !autoDispatch) {
          lastStatusReason = '已批改完成，待教師派發訂正'
        }
      } else {
        await writeCorrectionQuestionItems(
          supabaseDb,
          ownerId,
          assignmentId,
          studentId,
          correctionAttemptCount,
          [],
          {
            sourceSubmissionId: row.id,
            sourceImageUrl: row.image_url
          }
        )
      }
    }

    // Explicitly clear old explanation text for terminal/no-action states.
    // `undefined` would be dropped by compactObject and keep stale DB value.
    if (status === 'graded' || status === 'correction_passed') {
      lastStatusReason = null
    }

    const nextState = await upsertAssignmentStudentState(
      supabaseDb,
      ownerId,
      assignmentId,
      studentId,
      compactObject({
        status,
        current_submission_id: row.id,
        // 訂正提交不覆蓋 last_graded_submission_id，保留原始老師批改的 submission
        ...(source !== 'student_correction' ? { last_graded_submission_id: row.id } : {}),
        graded_once: true,
        // 系統硬規則：一旦批改過即鎖定一般重交
        upload_locked: true,
        correction_attempt_count: correctionAttemptCount,
        correction_attempt_limit: correctionAttemptLimit,
        last_status_reason: lastStatusReason
      })
    )

    stateMap.set(key, nextState)
  }
}

function getSystemApiKey() {
  return (
    getEnvValue('SYSTEM_GEMINI_API_KEY') ||
    getEnvValue('SECRET_API_KEY') ||
    ''
  )
}

async function runSubmissionGrading({
  assignment,
  normalizedImage,
  contentType,
  requestId
}) {
  const apiKey = getSystemApiKey()
  if (!apiKey) {
    throw new Error('Server API Key missing (SYSTEM_GEMINI_API_KEY / SECRET_API_KEY)')
  }

  const normalizedAnswerKey = normalizeJsonLike(assignment?.answer_key)
  if (!normalizedAnswerKey) {
    throw new Error('Assignment answer key missing or invalid')
  }

  const pipelineResult = await runAiPipeline({
    apiKey,
    model: STUDENT_CORRECTION_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: normalizedImage,
              mimeType: contentType || 'image/webp'
            }
          }
        ]
      }
    ],
    requestedRouteKey: AI_ROUTE_KEYS.GRADING_EVALUATE,
    routeHint: {
      source: 'student-correction'
    },
    internalContext: {
      requestId,
      resolvedAnswerKey: normalizedAnswerKey,
      enableStagedGrading: true,
      gradingMode: 'staged'
    }
  })

  const responseStatus = Number(pipelineResult.status) || 500
  if (responseStatus < 200 || responseStatus >= 300) {
    const message =
      pipelineResult?.data?.error?.message ||
      pipelineResult?.data?.error ||
      `AI grading failed with status ${responseStatus}`
    throw new Error(message)
  }

  const parsed = parseCandidateJson(pipelineResult.data)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI grading result parse failed')
  }

  return parsed
}

// Recheck Agent: 逐題訂正批改，取代全頁重批
async function runRecheckGrading({ supabaseDb, submission, assignment, correctionItems }) {
  const apiKey = getSystemApiKey()
  if (!apiKey) throw new Error('Server API Key missing')

  // Download per-question correction images: corrections/${submissionId}/${questionId}.webp
  const correctionImages = []
  for (const item of correctionItems) {
    const imagePath = `corrections/${submission.id}/${item.question_id}.webp`
    const { data: imageBlob, error } = await supabaseDb.storage
      .from(HOMEWORK_IMAGES_BUCKET)
      .download(imagePath)
    if (error || !imageBlob) {
      console.warn('[RECHECK] Could not download image for', item.question_id, error?.message)
      continue
    }
    const arrayBuffer = await imageBlob.arrayBuffer()
    correctionImages.push({
      questionId: item.question_id,
      base64: Buffer.from(arrayBuffer).toString('base64'),
      contentType: 'image/webp'
    })
  }

  if (!correctionImages.length) {
    throw new Error('No correction images found — cannot run recheck')
  }

  const answerKey = normalizeJsonLike(assignment.answer_key)
  const keyQuestions = Array.isArray(answerKey?.questions) ? answerKey.questions : []

  const itemsWithAnswers = correctionItems.map((item) => {
    const keyQ = keyQuestions.find((q) => String(q.id || '').trim() === item.question_id)
    return {
      questionId: item.question_id,
      questionText: item.question_text || '',
      mistakeReason: item.mistake_reason || '',
      hintGiven: item.hint_text || '',
      questionCategory: keyQ?.questionCategory || '',
      correctAnswer: keyQ?.answer || '',
      type: keyQ?.type ?? 1,
      acceptableAnswers: Array.isArray(keyQ?.acceptableAnswers) ? keyQ.acceptableAnswers : [],
      referenceAnswer: keyQ?.referenceAnswer || '',
      rubricsDimensions: Array.isArray(keyQ?.rubricsDimensions) ? keyQ.rubricsDimensions : [],
      strictness: answerKey?.strictness || 'standard',
      maxScore: Number(keyQ?.maxScore ?? 1),
      domain: assignment?.domain || ''
    }
  })

  // 2026-05-23: 包 trackingContext 把 token 寫入 ink_session_usage
  // 學生訂正：actor / billing 都打到 owner_id (老師)、有 assignment + submission 對應
  const recheckResult = await trackingContext.run(
    {
      supabaseAdmin: supabaseDb,
      actorUserId: submission.owner_id,
      billingUserId: submission.owner_id,
      isAdmin: false,
      inkSessionId: null,
      assignmentId: submission.assignment_id,
      submissionId: submission.id
    },
    () =>
      runRecheckPipeline({
        apiKey,
        model: STUDENT_CORRECTION_MODEL,
        correctionImages,
        correctionItems: itemsWithAnswers,
        requestId: submission.id
      })
  )

  const expectedQuestionIds = correctionItems
    .map((item) => String(item?.question_id || '').trim())
    .filter(Boolean)
  const rawResults = Array.isArray(recheckResult?.results) ? recheckResult.results : []
  const resultByQuestionId = new Map(
    rawResults
      .filter((item) => item && typeof item === 'object')
      .map((item) => [String(item.questionId || '').trim(), item])
      .filter(([questionId]) => questionId)
  )
  const normalizedResults = expectedQuestionIds.map((questionId) => {
    const matched = resultByQuestionId.get(questionId)
    if (matched && typeof matched === 'object') return matched
    const fallbackReason = 'AI 未能成功判定此題，請重新拍攝（含題號與作答）後再試。'
    return {
      questionId,
      passed: false,
      studentAnswer: '',
      reason: fallbackReason,
      newGuidance: fallbackReason
    }
  })

  // Convert recheck results to gradingResult format (compatible with parseMistakesFromGradingResult)
  const stillWrong = normalizedResults.filter((r) => r?.passed !== true)
  const passedCount = normalizedResults.filter((r) => r?.passed === true).length
  const totalChecked = normalizedResults.length

  return {
    totalScore: totalChecked > 0 ? Math.round((passedCount / totalChecked) * 100) : 0,
    mistakes: stillWrong.map((r) => ({
      id: r.questionId,
      questionId: r.questionId,
      reason: r.reason || r.newGuidance || '此題需要繼續訂正'
    })),
    details: normalizedResults.map((r) => ({
      questionId: r.questionId,
      isCorrect: r.passed,
      studentAnswer: r.studentAnswer,
      reason: r.reason,
      studentGuidance: r.newGuidance || r.reason
    }))
  }
}

async function handleCorrectionDashboard(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const assignmentId =
    typeof req.query?.assignmentId === 'string' ? req.query.assignmentId.trim() : ''
  if (!assignmentId) {
    res.status(400).json({ error: 'Missing assignmentId' })
    return
  }

  const supabaseDb = getSupabaseAdmin()
  try {
    const { data: assignment, error: assignmentError } = await supabaseDb
      .from('assignments')
      .select('id, title, classroom_id')
      .eq('id', assignmentId)
      .eq('owner_id', user.id)
      .maybeSingle()

    if (assignmentError) throw new Error(assignmentError.message)
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found' })
      return
    }

    const [studentsResult, statesResult, correctionsResult] = await Promise.all([
      supabaseDb
        .from('students')
        .select('id, name, seat_number')
        .eq('owner_id', user.id)
        .eq('classroom_id', assignment.classroom_id),
      supabaseDb
        .from('assignment_student_state')
        .select('*')
        .eq('owner_id', user.id)
        .eq('assignment_id', assignmentId),
      supabaseDb
        .from('correction_question_items')
        .select('student_id, status')
        .eq('owner_id', user.id)
        .eq('assignment_id', assignmentId)
        .in('status', ['open', 'disputed'])
    ])

    if (studentsResult.error) throw new Error(studentsResult.error.message)
    if (statesResult.error) throw new Error(statesResult.error.message)
    if (correctionsResult.error) throw new Error(correctionsResult.error.message)

    const stateByStudentId = new Map()
    for (const row of statesResult.data || []) {
      stateByStudentId.set(row.student_id, row)
    }
    const openCountByStudentId = new Map()
    const disputedCountByStudentId = new Map()
    for (const row of correctionsResult.data || []) {
      if (!row.student_id) continue
      if (row.status === 'disputed') {
        disputedCountByStudentId.set(
          row.student_id,
          (disputedCountByStudentId.get(row.student_id) || 0) + 1
        )
      } else {
        openCountByStudentId.set(
          row.student_id,
          (openCountByStudentId.get(row.student_id) || 0) + 1
        )
      }
    }

    const latestByStudent = await fetchLatestGradedSubmissionsByStudent(
      supabaseDb,
      user.id,
      assignmentId
    )

    const students = (studentsResult.data || [])
      .map((student) => {
        const state = stateByStudentId.get(student.id) || null
        const latestSubmission = latestByStudent.get(student.id) || null
        const latestMistakes = latestSubmission
          ? parseMistakesFromGradingResult(latestSubmission.grading_result)
          : []
        return {
          studentId: student.id,
          name: student.name,
          seatNumber: student.seat_number,
          status: state?.status || 'not_uploaded',
          correctionAttemptCount: clampInteger(state?.correction_attempt_count, 0, 99, 0),
          correctionAttemptLimit: clampInteger(
            state?.correction_attempt_limit,
            1,
            MAX_CORRECTION_ATTEMPT_LIMIT,
            DEFAULT_CORRECTION_ATTEMPT_LIMIT
          ),
          openQuestionCount: openCountByStudentId.get(student.id) || 0,
          disputedQuestionCount: disputedCountByStudentId.get(student.id) || 0,
          latestMistakeCount: latestMistakes.length,
          lastStatusReason: state?.last_status_reason || '',
          lastGradedSubmissionId: state?.last_graded_submission_id || latestSubmission?.id || null
        }
      })
      .sort((a, b) => {
        const sa = Number.isFinite(a.seatNumber) ? a.seatNumber : 99999
        const sb = Number.isFinite(b.seatNumber) ? b.seatNumber : 99999
        if (sa !== sb) return sa - sb
        return String(a.name || '').localeCompare(String(b.name || ''))
      })

    const dispatchActive = students.some((item) =>
      ['correction_required', 'correction_in_progress'].includes(item.status)
    )
    const dispatchReadyCount = students.filter(
      (item) =>
        item.latestMistakeCount > 0 &&
        !['correction_required', 'correction_in_progress'].includes(item.status)
    ).length

    res.status(200).json({
      assignmentId,
      assignmentTitle: assignment.title,
      dispatchActive,
      dispatchReadyCount,
      students
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '讀取訂正儀表板失敗'
    })
  }
}

// Natural-sort question IDs like "1-2-1" < "1-2-10" — split by '-', compare numerically
function compareQuestionIdsNatural(a, b) {
  const pa = String(a || '').split('-').map((s) => parseInt(s, 10))
  const pb = String(b || '').split('-').map((s) => parseInt(s, 10))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const ai = Number.isFinite(pa[i]) ? pa[i] : 0
    const bi = Number.isFinite(pb[i]) ? pb[i] : 0
    if (ai !== bi) return ai - bi
  }
  return String(a).localeCompare(String(b))
}

// Teacher generates correction notice PDF data (one entry per student)
async function handleCorrectionNotice(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const assignmentId =
    typeof req.query?.assignmentId === 'string' ? req.query.assignmentId.trim() : ''
  if (!assignmentId) {
    res.status(400).json({ error: 'Missing assignmentId' })
    return
  }

  const rawStudentIds =
    typeof req.query?.studentIds === 'string' ? req.query.studentIds.trim() : ''
  const requestedStudentIds = rawStudentIds
    ? rawStudentIds.split(',').map((s) => s.trim()).filter(Boolean)
    : null

  const supabaseDb = getSupabaseAdmin()
  try {
    const { data: assignment, error: assignmentError } = await supabaseDb
      .from('assignments')
      .select('id, title, classroom_id')
      .eq('id', assignmentId)
      .eq('owner_id', user.id)
      .maybeSingle()

    if (assignmentError) throw new Error(assignmentError.message)
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found' })
      return
    }

    const [studentsResult, classroomResult] = await Promise.all([
      supabaseDb
        .from('students')
        .select('id, name, seat_number')
        .eq('owner_id', user.id)
        .eq('classroom_id', assignment.classroom_id),
      supabaseDb
        .from('classrooms')
        .select('name')
        .eq('id', assignment.classroom_id)
        .eq('owner_id', user.id)
        .maybeSingle()
    ])
    if (studentsResult.error) throw new Error(studentsResult.error.message)
    if (classroomResult.error) throw new Error(classroomResult.error.message)

    let students = studentsResult.data || []
    if (requestedStudentIds && requestedStudentIds.length > 0) {
      const idSet = new Set(requestedStudentIds)
      students = students.filter((s) => idSet.has(s.id))
    }

    const { data: submissionRows, error: submissionsError } = await supabaseDb
      .from('submissions')
      .select('id, student_id, grading_result, score, source, status, graded_at, updated_at')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .neq('source', 'student_correction')
      .or('graded_at.not.is.null,status.eq.graded')
    if (submissionsError) throw new Error(submissionsError.message)

    const latestByStudent = new Map()
    for (const row of submissionRows || []) {
      if (!row.student_id) continue
      const rankedAt = toNumber(row.graded_at) ?? toMillis(row.updated_at) ?? 0
      const existing = latestByStudent.get(row.student_id)
      const existingRank = existing
        ? toNumber(existing.graded_at) ?? toMillis(existing.updated_at) ?? 0
        : -1
      if (!existing || rankedAt >= existingRank) {
        latestByStudent.set(row.student_id, row)
      }
    }

    const className = classroomResult.data?.name || ''
    const noticeStudents = students
      .map((student) => {
        const latest = latestByStudent.get(student.id) || null
        const gradingResult = latest?.grading_result || null
        const details = Array.isArray(gradingResult?.details) ? gradingResult.details : []
        const totalCount = details.length
        const mistakes = parseMistakesFromGradingResult(gradingResult)
        const mistakeQuestionIds = mistakes
          .map((m) => String(m.questionId || '').trim())
          .filter(Boolean)
          .sort(compareQuestionIdsNatural)
        const mistakeCount = mistakeQuestionIds.length
        const correctCount = Math.max(0, totalCount - mistakeCount)
        const accuracy = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : null
        const score = latest && Number.isFinite(latest.score) ? Number(latest.score) : null
        return {
          studentId: student.id,
          name: student.name || '',
          seatNumber: Number.isFinite(student.seat_number) ? student.seat_number : null,
          className,
          totalCount,
          correctCount,
          mistakeCount,
          accuracy,
          score,
          mistakeQuestionIds
        }
      })
      .sort((a, b) => {
        const sa = Number.isFinite(a.seatNumber) ? a.seatNumber : 99999
        const sb = Number.isFinite(b.seatNumber) ? b.seatNumber : 99999
        if (sa !== sb) return sa - sb
        return String(a.name).localeCompare(String(b.name))
      })

    res.status(200).json({
      assignmentId,
      assignmentTitle: assignment.title || '',
      className,
      students: noticeStudents
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '讀取訂正通知單資料失敗'
    })
  }
}

// Teacher fetches disputed items for a specific student (for the dispute review panel)
async function handleCorrectionDisputes(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const assignmentId = typeof req.query?.assignmentId === 'string' ? req.query.assignmentId.trim() : ''
  const studentId = typeof req.query?.studentId === 'string' ? req.query.studentId.trim() : ''
  if (!assignmentId || !studentId) {
    res.status(400).json({ error: 'Missing assignmentId or studentId' })
    return
  }

  const supabaseDb = getSupabaseAdmin()
  try {
    const { data, error } = await supabaseDb
      .from('correction_question_items')
      .select('question_id, question_text, hint_text, dispute_note, accessor_result, status')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .eq('status', 'disputed')
      .order('attempt_no', { ascending: false })

    if (error) throw new Error(error.message)

    const corrections = (data || []).map((row) => {
      const accessor = row.accessor_result && typeof row.accessor_result === 'object' ? row.accessor_result : null
      return {
        questionId: row.question_id,
        questionText: row.question_text ?? undefined,
        hintText: String(row.hint_text ?? ''),
        disputeNote: row.dispute_note ?? undefined,
        cropImageUrl: typeof accessor?.crop_image_url === 'string' ? accessor.crop_image_url : undefined,
        sourceSubmissionId: typeof accessor?.source_submission_id === 'string' ? accessor.source_submission_id : undefined,
        studentAnswer: typeof accessor?.student_answer_raw === 'string' ? accessor.student_answer_raw : undefined,
        status: row.status
      }
    })

    res.status(200).json({ corrections })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '載入申訴題目失敗' })
  }
}

// Teacher resolves disputed questions: accept (student was right) or reject (student must redo)
async function handleDisputeResolve(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : ''
  // resolutions: [{questionId, action: 'accept'|'reject', rejectionNote?}]
  const resolutions = Array.isArray(body.resolutions) ? body.resolutions : []

  if (!assignmentId || !studentId || !resolutions.length) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }

  const supabaseDb = getSupabaseAdmin()
  try {
    const now = new Date().toISOString()

    // Process all resolutions in parallel — avoids partial-update inconsistency if one fails mid-loop
    await Promise.all(
      resolutions.map(async (resolution) => {
        const questionId = typeof resolution.questionId === 'string' ? resolution.questionId.trim() : ''
        const action = typeof resolution.action === 'string' ? resolution.action.trim() : ''
        if (!questionId || !['accept', 'reject'].includes(action)) return

        if (action === 'accept') {
          // Teacher agrees — mark as resolved (student was correct, no more action needed)
          const { error } = await supabaseDb
            .from('correction_question_items')
            .update({ status: 'resolved', updated_at: now })
            .eq('owner_id', user.id)
            .eq('assignment_id', assignmentId)
            .eq('student_id', studentId)
            .eq('question_id', questionId)
            .eq('status', 'disputed')
          if (error) throw new Error(error.message)
        } else {
          // Teacher rejects — put back to open, clear dispute_note so student starts fresh
          const rejectionNote = typeof resolution.rejectionNote === 'string' && resolution.rejectionNote.trim()
            ? resolution.rejectionNote.trim()
            : null
          const { error } = await supabaseDb
            .from('correction_question_items')
            .update({
              status: 'open',
              dispute_note: null,
              dispute_rejected_at: now,
              dispute_rejection_note: rejectionNote,
              updated_at: now
            })
            .eq('owner_id', user.id)
            .eq('assignment_id', assignmentId)
            .eq('student_id', studentId)
            .eq('question_id', questionId)
            .eq('status', 'disputed')
          if (error) throw new Error(error.message)
        }
      })
    )

    // 2026-05-28: 申訴 accept 時、把學生這題從錯誤變正確、加分回 submission.score、
    // 從 gradingResult.mistakes 移除
    // 之前只動 correction_question_items.status='resolved'、submission 分數紋風不動、
    // 老師承認學生對結果分數沒還回去（user 回報 bug）
    const acceptedQids = resolutions
      .filter((r) => r?.action === 'accept' && typeof r?.questionId === 'string' && r.questionId.trim())
      .map((r) => r.questionId.trim())
    if (acceptedQids.length > 0) {
      try {
        // 找原始批改的 submission（round 0、最近一份）
        const { data: subRows } = await supabaseDb
          .from('submissions')
          .select('id, score, grading_result, graded_at')
          .eq('owner_id', user.id)
          .eq('assignment_id', assignmentId)
          .eq('student_id', studentId)
          .eq('round', 0)
          .order('graded_at', { ascending: false })
          .limit(1)
        const subRow = subRows?.[0]
        if (subRow?.grading_result && Array.isArray(subRow.grading_result?.details)) {
          const gr = subRow.grading_result
          const acceptedSet = new Set(acceptedQids)
          // mutate details：accepted 題目改成 isCorrect=true、score=maxScore
          const newDetails = gr.details.map((d) => {
            if (!d?.questionId || !acceptedSet.has(d.questionId)) return d
            const maxScore = Number.isFinite(Number(d.maxScore)) ? Number(d.maxScore) : 0
            return {
              ...d,
              score: maxScore,
              isCorrect: maxScore > 0,
              reason: '申訴通過（老師承認原始作答正確）',
              comment: '申訴通過（老師承認原始作答正確）'
            }
          })
          // mistakes：移除 accepted 題目
          const newMistakes = Array.isArray(gr.mistakes)
            ? gr.mistakes.filter((m) => !m?.questionId || !acceptedSet.has(m.questionId))
            : []
          // 重算 totalScore
          const newTotalScore = newDetails.reduce(
            (sum, d) => sum + (Number.isFinite(Number(d?.score)) ? Number(d.score) : 0),
            0
          )
          const newGr = {
            ...gr,
            details: newDetails,
            mistakes: newMistakes,
            totalScore: newTotalScore
          }
          const { error: updErr } = await supabaseDb
            .from('submissions')
            .update({
              score: newTotalScore,
              ai_score: newTotalScore,
              grading_result: newGr,
              updated_at: now
            })
            .eq('id', subRow.id)
            .eq('owner_id', user.id)
          if (updErr) {
            console.warn('[dispute-resolve] submission grading_result update failed:', updErr.message)
          }
        }
      } catch (err) {
        console.warn('[dispute-resolve] failed to sync accepted scores back to submission:', err?.message)
      }
    }

    // After resolving all, check remaining open/disputed counts to update state
    const { data: remaining } = await supabaseDb
      .from('correction_question_items')
      .select('status')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .in('status', ['open', 'disputed'])

    const remainingOpen = (remaining || []).filter((r) => r.status === 'open').length
    const remainingDisputed = (remaining || []).filter((r) => r.status === 'disputed').length

    let newStatus
    if (remainingOpen > 0) {
      newStatus = 'correction_required'
    } else if (remainingDisputed > 0) {
      newStatus = 'correction_pending_review'
    } else {
      newStatus = 'correction_passed'
    }

    await upsertAssignmentStudentState(supabaseDb, user.id, assignmentId, studentId, compactObject({
      status: newStatus,
      last_status_reason: newStatus === 'correction_required'
        ? '老師駁回申訴，請重新訂正'
        : newStatus === 'correction_pending_review'
          ? '仍有申訴題目待審閱'
          : null
    }))

    res.status(200).json({
      success: true,
      remainingOpen,
      remainingDisputed,
      newStatus
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '申訴裁決失敗' })
  }
}

// ── 用短碼匯入答案卷 ────────────────────────────────────────────────────
// 2026-06-01: 匯入分享答案卷時、把原圖從原作者 storage 複製一份到匯入者名下。
//   path 格式 = `<prefix>/<entityId>/<filename>`（如 template-answer-sheets/<id>/page-0.webp）、
//   只把第 2 段 entityId 換成 newId、prefix/filename 保留 → download-by-templateId 走 path 慣例剛好對得上。
//   單張失敗只 skip 該張（non-fatal）、不擋整個匯入。
async function copyTemplateStorageImages(supabaseDb, sourcePaths, newId) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0) return []
  const bucket = supabaseDb.storage.from('homework-images')
  const out = []
  for (const src of sourcePaths) {
    if (typeof src !== 'string' || !src) continue
    const parts = src.split('/')
    if (parts.length < 3) continue
    try {
      const { data, error } = await bucket.download(src)
      if (error || !data) { console.warn(`[import-template] 複製原圖 skip ${src}: ${error?.message || 'no data'}`); continue }
      const buffer = Buffer.from(await data.arrayBuffer())
      parts[1] = newId
      const dest = parts.join('/')
      const { error: upErr } = await bucket.upload(dest, buffer, { contentType: 'image/webp', upsert: true })
      if (upErr) { console.warn(`[import-template] 複製原圖上傳失敗 ${dest}: ${upErr.message}`); continue }
      out.push(dest)
    } catch (e) {
      console.warn(`[import-template] 複製原圖例外 ${src}:`, e instanceof Error ? e.message : e)
    }
  }
  return out
}

async function handleImportTemplate(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }

  const body = parseJsonBody(req)
  const shareCode = typeof body?.shareCode === 'string' ? body.shareCode.trim().toUpperCase() : ''
  if (!shareCode) { res.status(400).json({ error: '請輸入分享碼' }); return }

  const supabaseDb = getSupabaseAdmin()
  try {
    // 查找分享碼對應的答案卷（不限 owner，任何人的都可以匯入）
    // 2026-05-28: SELECT 補 page_orientations + answer_sheet_mode、避免新匯入者踩
    // 「page_orientations 為 null → server smart pageBreaks fallback 退回 0.5 equal split
    //   → 直/橫拍混合答案卷 1-2-2 invisible」這個雷
    // 2026-06-01: 連答案卷原圖也複製一份到匯入者名下（answer_sheet_image_paths / question_booklet_image_paths）
    //   ——否則匯入者沒有原圖、download 端點又擋 owner，無法預覽、也切不出每題 crop（前端是用原圖+bbox 即時切的）。
    //   不複製 folder（importer 沒這資料夾）。
    const { data: source, error: findErr } = await supabaseDb
      .from('answer_key_templates')
      .select('id, name, domain, doc_type, folder, answer_key, question_count, total_score, page_orientations, answer_sheet_mode, answer_sheet_image_paths, question_booklet_image_paths')
      .eq('share_code', shareCode)
      .maybeSingle()

    if (findErr) throw new Error(findErr.message)
    if (!source) { res.status(404).json({ error: '找不到此分享碼的答案卷' }); return }

    // 產生新的短碼給複製品
    const newShareCode = 'AK-' + Math.random().toString(36).substring(2, 8).toUpperCase()
    const newId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
    const nowIso = new Date().toISOString()

    // 2026-06-01: 把原圖（答案卷頁面 + 題本）複製一份到匯入者名下（path 把 entityId 段換成 newId）。
    const newAnswerSheetPaths = await copyTemplateStorageImages(supabaseDb, source.answer_sheet_image_paths, newId)
    const newBookletPaths = await copyTemplateStorageImages(supabaseDb, source.question_booklet_image_paths, newId)

    const { error: insertErr } = await supabaseDb
      .from('answer_key_templates')
      .insert({
        id: newId,
        owner_id: user.id,
        name: source.name,
        domain: source.domain,
        doc_type: source.doc_type,
        answer_key: source.answer_key,
        question_count: source.question_count,
        total_score: source.total_score,
        share_code: newShareCode,
        page_orientations: source.page_orientations,
        answer_sheet_mode: source.answer_sheet_mode,
        answer_sheet_image_paths: newAnswerSheetPaths.length ? newAnswerSheetPaths : null,
        question_booklet_image_paths: newBookletPaths.length ? newBookletPaths : null,
        created_at: nowIso,
        updated_at: nowIso
      })

    if (insertErr) throw new Error(insertErr.message)

    res.status(200).json({
      success: true,
      template: {
        id: newId,
        name: source.name,
        domain: source.domain,
        docType: source.doc_type,
        answerKey: source.answer_key,
        shareCode: newShareCode,
        questionCount: source.question_count,
        totalScore: source.total_score,
        pageOrientations: source.page_orientations,
        answerSheetMode: source.answer_sheet_mode,
        answerSheetImagePaths: newAnswerSheetPaths.length ? newAnswerSheetPaths : undefined,
        questionBookletImagePaths: newBookletPaths.length ? newBookletPaths : undefined,
        updatedAt: nowIso
      }
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '匯入失敗' })
  }
}

// ── 成績統計：直接從 Supabase 取分數 ────────────────────────────────────
async function handleGetGradebookScores(req, res) {
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method Not Allowed' }); return }
  const { user } = await getAuthUser(req, res)
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
  const classroomId = req.query?.classroomId
  if (!classroomId) { res.status(400).json({ error: 'Missing classroomId' }); return }
  const supabaseDb = getSupabaseAdmin()
  try {
    // 取該班級的所有 assignment IDs
    const { data: assignments, error: aErr } = await supabaseDb
      .from('assignments')
      .select('id')
      .eq('owner_id', user.id)
      .eq('classroom_id', classroomId)
    if (aErr) throw aErr
    const assignmentIds = (assignments || []).map(a => a.id)
    if (assignmentIds.length === 0) {
      res.status(200).json({ scores: [] })
      return
    }
    // 取所有 submissions 的分數
    const { data: subs, error: sErr } = await supabaseDb
      .from('submissions')
      .select('id, assignment_id, student_id, score, ai_score, score_source, graded_at, status')
      .eq('owner_id', user.id)
      .in('assignment_id', assignmentIds)
    if (sErr) throw sErr
    res.status(200).json({ scores: subs || [] })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '取得分數失敗' })
  }
}

// ── 清除作業的批改結果 ────────────────────────────────────────────────────
// ── 直接儲存批改結果到 Supabase（不依賴 sync push）────────────────────
async function handleSaveGrading(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }
  const { user } = await getAuthUser(req, res)
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
  const body = parseJsonBody(req)
  const submissions = Array.isArray(body?.submissions) ? body.submissions : []
  if (submissions.length === 0) { res.status(400).json({ error: 'Missing submissions' }); return }
  const supabaseDb = getSupabaseAdmin()
  try {
    let updated = 0
    for (const sub of submissions) {
      if (!sub?.id) continue
      // Phase A 失敗時、client 會帶 status='grading_failed' + gradingResult.pipelineFailure
      // 該情況不寫入 score / ai_score / graded_at（沒有實際批分）
      const isFailure = sub?.status === 'grading_failed'
      const updateFields = isFailure
        ? {
            status: 'grading_failed',
            grading_result: sub.gradingResult ?? undefined,
            updated_at: new Date().toISOString()
          }
        : {
            status: 'graded',
            score: toNumber(sub.score) ?? undefined,
            ai_score: toNumber(sub.aiScore) ?? undefined,
            score_source: sub.scoreSource ?? 'ai',
            grading_result: sub.gradingResult ?? undefined,
            graded_at: sub.gradedAt ?? Date.now(),
            updated_at: new Date().toISOString()
          }
      const { error } = await supabaseDb
        .from('submissions')
        .update(compactObject(updateFields))
        .eq('id', sub.id)
        .eq('owner_id', user.id)
      if (!error) updated++
    }
    // 觸發學生端狀態轉換（graded_once、訂正流程等）
    if (updated > 0) {
      try {
        // 查詢剛更新的 submissions 來取得 assignment_id
        const updatedIds = submissions.filter(s => s?.id).map(s => s.id)
        const { data: updatedSubs } = await supabaseDb
          .from('submissions')
          .select('id, assignment_id, student_id, status, graded_at, grading_result, source')
          .eq('owner_id', user.id)
          .in('id', updatedIds)
        if (updatedSubs && updatedSubs.length > 0) {
          // 2026-05-28: 手動改分數時、強制 rebuild correction state（不 skip 已在訂正流程的學生）
          // 否則「老師加分回該題」/「老師扣分」這種變動沒同步到學生端訂正清單
          const fromManualScoreEdit = body?.fromManualScoreEdit === true
          await applySubmissionStateTransitions(
            supabaseDb,
            user.id,
            updatedSubs,
            { forceRebuildCorrection: fromManualScoreEdit }
          )
        }
      } catch (err) {
        console.warn('[save-grading] applySubmissionStateTransitions failed (non-fatal):', err?.message)
      }
    }
    res.status(200).json({ success: true, updated })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '儲存失敗' })
  }
}

// 2026-05-18: PR3 審查頁老師確認後寫 final_answers 到 submissions。
// 不更動 score / status (status 仍是 synced、由 deriveCardStage 透過 final_answers 完整性算出待批改 / 待複核)
async function handleSaveFinalAnswers(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }
  const { user } = await getAuthUser(req, res)
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
  const body = parseJsonBody(req)
  const submissions = Array.isArray(body?.submissions) ? body.submissions : []
  if (submissions.length === 0) { res.status(400).json({ error: 'Missing submissions' }); return }
  const supabaseDb = getSupabaseAdmin()
  try {
    let updated = 0
    for (const sub of submissions) {
      if (!sub?.id || !Array.isArray(sub?.finalAnswers)) continue
      const { error } = await supabaseDb
        .from('submissions')
        .update({
          final_answers: sub.finalAnswers,
          updated_at: new Date().toISOString()
        })
        .eq('id', sub.id)
        .eq('owner_id', user.id)
      if (!error) updated++
    }
    res.status(200).json({ success: true, updated })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '儲存失敗' })
  }
}

async function handleClearGrading(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }
  const { user } = await getAuthUser(req, res)
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
  const body = parseJsonBody(req)
  const assignmentId = typeof body?.assignmentId === 'string' ? body.assignmentId.trim() : ''
  if (!assignmentId) { res.status(400).json({ error: 'Missing assignmentId' }); return }
  const supabaseDb = getSupabaseAdmin()
  try {
    const nowIso = new Date().toISOString()
    // 先撈出「真的有 grading_result」的學生（清除前）→ 等下只精準重設這些人的 state。
    // 手動批改的 stub submission 無 grading_result、不在此清單、其 state 完全不碰（人為決定保留）。
    const { data: gradedSubs, error: gradedSubsErr } = await supabaseDb
      .from('submissions')
      .select('student_id')
      .eq('assignment_id', assignmentId)
      .eq('owner_id', user.id)
      .not('grading_result', 'is', null)
    if (gradedSubsErr) throw new Error(gradedSubsErr.message)
    const affectedStudentIds = [...new Set((gradedSubs || []).map((r) => r.student_id).filter(Boolean))]

    const { error } = await supabaseDb
      .from('submissions')
      .update({
        status: 'synced',
        score: null,
        ai_score: null,
        score_source: null,
        feedback: null,
        grading_result: null,
        graded_at: null,
        updated_at: nowIso
      })
      .eq('assignment_id', assignmentId)
      .eq('owner_id', user.id)
      .not('grading_result', 'is', null)
    if (error) throw new Error(error.message)

    // 2026-05-30: 更換答案卷 = 評分「標準」變了 → 連訂正/申訴狀態也必須失效。
    // 跟「重跑 Phase A」不同：那個會擋下已完成(correction_passed)的卷；
    // 但「改答案卷」連 endpoint 也要 force 清（舊標準下的訂正/申訴都不算數）。
    // 重設目標 = 'uploaded'（有卷、等重批、仍鎖住不讓學生亂傳），等同剛上傳尚未批改；
    // 不能用 'graded'（會讓總覽把清空的學生誤當已批改）。
    // 只動「剛被清掉 grading 的學生」(affectedStudentIds)，含 graded / 所有 correction_*（含 endpoint）；
    // 手動批改 stub 不在清單、不受影響。詳見 docs/批改重跑與清除政策.md §4、§6。
    if (affectedStudentIds.length > 0) {
      const { error: stateErr } = await supabaseDb
        .from('assignment_student_state')
        .update({ status: 'uploaded', last_status_reason: '老師更換答案卷、批改與訂正狀態已清除', updated_at: nowIso })
        .eq('owner_id', user.id)
        .eq('assignment_id', assignmentId)
        .in('student_id', affectedStudentIds)
      if (stateErr) throw new Error(stateErr.message)
    }
    const { error: itemsErr } = await supabaseDb
      .from('correction_question_items')
      .update({ status: 'skipped', updated_at: nowIso })
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .in('status', ['open', 'disputed', 'resolved'])
    if (itemsErr) throw new Error(itemsErr.message)

    console.log(`✅ [clear-grading] 已清除 assignment=${assignmentId} 的批改結果 + 訂正/申訴狀態(含 endpoint)`)
    res.status(200).json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '清除失敗' })
  }
}

// 2026-05-28: Q1 — Phase A/B 重跑前先呼叫此 endpoint。
// 行為：
//   - 任一學生 status='correction_passed' → 回 { blockedStudents: [...] }、HTTP 409、不動資料
//   - 其他 correction_* 狀態 → 重置 assignment_student_state=graded、close correction_question_items
//   - 不在 correction 狀態 → no-op
// 用途：避免老師重跑批改時、舊 correction_question_items 跟新 mistakes 不一致
async function handleClearCorrectionForRerun(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }
  const { user } = await getAuthUser(req, res)
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
  const body = parseJsonBody(req)
  const assignmentId = typeof body?.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const studentIds = Array.isArray(body?.studentIds)
    ? [...new Set(body.studentIds.map((v) => typeof v === 'string' ? v.trim() : '').filter(Boolean))]
    : []
  if (!assignmentId || studentIds.length === 0) {
    res.status(400).json({ error: 'Missing assignmentId or studentIds' })
    return
  }
  const supabaseDb = getSupabaseAdmin()
  try {
    const { data: states, error: statesError } = await supabaseDb
      .from('assignment_student_state')
      .select('student_id, status')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .in('student_id', studentIds)
    if (statesError) throw new Error(statesError.message)

    const statusByStudent = new Map()
    for (const row of states || []) statusByStudent.set(row.student_id, String(row.status || '').toLowerCase())

    const passedStudentIds = studentIds.filter((sid) => statusByStudent.get(sid) === 'correction_passed')
    if (passedStudentIds.length > 0) {
      const { data: studentRows } = await supabaseDb
        .from('students')
        .select('id, name, seat_number')
        .eq('owner_id', user.id)
        .in('id', passedStudentIds)
      const blockedStudents = (studentRows || []).map((s) => ({
        studentId: s.id,
        name: s.name,
        seatNumber: s.seat_number
      }))
      res.status(409).json({
        error: 'CORRECTION_PASSED_BLOCKED',
        message: '部分學生已完成訂正、無法重跑批改',
        blockedStudents
      })
      return
    }

    const NON_TERMINAL = ['correction_required', 'correction_in_progress', 'correction_pending_review', 'correction_failed']
    const studentsToClear = studentIds.filter((sid) => NON_TERMINAL.includes(statusByStudent.get(sid)))
    if (studentsToClear.length === 0) {
      res.status(200).json({ success: true, clearedCount: 0 })
      return
    }

    const nowIso = new Date().toISOString()
    const { error: stateErr } = await supabaseDb
      .from('assignment_student_state')
      .update({
        status: 'graded',
        last_status_reason: '老師重新批改、訂正狀態已清除',
        updated_at: nowIso
      })
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .in('student_id', studentsToClear)
      .in('status', NON_TERMINAL)
    if (stateErr) throw new Error(stateErr.message)

    const { error: itemsErr } = await supabaseDb
      .from('correction_question_items')
      .update({ status: 'skipped', updated_at: nowIso })
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .in('student_id', studentsToClear)
      .in('status', ['open', 'disputed'])
    if (itemsErr) throw new Error(itemsErr.message)

    console.log(`[clear-correction-for-rerun] cleared assignment=${assignmentId} students=${studentsToClear.length}`)
    res.status(200).json({ success: true, clearedCount: studentsToClear.length })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '清除訂正狀態失敗' })
  }
}

// 2026-05-30: Phase B 重批的「逐題狀態調和」（取代舊的「整批清+重建」）。
// 依 docs/批改重跑與清除政策.md §5 逐題比對新舊對錯、只動翻轉題、保留未變動題的訂正/申訴成果。
// body: { assignmentId, studentId, submissionId, gradingResult }（gradingResult = 剛算好的新 Phase B 結果）
// 回傳調整後的 gradingResult（client 用它覆蓋本地）。
async function handleReconcilePhaseBRegrade(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }
  const { user } = await getAuthUser(req, res)
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
  const body = parseJsonBody(req)
  const assignmentId = typeof body?.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const studentId = typeof body?.studentId === 'string' ? body.studentId.trim() : ''
  const submissionId = typeof body?.submissionId === 'string' ? body.submissionId.trim() : ''
  const newGrade = body?.gradingResult
  if (!assignmentId || !studentId || !submissionId || !newGrade || !Array.isArray(newGrade.details)) {
    res.status(400).json({ error: 'Missing assignmentId/studentId/submissionId/gradingResult' }); return
  }
  const supabaseDb = getSupabaseAdmin()
  try {
    const now = new Date().toISOString()
    // 1) 目前每題的訂正/申訴狀態（優先序 disputed > open > resolved）
    const { data: items } = await supabaseDb
      .from('correction_question_items')
      .select('question_id, status, dispute_note, dispute_rejected_at')
      .eq('owner_id', user.id).eq('assignment_id', assignmentId).eq('student_id', studentId)
      .in('status', ['open', 'disputed', 'resolved'])
    const rank = { disputed: 3, open: 2, resolved: 1 }
    const itemByQ = new Map()
    for (const it of items || []) {
      const q = String(it.question_id || '').trim(); if (!q) continue
      const prev = itemByQ.get(q)
      if (!prev || (rank[it.status] || 0) > (rank[prev.status] || 0)) itemByQ.set(q, it)
    }
    const oldStateOf = (q) => {
      const it = itemByQ.get(q)
      if (!it) return 'none'
      if (it.status === 'disputed') return 'disputed'
      if (it.status === 'open') return 'open'
      if (it.status === 'resolved') return (it.dispute_note && !it.dispute_rejected_at) ? 'appeal_won' : 'corrected'
      return 'none'
    }
    // 2) 新一輪的錯題集合
    // ⚠️ mistakes 欄位名是 `id`（非 questionId）、且 explain 沒跑時 mistakes 可能為空 →
    //    一律用 canonical normalizer（讀 id||questionId、無 mistakes 時從 details isCorrect=false 推導）。
    const newMistakeList = parseMistakesFromGradingResult(newGrade)
    const newMistakeByQ = new Map(newMistakeList.map((m) => [String(m.questionId || '').trim(), m]))
    const newMistakeQs = new Set([...newMistakeByQ.keys()].filter(Boolean))
    const allQs = new Set([...itemByQ.keys(), ...newMistakeQs])

    // 3) 逐題決策（見 §5 矩陣）
    const newOpen = []          // none + 現在錯：對→錯、新錯題
    const resolveOpen = []      // open + 現在對：錯→對、結案
    const autoVindicate = []    // disputed + 現在對：申訴自動平反 → 該題給對
    const appealOverride = []   // appeal_won + 現在錯：老師已接受、不被覆蓋 → 該題給對
    for (const q of allQs) {
      const st = oldStateOf(q)
      const wrong = newMistakeQs.has(q)
      if (st === 'none' && wrong) newOpen.push(q)
      else if (st === 'open' && !wrong) resolveOpen.push(q)
      else if (st === 'disputed' && !wrong) autoVindicate.push(q)
      else if (st === 'appeal_won' && wrong) appealOverride.push(q)
      // 其餘（open+錯、disputed+錯、corrected、appeal_won+對）一律不動，保留現狀
    }

    // 4) 調整 grade：autoVindicate + appealOverride 的題目改成「正確、滿分」、移出 mistakes、重算分
    const makeCorrect = new Set([...autoVindicate, ...appealOverride])
    let adjusted = newGrade
    if (makeCorrect.size > 0) {
      const newDetails = (newGrade.details || []).map((d) => {
        const q = String(d?.questionId || '').trim()
        if (!makeCorrect.has(q)) return d
        const ms = Number.isFinite(Number(d?.maxScore)) ? Number(d.maxScore) : 0
        const reason = appealOverride.includes(q)
          ? '申訴通過（老師已接受、重新批改不覆蓋）'
          : '申訴通過（重新批改判定正確而自動通過）'
        return { ...d, score: ms, isCorrect: ms > 0, reason, comment: reason }
      })
      const newMistakes = (Array.isArray(newGrade.mistakes) ? newGrade.mistakes : [])
        .filter((m) => !makeCorrect.has(String((m?.id || m?.questionId) || '').trim()))
      adjusted = { ...newGrade, details: newDetails, mistakes: newMistakes }
    }
    const finalScore = (adjusted.details || []).reduce((s, d) => s + (Number.isFinite(Number(d?.score)) ? Number(d.score) : 0), 0)
    adjusted = { ...adjusted, totalScore: finalScore }

    // 5) 存回原卷
    const { error: subErr } = await supabaseDb.from('submissions').update({
      score: finalScore, ai_score: finalScore, grading_result: adjusted,
      score_source: 'ai', status: 'graded', updated_at: now
    }).eq('id', submissionId).eq('owner_id', user.id)
    if (subErr) throw new Error(subErr.message)

    // 6) 套用 item 動作：結案(resolveOpen) + 自動平反(autoVindicate) → resolved
    const toResolve = [...resolveOpen, ...autoVindicate]
    if (toResolve.length > 0) {
      await supabaseDb.from('correction_question_items')
        .update({ status: 'resolved', updated_at: now })
        .eq('owner_id', user.id).eq('assignment_id', assignmentId).eq('student_id', studentId)
        .in('question_id', toResolve).in('status', ['open', 'disputed'])
    }
    // 新錯題（原本對、重批變錯）：開新 attempt_no=0 open 列。
    // 帶上 bbox/hint/student_answer（從 normalizer 來、訂正 UI 與 lazy crop 需要）；
    // delete-then-insert 避免跟殘列的 (…,attempt_no,question_id) 唯一鍵衝突。
    if (newOpen.length > 0) {
      await supabaseDb.from('correction_question_items')
        .delete().eq('owner_id', user.id).eq('assignment_id', assignmentId).eq('student_id', studentId)
        .in('question_id', newOpen)
      const rows = newOpen.map((q) => {
        const m = newMistakeByQ.get(q) || {}
        return compactObject({
          owner_id: user.id, assignment_id: assignmentId, student_id: studentId, attempt_no: 0,
          question_id: q,
          question_text: m.questionText || undefined,
          mistake_reason: m.reason || undefined,
          hint_text: m.hintText || undefined,
          accessor_result: compactObject({
            source_submission_id: submissionId,
            question_bbox: normalizeBbox(m.questionBbox),
            answer_bbox: normalizeBbox(m.answerBbox),
            student_answer_raw: m.studentAnswerRaw || undefined
          }),
          status: 'open'
        })
      })
      await supabaseDb.from('correction_question_items').insert(rows)
    }

    // 7) 重算 assignment_student_state.status（沿用 dispute-resolve 的判定）
    const { data: remain } = await supabaseDb.from('correction_question_items')
      .select('status').eq('owner_id', user.id).eq('assignment_id', assignmentId).eq('student_id', studentId)
      .in('status', ['open', 'disputed'])
    const openN = (remain || []).filter((r) => r.status === 'open').length
    const dispN = (remain || []).filter((r) => r.status === 'disputed').length
    const wasInCorrection = itemByQ.size > 0
    // 2026-06-01: 只有「學生真的交過訂正(correction_attempt_count>0)」才算「已完成訂正」。
    //   老師重批把錯題清掉、但學生沒做任何訂正(attempts=0) → 回 graded、不誤標已完成訂正。
    //   (尤其原本的「錯」常是 AI 批錯、重批後消失，學生根本沒訂正過。)
    const { data: stRow } = await supabaseDb.from('assignment_student_state')
      .select('correction_attempt_count')
      .eq('owner_id', user.id).eq('assignment_id', assignmentId).eq('student_id', studentId)
      .maybeSingle()
    const attemptCount = clampInteger(stRow?.correction_attempt_count, 0, 99, 0)
    let st2
    if (openN > 0) st2 = 'correction_required'
    else if (dispN > 0) st2 = 'correction_pending_review'
    else if (wasInCorrection && attemptCount > 0) st2 = 'correction_passed'  // 學生真的訂正完成
    else st2 = 'graded'  // 從沒訂正、或老師重批清掉錯題(學生沒做) → 一般已批改
    await upsertAssignmentStudentState(supabaseDb, user.id, assignmentId, studentId, compactObject({
      status: st2,
      last_status_reason: st2 === 'correction_passed' ? null : '老師重新批改、已逐題調和訂正/申訴狀態'
    }))

    console.log(`[reconcile-phase-b] ${assignmentId}/${studentId} newOpen=${newOpen.length} resolved=${resolveOpen.length} vindicate=${autoVindicate.length} appealKeep=${appealOverride.length} → ${st2} score=${finalScore}`)
    res.status(200).json({
      success: true, gradingResult: adjusted, score: finalScore, newStatus: st2,
      reconcile: { newWrong: newOpen, resolved: resolveOpen, autoVindicated: autoVindicate, appealKept: appealOverride }
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Phase B 調和失敗' })
  }
}

async function handleManualGrade(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : ''
  if (!assignmentId || !studentId) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }
  const supabaseDb = getSupabaseAdmin()
  try {
    // 先確認是否已有 submission（避免重複建立）
    const { data: existing } = await supabaseDb
      .from('submissions')
      .select('id')
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .eq('owner_id', user.id)
      .maybeSingle()

    let stubSubmissionId = existing?.id ?? null
    if (!existing) {
      // 建一筆 stub submission，讓 sync 能把 graded 狀態帶回前端
      const { randomUUID } = await import('node:crypto')
      stubSubmissionId = randomUUID()
      const { error: insertErr } = await supabaseDb.from('submissions').insert({
        id: stubSubmissionId,
        assignment_id: assignmentId,
        student_id: studentId,
        owner_id: user.id,
        status: 'graded',
        source: 'teacher_camera',
        round: 0,
        actor_user_id: user.id,
        image_url: '',
        created_at: new Date().toISOString()
      })
      if (insertErr) throw new Error(insertErr.message)
    }

    // 把 stub submission_id 寫進 state，讓 sync-delete 的孤兒守門能正確識別。
    // 沒這欄位 → state 會被誤判為 graded 卻無 submission 連結，學生端被 upload_locked 擋掉。
    await upsertAssignmentStudentState(supabaseDb, user.id, assignmentId, studentId, compactObject({
      status: 'graded',
      current_submission_id: stubSubmissionId ?? undefined,
      last_graded_submission_id: stubSubmissionId ?? undefined,
      graded_once: true,
      upload_locked: true,
      last_status_reason: '教師手動批改成績'
    }))
    res.status(200).json({ success: true, newStatus: 'graded' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '手動標記失敗' })
  }
}

async function handleManualGradeRevert(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : ''
  if (!assignmentId || !studentId) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }
  const supabaseDb = getSupabaseAdmin()
  try {
    // 認 state：必須是手動批改成績的紀錄
    const { data: state, error: stateErr } = await supabaseDb
      .from('assignment_student_state')
      .select('current_submission_id, last_status_reason')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .maybeSingle()
    if (stateErr) throw new Error(stateErr.message)
    if (!state || state.last_status_reason !== '教師手動批改成績') {
      res.status(400).json({ error: '找不到可撤銷的手動標記紀錄' })
      return
    }
    const stubId = state.current_submission_id
    if (stubId) {
      // 防呆：verify 真的是 stub（source=teacher_camera + 空 image_url + NULL grading_result）
      // 任何一個不符就拒絕刪、避免誤殺真學生作業
      const { data: sub, error: subErr } = await supabaseDb
        .from('submissions')
        .select('id, source, image_url, grading_result')
        .eq('id', stubId)
        .eq('owner_id', user.id)
        .maybeSingle()
      if (subErr) throw new Error(subErr.message)
      if (sub) {
        const isStub =
          sub.source === 'teacher_camera' &&
          !sub.image_url &&
          sub.grading_result === null
        if (!isStub) {
          res.status(400).json({ error: 'current_submission 不是手動標記 stub、拒絕刪除' })
          return
        }
        const { error: delErr } = await supabaseDb
          .from('submissions')
          .delete()
          .eq('id', stubId)
          .eq('owner_id', user.id)
        if (delErr) throw new Error(delErr.message)
      }
    }
    // 重置 state 回未上傳
    await upsertAssignmentStudentState(supabaseDb, user.id, assignmentId, studentId, {
      status: 'not_uploaded',
      current_submission_id: null,
      last_graded_submission_id: null,
      graded_once: false,
      upload_locked: false,
      last_status_reason: null
    })
    res.status(200).json({ success: true, newStatus: 'not_uploaded' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '撤銷手動標記失敗' })
  }
}

async function handleCorrectionManualPass(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : ''
  if (!assignmentId || !studentId) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }
  const supabaseDb = getSupabaseAdmin()
  try {
    const now = new Date().toISOString()
    // Capture items being flipped — store original status in accessor_result.manually_passed
    // so revert can restore each item back to its prior open/disputed state.
    const { data: itemsToFlip, error: selectError } = await supabaseDb
      .from('correction_question_items')
      .select('id, accessor_result, status')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .in('status', ['open', 'disputed'])
    if (selectError) throw new Error(selectError.message)
    await Promise.all(
      (itemsToFlip || []).map((item) => {
        const accessor =
          item.accessor_result && typeof item.accessor_result === 'object'
            ? { ...item.accessor_result }
            : {}
        accessor.manually_passed = { from: item.status, at: now }
        return supabaseDb
          .from('correction_question_items')
          .update({ status: 'resolved', updated_at: now, accessor_result: accessor })
          .eq('id', item.id)
      })
    )
    // Mark correction as passed
    await upsertAssignmentStudentState(supabaseDb, user.id, assignmentId, studentId, {
      status: 'correction_passed',
      last_status_reason: '教師手動通過訂正'
    })
    res.status(200).json({ success: true, newStatus: 'correction_passed' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '手動通過訂正失敗' })
  }
}

async function handleCorrectionManualPassRevert(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }
  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : ''
  if (!assignmentId || !studentId) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }
  const supabaseDb = getSupabaseAdmin()
  try {
    const now = new Date().toISOString()
    // 找出有 manually_passed marker 的 resolved items
    const { data: resolvedItems, error: selectError } = await supabaseDb
      .from('correction_question_items')
      .select('id, accessor_result')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .eq('status', 'resolved')
    if (selectError) throw new Error(selectError.message)
    const itemsToRevert = (resolvedItems || []).filter(
      (item) =>
        item.accessor_result &&
        typeof item.accessor_result === 'object' &&
        item.accessor_result.manually_passed
    )
    if (itemsToRevert.length === 0) {
      res.status(400).json({ error: '找不到可撤銷的手動通過紀錄' })
      return
    }
    await Promise.all(
      itemsToRevert.map((item) => {
        const accessor =
          item.accessor_result && typeof item.accessor_result === 'object'
            ? { ...item.accessor_result }
            : {}
        const marker = accessor.manually_passed
        const fromStatus = ['open', 'disputed'].includes(marker?.from) ? marker.from : 'open'
        delete accessor.manually_passed
        return supabaseDb
          .from('correction_question_items')
          .update({ status: fromStatus, updated_at: now, accessor_result: accessor })
          .eq('id', item.id)
      })
    )
    // 回到「待訂正」，學生端會看到要重新訂正
    await upsertAssignmentStudentState(supabaseDb, user.id, assignmentId, studentId, {
      status: 'correction_required',
      last_status_reason: '教師撤銷手動通過'
    })
    res.status(200).json({ success: true, newStatus: 'correction_required', revertedCount: itemsToRevert.length })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '撤銷手動通過失敗' })
  }
}

async function handleCorrectionDispatchToggle(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  const assignmentId =
    typeof body.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'toggle'
  const requestedStudentIds = Array.isArray(body.studentIds)
    ? [
        ...new Set(
          body.studentIds
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter(Boolean)
        )
      ]
    : []
  if (!assignmentId) {
    res.status(400).json({ error: 'Missing assignmentId' })
    return
  }

  const supabaseDb = getSupabaseAdmin()
  try {
    const { data: assignment, error: assignmentError } = await supabaseDb
      .from('assignments')
      .select('id, classroom_id')
      .eq('id', assignmentId)
      .eq('owner_id', user.id)
      .maybeSingle()
    if (assignmentError) throw new Error(assignmentError.message)
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found' })
      return
    }

    const [{ data: states, error: statesError }, latestByStudent] = await Promise.all([
      supabaseDb
        .from('assignment_student_state')
        .select('*')
        .eq('owner_id', user.id)
        .eq('assignment_id', assignmentId),
      fetchLatestGradedSubmissionsByStudent(supabaseDb, user.id, assignmentId)
    ])
    if (statesError) throw new Error(statesError.message)

    const stateByStudentId = new Map()
    for (const row of states || []) {
      stateByStudentId.set(row.student_id, row)
    }

    const currentlyActive = (states || []).some((row) =>
      ['correction_required', 'correction_in_progress'].includes(String(row.status || ''))
    )
    const enable = action === 'start' ? true : action === 'stop' ? false : !currentlyActive

    if (!enable) {
      const nowIso = new Date().toISOString()

      // Layer 1: Find students whose correction submission is currently being AI-rechecked
      // (pending_grading or grading_in_progress) — must not recall them
      const { data: recheckingSubmissions } = await supabaseDb
        .from('submissions')
        .select('student_id')
        .eq('owner_id', user.id)
        .eq('assignment_id', assignmentId)
        .eq('source', 'student_correction')
        .in('status', ['pending_grading', 'pending_grading_retry', 'grading_in_progress'])

      const recheckingStudentIds = new Set(
        (recheckingSubmissions || []).map((r) => r.student_id).filter(Boolean)
      )

      // Fetch student names for blocked students to return in warning message
      let blockedStudents = []
      if (recheckingStudentIds.size > 0) {
        const { data: studentRows } = await supabaseDb
          .from('students')
          .select('id, name, seat_number')
          .eq('owner_id', user.id)
          .in('id', [...recheckingStudentIds])
        blockedStudents = (studentRows || []).map((s) => ({
          studentId: s.id,
          name: s.name,
          seatNumber: s.seat_number
        }))
      }

      // Only recall students who are NOT currently in recheck (and optionally scoped to requestedStudentIds)
      const recallableStates = (states || [])
        .filter((row) =>
          ['correction_required', 'correction_in_progress'].includes(String(row.status || '')) &&
          !recheckingStudentIds.has(row.student_id) &&
          (requestedStudentIds.length === 0 || requestedStudentIds.includes(row.student_id))
        )
        .map((row) => row.student_id)

      if (recallableStates.length > 0) {
        const { error: updateError } = await supabaseDb
          .from('assignment_student_state')
          .update({
            status: 'graded',
            last_status_reason: '教師已停止訂正',
            updated_at: nowIso
          })
          .eq('owner_id', user.id)
          .eq('assignment_id', assignmentId)
          .in('student_id', recallableStates)
          .in('status', ['correction_required', 'correction_in_progress'])
        if (updateError) throw new Error(updateError.message)

        const { error: closeError } = await supabaseDb
          .from('correction_question_items')
          .update({ status: 'skipped', updated_at: nowIso })
          .eq('owner_id', user.id)
          .eq('assignment_id', assignmentId)
          .eq('status', 'open')
          .in('student_id', recallableStates)
        if (closeError) throw new Error(closeError.message)
      }

      res.status(200).json({
        success: true,
        dispatchActive: recheckingStudentIds.size > 0,
        recalledCount: recallableStates.length,
        blockedStudents  // [{studentId, name, seatNumber}] — still in recheck, cannot recall
      })
      return
    }

    const { data: students, error: studentsError } = await supabaseDb
      .from('students')
      .select('id')
      .eq('owner_id', user.id)
      .eq('classroom_id', assignment.classroom_id)
    if (studentsError) throw new Error(studentsError.message)

    const classroomStudentIdSet = new Set(
      (students || []).map((student) => student.id).filter(Boolean)
    )
    const targetStudentIds = requestedStudentIds.length
      ? requestedStudentIds.filter((id) => classroomStudentIdSet.has(id))
      : []
    const targetStudentIdSet = targetStudentIds.length ? new Set(targetStudentIds) : null
    const skippedNotInClassroomCount = requestedStudentIds.length
      ? Math.max(0, requestedStudentIds.length - targetStudentIds.length)
      : 0

    if (requestedStudentIds.length && !targetStudentIds.length) {
      res.status(400).json({
        error: '勾選學生不在此作業班級中'
      })
      return
    }

    let activatedCount = 0
    let skippedLimitCount = 0
    let skippedNoMistakeCount = 0
    let skippedMissingSubmissionCount = 0
    for (const student of students || []) {
      const studentId = student.id
      if (!studentId) continue
      if (targetStudentIdSet && !targetStudentIdSet.has(studentId)) continue
      const latestSubmission = latestByStudent.get(studentId)
      if (!latestSubmission) {
        skippedMissingSubmissionCount += 1
        continue
      }
      const mistakes = parseMistakesFromGradingResult(latestSubmission.grading_result)
      if (!mistakes.length) {
        skippedNoMistakeCount += 1
        continue
      }

      const existingState = stateByStudentId.get(studentId) || null
      const correctionAttemptCount = clampInteger(
        existingState?.correction_attempt_count ?? 0,
        0,
        99,
        0
      )
      const correctionAttemptLimit = clampInteger(
        existingState?.correction_attempt_limit ?? DEFAULT_CORRECTION_ATTEMPT_LIMIT,
        1,
        MAX_CORRECTION_ATTEMPT_LIMIT,
        DEFAULT_CORRECTION_ATTEMPT_LIMIT
      )
      if (correctionAttemptCount >= correctionAttemptLimit) {
        skippedLimitCount += 1
        continue
      }

      const nextState = await upsertAssignmentStudentState(
        supabaseDb,
        user.id,
        assignmentId,
        studentId,
        {
          status: 'correction_required',
          current_submission_id: latestSubmission.id,
          last_graded_submission_id: latestSubmission.id,
          graded_once: true,
          upload_locked: true,
          correction_attempt_count: correctionAttemptCount,
          correction_attempt_limit: correctionAttemptLimit,
          last_status_reason: null
        }
      )
      stateByStudentId.set(studentId, nextState)

      await writeCorrectionQuestionItems(
        supabaseDb,
        user.id,
        assignmentId,
        studentId,
        correctionAttemptCount,
        mistakes,
        {
          sourceSubmissionId: latestSubmission.id,
          sourceImageUrl: latestSubmission.image_url
        }
      )
      activatedCount += 1
    }

    res.status(200).json({
      success: true,
      dispatchActive: currentlyActive || activatedCount > 0,
      activatedCount,
      skippedLimitCount,
      skippedNoMistakeCount,
      skippedMissingSubmissionCount,
      skippedNotInClassroomCount,
      targetedCount: targetStudentIds.length
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '切換派發狀態失敗'
    })
  }
}

async function handleCorrectionUnlock(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  const assignmentId =
    typeof body.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const studentId =
    typeof body.studentId === 'string' ? body.studentId.trim() : ''
  if (!assignmentId || !studentId) {
    res.status(400).json({ error: 'Missing assignmentId or studentId' })
    return
  }

  const supabaseDb = getSupabaseAdmin()
  try {
    const { data: assignment, error: assignmentError } = await supabaseDb
      .from('assignments')
      .select('id')
      .eq('id', assignmentId)
      .eq('owner_id', user.id)
      .maybeSingle()
    if (assignmentError) throw new Error(assignmentError.message)
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found' })
      return
    }

    const { data: state, error: stateError } = await supabaseDb
      .from('assignment_student_state')
      .select('*')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .maybeSingle()
    if (stateError) throw new Error(stateError.message)

    const currentLimit = clampInteger(
      state?.correction_attempt_limit ?? DEFAULT_CORRECTION_ATTEMPT_LIMIT,
      1,
      MAX_CORRECTION_ATTEMPT_LIMIT,
      DEFAULT_CORRECTION_ATTEMPT_LIMIT
    )
    const currentCount = clampInteger(state?.correction_attempt_count ?? 0, 0, 99, 0)
    const nextLimit = clampInteger(
      currentLimit + CORRECTION_UNLOCK_INCREMENT,
      1,
      MAX_CORRECTION_ATTEMPT_LIMIT,
      currentLimit
    )

    const latestByStudent = await fetchLatestGradedSubmissionsByStudent(
      supabaseDb,
      user.id,
      assignmentId
    )
    const latestSubmission = latestByStudent.get(studentId)
    const latestMistakes = latestSubmission
      ? parseMistakesFromGradingResult(latestSubmission.grading_result)
      : []
    if (!latestSubmission || latestMistakes.length === 0) {
      res.status(409).json({
        error: '此學生目前沒有可訂正錯題'
      })
      return
    }

    await upsertAssignmentStudentState(
      supabaseDb,
      user.id,
      assignmentId,
      studentId,
      {
        status: 'correction_required',
        current_submission_id: latestSubmission.id,
        last_graded_submission_id: latestSubmission.id,
        graded_once: true,
        correction_attempt_count: currentCount,
        correction_attempt_limit: nextLimit,
        upload_locked: true,
        last_status_reason: '教師已解鎖，可再訂正'
      }
    )

    await writeCorrectionQuestionItems(
      supabaseDb,
      user.id,
      assignmentId,
      studentId,
      currentCount,
      latestMistakes,
      {
        sourceSubmissionId: latestSubmission.id,
        sourceImageUrl: latestSubmission.image_url
      }
    )

    res.status(200).json({
      success: true,
      studentId,
      assignmentId,
      correctionAttemptCount: currentCount,
      correctionAttemptLimit: nextLimit,
      remainingAttempts: Math.max(0, nextLimit - currentCount)
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '解鎖訂正失敗'
    })
  }
}

async function handleSync(req, res) {
  const { user, accessToken } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const requestedOwnerId = resolveOwnerIdParam(req)
  const isOwnerOverride =
    requestedOwnerId && requestedOwnerId !== user.id

  // 後端始終使用 service role key 繞過 RLS
  const supabaseAdmin = getSupabaseAdmin()

  if (isOwnerOverride && req.method !== 'GET') {
    res.status(403).json({ error: 'Read-only view mode' })
    return
  }

  let ownerId = user.id
  let supabaseDb = supabaseAdmin

  if (isOwnerOverride) {
    try {
      const adminOverride = await requireAdminOverride(user.id)
      if (!adminOverride) {
        res.status(403).json({ error: 'Forbidden' })
        return
      }
      ownerId = requestedOwnerId
      // supabaseDb 已經是 admin client，無需重新賦值
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '讀取使用者權限失敗'
      })
      return
    }
  }

  if (req.method === 'GET') {
    try {
      // 2026-05-25: incremental sync — 只對 submissions 套用 since 過濾（最大宗、16MB TOAST）。
      // 其他表（classrooms/students/assignments/...）小、保持全拉、orphan cleanup 才能正確跑。
      //
      // 流程：client 帶 ?since=<ISO timestamp> 時、submissions select 加 .gte('updated_at', since)、
      // deleted_records 加 .gte('deleted_at', since)。response 多回 serverTime（query 開始前的
      // 時間）、client 存 localStorage、下次 sync 帶回來。本地 Dexie 用 bulkPut（不 clear）、
      // 缺的 row = 沒變 = 保留原值。第一次 sync（no since）= 全拉、後續每 30 秒只拉 submissions deltas。
      //
      // 改前：吳老師單次 sync 2.8MB grading_result+phase_a_state+final_answers JSONB。
      // 改後：沒事件時近 0 bytes、有 5 個學生上傳 ~50KB。~99% submissions JSONB 流量削減。
      const sinceParam = typeof req.query?.since === 'string' ? req.query.since : null
      const since = sinceParam ? new Date(sinceParam) : null
      const sinceIso = since && !Number.isNaN(since.getTime()) ? since.toISOString() : null
      const serverTime = new Date().toISOString()

      // 2026-05-19: PostgREST 預設 cap 1000 筆、submissions 超量會被切（佳軒老師 1040 筆只回 1000、
      // 老師看到「有些學生顯示尚未繳交」其實學生已上傳）。fetchAllPaginated 用 .range() 分頁撈全。
      // submissions 跟 deleted_records 已知會成長到 cap、用分頁；其他表格資料量小、保持單次 query。
      const [
        classroomsResult,
        studentsResult,
        assignmentsResult,
        submissionsResult,
        foldersResult,
        gradebookCustomColumnsResult,
        gradebookCustomScoresResult,
        answerKeyTemplatesResult,
        deletedResult
      ] = await Promise.all([
        supabaseDb.from('classrooms').select('*').eq('owner_id', ownerId),
        supabaseDb.from('students').select('*').eq('owner_id', ownerId),
        supabaseDb.from('assignments').select('*').eq('owner_id', ownerId),
        fetchAllPaginated(() => {
          let qb = supabaseDb
            .from('submissions')
            // 2026-05-17: 加 phase_a_state + final_answers 進 sync select、給 client 卡片狀態計算用
            .select('id, assignment_id, student_id, status, created_at, image_url, thumb_url, score, ai_score, score_source, feedback, graded_at, correction_count, source, round, parent_submission_id, actor_user_id, updated_at, grading_result, phase_a_state, final_answers')
            .eq('owner_id', ownerId)
          if (sinceIso) qb = qb.gte('updated_at', sinceIso)
          return qb
        }),
        supabaseDb.from('folders').select('*').eq('owner_id', ownerId),
        supabaseDb.from('gradebook_custom_columns').select('*').eq('owner_id', ownerId),
        supabaseDb.from('gradebook_custom_scores').select('*').eq('owner_id', ownerId),
        supabaseDb.from('answer_key_templates').select('*').eq('owner_id', ownerId),
        fetchAllPaginated(() => {
          let qb = supabaseDb
            .from('deleted_records')
            .select('table_name, record_id, deleted_at')
            .eq('owner_id', ownerId)
          if (sinceIso) qb = qb.gte('deleted_at', sinceIso)
          return qb
        })
      ])

      if (classroomsResult.error) {
        throw new Error(classroomsResult.error.message)
      }
      if (studentsResult.error) {
        throw new Error(studentsResult.error.message)
      }
      if (assignmentsResult.error) {
        throw new Error(assignmentsResult.error.message)
      }
      if (submissionsResult.error) {
        throw new Error(submissionsResult.error.message)
      }
      if (foldersResult.error) {
        throw new Error(foldersResult.error.message)
      }
      if (gradebookCustomColumnsResult.error) {
        throw new Error(gradebookCustomColumnsResult.error.message)
      }
      if (gradebookCustomScoresResult.error) {
        throw new Error(gradebookCustomScoresResult.error.message)
      }
      if (deletedResult.error) {
        throw new Error(deletedResult.error.message)
      }

      const includeTags = parseBooleanParam(req.query?.includeTags)
      let assignmentTags = undefined
      if (includeTags) {
        const [stateResult, tagsResult] = await Promise.all([
          supabaseDb
            .from('assignment_tag_state')
            .select(
              'assignment_id, status, sample_count, last_event_at, next_run_at, last_generated_at, model, prompt_version'
            )
            .eq('owner_id', ownerId),
          supabaseDb
            .from('assignment_tag_aggregates')
            .select('assignment_id, tag_label, tag_count, examples')
            .eq('owner_id', ownerId)
        ])

        if (stateResult.error) {
          throw new Error(stateResult.error.message)
        }
        if (tagsResult.error) {
          throw new Error(tagsResult.error.message)
        }

        const stateMap = new Map(
          (stateResult.data || []).map((row) => [row.assignment_id, row])
        )
        const tagMap = new Map()

        for (const row of tagsResult.data || []) {
          const assignmentId = row.assignment_id
          if (!assignmentId) continue
          if (!tagMap.has(assignmentId)) tagMap.set(assignmentId, [])
          const list = tagMap.get(assignmentId)
          if (list) {
            list.push(
              compactObject({
                label: row.tag_label,
                count: toNumber(row.tag_count) ?? 0,
                examples: Array.isArray(row.examples) ? row.examples : undefined
              })
            )
          }
        }

        const assignmentIdSet = new Set([
          ...Array.from(stateMap.keys()),
          ...Array.from(tagMap.keys())
        ])

        assignmentTags = Array.from(assignmentIdSet).map((assignmentId) => {
          const state = stateMap.get(assignmentId)
          const tags = tagMap.get(assignmentId) ?? []
          const status = state?.status ?? (tags.length ? 'ready' : 'pending')
          return compactObject({
            assignmentId,
            source: status === 'ready' ? 'ai' : 'rule',
            status,
            sampleCount: state?.sample_count ?? undefined,
            lastEventAt: toMillis(state?.last_event_at) ?? undefined,
            nextRunAt: toMillis(state?.next_run_at) ?? undefined,
            lastGeneratedAt: toMillis(state?.last_generated_at) ?? undefined,
            tags
          })
        })
      }

      const deleted = {
        classrooms: [],
        students: [],
        assignments: [],
        submissions: [],
        folders: [],
        gradebook_custom_columns: [],
        gradebook_custom_scores: [],
        answer_key_templates: []
      }
      const deletedSets = {
        classrooms: new Set(),
        students: new Set(),
        assignments: new Set(),
        submissions: new Set(),
        folders: new Set(),
        gradebook_custom_columns: new Set(),
        gradebook_custom_scores: new Set(),
        answer_key_templates: new Set()
      }

      for (const row of deletedResult.data || []) {
        const tableName = row.table_name
        const recordId = row.record_id
        if (!recordId || !deleted[tableName]) continue
        deleted[tableName].push(
          compactObject({
            id: recordId,
            deletedAt: toMillis(row.deleted_at) ?? undefined
          })
        )
        deletedSets[tableName].add(recordId)
      }

      const classrooms = (classroomsResult.data || []).map((row) =>
        compactObject({
          id: row.id,
          name: row.name,
          folder: row.folder ?? undefined,
          grade: row.grade ?? undefined,
          updatedAt: toMillis(row.updated_at) ?? undefined
        })
      )

      const validClassroomIds = new Set((classroomsResult.data || []).map((r) => r.id))

      const students = (studentsResult.data || [])
        .filter((row) => validClassroomIds.has(row.classroom_id))
        .map((row) => ({
          id: row.id,
          classroomId: row.classroom_id,
          seatNumber: row.seat_number,
          name: row.name,
          email: row.email ?? undefined,
          authUserId: row.auth_user_id ?? undefined,
          updatedAt: toMillis(row.updated_at) ?? undefined
        }))

      // 孤立作業（classroom 不存在）：從回應中移除並清理 Supabase
      const orphanedAssignmentIds = (assignmentsResult.data || [])
        .filter((row) => !validClassroomIds.has(row.classroom_id))
        .map((row) => row.id)

      if (orphanedAssignmentIds.length > 0) {
        console.warn(`[sync GET] 清除 ${orphanedAssignmentIds.length} 筆孤立作業:`, orphanedAssignmentIds)
        await supabaseDb.from('assignments').delete().in('id', orphanedAssignmentIds).eq('owner_id', ownerId)
        for (const id of orphanedAssignmentIds) {
          if (!deletedSets.assignments.has(id)) {
            deleted.assignments.push({ id, deletedAt: Date.now() })
            deletedSets.assignments.add(id)
          }
        }
      }

      const assignments = (assignmentsResult.data || [])
        .filter((row) => validClassroomIds.has(row.classroom_id))
        .map((row) =>
          compactObject({
            id: row.id,
            classroomId: row.classroom_id,
            title: row.title,
            totalPages: row.total_pages,
            domain: row.domain ?? undefined,
            folder: row.folder ?? undefined,
            scoringMode: normalizeScoringMode(row.scoring_mode) ?? undefined,
            gradeWeightPercent: toNumber(row.grade_weight_percent) ?? undefined,
            priorWeightTypes: row.prior_weight_types ?? undefined,
            answerKey: row.answer_key ?? undefined,
            answerKeyTemplateId: row.answer_key_template_id ?? undefined,
            conceptTags: row.concept_tags ?? undefined,
            studentUploadEnabled: row.student_upload_enabled ?? undefined,
            answerSheetImagePaths: row.answer_sheet_image_paths ?? undefined,
            questionBookletImagePaths: row.question_booklet_image_paths ?? undefined,
            answerSheetMode: row.answer_sheet_mode ?? undefined,
            updatedAt: toMillis(row.updated_at) ?? undefined
          })
        )

      const validAssignmentIds = new Set((assignmentsResult.data || [])
        .filter((r) => validClassroomIds.has(r.classroom_id))
        .map((r) => r.id)
      )
      const validStudentIds = new Set(
        (studentsResult.data || [])
          .filter((r) => validClassroomIds.has(r.classroom_id))
          .map((r) => r.id)
      )

      // 孤立 submissions（assignment 不存在）：從回應中移除並清理 Supabase
      const orphanedSubmissionIds = (submissionsResult.data || [])
        .filter((row) => !validAssignmentIds.has(row.assignment_id))
        .map((row) => row.id)

      if (orphanedSubmissionIds.length > 0) {
        console.warn(`[sync GET] 清除 ${orphanedSubmissionIds.length} 筆孤立 submissions:`, orphanedSubmissionIds)
        await supabaseDb.from('submissions').delete().in('id', orphanedSubmissionIds).eq('owner_id', ownerId)
        for (const id of orphanedSubmissionIds) {
          if (!deletedSets.submissions.has(id)) {
            deleted.submissions.push({ id, deletedAt: Date.now() })
            deletedSets.submissions.add(id)
          }
        }
      }

      const submissions = (submissionsResult.data || [])
        .filter((row) => validAssignmentIds.has(row.assignment_id))
        .map((row) => {
        const createdAt = row.created_at ? Date.parse(row.created_at) : null
        const gradedAt = toNumber(row.graded_at)
        const updatedAt = toMillis(row.updated_at)

        return compactObject({
          id: row.id,
          assignmentId: row.assignment_id,
          studentId: row.student_id,
          status: row.status ?? 'synced',
          source: row.source ?? undefined,
          round: row.round ?? 0,
          parentSubmissionId: row.parent_submission_id ?? undefined,
          actorUserId: row.actor_user_id ?? undefined,
          imageUrl: row.image_url ?? undefined,
          thumbUrl: row.thumb_url ?? row.thumbnail_url ?? undefined,
          createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
          score: row.score ?? undefined,
          aiScore: row.ai_score ?? undefined,
          scoreSource: row.score_source ?? undefined,
          feedback: row.feedback ?? undefined,
          gradingResult: row.grading_result ?? undefined,
          mistakesCount: Array.isArray(row.grading_result?.mistakes) && row.grading_result.mistakes.length > 0
            ? row.grading_result.mistakes.length
            : undefined,
          gradedAt: gradedAt ?? undefined,
          correctionCount: row.correction_count ?? undefined,
          updatedAt: updatedAt ?? undefined,
          // 2026-05-18: 補上 Phase A / Phase B 分離設計的 cached state
          // 之前 SELECT 有抓但 response map 漏出、導致 client 卡片 deriveCardStage
          // 無法取得 phase_a_state、Phase A 完成的卡片回退顯示「已上傳」
          phaseAState: row.phase_a_state ?? undefined,
          finalAnswers: row.final_answers ?? undefined
        })
      })

      // 孤立 folders：assignment 類型但 classroomId 不存在，或 classroom 類型但 classroomId 指向不存在的班級
      const orphanedFolderIds = (foldersResult.data || [])
        .filter((row) => {
          if (row.type === 'assignment' && row.classroom_id) {
            return !validClassroomIds.has(row.classroom_id)
          }
          return false
        })
        .map((row) => row.id)

      if (orphanedFolderIds.length > 0) {
        console.warn(`[sync GET] 清除 ${orphanedFolderIds.length} 筆孤立 folders:`, orphanedFolderIds)
        await supabaseDb.from('folders').delete().in('id', orphanedFolderIds).eq('owner_id', ownerId)
        for (const id of orphanedFolderIds) {
          if (!deletedSets.folders.has(id)) {
            deleted.folders.push({ id, deletedAt: Date.now() })
            deletedSets.folders.add(id)
          }
        }
      }

      const folders = (foldersResult.data || [])
        .filter((row) => !orphanedFolderIds.includes(row.id))
        .map((row) =>
          compactObject({
            id: row.id,
            name: row.name,
            type: row.type,
            classroomId: row.classroom_id ?? undefined,
            updatedAt: toMillis(row.updated_at) ?? undefined
          })
        )

      const orphanedGradebookCustomColumnIds = (gradebookCustomColumnsResult.data || [])
        .filter((row) => !validClassroomIds.has(row.classroom_id))
        .map((row) => row.id)

      if (orphanedGradebookCustomColumnIds.length > 0) {
        await supabaseDb
          .from('gradebook_custom_columns')
          .delete()
          .in('id', orphanedGradebookCustomColumnIds)
          .eq('owner_id', ownerId)
        for (const id of orphanedGradebookCustomColumnIds) {
          if (!deletedSets.gradebook_custom_columns.has(id)) {
            deleted.gradebook_custom_columns.push({ id, deletedAt: Date.now() })
            deletedSets.gradebook_custom_columns.add(id)
          }
        }
      }

      const gradebookCustomColumns = (gradebookCustomColumnsResult.data || [])
        .filter(
          (row) =>
            validClassroomIds.has(row.classroom_id) &&
            !orphanedGradebookCustomColumnIds.includes(row.id)
        )
        .map((row) =>
          compactObject({
            id: row.id,
            classroomId: row.classroom_id,
            name: row.name,
            weightPercent: toNumber(row.weight_percent) ?? 0,
            sortOrder: clampInteger(row.sort_order, -999999, 999999, 0),
            updatedAt: toMillis(row.updated_at) ?? undefined
          })
        )

      const validGradebookCustomColumnIds = new Set(
        gradebookCustomColumns.map((row) => row.id)
      )

      const orphanedGradebookCustomScoreIds = (gradebookCustomScoresResult.data || [])
        .filter(
          (row) =>
            !validClassroomIds.has(row.classroom_id) ||
            !validStudentIds.has(row.student_id) ||
            !validGradebookCustomColumnIds.has(row.column_id)
        )
        .map((row) => row.id)

      if (orphanedGradebookCustomScoreIds.length > 0) {
        await supabaseDb
          .from('gradebook_custom_scores')
          .delete()
          .in('id', orphanedGradebookCustomScoreIds)
          .eq('owner_id', ownerId)
        for (const id of orphanedGradebookCustomScoreIds) {
          if (!deletedSets.gradebook_custom_scores.has(id)) {
            deleted.gradebook_custom_scores.push({ id, deletedAt: Date.now() })
            deletedSets.gradebook_custom_scores.add(id)
          }
        }
      }

      const gradebookCustomScores = (gradebookCustomScoresResult.data || [])
        .filter(
          (row) =>
            validClassroomIds.has(row.classroom_id) &&
            validStudentIds.has(row.student_id) &&
            validGradebookCustomColumnIds.has(row.column_id) &&
            !orphanedGradebookCustomScoreIds.includes(row.id)
        )
        .map((row) =>
          compactObject({
            id: row.id,
            classroomId: row.classroom_id,
            columnId: row.column_id,
            studentId: row.student_id,
            score: row.score === null ? null : toNumber(row.score) ?? null,
            updatedAt: toMillis(row.updated_at) ?? undefined
          })
        )

      // Normalize answer_key_templates
      const answerKeyTemplates = (answerKeyTemplatesResult?.data || [])
        .map((row) => compactObject({
          id: row.id,
          name: row.name,
          domain: row.domain ?? undefined,
          docType: row.doc_type ?? undefined,
          folder: row.folder ?? undefined,
          answerKey: row.answer_key ?? undefined,
          questionCount: row.question_count ?? undefined,
          totalScore: row.total_score ?? undefined,
          shareCode: row.share_code ?? undefined,
          pageOrientations: row.page_orientations ?? undefined,
          answerSheetMode: row.answer_sheet_mode ?? undefined,
          answerSheetImagePaths: row.answer_sheet_image_paths ?? undefined,
          questionBookletImagePaths: row.question_booklet_image_paths ?? undefined,
          version: row.version ?? 1,
          updatedAt: toMillis(row.updated_at) ?? undefined
        }))

      res.status(200).json({
        classrooms: classrooms.filter((row) => !deletedSets.classrooms.has(row.id)),
        students: students.filter((row) => !deletedSets.students.has(row.id)),
        assignments: assignments.filter((row) => !deletedSets.assignments.has(row.id)),
        submissions: submissions.filter((row) => !deletedSets.submissions.has(row.id)),
        folders: folders.filter((row) => !deletedSets.folders.has(row.id)),
        gradebookCustomColumns: gradebookCustomColumns.filter(
          (row) => !deletedSets.gradebook_custom_columns.has(row.id)
        ),
        gradebookCustomScores: gradebookCustomScores.filter(
          (row) => !deletedSets.gradebook_custom_scores.has(row.id)
        ),
        answerKeyTemplates: answerKeyTemplates.filter((row) => !deletedSets.answer_key_templates.has(row.id)),
        deleted,
        // 2026-05-25: incremental sync cursor — client 把 serverTime 存 localStorage、
        // 下次 sync 帶 ?since=<serverTime> 取 deltas。serverTime 是 query 開始前抓的、
        // 確保所有「query 中或之後」寫入的 row 下次都會被拉到。
        serverTime,
        ...(assignmentTags ? { assignmentTags } : {})
      })
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '讀取雲端資料失敗'
      })
    }
    return
  }

  if (req.method === 'POST') {
    const body = parseJsonBody(req)
    if (!body) {
      res.status(400).json({ error: 'Invalid JSON body' })
      return
    }

    const classrooms = Array.isArray(body.classrooms) ? body.classrooms : []
    const students = Array.isArray(body.students) ? body.students : []
    const assignments = Array.isArray(body.assignments) ? body.assignments : []
    const submissions = Array.isArray(body.submissions) ? body.submissions : []
    const folders = Array.isArray(body.folders) ? body.folders : []
    const gradebookCustomColumns = Array.isArray(body.gradebookCustomColumns)
      ? body.gradebookCustomColumns
      : []
    const gradebookCustomScores = Array.isArray(body.gradebookCustomScores)
      ? body.gradebookCustomScores
      : []
    const deletedPayload =
      body.deleted && typeof body.deleted === 'object' ? body.deleted : {}
    
    console.log(
      `📥 [API] sync classrooms=${classrooms.length} students=${students.length} assignments=${assignments.length} submissions=${submissions.length} folders=${folders.length} customColumns=${gradebookCustomColumns.length} customScores=${gradebookCustomScores.length}`
    )

    const nowIso = new Date().toISOString()

    try {
      const applyDeletes = async (tableName, items) => {
        const list = normalizeDeletedList(items)
        if (list.length === 0) return
        const ids = list.map((item) => item.id)
        let deletedSubmissionRows = []

        // 步驟 1: 針對 submissions，先刪除雲端儲存檔案
        if (tableName === 'submissions') {
          const { data: submissionRows, error: submissionRowsError } = await supabaseDb
            .from('submissions')
            .select('id, assignment_id, student_id')
            .eq('owner_id', user.id)
            .in('id', ids)

          if (submissionRowsError) {
            throw new Error(submissionRowsError.message)
          }

          deletedSubmissionRows = (submissionRows || []).filter(
            (row) => typeof row.assignment_id === 'string' && typeof row.student_id === 'string'
          )

          const filePaths = list.flatMap(item => ([
            `submissions/${item.id}.webp`,
            `submissions/thumbs/${item.id}.webp`
          ]))

          try {
            // 使用批次刪除 API (Supabase 支援一次刪除多個檔案)
            const { error } = await supabaseDb.storage
              .from('homework-images')
              .remove(filePaths)

            if (error) {
              console.warn('批次刪除儲存檔案失敗，改用逐一刪除:', error.message)

              // 降級方案：逐一刪除
              const results = await Promise.allSettled(
                filePaths.map(async (filePath) => {
                  const { error: singleError } = await supabaseDb.storage
                    .from('homework-images')
                    .remove([filePath])

                  if (singleError && !singleError.message.includes('not found')) {
                    console.warn(`刪除檔案 ${filePath} 失敗:`, singleError.message)
                  }
                })
              )

              const succeeded = results.filter(r => r.status === 'fulfilled').length
              const failed = results.filter(r => r.status === 'rejected').length
              console.log(`✅ 雲端檔案刪除: ${succeeded} 成功, ${failed} 失敗 (共 ${list.length} 個)`)
            } else {
              console.log(`✅ 成功刪除 ${filePaths.length} 個雲端檔案`)
            }
          } catch (err) {
            console.error('❌ 雲端檔案刪除異常:', err)
            // 繼續執行資料庫刪除，不中斷流程
          }
        }

        // 步驟 2: 建立 tombstone 記錄 (原有邏輯)
        const deleteRows = list.map((item) =>
          compactObject({
            owner_id: user.id,
            table_name: tableName,
            record_id: item.id,
            deleted_at: toIsoTimestamp(item.deletedAt) ?? nowIso
          })
        )

        const tombstoneResult = await supabaseDb
          .from('deleted_records')
          .upsert(deleteRows, {
            onConflict: 'owner_id,table_name,record_id'
          })
        if (tombstoneResult.error) {
          throw new Error(tombstoneResult.error.message)
        }

        // 步驟 3: 從資料庫刪除記錄 (原有邏輯)
        const deleteResult = await supabaseDb
          .from(tableName)
          .delete()
          .in('id', ids)
          .eq('owner_id', user.id)
        if (deleteResult.error) {
          throw new Error(deleteResult.error.message)
        }

        if (tableName === 'submissions' && deletedSubmissionRows.length > 0) {
          const pairMap = new Map()
          for (const row of deletedSubmissionRows) {
            pairMap.set(`${row.assignment_id}::${row.student_id}`, row)
          }

          for (const row of pairMap.values()) {
            const { data: remainingRows, error: remainingError } = await supabaseDb
              .from('submissions')
              .select('id')
              .eq('owner_id', user.id)
              .eq('assignment_id', row.assignment_id)
              .eq('student_id', row.student_id)
              .limit(1)

            if (remainingError) {
              throw new Error(remainingError.message)
            }

            if ((remainingRows || []).length === 0) {
              const [assignmentExistsResult, studentExistsResult, currentStateResult] = await Promise.all([
                supabaseDb
                  .from('assignments')
                  .select('id')
                  .eq('owner_id', user.id)
                  .eq('id', row.assignment_id)
                  .limit(1),
                supabaseDb
                  .from('students')
                  .select('id')
                  .eq('owner_id', user.id)
                  .eq('id', row.student_id)
                  .limit(1),
                supabaseDb
                  .from('assignment_student_state')
                  .select('status, current_submission_id, last_graded_submission_id')
                  .eq('owner_id', user.id)
                  .eq('assignment_id', row.assignment_id)
                  .eq('student_id', row.student_id)
                  .maybeSingle()
              ])

              if (assignmentExistsResult.error) {
                throw new Error(assignmentExistsResult.error.message)
              }
              if (studentExistsResult.error) {
                throw new Error(studentExistsResult.error.message)
              }
              if (currentStateResult.error) {
                throw new Error(currentStateResult.error.message)
              }

              const assignmentExists = Array.isArray(assignmentExistsResult.data) && assignmentExistsResult.data.length > 0
              const studentExists = Array.isArray(studentExistsResult.data) && studentExistsResult.data.length > 0
              if (!assignmentExists || !studentExists) {
                continue
              }

              // 防呆：若當前 state 已是 graded 且仍有有效 submission 連結
              // （例如老師剛剛手動批改建了 stub），不要 reset 回 not_uploaded。
              // 這會造成「退回 → 立刻手動批改」的 race condition。
              //
              // 但若 graded 的兩個 submission 連結都是 null（FK ON DELETE SET NULL
              // 把它們清掉了），表示這是「批改後刪 submission 沒重新批改」的孤兒
              // 狀態 — 必須 reset，否則學生被 upload_locked 永久擋住。
              const stateRow = currentStateResult.data
              const hasLiveSubmissionLink = Boolean(
                stateRow?.current_submission_id || stateRow?.last_graded_submission_id
              )
              if (stateRow?.status === 'graded' && hasLiveSubmissionLink) {
                continue
              }

              await upsertAssignmentStudentState(
                supabaseDb,
                user.id,
                row.assignment_id,
                row.student_id,
                {
                  status: 'not_uploaded',
                  current_submission_id: null,
                  last_graded_submission_id: null,
                  graded_once: false,
                  upload_locked: false,
                  correction_attempt_count: 0,
                  last_status_reason: '教師已清空作業，請重新上傳'
                }
              )
            }
          }
        }
      }

      // 先刪子資料，避免 assignment/student 已刪後仍回寫 assignment_student_state 觸發 FK
      await applyDeletes('submissions', deletedPayload.submissions)
      await applyDeletes('gradebook_custom_scores', deletedPayload.gradebook_custom_scores)
      await applyDeletes('gradebook_custom_columns', deletedPayload.gradebook_custom_columns)
      await applyDeletes('assignments', deletedPayload.assignments)
      await applyDeletes('students', deletedPayload.students)
      await applyDeletes('classrooms', deletedPayload.classrooms)
      await applyDeletes('folders', deletedPayload.folders)
      await applyDeletes('answer_key_templates', deletedPayload.answer_key_templates)

      const buildUpsertRows = async (tableName, items, mapper) => {
        const filtered = items.filter((item) => item?.id)
        if (filtered.length === 0) return []
        const ids = filtered.map((item) => item.id)
        const [existingMap, deletedSet] = await Promise.all([
          fetchExistingUpdatedMap(supabaseDb, tableName, ids, user.id),
          fetchDeletedSet(supabaseDb, tableName, ids, user.id)
        ])

        const rows = []
        let skippedDeletedCount = 0
        let skippedStaleCount = 0
        for (const item of filtered) {
          if (deletedSet.has(item.id)) {
            skippedDeletedCount += 1
            continue
          }
          const hasExisting = existingMap.has(item.id)
          const existingUpdatedAt = existingMap.get(item.id)
          if (hasExisting) {
            const incomingUpdatedAt = toMillis(item.updatedAt ?? item.updated_at)
            if (!incomingUpdatedAt || (existingUpdatedAt && incomingUpdatedAt <= existingUpdatedAt)) {
              skippedStaleCount += 1
              continue
            }
          }
          rows.push(mapper(item))
        }
        if (rows.length > 0) {
          console.log(`📝 [sync] upsert ${tableName} count=${rows.length} (incoming=${filtered.length} stale=${skippedStaleCount} deleted=${skippedDeletedCount})`)
        }
        return rows
      }

      const syncTimers = {}
      const syncTimer = (label) => { syncTimers[label] = Date.now() }
      const syncTimerEnd = (label) => { console.log(`⏱️ [sync] ${label}: ${Date.now() - syncTimers[label]}ms`) }

      syncTimer('classrooms')
      const classroomRows = await buildUpsertRows(
        'classrooms',
        classrooms.filter((c) => c?.id),
        (c) =>
          compactObject({
            id: c.id,
            name: c.name,
            folder: c.folder,
            grade: c.grade != null ? parseInt(String(c.grade), 10) : undefined,
            owner_id: user.id,
            updated_at: toIsoTimestamp(c.updatedAt ?? c.updated_at) ?? nowIso
          })
      )

      if (classroomRows.length > 0) {
        const result = await supabaseDb
          .from('classrooms')
          .upsert(classroomRows, { onConflict: 'id' })
        if (result.error) throw new Error(result.error.message)
      }
      syncTimerEnd('classrooms')

      syncTimer('students')
      const studentRows = await buildUpsertRows(
        'students',
        students.filter((s) => s?.id && s?.classroomId),
        (s) =>
          compactObject({
            id: s.id,
            classroom_id: s.classroomId,
            seat_number: s.seatNumber,
            name: s.name,
            email:
              typeof s.email === 'string' && s.email.trim()
                ? s.email.trim().toLowerCase()
                : null,
            owner_id: user.id,
            updated_at: toIsoTimestamp(s.updatedAt ?? s.updated_at) ?? nowIso
          })
      )

      if (studentRows.length > 0) {
        const result = await supabaseDb
          .from('students')
          .upsert(studentRows, { onConflict: 'id' })
        if (result.error) throw new Error(result.error.message)
      }
      syncTimerEnd('students')

      syncTimer('assignments')
      const assignmentRows = await buildUpsertRows(
        'assignments',
        assignments.filter((a) => a?.id && a?.classroomId),
        (a) => {
          const scoringMode =
            normalizeScoringMode(a.scoringMode ?? a.scoring_mode) ?? undefined
          return compactObject({
            id: a.id,
            classroom_id: a.classroomId,
            title: a.title,
            total_pages: a.totalPages,
            domain: a.domain ?? undefined,
            doc_type: a.docType ?? a.doc_type ?? undefined,
            folder: a.folder,
            scoring_mode: scoringMode,
            grade_weight_percent: toNumber(
              a.gradeWeightPercent ?? a.grade_weight_percent
            ) ?? undefined,
            prior_weight_types: a.priorWeightTypes ?? undefined,
            answer_key: a.answerKey ?? undefined,
            answer_key_template_id: a.answerKeyTemplateId ?? a.answer_key_template_id ?? undefined,
            concept_tags: a.conceptTags ?? undefined,
            student_upload_enabled: a.studentUploadEnabled ?? a.student_upload_enabled ?? undefined,
            answer_sheet_image_paths: a.answerSheetImagePaths ?? a.answer_sheet_image_paths ?? undefined,
            question_booklet_image_paths: a.questionBookletImagePaths ?? a.question_booklet_image_paths ?? undefined,
            answer_sheet_mode: normalizeAnswerSheetMode(a.answerSheetMode ?? a.answer_sheet_mode) ?? undefined,
            owner_id: user.id,
            updated_at: toIsoTimestamp(a.updatedAt ?? a.updated_at) ?? nowIso
          })
        }
      )

      if (assignmentRows.length > 0) {
        console.log(`💾 [後端 Sync] 準備寫入 ${assignmentRows.length} 個作業到 Supabase:`, assignmentRows.map(a => ({ id: a.id, title: a.title, hasAnswerKey: !!a.answer_key })))
        const result = await supabaseDb
          .from('assignments')
          .upsert(assignmentRows, { onConflict: 'id' })
        if (result.error) {
          console.error(`❌ [後端 Sync] 寫入失敗:`, result.error)
          throw new Error(result.error.message)
        }
        console.log(`✅ [後端 Sync] 成功寫入 ${assignmentRows.length} 個作業`)
      }

      syncTimerEnd('assignments')

      // ── answer_key_templates ──────────────────────────────────
      // Guard: 不接受空 questions 的 push。stale client 把 answer_key 擦成
      // {questions:[], totalScore:0} 推上來會在 upsert 反向擦掉 server 已寫好的
      // 答案內容（2026-05-26 import-template 路徑的 corruption bug）。
      const incomingTemplates = Array.isArray(body.answerKeyTemplates)
        ? body.answerKeyTemplates.filter((t) => {
            if (!t?.id || !t?.answerKey) return false
            const qs = t.answerKey?.questions
            if (Array.isArray(qs) && qs.length === 0) {
              console.warn(`[SYNC] 拒絕 template ${t.id} push：answer_key.questions 為空（疑似 stale client 覆寫）`)
              return false
            }
            return true
          })
        : []
      if (incomingTemplates.length > 0) {
        const templateRows = incomingTemplates.map((t) => compactObject({
          id: t.id,
          owner_id: user.id,
          name: t.name ?? '',
          domain: t.domain ?? undefined,
          doc_type: t.docType ?? t.doc_type ?? undefined,
          folder: t.folder ?? undefined,
          answer_key: t.answerKey ?? t.answer_key,
          question_count: t.questionCount ?? t.question_count ?? undefined,
          total_score: t.totalScore ?? t.total_score ?? undefined,
          share_code: t.shareCode ?? t.share_code ?? ('AK-' + Math.random().toString(36).substring(2, 8).toUpperCase()),
          page_orientations: t.pageOrientations ?? t.page_orientations ?? undefined,
          answer_sheet_mode: normalizeAnswerSheetMode(t.answerSheetMode ?? t.answer_sheet_mode) ?? undefined,
          answer_sheet_image_paths: t.answerSheetImagePaths ?? t.answer_sheet_image_paths ?? undefined,
          question_booklet_image_paths: t.questionBookletImagePaths ?? t.question_booklet_image_paths ?? undefined,
          version: t.version ?? 1,
          updated_at: toIsoTimestamp(t.updatedAt ?? t.updated_at) ?? nowIso
        }))
        const tplResult = await supabaseDb
          .from('answer_key_templates')
          .upsert(templateRows, { onConflict: 'id' })
        if (tplResult.error) {
          console.error('[SYNC] answer_key_templates upsert failed:', tplResult.error.message)
        } else {
          console.log(`✅ [SYNC] 同步了 ${templateRows.length} 個答案卷模板`)
          // 模板被編輯後，把所有引用此模板的 assignment.total_pages 同步成模板實際頁數，
          // 避免「老師縮頁編輯後 assignment.total_pages 仍是舊值，學生被要求拍多餘頁數」的 bug。
          // 以 page_orientations / answer_sheet_image_paths 中較大者為準（兩者通常相等，
          // 取 max 是為了在資料半殘時偏向「不少傳」）。若兩者皆為空就不動 assignment，
          // 避免老師只改答案內容（沒帶頁數欄位）就把 total_pages 重置成 1。
          for (const t of incomingTemplates) {
            const orientationsCount = Array.isArray(t.pageOrientations) ? t.pageOrientations.length : 0
            const imagePathsCount = Array.isArray(t.answerSheetImagePaths) ? t.answerSheetImagePaths.length : 0
            const candidatePages = Math.max(orientationsCount, imagePathsCount)
            if (candidatePages > 0) {
              const { error: updErr, count } = await supabaseDb
                .from('assignments')
                .update({ total_pages: candidatePages, updated_at: nowIso }, { count: 'exact' })
                .eq('owner_id', user.id)
                .eq('answer_key_template_id', t.id)
              if (updErr) {
                console.error(`[SYNC] sync total_pages for template ${t.id} failed:`, updErr.message)
              } else if (count) {
                console.log(`✅ [SYNC] template ${t.id} 縮頁同步 → ${count} 份 assignment 改 total_pages=${candidatePages}`)
              }
            }

            // 把 template.answer_key 反向同步進所有引用此 template 的 assignments。
            // 同 sync request 內 assignments upsert (~L4047) 跑在 templates upsert 之前、
            // 且 client Dexie 的 assignment.answerKey 不會跟著 AnswerBank 編輯自動更新、
            // 所以 client push 一定會帶舊 answerKey 把 assignment 覆寫成 stale。這層是 SSoT。
            const ak = t.answerKey ?? t.answer_key
            if (ak !== undefined && ak !== null) {
              const { error: akErr, count: akCount } = await supabaseDb
                .from('assignments')
                .update({ answer_key: ak, updated_at: nowIso }, { count: 'exact' })
                .eq('owner_id', user.id)
                .eq('answer_key_template_id', t.id)
              if (akErr) {
                console.error(`[SYNC] sync answer_key for template ${t.id} failed:`, akErr.message)
              } else if (akCount) {
                console.log(`✅ [SYNC] template ${t.id} answer_key 同步 → ${akCount} 份 assignment`)
              }
            }
          }
        }
      }

      // ── gradebook_custom_columns ──────────────────────────────
      const incomingColumns = gradebookCustomColumns.filter(
        (c) => c?.id && (c?.classroomId || c?.classroom_id)
      )
      console.log(`[SYNC] gradebook_custom_columns incoming=${incomingColumns.length}`, {
        owner: user.id,
        items: incomingColumns.map((c) => ({
          id: c.id,
          name: c.name,
          classroomId: c.classroomId ?? c.classroom_id,
          updatedAt: c.updatedAt ?? c.updated_at ?? null
        }))
      })

      const gradebookCustomColumnRows = await buildUpsertRows(
        'gradebook_custom_columns',
        incomingColumns,
        (c) =>
          compactObject({
            id: c.id,
            classroom_id: c.classroomId ?? c.classroom_id,
            name:
              typeof c.name === 'string' && c.name.trim() ? c.name.trim() : '自訂欄位',
            weight_percent: toNumber(c.weightPercent ?? c.weight_percent) ?? 0,
            sort_order: clampInteger(c.sortOrder ?? c.sort_order, -999999, 999999, 0),
            owner_id: user.id,
            updated_at: toIsoTimestamp(c.updatedAt ?? c.updated_at) ?? nowIso
          })
      )

      console.log(`[SYNC] gradebook_custom_columns to_upsert=${gradebookCustomColumnRows.length} skipped=${incomingColumns.length - gradebookCustomColumnRows.length}`)

      if (gradebookCustomColumnRows.length > 0) {
        const result = await supabaseDb
          .from('gradebook_custom_columns')
          .upsert(gradebookCustomColumnRows, { onConflict: 'id' })
        if (result.error) {
          console.error('[SYNC] gradebook_custom_columns upsert ERROR', {
            message: result.error.message,
            code: result.error.code,
            details: result.error.details,
            hint: result.error.hint
          })
          throw new Error(result.error.message)
        }
        console.log(`[SYNC] gradebook_custom_columns upsert OK count=${gradebookCustomColumnRows.length}`)
      }

      // ── gradebook_custom_scores ───────────────────────────────
      const incomingScores = gradebookCustomScores.filter(
        (s) =>
          s?.id &&
          (s?.classroomId || s?.classroom_id) &&
          (s?.columnId || s?.column_id) &&
          (s?.studentId || s?.student_id)
      )
      console.log(`[SYNC] gradebook_custom_scores incoming=${incomingScores.length}`, {
        owner: user.id,
        items: incomingScores.map((s) => ({
          id: s.id,
          columnId: s.columnId ?? s.column_id,
          studentId: s.studentId ?? s.student_id,
          score: s.score,
          updatedAt: s.updatedAt ?? s.updated_at ?? null
        }))
      })

      const gradebookCustomScoreRows = await buildUpsertRows(
        'gradebook_custom_scores',
        incomingScores,
        (s) => {
          const parsedScore =
            s.score === null || s.score === undefined
              ? null
              : toNumber(s.score) ?? null
          return compactObject({
            id: s.id,
            classroom_id: s.classroomId ?? s.classroom_id,
            column_id: s.columnId ?? s.column_id,
            student_id: s.studentId ?? s.student_id,
            score: parsedScore,
            owner_id: user.id,
            updated_at: toIsoTimestamp(s.updatedAt ?? s.updated_at) ?? nowIso
          })
        }
      )

      console.log(`[SYNC] gradebook_custom_scores to_upsert=${gradebookCustomScoreRows.length} skipped=${incomingScores.length - gradebookCustomScoreRows.length}`)

      if (gradebookCustomScoreRows.length > 0) {
        const result = await supabaseDb
          .from('gradebook_custom_scores')
          .upsert(gradebookCustomScoreRows, { onConflict: 'id' })
        if (result.error) {
          console.error('[SYNC] gradebook_custom_scores upsert ERROR', {
            message: result.error.message,
            code: result.error.code,
            details: result.error.details,
            hint: result.error.hint
          })
          throw new Error(result.error.message)
        }
        console.log(`[SYNC] gradebook_custom_scores upsert OK count=${gradebookCustomScoreRows.length}`)
      }

      const incomingSubmissions = submissions.filter(
        (s) => s?.id && s?.assignmentId && s?.studentId
      )
      const incomingSubmissionIds = incomingSubmissions.map((s) => s.id)
      const fetchExistingSubmissions = async () => {
        if (incomingSubmissionIds.length === 0) return []
        const rows = []
        for (const chunk of chunkArray(incomingSubmissionIds, IN_CLAUSE_CHUNK_SIZE)) {
          const result = await supabaseDb
            .from('submissions')
            .select('id, status, graded_at, updated_at')
            .eq('owner_id', user.id)
            .in('id', chunk)
          if (result.error) {
            throw new Error(result.error.message)
          }
          rows.push(...(result.data || []))
        }
        return rows
      }
      const [deletedSubmissionSet, existingSubmissionRows] = await Promise.all([
        fetchDeletedSet(supabaseDb, 'submissions', incomingSubmissionIds, user.id),
        fetchExistingSubmissions()
      ])

      const existingSubmissionMap = new Map(
        existingSubmissionRows.map((row) => [row.id, row])
      )

      const submissionRows = []
      let skippedSubmissionDeletedCount = 0
      let skippedSubmissionStaleCount = 0
      for (const s of incomingSubmissions) {
        if (deletedSubmissionSet.has(s.id)) {
          skippedSubmissionDeletedCount += 1
          continue
        }

        const existing = existingSubmissionMap.get(s.id) || null
        const incomingUpdatedAt = toMillis(s.updatedAt ?? s.updated_at)
        const existingUpdatedAt = toMillis(existing?.updated_at)
        const incomingStatus = String(s.status || '').toLowerCase()
        const existingStatus = String(existing?.status || '').toLowerCase()
        const incomingGradedAt = toNumber(s.gradedAt ?? s.graded_at)
        const existingGradedAt = toNumber(existing?.graded_at)
        const incomingLooksGraded =
          incomingStatus === 'graded' || Number.isFinite(incomingGradedAt)
        const existingLooksGraded =
          existingStatus === 'graded' || Number.isFinite(existingGradedAt)

        if (existing) {
          const bothGraded = incomingLooksGraded && existingLooksGraded
          if (bothGraded) {
            if (
              !Number.isFinite(incomingGradedAt) ||
              (Number.isFinite(existingGradedAt) && incomingGradedAt <= existingGradedAt)
            ) {
              skippedSubmissionStaleCount += 1
              console.log(`[sync-stale] skipped submission ${s.id} (bothGraded) incoming=${incomingGradedAt} existing=${existingGradedAt}`)
              continue
            }
          } else if (
            !incomingUpdatedAt ||
            (existingUpdatedAt && incomingUpdatedAt <= existingUpdatedAt)
          ) {
            skippedSubmissionStaleCount += 1
            console.log(`[sync-stale] skipped submission ${s.id} (updatedAt) incoming=${incomingUpdatedAt} existing=${existingUpdatedAt}`)
            continue
          }
        }

        const createdAt = toIsoTimestamp(s.createdAt)
        const normalizedRound = clampInteger(s.round, 0, 9999, 0)
        const imageUrl =
          s.imageUrl || s.image_url || `submissions/${s.id}.webp`
        const thumbUrl =
          s.thumbUrl ||
          s.thumb_url ||
          s.thumbnailUrl ||
          s.thumbnail_url ||
          `submissions/thumbs/${s.id}.webp`

        // sync push 只更新結構性欄位，不碰批改欄位
        // 批改欄位（score, ai_score, score_source, feedback, grading_result, graded_at）
        // 由 save-grading API 專責寫入，避免 sync 覆蓋
        submissionRows.push(
          compactObject({
            id: s.id,
            assignment_id: s.assignmentId,
            student_id: s.studentId,
            // status: 只允許結構性狀態變更，不允許 sync 把 graded 改成 synced
            status: (() => {
              const incoming = s.status ?? undefined
              // 如果 server 上已是 graded，sync 不應降級為 synced
              if (existing && existingStatus === 'graded' && incoming !== 'graded') return undefined
              return incoming
            })(),
            image_url: imageUrl,
            thumb_url: thumbUrl,
            // source whitelist：避免 client 寫入意外值。
            // teacher_student_upload 為 legacy（UnifiedImportPage 舊行為），保留向下相容；
            // 新上傳一律走 teacher_scan / teacher_camera 區分 PDF / 相機。
            source: ALLOWED_SUBMISSION_SOURCES.has(s.source) ? s.source : undefined,
            round: normalizedRound,
            parent_submission_id: s.parentSubmissionId ?? s.parent_submission_id ?? undefined,
            actor_user_id: s.actorUserId ?? s.actor_user_id ?? undefined,
            created_at: createdAt ?? undefined,
            // 不寫入: score, ai_score, score_source, feedback, grading_result, graded_at
            correction_count: toNumber(s.correctionCount) ?? undefined,
            owner_id: user.id,
            updated_at: nowIso
          })
        )
      }

      // 防 silent data loss：upsert 前驗證 NEW row 的 image 真的在 storage 裡。
      // 若 handleSubmission upload 失敗但後續 sync 仍 push metadata，DB 會多一筆指向不存在
      // 檔案的 row，導致換裝置/學生看到破圖。新 row 找不到對應 storage 物件 → 整 row 跳過。
      let skippedSubmissionMissingStorageCount = 0
      if (submissionRows.length > 0) {
        const newRowImagePaths = []
        for (const row of submissionRows) {
          if (!existingSubmissionMap.has(row.id) && row.image_url) {
            newRowImagePaths.push(row.image_url)
          }
        }
        if (newRowImagePaths.length > 0) {
          const storageSet = new Set()
          let storageQueryErr = null
          for (const chunk of chunkArray(newRowImagePaths, IN_CLAUSE_CHUNK_SIZE)) {
            const { data: storageRows, error } = await supabaseDb
              .schema('storage')
              .from('objects')
              .select('name')
              .eq('bucket_id', 'homework-images')
              .in('name', chunk)
            if (error) {
              storageQueryErr = error
              break
            }
            for (const r of storageRows || []) storageSet.add(r.name)
          }
          if (storageQueryErr) {
            console.warn('[sync] storage existence check failed (skip drop):', storageQueryErr.message)
          } else {
            for (let i = submissionRows.length - 1; i >= 0; i -= 1) {
              const row = submissionRows[i]
              const isNew = !existingSubmissionMap.has(row.id)
              if (isNew && row.image_url && !storageSet.has(row.image_url)) {
                console.warn(`[sync-no-storage] dropped NEW submission ${row.id} (image ${row.image_url} not in storage; client should retry upload)`)
                submissionRows.splice(i, 1)
                skippedSubmissionMissingStorageCount += 1
              }
            }
          }
        }
      }

      if (incomingSubmissions.length > 0) {
        console.log(
          `📝 [sync] upsert submissions count=${submissionRows.length} (incoming=${incomingSubmissions.length} stale=${skippedSubmissionStaleCount} deleted=${skippedSubmissionDeletedCount} missing-storage=${skippedSubmissionMissingStorageCount})`
        )
      }

      syncTimer('submissions')
      if (submissionRows.length > 0) {
        syncTimer('submissions-upsert')
        const SUBMISSION_BATCH = 30
        for (let i = 0; i < submissionRows.length; i += SUBMISSION_BATCH) {
          const batch = submissionRows.slice(i, i + SUBMISSION_BATCH)
          syncTimer(`sub-batch-${i}`)
          const result = await supabaseDb
            .from('submissions')
            .upsert(batch, { onConflict: 'id' })
          syncTimerEnd(`sub-batch-${i}`)
          if (result.error) throw new Error(result.error.message)
        }
        syncTimerEnd('submissions-upsert')

        syncTimer('submissions-transitions')
        // grading 資料由 save-grading 寫入，sync push 不再包含 grading_result。
        // 因此改為 upsert 後從 DB 查出已有 grading_result 的 submissions，
        // 再對尚未建立 state 的記錄觸發 state transitions。
        {
          const submissionIds = submissionRows.map(r => r.id).filter(Boolean)
          let dbGradedRows = []
          if (submissionIds.length > 0) {
            try {
              for (const chunk of chunkArray(submissionIds, IN_CLAUSE_CHUNK_SIZE)) {
                const { data } = await supabaseDb
                  .from('submissions')
                  .select('id, assignment_id, student_id, status, graded_at, grading_result, source')
                  .eq('owner_id', user.id)
                  .in('id', chunk)
                  .not('grading_result', 'is', null)
                if (data) dbGradedRows.push(...data)
              }
            } catch { /* non-fatal */ }
          }
          // 也包含 student_correction 來源（不管是否已有 grading_result）
          const correctionRows = submissionRows.filter(
            (row) => row.source === 'student_correction' && !dbGradedRows.some(g => g.id === row.id)
          )
          // 為 correction rows 補充 DB 資料（可能缺少 assignment_id 等）
          let correctionDbRows = []
          if (correctionRows.length > 0) {
            try {
              const correctionIds = correctionRows.map(r => r.id).filter(Boolean)
              for (const chunk of chunkArray(correctionIds, IN_CLAUSE_CHUNK_SIZE)) {
                const { data } = await supabaseDb
                  .from('submissions')
                  .select('id, assignment_id, student_id, status, graded_at, grading_result, source')
                  .eq('owner_id', user.id)
                  .in('id', chunk)
                if (data) correctionDbRows.push(...data)
              }
            } catch { /* non-fatal */ }
          }
          const stateTransitionRows = [...dbGradedRows, ...correctionDbRows]
          console.log(`⏱️ [sync] stateTransitionRows: ${stateTransitionRows.length}/${submissionRows.length} (dbGraded=${dbGradedRows.length}, correction=${correctionDbRows.length})`)
          if (stateTransitionRows.length > 0) {
            await applySubmissionStateTransitions(supabaseDb, user.id, stateTransitionRows).catch(
              (err) => console.warn('[sync] applySubmissionStateTransitions failed (non-fatal):', err?.message)
            )
          }
        }
        syncTimerEnd('submissions-transitions')
      }

      syncTimerEnd('submissions')

      // sync push 不再包含 grading_result，改為檢查 status 或直接查 DB
      const touchedAssignments = new Set(
        submissionRows
          .filter((row) => row.assignment_id)
          .filter((row) => row.status === 'graded')
          .map((row) => row.assignment_id)
      )

      // 標籤系統已停用 — 不再觸發 tag state 更新
      // if (touchedAssignments.size > 0) {
      //   await touchAssignmentTagStates(
      //     supabaseDb,
      //     user.id,
      //     Array.from(touchedAssignments)
      //   )
      // }

      const folderRows = await buildUpsertRows(
        'folders',
        folders.filter((f) => f?.id),
        (f) =>
          compactObject({
            id: f.id,
            name: f.name,
            type: f.type,
            classroom_id: f.classroomId ?? f.classroom_id ?? undefined,
            owner_id: user.id,
            updated_at: toIsoTimestamp(f.updatedAt ?? f.updated_at) ?? nowIso
          })
      )

      if (folderRows.length > 0) {
        let result = await supabaseDb
          .from('folders')
          .upsert(folderRows, { onConflict: 'id' })
        if (
          result.error &&
          typeof result.error.message === 'string' &&
          result.error.message.includes('classroom_id')
        ) {
          const legacyRows = folderRows.map(({ classroom_id, ...rest }) => rest)
          result = await supabaseDb
            .from('folders')
            .upsert(legacyRows, { onConflict: 'id' })
        }
        if (result.error) throw new Error(result.error.message)
      }

      // 資料夾協調：用戶端為真（client is truth）
      // 刪除雲端存在但用戶端未傳入的資料夾（代表用戶已刪除）
      const clientFolderIds = new Set(folders.filter((f) => f?.id).map((f) => f.id))
      const { data: serverFolders, error: serverFoldersError } = await supabaseDb
        .from('folders')
        .select('id')
        .eq('owner_id', user.id)
      if (serverFoldersError) throw new Error(serverFoldersError.message)

      const staleFolderIds = (serverFolders || [])
        .map((r) => r.id)
        .filter((id) => !clientFolderIds.has(id))

      if (staleFolderIds.length > 0) {
        console.warn(`[sync POST] 清除 ${staleFolderIds.length} 筆用戶已刪除的 folders:`, staleFolderIds)
        const { error: deleteError } = await supabaseDb
          .from('folders')
          .delete()
          .in('id', staleFolderIds)
          .eq('owner_id', user.id)
        if (deleteError) throw new Error(deleteError.message)
      }

      console.log('[SYNC] POST complete OK', {
        owner: user.id,
        classrooms: classrooms.length,
        students: students.length,
        assignments: assignments.length,
        submissions: submissions.length,
        folders: folders.length,
        customColumns: gradebookCustomColumns.length,
        customScores: gradebookCustomScores.length
      })
      res.status(200).json({ success: true })
    } catch (err) {
      console.error('[SYNC] POST error', {
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      })
      res.status(500).json({
        error: err instanceof Error ? err.message : '同步失敗'
      })
    }
    return
  }

  res.status(405).json({ error: 'Method Not Allowed' })
}

async function handleSubmission(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const { user, accessToken } = await getAuthUser(req, res)
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    // 後端始終使用 service role key 繞過 RLS
    const supabaseDb = getSupabaseAdmin()

    let body = req.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        res.status(400).json({ error: 'Invalid JSON body' })
        return
      }
    }

    const {
      submissionId,
      assignmentId,
      studentId,
      createdAt,
      imageBase64,
      contentType,
      thumbBase64,
      thumbContentType,
      source: rawSource
    } = body || {}

    if (!submissionId || !assignmentId || !studentId || !createdAt || !imageBase64) {
      res.status(400).json({ error: 'Missing required fields' })
      return
    }

    // 教師端 source：teacher_scan（PDF 匯入）/ teacher_camera（相機拍攝）
    // 用於決定 bbox median 校正策略：只有 teacher_scan 啟用，相機照片各自獨立
    // 舊 client 沒帶 source → fallback 到 teacher_scan 維持向下相容
    const allowedTeacherSources = ['teacher_scan', 'teacher_camera']
    const submissionSource = allowedTeacherSources.includes(rawSource) ? rawSource : 'teacher_scan'

    const tombstoneCheck = await supabaseDb
      .from('deleted_records')
      .select('record_id')
      .eq('owner_id', user.id)
      .eq('table_name', 'submissions')
      .eq('record_id', submissionId)
      .limit(1)

    if (tombstoneCheck.error) {
      res.status(500).json({ error: tombstoneCheck.error.message })
      return
    }

    if (tombstoneCheck.data && tombstoneCheck.data.length > 0) {
      res.status(409).json({ error: '提交已被刪除，請重新建立' })
      return
    }

    const filePath = `submissions/${submissionId}.webp`
    const buffer = Buffer.from(String(imageBase64), 'base64')

    console.log('📤 [上傳] 開始上傳檔案:', {
      submissionId,
      assignmentId,
      studentId,
      filePath,
      fileSize: `${(buffer.length / 1024).toFixed(2)} KB`
    })

    const { error: uploadError } = await supabaseDb.storage
      .from('homework-images')
      .upload(filePath, buffer, {
        contentType: contentType || 'image/webp',
        upsert: true
      })

    if (uploadError) {
      console.error('❌ [上傳] 檔案上傳失敗:', uploadError.message)
      res.status(500).json({ error: `圖片上傳失敗: ${uploadError.message}` })
      return
    }

    console.log('✅ [上傳] 檔案上傳成功:', filePath)

    let thumbFilePath = null
    if (thumbBase64) {
      const candidateThumbPath = `submissions/thumbs/${submissionId}.webp`
      try {
        const thumbBuffer = Buffer.from(String(thumbBase64), 'base64')
        const { error: thumbUploadError } = await supabaseDb.storage
          .from('homework-images')
          .upload(candidateThumbPath, thumbBuffer, {
            contentType: thumbContentType || 'image/webp',
            upsert: true
          })

        if (thumbUploadError) {
          console.warn('⚠️ [縮圖] 上傳失敗，略過縮圖:', thumbUploadError.message)
        } else {
          thumbFilePath = candidateThumbPath
          console.log('✅ [縮圖] 上傳成功:', thumbFilePath)
        }
      } catch (err) {
        console.warn('⚠️ [縮圖] 上傳異常，略過縮圖:', err)
      }
    }

    const createdTime =
      typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)
    if (!Number.isFinite(createdTime)) {
      res.status(400).json({ error: 'Invalid createdAt' })
      return
    }

    const timestamp = new Date(createdTime).toISOString()

    // 先檢查是否有相同作業+學生的舊 submission
    const existingCheck = await supabaseDb
      .from('submissions')
      .select('id')
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .eq('owner_id', user.id)
      .limit(1)

    // 如果存在且 ID 不同，先刪除舊的
    if (existingCheck.data && existingCheck.data.length > 0) {
      const oldId = existingCheck.data[0].id
      if (oldId !== submissionId) {
        console.log('🗑️ [覆蓋] 發現舊作業，準備刪除:', {
          oldId,
          newId: submissionId,
          assignmentId,
          studentId
        })

        // 建立 tombstone 記錄
        await supabaseDb.from('deleted_records').upsert({
          owner_id: user.id,
          table_name: 'submissions',
          record_id: oldId,
          deleted_at: new Date().toISOString()
        }, {
          onConflict: 'owner_id,table_name,record_id'
        })

        // 刪除舊的 submission
        await supabaseDb
          .from('submissions')
          .delete()
          .eq('id', oldId)
          .eq('owner_id', user.id)

        console.log('✅ [覆蓋] 已刪除舊作業資料庫記錄:', oldId)

        // 刪除舊的雲端檔案
        try {
          await supabaseDb.storage
            .from('homework-images')
            .remove([`submissions/${oldId}.webp`, `submissions/thumbs/${oldId}.webp`])
          console.log('✅ [覆蓋] 已刪除舊作業雲端檔案:', {
            original: `submissions/${oldId}.webp`,
            thumb: `submissions/thumbs/${oldId}.webp`
          })
        } catch (err) {
          console.warn('⚠️ [覆蓋] 刪除舊檔案失敗:', err)
        }
      }
    }

    // 冪等性保護：若相同 submissionId 已存在（例如 client 重試但上次回應遺失），直接回傳成功
    const { data: existingById } = await supabaseDb
      .from('submissions')
      .select('id, status')
      .eq('id', submissionId)
      .eq('owner_id', user.id)
      .limit(1)

    if (existingById && existingById.length > 0) {
      console.log('ℹ️ [資料庫] submission 已存在，跳過重複寫入:', submissionId)
      res.status(200).json({ success: true, imageUrl: filePath })
      return
    }

    // 插入新的 submission（使用 insert 而非 upsert，避免蓋掉已批改的記錄）
    console.log('💾 [資料庫] 開始插入新 submission:', {
      id: submissionId,
      assignmentId,
      studentId,
      imageUrl: filePath,
      status: 'synced'
    })

    const { error: dbError } = await supabaseDb
      .from('submissions')
      .insert(
        compactObject({
          id: submissionId,
          assignment_id: assignmentId,
          student_id: studentId,
          image_url: filePath,
          thumb_url: thumbFilePath ?? undefined,
          status: 'synced',
          source: submissionSource,
          round: 0,
          actor_user_id: user.id,
          created_at: timestamp,
          owner_id: user.id
        })
      )

    if (dbError) {
      console.error('❌ [資料庫] 寫入失敗:', dbError.message)
      res.status(500).json({ error: `資料庫寫入失敗: ${dbError.message}` })
      return
    }

    const preferences = await getTeacherPreferences(supabaseDb, user.id)
    await upsertAssignmentStudentState(
      supabaseDb,
      user.id,
      assignmentId,
      studentId,
      {
        status: 'uploaded',
        current_submission_id: submissionId,
        upload_locked: false,
        correction_attempt_limit: preferences.max_correction_attempts
      }
    )

    console.log('✅ [資料庫] 新 submission 寫入成功')
    console.log('🎉 [完成] PDF 上傳流程完成:', {
      submissionId,
      imageUrl: filePath,
      status: 'synced'
    })

    res.status(200).json({ success: true, imageUrl: filePath })
  } catch (err) {
    console.error('❌ [submission] 上傳失敗:', err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : '')
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
  }
}

function normalizeBase64Input(rawValue) {
  if (typeof rawValue !== 'string') return null
  const trimmed = rawValue.trim()
  if (!trimmed) return null
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.startsWith('data:') && commaIndex > -1) {
    return trimmed.slice(commaIndex + 1)
  }
  return trimmed
}

function generateSubmissionId() {
  const random = Math.random().toString(36).slice(2, 10)
  return `sub_${Date.now()}_${random}`
}

async function uploadSubmissionAssets(
  supabaseDb,
  submissionId,
  imageBase64,
  contentType,
  thumbBase64,
  thumbContentType
) {
  const normalizedImage = normalizeBase64Input(imageBase64)
  if (!normalizedImage) {
    throw new Error('Missing image payload')
  }

  const filePath = `submissions/${submissionId}.webp`
  const buffer = Buffer.from(normalizedImage, 'base64')
  const { error: uploadError } = await supabaseDb.storage
    .from('homework-images')
    .upload(filePath, buffer, {
      contentType: contentType || 'image/webp',
      upsert: true
    })

  if (uploadError) {
    throw new Error(`圖片上傳失敗: ${uploadError.message}`)
  }

  let thumbFilePath = null
  const normalizedThumb = normalizeBase64Input(thumbBase64)
  if (normalizedThumb) {
    const candidateThumbPath = `submissions/thumbs/${submissionId}.webp`
    const thumbBuffer = Buffer.from(normalizedThumb, 'base64')
    const { error: thumbError } = await supabaseDb.storage
      .from('homework-images')
      .upload(candidateThumbPath, thumbBuffer, {
        contentType: thumbContentType || 'image/webp',
        upsert: true
      })
    if (!thumbError) {
      thumbFilePath = candidateThumbPath
    }
  }

  return { filePath, thumbFilePath }
}

async function deleteSubmissionAssets(supabaseDb, submissionId) {
  await supabaseDb.storage
    .from('homework-images')
    .remove([
      `submissions/${submissionId}.webp`,
      `submissions/thumbs/${submissionId}.webp`
    ])
}

async function handleTeacherPreferences(req, res) {
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const supabaseDb = getSupabaseAdmin()

  if (req.method === 'GET') {
    try {
      const preferences = await getTeacherPreferences(supabaseDb, user.id)
      res.status(200).json({ preferences })
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '讀取偏好設定失敗'
      })
    }
    return
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  try {
    const current = await getTeacherPreferences(supabaseDb, user.id)
    const updates = compactObject({
      student_portal_enabled:
        typeof body.studentPortalEnabled === 'boolean'
          ? body.studentPortalEnabled
          : undefined,
      show_score_to_students:
        typeof body.showScoreToStudents === 'boolean'
          ? body.showScoreToStudents
          : undefined,
      max_correction_attempts:
        body.maxCorrectionAttempts !== undefined
          ? clampInteger(
              body.maxCorrectionAttempts,
              1,
              10,
              current.max_correction_attempts
            )
          : undefined,
      correction_dispatch_mode:
        ['manual', 'auto'].includes(body.correctionDispatchMode)
          ? body.correctionDispatchMode
          : undefined,
      correction_due_at:
        body.correctionDueAt !== undefined
          ? normalizeDueAt(body.correctionDueAt)
          : undefined,
      student_feedback_visibility:
        ['status_only', 'score_only', 'score_reason', 'full'].includes(
          body.studentFeedbackVisibility
        )
          ? body.studentFeedbackVisibility
          : undefined
    })

    if (Object.keys(updates).length === 0) {
      res.status(200).json({ preferences: current })
      return
    }

    const { error } = await supabaseDb
      .from('teacher_preferences')
      .upsert({
        owner_id: user.id,
        ...updates,
        lock_upload_after_graded: true,
        require_full_page_count: true
      })

    if (error) {
      throw new Error(error.message)
    }

    const preferences = await getTeacherPreferences(supabaseDb, user.id)
    res.status(200).json({ preferences })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '更新偏好設定失敗'
    })
  }
}

async function handleStudentsBatchUpsert(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  const classroomId =
    typeof body.classroomId === 'string' ? body.classroomId.trim() : ''
  const students = Array.isArray(body.students) ? body.students : []
  if (!classroomId) {
    res.status(400).json({ error: 'Missing classroomId' })
    return
  }

  if (!students.length) {
    res.status(400).json({ error: 'students cannot be empty' })
    return
  }

  const normalizedStudents = []
  for (const item of students) {
    if (!item || typeof item !== 'object') continue
    const seatNumber = clampInteger(item.seatNumber ?? item.seat_number, 1, 999, 0)
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const email =
      typeof item.email === 'string' && item.email.trim()
        ? item.email.trim().toLowerCase()
        : null
    if (!seatNumber || !name) continue
    normalizedStudents.push(
      compactObject({
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined,
        seat_number: seatNumber,
        name,
        email: email ?? undefined
      })
    )
  }

  if (!normalizedStudents.length) {
    res.status(400).json({ error: 'No valid student rows' })
    return
  }

  const supabaseDb = getSupabaseAdmin()

  try {
    const { data, error } = await supabaseDb.rpc('upsert_students_batch', {
      p_owner_id: user.id,
      p_classroom_id: classroomId,
      p_students: normalizedStudents
    })

    if (error) {
      throw new Error(error.message)
    }

    res.status(200).json({
      success: true,
      total: normalizedStudents.length,
      rows: data || []
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '批次匯入學生失敗'
    })
  }
}

async function handleStudentOverview(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const supabaseDb = getSupabaseAdmin()
  try {
    const studentContexts = await resolveStudentContextsByAuthUser(
      supabaseDb,
      user.id,
      user.email
    )
    if (!studentContexts.length) {
      res.status(403).json({ error: 'Student account is not linked' })
      return
    }


    const ownerIds = [...new Set(studentContexts.map((context) => context.ownerId))]
    const classroomIds = [...new Set(studentContexts.map((context) => context.classroomId))]
    const [classroomsResult, teacherProfilesResult] = await Promise.all([
      ownerIds.length && classroomIds.length
        ? supabaseDb
            .from('classrooms')
            .select('id, owner_id, name')
            .in('owner_id', ownerIds)
            .in('id', classroomIds)
        : Promise.resolve({ data: [], error: null }),
      ownerIds.length
        ? supabaseDb.from('profiles').select('id, name').in('id', ownerIds)
        : Promise.resolve({ data: [], error: null })
    ])
    if (classroomsResult.error) throw new Error(classroomsResult.error.message)
    if (teacherProfilesResult.error) throw new Error(teacherProfilesResult.error.message)

    const classroomNameMap = new Map(
      (classroomsResult.data || []).map((row) => [`${row.owner_id}::${row.id}`, row.name])
    )
    const teacherNameMap = new Map(
      (teacherProfilesResult.data || []).map((row) => [row.id, row.name || ''])
    )

    const classroomOptions = studentContexts
      .map((context) => ({
        key: buildStudentClassroomKey(context),
        ownerId: context.ownerId,
        classroomId: context.classroomId,
        classroomName:
          classroomNameMap.get(`${context.ownerId}::${context.classroomId}`) ||
          `班級 ${context.classroomId}`,
        teacherName: teacherNameMap.get(context.ownerId) || undefined,
        studentId: context.id,
        studentName: context.name,
        seatNumber: context.seatNumber
      }))
      .sort((a, b) =>
        `${a.teacherName || ''}${a.classroomName}${a.seatNumber}`.localeCompare(
          `${b.teacherName || ''}${b.classroomName}${b.seatNumber}`,
          'zh-Hant'
        )
      )

    const primaryClassroom = classroomOptions[0]
    const primaryStudentContext = studentContexts.find(
      (c) => c.ownerId === primaryClassroom.ownerId && c.classroomId === primaryClassroom.classroomId
    ) || studentContexts[0]

    // 對每個 classroomOption 平行查詢（preferences 和 assignments 同步並行）
    // primaryPreferences 和整個 classroom loop 也並行執行
    const [allAssignmentItemsNested, primaryPreferences] = await Promise.all([
      Promise.all(
        classroomOptions.map(async (classroom) => {
        const { ownerId: cOwnerId, classroomId, studentId, key: classroomKey, classroomName } = classroom

        const [preferences, assignmentsResult] = await Promise.all([
          getTeacherPreferences(supabaseDb, cOwnerId),
          supabaseDb
            .from('assignments')
            .select('id, title, total_pages, student_show_score, student_upload_enabled, answer_key_template_id, updated_at')
            .eq('owner_id', cOwnerId)
            .eq('classroom_id', classroomId)
            .order('created_at', { ascending: false })
        ])
        if (assignmentsResult.error) throw new Error(assignmentsResult.error.message)

        const aIds = (assignmentsResult.data || []).map((a) => a.id)

        // 查答案卷模板的 pageOrientations
        const templateIds = [...new Set((assignmentsResult.data || []).map(a => a.answer_key_template_id).filter(Boolean))]
        const templateOrientationsMap = new Map()
        if (templateIds.length > 0) {
          const { data: tplRows } = await supabaseDb
            .from('answer_key_templates')
            .select('id, page_orientations')
            .in('id', templateIds)
          for (const row of tplRows || []) {
            if (row.page_orientations) templateOrientationsMap.set(row.id, row.page_orientations)
          }
        }

        const [statesResult, submissionsResult, correctionItemsResult, globalQueueResult] = await Promise.all([
          aIds.length
            ? supabaseDb
                .from('assignment_student_state')
                .select(
                  'assignment_id, status, upload_locked, graded_once, correction_attempt_count, correction_attempt_limit, last_status_reason, current_submission_id, last_graded_submission_id, updated_at'
                )
                .eq('owner_id', cOwnerId)
                .eq('student_id', studentId)
                .in('assignment_id', aIds)
            : Promise.resolve({ data: [], error: null }),
          aIds.length
            ? supabaseDb
                .from('submissions')
                // 2026-05-25: grading_result 拔掉、改用下方 fallback lazy pull
                // 大多數情況 openCorrections（correction_question_items）有資料、不需 grading_result
                // 真有 fallback 需求才針對特定 submission id 補拉、avoid pulling JSONB for all subs
                .select('id, assignment_id, score, graded_at, created_at, updated_at, source, image_url, status')
                .eq('owner_id', cOwnerId)
                .eq('student_id', studentId)
                .in('assignment_id', aIds)
            : Promise.resolve({ data: [], error: null }),
          aIds.length
            ? supabaseDb
                .from('correction_question_items')
                .select(
                  'assignment_id, attempt_no, question_id, question_text, mistake_reason, hint_text, accessor_result, status, dispute_note, dispute_rejected_at, dispute_rejection_note'
                )
                .eq('owner_id', cOwnerId)
                .eq('student_id', studentId)
                .in('status', ['open', 'disputed'])
                .in('assignment_id', aIds)
            : Promise.resolve({ data: [], error: null }),
          // Global queue for this teacher (all students' pending correction submissions)
          supabaseDb
            .from('submissions')
            .select('id, created_at')
            .in('status', ['pending_grading', 'pending_grading_retry', 'grading_in_progress'])
            .eq('owner_id', cOwnerId)
            .eq('source', 'student_correction')
            .order('created_at', { ascending: true })
        ])
        if (statesResult.error) throw new Error(statesResult.error.message)
        if (submissionsResult.error) throw new Error(submissionsResult.error.message)
        if (correctionItemsResult.error) throw new Error(correctionItemsResult.error.message)
        const globalQueue = globalQueueResult?.data || []

        const stateMap = new Map(
          (statesResult.data || []).map((row) => [row.assignment_id, row])
        )
        const submissionsByAssignment = new Map()
        for (const row of submissionsResult.data || []) {
          const existing = submissionsByAssignment.get(row.assignment_id) || []
          existing.push(row)
          submissionsByAssignment.set(row.assignment_id, existing)
        }
        const openCorrectionsByAssignment = new Map()
        for (const row of correctionItemsResult.data || []) {
          const existing = openCorrectionsByAssignment.get(row.assignment_id) || []
          const accessor = row.accessor_result && typeof row.accessor_result === 'object'
            ? row.accessor_result
            : null
          const accessorSourceImageUrl =
            typeof accessor?.source_image_url === 'string' ? accessor.source_image_url : undefined
          const accessorCropImageUrl =
            typeof accessor?.crop_image_url === 'string' ? accessor.crop_image_url : undefined
          const accessorSourceSubmissionId =
            typeof accessor?.source_submission_id === 'string' ? accessor.source_submission_id : undefined
          const resolvedSourceSubmissionId =
            accessorSourceSubmissionId || extractSubmissionIdFromImagePath(accessorSourceImageUrl)
          existing.push(
            compactObject({
              attemptNo: row.attempt_no,
              questionId: row.question_id,
              questionText: row.question_text ?? undefined,
              mistakeReason: String(row.mistake_reason ?? ''),
              hintText: String(row.hint_text ?? row.mistake_reason ?? ''),
              sourceSubmissionId: resolvedSourceSubmissionId || undefined,
              sourceImageUrl: accessorSourceImageUrl,
              cropImageUrl: accessorCropImageUrl,
              questionBbox: normalizeBbox(accessor?.question_bbox),
              answerBbox: normalizeBbox(accessor?.answer_bbox),
              status: row.status,
              disputeNote: row.dispute_note ?? undefined,
              disputeRejectedAt: row.dispute_rejected_at ?? undefined,
              disputeRejectionNote: row.dispute_rejection_note ?? undefined
            })
          )
          openCorrectionsByAssignment.set(row.assignment_id, existing)
        }

        // 2026-05-25: 第二段 lazy pull grading_result —— 只針對需要 fallback 的 submission id
        // 條件：assignment 處於 correction 狀態 + correction_question_items 沒料 + 有 latestGraded
        // 大多數情況不會 trigger，省下對所有 submissions 的 JSONB 拉取
        const fallbackSubIds = []
        for (const assignment of assignmentsResult.data || []) {
          const state = stateMap.get(assignment.id)
          const status = state?.status ?? 'not_uploaded'
          if (!['correction_required', 'correction_in_progress', 'correction_pending_review'].includes(status)) continue
          if ((openCorrectionsByAssignment.get(assignment.id) ?? []).length > 0) continue
          const subs = submissionsByAssignment.get(assignment.id) || []
          const latestGraded = subs
            .filter((row) => row.graded_at !== null && row.graded_at !== undefined)
            .sort((a, b) => (toNumber(b.graded_at) ?? 0) - (toNumber(a.graded_at) ?? 0))[0]
          if (latestGraded?.id) fallbackSubIds.push(latestGraded.id)
        }
        const fallbackGradingResultMap = new Map()
        if (fallbackSubIds.length > 0) {
          const { data: fbRows } = await supabaseDb
            .from('submissions')
            .select('id, grading_result')
            .in('id', fallbackSubIds)
            .eq('owner_id', cOwnerId)
          for (const row of fbRows || []) {
            if (row.grading_result) fallbackGradingResultMap.set(row.id, row.grading_result)
          }
        }

        return (assignmentsResult.data || []).map((assignment) => {
          const state = stateMap.get(assignment.id)
          const submissions = submissionsByAssignment.get(assignment.id) || []
          const latestSubmission = submissions
            .slice()
            .sort((a, b) => {
              const timeA = toMillis(a.updated_at) ?? toMillis(a.created_at) ?? 0
              const timeB = toMillis(b.updated_at) ?? toMillis(b.created_at) ?? 0
              return timeB - timeA
            })[0]
          const latestGradedSubmission = submissions
            .filter((row) => row.graded_at !== null && row.graded_at !== undefined)
            .sort((a, b) => (toNumber(b.graded_at) ?? 0) - (toNumber(a.graded_at) ?? 0))[0]

          const showScore =
            typeof assignment.student_show_score === 'boolean'
              ? assignment.student_show_score
              : preferences.show_score_to_students
          const rawStatus = state?.status ?? 'not_uploaded'
          const isCorrectionStatus = ['correction_required', 'correction_in_progress', 'correction_pending_review'].includes(rawStatus)
          const effectiveUploadLocked =
            Boolean(state?.upload_locked) || String(state?.status || '') === 'uploaded'
          const canUpload = preferences.student_portal_enabled && !effectiveUploadLocked
          const correctionAttemptCount = state?.correction_attempt_count ?? 0
          const openCorrections = openCorrectionsByAssignment.get(assignment.id) ?? []
          // 2026-05-25: grading_result 不再在 submissionsResult、改從 fallbackGradingResultMap 取
          const fallbackGradingResult = latestGradedSubmission?.id
            ? fallbackGradingResultMap.get(latestGradedSubmission.id)
            : null
          const fallbackCorrections =
            openCorrections.length === 0 && isCorrectionStatus && fallbackGradingResult
              ? parseMistakesFromGradingResult(fallbackGradingResult).map((mistake) =>
                  compactObject({
                    attemptNo: correctionAttemptCount,
                    questionId: mistake.questionId,
                    questionText: mistake.questionText,
                    mistakeReason: String(mistake.reason || ''),
                    hintText: String(mistake.hintText || mistake.reason || ''),
                    sourceSubmissionId:
                      latestGradedSubmission.id ||
                      extractSubmissionIdFromImagePath(latestGradedSubmission.image_url),
                    sourceImageUrl:
                      typeof latestGradedSubmission.image_url === 'string'
                        ? latestGradedSubmission.image_url
                        : undefined,
                    questionBbox: normalizeBbox(mistake.questionBbox),
                    answerBbox: normalizeBbox(mistake.answerBbox),
                    status: 'open'
                  })
                )
              : []
          const mergedCorrections =
            openCorrections.length > 0 ? openCorrections : fallbackCorrections
          // Status always follows assignment_student_state — teacher dispatch is the sole
          // trigger for correction visibility. Never force correction_required from mistakes alone.
          const status = rawStatus
          const visibility = preferences.student_feedback_visibility || 'score_reason'
          const visibleScore = visibility === 'status_only' ? false : showScore
          const visibleCorrections =
            visibility === 'status_only' || visibility === 'score_only' ? [] : mergedCorrections

          // Queue position for pending correction grading
          const pendingGradingSubmission = submissions.find((s) =>
            ['pending_grading', 'pending_grading_retry', 'grading_in_progress'].includes(String(s.status || '')) &&
            s.source === 'student_correction'
          )
          let gradingPending = false
          let gradingQueuePosition
          if (pendingGradingSubmission) {
            gradingPending = true
            const myIndex = globalQueue.findIndex((q) => q.id === pendingGradingSubmission.id)
            gradingQueuePosition = myIndex >= 0 ? myIndex + 1 : globalQueue.length
          }

          // Only report gradingFailed if the LATEST correction submission failed —
          // older grading_failed records from previous rounds should not resurface.
          const correctionSubmissions = submissions.filter((s) => s.source === 'student_correction')
          const latestCorrectionSub = correctionSubmissions.reduce((latest, s) => {
            if (!latest) return s
            return (Date.parse(s.created_at) || 0) > (Date.parse(latest.created_at) || 0) ? s : latest
          }, null)
          const gradingFailed = (!gradingPending && latestCorrectionSub?.status === 'grading_failed') || undefined

          // 防呆：以 template.page_orientations.length 為主，assignment.total_pages 退為 fallback。
          // 老師編輯模板縮頁但 assignment.total_pages 沒同步時（舊 sync push 不會更新），
          // 至少前端讀到的張數會跟模板一致，避免要求學生多拍頁。
          const tplOrientations = templateOrientationsMap.get(assignment.answer_key_template_id)
          const tplPagesFromOrientations = Array.isArray(tplOrientations) ? tplOrientations.length : 0
          const effectiveTotalPages =
            tplPagesFromOrientations > 0 ? tplPagesFromOrientations : assignment.total_pages

          return compactObject({
            id: assignment.id,
            classroomName,
            classroomKey,
            title: assignment.title,
            totalPages: effectiveTotalPages,
            studentUploadEnabled: assignment.student_upload_enabled ?? true,
            pageOrientations: tplOrientations || undefined,
            status,
            gradingPending: gradingPending || undefined,
            gradingQueuePosition: gradingPending ? gradingQueuePosition : undefined,
            gradingFailed,
            canUpload,
            uploadLocked: effectiveUploadLocked,
            uploadLockedReason:
              effectiveUploadLocked ? state?.last_status_reason ?? undefined : undefined,
            gradedOnce: Boolean(state?.graded_once),
            correctionAttemptCount,
            correctionAttemptLimit:
              state?.correction_attempt_limit ?? preferences.max_correction_attempts,
            hasSubmission: Boolean(latestSubmission?.id),
            latestSubmissionId: latestSubmission?.id ?? undefined,
            latestSubmissionSource: latestSubmission?.source ?? undefined,
            openCorrections: visibleCorrections,
            showScore: visibleScore,
            score:
              visibleScore && latestGradedSubmission
                ? toNumber(latestGradedSubmission.score)
                : undefined,
            updatedAt: toMillis(assignment.updated_at) ?? undefined
          })
        })
      })
    ),
      getTeacherPreferences(supabaseDb, primaryClassroom.ownerId)
    ])

    const assignmentItems = allAssignmentItemsNested
      .flat()
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

    res.status(200).json({
      classrooms: classroomOptions,
      activeClassroomKey: primaryClassroom.key,
      student: {
        id: primaryStudentContext.id,
        name: primaryStudentContext.name,
        seatNumber: primaryStudentContext.seatNumber,
        classroomId: primaryStudentContext.classroomId,
        ownerId: primaryClassroom.ownerId
      },
      preferences: {
        studentPortalEnabled: primaryPreferences.student_portal_enabled,
        showScoreToStudents: primaryPreferences.show_score_to_students,
        maxCorrectionAttempts: primaryPreferences.max_correction_attempts,
        lockUploadAfterGraded: primaryPreferences.lock_upload_after_graded,
        requireFullPageCount: primaryPreferences.require_full_page_count
      },
      assignments: assignmentItems
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '載入學生作業概況失敗'
    })
  }
}

async function handleStudentSubmission(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  const assignmentId =
    typeof body.assignmentId === 'string' ? body.assignmentId.trim() : ''
  const classroomKey =
    typeof body.classroomKey === 'string' ? body.classroomKey.trim() : ''
  const mode = body.mode === 'correction' ? 'correction' : 'upload'
  const imageBase64 = body.imageBase64
  const normalizedImagePayload = normalizeBase64Input(imageBase64)
  const contentType = body.contentType
  const thumbBase64 = body.thumbBase64
  const thumbContentType = body.thumbContentType
  const pageCount = clampInteger(body.pageCount, 1, 20, 1)
  // Per-question correction images: [{questionId, imageBase64, contentType}]
  const correctionImages = Array.isArray(body.correctionImages) ? body.correctionImages : []
  // Disputed questions: [{questionId, note}] — student believes AI was wrong
  const disputedQuestions = Array.isArray(body.disputedQuestions) ? body.disputedQuestions : []

  if (!assignmentId) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }
  // 2026-05-27: 訂正模式不需要 main image — AI recheck 只看 corrections/<sub>/<qid>.webp、
  // 老師端 GradingPage 也跳過 student_correction submission 顯示。imageBase64 只在 upload
  // 模式必填。
  if (mode === 'upload' && !normalizedImagePayload) {
    res.status(400).json({ error: 'Missing image' })
    return
  }

  const supabaseDb = getSupabaseAdmin()

  // 在 outer scope 宣告、讓 catch 能補救
  let submissionId = null
  let studentContextRef = null
  let assignmentIdRef = null

  // 2026-05-25: 4 個 403 path 都加診斷 log，Vercel 上下次 403 直接看出哪條 + 為什麼
  const authShort = String(user?.id || '').slice(0, 8)
  const emailShort = String(user?.email || '').replace(/(?<=^.{3}).+?(?=@)/, '***')
  const submitDbgPrefix = `[STUDENT-SUBMIT-DBG] auth=${authShort} email=${emailShort} assignmentId=${assignmentId} classroomKey=${classroomKey || 'none'}`

  try {
    const studentContexts = await resolveStudentContextsByAuthUser(
      supabaseDb,
      user.id,
      user.email
    )
    if (!studentContexts.length) {
      console.warn(`${submitDbgPrefix} 403 reason=not_linked (resolveStudentContextsByAuthUser returned 0 rows; both auth_user_id and email lookups empty)`)
      res.status(403).json({ error: 'Student account is not linked' })
      return
    }

    const selectedContextFromKey = classroomKey
      ? studentContexts.find((context) => buildStudentClassroomKey(context) === classroomKey)
      : null
    if (classroomKey && !selectedContextFromKey) {
      const candidateKeys = studentContexts.map((c) => buildStudentClassroomKey(c))
      console.warn(`${submitDbgPrefix} 403 reason=invalid_classroom_context contextCount=${studentContexts.length} candidateKeys=${JSON.stringify(candidateKeys)}`)
      res.status(403).json({ error: 'Invalid classroom context' })
      return
    }

    const ownerIds = [...new Set(studentContexts.map((context) => context.ownerId))]
    const { data: assignment, error: assignmentError } = await supabaseDb
      .from('assignments')
      .select('id, owner_id, classroom_id, total_pages, answer_key, concept_tags, title')
      .eq('id', assignmentId)
      .in('owner_id', ownerIds)
      .maybeSingle()

    if (assignmentError) throw new Error(assignmentError.message)
    if (!assignment) {
      console.warn(`${submitDbgPrefix} 404 reason=assignment_not_found ownerIds=${JSON.stringify(ownerIds)}`)
      res.status(404).json({ error: 'Assignment not found' })
      return
    }

    const studentContext = studentContexts.find((context) => {
      if (selectedContextFromKey && buildStudentClassroomKey(context) !== classroomKey) {
        return false
      }
      return (
        context.ownerId === assignment.owner_id &&
        context.classroomId === assignment.classroom_id
      )
    })

    if (!studentContext) {
      const contextSummary = studentContexts.map((c) => ({ classroomId: c.classroomId, ownerId: c.ownerId.slice(0, 8) }))
      console.warn(`${submitDbgPrefix} 403 reason=forbidden_assignment_access assignment.classroomId=${assignment.classroom_id} assignment.ownerId=${String(assignment.owner_id).slice(0, 8)} hasClassroomKey=${!!classroomKey} contexts=${JSON.stringify(contextSummary)}`)
      res.status(403).json({ error: 'Forbidden assignment access' })
      return
    }

    const ownerId = studentContext.ownerId
    const preferences = await getTeacherPreferences(supabaseDb, ownerId)
    if (!preferences.student_portal_enabled) {
      console.warn(`${submitDbgPrefix} 403 reason=portal_disabled ownerId=${ownerId.slice(0, 8)}`)
      res.status(403).json({ error: 'Student portal is disabled by teacher' })
      return
    }

    if (
      mode === 'upload' &&
      Number.isFinite(assignment.total_pages) &&
      assignment.total_pages > 0 &&
      pageCount !== assignment.total_pages
    ) {
      res.status(400).json({
        error: `需上傳 ${assignment.total_pages} 頁，實際為 ${pageCount} 頁`,
        code: 'PAGE_COUNT_MISMATCH'
      })
      return
    }

    const { data: existingState, error: existingStateError } = await supabaseDb
      .from('assignment_student_state')
      .select('*')
      .eq('owner_id', ownerId)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentContext.id)
      .maybeSingle()

    if (existingStateError) {
      throw new Error(existingStateError.message)
    }

    const currentState = existingState

    if (
      mode === 'upload' &&
      (currentState?.upload_locked || String(currentState?.status || '') === 'uploaded')
    ) {
      res.status(409).json({
        error: currentState.last_status_reason || '目前作業已鎖定，不可再上傳',
        code: 'UPLOAD_LOCKED'
      })
      return
    }

    const correctionLimit = clampInteger(
      currentState?.correction_attempt_limit ?? preferences.max_correction_attempts,
      1,
      10,
      preferences.max_correction_attempts
    )
    const correctionCount = clampInteger(
      currentState?.correction_attempt_count ?? 0,
      0,
      99,
      0
    )

    if (mode === 'correction') {
      const status = String(currentState?.status || '')
      if (status === 'correction_in_progress') {
        res.status(409).json({
          error: 'AI 批改中，請等待結果後再重新送出',
          code: 'GRADING_IN_PROGRESS'
        })
        return
      }
      if (!['correction_required', 'correction_pending_review'].includes(status)) {
        res.status(409).json({
          error: '目前作業未進入可訂正狀態',
          code: 'INVALID_CORRECTION_STATE'
        })
        return
      }
      // Block re-submission if all remaining items are disputed (waiting for teacher review)
      if (status === 'correction_pending_review') {
        const { count: openCount } = await supabaseDb
          .from('correction_question_items')
          .select('id', { count: 'exact', head: true })
          .eq('owner_id', ownerId)
          .eq('assignment_id', assignmentId)
          .eq('student_id', studentContext.id)
          .eq('status', 'open')
        if ((openCount ?? 0) === 0) {
          res.status(409).json({
            error: '所有題目皆在申訴審閱中，請等待老師裁決',
            code: 'ALL_DISPUTED'
          })
          return
        }
      }
      if (correctionCount >= correctionLimit) {
        res.status(409).json({
          error: '已超過可自主訂正次數，請找老師協助',
          code: 'CORRECTION_LIMIT_REACHED'
        })
        return
      }
    }

    submissionId = generateSubmissionId()
    studentContextRef = studentContext
    assignmentIdRef = assignmentId
    // 2026-05-27: 訂正模式不上傳整份作答頁、image_url 留空字串（schema NOT NULL）。
    // AI recheck 只讀 corrections/<sub>/<qid>.webp、UI 也跳過、上傳純粹是 wasted storage。
    let filePath = ''
    let thumbFilePath = null
    if (mode === 'upload') {
      const uploaded = await uploadSubmissionAssets(
        supabaseDb,
        submissionId,
        imageBase64,
        contentType,
        thumbBase64,
        thumbContentType
      )
      filePath = uploaded.filePath
      thumbFilePath = uploaded.thumbFilePath
    }

    // 未批改前可覆蓋舊作業（僅 upload 模式 — 訂正流程不該動原批改 submission）
    // 2026-05-27: 修兩個 bug：
    //   (a) 整段沒 gate mode、訂正模式跑來也會把舊的 graded submission 砍掉、學生卡片
    //       變「尚未繳交 + 待訂正」矛盾狀態。六年4班 U5 5/26 12 位學生中招、其中
    //       李宥均 / 白筱霜 因新 insert 失敗、舊批改紀錄連帶整張作答頁照片全消失。
    //   (b) SELECT 漏 status 欄位、`status === 'graded'` fallback 永遠失效 ——
    //       資料庫裡有 35 筆 graded_at IS NULL 的歷史 graded submission 會被誤判
    //       為「未批改」直接砍掉。
    if (mode === 'upload') {
      const { data: latestSubmissionRows, error: latestSubmissionError } = await supabaseDb
        .from('submissions')
        .select('id, status, graded_at')
        .eq('owner_id', ownerId)
        .eq('assignment_id', assignmentId)
        .eq('student_id', studentContext.id)
        .order('created_at', { ascending: false })
        .limit(1)

      if (latestSubmissionError) {
        throw new Error(latestSubmissionError.message)
      }

      const latestSubmission = latestSubmissionRows?.[0]
      if (latestSubmission?.id && latestSubmission.id !== submissionId) {
        const latestIsGraded = (latestSubmission.graded_at !== null && latestSubmission.graded_at !== undefined) ||
          String(latestSubmission.status || '').toLowerCase() === 'graded'
        if (!latestIsGraded) {
          await supabaseDb
            .from('deleted_records')
            .upsert(
              {
                owner_id: ownerId,
                table_name: 'submissions',
                record_id: latestSubmission.id,
                deleted_at: new Date().toISOString()
              },
              { onConflict: 'owner_id,table_name,record_id' }
            )
          await supabaseDb
            .from('submissions')
            .delete()
            .eq('id', latestSubmission.id)
            .eq('owner_id', ownerId)
          await deleteSubmissionAssets(supabaseDb, latestSubmission.id)
        }
      }
    }

    const round = mode === 'correction' ? correctionCount + 1 : 0
    const source = mode === 'correction' ? 'student_correction' : 'student_upload'

    // Store per-question correction images BEFORE inserting submission,
    // so grading job never sees pending_grading without images already in Storage.
    if (mode === 'correction' && correctionImages.length > 0) {
      // 高併發時限制每次請求的上傳並行度，避免 1 班同時送出時大量平行連線導致逾時
      const uploadConcurrency = 2
      const failedQuestionIds = []
      for (let i = 0; i < correctionImages.length; i += uploadConcurrency) {
        const batch = correctionImages.slice(i, i + uploadConcurrency)
        const results = await Promise.all(
          batch.map(async (img) => {
            const normalized = normalizeBase64Input(img.imageBase64)
            if (!normalized || !img.questionId) return { ok: true }
            const path = `corrections/${submissionId}/${img.questionId}.webp`
            const { error: uploadError } = await supabaseDb.storage
              .from(HOMEWORK_IMAGES_BUCKET)
              .upload(path, Buffer.from(normalized, 'base64'), {
                contentType: img.contentType || 'image/webp',
                upsert: true
              })
            if (uploadError) {
              console.warn('[student-submission] correction image upload failed:', uploadError.message, {
                submissionId,
                questionId: img.questionId
              })
            }
            return { ok: !uploadError, questionId: img.questionId }
          })
        )
        for (const r of results) {
          if (r && r.ok === false && r.questionId) {
            failedQuestionIds.push(r.questionId)
          }
        }
      }
      if (failedQuestionIds.length > 0) {
        const questionList = failedQuestionIds.join('、')
        throw new Error(`第 ${questionList} 題照片上傳失敗，請重新拍攝後再送出`)
      }
    }

    const { error: insertError } = await supabaseDb
      .from('submissions')
      .insert(
        compactObject({
          id: submissionId,
          assignment_id: assignmentId,
          student_id: studentContext.id,
          image_url: filePath,
          thumb_url: thumbFilePath ?? undefined,
          status: mode === 'correction' ? 'pending_grading' : 'synced',
          source,
          round,
          parent_submission_id: currentState?.current_submission_id ?? undefined,
          actor_user_id: user.id,
          owner_id: ownerId
        })
      )

    if (insertError) {
      throw new Error(insertError.message)
    }

    // Write disputed questions as status='disputed' (student believes AI was wrong)
    if (mode === 'correction' && disputedQuestions.length > 0) {
      const disputeRows = disputedQuestions
        .filter((d) => d && typeof d.questionId === 'string' && d.questionId.trim())
        .map((d) => ({
          owner_id: ownerId,
          assignment_id: assignmentId,
          student_id: studentContext.id,
          attempt_no: correctionCount,
          question_id: String(d.questionId).trim(),
          dispute_note: typeof d.note === 'string' && d.note.trim() ? d.note.trim() : null,
          status: 'disputed',
          updated_at: new Date().toISOString()
        }))
      if (disputeRows.length > 0) {
        const { error: disputeError } = await supabaseDb
          .from('correction_question_items')
          .upsert(disputeRows, { onConflict: 'owner_id,assignment_id,student_id,attempt_no,question_id' })
        if (disputeError) throw new Error(`申訴寫入失敗: ${disputeError.message}`)
      }
    }

    await upsertAssignmentStudentState(
      supabaseDb,
      ownerId,
      assignmentId,
      studentContext.id,
      compactObject({
        status: mode === 'correction' ? 'correction_in_progress' : 'uploaded',
        current_submission_id: submissionId,
        correction_attempt_limit: correctionLimit,
        upload_locked: mode === 'upload' ? true : currentState?.upload_locked,
        last_status_reason:
          mode === 'upload'
            ? '作業已送出，等待老師檢查'
            : currentState?.last_status_reason
      })
    )

    let correctionResult = null
    if (mode === 'correction') {
      // ── 同步批改：直接呼叫 AI recheck，不再透過 cron ──
      try {
        // 取得作業資料
        const { data: assignmentData } = await supabaseDb
          .from('assignments')
          .select('id, owner_id, classroom_id, total_pages, answer_key, title')
          .eq('id', assignmentId)
          .maybeSingle()

        if (!assignmentData) {
          throw new Error('找不到作業資料')
        }

        // 取得待訂正的題目
        const { data: openItems } = await supabaseDb
          .from('correction_question_items')
          .select('question_id, question_text, mistake_reason, hint_text')
          .eq('owner_id', ownerId)
          .eq('assignment_id', assignmentId)
          .eq('student_id', studentContext.id)
          .eq('status', 'open')

        if (!openItems?.length) {
          // 全部都是申訴題，沒有 open items → 跳過 AI，直接設為待老師審閱
          await supabaseDb
            .from('submissions')
            .update({ status: 'graded', score: 0, updated_at: new Date().toISOString() })
            .eq('id', submissionId)
          await upsertAssignmentStudentState(
            supabaseDb, ownerId, assignmentId, studentContext.id,
            { status: 'correction_pending_review', last_status_reason: '所有題目已申訴，等待老師審閱' }
          )
          correctionResult = { gradingPending: false, allDisputed: true }
        } else {
          // 確認訂正照片已上傳
          const recheckFolder = await supabaseDb.storage.from(HOMEWORK_IMAGES_BUCKET)
            .list(`corrections/${submissionId}`)
          if (!recheckFolder.data?.length) {
            throw Object.assign(
              new Error('訂正照片未正確上傳，請重新拍攝每題作答後再送出。'),
              { code: 'NO_RECHECK_IMAGES' }
            )
          }

          // 呼叫 AI 批改
          const submissionForRecheck = {
            id: submissionId,
            owner_id: ownerId,
            assignment_id: assignmentId,
            student_id: studentContext.id,
            image_url: filePath,
            source,
            round
          }
          const gradingResult = await runRecheckGrading({
            supabaseDb,
            submission: submissionForRecheck,
            assignment: assignmentData,
            correctionItems: openItems
          })

          const gradedAt = Date.now()
          const totalScore = toNumber(gradingResult?.totalScore) ?? 0
          const feedback =
            Array.isArray(gradingResult?.suggestions) && gradingResult.suggestions.length > 0
              ? String(gradingResult.suggestions[0] || '')
              : undefined

          // 寫入批改結果
          await supabaseDb
            .from('submissions')
            .update(
              compactObject({
                status: 'graded',
                score: totalScore,
                feedback,
                grading_result: gradingResult,
                graded_at: gradedAt,
                updated_at: new Date().toISOString()
              })
            )
            .eq('id', submissionId)
            .eq('owner_id', ownerId)

          // 更新訂正狀態（correction_attempt_count, question_items, logs 等）
          await applySubmissionStateTransitions(supabaseDb, ownerId, [
            {
              id: submissionId,
              assignment_id: assignmentId,
              student_id: studentContext.id,
              status: 'graded',
              source,
              graded_at: gradedAt,
              grading_result: gradingResult,
              image_url: filePath,
              updated_at: new Date().toISOString()
            }
          ])

          const stillWrong = Array.isArray(gradingResult?.mistakes) ? gradingResult.mistakes : []
          correctionResult = {
            gradingPending: false,
            passed: stillWrong.length === 0,
            totalScore,
            wrongCount: stillWrong.length,
            feedback
          }
        }
      } catch (recheckErr) {
        console.error('[STUDENT-CORRECTION] inline recheck failed:', recheckErr?.message)
        // 批改失敗：設為 grading_failed，讓學生可以重試
        await supabaseDb
          .from('submissions')
          .update({ status: 'grading_failed', updated_at: new Date().toISOString() })
          .eq('id', submissionId)
        try {
          await upsertAssignmentStudentState(supabaseDb, ownerId, assignmentId, studentContext.id, {
            status: 'correction_required',
            last_status_reason: recheckErr?.code === 'NO_RECHECK_IMAGES'
              ? recheckErr.message
              : 'AI 批改失敗，請重新送出訂正'
          })
        } catch { /* state update failure is non-fatal */ }
        correctionResult = {
          gradingPending: false,
          gradingFailed: true,
          errorMessage: recheckErr?.code === 'NO_RECHECK_IMAGES'
            ? recheckErr.message
            : '批改失敗，請重新送出訂正'
        }
      }
    }

    res.status(200).json({
      success: true,
      submissionId,
      source,
      round,
      correctionResult,
      classroomKey: buildStudentClassroomKey(studentContext)
    })
  } catch (err) {
    console.error('[STUDENT-SUBMISSION] outer catch:', err?.message, err?.stack?.split('\n').slice(0, 3).join(' | '))
    // 🆕 防孤兒：若 submission 已 insert（submissionId 已產出）、補救 status
    // 避免任何 5xx 留下 pending_grading 卡住的紀錄（2026-05-12 + 5/13 schema bug 都踩過）
    if (submissionId) {
      try {
        await supabaseDb
          .from('submissions')
          .update({ status: 'grading_failed', updated_at: new Date().toISOString() })
          .eq('id', submissionId)
        if (studentContextRef && assignmentIdRef) {
          await upsertAssignmentStudentState(
            supabaseDb, user.id, assignmentIdRef, studentContextRef.id,
            {
              status: 'correction_required',
              last_status_reason: 'AI 批改失敗（系統錯誤、請重新送出）'
            }
          ).catch(() => {})
        }
      } catch (fallbackErr) {
        console.error('[STUDENT-SUBMISSION] outer-catch fallback also failed:', fallbackErr?.message)
        // 落地不了就算了、至少 client 收到 500 error
      }
    }
    res.status(500).json({
      error: err instanceof Error ? err.message : '學生上傳作業失敗'
    })
  }
}

async function handleProcessPendingGrading(req, res) {
  const secret = req.headers['x-cron-secret'] || req.query?.secret
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const supabaseDb = getSupabaseAdmin()

  const { data: pendingRows, error: pendingError } = await supabaseDb
    .from('submissions')
    .select('id, owner_id, assignment_id, student_id, image_url, source, round, status')
    .in('status', ['pending_grading', 'pending_grading_retry'])
    .eq('source', 'student_correction')
    .order('created_at', { ascending: true })
    .limit(10)

  if (pendingError) {
    res.status(500).json({ error: pendingError.message })
    return
  }

  if (!pendingRows?.length) {
    res.status(200).json({ processed: 0, queued: 0 })
    return
  }

  const ids = pendingRows.map((r) => r.id)
  // Remember original status to decide retry vs fail on error
  const originalStatuses = new Map(pendingRows.map((r) => [r.id, r.status]))

  // Atomically mark as grading_in_progress to prevent duplicate processing
  await supabaseDb
    .from('submissions')
    .update({ status: 'grading_in_progress', updated_at: new Date().toISOString() })
    .in('id', ids)
    .in('status', ['pending_grading', 'pending_grading_retry'])

  const uniqueAssignmentIds = [...new Set(pendingRows.map((r) => r.assignment_id))]
  const { data: assignments } = await supabaseDb
    .from('assignments')
    .select('id, owner_id, classroom_id, total_pages, answer_key, title')
    .in('id', uniqueAssignmentIds)
  const assignmentMap = new Map((assignments || []).map((a) => [a.id, a]))

  let processed = 0

  // Simple N=2 concurrency runner
  async function runConcurrent(items, n, fn) {
    let i = 0
    async function worker() {
      while (i < items.length) {
        const item = items[i++]
        await fn(item)
      }
    }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  }

  await runConcurrent(pendingRows, 5, async (submission) => {
    const assignment = assignmentMap.get(submission.assignment_id)
    if (!assignment) {
      const revertStatus = originalStatuses.get(submission.id) === 'pending_grading_retry'
        ? 'grading_failed'
        : 'pending_grading_retry'
      await supabaseDb
        .from('submissions')
        .update({ status: revertStatus, updated_at: new Date().toISOString() })
        .eq('id', submission.id)
      return
    }

    try {
      const { data: imageBlob, error: downloadError } = await supabaseDb.storage
        .from('homework-images')
        .download(submission.image_url)

      if (downloadError || !imageBlob) {
        throw new Error(`Image download failed: ${downloadError?.message || 'empty blob'}`)
      }

      const arrayBuffer = await imageBlob.arrayBuffer()
      const base64 = Buffer.from(arrayBuffer).toString('base64')

      // Use Recheck Agent — correction submissions must provide per-question images
      const { data: openItems } = await supabaseDb
        .from('correction_question_items')
        .select('question_id, question_text, mistake_reason, hint_text')
        .eq('owner_id', submission.owner_id)
        .eq('assignment_id', submission.assignment_id)
        .eq('student_id', submission.student_id)
        .eq('status', 'open')

      // If all remaining questions were disputed (no open items), skip AI recheck and
      // set state to correction_pending_review — no grading failure should occur here.
      if (!openItems?.length) {
        await supabaseDb
          .from('submissions')
          .update({ status: 'graded', score: 0, updated_at: new Date().toISOString() })
          .eq('id', submission.id)
        await upsertAssignmentStudentState(
          supabaseDb, submission.owner_id, submission.assignment_id, submission.student_id,
          { status: 'correction_pending_review', last_status_reason: '所有題目已申訴，等待老師審閱' }
        )
        processed++
        return
      }

      const recheckFolder = await supabaseDb.storage.from(HOMEWORK_IMAGES_BUCKET)
        .list(`corrections/${submission.id}`)
      const hasRecheckImages = recheckFolder.data?.length > 0

      if (!hasRecheckImages) {
        throw Object.assign(new Error('訂正照片未正確上傳，請重新拍攝每題作答後再送出。'), { code: 'NO_RECHECK_IMAGES' })
      }

      const gradingResult = await runRecheckGrading({ supabaseDb, submission, assignment, correctionItems: openItems })

      const gradedAt = Date.now()
      const totalScore = toNumber(gradingResult?.totalScore) ?? 0
      const feedback =
        Array.isArray(gradingResult?.suggestions) && gradingResult.suggestions.length > 0
          ? String(gradingResult.suggestions[0] || '')
          : undefined

      await supabaseDb
        .from('submissions')
        .update(
          compactObject({
            status: 'graded',
            score: totalScore,
            feedback,
            grading_result: gradingResult,
            graded_at: gradedAt,
            updated_at: new Date().toISOString()
          })
        )
        .eq('id', submission.id)
        .eq('owner_id', submission.owner_id)

      await applySubmissionStateTransitions(supabaseDb, submission.owner_id, [
        {
          id: submission.id,
          assignment_id: submission.assignment_id,
          student_id: submission.student_id,
          status: 'graded',
          source: submission.source,
          graded_at: gradedAt,
          grading_result: gradingResult,
          image_url: submission.image_url,
          updated_at: new Date().toISOString()
        }
      ])

      console.log('[PROCESS-GRADING] graded submission', submission.id, 'score:', totalScore)
      processed++
    } catch (err) {
      console.error('[PROCESS-GRADING] Error grading', submission.id, err?.message)
      const isRetry = originalStatuses.get(submission.id) === 'pending_grading_retry'
      const isInvalidUpload = err?.code === 'NO_RECHECK_IMAGES'
      if (isRetry || isInvalidUpload) {
        // Permanent failure: second failure or invalid upload (no recheck images)
        await supabaseDb
          .from('submissions')
          .update({ status: 'grading_failed', updated_at: new Date().toISOString() })
          .eq('id', submission.id)
        // Wrap separately so a state-update failure does not leave assignment stuck at correction_in_progress
        try {
          await upsertAssignmentStudentState(supabaseDb, submission.owner_id, submission.assignment_id, submission.student_id, {
            status: 'correction_required',
            last_status_reason: isInvalidUpload ? err.message : 'AI 批改失敗，請重新送出訂正'
          })
        } catch (stateErr) {
          console.error('[PROCESS-GRADING] Failed to reset assignment state after grading failure', submission.id, stateErr?.message)
        }
      } else {
        // First failure → retry once more next minute
        await supabaseDb
          .from('submissions')
          .update({ status: 'pending_grading_retry', updated_at: new Date().toISOString() })
          .eq('id', submission.id)
      }
    }
  })

  res.status(200).json({ processed, queued: pendingRows.length })
}

async function handleStudentCorrections(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const assignmentId =
    typeof req.query?.assignmentId === 'string'
      ? req.query.assignmentId.trim()
      : ''

  const supabaseDb = getSupabaseAdmin()
  try {
    const studentContexts = await resolveStudentContextsByAuthUser(
      supabaseDb,
      user.id,
      user.email
    )
    if (!studentContexts.length) {
      res.status(403).json({ error: 'Student account is not linked' })
      return
    }

    // 如果有指定 classroomKey，找到對應的 context；否則查詢所有 contexts
    const requestedKey =
      typeof req.query?.classroomKey === 'string'
        ? req.query.classroomKey.trim()
        : ''

    const targetContexts = requestedKey
      ? studentContexts.filter(
          (ctx) => buildStudentClassroomKey(ctx) === requestedKey
        )
      : studentContexts

    if (requestedKey && !targetContexts.length) {
      res.status(403).json({ error: 'Student is not in the specified classroom' })
      return
    }

    // 查詢所有匹配 context 的訂正題目
    const allItems = []
    for (const ctx of targetContexts) {
      let query = supabaseDb
        .from('correction_question_items')
        .select(
          'assignment_id, attempt_no, question_id, question_text, mistake_reason, hint_text, accessor_result, status, dispute_note, dispute_rejected_at, dispute_rejection_note, updated_at'
        )
        .eq('owner_id', ctx.ownerId)
        .eq('student_id', ctx.id)
        .in('status', ['open', 'disputed'])
        .order('attempt_no', { ascending: false })

      if (assignmentId) {
        query = query.eq('assignment_id', assignmentId)
      }

      const { data, error } = await query
      if (error) throw new Error(error.message)

      for (const item of data || []) {
        allItems.push({ ...item, _classroomKey: buildStudentClassroomKey(ctx), _studentId: ctx.id })
      }
    }

    res.status(200).json({
      studentId: targetContexts[0]?.id ?? studentContexts[0].id,
      classroomKey: requestedKey || buildStudentClassroomKey(studentContexts[0]),
      items: allItems.map((item) =>
        {
          const accessor = item.accessor_result && typeof item.accessor_result === 'object'
            ? item.accessor_result
            : null
          const accessorSourceImageUrl =
            typeof accessor?.source_image_url === 'string'
              ? accessor.source_image_url
              : undefined
          const accessorCropImageUrl =
            typeof accessor?.crop_image_url === 'string'
              ? accessor.crop_image_url
              : undefined
          const accessorSourceSubmissionId =
            typeof accessor?.source_submission_id === 'string'
              ? accessor.source_submission_id
              : undefined
          const resolvedSourceSubmissionId =
            accessorSourceSubmissionId || extractSubmissionIdFromImagePath(accessorSourceImageUrl)
          return compactObject({
            assignmentId: item.assignment_id,
            attemptNo: item.attempt_no,
            questionId: item.question_id,
            questionText: item.question_text ?? undefined,
            mistakeReason: String(item.mistake_reason ?? ''),
            hintText: String(item.hint_text ?? item.mistake_reason ?? ''),
            sourceSubmissionId: resolvedSourceSubmissionId || undefined,
            sourceImageUrl: accessorSourceImageUrl,
            cropImageUrl: accessorCropImageUrl,
            questionBbox: normalizeBbox(accessor?.question_bbox),
            answerBbox: normalizeBbox(accessor?.answer_bbox),
            status: item.status,
            disputeNote: item.dispute_note ?? undefined,
            disputeRejectedAt: item.dispute_rejected_at ? toMillis(item.dispute_rejected_at) : undefined,
            disputeRejectionNote: item.dispute_rejection_note ?? undefined,
            updatedAt: toMillis(item.updated_at) ?? undefined,
            classroomKey: item._classroomKey || undefined
          })
        }
      )
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '讀取訂正題目失敗'
    })
  }
}

async function handleReport(req, res) {
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  // 標籤系統已停用，直接回傳空資料
  return res.status(200).json({
    domains: [],
    abilities: [],
    tagAbilityMap: [],
    dictionary: []
  })

  // ─── 以下為標籤系統停用前的原始邏輯（保留以備重啟） ───
  const requestedOwnerId = resolveOwnerIdParam(req)
  const isOwnerOverride =
    requestedOwnerId && requestedOwnerId !== user.id

  // 後端始終使用 service role key 繞過 RLS
  const supabaseAdmin = getSupabaseAdmin()

  let ownerId = user.id
  let supabaseDb = supabaseAdmin

  if (isOwnerOverride) {
    try {
      const adminOverride = await requireAdminOverride(user.id)
      if (!adminOverride) {
        res.status(403).json({ error: 'Forbidden' })
        return
      }
      ownerId = requestedOwnerId
      // supabaseDb 已經是 admin client，無需重新賦值
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '讀取使用者權限失敗'
      })
      return
    }
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const [
      domainResult,
      abilityAggResult,
      abilityDictResult,
      tagMapResult,
      tagDictResult
    ] = await Promise.all([
      supabaseDb
        .from('domain_tag_aggregates')
        .select(
          'domain, tag_label, tag_count, assignment_count, sample_count, generated_at'
        )
        .eq('owner_id', ownerId)
        .order('tag_count', { ascending: false }),
      supabaseDb
        .from('ability_aggregates')
        .select(
          'ability_id, total_count, assignment_count, domain_count, generated_at'
        )
        .eq('owner_id', ownerId)
        .order('total_count', { ascending: false }),
      supabaseDb
        .from('ability_dictionary')
        .select('id, label')
        .eq('owner_id', ownerId)
        .eq('status', 'active'),
      supabaseDb
        .from('tag_ability_map')
        .select('tag_id, ability_id, confidence')
        .eq('owner_id', ownerId),
      supabaseDb
        .from('tag_dictionary')
        .select('id, label, normalized_label, status, merged_to_tag_id')
        .eq('owner_id', ownerId)
    ])

    if (domainResult.error) throw new Error(domainResult.error.message)
    if (abilityAggResult.error) throw new Error(abilityAggResult.error.message)
    if (abilityDictResult.error) throw new Error(abilityDictResult.error.message)
    if (tagMapResult.error) throw new Error(tagMapResult.error.message)
    if (tagDictResult.error) throw new Error(tagDictResult.error.message)

    const dictionaryRows = tagDictResult.data ?? []
    const dictionaryById = new Map(dictionaryRows.map((row) => [row.id, row]))
    const dictionary = dictionaryRows.map((row) => {
      const mergedTarget = row.merged_to_tag_id
        ? dictionaryById.get(row.merged_to_tag_id)
        : null
      return {
        id: row.id,
        label: row.label,
        normalized_label: row.normalized_label,
        status: row.status,
        merged_to_tag_id: row.merged_to_tag_id ?? null,
        merged_to_label: mergedTarget?.label ?? null
      }
    })

    const domainMap = new Map()
    ;(domainResult.data || []).forEach((row) => {
      const domain = row.domain || 'uncategorized'
      if (!domainMap.has(domain)) domainMap.set(domain, [])
      domainMap.get(domain).push({
        label: row.tag_label,
        count: toNumber(row.tag_count) ?? 0,
        assignmentCount: toNumber(row.assignment_count) ?? 0,
        sampleCount: toNumber(row.sample_count) ?? null,
        generatedAt: toIsoTimestamp(row.generated_at)
      })
    })

    const domains = Array.from(domainMap.entries()).map(([domain, tags]) => ({
      domain,
      tags
    }))

    const abilityLabelById = new Map(
      (abilityDictResult.data || []).map((row) => [row.id, row.label])
    )
    const abilities = (abilityAggResult.data || []).map((row) => ({
      id: row.ability_id,
      label: abilityLabelById.get(row.ability_id) || row.ability_id,
      totalCount: toNumber(row.total_count) ?? 0,
      assignmentCount: toNumber(row.assignment_count) ?? 0,
      domainCount: toNumber(row.domain_count) ?? 0,
      generatedAt: toIsoTimestamp(row.generated_at)
    }))

    const tagLabelById = new Map(
      dictionaryRows.map((row) => [row.id, row.label || row.normalized_label])
    )
    const tagAbilityMap = new Map()
    ;(tagMapResult.data || []).forEach((row) => {
      const tagLabel = tagLabelById.get(row.tag_id)
      const abilityLabel = abilityLabelById.get(row.ability_id)
      if (!tagLabel || !abilityLabel) return
      const key = `${tagLabel}::${abilityLabel}`
      if (tagAbilityMap.has(key)) return
      tagAbilityMap.set(key, {
        tag: tagLabel,
        ability: abilityLabel,
        confidence: toNumber(row.confidence)
      })
    })

    res.status(200).json({
      domains,
      abilities,
      tagAbilityMap: Array.from(tagAbilityMap.values()),
      dictionary
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '讀取報告資料失敗'
    })
  }
}

// ============================================================
// Grading Results（批改詳情補抓）
// ============================================================

async function handleGradingResults(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const assignmentId =
    typeof req.query?.assignmentId === 'string' ? req.query.assignmentId.trim() : ''
  if (!assignmentId) {
    res.status(400).json({ error: 'Missing assignmentId' })
    return
  }

  const supabaseDb = getSupabaseAdmin()
  try {
    const { data, error } = await supabaseDb
      .from('submissions')
      .select('id, grading_result')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .eq('status', 'graded')
      .not('grading_result', 'is', null)

    if (error) throw new Error(error.message)

    const result = {}
    for (const row of data || []) {
      if (row.id && row.grading_result) {
        result[row.id] = row.grading_result
      }
    }

    res.status(200).json({ gradingResults: result })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '載入批改詳情失敗' })
  }
}

// ============================================================
// 1Campus 班級同步
// ============================================================

async function handleCampus1ClassroomSync(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const body = parseJsonBody(req)
  const dsns = typeof body?.dsns === 'string' ? body.dsns.trim() : ''

  if (!dsns || !isValidDsns(dsns)) {
    res.status(400).json({ error: 'Invalid dsns' })
    return
  }

  const supabaseAdmin = getSupabaseAdmin()

  // 確認此帳號確實有 1Campus 身份
  const { data: identity, error: identityError } = await supabaseAdmin
    .from('external_identities')
    .select('provider_meta, provider_account')
    .eq('user_id', user.id)
    .eq('provider', 'campus1')
    .maybeSingle()

  if (identityError || !identity) {
    console.warn('[1campus sync] 找不到 external_identities userId=', user.id, 'error=', identityError?.message)
    res.status(403).json({ error: '此帳號沒有 1Campus 身份' })
    return
  }

  // 確認是老師帳號（學生帳號不應呼叫 teacher sync）
  const roleType = String(identity.provider_meta?.roleType || '').trim()
  if (roleType && roleType !== 'teacher') {
    console.warn('[1campus sync] blocked: roleType is', roleType, 'for user', user.id)
    res.status(403).json({ error: '此功能僅限老師帳號使用' })
    return
  }

  // 從 DB 取 teacherID（不從 request 驗證，以防 teacherID 為空或格式不同）
  const storedTeacherID = String(identity.provider_meta?.teacherID || '').trim()
  const providerAccount = String(identity.provider_account || '').trim()
  const effectiveTeacherID = storedTeacherID || providerAccount
  const hasOAuthToken = !!identity.provider_meta?.oauth_access_token

  console.log('[1campus sync] user.id:', user.id, 'dsns:', dsns)
  console.log('[1campus sync] effectiveTeacherID:', effectiveTeacherID, '(storedTeacherID:', storedTeacherID, ', account:', providerAccount, ')')
  console.log('[1campus sync] hasOAuthToken:', hasOAuthToken)

  const dsnsLower = dsns.toLowerCase()
  const providerAccountDomain = providerAccount.includes('@')
    ? providerAccount.split('@')[1].trim().toLowerCase()
    : ''
  const fallbackEmailDomains = []
  if (providerAccountDomain) {
    fallbackEmailDomains.push(providerAccountDomain)
    if (!providerAccountDomain.startsWith('smail.')) {
      fallbackEmailDomains.push(`smail.${providerAccountDomain}`)
    }
  }
  fallbackEmailDomains.push(`smail.${dsnsLower}`)
  const dsnsParts = dsnsLower.split('.')
  if (dsnsParts.length > 2) {
    fallbackEmailDomains.push(`smail.${dsnsParts.slice(1).join('.')}`)
  }
  const uniqueFallbackDomains = Array.from(new Set(fallbackEmailDomains.filter(Boolean)))
  const defaultStudentMailDomain =
    uniqueFallbackDomains.find((d) => d.startsWith('smail.')) ||
    uniqueFallbackDomains[0] ||
    ''

  const normalizeCampus1StudentEmail = (rawEmail, rawStudentAcc) => {
    const directEmail = String(rawEmail || '').trim().toLowerCase()
    if (directEmail && directEmail.includes('@')) return directEmail

    const accountValue = String(rawStudentAcc || '').trim().toLowerCase()
    if (!accountValue) return null
    if (accountValue.includes('@')) return accountValue
    if (!defaultStudentMailDomain) return null
    if (!/^[a-z0-9._-]+$/i.test(accountValue)) return null
    return `${accountValue}@${defaultStudentMailDomain}`
  }

  if (!effectiveTeacherID) {
    res.status(403).json({ error: '無法取得 teacherID，請重新從 1Campus 登入' })
    return
  }

  // 取得 Jasmine API 專用 token（client_credentials 模式，不依賴用戶 OAuth）
  let accessToken
  try {
    accessToken = await getJasmineAccessToken()
    console.log('[1campus sync] got Jasmine token, length:', accessToken?.length)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('[1campus sync] getJasmineAccessToken failed:', errMsg)
    res.status(502).json({
      error: errMsg || '無法取得 Jasmine API 授權',
      debug: { step: 'getJasmineAccessToken', effectiveTeacherID, dsns }
    })
    return
  }

  // 使用 getCourseStudent 一次取得班級 + 學生 + email
  let courseStudents
  try {
    courseStudents = await fetchCampus1CourseStudents(dsns, effectiveTeacherID, accessToken)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('[1campus sync] fetchCampus1CourseStudents failed:', errMsg, '(effectiveTeacherID:', effectiveTeacherID, ')')
    res.status(502).json({
      error: '取得 1Campus 課程學生失敗',
      debug: { step: 'fetchCampus1CourseStudents', detail: errMsg, effectiveTeacherID, dsns, tokenLength: accessToken?.length }
    })
    return
  }

  console.log('[1campus sync] fetchCampus1CourseStudents returned', courseStudents.length, 'courses')

  // 依課程（courseID）分組，每個課程對應一個班級卡片
  // 同一班級上多科（如五年四班國語、五年四班數學）會產生不同卡片，名稱加上科目
  const classByCourseID = {}
  for (const course of courseStudents) {
    const classInfo = course.class || {}
    const courseID = String(course.courseID || '').trim()
    const classID = String(classInfo.classID || '').trim()
    const key = courseID || classID
    if (!key) continue

    const baseClassName = String(classInfo.className || '').trim()
    const courseName = String(course.courseName || '').trim()
    // getCourseStudent API 不一定回傳 courseName；若無則跳過，避免以純班級名稱建立重複班級
    if (!courseName) continue
    // 科目名稱通常已包含班級名稱（如「五年6班_智慧探究家：科技創新任務課程」）
    const displayName = courseName

    classByCourseID[key] = {
      courseID: key,
      classID,
      className: displayName,
      gradeYear: classInfo.gradeYear ?? null,
      students: Array.isArray(course.student) ? course.student : []
    }
  }

  const groupedClasses = Object.values(classByCourseID)
  console.log('[1campus sync] grouped into', groupedClasses.length, 'courses (one classroom per course)')

  if (!groupedClasses.length) {
    res.status(200).json({ success: true, synced: 0, total: 0, classrooms: [] })
    return
  }

  const results = []
  const nowIso = new Date().toISOString()

  for (const cls of groupedClasses) {
    const providerClassId = cls.courseID
    const className = cls.className

    try {
      // 查找現有的同步記錄
      const { data: syncRecord } = await supabaseAdmin
        .from('campus_classroom_sync')
        .select('id, classroom_id')
        .eq('owner_id', user.id)
        .eq('provider', 'campus1')
        .eq('provider_dsns', dsns)
        .eq('provider_class_id', providerClassId)
        .maybeSingle()

      let classroomId

      const gradeNum = cls.gradeYear != null ? parseInt(String(cls.gradeYear), 10) : null
      const gradeValue = gradeNum != null && !isNaN(gradeNum) ? gradeNum : null

      if (syncRecord?.classroom_id) {
        classroomId = syncRecord.classroom_id
        await supabaseAdmin
          .from('classrooms')
          .update({ name: className, ...(gradeValue != null ? { grade: gradeValue } : {}) })
          .eq('id', classroomId)
          .eq('owner_id', user.id)
      } else {
        // 生成與前端相同格式的 ID（timestamp-random）
        const generatedId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        const { data: newClassroom, error: classroomError } =
          await supabaseAdmin
            .from('classrooms')
            .insert({ id: generatedId, owner_id: user.id, name: className, folder: '1Campus', ...(gradeValue != null ? { grade: gradeValue } : {}) })
            .select('id')
            .single()

        if (classroomError) {
          throw new Error(`建立班級失敗: ${classroomError.message}`)
        }
        classroomId = newClassroom.id
      }

      // 轉換學生格式（getCourseStudent 回傳 seatNo, studentName, studentNumber, studentAcc, email）
      // email 可能在 email 或 studentAcc 欄位
      const normalizedStudents = cls.students
        .map((s) => {
          const normalizedEmail = normalizeCampus1StudentEmail(s.email, s.studentAcc)
          return {
            seat_number: Number(s.seatNo) || 0,
            name: String(s.studentName || '').trim(),
            email: normalizedEmail,
            provider_student_id: s.studentID != null && String(s.studentID).trim() ? String(s.studentID).trim() : null,
            student_number: s.studentNumber != null ? String(s.studentNumber).trim() : null
          }
        })
        .filter((s) => s.seat_number > 0 && s.name)

      const hasEmailCount = normalizedStudents.filter((s) => !!s.email).length
      const hasProviderStudentIdCount = normalizedStudents.filter((s) => !!s.provider_student_id).length
      console.log(
        '[1campus sync] normalized students snapshot:',
        {
          className,
          total: normalizedStudents.length,
          hasEmailCount,
          hasProviderStudentIdCount
        }
      )

      // 批次匯入學生
      let studentCount = 0
      if (normalizedStudents.length > 0) {
        const { error: rpcError } = await supabaseAdmin.rpc(
          'upsert_students_batch',
          {
            p_owner_id: user.id,
            p_classroom_id: classroomId,
            p_students: normalizedStudents.map(({ seat_number, name }) => ({ seat_number, name }))
          }
        )
        if (rpcError) throw new Error(`匯入學生失敗: ${rpcError.message}`)
        studentCount = normalizedStudents.length

        // 更新 email / provider_student_id / student_number（upsert_students_batch 不處理這些欄位）
        const studentsNeedUpdate = normalizedStudents.filter(
          (s) => s.email || s.provider_student_id || s.student_number
        )
        if (studentsNeedUpdate.length > 0) {
          let studentNumberColumnMissing = false
          let updateFailedCount = 0
          for (const s of studentsNeedUpdate) {
            const updatePayload = { updated_at: nowIso }
            if (s.email) updatePayload.email = s.email
            if (s.provider_student_id) updatePayload.provider_student_id = s.provider_student_id
            if (!studentNumberColumnMissing && s.student_number) {
              updatePayload.student_number = s.student_number
            }

            const runUpdate = async (payload) =>
              await supabaseAdmin
                .from('students')
                .update(payload)
                .eq('owner_id', user.id)
                .eq('classroom_id', classroomId)
                .eq('seat_number', s.seat_number)

            let { error: updateError } = await runUpdate(updatePayload)
            const updateErrMsg = String(updateError?.message || '').toLowerCase()

            if (
              updateError &&
              updateErrMsg.includes('student_number') &&
              (
                updateErrMsg.includes('does not exist') ||
                updateErrMsg.includes('schema cache') ||
                updateErrMsg.includes("could not find")
              )
            ) {
              studentNumberColumnMissing = true
              const retryPayload = { ...updatePayload }
              delete retryPayload.student_number
              if (Object.keys(retryPayload).length > 1) {
                const retryResult = await runUpdate(retryPayload)
                updateError = retryResult.error
              } else {
                updateError = null
              }
            }

            if (updateError) {
              updateFailedCount += 1
              console.warn(
                '[1campus sync] update student extra fields failed:',
                updateError.message,
                { className, seatNo: s.seat_number, name: s.name }
              )
            }
          }
          const updatedCount = studentsNeedUpdate.length - updateFailedCount
          console.log(
            '[1campus sync] updated extra fields:',
            { className, total: studentsNeedUpdate.length, updated: updatedCount, failed: updateFailedCount, studentNumberColumnMissing }
          )
        }
      }

      // 更新/建立同步記錄
      const syncPayload = {
        classroom_id: classroomId,
        sync_status: 'success',
        last_sync_at: nowIso,
        provider_class_name: className,
        last_student_count: studentCount,
        updated_at: nowIso
      }

      if (syncRecord) {
        await supabaseAdmin
          .from('campus_classroom_sync')
          .update(syncPayload)
          .eq('id', syncRecord.id)
      } else {
        await supabaseAdmin.from('campus_classroom_sync').insert({
          owner_id: user.id,
          provider: 'campus1',
          provider_dsns: dsns,
          provider_class_id: providerClassId,
          ...syncPayload
        })
      }

      results.push({
        classID: providerClassId,
        className,
        classroomId,
        studentCount,
        success: true
      })
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)

      try {
        const { data: existingSyncRecord } = await supabaseAdmin
          .from('campus_classroom_sync')
          .select('id')
          .eq('owner_id', user.id)
          .eq('provider', 'campus1')
          .eq('provider_dsns', dsns)
          .eq('provider_class_id', providerClassId)
          .maybeSingle()

        if (existingSyncRecord) {
          await supabaseAdmin
            .from('campus_classroom_sync')
            .update({ sync_status: 'error', last_error: errMessage, updated_at: nowIso })
            .eq('id', existingSyncRecord.id)
        } else {
          await supabaseAdmin.from('campus_classroom_sync').insert({
            owner_id: user.id,
            provider: 'campus1',
            provider_dsns: dsns,
            provider_class_id: providerClassId,
            provider_class_name: className,
            sync_status: 'error',
            last_error: errMessage
          })
        }
      } catch {
        // 記錄更新失敗不影響主流程
      }

      results.push({
        classID: providerClassId,
        className,
        success: false,
        error: errMessage
      })
    }
  }

  const synced = results.filter((r) => r.success).length
  res.status(200).json({
    success: synced > 0 || results.length === 0,
    synced,
    total: results.length,
    classrooms: results
  })
}

// ============================================================
// 1Campus Debug（暫時診斷用，確認 Jasmine API 可用後可移除）
// ============================================================
async function handleCampus1Debug(req, res) {
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const supabaseAdmin = getSupabaseAdmin()
  const result = { userId: user.id, steps: [] }

  // Step 1: 查 external_identities
  try {
    const { data: identity, error } = await supabaseAdmin
      .from('external_identities')
      .select('provider_meta, provider_account')
      .eq('user_id', user.id)
      .eq('provider', 'campus1')
      .maybeSingle()

    if (error) {
      result.steps.push({ step: 'identity', ok: false, error: error.message })
      res.status(200).json(result)
      return
    }
    if (!identity) {
      result.steps.push({ step: 'identity', ok: false, error: '找不到 campus1 身份記錄' })
      res.status(200).json(result)
      return
    }

    const meta = identity.provider_meta || {}
    result.steps.push({
      step: 'identity',
      ok: true,
      account: identity.provider_account,
      teacherID: meta.teacherID || null,
      studentID: meta.studentID || null,
      roleType: meta.roleType || null,
      dsns: meta.dsns || null,
      hasOAuthToken: !!meta.oauth_access_token,
      tokenExpiresAt: meta.oauth_token_expires_at || null,
      hasRefreshToken: !!meta.oauth_refresh_token
    })

    const dsns = meta.dsns
    const teacherID = String(meta.teacherID || identity.provider_account || '').trim()

    // Step 2: 取得 Jasmine API token（client_credentials 模式）
    let accessToken
    try {
      accessToken = await getJasmineAccessToken()
      result.steps.push({ step: 'jasmine_token', ok: true, tokenLength: accessToken?.length, mode: 'client_credentials' })
    } catch (err) {
      result.steps.push({ step: 'jasmine_token', ok: false, error: err?.message })
      res.status(200).json(result)
      return
    }

    // Step 3: 呼叫 getCourseStudent 取得班級 + 學生 + email
    const jasmineBase = process.env.CAMPUS1_JASMINE_API_BASE || 'https://devapi.1campus.net/api/jasmine'
    const getCourseStudentUrl = `${jasmineBase}/${dsns}/getCourseStudent?teacherID=${encodeURIComponent(teacherID)}`
    try {
      const rawResp = await fetch(getCourseStudentUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15000)
      })
      const rawText = await rawResp.text()
      let rawJson = null
      try { rawJson = JSON.parse(rawText) } catch { /* not JSON */ }

      const courses = rawJson?.course ?? rawJson?.data?.course ?? []
      const courseList = Array.isArray(courses) ? courses : []

      // 依班級分組
      const classByID = {}
      for (const course of courseList) {
        const classInfo = course.class || {}
        const classID = String(classInfo.classID || course.courseID || '')
        if (!classID) continue
        if (!classByID[classID]) {
          classByID[classID] = {
            classID,
            className: classInfo.className || course.courseName || '',
            gradeYear: classInfo.gradeYear ?? null,
            students: []
          }
        }
        const students = Array.isArray(course.student) ? course.student : []
        for (const s of students) {
          const exists = classByID[classID].students.find(
            (ex) => ex.seatNo === s.seatNo && ex.studentName === s.studentName
          )
          if (!exists) classByID[classID].students.push(s)
        }
      }

      const groupedClasses = Object.values(classByID)

      result.steps.push({
        step: 'getCourseStudent',
        ok: rawResp.ok,
        httpStatus: rawResp.status,
        url: getCourseStudentUrl,
        courseCount: courseList.length,
        uniqueClassCount: groupedClasses.length,
        classes: groupedClasses.slice(0, 5).map((c) => ({
          classID: c.classID,
          className: c.className,
          gradeYear: c.gradeYear,
          studentCount: c.students.length,
          sampleStudents: c.students.slice(0, 3).map((s) => ({
            seatNo: s.seatNo,
            studentName: s.studentName,
            studentNumber: s.studentNumber,
            studentID: s.studentID || null,
            studentAcc: s.studentAcc || null,
            email: s.email || s.studentAcc || null
          }))
        })),
        rawKeys: rawJson ? Object.keys(rawJson) : null,
        rawSnippet: rawText.slice(0, 1200)
      })
    } catch (err) {
      result.steps.push({ step: 'getCourseStudent', ok: false, error: err?.message, url: getCourseStudentUrl })
    }

    res.status(200).json(result)
  } catch (err) {
    res.status(500).json({ error: err?.message, steps: result.steps })
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  applyNoStoreHeaders(res)
  const action = resolveAction(req)
  if (action === 'sync') {
    await handleSync(req, res)
    return
  }
  if (action === 'submission') {
    await handleSubmission(req, res)
    return
  }
  if (action === 'teacher-preferences') {
    await handleTeacherPreferences(req, res)
    return
  }
  if (action === 'students-batch-upsert') {
    await handleStudentsBatchUpsert(req, res)
    return
  }
  if (action === 'student-overview') {
    await handleStudentOverview(req, res)
    return
  }
  if (action === 'student-submission') {
    await handleStudentSubmission(req, res)
    return
  }
  if (action === 'student-corrections') {
    await handleStudentCorrections(req, res)
    return
  }
  if (action === 'process-grading') {
    await handleProcessPendingGrading(req, res)
    return
  }
  if (action === 'correction-dashboard') {
    await handleCorrectionDashboard(req, res)
    return
  }
  if (action === 'correction-notice') {
    await handleCorrectionNotice(req, res)
    return
  }
  if (action === 'correction-dispatch-toggle') {
    await handleCorrectionDispatchToggle(req, res)
    return
  }
  if (action === 'correction-unlock') {
    await handleCorrectionUnlock(req, res)
    return
  }
  if (action === 'correction-disputes') {
    await handleCorrectionDisputes(req, res)
    return
  }
  if (action === 'dispute-resolve') {
    await handleDisputeResolve(req, res)
    return
  }
  if (action === 'clear-sw') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.status(200).send(`<!DOCTYPE html><html><head><title>清除快取</title></head><body>
<h2>正在清除 Service Worker 和快取...</h2><pre id="log"></pre>
<script>
const log = document.getElementById('log');
(async () => {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) { await r.unregister(); log.textContent += '已移除 SW: ' + r.scope + '\\n'; }
    const keys = await caches.keys();
    for (const k of keys) { await caches.delete(k); log.textContent += '已刪除快取: ' + k + '\\n'; }
    log.textContent += '\\n✅ 完成！3 秒後自動跳轉...';
    setTimeout(() => { window.location.href = '/'; }, 3000);
  } catch(e) { log.textContent += '❌ 錯誤: ' + e.message; }
})();
</script></body></html>`)
    return
  }
  if (action === 'get-gradebook-scores') {
    await handleGetGradebookScores(req, res)
    return
  }
  if (action === 'save-grading') {
    await handleSaveGrading(req, res)
    return
  }
  if (action === 'save-final-answers') {
    await handleSaveFinalAnswers(req, res)
    return
  }
  if (action === 'clear-grading') {
    await handleClearGrading(req, res)
    return
  }
  if (action === 'clear-correction-for-rerun') {
    await handleClearCorrectionForRerun(req, res)
    return
  }
  if (action === 'reconcile-phase-b-regrade') {
    await handleReconcilePhaseBRegrade(req, res)
    return
  }
  if (action === 'import-template') {
    await handleImportTemplate(req, res)
    return
  }
  if (action === 'manual-grade') {
    await handleManualGrade(req, res)
    return
  }
  if (action === 'manual-grade-revert') {
    await handleManualGradeRevert(req, res)
    return
  }
  if (action === 'correction-manual-pass') {
    await handleCorrectionManualPass(req, res)
    return
  }
  if (action === 'correction-manual-pass-revert') {
    await handleCorrectionManualPassRevert(req, res)
    return
  }
  if (action === 'report') {
    await handleReport(req, res)
    return
  }
  if (action === 'grading-results') {
    await handleGradingResults(req, res)
    return
  }
  if (action === '1campus-classroom-sync') {
    await handleCampus1ClassroomSync(req, res)
    return
  }
  if (action === '1campus-debug') {
    await handleCampus1Debug(req, res)
    return
  }
  if (action === 'assignment-state-summary') {
    await handleAssignmentStateSummary(req, res)
    return
  }
  if (action === 'correction-history') {
    await handleCorrectionHistory(req, res)
    return
  }
  if (action === 'refresh-assignment-summary') {
    await handleRefreshAssignmentSummary(req, res)
    return
  }
  if (action === 'assignment-summary') {
    await handleGetAssignmentSummary(req, res)
    return
  }
  if (action === 'concept-map') {
    await handleGetConceptMap(req, res)
    return
  }
  if (action === 'upsert-ai3-forensic-log') {
    await handleUpsertAi3ForensicLog(req, res)
    return
  }
  if (action === 'update-ai3-forensic-log') {
    await handleUpdateAi3ForensicLog(req, res)
    return
  }
  if (action === 'quality-check-log') {
    await handleQualityCheckLog(req, res)
    return
  }
  if (action === 'announcement-active') {
    await handleAnnouncementActive(req, res)
    return
  }
  res.status(404).json({ error: 'Not Found' })
}

// ─────────────────────────────────────────────────────────
// handleAnnouncementActive
// GET /api/data/announcement-active
// 回目前 active && now ∈ [starts_at, ends_at] 的最新一則公告，給登入後 modal 用
// ─────────────────────────────────────────────────────────
async function handleAnnouncementActive(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const supabaseDb = getSupabaseAdmin()
  const nowIso = new Date().toISOString()
  const { data, error } = await supabaseDb
    .from('announcements')
    .select('id, title, body, starts_at, ends_at')
    .eq('active', true)
    .lte('starts_at', nowIso)
    .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    res.status(500).json({ error: error.message || '讀取公告失敗' })
    return
  }
  res.status(200).json({ announcement: data || null })
}

// ─────────────────────────────────────────────────────────
// handleGetConceptMap
// GET /api/data/concept-map?grade=X[&domain=Y]
//   - grade: 1-12（必填）
//   - domain: 國語/英語/數學/自然/社會（選填、過濾 subject、避免跨科干擾）
//     - 未帶 domain 時回所有 grade=X 的概念（向後相容）
//     - 帶不存在的 domain（例如國語還沒灌進 concept_map）→ 回空陣列
// ─────────────────────────────────────────────────────────
function mapDomainToSubjects(domain) {
  if (!domain || typeof domain !== 'string') return null
  switch (domain.trim()) {
    case '國語': return ['chinese']
    case '英語': case '英文': return ['english']
    case '數學': return ['math']
    // 自然涵蓋國小自然 + 國中分科（生/化/地/物）
    case '自然': return ['science', 'nature_bio', 'nature_chem', 'nature_earth', 'nature_phy']
    case '社會': return ['social']
    default: return null
  }
}

async function handleGetConceptMap(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const grade = parseInt(req.query?.grade, 10)
  if (!grade || grade < 1 || grade > 12) {
    res.status(400).json({ error: 'Invalid grade parameter (must be 1–12)' })
    return
  }
  const domainRaw = Array.isArray(req.query?.domain) ? req.query.domain[0] : req.query?.domain
  const subjects = mapDomainToSubjects(domainRaw)
  if (domainRaw && !subjects) {
    console.warn(`[concept-map] unknown domain="${domainRaw}", returning empty items`)
    res.status(200).json({ items: [] })
    return
  }
  try {
    const supabaseDb = getSupabaseAdmin()
    let query = supabaseDb
      .from('concept_map')
      .select('code, label, description')
      .eq('grade', grade)
    if (subjects) query = query.in('subject', subjects)
    const { data, error } = await query.order('code', { ascending: true })
    if (error) {
      console.error('[concept-map] supabase error:', error)
      res.status(500).json({ error: 'DB error' })
      return
    }
    console.log(`[concept-map] grade=${grade} domain=${domainRaw || '(none)'} subjects=${subjects ? subjects.join(',') : 'all'} items=${data?.length || 0}`)
    res.status(200).json({ items: data || [] })
  } catch (err) {
    console.error('[concept-map] error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
}

// ─────────────────────────────────────────────────────────
// handleGetAssignmentSummary
// GET /api/data/assignment-summary?assignmentId=xxx
// ─────────────────────────────────────────────────────────
async function handleGetAssignmentSummary(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const assignmentId = typeof req.query?.assignmentId === 'string' ? req.query.assignmentId.trim() : ''
  if (!assignmentId) {
    res.status(400).json({ error: 'assignmentId required' })
    return
  }
  const supabaseDb = getSupabaseAdmin()
  const [{ data, error }, { data: latestSubRow }] = await Promise.all([
    supabaseDb
      .from('assignment_summaries')
      .select('status, class_summary, class_suggestion, minority_summary, minority_suggestion, student_summaries, error_groups, sample_count, updated_at, error_message')
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .maybeSingle(),
    supabaseDb
      .from('submissions')
      .select('updated_at')
      .eq('assignment_id', assignmentId)
      .eq('owner_id', user.id)
      .in('status', ['graded', 'correction_passed', 'correction_pending_review'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  ])
  if (error) {
    res.status(500).json({ error: error.message })
    return
  }
  res.status(200).json({ summary: data ?? null, latestGradedAt: latestSubRow?.updated_at ?? null })
}

// ─────────────────────────────────────────────────────────
// handleRefreshAssignmentSummary
// POST /api/data/refresh-assignment-summary
// Phase B 批改完後非同步觸發，為單份作業生成 AI 錯誤摘要
// ─────────────────────────────────────────────────────────
async function handleRefreshAssignmentSummary(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const { assignmentId } = req.body || {}
  if (!assignmentId || typeof assignmentId !== 'string') {
    res.status(400).json({ error: 'assignmentId required' })
    return
  }

  const supabaseDb = getSupabaseAdmin()
  const nowIso = new Date().toISOString()
  const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const logPrefix = `[refresh-assignment-summary][${traceId}]`

  console.log(`${logPrefix} start owner=${user.id} assignment=${assignmentId}`)

  // ── 同步執行：等 Gemini 完成後再回傳，避免 Vercel 背景執行不可靠導致卡 running ──
  try {
    // 1. 讀取此作業所有已批改的 submissions
    const { data: submissions, error: subErr } = await supabaseDb
      .from('submissions')
      .select('id, student_id, grading_result, status')
      .eq('assignment_id', assignmentId)
      .eq('owner_id', user.id)
      .in('status', ['graded', 'correction_passed', 'correction_pending_review'])

    if (subErr) {
      console.error(`${logPrefix} submissions query failed`, getErrorDiagnostics(subErr))
      throw wrapError(
        `submissions_query_failed: ${subErr.message || 'unknown'}`,
        subErr
      )
    }
    if (!submissions || submissions.length === 0) {
      await supabaseDb
        .from('assignment_summaries')
        .upsert(
          { owner_id: user.id, assignment_id: assignmentId, status: 'failed',
            error_message: '尚無批改資料', updated_at: new Date().toISOString() },
          { onConflict: 'owner_id,assignment_id' }
        )
      res.status(200).json({ success: false, status: 'failed', error: '尚無批改資料' })
      return
    }

    // 2. 取得學生姓名
    const studentIds = [...new Set(submissions.map(s => s.student_id).filter(Boolean))]
    const studentNameMap = {}
    if (studentIds.length > 0) {
      const { data: studentRows, error: studentRowsErr } = await supabaseDb
        .from('students')
        .select('id, name')
        .in('id', studentIds)
      if (studentRowsErr) {
        console.error(`${logPrefix} students query failed`, getErrorDiagnostics(studentRowsErr))
        throw wrapError(
          `students_query_failed: ${studentRowsErr.message || 'unknown'}`,
          studentRowsErr
        )
      }
      if (studentRows) {
        studentRows.forEach(s => { studentNameMap[s.id] = s.name })
      }
    }

    // 3. 讀取答案鍵的 concept_code（從 assignments 表）
    // 同時拉 answer_sheet_image_paths / question_booklet_image_paths 供 3b 取題目圖
    const { data: assignment, error: assignmentErr } = await supabaseDb
      .from('assignments')
      .select('answer_key, answer_sheet_image_paths, question_booklet_image_paths, answer_sheet_mode, answer_key_template_id')
      .eq('id', assignmentId)
      .eq('owner_id', user.id)
      .maybeSingle()

    if (assignmentErr) {
      console.error(`${logPrefix} assignments query failed`, getErrorDiagnostics(assignmentErr))
      throw wrapError(
        `assignments_query_failed: ${assignmentErr.message || 'unknown'}`,
        assignmentErr
      )
    }

    const conceptByQuestion = {}
    const questionInfoById = {}
    if (assignment?.answer_key) {
      const answerKey = typeof assignment.answer_key === 'string'
        ? JSON.parse(assignment.answer_key)
        : assignment.answer_key
      for (const q of (answerKey?.questions || [])) {
        if (q.concept_code) {
          conceptByQuestion[q.id] = { code: q.concept_code, label: q.concept_label || q.concept_code }
        }
        questionInfoById[q.id] = {
          type: q.type || null,
          correctAnswer: q.answer || q.referenceAnswer || null
        }
      }
    }

    // 3b. 嘗試從 Supabase Storage 取得題目圖片（給 AI 看題目內容）
    // 三個來源（任一即可）：
    //   - answer-sheets/${assignmentId}/page-${i}.webp 是 with_questions 模式的卷子
    //   - question_booklet_image_paths 欄位（早期 answer_only 模式存欄位的路徑陣列）
    //   - question-booklets/${assignmentId 或 templateId}/page-N.webp prefix scan（對齊 proxy.js:fetchQuestionBookletImages）
    // answer_only 模式時答題卡沒題目文字、必須讀題本才能讓 AI 看到題目
    const answerSheetImages = []
    let bookletSource = 'none'
    let bookletCount = 0
    try {
      // 路徑 A：固定 path 的 answer sheets（適用 with_questions 卷）
      for (let i = 0; i < 10; i++) {
        const path = `answer-sheets/${assignmentId}/page-${i}.webp`
        const { data: imgData, error: imgErr } = await supabaseDb.storage
          .from('homework-images').download(path)
        if (imgErr || !imgData) break
        const buffer = Buffer.from(await imgData.arrayBuffer())
        answerSheetImages.push({ mimeType: 'image/webp', data: buffer.toString('base64') })
      }
      // 路徑 B：answer_only 模式的題本（user 另外上傳）
      const bookletPaths = Array.isArray(assignment?.question_booklet_image_paths)
        ? assignment.question_booklet_image_paths
        : []
      for (const p of bookletPaths) {
        if (typeof p !== 'string' || !p) continue
        const { data: imgData, error: imgErr } = await supabaseDb.storage
          .from('homework-images').download(p)
        if (imgErr || !imgData) continue
        const buffer = Buffer.from(await imgData.arrayBuffer())
        const mimeType = p.toLowerCase().endsWith('.jpg') || p.toLowerCase().endsWith('.jpeg')
          ? 'image/jpeg' : 'image/webp'
        answerSheetImages.push({ mimeType, data: buffer.toString('base64') })
        bookletCount++
      }
      if (bookletCount > 0) bookletSource = 'column'

      // 路徑 B fallback：answer_only 模式但 column 沒題本 → 走 prefix scan
      // 對齊 proxy.js:fetchQuestionBookletImages：先 assignment-level、再 template-level
      if (bookletCount === 0 && assignment?.answer_sheet_mode === 'answer_only') {
        const bucket = supabaseDb.storage.from('homework-images')
        const downloadBookletByPrefix = async (prefix) => {
          const out = []
          for (let i = 0; i < 20; i++) {
            const { data, error } = await bucket.download(`${prefix}/page-${i}.webp`)
            if (error || !data) break
            const buf = Buffer.from(await data.arrayBuffer())
            out.push({ mimeType: 'image/webp', data: buf.toString('base64') })
          }
          return out
        }

        let fallbackImages = await downloadBookletByPrefix(`question-booklets/${assignmentId}`)
        let fallbackTag = 'prefix-assignment'

        if (fallbackImages.length === 0 && assignment?.answer_key_template_id) {
          fallbackImages = await downloadBookletByPrefix(`question-booklets/${assignment.answer_key_template_id}`)
          fallbackTag = 'prefix-template'
        }

        if (fallbackImages.length > 0) {
          answerSheetImages.push(...fallbackImages)
          bookletCount = fallbackImages.length
          bookletSource = fallbackTag
        }
      }

      if (answerSheetImages.length > 0) {
        console.log(`${logPrefix} fetched ${answerSheetImages.length} image(s) for multimodal summary (mode=${assignment?.answer_sheet_mode || 'unknown'}, booklets=${bookletCount}, bookletSource=${bookletSource})`)
      } else {
        console.log(`${logPrefix} no images available (no answer-sheets/, no question booklets in column or prefix scans)`)
      }
    } catch (imgFetchErr) {
      console.warn(`${logPrefix} image fetch failed (non-fatal):`, imgFetchErr?.message || imgFetchErr)
    }

    // 3. 整理每位學生的錯誤清單
    const studentErrors = []
    for (const sub of submissions) {
      let grading = null
      try {
        grading = typeof sub.grading_result === 'string'
          ? JSON.parse(sub.grading_result)
          : sub.grading_result
      } catch { continue }

      const mistakes = Array.isArray(grading?.mistakes) ? grading.mistakes : []
      const details = Array.isArray(grading?.details) ? grading.details : []

      // 收集每題的錯誤（含課綱概念）
      const errorItems = []
      for (const detail of details) {
        if (detail.score > 0 && detail.score >= (detail.maxScore || 1)) continue // 答對跳過
        const concept = conceptByQuestion[detail.questionId]
        const reason = mistakes.find(m => m.question?.includes(detail.questionId))?.reason || detail.explanation || ''
        const qInfo = questionInfoById[detail.questionId]
        const qType = qInfo?.type || detail.questionType || null
        // For choice/true_false, include correct & student answer so AI can describe the error meaningfully
        const isChoiceType = qType === 'single_choice' || qType === 'multi_choice' || qType === 'true_false'
        const studentAnswer = detail.studentAnswer || null
        const correctAnswer = isChoiceType ? (qInfo?.correctAnswer || null) : null
        errorItems.push({
          questionId: detail.questionId,
          questionType: qType,
          concept: concept ? `${concept.code}（${concept.label}）` : null,
          reason: reason.slice(0, 100),
          ...(studentAnswer ? { studentAnswer: String(studentAnswer).slice(0, 30) } : {}),
          ...(correctAnswer ? { correctAnswer: String(correctAnswer).slice(0, 30) } : {})
        })
      }

      if (errorItems.length > 0) {
        studentErrors.push({
          studentName: studentNameMap[sub.student_id] || `學生${sub.student_id}`,
          studentId: sub.student_id,
          errors: errorItems
        })
      }
    }

    const sampleCount = submissions.length
    // 限制 prompt 大小：最多 40 位學生，每位最多 5 個錯誤
    const cappedStudentErrors = studentErrors.slice(0, 40).map(s => ({
      ...s,
      errors: s.errors.slice(0, 5)
    }))
    const errorCount = cappedStudentErrors.length

    // 4. 建立 AI prompt
    const conceptContext = Object.keys(conceptByQuestion).length > 0
      ? `\n作業涵蓋的課綱概念：\n${Object.entries(conceptByQuestion).map(([qId, c]) => `第${qId}題：${c.code} ${c.label}`).join('\n')}\n`
      : ''

    const studentLines = cappedStudentErrors.map(s => {
      const errLines = s.errors.map(e => {
        const conceptStr = e.concept ? `（${e.concept}）` : ''
        const typeStr = e.questionType ? `[${e.questionType}]` : ''
        const answerStr = e.correctAnswer
          ? `，正確答案=${e.correctAnswer}，學生答=${e.studentAnswer || '?'}`
          : (e.studentAnswer ? `，學生答=${e.studentAnswer}` : '')
        return `  第${e.questionId}題${typeStr}${conceptStr}：${e.reason || '答錯'}${answerStr}`
      }).join('\n')
      return `${s.studentName}：\n${errLines}`
    }).join('\n\n')

    // 建立題號 → 頁碼對照表（讓 AI 知道哪些題目在哪張圖上）
    const questionIds = Object.keys(questionInfoById)
    let imageGuide = ''
    if (answerSheetImages.length > 0) {
      if (answerSheetImages.length === 1) {
        imageGuide = `\n📷 附圖說明：附上 1 張作業原卷圖片，所有題目都在這張圖上。請參考圖片中的題目內容（題幹、選項等）來撰寫更具體的錯誤描述。\n`
      } else {
        // 多頁：依題號前綴分組
        const pageGroups = new Map()
        for (const qId of questionIds) {
          const dashIdx = qId.indexOf('-')
          const pagePrefix = dashIdx > 0 ? qId.substring(0, dashIdx) : '1'
          const pageNum = parseInt(pagePrefix, 10) || 1
          if (!pageGroups.has(pageNum)) pageGroups.set(pageNum, [])
          pageGroups.get(pageNum).push(qId)
        }
        const pageLines = Array.from(pageGroups.entries())
          .sort(([a], [b]) => a - b)
          .map(([page, ids]) => `  - 圖片 ${page}（第 ${page} 頁）：包含題目 ${ids.slice(0, 8).join('、')}${ids.length > 8 ? ` 等共 ${ids.length} 題` : ''}`)
          .join('\n')
        imageGuide = `\n📷 附圖說明：附上 ${answerSheetImages.length} 張作業原卷圖片。題號前綴對應頁碼：
  - 題號格式為「頁碼-大題-小題」，例如「1-E-5」= 第 1 頁、大題 E、第 5 小題
  - 前綴「1-」的題目在第 1 張圖上，「2-」在第 2 張圖上，依此類推
${pageLines}
請參考圖片中的題目內容（題幹、選項等）來撰寫更具體的錯誤描述。\n`
      }
    }

    const prompt = `你是台灣國小/國中老師的教學助理。以下是一份作業的批改結果，共 ${sampleCount} 位學生，其中 ${errorCount} 位有錯誤。
${imageGuide}${conceptContext}
學生錯誤明細：
${studentLines || '（無錯誤）'}

請根據以上資料，用繁體中文生成摘要，輸出純 JSON（不要 markdown）：
{
  "class_summary": "大多數學生（超過半數）的共同錯誤描述，說明主要錯在哪個概念或步驟（2-4句話）。若無共同錯誤則說明全班表現。",
  "class_suggestion": "針對 class_summary 的問題，給老師具體的教學建議（1-3點，例如：建議複習某概念、加強某題型練習等）。若無錯誤則填 null。",
  "error_groups": [
    {
      "question_id": "題號（如 1-E-5）",
      "error_pattern": "推論學生答錯的原因，寫出學生可能的迷思概念或混淆點（1句話）。你的角色是教學診斷專家，不是只描述『誰答錯了什麼』，而是要分析『為什麼會答錯』。範例：✗ 差：『第5題選擇題答錯』 ✗ 不夠：『第5題正確答案B，學生選C』 ✓ 好：『混淆平行四邊形與梯形的定義：誤認只要有一組平行邊就是平行四邊形』 ✓ 好：『不理解分數除法要顛倒相乘，直接用分子除分子、分母除分母』",
      "student_names": ["學生A", "學生B", "學生C"],
      "count": 3,
      "suggestion": "針對上述迷思概念的具體教學建議（1句話，如：建議用對比圖表讓學生比較平行四邊形和梯形的異同）"
    }
  ],
  "minority_summary": "少數學生（少於半數）特有的問題描述，若無則填 null（1-2句話）",
  "minority_suggestion": "針對 minority_summary 的問題，給老師處理這些學生的建議（1-2點）。若無則填 null。",
  "student_summaries": [
    { "student_id": "xxx", "student_name": "小明", "summary": "簡短描述這位學生的主要錯誤（1句話）" }
  ]
}

注意：
- class_summary 聚焦在超過半數學生都有的問題
- error_groups 列出最多 3 個最多人犯的錯誤群組，依人數由多到少排序。每個群組標明哪些學生犯了這個錯誤。至少 2 人以上的錯誤才列入群組。若無共同錯誤則 error_groups 為空陣列。
- minority_summary 說明少數人特有的問題模式
- student_summaries 只列出有錯誤的學生
- 若有課綱概念代碼（如 N-4-12），請在摘要中引用讓老師知道是哪個單元
- class_suggestion 和 minority_suggestion 要具體可執行，不要太籠統
- ⚠️ 若附有作業原卷圖片，務必查看圖片中的題目內容。根據題幹、選項、以及學生的錯誤答案，推論學生最可能的迷思概念。例如：看到選擇題問「哪個是直角三角形？」而學生選了等腰三角形的選項 → 推論「學生混淆直角三角形和等腰三角形的判斷標準」。題號前綴對應圖片頁碼（1-開頭的題目看第1張圖）。`

    // 5. 呼叫 Gemini（加 120s 超時，保留足夠空間給 DB 查詢 + catch 寫入，確保在 Vercel 300s kill 前完成）
    const apiKey = getEnvValue('SYSTEM_GEMINI_API_KEY') || getEnvValue('SECRET_API_KEY')
    if (!apiKey) throw new Error('Server API Key missing')

    // 5a. 墨水 balance check：報告為老師專屬功能、billingUserId = user.id
    // 不接 ink_session（session 是給批改用、報告獨立 call）
    let isAdminUser = false
    let balanceBeforeCharge = 0
    try {
      const { data: profile } = await supabaseDb
        .from('profiles').select('ink_balance, role').eq('id', user.id).maybeSingle()
      isAdminUser = profile?.role === 'admin'
      balanceBeforeCharge = typeof profile?.ink_balance === 'number' ? profile.ink_balance : 0
      if (!isAdminUser && balanceBeforeCharge <= 0) {
        await supabaseDb.from('assignment_summaries').upsert(
          { owner_id: user.id, assignment_id: assignmentId, status: 'failed',
            error_message: '墨水不足、請先補充再生成報告', updated_at: new Date().toISOString() },
          { onConflict: 'owner_id,assignment_id' }
        )
        res.status(402).json({ success: false, error: '墨水不足、請先補充再生成報告' })
        return
      }
    } catch (e) {
      console.warn(`${logPrefix} ink balance check failed (non-fatal):`, e?.message)
    }

    // 2026-05-21: model 由 model-config.js 統一管理（report 走 REPORT_TEACHER_SUMMARY → FLASH）
    // orchestrator 內 executeSinglePipelineCall 會依 routeKey 再查一次、這裡只是 label
    const { MODEL_FLASH } = await import('../../server/ai/model-config.js')
    const summaryModel = MODEL_FLASH
    const SUMMARY_TIMEOUT_MS = 120_000
    // 組合 multimodal parts：圖片（若有）+ 文字 prompt
    const summaryParts = []
    for (let i = 0; i < answerSheetImages.length; i++) {
      summaryParts.push({ text: `--- 作業原卷第 ${i + 1} 頁 ---` })
      summaryParts.push({ inlineData: answerSheetImages[i] })
    }
    summaryParts.push({ text: prompt })

    // 2026-05-23: 包 trackingContext 把報告 token 寫入 ink_session_usage（給後台儀表板）
    // 注意：報告自己也會直接扣 ink_balance（line 7610-7625）、跟 settlement 流程獨立
    const pipelineResult = await trackingContext.run(
      {
        supabaseAdmin: supabaseDb,
        actorUserId: user.id,
        billingUserId: user.id,
        isAdmin: isAdminUser,
        inkSessionId: null,
        assignmentId: assignmentId,
        submissionId: null
      },
      () =>
        Promise.race([
          runAiPipeline({
            apiKey,
            model: summaryModel,
            contents: [{ role: 'user', parts: summaryParts }],
            requestedRouteKey: 'report.teacher_summary',
            routeHint: { source: 'data' },
            // 強制 structured output：responseMimeType 單獨用不夠（Flash 仍會漏 `}`），
            // 必須搭配 responseSchema 才會走嚴格 schema 路徑、產出 100% valid JSON。
            payload: {
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.2,
                responseSchema: {
                  type: 'OBJECT',
                  properties: {
                    class_summary: { type: 'STRING' },
                    class_suggestion: { type: 'STRING', nullable: true },
                    error_groups: {
                      type: 'ARRAY',
                      items: {
                        type: 'OBJECT',
                        properties: {
                          question_id: { type: 'STRING' },
                          error_pattern: { type: 'STRING' },
                          student_names: { type: 'ARRAY', items: { type: 'STRING' } },
                          count: { type: 'INTEGER' },
                          suggestion: { type: 'STRING' }
                        },
                        required: ['question_id', 'error_pattern', 'student_names', 'count']
                      }
                    },
                    minority_summary: { type: 'STRING', nullable: true },
                    minority_suggestion: { type: 'STRING', nullable: true },
                    student_summaries: {
                      type: 'ARRAY',
                      items: {
                        type: 'OBJECT',
                        properties: {
                          student_id: { type: 'STRING' },
                          student_name: { type: 'STRING' },
                          summary: { type: 'STRING' }
                        },
                        required: ['student_id', 'student_name', 'summary']
                      }
                    }
                  },
                  required: ['class_summary', 'error_groups', 'student_summaries']
                }
              }
            }
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('summary_generation_timeout: exceeded 240s')), SUMMARY_TIMEOUT_MS)
          )
        ])
    )

    const ok = Number(pipelineResult.status) >= 200 && Number(pipelineResult.status) < 300
    if (!ok) {
      console.error(`${logPrefix} runAiPipeline failed`, {
        status: pipelineResult.status,
        routeKey: pipelineResult.data?.routeKey,
        pipeline: pipelineResult.data?._pipeline
      })
      throw wrapError(`gemini_call_failed: status=${pipelineResult.status}`)
    }

    // 5b. 扣墨水（成功 call AI 後才扣、admin bypass）
    // 跟 proxy.js 相同公式 (computeInkPointsFromTokens) 確保一致
    try {
      const usage = pipelineResult.data?.usageMetadata
      if (usage && !isAdminUser) {
        const cost = computeInkPointsFromTokens({
          inputTokens: usage.promptTokenCount,
          outputTokens: usage.candidatesTokenCount,
          totalTokens: usage.totalTokenCount,
        })
        if (cost.points > 0) {
          const nextBalance = Math.max(0, balanceBeforeCharge - cost.points)
          await supabaseDb.from('profiles')
            .update({ ink_balance: nextBalance, updated_at: new Date().toISOString() })
            .eq('id', user.id)
          await supabaseDb.from('ink_ledger').insert({
            user_id: user.id,
            delta: -cost.points,
            reason: 'report_teacher_summary',
            metadata: {
              assignment_id: assignmentId,
              model: summaryModel,
              usage,
              cost,
              billedTo: 'self',
            }
          })
          console.log(`${logPrefix} ink charged ${cost.points} (balance ${balanceBeforeCharge} → ${nextBalance})`)
        }
      } else if (isAdminUser) {
        console.log(`${logPrefix} admin bypass ink charge`)
      }
    } catch (chargeErr) {
      // 扣款失敗不影響 user 得到報告、僅 log
      console.warn(`${logPrefix} ink charge failed (non-fatal):`, chargeErr?.message)
    }

    const rawText = pipelineResult.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const cleanText = rawText.replace(/```json|```/g, '').trim()
    let parsed
    try {
      parsed = JSON.parse(cleanText)
    } catch (parseErr) {
      // Gemini 偶發吐非標準 JSON (單引號 / unquoted key / trailing comma)
      // 記錄 raw text 片段、寫 failed 狀態、不要 throw 整個 endpoint
      console.error(`${logPrefix} JSON parse failed: ${parseErr.message}`)
      console.error(`${logPrefix} raw text sample (first 800 chars):`, cleanText.slice(0, 800))
      await supabaseDb.from('assignment_summaries').upsert(
        { owner_id: user.id, assignment_id: assignmentId, status: 'failed',
          error_message: `AI 回傳格式無法解析: ${parseErr.message}`,
          updated_at: new Date().toISOString() },
        { onConflict: 'owner_id,assignment_id' }
      )
      res.status(502).json({ success: false, error: 'AI 回傳格式無法解析、請重試一次' })
      return
    }

    // 6. 寫入 assignment_summaries
    const { error: readyUpsertErr } = await supabaseDb
      .from('assignment_summaries')
      .upsert(
        {
          owner_id: user.id,
          assignment_id: assignmentId,
          status: 'ready',
          class_summary: parsed.class_summary || null,
          class_suggestion: parsed.class_suggestion || null,
          minority_summary: parsed.minority_summary || null,
          minority_suggestion: parsed.minority_suggestion || null,
          student_summaries: Array.isArray(parsed.student_summaries) ? parsed.student_summaries : [],
          error_groups: Array.isArray(parsed.error_groups) ? parsed.error_groups : [],
          sample_count: sampleCount,
          error_message: null,
          generated_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        { onConflict: 'owner_id,assignment_id' }
      )

    if (readyUpsertErr) {
      console.error(`${logPrefix} ready upsert failed`, getErrorDiagnostics(readyUpsertErr))
      throw wrapError(
        `ready_upsert_failed: ${readyUpsertErr.message || 'unknown'}`,
        readyUpsertErr
      )
    }

    console.log(`${logPrefix} done`)
    res.status(200).json({ success: true, status: 'ready' })

  } catch (err) {
    console.error(`${logPrefix} error`, getErrorDiagnostics(err))
    const errMsg = err instanceof Error ? err.message : String(err)
    await supabaseDb
      .from('assignment_summaries')
      .upsert(
        {
          owner_id: user.id,
          assignment_id: assignmentId,
          status: 'failed',
          error_message: errMsg,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'owner_id,assignment_id' }
      )
    res.status(500).json({ success: false, error: errMsg })
  }
}

async function handleAssignmentStateSummary(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const rawIds = typeof req.query?.assignmentIds === 'string' ? req.query.assignmentIds.trim() : ''
  const assignmentIds = rawIds.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200)
  if (!assignmentIds.length) {
    res.status(200).json({ byAssignment: {} })
    return
  }

  const supabaseDb = getSupabaseAdmin()
  // Pull state rows + latest non-correction graded submissions in parallel so
  // we can attach an authoritative mistakeCount per (assignment, student).
  // Local Dexie gradingResult is local-first (teacher edits win), which can
  // leave stale mistake arrays after a server-side re-grade — the home
  // overview must rely on server data instead.
  const [stateResult, submissionsResult] = await Promise.all([
    supabaseDb
      .from('assignment_student_state')
      .select('assignment_id, student_id, status')
      .eq('owner_id', user.id)
      .in('assignment_id', assignmentIds),
    supabaseDb
      .from('submissions')
      // 2026-05-25: 只拉 grading_result 內的 mistakes + details 兩個 sub-array、
      // 不拉整顆 JSONB（_internal / cropByQuestionId 等大欄位都跳過）。
      // parseMistakesFromGradingResult 只用這兩段、剛好相容。
      // home overview 每次開都打、200 assignments × 30 students = 6000 row、省的量大
      .select('assignment_id, student_id, mistakes:grading_result->mistakes, details:grading_result->details, graded_at, updated_at, source, status')
      .eq('owner_id', user.id)
      .in('assignment_id', assignmentIds)
      .neq('source', 'student_correction')
      .eq('status', 'graded')
  ])

  if (stateResult.error) {
    res.status(500).json({ error: stateResult.error.message })
    return
  }
  if (submissionsResult.error) {
    res.status(500).json({ error: submissionsResult.error.message })
    return
  }

  const latestByKey = new Map()
  for (const row of submissionsResult.data || []) {
    const key = `${row.assignment_id}|${row.student_id}`
    const rankedAt = toNumber(row.graded_at) ?? toMillis(row.updated_at) ?? 0
    const existing = latestByKey.get(key)
    if (!existing || rankedAt >= existing.rankedAt) {
      latestByKey.set(key, { row, rankedAt })
    }
  }

  const byAssignment = {}
  for (const row of stateResult.data || []) {
    if (!byAssignment[row.assignment_id]) byAssignment[row.assignment_id] = []
    const key = `${row.assignment_id}|${row.student_id}`
    const entry = latestByKey.get(key)
    // 2026-05-25: sub-path 取回的 mistakes / details 已經是頂層欄位、組回去給 parser 用
    const mistakeCount = entry
      ? parseMistakesFromGradingResult({
          mistakes: entry.row.mistakes,
          details: entry.row.details
        }).length
      : null
    byAssignment[row.assignment_id].push({
      studentId: row.student_id,
      status: row.status,
      mistakeCount
    })
  }

  res.status(200).json({ byAssignment })
}

// ─────────────────────────────────────────────────────────
// handleCorrectionHistory
// GET /api/data/correction-history?studentId=xxx
// 回傳該學生跨作業的訂正歷程 raw 資料、由 frontend 自行 join 成 timeline
// ─────────────────────────────────────────────────────────
async function handleCorrectionHistory(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const studentId = typeof req.query?.studentId === 'string' ? req.query.studentId.trim() : ''
  if (!studentId) {
    res.status(400).json({ error: 'Missing studentId' })
    return
  }

  const supabaseDb = getSupabaseAdmin()

  const [studentResult, stateResult, attemptResult, itemResult] = await Promise.all([
    supabaseDb
      .from('students')
      .select('id, classroom_id, seat_number, name')
      .eq('owner_id', user.id)
      .eq('id', studentId)
      .maybeSingle(),
    supabaseDb
      .from('assignment_student_state')
      .select(
        'assignment_id, status, correction_attempt_count, correction_attempt_limit, last_status_reason, last_activity_at, updated_at'
      )
      .eq('owner_id', user.id)
      .eq('student_id', studentId),
    supabaseDb
      .from('correction_attempt_logs')
      .select(
        'assignment_id, attempt_no, submission_id, result_status, wrong_question_count, created_at'
      )
      .eq('owner_id', user.id)
      .eq('student_id', studentId)
      .order('assignment_id')
      .order('attempt_no'),
    supabaseDb
      .from('correction_question_items')
      .select(
        'assignment_id, attempt_no, question_id, question_text, mistake_reason, hint_text, status, accessor_result, dispute_note, dispute_rejected_at, dispute_rejection_note, created_at, updated_at'
      )
      .eq('owner_id', user.id)
      .eq('student_id', studentId)
      .order('assignment_id')
      .order('question_id')
      .order('attempt_no')
  ])

  if (studentResult.error) {
    res.status(500).json({ error: studentResult.error.message }); return
  }
  if (!studentResult.data) {
    res.status(404).json({ error: 'Student not found' }); return
  }
  if (stateResult.error) { res.status(500).json({ error: stateResult.error.message }); return }
  if (attemptResult.error) { res.status(500).json({ error: attemptResult.error.message }); return }
  if (itemResult.error) { res.status(500).json({ error: itemResult.error.message }); return }

  const assignmentIds = Array.from(
    new Set([
      ...(stateResult.data || []).map((r) => r.assignment_id),
      ...(attemptResult.data || []).map((r) => r.assignment_id),
      ...(itemResult.data || []).map((r) => r.assignment_id)
    ])
  ).filter(Boolean)

  // 補抓 round-0 grading_result.mistakes：cqi 不會在原批改時就建、只在學生被標錯
  // 後才建。學生第一次訂正就全對的 case 會有 attempts > 0 但 cqi = 0、timeline
  // 完全空。從 round-0 mistakes 合成 fake cqi (attempt_no=0、resolved) 補回起點 + 訂正紀錄。
  const cqiAssignmentIds = new Set((itemResult.data || []).map((r) => r.assignment_id))
  const needSynthesisAssignmentIds = assignmentIds.filter((aid) => !cqiAssignmentIds.has(aid))
  const synthesizedItems = []
  if (needSynthesisAssignmentIds.length > 0) {
    const { data: round0Subs, error: round0Err } = await supabaseDb
      .from('submissions')
      .select('assignment_id, grading_result')
      .eq('owner_id', user.id)
      .eq('student_id', studentId)
      .eq('round', 0)
      .in('assignment_id', needSynthesisAssignmentIds)
    if (round0Err) { res.status(500).json({ error: round0Err.message }); return }
    for (const sub of round0Subs || []) {
      const mistakes = Array.isArray(sub.grading_result?.mistakes) ? sub.grading_result.mistakes : []
      for (const m of mistakes) {
        if (!m?.id) continue
        synthesizedItems.push({
          assignment_id: sub.assignment_id,
          attempt_no: 0,
          question_id: String(m.id),
          question_text: m.question || null,
          mistake_reason: m.reason || null,
          hint_text: null,
          status: 'resolved',
          accessor_result: null,
          dispute_note: null,
          dispute_rejected_at: null,
          dispute_rejection_note: null,
          created_at: null,
          updated_at: null,
          __synthesized: true
        })
      }
    }
  }

  let assignmentRows = []
  if (assignmentIds.length > 0) {
    const { data, error } = await supabaseDb
      .from('assignments')
      .select('id, classroom_id, title, domain, created_at')
      .eq('owner_id', user.id)
      .in('id', assignmentIds)
    if (error) { res.status(500).json({ error: error.message }); return }
    assignmentRows = data || []
  }

  res.status(200).json({
    student: {
      id: studentResult.data.id,
      classroomId: studentResult.data.classroom_id,
      seatNumber: studentResult.data.seat_number,
      name: studentResult.data.name
    },
    assignments: assignmentRows.map((a) => ({
      id: a.id,
      classroomId: a.classroom_id,
      title: a.title,
      domain: a.domain,
      createdAt: a.created_at
    })),
    states: (stateResult.data || []).map((r) => ({
      assignmentId: r.assignment_id,
      status: r.status,
      correctionAttemptCount: r.correction_attempt_count,
      correctionAttemptLimit: r.correction_attempt_limit,
      lastStatusReason: r.last_status_reason,
      lastActivityAt: r.last_activity_at,
      updatedAt: r.updated_at
    })),
    attempts: (attemptResult.data || []).map((r) => ({
      assignmentId: r.assignment_id,
      attemptNo: r.attempt_no,
      submissionId: r.submission_id,
      resultStatus: r.result_status,
      wrongQuestionCount: r.wrong_question_count,
      createdAt: r.created_at
    })),
    questionItems: ([...(itemResult.data || []), ...synthesizedItems]).map((r) => {
      const accessor = r.accessor_result && typeof r.accessor_result === 'object' ? r.accessor_result : null
      return {
        assignmentId: r.assignment_id,
        attemptNo: r.attempt_no,
        questionId: r.question_id,
        questionText: r.question_text,
        mistakeReason: r.mistake_reason,
        hintText: r.hint_text,
        status: r.status,
        cropImageUrl: typeof accessor?.crop_image_url === 'string' ? accessor.crop_image_url : null,
        sourceSubmissionId: typeof accessor?.source_submission_id === 'string' ? accessor.source_submission_id : null,
        sourceImageUrl: typeof accessor?.source_image_url === 'string' ? accessor.source_image_url : null,
        answerBbox: accessor?.answer_bbox ?? null,
        disputeNote: r.dispute_note,
        disputeRejectedAt: r.dispute_rejected_at,
        disputeRejectionNote: r.dispute_rejection_note,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }
    })
  })
}


// ─────────────────────────────────────────────────────────
// handleUpsertAi3ForensicLog
// POST /api/data/upsert-ai3-forensic-log
// ─────────────────────────────────────────────────────────
// handleQualityCheckLog
// POST /api/data/quality-check-log
// Frontend posts quality-check results after batch Phase A so they appear in Vercel logs.
// ─────────────────────────────────────────────────────────
async function handleQualityCheckLog(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const body = parseJsonBody(req)
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'Invalid JSON body' })
    return
  }

  const assignmentId = typeof body.assignmentId === 'string' ? body.assignmentId.trim() : '(unknown)'
  const totalSubmissions = Number(body.totalSubmissions) || 0
  const flaggedCount = Number(body.flaggedCount) || 0
  const flags = Array.isArray(body.flags) ? body.flags : []

  console.log(`[QualityCheck] assignmentId=${assignmentId} total=${totalSubmissions} flagged=${flaggedCount}`)

  for (const flag of flags) {
    const sid = flag.submissionId ?? '?'
    const studentId = flag.studentId ?? '?'
    const conditions = Array.isArray(flag.conditions) ? flag.conditions.join(',') : '?'
    const detail = flag.detail ?? {}
    const parts = []
    if (detail.consecutiveBlankMax != null) parts.push(`consecutiveBlanks=${detail.consecutiveBlankMax}`)
    if (detail.typeMismatchCount != null) parts.push(`typeMismatch=${detail.typeMismatchCount}`)
    if (Array.isArray(detail.typeMismatchDetails) && detail.typeMismatchDetails.length > 0) {
      const summary = detail.typeMismatchDetails
        .map((d) => `${d.questionId}(expected=${d.expected},got=${d.got})`)
        .join(' ')
      parts.push(`mismatchDetails=[${summary}]`)
    }
    if (Array.isArray(detail.abcdMismatchDetails) && detail.abcdMismatchDetails.length > 0) {
      const summary = detail.abcdMismatchDetails
        .map((d) => `${d.questionId}(got=${d.got})`)
        .join(' ')
      parts.push(`abcdMismatch=[${summary}]`)
    }
    console.log(`[QualityCheck] FLAGGED submission=${sid} student=${studentId} conditions=[${conditions}] ${parts.join(' ')}`)
  }

  res.status(200).json({ ok: true, flaggedCount })
}

// Called after Phase A completes; inserts one row per question per submission.
// ─────────────────────────────────────────────────────────
async function handleUpsertAi3ForensicLog(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const body = parseJsonBody(req)
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) {
    res.status(400).json({ error: 'rows is required' })
    return
  }
  const now = new Date().toISOString()
  const dbRows = rows.map((r) => ({
    owner_id: user.id,
    assignment_id: ensureStr(r.assignmentId),
    student_id: ensureStr(r.studentId),
    submission_id: ensureStr(r.submissionId),
    question_id: ensureStr(r.questionId),
    question_type: ensureStr(r.questionType),
    ai1_answer: r.ai1Answer ?? null,
    ai1_status: r.ai1Status ?? null,
    ai2_answer: r.ai2Answer ?? null,
    ai2_status: r.ai2Status ?? null,
    consistency_status: r.consistencyStatus ?? null,
    forensic_mode: r.forensicMode ?? null,
    agreement_support: r.agreementSupport ?? null,
    ai1_support: r.ai1Support ?? null,
    ai2_support: r.ai2Support ?? null,
    system_decision: ensureStr(r.systemDecision),
    auto_confirmed_answer: r.autoConfirmedAnswer ?? null,
    updated_at: now,
  }))
  try {
    const supabaseDb = getSupabaseAdmin()
    const { error } = await supabaseDb
      .from('ai3_forensic_log')
      .upsert(dbRows, { onConflict: 'owner_id,submission_id,question_id' })
    if (error) {
      console.error('[upsert-ai3-forensic-log] supabase error:', error)
      res.status(500).json({ error: error.message })
      return
    }
    res.status(200).json({ ok: true, count: dbRows.length })
  } catch (err) {
    console.error('[upsert-ai3-forensic-log] error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
}

// ─────────────────────────────────────────────────────────
// handleUpdateAi3ForensicLog
// POST /api/data/update-ai3-forensic-log
// Called after Phase B completes per submission; updates teacher decision + Phase B results.
// ─────────────────────────────────────────────────────────
async function handleUpdateAi3ForensicLog(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  const body = parseJsonBody(req)
  const rows = Array.isArray(body.rows) ? body.rows : []
  if (rows.length === 0) {
    res.status(400).json({ error: 'rows is required' })
    return
  }
  const now = new Date().toISOString()
  // Build update patch per row using individual UPDATE calls
  try {
    const supabaseDb = getSupabaseAdmin()
    for (const r of rows) {
      const patch = {
        final_answer: r.finalAnswer ?? null,
        final_answer_source: r.finalAnswerSource ?? null,
        teacher_review_pick: r.teacherReviewPick ?? null,
        reviewed_at: r.reviewedAt ?? null,
        phase_b_is_correct: r.phaseBIsCorrect ?? null,
        phase_b_score: r.phaseBScore ?? null,
        phase_b_max_score: r.phaseBMaxScore ?? null,
        graded_at: r.gradedAt ?? null,
        updated_at: now,
      }
      const { error } = await supabaseDb
        .from('ai3_forensic_log')
        .update(patch)
        .eq('owner_id', user.id)
        .eq('submission_id', ensureStr(r.submissionId))
        .eq('question_id', ensureStr(r.questionId))
      if (error) {
        console.error('[update-ai3-forensic-log] supabase error:', error)
      }
    }
    res.status(200).json({ ok: true, count: rows.length })
  } catch (err) {
    console.error('[update-ai3-forensic-log] error:', err)
    res.status(500).json({ error: 'Internal Server Error' })
  }
}

function ensureStr(val) {
  return typeof val === 'string' ? val.trim() : String(val ?? '')
}
