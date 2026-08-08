// 國語(ao_pdf)READ_MEDIA_RES 驗證(2026-08-04)——user:國語是讀圖大宗,LOW 必須先過國語沙盒。
// 與英語版差異(鏡像 production ao_pdf):
//   crop = cropInlineImageByBbox(bbox, useActualBbox=true, pad=0)——零 pad 直裁、無紅框(markLine 空)
//   model = 全部 PRO(3.6-flash;國語卷 readModelOverride 整體 PRO)
//   text 家族用非英語規則(立場條款版)
//   國字注音格(fill_blank 且答案為 1-2 中文字或注音)拔 read → 跳過(production gzIsVjCell 同款)
// GT = phase_a_state.arbiterDecisions.finalAnswer(A班國語重批、判官驗收過的產物)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const KEY = process.env.SYSTEM_GEMINI_API_KEY
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { cropInlineImageByBbox, normalizeAnswerForComparison } = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')

const SUB_ID = '1778869835222-29yoyu4zd'   // 國語定期評量、score 48、arbiter 60 筆
const AID = '1778869700051-ollsjczry'

const { data: sub } = await db.from('submissions').select('phase_a_state').eq('id', SUB_ID).maybeSingle()
const { data: asg } = await db.from('assignments').select('answer_key').eq('id', AID).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const akById = new Map(ak.questions.map(q => [String(q.id), q]))
const img = await db.storage.from('homework-images').download(`submissions/${SUB_ID}.webp`)
const imgB64 = Buffer.from(await img.data.arrayBuffer()).toString('base64')

const aligned = sub.phase_a_state?.classifyResult?.alignedQuestions ?? []
const gtByQid = new Map()
for (const d of (sub.phase_a_state?.arbiterDecisions ?? [])) gtByQid.set(String(d.questionId), d.finalAnswer)
if (gtByQid.size === 0) { console.error('⛔ GT 空,中止'); process.exit(1) }

// production gzIsVjCell 同款:國字注音格拔 read
const gzIsVjCell = (qid) => {
  const k = akById.get(qid)
  if (!k || String(k.questionCategory ?? '') !== 'fill_blank') return false
  const key = String(k.answer ?? k.referenceAnswer ?? '').trim()
  return /^[一-鿿]{1,2}$/u.test(key) || /^[ㄅ-ㄩˊˇˋ˙]{1,5}$/u.test(key)
}
const SKIP = new Set(['multi_fill', 'map_fill', 'diagram_color', 'grid_geometry', 'map_symbol'])
const readable = aligned.filter(q => q.visible && q.answerBbox && !SKIP.has(q.questionType) && !gzIsVjCell(String(q.questionId)))
const skippedGz = aligned.filter(q => gzIsVjCell(String(q.questionId))).length
console.log(`可讀題 ${readable.length}(跳過國字注音 ${skippedGz})、題型:`, JSON.stringify(readable.reduce((o, q) => { o[q.questionType] = (o[q.questionType] || 0) + 1; return o }, {})))

const CFG = {
  single_choice: { batch: 20, family: 'choice' },
  true_false: { batch: 30, family: 'choice' },
  fill_blank: { batch: 30, family: 'text' },
  short_answer: { batch: 10, family: 'text' },
  ordering: { batch: 1, family: 'ordering' }
}
// 非英語 text 規則(production tsReadHead 摘錄;ao_pdf 無 markLine)
const head = (family) => {
  const roleLine = '你是校對員：每題標籤可能附正確答案，只當「看仔細一點」的提示；仍只回報學生實際手寫的內容、看不到就 blank，絕不可把正確答案填進去。'
  const rule = ({
    choice: '這些是「選擇/是非題」：回報學生圈選或寫下的選項代號(字母或數字)。',
    text: '這些是「填空/簡答題」：回報學生手寫的文字內容。若學生寫的是句子或片語，請輸出「完整連續的一句」(照原樣、保留詞間空格)，不要拆成逗號分隔的單字碎片。⚠ 若學生有「圈選/勾選印刷選項」或先寫立場詞（同意、不同意、支持、反對、勾選的類別名），把該立場抄在輸出最前面、用「｜」接理由——學生圈選的印刷選項文字算學生的作答、要抄出來。'
  })[family] || '回報學生手寫的內容。'
  return `以下是多張「同一題型」的作答區裁切放大圖，每張圖前有題號標籤。${roleLine}\n${rule}\n沒寫→status="blank"、有寫看不懂→status="unreadable"。只輸出 JSON：{"answers":[{"questionId":"...","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}`
}
const hintOf = (qid) => { const k = akById.get(qid); const ps = Array.isArray(k?.parts) && k.parts.length >= 2 ? k.parts : null; return ps ? ps.map(p => `${p.subId}=${p?.answer ?? ''}`).join('；') : String(k?.answer || k?.referenceAnswer || '').trim() }

