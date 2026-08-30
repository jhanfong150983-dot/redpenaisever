// ═══ 菜單制計價（扣款權威）─ 2026-08-27 user 拍板 ═══════════════════════════════
// 取代題數級距（5/10/15/20 點）：每份點數由「考卷內容」決定，答案卷存檔即可確定。
//
//   每份點數 = round( 基本費(模式,頁數,人數) ＋ Σ(題數 × 題型單價) )
//
// 單價=8 月 production 逐 token 實測成本 × 2.25（維運加成 1.5 × 毛利 1.5）。
// 全庫驗證（8 月各卷最新完整輪）：預測 vs 實測誤差 -23%~+34%，無任何卷觸及賠錢線
// （賠錢線=實測超過預測 2.27 倍）。詳見對話 2026-08-27 映射審計。
//
// ⚠ 三條鐵則：
//   ① 27 種 questionCategory 必須全部有歸類——未知類 fallback 簡答價＋console 告警，不允許靜默低價
//   ② 國字注音（bopomofo 偵測）為「沙盒驗證前暫行價」1.1 點/題——寧高勿低，驗完再降
//   ③ 動任何單價 → PRICING_VERSION 必須跳號（快照帶版本，老師已定價的卷永不變）
//
// 鏡像：client src/lib/exam-pricing.ts 同一套常數——動這裡必同步那邊，
//   並跑 local-only/crosscheck-exam-pricing.mjs 驗證兩邊逐字一致（normAnswerValue 漂移的教訓）。

export const PRICING_VERSION = 'menu-2026-08-30'

// 開關：'1' 啟用菜單制扣款；預設關（沿用題數級距）。client 鏡像 VITE_MENU_BILLING，
// 兩端同版部署後才能開（FLAT_BILLING 的紀律：顯示與實扣不可分家）。
export const MENU_BILLING_ENABLED = process.env.MENU_BILLING === '1'

// ── 題型單價（點/題；點面值 NT$1）─────────────────────────────────────────────
// ⚠ 2026-08-28 全面修正：先前的數學相關單價是「同一份卷被連續重批兩次」的疊加值。
//   培英卷 8 月被反覆重批 11.6 次（VJ 開發期），舊的「30 分鐘無呼叫＝新一輪」斷輪規則
//   把間隔 21 分鐘的兩次批改黏成一輪 → 數學成本虛報 77%（8.36 實際 4.73）。
//   改用「逐份卷分簇（>5 分鐘＝新一次批改）」重算，其他三科只批一次故不受影響。
export const UNIT_POINTS = {
  choice: 0.15,    // 選擇/是非/勾選/配合/排序（實測成本 0.05）
  fillTxt: 0.2,    // 填空：文字、英文（實測 0.08）
  fillMath: 0.2,   // 填空：數學式（實測 0.077；舊值 0.35 來自雙重計算）
  short: 0.3,      // 簡答/問答（實測 0.12）
  vj: 1.4,         // 作圖題 VJ（實測 0.616；舊值 1.6）
  level: 2.1,      // 應用題級分制（實測 0.907／題＝要素數 6 × 每要素 1 次；舊值 4.5）
  handwrite: 0.9,  // 國字/注音書寫格（字形判官＋注音判官各 3 票）——2026-08-30 實測 0.41/格
  zhuyin: 0.9,     // （保留舊鍵、與 handwrite 同價，避免既有快照對不上）
  unknown: 0.3     // 未知題型 fallback（=簡答價）＋告警
}

// 2026-08-30 新增「國字/注音書寫格」：國語卷的手寫國字/注音格，每格都要跑
//   字形判官（校對筆畫、抓造字錯字）＋注音判官，各 3 票 → 實測 0.41/格，
//   是 fill_blank(0.08)/short_answer(0.12) 假設值的 3~5 倍。
//   實證：114-2 國語卷每份固定 10 個判官格 × 3 票 = 30 次呼叫（逐份對照 33~37 次，判官佔 90%）。
//   判別綁死「國語卷 × 填空/短答 × 標答為 1~4 中文字或含注音」——全庫回放 111 卷只動 4 卷國語，零誤傷。
const HANDWRITE_CATS = new Set(['fill_blank', 'short_answer'])
const isCjkShort = (ans) => /^[一-鿿]{1,4}$/u.test(String(ans ?? '').trim())

