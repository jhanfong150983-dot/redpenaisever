// code 收編可行性盤點(2026-08-10):accessor 執行中的比對型題,實測
// ① 讀值 canonical 可解析率 ② naive code 比對 vs accessor 現判一致率 ③ 不一致樣本(看 accessor 在做什麼)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const TARGET = new Set(['multi_choice', 'circle_select_one', 'circle_select_many', 'single_check', 'multi_check', 'matching', 'table_cell', 'mark_in_text'])

// canonical 解析:字母集合 / 圈選 token / 數值
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩'
function parseCanonical(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s === '未作答' || s === '無法辨識') return null
  // 純字母(集合): "B" "A,C" "AC" "A、C"
  const letters = s.toUpperCase().replace(/[\s,、;；.．]/g, '')
  if (/^[A-J]{1,6}$/.test(letters)) return { kind: 'letters', v: [...letters].sort().join('') }
  // 圈選數字 token:①③ / 第1個/第 3 個 / 1,3
  let nums = []
  for (const ch of s) { const i = CIRCLED.indexOf(ch); if (i >= 0) nums.push(i + 1) }
  const mSeq = s.match(/第\s*(\d+)\s*個/g)
  if (mSeq) nums.push(...mSeq.map((x) => Number(x.match(/\d+/)[0])))
  if (!nums.length && /^[\d\s,、]+$/.test(s)) nums = s.split(/[\s,、]+/).filter(Boolean).map(Number)
  if (nums.length) return { kind: 'nums', v: [...new Set(nums)].sort((a, b) => a - b).join(',') }
  // 純數值(table_cell 數學)
  const num = s.replace(/[，,]/g, '')
  if (/^-?\d+(\.\d+)?$/.test(num)) return { kind: 'value', v: String(Number(num)) }
  // O/X 類
  if (/^[○ｏOoＯvV✓✔]$/.test(s)) return { kind: 'mark', v: 'O' }
  if (/^[✗✘xXＸ×]$/.test(s)) return { kind: 'mark', v: 'X' }
  return null
}

const since = new Date(Date.now() - 90 * 86400000).toISOString()
const { data: asgs } = await db.from('assignments').select('id,title,domain,answer_key,created_at').gte('created_at', since).not('answer_key', 'is', null).order('created_at', { ascending: false }).limit(40)

const stats = {}   // type → {cells, parseable, bothParse, agree, dis:[]}
for (const a of asgs || []) {
  const akQs = a.answer_key?.questions ?? []
  const akById = new Map(akQs.map((q) => [q.id, q]))
  if (!akQs.some((q) => TARGET.has(q.questionCategory))) continue
  let subs = [], p = 0
  for (;;) {
    const { data } = await db.from('submissions').select('grading_result').eq('assignment_id', a.id).not('grading_result', 'is', null).range(p * 100, p * 100 + 99)
    subs = subs.concat(data || []); if ((data || []).length < 100) break; p++
  }
  for (const s of subs) {
    for (const d of (s.grading_result?.details ?? [])) {
      const ak = akById.get(d.questionId)
      const t = ak?.questionCategory
      if (!t || !TARGET.has(t)) continue
      if (d.finalAnswerSource === 'manual') continue
      const st = stats[t] ?? (stats[t] = { cells: 0, stuParse: 0, bothParse: 0, agree: 0, dis: [], blank: 0 })
      st.cells++
      const raw = d.studentFinalAnswer ?? d.studentAnswer ?? ''
      if (String(raw).trim() === '' || raw === '未作答') { st.blank++; continue }
      const sv = parseCanonical(raw)
      if (sv) st.stuParse++
      const kv = parseCanonical(ak.answer)
      if (sv && kv && sv.kind === kv.kind) {
        st.bothParse++
        const codeOk = sv.v === kv.v
        const aiOk = d.isCorrect === true
        if (codeOk === aiOk) st.agree++
        else if (st.dis.length < 6) st.dis.push({ asg: a.title.slice(0, 12), qid: d.questionId, stu: String(raw).slice(0, 24), key: String(ak.answer).slice(0, 24), codeOk, aiOk, score: d.score })
      }
    }
  }
}

for (const [t, s] of Object.entries(stats).sort((a, b) => b[1].cells - a[1].cells)) {
  const pp = (x, base) => base ? (100 * x / base).toFixed(1) + '%' : '—'
  console.log(`\n■ ${t}: ${s.cells} 格(空白 ${s.blank})`)
  console.log(`  讀值可解析 ${pp(s.stuParse, s.cells - s.blank)}・雙方可解析 ${pp(s.bothParse, s.cells - s.blank)}・code vs AI 一致 ${pp(s.agree, s.bothParse)}`)
  for (const d of s.dis) console.log(`  ✦不一致: [${d.asg}]${d.qid} 學生「${d.stu}」標答「${d.key}」 code=${d.codeOk ? '對' : '錯'} AI=${d.aiOk ? '對' : '錯'}(${d.score}分)`)
}
