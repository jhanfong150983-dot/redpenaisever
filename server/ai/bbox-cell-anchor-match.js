/**
 * BBox Cell Anchor Match — Phase A classify 增益模組（answer_only 專用）
 *
 * 跟 `bbox-anchor-match.js` 平行存在、output schema 一致：
 *   { candidatesByQid: { qid → [{ idx, text, bbox, score }] }, stats }
 *
 * 演算法（跟既有 LCS+Dice 不同）：
 *   1. anchorHint regex 抽 (sectionName, cellOrdinal | parent+sub)
 *      格式：「位於『一、單選題』表格第 N 格」「位於『三、非選題』第 N 大題的子格 (M)」
 *   2. OCR 偵測 section header（^[一二三四五六]、）→ 各 section 的 y 範圍
 *   3. section y 範圍內找短數字字元（1~2 位、容忍 OCR 誤讀如「9」→「g」）
 *   4. 取 y 最上方一行當「印刷編號 row」、依 x 排序
 *   5. cell x 邊界 = 相鄰 anchor 中點；首末格用 typical_w/2 buffer
 *   6. sub-cell parent 偵測：anchorHint 含「子格 (M)」→ expand parent 為 sub_count × sibling_median
 *
 * 為什麼這策略適合 answer_only：
 *   - answer_only 的 anchorHint 是純結構描述、沒可配對的具體文字 → LCS 失敗
 *   - 但 anchorHint 已經結構化、適合 regex
 *   - OCR 偵測印刷編號 row 直接給「真實 cell anchor x」、不需 frontend 等距外推
 *
 * 實證（2026-05-07 物理畢業考 29 題）：
 *   - 29/29 配對成功
 *   - Section 1 frontend 等距外推 75px 累積誤差（1-11 偏右半格）→ 完全消除
 *   - 步距 [89-99]px 反映紙張透視傾斜、OCR 抓到真實位置
 */

// 容忍 OCR 誤讀的「短數字」regex（1~2 位純數字、或單字元 g/G/q/o/O/i/I/l/L 當作 1-2 位數）
const NUMBER_LIKE = /^([0-9]{1,2}|g|G|q|o|O|i|I|l|L)$/

// 「題號 prefix」regex：抓任何 detection 開頭的 1~2 位數字（可帶括號 / 句點 / 冒號 / 頓號）
// 用來處理 OCR 把題號跟題目文字 detect 成同一個 box 的 case（如 "1.潰「去一」：" 或 "6.平「仄」："）
// 2026-05-14 加入此 regex 救「印刷編號黏題目文字」的 layout（國中國語定期評量 case）
const LEADING_DIGIT_PREFIX = /^[\s（(]?(\d{1,2})[\.\.：:、）)]/

// 允許關閉 leading-prefix 路徑的旗標（緊急回退用、預設 ON）
const LEADING_PREFIX_ENABLED = process.env.OCR_CELL_ANCHOR_LEADING_PREFIX_ENABLED !== 'false'

/**
 * 解 answer_only 模式的 anchorHint。
 * @returns null | { sectionName, type: 'cell', cellOrdinal } | { sectionName, type: 'subcell', parentOrdinal, subOrdinal }
 */
export function parseCellAnchorHint(hint) {
  if (!hint) return null
  let m = String(hint).match(/位於『([^』]+)』.*?第\s*(\d+)\s*大題的子格\s*\((\d+)\)/)
  if (m) return { sectionName: m[1], type: 'subcell', parentOrdinal: +m[2], subOrdinal: +m[3] }
  m = String(hint).match(/位於『([^』]+)』.*?第\s*(\d+)\s*格/)
  if (m) return { sectionName: m[1], type: 'cell', cellOrdinal: +m[2] }
  return null
}

/**
 * 從 OCR detections 找出 section headers（「^[一二三四五六]、X」）。
 * 同 sectionChar 多次偵測時取 y_top 最小（最上方）那一個。
 * @returns Array<{ sectionChar, sectionType, y_start, y_end, y_top, y_bot, raw }>，依 y_top 排序
 */
