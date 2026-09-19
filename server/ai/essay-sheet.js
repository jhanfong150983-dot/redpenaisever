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
  const pageBufs = await splitPages(imageBuffer, pageBreaks)
  if (pageBufs.length < g.pages) {
    throw new Error(`作文卷需要 ${g.pages} 頁，這份只有 ${pageBufs.length} 頁——請確認正反面都掃進來了`)
  }
  const columns = []
  for (let p = 0; p < g.pages; p++) {
    const { buf, y0: pageY0, y1: pageY1 } = pageBufs[p]
    const pageSpan = pageY1 - pageY0
    const { byId } = await alignColumns(buf, layout)
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
