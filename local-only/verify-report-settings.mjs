import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env=Object.fromEntries(fs.readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))
const db=createClient(env.SUPABASE_URL||env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const r1 = await db.from('schools').select('id, name, report_school_name, report_crest_data_url').limit(5)
console.log('① schools 新欄位:', r1.error ? '❌ '+r1.error.message : '✅ 可查詢')
for (const s of r1.data ?? []) console.log(`   ${s.name} | 覆寫校名=${s.report_school_name ?? 'NULL'} | 校徽=${s.report_crest_data_url ? s.report_crest_data_url.length+' bytes' : 'NULL'}`)

// ② 任課老師對照(school-exams 列表會用的那條)
const { data: ex } = await db.from('school_exams').select('id,title,subject,school_id').eq('id','sxm_3f112a56cb6ab073').maybeSingle()
const { data: ecs } = await db.from('school_exam_classes').select('campus_class_id,class_name').eq('exam_id', ex.id)
const { data: courses, error: cErr } = await db.from('school_class_courses')
  .select('campus_class_id, subject, teacher_name').eq('school_id', ex.school_id).in('subject',[ex.subject])
console.log(`\n② 任課老師對照(考卷「${ex.title}」科目=${ex.subject}):`, cErr ? '❌ '+cErr.message : '✅')
const byKey = new Map()
for (const c of courses ?? []) {
  const n = String(c.teacher_name||'').trim(); if(!n) continue
  const k = `${c.campus_class_id}|${c.subject}`
  const cur = byKey.get(k); if(!cur) byKey.set(k,[n]); else if(!cur.includes(n)) cur.push(n)
}
let hit=0
for (const c of ecs ?? []) {
  const names = byKey.get(`${c.campus_class_id}|${ex.subject}`)
  if (names) hit++
  console.log(`   ${c.class_name.padEnd(8)} → ${names ? names.join('、') : '(未指派任課、報告抬頭老師欄會留空)'}`)
}
console.log(`   對到 ${hit}/${ecs.length} 班`)