export function findSectionHeaders(detections, imgH) {
  const headers = []
  for (let i = 0; i < detections.length; i++) {
    const d = detections[i]
    const t = (d.rec_text || '').trim()
    const m = t.match(/^([一二三四五六])、([^\s（(（]+)/)
    if (!m) continue
    headers.push({
      idx: i,
      sectionChar: m[1],
      sectionType: m[2],
      raw: t,
      x_left: d.bbox[0], y_top: d.bbox[1],
      x_right: d.bbox[2], y_bot: d.bbox[3]
    })
  }
  // 同 sectionChar 多次偵測 → 留 y_top 最小
  const dedup = new Map()
  for (const h of headers) {
    if (!dedup.has(h.sectionChar) || h.y_top < dedup.get(h.sectionChar).y_top) {
      dedup.set(h.sectionChar, h)
    }
  }
  const list = [...dedup.values()].sort((a, b) => a.y_top - b.y_top)
  // 標記 y_start / y_end
  for (let i = 0; i < list.length; i++) {
    list[i].y_start = list[i].y_top
    list[i].y_end = list[i + 1]?.y_top ?? imgH
  }
  return list
}

/**
 * 在指定 section y 範圍內找「印刷編號 anchors」。
 * 2026-05-14 改成 union-strategy：A ∪ B 合併、A 為主、B 補位。
 *
 * - A 路徑（純數字 box + top row）：跟舊 matcher 同邏輯、處理「題號是獨立 box」的格式（物理畢業考、答案卡單欄編號）
 *   - 容忍 OCR 把 "9" 誤讀成 "g"、依空間順序推回 ordinal
 *   - 取 y 最上方一行（容差 ±50px）、ordinal = 該行排序後 index + 1
 * - B 路徑（leading-digit prefix）：抓任何「以 1~2 位數字開頭」的 box（如 "1.潰「去一」：" 或 "6.平「仄」："）
 *   - 多 row 支援、ordinal = 抓到的數字本身（不是空間位置）
 *   - bbox normalize 成只取「題號的部份」、避免題目文字撐爆 cell 邊界
 * - 合併：A 找到的 ordinal 永遠優先；A 沒找到的、用 B 補位
 *
 * @returns Array<{ ordinal, source, x_left, y_top, x_right, y_bot, x_center, y_center, idx, text }>
 *   排序：由 ord 升冪。注意 ordinal 不一定連續（A/B 都沒找到的中間 ord 會空）
 */
export function findCellNumberRow(detections, section, opts = {}) {
  const yTolerance = opts.yTolerance ?? 50
  const inSection = []
  for (let i = 0; i < detections.length; i++) {
    const d = detections[i]
    const cy = (d.bbox[1] + d.bbox[3]) / 2
    if (cy <= section.y_start || cy >= section.y_end) continue
    const text = (d.rec_text || '').trim()
    // skip section header 本身、避免被當題號
    if (/^[一二三四五六]、/.test(text)) continue
    inSection.push({ d, idx: i, text })
  }
  if (inSection.length === 0) return []

  // ── A path: 純數字 box + top row（保留舊邏輯、物理畢業考 baseline 不動）──
  const aCandidates = inSection.filter(({ text }) => NUMBER_LIKE.test(text))
  const aAnchorsByOrd = new Map()
  if (aCandidates.length > 0) {
    aCandidates.sort((a, b) => a.d.bbox[1] - b.d.bbox[1])
    const baseY = aCandidates[0].d.bbox[1]
    const topRow = aCandidates.filter(c => Math.abs(c.d.bbox[1] - baseY) < yTolerance)
    topRow.sort((a, b) => a.d.bbox[0] - b.d.bbox[0])
    // ordinal = top row 排序後 array index + 1（這條路徑容忍 OCR 誤讀「g/G/q/...」當數字）
    topRow.forEach((c, i) => {
      const ord = i + 1
      aAnchorsByOrd.set(ord, {
        ordinal: ord,
        source: 'A',
        idx: c.idx,
        text: c.text,
        x_left: c.d.bbox[0], y_top: c.d.bbox[1],
        x_right: c.d.bbox[2], y_bot: c.d.bbox[3],
        x_center: (c.d.bbox[0] + c.d.bbox[2]) / 2,
        y_center: (c.d.bbox[1] + c.d.bbox[3]) / 2
      })
    })
  }

  // ── B path: leading-digit prefix（救「題號黏題目」layout、多 row 支援）──
  const bAnchorsByOrd = new Map()
  if (LEADING_PREFIX_ENABLED) {
    for (const c of inSection) {
      const m = c.text.match(LEADING_DIGIT_PREFIX)
      if (!m) continue
      const ord = +m[1]
      if (ord < 1 || ord > 50) continue
      // normalize bbox：估算「題號 prefix 部份」的右邊界、避免題目文字撐爆 cell midpoint 切割
      // m[0] 含 leading 字符 + 數字 + 1 個標點；text 包含整段文字
      const [x1, y1, x2, y2] = c.d.bbox
      const prefixLen = m[0].length + 0.5  // +0.5 buffer 給 OCR text 長度估計
      const textLen = Math.max(c.text.length, 2)
      const digitFraction = Math.min(1, prefixLen / textLen)
      const xRightNormalized = x1 + (x2 - x1) * digitFraction
      // 同一 ord 多個（如 section 一有 "1.潰..." row1、"1." row2 副本）→ 取 y 最上方
      const existing = bAnchorsByOrd.get(ord)
      if (existing && existing.y_top <= y1) continue
      bAnchorsByOrd.set(ord, {
        ordinal: ord,
        source: 'B',
        idx: c.idx,
        text: c.text,
        x_left: x1, y_top: y1,
        x_right: xRightNormalized, y_bot: y2,
        x_center: (x1 + xRightNormalized) / 2,
        y_center: (y1 + y2) / 2
      })
    }
  }

  // ── 合併：A 為主、B 補位 ──
  // 2026-05-14 加入 ghost detection：A 跟 B 同 ord 但 y_top 差太大時、丟 A
  //   - A 路徑只看「孤立純數字 box」、容易被 OCR 把學生筆跡誤判成數字（如 ㄗ→2）抓到 ghost
  //   - B 路徑是「以數字開頭的整段文字」（如 "1.潰「ㄊㄧㄝˋ」："）、印刷文字、不可能在答案區
  //   - 兩者都宣稱同 ord 時、B 的證據強得多
  //   - 物理 case：B 抓不到孤立「1」（regex 要求 leading digit + punct）、走 else 不影響
  const aGhostDropThreshold = 60  // px、超過此距離視為不同 row
  const merged = new Map(bAnchorsByOrd)
  for (const [ord, aAnchor] of aAnchorsByOrd) {
    const bAnchor = bAnchorsByOrd.get(ord)
    if (bAnchor && Math.abs(aAnchor.y_top - bAnchor.y_top) > aGhostDropThreshold) {
      // A 跟 B 同 ord 但 y 差太大、A 可能是 ghost、保留 B 不覆蓋
      continue
    }
    merged.set(ord, aAnchor)
  }

  return [...merged.values()].sort((a, b) => a.ordinal - b.ordinal)
}

/**
 * 從 anchors 推每格 cell bbox（px 座標 + normalized）。
 * 2026-05-14 改寫支援多 row layout：
 *   1. anchors 依 y 聚類成 row（容差 60px）
 *   2. 每 row 內依 x 排序、用相鄰 anchor 中點切左右邊界
 *   3. 上下邊界：本 row y_top → 下一 row y_top（最後一 row → section.y_end 或 +200px buffer）
 *
 * 單 row layout（如物理畢業考）行為等同舊版（只聚出一 row、邏輯一致）。
 * 多 row layout（如國中國語 section 四的 20 題 2×10）能正確分上下兩 row。
 *
 * @param {Array} anchors - 來自 findCellNumberRow 的 union anchor list（含 .ordinal、A/B 混合）
 */
export function deriveCellBboxes(anchors, section, imgW, imgH) {
  if (anchors.length === 0) return []
  const rowTolerance = 60

  // Step 1: 依 y_top 聚類成 row
  const sorted = [...anchors].sort((a, b) => a.y_top - b.y_top)
  const rows = []
  for (const a of sorted) {
    const row = rows.find(r => Math.abs(r.y_top - a.y_top) < rowTolerance)
    if (row) {
      row.anchors.push(a)
      row.y_top = Math.min(row.y_top, a.y_top)
    } else {
      rows.push({ y_top: a.y_top, anchors: [a] })
    }
  }
  rows.sort((a, b) => a.y_top - b.y_top)

  // Step 2: 每 row 內 sort by x + 算邊界
  const cells = []
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]
    row.anchors.sort((a, b) => a.x_left - b.x_left)
    const yStart = row.y_top
    const yEnd = rows[ri + 1]?.y_top ?? Math.min(section.y_end, yStart + 200)

    // typical width within this row
    const interiorWidths = []
    for (let i = 1; i < row.anchors.length - 1; i++) {
      interiorWidths.push((row.anchors[i + 1].x_left - row.anchors[i - 1].x_right) / 2)
    }
    if (interiorWidths.length === 0 && row.anchors.length >= 2) {
      for (let i = 0; i < row.anchors.length - 1; i++) {
        interiorWidths.push(row.anchors[i + 1].x_left - row.anchors[i].x_left)
      }
    }
    const typicalW = interiorWidths.length > 0
      ? interiorWidths.sort((a, b) => a - b)[Math.floor(interiorWidths.length / 2)]
      : 100

    for (let i = 0; i < row.anchors.length; i++) {
      const cur = row.anchors[i]
      const prev = row.anchors[i - 1]
      const next = row.anchors[i + 1]
      let xLeft, xRight
      if (prev) xLeft = (prev.x_right + cur.x_left) / 2
      else xLeft = Math.max(0, cur.x_left - typicalW / 2)
      if (next) xRight = (cur.x_right + next.x_left) / 2
      else xRight = Math.min(imgW, cur.x_right + typicalW / 2)

      cells.push({
        ordinal: cur.ordinal,
        anchor: cur,
        bbox_px: { x: xLeft, y: yStart, w: xRight - xLeft, h: yEnd - yStart },
        bbox_norm: {
          x: +(xLeft / imgW).toFixed(3),
          y: +(yStart / imgH).toFixed(3),
          w: +((xRight - xLeft) / imgW).toFixed(3),
          h: +((yEnd - yStart) / imgH).toFixed(3)
        }
      })
    }
  }
  return cells.sort((a, b) => a.ordinal - b.ordinal)
}

