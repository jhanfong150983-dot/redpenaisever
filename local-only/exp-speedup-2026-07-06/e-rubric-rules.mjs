// RUBRIC 穩定性鐵則沙盒（2026-07-14）：6 個 r5↔r6 同文異判格 × 新規則 × 5 輪
// 期望（老師裁定）：B型人物事蹟等價→給分、通順/因果/類比型→不得以此扣分 → 全部穩定給分
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '../../../redpenai/node_modules/@google/generative-ai/dist/index.mjs'

const envTxt = fs.readFileSync(new URL('../../.env.local', import.meta.url), 'utf8')
for (const l of envTxt.split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const genAI = new GoogleGenerativeAI(process.env.SYSTEM_GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig: { temperature: 0 } })
const AID = '1778510937216-3s4c2x9th'
// [seat, qid, 老師期望, 類型]
const CELLS = [
  [16, '4-5-5-2', '滿分', 'B型·女學堂=馬偕真實事蹟'],
  [28, '4-5-5-2', '滿分', 'B型·同上'],
  [4, '5-6-6', '滿分', 'A型·不得要求因果句式'],
  [24, '5-6-6', '滿分', 'A型·不得扣通順'],
  [18, '2-3-6', '滿分', 'A型·錯字缺字不扣'],
  [16, '2-3-5', '滿分', 'A型·不得要求類比'],
]
const RULES = `🔒 RUBRIC 穩定性鐵則（Domain 社會/自然、優先於其他規則）：
1.【表達不扣分】錯字、缺字、注音代字、語句不通順一律不扣分——能理解學生想表達的意思就照概念評分。唯有「完全無法理解在說什麼」才判該維度不成立。🚨 禁止以「語句表達不夠通順/清楚/完整/流暢」作為扣分理由。
2.【範例非清單】referenceAnswer 是「範例答案」、不是必要覆蓋清單。評分唯一錨點是各維度的 criteria；學生不需覆蓋範例答案的所有論點、深度或字數。
3.【人物事蹟等價】維度要求「人物＋其相關事蹟/事件/影響」時：人物正確、且所述為該人物真實事蹟即滿足——不要求與 referenceAnswer 列舉的事蹟相同（例：馬偕「創立淡水女學堂」與「醫治牙痛」同樣成立）。
4.【理由成立標準】理由/說明維度＝學生的理由能支持所選選項且屬相關概念即成立；不得額外要求「明確因果句式」「合理類比」「更完整的說明」——除非該維度 criteria 明文要求。
5.【輸出強制】必須回傳 rubricScores（與 rubricsDimensions 同順序、每維 {dimension, score, maxScore}）。`
const { data: asg } = await sb.from('assignments').select('answer_key').eq('id', AID).single()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const { data: subs } = await sb.from('submissions').select('id, student_id, grading_result').eq('assignment_id', AID)
const { data: stus } = await sb.from('students').select('id, seat_number').in('id', subs.map((x) => x.student_id))
async function judge(q, stuAnswer) {
  const prompt = `你是批改老師（Domain: 社會）。依 rubricsDimensions 逐維度評分。
${RULES}

題目維度（rubricsDimensions）：${JSON.stringify(q.rubricsDimensions)}
referenceAnswer（範例答案）：「${q.referenceAnswer ?? q.answer ?? ''}」
maxScore：${q.maxScore}

學生作答：「${stuAnswer}」

只輸出 JSON：{"rubricScores":[{"dimension":"...","score":0,"maxScore":0}],"scoringReason":"逐維度說明"}`
  for (let a = 0; a < 3; a++) {
    try {
      const res = await model.generateContent(prompt)
      const j = JSON.parse(res.response.text().replace(/```json|```/g, '').trim())
      if (Array.isArray(j?.rubricScores)) return j
    } catch { await new Promise((r) => setTimeout(r, 5000)) }
  }
  return null
}
for (const [seat, qid, expect, note] of CELLS) {
  const sub = subs.find((s) => stus.find((t) => t.id === s.student_id)?.seat_number === seat)
  const gr = typeof sub.grading_result === 'string' ? JSON.parse(sub.grading_result) : sub.grading_result
  const det = (gr?.details || []).find((d) => d.questionId === qid)
  const q = ak.questions.find((x) => x.id === qid)
  const stuAnswer = String(det?.studentAnswer ?? '')
  const scores = []
  for (let r = 0; r < 5; r++) {
    const j = await judge(q, stuAnswer)
    if (!j) { scores.push('?'); continue }
    const sum = j.rubricScores.reduce((a, d) => a + Math.max(0, Math.min(Number(d.maxScore) || 0, Number(d.score) || 0)), 0)
    scores.push(sum)
  }
  const stable = new Set(scores.map(String)).size === 1
  console.log(`座${seat}|${qid} [${note}] 期望${expect}(${q.maxScore}分) → 5輪: ${scores.join('/')} ${stable ? '✓穩定' : '⚠晃動'}`)
}
