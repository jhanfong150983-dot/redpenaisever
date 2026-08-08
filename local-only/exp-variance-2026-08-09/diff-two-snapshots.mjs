// 免費的重批變異量測：A班國語兩份完整快照（8/08 15:13 與 19:50，中間一次完整重批）逐格對照。
// ⚠ confound：那次重批期間國字判官曾降 MEDIUM → 國字/注音格不算純變異，需分開看。
//   非國字格兩次的組態相同 → 那部分是純 run-to-run 變異。
import fs from 'node:fs'
const A=JSON.parse(fs.readFileSync('local-only/snapshots/before-gzmed_1778869700051-ollsjczry_2026-08-08-07-13-38.json','utf8'))
const B=JSON.parse(fs.readFileSync('local-only/snapshots/before-chainveto_1778869700051-ollsjczry_2026-08-08-11-50-25.json','utf8'))
const sg = await import('../../server/ai/staged-grading.js')
const fold=(x)=>sg.normalizeAnswerForComparison(sg.deLatexMathText(String(x??'')))
const gzCjk=(s)=>/^[一-鿿]{1,2}$/u.test(s), gzZh=(s)=>/^[ㄅ-ㄩˊˇˋ˙]{1,5}$/u.test(s)
const byId=(snap)=>new Map(snap.submissions.map(s=>[s.id,s]))
const ma=byId(A), mb=byId(B)
console.log(`A: ${A.tag} @ ${A.snapshotAt}   B: ${B.tag} @ ${B.snapshotAt}`)
console.log(`共同卷數: ${[...ma.keys()].filter(k=>mb.has(k)).length}/31\n`)
const st={gz:{n:0,verdict:0,ans:0,votes:0,conf:0},other:{n:0,verdict:0,ans:0,votes:0,conf:0}}
const flips=[]
for(const [id,sa] of ma){
  const sb=mb.get(id); if(!sb)continue
  const cb=new Map((sb.details||[]).map(d=>[d.qid,d]))
  for(const da of (sa.details||[])){
    const db=cb.get(da.qid); if(!db)continue
    // 判斷是否國字注音格：用 votes 是否存在（判官只跑 gz）
    const isGz = (Array.isArray(da.votes)&&da.votes.length>0)||(Array.isArray(db.votes)&&db.votes.length>0)
    const g = isGz?st.gz:st.other
    g.n++
    const vFlip = da.ok!==db.ok
    const aFlip = fold(da.ans)!==fold(db.ans)
    const voteFlip = JSON.stringify(da.votes??null)!==JSON.stringify(db.votes??null)
    const cFlip = Number(da.conf)!==Number(db.conf)
    if(vFlip)g.verdict++; if(aFlip)g.ans++; if(voteFlip)g.votes++; if(cFlip)g.conf++
    if(vFlip) flips.push({seat:sa.seat,qid:da.qid,isGz,
      a:{ok:da.ok,score:da.score,ans:da.ans,conf:da.conf,j:da.journey},
      b:{ok:db.ok,score:db.score,ans:db.ans,conf:db.conf,j:db.journey},
      sameAns: !aFlip})
  }
}
const pct=(x,n)=>n?(x/n*100).toFixed(1)+'%':'-'
console.log('分類           格數   判定翻盤        讀值變動        判官票變動      信心變動')
for(const [k,g] of Object.entries(st))
  console.log(`${(k==='gz'?'國字注音(有判官)':'其他題型').padEnd(15)}${String(g.n).padStart(4)}  ${String(g.verdict).padStart(4)} ${pct(g.verdict,g.n).padStart(7)}  ${String(g.ans).padStart(4)} ${pct(g.ans,g.n).padStart(7)}  ${String(g.votes).padStart(4)} ${pct(g.votes,g.n).padStart(7)}  ${String(g.conf).padStart(4)} ${pct(g.conf,g.n).padStart(7)}`)
console.log(`\n判定翻盤合計 ${flips.length} 格`)
const sameAnsFlips=flips.filter(f=>f.sameAns)
console.log(`  其中「讀值一字未變卻翻盤」= accessor 純變異: ${sameAnsFlips.length} 格`)
console.log(`  讀值也變了（read/判官變異連帶）: ${flips.length-sameAnsFlips.length} 格`)
console.log('\n── accessor 純變異明細（讀值相同、判定不同）──')
for(const f of sameAnsFlips.slice(0,25))
  console.log(`  座${String(f.seat).padStart(2)} ${f.qid.padEnd(8)} ${f.isGz?'[gz]':'    '} 「${String(f.a.ans).slice(0,28)}」  ${f.a.ok?'對':'錯'}${f.a.score}→${f.b.ok?'對':'錯'}${f.b.score}  conf ${f.a.conf}→${f.b.conf}`)
fs.writeFileSync('local-only/exp-variance-2026-08-09/flips.json',JSON.stringify(flips,null,1))
