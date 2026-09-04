// 2026-09-04 生成作答卷回讀（配套 client answerSheetGenerator.ts 的 RPGEN1 版面）。
//   掃描/照片 → 偵測四個對齊錨點（RPOMR1 標頭上緣兩角標＋頁底兩方塊）→ DLT 解單應性 →
//   依 layoutMeta 的 bbox u/v 反推每格位置 → 透視校正裁出格圖（免 classify 直入 read）。
//   來源：local-only/proto-real-readback.mjs（段4 實體卷驗收：國語 60＋數學 33 格全數乾淨、20 格 read 全對）。
//   ⛔ 鐵律：錨點缺任一角必 throw（請重掃/重拍），不得三點硬算或亂對齊——寧可失敗不可錯裁。

import sharp from 'sharp'

/** 裁圖輸出解析度（px/mm）；8 ≈ production crop 等級 */
const CROP_PX_PER_MM = 8
/** 裁圖外擴（mm），容納壓線筆劃 */
const CROP_PAD_MM = 1.2

// ── DLT 單應性（4 點對應、Gauss-Jordan）────────────────────
function homography(src, dst) {
  const A = []
  const b = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v)
  }
  const n = 8
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return [...M.map((r, i) => r[n] / r[i]), 1]
}

function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8]
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w]
}

// ── 錨點偵測 ────────────────────────────────────────────────
// 四角窗自適應閾值＋連通元件；候選須為實心近方塊。消歧：RPOMR1 標頭有上下兩排角標
// 都可能落在上窗 → 上窗取最上、下窗取最下的合格候選。
function detectAnchorsInGray(gray, W, H, anchorSizeMm, pageMm) {
  const [PW, PH] = pageMm
  const winW = Math.round(W * 0.22)
  const winH = Math.round(H * 0.22)
  const wins = [
    [0, 0, 'TL'],
    [W - winW, 0, 'TR'],
    [0, H - winH, 'BL'],
    [W - winW, H - winH, 'BR']
  ]
  const centers = []
  for (const [wx, wy, label] of wins) {
    const hist = new Uint32Array(256)
    for (let y = 0; y < winH; y++) for (let x = 0; x < winW; x++) hist[gray[(wy + y) * W + wx + x]]++
    let acc = 0
    let thr = 60
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      if (acc > winW * winH * 0.04) { thr = Math.min(v + 15, 140); break }
    }
    const seen = new Uint8Array(winW * winH)
    const cands = []
    for (let y = 0; y < winH; y++) {
      for (let x = 0; x < winW; x++) {
        const idx = y * winW + x
        if (seen[idx] || gray[(wy + y) * W + wx + x] > thr) continue
        let area = 0
        let sx = 0
        let sy = 0
        let minX = 1e9
        let maxX = -1
        let minY = 1e9
        let maxY = -1
        const st = [idx]
        seen[idx] = 1
        while (st.length) {
          const c = st.pop()
          const cy = (c / winW) | 0
          const cx = c % winW
          area++; sx += cx; sy += cy
          if (cx < minX) minX = cx
          if (cx > maxX) maxX = cx
          if (cy < minY) minY = cy
          if (cy > maxY) maxY = cy
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx
            const ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= winW || ny >= winH) continue
            const ni = ny * winW + nx
            if (!seen[ni] && gray[(wy + ny) * W + wx + nx] <= thr) { seen[ni] = 1; st.push(ni) }
          }
        }
        const bw = maxX - minX + 1
        const bh = maxY - minY + 1
        cands.push({ area, fill: area / (bw * bh), squareness: Math.min(bw, bh) / Math.max(bw, bh), cx: wx + sx / area, cy: wy + sy / area })
      }
    }
    const pxPerMMLo = (Math.min(W, H) / PW) * 0.55
    const pxPerMMHi = (Math.max(W, H) / PH) * 1.15
    const areaLo = Math.pow(anchorSizeMm * pxPerMMLo, 2) * 0.4
    const areaHi = Math.pow(anchorSizeMm * pxPerMMHi, 2) * 2.5
    let ok = cands.filter((c) => c.area >= areaLo && c.area <= areaHi && c.fill > 0.6 && c.squareness > 0.55)
    if (!ok.length) {
      const err = new Error(`作答卷 ${label} 角的定位方塊找不到，請確認整張卷（含四角黑色方塊）都入鏡後重新掃描/拍照`)
      err.code = 'ANCHOR_NOT_FOUND'
      err.corner = label
      throw err
    }
    ok = ok.sort((a, b) => (label[0] === 'T' ? a.cy - b.cy : b.cy - a.cy))
    centers.push([ok[0].cx, ok[0].cy])
  }
  return centers
}

