import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env=Object.fromEntries(fs.readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))
const db=createClient(env.SUPABASE_URL||env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const r1 = await db.from('submissions').select('id, grading_cleared_at').limit(1)
console.log('① grading_cleared_at 欄位:', r1.error ? '❌ '+r1.error.message : '✅ 可查詢')
const { count: cleared } = await db.from('submissions').select('id',{count:'exact',head:true}).not('grading_cleared_at','is',null)
const { count: total } = await db.from('submissions').select('id',{count:'exact',head:true})
console.log(`   目前 ${cleared}/${total} 筆有墓碑(全新欄位、預期為 0,之後每次清除會蓋上)`)
// ② sync select 整條實跑
const slim='id, assignment_id, student_id, status, created_at, image_url, thumb_url, score, ai_score, score_source, feedback, graded_at, correction_count, source, round, parent_submission_id, actor_user_id, graded_by, updated_at, page_breaks, has_grading_result, phase_a_saved_at, mistakes_count, grading_cleared_at'
const r2 = await db.from('submissions').select(slim).eq('owner_id','c121fe65-edd8-4911-9796-d286af36639a').limit(1000)
console.log('② 新版 sync select:', r2.error ? '❌ '+r2.error.message : `✅ ${r2.data.length} 筆 / ${(Buffer.byteLength(JSON.stringify(r2.data))/1024/1024).toFixed(2)} MB`)
