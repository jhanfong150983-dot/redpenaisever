// 2026-09-20 作文錯別字「字典確認器」（零 AI）
//
// user 拍板的三條規則：
//   AI 抓到 ＋ 字典確認 → 高信心，直接採用
//   AI 抓到 ＋ 字典不確認 → 低信心，進低信心清單讓老師確認
//   AI 沒抓到 ＋ 字典抓到 → **無視**
//
// ⭐ 第三條讓實作大幅簡化：字典不必負責「找」錯別字，只要「確認」AI 找到的
//    → 完全不需要斷詞（jieba），省掉最麻煩也最重的那一塊。
//
// 驗證（local-only/essay/_validate_simple_check.py，對 09-19 實驗的 78 筆 AI 錯別字）：
//   本確認器說「確認」 25 筆，命中大考中心官方真值 15 → 精確率 60%
//   本確認器說「不確認」53 筆，命中 19 → 36%
//   （原型那版用 jieba 斷詞找出來的 both 桶只有 14 筆、57%，本版更準也更省）
//   ⚠ 官方樣卷說明只列它想講的錯別字、未必窮舉，所以絕對值可能低估；相對差距才是重點。
//   ⚠ 60% 意味著「直接採用」的那一桶約四成未見於官方清單（user 已知悉並拍板照做）。
//
// 字典＝教育部《重編國語辭典修訂本》詞條＋注音，加 jieba dict.txt.big 詞頻濾網，
// 由 local-only/essay/_build_typo_dict.py 產生 data/typo-dict.json（1.78MB）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
let DICT = null

function load() {
  if (DICT) return DICT
  try {
    const raw = fs.readFileSync(path.join(DIR, 'data', 'typo-dict.json'), 'utf-8')
    const j = JSON.parse(raw)
    DICT = {
      common: new Set(j.common),   // 教育部收錄且常用（詞頻≥300）
      all: new Set(j.all),         // 教育部收錄的全部 2~4 字詞
      sound: j.sound,              // 字 → [無聲調注音]
    }
    console.log(`[EssayTypoDict] 載入：常用詞 ${DICT.common.size}、全部詞 ${DICT.all.size}、注音字 ${Object.keys(DICT.sound).length}`)
  } catch (err) {
    // fail-open：字典載不進來就讓所有 AI 錯別字走低信心（交老師看），不要整個批改掛掉
    console.warn('[EssayTypoDict] 字典載入失敗，全部錯別字改走低信心：', err?.message)
    DICT = { common: new Set(), all: new Set(), sound: {} }
  }
  return DICT
}

const HAN = /^[一-鿿]+$/
const isHan = (s) => typeof s === 'string' && s.length > 0 && HAN.test(s)

/** 兩個字是否同音（不分聲調） */
function sameSound(a, b) {
  const d = load()
  const sa = d.sound[a]
  const sb = d.sound[b]
  if (!sa || !sb) return false
  return sa.some((x) => sb.includes(x))
}

/**
 * 字典是否同意 AI 的這個錯別字判定。
 * @param {string} wrong AI 說學生寫錯的字／詞
 * @param {string} correct AI 建議的正確字／詞
 * @returns {{ok:boolean, reason:string}} ok=true → 高信心
 */
export function confirmTypo(wrong, correct) {
  const d = load()
  if (!d.all.size) return { ok: false, reason: 'dict-unavailable' }
  if (!isHan(wrong) || !isHan(correct)) return { ok: false, reason: 'not-han' }
  if (wrong === correct) return { ok: false, reason: 'same' }

  // ① 建議的正確寫法要真的是個「教育部收錄且常用」的詞（單字則要有注音＝確實是個字）
  //   ⭐ 2026-09-20 AI 改以「詞」為單位輸出後，整串未必是辭典詞（例：「拾它」→「給它」），
  //     但**含被改字的子詞**可能是（例：「鈦舊換新」→「汰舊換新」的「汰舊」）。
  //     所以整串查不到時，再退一步查子詞；兩者都查不到才判 correct-not-a-word。
  // 2 字詞要過詞頻濾網（教育部辭典收了大量冷僻 2 字條目，不濾會放行一堆怪詞）；
  //   3~4 字詞／成語本身就夠明確，收錄即可（例「汰舊換新」jieba 詞頻不足但確實是成語）
  const isWord = (w) => d.all.has(w) && (w.length >= 3 || d.common.has(w))
  const changedAt = wrong.length === correct.length
    ? [...correct].findIndex((c, i) => c !== wrong[i])
    : -1
  const subWordOk = () => {
    if (changedAt < 0) return false
    for (const L of [4, 3, 2]) {
      for (let st = Math.max(0, changedAt - L + 1); st + L <= correct.length && st <= changedAt; st++) {
        const cand = correct.slice(st, st + L)
        const orig = wrong.slice(st, st + L)
        if (isWord(cand) && !d.all.has(orig)) return true   // 改完成詞、改之前不成詞＝典型別字
      }
    }
    return false
  }
  const okCorrect = correct.length >= 2
    ? (isWord(correct) || subWordOk())
    : !!d.sound[correct]
  if (!okCorrect) return { ok: false, reason: 'correct-not-a-word' }

  // ② 學生寫的整串本身就是辭典收錄的詞 → 交老師判（例：「標緻」是詞，字典無從判斷他其實要寫「標誌」）。
  //   ⚠ 這條**故意用最寬的 d.all**（不套詞頻濾網）：高信心＝直接採用，誤判會變成
  //     「跟學生說你寫錯了，但他其實沒錯」——這一側要保守。
  if (wrong.length >= 2 && d.all.has(wrong)) return { ok: false, reason: 'wrong-is-also-a-word' }

  // ③ 只差一個字時要求同音——「別字」的定義就是音近而形異；不同音多半是 AI 抄錯或語意推測
  if (wrong.length === correct.length) {
    const diff = []
    for (let i = 0; i < wrong.length; i++) if (wrong[i] !== correct[i]) diff.push(i)
    if (diff.length === 1) {
      const i = diff[0]
      if (!sameSound(wrong[i], correct[i])) return { ok: false, reason: 'not-homophone' }
    } else if (diff.length > 1) {
      return { ok: false, reason: 'multi-char-diff' }
    }
  }
  return { ok: true, reason: 'ok' }
}

/**
 * 把 AI 的錯別字清單分桶。
 * @returns {{typos:Array, highCount:number, lowCount:number}}
 */
export function bucketTypos(typos) {
  const out = (Array.isArray(typos) ? typos : []).map((t) => {
    const { ok, reason } = confirmTypo(String(t?.wrong ?? ''), String(t?.correct ?? ''))
    return { ...t, confidence: ok ? 'high' : 'low', dictReason: reason }
  })
  return {
    typos: out,
    highCount: out.filter((t) => t.confidence === 'high').length,
    lowCount: out.filter((t) => t.confidence === 'low').length,
  }
}
