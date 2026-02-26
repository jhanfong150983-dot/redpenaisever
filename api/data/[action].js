import { handleCors } from '../../server/_cors.js'
import { getAuthUser } from '../../server/_auth.js'
import { getSupabaseAdmin } from '../../server/_supabase.js'

const TAG_QUIET_MINUTES = 5

function resolveAction(req) {
  const actionParam = req.query?.action
  if (Array.isArray(actionParam)) {
    return actionParam[0] || ''
  }
  if (typeof actionParam === 'string') return actionParam
  const pathname = req.url ? req.url.split('?')[0] : ''
  const segments = pathname.split('/').filter(Boolean)
  return segments[segments.length - 1] || ''
}

function parseJsonBody(req) {
  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return null
    }
  }
  return body || null
}

function toIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return null
}

function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  )
}

function parseBooleanParam(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true') return true
    if (normalized === '0' || normalized === 'false') return false
  }
  return false
}

function resolveOwnerIdParam(req) {
  const raw = req.query?.ownerId ?? req.query?.owner_id
  if (Array.isArray(raw)) {
    return typeof raw[0] === 'string' ? raw[0].trim() : null
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed || null
  }
  return null
}

async function requireAdminOverride(userId) {
  const supabaseAdmin = getSupabaseAdmin()
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    throw new Error('讀取使用者權限失敗')
  }

  if (data?.role?.toLowerCase?.() !== 'admin') {
    return null
  }

  return supabaseAdmin
}

function addMinutesIso(date, minutes) {
  const base = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(base.getTime())) return null
  return new Date(base.getTime() + minutes * 60 * 1000).toISOString()
}

function normalizeDeletedList(items) {
  if (!Array.isArray(items)) return []
  return items
    .map((item) => {
      if (typeof item === 'string') {
        return { id: item, deletedAt: null }
      }
      if (item && typeof item === 'object') {
        const id = item.id || item.recordId
        const deletedAt = toMillis(item.deletedAt) ?? null
        if (typeof id === 'string' && id.length > 0) {
          return { id, deletedAt }
        }
      }
      return null
    })
    .filter(Boolean)
}

async function fetchExistingUpdatedMap(supabaseDb, tableName, ids, ownerId) {
  if (ids.length === 0) return new Map()
  const result = await supabaseDb
    .from(tableName)
    .select('id, updated_at')
    .eq('owner_id', ownerId)
    .in('id', ids)
  if (result.error) {
    throw new Error(result.error.message)
  }
  return new Map(
    (result.data || []).map((row) => [row.id, toMillis(row.updated_at)])
  )
}

async function fetchDeletedSet(supabaseDb, tableName, ids, ownerId) {
  if (ids.length === 0) return new Set()
  const result = await supabaseDb
    .from('deleted_records')
    .select('record_id')
    .eq('owner_id', ownerId)
    .eq('table_name', tableName)
    .in('record_id', ids)
  if (result.error) {
    throw new Error(result.error.message)
  }
  return new Set((result.data || []).map((row) => row.record_id))
}

async function touchAssignmentTagStates(supabaseDb, ownerId, assignmentIds) {
  if (!assignmentIds.length) return
  const now = new Date()
  const nowIso = now.toISOString()
  const nextRunAtIso = addMinutesIso(now, TAG_QUIET_MINUTES)

  const { data, error } = await supabaseDb
    .from('assignment_tag_state')
    .select('assignment_id, status, window_started_at, dirty, manual_locked')
    .eq('owner_id', ownerId)
    .in('assignment_id', assignmentIds)

  if (error) {
    throw new Error(error.message)
  }

  const stateMap = new Map(
    (data || []).map((row) => [row.assignment_id, row])
  )

  const rows = assignmentIds.map((assignmentId) => {
    const existing = stateMap.get(assignmentId)
    const isManualLocked = Boolean(existing?.manual_locked)
    const status = isManualLocked ? 'ready' : existing?.status ?? 'idle'
    const isRunning = status === 'running'
    const resetWindow =
      !existing ||
      !existing.window_started_at ||
      status === 'idle' ||
      status === 'failed' ||
      status === 'ready' ||
      status === 'insufficient_samples'
    const windowStartedAt = resetWindow ? nowIso : existing.window_started_at

    return compactObject({
      owner_id: ownerId,
      assignment_id: assignmentId,
      status: isManualLocked ? 'ready' : isRunning ? 'running' : 'pending',
      window_started_at: windowStartedAt,
      last_event_at: nowIso,
      next_run_at: isManualLocked ? undefined : nextRunAtIso ?? undefined,
      dirty: isManualLocked ? false : isRunning ? true : existing?.dirty ?? false,
      manual_locked: isManualLocked ? true : existing?.manual_locked ?? false,
      updated_at: nowIso
    })
  })

  if (!rows.length) return

  const result = await supabaseDb
    .from('assignment_tag_state')
    .upsert(rows, { onConflict: 'owner_id,assignment_id' })

  if (result.error) {
    throw new Error(result.error.message)
  }
}

