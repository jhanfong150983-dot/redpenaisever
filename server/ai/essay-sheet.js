// 2026-09-19 作文稿紙：學生卷 → 逐直行裁圖＋零 AI「數格子」驗證。
//   ⛔ 幾何是 client `redpenai/src/lib/essaySheetGenerator.ts` 的鏡像（server 不能 import client TS，
//      同 QUESTION_CATEGORY_TO_BUCKET 的慣例）。改稿紙幾何時兩邊都要改、並升 ESSAY_SHEET_VERSION。
//   對齊沿用生成作答卷那套四角錨點（generated-sheet-readback.js），作文卷兩頁都印了錨點。
//
//   數格子驗證（實驗0/1）：稿紙一格一字 → 每直行「有墨的格數」應等於抄本字數，
//   不符即標低信心交老師補。實測抓到全部漏字／多字／疊字行，只漏「字數不變的改字」。
import sharp from 'sharp'
import { alignGeneratedSheetBoxes } from './generated-sheet-readback.js'

/** 這份定版版面是不是作文稿紙 */
export function isEssayLayout(layout) {
  return !!layout && typeof layout === 'object' && !!layout.essay
}

/**
 * 第 col 直行（1 起算、1＝最右邊）的矩形 [x, y, w, h]（mm、橫式紙座標）。
 * withGutter＝含該行「右側」窄欄——插入字慣例寫在右側；含左側會把鄰行的插入字一起收進來
 * （實驗0 的 5-10 事故：插入字被鄰行誤收，修正後 29 行改善 15 行）。
 */
export function essayColumnRectMm(g, col, withGutter = true) {
  const pitch = g.cellMm + g.gutterMm
  const right = g.gridMm[0] + g.gridMm[2] - (col - 1) * pitch
  return withGutter
    ? [right - pitch, g.gridMm[1], pitch, g.rows * g.cellMm]
    : [right - pitch, g.gridMm[1], g.cellMm, g.rows * g.cellMm]
}

/** 第 col 直行第 row 格（皆 1 起算）的矩形 [x, y, w, h] */
export function essayCellRectMm(g, col, row) {
  const [x, y] = essayColumnRectMm(g, col, false)
  return [x, y + (row - 1) * g.cellMm, g.cellMm, g.cellMm]
}

/** 合併圖（多頁直向堆疊）→ 每頁一個 buffer；沒有 pageBreaks 就整張當一頁 */
async function splitPages(imageBuffer, pageBreaks) {
  const meta = await sharp(imageBuffer).metadata()
  const W = meta.width
  const H = meta.height
  if (!W || !H) throw new Error('作文卷影像尺寸讀取失敗')
  const bounds = [0, ...(Array.isArray(pageBreaks) ? pageBreaks : []), 1]
  const out = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const top = Math.round(bounds[i] * H)
    const bottom = Math.round(bounds[i + 1] * H)
    if (bottom - top <= 0) continue
    out.push({
      buf: await sharp(imageBuffer).extract({ left: 0, top, width: W, height: bottom - top }).png().toBuffer(),
      // 該頁在「合併圖」裡的縱向範圍（0~1）——檢討單要在原卷上畫紅字，需要合併圖座標
      y0: bounds[i],
      y1: bounds[i + 1],
    })
  }
  return out
}

/** 單頁：用四角錨點把「23 條直行」投影到學生卷上（reuse 生成作答卷的對齊＋驗證） */
async function alignColumns(pageBuffer, layout) {
  const g = layout.essay
  const boxes = []
  for (let c = 1; c <= g.cols; c++) {
    boxes.push({ id: `c${c}`, xyMm: essayColumnRectMm(g, c, true) })
    // 每格也一起投影：數格子驗證要逐格量墨
    for (let r = 1; r <= g.rows; r++) boxes.push({ id: `c${c}r${r}`, xyMm: essayCellRectMm(g, c, r) })
  }
  const { boxes: aligned, anchors } = await alignGeneratedSheetBoxes(pageBuffer, {
    pageMm: layout.pageMm,
    anchorsMm: layout.anchorsMm,
    uvBasis: layout.uvBasis,
    header: layout.header,
    boxes,
  })
  const byId = new Map(aligned.map((b) => [b.id, b.bbox]))
  return { byId, anchors }
}

