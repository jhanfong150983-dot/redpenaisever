// 判官 3.5 vs 3.6 A/B(2026-08-04)——國語測試 vs 7月B班 翻盤格,同 crop 同 prompt 只換 model。
// 背景:7月B班=舊管線+3.5(7/13);今=三判官+3.6(7/22 全套切換,判官只過小沙盒「誤殺2→3」)。
// 真實對應=兩邊按座號排序位置對位(7月跳缺交、國語測試順匯)。
// 鏡像 production(staged-grading.js 字形終審):
//   stuCrop = cropInlineImageByBbox(inflateBboxForType(bbox,'fill_blank'=0.005), true, 0.005)
//   國字:crop <600px 放大×3(⛔注音不放大);glyphPrompt(IDS 拆解)×3 票、一票 different 就殺
//   注音:pnA/pnB/pnC 三判官+標準答案圖(pad 0.01)+冒號條款、多數決
//   config = temp 0 + MINIMAL + MEDIA_RESOLUTION_HIGH(JUDGE_HIGHRES)
// 用法:node run.mjs [N cells,預設10]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const KEY = process.env.SYSTEM_GEMINI_API_KEY
if (!KEY) { console.error('⛔ 無 SYSTEM_GEMINI_API_KEY'); process.exit(1) }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { cropInlineImageByBbox } = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')
const { decomposeGlyph } = await import('../../server/ai/glyph-decomp.js')

const AID_J = '1778869875728-wlkato1nr' // 7月B班定期評量
const AID_N = '1785806270475-1uflwr4gg' // 國語測試(今天)
const NCELLS = Number(process.argv[2] || 10)

// ── 真實對應(位置對位) + 翻盤格 ──
const pull = async (aid) => (await db.from('submissions').select('id,student_id,graded_at,grading_result,phase_a_state').eq('assignment_id', aid).not('grading_result', 'is', null)).data ?? []
const july = await pull(AID_J), now = await pull(AID_N)
const sids = [...new Set([...july, ...now].map(s => s.student_id))]
const { data: studs } = await db.from('students').select('id,seat_number').in('id', sids)
const seatMap = new Map((studs ?? []).map(s => [s.id, s.seat_number]))
const seat = (s) => seatMap.get(s.student_id) ?? 999
const jS = july.sort((a, b) => seat(a) - seat(b)), nS = now.sort((a, b) => seat(a) - seat(b))
const CUT = new Date('2026-08-04T12:00:00+08:00').getTime()

// ── 答案卷 key + akBbox ──
const { data: asg } = await db.from('assignments').select('answer_key, answer_key_template_id, answer_sheet_image_paths').eq('id', AID_N).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const akById = new Map((ak?.questions ?? []).map(q => [String(q.id), q]))
const keyOf = (qid) => String(akById.get(qid)?.answer ?? akById.get(qid)?.referenceAnswer ?? '').trim()
const kindOf = (key) => /^[ㄅ-ㄩˊˇˋ˙]{1,5}$/.test(key) ? 'zhuyin' : /^[一-鿿]{1,2}$/u.test(key) ? 'glyph' : null

const flips = []
for (let i = 0; i < Math.min(jS.length, nS.length); i++) {
  const j = jS[i], n = nS[i]
  const dj = new Map((j.grading_result?.details ?? []).map(d => [String(d.questionId), d]))
  for (const d of (n.grading_result?.details ?? [])) {
    const qid = String(d.questionId); if (!/^1-1-\d+$/.test(qid)) continue
    const x = dj.get(qid); if (!x || !!x.isCorrect === !!d.isCorrect) continue
    const key = keyOf(qid), kind = kindOf(key)
    if (!kind) continue
    flips.push({ batch: Number(n.graded_at) < CUT ? 1 : 2, seatJ: seat(j), n, qid, key, kind, julyOK: !!x.isCorrect, nowOK: !!d.isCorrect, votesNow: d.glyphVotes ?? null })
  }
}
// 取樣:對→錯優先(今天判錯的可疑格),兩批各半、glyph/zhuyin 都要
const o2x = flips.filter(f => f.julyOK && !f.nowOK), x2o = flips.filter(f => !f.julyOK && f.nowOK)
const pick = []
for (const pool of [o2x.filter(f => f.kind === 'zhuyin'), o2x.filter(f => f.kind === 'glyph'), x2o]) {
  for (const b of [1, 2]) for (const f of pool.filter(x => x.batch === b)) if (pick.length < NCELLS && !pick.includes(f)) pick.push(f)
}
console.log(`翻盤格共 ${flips.length}(對→錯 ${o2x.length}/錯→對 ${x2o.length}),取 ${pick.length} 格 A/B`)

