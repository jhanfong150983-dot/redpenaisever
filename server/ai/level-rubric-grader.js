/**
 * 級分制判分（數學應用題）。對應 client 端 src/lib/levelRubric.ts 的規則引擎——**須同步**。
 *
 * 設計（沙盒 21 份會考公告樣卷 × 5 輪 × 三判官驗證：一致率 21/21、放水 0、級分零跳動）：
 *   ・判官**只回報「哪些要素有出現」，不給分、不判級分**
 *   ・級分由 code 依答案卷上的 levelRules 算 → 再依 levels[].score 換成分數
 *   ・三位判官「檢查流程不同」（照抄注音三判官 v2 的精神；同一 prompt 跑三次只會複製同一個偏誤）
 *   ・多數決定案；任一要素出現 2:1 分歧 → 標低信心交老師（分歧不消滅、只標示）
 *
 * 為什麼級分不讓 AI 判：實測同一份卷、要素完全相同時 AI 仍會判出不同級分
 * （q1_L1_s3 在 2/1 之間跳），那就是「同樣寫法不同分」的來源。
 * 反過來，級分規則寫在 code 就能逐條對照官方指引審查——沙盒期間就靠這個抓到我自己寫的兩條
 * 偏誤（一條放水「答案對就給二級」、一條誤殺「第一小題錯就不能到二級」）。
 */

/** 三位判官：**任務不同**，不是同一段 prompt 跑三次 */
export const LEVEL_JUDGE_TASKS = {
  A: ['逐項檢核', '依序檢查下方每一條必要要素，逐條說明「在學生作答的哪個位置看到／完全找不到」。'],
  B: ['先讀後對', '先把學生寫的每一行依序摘要出來（不要評價），列完之後再回頭對照要素清單，逐條標記有無。'],
  C: ['找缺口', '假設這份作答是滿分，你的任務是**挑毛病**：找出要素清單中「學生沒有做到」的項目。沒把握的一律當作有做到（寧可放過，不要誤指）。'],
}

export function buildLevelJudgePrompt(rubric, judge, questionHint = '', splitImages = false) {
  const [name, task] = LEVEL_JUDGE_TASKS[judge] || LEVEL_JUDGE_TASKS.A
  const els = (rubric?.requiredElements || [])
    .map((e) => `  - ${e.key}：${e.desc}`).join('\n')
  let groups = ''
  for (const g of rubric?.alternativeGroups || []) {
    groups += `\n  ◆ 替代組 ${g.key}｜${g.desc}（任一即可；滿足時把所選的 key 也寫進 elements_found）：`
    for (const o of g.options || []) groups += `\n      - ${o.key}：${o.desc}`
  }
  const flaws = (rubric?.toleratedFlaws || []).map((f) => `  - ${f}`).join('\n') || '  （無）'
  const splitNote = splitImages
    ? '\n⚠️ 你會收到【左半】【右半】兩張圖，那是**同一題作答區的左右兩半**（中間有重疊）。'
      + '學生常左欄寫一段、右欄寫另一段，**兩張都要看完再判斷**，不要只依其中一張下結論。\n'
    : ''
  return `你是數學非選擇題的閱卷老師之一（本題共三位老師各自獨立檢查，最後投票）。
你這一位的檢查方式是【${name}】：${task}${splitNote}
${questionHint ? `\n【題目】${questionHint}\n` : ''}
【必要解題要素】
${els}${groups}

【容許的瑕疵】（出現這些不算缺陷）
${flaws}

【判斷原則】
0. ⭐ **先把整張圖掃過一遍再判斷**。學生的作答常常分散在多處：左欄寫一段、右欄寫另一段、
   下方補算一段都很常見。**不要只看左半邊或最上面幾行**——實測有學生右半邊寫了完整的
   門檻計算與比較，判官只讀左欄就回報「什麼都沒有」。
   ⛔ **「#」（井字號）不是劃掉**。台灣數學作答慣例：在答案右邊寫「#」表示「此即為答案／到此結束」，
      形狀是兩橫兩豎交叉、常寫得歪斜，看起來像 ✗✗ 或 ##。**看到它要把該行當成有效答案，不是塗改。**
      真正的塗改是「線條穿過文字本身」；寫在文字**右側或後方**的記號一律不是塗改。
      同理，答案下方的**底線**、旁邊的圈選、箭頭都是強調，不是刪除。
      只有確認整段被線畫過才不採計；而且被畫掉處旁邊常常就是重寫的正確版本，要繼續往下看。
1. 你只負責回報「每一條要素學生有沒有呈現」，**不要給分、不要決定級分**（級分由系統依要素計算）。
2. 等值寫法一律算呈現：同一個值的不同算式、不同命名、不同排列順序都算。
3. 但要素敘述中標了「⛔」的情況，明確不算呈現。
4. 手寫可能潦草；辨識不確定時填進 uncertain，不要為了給分假設看不到的內容。
5. 承錯不重複扣：中間值算錯但後續方法正確，後續要素仍算呈現。
6. ⛔ **要素指定了特定的值或結論時，學生寫成不同或相反的內容一律算「未呈現」**。
   例：要素要求結論為「否／不通過」，學生寫「通過」→ 未呈現（不是「有寫結論就算」）。
   例：要素要求「x ≥ 20000000 × 1/4」，學生寫「x ≥ 6700000 × 1/4」（總數用錯）→ 未呈現。
   判斷的是「有沒有寫對」，不是「有沒有寫」。

【輸出】只輸出一個 JSON 物件，不要加說明或程式碼框：
{
  "checks": [{ "key": "要素 key", "present": true/false, "evidence": "在哪看到／為何判定沒有（20字內）" }],
  "elements_found": ["present 為 true 的 key，含所選替代組 option key"],
  "uncertain": "辨識或判斷上不確定的地方；沒有就填空字串"
}`
}