function parseAnswers(data) {
  const text = (data?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join('')
  const m = text.match(/\{[\s\S]*\}/); if (!m) return null
  try { const j = JSON.parse(m[0]); return Array.isArray(j.answers) ? j.answers : null } catch { return null }
}

async function runArm(label, mediaRes) {
  const groups = new Map()
  for (const q of readable) { const t = q.questionType; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(q) }
  const got = new Map()
  let imgTok = 0, outTok = 0, thTok = 0, cost = 0, calls = 0
  for (const [type, qs] of groups) {
    const cfg = CFG[type] ?? { batch: 15, family: 'text' }
    for (let i = 0; i < qs.length; i += cfg.batch) {
      const batch = qs.slice(i, i + cfg.batch)
      const parts = [{ text: head(cfg.family) }]
      for (const q of batch) {
        // ao_pdf:零 pad 直裁 classify bbox(production isAoPdf 分支)
        const crop = await cropInlineImageByBbox(imgB64, 'image/webp', q.answerBbox, true, 0)
        if (!crop) continue
        const ans = hintOf(String(q.questionId))
        parts.push({ text: `--- 題目 ${q.questionId}${ans ? `（正確答案：${ans}）` : ''} ---` })
        parts.push({ inlineData: crop })
      }
      let payload = { generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' } } }
      if (mediaRes) payload = { generationConfig: { ...payload.generationConfig, mediaResolution: mediaRes } }
      const r = await callGeminiGenerateContent({ apiKey: KEY, model: 'gemini-3.6-flash', contents: [{ role: 'user', parts }], payload, timeoutMs: 180000 })
      calls++
      const u = r?.data?.usageMetadata ?? {}
      imgTok += (u.promptTokensDetails ?? []).find(d => d.modality === 'IMAGE')?.tokenCount ?? 0
      outTok += u.candidatesTokenCount ?? 0; thTok += u.thoughtsTokenCount ?? 0
      // ⛔ 2026-08-08 修:本檔 model=3.6-flash,輸出價 7.50(原寫 9 = 3.5-flash 的價、高估 20%)。費率權威 ../_rates.mjs
      cost += ((u.promptTokenCount ?? 0) / 1e6 * 1.5 + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) / 1e6 * 7.5) * 33
      for (const a of parseAnswers(r?.data) ?? []) got.set(String(a.questionId), a)
    }
  }
  let match = 0, diff = [], missing = 0
  for (const q of readable) {
    const qid = String(q.questionId)
    const a = got.get(qid)
    if (!a) { missing++; continue }
    const gv = normalizeAnswerForComparison(String(gtByQid.get(qid) ?? ''))
    const av = normalizeAnswerForComparison(String(a.status === 'blank' ? '' : a.studentAnswerRaw ?? ''))
    if (gv === av) match++
    else diff.push({ qid, gt: String(gtByQid.get(qid) ?? '').slice(0, 40), got: String(a.studentAnswerRaw ?? `[${a.status}]`).slice(0, 40) })
  }
  console.log(`\n[${label}] ${calls} calls 圖tok=${imgTok} out=${outTok} th=${thTok} NT$${cost.toFixed(2)}`)
  console.log(`  對 GT:一致 ${match}/${readable.length}、不一致 ${diff.length}、漏答 ${missing}`)
  for (const d of diff.slice(0, 8)) console.log(`   ✗ ${d.qid}: GT「${d.gt}」→「${d.got}」`)
  return { label, calls, imgTok, outTok, thTok, cost, match, total: readable.length, diff, missing }
}

const N = Number(process.argv[2] || 1)
const MODE = process.argv[3] || 'hl'
const arms = []
for (let i = 0; i < N; i++) {
  if (MODE.includes('h')) arms.push(await runArm(`HIGH #${i + 1}`, null))
  if (MODE.includes('m')) arms.push(await runArm(`MED  #${i + 1}`, 'MEDIA_RESOLUTION_MEDIUM'))
  if (MODE.includes('l')) arms.push(await runArm(`LOW  #${i + 1}`, 'MEDIA_RESOLUTION_LOW'))
}
fs.writeFileSync(path.join(__dirname, 'guoyu-result.json'), JSON.stringify(arms, null, 2))
console.log('\n→ guoyu-result.json')
