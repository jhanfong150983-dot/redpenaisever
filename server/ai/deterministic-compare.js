// ═══ 確定性比對器（Phase 0b-7 code-first 用）— 2026-08-15 ═══════════════════════
// 命題（user）：有沒有可以先 code、但目前沒先 code 的？
// 全庫實證（約 4.4 萬格、docs/批改路由盤點_code-first可行性_2026-08-15.md）：
//   true_false 100% 判得動且 0 筆不一致；single_choice/check 家族 94–100%；
//   數學 fill_blank 93%／98% 一致。不一致逐筆歸因後，扣掉比對器缺陷與答案卷欄位錯，
//   其餘全是 AI 判錯（誤殺 113、放水 7）——這些格 code 比 accessor 準。
//
// 設計原則：
//   ・**寬鬆但不越權**：大小寫/全半形/圈號/括號/尾端句讀/列舉分隔符/是非符號/選項代號
//     跨記號/數值與代數等價，一律視為等價；判不動一律回 null 交回 accessor。
//   ・⚠ 英文字母之間的空白**保留**——實測「bath room」vs 標答「bathroom」，
//     算不算對是老師的拼寫尺度，code 不該替它決定。
//   ・⚠ 不做「去單位後數值相同」——單位政策屬於 answerKey.unitErrorRule，交給既有路徑。
//     （不設限會鬧笑話：「7元」等於「多多給皮皮 7 元」、平方公尺等於立方公尺。）

import { relationGateVerdict } from './numeric-relation-gate.js'

// 只有這些題型走 code-first；其餘（word_problem/calculation/短答/表格/作圖/複合題）
// 維持既有路徑。判官型（VJ/字形/級分制/map_fill）在更早的階段就已 bypass。
export const CODE_FIRST_CATEGORIES = new Set([
  'single_choice', 'multi_choice', 'true_false', 'fill_blank',
  'single_check', 'multi_check', 'multi_check_other', 'circle_select_one',
  'ordering', 'multi_fill',
])

// 不等式符號（刻意不含「=」，理由見 decideDeterministic 末段）
const INEQ = /(<=|>=|[<>≤≧≥≦⩽⩾])/u

const PLACEHOLDER = new Set(['未作答', '無法辨識', '圖像辨識', '圖上作答', '卷面作答', ''])
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
const CJKNUM = '一二三四五六七八九十'
const HEAVEN = '甲乙丙丁戊己庚辛壬癸'

// 選項代號跨記號等價：甲=A=1=①（2026-06-02 既有規則，此處沿用）
//   ＋序數敘述「第二個」「第4項」→ 2、4（2026-08-15：勾選題的標答常是這種寫法，
//   學生填的是編號；不解析的話會被下面「標答為文字」規則誤判成錯——回放實測 173 格）。
function optionIndex(s) {
  let t = String(s ?? '').trim().replace(/^[（(]\s*|\s*[）)]$/gu, '')
  const ord = t.match(/^第\s*([0-9０-９一二三四五六七八九十])\s*[個項題張幅條列格排]?$/u)
  if (ord) {
    const c = ord[1].replace(/[０-９]/gu, (x) => String.fromCharCode(x.charCodeAt(0) - 0xFF10))
    const i = CJKNUM.indexOf(c)
    const idx = i >= 0 ? i + 1 : (/^[1-9]$/u.test(c) ? Number(c) : null)
    return idx ? { idx, fromText: true } : null
  }
  if (t.length !== 1) return null
  let i = CIRCLED.indexOf(t); if (i >= 0) return { idx: i + 1, fromText: false }
  i = HEAVEN.indexOf(t); if (i >= 0) return { idx: i + 1, fromText: false }
  i = CJKNUM.indexOf(t); if (i >= 0) return { idx: i + 1, fromText: false }
  if (/^[A-Za-z]$/u.test(t)) return { idx: t.toUpperCase().charCodeAt(0) - 64, fromText: false }
  if (/^[1-9]$/u.test(t)) return { idx: Number(t), fromText: false }
  return null
}

// 是非等價（比照 normalizeTrueFalseAnswer 的精神）
function tfValue(s) {
  const t = String(s ?? '').trim().replace(/\s/gu, '')
  if (/^[○◯oO✓✔vV對是T]$/u.test(t)) return 'O'
  if (/^[Xx×✗✘╳錯否F]$/u.test(t)) return 'X'
  return null
}

