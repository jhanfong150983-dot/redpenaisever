import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

export const config = { runtime: 'nodejs' }

const BUCKET = 'homework-images'
const MAX_PAGES = 10
const MAX_IMAGE_SIZE = 2 * 1024 * 1024 // 2 MB per page (already compressed by client)

function storagePath(assignmentId, pageIndex) {
  return `answer-sheets/${assignmentId}/page-${pageIndex}.webp`
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const { user } = await getAuthUser(req, res)
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const { assignmentId, imagesBase64 } = req.body ?? {}
    if (!assignmentId || typeof assignmentId !== 'string') {
      res.status(400).json({ error: 'Missing assignmentId' })
      return
    }
    if (!Array.isArray(imagesBase64) || imagesBase64.length === 0) {
      res.status(400).json({ error: 'Missing imagesBase64 array' })
      return
    }
    if (imagesBase64.length > MAX_PAGES) {
      res.status(400).json({ error: `Too many pages (max ${MAX_PAGES})` })
      return
    }

    const supabase = getSupabaseAdmin()

    // Verify ownership: user must own this assignment
    const { data: assignment, error: assignmentError } = await supabase
      .from('assignments')
      .select('id, owner_id')
      .eq('id', assignmentId)
      .maybeSingle()

    if (assignmentError) {
      res.status(500).json({ error: assignmentError.message })
      return
    }
    // assignment may not exist yet in Supabase if it was just created locally (sync pending).
    // In that case, skip ownership check and allow upload as long as user is authenticated.
    if (assignment && assignment.owner_id !== user.id) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const paths = []
    for (let i = 0; i < imagesBase64.length; i++) {
      const base64 = imagesBase64[i]
      if (typeof base64 !== 'string') {
        res.status(400).json({ error: `imagesBase64[${i}] is not a string` })
        return
      }

      // Strip data URL prefix if present
      const raw = base64.replace(/^data:[^;]+;base64,/, '')
      const buffer = Buffer.from(raw, 'base64')

      if (buffer.length > MAX_IMAGE_SIZE) {
        res.status(400).json({ error: `Page ${i} exceeds max size of 2 MB` })
        return
      }

      const path = storagePath(assignmentId, i)
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, buffer, {
          contentType: 'image/webp',
          upsert: true,
        })

      if (uploadError) {
        res.status(500).json({ error: `Upload failed for page ${i}: ${uploadError.message}` })
        return
      }
      paths.push(path)
    }

    res.status(200).json({ paths })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
  }
}
