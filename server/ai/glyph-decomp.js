// 2026-07-12 方案C：國字權威部件拆解（IDS 查表、確定性零幻覺）
// 背景：字形終審判官靠記憶拆部件會幻覺（羈幻想含戈——文字空間實測 3/5 輪拆出「馬戈」），
//   AI 現場生成拆解同病 → 改用 cjkvi-ids 開放資料查表（羈=⿱罒⿰革馬），零幻覺、全字覆蓋。
// 規則：頂層結構符 → 位置標籤；生僻部件（Ext-A/B+，如 䩻）再展開一層；
//   拆不出 2~3 個乾淨大塊（⿻ 交疊型、含未編碼實體、生僻塊展不開）→ 回 null，判官退無拆解 prompt。
// 驗證：堤/鞏/喚/羈/堰 全數命中老師校對版（local-only build-glyph-ids.mjs）。
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
let IDS_MAP = null
function loadIds() {
  if (IDS_MAP === null) {
    try { IDS_MAP = require('./glyph-ids-data.json') } catch { IDS_MAP = {} }
  }
  return IDS_MAP
}

const OPS2 = { '⿰': ['左', '右'], '⿱': ['上', '下'], '⿴': ['外框', '內'], '⿵': ['外框', '內'], '⿶': ['外框', '內'], '⿷': ['外框', '內'], '⿸': ['外', '內'], '⿹': ['外', '內'], '⿺': ['外', '內'] }
const OPS3 = { '⿲': ['左', '中', '右'], '⿳': ['上', '中', '下'] }
const BAD = /[⿻{}&;()0-9A-Za-z?？]/
const isRare = (ch) => { const cp = ch.codePointAt(0); return (cp >= 0x3400 && cp <= 0x4DBF) || cp >= 0x20000 }

function parseIds(s) {
  if (!s) return null
  const chars = [...s]
  let i = 0
  const node = () => {
    const c = chars[i++]
    if (c === undefined) return null
    if (OPS2[c]) { const a = node(), b = node(); return (a && b) ? { op: c, kids: [a, b] } : null }
    if (OPS3[c]) { const a = node(), b = node(), d = node(); return (a && b && d) ? { op: c, kids: [a, b, d] } : null }
    return { leaf: c }
  }
  const t = node()
  return (t && i === chars.length) ? t : null
}

// 單層樹 → [[位置, 部件], ...]（任一子節點非 leaf 就放棄）
function flattenShallow(tree) {
  if (!tree || tree.leaf) return null
  const labels = OPS2[tree.op] ?? OPS3[tree.op]
  if (!labels) return null
  const out = []
  for (let k = 0; k < tree.kids.length; k++) {
    if (!tree.kids[k].leaf) return null
    out.push([labels[k], tree.kids[k].leaf])
  }
  return out
}

/**
 * 把單一國字拆成 2~3 個大部件（含位置標籤）。
 * @returns {string[]|null} 例：羈 → ['上=罒','下左=革','下右=馬']；拆不了 → null
 */
export function decomposeGlyph(ch) {
  try {
    if (typeof ch !== 'string' || [...ch].length !== 1) return null
    const map = loadIds()
    const ids = map[ch]
    if (!ids || BAD.test(ids)) return null
    const tree = parseIds(ids)
    if (!tree || tree.leaf) return null
    const labels = OPS2[tree.op] ?? OPS3[tree.op]
    if (!labels) return null
    const out = []
    for (let k = 0; k < tree.kids.length; k++) {
      const kid = tree.kids[k]
      if (kid.leaf && BAD.test(kid.leaf)) return null
      if (kid.leaf && !isRare(kid.leaf)) { out.push(`${labels[k]}=${kid.leaf}`); continue }
      // 巢狀結構 or 生僻部件（如 羈 的 䩻）：展開一層；展不開＝整字放棄（不塞判官看不懂的字）
      const sub = kid.leaf ? flattenShallow(parseIds(map[kid.leaf])) : flattenShallow(kid)
      if (!sub) return null
      for (const [l2, c2] of sub) {
        if (BAD.test(c2) || isRare(c2)) return null
        out.push(`${labels[k]}${l2}=${c2}`)
      }
    }
    return (out.length >= 2 && out.length <= 3) ? out : null
  } catch { return null }
}
