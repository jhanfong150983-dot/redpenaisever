/**
 * BBox Sub-Cell Match — multi_fill 子格 anchor 增益模組
 *
 * 處理「(N)label 後方的底線/空格」格式的 multi_fill 子題：
 *   anchorHint 例：「位於『題組三』第1小題，(1)推力 後方的底線處」
 *
 * 觀察（社會 1 號 page 2）：
 *   一行三 sub-cell（推力/拉力/阻力）、PaddleOCR 分別偵測成 3 個獨立 row：
 *     (1)推力(...)：A，D   bbox=[70, 1474, 442, 1503]
 *     (2)拉力(...)：B，E   bbox=[495, 1471, 880, 1510]
 *     (3)阻力(...)：       bbox=[935, 1477, 1186, 1506]
 *   每個 row 含 label + 答題、bbox 寬度剛好涵蓋答題格。
 *
 * Matcher 流程：
 *   1. parseSubCellHint 抽出 (sectionKey, parentOrdinal, subOrdinal, subLabel)
 *   2. 在 OCR detections 找 text 含「(subOrdinal)subLabel」的 row
 *   3. 回傳該 row bbox 當 candidate
 *
 * downstream applyOcrBboxOverride 會 width_floor 把 classify bbox 拉到 OCR row 寬、
 * 涵蓋答題位置。
 *
 * 跟 bracket_gap / single_choice / cell_anchor / lcs 平行存在、output schema 一致。
 */

// 2026-05-19: 只對 multi_fill 開啟、fill_blank/fill_variants 維持 5/17 純 AI classify 決策。
// multi_fill 因為答案短（如 "A,D" 3 字）、AI 按字寬框 bbox 偏窄（~0.07）涵蓋不到完整答題格、
// OCR 找 (N)label 算出完整 cell bbox（label 到下一個 sibling 左緣）救援。
const SUB_CELL_TYPES = new Set(['multi_fill'])

const TRAD_TO_SIMP = {
  '彥':'彦','凱':'凯','對':'对','長':'长','說':'说','麼':'么','個':'个','幾':'几',
  '從':'从','處':'处','應':'应','會':'会','線':'线','寬':'宽','兩':'两','為':'为',
  '時':'时','與':'与','當':'当','裡':'里','裏':'里','辦':'办','夠':'够','單':'单',
  '雙':'双','舊':'旧','頭':'头','紅':'红','綠':'绿','藍':'蓝','黃':'黄','電':'电',
  '臺':'台','樣':'样','張':'张','車':'车','邊':'边','麗':'丽','學':'学','歡':'欢'
}

function normalize(s) {
  if (!s) return ''
  return String(s).split('').map(c => TRAD_TO_SIMP[c] || c).join('')
}

/**
 * 解 anchorHint。
 * @returns null | { sectionKey, parentOrdinal, subOrdinal, subLabel }
 */
export function parseSubCellHint(hint) {
  if (!hint) return null
  const h = String(hint)

  // section name from 『...』 or 「...」
  const secMatch = h.match(/『([^』]+)』/) || h.match(/「([^」]+)」/)
  if (!secMatch) return null
  const secName = secMatch[1].trim()

  let sectionKey = null
  let m = secName.match(/^[題题]組\s*([一二三四五六七八九十\d]+)/)
  if (m) sectionKey = `題組${m[1]}`
  if (!sectionKey) {
    m = secName.match(/^Part\s*([A-Z])/i)
    if (m) sectionKey = `Part_${m[1].toUpperCase()}`
  }
  if (!sectionKey) {
    m = secName.match(/^Section\s*(\d+)/i)
    if (m) sectionKey = `Section_${m[1]}`
  }
  if (!sectionKey) {
    m = secName.match(/^([壹貳參肆伍陸柒捌玖拾]+|[一二三四五六七八九十百]+)\s*[、，]/)
    if (m) sectionKey = `chinese_${m[1]}`
  }
  if (!sectionKey) return null

  // parent ordinal (第N小題 / 第N題)
  const parentMatch = h.match(/第\s*(\d+)\s*小?題/)
  if (!parentMatch) return null

  // sub-cell label: (subOrdinal)label
  const subMatch = h.match(/[（(]\s*(\d+)\s*[）)]\s*([一-龥]+)/)
  if (!subMatch) return null

  // 必須有位置關鍵字（確認是 sub-cell「X 後方」結構、不是其他奇怪 anchorHint）
  const hasPositionHint = /後方|右側|之後|底線|的線|下方|右邊|空格|空白/.test(h)
  if (!hasPositionHint) return null

  return {
    sectionKey,
    parentOrdinal: +parentMatch[1],
    subOrdinal: +subMatch[1],
    subLabel: subMatch[2]
  }
}

/**
 * 在 OCR detections 找含「(subOrdinal)subLabel」的 row。
 * 優先序：精準匹配 (subOrdinal + 完整 subLabel) > 寬鬆匹配 (只看 subLabel)
 */
