// read 裁圖解析度降本沙盒(2026-08-04)
// 背景:classify 以外的成本 73% 是圖片 input;wq_pdf 的 read crop(cropWithMarkByBbox)
//   以原生解析度送出,單次 call 圖 token(4.5~6.7K)比整頁縮圖(1,088)還大。
// 問題:裁圖縮到 max-width 1024 / 768 後,讀值是否仍與 production 最終讀值一致?
// 鏡像:同 crop 函式+pad(0.012, 0.048/3)、同 family 分組/批次、同 review 角色 prompt、
//   同 model 分流(PRO=3.6/FLASH=2.5、英語 text 升 PRO)。溫度 0(production READ_TEMP 預設)。
// GT:phase_a_state.arbiterDecisions.finalAnswer(user 驗證過的 81 分批改)。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const KEY = process.env.SYSTEM_GEMINI_API_KEY
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { cropWithMarkByBbox, normalizeAnswerForComparison } = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')
const { default: sharp } = await import('sharp')

const SUB_ID = '1785430466309-pjibhofgt'
const AID = 'sxa_4660b86669f3bb73'
const TOTAL_PAGES = 3

const { data: sub } = await db.from('submissions').select('phase_a_state').eq('id', SUB_ID).maybeSingle()
const { data: asg } = await db.from('assignments').select('answer_key').eq('id', AID).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const akById = new Map(ak.questions.map(q => [String(q.id), q]))
const img = await db.storage.from('homework-images').download(`submissions/${SUB_ID}.webp`)
const imgB64 = Buffer.from(await img.data.arrayBuffer()).toString('base64')

const aligned = sub.phase_a_state?.classifyResult?.alignedQuestions ?? []
const gtByQid = new Map()
for (const d of (sub.phase_a_state?.arbiterDecisions ?? [])) gtByQid.set(String(d.questionId), d.finalAnswer)
if (gtByQid.size === 0) { console.error('⛔ GT(arbiterDecisions) 空,中止'); process.exit(1) }

// production family/批次/model 表(staged-grading TYPE_READ_CONFIG 摘錄)
const CFG = {
  single_choice: { model: '2.5', batch: 20, family: 'choice' },
  true_false: { model: '2.5', batch: 30, family: 'choice' },
  single_check: { model: '3.6', batch: 15, family: 'check' },
  multi_check: { model: '3.6', batch: 15, family: 'check' },
  fill_blank: { model: '3.6', batch: 30, family: 'text' },   // 英語 text 升 PRO
  short_answer: { model: '3.6', batch: 10, family: 'text' },
  ordering: { model: '3.6', batch: 1, family: 'ordering' }
}
const SKIP = new Set(['multi_fill', 'map_fill', 'diagram_color', 'grid_geometry', 'map_symbol'])
// 第 1 頁、可讀題
const PAGE_PREFIX = process.argv[2] || '1-'
const page1 = aligned.filter(q => String(q.questionId).startsWith(PAGE_PREFIX) && q.visible && q.answerBbox && !SKIP.has(q.questionType))
console.log(`頁 ${PAGE_PREFIX} 可讀題 ${page1.length} 題:`, [...new Set(page1.map(q => q.questionType))].join(', '))

// production 同款 prompt(tsReadHead role='review' 摘錄;markLine=wq_pdf set-of-mark)
const markLine = '每張圖中的「紅色方框」標示該題的作答區——只讀紅框內、紅框外（其他列/其他題）一律忽略。紅框內仍然只回報「學生手寫」的內容：印刷的題目文字、引導模板（如「我（同意/不同意），因為」）、選項文字都不要抄，只抄學生自己寫上去的字。'
const head = (family) => {
  if (family === 'ordering') return `這是「排序題」作答區的裁切放大圖：一排方框/括號、每格一個學生手寫數字。${markLine}先數清楚總共有幾格、再由左到右逐格讀出每格的手寫數字(格數要對得上框數)。某格看不清→該格用 ?；整題空白→status="blank"。不要猜、不要管正確答案。只輸出 JSON：{"answers":[{"questionId":"...","studentAnswerRaw":"n,n,n,...","status":"read|blank|unreadable"}]}`
  const roleLine = '你是校對員：每題標籤可能附正確答案，只當「看仔細一點」的提示；仍只回報學生實際手寫的內容、看不到就 blank，絕不可把正確答案填進去。'
  const rule = ({
    choice: '這些是「選擇/是非題」：回報學生圈選或寫下的選項代號(字母或數字)。',
    check: '這些是「勾選題」：回報學生實際打勾/圈選的項目(格號集合，如 1,3)。',
    text: '這些是「填空/簡答題」：每張圖找到「學生有手寫作答」的那一行，把該行完整抄出來——印刷字和學生手寫字合併成一個完整句子(照原樣、保留學生的拼字錯誤、不要幫學生訂正)。不要抄題目敘述、題號、配分、也不要抄其他行的印刷文字。該行只有印刷沒有任何手寫→status="blank"。'
  })[family] || '回報學生手寫的內容。'
  return `以下是多張「同一題型」的作答區裁切放大圖，每張圖前有題號標籤。${roleLine}\n${markLine}${rule}\n沒寫→status="blank"、有寫看不懂→status="unreadable"。只輸出 JSON：{"answers":[{"questionId":"...","studentAnswerRaw":"...","status":"read|blank|unreadable"}]}`
}
const hintOf = (qid) => { const k = akById.get(qid); const ps = Array.isArray(k?.parts) && k.parts.length >= 2 ? k.parts : null; return ps ? ps.map(p => `${p.subId}=${p?.answer ?? ''}`).join('；') : String(k?.answer || k?.referenceAnswer || '').trim() }

