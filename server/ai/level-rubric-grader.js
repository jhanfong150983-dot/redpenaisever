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

export function buildLevelJudgePrompt(rubric, judge, questionHint = '') {
  const [name, task] = LEVEL_JUDGE_TASKS[judge] || LEVEL_JUDGE_TASKS.A
  const els = (rubric?.requiredElements || [])
    .map((e) => `  - ${e.key}：${e.desc}`).join('\n')
  let groups = ''
  for (const g of rubric?.alternativeGroups || []) {
    groups += `\n  ◆ 替代組 ${g.key}｜${g.desc}（任一即可；滿足時把所選的 key 也寫進 elements_found）：`
    for (const o of g.options || []) groups += `\n      - ${o.key}：${o.desc}`
  }
  const flaws = (rubric?.toleratedFlaws || []).map((f) => `  - ${f}`).join('\n') || '  （無）'
  return `你是數學非選擇題的閱卷老師之一（本題共三位老師各自獨立檢查，最後投票）。
你這一位的檢查方式是【${name}】：${task}
${questionHint ? `\n【題目】${questionHint}\n` : ''}
【必要解題要素】
${els}${groups}

【容許的瑕疵】（出現這些不算缺陷）
${flaws}

【判斷原則】
0. ⭐ **先把整張圖掃過一遍再判斷**。學生的作答常常分散在多處：左欄寫一段、右欄寫另一段、
   下方補算一段都很常見。**不要只看左半邊或最上面幾行**——實測有學生右半邊寫了完整的
   門檻計算與比較，判官只讀左欄就回報「什麼都沒有」。
   若學生把某段**劃掉**，那一段不採計；但劃掉的旁邊常常就是他重寫的正確版本，要繼續往下看。
1. 你只負責回報「每一條要素學生有沒有呈現」，**不要給分、不要決定級分**（級分由系統依要素計算）。
2. 等值寫法一律算呈現：同一個值的不同算式、不同命名、不同排列順序都算。
3. 但要素敘述中標了「⛔」的情況，明確不算呈現。
4. 手寫可能潦草；辨識不確定時填進 uncertain，不要為了給分假設看不到的內容。
5. 承錯不重複扣：中間值算錯但後續方法正確，後續要素仍算呈現。

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

  // 信心：對齊注音三判官——全票一致高、2:1 有雜音、判官全失敗送審
  let confidence = 97
  if (valid.length === 0) confidence = 0
  else if (valid.length < 3) confidence = 70          // 有判官失敗、票數不足
  else if (split.length > 0) confidence = 75          // 要素有 2:1 分歧
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
  const parts = []
  if (missing.length === 0) parts.push(`${allKeys.length} 項要素全數呈現`)
  else parts.push(`未呈現：${missing.map(label).join('；')}`)
  if (split.length > 0) parts.push(`「${split.map(label).join('」「')}」判官意見不一致，建議複核`)
  if (valid.length < 3) parts.push(`僅 ${valid.length} 位判官回覆`)

  return {
    level, score, found, split, missing, confidence,
    voteCount: valid.length,
    reason: level == null
      ? '答案卷缺少等第判定規則'
      : `${['零', '一', '二', '三'][level]}級分（${parts.join('；')}）`,
  }
}
