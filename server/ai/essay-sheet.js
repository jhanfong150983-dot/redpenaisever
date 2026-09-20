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
  if (opts.format === 'gsat') return detectGsatGridOnPage(pageBuffer, opts)
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
  //   ④ 行數明顯**多於**預期＝這張根本不是這種稿紙（2026-09-21 卷種隔離）。
  //      原本只擋「少抓」：抓到 38 條線會默默取前 23 條當成功——空白的學測公版卷就這樣被會考偵測器放行。
  //      實測 29 張通過的會考樣卷 detected 全部剛好 23（分佈 14~17／23／null，沒有任何一張 >23），
  //      學測是 38 → 門檻留 2 行餘裕，對正常會考卷零影響（回歸①逐頁簽章一致）。
  if (detected > wantCols + 2) {
    reasons.push(`找到 ${detected} 行格線，明顯多於這種稿紙應有的 ${wantCols} 行——這張可能不是這種稿紙`)
  }
  return { rows: wantRows, cols, detectedCols: detected, incomplete: reasons.length > 0, reasons }
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
async function detectGsatGridOnPage(pageBuffer, opts = {}) {
  const wantCols = opts.cols ?? 38
  const wantRows = opts.rows ?? 22
  const { data, info } = await sharp(pageBuffer).raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  const H = info.height
  const ch = info.channels
  if (!W || !H || ch < 3) return null

  // 綠色強度圖（一次算好，後面在不同範圍上重複投影）。
  // ⛔ 不可用「過門檻才算 1」的二值遮罩：真實掃描的綠線又細又淡（縮圖＋WebP 後 g−max(r,b) 常只有 3~10），
  //   二值化後一條線只剩 ~9% 的像素被算到（實測 115 原卷2-1），證據低到跟雜訊分不開。
  //   改累加**連續的綠色強度** max(0, g−max(r,b))：淡線靠整條線的長度積分出來；
  //   筆跡是灰黑（≈0）、筆跡邊緣的色邊偏紅（負值→0）、紙白≈0，都不貢獻。上限 40 防止少數鮮綠像素獨大。
  const green = new Float32Array(W * H)
  for (let i = 0, p = 0; i < W * H; i++, p += ch) {
    const r = data[p], g = data[p + 1], b = data[p + 2]
    const v = g - (r > b ? r : b)
    if (v > 2 && g > 90) green[i] = v > 40 ? 40 : v
  }
  const project = (x0, x1, y0, y1) => {
    const col = new Float64Array(W)
    const row = new Float64Array(H)
    for (let y = y0; y < y1; y++) {
      const base = y * W
      for (let x = x0; x < x1; x++) { const v = green[base + x]; if (v) { col[x] += v; row[y] += v } }
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
  const out = { rows: wantRows, cols, detectedCols: wantCols, incomplete: reasons.length > 0, reasons }
  // 只給回歸／診斷腳本用（production 不帶 debug）
  if (opts.debug) out._debug = { W, H, colPitch: cx.P, rowPitch: cy.P, x0: cx.o, y0: cy.o, evX, evY, bgX, bgY }
  return out
}

/** 自備稿紙：偵測到的格線 → 與錨點版同樣的 byId 結構（cN＝整行、cNrM＝單格） */
async function detectGridBoxes(pageBuffer, g) {
  // format 只來自版面資料裡明確寫的欄位（學測模式建卷時寫 'gsat'）；沒寫＝會考，行為與過去完全相同
  const grid = await detectEssayGridOnPage(pageBuffer, { cols: g.cols, rows: g.rows, format: g.format })
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
 * 學生卷 → 逐直行裁圖＋每行的「有墨格數」。
 * @returns {Promise<{columns: Array<{page:number,col:number,pngBase64:string,inkCells:number,inkRows:boolean[],blank:boolean}>, pages:number}>}
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
      // ⭐ 逐格墨跡本來就算過，只是以前只留總數。留下每一格的結果，
      //   行首縮排就能純用程式決定（行首連續幾格沒墨跡＝空幾格），不必靠 AI 抄——
      //   實測「逐格輸出」的抄寫會直接吃掉行首空格，害段落被黏在一起。
      const inkRows = []
      const inkRatios = []     // 每格墨水密度：塗改／重寫的格子會異常高，可零 AI 標低信心
      for (let r = 1; r <= g.rows; r++) {
        const rect = byId.get(`c${c}r${r}`)
        const ink = rect ? cellHasInk(gray, W, H, rect) : null
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
  return { columns, pages: g.pages }
}
