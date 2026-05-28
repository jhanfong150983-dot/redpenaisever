// Batch backfill 所有「有題、無 tag、有批改、有 grade、domain 可映射」的作業
// 用題本（answer_only）或答案卷（with_questions）跑 Gemini concept tagging
// 用法：node scripts/backfill-concept-tags-batch.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

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
if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_KEY) throw new Error('env missing')

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const DOMAIN_TO_SUBJECTS = {
  '國語': ['chinese'],
  '英語': ['english'], '英文': ['english'],
  '數學': ['math'],
  '自然': ['science', 'nature_bio', 'nature_chem', 'nature_earth', 'nature_phy'],
  '社會': ['social'],
}

// ── 取候選作業 ───────────────────────────────────────────────────────────────
async function listCandidates() {
  const a = await sb.from('assignments').select('id,title,domain,answer_sheet_mode,answer_key_template_id,answer_key,classroom_id,concept_tags')
  if (a.error) throw a.error
  const c = await sb.from('classrooms').select('id,grade,name')
  if (c.error) throw c.error
  const cMap = new Map(c.data.map(r => [r.id, r]))

  // submissions 表大、只抓 assignment_id + 篩 grading_result not null
  // 為了避免拉一堆 JSONB grading_result（很大），用 count head 模式 per assignment
  const out = []
  for (const r of a.data) {
    const cls = cMap.get(r.classroom_id)
    const grade = cls?.grade
    const q = (r.answer_key?.questions || [])
    const tagCount = r.concept_tags ? Object.keys(r.concept_tags).length : 0
    if (q.length === 0 || tagCount > 0 || !grade) continue
    const subjects = DOMAIN_TO_SUBJECTS[r.domain]
    if (!subjects) continue
    // 用 head:true 只拿 count
    const { count, error: sErr } = await sb.from('submissions')
      .select('id', { count: 'exact', head: true })
      .eq('assignment_id', r.id)
      .not('grading_result', 'is', null)
    if (sErr) continue
    if (!count || count === 0) continue
    out.push({ ...r, grade, classroom_name: cls?.name, subjects, q_count: q.length, graded: count })
  }
  return out
}

const candidates = await listCandidates()
candidates.sort((a, b) => b.graded - a.graded)
console.log(`[batch] ${candidates.length} candidates to backfill`)

// ── 下載圖：先 booklet（answer_only）或 answer-sheet（with_questions） ─────
async function downloadBooklet(assignmentId, templateId) {
  for (const [prefix, id] of [['question-booklets', assignmentId], ['question-booklets', templateId]]) {
    if (!id) continue
    const pages = []
    for (let i = 0; i < 20; i++) {
      const { data, error } = await sb.storage.from('homework-images').download(`${prefix}/${id}/page-${i}.webp`)
      if (error || !data) break
      const buf = Buffer.from(await data.arrayBuffer())
      pages.push({ inlineData: { mimeType: 'image/webp', data: buf.toString('base64') } })
    }
    if (pages.length > 0) return { pages, source: `${prefix}/${id}` }
  }
  return { pages: [], source: null }
}
async function downloadAnswerSheet(assignmentId, templateId) {
  for (const [prefix, id] of [['answer-sheets', assignmentId], ['template-answer-sheets', templateId]]) {
    if (!id) continue
    const pages = []
    for (let i = 0; i < 20; i++) {
      const { data, error } = await sb.storage.from('homework-images').download(`${prefix}/${id}/page-${i}.webp`)
      if (error || !data) break
      const buf = Buffer.from(await data.arrayBuffer())
      pages.push({ inlineData: { mimeType: 'image/webp', data: buf.toString('base64') } })
    }
    if (pages.length > 0) return { pages, source: `${prefix}/${id}` }
  }
  return { pages: [], source: null }
}

