// 判官降本沙盒 #1(2026-08-08):國字判官 HIGH → MEDIUM。
//
// 背景:判官佔全系統成本 58%(每份 NT$3.22),其中圖片輸入佔判官 75%(2.40/份)。
//   每卷 30 calls(10 格 × 3 判官);國字 1 張圖、注音 2 張圖(標準答案圖+學生圖)。
//   8/04 medium 事故(誤殺升高)導致 JUDGE_HIGHRES 把判官全鎖 HIGH。
//   但:國字 crop production 本來就放大 ×3(≤600px)、注音明文禁止放大
//   → 事故很可能主要由注音造成。本實驗把兩者分開:只把「國字」降 MEDIUM、注音維持 HIGH。
//
// 臂:A=BASE(全 HIGH、production 現況)  B=GZMED(國字 MEDIUM、注音 HIGH)
// 各跑 2 輪。基準=今天 production 的判定(grading_result.details[].isCorrect)。
// 指標:誤殺(prod 對→沙盒 錯)、放水(prod 錯→沙盒 對)、兩輪一致、圖片 tok、成本
// 否決線:誤殺或放水比 A 臂多 → 否決(user 硬約束:品質不可變動)
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
const { decomposeGlyph } = await import('../../server/ai/glyph-decomp.js')

const AID = '1778869700051-ollsjczry'
const FIXTURES = [
  { sub: '1778869833186-juyjhvqqi', tag: '座15(66分 5對/5錯)' },
  { sub: '1778869832946-7zydh575f', tag: '座13(84分 6對/4錯)' },
  { sub: '1778869832162-i57h81yzo', tag: '座05(26分 1對/9錯)' },
]
const MODEL = 'gemini-3.5-flash'   // JUDGE_MODEL
const RATE = [1.50, 9.00], TWD = 33  // ⚠ 已查證官方定價(儀表板權威);先前沙盒誤用 0.30/2.50

const { data: asg } = await db.from('assignments').select('answer_key,answer_key_template_id,answer_sheet_image_paths').eq('id', AID).maybeSingle()
const ak = typeof asg.answer_key === 'string' ? JSON.parse(asg.answer_key) : asg.answer_key
const akById = new Map(ak.questions.map(q => [String(q.id), q]))
const keyOf = (qid) => String(akById.get(qid)?.answer ?? akById.get(qid)?.referenceAnswer ?? '').trim()
const kindOf = (qid) => { const k = keyOf(qid); return /^[ㄅ-ㄩˊˇˋ˙]{1,5}$/.test(k) ? 'zhuyin' : /^[一-鿿]{1,2}$/u.test(k) ? 'glyph' : null }

// ── 標準答案圖(production getZyRefCrop 候選鏈) ──
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
const refCropCache = new Map()
const getZyRefCrop = async (qid) => {
  if (refCropCache.has(qid)) return refCropCache.get(qid)
  const akQ = akById.get(qid), b = akQ?.answerBbox
  let out = null
  if (b) {
    const buf = await getRefPage(Math.max(0, Number(akQ?.pageIndex) || 0))
    if (buf) {
      const m = await sharp(buf).metadata(); const pad = 0.01
      const cx = Math.round(Math.max(0, b.x - pad) * m.width), cy = Math.round(Math.max(0, b.y - pad) * m.height)
      const cw = Math.min(m.width - cx, Math.round((Math.min(1, b.x + b.w + pad) - Math.max(0, b.x - pad)) * m.width))
      const ch = Math.min(m.height - cy, Math.round((Math.min(1, b.y + b.h + pad) - Math.max(0, b.y - pad)) * m.height))
      if (cw >= 4 && ch >= 4) out = { mimeType: 'image/jpeg', data: (await sharp(buf).extract({ left: cx, top: cy, width: cw, height: ch }).jpeg({ quality: 90 }).toBuffer()).toString('base64') }
    }
  }
  refCropCache.set(qid, out); return out
}