// ── 題型 → 菜單類映射（2026-08-27 全庫 27 類審計定案）────────────────────────
const CHOICE_SET = new Set([
  'single_choice', 'single_check', 'multi_check', 'true_false', 'circle_select_one',
  'multi_choice', 'multi_fill', 'multi_check_other', 'matching', 'table_check', 'ordering'
])
const VJ_SET = new Set(['diagram_draw', 'diagram_color', 'grid_geometry', 'map_symbol', 'map_fill'])
const SHORT_SET = new Set([
  'short_answer', 'compound_circle_with_explain', 'compound_judge_with_explain',
  'compound_chain_table', 'compound_check_with_explain', 'fill_variants', 'table_cell'
])

// 數學式判別：標答含數字且帶運算/關係符號，或為純數字分數形態
const mathishAnswer = (ans) =>
  /[0-9]/.test(ans) && (/[<>≥≤≦≧=+\-×÷/√^%]/.test(ans) || /^[0-9.,\s/]+$/.test(ans))
// 注音判別：標答含注音符號（ㄅ..ㄩ˙ˊˇˋ）
const zhuyinAnswer = (ans) => /[ㄅ-ㄯˊˇˋ˙]/.test(ans)

/** 單題歸類（billing 權威；client 鏡像同名函式）。domain 用於國語手寫格判別。 */
export function menuClassOf(q, domain = '') {
  const c = String(q?.questionCategory ?? '').trim()
  const ans = String(q?.answer ?? '')
  if (q?.levelRubric) return 'level'                      // 級分制優先於 category
  if (VJ_SET.has(c)) return 'vj'
  if (CHOICE_SET.has(c)) return 'choice'
  // 國語手寫格：寫國字（字形判官比對筆畫）／寫注音（注音三判官）——成本 0.41/格。
  // ⛔ 排除帶 rubricsDimensions 的題：那是註釋題、走查表制（純文字判分＋值→分數表快取），
  //    不送圖也不跑判官。目前靠「標答 ≤4 字」剛好分開，但那是運氣不是設計——
  //    註釋題參考答案若剛好是「深藍」這種 2 字詞就會誤收，故明確排除。
  if (String(domain).includes('國') && HANDWRITE_CATS.has(c) && !q?.rubricsDimensions
      && (isCjkShort(ans) || zhuyinAnswer(ans))) return 'handwrite'
  if (zhuyinAnswer(ans)) return 'zhuyin'                  // 非國語卷的注音（保守仍收判官價）
  if (SHORT_SET.has(c)) return 'short'
  if (c === 'word_problem' || c === 'calculation' || c === 'fill_blank')
    return mathishAnswer(ans) ? 'fillMath' : (c === 'fill_blank' ? 'fillTxt' : 'short')
  return 'unknown'
}

// ── 每份基本費（卷面定位建模攤提＋整卷判分）──────────────────────────────────
// 建模費實測：答案卷模式（1–2 頁）NT$47/班、原卷作答 NT$14.5/頁/班（n=2 樣本、
// 全表最不確定項——由 2.25 倍率吸收，累積 5–10 份新卷首建後重擬合）。
// 人數用「實際班級人數」精算（對外菜單以級距溝通、實扣按實數，只會更便宜不會更貴）。
export function baseFeePoints(mode, pages, classSize) {
  const n = Math.max(1, Number(classSize) || 30)
  const p = Math.max(1, Number(pages) || 2)
  const modelFee = mode === 'ao' ? 47 : 14.5 * p
  return (0.15 + modelFee / n) * 2.25
}

