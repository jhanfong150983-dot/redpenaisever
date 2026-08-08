// 判官降本沙盒 #2(2026-08-08):注音判官的三條省圖路,一次全測。
// 國字已定案(MEDIUM 上線),本輪只跑注音格 → 省沙盒錢。
//
// 注音現況:每 call 帶 2 張圖(標準答案圖 + 學生作答圖)、HIGH ≈ 2,155 img tok/call。
// 臂:
//   ZYBASE   現況:2 張圖、HIGH                          ← 基準(同 production)
//   ZYMED    2 張圖、MEDIUM                              ← 8/04 事故從未單獨測過 medium(當時混了 3.6 模型)
//   ZYPAIR   標準+學生併成一張左右對照圖、HIGH             ← 2 個 image part → 1 個
//   ZYPAIRMED 併圖 + MEDIUM                               ← 疊加(最省、也最激進)
//
// ⛔ 全程不放大注音 crop(production 鐵則:放大會放走缺調號的真錯誤)。
//    但併圖後固定 token 預算被兩半分攤=等效降解析度,這正是要測的風險。
// 基準判定=今天 production 的 isCorrect;否決線=誤殺或放水比 ZYBASE 多。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const KEY = process.env.SYSTEM_GEMINI_API_KEY
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const { cropInlineImageByBbox } = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')

const AID = '1778869700051-ollsjczry'
const FIXTURES = [
  { sub: '1778869833186-juyjhvqqi', tag: '座15' },
  { sub: '1778869832946-7zydh575f', tag: '座13' },
  { sub: '1778869832162-i57h81yzo', tag: '座05' },
]
const MODEL = 'gemini-3.5-flash'
const RATE = [1.50, 9.00], TWD = 33

const { data: asg } = await db.from('assignments').select('answer_key,answer_key_template_id,answer_sheet_image_paths').eq('id', AID).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const akById = new Map(ak.questions.map(q => [String(q.id), q]))
const keyOf = (qid) => String(akById.get(qid)?.answer ?? akById.get(qid)?.referenceAnswer ?? '').trim()
const isZy = (qid) => /^[ㄅ-ㄩˊˇˋ˙]{1,5}$/.test(keyOf(qid))

const refPage = new Map()
const getRefPage = async (pi) => {
  if (refPage.has(pi)) return refPage.get(pi)
  const cands = []
  if (Array.isArray(asg.answer_sheet_image_paths) && asg.answer_sheet_image_paths[pi]) cands.push(asg.answer_sheet_image_paths[pi])
  if (asg.answer_key_template_id) cands.push(`template-answer-sheets/${asg.answer_key_template_id}/page-${pi}.webp`)
  cands.push(`answer-sheets/${AID}/page-${pi}.webp`)
  let out = null
  for (const p of cands) { const r = await db.storage.from('homework-images').download(p); if (!r.error && r.data) { out = Buffer.from(await r.data.arrayBuffer()); break } }
  refPage.set(pi, out); return out
}
const refCache = new Map()
const getRefCrop = async (qid) => {
  if (refCache.has(qid)) return refCache.get(qid)
  const akQ = akById.get(qid), b = akQ?.answerBbox
  let out = null
  if (b) {
    const buf = await getRefPage(Math.max(0, Number(akQ?.pageIndex) || 0))
    if (buf) {
      const m = await sharp(buf).metadata(); const pad = 0.01
      const cx = Math.round(Math.max(0, b.x - pad) * m.width), cy = Math.round(Math.max(0, b.y - pad) * m.height)
      const cw = Math.min(m.width - cx, Math.round((Math.min(1, b.x + b.w + pad) - Math.max(0, b.x - pad)) * m.width))
      const ch = Math.min(m.height - cy, Math.round((Math.min(1, b.y + b.h + pad) - Math.max(0, b.y - pad)) * m.height))
      if (cw >= 4 && ch >= 4) out = (await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).jpeg({ quality: 90 }).toBuffer())
    }
  }
  refCache.set(qid, out); return out
}

