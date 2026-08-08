// 批改基準快照(2026-08-08 建立):重跑 Phase A 會覆蓋 phase_a_state(含仲裁讀值)
//   → 驗證前先快照,事後才能逐格 diff。教訓來源:8/08 合成圖驗證只剩「平均分」粗指標。
// 用法:node local-only/snapshot-grading.mjs <assignmentId> [標籤]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
for (const l of fs.readFileSync(path.join(__dirname, '../.env.local'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '').trim() }
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const AID = process.argv[2]
const TAG = process.argv[3] || 'snap'
if (!AID) { console.error('用法: node snapshot-grading.mjs <assignmentId> [標籤]'); process.exit(1) }

const { data: asg } = await db.from('assignments').select('title,domain').eq('id', AID).maybeSingle()
let subs = [], p = 0
for (;;) {
  const { data } = await db.from('submissions').select('id,student_id,score,graded_at,grading_result,phase_a_state').eq('assignment_id', AID).not('grading_result', 'is', null).order('id').range(p * 200, p * 200 + 199)
  subs = subs.concat(data || []); if ((data || []).length < 200) break; p++
}
const { data: studs } = await db.from('students').select('id,seat_number,name').in('id', [...new Set(subs.map(s => s.student_id))])
const sm = new Map((studs ?? []).map(s => [s.id, s]))

const snap = {
  assignmentId: AID, title: asg?.title, domain: asg?.domain,
  snapshotAt: new Date().toISOString(), tag: TAG, papers: subs.length,
  submissions: subs.map((s) => ({
    id: s.id, seat: sm.get(s.student_id)?.seat_number ?? null, score: s.score,
    gradedAt: s.graded_at ? Number(s.graded_at) : null,
    // 逐格判定(diff 的主體)
    details: (s.grading_result?.details ?? []).map((d) => ({
      qid: String(d.questionId), ok: d.isCorrect === true, score: d.score, maxScore: d.maxScore,
      ans: d.studentAnswer ?? null, conf: d.confidence ?? null,
      journey: d.confidenceJourney ?? null, votes: d.glyphVotes ?? null,
      r1: d.readAnswer1?.studentAnswer ?? null, r2: d.readAnswer2?.studentAnswer ?? null,
      consistency: d.consistencyStatus ?? null,
    })),
    // 仲裁讀值(read 品質的 GT)
    arbiter: (s.phase_a_state?.arbiterDecisions ?? []).map((d) => ({ qid: String(d.questionId), finalAnswer: d.finalAnswer ?? null, status: d.arbiterStatus ?? null })),
    // bbox(重現裁圖用)
    bboxes: (s.phase_a_state?.classifyResult?.alignedQuestions ?? []).map((q) => ({ qid: String(q.questionId), t: q.questionType, bbox: q.answerBbox ?? null })),
  })),
}
const dir = path.join(__dirname, 'snapshots')
fs.mkdirSync(dir, { recursive: true })
const f = path.join(dir, `${TAG}_${AID}_${snap.snapshotAt.slice(0, 19).replace(/[:T]/g, '-')}.json`)
fs.writeFileSync(f, JSON.stringify(snap))
const cells = snap.submissions.reduce((a, s) => a + s.details.length, 0)
const low = snap.submissions.reduce((a, s) => a + s.details.filter(d => (d.conf ?? 100) < 60).length, 0)
console.log(`✅ 快照完成:${snap.title}(${snap.domain}) ${snap.papers} 卷 / ${cells} 格`)
console.log(`   平均分 ${(snap.submissions.reduce((a, s) => a + (s.score || 0), 0) / snap.papers).toFixed(2)}  低信心 ${low} 格`)
console.log(`   → ${path.relative(path.join(__dirname, '..'), f)}  (${Math.round(fs.statSync(f).size / 1024)} KB)`)