// ── crop 建構(鏡像 production)──
const imgCache = new Map()
const getImgB64 = async (id) => {
  if (!imgCache.has(id)) {
    const r = await db.storage.from('homework-images').download(`submissions/${id}.webp`)
    imgCache.set(id, r.error ? null : Buffer.from(await r.data.arrayBuffer()).toString('base64'))
  }
  return imgCache.get(id)
}
const inflate = (b, p = 0.005) => ({ x: Math.max(0, b.x - p), y: Math.max(0, b.y - p), w: Math.min(1, b.x + b.w + p) - Math.max(0, b.x - p), h: Math.min(1, b.y + b.h + p) - Math.max(0, b.y - p) })

// 標準答案圖(注音 ref;production getZyRefCrop 候選鏈)
let refPageCache = new Map()
const getRefPage = async (pageIndex) => {
  if (refPageCache.has(pageIndex)) return refPageCache.get(pageIndex)
  const cands = []
  if (Array.isArray(asg.answer_sheet_image_paths) && asg.answer_sheet_image_paths[pageIndex]) cands.push(asg.answer_sheet_image_paths[pageIndex])
  if (asg.answer_key_template_id) cands.push(`template-answer-sheets/${asg.answer_key_template_id}/page-${pageIndex}.webp`)
  cands.push(`answer-sheets/${AID_N}/page-${pageIndex}.webp`)
  let loaded = null
  for (const p of cands) {
    const r = await db.storage.from('homework-images').download(p)
    if (!r.error && r.data) { loaded = Buffer.from(await r.data.arrayBuffer()); break }
  }
  refPageCache.set(pageIndex, loaded)
  return loaded
}
const getZyRefCrop = async (qid) => {
  const akQ = akById.get(qid); const b = akQ?.answerBbox
  if (!b) return null
  const buf = await getRefPage(Math.max(0, Number(akQ?.pageIndex) || 0))
  if (!buf) return null
  const meta = await sharp(buf).metadata(); const pad = 0.01
  const cx = Math.round(Math.max(0, b.x - pad) * meta.width), cy = Math.round(Math.max(0, b.y - pad) * meta.height)
  const cw = Math.min(meta.width - cx, Math.round((Math.min(1, b.x + b.w + pad) - Math.max(0, b.x - pad)) * meta.width))
  const ch = Math.min(meta.height - cy, Math.round((Math.min(1, b.y + b.h + pad) - Math.max(0, b.y - pad)) * meta.height))
  if (cw < 4 || ch < 4) return null
  const out = await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).jpeg({ quality: 90 }).toBuffer()
  return { mimeType: 'image/jpeg', data: out.toString('base64') }
}