// ── prompts(逐字照抄 staged-grading.js)──
const COLON = `\n⚠ 印刷題目的冒號「：」、頓號、標點都不是學生的筆畫——不要把它們當成輕聲點或調號。`
const zyPrompts = (k) => [
  `這是「國字注音」題。第一張是【標準答案圖】（老師答案卷、標準答案「${k}」）、第二張是【學生作答圖】。\n你的任務是「比對」、不是辨認：\n1. analysis：把標準「${k}」拆成注音符號＋聲調記號（一聲=無記號），逐一對照——標準圖有的符號/調號學生有沒有？學生有沒有標準圖上沒有的多餘筆畫？\n2. verdict：與標準圖一致 → "same"；符號不同、或多寫/少寫調號 → "different"；學生格內沒有手寫 → "blank"${COLON}\n只輸出 JSON：{"analysis":"60字內","verdict":"same|different|blank","reason":"20字內"}`,
  `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${k}」）、第二張是【學生作答圖】。\n你的任務是「比對」：\n1. analysis：由上而下列出學生實際手寫的每個注音符號、跟標準圖並排比形狀；再比調號——先定位「獨立的短斜筆/勾/點」有沒有，⚠不可把符號自身筆畫當調號。\n2. verdict：形狀序列與調號跟標準圖一致 → "same"；任一不同 → "different"；沒寫 → "blank"${COLON}\n只輸出 JSON：{"analysis":"60字內","verdict":"same|different|blank","reason":"20字內"}`,
  `這是「國字注音」題。第一張是【標準答案圖】（標準答案「${k}」）、第二張是【學生作答圖】。\n你的任務是「找不同」（純比形狀、不要辨認符號名稱）：\n1. diff：並排比較兩張圖中「手寫注音」的部分，列出所有視覺差異（形狀、筆畫數、多出/缺少的獨立筆畫）。\n2. verdict：差異只是字醜、粗細、大小、位置偏移 → "same"；有「多出或缺少一筆獨立筆畫」或「某符號的形狀根本是另一個東西」 → "different"；學生格內沒有手寫 → "blank"${COLON}\n只輸出 JSON：{"diff":"60字內","verdict":"same|different|blank","reason":"20字內"}`,
]
const glyphPromptOf = (k) => {
  const d = decomposeGlyph(k)
  return d ? `這是學生手寫的一個國字。標準答案是「${k}」。\n「${k}」的標準部件拆解（權威資料、請照這個拆解逐塊檢查、不要自行拆解）：${JSON.stringify(d)}\n逐塊回答：學生在該位置寫的，大致上是這個部件嗎？\n判準（老師改考卷的標準）：字醜、潦草、微小筆畫差異（多一點/少一橫/內部細節模糊）都算 same。\n只有「某一大塊寫成別的東西」「缺了一整塊」「整個字是另一個字或自創字」才是 different。\n格內完全沒有手寫筆跡（只有印刷）→ verdict="blank"。\n只輸出 JSON：{"blocks":"逐塊對照（60字內）","verdict":"same|different|blank","reason":"20字內結論"}` : `這是學生手寫的一個國字。標準答案是「${k}」。\n你的任務：判斷學生寫的是不是「${k}」這個字。用「大部件」層級比對、不要逐筆畫檢查：\n1. blocks：把「${k}」拆成最多 2~3 個大部件（左右或上下大塊），逐塊回答——學生在這個位置寫的，大致上是同一個東西嗎？\n2. 判準（老師改考卷的標準）：字醜、潦草、微小筆畫差異（多一點/少一橫/內部細節模糊）都算 same。\n   只有「某一大塊寫成別的東西」「缺了一整塊」「整個字是另一個字或自創字」才是 different。\n格內完全沒有手寫筆跡（只有印刷）→ verdict="blank"。\n只輸出 JSON：{"blocks":"逐塊對照（60字內）","verdict":"same|different|blank","reason":"20字內結論"}`
}

const acc = { calls: 0, img: 0, cost: 0 }
const parse = (d) => { const t = (d?.candidates ?? []).flatMap(c => c?.content?.parts ?? []).map(p => p?.text ?? '').join(''); const m = t.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) } catch { return null } }
async function judge(parts, mediaRes) {
  const r = await callGeminiGenerateContent({
    apiKey: KEY, model: MODEL, contents: [{ role: 'user', parts }],
    payload: { generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' }, mediaResolution: mediaRes } },
    timeoutMs: 60000,
  })
  const u = r?.data?.usageMetadata ?? {}
  const img = (u.promptTokensDetails ?? []).find(d => d.modality === 'IMAGE')?.tokenCount ?? 0
  acc.calls++; acc.img += img
  acc.cost += ((u.promptTokenCount ?? 0) / 1e6 * RATE[0] + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) / 1e6 * RATE[1]) * TWD
  return parse(r?.data)
}

