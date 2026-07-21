// 家長報告快取（2026-07-20）：只存花錢的 AI 產物（逐題診斷 + 老師的話）到 parent_reports。
//   GET  ?assignmentId=  → 載入該作業全部已快取的診斷/評語，並用指紋比對回傳每筆 stale。
//   POST { assignmentId, items:[{studentId, diagnosis, comment}] } → 批次 upsert，
//        server 端當下讀 submission.graded_at + answer_key 內容雜湊蓋指紋。
//   ⚠指紋不可用 assignment.updated_at（sync/任何寫入都會 bump、報告幾分鐘就假失效）——
//     改用 answer_key「內容雜湊」，只有答案卷真的變才失效。graded_at 抓重批改。
//   截圖不進此表（免費、由 /api/report/crops 現切）。存取一律 service_role + owner 驗證。
import crypto from 'node:crypto'
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

// 答案卷「答案內容」指紋：只取影響報告對錯的欄位（每題 id + answer + parts 答案），
//   ⚠不可含整個 answer_key——批改會回寫 bbox/crop/alignment 等 metadata、害整個雜湊變、報告全假失效。
//   只有老師真的改「答案」才會變。跨讀取穩定。
function akFingerprint(ak) {
  let obj = ak
  if (typeof ak === 'string') { try { obj = JSON.parse(ak) } catch { obj = null } }
  const qs = Array.isArray(obj?.questions) ? obj.questions : []
  const core = qs.map((q) => ({
    id: String(q?.id ?? q?.questionId ?? ''),
    a: String(q?.answer ?? q?.referenceAnswer ?? ''),
    p: Array.isArray(q?.parts) ? q.parts.map((pp) => `${pp?.subId ?? ''}=${pp?.answer ?? ''}`) : [],
  }))
  return crypto.createHash('sha1').update(JSON.stringify(core)).digest('hex')
}

async function loadAssignment(supabaseAdmin, assignmentId, userId) {
  const { data: asg } = await supabaseAdmin
    .from('assignments').select('id, owner_id, answer_key').eq('id', assignmentId).maybeSingle()
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

      // 輕量模式：只回「有幾筆家長報告」（給重批改/改答案卷的前置閘用）——不撈診斷內容、不算 stale，
      //   避免整包 diagnosis JSONB 拖慢前置檢查（原本 ~1s 像當機）。owner 只查 owner_id、不撈 answer_key。
      if (String(req.query?.countOnly ?? '') === '1') {
        const { data: a } = await supabaseAdmin
          .from('assignments').select('owner_id').eq('id', assignmentId).maybeSingle()
        if (!a || a.owner_id !== user.id) { res.status(403).json({ error: 'Forbidden' }); return }
        let q = supabaseAdmin
          .from('parent_reports').select('student_id', { count: 'exact', head: true }).eq('assignment_id', assignmentId)
        // 可選：限縮到指定學生（重批改只影響被重批的那幾位、不是整份作業）。
        const sidsRaw = String(req.query?.studentIds ?? '').trim()
        if (sidsRaw) {
          const ids = sidsRaw.split(',').map((s) => s.trim()).filter(Boolean)
          if (ids.length) q = q.in('student_id', ids)
        }
        const { count } = await q
        res.setHeader('Cache-Control', 'no-store')
        res.status(200).json({ count: count ?? 0 })
        return
      }

      const asg = await loadAssignment(supabaseAdmin, assignmentId, user.id)
      if (!asg) { res.status(403).json({ error: 'Forbidden' }); return }

      const { data: rows } = await supabaseAdmin
        .from('parent_reports')
        .select('student_id, diagnosis, comment, graded_fp, answer_key_fp')
        .eq('assignment_id', assignmentId)
      const cached = Array.isArray(rows) ? rows : []

      // 現值指紋：每生 graded_at＋score（抓重批改「與老師手動改分」）+ answer_key 內容雜湊（抓改答案卷）
      //   2026-07-22：graded_fp 從 graded_at 擴充為 `${graded_at}|${score}`——老師申訴改分不動 graded_at、
      //   舊指紋聞不到 → 報告停在舊分數。score 是輕欄位、不碰大 JSONB。格式切換屬一次性失效（重生即回新格式）。
      //   殘餘：只改答案文字、分數沒變 → 不失效（外觀級、接受）。
      const { data: subs } = await supabaseAdmin
        .from('submissions').select('student_id, graded_at, score').eq('assignment_id', assignmentId)
      const gradedNow = new Map((subs ?? []).map((s) => [String(s.student_id), `${s.graded_at}|${s.score ?? ''}`]))
      const akNow = akFingerprint(asg.answer_key)

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
      const asg = await loadAssignment(supabaseAdmin, assignmentId, user.id)
      if (!asg) { res.status(403).json({ error: 'Forbidden' }); return }
      if (rawItems.length === 0) { res.status(200).json({ saved: 0 }); return }

      // 蓋指紋用的現值 graded_at＋score + answer_key 內容雜湊（2026-07-22 與 GET 同格式 `${graded_at}|${score}`）
      const { data: subs } = await supabaseAdmin
        .from('submissions').select('student_id, graded_at, score').eq('assignment_id', assignmentId)
      const gradedNow = new Map((subs ?? []).map((s) => [String(s.student_id), `${s.graded_at}|${s.score ?? ''}`]))
      const akFp = akFingerprint(asg.answer_key)

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
            answer_key_fp: akFp,
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
