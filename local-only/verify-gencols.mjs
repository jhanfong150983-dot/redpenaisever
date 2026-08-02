import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env=Object.fromEntries(fs.readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))
const db=createClient(env.SUPABASE_URL||env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const cnt = async (fn)=> (await fn(db.from('submissions').select('id',{count:'exact',head:true}))).count
console.log('has_grading_result=true   :', await cnt(q=>q.eq('has_grading_result',true)),
            '| grading_result not null :', await cnt(q=>q.not('grading_result','is',null)))
console.log('phase_a_saved_at not null :', await cnt(q=>q.not('phase_a_saved_at','is',null)),
            '| phase_a_state not null  :', await cnt(q=>q.not('phase_a_state','is',null)))
const { data } = await db.from('submissions').select('id, phase_a_saved_at, mistakes_count, sAt:phase_a_state->>savedAt, ms:grading_result->mistakes').not('grading_result','is',null).limit(5)
let bad=0
for (const r of data??[]) {
  const expect = Array.isArray(r.ms) ? r.ms.length : null
  const ok = r.mistakes_count === expect && r.phase_a_saved_at === (r.sAt ?? null)
  if(!ok) bad++
  console.log(` ${ok?'OK':'XX'} mistakes_count=${r.mistakes_count}(應為 ${expect}) phase_a_saved_at=${r.phase_a_saved_at}`)
}
console.log(bad===0 ? '抽樣全部一致' : `⚠ ${bad} 筆不一致`)
