// 家長報告快取（2026-07-20）：只存花錢的 AI 產物（逐題診斷 + 老師的話）到 parent_reports。
//   GET  ?assignmentId=  → 載入該作業全部已快取的診斷/評語，並用指紋比對回傳每筆 stale。
//   POST { assignmentId, items:[{studentId, diagnosis, comment}] } → 批次 upsert，
//        server 端當下讀 submission.graded_at / assignment.updated_at 蓋指紋。
//   截圖不進此表（免費、由 /api/report/crops 現切）。存取一律 service_role + owner 驗證。
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

async function assertOwner(supabaseAdmin, assignmentId, userId) {
  const { data: asg } = await supabaseAdmin
    .from('assignments').select('id, owner_id, updated_at').eq('id', assignmentId).maybeSingle()
  if (!asg || asg.owner_id !== userId) return null
  return asg
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return

  try {
    const { user } = await getAuthUser(req, res)
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
    const supabaseAdmin = getSupabaseAdmin()

    if (req.method === 'GET') {
      const assignmentId = String(req.query?.assignmentId ?? '').trim()
      if (!assignmentId) { res.status(400).json({ error: 'Missing assignmentId' }); return }
      const asg = await assertOwner(supabaseAdmin, assignmentId, user.id)
      if (!asg) { res.status(403).json({ error: 'Forbidden' }); return }

      const { data: rows } = await supabaseAdmin
        .from('parent_reports')
        .select('student_id, diagnosis, comment, graded_fp, answer_key_fp')
        .eq('assignment_id', assignmentId)
      const cached = Array.isArray(rows) ? rows : []

      // 現值指紋：每生 graded_at + 作業 updated_at
      const { data: subs } = await supabaseAdmin
        .from('submissions').select('student_id, graded_at').eq('assignment_id', assignmentId)
      const gradedNow = new Map((subs ?? []).map((s) => [String(s.student_id), s.graded_at]))
      const akNow = asg.updated_at

      const items = cached.map((r) => {
        const sid = String(r.student_id)
        const gradedStale = gradedNow.has(sid) && String(gradedNow.get(sid)) !== String(r.graded_fp)
        const akStale = String(akNow) !== String(r.answer_key_fp)
        return {
          studentId: sid,
          diagnosis: r.diagnosis || {},
          comment: r.comment || '',
          stale: Boolean(gradedStale || akStale),
        }
      })
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).json({ items })
      return
    }

    if (req.method === 'POST') {
      const assignmentId = String(req.body?.assignmentId ?? '').trim()
      const rawItems = Array.isArray(req.body?.items) ? req.body.items : []
      if (!assignmentId) { res.status(400).json({ error: 'Missing assignmentId' }); return }
      const asg = await assertOwner(supabaseAdmin, assignmentId, user.id)
      if (!asg) { res.status(403).json({ error: 'Forbidden' }); return }
      if (rawItems.length === 0) { res.status(200).json({ saved: 0 }); return }

      // 蓋指紋用的現值 graded_at
      const { data: subs } = await supabaseAdmin
        .from('submissions').select('student_id, graded_at').eq('assignment_id', assignmentId)
      const gradedNow = new Map((subs ?? []).map((s) => [String(s.student_id), s.graded_at]))

      const now = new Date().toISOString()
      const rows = rawItems
        .map((it) => {
          const sid = String(it?.studentId ?? '').trim()
          if (!sid) return null
          return {
            assignment_id: assignmentId,
            student_id: sid,
            owner_id: user.id,
            diagnosis: it?.diagnosis && typeof it.diagnosis === 'object' ? it.diagnosis : {},
            comment: typeof it?.comment === 'string' ? it.comment : null,
            graded_fp: gradedNow.get(sid) ?? null,
            answer_key_fp: asg.updated_at,
            updated_at: now,
          }
        })
        .filter(Boolean)

      const { error } = await supabaseAdmin
        .from('parent_reports')
        .upsert(rows, { onConflict: 'assignment_id,student_id' })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.status(200).json({ saved: rows.length })
      return
    }

    res.status(405).json({ error: 'Method Not Allowed' })
  } catch (err) {
    console.error('[report/parent-cache] failed:', err?.message)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Cache op failed' })
  }
}

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
}
