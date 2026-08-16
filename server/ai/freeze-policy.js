// ═══ 判定冷凍政策（收斂版）— 2026-08-16 user 拍板 ═══════════════════════════
// 系統裡有兩套「AI 判過就存起來」的機制，鍵的形態不同（值 vs 內容 hash），
//   但**行為規則必須一致**，否則老師會在不同題型遇到不同的意外。
//
// 三條共用規則：
//   ① 鍵含「判定邏輯版本」→ 改判分邏輯即自動失效重判，不被舊版本綁死
//   ② source='teacher' 最高優先，AI 寫入永不覆蓋 → 老師裁決是最終事實
//   ③ 低信心旗標隨判定一起存 → 重批沿用時仍會送複核（穩定 ≠ 當作沒問題）
//
// 鍵的差異（唯一允許不同的地方）：
//   ・值可比（文字/數值答案）→ 用正規化後的值當鍵，**跨學生共用**（同答同分）
//   ・值不可比（圖、整份作答）→ 用內容 hash 當鍵，**各自獨立**（圖不會重複）

// ⚠ 動到任何影響判分結果的邏輯（prompt、投票數、規準解讀、計分公式）時，
//   **必須**調高對應的版本號，否則既有卷會沿用舊判定、新修法對它們無效。
export const FREEZE_LOGIC_VERSION = {
  // 國語短答值→分數表（semantic_score_tables）
  semantic: 'sem-2026-08-16',
  // 作圖題判官（vj_verdict_cache）；同時是 vj-verdict-cache.js 的 VJ_PROMPT_VERSION
  vj: 'vj-2026-08-16-3votes-weighted',
}

/** AI 判定寫入時的共用 upsert 選項：永不覆蓋既有列（含 source='teacher'） */
export const AI_UPSERT_OPTS = { ignoreDuplicates: true }

/**
 * 老師裁決是否應覆蓋 AI 判定（永遠是）；回傳寫回資料庫用的欄位。
 * 兩表共用：分數換成老師的、來源標 teacher、低信心解除（已經有人決定了）。
 */
export function teacherOverrideFields(score) {
  return { score, source: 'teacher', low_conf: false, updated_at: new Date().toISOString() }
}

/** 命中冷凍時，信心該給多少（兩表共用） */
export function frozenConfidence({ source, lowConf, aiHigh = 90 }) {
  if (source === 'teacher') return 100     // 人工定案
  return lowConf ? 60 : aiHigh             // <70 才會進複核面板
}
