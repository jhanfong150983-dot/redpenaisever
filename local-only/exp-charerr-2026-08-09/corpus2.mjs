// 補撈「被舊規則翻 0 分」的格子（reason 以「用字錯誤」開頭＝_charErrOverride）
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
for (const l of fs.readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'').replace(/\r$/,'').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
let rows=[],p=0
for(;;){const {data,error}=await db.from('submissions').select('id,assignment_id,student_id,grading_result').not('grading_result','is',null).order('id').range(p*100,p*100+99); if(error){console.log('ERR',error.message);break} rows=rows.concat(data||[]); if((data||[]).length<100)break; p++}
const hits=[]
for(const s of rows) for(const d of (s.grading_result?.details??[])){
  if(!String(d.reason??'').startsWith('用字錯誤'))continue
  hits.push({aid:s.assignment_id,sid:s.student_id,qid:String(d.questionId),
    stu:String(d.studentFinalAnswer??d.studentAnswer??''),score:d.score,max:d.maxScore,reason:d.reason})
}
console.log(`全庫「被錯字覆核翻 0」的格子: ${hits.length}`)
const byAid={}; for(const h of hits) byAid[h.aid]=(byAid[h.aid]||0)+1
const {data:asgs}=await db.from('assignments').select('id,title,answer_key').in('id',Object.keys(byAid))
const at=new Map((asgs||[]).map(a=>[a.id,a.title]))
const akmap=new Map((asgs||[]).map(a=>{const k=typeof a.answer_key==='string'?JSON.parse(a.answer_key):a.answer_key; return [a.id,new Map((k?.questions||[]).map(q=>[String(q.id),q]))]}))
for(const [k,v] of Object.entries(byAid).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(v).padStart(3)} 格　${at.get(k)??k}`)
const out=[]
for(const h of hits){
  const q=akmap.get(h.aid)?.get(h.qid)
  const ref=String(q?.referenceAnswer??q?.answer??'').trim()
  if(!ref||!h.stu)continue
  out.push({...h,ref,title:at.get(h.aid)})
}
fs.writeFileSync(path.join('local-only','exp-charerr-2026-08-09','corpus2.json'),JSON.stringify(out,null,1))
const uniq=new Set(out.map(o=>o.qid+'|'+o.stu))
console.log(`\n可測 ${out.length} 格、不同寫法 ${uniq.size} 種`)
console.log('\n樣本:'); for(const o of out.slice(0,10)) console.log(`  ${o.qid} 正解「${o.ref.slice(0,24)}」 學生「${o.stu.slice(0,30)}」 ${o.score}/${o.max}  ${o.reason.slice(0,40)}`)
