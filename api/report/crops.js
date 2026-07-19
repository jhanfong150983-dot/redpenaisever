// 家長報告錯題截圖（2026-07-19、user 拍板方案 A：server 端切）：
//   輸入 assignmentId + studentId + 要截的題號 → 回每題的學生作答 crop（data URI）。
//   免費（無 AI）；server 直接有學生作答圖 + bbox（phase_a_state.classifyResult），
//   不必把整張高解圖灌到前端、也避開 client 對 storage 的 RLS 讀取限制。
//   crop 幾何沿用沙盒實證版（pad 0.008、窄圖放大到 640、jpeg q82）。
import sharp from 'sharp'
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

const MAX_QIDS = 80

function parseJson(v) {
  if (v == null) return null
  if (typeof v === 'string') { try { return JSON.parse(v) } catch { return null } }
  return v
}

// 從 phase_a_state 取 questionId → answerBbox（normalized 0-1）。
function buildBboxMap(phaseAState) {
  const pa = parseJson(phaseAState)
  const list = pa?.classifyResult?.alignedQuestions || pa?.classifyResult?.questions || []
  const map = new Map()
  for (const q of Array.isArray(list) ? list : []) {
    const id = String(q?.questionId ?? q?.id ?? '').trim()
    const b = q?.answerBbox
    if (id && b && [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(Number(n)))) {
      map.set(id, { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) })
    }
  }
  return map
}

async function cropOne(buf, meta, b) {
  const pad = 0.008
  const cx = Math.round(Math.max(0, b.x - pad) * meta.width)
  const cy = Math.round(Math.max(0, b.y - pad) * meta.height)
  const cw = Math.min(meta.width - cx, Math.round((Math.min(1, b.x + b.w + pad) - Math.max(0, b.x - pad)) * meta.width))
  const ch = Math.min(meta.height - cy, Math.round((Math.min(1, b.y + b.h + pad) - Math.max(0, b.y - pad)) * meta.height))
  if (!(cw > 0 && ch > 0)) return null
  let im = sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch })
  if (cw < 640) im = im.resize({ width: Math.min(640, cw * 2) })
  const out = await im.jpeg({ quality: 82 }).toBuffer()
  return 'data:image/jpeg;base64,' + out.toString('base64')
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }

  try {
    const { user } = await getAuthUser(req, res)
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }

    const assignmentId = String(req.body?.assignmentId ?? '').trim()
    const studentId = String(req.body?.studentId ?? '').trim()
    const rawQids = Array.isArray(req.body?.questionIds) ? req.body.questionIds : []
    const questionIds = [...new Set(rawQids.map((q) => String(q ?? '').trim()).filter(Boolean))].slice(0, MAX_QIDS)
    if (!assignmentId || !studentId) { res.status(400).json({ error: 'Missing assignmentId or studentId' }); return }
    if (questionIds.length === 0) { res.status(200).json({ crops: {}, missing: [] }); return }

    const supabaseAdmin = getSupabaseAdmin()

    // 擁有權：只有作業 owner（老師）可取自己班的 crop。
    const { data: asg } = await supabaseAdmin
      .from('assignments').select('id, owner_id').eq('id', assignmentId).maybeSingle()
    if (!asg || asg.owner_id !== user.id) { res.status(403).json({ error: 'Forbidden' }); return }

    const { data: sub } = await supabaseAdmin
      .from('submissions').select('image_url, phase_a_state')
      .eq('assignment_id', assignmentId).eq('student_id', studentId).maybeSingle()
    if (!sub?.image_url) { res.status(404).json({ error: 'Submission or image not found' }); return }

    const bboxMap = buildBboxMap(sub.phase_a_state)

    const { data: blob, error: dlErr } = await supabaseAdmin.storage.from('homework-images').download(sub.image_url)
    if (dlErr || !blob) { res.status(404).json({ error: 'Image download failed' }); return }
    const buf = Buffer.from(await blob.arrayBuffer())
    const meta = await sharp(buf).metadata()

    const crops = {}
    const missing = []
    for (const qid of questionIds) {
      const b = bboxMap.get(qid)
      if (!b) { missing.push(qid); continue }
      try {
        const uri = await cropOne(buf, meta, b)
        if (uri) crops[qid] = uri; else missing.push(qid)
      } catch { missing.push(qid) }
    }

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ crops, missing })
  } catch (err) {
    console.error('[report/crops] failed:', err?.message)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Crop generation failed' })
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
}