/**
 * 生成作答卷回讀：偵測錨點 → 對齊 → 依 bbox 裁出每一格。
 * @param {Buffer} imageBuffer 掃描/照片（任意常見格式；EXIF 方向自動校正）
 * @param {object} layout 產卡時存下的 layoutMeta＋boxes：
 *   { version, pageMm:[w,h], anchorsMm:[[x,y]×4], uvBasis:{x0,y0,w,h}, boxes:[{id,uv:{x,y,w,h}, xyMm:[x,y,w,h]}] }
 * @returns {Promise<{ anchors: number[][], cells: Array<{ id: string, png: Buffer }> }>}
 */
export async function readBackGeneratedSheet(imageBuffer, layout) {
  const { pageMm, anchorsMm, uvBasis, boxes } = layout
  const img = sharp(imageBuffer).rotate()
  const { data: gray, info } = await img.clone().greyscale().raw().toBuffer({ resolveWithObject: true })
  const W = info.width
  const H = info.height
  const anchors = detectAnchorsInGray(gray, W, H, 5, pageMm)
  const anchorUv = anchorsMm.map(([x, y]) => [(x - uvBasis.x0) / uvBasis.w, (y - uvBasis.y0) / uvBasis.h])
  const He = homography(anchorUv, anchors)

  // ── 對齊自檢：投影「標頭下排兩顆角標」（已知 mm 位置的印刷特徵）驗證該處為黑方塊。
  // 防的是：上排角標被遮時，偵測器把下排角標誤當上排 → 靜默錯位（反向測試抓到的漏洞）。
  if (layout.header) {
    const hd = layout.header
    const verifyMm = [
      [hd.x + 2.5, hd.y + hd.h - 2.5],
      [hd.x + hd.w - 2.5, hd.y + hd.h - 2.5]
    ]
    for (const [vx, vy] of verifyMm) {
      const [px, py] = applyH(He, (vx - uvBasis.x0) / uvBasis.w, (vy - uvBasis.y0) / uvBasis.h)
      let sum = 0
      let n = 0
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const sx = Math.round(px + dx)
          const sy = Math.round(py + dy)
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue
          sum += gray[sy * W + sx]
          n++
        }
      }
      if (!n || sum / n > 120) {
        const err = new Error('作答卷對齊檢核失敗（定位方塊可能被遮住或摺到），請攤平整張卷、四角完整入鏡後重新掃描/拍照')
        err.code = 'ALIGNMENT_CHECK_FAILED'
        throw err
      }
    }
  }

  const cells = []
  for (const b of boxes) {
    const [x, y, w, h] = b.xyMm ?? b.xy_mm
    const cw = Math.round((w + 2 * CROP_PAD_MM) * CROP_PX_PER_MM)
    const ch = Math.round((h + 2 * CROP_PAD_MM) * CROP_PX_PER_MM)
    const out = Buffer.alloc(cw * ch, 255)
    for (let py = 0; py < ch; py++) {
      for (let px = 0; px < cw; px++) {
        const mx = x - CROP_PAD_MM + px / CROP_PX_PER_MM
        const my = y - CROP_PAD_MM + py / CROP_PX_PER_MM
        const [sx, sy] = applyH(He, (mx - uvBasis.x0) / uvBasis.w, (my - uvBasis.y0) / uvBasis.h)
        const x0 = Math.floor(sx)
        const y0 = Math.floor(sy)
        if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) continue
        const fx = sx - x0
        const fy = sy - y0
        out[py * cw + px] =
          gray[y0 * W + x0] * (1 - fx) * (1 - fy) +
          gray[y0 * W + x0 + 1] * fx * (1 - fy) +
          gray[(y0 + 1) * W + x0] * (1 - fx) * fy +
          gray[(y0 + 1) * W + x0 + 1] * fx * fy
      }
    }
    const png = await sharp(out, { raw: { width: cw, height: ch, channels: 1 } }).png().toBuffer()
    cells.push({ id: b.id, png })
  }
  return { anchors, cells }
}
