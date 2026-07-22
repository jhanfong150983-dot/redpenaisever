// 知識點歸類寫入（2026-07-22、進階報告升級流程）：把 AI 歸類結果外科手術式合併進 answer_key。
//   POST { assignmentId, items:[{questionId, topic, knowledgePoints, ability, cnaArea, note}], kpTips:{kp:tip} }
//   ⚠ 只寫 questions[].analysis 與頂層 kpTips、其他欄位一律不碰（answer/bbox/crop metadata 都不動）——
//     不可能發生「歸類寫入把答案卷擦掉」的事故。owner 驗證 + service_role。
//   同時鏡寫 template（若 template.answer_key 有 questions 且 id 對得上）——同卷其他班共用、一次付費全班受益。
import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

const parseAk = (v) => { if (!v) return null; if (typeof v === 'string') { try { return JSON.parse(v) } catch { return null } } return v }

function mergeAnalysis(ak, byId, kpTips) {
  if (!ak || !Array.isArray(ak.questions)) return 0
  let hit = 0
  for (const q of ak.questions) {
    const it = byId.get(String(q?.id ?? '').trim())
    if (!it) continue
    q.analysis = {
      topic: String(it.topic ?? '').slice(0, 60),
      knowledgePoints: (Array.isArray(it.knowledgePoints) ? it.knowledgePoints : []).map((k) => String(k).slice(0, 60)).slice(0, 4),
      // 2026-07-22 三層版：課綱指標代碼（固定候選、跨卷穩定）——未來趨勢聚合用這層
      ...(it.code ? { code: String(it.code).slice(0, 20) } : {}),
      ...(it.ability ? { ability: String(it.ability).slice(0, 30) } : {}),
      ...(it.cnaArea ? { cnaArea: String(it.cnaArea).slice(0, 30) } : {}),
      ...(it.note ? { note: String(it.note).slice(0, 120) } : {}),
    }
    hit++
  }
  if (kpTips && typeof kpTips === 'object' && Object.keys(kpTips).length) {
    ak.kpTips = { ...(ak.kpTips && typeof ak.kpTips === 'object' ? ak.kpTips : {}), ...kpTips }
  }
  return hit
}

export default async function handler(req, res) {
  if (handleCors(req, res)) return
  try {
    const { user } = await getAuthUser(req, res)
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return }
    const supabaseAdmin = getSupabaseAdmin()

    const assignmentId = String(req.body?.assignmentId ?? '').trim()
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : []
    const kpTipsIn = req.body?.kpTips && typeof req.body.kpTips === 'object' ? req.body.kpTips : {}
    if (!assignmentId || rawItems.length === 0) { res.status(400).json({ error: 'Missing assignmentId/items' }); return }

    const kpTips = {}
    for (const [k, v] of Object.entries(kpTipsIn)) {
      if (typeof v === 'string' && v.trim()) kpTips[String(k).slice(0, 60)] = v.trim().slice(0, 120)
    }
    const byId = new Map(rawItems
      .filter((it) => it && it.questionId && it.topic)
      .map((it) => [String(it.questionId).trim(), it]))
    if (byId.size === 0) { res.status(400).json({ error: 'No valid items' }); return }

    const { data: asg } = await supabaseAdmin
      .from('assignments').select('id, owner_id, answer_key, answer_key_template_id')
      .eq('id', assignmentId).maybeSingle()
    if (!asg || asg.owner_id !== user.id) { res.status(403).json({ error: 'Forbidden' }); return }

    const ak = parseAk(asg.answer_key)
    if (!ak || !Array.isArray(ak.questions) || ak.questions.length === 0) {
      res.status(400).json({ error: 'answer_key has no questions' }); return
    }
    const hit = mergeAnalysis(ak, byId, kpTips)
    if (hit === 0) { res.status(400).json({ error: 'No questionId matched answer_key' }); return }
    const { error: upErr } = await supabaseAdmin
      .from('assignments')
      .update({ answer_key: ak, updated_at: new Date().toISOString() })
      .eq('id', assignmentId)
    if (upErr) { res.status(500).json({ error: upErr.message }); return }

    // 鏡寫 template（best-effort；template ak 可能為空 → 跳過）
    let tplHit = 0
    if (asg.answer_key_template_id) {
      try {
        const { data: tpl } = await supabaseAdmin
          .from('answer_key_templates').select('id, owner_id, answer_key')
          .eq('id', asg.answer_key_template_id).maybeSingle()
        if (tpl && tpl.owner_id === user.id) {
          const tplAk = parseAk(tpl.answer_key)
          if (tplAk && Array.isArray(tplAk.questions) && tplAk.questions.length) {
            tplHit = mergeAnalysis(tplAk, byId, kpTips)
            if (tplHit > 0) await supabaseAdmin.from('answer_key_templates').update({ answer_key: tplAk }).eq('id', tpl.id)
          }
        }
      } catch { /* template 鏡寫失敗不影響主寫入 */ }
    }
    res.status(200).json({ saved: hit, templateSaved: tplHit, kpTipsSaved: Object.keys(kpTips).length })
  } catch (err) {
    console.error('[report/kp-save] failed:', err?.message)
    res.status(500).json({ error: err instanceof Error ? err.message : 'kp-save failed' })
  }
}
