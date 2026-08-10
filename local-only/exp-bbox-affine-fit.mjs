// 答案卷框→學生框 是否仿射可校正:fit y_st = a·y_ak + b(逐頁)、看殘差
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const fit = (xs, ys) => { // OLS y = a x + b
  const n = xs.length, mx = xs.reduce((a,b)=>a+b,0)/n, my = ys.reduce((a,b)=>a+b,0)/n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { num += (xs[i]-mx)*(ys[i]-my); den += (xs[i]-mx)**2 }
  const a = num/den, b = my - a*mx
  const res = xs.map((x,i)=>ys[i]-(a*x+b))
  return { a, b, res }
}
const q = (arr, p) => { const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length*p)] }

for (const A of [
  { id: '1778869700051-ollsjczry', name: '國語(1頁)' },
  { id: '1782277579142-g6jrjr6ed', name: '英語(3頁)' },
]) {
  const { data: asg } = await db.from('assignments').select('answer_key').eq('id', A.id).maybeSingle()
  const akQs = (asg?.answer_key?.questions ?? []).filter((x) => x.answerBbox)
  const nPages = Math.max(...akQs.map((x) => Number(x.pageIndex) || 0)) + 1

  // 學生統一框(取一份就好,跨學生離散=0 已證)+ 一份的 pageBreaks(若有)
  const { data: subs } = await db.from('submissions').select('id,grading_result,phase_a_state').eq('assignment_id', A.id).not('grading_result', 'is', null).limit(1)
  const s0 = subs[0]
  const pb = s0.phase_a_state?.pageBreaks ?? s0.grading_result?.pageBreaks ?? null
  console.log(`\n══ ${A.name} ══  pageBreaks:`, pb ? JSON.stringify(pb.map((x)=>+x.toFixed(3))) : '(無/等分)')
  const stByQid = new Map((s0.grading_result?.details ?? []).filter((d) => d.answerBbox).map((d) => [d.questionId, d.answerBbox]))

  // 逐頁擬合:答案卷 per-page y → 學生 merged y
  for (let pg = 0; pg < nPages; pg++) {
    const pairs = []
    for (const ak of akQs) {
      if ((Number(ak.pageIndex) || 0) !== pg) continue
      const st = stByQid.get(ak.id)
      if (!st) continue
      pairs.push({ qid: ak.id, akx: ak.answerBbox.x, aky: ak.answerBbox.y, stx: st.x, sty: st.y, akw: ak.answerBbox.w, stw: st.w })
    }
    if (pairs.length < 6) { console.log(` 頁${pg + 1}: 樣本不足(${pairs.length})`); continue }
    const fy = fit(pairs.map((p) => p.aky), pairs.map((p) => p.sty))
    const fx = fit(pairs.map((p) => p.akx), pairs.map((p) => p.stx))
    // 殘差換 mm(merged 圖高 = nPages 頁 → y 殘差 ×297×nPages)
    const ry = fy.res.map((r) => Math.abs(r) * 297 * nPages)
    const rx = fx.res.map((r) => Math.abs(r) * 210)
    console.log(` 頁${pg + 1}(${pairs.length} 題): y 殘差 中位 ${q(ry, .5).toFixed(1)}mm / P90 ${q(ry, .9).toFixed(1)}mm / max ${Math.max(...ry).toFixed(1)}mm   x 殘差 中位 ${q(rx, .5).toFixed(1)}mm / P90 ${q(rx, .9).toFixed(1)}mm`)
    console.log(`   y: a=${fy.a.toFixed(4)} b=${fy.b.toFixed(4)}  x: a=${fx.a.toFixed(4)} b=${fx.b.toFixed(4)}`)
    const bad = pairs.map((p, i) => ({ qid: p.qid, r: ry[i] })).sort((a, b) => b.r - a.r).slice(0, 3)
    console.log('   y 殘差最大:', bad.map((b) => `${b.qid}=${b.r.toFixed(1)}mm`).join('、'))
    // 寬度比較(語意差:答案卷框答案欄 vs 學生框作答區)
    const dw = pairs.map((p) => Math.abs(p.stw - p.akw) * 210)
    console.log(`   |寬度差| 中位 ${q(dw, .5).toFixed(1)}mm / P90 ${q(dw, .9).toFixed(1)}mm`)
  }
}
