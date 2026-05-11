/**
 * BBox Single-Choice Anchor Match — with_questions 模式 single_choice 增益模組
 *
 * 跟 `bbox-anchor-match.js` (LCS+Dice) 平行存在、針對 single_choice 題型。
 * 跟 `bbox-cell-anchor-match.js` (answer_only) 同設計哲學：anchorHint 結構解析。
 *
 * 觀察 4 種 single_choice anchorHint 格式（多卷實證 2026-05-07）：
 *   - "位於第N小題題號前的括號內"
 *   - "位於題組(中文/數字)第N小題題號前的括號內"
 *   - "Part X 題號 N 旁的圓括號內" / "PartX 閱讀測驗 (N) 旁..."
 *   - "位於「(中文)、」後方，第 N 題的圓圈數字答案"
 *
 * Output schema 跟 buildAnchorCandidates 一致：
 *   { candidatesByQid: { qid → [{idx, text, bbox, score}] }, stats }
 *
 * 實證（5 份卷、平均 88% 配對）：
 *   - 社會考卷測試 100%
 *   - 社會領域期中考 93%
 *   - 社會期中考前小考 90%
 *   - 11402Midterm 英文 80%（雙欄 layout）
 *   - 期中評量試卷 79%
 */

// ── OCR 偵測題號 row 的 regex（從多卷觀察） ──
//   ()N.   ( )N。   (X)N.   (了)N.（OCR 誤讀）   2)N.   A)N.   )N.   N.   N、
const PATTERNS = [
  // 完整括號 (任意 0-5 字) N.
  { re: /^\s*[（(](?:[^）)]{0,5})[）)]\s*(\d{1,2})\s*[、。.]/, type: 'paren_full' },
  // 1 字 + 右括號 + N.（左括號被 OCR 吞、如「2)1.」「A)1.」）
  { re: /^\s*[\dA-Za-z]\s*[）)]\s*(\d{1,2})\s*[、。.]/, type: 'char_close_paren' },
  // 只剩右括號 + N.（如「)3.」、行頭縮排被 OCR 切丟）
  { re: /^\s*[）)]\s*(\d{1,2})\s*[、。.]/, type: 'close_paren_only' },
  // N、 或 N. 行首（純數字題號）
  { re: /^\s*(\d{1,2})\s*[、。.]/, type: 'plain' }
]

/**
 * 解 single_choice anchorHint。
 *
 * 新 prompt 強制格式：「位於『<section>』第 N 小題題號前的括號內」
 * 支援的 section 標題格式：
 *   - 題組X（X 為中文數字一二三...或阿拉伯數字）
 *   - 壹/貳/參/.../拾、XX 題（中文大寫數字 + 頓號）
 *   - 一/二/三、XX 題（中文小寫數字 + 頓號）
 *   - Part A/B/C...
 *   - Section 1/2/3...
 *
 * 也兼容舊 prompt 寫的 anchorHint 格式（無 『』 引號、或描述性文字）。
 *
 * @returns null | { groupKey, groupLabel, ordinal }
 */
export function parseSingleChoiceAnchorHint(hint) {
  if (!hint) return null
  const h = String(hint)

  // ── 先抽 ordinal（第N小題 / 第N題 / 題號N） ──
  const ordMatch = h.match(/第\s*(\d+)\s*小?題/) || h.match(/題號\s*(\d+)/)
  const ordinal = ordMatch ? +ordMatch[1] : null

  // ── 從 『...』 或 「...」 抽 section 標題 ──
  const secMatch = h.match(/『([^』]+)』/) || h.match(/「([^」]+)」/)
  if (secMatch && ordinal !== null) {
    const sec = secMatch[1].trim()
    const fromSection = parseSectionName(sec)
    if (fromSection) return { ...fromSection, ordinal }
  }

  // ── 兼容舊格式（沒引號包覆的 section 名）──
  // Part X 題號 N（容忍 PartX 無空白）
  let m = h.match(/Part\s*([A-Z])\b.*?(?:題號|閱讀測驗)?\s*\(?\s*(\d+)\s*\)?/i)
  if (m) return { groupKey: `Part_${m[1].toUpperCase()}`, groupLabel: `Part ${m[1].toUpperCase()}`, ordinal: +m[2] }

  // 題組(中文/數字)第N小題
  m = h.match(/[題题]組\s*([一二三四五六七八九十\d]+)\s*第\s*(\d+)\s*小?題/)
  if (m) return { groupKey: `題組${m[1]}`, groupLabel: `題組${m[1]}`, ordinal: +m[2] }

  // 第N小題沒 group prefix → return null（避免 default fallback 抓到錯誤的 row）
  // 舊版這裡 return 'default'、會被 main matcher 的 fallback 抓 OCR 第一個 group 的 row、
  // 容易 mis-match（如 1-1-x 配到題組二的 row）。改回 null 讓 read 走純視覺 classify。
  return null
}

