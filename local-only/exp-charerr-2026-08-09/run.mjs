// 國語 short_answer 錯字覆核：舊(hasError→翻0) vs 新(count→逐字扣1) 對照 × 5 輪
//
// 背景：user 發現同一題全班尺度矛盾——「由下快速地盤旋而上」2/2 而「由下急速的盤旋而上」0/2。
//   根因不是 accessor 隨機，是 SHORTANS_CHARERR 覆核抓到錯字就 sc.score=0（翻零而非扣分），
//   而「意思相近的詞」完全忽略 → 換整個詞沒事、寫錯一個虛字歸零。
// user 拍板的扣分表：語意軸交給 accessor（保留=滿分／部分保留=部分分／改變=0），
//   錯字軸每字扣 1、累加、下限 0、**不因題目分數低而例外**。
// 本沙盒驗證兩件事：① 新 prompt 的錯字數是否跨輪穩定 ② 跨學生同類偏差是否得同分。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelRates, USD_TO_TWD } from '../_rates.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const KEY = process.env.SYSTEM_GEMINI_API_KEY
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')
const MODEL = 'gemini-3.6-flash'          // = MODEL_PRO（production 覆核用的 modelOverride）
const ROUNDS = 5

const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus.json'), 'utf8'))
// 去重：同一個 (題, 寫法) 只需測一次
const uniq = new Map()
for (const c of corpus) {
  const k = `${c.qid}|${c.stu}`
  if (!uniq.has(k)) uniq.set(k, { ...c, n: 1 }); else uniq.get(k).n++
}
const cases = [...uniq.values()]
console.log(`去重後 ${cases.length} 種寫法（原 ${corpus.length} 格）、每種 ${ROUNDS} 輪 × 2 prompt\n`)

// ── 舊 prompt（production 現況、逐字複製）──
const OLD = (ref, stu) => `國語科用字覆核。標準答案：「${ref}」。學生作答（已判定語意正確）：「${stu}」。
只檢查「用字錯誤」，其餘一律忽略：
✅要抓（hasError=true）：錯別字（字或部件寫錯）、以注音符號代替國字、把標準的關鍵字詞寫成不同的字（如「急速」寫成「極速」、「地」寫成「的」）。
❌一律忽略、不算錯：答案不完整／漏字、只答部分、把多個可接受答案併寫、用意思相近的詞、標點差異、簡繁體。
只輸出 JSON：{"hasError":true|false,"which":"若有，指出哪個字寫錯（20字內）"}`

// ── 新 prompt：問「幾個」而不是「有沒有」，並把錯字定義從舉例改成原則 ──
const NEW = (ref, stu) => `國語科用字覆核。標準答案：「${ref}」。學生作答：「${stu}」。
數出學生作答裡有幾個「用字錯誤」。

用字錯誤的定義（只有這一種）：
✅ **音近或形近的別字**——學生想寫的是標準答案裡那個字，但寫成了同音／近音字或形似字。
   例：「地」寫成「的」、「急速」寫成「極速」、「在」寫成「再」、部件寫錯。
✅ 以注音符號代替國字。

一律不算錯、不要計入：
❌ 換成另一個「不同音也不同形」的同義詞（例：「急速」寫成「快速」、「由」寫成「從」）。
❌ 漏字、缺字、答案不完整、只答部分。
❌ 多寫字、贅字、標點差異、簡繁體。
❌ 改用自己的話表達但意思相同。

count = 錯字的個數（0 表示沒有用字錯誤）。同一個字重複寫錯只算 1 個。
只輸出 JSON：{"count":0,"which":"逐一列出哪些字寫錯（30字內），沒有則空字串"}`

