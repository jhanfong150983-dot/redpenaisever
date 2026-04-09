import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

export const config = { runtime: 'nodejs' }

const BUCKET = 'homework-images'

function storagePath(assignmentId, pageIndex) {
  return `answer-sheets/${assignmentId}/page-${pageIndex}.webp`
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return
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

    const assignmentId = Array.isArray(req.query?.assignmentId)
      ? req.query.assignmentId[0]
      : req.query?.assignmentId
    const pageIndexRaw = Array.isArray(req.query?.pageIndex)
      ? req.query.pageIndex[0]
      : req.query?.pageIndex

    if (!assignmentId || typeof assignmentId !== 'string') {
      res.status(400).json({ error: 'Missing assignmentId' })
      return
    }

    const pageIndex = pageIndexRaw !== undefined ? parseInt(pageIndexRaw, 10) : 0
    if (isNaN(pageIndex) || pageIndex < 0) {
      res.status(400).json({ error: 'Invalid pageIndex' })
      return
    }

    const supabase = getSupabaseAdmin()

    // Verify ownership
    const { data: assignment, error: assignmentError } = await supabase
      .from('assignments')
      .select('id, owner_id')
      .eq('id', assignmentId)
      .maybeSingle()

    if (assignmentError) {
      res.status(500).json({ error: assignmentError.message })
      return
    }
    if (!assignment) {
      res.status(404).json({ error: 'Assignment not found' })
      return
    }
    if (assignment.owner_id !== user.id) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const path = storagePath(assignmentId, pageIndex)
    const { data, error: downloadError } = await supabase.storage
      .from(BUCKET)
      .download(path)

    if (downloadError || !data) {
      res.status(404).json({ error: 'Image not found' })
      return
    }

    const arrayBuffer = await data.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    res.setHeader('Content-Type', 'image/webp')
    res.setHeader('Content-Length', buffer.length)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.status(200).send(buffer)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
  }
}