// 三檔裁圖(native / 1024 / 768)
async function makeCrop(bbox, maxW) {
  const c = await cropWithMarkByBbox(imgB64, 'image/webp', bbox, 0.012, +(0.048 / TOTAL_PAGES).toFixed(4))
  if (!c || !maxW) return c
  const buf = Buffer.from(c.data, 'base64')
  const meta = await sharp(buf).metadata()
  if ((meta.width ?? 0) <= maxW) return c
  const out = await sharp(buf).resize({ width: maxW }).jpeg({ quality: 90 }).toBuffer()
  return { data: out.toString('base64'), mimeType: 'image/jpeg' }
}

function parseAnswers(data) {
  const text = (data?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join('')
  const m = text.match(/\{[\s\S]*\}/); if (!m) return null
  try { const j = JSON.parse(m[0]); return Array.isArray(j.answers) ? j.answers : null } catch { return null }
}
const MODEL = { '3.6': 'gemini-3.6-flash', '2.5': 'gemini-2.5-flash' }
const GEN = { generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' } } }

async function runArm(label, maxW, mediaRes) {
  const groups = new Map()
  for (const q of page1) { const t = q.questionType; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(q) }
  const got = new Map()
  let imgTok = 0, txtTok = 0, outTok = 0, thTok = 0, cost = 0, calls = 0
  for (const [type, qs] of groups) {
    const cfg = CFG[type] ?? { model: '2.5', batch: 15, family: 'text' }
    for (let i = 0; i < qs.length; i += cfg.batch) {
      const batch = qs.slice(i, i + cfg.batch)
      const parts = [{ text: head(cfg.family) }]
      for (const q of batch) {
        const crop = await makeCrop(q.answerBbox, maxW)
        if (!crop) continue
        const ans = hintOf(q.questionId)
        parts.push({ text: `--- 題目 ${q.questionId}${ans ? `（正確答案：${ans}）` : ''} ---` })
        parts.push({ inlineData: crop })
      }
      const model = MODEL[cfg.model]
      let payload = cfg.model === '2.5' ? { generationConfig: { temperature: 0 } } : GEN
      // Gemini 3.x 每張圖固定 token 檔位(HIGH≈1120/MEDIUM≈560/LOW≈280),與像素無關;2.5 不支援、不掛
      if (mediaRes && cfg.model !== '2.5') payload = { generationConfig: { ...payload.generationConfig, mediaResolution: mediaRes } }
      const r = await callGeminiGenerateContent({ apiKey: KEY, model, contents: [{ role: 'user', parts }], payload, timeoutMs: 180000 })
      calls++
      const u = r?.data?.usageMetadata ?? {}
      const det = u.promptTokensDetails ?? []
      imgTok += det.find(d => d.modality === 'IMAGE')?.tokenCount ?? 0
      txtTok += det.find(d => d.modality === 'TEXT')?.tokenCount ?? 0
      outTok += u.candidatesTokenCount ?? 0; thTok += u.thoughtsTokenCount ?? 0
      const [ci, co] = cfg.model === '2.5' ? [0.075, 0.30] : [1.5, 9.0]
      cost += ((u.promptTokenCount ?? 0) / 1e6 * ci + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) / 1e6 * co) * 33
      for (const a of parseAnswers(r?.data) ?? []) got.set(String(a.questionId), a)
    }
  }
  // 對 GT:normalize 後相等 or 都空白
  let match = 0, diff = [], missing = 0
  for (const q of page1) {
    const qid = String(q.questionId)
    const gt = gtByQid.get(qid)
    const a = got.get(qid)
    if (!a) { missing++; continue }
    const gv = normalizeAnswerForComparison(String(gt ?? ''))
    const av = normalizeAnswerForComparison(String(a.status === 'blank' ? '' : a.studentAnswerRaw ?? ''))
    if (gv === av) match++
    else diff.push({ qid, gt: String(gt ?? '').slice(0, 30), got: String(a.studentAnswerRaw ?? `[${a.status}]`).slice(0, 30) })
  }
  console.log(`\n[${label}] ${calls} calls  圖tok=${imgTok} 文tok=${txtTok} out=${outTok} th=${thTok}  NT$${cost.toFixed(2)}`)
  console.log(`  對 GT:一致 ${match}/${page1.length}、不一致 ${diff.length}、漏答 ${missing}`)
  for (const d of diff.slice(0, 6)) console.log(`   ✗ ${d.qid}: GT「${d.gt}」→ 讀到「${d.got}」`)
  return { label, calls, imgTok, txtTok, outTok, thTok, cost, match, diff, missing }
}

const MODE = process.argv[3] || 'all3'
const arms = []
if (MODE === 'hl') {
  arms.push(await runArm('HIGH', 0, null))
  arms.push(await runArm('LOW ', 0, 'MEDIA_RESOLUTION_LOW'))
} else {
  arms.push(await runArm('現況(HIGH 預設) ', 0, null))
  arms.push(await runArm('MEDIUM          ', 0, 'MEDIA_RESOLUTION_MEDIUM'))
  arms.push(await runArm('LOW             ', 0, 'MEDIA_RESOLUTION_LOW'))
}
fs.writeFileSync(path.join(__dirname, `result-${PAGE_PREFIX.replace('-','')}.json`), JSON.stringify(arms, null, 2))
console.log('\n→ result.json')
