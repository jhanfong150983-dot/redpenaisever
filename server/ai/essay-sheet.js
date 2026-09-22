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
  // ⛔ 卷種分流（user 09-21：會考卷與學測卷不能混在一起，各自要成功、互不影響）。
  //   只認**明確的** format:'gsat'，不從行數／顏色去猜——猜錯的後果是拿錯的偵測器「碰巧成功」。
  //   下面整段會考邏輯一個字元都沒動；學測走完全獨立的 detectGsatGridOnPage。
  //   雙向隔離由 local-only/essay/_grid_isolation_regression.mjs 把關（四個象限）。
  //
  // 2026-09-22 灰階後備（user：老師的稿紙可能是黑白影印、掃描也一定是黑白）：
  //   兩支偵測器都先用「顏色」找線（行為與過去逐字元相同）；找不到或不完整時，再用「暗度」找一次。
  //   ⛔ 單調規則：彩色能過的頁結果不變；只有原本會失敗的頁才可能被灰階救回，且灰階同樣要過全部守門。
  //   暗度＝紙白 0、灰線／黑筆都有值：筆跡只散在格子裡、格線是整條，投影／梳子把整條線積分出來後差得很遠。
  const { data, info } = await sharp(pageBuffer).raw().toBuffer({ resolveWithObject: true })
  if (!info.width || !info.height || info.channels < 3) return null
  if (opts.format === 'gsat') {
    // ⛔ 學測**不開**灰階後備：模擬黑白掃描 12 頁裡 4 頁「守門全過、但整把梳子偏 1～2 行」（公版右側說明框的黑框線
    //   被當成格線，梳子鎖到它上面）——那是無聲批錯，比直接失敗危險。等拿到真實黑白樣卷、能驗證再開。
    //   （detectGsatGridOnPage 的 measure='gray' 路徑保留給日後實驗。）
    return detectGsatGridOnPage(data, info, opts, 'color')
  }
  const color = detectCapGridOnPage(data, info, opts, 'color')
  if (color && !color.incomplete) return color
  const gray = detectCapGridOnPage(data, info, opts, 'gray')
  if (gray && !gray.incomplete) return gray
  return color ?? gray
}

/**
 * 灰階後備的證據圖：「長直線的暗度」。
 *   黑白影印的格線跟黑筆一樣都是暗的，單看暗度分不開（實測：會考卷 50 頁只救回 8 頁、學測 0/12——
 *   筆跡把格心撐到跟格線一樣高）。差別在**形狀**：格線是貫穿整個格區的長直線，筆跡再直也只在一格內。
 *   → 只保留「連續暗像素長度 ≥ minRun（約 1.2 格）」的直線段：vert 給直行投影、horz 給橫列投影。
 *   值＝暗度（紙白 0、上限 40），紙白／短筆畫／散點都是 0。
 */
export function longRunDarkness(data, W, H, ch, minRun) {
  const N = W * H
  const lum = new Uint8Array(N)
  const hist = new Uint32Array(256)
  for (let i = 0, p = 0; i < N; i++, p += ch) { const l = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8; lum[i] = l; hist[l]++ }
  // 門檻固定「亮度 < 207」（＝比 215 暗 8 以上）。⛔ 試過「比紙白暗 ≥10」＋容許斷點：會考灰階從 50/50 掉到 43/50
  //   （更多筆跡與浮水印被算進去、多抓出 33~46 條線）→ 不採用。這版在 50 張灰階會考卷上行位與彩色完全一致。
  void hist
  const dark = new Uint8Array(N)
  for (let i = 0; i < N; i++) { const d = 215 - lum[i]; dark[i] = d > 8 ? (d > 40 ? 40 : d) : 0 }
  const GAP = 0
  const vert = new Float32Array(N)
  const horz = new Float32Array(N)
  const sweep = (len, idx, out) => {
    let st = -1, last = -1
    for (let t = 0; t <= len; t++) {
      const on = t < len && dark[idx(t)] > 0
      if (on) { if (st < 0) st = t; last = t; continue }
      if (st >= 0 && (t - last > GAP || t === len)) {
        if (last - st + 1 >= minRun) for (let k = st; k <= last; k++) { const i = idx(k); if (dark[i]) out[i] = dark[i] }
        st = -1
      }
    }
  }
  for (let x = 0; x < W; x++) sweep(H, (y) => y * W + x, vert)
  for (let y = 0; y < H; y++) sweep(W, (x) => y * W + x, horz)
  return { vert, horz }
}

/** 會考自備稿紙（粉紅格線）。measure='color'＝原本的彩度遮罩；'gray'＝長直線暗度（黑白影印後備） */
function detectCapGridOnPage(data, info, opts, measure) {
  const wantCols = opts.cols ?? 23
  const wantRows = opts.rows ?? 22
  const W = info.width
  const H = info.height
  const ch = info.channels
  // 印刷格線＝「有顏色」的像素：會考是粉紅、學測是綠，所以不能只認紅色。
  //   判準＝彩度夠高（max-min）且不太暗（排除黑字與定位方塊）、不太亮（排除紙白）。
  //   學生筆跡是黑／深藍、又不成整條線，後面的投影門檻會把它濾掉。
  //   灰階後備：黑白影印的格線是灰線，改認「不是紙白的像素」（亮度 < 200；黑筆一起算進去、靠投影濾掉）。
  const colSum = new Float64Array(W)
  const rowSum = new Float64Array(H)
  if (measure === 'gray') {
    const { vert, horz } = longRunDarkness(data, W, H, ch, Math.max(24, Math.round(W * 0.02)))
    for (let i = 0; i < W * H; i++) { if (vert[i]) colSum[i % W]++; if (horz[i]) rowSum[(i / W) | 0]++ }
  } else {
    for (let i = 0, p = 0; i < W * H; i++, p += ch) {
      const r = data[p], g = data[p + 1], b = data[p + 2]
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b)
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b)
      if (mx - mn > 28 && mx > 80 && mn < 235) { colSum[i % W]++; rowSum[(i / W) | 0]++ }
    }
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
  //   ④ 行數明顯**多於**預期＝這張根本不是這種稿紙（2026-09-21 卷種隔離）。
  //      原本只擋「少抓」：抓到 38 條線會默默取前 23 條當成功——空白的學測公版卷就這樣被會考偵測器放行。
  //      實測 29 張通過的會考樣卷 detected 全部剛好 23（分佈 14~17／23／null，沒有任何一張 >23），
  //      學測是 38 → 門檻留 2 行餘裕，對正常會考卷零影響（回歸①逐頁簽章一致）。
  if (detected > wantCols + 2) {
    reasons.push(`找到 ${detected} 行格線，明顯多於這種稿紙應有的 ${wantCols} 行——這張可能不是這種稿紙`)
  }
  //   ⑤（只在灰階後備）行距必須是「稿紙尺度」：B4 橫式 12.5mm 行距／364mm 紙寬＝圖寬 3.4%（裁到只剩格區 4.3%、A3 掃 3.0%）。
  //      實測 115-1-02（彩色路徑本來就不過的頁）灰階鎖到 43px 的週期結構（＝圖寬 1.8%）、23 行等寬、22 列全過守門
  //      → 無聲批錯。彩色路徑不加此守門（與基準逐頁一致的承諾）。列高也要≈行距×0.8（10mm 格／12.5mm 行距）。
  if (measure === 'gray') {
    if (medW < 0.024 || medW > 0.05) reasons.push(`灰階後備：行距 ${(medW * 100).toFixed(1)}% 不是稿紙尺度（應為圖寬的 2.4~5%）`)
    if (rowPitch > 0 && Math.abs(rowPitch / (medW * W) - 0.8) > 0.15) reasons.push('灰階後備：列高與行距的比例不對（應≈0.8）')
  }
  return { rows: wantRows, cols, detectedCols: detected, incomplete: reasons.length > 0, reasons, measure }
}

