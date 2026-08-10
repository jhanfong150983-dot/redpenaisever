// ⑦ 註釋查表制沙盒(2026-08-11):去重批次評分 vs production 逐卷
// 鏡像:model=GRADING_ACCESSOR(2.5-flash)、temp 0、rubricsDimensions 逐維輸出、總分 code 加總
// 機關:①5 輪重跑 ②每輪順序洗牌(偷懶/位置偏差偵測) ③批次大小 all vs 5
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const { callGeminiGenerateContent } = await import('../server/ai/model-adapter.js')
const KEY = process.env.SYSTEM_GEMINI_API_KEY
const MODEL = 'gemini-2.5-flash'          // = MODEL_FLASH = GRADING_ACCESSOR
const ROUNDS = 5
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// ── 1) A班國語 short_answer 資料 ──
const AID = '1778869700051-ollsjczry'
const { data: asg } = await db.from('assignments').select('answer_key').eq('id', AID).maybeSingle()
const akQs = (asg.answer_key.questions || []).filter((q) => q.questionCategory === 'short_answer')
let subs = [], p = 0
for (;;) { const { data } = await db.from('submissions').select('grading_result').eq('assignment_id', AID).not('grading_result', 'is', null).range(p * 100, p * 100 + 99); subs = subs.concat(data || []); if ((data || []).length < 100) break; p++ }

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, '').replace(/，/g, ',').replace(/。/g, '.').replace(/；/g, ';')
const QUESTIONS = []
for (const q of akQs) {
  const values = new Map() // norm → {raw, count, prodScores:[]}
  for (const s of subs) {
    const d = (s.grading_result?.details || []).find((x) => x.questionId === q.id)
    if (!d || d.finalAnswerSource === 'manual') continue
    const raw = String(d.studentFinalAnswer ?? d.studentAnswer ?? '').trim()
    if (!raw || raw === '未作答' || raw === '無法辨識') continue
    const k = norm(raw)
    const v = values.get(k) ?? { raw, count: 0, prodScores: [] }
    v.count++; v.prodScores.push(Number(d.score))
    values.set(k, v)
  }
  if (values.size >= 3) QUESTIONS.push({ id: q.id, ref: q.referenceAnswer ?? q.answer, maxScore: q.maxScore, dims: q.rubricsDimensions, values: [...values.values()] })
}
console.log(`題數 ${QUESTIONS.length}、每題去重寫法數:`, QUESTIONS.map((q) => q.values.length).join(','))

// ── 2) 批次 prompt(鏡像 production short_answer 條款、國語 carve-out)──
function buildPrompt(q, list) {
  const dims = q.dims.map((d) => `  - ${d.name}(${d.maxScore} 分):${d.criteria}`).join('\n')
  const items = list.map((v, i) => `${i + 1}. 「${v.raw}」`).join('\n')
  return `你是國小國語科的批改老師。以下是同一題的多位學生作答(已去除重複),請「逐一」依 rubric 維度評分。

【題目資訊】
- 題型:注釋/語詞解釋(short_answer)
- 參考答案:「${q.ref}」
- 配分:${q.maxScore} 分
- rubricsDimensions(評分維度,唯一評分錨點):
${dims}

【評分規則(嚴格遵守)】
- Grade by key concept presence using rubricsDimensions only. Do NOT use rubric 4-level fallback.
- RUBRIC CRITERIA LANGUAGE WARNING: criteria 中「準確提及「X」」等描述的是「目標概念」而非逐字要求。不做關鍵字比對——只判斷學生答案是否表達了相同意義。
- referenceAnswer 是「範例答案」、不是必要覆蓋清單。評分唯一錨點是各維度的 criteria。
- 國語注釋題:referenceAnswer 本身 2-4 字(如「深藍」「回頭」)是正常的,字面吻合即應滿分,不因答案短而扣分。
- 你在這裡只判**語意**(保留=滿分/部分保留=部分分/語意改變=0),錯字**不影響你的給分**;
- 🚨 絕對不要在 reason 裡寫「錯字不扣分」之類的說法;若學生有錯字,理由只需描述語意是否正確,不要對用字下結論。
- 每個維度只依自己的 criteria 獨立判分,禁止連坐。
- 每位學生的評分彼此獨立——但你必須對所有學生使用同一把尺:相似的寫法應得到相似的分數。

【學生作答清單】
${items}

【輸出】只輸出 JSON 陣列,長度=${list.length},第 i 項對應第 i 個作答:
[{"idx":1,"rubricScores":[{"dimension":"${q.dims[0]?.name}","score":0,"maxScore":${q.dims[0]?.maxScore},"reason":"..."},...] },...]`
}