/**
 * 解 section 名（從 anchorHint 的 『』 或 「」 內抽出）。
 * @returns null | { groupKey, groupLabel }
 */
function parseSectionName(sec) {
  // 題組X
  let m = sec.match(/^[題题]組\s*([一二三四五六七八九十\d]+)/)
  if (m) return { groupKey: `題組${m[1]}`, groupLabel: `題組${m[1]}` }

  // Part X
  m = sec.match(/^Part\s*([A-Z])/i)
  if (m) return { groupKey: `Part_${m[1].toUpperCase()}`, groupLabel: `Part ${m[1].toUpperCase()}` }

  // Section N
  m = sec.match(/^Section\s*(\d+)/i)
  if (m) return { groupKey: `Section_${m[1]}`, groupLabel: `Section ${m[1]}` }

  // 中文大寫數字 + 頓號：壹/貳/參/肆/伍/陸/柒/捌/玖/拾
  m = sec.match(/^([壹貳參肆伍陸柒捌玖拾]+)\s*[、，]/)
  if (m) return { groupKey: `cap_${m[1]}`, groupLabel: `${m[1]}、` }

  // 中文小寫數字 + 頓號：一/二/三...
  m = sec.match(/^([一二三四五六七八九十百]+)\s*[、，]/)
  if (m) return { groupKey: `chinese_${m[1]}`, groupLabel: `${m[1]}、` }

  return null
}

// ── 從 OCR detections 找含「題號」的 row ──
export function findQuestionNumberRows(detections) {
  const rows = []
  for (let i = 0; i < detections.length; i++) {
    const d = detections[i]
    const text = (d.rec_text || '').trim()
    for (const p of PATTERNS) {
      const m = text.match(p.re)
      if (m) {
        rows.push({
          idx: i,
          ordinal: +m[1],
          text,
          patternType: p.type,
          bbox: d.bbox,
          x_left: d.bbox[0], y_top: d.bbox[1],
          x_right: d.bbox[2], y_bot: d.bbox[3],
          y_center: (d.bbox[1] + d.bbox[3]) / 2,
          x_center: (d.bbox[0] + d.bbox[2]) / 2
        })
        break
      }
    }
  }
  return rows
}

// ── 偵測 group boundaries（雙欄 aware） ──
export function detectGroups(detections, imgW = 0) {
  const headerCandidates = []
  for (let i = 0; i < detections.length; i++) {
    const d = detections[i]
    const text = (d.rec_text || '').trim()
    let key = null, label = null
    // 題組X
    let m = text.match(/[題题]組\s*([一二三四五六七八九十\d]+)/)
    if (m) { key = `題組${m[1]}`; label = `題組${m[1]}` }
    // Part X
    if (!key) {
      m = text.match(/Part\s*([A-Z])\b/i)
      if (m) { key = `Part_${m[1].toUpperCase()}`; label = `Part ${m[1].toUpperCase()}` }
    }
    // Section N
    if (!key) {
      m = text.match(/Section\s*(\d+)/i)
      if (m) { key = `Section_${m[1]}`; label = `Section ${m[1]}` }
    }
    // 中文大寫數字 + 頓號（壹、貳、參…）
    if (!key) {
      m = text.match(/^\s*[（(]?\s*([壹貳參肆伍陸柒捌玖拾]+)\s*[、)）]/)
      if (m) { key = `cap_${m[1]}`; label = `${m[1]}、` }
    }
    // 中文小寫數字 + 頓號（一、二、三…）
    if (!key) {
      m = text.match(/^\s*[（(]?\s*([一二三四五六七八九十百])\s*[、)）]/)
      if (m) { key = `chinese_${m[1]}`; label = `${m[1]}、` }
    }
    if (key) {
      headerCandidates.push({
        key, label,
        y_top: d.bbox[1], y_bot: d.bbox[3],
        x_left: d.bbox[0], x_right: d.bbox[2],
        x_center: (d.bbox[0] + d.bbox[2]) / 2
      })
    }
  }
  // 同 key 取 y_top 最小
  const dedup = new Map()
  for (const h of headerCandidates) {
    if (!dedup.has(h.key) || h.y_top < dedup.get(h.key).y_top) dedup.set(h.key, h)
  }
  const headers = [...dedup.values()]
  const midX = imgW > 0 ? imgW / 2 : 0
  const left = midX > 0 ? headers.filter(h => h.x_center < midX) : []
  const right = midX > 0 ? headers.filter(h => h.x_center >= midX) : []
  const isMultiColumn = left.length > 0 && right.length > 0

  if (!isMultiColumn) {
    headers.sort((a, b) => a.y_top - b.y_top)
    for (let i = 0; i < headers.length; i++) {
      headers[i].y_start = headers[i].y_top
      headers[i].y_end = headers[i + 1]?.y_top ?? Infinity
      headers[i].column = null
    }
    return headers
  }
  const result = []
  for (const [arr, col] of [[left, 'L'], [right, 'R']]) {
    arr.sort((a, b) => a.y_top - b.y_top)
    for (let i = 0; i < arr.length; i++) {
      arr[i].y_start = arr[i].y_top
      arr[i].y_end = arr[i + 1]?.y_top ?? Infinity
      arr[i].column = col
    }
    result.push(...arr)
  }
  return result
}