/**
 * 學測國寫**公版答題卷**的格線偵測（format:'gsat'）——與上面會考那支完全獨立，互不呼叫、互不共用門檻。
 *
 * 為什麼不能沿用會考的做法（2026-09-21，115 學測第二大題真實原卷 6 份實測 0/6）：
 *   會考那支用「彩度夠高」當遮罩、再把過門檻的線串成鏈。學測真實掃描的綠格線又細又淡，
 *   遮罩命中的像素裡 52% 是**筆跡邊緣的紅色色邊**、34% 是浮水印、綠線只有 14%
 *   （整頁寫滿 800 字、又沒有窄欄隔開）。空白 PDF 會過、真實卷全滅。拉高飽和度沒用（雜訊一起放大）。
 *
 * 做法：
 *   ①遮罩只認**綠色色相**（g 明顯大於 r、b）→ 筆跡的紅色色邊直接出局。
 *   ②不去「找線再串」，改用**梳子比對**：公版格子是固定的 38×22 正方格（10mm），
 *     所以拿一把「N+1 根等距齒」的梳子在投影上滑動，找齒壓在線上、齒縫落在格心的最佳位置。
 *     39 條線的證據一起投票 → 個別線太淡、被筆跡蓋住都不影響；橫線比直線糊也不怕。
 *   ③列距由行距推得（正方格，容許掃描器 ±4% 的縱橫比誤差）→ 不必偵測出每一條橫線。
 * @returns 與 detectEssayGridOnPage 相同的結構（cols 由右至左、normalized）
 */