// ── prompts(逐字照抄 staged-grading.js)──
const COLON_CLAUSE = `\n⚠ 印刷題目的冒號「：」、頓號、標點都不是學生的筆畫——不要把它們當成輕聲點或調號。`
const zyPrompts = (key) => [
  `這是「國字注音」題。第一張是【標準答案圖】（老師答案卷、標準答案「${key}」）、第二張是【學生作答圖】。\n你的任務是「比對」、不是辨認：\n1. analysis：把標準「${key}」拆成注音符號＋聲調記號（一聲=無記號），逐一對照——標準圖有的符號/調號學生有沒有？學生有沒有標準圖上沒有的多餘筆畫？\n2. verdict：與標準圖一致 → "same"；符號不同、或多寫/少寫調號 → "different"；學生格內沒有手寫 → "blank"${COLON_CLAUSE}\n只輸出 JSON：{"analysis":"60字內","verdict":"same|different|blank","reason":"20字內"}`,
  `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${key}」）、第二張是【學生作答圖】。\n你的任務是「比對」：\n1. analysis：由上而下列出學生實際手寫的每個注音符號、跟標準圖並排比形狀；再比調號——先定位「獨立的短斜筆/勾/點」有沒有，⚠不可把符號自身筆畫當調號。\n2. verdict：形狀序列與調號跟標準圖一致 → "same"；任一不同 → "different"；沒寫 → "blank"${COLON_CLAUSE}\n只輸出 JSON：{"analysis":"60字內","verdict":"same|different|blank","reason":"20字內"}`,
  `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${key}」）、第二張是【學生作答圖】。\n你的任務是「找不同」（純比形狀、不要辨認符號名稱）：\n1. diff：並排比較兩張圖中「手寫注音」的部分，列出所有視覺差異（形狀、筆畫數、多出/缺少的獨立筆畫）。\n2. verdict：差異只是字醜、粗細、大小、位置偏移 → "same"；有「多出或缺少一筆獨立筆畫」或「某符號的形狀根本是另一個東西」 → "different"；學生格內沒有手寫 → "blank"${COLON_CLAUSE}\n只輸出 JSON：{"diff":"60字內","verdict":"same|different|blank","reason":"20字內"}`
]
const glyphPromptOf = (key) => {
  const d = decomposeGlyph(key)
  return d ? `這是學生手寫的一個國字。標準答案是「${key}」。\n「${key}」的標準部件拆解（權威資料、請照這個拆解逐塊檢查、不要自行拆解）：${JSON.stringify(d)}\n逐塊回答：學生在該位置寫的，大致上是這個部件嗎？\n判準（老師改考卷的標準）：字醜、潦草、微小筆畫差異（多一點/少一橫/內部細節模糊）都算 same。\n只有「某一大塊寫成別的東西」「缺了一整塊」「整個字是另一個字或自創字」才是 different。\n格內完全沒有手寫筆跡（只有印刷）→ verdict="blank"。\n只輸出 JSON：{"blocks":"逐塊對照（60字內）","verdict":"same|different|blank","reason":"20字內結論"}` : `這是學生手寫的一個國字。標準答案是「${key}」。\n你的任務：判斷學生寫的是不是「${key}」這個字。用「大部件」層級比對、不要逐筆畫檢查：\n1. blocks：把「${key}」拆成最多 2~3 個大部件（左右或上下大塊），逐塊回答——學生在這個位置寫的，大致上是同一個東西嗎？\n2. 判準（老師改考卷的標準）：字醜、潦草、微小筆畫差異（多一點/少一橫/內部細節模糊）都算 same。\n   只有「某一大塊寫成別的東西」「缺了一整塊」「整個字是另一個字或自創字」才是 different。\n格內完全沒有手寫筆跡（只有印刷）→ verdict="blank"。\n只輸出 JSON：{"blocks":"逐塊對照（60字內）","verdict":"same|different|blank","reason":"20字內結論"}`
}

const GEN = { generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' }, mediaResolution: 'MEDIA_RESOLUTION_HIGH' } }
let totalCost = 0, totalCalls = 0
// ⛔ 費率權威=../_rates.mjs(鏡像 admin modelRates);2026-08-08 修:3.5-flash 原誤寫 0.30/2.50、實為 1.50/9.00
const RATE = { 'gemini-3.5-flash': [1.50, 9.00], 'gemini-3.6-flash': [1.50, 7.50] }
// ⚠ 本檔已產出的結論(3.5 vs 3.6 品質 A/B)不受影響;但當初報出的「3.5 便宜 5 倍」是錯的
const parseJson = (data) => {
  const t = data?.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? ''
  const m = t.match(/\{[\s\S]*\}/); if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}
const judge = async (model, parts) => {
  const r = await callGeminiGenerateContent({ apiKey: KEY, model, contents: [{ role: 'user', parts }], payload: GEN, timeoutMs: 60000 })
  totalCalls++
  const u = r?.data?.usageMetadata ?? {}
  const [ri, ro] = RATE[model]
  totalCost += ((u.promptTokenCount ?? 0) / 1e6 * ri + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) / 1e6 * ro) * 33
  return parseJson(r?.data)
}
const vLetter = (v) => v?.verdict ? v.verdict[0] : '?'

