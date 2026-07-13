// 層級鏈決策純函數測試（2026-07-11）：案例取自培英 harness 實測
import { computeEscalationDecision as D } from '../../server/ai/staged-grading.js'

const cases = [
  // L2'：新盲+新知答一致 → 採之（含格式差經 fold 吸收）
  ['L2 一致', { r1: 'x ≤ 13/11', r2: 'x <= 73/11', r1p: 'x \\le \\frac{73}{11}', r2p: 'x<=73/11', key: 'x<=73/11' }, { level: 'L2', adopted: 'x \\le \\frac{73}{11}' }],
  ['L2 空白一致', { r1: 'go', r2: '80', r1p: '', r2p: '', key: '80' }, { level: 'L2', adopted: '' }],
  // 舊盲=key 時 L2x 先攔（採用值與 L3a 相同、且免標記——語義等價、更早出口）
  ['盲=key 走 L2x', { r1: 'x>=50/7', r2: 'x >= 50/7', r1p: 'x≥5/7', r2p: 'x>=50/7', key: 'x>=50/7' }, { level: 'L2x', adopted: 'x>=50/7' }],
  // 真 L3a：背書靠數值等價（字串不同、不觸發 L2x）——r1' 寫反向不等式仍算背書
  ['L3a 等價背書', { r1: 'x≥5/7', r2: 'x >= 50/7', r1p: '50/7 <= x', r2p: 'x>=50/7', key: 'x>=50/7' }, { level: 'L3a', adopted: 'x>=50/7' }],
  // L3a_blindguard：座30 型——知答共識=正解、無盲票背書 → 採盲讀值＋illegible（寧可誤殺）
  ['座30 幻覺區', { r1: 'x>=57/-7', r2: 'x>=50/7', r1p: 'x \\ge \\frac{50}{-7}', r2p: 'x>=50/7', key: 'x>=50/7' }, { level: 'L3a_blindguard', adopted: 'x \\ge \\frac{50}{-7}', illegible: true }],
  // L3b：知答共識≠正解 → 直接採（帶分數 7又1/7 交 Phase B 判等價）
  ['帶分數 L3b', { r1: 'x >= 1 1/4', r2: 'x ≥ 7 1/7', r1p: 'x ≥ 1 1/7', r2p: 'x≥7 1/7', key: 'x>=50/7' }, { level: 'L3b', adopted: 'x≥7 1/7' }],
  // 部分分：知答共識「16, 15」≠key → L3b 採之 → Phase B 給部分分（座12 Q17 實例 1/3）
  ['部分分 L3b', { r1: '16.15', r2: '16, 15', r1p: '16.15', r2p: '16, 15', key: '15, 16, 17' }, { level: 'L3b', adopted: '16, 15' }],
  // L3c：兩盲票跨條件一致（知答未成共識）
  ['L3c 盲共識', { r1: '9x < -19', r2: '9x < -79', r1p: '9x < -19', r2p: '9x<-79x', key: '9x<-79' }, { level: 'L3c', adopted: '9x < -19' }],
  // L2x 交叉對：一盲一知答跨輪一致（round8 座11 Q4 實測案例）
  ['L2x 新盲×舊知答（r2p 失敗）', { r1: '26', r2: '21', r1p: '21', r2p: null, key: '無解' }, { level: 'L2x', adopted: '21', illegible: false }],
  ['L2x 舊盲×新知答（r1p 失敗）', { r1: '21', r2: '2(', r1p: null, r2p: '21', key: '無解' }, { level: 'L2x', adopted: '21', illegible: false }],
  ['L2x=key 也安全（盲票即背書）', { r1: 'x<=17/11', r2: 'x<=73/11', r1p: 'x<=73/11', r2p: null, key: 'x<=73/11' }, { level: 'L2x', adopted: 'x<=73/11', illegible: false }],
  // tail：四票無共識 → 採 r2'＋illegible
  ['tail 發散', { r1: 'fo', r2: '8', r1p: 'fv', r2p: '80', key: '80' }, { level: 'tail', adopted: '80', illegible: true }],
  // tail：r2' 失敗 → 退 r2
  ['tail 退r2', { r1: 'fo', r2: '8', r1p: 'fv', r2p: null, key: '80' }, { level: 'tail', adopted: '8', illegible: true }],
  // 全失敗 → null（fail-open 維持送審）
  ['全失敗', { r1: null, r2: null, r1p: null, r2p: null, key: '80' }, { level: null, adopted: null }],
  // ── 2026-07-13 空白衝突特例（chain-native blank-trust 改版）──
  // 情境A：學生真有寫、r1 偶發漏看 → 加賽盲讀讀出 ≈ r2 → L2x 採內容（社會座16 型救回）
  ['空白衝突·盲加賽讀出(情境A)', { r1: '', r2: '民變，因為人民對政府表達訴求', r1p: '民變，因為人民對政府表達訴求', r2p: null, key: '民變|合理理由' }, { level: 'L2x', adopted: '民變，因為人民對政府表達訴求', illegible: false }],
  // 情境B：真空白＋知答幻覺=key → L3a_blindguard 採盲讀值(空白)＋標記（英語 22/22 防線）
  ['空白衝突·幻覺=key(情境B)', { r1: '', r2: 'The dog is running', r1p: '', r2p: 'The dog is running', key: 'The dog is running' }, { level: 'L3a_blindguard', adopted: '', illegible: true }],
  // 情境C：真空白＋知答幻覺≠key → 盲票空白共識 → L3b_blankguard 判空白＋標記（堵放水）
  ['空白衝突·幻覺≠key(情境C)', { r1: '', r2: '支持，因為可以幫助大家', r1p: '', r2p: '支持，因為可以幫助大家', key: '反對|理由' }, { level: 'L3b_blankguard', adopted: '', illegible: true }],
  // 情境C tail 版：知答兩輪不一致、盲票雙空白 → tail_blankguard 判空白＋標記
  ['空白衝突·盲雙空白走L3c(天然正確)', { r1: '', r2: '支持AAA', r1p: '', r2p: '支持BBB', key: '反對|理由' }, { level: 'L3c', adopted: '', illegible: false }],
  // 對照：盲票只有一張空白（r1p 讀出別的內容）→ 不觸發 blankguard、照常 tail
  ['空白單票不觸發 guard', { r1: '', r2: '支持AAA', r1p: '支持CCC', r2p: '支持BBB', key: '反對|理由' }, { level: 'tail', adopted: '支持BBB', illegible: true }],
]
let pass = 0, fail = 0
for (const [name, input, want] of cases) {
  const got = D(input)
  const ok = got.level === want.level
    && got.adopted === want.adopted
    && (want.illegible === undefined || got.illegible === want.illegible)
  if (ok) pass++
  else { fail++; console.log(`✗ ${name}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`) }
}
console.log(`${pass}/${cases.length} pass, ${fail} fail`)
