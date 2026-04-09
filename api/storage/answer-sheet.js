/**
 * /api/storage/answer-sheet
 *
 * GET  ?assignmentId=&pageIndex=   — download a single page image
 * POST { assignmentId, imagesBase64[] } — upload compressed page images
 */
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

export const config = { runtime: 'nodejs' }

const BUCKET = 'homework-images'
const MAX_PAGES = 10
const MAX_IMAGE_SIZE = 2 * 1024 * 1024

function storagePath(assignmentId, pageIndex) {
  return `answer-sheets/${assignmentId}/page-${pageIndex}.webp`
}

async function verifyOwnership(supabase, assignmentId, userId) {
  const { data: assignment, error } = await supabase
    .from('assignments')
    .select('id, owner_id')
    .eq('id', assignmentId)
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: error.message }
  // assignment may not exist in Supabase yet (sync pending) — allow upload
  if (assignment && assignment.owner_id !== userId) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return { ok: true, assignment }
}

async function handleDownload(req, res, user, supabase) {
  const assignmentId = Array.isArray(req.query?.assignmentId)
    ? req.query.assignmentId[0]
    : req.query?.assignmentId
  const pageIndexRaw = Array.isArray(req.query?.pageIndex)
    ? req.query.pageIndex[0]
    : req.query?.pageIndex

  if (!assignmentId) { res.status(400).json({ error: 'Missing assignmentId' }); return }

  const pageIndex = pageIndexRaw !== undefined ? parseInt(pageIndexRaw, 10) : 0
  if (isNaN(pageIndex) || pageIndex < 0) { res.status(400).json({ error: 'Invalid pageIndex' }); return }

  const own = await verifyOwnership(supabase, assignmentId, user.id)
  if (!own.ok) { res.status(own.status).json({ error: own.error }); return }
  // For download, assignment must exist
  if (!own.assignment) { res.status(404).json({ error: 'Assignment not found' }); return }
  if (own.assignment.owner_id !== user.id) { res.status(403).json({ error: 'Forbidden' }); return }

  const { data, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(storagePath(assignmentId, pageIndex))

  if (downloadError || !data) { res.status(404).json({ error: 'Image not found' }); return }

  const buffer = Buffer.from(await data.arrayBuffer())
  res.setHeader('Content-Type', 'image/webp')
  res.setHeader('Content-Length', buffer.length)
  res.setHeader('Cache-Control', 'private, max-age=3600')
  res.status(200).send(buffer)
}

async function handleUpload(req, res, user, supabase) {
  const { assignmentId, imagesBase64 } = req.body ?? {}
  if (!assignmentId || typeof assignmentId !== 'string') {
    res.status(400).json({ error: 'Missing assignmentId' }); return
  }
  if (!Array.isArray(imagesBase64) || imagesBase64.length === 0) {
    res.status(400).json({ error: 'Missing imagesBase64 array' }); return
  }
  if (imagesBase64.length > MAX_PAGES) {
    res.status(400).json({ error: `Too many pages (max ${MAX_PAGES})` }); return
  }

  const own = await verifyOwnership(supabase, assignmentId, user.id)
  if (!own.ok) { res.status(own.status).json({ error: own.error }); return }

  const paths = []
  for (let i = 0; i < imagesBase64.length; i++) {
    const base64 = imagesBase64[i]
    if (typeof base64 !== 'string') {
      res.status(400).json({ error: `imagesBase64[${i}] is not a string` }); return
    }
    const buffer = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (buffer.length > MAX_IMAGE_SIZE) {
      res.status(400).json({ error: `Page ${i} exceeds max size of 2 MB` }); return
    }
    const path = storagePath(assignmentId, i)
    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: 'image/webp', upsert: true })
    if (uploadError) {
      res.status(500).json({ error: `Upload failed for page ${i}: ${uploadError.message}` }); return
    }
    paths.push(path)
  }

  res.status(200).json({ paths })
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return

  try {
    const { user } = await getAuthUser(req, res)
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }

    const supabase = getSupabaseAdmin()

    if (req.method === 'GET') {
      await handleDownload(req, res, user, supabase)
    } else if (req.method === 'POST') {
      await handleUpload(req, res, user, supabase)
    } else {
      res.status(405).json({ error: 'Method Not Allowed' })
    }
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
  }
}
