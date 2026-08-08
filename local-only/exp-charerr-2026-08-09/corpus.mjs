// 撈國語註釋 short_answer 測資（A班國語全部 10 題 × 31 卷）
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
for (const l of fs.readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'').replace(/\r$/,'').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const AIDS=[['A班','1778869700051-ollsjczry'],['B班','1778869875728-wlkato1nr']]
const out=[]
for(const [cls,AID] of AIDS){
  const {data:a}=await db.from('assignments').select('answer_key').eq('id',AID).maybeSingle()
  const ak=typeof a.answer_key==='string'?JSON.parse(a.answer_key):a.answer_key
  const akById=new Map((ak.questions||[]).map(q=>[String(q.id),q]))
  let subs=[],p=0
  for(;;){const {data,error}=await db.from('submissions').select('id,student_id,grading_result').eq('assignment_id',AID).not('grading_result','is',null).order('id').range(p*50,p*50+49); if(error){console.log('ERR',error.message);break} subs=subs.concat(data||[]);if((data||[]).length<50)break;p++}
  const {data:studs}=await db.from('students').select('id,seat_number').in('id',subs.map(s=>s.student_id))
  const sm=new Map((studs||[]).map(s=>[s.id,s.seat_number]))
  for(const s of subs) for(const d of (s.grading_result?.details??[])){
    const q=akById.get(String(d.questionId))
    if(q?.questionCategory!=='short_answer')continue
    const ref=String(q.referenceAnswer??q.answer??'').trim()
    const stu=String(d.studentFinalAnswer??d.studentAnswer??'').trim()
    if(!ref||!stu||stu==='未作答'||stu==='無法辨識')continue
    if(!(Number(d.score)>0))continue           // 新規則的覆核範圍：score>0
    out.push({cls,seat:sm.get(s.student_id),qid:String(d.questionId),ref,stu,
      score:Number(d.score),max:Number(d.maxScore),isCorrect:d.isCorrect===true,
      journey:d.confidenceJourney,charErr:d.reason?.startsWith('用字錯誤')||false})
  }
}
fs.writeFileSync(path.join('local-only','exp-charerr-2026-08-09','corpus.json'),JSON.stringify(out,null,1))
console.log(`測資 ${out.length} 格（score>0 的國語 short_answer）`)
const byQ={}; for(const o of out) byQ[o.cls+' '+o.qid]=(byQ[o.cls+' '+o.qid]||0)+1
console.log('逐題:', Object.entries(byQ).sort().map(([k,v])=>`${k}:${v}`).join('  '))
const uniq=new Set(out.map(o=>o.qid+'|'+o.stu))
console.log(`不同的 (題,寫法) 組合: ${uniq.size}`)
const full=out.filter(o=>o.score===o.max).length
console.log(`目前滿分 ${full}、部分分 ${out.length-full}`)
