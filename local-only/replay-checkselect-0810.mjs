// Phase 0b-4 全庫回放:gradeCheckSelectDeterministic(正式函數) vs 現存 accessor 判分
// 反向檢查:不只看收編率,逐格列出「會變分」的格(變好=修誤殺/放水、變壞=新誤判)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const { gradeCheckSelectDeterministic } = await import('../server/ai/staged-grading.js')
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const TARGET = new Set(['single_check', 'multi_check', 'circle_select_one'])
const since = new Date(Date.now() - 90 * 86400000).toISOString()
const { data: asgs } = await db.from('assignments').select('id,title,answer_key').gte('created_at', since).not('answer_key', 'is', null).order('created_at', { ascending: false }).limit(40)

const stat = { cells: 0, gradable: 0, same: 0, changed: [] }
for (const a of asgs || []) {
  const akQs = a.answer_key?.questions ?? []
  if (!akQs.some((q) => TARGET.has(q.questionCategory))) continue
  const akById = new Map(akQs.map((q) => [q.id, q]))
  let subs = [], p = 0
  for (;;) {
    const { data } = await db.from('submissions').select('grading_result').eq('assignment_id', a.id).not('grading_result', 'is', null).range(p * 100, p * 100 + 99)
    subs = subs.concat(data || []); if ((data || []).length < 100) break; p++
  }
  for (const s of subs) {
    for (const d of (s.grading_result?.details ?? [])) {
      const q = akById.get(d.questionId)
      if (!q || !TARGET.has(q.questionCategory) || d.finalAnswerSource === 'manual') continue
      stat.cells++
      const raw = d.studentFinalAnswer ?? d.studentAnswer ?? ''
      const status = (String(raw).trim() === '' || raw === '未作答') ? 'blank' : (raw === '無法辨識' ? 'unreadable' : 'read')
      const r = gradeCheckSelectDeterministic(q, raw, status)
      if (!r.gradable) continue
      stat.gradable++
      if (Number(r.score) === Number(d.score)) { stat.same++; continue }
      stat.changed.push({
        asg: a.title.slice(0, 14), qid: d.questionId, cat: q.questionCategory,
        stu: String(raw).slice(0, 20), key: String(q.answer).slice(0, 20),
        old: d.score, neu: r.score
      })
    }
  }
}
console.log(`格數 ${stat.cells}・收編 ${stat.gradable}(${(100 * stat.gradable / stat.cells).toFixed(1)}%)・同分 ${stat.same}・變分 ${stat.changed.length}`)
const byCat={}; for (const c of stat.changed) byCat[c.cat]=(byCat[c.cat]||0)+1; console.log('變分分佈:',JSON.stringify(byCat)); for (const c of stat.changed.filter(x=>x.cat!=='multi_check')) console.log(` ✦[${c.asg}]${c.qid}(${c.cat}) 學生「${c.stu}」標答「${c.key}」 ${c.old} → ${c.neu} 分`)
