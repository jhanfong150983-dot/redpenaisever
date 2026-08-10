// 簡報用真實資料抽取(匿名):A班國語定期評量 → 逐題 P/D、分數分佈、範例格
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const AID = '1778869700051-ollsjczry'
let subs = [], p = 0
for (;;) {
  const { data, error } = await db.from('submissions').select('id,score,grading_result').eq('assignment_id', AID).not('grading_result', 'is', null).order('id').range(p * 200, p * 200 + 199)
  if (error) throw error
  subs = subs.concat(data || []); if ((data || []).length < 200) break; p++
}
console.log('papers:', subs.length)
const one = subs[0].grading_result
const qrs = one.details || []
console.log('sample keys:', Object.keys(one).slice(0, 10))
console.log('qr keys:', qrs[0] ? Object.keys(qrs[0]).slice(0, 20) : 'none')

// 逐題聚合
const byQ = new Map()
const totals = []
for (const s of subs) {
  const qs = s.grading_result?.details || []
  totals.push(Number(s.score))
  for (const q of qs) {
    const g = byQ.get(q.questionId) ?? { max: 0, scores: [], type: q.questionType || q.type, oks: 0, ans: [] }
    const max = Number(q.maxScore ?? q.max ?? 0)
    g.max = Math.max(g.max, max)
    g.scores.push(Number(q.score ?? 0))
    if (q.isCorrect === true || q.correct === true) g.oks++
    const ans = q.finalAnswer ?? q.studentAnswer ?? ''
    if (ans) g.ans.push({ ans: String(ans).slice(0, 20), score: q.score, max })
    byQ.set(q.questionId, g)
  }
}
// P = 平均得分率;D = 前27% P - 後27% P(以總分排序)
const sorted = subs.map(s => ({ id: s.id, t: Number(s.score) })).sort((a, b) => b.t - a.t)
const k = Math.max(1, Math.round(sorted.length * 0.27))
const topIds = new Set(sorted.slice(0, k).map(x => x.id))
const botIds = new Set(sorted.slice(-k).map(x => x.id))
const items = []
for (const [qid, g] of byQ) {
  const P = g.max ? g.scores.reduce((a, b) => a + b, 0) / g.scores.length / g.max : 0
  let tp = [], bp = []
  for (const s of subs) {
    const q = (s.grading_result?.details || []).find(x => x.questionId === qid)
    if (!q || !g.max) continue
    const r = Number(q.score ?? 0) / g.max
    if (topIds.has(s.id)) tp.push(r)
    if (botIds.has(s.id)) bp.push(r)
  }
  const D = (tp.length && bp.length) ? tp.reduce((a,b)=>a+b,0)/tp.length - bp.reduce((a,b)=>a+b,0)/bp.length : 0
  items.push({ qid, type: g.type, max: g.max, P: +P.toFixed(2), D: +D.toFixed(2) })
}
items.sort((a, b) => String(a.qid).localeCompare(String(b.qid), 'zh-Hant', { numeric: true }))
console.log('\nquestions:', items.length)
console.log(items.slice(0, 40))
console.log('\nscore distribution:', totals.sort((a,b)=>a-b).join(','))
console.log('mean:', (totals.reduce((a,b)=>a+b,0)/totals.length).toFixed(1))

// 範例 short_answer 格(取有文字讀值的)
for (const s of subs.slice(0, 6)) {
  for (const q of (s.grading_result?.details || [])) {
    const t = q.questionType || q.type
    if (t === 'short_answer' && q.finalAnswer && String(q.finalAnswer).length >= 4) {
      console.log('example cell:', { qid: q.questionId, ans: String(q.finalAnswer).slice(0, 30), score: q.score, max: q.maxScore, reason: String(q.scoringReason || '').slice(0, 60) })
    }
  }
  break
}
fs.writeFileSync(path.join(__dirname, 'deck-real-data.json'), JSON.stringify({ papers: subs.length, items, totals }, null, 1))
