// 追驗:給 MINIMAL 明確頁界(PDF 等高 → pageBreaks=[1/3, 2/3])之後,座標框對不對。
// 假設:B 臂全滅不是能力問題,是「推斷頁界」那段 thinking 被關掉;把頁界寫進 prompt 就不用推。
// B'(MINIMAL+頁界)×3、A'(dynamic+頁界)×1。對照同一份 GT。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envTxt = fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8')
for (const l of envTxt.split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }

const KEY = process.env.SYSTEM_GEMINI_API_KEY
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { buildClassifyPrompt, buildClassifyQuestionSpecs } = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')

const SUB_ID = '1785430466309-pjibhofgt'
const AID = 'sxa_4660b86669f3bb73'
const MODEL = 'gemini-3.6-flash'

const { data: sub } = await db.from('submissions').select('phase_a_state').eq('id', SUB_ID).maybeSingle()
const { data: asg } = await db.from('assignments').select('answer_key, answer_sheet_mode, total_pages').eq('id', AID).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const img = await db.storage.from('homework-images').download(`submissions/${SUB_ID}.webp`)
const imgB64 = Buffer.from(await img.data.arrayBuffer()).toString('base64')

const gt = new Map()
for (const q of (sub.phase_a_state?.classifyResult?.alignedQuestions ?? []))
  if (String(q.questionId).startsWith('1-') && q.answerBbox) gt.set(String(q.questionId), q.answerBbox)
if (gt.size === 0) { console.error('⛔ GT 空'); process.exit(1) }

// 合成頁界:PDF 合併=等高分頁(total_pages=3 → [0.3333, 0.6667])
const n = asg.total_pages || 3
const synthBreaks = Array.from({ length: n - 1 }, (_, i) => (i + 1) / n)
console.log(`合成頁界: ${JSON.stringify(synthBreaks.map(v => +v.toFixed(4)))}(total_pages=${n})、GT ${gt.size} 題\n`)

const pageIds = ak.questions.map(q => String(q.id)).filter(id => id.startsWith('1-'))
const specs = buildClassifyQuestionSpecs(pageIds, ak.questions, asg.answer_sheet_mode || 'with_questions')
const prompt = buildClassifyPrompt(pageIds, specs, synthBreaks, 0, [], asg.answer_sheet_mode || 'with_questions')

function parseBboxes(data) {
  const text = (data?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join('')
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let j; try { j = JSON.parse(m[0]) } catch { return null }
  const out = new Map()
  for (const q of (j.alignedQuestions ?? [])) { const b = q.answerBbox; if (q.questionId && b && [b.x, b.y, b.w, b.h].every(Number.isFinite)) out.set(String(q.questionId), { x: +b.x, y: +b.y, w: +b.w, h: +b.h }) }
  return out
}
function hit(b, k) {
  const ix = Math.max(0, Math.min(b.x + b.w, k.x + k.w) - Math.max(b.x, k.x))
  return (b.w > 0 ? ix / b.w : 0) >= 0.5 && Math.abs((b.y + b.h / 2) - (k.y + k.h / 2)) <= 0.015
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }

async function once(label, payload) {
  const t0 = Date.now()
  const r = await callGeminiGenerateContent({ apiKey: KEY, model: MODEL, contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/webp', data: imgB64 } }] }], payload, timeoutMs: 180000 })
  const u = r?.data?.usageMetadata ?? {}
  const bb = r?.ok ? parseBboxes(r.data) : null
  let hits = 0, dys = []
  if (bb) for (const [id, k] of gt) { const b = bb.get(id); if (b) { if (hit(b, k)) hits++; dys.push(b.y - k.y) } }
  console.log(`[${label}] ${Date.now() - t0}ms thoughts=${u.thoughtsTokenCount ?? 0} 命中 ${hits}/${gt.size} y偏移中位 ${dys.length ? med(dys).toFixed(4) : '-'}`)
  return { hits, bb: bb ? Object.fromEntries(bb) : null, usage: u }
}

// 第三臂:thinkingBudget 上限(保留少量思考推頁界,砍掉其餘)
const arm = process.argv[2] || 'budget'
const out = { runs: [] }
if (arm === 'budget') {
  for (const budget of [1024, 1024, 512]) {
    out.runs.push(await once(`C budget=${budget}+頁界`, { generationConfig: { thinkingConfig: { thinkingBudget: budget } } }))
  }
}
fs.writeFileSync(path.join(__dirname, `${arm}-result.json`), JSON.stringify(out, null, 2))
console.log(`→ ${arm}-result.json`)
