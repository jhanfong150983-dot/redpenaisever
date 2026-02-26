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
    const submissionId = Array.isArray(submissionIdParam)
      ? submissionIdParam[0]
      : submissionIdParam
    if (!submissionId) {
      res.status(400).json({ error: 'Missing submissionId' })
      return
    }

    // 後端始終使用 service role key 繞過 RLS
    const supabaseDb = getSupabaseAdmin()

    const { data: submission, error: submissionError } = await supabaseDb
      .from('submissions')
      .select('id, owner_id, thumb_url')
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
    }

    if (!submission || !hasAccess) {
      res.status(404).json({ error: 'Submission not found' })
      return
    }

    const wantsThumbnail = parseBooleanParam(
      req.query?.thumbnail ?? req.query?.thumb ?? req.query?.thumbUrl
    )

    const normalizedThumbUrl = submission?.thumb_url ?? undefined

    const originalPath = `submissions/${submissionId}.webp`
    const thumbFallbackPath = `submissions/thumbs/${submissionId}.webp`
    const candidatePaths = []

    if (wantsThumbnail) {
      if (normalizedThumbUrl) {
        candidatePaths.push(normalizedThumbUrl.replace(/^\/+/, ''))
      }
      candidatePaths.push(thumbFallbackPath)
    }
    candidatePaths.push(originalPath)

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