/**
 * sub-cell parent 偵測 + 展開：parent cell 寬度應該是 sub_count × sibling_median。
 * 如果 parent 偏窄（推算用相鄰 anchor 中點切的結果），往左展。
 */
export function applySubCellExpansion(cells, subCountByParentOrd, imgW, imgH) {
  for (const [parentOrd, subCount] of subCountByParentOrd.entries()) {
    const parent = cells.find(c => c.ordinal === parentOrd)
    if (!parent) continue
    const otherCells = cells.filter(c => c.ordinal !== parentOrd)
    if (otherCells.length === 0) continue
    const otherWidths = otherCells.map(c => c.bbox_px.w).sort((a, b) => a - b)
    const medianOther = otherWidths[Math.floor(otherWidths.length / 2)]
    const targetParentW = subCount * medianOther
    if (targetParentW > parent.bbox_px.w) {
      const xRight = parent.bbox_px.x + parent.bbox_px.w
      const newXLeft = Math.max(0, xRight - targetParentW)
      parent.bbox_px = { ...parent.bbox_px, x: newXLeft, w: xRight - newXLeft }
      parent.bbox_norm = {
        x: +(newXLeft / imgW).toFixed(3),
        y: parent.bbox_norm.y,
        w: +((xRight - newXLeft) / imgW).toFixed(3),
        h: parent.bbox_norm.h
      }
    }
  }
  return cells
}