export function parseLevelJudgeResult(text) {
  if (!text) return null
  const cleaned = String(text).replace(/```json|```/g, '').trim()
  let obj = null
  try {
    obj = JSON.parse(cleaned)
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { obj = JSON.parse(m[0]) } catch { return null }
  }
  if (!obj || !Array.isArray(obj.elements_found)) return null
  return {
    found: obj.elements_found.map((x) => String(x ?? '').trim()).filter(Boolean),
    uncertain: String(obj.uncertain ?? '').trim(),
    checks: Array.isArray(obj.checks) ? obj.checks : [],
  }
}

/** 依 levelRules 由高到低比對，第一條成立者即為該級分；沒有規則 → null（呼叫端自行 fallback） */
export function levelFromElements(rubric, found) {
  const rules = rubric?.levelRules
  if (!Array.isArray(rules) || rules.length === 0) return null
  const has = new Set(found || [])
  const groups = rubric?.alternativeGroups || []
  const groupOk = (key) => {
    const g = groups.find((x) => x.key === key)
    return !!g && (g.options || []).some((o) => has.has(o.key))
  }
  const ks = (v) => (Array.isArray(v) ? v.map((x) => String(x ?? '')).filter(Boolean) : [])
  for (const r of [...rules].sort((a, b) => Number(b.level) - Number(a.level))) {
    if (ks(r.requireAll).some((k) => !has.has(k))) continue
    if (ks(r.requireAny).length > 0 && !ks(r.requireAny).some((k) => has.has(k))) continue
    if (ks(r.requireGroups).some((k) => !groupOk(k))) continue
    if (ks(r.requireAnyGroup).length > 0 && !ks(r.requireAnyGroup).some(groupOk)) continue
    return Number(r.level)
  }
  return 0
}

/**
 * 三判官投票 → 級分 → 分數。
 * votes = [{judge:'A', found:[...]}, ...]（失敗的判官先濾掉再傳進來）
 */