/**
 * 自備稿紙：直接在學生卷上偵測印刷格線（純 code、不需要定位方塊、不需要疊合）。
 *   ⭐ 依據：實驗0/1 用同一套紅線偵測，在 114/115 共 51 張真實樣卷上全部正確抓出 23 行。
 *   不受裁切比例、縮放、有沒有錨點影響——這正是自備稿紙（例如會考答案卷）唯一可靠的定位方式。
 * @returns {Promise<{cols: Array<{x:number,y:number,w:number,h:number}>, rows:number}|null>} 頁面 normalized
 */
export async function detectEssayGridOnPage(pageBuffer, opts = {}) {
  const wantCols = opts.cols ?? 23
  const wantRows = opts.rows ?? 22
  const { data, info } = await sharp(pageBuffer).raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  const H = info.height
  const ch = info.channels
  if (!W || !H || ch < 3) return null
  // 印刷格線＝「有顏色」的像素：會考是粉紅、學測是綠，所以不能只認紅色。
  //   判準＝彩度夠高（max-min）且不太暗（排除黑字與定位方塊）、不太亮（排除紙白）。
  //   學生筆跡是黑／深藍、又不成整條線，後面的投影門檻會把它濾掉。
  //   ⚠ 已知限制：**灰階掃描**會把彩色格線變成灰線，此法失效（見 docs 實驗紀錄）。
  const colSum = new Float64Array(W)
  const rowSum = new Float64Array(H)
  for (let i = 0, p = 0; i < W * H; i++, p += ch) {
    const r = data[p], g = data[p + 1], b = data[p + 2]
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b)
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b)
    if (mx - mn > 28 && mx > 80 && mn < 235) { colSum[i % W]++; rowSum[(i / W) | 0]++ }
  }
  // 9px 帶狀加總：掃描微歪斜時一條線會跨好幾個像素列
  const band = (arr) => {
    const out = new Float64Array(arr.length)
    for (let i = 0; i < arr.length; i++) {
      let s = 0
      for (let k = -4; k <= 4; k++) { const j = i + k; if (j >= 0 && j < arr.length) s += arr[j] }
      out[i] = s
    }
    return out
  }
  const maxOf = (a) => { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m }
  const runsOf = (arr, thr) => {
    const out = []
    let st = -1
    for (let i = 0; i < arr.length; i++) {
      const on = arr[i] > thr
      if (on && st < 0) st = i
      if (!on && st >= 0) { out.push((st + i - 1) >> 1); st = -1 }
    }
    if (st >= 0) out.push((st + arr.length - 1) >> 1)
    return out
  }
  // 門檻依影像自動校準：寫死 0.8×邊長會在 WebP 壓縮後失效
  //   （實測同一張圖 PNG 抓到 29 條橫線、WebP q85 只剩 1 條——橫線被壓得比直線糊）
  const bc = band(colSum)
  const br = band(rowSum)
  // ⛔ 門檻不可用「全圖最大值」：實測 115 學測真實樣卷有個無關元素彩度飆到 877，
  //   而格區的格線只有 83 → 用 max×0.45 會把格線整批濾掉（只串到 1 行）。改用 90 百分位。
  const pctOf = (a, f) => {
    const nz = []
    for (let i = 0; i < a.length; i++) if (a[i] > 0) nz.push(a[i])
    if (!nz.length) return 0
    nz.sort((x, y) => x - y)
    return nz[Math.min(nz.length - 1, Math.floor(nz.length * f))]
  }
  const mids = runsOf(bc, pctOf(bc, 0.9) * 0.5)
  const hmids = runsOf(br, pctOf(br, 0.9) * 0.5)
  if (mids.length < 3 || hmids.length < 3) return null

  // 格區上下界：取「最長一段等距的橫線」＝字格的列線（排除標題框、裝訂線之類的雜線）
  const regularRun = (arr) => {
    if (arr.length < 3) return arr
    const gaps = []
    for (let i = 0; i < arr.length - 1; i++) gaps.push(arr[i + 1] - arr[i])
    const sorted = [...gaps].sort((a, b) => a - b)
    const med = sorted[sorted.length >> 1]
    let best = [0, 0], st = 0
    for (let i = 0; i <= gaps.length; i++) {
      const ok = i < gaps.length && Math.abs(gaps[i] - med) <= Math.max(3, med * 0.35)
      if (!ok) { if (i - st > best[1] - best[0]) best = [st, i]; st = i + 1 }
    }
    return arr.slice(best[0], best[1] + 1)
  }
  const hRun = regularRun(hmids)
  if (hRun.length < 3) return null
  const yTop = hRun[0]
  const yBot = hRun[hRun.length - 1]

  // 直行：⛔ 不可用「老師填的行數均分」——掃描常被裁掉左右（實測 115 學測樣卷 38 行只掃到 26 行），
  //   均分會讓整批行位全錯。改成「由每條候選直線往左跨一個行距、吸附最近格線」串成鏈，取最長的一條。
  //   同時解決：①會考型（字格＋窄欄交錯，行距＝兩者相加）②學測型（均勻格線）
  //   ③格區旁的框線（串不起來被淘汰）④掃描被裁切（串到沒線就停）。
  const gapsAll = []
  for (let i = 0; i < mids.length - 1; i++) gapsAll.push(mids[i + 1] - mids[i])
  const minPitch = Math.max(4, W * 0.008)
  const cands = new Set()
  for (const g of gapsAll) if (g >= minPitch) cands.add(Math.round(g))
  for (let i = 0; i < gapsAll.length - 1; i++) {
    const sum = gapsAll[i] + gapsAll[i + 1]
    if (sum >= minPitch) cands.add(Math.round(sum))
  }
  const snap = (x, tol) => {
    let best = null, bd = Infinity
    for (const m of mids) { const d = Math.abs(m - x); if (d < bd) { bd = d; best = m } }
    return bd <= tol ? best : null
  }
  let chain = null
  for (const pitch of cands) {
    const tol = Math.max(3, pitch * 0.22)
    for (let si = mids.length - 1; si >= 0; si--) {
      const out = [mids[si]]
      let x = mids[si]
      for (;;) {
        const nx = snap(x - pitch, tol)
        if (nx != null && nx < x) { out.push(nx); x = nx; continue }
        // 容許跳過一條「淡到偵測不到」的格線：往左跨兩個行距，中間那條用內插補回
        const skip = snap(x - 2 * pitch, tol)
        if (skip != null && skip < x) { out.push((x + skip) / 2, skip); x = skip; continue }
        break
      }
      if (!chain || out.length > chain.length) chain = out
    }
  }
  if (!chain || chain.length < 2) return null
  // 防呆：抓不全比抓不到更危險（少抓的行＝整段文字無聲消失）。
  //   左端離影像邊緣還很遠＝那裡本來該有行卻沒抓到 → 不放行；緊貼邊緣＝掃描被裁切，照抓到的算。
  // chain 由右至左＝書寫順序；相鄰兩條線之間就是一行（含右側窄欄）
  const nCols = Math.min(chain.length - 1, wantCols)
  const cols = []
  for (let i = 0; i < nCols; i++) {
    cols.push({ x: chain[i + 1] / W, y: yTop / H, w: (chain[i] - chain[i + 1]) / W, h: (yBot - yTop) / H })
  }
  // 偵測器照實回報抓到什麼，「能不能用」的政策交給呼叫端（detectGridBoxes）決定。
  //   ⭐ 三道 incomplete 判準，每一道對應一種「會讓整段文字無聲消失」的失敗：
  const reasons = []
  //   ① 左端離影像邊緣還很遠卻少抓行＝那裡本來該有行卻沒抓到（緊貼邊緣＝掃描被裁切，照抓到的算）
  const leftMost = chain[chain.length - 1]
  const detected = chain.length - 1
  if (detected < wantCols && leftMost > Math.max(8, (chain[0] - chain[1]) * 1.5)) {
    reasons.push(`只找到 ${detected} 行格線（應為 ${wantCols} 行），左側還有空間卻沒抓到`)
  }
  //   ② 行寬不一致＝中間漏掉一條格線、把兩行併成一行（實測 115 學測樣卷就是這樣，
  //      行數看似連續、右半對齊正確，但左半整批位移一行）。單看行數抓不到這種錯。
  const ws = cols.map((c) => c.w).sort((a, b) => a - b)
  const medW = ws[ws.length >> 1]
  const outlier = cols.findIndex((c) => Math.abs(c.w - medW) > medW * 0.25)
  if (medW > 0 && outlier >= 0) {
    reasons.push(`第 ${outlier + 1} 行的寬度與其他行差太多（可能兩行被併成一行）`)
  }
  //   ③ 格區上下界要能被列高整除成 wantRows 列。regularRun 取「最長等距段」，
  //      若最上面幾條列線太淡沒被偵測到，上界就會往下掉——實測 115 學測樣卷少了最上面 3 列，
  //      每一行的前 3 個字會被整批裁掉，而行數完全正常、看不出來。
  const rowPitch = hRun.length > 1 ? (hRun[hRun.length - 1] - hRun[0]) / (hRun.length - 1) : 0
  const rowsSpanned = rowPitch > 0 ? Math.round((yBot - yTop) / rowPitch) : 0
  if (rowsSpanned && Math.abs(rowsSpanned - wantRows) > 0) {
    reasons.push(`格區只涵蓋 ${rowsSpanned} 列（應為 ${wantRows} 列），上下界可能抓錯`)
  }
  return { rows: wantRows, cols, detectedCols: detected, incomplete: reasons.length > 0, reasons }
}

