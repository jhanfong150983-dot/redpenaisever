// 數學終答 code 比對回放(2026-08-11、⑥⑦查表沙盒數學臂)
// canonical:去前綴(約/大約/A:/答:)→ 抽數值+單位 → 單位同義表比對 vs 標答;回放 vs production 全格 diff
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// 單位同義表(小學數學常用;canonical key 任選組內第一個)
const UNIT_GROUPS = [
  ['cm3', '立方公分', '立方厘米', 'cm³'],
  ['m3', '立方公尺', 'm³'],
  ['cm2', '平方公分', '平方厘米', 'cm²'],
  ['m2', '平方公尺', 'm²'],
  ['km2', '平方公里', 'km²'],
  ['cm', '公分', '厘米'],
  ['m', '公尺', '米'],
  ['km', '公里', '千米'],
  ['mm', '毫米', '公釐'],
  ['kg', '公斤', '千克'],
  ['g', '公克', '克'],
  ['l', '公升', '升', 'L'],
  ['ml', '毫升', 'mL', 'cc'],
  ['元', '塊', '塊錢'],
  ['分鐘', '分', 'min', '分鐘'],
  ['小時', '時', 'hr', 'h'],
  ['秒', 's', 'sec'],
]
const UNIT_CANON = new Map()
for (const g of UNIT_GROUPS) for (const u of g) UNIT_CANON.set(u.toLowerCase(), g[0])

function parseFinal(raw) {
  let s = String(raw ?? '').trim()
  if (!s || s === '未作答' || s === '無法辨識') return null
  const isApprox = /^約|^大約/.test(s)
  // 去常見前綴/裝飾
  s = s.replace(/^[Aa][:：]\s*/, '').replace(/^答[:：]?\s*/, '').replace(/^約|^大約|^,約/g, '').trim()
  s = s.replace(/[，,]/g, '')
  // 數值(含分數 a/b 與帶分數 a又b/c 先不展開,僅小數/整數)
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(.*)$/)
  if (!m) return null
  const num = Number(m[1])
  let unit = m[2].trim().replace(/[。.\s]+$/g, '').replace(/後$/, '')
  if (/[()（）:：=+\-×x*÷/]/.test(unit) || /\d/.test(unit) || unit.length > 6) return null  // 複合答案/算式雜訊 → 不收
  const unitCanon = unit ? (UNIT_CANON.get(unit.toLowerCase()) ?? unit.toLowerCase()) : ''
  return { num, unit: unitCanon, hadUnit: !!unit, isApprox }
}

const since = new Date(Date.now() - 90 * 86400000).toISOString()
const { data: asgs } = await db.from('assignments').select('id,title,answer_key').eq('domain', '數學').gte('created_at', since).not('answer_key', 'is', null).limit(20)

const S = { cells: 0, parse: 0, agree: 0, diffs: [] }
for (const a of asgs || []) {
  const ak = a.answer_key
  const unitRule = String(ak?.unitErrorRule ?? 'zero')
  const akQs = new Map((ak?.questions || []).filter((q) => ['word_problem', 'calculation'].includes(q.questionCategory)).map((q) => [q.id, q]))
  if (!akQs.size) continue
  let subs = [], p = 0
  for (;;) { const { data } = await db.from('submissions').select('id,grading_result').eq('assignment_id', a.id).not('grading_result', 'is', null).range(p * 100, p * 100 + 99); subs = subs.concat(data || []); if ((data || []).length < 100) break; p++ }
  for (const s of subs) {
    for (const d of (s.grading_result?.details || [])) {
      const q = akQs.get(d.questionId)
      if (!q || d.finalAnswerSource === 'manual') continue
      const sc = Number(d.score)
      if (!Number.isFinite(sc)) continue // 缺分格另案
      S.cells++
      const kv = parseFinal(q.answer)
      const sv = parseFinal(d.studentFinalAnswer ?? d.studentAnswer)
      if (!kv || !sv) continue
      if (kv.isApprox) continue  // 估算題(標答帶「約」)=容差裁量區,不收編、留 accessor
      S.parse++
      const mx = Number(q.maxScore ?? d.maxScore)
      // code 判:數值相同+單位等價 → 滿分;數值同但單位缺/錯 → unitRule;數值錯 → 0
      let code
      if (sv.num === kv.num && (sv.unit === kv.unit || !kv.hadUnit)) code = mx  // 標答無單位→學生單位不比
      else if (sv.num === kv.num) code = unitRule === 'half' ? mx / 2 : (unitRule === 'deduct' ? Math.max(0, mx - (Number(ak?.unitErrorDeduction) || 1)) : 0)
      else code = 0
      if (code === sc) { S.agree++; continue }
      if (S.diffs.length < 400) S.diffs.push({ asg: a.title.slice(0, 12), qid: d.questionId, stu: String(d.studentFinalAnswer ?? d.studentAnswer).slice(0, 22), key: String(q.answer).slice(0, 18), ai: sc, code, r: (d.reason || '').replace(/\n/g, ' ').slice(0, 42) })
    }
  }
}
console.log(`格數 ${S.cells}・可解析 ${S.parse}(${(100 * S.parse / S.cells).toFixed(1)}%)・與 production 同分 ${S.agree}(${(100 * S.agree / S.parse).toFixed(1)}%)・不同 ${S.diffs.length}`)
const buckets = {}
for (const d of S.diffs) { const k = `${d.ai}→${d.code}`; buckets[k] = (buckets[k] || 0) + 1 }
console.log('差異樣態:', JSON.stringify(buckets))
for (const b of ['7→0','5→0','6→0','0→5']) { console.log('── '+b+' ──'); for (const d of S.diffs.filter(x=>String(x.ai)+'→'+String(x.code)===b).slice(0,4)) console.log(' ['+d.asg+']'+d.qid+' 「'+d.stu+'」(標「'+d.key+'」) | '+d.r) }
for (const d of []) console.log(` ✦[${d.asg}]${d.qid} 「${d.stu}」(標「${d.key}」) AI=${d.ai} code=${d.code} | ${d.r}`)
