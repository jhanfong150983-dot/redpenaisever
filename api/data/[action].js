import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'
import { getEnvValue } from '../../server/_env.js'
import { runAiPipeline } from '../../server/ai/orchestrator.js'
import { AI_ROUTE_KEYS } from '../../server/ai/routes.js'
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
  notification_enabled: true,
  notification_channel: 'in_app',
  notification_events: {
    submission_uploaded: true,
    grading_completed: true,
    correction_dispatched: true,
    correction_submitted: true,
    correction_limit_reached: true,
    correction_due_reminder: true
  },
  correction_dispatch_mode: 'manual',
  correction_due_at: null,
  student_feedback_visibility: 'score_reason',
  notification_digest: 'instant',
  quiet_hours_enabled: false,
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00'
}

const TEACHER_PREFERENCES_BASE_SELECT =
  'owner_id, student_portal_enabled, show_score_to_students, max_correction_attempts, lock_upload_after_graded, require_full_page_count'

const TEACHER_PREFERENCES_EXTENDED_SELECT =
  `${TEACHER_PREFERENCES_BASE_SELECT}, notification_enabled, notification_channel, notification_events, correction_dispatch_mode, correction_due_at, student_feedback_visibility, notification_digest, quiet_hours_enabled, quiet_hours_start, quiet_hours_end`

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

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  )
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

