// read thinking 階梯實驗（2026-07-17）——背景：model-adapter 全 strip thinkingConfig、production read 實跑預設全思考
//   （thoughts=57% 帳單、read 家族 84%）。問題：3.5-flash read 開 MINIMAL/LOW 品質守不守得住？
// 鏡像 production：text family 兩角色 prompt（含 07-15 立場條款）、temp0、batch30、fill_blank、培英數學 E4 六卷 crops。
// 判準：①L1放行組真錯率（stable 且≠老師定案）不得高於 DEFAULT ②NR率 ③GT一致率 ④thoughts/成本。
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { normalizeAnswerForComparison, computeConsistencyStatus } from '../../server/ai/staged-grading.js'

const envTxt = fs.readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
for (const l of envTxt.split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const KEY = process.env.SYSTEM_GEMINI_API_KEY
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const E4DIR = new URL('../exp-speedup-2026-07-06/', import.meta.url)
const { inputs } = JSON.parse(fs.readFileSync(new URL('./inputs.json', E4DIR), 'utf8'))
const e4subs = JSON.parse(fs.readFileSync(new URL('./e4-subs.json', E4DIR), 'utf8'))
const truthBySub = new Map(inputs.map((x) => [x.submissionId, new Map((x.finalAnswers || []).map((f) => [f.questionId, f.finalStudentAnswer]))]))

// 正確答案（read2 知答標籤用）：由 submission → assignment.answer_key
const { data: subRows } = await sb.from('submissions').select('id, assignment_id').eq('id', e4subs[0].submissionId).limit(1)
const { data: asgRows } = await sb.from('assignments').select('id, answer_key').eq('id', subRows[0].assignment_id).limit(1)
const akRaw = typeof asgRows[0].answer_key === 'string' ? JSON.parse(asgRows[0].answer_key) : asgRows[0].answer_key
const ansByQid = new Map((akRaw?.questions || []).map((q) => [String(q.id).trim(), String(q.answer ?? q.referenceAnswer ?? '').trim()]))
console.log(`answer_key 載入：${ansByQid.size} 題（assignment ${subRows[0].assignment_id}）`)

// production text family prompt 鏡像（staged-grading tsReadHead、非英語、無紅框 markLine）
const RULE_TEXT = '這些是「填空/簡答題」：回報學生手寫的文字內容。若學生寫的是句子或片語，請輸出「完整連續的一句」(照原樣、保留詞間空格)，不要拆成逗號分隔的單字碎片。⚠ 若學生有「圈選/勾選印刷選項」或先寫立場詞（同意、不同意、支持、反對、勾選的類別名），把該立場抄在輸出最前面、用「｜」接理由——學生圈選的印刷選項文字算學生的作答、要抄出來。'
const ROLE = {
  main: '你是抄寫員：不知道正確答案，只忠實回報學生實際手寫的內容、不要猜。',
  review: '你是校對員：每題標籤可能附正確答案，只當「看仔細一點」的提示；仍只回報學生實際手寫的內容、看不到就 blank，絕不可把正確答案填進去。'
}
const head = (role) => `以下是多張「同一題型」的作答區裁切放大圖，每張圖前有題號標籤。${ROLE[role]}\n${RULE_TEXT}\n沒寫→status="blank"、有寫看不懂→status="unreadable"。只輸出 JSON：{"answers":[{"questionId":"...","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}`

const cellsBySub = new Map()
for (const meta of e4subs) {
  const cells = []
  for (let i = 1; i <= 30; i++) {
    const qid = `1-1-${i}`
    try { cells.push({ qid, b64: fs.readFileSync(new URL(`./crops/${meta.submissionId.slice(-6)}-${qid}.jpg`, E4DIR)).toString('base64') }) } catch {}
  }
  cellsBySub.set(meta.submissionId, cells)
}

async function callRead({ model, thinking, role, cells }) {
  const parts = [{ text: head(role) }]
  for (const c of cells) {
    const ans = role === 'review' ? ansByQid.get(c.qid) : ''
    parts.push({ text: `--- 題目 ${c.qid}${ans ? `（正確答案：${ans}）` : ''} ---` })
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: c.b64 } })
  }
  const generationConfig = { temperature: 0 }
  if (thinking) generationConfig.thinkingConfig = { thinking_level: thinking }
  const body = { contents: [{ role: 'user', parts }], generationConfig }
  for (let a = 0; a < 3; a++) {
    const t0 = Date.now()
    try {
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 180000)
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal
      })
      clearTimeout(to)
      const j = await r.json()
      if (!r.ok) { if (a < 2 && (r.status === 429 || r.status >= 500)) { await new Promise((z) => setTimeout(z, 8000 * (a + 1))); continue } return { err: `HTTP${r.status}:${JSON.stringify(j).slice(0, 120)}`, ms: Date.now() - t0 } }
      const txt = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').replace(/```json|```/g, '').trim()
      let arr = []
      try { const m = txt.match(/\{[\s\S]*\}/); arr = (m ? JSON.parse(m[0]) : {})?.answers || [] } catch {}
      return { byQ: new Map(arr.map((x) => [String(x?.questionId).trim(), x])), usage: j?.usageMetadata || {}, ms: Date.now() - t0 }
    } catch (e) { if (a < 2) { await new Promise((z) => setTimeout(z, 8000 * (a + 1))); continue } return { err: String(e?.message || e).slice(0, 120), ms: Date.now() - t0 } }
  }
  return { err: 'exhausted', ms: 0 }
}

