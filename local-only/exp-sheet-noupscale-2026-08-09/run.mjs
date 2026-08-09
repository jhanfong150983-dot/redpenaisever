// 用英語卷真實裁圖，對照「硬拉伸(舊)」vs「只縮不放(新)」的合成圖
import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
for (const l of fs.readFileSync('.env.local','utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'').replace(/\r$/,'').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sg = await import('../../server/ai/staged-grading.js')
const AID='1782277579142-g6jrjr6ed', PAGES=3
const {data:ai}=await db.from('assignments').select('answer_key').eq('id',AID).maybeSingle()
const ak=typeof ai.answer_key==='string'?JSON.parse(ai.answer_key):ai.answer_key
const akById=new Map((ak.questions||[]).map(q=>[String(q.id),q]))
const {data:one}=await db.from('submissions').select('id,phase_a_state').eq('assignment_id',AID).not('phase_a_state','is',null).limit(1)
const s=one[0]
const r=await db.storage.from('homework-images').download('submissions/'+s.id+'.webp')
const img=Buffer.from(await r.data.arrayBuffer()).toString('base64')
// 取 8 個 single_choice 格（最小的那批）
const items=[]
for(const q of (s.phase_a_state?.classifyResult?.alignedQuestions??[])){
  if(!q.answerBbox)continue
  const t=akById.get(String(q.questionId))?.questionCategory
  if(t!=='single_choice')continue
  const bw=Number(q.answerBbox.w)||0, bh=Number(q.answerBbox.h)||0
  const padX=+Math.min(0.012,bw*0.12).toFixed(4), padY=+Math.min(0.048/PAGES,bh*0.35).toFixed(4)
  const c=await sg.cropWithMarkByBbox(img,'image/webp',q.answerBbox,padX,padY)
  if(c) items.push({questionId:q.questionId, crop:c})
  if(items.length>=8)break
}
console.log(`取 ${items.length} 個 single_choice 裁圖`)
const out=path.join('local-only','exp-sheet-noupscale-2026-08-09')
for(const [lab,env] of [['old-stretch','1'],['new-noupscale','']]){
  if(env)process.env.READ_SHEET_STRETCH=env; else delete process.env.READ_SHEET_STRETCH
  const sheets=await sg.buildReadSheets(items)
  if(!sheets){console.log(lab,'失敗');continue}
  const sharp=(await import('sharp')).default
  for(let i=0;i<sheets.length;i++){
    const buf=Buffer.from(sheets[i].inlineData.data,'base64')
    const m=await sharp(buf).metadata()
    fs.writeFileSync(path.join(out,`${lab}-${i}.jpg`),buf)
    console.log(`  ${lab}-${i}.jpg  ${m.width}x${m.height}  ${(buf.length/1024).toFixed(0)}KB  含 ${sheets[i].ids.length} 格`)}
}
