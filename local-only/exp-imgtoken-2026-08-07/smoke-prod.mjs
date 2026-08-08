// 冒煙:直接進 production 的 runStagedGradingPhaseA(type-split + 合成圖),不重跑 classify。
// 目的:①確認合成圖分支真的被走到 ②讀值與現行無 diff ③實測 token/成本
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sg = await import('../../server/ai/staged-grading.js')
const SUB = '1778869835222-29yoyu4zd', AID = '1778869700051-ollsjczry'
const { data: sub } = await db.from('submissions').select('phase_a_state').eq('id', SUB).maybeSingle()
const { data: asg } = await db.from('assignments').select('answer_key,domain').eq('id', AID).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const r = await db.storage.from('homework-images').download(`submissions/${SUB}.webp`)
const b64 = Buffer.from(await r.data.arrayBuffer()).toString('base64')
const gt = new Map(); for (const d of (sub.phase_a_state?.arbiterDecisions ?? [])) gt.set(String(d.questionId), d.finalAnswer)

const run = async (sheetOn) => {
  process.env.READ_SHEET = sheetOn ? '1' : '0'
  const logs = []
  const t0 = Date.now()
  const res = await sg.runStagedGradingPhaseA({
    apiKey: process.env.SYSTEM_GEMINI_API_KEY,
    payload: { domain: asg.domain, answerKey: ak, strictness: ak.strictness ?? 'normal' },
    inlineImages: [{ inlineData: { data: b64, mimeType: 'image/webp' } }],
    answerKeyQuestions: ak.questions,
    internalContext: { domainHint: asg.domain, submissionId: SUB, assignmentId: AID, reuseClassifyResult: sub.phase_a_state?.classifyResult },
    onLog: (l) => logs.push(String(l)),
  }).catch(e => ({ error: String(e?.message || e) }))
  return { res, logs, sec: Math.round((Date.now() - t0) / 1000) }
}
const out = await run(true)
if (out.res?.error) { console.log('⛔ 執行失敗:', out.res.error); process.exit(1) }
console.log('合成圖 log:', out.logs.filter(l => /合成圖|type-split/.test(l)).slice(0, 4).join('\n  ') || '(無)')
const qr = out.res?.questionResults ?? out.res?.arbiterDecisions ?? []
console.log('回傳題數', Array.isArray(qr) ? qr.length : '?', ' 耗時', out.sec + 's')
let match = 0, tot = 0
for (const d of (Array.isArray(qr) ? qr : [])) {
  const qid = String(d.questionId ?? d.id ?? ''); if (!gt.has(qid)) continue
  tot++
  const a = sg.normalizeAnswerForComparison(String(d.finalAnswer ?? d.studentFinalAnswer ?? d.studentAnswer ?? ''))
  if (a === sg.normalizeAnswerForComparison(String(gt.get(qid) ?? ''))) match++
}
console.log(`對 GT ${match}/${tot}`)
fs.writeFileSync(path.join(__dirname, 'smoke-log.txt'), out.logs.join('\n'))
console.log('→ smoke-log.txt')