const parse = (data) => {
  const t = (data?.candidates ?? []).flatMap((c) => c?.content?.parts ?? []).map((x) => x?.text ?? '').join('')
  const m = t.match(/\[[\s\S]*\]/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}
let cost = { calls: 0, inTok: 0, outTok: 0 }
async function askOnce(prompt) {
  const r = await callGeminiGenerateContent({
    apiKey: KEY, model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    payload: { generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' } } },
    timeoutMs: 60000
  })
  const u = r?.data?.usageMetadata ?? {}
  cost.calls++; cost.inTok += Number(u.promptTokenCount) || 0; cost.outTok += (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0)
  return parse(r?.data)
}
async function ask(prompt) {
  for (let att = 0; att < 3; att++) {
    try { return await askOnce(prompt) } catch (e) {
      console.log(`  retry ${att + 1}/3: ${e?.status ?? e?.message}`)
      await new Promise((r) => setTimeout(r, 2000 * (att + 1)))
    }
  }
  return null
}

// ── 3) 跑:2 種批次大小 × 5 輪、每輪洗牌 ──
const seededShuffle = (arr, seed) => {
  const a = [...arr]; let s = seed
  for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}
const results = []  // {qid, valueNorm, arm, round, score, dims}
const CONC = 4
for (const arm of ['all', 'chunk5']) {
  for (let round = 0; round < ROUNDS; round++) {
    const tasks = []
    for (const q of QUESTIONS) {
      const order = seededShuffle(q.values, round * 7 + 13)
      const chunks = arm === 'all' ? [order] : Array.from({ length: Math.ceil(order.length / 5) }, (_, i) => order.slice(i * 5, i * 5 + 5))
      for (const chunk of chunks) tasks.push({ q, chunk })
    }
    let idx = 0
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (idx < tasks.length) {
        const t = tasks[idx++]
        const out = await ask(buildPrompt(t.q, t.chunk))
        if (!Array.isArray(out)) { console.log(`  ⚠ parse fail ${t.q.id} round${round}`); continue }
        for (let i = 0; i < t.chunk.length; i++) {
          const o = out.find((x) => Number(x.idx) === i + 1) ?? out[i]
          const dims = Array.isArray(o?.rubricScores) ? o.rubricScores : []
          // 鏡像 production:總分=code 依維度 clamp 加總
          let score = 0
          for (let di = 0; di < t.q.dims.length; di++) {
            const mx = Number(t.q.dims[di]?.maxScore) || 0
            const sv = Number(dims[di]?.score)
            score += Math.max(0, Math.min(mx, Number.isFinite(sv) ? sv : 0))
          }
          results.push({ qid: t.q.id, v: norm(t.chunk[i].raw), arm, round, score, pos: i })
        }
      }
    }))
    console.log(`arm=${arm} round=${round + 1}/${ROUNDS} done(calls 累計 ${cost.calls})`)
  }
}
fs.writeFileSync(path.join(__dirname, 'exp-zhushi-batch-results.json'), JSON.stringify({ QUESTIONS: QUESTIONS.map(q => ({ id: q.id, ref: q.ref, maxScore: q.maxScore, values: q.values })), results, cost }, null, 1))

// ── 4) 分析 ──
console.log('\n══ 分析 ══')
const key = (r) => `${r.qid}|${r.v}|${r.arm}`
const byVal = new Map()
for (const r of results) { const a = byVal.get(key(r)) ?? []; a.push(r); byVal.set(key(r), a) }
for (const arm of ['all', 'chunk5']) {
  let stable = 0, unstable = 0, flips = []
  for (const [k, rs] of byVal) {
    if (!k.endsWith('|' + arm)) continue
    const ss = new Set(rs.map((x) => x.score))
    if (ss.size === 1) stable++
    else { unstable++; if (flips.length < 6) flips.push({ k, scores: rs.map((x) => x.score).join(',') }) }
  }
  console.log(`[${arm}] 值×5輪 穩定 ${stable}/${stable + unstable}(${(100 * stable / (stable + unstable)).toFixed(1)}%)`)
  for (const f of flips) console.log('   ⚠ ' + f.k.slice(0, 50) + ' → ' + f.scores)
}
// vs production
let agreeCells = 0, diffCells = 0, prodInconsist = 0
const diffList = []
for (const q of QUESTIONS) {
  for (const v of q.values) {
    const rs = results.filter((r) => r.qid === q.id && r.v === norm(v.raw) && r.arm === 'all')
    if (!rs.length) continue
    const modeScore = rs.map((x) => x.score).sort((a, b) => rs.filter(y => y.score === a).length - rs.filter(y => y.score === b).length).pop()
    const prodSet = new Set(v.prodScores)
    if (prodSet.size > 1) prodInconsist++
    for (const ps of v.prodScores) { if (ps === modeScore) agreeCells++; else diffCells++ }
    if (![...prodSet].every((x) => x === modeScore) && diffList.length < 10) diffList.push({ qid: q.id, raw: v.raw.slice(0, 18), n: v.count, prod: [...prodSet].join('/'), batch: modeScore })
  }
}
console.log(`\nvs production(格次):同分 ${agreeCells}、不同 ${diffCells};production 自身同值不同分的值 ${prodInconsist} 個`)
for (const d of diffList) console.log(` ✦${d.qid}「${d.raw}」×${d.n} prod=${d.prod} batch=${d.batch}`)
console.log(`\n成本:${cost.calls} calls、in ${cost.inTok} tok、out ${cost.outTok} tok`)