async function detectGsatGridOnPage(data, info, opts = {}, measure = 'color') {
  const wantCols = opts.cols ?? 38
  const wantRows = opts.rows ?? 22
  const W = info.width
  const H = info.height
  const ch = info.channels

  // 綠色強度圖（一次算好，後面在不同範圍上重複投影）。
  // ⛔ 不可用「過門檻才算 1」的二值遮罩：真實掃描的綠線又細又淡（縮圖＋WebP 後 g−max(r,b) 常只有 3~10），
  //   二值化後一條線只剩 ~9% 的像素被算到（實測 115 原卷2-1），證據低到跟雜訊分不開。
  //   改累加**連續的綠色強度** max(0, g−max(r,b))：淡線靠整條線的長度積分出來；
  //   筆跡是灰黑（≈0）、筆跡邊緣的色邊偏紅（負值→0）、紙白≈0，都不貢獻。上限 40 防止少數鮮綠像素獨大。
  let green = null, mapCol = null, mapRow = null
  if (measure === 'gray') {
    // 黑白影印後備：直行投影只看長直的直線段、橫列投影只看長直的橫線段（見 longRunDarkness）
    const lr = longRunDarkness(data, W, H, ch, Math.max(24, Math.round(W * 0.02)))
    mapCol = lr.vert
    mapRow = lr.horz
  } else {
    green = new Float32Array(W * H)
    for (let i = 0, p = 0; i < W * H; i++, p += ch) {
      const r = data[p], g = data[p + 1], b = data[p + 2]
      // 2026-09-22 改「紅色赤字＋藍色赤字」2g−r−b（不再取 min）：115 原卷 2-1 的格線是藍綠色 (164,186,183)，
      //   g−max(r,b) 只剩 3、其他卷 11 → 右框線證據跟雜訊分不開、線上第一份學測卷就掛在這裡；
      //   改成和之後三卷都是 25~26。藍色原子筆 b≫g → 負值→0，紅色頁碼 r≫g → 0，黑筆/紙白 ≈0，性質不變。
      const v = 2 * g - r - b
      if (v > 4 && g > 90 && g >= b - 8) green[i] = v > 40 ? 40 : v
    }
    mapCol = green
    mapRow = green
  }
  const project = (x0, x1, y0, y1) => {
    const col = new Float64Array(W)
    const row = new Float64Array(H)
    for (let y = y0; y < y1; y++) {
      const base = y * W
      for (let x = x0; x < x1; x++) {
        const v = mapCol[base + x]; if (v) col[x] += v
        const u = mapRow[base + x]; if (u) row[y] += u
      }
    }
    return { col, row }
  }
  // 帶狀加總：掃描微歪斜時一條線會跨好幾個像素
  const band = (arr, half) => {
    const out = new Float64Array(arr.length)
    for (let i = 0; i < arr.length; i++) {
      let s = 0
      for (let k = -half; k <= half; k++) { const j = i + k; if (j >= 0 && j < arr.length) s += arr[j] }
      out[i] = s
    }
    return out
  }
  const at = (arr, x) => {
    if (x < 0 || x > arr.length - 1) return 0
    const i = Math.floor(x)
    const f = x - i
    return arr[i] * (1 - f) + (arr[i + 1] ?? arr[i]) * f
  }
  /**
   * 梳子比對：n 格＝n+1 根齒。分數＝齒上的量 − 齒縫（格心）的量。
   * ⛔ 粗搜尋的步長必須配合帶寬：行距每差 dp，第 n 根齒就偏 n×dp。
   *   首版粗搜尋 dp=0.5、帶寬 ±2 → 38 根齒尾端偏 9px，後段的齒全壓不到線，
   *   分數失真、鎖到「整把梳子偏一格」的位置（連空白卷都中招：每張圖第一根齒證據都是 0）。
   *   所以分兩段：粗搜尋用 ±6 寬帶＋dp 0.2（尾端最多偏 3.8px，仍在帶內）；再用 ±2 窄帶精修。
   */
  const comb = (raw, n, pMin, pMax, oMin, oMax) => {
    const run = (arr, p0, p1, dp, o0, o1, dO) => {
      let best = null
      for (let P = p0; P <= p1; P += dp) {
        const hi = Math.min(o1, arr.length - 1 - n * P)
        for (let o = Math.max(0, o0); o <= hi; o += dO) {
          let s = 0
          for (let k = 0; k <= n; k++) s += at(arr, o + k * P)
          for (let k = 0; k < n; k++) s -= at(arr, o + (k + 0.5) * P)
          if (!best || s > best.s) best = { P, o, s }
        }
      }
      return best
    }
    const coarse = run(band(raw, 6), pMin, pMax, 0.2, oMin, oMax, 2)
    if (!coarse) return null
    const fineArr = band(raw, 2)
    const best = run(fineArr, coarse.P - 0.4, coarse.P + 0.4, 0.01, coarse.o - 8, coarse.o + 8, 0.25) ?? coarse
    const teeth = []
    const mids = []
    for (let k = 0; k <= n; k++) teeth.push(at(fineArr, best.o + k * best.P))
    for (let k = 0; k < n; k++) mids.push(at(fineArr, best.o + (k + 0.5) * best.P))
    return { ...best, teeth, mids }
  }

  // 第一輪：整張圖的投影 → 先定直行；再只看格區的 x 範圍定橫列；最後只看格區的 y 範圍重定直行
  // 行距的合理範圍：公版是 A3 橫式、格區 38 格 → 整張掃進來時行距≈寬度的 2.4%；
  //   掃描被裁到只剩格區時上限＝寬度/38。下限取 1.8%（格區至少佔圖寬 68%）。
  let pj = project(0, W, 0, H)
  let cx = comb(pj.col, wantCols, W * 0.018, (W - 1) / wantCols, 0, W)
  if (!cx) return null
  const xr = (c) => [Math.max(0, Math.floor(c.o)), Math.min(W, Math.ceil(c.o + wantCols * c.P))]
  pj = project(...xr(cx), 0, H)
  let cy = comb(pj.row, wantRows, cx.P * 0.96, Math.min(cx.P * 1.04, (H - 1) / wantRows), 0, H)
  if (!cy) return null
  const yr = [Math.max(0, Math.floor(cy.o)), Math.min(H, Math.ceil(cy.o + wantRows * cy.P))]
  pj = project(0, W, yr[0], yr[1])
  cx = comb(pj.col, wantCols, cx.P * 0.98, cx.P * 1.02, cx.o - cx.P * 0.5, cx.o + cx.P * 0.5) ?? cx
  pj = project(...xr(cx), 0, H)
  cy = comb(pj.row, wantRows, cy.P * 0.98, cy.P * 1.02, cy.o - cy.P * 0.5, cy.o + cy.P * 0.5) ?? cy

  // ── 守門：抓錯比抓不到危險（少一行＝整段文字無聲消失）──
  const gridW = wantCols * cx.P
  const gridH = wantRows * cy.P
  // 每根齒的「線證據」＝那條線上的平均綠色強度（每像素、已除以格區邊長）。
  // 守門看的是**相對**量（齒 vs 兩側齒縫），不是絕對值——不同掃描器、不同印刷的綠線深淺差很多。
  const evX = cx.teeth.map((v) => v / gridH)
  const evY = cy.teeth.map((v) => v / gridW)
  const bgX = cx.mids.map((v) => v / gridH)
  const bgY = cy.mids.map((v) => v / gridW)
  const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length
  const reasons = []
  // ① 整體沒有綠線（誤拿會考的粉紅稿紙、灰階掃描）→ 回 null，不可硬湊一個位置出來
  //    綠線每像素強度即使很淡也有 ~1 以上（±2 帶寬加總），紙白／粉紅／灰階趨近 0
  if (mean(evX) < 0.6 || mean(evY) < 0.6) {
    if (!opts.debug) return null
    reasons.push(`整體綠線證據不足（直 ${mean(evX).toFixed(2)}／橫 ${mean(evY).toFixed(2)}）`)
  }
  // ② 梳子真的壓在線上時，線上的綠遠高於格心（格心只有浮水印的淡綠底）
  if (mean(evX) < mean(bgX) * 2) reasons.push('直格線與格心的對比不足，定位不可靠')
  if (mean(evY) < mean(bgY) * 2) reasons.push('橫格線與格心的對比不足，定位不可靠')
  // ③ 逐條檢查：某條線不比兩側格心亮＝那個位置其實沒有線（掃描裁到格區、或整把梳子偏了一格）
  const weak = (ev, bg) => ev.filter((v, k) => {
    const nb = [bg[k - 1], bg[k]].filter((x) => x != null)
    return v < mean(nb) * 1.3 + 0.05
  }).length
  const weakX = weak(evX, bgX)
  const weakY = weak(evY, bgY)
  // 個別線被筆跡整條蓋住是可能的，容許極少數；超過就不放行
  if (weakX > 2) reasons.push(`有 ${weakX} 條直格線在預期位置找不到（應為 ${wantCols + 1} 條）——掃描可能裁到格區，或不是學測公版答題卷`)
  if (weakY > 1) reasons.push(`有 ${weakY} 條橫格線在預期位置找不到（應為 ${wantRows + 1} 條）——掃描可能裁到格區，或不是學測公版答題卷`)
  // ④ 最外圈的四條框線一定要在：少了任何一條＝梳子偏一格或掃描被裁，這是「整行／整列文字無聲消失」的來源
  const edgeOk = (ev, bg) => ev[0] >= bg[0] * 1.3 + 0.05 && ev[ev.length - 1] >= bg[bg.length - 1] * 1.3 + 0.05
  if (!edgeOk(evX, bgX)) reasons.push('格區最左或最右的框線找不到——梳子可能偏了一格，或掃描裁到格區')
  if (!edgeOk(evY, bgY)) reasons.push('格區最上或最下的框線找不到——梳子可能偏了一格，或掃描裁到格區')

  // cols 由右至左＝書寫順序（與會考那支回傳的結構一致）
  const cols = []
  for (let i = 0; i < wantCols; i++) {
    const xLeft = cx.o + (wantCols - 1 - i) * cx.P
    cols.push({ x: xLeft / W, y: cy.o / H, w: cx.P / W, h: gridH / H })
  }
  const out = { rows: wantRows, cols, detectedCols: wantCols, incomplete: reasons.length > 0, reasons, measure }
  // 只給回歸／診斷腳本用（production 不帶 debug）
  if (opts.debug) out._debug = { W, H, colPitch: cx.P, rowPitch: cy.P, x0: cx.o, y0: cy.o, evX, evY, bgX, bgY, measure }
  return out
}

