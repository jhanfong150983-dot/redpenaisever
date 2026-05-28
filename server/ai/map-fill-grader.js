/**
 * Map-Fill Grader — Direction Y 評分 pipeline
 *
 * map_fill 題（地圖填圖題）的視覺評分模組。實驗 2026-05-28 證實：
 *   1. AnswerKey 看不到、AI 不會「acceptableAnswers 反推」幻覺
 *   2. 給「位置描述」清單當 anchor、AI 老實回每位置學生實際寫了什麼
 *   3. 程式碼比對 vs acceptableAnswers、deterministic 不幻覺
 *
 * 流程：
 *   Stage A: AnswerKey crop → AI 偵測每位置 {name, desc}
 *           （extract 階段跑一次、結果存進 question.positions）
 *   Stage B: 學生圖 + descs（不含 name）→ AI 回每位置 student_text
 *   Stage C: 程式比對 student_text vs positions[i].name → 分數
 *
 * 設計：純函式、無 HTTP、沒 dependencies on staged-grading 內部 state。
 * staged-grading.js 負責用 executeStage 包這支模組的 prompt + parse output。
 */

// ── Stage A: AnswerKey 位置偵測 prompt ──────────────────────────────────────
export function buildStageAPrompt(expectedNames) {
  const expected = Array.isArray(expectedNames) ? expectedNames : []
  return `這是一張**填圖題答案卷**：印刷地圖 + 老師印刷的紅字答案標籤（標出每個位置應該填的地名）。

任務：找出**所有**紅字標籤、對每個輸出 (name, location_desc)。

預期會看到約 ${expected.length} 個標籤。

【參考 hint】（已知會出現的地名、僅供比對拼字、不要漏未列出的）：
${expected.join('、')}

【輸出 JSON 格式（純 JSON、無 markdown）】
{
  "positions": [
    {
      "name": "摩洛哥",
      "desc": "地圖最左上方、臨地中海、阿爾及利亞以西"
    },
    {
      "name": "查德",
      "desc": "中央位置、尼日以東、中非以北"
    }
  ]
}

【desc 寫法】
- 用方位詞 + 相鄰關係：「左上方」「中央偏右」「東北角」「鄰 X」「X 以南」
- 描述要**夠精確**、讓人看另一張同一張地圖時能找到同位置
- 1-2 句、中文
- 不要直接寫名字（如「摩洛哥的位置」）、要寫地理特徵（「西北角、臨地中海」）

【重要】
- 列出**所有看到的紅字標籤**、不要漏
- 每個標籤一個 entry、不要合併
- 名字按你**實際看到的**列、不要從 hint 反推

只輸出 JSON。`
}

export function parseStageAResult(rawText) {
  if (!rawText || typeof rawText !== 'string') return null
  const clean = rawText.replace(/```json|```/g, '').trim()
  let parsed
  try { parsed = JSON.parse(clean) } catch { return null }
  if (!parsed || !Array.isArray(parsed.positions)) return null
  return parsed.positions
    .map((p) => ({
      name: String(p?.name ?? '').trim(),
      desc: String(p?.desc ?? '').trim()
    }))
    .filter((p) => p.name && p.desc)
}

// ── Stage B-AI2 (Review Reader): 給 names 當 verification hint、仿 buildReviewReadPrompt ──
// AI2 角色：知道每位置的標準名字、做 verification、但仍只能回實看到的內容
//
// 對應 buildReviewReadPrompt（其他題型用）的設計：
// - 提供標準答案作 hint
// - 看到不同時「再仔細看一次」、確認不是漏讀
// - 真的看不到 → blank、不可從 hint 反推
export function buildStageBReviewPrompt(positions) {
  const arr = Array.isArray(positions) ? positions : []
  const list = arr.map((p, i) => `  ${i + 1}. 位置：${p.desc}（正確答案：${p.name}）`).join('\n')
  return `== ROLE: 校對審查員 (Review Reader for map_fill) ==
你是校對審查員。你會看到一份**地圖填圖題的學生作頁**、以及一張位置清單（含每位置的標準答案）。

你的任務跟客觀抄寫員一樣：對**每個位置描述**、看圖找到對應位置、回傳該位置**學生實際手寫的內容**。
**標準答案只是 verification hint、絕對不是你的答案**。

【位置清單（共 ${arr.length} 個）】
${list}

【如何使用「正確答案」hint】
- 用它做 verification：你先讀、再對照、如果你讀到的跟正確答案不同、就**再仔細看一遍**該位置、確認你沒有漏讀任何小字、淺色、邊緣的筆跡
- 如果再仔細看完還是讀到不同內容 → 回**你看到的**（學生可能真的寫錯了）
- 如果學生那位置真的沒寫東西 → student_text = ""、**不可從正確答案反推**

【嚴格規則】
- 你輸出的必須是學生**實際寫的**、不是正確答案
- 學生沒寫東西 → student_text = ""
- 看不清楚 → student_text = "?"
- 即使你「知道」標準答案、看不到就是看不到、不要 echo 正確答案

【輸出 JSON 格式（純 JSON、無 markdown）】
{
  "readings": [
    { "position_idx": 1, "student_text": "中國" },
    { "position_idx": 2, "student_text": "" }
  ]
}

position_idx 對應上面清單編號（1-based）。只輸出 JSON。`
}

