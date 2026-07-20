// 單題「答錯學生」作答截圖（2026-07-20、user 拍板：圖上作答題送 crop 給 AI 歸納錯誤樣態）：
//   輸入 assignmentId + questionId → 回這題「答錯」學生的作答 crop（data URI）。
//   用途：計算作圖/繪圖題文字沒意義，改送實際手繪/計算圖，AI 才能看圖歸納錯誤樣態。
//   crop 幾何沿用 crops.js；免費（無 AI）；owner 驗證。上限 24 位（user：輸入圖成本還好、防爆走即可）。
import sharp from 'sharp'
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

const MAX_STUDENTS = 24

function parseJson(v) {
  if (v == null) return null
  if (typeof v === 'string') { try { return JSON.parse(v) } catch { return null } }
  return v
}
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
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }

  try {
    const { user } = await getAuthUser(req, res)
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }

    const assignmentId = String(req.body?.assignmentId ?? '').trim()
    const questionId = String(req.body?.questionId ?? '').trim()
    if (!assignmentId || !questionId) { res.status(400).json({ error: 'Missing assignmentId or questionId' }); return }

    const supabaseAdmin = getSupabaseAdmin()
    const { data: asg } = await supabaseAdmin
      .from('assignments').select('id, owner_id').eq('id', assignmentId).maybeSingle()
    if (!asg || asg.owner_id !== user.id) { res.status(403).json({ error: 'Forbidden' }); return }

    const { data: subs } = await supabaseAdmin
      .from('submissions').select('student_id, image_url, phase_a_state, grading_result')
      .eq('assignment_id', assignmentId)
    const rows = Array.isArray(subs) ? subs : []

    // 找「這題答錯（失分）」的學生
    const wrong = []
    for (const s of rows) {
      const gr = parseJson(s.grading_result)
      const d = (gr?.details || []).find((x) => String(x?.questionId ?? '').trim() === questionId)
      if (!d) continue
      const mx = num(d.maxScore)
      const lost = mx > 0 ? mx - num(d.score) : (d.isCorrect === true ? 0 : 1)
      if (d.isCorrect !== true && lost > 0.01 && s.image_url) wrong.push(s)
    }
    if (wrong.length === 0) { res.status(200).json({ crops: [] }); return }

    const crops = []
    for (const s of wrong.slice(0, MAX_STUDENTS)) {
      try {
        const bboxMap = buildBboxMap(s.phase_a_state)
        const b = bboxMap.get(questionId)
        if (!b) continue
        const { data: blob, error } = await supabaseAdmin.storage.from('homework-images').download(s.image_url)
        if (error || !blob) continue
        const buf = Buffer.from(await blob.arrayBuffer())
        const meta = await sharp(buf).metadata()
        const uri = await cropOne(buf, meta, b)
        if (uri) crops.push({ studentId: String(s.student_id), dataUrl: uri })
      } catch { /* 單生失敗略過 */ }
    }

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ crops, wrongTotal: wrong.length })
  } catch (err) {
    console.error('[report/question-crops] failed:', err?.message)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Crop generation failed' })
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
}