async function handleSync(req, res) {
  const { user, accessToken } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const requestedOwnerId = resolveOwnerIdParam(req)
  const isOwnerOverride =
    requestedOwnerId && requestedOwnerId !== user.id

  // 後端始終使用 service role key 繞過 RLS
  const supabaseAdmin = getSupabaseAdmin()

  if (isOwnerOverride && req.method !== 'GET') {
    res.status(403).json({ error: 'Read-only view mode' })
    return
  }

  let ownerId = user.id
  let supabaseDb = supabaseAdmin

  if (isOwnerOverride) {
    try {
      const adminOverride = await requireAdminOverride(user.id)
      if (!adminOverride) {
        res.status(403).json({ error: 'Forbidden' })
        return
      }
      ownerId = requestedOwnerId
      // supabaseDb 已經是 admin client，無需重新賦值
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '讀取使用者權限失敗'
      })
      return
    }
  }

  if (req.method === 'GET') {
    try {
      const [
        classroomsResult,
        studentsResult,
        assignmentsResult,
        submissionsResult,
        foldersResult,
        deletedResult
      ] = await Promise.all([
        supabaseDb.from('classrooms').select('*').eq('owner_id', ownerId),
        supabaseDb.from('students').select('*').eq('owner_id', ownerId),
        supabaseDb.from('assignments').select('*').eq('owner_id', ownerId),
        supabaseDb.from('submissions').select('*').eq('owner_id', ownerId),
        supabaseDb.from('folders').select('*').eq('owner_id', ownerId),
        supabaseDb
          .from('deleted_records')
          .select('table_name, record_id, deleted_at')
          .eq('owner_id', ownerId)
      ])

      if (classroomsResult.error) {
        throw new Error(classroomsResult.error.message)
      }
      if (studentsResult.error) {
        throw new Error(studentsResult.error.message)
      }
      if (assignmentsResult.error) {
        throw new Error(assignmentsResult.error.message)
      }
      if (submissionsResult.error) {
        throw new Error(submissionsResult.error.message)
      }
      if (foldersResult.error) {
        throw new Error(foldersResult.error.message)
      }
      if (deletedResult.error) {
        throw new Error(deletedResult.error.message)
      }

      const includeTags = parseBooleanParam(req.query?.includeTags)
      let assignmentTags = undefined
      if (includeTags) {
        const [stateResult, tagsResult] = await Promise.all([
          supabaseDb
            .from('assignment_tag_state')
            .select(
              'assignment_id, status, sample_count, last_event_at, next_run_at, last_generated_at, model, prompt_version'
            )
            .eq('owner_id', ownerId),
          supabaseDb
            .from('assignment_tag_aggregates')
            .select('assignment_id, tag_label, tag_count, examples')
            .eq('owner_id', ownerId)
        ])

        if (stateResult.error) {
          throw new Error(stateResult.error.message)
        }
        if (tagsResult.error) {
          throw new Error(tagsResult.error.message)
        }

        const stateMap = new Map(
          (stateResult.data || []).map((row) => [row.assignment_id, row])
        )
        const tagMap = new Map()

        for (const row of tagsResult.data || []) {
          const assignmentId = row.assignment_id
          if (!assignmentId) continue
          if (!tagMap.has(assignmentId)) tagMap.set(assignmentId, [])
          const list = tagMap.get(assignmentId)
          if (list) {
            list.push(
              compactObject({
                label: row.tag_label,
                count: toNumber(row.tag_count) ?? 0,
                examples: Array.isArray(row.examples) ? row.examples : undefined
              })
            )
          }
        }

        const assignmentIdSet = new Set([
          ...Array.from(stateMap.keys()),
          ...Array.from(tagMap.keys())
        ])

        assignmentTags = Array.from(assignmentIdSet).map((assignmentId) => {
          const state = stateMap.get(assignmentId)
          const tags = tagMap.get(assignmentId) ?? []
          const status = state?.status ?? (tags.length ? 'ready' : 'pending')
          return compactObject({
            assignmentId,
            source: status === 'ready' ? 'ai' : 'rule',
            status,
            sampleCount: state?.sample_count ?? undefined,
            lastEventAt: toMillis(state?.last_event_at) ?? undefined,
            nextRunAt: toMillis(state?.next_run_at) ?? undefined,
            lastGeneratedAt: toMillis(state?.last_generated_at) ?? undefined,
            tags
          })
        })
      }

      const deleted = {
        classrooms: [],
        students: [],
        assignments: [],
        submissions: [],
        folders: []
      }
      const deletedSets = {
        classrooms: new Set(),
        students: new Set(),
        assignments: new Set(),
        submissions: new Set(),
        folders: new Set()
      }

      for (const row of deletedResult.data || []) {
        const tableName = row.table_name
        const recordId = row.record_id
        if (!recordId || !deleted[tableName]) continue
        deleted[tableName].push(
          compactObject({
            id: recordId,
            deletedAt: toMillis(row.deleted_at) ?? undefined
          })
        )
        deletedSets[tableName].add(recordId)
      }

      const classrooms = (classroomsResult.data || []).map((row) =>
        compactObject({
          id: row.id,
          name: row.name,
          folder: row.folder ?? undefined,
          updatedAt: toMillis(row.updated_at) ?? undefined
        })
      )

      const students = (studentsResult.data || []).map((row) => ({
        id: row.id,
        classroomId: row.classroom_id,
        seatNumber: row.seat_number,
        name: row.name,
        updatedAt: toMillis(row.updated_at) ?? undefined
      }))

      const assignments = (assignmentsResult.data || []).map((row) =>
        compactObject({
          id: row.id,
          classroomId: row.classroom_id,
          title: row.title,
          totalPages: row.total_pages,
          domain: row.domain ?? undefined,
          folder: row.folder ?? undefined,
          priorWeightTypes: row.prior_weight_types ?? undefined,
          answerKey: row.answer_key ?? undefined,
          updatedAt: toMillis(row.updated_at) ?? undefined
        })
      )

      const submissions = (submissionsResult.data || []).map((row) => {
        const createdAt = row.created_at ? Date.parse(row.created_at) : null
        const gradedAt = toNumber(row.graded_at)
        const updatedAt = toMillis(row.updated_at)

        return compactObject({
          id: row.id,
          assignmentId: row.assignment_id,
          studentId: row.student_id,
          status: row.status ?? 'synced',
          imageUrl: row.image_url ?? undefined,
          thumbUrl: row.thumb_url ?? row.thumbnail_url ?? undefined,
          createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
          score: row.score ?? undefined,
          feedback: row.feedback ?? undefined,
          gradingResult: row.grading_result ?? undefined,
          gradedAt: gradedAt ?? undefined,
          correctionCount: row.correction_count ?? undefined,
          updatedAt: updatedAt ?? undefined
        })
      })

      const folders = (foldersResult.data || []).map((row) =>
        compactObject({
          id: row.id,
          name: row.name,
          type: row.type,
          updatedAt: toMillis(row.updated_at) ?? undefined
        })
      )

      res.status(200).json({
        classrooms: classrooms.filter((row) => !deletedSets.classrooms.has(row.id)),
        students: students.filter((row) => !deletedSets.students.has(row.id)),
        assignments: assignments.filter((row) => !deletedSets.assignments.has(row.id)),
        submissions: submissions.filter((row) => !deletedSets.submissions.has(row.id)),
        folders: folders.filter((row) => !deletedSets.folders.has(row.id)),
        deleted,
        ...(assignmentTags ? { assignmentTags } : {})
      })
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '讀取雲端資料失敗'
      })
    }
    return
  }

  if (req.method === 'POST') {
    const body = parseJsonBody(req)
    if (!body) {
      res.status(400).json({ error: 'Invalid JSON body' })
      return
    }

    const classrooms = Array.isArray(body.classrooms) ? body.classrooms : []
    const students = Array.isArray(body.students) ? body.students : []
    const assignments = Array.isArray(body.assignments) ? body.assignments : []
    const submissions = Array.isArray(body.submissions) ? body.submissions : []
    const folders = Array.isArray(body.folders) ? body.folders : []
    const deletedPayload =
      body.deleted && typeof body.deleted === 'object' ? body.deleted : {}
    
    console.log(`📥 [後端 Sync POST] 收到 ${assignments.length} 個作業:`, assignments.map(a => ({ id: a.id, title: a.title, hasAnswerKey: !!a.answerKey })))

    console.log('📥 [API] 收到同步請求:', {
      classrooms: classrooms.length,
      students: students.length,
      assignments: assignments.length,
      submissions: submissions.length,
      folders: folders.length,
      deleted: {
        classrooms: deletedPayload.classrooms?.length || 0,
        students: deletedPayload.students?.length || 0,
        assignments: deletedPayload.assignments?.length || 0,
        submissions: deletedPayload.submissions?.length || 0,
        folders: deletedPayload.folders?.length || 0
      }
    })

    const nowIso = new Date().toISOString()

    try {
      const applyDeletes = async (tableName, items) => {
        const list = normalizeDeletedList(items)
        if (list.length === 0) return

        // 步驟 1: 針對 submissions，先刪除雲端儲存檔案
        if (tableName === 'submissions') {
          const filePaths = list.flatMap(item => ([
            `submissions/${item.id}.webp`,
            `submissions/thumbs/${item.id}.webp`
          ]))

          try {
            // 使用批次刪除 API (Supabase 支援一次刪除多個檔案)
            const { error } = await supabaseDb.storage
              .from('homework-images')
              .remove(filePaths)

            if (error) {
              console.warn('批次刪除儲存檔案失敗，改用逐一刪除:', error.message)

              // 降級方案：逐一刪除
              const results = await Promise.allSettled(
                filePaths.map(async (filePath) => {
                  const { error: singleError } = await supabaseDb.storage
                    .from('homework-images')
                    .remove([filePath])

                  if (singleError && !singleError.message.includes('not found')) {
                    console.warn(`刪除檔案 ${filePath} 失敗:`, singleError.message)
                  }
                })
              )

              const succeeded = results.filter(r => r.status === 'fulfilled').length
              const failed = results.filter(r => r.status === 'rejected').length
              console.log(`✅ 雲端檔案刪除: ${succeeded} 成功, ${failed} 失敗 (共 ${list.length} 個)`)
            } else {
              console.log(`✅ 成功刪除 ${filePaths.length} 個雲端檔案`)
            }
          } catch (err) {
            console.error('❌ 雲端檔案刪除異常:', err)
            // 繼續執行資料庫刪除，不中斷流程
          }
        }

        // 步驟 2: 建立 tombstone 記錄 (原有邏輯)
        const deleteRows = list.map((item) =>
          compactObject({
            owner_id: user.id,
            table_name: tableName,
            record_id: item.id,
            deleted_at: toIsoTimestamp(item.deletedAt) ?? nowIso
          })
        )

        const tombstoneResult = await supabaseDb
          .from('deleted_records')
          .upsert(deleteRows, {
            onConflict: 'owner_id,table_name,record_id'
          })
        if (tombstoneResult.error) {
          throw new Error(tombstoneResult.error.message)
        }

        // 步驟 3: 從資料庫刪除記錄 (原有邏輯)
        const ids = list.map((item) => item.id)
        const deleteResult = await supabaseDb
          .from(tableName)
          .delete()
          .in('id', ids)
          .eq('owner_id', user.id)
        if (deleteResult.error) {
          throw new Error(deleteResult.error.message)
        }
      }

      console.log('🔄 [API] 開始處理刪除請求...')
      await applyDeletes('classrooms', deletedPayload.classrooms)
      await applyDeletes('students', deletedPayload.students)
      await applyDeletes('assignments', deletedPayload.assignments)
      await applyDeletes('submissions', deletedPayload.submissions)
      await applyDeletes('folders', deletedPayload.folders)
      console.log('✅ [API] 所有刪除處理完成')

      const buildUpsertRows = async (tableName, items, mapper) => {
        const filtered = items.filter((item) => item?.id)
        if (filtered.length === 0) return []
        const ids = filtered.map((item) => item.id)
        const [existingMap, deletedSet] = await Promise.all([
          fetchExistingUpdatedMap(supabaseDb, tableName, ids, user.id),
          fetchDeletedSet(supabaseDb, tableName, ids, user.id)
        ])

        const rows = []
        for (const item of filtered) {
          if (deletedSet.has(item.id)) continue
          const hasExisting = existingMap.has(item.id)
          const existingUpdatedAt = existingMap.get(item.id)
          if (hasExisting) {
            const incomingUpdatedAt = toMillis(item.updatedAt ?? item.updated_at)
            if (!incomingUpdatedAt || (existingUpdatedAt && incomingUpdatedAt <= existingUpdatedAt)) {
              console.log(`⏭️ [buildUpsertRows ${tableName}] 跳過舊資料: ${item.id}, 本地 ${incomingUpdatedAt} <= 雲端 ${existingUpdatedAt}`)
              continue
            }
          }
          rows.push(mapper(item))
        }
        console.log(`📝 [buildUpsertRows ${tableName}] 過濾後準備寫入 ${rows.length}/${filtered.length} 筆`)
        return rows
      }

      const classroomRows = await buildUpsertRows(
        'classrooms',
        classrooms.filter((c) => c?.id),
        (c) =>
          compactObject({
            id: c.id,
            name: c.name,
            folder: c.folder,
            owner_id: user.id,
            updated_at: nowIso
          })
      )

      if (classroomRows.length > 0) {
        const result = await supabaseDb
          .from('classrooms')
          .upsert(classroomRows, { onConflict: 'id' })
        if (result.error) throw new Error(result.error.message)
      }

      const studentRows = await buildUpsertRows(
        'students',
        students.filter((s) => s?.id && s?.classroomId),
        (s) =>
          compactObject({
            id: s.id,
            classroom_id: s.classroomId,
            seat_number: s.seatNumber,
            name: s.name,
            owner_id: user.id,
            updated_at: nowIso
          })
      )

      if (studentRows.length > 0) {
        const result = await supabaseDb
          .from('students')
          .upsert(studentRows, { onConflict: 'id' })
        if (result.error) throw new Error(result.error.message)
      }

      const assignmentRows = await buildUpsertRows(
        'assignments',
        assignments.filter((a) => a?.id && a?.classroomId),
        (a) =>
          compactObject({
            id: a.id,
            classroom_id: a.classroomId,
            title: a.title,
            total_pages: a.totalPages,
            domain: a.domain ?? undefined,
            folder: a.folder,
            prior_weight_types: a.priorWeightTypes ?? undefined,
            answer_key: a.answerKey ?? undefined,
            owner_id: user.id,
            updated_at: nowIso
          })
      )

      if (assignmentRows.length > 0) {
        console.log(`💾 [後端 Sync] 準備寫入 ${assignmentRows.length} 個作業到 Supabase:`, assignmentRows.map(a => ({ id: a.id, title: a.title, hasAnswerKey: !!a.answer_key })))
        const result = await supabaseDb
          .from('assignments')
          .upsert(assignmentRows, { onConflict: 'id' })
        if (result.error) {
          console.error(`❌ [後端 Sync] 寫入失敗:`, result.error)
          throw new Error(result.error.message)
        }
        console.log(`✅ [後端 Sync] 成功寫入 ${assignmentRows.length} 個作業`)
      } else {
        console.log(`⚠️ [後端 Sync] 沒有作業需要寫入`)
      }

      const submissionRows = await buildUpsertRows(
        'submissions',
        submissions.filter((s) => s?.id && s?.assignmentId && s?.studentId),
        (s) => {
          const createdAt = toIsoTimestamp(s.createdAt)
          const gradedAt = toNumber(s.gradedAt)
          const imageUrl =
            s.imageUrl || s.image_url || `submissions/${s.id}.webp`
          const thumbUrl =
            s.thumbUrl ||
            s.thumb_url ||
            s.thumbnailUrl ||
            s.thumbnail_url ||
            `submissions/thumbs/${s.id}.webp`

          return compactObject({
            id: s.id,
            assignment_id: s.assignmentId,
            student_id: s.studentId,
            status: s.status ?? undefined,
            image_url: imageUrl,
            thumb_url: thumbUrl,
            created_at: createdAt ?? undefined,
            score: toNumber(s.score) ?? undefined,
            feedback: s.feedback ?? undefined,
            grading_result: s.gradingResult ?? undefined,
            graded_at: gradedAt ?? undefined,
            correction_count: toNumber(s.correctionCount) ?? undefined,
            owner_id: user.id,
            updated_at: nowIso
          })
        }
      )

      if (submissionRows.length > 0) {
        const result = await supabaseDb
          .from('submissions')
          .upsert(submissionRows, { onConflict: 'id' })
        if (result.error) throw new Error(result.error.message)
      }

      const touchedAssignments = new Set(
        submissionRows
          .filter((row) => row.assignment_id)
          .filter((row) => row.grading_result !== undefined || row.status === 'graded')
          .map((row) => row.assignment_id)
      )

      if (touchedAssignments.size > 0) {
        await touchAssignmentTagStates(
          supabaseDb,
          user.id,
          Array.from(touchedAssignments)
        )
      }

      const folderRows = await buildUpsertRows(
        'folders',
        folders.filter((f) => f?.id),
        (f) =>
          compactObject({
            id: f.id,
            name: f.name,
            type: f.type,
            owner_id: user.id,
            updated_at: nowIso
          })
      )

      if (folderRows.length > 0) {
        const result = await supabaseDb
          .from('folders')
          .upsert(folderRows, { onConflict: 'id' })
        if (result.error) throw new Error(result.error.message)
      }

      res.status(200).json({ success: true })
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '同步失敗'
      })
    }
    return
  }

  res.status(405).json({ error: 'Method Not Allowed' })
}