// ---- 探針：各 model × thinking_level 是否接受＋thoughts 實際水位（單卷單 call）----
const probeCells = cellsBySub.get(e4subs[0].submissionId).slice(0, 5)
console.log('\n== 探針（5 crops 小 call）==')
const probeOk = {}
for (const [model, th] of [['gemini-3.5-flash', 'MINIMAL'], ['gemini-3.5-flash', 'LOW'], ['gemini-2.5-flash', 'MINIMAL']]) {
  const r = await callRead({ model, thinking: th, role: 'main', cells: probeCells })
  const u = r.usage || {}
  console.log(`  ${model}+${th}: ${r.err ? '❌ ' + r.err : `✅ thoughts=${u.thoughtsTokenCount ?? 0} prompt=${u.promptTokenCount} cand=${u.candidatesTokenCount} ${Math.round(r.ms / 1000)}s`}`)
  probeOk[`${model}|${th}`] = !r.err
}

// ---- 主實驗：3.5-flash、DEFAULT vs MINIMAL（LOW 探針過就加）×5 輪 ×6 卷 × read1/read2 ----
const ARMS = [{ name: 'DEFAULT', thinking: null }, { name: 'MINIMAL', thinking: 'MINIMAL' }]
if (probeOk['gemini-3.5-flash|LOW']) ARMS.push({ name: 'LOW', thinking: 'LOW' })
const ROUNDS = 5
console.log(`\n主實驗：${ARMS.map((a) => a.name).join('/')} × ${ROUNDS} 輪 × ${e4subs.length} 卷 × 2 讀 = ${ARMS.length * ROUNDS * e4subs.length * 2} calls`)

const runPool = async (tasks, limit) => { let i = 0; await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => { while (i < tasks.length) { const t = tasks[i++]; await t() } })) }
const raw = []  // {arm, round, sub, role, qid, val, status, thoughts...}
for (const arm of ARMS) {
  for (let round = 0; round < ROUNDS; round++) {
    const tasks = []
    for (const meta of e4subs) for (const role of ['main', 'review']) {
      tasks.push(async () => {
        const r = await callRead({ model: 'gemini-3.5-flash', thinking: arm.thinking, role, cells: cellsBySub.get(meta.submissionId) })
        raw.push({ arm: arm.name, round, sub: meta.submissionId, role, err: r.err || null, ms: r.ms, usage: r.usage || null, answers: r.byQ ? [...r.byQ.values()] : [] })
      })
    }
    await runPool(tasks, 4)
    process.stdout.write(`  ${arm.name} r${round + 1} 完成\n`)
  }
}
fs.writeFileSync(new URL('./out.json', import.meta.url), JSON.stringify(raw))

// ---- 統計 ----
const fold = (s) => normalizeAnswerForComparison(String(s ?? ''))
const num = (v) => Number(v) || 0
console.log('\n== 結果 ==')
console.log('arm | NR率 | L1放行真錯率⚠ | r1 vs 定案 | blank率 | thoughts/call | 秒/call | 估NT$/卷')
for (const arm of ARMS) {
  const rows = raw.filter((x) => x.arm === arm.name)
  const errN = rows.filter((x) => x.err).length
  let stable = 0, tot = 0, passWrong = 0, passGT = 0, gtHit = 0, gtTot = 0, blank = 0, cellN = 0
  for (let round = 0; round < ROUNDS; round++) for (const meta of e4subs) {
    const g = (role) => new Map((rows.find((x) => x.round === round && x.sub === meta.submissionId && x.role === role)?.answers || []).map((a) => [String(a.questionId).trim(), a]))
    const m1 = g('main'), m2 = g('review')
    const truth = truthBySub.get(meta.submissionId) || new Map()
    for (const c of cellsBySub.get(meta.submissionId)) {
      const a1 = m1.get(c.qid) || { status: 'blank', studentAnswerRaw: '' }
      const a2 = m2.get(c.qid) || { status: 'blank', studentAnswerRaw: '' }
      cellN++
      if (a1.status === 'blank') blank++
      const cs = computeConsistencyStatus(a1, { status: a2.status, studentAnswerRaw: a2.studentAnswerRaw }, 'fill_blank')
      tot++
      const isStable = cs === 'stable'
      if (isStable) stable++
      const t = truth.get(c.qid)
      if (t !== undefined) {
        gtTot++
        if (fold(a1.studentAnswerRaw) === fold(t)) gtHit++
        if (isStable) { passGT++; if (fold(a1.studentAnswerRaw) !== fold(t)) passWrong++ }
      }
    }
  }
  const th = rows.reduce((s, x) => s + num(x.usage?.thoughtsTokenCount), 0) / Math.max(1, rows.length - errN)
  const inTok = rows.reduce((s, x) => s + num(x.usage?.promptTokenCount), 0)
  const outTok = rows.reduce((s, x) => s + num(x.usage?.candidatesTokenCount) + num(x.usage?.thoughtsTokenCount), 0)
  // ✅ 費率正確(本檔 model=3.5-flash → 1.50/9.00);費率權威 ../_rates.mjs
  const costPerSub = (inTok * 1.5 + outTok * 9) / 1e6 * 33 / (ROUNDS * e4subs.length)
  const ms = rows.filter((x) => !x.err).map((x) => x.ms)
  console.log(`  ${arm.name} | NR ${(100 - stable / tot * 100).toFixed(1)}% | ${passWrong}/${passGT} (${(passWrong / Math.max(1, passGT) * 100).toFixed(1)}%) | ${gtHit}/${gtTot} (${(gtHit / Math.max(1, gtTot) * 100).toFixed(0)}%) | ${(blank / cellN * 100).toFixed(1)}% | ${Math.round(th)} | ${(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length) / 1000).toFixed(1)}s | ${costPerSub.toFixed(2)}${errN ? ` | err=${errN}` : ''}`)
}
console.log('\n（L1放行真錯率=兩讀 stable 卻≠老師定案＝會靜默出錯的比例、硬 gate；成本=兩讀合計/卷、費率沿 mode-cost-real）')
