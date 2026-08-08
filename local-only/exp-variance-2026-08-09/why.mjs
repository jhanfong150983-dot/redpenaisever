import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
for (const l of fs.readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'').replace(/\r$/,'').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const AID='1778869700051-ollsjczry'
const A=JSON.parse(fs.readFileSync('local-only/snapshots/before-gzmed_1778869700051-ollsjczry_2026-08-08-07-13-38.json','utf8'))
const B=JSON.parse(fs.readFileSync('local-only/snapshots/before-chainveto_1778869700051-ollsjczry_2026-08-08-11-50-25.json','utf8'))
const {data:a}=await db.from('assignments').select('answer_key').eq('id',AID).maybeSingle()
const ak=typeof a.answer_key==='string'?JSON.parse(a.answer_key):a.answer_key
const akById=new Map((ak.questions||[]).map(q=>[String(q.id),q]))
let subs=[],p=0
for(;;){const {data,error}=await db.from('submissions').select('id,student_id,graded_at,grading_result').eq('assignment_id',AID).order('id').range(p*50,p*50+49); if(error){console.log('ERR',error.message);break} subs=subs.concat(data||[]);if((data||[]).length<50)break;p++}
const {data:studs}=await db.from('students').select('id,seat_number').in('id',subs.map(s=>s.student_id))
const sm=new Map((studs||[]).map(s=>[s.id,s.seat_number]))
for(const [seat,qid] of [[5,'1-2-2'],[16,'1-2-2']]){
  const sa=A.submissions.find(x=>x.seat===seat), sb=B.submissions.find(x=>x.seat===seat)
  const da=(sa?.details||[]).find(d=>d.qid===qid), dbb=(sb?.details||[]).find(d=>d.qid===qid)
  const cur=subs.find(x=>sm.get(x.student_id)===seat)
  const dc=(cur?.grading_result?.details||[]).find(d=>String(d.questionId)===qid)
  const q=akById.get(qid)
  console.log(`\n══════ 座${seat} ${qid} ══════`)
  console.log(`正解「${q?.answer}」  滿分 ${q?.maxScore}  題型 ${q?.questionCategory}`)
  console.log(`讀值(兩輪完全相同)「${da?.ans}」`)
  console.log(`\n第一輪(15:13): ${da.ok?'判對':'判錯'} ${da.score}/${da.maxScore}  信心 ${da.conf}  ${da.journey}`)
  console.log(`第二輪(19:50): ${dbb.ok?'判對':'判錯'} ${dbb.score}/${dbb.maxScore}  信心 ${dbb.conf}  ${dbb.journey}`)
  console.log(`\n第二輪的 accessor 理由(從 DB 撈、該卷 21:30 沒重批過):`)
  console.log(`  isCorrect=${dc?.isCorrect} score=${dc?.score}/${dc?.maxScore} errorType=${dc?.errorType}`)
  console.log(`  reason: ${dc?.reason}`)
  console.log(`  r1「${dc?.readAnswer1?.studentAnswer}」 r2「${dc?.readAnswer2?.studentAnswer}」 consistency=${dc?.consistencyStatus}`)
  console.log(`  graded_at ${new Date(Number(cur.graded_at)).toLocaleString('zh-TW')}`)
}
// 同一題全班的判定分布：看 accessor 對這題的尺度有多不穩
console.log('\n\n══════ 1-2-2 全班判定分布（第二輪 = 目前 DB）══════')
console.log(`正解「${akById.get('1-2-2')?.answer}」`)
const rows=[]
for(const s of subs){const d=(s.grading_result?.details||[]).find(x=>String(x.questionId)==='1-2-2'); if(d)rows.push({seat:sm.get(s.student_id),ans:d.studentAnswer,score:d.score,max:d.maxScore,ok:d.isCorrect})}
const byAns={}
for(const r of rows){const k=String(r.ans); byAns[k]??=[]; byAns[k].push(`座${r.seat}:${r.score}/${r.max}`)}
for(const [ans,list] of Object.entries(byAns).sort((x,y)=>y[1].length-x[1].length)){
  const scores=new Set(list.map(x=>x.split(':')[1]))
  console.log(`${scores.size>1?'⚠ ':'  '}「${ans}」 → ${list.join('、')}${scores.size>1?'   ← 同一讀值不同分數!':''}`)}
