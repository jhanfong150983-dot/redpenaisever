// 補跑 corpus2（被舊規則翻 0 的 11 格 / 7 種寫法）— 這批我先前建了卻沒測
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { modelRates, USD_TO_TWD } from '../_rates.mjs'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname,'../../.env.local'),'utf8').split('\n')) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'').replace(/\r$/,'').trim() }
const KEY=process.env.SYSTEM_GEMINI_API_KEY
const { callGeminiGenerateContent } = await import('../../server/ai/model-adapter.js')
const MODEL='gemini-3.6-flash', ROUNDS=5
const c2=JSON.parse(fs.readFileSync(path.join(__dirname,'corpus2.json'),'utf8'))
// 再加上 production 實際出問題的那兩格（座25 1-2-5 / 1-2-6）確保涵蓋
const uniq=new Map()
for(const c of c2){const k=`${c.qid}|${c.stu}`; if(!uniq.has(k))uniq.set(k,{...c,n:1}); else uniq.get(k).n++}
const cases=[...uniq.values()]
console.log(`corpus2 去重 ${cases.length} 種寫法（原 ${c2.length} 格）× ${ROUNDS} 輪\n`)
const NEW=(ref,stu)=>`國語科用字覆核。標準答案：「${ref}」。學生作答：「${stu}」。
數出學生作答裡有幾個「用字錯誤」。

用字錯誤的定義（只有這一種）：
✅ **音近或形近的別字**——學生想寫的是標準答案裡那個字，但寫成了同音／近音字或形似字。
   例：「地」寫成「的」、「急速」寫成「極速」、「在」寫成「再」、部件寫錯。
✅ 以注音符號代替國字。

一律不算錯、不要計入：
❌ 換成另一個「不同音也不同形」的同義詞（例：「急速」寫成「快速」、「由」寫成「從」）。
❌ 漏字、缺字、答案不完整、只答部分。
❌ 多寫字、贅字、標點差異、簡繁體。
❌ 改用自己的話表達但意思相同。

count = 錯字的個數（0 表示沒有用字錯誤）。同一個字重複寫錯只算 1 個。
只輸出 JSON：{"count":0,"which":"逐一列出哪些字寫錯（30字內），沒有則空字串"}`
const acc={calls:0,cost:0}
const parse=(d)=>{const t=(d?.candidates??[]).flatMap(c=>c?.content?.parts??[]).map(x=>x?.text??'').join('');const m=t.match(/\{[\s\S]*\}/);if(!m)return null;try{return JSON.parse(m[0])}catch{return null}}
const ask=async(pr)=>{const r=await callGeminiGenerateContent({apiKey:KEY,model:MODEL,contents:[{role:'user',parts:[{text:pr}]}],payload:{generationConfig:{temperature:0,thinkingConfig:{thinking_level:'MINIMAL'}}},timeoutMs:20000})
 const u=r?.data?.usageMetadata??{},rt=modelRates(MODEL); acc.calls++
 acc.cost+=((Number(u.promptTokenCount)||0)/1e6*rt.inUsd+((Number(u.candidatesTokenCount)||0)+(Number(u.thoughtsTokenCount)||0))/1e6*rt.outUsd)*USD_TO_TWD
 return parse(r?.data)}
const out=[]
for(const c of cases){
  const runs=[]
  for(let i=0;i<ROUNDS;i++) runs.push(await ask(NEW(c.ref,c.stu)))
  const cnt=runs.map(x=>Number(x?.count))
  const stable=new Set(cnt).size===1
  out.push({...c,cnt,stable,which:String(runs[0]?.which??'').slice(0,45)})
  console.log(`${stable?'  ':'⚠ '}count=[${cnt.join(',')}] ×${c.n}格  正解「${c.ref.slice(0,22)}」`)
  console.log(`     學生「${c.stu.slice(0,32)}」  舊 0/${c.max} → 新 ${Math.max(0,c.max-(cnt[0]||0))}/${c.max}   ${out.at(-1).which}`)
}
console.log(`\n不穩 ${out.filter(o=>!o.stable).length}/${out.length} 種｜${acc.calls} calls NT$${acc.cost.toFixed(2)}`)
fs.writeFileSync(path.join(__dirname,'result2.json'),JSON.stringify(out,null,1))