async function handleSubmission(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const { user, accessToken } = await getAuthUser(req, res)
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    // 後端始終使用 service role key 繞過 RLS
    const supabaseDb = getSupabaseAdmin()

    let body = req.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        res.status(400).json({ error: 'Invalid JSON body' })
        return
      }
    }

    const {
      submissionId,
      assignmentId,
      studentId,
      createdAt,
      imageBase64,
      contentType,
      thumbBase64,
      thumbContentType
    } = body || {}

    if (!submissionId || !assignmentId || !studentId || !createdAt || !imageBase64) {
      res.status(400).json({ error: 'Missing required fields' })
      return
    }

    const tombstoneCheck = await supabaseDb
      .from('deleted_records')
      .select('record_id')
      .eq('owner_id', user.id)
      .eq('table_name', 'submissions')
      .eq('record_id', submissionId)
      .limit(1)

    if (tombstoneCheck.error) {
      res.status(500).json({ error: tombstoneCheck.error.message })
      return
    }

    if (tombstoneCheck.data && tombstoneCheck.data.length > 0) {
      res.status(409).json({ error: '提交已被刪除，請重新建立' })
      return
    }

    const filePath = `submissions/${submissionId}.webp`
    const buffer = Buffer.from(String(imageBase64), 'base64')

    console.log('📤 [上傳] 開始上傳檔案:', {
      submissionId,
      assignmentId,
      studentId,
      filePath,
      fileSize: `${(buffer.length / 1024).toFixed(2)} KB`
    })

    const { error: uploadError } = await supabaseDb.storage
      .from('homework-images')
      .upload(filePath, buffer, {
        contentType: contentType || 'image/webp',
        upsert: true
      })

    if (uploadError) {
      console.error('❌ [上傳] 檔案上傳失敗:', uploadError.message)
      res.status(500).json({ error: `圖片上傳失敗: ${uploadError.message}` })
      return
    }

    console.log('✅ [上傳] 檔案上傳成功:', filePath)

    let thumbFilePath = null
    if (thumbBase64) {
      const candidateThumbPath = `submissions/thumbs/${submissionId}.webp`
      try {
        const thumbBuffer = Buffer.from(String(thumbBase64), 'base64')
        const { error: thumbUploadError } = await supabaseDb.storage
          .from('homework-images')
          .upload(candidateThumbPath, thumbBuffer, {
            contentType: thumbContentType || 'image/webp',
            upsert: true
          })

        if (thumbUploadError) {
          console.warn('⚠️ [縮圖] 上傳失敗，略過縮圖:', thumbUploadError.message)
        } else {
          thumbFilePath = candidateThumbPath
          console.log('✅ [縮圖] 上傳成功:', thumbFilePath)
        }
      } catch (err) {
        console.warn('⚠️ [縮圖] 上傳異常，略過縮圖:', err)
      }
    }

    const createdTime =
      typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)
    if (!Number.isFinite(createdTime)) {
      res.status(400).json({ error: 'Invalid createdAt' })
      return
    }

    const timestamp = new Date(createdTime).toISOString()

    // 先檢查是否有相同作業+學生的舊 submission
    const existingCheck = await supabaseDb
      .from('submissions')
      .select('id')
      .eq('assignment_id', assignmentId)
      .eq('student_id', studentId)
      .eq('owner_id', user.id)
      .limit(1)

    // 如果存在且 ID 不同，先刪除舊的
    if (existingCheck.data && existingCheck.data.length > 0) {
      const oldId = existingCheck.data[0].id
      if (oldId !== submissionId) {
        console.log('🗑️ [覆蓋] 發現舊作業，準備刪除:', {
          oldId,
          newId: submissionId,
          assignmentId,
          studentId
        })

        // 建立 tombstone 記錄
        await supabaseDb.from('deleted_records').upsert({
          owner_id: user.id,
          table_name: 'submissions',
          record_id: oldId,
          deleted_at: new Date().toISOString()
        }, {
          onConflict: 'owner_id,table_name,record_id'
        })

        // 刪除舊的 submission
        await supabaseDb
          .from('submissions')
          .delete()
          .eq('id', oldId)
          .eq('owner_id', user.id)

        console.log('✅ [覆蓋] 已刪除舊作業資料庫記錄:', oldId)

        // 刪除舊的雲端檔案
        try {
          await supabaseDb.storage
            .from('homework-images')
            .remove([`submissions/${oldId}.webp`, `submissions/thumbs/${oldId}.webp`])
          console.log('✅ [覆蓋] 已刪除舊作業雲端檔案:', {
            original: `submissions/${oldId}.webp`,
            thumb: `submissions/thumbs/${oldId}.webp`
          })
        } catch (err) {
          console.warn('⚠️ [覆蓋] 刪除舊檔案失敗:', err)
        }
      }
    }

    // 插入新的 submission（使用 insert 而非 upsert）
    console.log('💾 [資料庫] 開始插入新 submission:', {
      id: submissionId,
      assignmentId,
      studentId,
      imageUrl: filePath,
      status: 'synced'
    })

    const { error: dbError } = await supabaseDb
      .from('submissions')
      .insert(
        compactObject({
          id: submissionId,
          assignment_id: assignmentId,
          student_id: studentId,
          image_url: filePath,
          thumb_url: thumbFilePath ?? undefined,
          status: 'synced',
          created_at: timestamp,
          owner_id: user.id
        })
      )

    if (dbError) {
      console.error('❌ [資料庫] 寫入失敗:', dbError.message)
      res.status(500).json({ error: `資料庫寫入失敗: ${dbError.message}` })
      return
    }

    console.log('✅ [資料庫] 新 submission 寫入成功')
    console.log('🎉 [完成] PDF 上傳流程完成:', {
      submissionId,
      imageUrl: filePath,
      status: 'synced'
    })

    res.status(200).json({ success: true, imageUrl: filePath })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server error' })
  }
}