const acc = { old: { calls: 0, cost: 0 }, new: { calls: 0, cost: 0 } }
const parse = (d) => { const t = (d?.candidates ?? []).flatMap((c) => c?.content?.parts ?? []).map((x) => x?.text ?? '').join(''); const m = t.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]) } catch { return null } }
const ask = async (prompt, arm) => {
  const r = await callGeminiGenerateContent({
    apiKey: KEY, model: MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    // production 覆核用 READ_ANSWER_GENERATION_CONFIG（temp 0 / MINIMAL）
    payload: { generationConfig: { temperature: 0, thinkingConfig: { thinking_level: 'MINIMAL' } } },
    timeoutMs: 20000
  })
  const u = r?.data?.usageMetadata ?? {}
  const rt = modelRates(MODEL)
  acc[arm].calls++
  acc[arm].cost += ((Number(u.promptTokenCount) || 0) / 1e6 * rt.inUsd
    + ((Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0)) / 1e6 * rt.outUsd) * USD_TO_TWD
  return parse(r?.data)
}

const results = []
let done = 0
const CONC = 6
let idx = 0
await Promise.all(Array.from({ length: CONC }, async () => {
  while (idx < cases.length) {
    const c = cases[idx++]
    const oldRuns = [], newRuns = []
    for (let i = 0; i < ROUNDS; i++) {
      oldRuns.push(await ask(OLD(c.ref, c.stu), 'old'))
      newRuns.push(await ask(NEW(c.ref, c.stu), 'new'))
    }
    const oldErr = oldRuns.map((x) => x?.hasError === true)
    const newCnt = newRuns.map((x) => Number(x?.count))
    results.push({
      ...c,
      oldErr, oldStable: new Set(oldErr).size === 1,
      newCnt, newStable: new Set(newCnt).size === 1,
      newWhich: String(newRuns[0]?.which ?? '').slice(0, 40),
      // 新分數＝現行分數 − 錯字數（下限 0）；用眾數當代表
      newScore: Math.max(0, c.score - (newCnt.sort((a, b) => newCnt.filter(v => v === a).length - newCnt.filter(v => v === b).length).pop() || 0))
    })
    done++
    if (done % 20 === 0) console.log(`  …${done}/${cases.length}`)
  }
}))
results.sort((a, b) => a.cls.localeCompare(b.cls) || a.qid.localeCompare(b.qid) || a.stu.localeCompare(b.stu))

const oldUnstable = results.filter((r) => !r.oldStable)
const newUnstable = results.filter((r) => !r.newStable)
console.log(`\n${'═'.repeat(70)}`)
console.log(`① 跨輪穩定度（${ROUNDS} 輪同輸入）`)
console.log(`   舊 prompt(hasError)：不穩 ${oldUnstable.length}/${results.length} 種`)
console.log(`   新 prompt(count)   ：不穩 ${newUnstable.length}/${results.length} 種`)
for (const r of newUnstable.slice(0, 12)) console.log(`     ⚠ ${r.cls}${r.qid} 「${r.stu.slice(0, 30)}」 count=${r.newCnt.join(',')}`)

console.log(`\n② 分數變動（現行 → 新規則；權重＝該寫法出現幾格）`)
const changed = results.filter((r) => r.newScore !== r.score)
let cells = 0
for (const r of changed) cells += r.n
console.log(`   ${changed.length} 種寫法、共 ${cells} 格會變動`)
for (const r of changed) console.log(`     ${r.cls}${r.qid} ×${r.n}格  「${r.stu.slice(0, 34)}」  ${r.score}/${r.max} → ${r.newScore}/${r.max}  錯字${r.newCnt[0]}「${r.newWhich}」`)

console.log(`\n③ 舊規則會翻 0 的（對照：新規則只扣 ${1} 分/字）`)
const oldZero = results.filter((r) => r.oldErr[0] === true)
let oz = 0; for (const r of oldZero) oz += r.n
console.log(`   ${oldZero.length} 種寫法、共 ${oz} 格`)
for (const r of oldZero) console.log(`     ${r.cls}${r.qid} ×${r.n}格  「${r.stu.slice(0, 34)}」  舊:${r.score}→0   新:${r.score}→${r.newScore}  「${r.newWhich}」`)

console.log(`\n成本：舊 ${acc.old.calls} calls NT$${acc.old.cost.toFixed(2)}、新 ${acc.new.calls} calls NT$${acc.new.cost.toFixed(2)}、合計 NT$${(acc.old.cost + acc.new.cost).toFixed(2)}`)
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(results, null, 1))