/**
 * Main entry：對 answerKey questions 跟 OCR detections 配對、回傳 candidates。
 *
 * Output schema 跟 `bbox-anchor-match.js` `buildAnchorCandidates` 一致：
 *   { candidatesByQid: { qid → [{ idx, text, bbox, score }] }, stats }
 *
 * - bbox 為 px 座標 [x1, y1, x2, y2]（同 OCR detection 慣例）
 * - downstream `buildOcrHintsSection` / `applyOcrBboxOverride` 直接共用
 */
export function buildCellAnchorCandidates(answerKeyQuestions, ocrDetections, imageSize) {
  const [imgW, imgH] = imageSize || [1, 1]
  const result = {}
  const stats = {
    totalQuestions: 0,
    parsedCount: 0,
    sectionFound: 0,
    matchedCount: 0,
    matchRate: 0,
    assignmentMethod: 'cell_anchor',
    sectionsDetected: [],
    perSection: {}
  }
  if (!Array.isArray(answerKeyQuestions) || !Array.isArray(ocrDetections)) {
    return { candidatesByQid: {}, stats }
  }
  stats.totalQuestions = answerKeyQuestions.length

  // Step 1: section headers
  const sections = findSectionHeaders(ocrDetections, imgH)
  stats.sectionsDetected = sections.map(s => ({ char: s.sectionChar, type: s.sectionType, y_start: s.y_start, y_end: s.y_end }))
  if (sections.length === 0) return { candidatesByQid: {}, stats }

  // Step 2: 對每個 section 求 numRow + cells
  // 先算每 section 的 maxOrd（從 answerKey）、用來過濾 B 補進來的 ghost anchor
  // 例：物理 Section 三 answerKey 只到 ord=6，但 OCR 把「7.5」（答案數值）誤抓成 ord=7、要砍掉
  const maxOrdBySection = new Map()
  for (const q of answerKeyQuestions) {
    const p = parseCellAnchorHint(q.anchorHint)
    if (!p) continue
    const sChar = p.sectionName.match(/^[一二三四五六]/)?.[0]
    if (!sChar) continue
    const ord = p.type === 'cell' ? p.cellOrdinal : p.parentOrdinal
    maxOrdBySection.set(sChar, Math.max(maxOrdBySection.get(sChar) || 0, ord))
  }

  const cellsBySection = new Map()
  for (const sec of sections) {
    let numRow = findCellNumberRow(ocrDetections, sec)
    // 砍 ghost：B 補進來但 ord > answerKey 該 section maxOrd 的
    const maxOrd = maxOrdBySection.get(sec.sectionChar) ?? Infinity
    numRow = numRow.filter(a => !(a.source === 'B' && a.ordinal > maxOrd))
    let cells = deriveCellBboxes(numRow, sec, imgW, imgH)
    // sub-cell expansion
    const subCountByParent = new Map()
    for (const q of answerKeyQuestions) {
      const p = parseCellAnchorHint(q.anchorHint)
      if (!p || p.type !== 'subcell') continue
      const sChar = p.sectionName.match(/^[一二三四五六]/)?.[0]
      if (sChar !== sec.sectionChar) continue
      subCountByParent.set(p.parentOrdinal, Math.max(subCountByParent.get(p.parentOrdinal) || 0, p.subOrdinal))
    }
    if (subCountByParent.size > 0) {
      cells = applySubCellExpansion(cells, subCountByParent, imgW, imgH)
    }
    cellsBySection.set(sec.sectionChar, cells)
    const sourceA = numRow.filter(a => a.source === 'A').length
    const sourceB = numRow.filter(a => a.source === 'B').length
    stats.perSection[sec.sectionChar] = {
      sectionType: sec.sectionType,
      numRowCount: numRow.length,
      cellCount: cells.length,
      anchorSourceA: sourceA,  // 純數字 anchor 數
      anchorSourceB: sourceB,  // leading-digit prefix anchor 數
      subCells: [...subCountByParent.entries()]
    }
  }

  // Step 3: 對每題用 anchorHint 找對應 cell
  for (const q of answerKeyQuestions) {
    const qid = q?.id
    if (!qid) continue
    const parsed = parseCellAnchorHint(q.anchorHint)
    if (!parsed) continue
    stats.parsedCount++
    const sectionChar = parsed.sectionName.match(/^[一二三四五六]/)?.[0]
    if (!sectionChar) continue
    const cells = cellsBySection.get(sectionChar)
    if (!cells || cells.length === 0) continue
    stats.sectionFound++

    // ordinal: cell 用 cellOrdinal、subcell 用 parentOrdinal（之後切）
    const targetOrd = parsed.type === 'cell' ? parsed.cellOrdinal : parsed.parentOrdinal
    const cell = cells.find(c => c.ordinal === targetOrd)
    if (!cell) continue

    let bbox_px = cell.bbox_px
    // sub-cell 切分
    if (parsed.type === 'subcell') {
      const siblingCount = answerKeyQuestions.filter(qq => {
        const p = parseCellAnchorHint(qq.anchorHint)
        return p?.type === 'subcell' && p.sectionName === parsed.sectionName && p.parentOrdinal === parsed.parentOrdinal
      }).length || 1
      const subW = cell.bbox_px.w / siblingCount
      const subX = cell.bbox_px.x + subW * (parsed.subOrdinal - 1)
      bbox_px = { x: subX, y: cell.bbox_px.y, w: subW, h: cell.bbox_px.h }
    }

    // bbox 用 px [x1, y1, x2, y2] 格式（跟 ocrDetections.bbox 慣例一致）
    const bbox = [
      Math.round(bbox_px.x),
      Math.round(bbox_px.y),
      Math.round(bbox_px.x + bbox_px.w),
      Math.round(bbox_px.y + bbox_px.h)
    ]
    result[qid] = [{
      idx: cell.anchor.idx,
      text: `cell#${cell.ordinal}${parsed.type === 'subcell' ? `(${parsed.subOrdinal}/${cell.bbox_px.w})` : ''}`,
      bbox,
      score: 1.0  // cell anchor 是 deterministic、score=1
    }]
    stats.matchedCount++
  }

  stats.matchRate = stats.totalQuestions > 0 ? stats.matchedCount / stats.totalQuestions : 0
  return { candidatesByQid: result, stats }
}
