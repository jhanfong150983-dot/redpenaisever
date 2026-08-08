// Phase 2(單頁版):A(dynamic)×5 vs B(MINIMAL)×5,對照 ground truth 命中率。
// ground truth = 這份卷 production phase_a_state 的最終 bbox(統一框+FocusRepair 後、
//   user 已驗證批改結果 81 分與教師端一致)。
// 判準(沿用 FocusRepair 的幾何標準):x 軸重疊 ≥50% 且列中心 y 差 ≤0.015 = 命中。
// 另算「median-of-5 統一框」的命中率——production 實際用的是 K 取樣的 median,不是單次。
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

const SUB_ID = '1785430466309-pjibhofgt'  // 羅紹齊 座1、score 81、phase_a_state 48 題(production GT)
const AID = 'sxa_4660b86669f3bb73'
const MODEL = 'gemini-3.6-flash'
const N = 5

const { data: sub } = await db.from('submissions').select('page_breaks, phase_a_state').eq('id', SUB_ID).maybeSingle()
const { data: asg } = await db.from('assignments').select('answer_key, answer_sheet_mode').eq('id', AID).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const img = await db.storage.from('homework-images').download(`submissions/${SUB_ID}.webp`)
const imgB64 = Buffer.from(await img.data.arrayBuffer()).toString('base64')

// ground truth:production 最終 bbox(第 1 頁題目)
const gtAll = sub.phase_a_state?.classifyResult?.alignedQuestions ?? []
const gt = new Map()
for (const q of gtAll) if (String(q.questionId).startsWith('1-') && q.answerBbox) gt.set(String(q.questionId), q.answerBbox)
const pageIds = ak.questions.map(q => String(q.id)).filter(id => id.startsWith('1-'))
console.log(`ground truth ${gt.size} 題 / 第 1 頁題目 ${pageIds.length} 題`)
if (gt.size === 0) { console.error('⛔ ground truth 為空,中止(不花冤枉錢)'); process.exit(1) }

const specs = buildClassifyQuestionSpecs(pageIds, ak.questions, asg.answer_sheet_mode || 'with_questions')
const prompt = buildClassifyPrompt(pageIds, specs, sub.page_breaks || [], 0, [], asg.answer_sheet_mode || 'with_questions')

function parseBboxes(data) {
  const text = (data?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join('')
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let j; try { j = JSON.parse(m[0]) } catch { return null }
  const out = new Map()
  for (const q of (j.alignedQuestions ?? [])) { const b = q.answerBbox; if (q.questionId && b && [b.x, b.y, b.w, b.h].every(Number.isFinite)) out.set(String(q.questionId), { x: +b.x, y: +b.y, w: +b.w, h: +b.h }) }
  return out
}
// FocusRepair 同款幾何判準
function hit(b, k) {
  const ix = Math.max(0, Math.min(b.x + b.w, k.x + k.w) - Math.max(b.x, k.x))
  const xOv = b.w > 0 ? ix / b.w : 0
  const rowDy = Math.abs((b.y + b.h / 2) - (k.y + k.h / 2))
  return xOv >= 0.5 && rowDy <= 0.015
}
function scoreRun(bboxes) {
  if (!bboxes) return { hits: 0, total: gt.size }
  let hits = 0
  for (const [id, k] of gt) { const b = bboxes.get(id); if (b && hit(b, k)) hits++ }
  return { hits, total: gt.size }
}
function medianBox(runs) {
  const out = new Map()
  for (const id of gt.keys()) {
    const bs = runs.map(r => r?.get(id)).filter(Boolean)
    if (bs.length < 3) continue
    const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
    out.set(id, { x: med(bs.map(b => b.x)), y: med(bs.map(b => b.y)), w: med(bs.map(b => b.w)), h: med(bs.map(b => b.h)) })
  }
  return out
}

async function arm(label, payload) {
  const runs = []
  let inTok = 0, outTok = 0, thTok = 0, ms = 0
  for (let i = 0; i < N; i++) {
    const t0 = Date.now()
    const r = await callGeminiGenerateContent({ apiKey: KEY, model: MODEL, contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/webp', data: imgB64 } }] }], payload, timeoutMs: 180000 })
    ms += Date.now() - t0
    const u = r?.data?.usageMetadata ?? {}
    inTok += u.promptTokenCount || 0; outTok += u.candidatesTokenCount || 0; thTok += u.thoughtsTokenCount || 0
    const bb = r?.ok ? parseBboxes(r.data) : null
    const s = scoreRun(bb)
    console.log(`  [${label} #${i + 1}] ${Date.now() - t0}ms thoughts=${u.thoughtsTokenCount ?? 0} 命中 ${s.hits}/${s.total}`)
    runs.push(bb)
  }
  const medScore = scoreRun(medianBox(runs))
  // ⛔ 2026-08-08 修:classify=3.6-flash,輸出價 7.50(原寫 9)。費率權威 ../_rates.mjs
  const cost = (inTok / 1e6 * 1.5 + (outTok + thTok) / 1e6 * 7.5) * 33
  console.log(`  [${label}] median-of-${N} 統一框命中 ${medScore.hits}/${medScore.total}、平均 ${Math.round(ms / N / 1000)}s/次、${N} 次共 NT$${cost.toFixed(1)}(thoughts NT$${(thTok / 1e6 * 7.5 * 33).toFixed(1)})\n`)
  return { runs: runs.map(r => r ? Object.fromEntries(r) : null), medScore, inTok, outTok, thTok, cost }
}

console.log(`\n=== A 現況(dynamic thinking)×${N} ===`)
const A = await arm('A', {})
console.log(`=== B MINIMAL ×${N} ===`)
const B = await arm('B', { generationConfig: { thinkingConfig: { thinking_level: 'MINIMAL' } } })
fs.writeFileSync(path.join(__dirname, 'run5-result.json'), JSON.stringify({ A, B, gt: Object.fromEntries(gt) }, null, 2))
console.log('原始資料 → run5-result.json')
