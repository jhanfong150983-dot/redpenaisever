// 多子格無序配對離線驗證（2026-07-14）：r5 全班 4-5-5 / 6-7-8 實資料
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { alignSiblingCompoundAnswers } from '../../server/ai/staged-grading.js'

const envTxt = fs.readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
for (const l of envTxt.split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const AID = '1778510937216-3s4c2x9th'
const { data: asg } = await sb.from('assignments').select('answer_key').eq('id', AID).single()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
console.log('參考答案:')
for (const qid of ['4-5-5-1', '4-5-5-2', '6-7-8-1', '6-7-8-2']) {
  const q = ak.questions.find((x) => x.id === qid)
  console.log(' ', qid, '「' + String(q?.answer ?? '').slice(0, 40) + '」cat=' + q?.questionCategory)
}
const snap = JSON.parse(fs.readFileSync(new URL('./gz-snap-shehui-r5.json', import.meta.url), 'utf8'))
let swapN = 0, keepN = 0
for (const s of snap.students) {
  // 用 r5 details 的 studentAnswer 模擬 finalReadAnswerResult
  const answers = []
  for (const qid of ['4-5-5-1', '4-5-5-2', '6-7-8-1', '6-7-8-2']) {
    const q = s.perQ[qid]
    if (!q) continue
    const t = String(q.stu ?? '').trim()
    answers.push({ questionId: qid, studentAnswerRaw: t, status: (!t || t === '未作答') ? 'blank' : t === '無法辨識' ? 'unreadable' : 'read' })
  }
  const before = answers.map((a) => `${a.questionId}=「${String(a.studentAnswerRaw).slice(0, 14)}」`).join(' ')
  const swapped = alignSiblingCompoundAnswers(answers, ak.questions)
  if (swapped.length > 0) {
    swapN++
    console.log(`\n座${s.seat} 交換組: ${swapped.join(',')}`)
    console.log('  前:', before)
    console.log('  後:', answers.map((a) => `${a.questionId}=「${String(a.studentAnswerRaw).slice(0, 14)}」`).join(' '))
  } else keepN++
}
console.log(`\n交換 ${swapN} 卷、不動 ${keepN} 卷`)
