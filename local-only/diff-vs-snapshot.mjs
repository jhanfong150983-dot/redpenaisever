// 快照對照(2026-08-08):拿 snapshots/*.json 的基準 vs 現在的 DB,逐格 diff + 帳單對照。
// 用法:node local-only/diff-vs-snapshot.mjs <快照檔名或路徑>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { modelRates, USD_TO_TWD, imageTokensOf } from './_rates.mjs'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

let f = process.argv[2]
if (!f) { const d = path.join(__dirname, 'snapshots'); const fs2 = fs.readdirSync(d).filter(x => x.endsWith('.json')).sort(); f = path.join(d, fs2[fs2.length - 1]); console.log('(未指定→用最新快照)') }
if (!fs.existsSync(f)) f = path.join(__dirname, 'snapshots', f)
const snap = JSON.parse(fs.readFileSync(f, 'utf8'))
const AID = snap.assignmentId
console.log(`基準:${snap.title}(${snap.domain}) ${snap.papers} 卷、快照於 ${snap.snapshotAt}\n`)

let subs = [], p = 0
for (;;) {
  const { data } = await db.from('submissions').select('id,score,graded_at,grading_result').eq('assignment_id', AID).not('grading_result', 'is', null).order('id').range(p * 200, p * 200 + 199)
  subs = subs.concat(data || []); if ((data || []).length < 200) break; p++
}
const now = new Map(subs.map(s => [s.id, s]))
const snapAt = Number(new Date(snap.snapshotAt))

// ── 品質 diff ──
let regraded = 0, cells = 0, flip = 0, o2x = 0, x2o = 0, ansDiff = 0
let lowB = 0, lowA = 0, scoreB = 0, scoreA = 0
const flips = []
for (const b of snap.submissions) {
  const a = now.get(b.id); if (!a) continue
  const changed = Number(a.graded_at || 0) > (b.gradedAt || 0)
  if (changed) regraded++
  const ad = new Map((a.grading_result?.details ?? []).map(d => [String(d.questionId), d]))
  scoreB += b.score || 0; scoreA += a.score || 0
  for (const d of b.details) {
    const x = ad.get(d.qid); if (!x) continue
    cells++
    if ((d.conf ?? 100) < 60) lowB++
    if ((x.confidence ?? 100) < 60) lowA++
    const nowOk = x.isCorrect === true
    if (nowOk !== d.ok) { flip++; d.ok ? o2x++ : x2o++; flips.push({ seat: b.seat, qid: d.qid, was: d.ok, now: nowOk, ansB: d.ans, ansA: x.studentAnswer, votesB: d.votes, votesA: x.glyphVotes }) }
    else if (String(d.ans ?? '') !== String(x.studentAnswer ?? '')) ansDiff++
  }
}
console.log(`重批卷數 ${regraded}/${snap.papers}   比對格數 ${cells}`)
console.log(`平均分  ${(scoreB / snap.papers).toFixed(2)} → ${(scoreA / snap.papers).toFixed(2)}   (${((scoreA - scoreB) / snap.papers >= 0 ? '+' : '')}${((scoreA - scoreB) / snap.papers).toFixed(2)})`)
console.log(`低信心  ${lowB} → ${lowA} 格`)
console.log(`判定翻盤 ${flip} 格(對→錯 ${o2x} / 錯→對 ${x2o})、讀值變動但判定同 ${ansDiff} 格`)
if (flips.length) {
  console.log('\n翻盤明細(最多 25 筆):')
  for (const x of flips.slice(0, 25)) console.log(`  座${String(x.seat).padStart(2)} ${x.qid.padEnd(8)} ${x.was ? '對→錯' : '錯→對'}  讀值「${String(x.ansB ?? '').slice(0, 14)}」→「${String(x.ansA ?? '').slice(0, 14)}」  票 ${JSON.stringify(x.votesB)?.slice(0, 40)} → ${JSON.stringify(x.votesA)?.slice(0, 40)}`)
}

// ── 帳單(快照時間之後的 usage=這次重批) ──
let rows = [], q = 0
for (;;) {
  const { data } = await db.from('ink_session_usage').select('route_key,model_name,input_tokens,output_tokens,usage_metadata,created_at').eq('assignment_id', AID).gte('created_at', snap.snapshotAt).order('created_at').range(q * 1000, q * 1000 + 999)
  rows = rows.concat(data || []); if ((data || []).length < 1000) break; q++
}
if (!rows.length) { console.log('\n(快照後尚無 usage → 還沒重批)'); process.exit(0) }
const LABEL = (r) => { const k = r.route_key || '', m = r.model_name || ''
  if (/classify/.test(k)) return '① classify'
  if (/detail_read|read_answer/.test(k) && !/re_read/.test(k)) return '② AI1 盲讀'
  if (/re_read_answer/.test(k)) return /3\.5/.test(m) ? '④ 判官×3' : '③ AI2 校對'
  if (/accessor/.test(k)) return '⑤ accessor'
  return '⑥ 其他' }
const N = regraded || snap.papers
const o = {}; let T = 0
for (const r of rows) {
  const k = LABEL(r), rt = modelRates(r.model_name)
  const th = r.usage_metadata?.thoughtsTokenCount ?? 0
  const c = ((r.input_tokens ?? 0) / 1e6 * rt.inUsd + ((r.output_tokens ?? 0) + th) / 1e6 * rt.outUsd) * USD_TO_TWD
  o[k] = o[k] || { calls: 0, img: 0, cost: 0 }
  o[k].calls++; o[k].img += imageTokensOf(r.usage_metadata); o[k].cost += c; T += c
}
console.log(`\n=== 本次重批帳單(${rows.length} calls、${N} 卷)===`)
console.log('階段'.padEnd(14), 'calls'.padStart(6), '圖tok'.padStart(10), 'NT$'.padStart(8), '每份'.padStart(7))
for (const [k, v] of Object.entries(o).sort()) console.log(k.padEnd(14), String(v.calls).padStart(6), String(v.img).padStart(10), v.cost.toFixed(1).padStart(8), (v.cost / N).toFixed(3).padStart(7))
console.log('-'.repeat(50))
console.log('合計'.padEnd(14), String(rows.length).padStart(6), String(Object.values(o).reduce((a, v) => a + v.img, 0)).padStart(10), T.toFixed(1).padStart(8), (T / N).toFixed(2).padStart(7))