// 一格判定(鏡像 production 多數決/一票殺)
async function judgeCell(kind, key, stuCrop, refCrop, mediaRes) {
  if (kind === 'zhuyin') {
    if (!refCrop) return { verdict: 'noref', votes: '' }
    const pv = await Promise.all(zyPrompts(key).map(p => judge([{ text: p }, { text: '【標準答案圖】' }, { inlineData: refCrop }, { text: '【學生作答圖】' }, { inlineData: stuCrop }], mediaRes)))
    const votes = pv.map(v => v?.verdict ? v.verdict[0] : '?').join('')
    const n = (k) => pv.filter(v => v?.verdict === k).length
    return { verdict: n('blank') >= 2 ? 'blank' : n('different') >= 2 ? 'different' : n('same') >= 2 ? 'same' : 'split', votes }
  }
  const pv = await Promise.all([0, 1, 2].map(() => judge([{ text: glyphPromptOf(key) }, { inlineData: stuCrop }], mediaRes)))
  const votes = pv.map(v => v?.verdict ? v.verdict[0] : '?').join('')
  const blanks = pv.filter(v => v?.verdict === 'blank').length
  return { verdict: blanks >= 2 ? 'blank' : pv.some(v => v?.verdict === 'different') ? 'different' : 'same', votes }
}

// ── 一臂 ──
async function runArm(arm) {
  Object.keys(acc).forEach(k => acc[k] = 0)
  const out = []
  for (const fx of FIXTURES) {
    const { data: sub } = await db.from('submissions').select('phase_a_state,grading_result').eq('id', fx.sub).maybeSingle()
    const al = sub.phase_a_state?.classifyResult?.alignedQuestions ?? []
    const prod = new Map((sub.grading_result?.details ?? []).map(d => [String(d.questionId), d]))
    const r = await db.storage.from('homework-images').download(`submissions/${fx.sub}.webp`)
    const imgB64 = Buffer.from(await r.data.arrayBuffer()).toString('base64')
    for (const q of al) {
      const qid = String(q.questionId)
      const kind = kindOf(qid); if (!kind || !q.answerBbox) continue
      // production 裁圖:inflateBboxForType(fill_blank pad 0.005) + useActualBbox pad 0.005
      const p = 0.005
      const bb = { x: Math.max(0, q.answerBbox.x - p), y: Math.max(0, q.answerBbox.y - p), w: Math.min(1, q.answerBbox.x + q.answerBbox.w + p) - Math.max(0, q.answerBbox.x - p), h: Math.min(1, q.answerBbox.y + q.answerBbox.h + p) - Math.max(0, q.answerBbox.y - p) }
      let stuCrop = await cropInlineImageByBbox(imgB64, 'image/webp', bb, true, p)
      if (!stuCrop) continue
      // 國字放大 ×3(≤600px);⛔注音不可放大(production 鐵則)
      if (kind !== 'zhuyin') {
        const buf = Buffer.from(stuCrop.data, 'base64'); const m = await sharp(buf).metadata()
        if (m?.width && m.width < 600) stuCrop = { data: (await sharp(buf).resize({ width: Math.min(600, m.width * 3) }).jpeg({ quality: 92 }).toBuffer()).toString('base64'), mimeType: 'image/jpeg' }
      }
      const refCrop = kind === 'zhuyin' ? await getZyRefCrop(qid) : null
      // 臂差異:B 臂只把「國字」降 MEDIUM,注音維持 HIGH
      const mediaRes = (arm === 'GZMED' && kind !== 'zhuyin') ? 'MEDIA_RESOLUTION_MEDIUM' : 'MEDIA_RESOLUTION_HIGH'
      const res = await judgeCell(kind, keyOf(qid), stuCrop, refCrop, mediaRes)
      const pd = prod.get(qid)
      out.push({ tag: fx.tag, qid, kind, key: keyOf(qid), prodOk: pd ? !!pd.isCorrect : null, verdict: res.verdict, votes: res.votes, ok: res.verdict === 'same' })
    }
  }
  return { arm, cells: out, ...acc }
}

