// 2026-08-11 調查:semantic_score_tables 裡「只差標點就相同」的未聚合值
// 目的:定義哪些標點差異=AI read 漂移(該折疊)、哪些=語意差異(不可折疊)
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const envTxt = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
for (const l of envTxt.split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// 現行 normSemanticValue(鏡像 server semantic-score-table.js)
function normNow(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/，/g, ',').replace(/。/g, '.').replace(/；/g, ';').replace(/：/g, ':').replace(/、/g, ',')
    .replace(/^[,.;:!?，。；：、！？\s]+|[,.;:!?，。；：、！？\s]+$/g, '')
}
// 候選新折疊:拔掉「所有」標點(中英文、引號括號刪節號間隔號)後的 key —— 用來找碰撞
function stripAllPunct(s) {
  return String(s ?? '').replace(/[,.;:!?，。；：、！？…‥·・「」『』（）()\[\]【】《》〈〉""''"'——\-~～\s]/g, '')
}

const { data: rows, error } = await sb.from('semantic_score_tables')
  .select('scope_key, question_id, value_norm, value_raw, score, max_score, low_conf')
  .limit(5000)
if (error) { console.error(error.message); process.exit(1) }
console.log(`共 ${rows.length} 列凍結值`)

// (scope, qid) 內找:value_norm 不同、stripAllPunct 相同 → 標點碰撞群
const byQ = new Map()
for (const r of rows) {
  const k = `${r.scope_key}|${r.question_id}`
  const list = byQ.get(k) ?? []
  list.push(r)
  byQ.set(k, list)
}
let groups = 0, sameScore = 0, diffScore = 0
const samples = []
for (const [k, list] of byQ) {
  const byStripped = new Map()
  for (const r of list) {
    const sk = stripAllPunct(r.value_norm)
    if (!sk) continue
    const g = byStripped.get(sk) ?? []
    g.push(r)
    byStripped.set(sk, g)
  }
  for (const [sk, g] of byStripped) {
    if (g.length < 2) continue
    const norms = new Set(g.map((r) => r.value_norm))
    if (norms.size < 2) continue // value_norm 相同=本來就同一列,不算
    groups++
    const scores = new Set(g.map((r) => Number(r.score)))
    if (scores.size === 1) sameScore++; else diffScore++
    samples.push({
      q: k.split('|')[1], scope: k.split('|')[0].slice(-8),
      stripped: sk.slice(0, 24),
      variants: g.map((r) => `「${r.value_raw}」norm=「${r.value_norm}」${r.score}/${r.max_score}${r.low_conf ? '(低信心)' : ''}`),
      scoreSplit: scores.size > 1,
    })
  }
}
console.log(`\n標點碰撞群:${groups} 組(同分 ${sameScore}、不同分 ${diffScore} ⚠)\n`)
for (const s of samples) {
  console.log(`${s.scoreSplit ? '⚠️不同分' : '  同分'} 題${s.q} [${s.scope}] 拔標點後=「${s.stripped}」`)
  for (const v of s.variants) console.log(`    ${v}`)
}

// 附:全表值裡「內部含標點」的分布(看哪些符號最常出現在凍結值內部)
const punctFreq = new Map()
for (const r of rows) {
  const inner = String(r.value_norm).slice(1, -1) // 頭尾已被現行 norm 拔掉,看內部
  for (const ch of inner) {
    if (/[,.;:!?，。；：、！？…‥·・「」『』（）()\[\]【】《》〈〉""''"'——\-~～]/.test(ch)) {
      punctFreq.set(ch, (punctFreq.get(ch) ?? 0) + 1)
    }
  }
}
console.log('\n凍結值「內部」標點出現次數:')
for (const [ch, n] of [...punctFreq.entries()].sort((a, b) => b[1] - a[1])) console.log(`  「${ch}」× ${n}`)