// ── Stage B: 學生卷位置讀取 prompt ──────────────────────────────────────────
export function buildStageBPrompt(descs) {
  const arr = Array.isArray(descs) ? descs : []
  const descList = arr.map((d, i) => `  ${i + 1}. ${d}`).join('\n')
  return `這是一份**地圖填圖題的學生作頁**：學生在地圖上的不同位置手寫了地名（中文）。

你會收到一個「位置描述清單」、每個描述對應地圖上一個特定位置（共 ${arr.length} 個位置）。

【位置清單】
${descList}

任務：對**每個位置描述**、看圖找到對應位置、回傳該位置**學生手寫的內容**。

【重要規則】
- 認真看圖、辨識學生實際手寫的字
- 嚴禁猜測、嚴禁腦補
- 學生沒寫東西 → student_text = ""（空字串）
- 看不清楚 → student_text = "?"
- 不要管學生寫得對不對、只負責「學生實際寫了什麼」
- **不告訴你標準答案**、純粹老實列學生筆跡

【輸出 JSON 格式（純 JSON、無 markdown）】
{
  "readings": [
    { "position_idx": 1, "student_text": "中國" },
    { "position_idx": 2, "student_text": "" },
    { "position_idx": 3, "student_text": "?" }
  ]
}

position_idx 對應上面清單編號（1-based）。如果學生寫得很潦草、依字形猜最接近的字、但維持「謹慎」原則（猜不出來 → "?"）。

只輸出 JSON。`
}

export function parseStageBResult(rawText, expectedCount) {
  if (!rawText || typeof rawText !== 'string') return null
  const clean = rawText.replace(/```json|```/g, '').trim()
  let parsed
  try { parsed = JSON.parse(clean) } catch { return null }
  if (!parsed || !Array.isArray(parsed.readings)) return null
  const map = new Map()
  for (const r of parsed.readings) {
    const idx = Number(r?.position_idx)
    if (!Number.isFinite(idx) || idx < 1) continue
    map.set(idx, String(r?.student_text ?? ''))
  }
  // 補齊缺失的 position_idx 為空字串、保證 length === expectedCount
  const result = []
  for (let i = 1; i <= expectedCount; i++) {
    result.push({ position_idx: i, student_text: map.has(i) ? map.get(i) : '' })
  }
  return result
}

// ── Stage C: deterministic 比對 ─────────────────────────────────────────────
// positions: [{name, desc}]
// readings: [{position_idx, student_text}]
// acceptableAnswers: string[]
// 回傳：{ score, maxScore, isCorrect, perPosResults, scoringReason, studentFinalAnswer }
//
// 評分規則（user 2026-05-28 確認）：
//   1 分/位置、maxScore = positions.length
//   - student === "" → blank、0 分
//   - student === "?" → unclear、0 分
//   - student === positions[i].name → correct、+1 分
//   - acceptableAnswers includes student → correct（同義變體、+1 分）
//   - 其他 → wrong、0 分
export function gradeMapFillDeterministically(positions, readings, acceptableAnswers) {
  const posArr = Array.isArray(positions) ? positions : []
  const readingArr = Array.isArray(readings) ? readings : []
  const readingByIdx = new Map(readingArr.map((r) => [r.position_idx, r.student_text || '']))
  const acceptableSet = new Set(Array.isArray(acceptableAnswers) ? acceptableAnswers : [])

  const perPosResults = []
  let correct = 0
  let wrong = 0
  let blank = 0
  let unclear = 0

  for (let i = 0; i < posArr.length; i++) {
    const idx = i + 1
    const refName = posArr[i].name
    const studentText = String(readingByIdx.get(idx) || '').trim()
    let status
    if (!studentText) { status = 'blank'; blank++ }
    else if (studentText === '?') { status = 'unclear'; unclear++ }
    else if (studentText === refName || acceptableSet.has(studentText)) { status = 'correct'; correct++ }
    else { status = 'wrong'; wrong++ }
    perPosResults.push({
      idx,
      position: refName,
      student: studentText,
      status,
      desc: posArr[i].desc || ''
    })
  }

  const maxScore = posArr.length
  const score = correct
  const isCorrect = score === maxScore && maxScore > 0

  // scoringReason：列出每個錯/漏的位置（user 2026-05-28 確認要寫出來）
  const scoringReason = buildScoringReason({ correct, wrong, blank, unclear, perPosResults, maxScore })

  // studentFinalAnswer：列出學生實際寫到的內容（給前端顯示用）
  const studentFinalAnswer = perPosResults
    .filter((r) => r.student && r.student !== '?')
    .map((r) => r.student)
    .join(', ')

  return {
    score,
    maxScore,
    isCorrect,
    perPosResults,
    scoringReason,
    studentFinalAnswer,
    summary: { correct, wrong, blank, unclear }
  }
}

function buildScoringReason({ correct, wrong, blank, unclear, perPosResults, maxScore }) {
  if (maxScore === 0) return '無位置可評（AnswerKey 無 positions）'
  if (correct === maxScore) return `全部 ${maxScore} 個位置答對。`

  const lines = [`答對 ${correct}/${maxScore} 個位置。`]

  // 列出錯的
  const wrongs = perPosResults.filter((r) => r.status === 'wrong')
  if (wrongs.length > 0) {
    lines.push(`【答錯 ${wrongs.length} 題】`)
    for (const w of wrongs) {
      lines.push(`  ・「${w.position}」位置：學生寫「${w.student}」、應為「${w.position}」`)
    }
  }

  // 列出漏寫的
  const blanks = perPosResults.filter((r) => r.status === 'blank')
  if (blanks.length > 0) {
    const names = blanks.map((b) => b.position).join('、')
    lines.push(`【漏寫 ${blanks.length} 題】${names}`)
  }

  // 列出辨識不清的
  const unclears = perPosResults.filter((r) => r.status === 'unclear')
  if (unclears.length > 0) {
    const names = unclears.map((u) => u.position).join('、')
    lines.push(`【看不清 ${unclears.length} 題、需老師複核】${names}`)
  }

  return lines.join('\n')
}