// 左右對照併圖:⛔不放大,兩張各自原尺寸、上緣對齊、加「標準」/「學生」標籤與紅框
async function buildPair(refBuf, stuBuf) {
  const rm = await sharp(refBuf).metadata(), sm = await sharp(stuBuf).metadata()
  const LAB = 26, GAP = 10, PAD = 6
  const H = Math.max(rm.height, sm.height)
  const W = rm.width + sm.width + GAP + PAD * 2
  const totalH = H + LAB + PAD * 2
  const svg = [`<rect width="${W}" height="${totalH}" fill="white"/>`,
    `<text x="${PAD}" y="${LAB - 6}" font-size="18" font-family="sans-serif" font-weight="bold" fill="#c00">標準</text>`,
    `<text x="${PAD + rm.width + GAP}" y="${LAB - 6}" font-size="18" font-family="sans-serif" font-weight="bold" fill="#06c">學生</text>`,
    `<rect x="${PAD - 2}" y="${LAB - 2}" width="${rm.width + 4}" height="${rm.height + 4}" fill="none" stroke="#c00" stroke-width="2"/>`,
    `<rect x="${PAD + rm.width + GAP - 2}" y="${LAB - 2}" width="${sm.width + 4}" height="${sm.height + 4}" fill="none" stroke="#06c" stroke-width="2"/>`]
  const base = await sharp(Buffer.from(`<svg width="${W}" height="${totalH}">${svg.join('')}</svg>`)).png().toBuffer()
  const out = await sharp(base).composite([{ input: refBuf, left: PAD, top: LAB }, { input: stuBuf, left: PAD + rm.width + GAP, top: LAB }]).jpeg({ quality: 92 }).toBuffer()
  return { mimeType: 'image/jpeg', data: out.toString('base64') }
}

const COLON = `\n⚠ 印刷題目的冒號「：」、頓號、標點都不是學生的筆畫——不要把它們當成輕聲點或調號。`
// 兩圖版(production 逐字)
const zy2 = (k) => [
  `這是「國字注音」題。第一張是【標準答案圖】（老師答案卷、標準答案「${k}」）、第二張是【學生作答圖】。\n你的任務是「比對」、不是辨認：\n1. analysis：把標準「${k}」拆成注音符號＋聲調記號（一聲=無記號），逐一對照——標準圖有的符號/調號學生有沒有？學生有沒有標準圖上沒有的多餘筆畫？\n2. verdict：與標準圖一致 → "same"；符號不同、或多寫/少寫調號 → "different"；學生格內沒有手寫 → "blank"${COLON}\n只輸出 JSON：{"analysis":"60字內","verdict":"same|different|blank","reason":"20字內"}`,
  `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${k}」）、第二張是【學生作答圖】。\n你的任務是「比對」：\n1. analysis：由上而下列出學生實際手寫的每個注音符號、跟標準圖並排比形狀；再比調號——先定位「獨立的短斜筆/勾/點」有沒有，⚠不可把符號自身筆畫當調號。\n2. verdict：形狀序列與調號跟標準圖一致 → "same"；任一不同 → "different"；沒寫 → "blank"${COLON}\n只輸出 JSON：{"analysis":"60字內","verdict":"same|different|blank","reason":"20字內"}`,
  `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${k}」）、第二張是【學生作答圖】。\n你的任務是「找不同」（純比形狀、不要辨認符號名稱）：\n1. diff：並排比較兩張圖中「手寫注音」的部分，列出所有視覺差異（形狀、筆畫數、多出/缺少的獨立筆畫）。\n2. verdict：差異只是字醜、粗細、大小、位置偏移 → "same"；有「多出或缺少一筆獨立筆畫」或「某符號的形狀根本是另一個東西」 → "different"；學生格內沒有手寫 → "blank"${COLON}\n只輸出 JSON：{"diff":"60字內","verdict":"same|different|blank","reason":"20字內"}`,
]
// 併圖版:同樣三個檢查流程,只改「兩張圖」→「一張左右對照圖」的描述
const zy1 = (k) => zy2(k).map(p => p
  .replace('第一張是【標準答案圖】（老師答案卷、標準答案「' + k + '」）、第二張是【學生作答圖】', '下圖是一張【左右對照圖】：左半（紅框、標「標準」）是老師答案卷的標準答案「' + k + '」、右半（藍框、標「學生」）是學生作答')
  .replace('第一張是【標準答案圖】（標準答案「' + k + '」）、第二張是【學生作答圖】', '下圖是一張【左右對照圖】：左半（紅框、標「標準」）是標準答案「' + k + '」、右半（藍框、標「學生」）是學生作答')
  .replace('標準圖有的符號/調號', '左半標準有的符號/調號').replace('標準圖上沒有的', '左半標準沒有的')
  .replace('跟標準圖並排比形狀', '跟左半標準並排比形狀').replace('跟標準圖一致', '跟左半標準一致').replace('與標準圖一致', '與左半標準一致')
  .replace('兩張圖中「手寫注音」', '左右兩半中「手寫注音」'))