function groupQuestionRows(questionRows, groups, imgW = 0) {
  if (groups.length === 0) {
    return new Map([['default', [...questionRows].sort((a, b) => a.y_top - b.y_top)]])
  }
  const map = new Map()
  for (const g of groups) map.set(g.key, [])
  const midX = imgW > 0 ? imgW / 2 : 0
  const isMultiColumn = groups.some(g => g.column === 'L') && groups.some(g => g.column === 'R')

  for (const r of questionRows) {
    const cy = r.y_center
    const cx = r.x_center
    const rowCol = isMultiColumn && midX > 0 ? (cx < midX ? 'L' : 'R') : null
    const g = groups.find(gg => {
      if (cy < gg.y_start || cy >= gg.y_end) return false
      if (gg.column !== null && rowCol !== null && gg.column !== rowCol) return false
      return true
    })
    if (g) map.get(g.key).push(r)
  }
  for (const arr of map.values()) arr.sort((a, b) => a.y_top - b.y_top)
  return map
}

/**
 * Main entry：對 answerKey single_choice questions 配 candidates。
 * Output schema 同 buildAnchorCandidates。
 */
export function buildSingleChoiceAnchorCandidates(answerKeyQuestions, ocrDetections, imageSize) {
  const [imgW, imgH] = imageSize || [1, 1]
  const result = {}
  const stats = {
    totalQuestions: 0,
    parsedCount: 0,
    matchedCount: 0,
    matchRate: 0,
    questionRowsFound: 0,
    groupsDetected: [],
    assignmentMethod: 'single_choice_structural'
  }
  if (!Array.isArray(answerKeyQuestions) || !Array.isArray(ocrDetections)) {
    return { candidatesByQid: {}, stats }
  }

  const scQuestions = answerKeyQuestions.filter(q => q?.questionCategory === 'single_choice')
  stats.totalQuestions = scQuestions.length
  if (scQuestions.length === 0) return { candidatesByQid: {}, stats }

  const questionRows = findQuestionNumberRows(ocrDetections)
  stats.questionRowsFound = questionRows.length

  const groups = detectGroups(ocrDetections, imgW)
  stats.groupsDetected = groups.map(g => ({ key: g.key, label: g.label, column: g.column }))

  const grouped = groupQuestionRows(questionRows, groups, imgW)

  for (const q of scQuestions) {
    const parsed = parseSingleChoiceAnchorHint(q.anchorHint)
    if (!parsed) continue
    stats.parsedCount++

    let groupRows = grouped.get(parsed.groupKey)
    if (!groupRows || groupRows.length === 0) {
      // Fallback：取第一組（topmost）
      const firstGroup = [...grouped.entries()].find(([_, rows]) => rows.length > 0)
      if (firstGroup) groupRows = firstGroup[1]
    }
    if (!groupRows || groupRows.length === 0) continue

    const row = groupRows.find(r => r.ordinal === parsed.ordinal)
    if (!row) continue

    result[q.id] = [{
      idx: row.idx,
      text: `q#${parsed.ordinal} (${parsed.groupLabel}): ${row.text.slice(0, 30)}`,
      bbox: row.bbox,
      score: 1.0
    }]
    stats.matchedCount++
  }

  stats.matchRate = stats.totalQuestions > 0 ? +(stats.matchedCount / stats.totalQuestions).toFixed(3) : 0
  return { candidatesByQid: result, stats }
}