const SENT = ''
export function normLenient(s) {
  let t = String(s ?? '').trim()
    .replace(/[０-９]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10))
    .replace(/[Ａ-Ｚａ-ｚ]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(new RegExp(`[${CIRCLED}]`, 'gu'), (c) => String(CIRCLED.indexOf(c) + 1))
    .replace(/[，]/gu, ',').replace(/[。]/gu, '.').replace(/[；]/gu, ';').replace(/[：]/gu, ':')
    .replace(/[−–—]/gu, '-').replace(/[°º˚]/gu, '')
  // 逐項帶括號的清單「(1),(2),(4)」→「1,2,4」。只在**整串都是括號短項**時才剝，
  //   否則會把數學式「2(x+3)」拆成「2x+3」（2026-08-15 回放實測 79 格多選題誤殺）。
  if (/^[（(][^（()）]{1,3}[）)]([,、\s]*[（(][^（()）]{1,3}[）)])+$/u.test(t)) {
    t = t.replace(/[（()）]/gu, (c) => (c === '（' || c === '(' ? '' : ','))
      .replace(/[、\s]/gu, ',').replace(/,+/gu, ',').replace(/^,|,$/gu, '')
  }
  t = t.replace(/^[（(]\s*(.+?)\s*[）)]$/u, '$1')
  // 列舉分隔符折疊（≥2 個記號、千分位豁免）——與 staged-grading.foldEnumSeparators 同判準
  const marks = (t.match(/(?<=\d)\s*[.,、]\s*(?=\d)/gu) || []).length
  if (marks >= 2 && !/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(t.replace(/\s+/gu, ''))) {
    t = t.replace(/(?<=\d)\s*[.,、]\s*(?=\d)/gu, ',')
  }
  // 英文字母之間的空白保留成單一空白，其餘全刪
  t = t.replace(/(?<=[A-Za-z])\s+(?=[A-Za-z])/gu, SENT).replace(/\s+/gu, '').replace(new RegExp(SENT, 'gu'), ' ')
  return t.replace(/[.。!！?？,，、;；]+$/u, '').toLowerCase()
}

// 未約分分數（fractionRule=require_simplified 時要交給既有路徑處理）
const looksUnsimplified = (s) => {
  const m = String(s ?? '').match(/^(-?\d+)\s*\/\s*(\d+)$/u)
  if (!m) return false
  const a = Math.abs(Number(m[1])), b = Number(m[2])
  if (!b || a === 0) return false
  const g = (x, y) => (y ? g(y, x % y) : x)
  return g(a, b) > 1
}


// 標答是不是「形式答案」（數、式、代號、是非）——只有這類才由 code 全權定案。
//   含中日文字（含單位「100公尺」「7分42秒」、詞語「羅妹號事件」）→ 自然語言 → 交 accessor。
//   含兩個以上英文單字（英語句子）→ 交 accessor。
function isFormalAnswer(ref) {
  const s = String(ref ?? '').trim()
  if (!s) return false
  if (/[㐀-鿿぀-ヿ]/u.test(s)) return false        // 有 CJK → 文字
  if ((s.match(/[A-Za-z]{2,}/gu) || []).length > 0 && !/^[A-Za-z]$/u.test(s)) {
    // 多字母詞（bathroom、kitchen）→ 文字；單一變數 x/y 不算
    if (!/^[A-Za-z]\s*(<=|>=|<|>|=)/u.test(s)) return false
  }
  return /^[\d\s.,/%+\-*()\[\]<>=xXyYaAbBnN×÷≤≥°]+$/u.test(s) || optionIndex(s)?.fromText === false || !!tfValue(s)
}


// ── 多選題計分（2026-08-15 user 拍板：把部分給分變成答案卷的正式設定）────────────
// 背景：AI 原本自行「答對一個給一半」——答案卷裡沒有這條規則。這是「AI 自行加碼」的
//   同一個病（面積要單位、英文要句點皆同類），沒有規則撐著就會在不同批次給不同分。
// answerKey.multiCheckRule：
//   'deduct'（預設）＝每錯一個扣 multiCheckDeduction 分（預設 1）；漏選與誤選同權、下限 0。
//                     user 拍板：「錯1扣1、多1也扣1」。全庫 122 題多選中 91 題是「2 分／2 正解」，
//                     這種題扣 1 分恰等於扣掉一個選項的配分。
//   'all_or_nothing' ＝集合完全相同才給分，否則 0
//   'partial'        ＝滿分 × 選對數/正解數，多選不倒扣（＝AI 原本的實際行為）
//   'partial_strict' ＝只要選到非正解就 0；否則同 partial
const MULTI_CATEGORIES = new Set(['multi_check', 'multi_check_other', 'multi_choice'])

