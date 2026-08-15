// ═══ 數值關係閘門（確定性）— 2026-08-15 ════════════════════════════════════════
// 由來：培英數學第三次定期評量實測 4 件放水——
//   ・1-1-10 學生「x <= 7 6/11」(=83/11) vs 標答「x<=73/11」→ 判「答案正確」滿分
//   ・1-1-9  學生「x > 50/7」 vs 標答「x>=50/7」→ 三人皆滿分（端點含不含是實打實的觀念）
// 根因有二，兩道既有閘門都把不等式擋在程式覆核之外：
//   ① staged-grading 的 isSimpleAnswer 字元集不含 < > = → 整段覆核跳過
//   ② studentHasCalcSteps 看到答案裡的「=」就認定含計算過程 → 再跳過一次
//   （就算跑到，isNumericEqual 的 stripUnit 也會把 < > = 一併刪掉再比數值。）
// 共同病灶：模型在「看數字」不在「算數值」——7 6/11 與 73/11 數字都在、> 與 ≥ 只差一條線。
//
// 設計原則（依 feedback_misgrade_acceptable_overcredit_worth_catching）：
//   **單向**——只把「數值確定不等卻拿滿分」降為 0，絕不反向加分。
//   加分牽涉單位、最簡分數、要不要列式等規則，風險遠高於收益；誤殺走申訴可接受，
//   但抓放水不可以引入新誤殺，所以任何解析不確定的情況一律 skip（回到 AI 判斷）。
// 保守條件：兩邊都要解析成精確有理數；關係符號要嘛都有、要嘛都沒有（只有一邊有 → skip）。

import { linearVerdict } from './linear-expression.js'

const FULLWIDTH_DIGIT = /[０-９]/g

// 「=」視同沒有關係符號（「= 55.7」與「55.7」是同一件事，等號只是書寫習慣）
function normalizeRelation(sym) {
  return sym === '=' ? '' : sym
}

/**
 * 解析「關係符號＋精確數值」。任何無法確定的形式一律回 null（交回 AI）。
 * 支援：整數、小數、分數 a/b、帶分數 a b/c、百分比；前綴「答:」「x」等單一變數。
 * 回 { rel, n, d, isDecimal, places } —— 數值以有理數 n/d 表示，比較用交叉相乘避免浮點誤差。
 */
export function parseRelationValue(rawIn) {
  let s = String(rawIn ?? '').trim()
  if (!s) return null
  s = s
    .replace(FULLWIDTH_DIGIT, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10))
    .replace(/[≤≦⩽]/gu, '<=').replace(/[≥≧⩾]/gu, '>=')
    .replace(/＜/gu, '<').replace(/＞/gu, '>').replace(/[＝]/gu, '=')
    .replace(/[－−–—]/gu, '-')
    .replace(/[（(]\s*|\s*[）)]/gu, '')
    .trim()
  // 前綴：答: / Ans: / A:
  s = s.replace(/^(?:答|[Aa]ns|[Aa])\s*[:：]\s*/u, '').trim()
  // 尾端句讀剝除。⚠ 2026-08-15 實測破口：同一格兩輪讀成「x>50/7」與「x>50/7.」，
  //   帶句點那次解析失敗 → 閘門靜默跳過 → AI 放水 3 分，等於閘門形同虛設。
  //   （staged-grading 的 norm() 本來就會剝尾端句讀，閘門拿的是原始讀值，得自己剝。）
  //   只剝尾端：小數點在數字之間，不受影響。
  s = s.replace(/[.。、,，;；!！?？\s]+$/u, '').trim()
  // 單一變數 + 關係符號（x>=、y <）——變數本身不參與比較
  s = s.replace(/^[A-Za-z]\s*(?=<=|>=|<|>|=)/u, '').trim()

  const relMatch = s.match(/^(<=|>=|<|>|=)/u)
  const rel = normalizeRelation(relMatch?.[1] ?? '')
  let body = s.slice(relMatch?.[1]?.length ?? 0).trim()
  if (!body) return null

  let percent = false
  if (body.endsWith('%')) { percent = true; body = body.slice(0, -1).trim() }

  let m = body.match(/^(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/u)          // 帶分數 6 7/11
  if (m) {
    const [w, n, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (!d) return null
    const sign = w < 0 ? -1 : 1
    return { rel, percent, n: sign * (Math.abs(w) * d + n), d, isDecimal: false, places: 0 }
  }
  m = body.match(/^(-?\d+)\s*\/\s*(\d+)$/u)                       // 分數 73/11
  if (m) {
    const d = Number(m[2])
    return d ? { rel, percent, n: Number(m[1]), d, isDecimal: false, places: 0 } : null
  }
  m = body.match(/^(-?\d+)(?:\.(\d+))?$/u)                        // 整數 / 小數
  if (m) {
    const places = m[2]?.length ?? 0
    const n = Number(`${m[1]}${m[2] ?? ''}`.replace(/^(-?)0*(?=\d)/, '$1'))
    if (!Number.isFinite(n)) return null
    return { rel, percent, n, d: 10 ** places, isDecimal: places > 0, places }
  }
  return null   // 含單位、文字、多值、算式 → 不碰
}

const rawValue = (p) => p.n / p.d                       // 未套百分比的字面值
const value = (p) => rawValue(p) / (p.percent ? 100 : 1)  // 實際數值

/**
 * @returns 'equal' | 'differ' | null（null = 無法確定，維持 AI 判斷）
 */
export function relationGateVerdict(refRaw, studentRaw) {
  // 含變數 → 走一元一次式等價（係數比對）。2026-08-15：AI 判代數等價會漏項——
  //   培英 1-1-5 學生少了成本項 -x，AI 仍以「代入驗證同解」判對。
  if (/[A-Za-z]/u.test(String(refRaw ?? '')) || /[A-Za-z]/u.test(String(studentRaw ?? ''))) {
    return linearVerdict(refRaw, studentRaw)
  }
  const ref = parseRelationValue(refRaw)
  const stu = parseRelationValue(studentRaw)
  if (!ref || !stu) return null
  // 關係符號只有一邊有 → 學生可能把「x≥」寫在框外、或標答寫得寬鬆 → 不判
  if ((ref.rel === '') !== (stu.rel === '')) return null
  // 只有一邊帶 % 且**字面數字相同**（「45」vs「45%」）→ 不判：多半是格子後面本來就印著％、
  //   學生不必再寫，降分等於製造新誤殺。字面數字本來就不同（「8%」vs「10」）則照常比。
  if (ref.percent !== stu.percent && ref.n * stu.d === stu.n * ref.d) return null
  if (ref.rel !== stu.rel) return 'differ'
  // 交叉相乘比實際數值（含百分比換算）；73/11 vs 83/11 不受浮點影響
  const [rn, rd] = [ref.n * (ref.percent ? 1 : 100), ref.d]
  const [sn, sd] = [stu.n * (stu.percent ? 1 : 100), stu.d]
  if (rn * sd === sn * rd) return 'equal'
  // 四捨五入放行：一邊是小數、差距在該小數位的半個單位內 → 視同相等（不製造新誤殺）
  const dec = ref.isDecimal || stu.isDecimal
  if (dec) {
    const places = Math.min(ref.isDecimal ? ref.places : Infinity, stu.isDecimal ? stu.places : Infinity)
    if (Number.isFinite(places) && Math.abs(value(ref) - value(stu)) <= 0.5 * 10 ** -places) return 'equal'
  }
  return 'differ'
}
