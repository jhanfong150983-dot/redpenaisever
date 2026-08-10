// 答案卷 bbox 當模板可行性(2026-08-10、user 提問:Gradescope 模式)
// ① 同題跨學生 bbox 離散度:小 → PDF 卷可用固定模板、免逐生 classify
// ② 答案卷 answerBbox vs 學生實框:偏移小且穩定 → 答案卷框可直接當模板
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const ASSIGNMENTS = [
  { id: '1778869700051-ollsjczry', name: '國語 A班' },
  { id: '1782277579142-g6jrjr6ed', name: '英語期末定期評量' },
]

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) }

for (const A of ASSIGNMENTS) {
  const { data: asg } = await db.from('assignments').select('title,domain,answer_key').eq('id', A.id).maybeSingle()
  const akQs = asg?.answer_key?.questions ?? []
  const akByQid = new Map(akQs.map((q) => [q.id, q]))
  const nPages = Math.max(...akQs.map((q) => Number(q.pageIndex) || 0)) + 1

  let subs = [], p = 0
  for (;;) {
    const { data } = await db.from('submissions').select('id,source,grading_result').eq('assignment_id', A.id).not('grading_result', 'is', null).range(p * 100, p * 100 + 99)
    subs = subs.concat(data || []); if ((data || []).length < 100) break; p++
  }
  const srcCount = {}
  for (const s of subs) srcCount[s.source ?? '?'] = (srcCount[s.source ?? '?'] || 0) + 1
  console.log(`\n══ ${A.name}(${asg.title})══`)
  console.log(`卷數 ${subs.length}、來源 ${JSON.stringify(srcCount)}、答案卷 ${akQs.length} 題、${nPages} 頁`)

  // 逐題收集學生 bbox
  const byQid = new Map()
  for (const s of subs) {
    for (const d of (s.grading_result?.details ?? [])) {
      const b = d.answerBbox
      if (!b || typeof b.x !== 'number') continue
      const arr = byQid.get(d.questionId) ?? []
      arr.push(b)
      byQid.set(d.questionId, arr)
    }
  }

  // ① 跨學生離散度(normalized;換算 A4 mm:x/w×210、y/h×297×nPages 因 merged 圖高=nPages 頁)
  const spreads = []
  for (const [qid, boxes] of byQid) {
    if (boxes.length < 5) continue
    spreads.push({
      qid,
      n: boxes.length,
      sx: std(boxes.map((b) => b.x)), sy: std(boxes.map((b) => b.y)),
      sw: std(boxes.map((b) => b.w)), sh: std(boxes.map((b) => b.h)),
    })
  }
  const q90 = (arr) => { const s2 = [...arr].sort((a, b) => a - b); return s2[Math.floor(s2.length * 0.9)] }
  console.log(`\n① 同題跨學生離散(std、normalized→A4 mm)`)
  console.log(`   x: median ${(q90(spreads.map(s=>s.sx))*210).toFixed(1)}mm(P90)  y: ${(q90(spreads.map(s=>s.sy))*297*nPages).toFixed(1)}mm(P90)`)
  console.log(`   全題平均 std x=${(mean(spreads.map(s=>s.sx))*210).toFixed(2)}mm y=${(mean(spreads.map(s=>s.sy))*297*nPages).toFixed(2)}mm w=${(mean(spreads.map(s=>s.sw))*210).toFixed(2)}mm h=${(mean(spreads.map(s=>s.sh))*297*nPages).toFixed(2)}mm`)
  const worst = spreads.sort((a, b) => (b.sx + b.sy) - (a.sx + a.sy)).slice(0, 3)
  for (const w of worst) console.log(`   最散:${w.qid} std x=${(w.sx*210).toFixed(1)}mm y=${(w.sy*297*nPages).toFixed(1)}mm(n=${w.n})`)

  // ② 答案卷框 vs 學生平均框(答案卷 per-page 座標 → merged 座標:y'=(pageIndex+y)/nPages)
  console.log(`\n② 答案卷框 vs 學生實框(平均差、A4 mm)`)
  const diffs = []
  for (const [qid, boxes] of byQid) {
    const ak = akByQid.get(qid)
    if (!ak?.answerBbox || boxes.length < 5) continue
    const pg = Number(ak.pageIndex) || 0
    const akM = { x: ak.answerBbox.x, y: (pg + ak.answerBbox.y) / nPages, w: ak.answerBbox.w, h: ak.answerBbox.h / nPages }
    const st = { x: mean(boxes.map((b) => b.x)), y: mean(boxes.map((b) => b.y)), w: mean(boxes.map((b) => b.w)), h: mean(boxes.map((b) => b.h)) }
    diffs.push({ qid, dx: (st.x - akM.x) * 210, dy: (st.y - akM.y) * 297 * nPages, dw: (st.w - akM.w) * 210, dh: (st.h - akM.h) * 297 * nPages })
  }
  if (diffs.length) {
    const abs = (k) => diffs.map((d) => Math.abs(d[k]))
    console.log(`   |dx| 平均 ${mean(abs('dx')).toFixed(1)}mm / P90 ${q90(abs('dx')).toFixed(1)}mm・|dy| 平均 ${mean(abs('dy')).toFixed(1)}mm / P90 ${q90(abs('dy')).toFixed(1)}mm`)
    console.log(`   |dw| 平均 ${mean(abs('dw')).toFixed(1)}mm・|dh| 平均 ${mean(abs('dh')).toFixed(1)}mm`)
    console.log(`   系統性偏移(帶正負):dx=${mean(diffs.map(d=>d.dx)).toFixed(1)}mm dy=${mean(diffs.map(d=>d.dy)).toFixed(1)}mm`)
    const w2 = diffs.sort((a, b) => (Math.abs(b.dx) + Math.abs(b.dy)) - (Math.abs(a.dx) + Math.abs(a.dy))).slice(0, 4)
    for (const d of w2) console.log(`   最偏:${d.qid} dx=${d.dx.toFixed(1)}mm dy=${d.dy.toFixed(1)}mm dw=${d.dw.toFixed(1)}mm`)
  } else {
    console.log('   (答案卷無可對照 bbox)')
  }
  fs.writeFileSync(path.join(__dirname, `bbox-template-${A.id}.json`), JSON.stringify({ spreads, diffs }, null, 1))
}
