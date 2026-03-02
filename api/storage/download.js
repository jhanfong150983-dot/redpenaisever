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

export default async function handler(req, res) {
  if (handleCors(req, res)) {
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

    // 後端始終使用 service role key 繞過 RLS
    const supabaseDb = getSupabaseAdmin()

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
    res.status(200).send(buffer)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
  }
}