function optionSet(raw) {
  const toks = normLenient(raw).split(/[,;\s]+/u).map((x) => x.trim()).filter(Boolean)
  if (toks.length === 0) return null
  const out = new Set()
  for (const tk of toks) {
    const oi = optionIndex(tk)
    if (!oi) return null            // 有無法對應成選項的 token → 交回 accessor
    out.add(oi.idx)
  }
  return out
}

function gradeMultiSelect(q, ref, stu, answerKey) {
  const rule = String(answerKey?.multiCheckRule ?? 'deduct')
  const R = optionSet(ref), S = optionSet(stu)
  if (!R || !S) return null
  const max = Math.max(0, Number(q?.maxScore) || 0)
  const hit = [...S].filter((x) => R.has(x)).length
  const extra = [...S].filter((x) => !R.has(x)).length
  const exact = hit === R.size && extra === 0
  const missed = R.size - hit
  if (exact) return { verdict: 'equal', by: '多選集合相同', score: max }
  if (rule === 'deduct') {
    const per = Number.isFinite(Number(answerKey?.multiCheckDeduction)) ? Number(answerKey.multiCheckDeduction) : 1
    const score = Math.max(0, Math.round((max - (missed + extra) * per) * 10) / 10)
    return {
      verdict: 'differ',
      by: `多選扣分（漏選 ${missed}、誤選 ${extra}，每個扣 ${per} 分）`,
      score,
    }
  }
  if (rule === 'all_or_nothing') return { verdict: 'differ', by: '多選未完全正確（全有全無）', score: 0 }
  if (rule === 'partial_strict' && extra > 0) {
    return { verdict: 'differ', by: `多選有誤選（規則：選錯即 0）`, score: 0 }
  }
  const score = Math.round((max * hit / Math.max(1, R.size)) * 10) / 10
  return {
    verdict: score >= max ? 'equal' : 'differ',
    by: `多選部分給分（選對 ${hit}/${R.size}${extra ? `、誤選 ${extra}` : ''}）`,
    score,
  }
}

/**
 * 這一格能不能由 code 直接定案？
 * @returns null（判不動 → 交 accessor）| { verdict: 'equal'|'differ', by }
 */