// ── prompt + Gemini ─────────────────────────────────────────────────────────
function buildPrompt(qs, cm) {
  const questionList = qs.map(q => {
    const a = q.answer?.trim() ? `  答案: "${q.answer.trim()}"` : ''
    return `- id: "${q.id}"  題型: ${q.questionCategory ?? '未知'}${a}`
  }).join('\n')
  const conceptList = cm.map(c => c.description
    ? `${c.code}  短標題:「${c.label}」  說明:${c.description}`
    : `${c.code}  短標題:「${c.label}」`).join('\n')
  return `【108課綱概念標記任務 / concept_code_only】
請根據圖片中的題目內容，為下列每一題標記最符合的 108 課綱概念代碼。

題目清單（共 ${qs.length} 題）：
${questionList}

概念代碼清單（格式：代碼  短標題：「...」  說明：...）：
${conceptList}

規則：
- 每一題都必須出現在回傳的 tags 陣列中
- 每題只選一個最核心的概念代碼
- 【嚴格禁止】concept_code 只能選上方清單中的代碼
- 【嚴格禁止】concept_label 只能填入該代碼對應的「短標題」
- 若確實無法從清單中找到對應概念，填 "concept_code": null, "concept_label": null

回傳純 JSON（無 Markdown）：
{ "tags": [ { "questionId": "1-1", "concept_code": "Ab-IV-1", "concept_label": "..." } ] }`.trim()
}
async function callGemini(qs, imageParts, conceptRows) {
  const prompt = buildPrompt(qs, conceptRows)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
  }
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json()
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${JSON.stringify(data).slice(0, 300)}`)
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim()
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
  return parsed.tags || []
}

// ── 主迴圈 ──────────────────────────────────────────────────────────────────
const summary = { ok: [], skipped: [], failed: [] }
let idx = 0
for (const a of candidates) {
  idx++
  const tag = `[${idx}/${candidates.length}] ${a.id} ${a.title?.slice(0, 30) || ''}`
  try {
    // concept_map
    const { data: cm, error: cmErr } = await sb.from('concept_map')
      .select('code,label,description').in('subject', a.subjects).eq('grade', a.grade).order('code')
    if (cmErr) throw cmErr
    if (!cm || cm.length === 0) {
      console.log(`${tag} SKIP no concept_map (grade=${a.grade} subjects=${a.subjects.join(',')})`)
      summary.skipped.push({ id: a.id, title: a.title, reason: 'no_concept_map' })
      continue
    }
    // images
    const isAnswerOnly = a.answer_sheet_mode === 'answer_only'
    const dl = isAnswerOnly
      ? await downloadBooklet(a.id, a.answer_key_template_id)
      : await downloadAnswerSheet(a.id, a.answer_key_template_id)
    if (dl.pages.length === 0) {
      // answer_only 抓不到題本時 fallback 試 answer-sheet（雖然只有答案、但聊勝於無）
      const fb = isAnswerOnly ? await downloadAnswerSheet(a.id, a.answer_key_template_id) : null
      if (!fb || fb.pages.length === 0) {
        console.log(`${tag} SKIP no images`)
        summary.skipped.push({ id: a.id, title: a.title, reason: 'no_images' })
        continue
      }
      dl.pages = fb.pages; dl.source = fb.source + ' (booklet fallback)'
    }
    const questions = a.answer_key.questions.map(q => ({
      id: q.id, questionCategory: q.questionCategory, answer: q.answer ?? q.referenceAnswer ?? ''
    }))
    console.log(`${tag} calling Gemini (q=${questions.length}, cm=${cm.length}, imgs=${dl.pages.length} from ${dl.source})`)
    let tags = await callGemini(questions, dl.pages, cm)
    const seen = new Set(tags.filter(t => t?.questionId).map(t => t.questionId))
    const missing = questions.filter(q => !seen.has(q.id))
    if (missing.length > 0) {
      console.log(`${tag}   retry for ${missing.length} missing`)
      const r2 = await callGemini(missing, dl.pages, cm)
      tags = [...tags, ...r2]
    }
    // build tagsMap
    const tagsByQ = {}; let nonNull = 0
    for (const t of tags) {
      if (t?.questionId && t.concept_code && t.concept_label) {
        tagsByQ[t.questionId] = { code: t.concept_code, label: t.concept_label }; nonNull++
      }
    }
    if (nonNull === 0) {
      console.log(`${tag} SKIP all-null result (concept_map mismatch?)`)
      summary.skipped.push({ id: a.id, title: a.title, reason: 'all_null_tags' })
      continue
    }
    // UPDATE concept_tags + answer_key.questions[].concept_code
    const ak = a.answer_key
    for (const q of ak.questions) {
      const t = tagsByQ[q.id]
      if (t) { q.concept_code = t.code; q.concept_label = t.label }
    }
    const { error: uErr } = await sb.from('assignments').update({
      concept_tags: tagsByQ, answer_key: ak, updated_at: new Date().toISOString()
    }).eq('id', a.id)
    if (uErr) throw uErr
    console.log(`${tag} OK ${nonNull}/${questions.length}`)
    summary.ok.push({ id: a.id, title: a.title, tagged: nonNull, total: questions.length })
  } catch (e) {
    console.log(`${tag} FAIL ${e.message}`)
    summary.failed.push({ id: a.id, title: a.title, reason: e.message })
  }
  // gentle pacing
  await new Promise(r => setTimeout(r, 1500))
}

console.log('\n========== SUMMARY ==========')
console.log(`OK     : ${summary.ok.length}`)
console.log(`SKIPPED: ${summary.skipped.length}`)
console.log(`FAILED : ${summary.failed.length}`)
if (summary.skipped.length > 0) {
  console.log('\n--- SKIPPED ---')
  for (const s of summary.skipped) console.log(`  ${s.id}  ${s.title}  [${s.reason}]`)
}
if (summary.failed.length > 0) {
  console.log('\n--- FAILED ---')
  for (const f of summary.failed) console.log(`  ${f.id}  ${f.title}  [${f.reason}]`)
}