// ═══ 2026-09-22 自備稿紙「疊合」定位（user 拍板：老師上傳題本＋空白稿紙 → 疊合 → 套 bbox）═══
//   老師在空白稿紙上框格區＋填行列數（公版一鍵帶入）→ 存成 essay.template.grids（模板頁 normalized）；
//   批改時每頁：疊合服務（registration-service，SIFT+RANSAC）把模板格子投到學生卷 → 窄範圍校正 → 守門。
//   實測（local-only/essay/_register_exp.py）：學測 6 份原卷 6/6、每格誤差中位 0.01~0.07 格、黑白掃描結果相同。
//   ⛔ 作文參數與一般卷不同：min_consistency=0（每格都有字，對空白模板格的 NCC 一致率必低）、
//     snap='none'（吸附交給我們自己的窄範圍校正）、逐格送（整行細長框判不了）、min_structure=0.12（服務預設 0.25 會擋掉
//     淡線／黑白的稿紙，實測 2-4 灰階 0.12~0.23；結構分只是粗篩，真正的守門是下面的格線驗證）。
//   失敗（沒設 URL／服務掛／守門不過）→ 退回原本的格線偵測，行為與過去相同。

/** 模板某頁的格子（模板頁 normalized）：由老師框的格區＋行列數均分。第 1 行在最右邊；窄欄在每行右側 */
export function essayTemplateCells(g, pageIdx) {
  const grids = Array.isArray(g?.template?.grids) ? g.template.grids : []
  const grid = grids.find((x) => Number(x?.page) === pageIdx + 1) ?? grids[0]
  const box = grid?.box
  if (!box || !(box.w > 0) || !(box.h > 0)) return null
  const cols = g.cols, rows = g.rows
  const pitch = box.w / cols
  const ratio = Number(g.template?.gutterRatio) > 0 && Number(g.template.gutterRatio) <= 1 ? Number(g.template.gutterRatio) : 1
  const cellW = pitch * ratio
  const cellH = box.h / rows
  const out = []
  for (let c = 1; c <= cols; c++) {
    const right = box.x + box.w - (c - 1) * pitch
    for (let r = 1; r <= rows; r++) {
      out.push({ id: `c${c}r${r}`, page: 0, bbox: { x: right - pitch, y: box.y + (r - 1) * cellH, w: cellW, h: cellH }, manual: true })
    }
  }
  return { cells: out, pitch, ratio, cellH, box }
}

