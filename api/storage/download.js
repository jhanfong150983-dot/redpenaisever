import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

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

function parseBooleanParam(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  }
  return false
}

function normalizePathParam(value) {
  if (Array.isArray(value)) {
    return normalizePathParam(value[0])
  }
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/^\/+/, '')
  if (!trimmed) return ''
  if (trimmed.includes('..')) return ''
  return trimmed.split('?')[0].split('#')[0]
}

function extractSubmissionIdFromPath(path) {
  const text = String(path || '').trim()
  if (!text) return ''
  const submissionMatch = text.match(/(?:^|\/)submissions\/([^/?#]+)\.webp(?:[?#]|$)/i)
  if (submissionMatch && submissionMatch[1]) {
    return String(submissionMatch[1]).trim()
  }
  const cropMatch = text.match(/^corrections\/crops\/([^/]+)\//i)
  if (cropMatch && cropMatch[1]) {
    return String(cropMatch[1]).trim()
  }
  return ''
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

async function isAdminUser(supabaseDb, userId) {
  const { data, error } = await supabaseDb
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()

  if (error) return false
  return data?.role?.toLowerCase?.() === 'admin'
}

// ── answer-sheet helpers ─────────────────────────────────────────────────────

const MAX_ANSWER_SHEET_PAGES = 10
const MAX_ANSWER_SHEET_IMAGE_SIZE = 2 * 1024 * 1024

function answerSheetPath(assignmentId, pageIndex) {
  return `answer-sheets/${assignmentId}/page-${pageIndex}.webp`
}

async function verifyAssignmentOwnership(supabaseDb, assignmentId, userId) {
  const { data: assignment, error } = await supabaseDb
    .from('assignments')
    .select('id, owner_id')
    .eq('id', assignmentId)
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  if (assignment && assignment.owner_id !== userId) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return { ok: true, assignment }
}

async function handleAnswerSheetDownload(req, res, user, supabaseDb) {
  const assignmentId = Array.isArray(req.query?.assignmentId)
    ? req.query.assignmentId[0] : req.query?.assignmentId
  const pageIndexRaw = Array.isArray(req.query?.pageIndex)
    ? req.query.pageIndex[0] : req.query?.pageIndex

  if (!assignmentId) { res.status(400).json({ error: 'Missing assignmentId' }); return }
  const pageIndex = pageIndexRaw !== undefined ? parseInt(pageIndexRaw, 10) : 0
  if (isNaN(pageIndex) || pageIndex < 0) { res.status(400).json({ error: 'Invalid pageIndex' }); return }

  const own = await verifyAssignmentOwnership(supabaseDb, assignmentId, user.id)
  if (!own.ok) { res.status(own.status).json({ error: own.error }); return }
  if (!own.assignment) { res.status(404).json({ error: 'Assignment not found' }); return }

  const { data, error: downloadError } = await supabaseDb.storage
    .from('homework-images').download(answerSheetPath(assignmentId, pageIndex))
  if (downloadError || !data) { res.status(404).json({ error: 'Image not found' }); return }

  const buffer = Buffer.from(await data.arrayBuffer())
  res.setHeader('Content-Type', 'image/webp')
  res.setHeader('Content-Length', buffer.length)
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.status(200).send(buffer)
}

async function handleAnswerSheetUpload(req, res, user, supabaseDb) {
  const { assignmentId, imagesBase64, storagePrefix } = req.body ?? {}
  if (!assignmentId || typeof assignmentId !== 'string') {
    res.status(400).json({ error: 'Missing assignmentId' }); return
  }
  if (!Array.isArray(imagesBase64) || imagesBase64.length === 0) {
    res.status(400).json({ error: 'Missing imagesBase64 array' }); return
  }
  // 允許 answer-sheets（預設）和 question-booklets 兩種前綴
  const allowedPrefixes = ['answer-sheets', 'question-booklets']
  const prefix = allowedPrefixes.includes(storagePrefix) ? storagePrefix : 'answer-sheets'
  const maxPages = prefix === 'question-booklets' ? 20 : MAX_ANSWER_SHEET_PAGES
  if (imagesBase64.length > maxPages) {
    res.status(400).json({ error: `Too many pages (max ${maxPages})` }); return
  }

  const own = await verifyAssignmentOwnership(supabaseDb, assignmentId, user.id)
  if (!own.ok) { res.status(own.status).json({ error: own.error }); return }

  const paths = []
  for (let i = 0; i < imagesBase64.length; i++) {
    const base64 = imagesBase64[i]
    if (typeof base64 !== 'string') { res.status(400).json({ error: `imagesBase64[${i}] is not a string` }); return }
    const buffer = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (buffer.length > MAX_ANSWER_SHEET_IMAGE_SIZE) {
      res.status(400).json({ error: `Page ${i} exceeds max size of 2 MB` }); return
    }
    const storagePath = `${prefix}/${assignmentId}/page-${i}.webp`
    const { error: uploadError } = await supabaseDb.storage
      .from('homework-images')
      .upload(storagePath, buffer, { contentType: 'image/webp', upsert: true })
    if (uploadError) { res.status(500).json({ error: `Upload failed for page ${i}: ${uploadError.message}` }); return }
    paths.push(storagePath)
  }

  // 直接持久化到 assignments 對應欄位
  const updatePayload = prefix === 'answer-sheets'
    ? { answer_sheet_image_paths: paths }
    : { question_booklet_image_paths: paths }
  const { error: updateError } = await supabaseDb
    .from('assignments')
    .update(updatePayload)
    .eq('id', assignmentId)
    .eq('owner_id', user.id)
  if (updateError) {
    console.warn(`[${prefix}] paths uploaded to Storage but failed to persist column for ${assignmentId}: ${updateError.message}`)
  }

  res.status(200).json({ paths })
}

// ── answer-crop helpers ──────────────────────────────────────────────────────

const MAX_CROP_SIZE = 500 * 1024 // 500KB per crop
const MAX_CROPS_PER_UPLOAD = 50
const HOMEWORK_IMAGES_BUCKET = 'homework-images'

function answerCropPath(assignmentId, questionId) {
  // Sanitize questionId for safe storage path (replace / with _)
  const safeQid = String(questionId).replace(/[/\\]/g, '_')
  return `answer-crops/${assignmentId}/${safeQid}.jpg`
}

async function handleAnswerCropUpload(req, res, user, supabaseDb) {
  const { assignmentId, crops } = req.body || {}
  if (!assignmentId || typeof assignmentId !== 'string') {
    res.status(400).json({ error: 'Missing assignmentId' }); return
  }
  if (!Array.isArray(crops) || crops.length === 0) {
    res.status(400).json({ error: 'Missing crops array' }); return
  }
  if (crops.length > MAX_CROPS_PER_UPLOAD) {
    res.status(400).json({ error: `Too many crops (max ${MAX_CROPS_PER_UPLOAD})` }); return
  }

  const own = await verifyAssignmentOwnership(supabaseDb, assignmentId, user.id)
  if (!own.ok) { res.status(own.status).json({ error: own.error }); return }

  const paths = {}
  let uploaded = 0
  for (const crop of crops) {
    const qId = crop?.questionId
    const base64 = crop?.imageBase64
    if (!qId || typeof base64 !== 'string') continue
    const buffer = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (buffer.length > MAX_CROP_SIZE) {
      console.warn(`[answer-crop] skip ${qId}: ${buffer.length} bytes exceeds ${MAX_CROP_SIZE}`)
      continue
    }
    const storagePath = answerCropPath(assignmentId, qId)
    const { error: uploadError } = await supabaseDb.storage
      .from(HOMEWORK_IMAGES_BUCKET)
      .upload(storagePath, buffer, { contentType: 'image/jpeg', upsert: true })
    if (uploadError) {
      console.warn(`[answer-crop] upload failed for ${qId}:`, uploadError.message)
      continue
    }
    paths[qId] = storagePath
    uploaded++
  }
  console.log(`[answer-crop] uploaded ${uploaded}/${crops.length} crops for assignment=${assignmentId}`)
  res.status(200).json({ paths })
}

// ── main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }

  // POST → answer sheet upload or crop upload
  if (req.method === 'POST') {
    try {
      const { user } = await getAuthUser(req, res)
      if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
      const supabaseDb = getSupabaseAdmin()
      // Dispatch by action field or default to answer sheet upload
      if (req.body?.action === 'upload_crops') {
        await handleAnswerCropUpload(req, res, user, supabaseDb)
      } else {
        await handleAnswerSheetUpload(req, res, user, supabaseDb)
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
    }
    return
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const { user } = await getAuthUser(req, res)
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const supabaseDb = getSupabaseAdmin()

    // GET with assignmentId → answer sheet or crop download
    const assignmentIdParam = req.query?.assignmentId
    if (assignmentIdParam) {
      const cropPath = normalizePathParam(req.query?.cropPath)
      if (cropPath && cropPath.startsWith('answer-crops/')) {
        // Verify ownership then serve the crop image
        const assignmentId = Array.isArray(assignmentIdParam) ? assignmentIdParam[0] : assignmentIdParam
        const own = await verifyAssignmentOwnership(supabaseDb, assignmentId, user.id)
        if (!own.ok) { res.status(own.status).json({ error: own.error }); return }
        const { data, error: dlErr } = await supabaseDb.storage
          .from(HOMEWORK_IMAGES_BUCKET).download(cropPath)
        if (dlErr || !data) { res.status(404).json({ error: 'Crop not found' }); return }
        const buffer = Buffer.from(await data.arrayBuffer())
        res.setHeader('Content-Type', 'image/jpeg')
        res.setHeader('Content-Length', buffer.length)
        res.setHeader('Cache-Control', 'private, max-age=86400')
        res.status(200).send(buffer)
        return
      }
      await handleAnswerSheetDownload(req, res, user, supabaseDb)
      return
    }

    // GET with submissionId → original submission image download
    const submissionIdParam = req.query?.submissionId
    let submissionId = Array.isArray(submissionIdParam)
      ? submissionIdParam[0]
      : submissionIdParam
    const requestedPath = normalizePathParam(req.query?.path)
    if (!submissionId && requestedPath) {
      submissionId = extractSubmissionIdFromPath(requestedPath)
    }

    if (!submissionId) {
      res.status(400).json({ error: 'Missing submissionId' })
      return
    }

    if (requestedPath) {
      const pathSubmissionId = extractSubmissionIdFromPath(requestedPath)
      if (!pathSubmissionId || pathSubmissionId !== submissionId) {
        res.status(403).json({ error: 'Forbidden path access' })
        return
      }
    }

    // 後端始終使用 service role key 繞過 RLS（已在上方取得 supabaseDb）

    const { data: submission, error: submissionError } = await supabaseDb
      .from('submissions')
      .select('id, owner_id, student_id, thumb_url')
      .eq('id', submissionId)
      .maybeSingle()

    if (submissionError) {
      res.status(500).json({ error: submissionError.message })
      return
    }

    // 檢查權限：自己的資料或管理員以他人身份檢視
    const requestedOwnerId = resolveOwnerIdParam(req)
    const isOwnerOverride = requestedOwnerId && requestedOwnerId !== user.id
    
    let hasAccess = false
    if (submission?.owner_id === user.id) {
      // 自己的資料
      hasAccess = true
    } else if (isOwnerOverride && submission?.owner_id === requestedOwnerId) {
      // 管理員以他人身份檢視
      hasAccess = await isAdminUser(supabaseDb, user.id)
    } else if (submission?.student_id && submission?.owner_id) {
      // 學生本人可讀取自己的 submission 圖片
      const { data: student, error: studentError } = await supabaseDb
        .from('students')
        .select('id, owner_id, auth_user_id, email')
        .eq('id', submission.student_id)
        .eq('owner_id', submission.owner_id)
        .maybeSingle()

      if (!studentError && student) {
        const isLinkedByAuth = student.auth_user_id === user.id
        const isLinkedByEmail =
          Boolean(normalizeEmail(user.email)) &&
          normalizeEmail(student.email) === normalizeEmail(user.email)

        if (isLinkedByAuth || isLinkedByEmail) {
          hasAccess = true

          if (!isLinkedByAuth && isLinkedByEmail) {
            await supabaseDb
              .from('students')
              .update({ auth_user_id: user.id, updated_at: new Date().toISOString() })
              .eq('id', student.id)
              .eq('owner_id', student.owner_id)
          }
        }
      }
    }

    if (!submission || !hasAccess) {
      res.status(404).json({ error: 'Submission not found' })
      return
    }

    const candidatePaths = []
    if (requestedPath) {
      candidatePaths.push(requestedPath)
    } else {
      const wantsThumbnail = parseBooleanParam(
        req.query?.thumbnail ?? req.query?.thumb ?? req.query?.thumbUrl
      )
      const normalizedThumbUrl = submission?.thumb_url ?? undefined
      const originalPath = `submissions/${submissionId}.webp`
      const thumbFallbackPath = `submissions/thumbs/${submissionId}.webp`
      if (wantsThumbnail) {
        if (normalizedThumbUrl) {
          candidatePaths.push(normalizedThumbUrl.replace(/^\/+/, ''))
        }
        candidatePaths.push(thumbFallbackPath)
      }
      candidatePaths.push(originalPath)
    }

    let data = null
    for (const candidate of candidatePaths) {
      const { data: downloadData, error: downloadError } = await supabaseDb.storage
        .from('homework-images')
        .download(candidate)

      if (!downloadError && downloadData) {
        data = downloadData
        break
      }

      // If download failed because the thumb path doesn't exist, keep trying
      if (downloadError && candidate === candidatePaths[candidatePaths.length - 1]) {
        res.status(404).json({ error: 'Image not found' })
        return
      }
    }

    if (!data) {
      res.status(404).json({ error: 'Image not found' })
      return
    }

    const arrayBuffer = await data.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    res.setHeader('Content-Type', data.type || 'image/webp')
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.status(200).send(buffer)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
  }
}
