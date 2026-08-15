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
function optionIndex(s) {
  const t = String(s ?? '').trim().replace(/^[（(]\s*|\s*[）)]$/gu, '')
  if (t.length !== 1) return null
  let i = CIRCLED.indexOf(t); if (i >= 0) return i + 1
  i = HEAVEN.indexOf(t); if (i >= 0) return i + 1
  i = CJKNUM.indexOf(t); if (i >= 0) return i + 1
  if (/^[A-Za-z]$/u.test(t)) return t.toUpperCase().charCodeAt(0) - 64
  if (/^[1-9]$/u.test(t)) return Number(t)
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

  const tr = tfValue(ref), ts = tfValue(stu)
  if (tr && ts) return { verdict: tr === ts ? 'equal' : 'differ', by: '是非等價' }

  const ir = optionIndex(ref), is = optionIndex(stu)
  if (ir && is) return { verdict: ir === is ? 'equal' : 'differ', by: '選項代號等價' }

  const g = relationGateVerdict(ref, stu)
  if (g === 'equal' || g === 'equal_approx') return { verdict: 'equal', by: '數值/代數等價' }
  if (g === 'differ') return { verdict: 'differ', by: '數值/代數不等' }

  // 兩邊都是短英數（≤12 字、無單位無中文）→ 不同就是不同
  if (/^[a-z0-9]{1,12}$/u.test(R) && /^[a-z0-9]{1,12}$/u.test(S)) return { verdict: 'differ', by: '短英數不同' }

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
