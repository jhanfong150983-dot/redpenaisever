// v3 prompt：補形近例(者/都)、明說「正解沒有的字＝增字不扣」、約束 which 格式
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelRates, USD_TO_TWD } from '../_rates.mjs'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname,'../../.env.local'),'utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'').replace(/\r$/,'').trim() }
const KEY=process.env.SYSTEM_GEMINI_API_KEY
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')
const MODEL='gemini-3.6-flash', ROUNDS=5

export const V3=(ref,stu)=>`國語科用字覆核。標準答案：「${ref}」。學生作答：「${stu}」。
逐字比對，數出學生作答裡有幾個「用字錯誤」。

用字錯誤 ＝ **標準答案某個位置的字，學生寫成了別的字**，且兩字是同音／近音或字形相近：
✅ 同音或近音：「地」寫成「的」、「急」寫成「極」、「在」寫成「再」、「盡」寫成「進」。
✅ 字形相近（含部件多寫或少寫）：「都」寫成「者」、「繁」寫成「敏」、偏旁寫錯、部件漏寫。
✅ 以注音符號代替國字。

一律不算錯、count 不要加：
❌ **標準答案裡本來就沒有的字**（學生自己多寫的助詞、贅字）——那是「多寫」不是「寫錯」。
   例：標準答案「盡情飲酒」、學生「盡情的飲酒」→ 標準答案沒有那個位置的字 → count 不加。
❌ 換成另一個「不同音也不同形」的同義詞：「急速」寫成「快速」、「由」寫成「從」。
❌ 漏字、缺字、只答部分、詞序顛倒。
❌ 標點差異、簡繁體、改用自己的話但意思相同。

count = 錯字個數（0 = 沒有用字錯誤）。同一個字重複寫錯只算 1 個。
which = 每個錯字寫成「X 應為 Y」，多個用「、」分隔；沒有則空字串。不要寫解釋、不要超過 30 字。
只輸出 JSON：{"count":0,"which":""}`

const acc={calls:0,cost:0}
const parse=(d)=>{const t=(d?.candidates??[]).flatMap(c=>c?.content?.parts??[]).map(x=>x?.text??'').join('');const m=t.match(/\{[\s\S]*\}/);if(!m)return null;try{return JSON.parse(m[0])}catch{return null}}
const ask=async(pr)=>{const r=await callGeminiGenerateContent({apiKey:KEY,model:MODEL,contents:[{role:'user',parts:[{text:pr}]}],payload:{generationConfig:{temperature:0,thinkingConfig:{thinking_level:'MINIMAL'}}},timeoutMs:20000})
 const u=r?.data?.usageMetadata??{},rt=modelRates(MODEL); acc.calls++
 acc.cost+=((Number(u.promptTokenCount)||0)/1e6*rt.inUsd+((Number(u.candidatesTokenCount)||0)+(Number(u.thoughtsTokenCount)||0))/1e6*rt.outUsd)*USD_TO_TWD
 return parse(r?.data)}

// 測資：corpus2 全部 + corpus1 裡「舊/新有分歧」與「含的/極/者」的關鍵樣本
const c2=JSON.parse(fs.readFileSync(path.join(__dirname,'corpus2.json'),'utf8'))
const R1=JSON.parse(fs.readFileSync(path.join(__dirname,'result.json'),'utf8'))
const key=new Map()
for(const c of c2) key.set(`${c.qid}|${c.stu}`,{ref:c.ref,stu:c.stu,max:c.max,src:'翻0組',expect:null})
for(const r of R1){ if(/[的極者進繁]/.test(r.stu)||r.newCnt[0]>0) key.set(`${r.qid}|${r.stu}`,{ref:r.ref,stu:r.stu,max:r.max,src:'score>0組',expect:r.newCnt[0]}) }
const cases=[...key.values()]
console.log(`v3 測 ${cases.length} 種寫法 × ${ROUNDS} 輪\n`)
const out=[]
for(const c of cases){
  const runs=[]; for(let i=0;i<ROUNDS;i++) runs.push(await ask(V3(c.ref,c.stu)))
  const cnt=runs.map(x=>Number(x?.count)), stable=new Set(cnt).size===1
  const which=String(runs[0]?.which??'')
  const fmtOk = cnt[0]===0 ? which==='' : /應為/.test(which)&&which.length<=30
  out.push({...c,cnt,stable,which,fmtOk})
  const flag = !stable?'⚠不穩':(!fmtOk?'⚠格式':'  ')
  console.log(`${flag} [${cnt.join(',')}]${c.expect!=null&&c.expect!==cnt[0]?` (v2 是 ${c.expect})`:''}  「${c.stu.slice(0,30)}」 ← 「${c.ref.slice(0,20)}」  ${which}`)
}
console.log(`\n不穩 ${out.filter(o=>!o.stable).length}/${out.length}｜which 格式不佳 ${out.filter(o=>!o.fmtOk).length}/${out.length}｜${acc.calls} calls NT$${acc.cost.toFixed(2)}`)
fs.writeFileSync(path.join(__dirname,'result3.json'),JSON.stringify(out,null,1))