const OUT = path.join(__dirname, 'crops'); fs.mkdirSync(OUT, { recursive: true })
const rows = []
for (const f of pick) {
  const al = f.n.phase_a_state?.classifyResult?.alignedQuestions ?? []
  const row = al.find(q => String(q.questionId) === f.qid)
  if (!row?.answerBbox) { console.log(`skip ${f.qid}(無 bbox)`); continue }
  const imgB64 = await getImgB64(f.n.id)
  let stuCrop = await cropInlineImageByBbox(imgB64, 'image/webp', inflate(row.answerBbox, 0.005), true, 0.005)
  if (!stuCrop) { console.log(`skip ${f.qid}(crop 失敗)`); continue }
  if (f.kind !== 'zhuyin') { // 國字放大×3 ≤600(⛔注音不放大)
    const buf = Buffer.from(stuCrop.data, 'base64'); const meta = await sharp(buf).metadata()
    if (meta?.width && meta.width < 600) {
      const up = await sharp(buf).resize({ width: Math.min(600, meta.width * 3) }).jpeg({ quality: 92 }).toBuffer()
      stuCrop = { data: up.toString('base64'), mimeType: 'image/jpeg' }
    }
  }
  fs.writeFileSync(path.join(OUT, `${f.qid}_seat${f.seatJ}.jpg`), Buffer.from(stuCrop.data, 'base64'))
  const cell = { ...f, verdicts: {} }
  for (const model of ['gemini-3.5-flash', 'gemini-3.6-flash']) {
    let votes, verdict
    if (f.kind === 'zhuyin') {
      const ref = await getZyRefCrop(f.qid)
      if (!ref) { verdict = 'noref'; votes = [] } else {
        const pv = await Promise.all(zyPrompts(f.key).map(p => judge(model, [{ text: p }, { text: '【標準答案圖】' }, { inlineData: ref }, { text: '【學生作答圖】' }, { inlineData: stuCrop }])))
        votes = pv.map(vLetter)
        const nOf = (k) => pv.filter(v => v?.verdict === k).length
        verdict = nOf('blank') >= 2 ? 'blank' : nOf('different') >= 2 ? 'different' : nOf('same') >= 2 ? 'same' : 'split'
      }
    } else {
      const pv = await Promise.all([0, 1, 2].map(() => judge(model, [{ text: glyphPromptOf(f.key) }, { inlineData: stuCrop }])))
      votes = pv.map(vLetter)
      const blanks = pv.filter(v => v?.verdict === 'blank').length
      verdict = blanks >= 2 ? 'blank' : pv.some(v => v?.verdict === 'different') ? 'different' : 'same' // 一票殺
    }
    cell.verdicts[model] = { verdict, votes: votes.join('') }
  }
  rows.push(cell)
  const ok = (v) => v === 'same' ? '對' : v === 'blank' ? '空' : v === 'noref' ? '無ref' : '錯'
  console.log(`[批${cell.batch}] 座${f.seatJ} ${f.qid}「${f.key}」(${f.kind})  7月=${f.julyOK ? '對' : '錯'} 今=${f.nowOK ? '對' : '錯'}  | 3.5→${ok(cell.verdicts['gemini-3.5-flash'].verdict)}(${cell.verdicts['gemini-3.5-flash'].votes}) 3.6→${ok(cell.verdicts['gemini-3.6-flash'].verdict)}(${cell.verdicts['gemini-3.6-flash'].votes})`)
}
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(rows, null, 1))
console.log(`\n${totalCalls} calls、成本 NT$${totalCost.toFixed(2)}`)
// 彙總:3.5/3.6 各自與「7月verdict」「今verdict」的一致率
const agree = (m, side) => rows.filter(r => r.verdicts[m] && ((r.verdicts[m].verdict === 'same') === (side === 'july' ? r.julyOK : r.nowOK))).length
for (const m of ['gemini-3.5-flash', 'gemini-3.6-flash']) console.log(`${m}: 同7月 ${agree(m, 'july')}/${rows.length}、同今天 ${agree(m, 'now')}/${rows.length}`)