async function handleReport(req, res) {
  const { user, accessToken } = await getAuthUser(req, res)
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const requestedOwnerId = resolveOwnerIdParam(req)
  const isOwnerOverride =
    requestedOwnerId && requestedOwnerId !== user.id

  // 後端始終使用 service role key 繞過 RLS
  const supabaseAdmin = getSupabaseAdmin()

  let ownerId = user.id
  let supabaseDb = supabaseAdmin

  if (isOwnerOverride) {
    try {
      const adminOverride = await requireAdminOverride(user.id)
      if (!adminOverride) {
        res.status(403).json({ error: 'Forbidden' })
        return
      }
      ownerId = requestedOwnerId
      // supabaseDb 已經是 admin client，無需重新賦值
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : '讀取使用者權限失敗'
      })
      return
    }
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' })
    return
  }

  try {
    const [
      domainResult,
      abilityAggResult,
      abilityDictResult,
      tagMapResult,
      tagDictResult
    ] = await Promise.all([
      supabaseDb
        .from('domain_tag_aggregates')
        .select(
          'domain, tag_label, tag_count, assignment_count, sample_count, generated_at'
        )
        .eq('owner_id', ownerId)
        .order('tag_count', { ascending: false }),
      supabaseDb
        .from('ability_aggregates')
        .select(
          'ability_id, total_count, assignment_count, domain_count, generated_at'
        )
        .eq('owner_id', ownerId)
        .order('total_count', { ascending: false }),
      supabaseDb
        .from('ability_dictionary')
        .select('id, label')
        .eq('owner_id', ownerId)
        .eq('status', 'active'),
      supabaseDb
        .from('tag_ability_map')
        .select('tag_id, ability_id, confidence')
        .eq('owner_id', ownerId),
      supabaseDb
        .from('tag_dictionary')
        .select('id, label, normalized_label, status, merged_to_tag_id')
        .eq('owner_id', ownerId)
    ])

    if (domainResult.error) throw new Error(domainResult.error.message)
    if (abilityAggResult.error) throw new Error(abilityAggResult.error.message)
    if (abilityDictResult.error) throw new Error(abilityDictResult.error.message)
    if (tagMapResult.error) throw new Error(tagMapResult.error.message)
    if (tagDictResult.error) throw new Error(tagDictResult.error.message)

    const dictionaryRows = tagDictResult.data ?? []
    const dictionaryById = new Map(dictionaryRows.map((row) => [row.id, row]))
    const dictionary = dictionaryRows.map((row) => {
      const mergedTarget = row.merged_to_tag_id
        ? dictionaryById.get(row.merged_to_tag_id)
        : null
      return {
        id: row.id,
        label: row.label,
        normalized_label: row.normalized_label,
        status: row.status,
        merged_to_tag_id: row.merged_to_tag_id ?? null,
        merged_to_label: mergedTarget?.label ?? null
      }
    })

    const domainMap = new Map()
    ;(domainResult.data || []).forEach((row) => {
      const domain = row.domain || 'uncategorized'
      if (!domainMap.has(domain)) domainMap.set(domain, [])
      domainMap.get(domain).push({
        label: row.tag_label,
        count: toNumber(row.tag_count) ?? 0,
        assignmentCount: toNumber(row.assignment_count) ?? 0,
        sampleCount: toNumber(row.sample_count) ?? null,
        generatedAt: toIsoTimestamp(row.generated_at)
      })
    })

    const domains = Array.from(domainMap.entries()).map(([domain, tags]) => ({
      domain,
      tags
    }))

    const abilityLabelById = new Map(
      (abilityDictResult.data || []).map((row) => [row.id, row.label])
    )
    const abilities = (abilityAggResult.data || []).map((row) => ({
      id: row.ability_id,
      label: abilityLabelById.get(row.ability_id) || row.ability_id,
      totalCount: toNumber(row.total_count) ?? 0,
      assignmentCount: toNumber(row.assignment_count) ?? 0,
      domainCount: toNumber(row.domain_count) ?? 0,
      generatedAt: toIsoTimestamp(row.generated_at)
    }))

    const tagLabelById = new Map(
      dictionaryRows.map((row) => [row.id, row.label || row.normalized_label])
    )
    const tagAbilityMap = new Map()
    ;(tagMapResult.data || []).forEach((row) => {
      const tagLabel = tagLabelById.get(row.tag_id)
      const abilityLabel = abilityLabelById.get(row.ability_id)
      if (!tagLabel || !abilityLabel) return
      const key = `${tagLabel}::${abilityLabel}`
      if (tagAbilityMap.has(key)) return
      tagAbilityMap.set(key, {
        tag: tagLabel,
        ability: abilityLabel,
        confidence: toNumber(row.confidence)
      })
    })

    res.status(200).json({
      domains,
      abilities,
      tagAbilityMap: Array.from(tagAbilityMap.values()),
      dictionary
    })
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : '讀取報告資料失敗'
    })
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res)) {
    return
  }
  const action = resolveAction(req)
  if (action === 'sync') {
    await handleSync(req, res)
    return
  }
  if (action === 'submission') {
    await handleSubmission(req, res)
    return
  }
  if (action === 'report') {
    await handleReport(req, res)
    return
  }
  res.status(404).json({ error: 'Not Found' })
}
