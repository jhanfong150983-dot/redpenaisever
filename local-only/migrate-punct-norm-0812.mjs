// 2026-08-12 遷移:semantic_score_tables value_norm 加「CJK 內部分隔標點折疊」
// 規則(user 拍板):半形化後的 , . ; : 若前後緊鄰皆為中文字 → 移除;數字鄰接一律保留。
// 碰撞合併:同 (scope,qid,newNorm) 多列 → 全歧取最高分(user 既定規則)、輸家列刪除。
// 用法:node migrate-punct-norm-0812.mjs        → dry-run(只印不寫)
//       node migrate-punct-norm-0812.mjs --apply → 真正套用
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const envTxt = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
for (const l of envTxt.split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const APPLY = process.argv.includes('--apply')

// 新版 normSemanticValue(=現行 + CJK 內部標點折疊;與 server/client 程式改動一字不差)
function normNew(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/，/g, ',').replace(/。/g, '.').replace(/；/g, ';').replace(/：/g, ':').replace(/、/g, ',')
    // CJK 內部分隔標點折疊(2026-08-12):兩側皆中文字的 , . ; : =AI read 漂移的列舉/斷句符
    //(「靠著、依傍」=「靠著.依傍」=「靠著依傍」);lookahead 不消耗右鄰、連續多段一次收斂。
    // 數字鄰接(3.5/1:2/1,000)不符合兩側皆 CJK → 原樣保留。
    .replace(/([一-鿿])[,.;:]+(?=[一-鿿])/g, '$1')
    .replace(/^[,.;:!?，。；：、！？\s]+|[,.;:!?，。；：、！？\s]+$/g, '')
}

const { data: rows, error } = await sb.from('semantic_score_tables')
  .select('id, scope_key, question_id, value_norm, value_raw, score, max_score, low_conf, verdict, created_at')
  .order('created_at', { ascending: true })
  .limit(10000)
if (error) { console.error(error.message); process.exit(1) }
console.log(`共 ${rows.length} 列\n`)

// 反向檢查①:找出任何「含數字的值」其 norm 因新規則改變 → 必須為 0
let digitFolds = 0
for (const r of rows) {
  const n = normNew(r.value_raw)
  if (n !== r.value_norm && /\d/.test(String(r.value_raw))) {
    console.log(`⛔ 含數字值被改動:「${r.value_raw}」 ${r.value_norm} → ${n}`)
    digitFolds++
  }
}
console.log(`反向檢查①(數字值不可折):${digitFolds === 0 ? '✅ 0 件' : `⛔ ${digitFolds} 件——中止`}`)
if (digitFolds > 0) process.exit(1)

// 重算+分組
const byKey = new Map() // `${scope}|${qid}|${newNorm}` → rows
let unchanged = 0, renamed = 0
for (const r of rows) {
  r._newNorm = normNew(r.value_raw)
  if (!r._newNorm) r._newNorm = r.value_norm // 折疊後變空(答案=標點)→ 保留原 key、不折
  if (r._newNorm === r.value_norm) unchanged++; else renamed++
  const k = `${r.scope_key}|${r.question_id}|${r._newNorm}`
  const g = byKey.get(k) ?? []
  g.push(r)
  byKey.set(k, g)
}
console.log(`norm 不變 ${unchanged} 列、需改名 ${renamed} 列`)

// 合併計畫
const toDelete = []
const toUpdate = []
let mergeGroups = 0
for (const [k, g] of byKey) {
  if (g.length > 1) {
    mergeGroups++
    // 全歧取最高分;同分取最早凍結(created_at asc 排序後首個同分者)
    const winner = [...g].sort((a, b) => Number(b.score) - Number(a.score))[0]
    console.log(`\n合併 ${k.split('|')[1]}「${winner._newNorm}」(${g.length} 列 → 1):`)
    for (const r of g) {
      const mark = r === winner ? '👑留' : '  刪'
      console.log(`  ${mark} 「${r.value_raw}」${r.score}/${r.max_score}${r.low_conf ? '(低信心)' : ''}`)
      if (r !== winner) toDelete.push(r.id)
    }
    if (winner.value_norm !== winner._newNorm) toUpdate.push({ id: winner.id, value_norm: winner._newNorm })
  } else {
    const r = g[0]
    if (r.value_norm !== r._newNorm) toUpdate.push({ id: r.id, value_norm: r._newNorm })
  }
}
console.log(`\n計畫:刪 ${toDelete.length} 列、改名 ${toUpdate.length} 列、合併 ${mergeGroups} 群`)

if (!APPLY) { console.log('\n(dry-run 結束;確認無誤後加 --apply 套用)'); process.exit(0) }

// 套用:先刪輸家(避開 unique 衝突)再改名
if (toDelete.length) {
  const { error: e1 } = await sb.from('semantic_score_tables').delete().in('id', toDelete)
  if (e1) { console.error('刪除失敗:', e1.message); process.exit(1) }
}
for (const u of toUpdate) {
  const { error: e2 } = await sb.from('semantic_score_tables').update({ value_norm: u.value_norm }).eq('id', u.id)
  if (e2) { console.error(`改名失敗 id=${u.id}:`, e2.message); process.exit(1) }
}
// 驗收:重新掃一次,不得再有碰撞
const { data: after } = await sb.from('semantic_score_tables').select('scope_key, question_id, value_raw').limit(10000)
const seen = new Set()
let post = 0
for (const r of after ?? []) {
  const k = `${r.scope_key}|${r.question_id}|${normNew(r.value_raw)}`
  if (seen.has(k)) { console.log(`⚠ 殘餘碰撞: ${k}`); post++ }
  seen.add(k)
}
console.log(`\n✅ 套用完成:刪 ${toDelete.length}、改名 ${toUpdate.length};驗收殘餘碰撞 ${post} 件`)