export function aggregateLevelVotes(rubric, votes, maxScore) {
  const valid = (votes || []).filter((v) => v && Array.isArray(v.found))
  const allKeys = [
    ...(rubric?.requiredElements || []).map((e) => e.key),
    ...(rubric?.alternativeGroups || []).flatMap((g) => (g.options || []).map((o) => o.key)),
  ]
  const found = []
  const split = []
  for (const k of allKeys) {
    const n = valid.filter((v) => v.found.includes(k)).length
    if (n * 2 > valid.length) found.push(k)
    if (n > 0 && n < valid.length) split.push(k)   // 判官意見不一致的要素
  }
  const level = levelFromElements(rubric, found)
  const lv = (rubric?.levels || []).find((l) => Number(l.level) === level)
  // 分數以答案卷上老師確認過的 levels[].score 為準；缺就依比例回推（不猜、只保底）
  const ratio = { 3: 1, 2: 0.65, 1: 0.3, 0: 0 }[level] ?? 0
  const score = typeof lv?.score === 'number' ? lv.score : Math.round(maxScore * ratio * 2) / 2

  // 信心：分歧要看「會不會改變級分」，不是所有 2:1 都同等嚴重。
  //   把分歧要素全算有／全算沒有各跑一次，級分會變 → 這份的等第本身不確定 → 低信心送審（45）；
  //   級分不變 → 只是雜訊、照多數採用但標一點雜音（75）。
  //   ⚠️ UI 的低信心紅底與複核面板看的是 systemConfidence < 70，所以「要送審」必須 <70。
  const lvOptimistic = levelFromElements(rubric, [...found, ...split])
  const lvPessimistic = levelFromElements(rubric, found.filter((k) => !split.includes(k)))
  const levelUnstable = split.length > 0 && (lvOptimistic !== level || lvPessimistic !== level)
  let confidence = 97
  if (valid.length === 0) confidence = 0
  else if (valid.length < 3) confidence = 65          // 判官失敗、票數不足 → 送審
  else if (levelUnstable) confidence = 45             // 分歧會改變等第 → 送審
  else if (split.length > 0) confidence = 75          // 分歧不影響等第 → 只標雜音
  // 理由要寫「缺了哪一項」而不是只寫幾分之幾——老師檢討與學生申訴時看的就是這句。
  // 要素敘述含 ⛔ 條款（給判官看的），對老師是雜訊，去掉；過長截斷。
  // 老師要看的是「缺哪一步」，不是完整規準原文。
  // 早期直接砍到 24 字，結果砍掉的正好是最關鍵的具體值（「第(3)小題：正確列出一元一次不等式「x ≥ 2…」）。
  // 改成抽取「小題標記」＋「」裡的具體值，丟掉中間的贅述。
  const label = (key) => {
    const e = (rubric?.requiredElements || []).find((x) => x.key === key)
      || (rubric?.alternativeGroups || []).flatMap((g) => g.options || []).find((o) => o.key === key)
    const raw = String(e?.desc ?? key).split('⛔')[0].trim()
    // 小題標記：取到第一個冒號為止（例：「第(4)小題條件(3)檢驗」）
    const headMatch = raw.match(/^【?[^：:]{0,20}小題[^：:]{0,10}/)
    const head = headMatch ? headMatch[0].replace(/^【/, '').trim() : ''
    // 具體值：「」裡的內容，最多取 3 個（例：否／不通過／未通過）
    const quoted = [...raw.matchAll(/「([^」]{1,40})」/g)].map((m) => m[1]).slice(0, 3)
    if (quoted.length > 0) return head ? `${head}：${quoted.join('／')}` : quoted.join('／')
    const rest = head ? raw.slice(head.length).replace(/^[：:]\s*/, '') : raw
    const body = rest.length > 34 ? `${rest.slice(0, 34)}…` : rest
    return head ? `${head}：${body}` : body
  }
  const missing = allKeys.filter((k) => !found.includes(k)
    // 替代組只要中一個就算滿足，未中的另一條不算「缺」
    && !(rubric?.alternativeGroups || []).some((g) => (g.options || []).some((o) => o.key === k)
      && (g.options || []).some((o) => found.includes(o.key))))
  // 逐要素明細由 UI 羅列（✓／✗／？），理由只寫「幾項做到、缺哪幾步」的摘要——
  // 兩邊都寫整份清單會變成重複的長句，反而難讀。
  const parts = [`${found.length}/${allKeys.length} 項要素呈現`]
  if (missing.length > 0) parts.push(`缺：${missing.map(label).join('、')}`)
  if (split.length > 0) {
    parts.push(levelUnstable
      ? `${split.length} 項判官意見不一致，且會影響等第，請老師複核`
      : `${split.length} 項判官意見不一致（不影響等第）`)
  }
  if (valid.length < 3) parts.push(`僅 ${valid.length} 位判官回覆`)

  return {
    level, score, found, split, missing, confidence,
    voteCount: valid.length,
    reason: level == null
      ? '答案卷缺少等第判定規則'
      : `${['零', '一', '二', '三'][level]}級分（${parts.join('；')}）`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-08-14 逐要素提問（user 拍板「1 crop 1 讀」，品質優先）
//
// 為什麼改：會考型應用題給學生一個大格子自由書寫、沒有 (1)(2) 小標。
//   一次把整份規準丟給 AI，它會退化成「掃描找小標比對清單」，寬圖右半、非線性排版就漏。
//   閱卷老師的實際做法是「拿一條標準搜整張卷，再換下一條」——照這個方式問就對了。
//
// 沙盒實測（21 份會考公告樣卷、同一份 v5 規準、級分都由 code 算，唯一變數是一次問幾條）：
//   整份規準 19/21 = 90%（一件放水、一件誤殺）
//   逐要素   21/21 = 100%   ← 兩個方向的錯都修正
// 因此逐要素只用**單一判官**，不再疊三票（三票是為了壓整份規準的不穩，逐要素本身就穩）。
//
// 代價：呼叫數 1 → 要素數。實測每次呼叫成本幾乎固定（圖片是主體、prompt 長短影響很小），
//   所以成本≈呼叫數；user 拍板品質優先。
// 失去的分歧偵測改用判官自己回報的 uncertain——比投票更精準，直接指出是哪一條沒把握。
// ─────────────────────────────────────────────────────────────────────────────

/** 一次只問一條要素。刻意不列出其他要素——列了它又會回到掃描清單的模式。 */
export function buildElementQuestionPrompt(rubric, element, splitImages = false) {
  const flaws = (rubric?.toleratedFlaws || []).map((f) => `  - ${f}`).join('\n') || '  （無）'
  const splitNote = splitImages
    ? '\n⚠️ 你會收到【左半】【右半】兩張圖，那是同一題作答區的左右兩半（中間有重疊），兩張都要看完。\n'
    : ''
  return `你是數學非選擇題的閱卷老師。這是一位學生的整題作答——可能寫得零散：
左欄一段、右欄一段、下方補算、順序顛倒都有可能，也不一定標 (1)(2)。${splitNote}
【你這一次只需要回答一個問題】
學生的作答裡，**有沒有出現下面這一項**？

  ${element?.desc ?? ''}

【怎麼判斷】
1. 把整張圖從頭到尾看過，包含左右兩側與下方。不要只看最上面幾行或左半邊。
2. 等值寫法一律算呈現：同一個值的不同算式、不同命名、不同排列順序都算。
3. 上面若標了「⛔」，那些情況明確不算呈現。
4. 判斷的是「**有沒有寫對**」，不是「有沒有寫」——寫成不同或相反的值算未呈現。
   例：要求結論「否」，學生寫「通過」→ 未呈現。
5. 「#」（井字號）是台灣數學作答慣例，寫在答案右邊表示「此即為答案」，**不是劃掉**；
   底線、圈選、箭頭同屬強調。真正的塗改是線條穿過文字本身。
6. 看不清楚就據實填 uncertain，不要為了給分假設看不到的內容。

【容許的瑕疵】（出現這些不影響本項判定）
${flaws}

只輸出 JSON：{{"present": true/false, "evidence": "在圖的哪個位置看到／為何判定沒有（25字內）", "uncertain": "沒把握的地方；沒有就填空字串"}}`
}

export function parseElementAnswer(text) {
  if (!text) return null
  const cleaned = String(text).replace(/```json|```/g, '').trim()
  let obj = null
  try {
    obj = JSON.parse(cleaned)
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (!m) return null
    try { obj = JSON.parse(m[0]) } catch { return null }
  }
  if (!obj || typeof obj.present !== 'boolean') return null
  return {
    present: obj.present,
    evidence: String(obj.evidence ?? '').trim(),
    uncertain: String(obj.uncertain ?? '').trim(),
  }
}

/**
 * 逐要素答案 → 級分 → 分數。
 * answers = [{ key, present, evidence, uncertain }]；取不到答案的要素請省略（會視為未呈現並降信心）。
 */
export function aggregateElementAnswers(rubric, answers, maxScore) {
  const allKeys = [
    ...(rubric?.requiredElements || []).map((e) => e.key),
    ...(rubric?.alternativeGroups || []).flatMap((g) => (g.options || []).map((o) => o.key)),
  ]
  const byKey = new Map((answers || []).filter((a) => a && a.key).map((a) => [a.key, a]))
  const found = allKeys.filter((k) => byKey.get(k)?.present === true)
  const missingAnswer = allKeys.filter((k) => !byKey.has(k))
  const unsure = allKeys.filter((k) => (byKey.get(k)?.uncertain || '').length > 0)

  const level = levelFromElements(rubric, found)
  const lv = (rubric?.levels || []).find((l) => Number(l.level) === level)
  const ratio = { 3: 1, 2: 0.65, 1: 0.3, 0: 0 }[level] ?? 0
  const score = typeof lv?.score === 'number' ? lv.score : Math.round(maxScore * ratio * 2) / 2

  // 信心：判官自己說沒把握的要素，若翻面會改變等第 → 這份的等第不可靠 → 送審。
  //   ⚠️ UI 的紅底與複核面板看 systemConfidence < 70，所以「要送審」必須 <70。
  const flip = (k) => (found.includes(k) ? found.filter((x) => x !== k) : [...found, k])
  const unsureMatters = unsure.some((k) => levelFromElements(rubric, flip(k)) !== level)
  let confidence = 97
  if (allKeys.length > 0 && byKey.size === 0) confidence = 0
  else if (missingAnswer.length > 0) confidence = 65
  else if (unsureMatters) confidence = 45
  else if (unsure.length > 0) confidence = 75

  const label = (key) => {
    const e = (rubric?.requiredElements || []).find((x) => x.key === key)
      || (rubric?.alternativeGroups || []).flatMap((g) => g.options || []).find((o) => o.key === key)
    const raw = String(e?.desc ?? key).split('⛔')[0].trim()
    const headMatch = raw.match(/^【?[^：:]{0,20}小題[^：:]{0,10}/)
    const head = headMatch ? headMatch[0].replace(/^【/, '').trim() : ''
    const quoted = [...raw.matchAll(/「([^」]{1,40})」/g)].map((m) => m[1]).slice(0, 3)
    if (quoted.length > 0) return head ? `${head}：${quoted.join('／')}` : quoted.join('／')
    const rest = head ? raw.slice(head.length).replace(/^[：:]\s*/, '') : raw
    const body = rest.length > 34 ? `${rest.slice(0, 34)}…` : rest
    return head ? `${head}：${body}` : body
  }
  // 替代組只要中一個就算滿足，未中的另一條不算「缺」
  const missing = allKeys.filter((k) => !found.includes(k)
    && !(rubric?.alternativeGroups || []).some((g) => (g.options || []).some((o) => o.key === k)
      && (g.options || []).some((o) => found.includes(o.key))))
  const parts = [`${found.length}/${allKeys.length} 項要素呈現`]
  if (missing.length > 0) parts.push(`缺：${missing.map(label).join('、')}`)
  if (unsure.length > 0) {
    parts.push(unsureMatters
      ? `${unsure.length} 項判讀沒把握，且會影響等第，請老師複核`
      : `${unsure.length} 項判讀沒把握（不影響等第）`)
  }
  if (missingAnswer.length > 0) parts.push(`${missingAnswer.length} 項未能判讀，請老師複核`)

  return {
    level, score, found, unsure, missingAnswer, confidence,
    evidence: allKeys.map((k) => ({ key: k, ...(byKey.get(k) || { present: false }) })),
    reason: level == null
      ? '答案卷缺少等第判定規則'
      : `${['零', '一', '二', '三'][level]}級分（${parts.join('；')}）`,
  }
}