// ── 主 ──
const arms = (process.argv[2] ? process.argv[2].split(',') : ['BASE', 'GZMED']).map(s => s.trim().toUpperCase())
const all = []
for (const arm of arms) {
  for (const run of [1, 2]) {
    const r = await runArm(arm); r.run = run; all.push(r)
    const gz = r.cells.filter(c => c.kind !== 'zhuyin'), zy = r.cells.filter(c => c.kind === 'zhuyin')
    const ks = r.cells.filter(c => c.prodOk === true && !c.ok).length   // 誤殺
    const ss = r.cells.filter(c => c.prodOk === false && c.ok).length   // 放水
    console.log(`[${arm} #${run}] ${r.calls} calls 圖tok ${r.img} NT$${r.cost.toFixed(2)}  | 格 ${r.cells.length}(國字${gz.length}/注音${zy.length})  誤殺 ${ks}  放水 ${ss}`)
  }
}
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(all, null, 1))

console.log('\n================ 彙總 ================')
const key = c => c.tag + '|' + c.qid
console.log('臂'.padEnd(8), '兩次一致'.padEnd(9), '誤殺(兩次)'.padEnd(11), '放水(兩次)'.padEnd(11), '國字圖tok'.padStart(9), 'NT$/份'.padStart(8), '判定')
const base = all.filter(r => r.arm === 'BASE')
const bKs = base.map(r => r.cells.filter(c => c.prodOk === true && !c.ok).length)
const bSs = base.map(r => r.cells.filter(c => c.prodOk === false && c.ok).length)
for (const arm of arms) {
  const rs = all.filter(r => r.arm === arm); if (rs.length < 2) continue
  const snap = r => r.cells.slice().sort((a, b) => key(a).localeCompare(key(b))).map(c => key(c) + '=' + c.verdict).join('|')
  const same = snap(rs[0]) === snap(rs[1])
  const ks = rs.map(r => r.cells.filter(c => c.prodOk === true && !c.ok).length)
  const ss = rs.map(r => r.cells.filter(c => c.prodOk === false && c.ok).length)
  const gzImg = Math.round(rs.reduce((a, r) => a + r.cells.filter(c => c.kind !== 'zhuyin').length, 0) / 2)
  const perPaper = (rs[0].cost + rs[1].cost) / 2 / FIXTURES.length
  const v = arm === 'BASE' ? '—基準—'
    : (Math.max(...ks) > Math.max(...bKs) ? `❌誤殺增加(${Math.max(...ks)}>${Math.max(...bKs)})`
      : Math.max(...ss) > Math.max(...bSs) ? `❌放水增加(${Math.max(...ss)}>${Math.max(...bSs)})`
        : !same ? '⚠️兩次有diff(但品質未退)' : '✅可採用')
  console.log(arm.padEnd(8), (same ? '✅' : '❌').padEnd(9), ks.join(' / ').padEnd(11), ss.join(' / ').padEnd(11), String(Math.round(rs[0].img)).padStart(9), perPaper.toFixed(2).padStart(8), v)
}
// 逐格差異(BASE vs GZMED,只列國字)
if (arms.length === 2) {
  const b = all.find(r => r.arm === 'BASE'), g = all.find(r => r.arm === 'GZMED')
  const gm = new Map(g.cells.map(c => [key(c), c]))
  const diffs = b.cells.filter(c => c.kind !== 'zhuyin' && gm.get(key(c)) && gm.get(key(c)).verdict !== c.verdict)
  console.log(`\n國字格 BASE↔GZMED 判定差異 ${diffs.length} 格:`)
  for (const c of diffs) console.log(`  ${c.tag} ${c.qid}「${c.key}」 prod=${c.prodOk ? '對' : '錯'}  BASE=${c.verdict}(${c.votes}) → GZMED=${gm.get(key(c)).verdict}(${gm.get(key(c)).votes})`)
}
