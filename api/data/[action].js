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
const HOMEWORK_IMAGES_BUCKET = 'homework-images'
const STUDENT_CORRECTION_MODEL =
  getEnvValue('STUDENT_CORRECTION_MODEL') ||
  getEnvValue('SYSTEM_GEMINI_MODEL') ||
  'gemini-3-flash-preview'

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

async function fetchExistingUpdatedMap(supabaseDb, tableName, ids, ownerId) {
  if (ids.length === 0) return new Map()
  const result = await supabaseDb
    .from(tableName)
    .select('id, updated_at')
    .eq('owner_id', ownerId)
    .in('id', ids)
  if (result.error) {
    throw new Error(result.error.message)
  }
  return new Map(
    (result.data || []).map((row) => [row.id, toMillis(row.updated_at)])
  )
}

async function fetchDeletedSet(supabaseDb, tableName, ids, ownerId) {
  if (ids.length === 0) return new Set()
  const result = await supabaseDb
    .from('deleted_records')
    .select('record_id')
    .eq('owner_id', ownerId)
    .eq('table_name', tableName)
    .in('record_id', ids)
  if (result.error) {
    throw new Error(result.error.message)
  }
  return new Set((result.data || []).map((row) => row.record_id))
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
    mistakes.push({
      questionId: questionId || questionText || `Q${mistakes.length + 1}`,
      questionText: questionText || questionId || '',
      reason: reason || '需要再次確認作答內容',
      hintText: String(reason || ''),
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
    mistakes.push({
      questionId,
      questionText: questionId,
      reason,
      hintText: String(reason || ''),
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

async function applySubmissionStateTransitions(supabaseDb, ownerId, submissionRows) {
  if (!Array.isArray(submissionRows) || submissionRows.length === 0) return

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
      continue
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
          preferPreviousAccessor: true
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

  const recheckResult = await runRecheckPipeline({
    apiKey,
    model: STUDENT_CORRECTION_MODEL,
    correctionImages,
    correctionItems: itemsWithAnswers,
    requestId: submission.id
  })

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
    const { data: source, error: findErr } = await supabaseDb
      .from('answer_key_templates')
      .select('id, name, domain, doc_type, folder, answer_key, question_count, total_score')
      .eq('share_code', shareCode)
      .maybeSingle()

    if (findErr) throw new Error(findErr.message)
    if (!source) { res.status(404).json({ error: '找不到此分享碼的答案卷' }); return }

    // 產生新的短碼給複製品
    const newShareCode = 'AK-' + Math.random().toString(36).substring(2, 8).toUpperCase()
    const newId = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
    const nowIso = new Date().toISOString()

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
        shareCode: newShareCode,
        questionCount: source.question_count,
        totalScore: source.total_score
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
      const { error } = await supabaseDb
        .from('submissions')
        .update(compactObject({
          status: 'graded',
          score: toNumber(sub.score) ?? undefined,
          ai_score: toNumber(sub.aiScore) ?? undefined,
          score_source: sub.scoreSource ?? 'ai',
          grading_result: sub.gradingResult ?? undefined,
          graded_at: sub.gradedAt ?? Date.now(),
          updated_at: new Date().toISOString()
        }))
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
        updated_at: new Date().toISOString()
      })
      .eq('assignment_id', assignmentId)
      .eq('owner_id', user.id)
      .not('grading_result', 'is', null)
    if (error) throw new Error(error.message)
    console.log(`✅ [clear-grading] 已清除 assignment=${assignmentId} 的批改結果`)
    res.status(200).json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '清除失敗' })
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

    if (!existing) {
      // 建一筆 stub submission，讓 sync 能把 graded 狀態帶回前端
      const { randomUUID } = await import('node:crypto')
      const { error: insertErr } = await supabaseDb.from('submissions').insert({
        id: randomUUID(),
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

    await upsertAssignmentStudentState(supabaseDb, user.id, assignmentId, studentId, {
      status: 'graded',
      graded_once: true,
      upload_locked: true,
      last_status_reason: 'teacher_manual_grade'
    })
    res.status(200).json({ success: true, newStatus: 'graded' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '手動標記失敗' })
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
    // Resolve all open/disputed correction items for this student
    const { error: updateError } = await supabaseDb
      .from('correction_question_items')
      .update({ status: 'resolved', updated_at: now })
      .eq('owner_id', user.id)
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .in('status', ['open', 'disputed'])
    if (updateError) throw new Error(updateError.message)
    // Mark correction as passed
    await upsertAssignmentStudentState(supabaseDb, user.id, assignmentId, studentId, {
      status: 'correction_passed',
      last_status_reason: 'teacher_manual_pass'
    })
    res.status(200).json({ success: true, newStatus: 'correction_passed' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '手動通過訂正失敗' })
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
        supabaseDb
          .from('submissions')
          .select('id, assignment_id, student_id, status, created_at, image_url, thumb_url, score, ai_score, score_source, feedback, graded_at, correction_count, source, round, parent_submission_id, actor_user_id, updated_at, grading_result')
          .eq('owner_id', ownerId),
        supabaseDb.from('folders').select('*').eq('owner_id', ownerId),
        supabaseDb.from('gradebook_custom_columns').select('*').eq('owner_id', ownerId),
        supabaseDb.from('gradebook_custom_scores').select('*').eq('owner_id', ownerId),
        supabaseDb.from('answer_key_templates').select('*').eq('owner_id', ownerId),
        supabaseDb
          .from('deleted_records')
          .select('table_name, record_id, deleted_at')
          .eq('owner_id', ownerId)
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
        gradebook_custom_scores: []
      }
      const deletedSets = {
        classrooms: new Set(),
        students: new Set(),
        assignments: new Set(),
        submissions: new Set(),
        folders: new Set(),
        gradebook_custom_columns: new Set(),
        gradebook_custom_scores: new Set()
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
          updatedAt: updatedAt ?? undefined
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
        answerKeyTemplates,
        deleted,
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
              const [assignmentExistsResult, studentExistsResult] = await Promise.all([
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
                  .limit(1)
              ])

              if (assignmentExistsResult.error) {
                throw new Error(assignmentExistsResult.error.message)
              }
              if (studentExistsResult.error) {
                throw new Error(studentExistsResult.error.message)
              }

              const assignmentExists = Array.isArray(assignmentExistsResult.data) && assignmentExistsResult.data.length > 0
              const studentExists = Array.isArray(studentExistsResult.data) && studentExistsResult.data.length > 0
              if (!assignmentExists || !studentExists) {
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
      const incomingTemplates = Array.isArray(body.answerKeyTemplates)
        ? body.answerKeyTemplates.filter((t) => t?.id && t?.answerKey)
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
          updated_at: toIsoTimestamp(t.updatedAt ?? t.updated_at) ?? nowIso
        }))
        const tplResult = await supabaseDb
          .from('answer_key_templates')
          .upsert(templateRows, { onConflict: 'id' })
        if (tplResult.error) {
          console.error('[SYNC] answer_key_templates upsert failed:', tplResult.error.message)
        } else {
          console.log(`✅ [SYNC] 同步了 ${templateRows.length} 個答案卷模板`)
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
      const [deletedSubmissionSet, existingSubmissionResult] = await Promise.all([
        fetchDeletedSet(supabaseDb, 'submissions', incomingSubmissionIds, user.id),
        incomingSubmissionIds.length > 0
          ? supabaseDb
              .from('submissions')
              .select('id, status, graded_at, updated_at')
              .eq('owner_id', user.id)
              .in('id', incomingSubmissionIds)
          : Promise.resolve({ data: [], error: null })
      ])

      if (existingSubmissionResult.error) {
        throw new Error(existingSubmissionResult.error.message)
      }

      const existingSubmissionMap = new Map(
        (existingSubmissionResult.data || []).map((row) => [row.id, row])
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

        submissionRows.push(
          compactObject({
            id: s.id,
            assignment_id: s.assignmentId,
            student_id: s.studentId,
            status: s.status ?? undefined,
            image_url: imageUrl,
            thumb_url: thumbUrl,
            source: s.source ?? undefined,
            // submissions.round 為 NOT NULL，任何缺值都回補 0
            round: normalizedRound,
            parent_submission_id: s.parentSubmissionId ?? s.parent_submission_id ?? undefined,
            actor_user_id: s.actorUserId ?? s.actor_user_id ?? undefined,
            created_at: createdAt ?? undefined,
            // score 和 grading_result.totalScore 連動：有 totalScore 時強制同步
            score: (() => {
              const grTotal = toNumber(s.gradingResult?.totalScore)
              return grTotal ?? toNumber(s.score) ?? undefined
            })(),
            ai_score: (() => {
              const grTotal = toNumber(s.gradingResult?.totalScore)
              return grTotal ?? toNumber(s.aiScore ?? s.ai_score) ?? undefined
            })(),
            score_source: (s.scoreSource ?? s.score_source) || undefined,
            feedback: s.feedback ?? undefined,
            grading_result: s.gradingResult ?? undefined,
            graded_at: Number.isFinite(incomingGradedAt) ? incomingGradedAt : undefined,
            correction_count: toNumber(s.correctionCount) ?? undefined,
            owner_id: user.id,
            // authoritative timestamp: always generated on server side
            updated_at: nowIso
          })
        )
      }

      if (incomingSubmissions.length > 0) {
        console.log(
          `📝 [sync] upsert submissions count=${submissionRows.length} (incoming=${incomingSubmissions.length} stale=${skippedSubmissionStaleCount} deleted=${skippedSubmissionDeletedCount})`
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
        // 只對「server 上還沒有 grading_result 但 incoming 有」的 submissions 跑 state transitions
        // 這代表是本地新批改的，需要更新 assignment_student_state
        // 排除：server 上已經有 grading_result 的（只是重複 push 同樣的資料）
        const existingGradedIds = new Set()
        try {
          const submissionIds = submissionRows.map(r => r.id).filter(Boolean)
          if (submissionIds.length > 0) {
            const { data: existingRows } = await supabaseDb
              .from('submissions')
              .select('id')
              .in('id', submissionIds)
              .not('grading_result', 'is', null)
            if (existingRows) existingRows.forEach(r => existingGradedIds.add(r.id))
          }
        } catch { /* non-fatal */ }
        const stateTransitionRows = submissionRows.filter(
          (row) => (row.grading_result && !existingGradedIds.has(row.id)) || row.source === 'student_correction'
        )
        console.log(`⏱️ [sync] stateTransitionRows: ${stateTransitionRows.length}/${submissionRows.length} (existingGraded=${existingGradedIds.size})`)
        if (stateTransitionRows.length > 0) {
          await applySubmissionStateTransitions(supabaseDb, user.id, stateTransitionRows).catch(
            (err) => console.warn('[sync] applySubmissionStateTransitions failed (non-fatal):', err?.message)
          )
        }
        syncTimerEnd('submissions-transitions')
      }

      syncTimerEnd('submissions')

      const touchedAssignments = new Set(
        submissionRows
          .filter((row) => row.assignment_id)
          .filter((row) => row.grading_result !== undefined || row.status === 'graded')
          .map((row) => row.assignment_id)
      )

      if (touchedAssignments.size > 0) {
        await touchAssignmentTagStates(
          supabaseDb,
          user.id,
          Array.from(touchedAssignments)
        )
      }

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
      thumbContentType
    } = body || {}

    if (!submissionId || !assignmentId || !studentId || !createdAt || !imageBase64) {
      res.status(400).json({ error: 'Missing required fields' })
      return
    }

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
          source: 'teacher_scan',
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
            .select('id, title, total_pages, student_show_score, updated_at')
            .eq('owner_id', cOwnerId)
            .eq('classroom_id', classroomId)
            .order('created_at', { ascending: false })
        ])
        if (assignmentsResult.error) throw new Error(assignmentsResult.error.message)

        const aIds = (assignmentsResult.data || []).map((a) => a.id)

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
                .select('id, assignment_id, score, graded_at, created_at, updated_at, source, grading_result, image_url, status')
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
          const fallbackCorrections =
            openCorrections.length === 0 && isCorrectionStatus && latestGradedSubmission?.grading_result
              ? parseMistakesFromGradingResult(latestGradedSubmission.grading_result).map((mistake) =>
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

          return compactObject({
            id: assignment.id,
            classroomName,
            classroomKey,
            title: assignment.title,
            totalPages: assignment.total_pages,
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

  if (!assignmentId || !normalizedImagePayload) {
    res.status(400).json({ error: 'Missing required fields' })
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

    const selectedContextFromKey = classroomKey
      ? studentContexts.find((context) => buildStudentClassroomKey(context) === classroomKey)
      : null
    if (classroomKey && !selectedContextFromKey) {
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
      res.status(403).json({ error: 'Forbidden assignment access' })
      return
    }

    const ownerId = studentContext.ownerId
    const preferences = await getTeacherPreferences(supabaseDb, ownerId)
    if (!preferences.student_portal_enabled) {
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

    const submissionId = generateSubmissionId()
    const { filePath, thumbFilePath } = await uploadSubmissionAssets(
      supabaseDb,
      submissionId,
      imageBase64,
      contentType,
      thumbBase64,
      thumbContentType
    )

    // 未批改前可覆蓋舊作業
    const { data: latestSubmissionRows, error: latestSubmissionError } = await supabaseDb
      .from('submissions')
      .select('id, graded_at')
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
  if (action === 'clear-grading') {
    await handleClearGrading(req, res)
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
  if (action === 'correction-manual-pass') {
    await handleCorrectionManualPass(req, res)
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
  res.status(404).json({ error: 'Not Found' })
}

// ─────────────────────────────────────────────────────────
// handleGetConceptMap
// GET /api/data/concept-map?grade=X
// ─────────────────────────────────────────────────────────
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
  try {
    const supabaseDb = getSupabaseAdmin()
    const { data, error } = await supabaseDb
      .from('concept_map')
      .select('code, label, description')
      .eq('grade', grade)
      .order('code', { ascending: true })
    if (error) {
      console.error('[concept-map] supabase error:', error)
      res.status(500).json({ error: 'DB error' })
      return
    }
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
  const { data, error } = await supabaseDb
    .from('assignment_summaries')
    .select('status, class_summary, class_suggestion, minority_summary, minority_suggestion, student_summaries, error_groups, sample_count, updated_at, error_message')
    .eq('owner_id', user.id)
    .eq('assignment_id', assignmentId)
    .maybeSingle()
  if (error) {
    res.status(500).json({ error: error.message })
    return
  }
  res.status(200).json({ summary: data ?? null })
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
    const { data: assignment, error: assignmentErr } = await supabaseDb
      .from('assignments')
      .select('answer_key')
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

    // 3b. 嘗試從 Supabase Storage 取得答案卷圖片（給 AI 看題目內容）
    const answerSheetImages = []
    try {
      for (let i = 0; i < 10; i++) {
        const path = `answer-sheets/${assignmentId}/page-${i}.webp`
        const { data: imgData, error: imgErr } = await supabaseDb.storage
          .from('homework-images').download(path)
        if (imgErr || !imgData) break
        const buffer = Buffer.from(await imgData.arrayBuffer())
        answerSheetImages.push({ mimeType: 'image/webp', data: buffer.toString('base64') })
      }
      if (answerSheetImages.length > 0) {
        console.log(`${logPrefix} fetched ${answerSheetImages.length} answer sheet image(s) for multimodal summary`)
      }
    } catch (imgFetchErr) {
      console.warn(`${logPrefix} answer sheet image fetch failed (non-fatal):`, imgFetchErr?.message || imgFetchErr)
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

    const summaryModel = getEnvValue('SYSTEM_GEMINI_MODEL') || 'gemini-3-flash-preview'
    const SUMMARY_TIMEOUT_MS = 120_000
    // 組合 multimodal parts：圖片（若有）+ 文字 prompt
    const summaryParts = []
    for (let i = 0; i < answerSheetImages.length; i++) {
      summaryParts.push({ text: `--- 作業原卷第 ${i + 1} 頁 ---` })
      summaryParts.push({ inlineData: answerSheetImages[i] })
    }
    summaryParts.push({ text: prompt })

    const pipelineResult = await Promise.race([
      runAiPipeline({
        apiKey,
        model: summaryModel,
        contents: [{ role: 'user', parts: summaryParts }],
        requestedRouteKey: 'report.teacher_summary',
        routeHint: { source: 'data' }
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('summary_generation_timeout: exceeded 240s')), SUMMARY_TIMEOUT_MS)
      )
    ])

    const ok = Number(pipelineResult.status) >= 200 && Number(pipelineResult.status) < 300
    if (!ok) {
      console.error(`${logPrefix} runAiPipeline failed`, {
        status: pipelineResult.status,
        routeKey: pipelineResult.data?.routeKey,
        pipeline: pipelineResult.data?._pipeline
      })
      throw wrapError(`gemini_call_failed: status=${pipelineResult.status}`)
    }

    const rawText = pipelineResult.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
    const cleanText = rawText.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(cleanText)

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
  const { data, error } = await supabaseDb
    .from('assignment_student_state')
    .select('assignment_id, student_id, status')
    .eq('owner_id', user.id)
    .in('assignment_id', assignmentIds)

  if (error) {
    res.status(500).json({ error: error.message })
    return
  }

  const byAssignment = {}
  for (const row of data || []) {
    if (!byAssignment[row.assignment_id]) byAssignment[row.assignment_id] = []
    byAssignment[row.assignment_id].push({ studentId: row.student_id, status: row.status })
  }

  res.status(200).json({ byAssignment })
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
