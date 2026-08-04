// Phase 1 探針:classify(3.6-flash)開 thinking_level=MINIMAL 之後,
//   ① thoughtsTokenCount 有沒有歸零 ② bbox 是否仍為 0~1 正規化(五月雷:MINIMAL 吐 pixel 座標)
//   ③ 與現況(dynamic thinking)的 bbox 偏移量。
// 鏡像 production:同一份卷的合併圖 + buildClassifyPrompt + 全圖 parts(多頁路徑的單頁 call)。
// A(現況)×1、B(MINIMAL)×2。成本約 NT$4。唯讀 production 資料、結果只寫本目錄。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envTxt = fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8')
for (const l of envTxt.split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }

const KEY = process.env.SYSTEM_GEMINI_API_KEY
if (!KEY) { console.error('缺 SYSTEM_GEMINI_API_KEY'); process.exit(1) }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { buildClassifyPrompt, buildClassifyQuestionSpecs } = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')

// fixture:行政英語TEST 五年3班 座1 羅紹齊(已批改、有 phase_a_state 可對照)
const SUB_ID = '1785430474729-z1gnu7ai3'
const AID = 'sxa_4660b86669f3bb73'
const MODEL = 'gemini-3.6-flash'

const { data: sub } = await db.from('submissions').select('id, page_breaks').eq('id', SUB_ID).maybeSingle()
const { data: asg } = await db.from('assignments').select('answer_key, answer_sheet_mode').eq('id', AID).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const img = await db.storage.from('homework-images').download(`submissions/${SUB_ID}.webp`)
if (img.error) { console.error('圖片下載失敗:', img.error.message); process.exit(1) }
const imgB64 = Buffer.from(await img.data.arrayBuffer()).toString('base64')
console.log(`fixture: 卷 ${SUB_ID}、圖 ${(imgB64.length * 0.75 / 1024).toFixed(0)} KB、題數 ${ak.questions.length}、pageBreaks ${JSON.stringify(sub.page_breaks)}`)

// 第 1 頁的題目(production 多頁路徑=每頁一 call、送全圖)
const pageIds = ak.questions.map(q => String(q.id)).filter(id => id.startsWith('1-'))
const specs = buildClassifyQuestionSpecs(pageIds, ak.questions, asg.answer_sheet_mode || 'with_questions')
const prompt = buildClassifyPrompt(pageIds, specs, sub.page_breaks || [], 0, [], asg.answer_sheet_mode || 'with_questions')
console.log(`第 1 頁題目 ${pageIds.length} 題、prompt ${prompt.length} 字元\n`)

function parseBboxes(data) {
  const text = (data?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join('')
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return { error: 'no-json', raw: text.slice(0, 200) }
  let j; try { j = JSON.parse(m[0]) } catch (e) { return { error: 'bad-json', raw: text.slice(0, 200) } }
  const qs = Array.isArray(j.alignedQuestions) ? j.alignedQuestions : Array.isArray(j.questions) ? j.questions : []
  const out = {}
  for (const q of qs) { const b = q.answerBbox || q.bbox; if (q.questionId && b) out[String(q.questionId)] = { x: +b.x, y: +b.y, w: +b.w, h: +b.h } }
  return { bboxes: out, rawText: text.slice(0, 400) }
}

async function run(label, payload) {
  const t0 = Date.now()
  const r = await callGeminiGenerateContent({ apiKey: KEY, model: MODEL, contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/webp', data: imgB64 } }] }], payload, timeoutMs: 180000 })
  const ms = Date.now() - t0
  const u = r?.data?.usageMetadata ?? {}
  const parsed = r?.ok ? parseBboxes(r.data) : { error: `http-${r?.status}` }
  const n = parsed.bboxes ? Object.keys(parsed.bboxes).length : 0
  const pixel = parsed.bboxes ? Object.entries(parsed.bboxes).filter(([, b]) => b.x > 2 || b.y > 2 || b.w > 2 || b.h > 2) : []
  console.log(`[${label}] ${ms}ms  in=${u.promptTokenCount} out=${u.candidatesTokenCount} thoughts=${u.thoughtsTokenCount ?? 0}  題=${n}/${pageIds.length}  pixel框=${pixel.length}${parsed.error ? '  ⚠ ' + parsed.error : ''}`)
  return { label, ms, usage: u, ...parsed }
}

const A = await run('A 現況(dynamic)  ', {})
const B1 = await run('B1 MINIMAL       ', { generationConfig: { thinkingConfig: { thinking_level: 'MINIMAL' } } })
const B2 = await run('B2 MINIMAL       ', { generationConfig: { thinkingConfig: { thinking_level: 'MINIMAL' } } })

// bbox 偏移:B vs A(同題中心點距離,單位=頁面比例)
function drift(a, b) {
  if (!a?.bboxes || !b?.bboxes) return null
  const ds = []
  for (const [id, ba] of Object.entries(a.bboxes)) {
    const bb = b.bboxes[id]; if (!bb) continue
    ds.push({ id, d: Math.hypot((ba.x + ba.w / 2) - (bb.x + bb.w / 2), (ba.y + ba.h / 2) - (bb.y + bb.h / 2)) })
  }
  ds.sort((x, y) => y.d - x.d)
  return ds
}
for (const [name, d] of [['B1 vs A', drift(A, B1)], ['B2 vs A', drift(A, B2)], ['B1 vs B2(MINIMAL 自身穩定度)', drift(B1, B2)]]) {
  if (!d) { console.log(`${name}: 無法比對`); continue }
  const med = d.length ? d[Math.floor(d.length / 2)].d : 0
  console.log(`\n${name}: 共 ${d.length} 題、中位偏移 ${med.toFixed(4)}、最大 ${d[0]?.d.toFixed(4)}(${d[0]?.id})、>0.01 的 ${d.filter(x => x.d > 0.01).length} 題`)
  for (const x of d.slice(0, 3)) console.log(`   ${x.id}: ${x.d.toFixed(4)}`)
}
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ A, B1, B2 }, null, 2))
console.log('\n原始結果 → result.json')