function findSubCellRow(detections, subOrdinal, subLabel) {
  const labelNorm = normalize(subLabel)
  // 精準：text 含 (N) 或 （N） 後接完整 label（容忍簡繁差異）
  // 例：「(1)推力(讓人們...)：A,D」
  const exact = []
  const loose = []
  for (let i = 0; i < detections.length; i++) {
    const text = (detections[i].rec_text || '').trim()
    const textNorm = normalize(text)
    // 精準 pattern：[（(]N[）)]label
    const re = new RegExp(`[（(]\\s*${subOrdinal}\\s*[）)]\\s*${labelNorm}`)
    if (re.test(textNorm)) {
      exact.push({ idx: i, det: detections[i], score: 1.0 })
    } else if (textNorm.includes(labelNorm)) {
      loose.push({ idx: i, det: detections[i], score: 0.6 })
    }
  }
  if (exact.length > 0) return exact[0]
  if (loose.length > 0) return loose[0]
  return null
}

/**
 * Main entry：對 answerKey 含 sub-cell anchorHint 的 questions 配 candidates。
 *
 * 2026-05-19 修改：candidate bbox 從「label row only」擴成「完整 cell area」(label.x1 → next sibling label.x1)。
 * 之前只回 label row bbox、applyOcrBboxOverride width_floor 救得很有限；現在直接給完整 cell area、
 * applyOcrBboxOverride 一次性把 AI 窄 bbox union 到全 cell 寬。
 *
 * 邏輯：
 *   1. parse anchorHint → 每題 subOrdinal + subLabel
 *   2. 在 OCR detections 找 (subOrdinal)subLabel pattern 的 row
 *   3. 按 sectionKey + parentOrdinal 把同題的 siblings 分組
 *   4. 同組內按 subOrdinal 排序、用 y 中心相差 < 0.8 × rowH 判定「同 row」(橫向排列)
 *   5. cell bbox = [this.label.x1, next sibling.label.x1] (同 row)，最後一個用 imgW
 *   6. 非同 row（垂直排列、罕見）回退到 label row bbox
 *
 * Output schema 同 buildAnchorCandidates。
 */
export function buildSubCellAnchorCandidates(answerKeyQuestions, ocrDetections, imageSize) {
  const result = {}
  const stats = {
    totalCandidates: 0,
    parsedCount: 0,
    matchedCount: 0,
    matchRate: 0,
    assignmentMethod: 'sub_cell_anchor_cell_area'
  }
  if (!Array.isArray(answerKeyQuestions) || !Array.isArray(ocrDetections)) {
    return { candidatesByQid: {}, stats }
  }

  const candidates = answerKeyQuestions.filter(q =>
    q?.questionCategory && SUB_CELL_TYPES.has(q.questionCategory) && q.anchorHint
  )
  stats.totalCandidates = candidates.length
  if (candidates.length === 0) return { candidatesByQid: {}, stats }

  // 第一遍：parse + findRow、收集所有 matches
  const matches = []
  for (const q of candidates) {
    const parsed = parseSubCellHint(q.anchorHint)
    if (!parsed) continue
    stats.parsedCount++
    const found = findSubCellRow(ocrDetections, parsed.subOrdinal, parsed.subLabel)
    if (!found) continue
    matches.push({ q, parsed, row: found.det, score: found.score })
  }

  // 第二遍：按 sectionKey + parentOrdinal 分組
  const groups = new Map()
  for (const m of matches) {
    const groupKey = `${m.parsed.sectionKey}::${m.parsed.parentOrdinal}`
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push(m)
  }

  const [imgW] = imageSize || [1, 1]

  // 第三遍：每組算 cell bbox
  for (const group of groups.values()) {
    // 按 subOrdinal 排序
    group.sort((a, b) => a.parsed.subOrdinal - b.parsed.subOrdinal)

    for (let i = 0; i < group.length; i++) {
      const m = group[i]
      const nextM = group[i + 1]
      const labelY1 = m.row.bbox[1]
      const labelY2 = m.row.bbox[3]
      const rowH = labelY2 - labelY1
      const labelYCenter = (labelY1 + labelY2) / 2

      // 判斷下一個 sibling 是不是同 row (橫向)
      let sameRowAsNext = false
      if (nextM) {
        const nextYCenter = (nextM.row.bbox[1] + nextM.row.bbox[3]) / 2
        sameRowAsNext = Math.abs(labelYCenter - nextYCenter) < rowH * 0.8
      }

      // 算 cell bbox
      const cellX1 = m.row.bbox[0]
      let cellX2
      if (sameRowAsNext) {
        // 同 row：cell 到下一個 sibling 左緣（-1px 避免完全重疊）
        cellX2 = Math.max(cellX1 + 1, nextM.row.bbox[0] - 1)
      } else {
        // 不同 row 或最後一個 sibling：cell 延伸到 imgW
        cellX2 = imgW
      }

      result[m.q.id] = [{
        idx: 0,
        text: `cell (${m.parsed.sectionKey}/Q${m.parsed.parentOrdinal}/(${m.parsed.subOrdinal})${m.parsed.subLabel}): w=${cellX2 - cellX1}px`,
        bbox: [cellX1, labelY1, cellX2, labelY2],
        score: m.score
      }]
      stats.matchedCount++
    }
  }

  stats.matchRate = stats.totalCandidates > 0 ? +(stats.matchedCount / stats.totalCandidates).toFixed(3) : 0
  return { candidatesByQid: result, stats }
}