export function decideDeterministic({ question, studentAnswer, answerKey, status }) {
  const q = question
  if (!q) return null
  const cat = String(q.questionCategory ?? '')
  if (!CODE_FIRST_CATEGORIES.has(cat)) return null
  // 合題（一格多小題）要逐空計分 → 交既有路徑
  if (Array.isArray(q.parts) && q.parts.length >= 2) return null
  // 英語規則啟用時，fill_blank/short_answer 的拼字/大小寫/標點扣分是 accessor 的職責
  const hasEnglishRules = !!(answerKey?.englishRules?.punctuationCheck?.enabled || answerKey?.englishRules?.wordOrderCheck?.enabled)
  if (hasEnglishRules && (cat === 'fill_blank' || cat === 'short_answer')) return null

  const ref = String(q.answer ?? '').trim()
  const stu = String(studentAnswer ?? '').trim()
  if (!ref || PLACEHOLDER.has(stu) || status !== 'read') return null
  // 標答本身列了多個可接受答案（頓號/斜線）→ 交既有路徑（那裡有 refAlts 邏輯）。
  //   ⚠ 先把「數字/數字」的分數線挖掉再判，否則「x>4/3」「73/11」「1/3小時」全被誤擋
  //   （2026-08-15 實測：原寫法要求整串就是一個純分數才放行，覆蓋率被砍掉一大塊）。
  if (/[、／/]/u.test(ref.replace(/\d+\s*\/\s*\d+/gu, ''))) return null
  if (answerKey?.fractionRule === 'require_simplified' && looksUnsimplified(stu)) return null

  const R = normLenient(ref), S = normLenient(stu)
  if (!R || !S) return null
  if (R === S) return { verdict: 'equal', by: '正規化後相同' }

  // 多選題：依答案卷的 multiCheckRule 計分（含部分給分）
  if (MULTI_CATEGORIES.has(cat)) return gradeMultiSelect(q, ref, stu, answerKey)

  const tr = tfValue(ref), ts = tfValue(stu)
  if (tr && ts) return { verdict: tr === ts ? 'equal' : 'differ', by: '是非等價' }

  // 圈選題的讀值常把整行選項文字一起抄回來（「A. 2 hamburgers, French fries,」）——
  //   標答是單一代號時，取學生答案開頭的代號比對（2026-08-15 回放實測 20 格誤殺）。
  const leadCode = (s) => {
    const m = String(s ?? '').trim().match(/^[（(]?\s*([A-Za-z1-9甲乙丙丁戊①-⑳])\s*[）).、,:：]/u)
    return m ? m[1] : null
  }
  const ir = optionIndex(ref), is = optionIndex(stu) ?? (optionIndex(ref) ? optionIndex(leadCode(stu)) : null)
  if (ir && is) {
    if (ir.idx === is.idx) return { verdict: 'equal', by: '選項代號等價' }
    // ⚠ 序數敘述（「第四個」）只能用來「確認相同」，不能用來判不同：答案卷存的是選項文字、
    //   學生填的是編號，兩者的編號基準未必一致（回放實測 51 格：標答「第四個」學生「1」
    //   而 AI 看圖判正確）。符號代號（A/甲/①）沒有這個歧義，可以判不同。
    if (ir.fromText || is.fromText) return null
    return { verdict: 'differ', by: '選項代號等價' }
  }

  const g = relationGateVerdict(ref, stu)
  if (g === 'equal' || g === 'equal_approx') return { verdict: 'equal', by: '數值/代數等價' }
  if (g === 'differ') return { verdict: 'differ', by: '數值/代數不等' }

  // 兩邊都是短英數（≤12 字、無單位無中文）→ 不同就是不同
  if (/^[a-z0-9]{1,12}$/u.test(R) && /^[a-z0-9]{1,12}$/u.test(S)) return { verdict: 'differ', by: '短英數不同' }

  // ── 形式答案：等價才對，其餘一律錯（user 拍板 2026-08-15）──────────────────
  //   「圖、文字語言交給 accessor；代號、符號、數學（除應用題）直接交給 code」。
  //   理由：等價在形式物件（數、式、代號、是非）上是可計算的，在自然語言上不是。
  //   AI 對形式物件只會製造不一致——本日盤點的放水與誤殺幾乎全在這裡，其中
  //   數練36-37 那 13 格 AI 還宣稱「經核對影像」，但 fill_blank 的 accessor 根本
  //   拿不到裁圖（cropTypesForAccessor 只含 calc/word_problem）——證據是編的。
  //   代價明示：學生若寫出 code 解析不了的形式（絕對值、多變數、殘缺式）會算錯，
  //   由學生向老師申訴改分——人工才是最標準。
  if (isFormalAnswer(ref)) {
    // ⚠ 唯一保留的寬鬆：只有一邊帶 % 而字面數字相同（學生「45」vs 標答「45%」）。
    //   答案卷格子後面通常已經印著「％」，學生不必再寫；嚴格判錯會誤殺（回放 11 格，
    //   現行 AI 全判正確）。要改成嚴格，把這段拿掉即可。
    const pctA = /^-?[\d.]+%$/u.test(ref.replace(/\s/gu, '')), pctB = /^-?[\d.]+%$/u.test(stu.replace(/\s/gu, ''))
    if (pctA !== pctB && R.replace(/%/gu, '') === S.replace(/%/gu, '')) {
      return { verdict: 'equal', by: '百分號有無（格子已印％）' }
    }
    return { verdict: 'differ', by: '與標準答案不等價' }
  }

  // 標答是不等式、學生完全沒用關係符號 → 錯（2026-08-15 user：這單元在考不等式）
  //   實例：標答「330<=x<=350」、學生「330~350」——波浪號表達的區間雖然同義，但答案卷
  //   要的是不等式；同一格兩輪一判對一判錯，正是沒有確定性規則的後果。
  //   以答案卷為準（見 docs/批改路由盤點）：答案卷寫不等式，就是要不等式。
  //   ⚠ 只認 < > ≤ ≥，不含單純的「=」——很多標答寫「x=5」但老師接受「5」，那不該被判錯。
  //   全庫實測：符合本條的格僅 13 個（扣掉級分制佔位），且現行幾乎全已判 0 →
  //   不改變分數，但把它們從「AI 心情」變成確定性。
  if (INEQ.test(ref) && !INEQ.test(stu)) {
    return { verdict: 'differ', by: '答案卷要求不等式、學生未使用關係符號' }
  }

  return null
}