function sanitizeHintText(rawReason = '') {
  const text = String(rawReason || '').trim()
  if (!text) {
    return '作答內容與題目要求不一致。'
  }

  const buildGenericReasonFromReason = (sourceText) => {
    const base = String(sourceText || '')
    if (/重複|漏填|漏選|漏答|遺漏/.test(base)) {
      return '答案選取不完整或有重複，與題目要求不一致。'
    }
    if (/單位|公分|公斤|平方|cm|mm|m²|kg|g/i.test(base)) {
      return '數值與單位對應不一致。'
    }
    if (/計算|運算|加|減|乘|除|小數|四捨五入|等於/.test(base)) {
      return '計算結果與題目條件不一致。'
    }
    if (/題意|概念|條件|分類|判斷|理解/.test(base)) {
      return '作答與題意或分類條件不一致。'
    }
    if (/未作答|空白/.test(base)) {
      return '此題未完成作答。'
    }
    return '作答內容與題目要求不一致。'
  }

  const hasAnswerLeakRisk = (sourceText) => {
    const base = String(sourceText || '')
    if (!base) return false
    const patterns = [
      /正確答案|標準答案|答案是|答案為|正解|應該是|應為|應填|應選|才是/,
      /「[^」]{1,40}」\s*(?:才是|為|是)/,
      /『[^』]{1,40}』\s*(?:才是|為|是)/,
      /“[^”]{1,40}”\s*(?:才是|為|是)/,
      /漏(?:掉|選|填|答).{0,20}(?:「[^」]{1,40}」|『[^』]{1,40}』|“[^”]{1,40}”)/,
      /改(?:成|為).{0,20}(?:「[^」]{1,40}」|『[^』]{1,40}』|“[^”]{1,40}”)/,
      /符合該題定義/
    ]
    return patterns.some((pattern) => pattern.test(base))
  }

  // 避免直接洩漏答案
  const blockedPatterns = [
    /正確答案[^\n，。]*/g,
    /標準答案[^\n，。]*/g,
    /答案是[^\n，。]*/g,
    /答案為[^\n，。]*/g,
    /「[^」]{1,40}」\s*才是[^\n，。]*/g,
    /『[^』]{1,40}』\s*才是[^\n，。]*/g,
    /“[^”]{1,40}”\s*才是[^\n，。]*/g
  ]
  let sanitized = text
  for (const pattern of blockedPatterns) {
    sanitized = sanitized.replace(pattern, '').trim()
  }
  sanitized = sanitized
    .replace(/^(?:學生|同學|你|您|作答者)\s*/g, '')
    .replace(/^(?:誤將|誤把)\s*/g, '')
    .replace(/\s*(?:建議|請)\s*[^。；!！?？\n]*/g, '')
    .replace(/\s*(?:可再|可改|可參考|記得)\s*[^。；!！?？\n]*/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[，。；、\s]+/, '')
    .replace(/[，、\s]+$/, '')
    .trim()

  if (!sanitized || hasAnswerLeakRisk(text) || hasAnswerLeakRisk(sanitized)) {
    return buildGenericReasonFromReason(text)
  }

  const firstSentence = sanitized
    .split(/[。；;!?！？\n]/)
    .map((part) => part.trim())
    .filter(Boolean)[0]

  let core = String(firstSentence || '').trim()
  core = core.replace(/^(?:需注意|請注意|注意)\s*/, '').trim()
  core = core.replace(/[，、\s]+$/, '').trim()

  if (!core || hasAnswerLeakRisk(core)) {
    return buildGenericReasonFromReason(text)
  }

  return /[。！？]$/.test(core) ? core : `${core}。`
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
    const normalizedBbox =
      normalizeBboxForImage(answerBbox, imageWidth, imageHeight) ||
      normalizeBboxForImage(questionBbox, imageWidth, imageHeight)
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

function normalizeNotificationEvents(value) {
  const defaults = DEFAULT_TEACHER_PREFERENCES.notification_events
  const source = value && typeof value === 'object' ? value : {}
  return {
    submission_uploaded:
      typeof source.submission_uploaded === 'boolean'
        ? source.submission_uploaded
        : defaults.submission_uploaded,
    grading_completed:
      typeof source.grading_completed === 'boolean'
        ? source.grading_completed
        : defaults.grading_completed,
    correction_dispatched:
      typeof source.correction_dispatched === 'boolean'
        ? source.correction_dispatched
        : defaults.correction_dispatched,
    correction_submitted:
      typeof source.correction_submitted === 'boolean'
        ? source.correction_submitted
        : defaults.correction_submitted,
    correction_limit_reached:
      typeof source.correction_limit_reached === 'boolean'
        ? source.correction_limit_reached
        : defaults.correction_limit_reached,
    correction_due_reminder:
      typeof source.correction_due_reminder === 'boolean'
        ? source.correction_due_reminder
        : defaults.correction_due_reminder
  }
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
    notification_enabled:
      typeof data.notification_enabled === 'boolean'
        ? data.notification_enabled
        : DEFAULT_TEACHER_PREFERENCES.notification_enabled,
    notification_channel: normalizeEnum(
      data.notification_channel,
      ['in_app', 'email', 'both', 'none'],
      DEFAULT_TEACHER_PREFERENCES.notification_channel
    ),
    notification_events: normalizeNotificationEvents(data.notification_events),
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
    ),
    notification_digest: normalizeEnum(
      data.notification_digest,
      ['instant', 'daily'],
      DEFAULT_TEACHER_PREFERENCES.notification_digest
    ),
    quiet_hours_enabled:
      typeof data.quiet_hours_enabled === 'boolean'
        ? data.quiet_hours_enabled
        : DEFAULT_TEACHER_PREFERENCES.quiet_hours_enabled,
    quiet_hours_start: normalizeTimeString(
      data.quiet_hours_start,
      DEFAULT_TEACHER_PREFERENCES.quiet_hours_start
    ),
    quiet_hours_end: normalizeTimeString(
      data.quiet_hours_end,
      DEFAULT_TEACHER_PREFERENCES.quiet_hours_end
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

// ─── Notification helpers ────────────────────────────────────────────────────

function isInQuietHours(preferences) {
  if (!preferences.quiet_hours_enabled) return false
  const start = typeof preferences.quiet_hours_start === 'string'
    ? preferences.quiet_hours_start : '22:00'
  const end = typeof preferences.quiet_hours_end === 'string'
    ? preferences.quiet_hours_end : '07:00'
  const now = new Date()
  // Taiwan is UTC+8; approximate local minute-of-day
  const localMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60)
  const toMinutes = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const s = toMinutes(start)
  const e = toMinutes(end)
  return s <= e ? localMinutes >= s && localMinutes < e
    : localMinutes >= s || localMinutes < e
}

async function createTeacherNotification(supabaseDb, ownerId, event, data, preferences) {
  try {
    if (!preferences || !preferences.notification_enabled) return
    const events = preferences.notification_events || {}
    if (events[event] === false) return
    if (isInQuietHours(preferences)) return
    await supabaseDb
      .from('teacher_notifications')
      .insert({ owner_id: ownerId, event, data: data || {} })
  } catch {
    // notifications are non-critical; swallow errors silently
  }
}

// ─────────────────────────────────────────────────────────────────────────────

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
      hintText: sanitizeHintText(reason),
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
      hintText: sanitizeHintText(reason),
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

  const uniqueMistakes = []
  const seenQuestionIds = new Set()
  for (let index = 0; index < mistakes.length; index += 1) {
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
      const questionBbox = normalizeBbox(mistake.questionBbox)
      const answerBbox = normalizeBbox(mistake.answerBbox)
      const cropImageUrl = cropImageForQuestion
        ? await cropImageForQuestion({
            questionId,
            questionBbox,
            answerBbox
          })
        : null
      return {
        mistake,
        questionId,
        questionBbox,
        answerBbox,
        cropImageUrl: cropImageUrl || undefined
      }
    })
  )

  const rows = preparedMistakes.map(
    ({ mistake, questionId, questionBbox, answerBbox, cropImageUrl }, index) =>
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
          source_submission_id: sourceSubmissionId,
          source_image_url: sourceImageUrl,
          crop_image_url: cropImageUrl,
          question_bbox: questionBbox,
          answer_bbox: answerBbox
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

  const pendingNotifications = {
    grading_completed: [],
    correction_submitted: [],
    correction_limit_reached: []
  }

  for (const row of submissionRows) {
    const assignmentId = row.assignment_id
    const studentId = row.student_id
    if (!assignmentId || !studentId) continue
    const key = `${assignmentId}::${studentId}`
    const existingState = stateMap.get(key) || null
    const source = String(row.source || 'teacher_camera')
    const isGraded = row.graded_at !== undefined && row.graded_at !== null
      ? true
      : String(row.status || '').toLowerCase() === 'graded'

    if (!isGraded) {
      const nextState = await upsertAssignmentStudentState(
        supabaseDb,
        ownerId,
        assignmentId,
        studentId,
        {
          status: source === 'student_correction' ? 'correction_in_progress' : 'uploaded',
          current_submission_id: row.id,
          correction_attempt_limit:
            existingState?.correction_attempt_limit ??
            preferences.max_correction_attempts
        }
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
      correctionAttemptCount += 1
      if (!hasMistakes) {
        status = 'correction_passed'
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
        !hasMistakes
          ? 'pass'
          : status === 'correction_failed'
            ? 'failed'
            : 'retry',
        row.grading_result,
        mistakes.length
      )

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

    const nextState = await upsertAssignmentStudentState(
      supabaseDb,
      ownerId,
      assignmentId,
      studentId,
      compactObject({
        status,
        current_submission_id: row.id,
        last_graded_submission_id: row.id,
        graded_once: true,
        // 系統硬規則：一旦批改過即鎖定一般重交
        upload_locked: true,
        correction_attempt_count: correctionAttemptCount,
        correction_attempt_limit: correctionAttemptLimit,
        last_status_reason: lastStatusReason
      })
    )

    stateMap.set(key, nextState)

    // Collect notification event for batch processing after the loop
    if (source === 'student_correction') {
      if (status === 'correction_failed') {
        pendingNotifications.correction_limit_reached.push({ assignmentId, studentId })
      } else {
        pendingNotifications.correction_submitted.push({ assignmentId, studentId })
      }
    } else if (isGraded && existingState?.graded_once !== true) {
      pendingNotifications.grading_completed.push({ assignmentId, studentId })
    }
  }

  // Create aggregated notifications (one per assignment per event type)
  const allNotifAssignmentIds = [
    ...new Set(
      Object.values(pendingNotifications).flat().map((r) => r.assignmentId)
    )
  ]
  const assignmentTitleMap = new Map()
  if (allNotifAssignmentIds.length > 0) {
    const { data: assignmentRows } = await supabaseDb
      .from('assignments')
      .select('id, title')
      .eq('owner_id', ownerId)
      .in('id', allNotifAssignmentIds)
    for (const row of assignmentRows || []) {
      if (row.id && row.title) assignmentTitleMap.set(row.id, row.title)
    }
  }

  for (const [event, rows] of Object.entries(pendingNotifications)) {
    if (rows.length === 0) continue
    const byAssignment = new Map()
    for (const r of rows) {
      const list = byAssignment.get(r.assignmentId) || []
      list.push(r.studentId)
      byAssignment.set(r.assignmentId, list)
    }
    for (const [aId, sIds] of byAssignment.entries()) {
      await createTeacherNotification(
        supabaseDb, ownerId, event,
        {
          assignmentId: aId,
          assignmentTitle: assignmentTitleMap.get(aId) ?? undefined,
          count: sIds.length,
          studentIds: sIds
        },
        preferences
      )
    }
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
        .eq('status', 'open')
    ])

    if (studentsResult.error) throw new Error(studentsResult.error.message)
    if (statesResult.error) throw new Error(statesResult.error.message)
    if (correctionsResult.error) throw new Error(correctionsResult.error.message)

    const stateByStudentId = new Map()
    for (const row of statesResult.data || []) {
      stateByStudentId.set(row.student_id, row)
    }
    const openCountByStudentId = new Map()
    for (const row of correctionsResult.data || []) {
      if (!row.student_id) continue
      openCountByStudentId.set(
        row.student_id,
        (openCountByStudentId.get(row.student_id) || 0) + 1
      )
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
      const { error: updateError } = await supabaseDb
        .from('assignment_student_state')
        .update({
          status: 'graded',
          last_status_reason: '教師已停止訂正',
          updated_at: nowIso
        })
        .eq('owner_id', user.id)
        .eq('assignment_id', assignmentId)
        .in('status', ['correction_required', 'correction_in_progress'])
      if (updateError) throw new Error(updateError.message)

      const { error: closeError } = await supabaseDb
        .from('correction_question_items')
        .update({
          status: 'skipped',
          updated_at: nowIso
        })
        .eq('owner_id', user.id)
        .eq('assignment_id', assignmentId)
        .eq('status', 'open')
      if (closeError) throw new Error(closeError.message)

      res.status(200).json({
        success: true,
        dispatchActive: false
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

    if (enable && activatedCount > 0) {
      const dispatchPrefs = await getTeacherPreferences(supabaseDb, user.id)
      await createTeacherNotification(supabaseDb, user.id, 'correction_dispatched', {
        assignmentId,
        count: activatedCount
      }, dispatchPrefs)
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
        deletedResult
      ] = await Promise.all([
        supabaseDb.from('classrooms').select('*').eq('owner_id', ownerId),
        supabaseDb.from('students').select('*').eq('owner_id', ownerId),
        supabaseDb.from('assignments').select('*').eq('owner_id', ownerId),
        supabaseDb
          .from('submissions')
          .select('id, assignment_id, student_id, status, created_at, image_url, thumb_url, score, feedback, graded_at, correction_count, source, round, parent_submission_id, actor_user_id, updated_at')
          .eq('owner_id', ownerId),
        supabaseDb.from('folders').select('*').eq('owner_id', ownerId),
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
        folders: []
      }
      const deletedSets = {
        classrooms: new Set(),
        students: new Set(),
        assignments: new Set(),
        submissions: new Set(),
        folders: new Set()
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
            priorWeightTypes: row.prior_weight_types ?? undefined,
            answerKey: row.answer_key ?? undefined,
            updatedAt: toMillis(row.updated_at) ?? undefined
          })
        )

      const validAssignmentIds = new Set((assignmentsResult.data || [])
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
          feedback: row.feedback ?? undefined,
          gradingResult: row.grading_result ?? undefined,
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

      res.status(200).json({
        classrooms: classrooms.filter((row) => !deletedSets.classrooms.has(row.id)),
        students: students.filter((row) => !deletedSets.students.has(row.id)),
        assignments: assignments.filter((row) => !deletedSets.assignments.has(row.id)),
        submissions: submissions.filter((row) => !deletedSets.submissions.has(row.id)),
        folders: folders.filter((row) => !deletedSets.folders.has(row.id)),
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
    const deletedPayload =
      body.deleted && typeof body.deleted === 'object' ? body.deleted : {}
    
    console.log(`📥 [API] sync classrooms=${classrooms.length} students=${students.length} assignments=${assignments.length} submissions=${submissions.length} folders=${folders.length}`)

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

      const classroomRows = await buildUpsertRows(
        'classrooms',
        classrooms.filter((c) => c?.id),
        (c) =>
          compactObject({
            id: c.id,
            name: c.name,
            folder: c.folder,
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

      const assignmentRows = await buildUpsertRows(
        'assignments',
        assignments.filter((a) => a?.id && a?.classroomId),
        (a) =>
          compactObject({
            id: a.id,
            classroom_id: a.classroomId,
            title: a.title,
            total_pages: a.totalPages,
            domain: a.domain ?? undefined,
            folder: a.folder,
            prior_weight_types: a.priorWeightTypes ?? undefined,
            answer_key: a.answerKey ?? undefined,
            owner_id: user.id,
            updated_at: toIsoTimestamp(a.updatedAt ?? a.updated_at) ?? nowIso
          })
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

      const submissionRows = await buildUpsertRows(
        'submissions',
        submissions.filter((s) => s?.id && s?.assignmentId && s?.studentId),
        (s) => {
          const createdAt = toIsoTimestamp(s.createdAt)
          const gradedAt = toNumber(s.gradedAt)
          const normalizedRound = clampInteger(s.round, 0, 9999, 0)
          const imageUrl =
            s.imageUrl || s.image_url || `submissions/${s.id}.webp`
          const thumbUrl =
            s.thumbUrl ||
            s.thumb_url ||
            s.thumbnailUrl ||
            s.thumbnail_url ||
            `submissions/thumbs/${s.id}.webp`

          return compactObject({
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
            score: toNumber(s.score) ?? undefined,
            feedback: s.feedback ?? undefined,
            grading_result: s.gradingResult ?? undefined,
            graded_at: gradedAt ?? undefined,
            correction_count: toNumber(s.correctionCount) ?? undefined,
            owner_id: user.id,
            updated_at:
              toIsoTimestamp(s.updatedAt ?? s.updated_at) ??
              createdAt ??
              nowIso
          })
        }
      )

      if (submissionRows.length > 0) {
        // Batch upsert to avoid hitting Supabase request body size limits (large grading_result JSONs)
        const SUBMISSION_BATCH = 50
        for (let i = 0; i < submissionRows.length; i += SUBMISSION_BATCH) {
          const batch = submissionRows.slice(i, i + SUBMISSION_BATCH)
          const result = await supabaseDb
            .from('submissions')
            .upsert(batch, { onConflict: 'id' })
          if (result.error) throw new Error(result.error.message)
        }
        // applySubmissionStateTransitions may download/crop images — make it non-fatal during bulk sync
        await applySubmissionStateTransitions(supabaseDb, user.id, submissionRows).catch(
          (err) => console.warn('[sync] applySubmissionStateTransitions failed (non-fatal):', err?.message)
        )
      }

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

      res.status(200).json({ success: true })
    } catch (err) {
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

    // 插入新的 submission（使用 insert 而非 upsert）
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
      notification_enabled:
        typeof body.notificationEnabled === 'boolean'
          ? body.notificationEnabled
          : undefined,
      notification_channel:
        ['in_app', 'email', 'both', 'none'].includes(body.notificationChannel)
          ? body.notificationChannel
          : undefined,
      notification_events:
        body.notificationEvents && typeof body.notificationEvents === 'object'
          ? normalizeNotificationEvents(body.notificationEvents)
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
          : undefined,
      notification_digest:
        ['instant', 'daily'].includes(body.notificationDigest)
          ? body.notificationDigest
          : undefined,
      quiet_hours_enabled:
        typeof body.quietHoursEnabled === 'boolean'
          ? body.quietHoursEnabled
          : undefined,
      quiet_hours_start:
        body.quietHoursStart !== undefined
          ? normalizeTimeString(
              body.quietHoursStart,
              DEFAULT_TEACHER_PREFERENCES.quiet_hours_start
            )
          : undefined,
      quiet_hours_end:
        body.quietHoursEnd !== undefined
          ? normalizeTimeString(
              body.quietHoursEnd,
              DEFAULT_TEACHER_PREFERENCES.quiet_hours_end
            )
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

async function handleTeacherNotifications(req, res) {
  const { user } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const supabaseDb = getSupabaseAdmin()

  // GET: return unread notifications (latest 50)
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabaseDb
        .from('teacher_notifications')
        .select('id, event, data, is_read, created_at')
        .eq('owner_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw new Error(error.message)
      const unreadCount = (data || []).filter((n) => !n.is_read).length
      res.status(200).json({ notifications: data || [], unreadCount })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '讀取通知失敗' })
    }
    return
  }

  // POST: mark notifications as read
  if (req.method === 'POST') {
    try {
      const body = parseJsonBody(req)
      const ids = Array.isArray(body?.ids) ? body.ids.filter(Number.isFinite) : null
      const query = supabaseDb
        .from('teacher_notifications')
        .update({ is_read: true })
        .eq('owner_id', user.id)
      if (ids && ids.length > 0) {
        query.in('id', ids)
      }
      const { error } = await query
      if (error) throw new Error(error.message)
      res.status(200).json({ success: true })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '標記通知失敗' })
    }
    return
  }

  res.status(405).json({ error: 'Method Not Allowed' })
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

    const requestedClassroomKey =
      typeof req.query?.classroomKey === 'string'
        ? req.query.classroomKey.trim()
        : ''
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

    const activeClassroom =
      classroomOptions.find((item) => item.key === requestedClassroomKey) ||
      classroomOptions[0]
    if (!activeClassroom) {
      res.status(403).json({ error: 'Student account is not linked' })
      return
    }
    const studentContext =
      studentContexts.find(
        (context) =>
          context.id === activeClassroom.studentId &&
          context.ownerId === activeClassroom.ownerId &&
          context.classroomId === activeClassroom.classroomId
      ) || studentContexts[0]
    if (!studentContext) {
      res.status(403).json({ error: 'Student account is not linked' })
      return
    }

    const ownerId = studentContext.ownerId
    const preferences = await getTeacherPreferences(supabaseDb, ownerId)

    const assignmentsResult = await supabaseDb
      .from('assignments')
      .select('id, title, total_pages, student_show_score, updated_at')
      .eq('owner_id', ownerId)
      .eq('classroom_id', studentContext.classroomId)
      .order('created_at', { ascending: false })

    if (assignmentsResult.error) {
      throw new Error(assignmentsResult.error.message)
    }

    const assignmentIds = (assignmentsResult.data || []).map((a) => a.id)

    const [statesResult, submissionsResult, correctionItemsResult] = await Promise.all([
      assignmentIds.length
        ? supabaseDb
            .from('assignment_student_state')
            .select(
              'assignment_id, status, upload_locked, graded_once, correction_attempt_count, correction_attempt_limit, last_status_reason, current_submission_id, last_graded_submission_id, updated_at'
            )
            .eq('owner_id', ownerId)
            .eq('student_id', studentContext.id)
            .in('assignment_id', assignmentIds)
        : Promise.resolve({ data: [], error: null }),
      assignmentIds.length
        ? supabaseDb
            .from('submissions')
            .select('id, assignment_id, score, graded_at, created_at, updated_at, source, grading_result, image_url')
            .eq('owner_id', ownerId)
            .eq('student_id', studentContext.id)
            .in('assignment_id', assignmentIds)
        : Promise.resolve({ data: [], error: null }),
      assignmentIds.length
        ? supabaseDb
            .from('correction_question_items')
            .select(
              'assignment_id, attempt_no, question_id, question_text, mistake_reason, hint_text, accessor_result, status'
            )
            .eq('owner_id', ownerId)
            .eq('student_id', studentContext.id)
            .eq('status', 'open')
            .in('assignment_id', assignmentIds)
        : Promise.resolve({ data: [], error: null })
    ])

    if (statesResult.error) throw new Error(statesResult.error.message)
    if (submissionsResult.error) throw new Error(submissionsResult.error.message)
    if (correctionItemsResult.error) throw new Error(correctionItemsResult.error.message)

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
      existing.push(
        compactObject({
          attemptNo: row.attempt_no,
          questionId: row.question_id,
          questionText: row.question_text ?? undefined,
          mistakeReason: sanitizeHintText(row.mistake_reason ?? ''),
          hintText: sanitizeHintText(row.hint_text ?? row.mistake_reason ?? ''),
          sourceSubmissionId: resolvedSourceSubmissionId || undefined,
          sourceImageUrl: accessorSourceImageUrl,
          cropImageUrl: accessorCropImageUrl,
          questionBbox: normalizeBbox(accessor?.question_bbox),
          answerBbox: normalizeBbox(accessor?.answer_bbox),
          status: row.status
        })
      )
      openCorrectionsByAssignment.set(row.assignment_id, existing)
    }

    const assignmentItems = (assignmentsResult.data || []).map((assignment) => {
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
      const isCorrectionStatus = ['correction_required', 'correction_in_progress'].includes(rawStatus)
      const effectiveUploadLocked =
        Boolean(state?.upload_locked) || String(state?.status || '') === 'uploaded'
      const canUpload =
        preferences.student_portal_enabled && !effectiveUploadLocked
      const correctionAttemptCount = state?.correction_attempt_count ?? 0
      const openCorrections = openCorrectionsByAssignment.get(assignment.id) ?? []
      const fallbackCorrections =
        openCorrections.length === 0 && isCorrectionStatus && latestGradedSubmission?.grading_result
          ? parseMistakesFromGradingResult(latestGradedSubmission.grading_result).map((mistake) =>
              compactObject({
                attemptNo: correctionAttemptCount,
                questionId: mistake.questionId,
                questionText: mistake.questionText,
                mistakeReason: sanitizeHintText(mistake.reason),
                hintText: sanitizeHintText(mistake.hintText || mistake.reason),
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
      const status =
        mergedCorrections.length > 0 &&
        !['correction_required', 'correction_in_progress', 'correction_failed', 'correction_passed'].includes(rawStatus)
          ? 'correction_required'
          : rawStatus

      // Apply student_feedback_visibility preference
      const visibility = preferences.student_feedback_visibility || 'score_reason'
      const visibleScore = visibility === 'status_only' ? false : showScore
      const visibleCorrections =
        visibility === 'status_only' || visibility === 'score_only' ? [] : mergedCorrections

      return compactObject({
        id: assignment.id,
        title: assignment.title,
        totalPages: assignment.total_pages,
        status,
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

    res.status(200).json({
      classrooms: classroomOptions,
      activeClassroomKey: activeClassroom.key,
      student: {
        id: studentContext.id,
        name: studentContext.name,
        seatNumber: studentContext.seatNumber,
        classroomId: studentContext.classroomId,
        ownerId
      },
      preferences: {
        studentPortalEnabled: preferences.student_portal_enabled,
        showScoreToStudents: preferences.show_score_to_students,
        maxCorrectionAttempts: preferences.max_correction_attempts,
        lockUploadAfterGraded: preferences.lock_upload_after_graded,
        requireFullPageCount: preferences.require_full_page_count
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
      .select('id, owner_id, classroom_id, total_pages, answer_key, title')
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
      if (!['correction_required', 'correction_in_progress'].includes(status)) {
        res.status(409).json({
          error: '目前作業未進入可訂正狀態',
          code: 'INVALID_CORRECTION_STATE'
        })
        return
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
      const latestIsGraded = latestSubmission.graded_at !== null && latestSubmission.graded_at !== undefined
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

    const { error: insertError } = await supabaseDb
      .from('submissions')
      .insert(
        compactObject({
          id: submissionId,
          assignment_id: assignmentId,
          student_id: studentContext.id,
          image_url: filePath,
          thumb_url: thumbFilePath ?? undefined,
          status: 'synced',
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

    // Notify teacher when student uploads (non-correction)
    if (mode === 'upload') {
      const ownerPrefs = await getTeacherPreferences(supabaseDb, ownerId)
      await createTeacherNotification(supabaseDb, ownerId, 'submission_uploaded', {
        assignmentId,
        studentId: studentContext.id,
        studentName: studentContext.name || undefined
      }, ownerPrefs)
    }

    let correctionResult = null
    if (mode === 'correction') {
      try {
        const gradingResult = await runSubmissionGrading({
          assignment,
          normalizedImage: normalizedImagePayload,
          contentType,
          requestId: submissionId
        })
        const gradedAt = Date.now()
        const totalScore = toNumber(gradingResult?.totalScore) ?? 0
        const feedback =
          Array.isArray(gradingResult?.suggestions) && gradingResult.suggestions.length > 0
            ? String(gradingResult.suggestions[0] || '')
            : undefined

        const { error: updateSubmissionError } = await supabaseDb
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

        if (updateSubmissionError) {
          throw new Error(updateSubmissionError.message)
        }

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

        const { data: latestState, error: latestStateError } = await supabaseDb
          .from('assignment_student_state')
          .select(
            'status, correction_attempt_count, correction_attempt_limit, last_status_reason'
          )
          .eq('owner_id', ownerId)
          .eq('assignment_id', assignmentId)
          .eq('student_id', studentContext.id)
          .maybeSingle()
        if (latestStateError) {
          throw new Error(latestStateError.message)
        }

        correctionResult = {
          status: latestState?.status || 'correction_in_progress',
          totalScore,
          wrongQuestionCount: parseMistakesFromGradingResult(gradingResult).length,
          correctionAttemptCount: clampInteger(
            latestState?.correction_attempt_count,
            0,
            99,
            correctionCount + 1
          ),
          correctionAttemptLimit: clampInteger(
            latestState?.correction_attempt_limit,
            1,
            MAX_CORRECTION_ATTEMPT_LIMIT,
            correctionLimit
          ),
          lastStatusReason: latestState?.last_status_reason || undefined
        }
      } catch (gradingError) {
        await upsertAssignmentStudentState(
          supabaseDb,
          ownerId,
          assignmentId,
          studentContext.id,
          compactObject({
            status: 'correction_required',
            current_submission_id: submissionId,
            correction_attempt_limit: correctionLimit,
            upload_locked: true,
            last_status_reason: 'AI 再次批改失敗，請稍後再試'
          })
        )
        throw gradingError
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
          'assignment_id, attempt_no, question_id, question_text, mistake_reason, hint_text, accessor_result, status, updated_at'
        )
        .eq('owner_id', ctx.ownerId)
        .eq('student_id', ctx.id)
        .eq('status', 'open')
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
            mistakeReason: sanitizeHintText(item.mistake_reason ?? ''),
            hintText: sanitizeHintText(item.hint_text ?? item.mistake_reason ?? ''),
            sourceSubmissionId: resolvedSourceSubmissionId || undefined,
            sourceImageUrl: accessorSourceImageUrl,
            cropImageUrl: accessorCropImageUrl,
            questionBbox: normalizeBbox(accessor?.question_bbox),
            answerBbox: normalizeBbox(accessor?.answer_bbox),
            status: item.status,
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

  // 從 DB 取 teacherID（不從 request 驗證，以防 teacherID 為空或格式不同）
  const storedTeacherID = String(identity.provider_meta?.teacherID || '').trim()
  const providerAccount = String(identity.provider_account || '').trim()
  const effectiveTeacherID = storedTeacherID || providerAccount
  const hasOAuthToken = !!identity.provider_meta?.oauth_access_token

  console.log('[1campus sync] user.id:', user.id, 'dsns:', dsns)
  console.log('[1campus sync] effectiveTeacherID:', effectiveTeacherID, '(storedTeacherID:', storedTeacherID, ', account:', providerAccount, ')')
  console.log('[1campus sync] hasOAuthToken:', hasOAuthToken)

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

  // 依班級分組（同一個 classID 可能出現在多個 course 中）
  const classByID = {}
  for (const course of courseStudents) {
    const classInfo = course.class || {}
    const classID = String(classInfo.classID || course.courseID || '').trim()
    if (!classID) continue

    if (!classByID[classID]) {
      classByID[classID] = {
        classID,
        className: String(classInfo.className || course.courseName || `班級 ${classID}`).trim(),
        gradeYear: classInfo.gradeYear ?? null,
        students: []
      }
    }

    const students = Array.isArray(course.student) ? course.student : []
    for (const s of students) {
      // 避免重複學生（同一個 classID 下可能來自多個 course）
      const existing = classByID[classID].students.find(
        (ex) => ex.seatNo === s.seatNo && ex.studentName === s.studentName
      )
      if (!existing) {
        classByID[classID].students.push(s)
      }
    }
  }

  const groupedClasses = Object.values(classByID)
  console.log('[1campus sync] grouped into', groupedClasses.length, 'unique classes')

  if (!groupedClasses.length) {
    res.status(200).json({ success: true, synced: 0, total: 0, classrooms: [] })
    return
  }

  const results = []
  const nowIso = new Date().toISOString()

  for (const cls of groupedClasses) {
    const providerClassId = cls.classID
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

      if (syncRecord?.classroom_id) {
        classroomId = syncRecord.classroom_id
        await supabaseAdmin
          .from('classrooms')
          .update({ name: className })
          .eq('id', classroomId)
          .eq('owner_id', user.id)
      } else {
        const { data: newClassroom, error: classroomError } =
          await supabaseAdmin
            .from('classrooms')
            .insert({ owner_id: user.id, name: className, folder: '1Campus' })
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
          const rawEmail = (typeof s.email === 'string' && s.email.trim()) ? s.email.trim()
            : (typeof s.studentAcc === 'string' && s.studentAcc.trim()) ? s.studentAcc.trim()
            : null
          return {
            seat_number: Number(s.seatNo) || 0,
            name: String(s.studentName || '').trim(),
            email: rawEmail,
            provider_student_id: s.studentID != null && String(s.studentID).trim() ? String(s.studentID).trim() : null,
            student_number: s.studentNumber != null ? String(s.studentNumber).trim() : null
          }
        })
        .filter((s) => s.seat_number > 0 && s.name)

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

        // 更新 email 和 provider_student_id（upsert_students_batch 不處理這兩個欄位）
        const studentsNeedUpdate = normalizedStudents.filter((s) => s.email || s.provider_student_id)
        if (studentsNeedUpdate.length > 0) {
          for (const s of studentsNeedUpdate) {
            const updatePayload = { updated_at: nowIso }
            if (s.email) updatePayload.email = s.email
            if (s.provider_student_id) updatePayload.provider_student_id = s.provider_student_id
            await supabaseAdmin
              .from('students')
              .update(updatePayload)
              .eq('owner_id', user.id)
              .eq('classroom_id', classroomId)
              .eq('seat_number', s.seat_number)
          }
          console.log('[1campus sync] updated extra fields for', studentsNeedUpdate.length, 'students')
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
  if (action === 'teacher-notifications') {
    await handleTeacherNotifications(req, res)
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
  if (action === 'report') {
    await handleReport(req, res)
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
  res.status(404).json({ error: 'Not Found' })
}