/** 自備稿紙：偵測到的格線 → 與錨點版同樣的 byId 結構（cN＝整行、cNrM＝單格） */
async function detectGridBoxes(pageBuffer, g) {
  const grid = await detectEssayGridOnPage(pageBuffer, { cols: g.cols, rows: g.rows })
  if (!grid) {
    throw new Error('這一頁找不到稿紙的格線——請確認掃描完整、格線清楚，或改用系統製作的作文稿紙')
  }
  // ⛔ 抓不全一定要擋：少抓的行會讓整段文字無聲消失，比直接失敗危險得多
  if (grid.incomplete) {
    throw new Error(`這一頁的稿紙格線抓得不完整（${grid.reasons.join('；')}）——格線太淡或掃描不清，請提高掃描品質、整張掃進去不要裁到格線，或改用系統製作的作文稿紙`)
  }
  const byId = new Map()
  grid.cols.forEach((c, i) => {
    byId.set(`c${i + 1}`, { x: c.x, y: c.y, w: c.w, h: c.h })
    const cellH = c.h / g.rows
    // 單格寬＝扣掉右側窄欄後的字格（偵測到的 w 含窄欄）
    //   ⚠ gutterMm 可以是 0（學測稿紙沒有窄欄、整行就是字格）→ 不可用 `g.gutterMm &&` 判斷，
    //     否則 0 會掉進 0.8 的 fallback、每格白白裁掉兩成。
    const cellW = c.w * (g.cellMm && g.gutterMm != null ? g.cellMm / (g.cellMm + g.gutterMm) : 0.8)
    for (let r = 1; r <= g.rows; r++) {
      byId.set(`c${i + 1}r${r}`, { x: c.x, y: c.y + (r - 1) * cellH, w: cellW, h: cellH })
    }
  })
  return byId
}

