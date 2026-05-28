// One-off backfill: 國中一年級測試B班 / 國語第二次定期評量 (1778869875728-wlkato1nr)
// 用題本圖 + 已灌好的國語 concept_map 跑 Gemini、把 concept_code 寫回 answer_key
// 用法：node scripts/backfill-concept-tags-1778869875728.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const ASSIGNMENT_ID = '1778869875728-wlkato1nr'
const TEMPLATE_ID = '1778692710671-b5xzwo21m'
const GRADE = 7
const DOMAIN = '國語'
const SUBJECT = 'chinese'
const BOOKLET_PAGES = 6

// ── load env ─────────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url))
const envText = readFileSync(resolve(__dir, '..', '.env.local'), 'utf-8')
const env = {}
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const SUPABASE_URL = env.SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY
const GEMINI_KEY = env.SYSTEM_GEMINI_API_KEY || env.SECRET_API_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
if (!GEMINI_KEY) throw new Error('Missing SYSTEM_GEMINI_API_KEY / SECRET_API_KEY')

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

// ── 1. 讀 answer_key questions ──────────────────────────────────────────────
console.log(`[backfill] reading answer_key for ${ASSIGNMENT_ID}`)
const { data: assignment, error: aErr } = await sb
  .from('assignments').select('answer_key').eq('id', ASSIGNMENT_ID).single()
if (aErr) throw aErr
const answerKey = typeof assignment.answer_key === 'string' ? JSON.parse(assignment.answer_key) : assignment.answer_key
const questions = (answerKey?.questions || []).map(q => ({
  id: q.id,
  questionCategory: q.questionCategory,
  answer: q.answer ?? q.referenceAnswer ?? ''
}))
console.log(`[backfill] ${questions.length} questions in answer_key`)

// ── 2. 讀 concept_map (chinese, grade 7) ────────────────────────────────────
console.log(`[backfill] reading concept_map (subject=${SUBJECT}, grade=${GRADE})`)
const { data: conceptRows, error: cErr } = await sb
  .from('concept_map').select('code, label, description')
  .eq('subject', SUBJECT).eq('grade', GRADE).order('code')
if (cErr) throw cErr
console.log(`[backfill] ${conceptRows.length} concept rows available`)

// ── 3. 下載題本圖 ────────────────────────────────────────────────────────────
console.log(`[backfill] downloading ${BOOKLET_PAGES} booklet pages from question-booklets/${TEMPLATE_ID}/`)
const bookletParts = []
for (let i = 0; i < BOOKLET_PAGES; i++) {
  const path = `question-booklets/${TEMPLATE_ID}/page-${i}.webp`
  const { data, error } = await sb.storage.from('homework-images').download(path)
  if (error || !data) throw new Error(`download failed: ${path} - ${error?.message}`)
  const buf = Buffer.from(await data.arrayBuffer())
  bookletParts.push({ inlineData: { mimeType: 'image/webp', data: buf.toString('base64') } })
  console.log(`  page ${i}: ${(buf.length / 1024).toFixed(1)} KB`)
}

// ── 4. 組 prompt（複製 gemini.ts:buildTagConceptsPrompt 邏輯） ─────────────
function buildPrompt(qs, cm) {
  const questionList = qs.map(q => {
    const a = q.answer?.trim() ? `  答案: "${q.answer.trim()}"` : ''
    return `- id: "${q.id}"  題型: ${q.questionCategory ?? '未知'}${a}`
  }).join('\n')
  const conceptList = cm.map(c => c.description
    ? `${c.code}  短標題:「${c.label}」  說明:${c.description}`
    : `${c.code}  短標題:「${c.label}」`
  ).join('\n')

  return `【108課綱概念標記任務 / concept_code_only】
請根據圖片中的題目內容，為下列每一題標記最符合的 108 課綱概念代碼。

題目清單（共 ${qs.length} 題）：
${questionList}

概念代碼清單（格式：代碼  短標題：「...」  說明：...）：
${conceptList}

規則：
- 【重要】題目清單中的每一題都必須出現在回傳的 tags 陣列中，不可遺漏任何題號
- tags 陣列長度必須等於題目清單長度（${qs.length} 筆）
- 每題只選一個最核心的概念代碼（若題目橫跨多個概念，選主要考點）
- 【嚴格禁止】concept_code 只能選上方清單中的代碼，禁止自行創造不在清單中的代碼
- 【嚴格禁止】concept_label 只能填入該代碼對應的「短標題」（即 「」內的文字），禁止把說明文字混入
- 若確實無法從清單中找到對應概念，填 "concept_code": null, "concept_label": null
- 寧可填 null 也不能填清單外的代碼或自訂標題

回傳純 JSON（無 Markdown），格式：
{
  "tags": [
    { "questionId": "1-1", "concept_code": "Ab-IV-1", "concept_label": "4,000 個常用字的字形、字音和字義" },
    { "questionId": "1-2", "concept_code": null, "concept_label": null }
  ]
}`.trim()
}

// ── 5. call Gemini ──────────────────────────────────────────────────────────
async function callGemini(qs) {
  const prompt = buildPrompt(qs, conceptRows)
  const model = 'gemini-2.5-flash'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, ...bookletParts] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
  }
  console.log(`[backfill] calling Gemini (${model}) with ${qs.length} questions + ${bookletParts.length} images`)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await r.json()
  if (!r.ok) {
    console.error('Gemini error:', JSON.stringify(data, null, 2))
    throw new Error(`Gemini failed: ${r.status}`)
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim()
  const cleaned = text.replace(/```json|```/g, '').trim()
  const parsed = JSON.parse(cleaned)
  return parsed.tags || []
}

let allTags = await callGemini(questions)
console.log(`[backfill] first call: ${allTags.length} tags returned`)
const seen = new Set(allTags.filter(t => t?.questionId).map(t => t.questionId))
const missingQs = questions.filter(q => !seen.has(q.id))
if (missingQs.length > 0) {
  console.warn(`[backfill] missing ${missingQs.length} tags, retry`)
  const retry = await callGemini(missingQs)
  allTags = [...allTags, ...retry]
}

// ── 6. build conceptTags map + UPDATE ─────────────────────────────────────
const tagsByQ = {}
let nonNullCount = 0
for (const t of allTags) {
  if (t?.questionId && t.concept_code && t.concept_label) {
    tagsByQ[t.questionId] = { code: t.concept_code, label: t.concept_label }
    nonNullCount++
  }
}
console.log(`[backfill] ${nonNullCount}/${questions.length} questions got non-null concept_code`)

// ── 7. UPDATE answer_key.questions[i].concept_code/concept_label ──────────
for (const q of answerKey.questions) {
  const t = tagsByQ[q.id]
  if (t) {
    q.concept_code = t.code
    q.concept_label = t.label
  }
}
const { error: uErr } = await sb
  .from('assignments').update({ answer_key: answerKey, updated_at: new Date().toISOString() })
  .eq('id', ASSIGNMENT_ID)
if (uErr) throw uErr

// 順便寫 conceptTags 欄位（若 schema 有）— 寫到 assignment_tag_state？或留給 client sync
// 這份案例 client gradingPage 直接讀 answer_key 上的 concept_code、不需另寫
console.log(`[backfill] DONE. answer_key updated with concept_code for ${nonNullCount}/${questions.length} questions.`)

// 印出 missing 題目方便人工檢查
const missing = answerKey.questions.filter(q => !q.concept_code).map(q => q.id)
if (missing.length > 0) console.log(`[backfill] still missing concept_code (${missing.length}):`, missing.join(', '))
