import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env=Object.fromEntries(fs.readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))
const db=createClient(env.SUPABASE_URL||env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const owner='c121fe65-edd8-4911-9796-d286af36639a'
const slim='id, assignment_id, student_id, status, created_at, image_url, thumb_url, score, ai_score, score_source, feedback, graded_at, correction_count, source, round, parent_submission_id, actor_user_id, graded_by, updated_at, page_breaks, has_grading_result, phase_a_saved_at, mistakes_count'
const fat = 'id, assignment_id, student_id, status, created_at, image_url, thumb_url, score, ai_score, score_source, feedback, graded_at, correction_count, source, round, parent_submission_id, actor_user_id, graded_by, updated_at, grading_result, phase_a_state, final_answers, page_breaks'
for (const [name,cols] of [['瘦身後',slim],['原本',fat]]) {
  const { data, error } = await db.from('submissions').select(cols).eq('owner_id',owner).limit(1000)
  if (error) { console.log(name,'❌',error.message); continue }
  const bytes=Buffer.byteLength(JSON.stringify(data))
  console.log(`${name}: ${data.length} 份 → ${(bytes/1024/1024).toFixed(2)} MB(平均 ${(bytes/data.length/1024).toFixed(1)} KB/份)`)
}
