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

const SUB_CELL_TYPES = new Set(['multi_fill', 'fill_blank', 'fill_variants'])

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
 * Output schema 同 buildAnchorCandidates。
 */
export function buildSubCellAnchorCandidates(answerKeyQuestions, ocrDetections, imageSize) {
  const result = {}
  const stats = {
    totalCandidates: 0,
    parsedCount: 0,
    matchedCount: 0,
    matchRate: 0,
    assignmentMethod: 'sub_cell_anchor'
  }
  if (!Array.isArray(answerKeyQuestions) || !Array.isArray(ocrDetections)) {
    return { candidatesByQid: {}, stats }
  }

  const candidates = answerKeyQuestions.filter(q =>
    q?.questionCategory && SUB_CELL_TYPES.has(q.questionCategory) && q.anchorHint
  )
  stats.totalCandidates = candidates.length
  if (candidates.length === 0) return { candidatesByQid: {}, stats }

  for (const q of candidates) {
    const parsed = parseSubCellHint(q.anchorHint)
    if (!parsed) continue
    stats.parsedCount++

    const found = findSubCellRow(ocrDetections, parsed.subOrdinal, parsed.subLabel)
    if (!found) continue

    result[q.id] = [{
      idx: found.idx,
      text: `sub-cell (${parsed.sectionKey}/Q${parsed.parentOrdinal}/(${parsed.subOrdinal})${parsed.subLabel}): ${(found.det.rec_text || '').slice(0, 30)}`,
      bbox: found.det.bbox,
      score: found.score
    }]
    stats.matchedCount++
  }

  stats.matchRate = stats.totalCandidates > 0 ? +(stats.matchedCount / stats.totalCandidates).toFixed(3) : 0
  return { candidatesByQid: result, stats }
}