const acc = { calls: 0, img: 0, cost: 0 }
const parse = (d) => { const t = (d?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join(''); const m = t.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) } catch { return null } }
async function ask(parts, mediaRes) {
  const r = await callGeminiGenerateContent({ apiKey: KEY, model: MODEL, contents: [{ role: 'user', parts }], payload: { generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' }, mediaResolution: mediaRes } }, timeoutMs: 60000 })
  const u = r?.data?.usageMetadata ?? {}
  acc.calls++; acc.img += (u.promptTokensDetails ?? []).find(d => d.modality === 'IMAGE')?.tokenCount ?? 0
  acc.cost += ((u.promptTokenCount ?? 0) / 1e6 * RATE[0] + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) / 1e6 * RATE[1]) * TWD
  return parse(r?.data)
}

const ARMS = {
  ZYBASE: { pair: false, res: 'MEDIA_RESOLUTION_HIGH' },
  ZYMED: { pair: false, res: 'MEDIA_RESOLUTION_MEDIUM' },
  ZYPAIR: { pair: true, res: 'MEDIA_RESOLUTION_HIGH' },
  ZYPAIRMED: { pair: true, res: 'MEDIA_RESOLUTION_MEDIUM' },
}

async function runArm(arm) {
  const cfg = ARMS[arm]
  Object.keys(acc).forEach(k => acc[k] = 0)
  const cells = []
  for (const fx of FIXTURES) {
    const { data: sub } = await db.from('submissions').select('phase_a_state,grading_result').eq('id', fx.sub).maybeSingle()
    const al = sub.phase_a_state?.classifyResult?.alignedQuestions ?? []
    const prod = new Map((sub.grading_result?.details ?? []).map(d => [String(d.questionId), d]))
    const r = await db.storage.from('homework-images').download(`submissions/${fx.sub}.webp`)
    const imgB64 = Buffer.from(await r.data.arrayBuffer()).toString('base64')
    for (const q of al) {
      const qid = String(q.questionId)
      if (!isZy(qid) || !q.answerBbox) continue
      const p = 0.005
      const bb = { x: Math.max(0, q.answerBbox.x - p), y: Math.max(0, q.answerBbox.y - p), w: Math.min(1, q.answerBbox.x + q.answerBbox.w + p) - Math.max(0, q.answerBbox.x - p), h: Math.min(1, q.answerBbox.y + q.answerBbox.h + p) - Math.max(0, q.answerBbox.y - p) }
      const stu = await cropInlineImageByBbox(imgB64, 'image/webp', bb, true, p)
      const ref = await getRefCrop(qid)
      if (!stu || !ref) continue
      const k = keyOf(qid)
      let pv
      if (cfg.pair) {
        const pairImg = await buildPair(ref, Buffer.from(stu.data, 'base64'))
        pv = await Promise.all(zy1(k).map(t => ask([{ text: t }, { inlineData: pairImg }], cfg.res)))
      } else {
        const refPart = { inlineData: { mimeType: 'image/jpeg', data: ref.toString('base64') } }
        pv = await Promise.all(zy2(k).map(t => ask([{ text: t }, { text: '【標準答案圖】' }, refPart, { text: '【學生作答圖】' }, { inlineData: stu }], cfg.res)))
      }
      const votes = pv.map(v => v?.verdict ? v.verdict[0] : '?').join('')
      const n = (x) => pv.filter(v => v?.verdict === x).length
      const verdict = n('blank') >= 2 ? 'blank' : n('different') >= 2 ? 'different' : n('same') >= 2 ? 'same' : 'split'
      const pd = prod.get(qid)
      cells.push({ tag: fx.tag, qid, key: k, prodOk: pd ? !!pd.isCorrect : null, verdict, votes, ok: verdict === 'same' })
    }
  }
  return { arm, cells, ...acc }
}

const arms = (process.argv[2] ? process.argv[2].split(',') : Object.keys(ARMS)).map(s => s.trim().toUpperCase()).filter(a => ARMS[a])
const all = []
for (const arm of arms) {
  for (const run of [1, 2]) {
    const r = await runArm(arm); r.run = run; all.push(r)
    const ks = r.cells.filter(c => c.prodOk === true && !c.ok).length
    const ss = r.cells.filter(c => c.prodOk === false && c.ok).length
    console.log(`[${arm} #${run}] ${r.calls} calls 圖tok ${r.img}(每call ${Math.round(r.img / r.calls)}) NT$${r.cost.toFixed(2)}  注音格 ${r.cells.length}  誤殺 ${ks}  放水 ${ss}`)
  }
}
fs.writeFileSync(path.join(__dirname, 'result2.json'), JSON.stringify(all, null, 1))

const K = c => c.tag + '|' + c.qid
console.log('\n================ 注音判官彙總 ================')
const b = all.filter(r => r.arm === 'ZYBASE')
const bK = b.length ? Math.max(...b.map(r => r.cells.filter(c => c.prodOk === true && !c.ok).length)) : 0
const bS = b.length ? Math.max(...b.map(r => r.cells.filter(c => c.prodOk === false && c.ok).length)) : 0
const bImg = b.length ? b[0].img : 0
console.log('臂'.padEnd(11), '兩次一致'.padEnd(9), '誤殺'.padEnd(8), '放水'.padEnd(8), '圖tok/call'.padStart(11), '省圖'.padStart(6), '判定')
for (const arm of arms) {
  const rs = all.filter(r => r.arm === arm); if (rs.length < 2) continue
  const snap = r => r.cells.slice().sort((a, c) => K(a).localeCompare(K(c))).map(c => K(c) + '=' + c.verdict).join('|')
  const same = snap(rs[0]) === snap(rs[1])
  const ks = rs.map(r => r.cells.filter(c => c.prodOk === true && !c.ok).length)
  const ss = rs.map(r => r.cells.filter(c => c.prodOk === false && c.ok).length)
  const perCall = Math.round(rs[0].img / rs[0].calls)
  const v = arm === 'ZYBASE' ? '—基準—'
    : Math.max(...ks) > bK ? `❌誤殺增加(${Math.max(...ks)}>${bK})`
      : Math.max(...ss) > bS ? `❌放水增加(${Math.max(...ss)}>${bS})`
        : !same ? '⚠️兩次有diff(品質未退)' : '✅可採用'
  console.log(arm.padEnd(11), (same ? '✅' : '❌').padEnd(9), ks.join('/').padEnd(8), ss.join('/').padEnd(8), String(perCall).padStart(11), (bImg ? ((rs[0].img / bImg - 1) * 100).toFixed(0) + '%' : '-').padStart(6), v)
}
// 逐格差異 vs ZYBASE
const bb = all.find(r => r.arm === 'ZYBASE')
if (bb) {
  const bm = new Map(bb.cells.map(c => [K(c), c]))
  for (const arm of arms.filter(a => a !== 'ZYBASE')) {
    const r = all.find(x => x.arm === arm)
    const d = r.cells.filter(c => bm.get(K(c)) && bm.get(K(c)).verdict !== c.verdict)
    console.log(`\n${arm} vs ZYBASE 判定差異 ${d.length} 格${d.length ? ':' : ''}`)
    for (const c of d) console.log(`  ${c.tag} ${c.qid}「${c.key}」 prod=${c.prodOk ? '對' : '錯'}  BASE=${bm.get(K(c)).verdict}(${bm.get(K(c)).votes}) → ${arm}=${c.verdict}(${c.votes})`)
  }
}