/** 一格是不是「有墨」：暗像素數超過門檻。門檻隨格子面積縮放（低解析度掃描墨點數會等比變少） */
function cellHasInk(raw, W, H, rect, darkThreshold = 110, ratio = 0.004) {
  const x0 = Math.max(0, Math.round(rect.x * W))
  const y0 = Math.max(0, Math.round(rect.y * H))
  const x1 = Math.min(W, Math.round((rect.x + rect.w) * W))
  const y1 = Math.min(H, Math.round((rect.y + rect.h) * H))
  // 內縮 12%：避開印刷格線本身
  const padX = Math.round((x1 - x0) * 0.12)
  const padY = Math.round((y1 - y0) * 0.12)
  let dark = 0
  let total = 0
  for (let y = y0 + padY; y < y1 - padY; y++) {
    for (let x = x0 + padX; x < x1 - padX; x++) {
      total++
      if (raw[y * W + x] < darkThreshold) dark++
    }
  }
  return { dark, total, inked: total > 0 && dark / total >= ratio }
}

/**
 * 學生卷 → 逐直行裁圖＋每行的「有墨格數」。
 * @returns {Promise<{columns: Array<{page:number,col:number,pngBase64:string,inkCells:number,blank:boolean}>, pages:number}>}
 */
export async function cutEssayColumns(imageBuffer, layout, pageBreaks) {
  if (!isEssayLayout(layout)) throw new Error('不是作文稿紙版面')
  const g = layout.essay
  let pageBufs = await splitPages(imageBuffer, pageBreaks)
  if (pageBufs.length < g.pages) {
    // pageBreaks 是「優化」不是「前提」：作文稿紙每頁等高，合併圖平均切就對了。
    //   實測 client 沒把 pageBreaks 存進 DB 時（2026-09-20 的老卷），平均切出來的兩頁
    //   格線偵測都是 23/23。真的只掃了一頁的話，平均切會把一頁劈成兩半 →
    //   下面 detectGridBoxes 的「格區列數」守門會大聲擋下，不會無聲批錯。
    const even = Array.from({ length: g.pages - 1 }, (_, i) => (i + 1) / g.pages)
    const retry = await splitPages(imageBuffer, even)
    if (retry.length < g.pages) {
      throw new Error(`作文卷需要 ${g.pages} 頁，這份只有 ${pageBufs.length} 頁——請確認正反面都掃進來了`)
    }
    pageBufs = retry
  }
  const columns = []
  const byoMode = g.source === 'byo'
  for (let p = 0; p < g.pages; p++) {
    const { buf, y0: pageY0, y1: pageY1 } = pageBufs[p]
    const pageSpan = pageY1 - pageY0
    // 自備稿紙沒有四角定位方塊 → 直接在學生卷上偵測印刷格線（純 code；實驗證實 102 張真實樣卷 100% 抓對）
    const byId = byoMode ? await detectGridBoxes(buf, g) : (await alignColumns(buf, layout)).byId
    const { data: gray, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true })
    const W = info.width
    const H = info.height
    for (let c = 1; c <= g.cols; c++) {
      let inkCells = 0
      for (let r = 1; r <= g.rows; r++) {
        const rect = byId.get(`c${c}r${r}`)
        if (rect && cellHasInk(gray, W, H, rect).inked) inkCells++
      }
      const rect = byId.get(`c${c}`)
      if (!rect) continue
      const blank = inkCells === 0
      let pngBase64 = ''
      if (!blank) {
        const left = Math.max(0, Math.round(rect.x * W))
        const top = Math.max(0, Math.round(rect.y * H))
        const width = Math.min(W - left, Math.round(rect.w * W))
        const height = Math.min(H - top, Math.round(rect.h * H))
        if (width > 4 && height > 4) {
          pngBase64 = (await sharp(buf).extract({ left, top, width, height }).png().toBuffer()).toString('base64')
        }
      }
      columns.push({
        page: p + 1,
        col: c,
        pngBase64,
        inkCells,
        blank,
        // 這一行在「學生合併圖」上的位置（normalized）→ 檢討單直接照著畫紅字，不必在前端重做對齊
        bbox: { x: rect.x, y: pageY0 + rect.y * pageSpan, w: rect.w, h: rect.h * pageSpan },
      })
    }
  }
  return { columns, pages: g.pages }
}