/** 從 answer_key 推導模式與頁數（建卷時即全部已知） */
export function detectLayout(answerKey) {
  const layout = answerKey?._layoutDetected?.[0]?.layout
  const mode = String(layout ?? '').startsWith('answer-o') ? 'ao' : 'wq'
  let maxPage = 0
  for (const q of answerKey?.questions ?? []) {
    const pi = Number(q?.pageIndex)
    if (Number.isFinite(pi) && pi > maxPage) maxPage = pi
  }
  return { mode, pages: maxPage + 1 }
}

/**
 * 每份點數（整數、下限 1）＋明細。answerKey 與 classSize 為僅有的輸入——
 * 確定性、建卷即可算、批改前後不變。
 * @returns {{ points:number, version:string, breakdown:Object, warnings:string[] }}
 */
export function computePointsPerSheet(answerKey, classSize, domain = '') {
  const warnings = []
  const qs = Array.isArray(answerKey?.questions) ? answerKey.questions : []
  const { mode, pages } = detectLayout(answerKey)
  const comp = {}
  let qSum = 0
  for (const q of qs) {
    const cls = menuClassOf(q, domain)
    if (cls === 'unknown') warnings.push(`未知題型 "${q?.questionCategory}"（${q?.id}）→ 以簡答價計`)
    comp[cls] = (comp[cls] ?? 0) + 1
    qSum += UNIT_POINTS[cls]
  }
  const base = baseFeePoints(mode, pages, classSize)
  const points = Math.max(1, Math.round(base + qSum))
  if (warnings.length) console.warn(`[exam-pricing] ${warnings.join('；')}`)
  return { points, version: PRICING_VERSION, breakdown: { mode, pages, classSize, base: +base.toFixed(2), comp }, warnings }
}

/**
 * 取得（或建立）某批 assignment 的價格快照。首次成功扣款時凍結——
 * 之後答案卷再怎麼改、菜單再怎麼調，該卷每份點數永不變（同卷同價是資料庫保證的）。
 * fail-open：快照表不存在/查詢失敗 → 現算不凍結（價仍確定，只是未鎖）。
 * @returns Map(assignmentId → points)
 */
export async function resolvePointsPerSheet(supabaseAdmin, assignmentIds) {
  const out = new Map()
  const aids = [...new Set((assignmentIds ?? []).filter(Boolean))]
  if (aids.length === 0) return out
  let missing = [...aids]
  try {
    const { data } = await supabaseAdmin
      .from('exam_price_snapshots')
      .select('assignment_id, points_per_sheet')
      .in('assignment_id', aids)
    for (const r of data ?? []) out.set(r.assignment_id, Number(r.points_per_sheet) || 1)
    missing = aids.filter((a) => !out.has(a))
  } catch { /* 表不存在 → 全部現算 */ }
  if (missing.length === 0) return out

  const { data: asgs } = await supabaseAdmin
    .from('assignments').select('id, classroom_id, answer_key, domain, title').in('id', missing)
  const classIds = [...new Set((asgs ?? []).map((a) => a.classroom_id).filter(Boolean))]
  const sizeByClass = new Map()
  if (classIds.length) {
    try {
      const { data: studs } = await supabaseAdmin
        .from('students').select('classroom_id').in('classroom_id', classIds)
      for (const s of studs ?? []) sizeByClass.set(s.classroom_id, (sizeByClass.get(s.classroom_id) ?? 0) + 1)
    } catch { /* fail-open → 預設 30 */ }
  }
  for (const a of asgs ?? []) {
    const size = sizeByClass.get(a.classroom_id) || 30
    const r = computePointsPerSheet(a.answer_key, size, String(a.domain ?? a.title ?? ''))
    out.set(a.id, r.points)
    try {
      await supabaseAdmin.from('exam_price_snapshots').upsert(
        { assignment_id: a.id, points_per_sheet: r.points, pricing_version: r.version, class_size: size, breakdown: r.breakdown },
        { onConflict: 'assignment_id', ignoreDuplicates: true }   // 併發時先寫者勝，本輪用本地計算值（同公式同輸入=同值）
      )
    } catch { /* 凍結失敗不擋扣款 */ }
  }
  return out
}