/** 呼叫疊合服務（單頁）。回 Map id→bbox（該頁 normalized）或 null */
export async function registerEssayPage(pageBuffer, templateB64, cells, log) {
  const url = process.env.REGISTRATION_URL
  if (!url || process.env.REGISTRATION_ENABLED === '0' || !templateB64 || !cells?.length) return null
  const timeoutMs = Number(process.env.REGISTRATION_TIMEOUT_MS) || 30000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    // 服務內部統一縮到寬 1200 處理，送 webp q85 即可（3240px 的 png 轉 base64 會到 10MB）
    const stu = (await sharp(pageBuffer).webp({ quality: 85 }).toBuffer()).toString('base64')
    const resp = await fetch(`${url.replace(/\/$/, '')}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ template_id: 'essay', template_pages: [templateB64], boxes: cells.map(({ id, page, bbox, manual }) => ({ id, page, bbox, manual })), student_image: stu, page_breaks: null, min_consistency: 0, snap: 'none', min_structure: 0.12 }),
    })
    if (!resp.ok) { log(`[Essay] 疊合服務回 ${resp.status} → 退回格線偵測`); return null }
    const data = await resp.json()
    const pg = data?.pages?.[0]
    if (data?.decision !== 'aligned' || !Array.isArray(data.boxes) || !data.boxes.length) {
      log(`[Essay] 疊合退回格線偵測：${data?.reason || 'no boxes'}（inliers ${pg?.inliers ?? '?'}、${Date.now() - t0}ms）`)
      return null
    }
    log(`[Essay] 疊合成功 ${data.boxes.length} 格（inliers ${pg?.inliers}、structure ${pg?.structure}、${Date.now() - t0}ms）`)
    return { boxes: new Map(data.boxes.map((b) => [b.id, b.bbox])), inliers: Number(pg?.inliers) || 0, structure: Number(pg?.structure) || 0 }
  } catch (err) {
    log(`[Essay] 疊合例外 ${err?.name === 'AbortError' ? 'timeout' : err?.message} → 退回格線偵測`)
    return null
  } finally { clearTimeout(timer) }
}

/**
 * 投影後的窄範圍校正＋守門：把疊合投出來的格子整理成「等距的行線＋等距的列線」，再用學生卷自己的長直線暗度
 * 在 ±0.3 格內把每條線吸到實際印刷線上（顏色無關，黑白也行）；吸到的線太少或吸完偏太多＝疊合不可信 → 回 null。
 * @returns byId（cN／cNrM，normalized）或 null
 */
export async function refineProjectedGrid(pageBuffer, g, tpl, projected, log) {
  const { data, info } = await sharp(pageBuffer).raw().toBuffer({ resolveWithObject: true })
  const W = info.width, H = info.height, ch = info.channels
  const cols = g.cols, rows = g.rows
  // 每行的右緣（第 1 行最右）＝ c{i}r* 的 x+w 最大值；上下界＝所有格的 y 極值
  const rights = [], lefts = [], tops = [], bottoms = []
  for (let c = 1; c <= cols; c++) {
    let r0 = -Infinity, l0 = Infinity
    for (let r = 1; r <= rows; r++) {
      const b = projected.get(`c${c}r${r}`)
      if (!b) return null
      // 投影的是「字格」（寬＝pitch×ratio）；行的右緣＝字格右緣＋窄欄
      const right = (b.x + b.w) * W + (1 - tpl.ratio) * (b.w / tpl.ratio) * W
      r0 = Math.max(r0, right); l0 = Math.min(l0, b.x * W)
      if (r === 1) tops.push(b.y * H)
      if (r === rows) bottoms.push((b.y + b.h) * H)
    }
    rights.push(r0); lefts.push(l0)
  }
  // 最小平方擬合等距線：x_k = o − k·P（k=0..cols；k=cols＝最後一行左緣）
  const fit = (pts) => { // pts: [[k, v]]
    const n = pts.length
    let sk = 0, sv = 0, skk = 0, skv = 0
    for (const [k, v] of pts) { sk += k; sv += v; skk += k * k; skv += k * v }
    const P = (n * skv - sk * sv) / (n * skk - sk * sk)
    return { o: (sv - P * sk) / n, P }
  }
  const xPts = rights.map((v, i) => [i, v]); xPts.push([cols, lefts[cols - 1]])
  const fx = fit(xPts)            // fx.P 為負（往左）
  const yTop = tops.reduce((a, b) => a + b, 0) / tops.length
  const yBot = bottoms.reduce((a, b) => a + b, 0) / bottoms.length
  const fy = { o: yTop, P: (yBot - yTop) / rows }
  const pitch = -fx.P
  if (!(pitch > 4) || !(fy.P > 4)) return null

  // 學生卷自己的證據：**純暗度**投影（紙白 0、上限 40）。⛔ 不可用長直線濾波：學測淡綠線縮圖後斷成 ≤46px 的小段，
  //   逐像素欄的連續段全部不到門檻、證據圖整片是 0（實測 2-1／2-4）。這裡只在已知位置 ±0.3 格內找峰、
  //   而且要求峰值 ≥ 窗內平均 ×1.3，筆跡散在格子中間、不會在格線位置形成整條的峰，純暗度就夠用（實測比值 1.3~3.3）。
  //   直行投影只看格區 y 範圍、橫列只看 x 範圍。
  const y0 = Math.max(0, Math.floor(fy.o)), y1 = Math.min(H, Math.ceil(fy.o + rows * fy.P))
  const x1 = Math.min(W, Math.ceil(fx.o)), x0 = Math.max(0, Math.floor(fx.o - cols * pitch))
  // ⛔ 純暗度也不行：寫滿的頁，直豎筆畫在 ±0.3 格內比淡線還暗，峰被筆跡搶走（實測平移被拉 0.3 格）。
  //   證據＝「淡線帶通」（亮度 115~207：印刷淡線在這一段、墨水 <115 排除、紙白 >207 排除）
  //       ＋「長直線暗度」（黑白影印的實線是黑的、會被帶通排除，但它是整條直線，靠這個補）。
  const lr = longRunDarkness(data, W, H, ch, Math.max(24, Math.round(fy.P * 1.2)))
  const N = W * H
  const lum = new Uint8Array(N)
  const hist = new Uint32Array(256)
  for (let i = 0, p = 0; i < N; i++, p += ch) { const l = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8; lum[i] = l; hist[l]++ }
  let acc = 0, paper = 250
  for (let l = 0; l < 256; l++) { acc += hist[l]; if (acc >= N * 0.8) { paper = l; break } }
  // 淡線帶的上限跟紙白相對（實測 2-4 的綠線亮度中位 232、紙 255；寫死 207 會把它排掉）
  const faintHi = Math.min(240, paper - 8)
  // ⛔ 墨水暈圈排除：深色筆畫的抗鋸齒邊緣亮度也落在淡線帶（實測 2-4 深咖啡色墨、字大，暈圈在離格線 22px 處形成假峰）。
  //   做法：亮度 <110 的像素（墨）往四周膨脹 5px 當排除遮罩，淡線證據只算遮罩外的像素。
  const R = 5
  const ink = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (lum[i] < 110) ink[i] = 1
  const ex = new Uint8Array(N)
  for (let y = 0; y < H; y++) { const base = y * W; let last = -1e9; for (let x = 0; x < W; x++) { if (ink[base + x]) last = x; if (x - last <= R) ex[base + x] = 1 } last = 1e9; for (let x = W - 1; x >= 0; x--) { if (ink[base + x]) last = x; if (last - x <= R) ex[base + x] = 1 } }
  for (let x = 0; x < W; x++) { let last = -1e9; for (let y = 0; y < H; y++) { const i = y * W + x; if (ink[i]) last = y; if (y - last <= R) ex[i] = 1 } last = 1e9; for (let y = H - 1; y >= 0; y--) { const i = y * W + x; if (ink[i]) last = y; if (last - y <= R) ex[i] = 1 } }
  const colProf = new Float64Array(W), rowProf = new Float64Array(H)
  for (let y = 0; y < H; y++) {
    const base = y * W
    const inY = y >= y0 && y < y1
    let rs = 0
    for (let x = 0; x < W; x++) {
      const i = base + x
      const l = lum[i]
      const v = !ex[i] && l >= 115 && l <= faintHi ? Math.min(40, 250 - l) : 0
      if (inY) { const u = lr.vert[i]; colProf[x] += v + (u || 0) }
      if (x >= x0 && x < x1) { const u = lr.horz[i]; rs += v + (u || 0) }
    }
    rowProf[y] = rs
  }
  const band = (arr, i, half) => { let s = 0; for (let k = -half; k <= half; k++) { const j = i + k; if (j >= 0 && j < arr.length) s += arr[j] } return s }
  // 每條預期線：±0.3 格內找峰；峰要明顯高於 ±0.5 格窗內的平均才算「吸到」
  // pair＝有窄欄的稿紙：每行右緣往左 pair px 還有一條窄欄線（會考 0.2 行距）。⛔ 單線吸附會在兩條線之間亂吸
  //   （09-22 實測：各行隨機吸到不同那條、擬合落在中間、整片偏 12px、黑白影印的深灰線落進格子被當墨跡）。
  //   成對比對：候選偏移 d 的分數＝證據(右緣+d)＋證據(右緣−pair+d)，吸錯一條只拿到一半分數，正確的 d 才是峰。
  const snapLines = (prof, expect, step, dbg = null, pair = 0) => {
    const hits = []
    for (let k = 0; k < expect.length; k++) {
      const e = expect[k]
      const lo = Math.round(e - 0.3 * step), hi = Math.round(e + 0.3 * step)
      const ev = (i) => band(prof, i, 2) + (pair > 0 && k < expect.length - 1 ? band(prof, Math.round(i - pair), 2) : 0)
      let best = -1, bv = 0, sum = 0, n = 0
      for (let i = Math.round(e - 0.5 * step); i <= Math.round(e + 0.5 * step); i++) { if (i < 0 || i >= prof.length) continue; const v = ev(i); sum += v; n++; if (i >= lo && i <= hi && v > bv) { bv = v; best = i } }
      const mean = n ? sum / n : 0
      if (dbg && (k === 0 || k === expect.length - 1)) dbg.push(`k${k}@${e.toFixed(0)}: peak ${bv.toFixed(0)}@${best} mean ${mean.toFixed(0)}`)
      if (best >= 0 && bv > 0 && bv >= mean * 1.3) hits.push([k, best])
    }
    return hits
  }
  const expectX = Array.from({ length: cols + 1 }, (_, k) => fx.o - k * pitch)
  const expectY = Array.from({ length: rows + 1 }, (_, k) => fy.o + k * fy.P)
  const dbg = []
  const hx = snapLines(colProf, expectX, pitch, dbg, tpl.ratio < 0.98 ? pitch * (1 - tpl.ratio) : 0)
  const hy = snapLines(rowProf, expectY, fy.P, dbg)
  let ox = fx.o, px = pitch, oy = fy.o, py = fy.P
  let used = 'projection'
  // ⛔ 格區的四條外框線一定要吸到：純格子上 SIFT 若鎖到「整把偏一格」，內部線照樣對得上（週期結構），
  //   只有外框線會落在沒線的地方。內部線吸到 ≥30% 即可（淡線、被字蓋住都正常）。
  const hasK = (hits, k) => hits.some(([kk]) => kk === k)
  const edgesOk = hasK(hx, 0) && hasK(hx, cols) && hasK(hy, 0) && hasK(hy, rows)
  if (edgesOk && hx.length >= Math.ceil((cols + 1) * 0.3) && hy.length >= Math.ceil((rows + 1) * 0.3)) {
    // ⛔ 不用最小平方重新擬合行距：命中的峰會被筆跡拉歪（實測校正後誤差從 0.02~0.10 格變 0.16~0.38）。
    //   投影本身已經很準（每格 ≤0.1 格），這裡只做兩件事：①驗證（外框＋內部線吸得到）②用命中線偏移的**中位數**做整體平移。
    const med = (arr) => { const v = [...arr].sort((p, q) => p - q); return v.length ? v[v.length >> 1] : 0 }
    // ⛔ 行數／每行格數填錯的守門（09-22 user 把會考稿紙填成 23×20：外框照樣吸到、內部線也吸到 17/21 → 放行 → 整份格子錯）。
    //   「吸到的線擬合間距」抓不到這種錯（吸附只在預期位置 ±0.3 格找，間距錯 10% 也會被就近吸掉）→ 直接**數**格區內有幾條線：
    //   外框之間的峰數必須＝行數＋1／列數＋1（±1）。直行有窄欄時字格右緣與窄欄線相距 0.2 行距 → 用 0.6 行距的最小間距把它們併成一個峰。
    const countPeaks = (prof, a, b, minSep) => {
      const lo = Math.round(Math.min(a, b)), hi = Math.round(Math.max(a, b))
      let mx = 0
      for (let i = lo; i <= hi; i++) mx = Math.max(mx, band(prof, i, 2))
      const thr = mx * 0.25
      const peaks = []
      for (let i = lo; i <= hi; i++) {
        const v = band(prof, i, 2)
        if (v < thr) continue
        let isMax = true
        for (let k = 1; k <= 3; k++) { if (band(prof, i - k, 2) > v || band(prof, i + k, 2) > v) { isMax = false; break } }
        if (!isMax) continue
        if (peaks.length && i - peaks[peaks.length - 1].i < minSep) { if (v > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = { i, v }; continue }
        peaks.push({ i, v })
      }
      return peaks.length
    }
    const nX = countPeaks(colProf, hx.find(([k]) => k === 0)[1], hx.find(([k]) => k === cols)[1], pitch * 0.6)
    const nY = countPeaks(rowProf, hy.find(([k]) => k === 0)[1], hy.find(([k]) => k === rows)[1], fy.P * 0.5)
    if (Math.abs(nX - (cols + 1)) > 1 || Math.abs(nY - (rows + 1)) > 1) {
      log(`[Essay] 格區內數到 ${nX} 條直線、${nY} 條橫線，與稿紙設定（${cols} 行、${rows} 格）不符 → 行數／每行格數可能填錯`)
      const err = new Error(`稿紙設定與學生卷不符：格區內數到 ${nX - 1} 行、每行 ${nY - 1} 格，但答案卷填的是 ${cols} 行、每行 ${rows} 格——請到答案卷編輯稿紙設定（行數／每行格數／窄欄）`)
      err.code = 'ESSAY_SHEET_MISMATCH'
      throw err
    }
    // 校正：吸到 ≥60% 的線 → 用最小平方重擬「間距＋位移」（老師框的格區有 1~2% 誤差時，行距累積到最後一行會偏 0.3 格，
    //   黑白影印的深灰格線就落進字格被當成墨跡）；不足 60% 只做中位平移。
    //   ⛔ 擬合的證據已排除墨水（淡線帶通＋墨水膨脹排除），之前「被筆跡拉歪」是純暗度時代的事。仍守門：間距差 ≤4%、位移 ≤0.4 格。
    const dx = med(hx.map(([k, v]) => v - expectX[k]))
    const dy = med(hy.map(([k, v]) => v - expectY[k]))
    if (Math.abs(dx) > pitch * 0.4 || Math.abs(dy) > fy.P * 0.4) {
      log(`[Essay] 疊合校正平移過大（${dx.toFixed(1)}, ${dy.toFixed(1)}px）→ 疊合不可信`)
      return null
    }
    ox = fx.o + dx; oy = fy.o + dy
    let how = 'shift'
    if (hx.length >= Math.ceil((cols + 1) * 0.6)) { const r = fit(hx); if (Math.abs(-r.P - pitch) <= pitch * 0.04) { ox = r.o; px = -r.P; how = 'fit' } }
    if (hy.length >= Math.ceil((rows + 1) * 0.6)) { const r = fit(hy); if (Math.abs(r.P - fy.P) <= fy.P * 0.04) { oy = r.o; py = r.P; how += '+fit' } }
    used = `verified ${hx.length}/${cols + 1}×${hy.length}/${rows + 1}, ${how}, shift ${dx.toFixed(1)},${dy.toFixed(1)}px, pitch ${pitch.toFixed(1)}→${px.toFixed(1)}/${fy.P.toFixed(1)}→${py.toFixed(1)}`
  } else {
    // 吸不到一半以上的線：投影本身可能就偏了（純格子沒特徵時 SIFT 會鎖錯）→ 不敢用
    log(`[Essay] 疊合後吸到 ${hx.length}/${cols + 1} 條直線、${hy.length}/${rows + 1} 條橫線、外框${edgesOk ? '齊' : '缺'} → 疊合不可信；外框證據 ${dbg.join(" ｜ ")}`)
    return null
  }
  // 格區必須落在圖內（含 2% 餘裕）
  if (ox > W * 1.02 || ox - cols * px < -W * 0.02 || oy < -H * 0.02 || oy + rows * py > H * 1.02) return null
  // 列高／行距比例要像稿紙（10mm 格：會考 0.8、學測 1.0）；差 15% 以上＝投影歪了
  const expectRatio = tpl.ratio
  if (Math.abs(py / px - expectRatio) > 0.15 * expectRatio) { log(`[Essay] 列高/行距 ${(py / px).toFixed(2)} 不像稿紙（應≈${expectRatio}）→ 疊合不可信`); return null }
  const byId = new Map()
  const cellW = px * tpl.ratio
  for (let c = 1; c <= cols; c++) {
    const right = ox - (c - 1) * px
    byId.set(`c${c}`, { x: (right - px) / W, y: oy / H, w: px / W, h: (rows * py) / H })
    for (let r = 1; r <= rows; r++) byId.set(`c${c}r${r}`, { x: (right - px) / W, y: (oy + (r - 1) * py) / H, w: cellW / W, h: py / H })
  }
  log(`[Essay] 疊合定位採用（${used}；行距 ${px.toFixed(1)}px、列高 ${py.toFixed(1)}px）`)
  return byId
}

/** 退回格線偵測時用哪一支：學測公版／無窄欄的自備稿紙＝梳子；會考公版／有窄欄＝串鏈 */
function fallbackDetectorFormat(g) {
  if (g.sheet === 'gsat') return 'gsat'
  // 自備稿紙一律走會考型串鏈偵測（它本來就同時處理「字格＋窄欄」與「均勻格線」，而且有灰階後備）；
  //   梳子那支只認學測公版的綠線，黑白影印會直接死（09-22 user 的自備會考卷第 2 頁就是這樣報錯）。
  if (g.sheet === 'custom') return undefined
  return g.format === 'gsat' ? 'gsat' : undefined
}

/** 自備稿紙：偵測到的格線 → 與錨點版同樣的 byId 結構（cN＝整行、cNrM＝單格） */
async function detectGridBoxes(pageBuffer, g) {
  // format 只來自版面資料裡明確寫的欄位（學測模式建卷時寫 'gsat'）；沒寫＝會考，行為與過去完全相同
  const grid = await detectEssayGridOnPage(pageBuffer, { cols: g.cols, rows: g.rows, format: fallbackDetectorFormat(g) })
  if (!grid) {
    throw new Error(fallbackDetectorFormat(g) === 'gsat'
      ? '這一頁找不到學測稿紙的綠色格線——請用彩色掃描（黑白掃描或影印的公版卷目前抓不到格線）、整張掃進去不要裁到格區，或改用系統製作的作文稿紙'
      : '這一頁找不到稿紙的格線——請確認掃描完整、格線清楚，或改用系統製作的作文稿紙')
  }
  // ⛔ 抓不全一定要擋：少抓的行會讓整段文字無聲消失，比直接失敗危險得多
  if (grid.incomplete) {
    throw new Error(g.sheet === 'custom'
      ? `這一頁的稿紙格線與答案卷的稿紙設定對不起來（${grid.reasons.join('；')}）——請確認稿紙設定的行數／每行格數／窄欄是否與這張稿紙相同，並整張掃進去不要裁到格線`
      : `這一頁的稿紙格線抓得不完整（${grid.reasons.join('；')}）——格線太淡或掃描不清，請提高掃描品質、整張掃進去不要裁到格線，或改用系統製作的作文稿紙`)
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
// 2026-09-22 墨跡門檻改成「紙白相對」：user 用黑白影印稿紙＋鉛筆寫的真卷，筆畫亮度 150~190、
//   寫死 <110 一格都抓不到（整份被判空白）。實測寫了字的格 <190 佔 2~17%、空格（內縮 15% 後）0%。
//   門檻＝min(190, 紙白−40)；內縮 12%→15%（黑白影印的格線是深灰、要多避一點）。ESSAY_INK_MODE=old 退回。
function cellHasInk(raw, W, H, rect, darkThreshold = 110, ratio = 0.004, inset = 0.12) {
  const x0 = Math.max(0, Math.round(rect.x * W))
  const y0 = Math.max(0, Math.round(rect.y * H))
  const x1 = Math.min(W, Math.round((rect.x + rect.w) * W))
  const y1 = Math.min(H, Math.round((rect.y + rect.h) * H))
  // 內縮：避開印刷格線本身
  const padX = Math.round((x1 - x0) * inset)
  const padY = Math.round((y1 - y0) * inset)
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
 * 把「同一頁、連號的數行」裁成一張圖（合成抄寫用）。
 * ⛔ col 越大越靠左（直書由右往左）→ 左界取 group 最後一行、右界取第一行。
 * bbox 已經是**合併圖**的 normalized 座標，所以直接對原圖裁就對了，不必再算頁偏移。
 */
export async function cropEssayColumnGroup(imageBuffer, group) {
  if (!group?.length) return ''
  const meta = await sharp(imageBuffer).metadata()
  const W = meta.width
  const H = meta.height
  const leftBox = group[group.length - 1].bbox
  const rightBox = group[0].bbox
  const left = Math.max(0, Math.round(leftBox.x * W))
  const top = Math.max(0, Math.round(rightBox.y * H))
  const width = Math.min(W - left, Math.round((rightBox.x + rightBox.w - leftBox.x) * W))
  const height = Math.min(H - top, Math.round(rightBox.h * H))
  if (width < 4 || height < 4) return ''
  const png = await sharp(imageBuffer).extract({ left, top, width, height }).png().toBuffer()
  return png.toString('base64')
}

/**
 * 行首縮排改由程式決定：行首連續幾格沒墨跡就是空幾格。
 * ⛔ 不能靠 AI 抄——逐格輸出會直接吃掉行首空格，段落就被黏在一起
 *   （分段判準是 columnsToParagraphs 的 /^[\s　]+/）。
 */
export function applyColumnIndent(text, inkRows) {
  const body = String(text ?? '').replace(/^[\s　]+/, '')
  if (!body || !Array.isArray(inkRows)) return body
  let lead = 0
  while (lead < inkRows.length && !inkRows[lead]) lead++
  if (lead >= inkRows.length) return body
  return '　'.repeat(lead) + body
}

/**
 * 這份作文卷要批哪幾頁（1 起算）。沒有 items＝全部頁都是同一篇（會考），回 null 表示不限制。
 *
 * 2026-09-21 學測國寫：一張答題卷上有**不只一篇**（正面第一大題、背面第二大題），
 *   版面資料用 essay.items 描述「哪一項寫在哪幾頁」。會考沒有 items → 行為與過去完全相同。
 * ⛔ 目前只支援**一個** item（第一階段只批第二大題）。多個 item 需要逐項分開抄寫／眉批／評分，
 *   那一段還沒做——這裡直接擋下，不可以默默把多篇合成一篇批（那正是高中自備卷一直被鎖住的原因）。
 */
export function essayGradedPages(g) {
  const items = Array.isArray(g?.items) ? g.items : null
  if (!items || !items.length) return null
  if (items.length > 1) throw new Error('這份作文卷有多個寫作題，目前只支援一題（多題分開批改尚未開放）')
  const pages = (Array.isArray(items[0]?.pages) ? items[0].pages : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= g.pages)
  if (!pages.length) throw new Error('作文卷的寫作題沒有指定頁面（essay.items[0].pages）')
  return new Set(pages)
}

/**
 * 學生卷 → 逐直行裁圖＋每行的「有墨格數」。
 * @returns {Promise<{columns: Array<{page:number,col:number,pngBase64:string,inkCells:number,inkRows:boolean[],blank:boolean}>, pages:number}>}
 */
export async function cutEssayColumns(imageBuffer, layout, pageBreaks, opts = {}) {
  if (!isEssayLayout(layout)) throw new Error('不是作文稿紙版面')
  const g = layout.essay
  const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m)
  // 老師上傳的空白稿紙頁圖（base64、依頁序）——proxy 從 answer_sheet_image_paths 抓；沒有＝不疊合
  const templatePages = Array.isArray(opts.templatePages) ? opts.templatePages : []
  let pageBufs = await splitPages(imageBuffer, pageBreaks)
  // 2026-09-22 只掃了一頁（學測情意題常見：學生只寫一面、老師只掃那一面）：
  //   合併圖的長寬比就是一頁橫式稿紙（B4 257/364、A3 297/420 都 ≈0.707；兩頁上下疊 ≈1.41）
  //   → 當作只有第 1 頁，缺的頁直接跳過（等同該頁空白）。⛔ 以前是平均切→把一頁劈成兩半→格線找不到→整份失敗。
  const meta = await sharp(imageBuffer).metadata()
  const aspect = meta.width && meta.height ? meta.height / meta.width : 0
  //   判準用「高<寬」：一頁橫式稿紙不管怎麼裁邊都是扁的（實測掃描檔 0.59~0.71），兩頁上下疊一定 >1.2
  const onePage = pageBufs.length === 1 && aspect > 0 && aspect < 1.0
  if (onePage && g.pages > 1) {
    console.log(`[Essay] 只收到 1 頁（長寬比 ${aspect.toFixed(3)}）、稿紙有 ${g.pages} 頁 → 缺的頁當空白`)
  } else if (pageBufs.length < g.pages) {
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
  // 每頁定位方式（給前端複核面板顯示，user 09-22：驗收要看得到走了哪一條）
  const locate = []
  const graded = essayGradedPages(g)
  if (graded && ![...graded].some((p) => pageBufs[p - 1])) throw new Error(`這份只掃到 ${pageBufs.length} 頁，但要批的是第 ${[...graded].join('、')} 頁——請確認正反面都掃進來了`)
  for (let p = 0; p < g.pages; p++) {
    if (!pageBufs[p]) continue
    // 不在批改範圍的頁整頁跳過：不偵測格線、不裁行、不產生任何 column
    //   （學測第一階段只批背面的第二大題；正面的第一大題是另一篇文章，混進來會被當成同一篇批）
    if (graded && !graded.has(p + 1)) continue
    const { buf, y0: pageY0, y1: pageY1 } = pageBufs[p]
    const pageSpan = pageY1 - pageY0
    // 自備稿紙：①疊合到老師的空白稿紙（有模板才做）②失敗退回在學生卷上偵測印刷格線（純 code；102 張真實樣卷 100%）
    let byId = null
    if (byoMode && g.template && templatePages.length) {
      // 兩頁都掃＝頁序對應模板頁；只掃一頁時不知道是正面還背面（公版正反面格區位置差一格）→ 每頁都試、取 inliers 最高
      const cand = onePage ? templatePages.map((_, i) => i).sort((a, b) => (a === p ? -1 : b === p ? 1 : a - b)) : [Math.min(p, templatePages.length - 1)]
      let best = null
      for (const ti of cand) {
        const tpl = essayTemplateCells(g, ti)
        if (!tpl || !templatePages[ti]) continue
        const reg = await registerEssayPage(buf, templatePages[ti], tpl.cells, log)
        if (reg && (!best || reg.inliers > best.reg.inliers)) best = { reg, tpl, ti }
      }
      if (best) {
        if (cand.length > 1) log(`[Essay] 模板第 ${best.ti + 1} 頁疊合最好（inliers ${best.reg.inliers}）`)
        // 稿紙設定與學生卷不符（行數／格數填錯）是老師要改設定的事，直接往上丟、不退回偵測（偵測也會用同一組錯的行列數）
        byId = await refineProjectedGrid(buf, g, best.tpl, best.reg.boxes, log)
      }
    }
    locate.push({ page: p + 1, method: byId ? 'registration' : byoMode ? 'grid' : 'anchor' })
    if (!byId) byId = byoMode ? await detectGridBoxes(buf, g) : (await alignColumns(buf, layout)).byId
    const { data: gray, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true })
    const W = info.width
    const H = info.height
    // 紙白（亮度第 80 百分位）→ 墨跡門檻（見 cellHasInk 註解）
    let inkThr = 110, inkInset = 0.12
    if (process.env.ESSAY_INK_MODE !== 'old') {
      const hist = new Uint32Array(256)
      for (let i = 0; i < gray.length; i++) hist[gray[i]]++
      let acc = 0, paper = 250
      for (let l = 0; l < 256; l++) { acc += hist[l]; if (acc >= gray.length * 0.8) { paper = l; break } }
      inkThr = Math.max(110, Math.min(190, paper - 40)); inkInset = 0.15
    }
    for (let c = 1; c <= g.cols; c++) {
      // ⭐ 逐格墨跡本來就算過，只是以前只留總數。留下每一格的結果，
      //   行首縮排就能純用程式決定（行首連續幾格沒墨跡＝空幾格），不必靠 AI 抄——
      //   實測「逐格輸出」的抄寫會直接吃掉行首空格，害段落被黏在一起。
      const inkRows = []
      const inkRatios = []     // 每格墨水密度：塗改／重寫的格子會異常高，可零 AI 標低信心
      for (let r = 1; r <= g.rows; r++) {
        const rect = byId.get(`c${c}r${r}`)
        const ink = rect ? cellHasInk(gray, W, H, rect, inkThr, 0.004, inkInset) : null
        inkRows.push(!!ink?.inked)
        inkRatios.push(ink && ink.total > 0 ? ink.dark / ink.total : 0)
      }
      const inkCells = inkRows.filter(Boolean).length
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
        inkRows,
        inkRatios,
        blank,
        // 這一行在「學生合併圖」上的位置（normalized）→ 檢討單直接照著畫紅字，不必在前端重做對齊
        bbox: { x: rect.x, y: pageY0 + rect.y * pageSpan, w: rect.w, h: rect.h * pageSpan },
      })
    }
  }
  return { columns, pages: g.pages, locate }
}
