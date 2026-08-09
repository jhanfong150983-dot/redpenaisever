// 座7 +1位移機制隔離：①寬度排序合成圖(現行) ②原始順序合成圖 ③逐張裁圖
// GT = 7月逐張讀值（其中 6 格經 user 眼球確認）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname,'../../.env.local'),'utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'').replace(/\r$/,'').trim() }
const KEY=process.env.SYSTEM_GEMINI_API_KEY
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const sg = await import('../../server/ai/staged-grading.js')
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')
const AID='1782277579142-g6jrjr6ed'
const A=JSON.parse(fs.readFileSync('local-only/snapshots/before-eng-b1_1782277579142-g6jrjr6ed_2026-08-09-01-19-25.json','utf8'))
const {data:ai}=await db.from('assignments').select('answer_key').eq('id',AID).maybeSingle()
const ak=typeof ai.answer_key==='string'?JSON.parse(ai.answer_key):ai.answer_key
const akById=new Map((ak.questions||[]).map(q=>[String(q.id),q]))
let subs=[],p=0
for(;;){const {data}=await db.from('submissions').select('id,student_id,phase_a_state').eq('assignment_id',AID).order('id').range(p*50,p*50+49); subs=subs.concat(data||[]); if((data||[]).length<50)break; p++}
const {data:studs}=await db.from('students').select('id,seat_number').in('id',subs.map(s=>s.student_id))
const sm=new Map((studs||[]).map(s=>[s.id,s.seat_number]))
const s7=subs.find(x=>sm.get(x.student_id)===7)
const snap=A.submissions.find(x=>x.seat===7)
const gtByQ=new Map((snap?.details||[]).map(d=>[d.qid,String(d.ans)]))
const bb=new Map((s7.phase_a_state?.classifyResult?.alignedQuestions??[]).map(q=>[String(q.questionId),q.answerBbox]))
const r=await db.storage.from('homework-images').download('submissions/'+s7.id+'.webp')
const img=Buffer.from(await r.data.arrayBuffer()).toString('base64')
// 全部 single_choice 依題號序建 crop（B1 緊框、同 production）
const qids=[...akById.values()].filter(q=>q.questionCategory==='single_choice').map(q=>String(q.id))
const items=[]
for(const q of qids){
  const box=bb.get(q); if(!box)continue
  const bw=Number(box.w)||0, bh=Number(box.h)||0
  const padX=+Math.min(0.012,bw*0.12).toFixed(4), padY=+Math.min(0.048/3,bh*0.35).toFixed(4)
  const c=await sg.cropWithMarkByBbox(img,'image/webp',box,padX,padY)
  if(c) items.push({questionId:q, crop:c})
}
console.log(`座7 single_choice ${items.length} 格　GT（7月逐張讀）: ${items.map(i=>gtByQ.get(i.questionId)??'?').join(',')}`)
const PROMPT=(ids)=>`這是學生答案卷的作答區裁切圖。每格是一題單選題，學生在括號內寫一個英文字母。
請逐格回報學生寫的字母；沒寫→"未作答"。
⚠ 這是一張「合成圖」：由多格作答區上下排列組成，每格上方有紅色題號、外圍有紅框。請逐格處理，題號依序為：${ids.join('、')}。
只輸出 JSON：{"answers":[{"questionId":"...","value":"A|B|C|D|未作答"}]}`
const PROMPT1=(id)=>`這是學生答案卷「一題單選題」的作答區裁切圖，學生在括號內寫一個英文字母。紅框標示作答區。沒寫→"未作答"。
只輸出 JSON：{"questionId":"${id}","value":"A|B|C|D|未作答"}`
const parse=(d)=>{const t=(d?.candidates??[]).flatMap(c=>c?.content?.parts??[]).map(x=>x?.text??'').join('');const m=t.match(/\{[\s\S]*\}/);if(!m)return null;try{return JSON.parse(m[0])}catch{return null}}
const MODELS=['gemini-2.5-flash']
const ROUNDS=3
for(const MODEL of MODELS){
  console.log(`\n══ model=${MODEL} ══`)
  for(const [arm,env] of [['①寬度排序(現行)',''],['②原始順序','keep'],['③逐張','per']]){
    const accs=[]
    for(let round=0;round<ROUNDS;round++){
      const got=new Map()
      if(arm==='③逐張'){
        await Promise.all(items.map(async it=>{
          const r=await callGeminiGenerateContent({apiKey:KEY,model:MODEL,contents:[{role:'user',parts:[{text:PROMPT1(it.questionId)},{inlineData:it.crop}]}],payload:{generationConfig:{temperature:0,thinkingConfig:{thinking_level:'MINIMAL'}}},timeoutMs:30000})
          const pj=parse(r?.data); if(pj)got.set(String(pj.questionId),String(pj.value))}))
      }else{
        let sheets
        if(env==='keep'){
          // 原始順序：直接自建（不排序、每張寬=最寬格）
          const sharp=(await import('sharp')).default
          sheets=[]
          for(let s=0;s<items.length;s+=20){
            const chunk=items.slice(s,s+20)
            const ms=[]; for(const it of chunk){const buf=Buffer.from(it.crop.data,'base64');const m=await sharp(buf).metadata();ms.push({qid:it.questionId,buf,w:m.width,h:m.height})}
            const cellW=Math.max(48,Math.min(460,...ms.map(c=>c.w)))
            const cells=[]
            for(const c of ms){const fit=await sharp(c.buf).resize({width:cellW,height:900,fit:'inside',withoutEnlargement:true}).toBuffer()
              const fm=await sharp(fit).metadata(); const h=Math.max(24,fm.height)
              cells.push({qid:c.qid,buf:await sharp({create:{width:cellW,height:h,channels:3,background:'#ffffff'}}).composite([{input:fit,gravity:'center'}]).png().toBuffer(),h})}
            const totalH=cells.reduce((a,c)=>a+c.h+30+8,0)+8, W=cellW+16
            const svg=[`<rect width="${W}" height="${totalH}" fill="white"/>`]; const comps=[]; let y=8
            for(const c of cells){svg.push(`<text x="8" y="${y+20}" font-family="sans-serif" font-size="20" font-weight="bold" fill="#c00">${c.qid}</text>`)
              const top=y+30; comps.push({input:c.buf,left:8,top})
              svg.push(`<rect x="6" y="${top-2}" width="${cellW+4}" height="${c.h+4}" fill="none" stroke="#c00" stroke-width="3"/>`); y=top+c.h+8}
            const base=await sharp(Buffer.from(`<svg width="${W}" height="${totalH}">${svg.join('')}</svg>`)).png().toBuffer()
            const out=await sharp(base).composite(comps).jpeg({quality:92}).toBuffer()
            sheets.push({inlineData:{mimeType:'image/jpeg',data:out.toString('base64')},ids:cells.map(c=>c.qid)})}
        }else{
          sheets=await sg.buildReadSheets(items)
        }
        for(const sh of sheets){
          const r=await callGeminiGenerateContent({apiKey:KEY,model:MODEL,contents:[{role:'user',parts:[{text:PROMPT(sh.ids)},{inlineData:sh.inlineData}]}],payload:{generationConfig:{temperature:0,thinkingConfig:{thinking_level:'MINIMAL'}}},timeoutMs:60000})
          const pj=parse(r?.data)
          for(const a of (pj?.answers??[])) got.set(String(a.questionId),String(a.value))}
      }
      let ok=0,n=0
      for(const it of items){const gt=gtByQ.get(it.questionId); if(gt==null)continue; n++
        const g=got.get(it.questionId)??'(缺)'
        if(String(g).trim().toUpperCase()===String(gt).trim().toUpperCase()||(gt==='未作答'&&g==='未作答'))ok++}
      accs.push(`${ok}/${n}`)
    }
    console.log(`  ${arm}  ${ROUNDS} 輪符合 GT: ${accs.join('、')}`)
  }
}
